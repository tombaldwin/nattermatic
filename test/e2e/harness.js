// What every end-to-end group shares: nodes on localhost with distinct ports, plus MCP adapters.
// Members a..j (except d) share one network founded by a; d is on a network of its own.
// Each group runs in a process of its own, with its own folder and ports (E2E_PORT_BASE): test/e2e.js
// runs them side by side.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { spawn, execFileSync, execFile, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { newIdentity } from '../../src/cert.js'
import { Roster } from '../../src/roster.js'
import { signEnvelope, sealBeacon } from '../../src/crypto.js'
import { authedRequest, peerCertificate } from '../../src/tls.js'
import { Local } from '../../src/local.js'
import { readIdentity, VERSION } from '../../src/config.js'
import { openStore } from '../../src/store.js'
import { FRAMED } from '../../src/mcp.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'natter.js')
// NATTERMATIC_TEST_EXE runs everything with a built single executable (the macOS app) instead
const [EXE, ...PRE] = process.env.NATTERMATIC_TEST_EXE ? [path.resolve(process.env.NATTERMATIC_TEST_EXE)] : [process.execPath, '--no-warnings', BIN]
// leases on test time: short ttls, a quick sweep, a short wait for a session that's gone (long enough
// for an adapter to reconnect while the other groups run alongside)
Object.assign(process.env, { NATTERMATIC_LEASE_MIN_MS: '2000', NATTERMATIC_LEASE_GRACE_MS: '3000', NATTERMATIC_LEASE_SWEEP_MS: '300', NATTERMATIC_LEASE_RUN_TTL_MS: '2400' })
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nattermatic-e2e-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
// the messaging group runs on the default base: some of its steps use fixed ports from 17787 to 17792
const BASE = Number(process.env.E2E_PORT_BASE || 17771)
const NODES = Object.fromEntries([...'abcdefghijklmn'].map((n, i) => [n, BASE + i]))
const EXTRA_PORTS = [19, 20, 21, 22].map(i => BASE + i)
const routes = Object.fromEntries(Object.entries(NODES).map(([n, p]) => [`${n}.test`, `127.0.0.1:${p}`]))

// identities and the shared network (a founds it; t.test is this test process, acting as a member)
const IDS = Object.fromEntries(Object.keys(NODES).map(n => [n, newIdentity()]))
const TESTER = newIdentity()
const NET = Roster.genesis(IDS.a, 'a.test')
for (const n of ['b', 'c', 'e', 'f', 'g', 'h', 'j']) NET.add(IDS.a, `${n}.test`, IDS[n].cert)
NET.add(IDS.a, 't.test', TESTER.cert)
const OTHER_NET = Roster.genesis(IDS.d, 'd.test')

function home(n, conf = {}, roster = n === 'd' ? OTHER_NET : NET) {
  const dir = path.join(ROOT, n)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    host: `${n}.test`, port: NODES[n], discovery: false, routes, autoAliases: false,
    peers: ['a', 'b', 'c'].filter(x => x !== n).map(x => `${x}.test`), ...conf,
  }))
  fs.writeFileSync(path.join(dir, 'node.key'), IDS[n].key, { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'node.crt'), IDS[n].cert)
  fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({ net: roster.net, records: roster.records }))
  return dir
}
const envFor = n => ({ ...process.env, NATTERMATIC_HOME: path.join(ROOT, n) })
const localOf = n => new Local({ identity: readIdentity(path.join(ROOT, n)), port: NODES[n], dir: path.join(ROOT, n) })

const procs = {}
async function startNode(n) {
  const out = fs.openSync(path.join(ROOT, n, 'node.log'), 'a')
  procs[n] = spawn(EXE, [...PRE, 'node'], { env: envFor(n), stdio: ['ignore', out, out] })
  const local = localOf(n)
  for (let i = 0; i < 50; i++) {
    const h = await local.health()
    if (h && !h.foreign) return
    await sleep(100)
  }
  throw new Error(`node ${n} did not start`)
}
async function stopNode(n) {
  const p = procs[n]
  if (!p || p.exitCode !== null || p.signalCode !== null) return   // already gone (killed by a signal: exitCode stays null)
  const done = new Promise(r => p.once('exit', r))
  if (process.env.NODE_V8_COVERAGE) { p.kill('SIGUSR2'); await sleep(300) }    // measuring coverage: it writes what ran first
  p.kill('SIGKILL')   // simulate a crash / machine dropping off
  await done
}
function cliAsync(n, ...args) {
  return new Promise((resolve, reject) => execFile(EXE, [...PRE, ...args], { env: envFor(n), encoding: 'utf8' },
    (err, out) => err ? reject(err) : resolve(out.trim())))
}
/** A command expected to fail: its stderr. */
function cliFails(n, ...args) {
  const r = spawnSync(EXE, [...PRE, ...args], { env: envFor(n), encoding: 'utf8' })
  assert.notEqual(r.status, 0, `expected \`nattermatic ${args.join(' ')}\` to fail:\n${r.stdout}`)
  return r.stderr
}
function cli(n, ...args) {
  return execFileSync(EXE, [...PRE, ...args], { env: envFor(n), encoding: 'utf8' }).trim()
}

// mode: false = channel session, true = --poll, 'plain' = a session without the channel enabled
async function adapter(n, name, poll = false) {
  const transport = new StdioClientTransport({
    command: EXE,
    args: [...PRE, 'mcp', '--name', name, ...(poll === 'plain' ? [] : poll ? ['--poll'] : ['--channel'])],
    env: { ...envFor(n), NATTERMATIC_LISTEN_GRACE_MS: '100' }, stderr: 'ignore',
  })
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  const got = []
  await client.connect(transport)
  // as Claude Code does: it starts listening once it has the tool list, and what comes sooner is lost
  await client.listTools()
  // a push's content is the message framed (see frameBody): `body` is the message itself
  client.fallbackNotificationHandler = async notif => {
    if (notif.method === 'notifications/claude/channel') got.push({ ...notif.params, body: FRAMED.exec(notif.params.content)?.[2] ?? notif.params.content })
  }
  const call = async (tool, args = {}) => (await client.callTool({ name: tool, arguments: args })).content[0].text
  return { client, got, call, close: () => client.close(), instructions: client.getInstructions() }
}
async function waitFor(fn, ms = 8000, what = 'condition') {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}

// a session's acknowledgement follows the push, and what stops before it arrives is offered again
const acked = n => waitFor(() => !JSON.parse(cli(n, 'status')).counts.some(c => c.state === 'queued'), 5000, 'the acknowledgement')
const running = n => procs[n] && procs[n].exitCode === null && procs[n].signalCode === null
async function ensureNode(n) { if (!running(n)) await startNode(n) }
/**
 * A request to node `n` as a member machine (`as`: an identity; the test is member t.test).
 * `dks`: the discovery keys we hold; `addr`: where to connect (default: n's port).
 */
async function memberPost(n, p, obj, as = TESTER, dks = NET.dks, addr = `127.0.0.1:${NODES[n]}`) {
  const r = await authedRequest({ addr, method: 'POST', path: p, body: JSON.stringify(obj), identity: as, accept: new Map([[IDS[n].fp, crypto.createPublicKey(IDS[n].key)]]), dks, timeout: 10_000 })
  return { status: r.status, data: JSON.parse(r.text) }
}
function envelope(to, body, extra = {}, key = TESTER.key) {
  const e = { id: crypto.randomUUID(), from: 'tester@t.test', to, body, sent_at: Date.now(), expires_at: Date.now() + 3600_000, ...extra }
  return { ...e, sig: signEnvelope(key, e) }
}
/** An HTTPS request with no client certificate (an outsider). */
function outsiderGet(port, p) {
  return new Promise(resolve => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
    })
    let buf = ''
    s.on('data', c => { buf += c })
    s.on('end', () => resolve(Number(buf.match(/^HTTP\/1\.1 (\d+)/)?.[1] || 0)))
    s.on('error', () => resolve(0))
  })
}
const curlBin = ['/usr/bin/curl', '/bin/curl'].find(p => fs.existsSync(p)) || 'curl'

async function killPorts() {
  for (const p of [...Object.values(NODES), ...EXTRA_PORTS]) {
    let pids = ''
    try { pids = execFileSync('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim() } catch {}
    for (const pid of pids.split('\n').filter(Boolean)) try { process.kill(Number(pid)) } catch {}
  }
}

let passed = 0
async function step(name, fn) {
  process.stdout.write(`- ${name} ... `)
  await fn()
  passed++
  console.log('ok')
}
// ---- setup, invites, joining, removal (real `natter setup`, nodes on ports i/k/l) ----
const setupEnv = (n, extra = {}) => ({ ...process.env, NATTERMATIC_HOME: path.join(ROOT, `s-${n}`), NATTERMATIC_PORT: String(NODES[n]), NATTERMATIC_HOST: `${n}.test`, NATTERMATIC_DISCOVERY: '0', NATTERMATIC_AUTO_ALIASES: '0', ...extra })
const setup = (n, args = [], extra = {}) => spawnSync(EXE, [...PRE, 'setup', ...args, '--no-service', '--no-claude', '--no-alias'], { env: setupEnv(n, extra), encoding: 'utf8', timeout: 60_000 })
const scli = (n, ...args) => spawnSync(EXE, [...PRE, ...args], { env: setupEnv(n), encoding: 'utf8', timeout: 30_000 })
const sLocal = n => new Local({ identity: readIdentity(path.join(ROOT, `s-${n}`)), port: NODES[n], dir: path.join(ROOT, `s-${n}`) })
const parseInvite = out => {
  const m = out.match(/curl -fsSL -k --pinnedpubkey "sha256\/\/([^"]+)" "https:\/\/[^/]+\/join\/install\?t=([^"]+)"/)
  assert.ok(m, `an invite line in:\n${out}`)
  return { pin: m[1], token: m[2] }
}
const joinArgs = (inv, port = NODES.i) => ['--join', `127.0.0.1:${port}`, '--pin', inv.pin, '--token', inv.token]


/** Run a group's steps, then stop everything it started; on a failure, show the nodes' logs. @param {() => Promise<void>} steps */
async function run(steps) {
  try {
    await killPorts()
    await steps()
    console.log(`\nall ${passed} steps passed`)
  } catch (e) {
    console.log('FAILED')
    console.error(e)
    for (const n of [...Object.keys(NODES), ...Object.keys(NODES).map(n => `s-${n}`)]) {
      try { console.error(`--- ${n}/node.log ---\n` + fs.readFileSync(path.join(ROOT, n, 'node.log'), 'utf8').slice(-2000)) } catch {}
    }
    process.exitCode = 1
  } finally {
    for (const n of Object.keys(procs)) await stopNode(n)
    await killPorts()   // nodes auto-started by adapters and setup are not our children
    if (!process.exitCode) fs.rmSync(ROOT, { recursive: true, force: true })
    process.exit()   // don't wait on stray handles (a failed step may leave adapters or timers behind)
  }
}

export {
  fs, os, path, assert, net, tls, crypto, spawn, execFileSync, execFile, spawnSync, fileURLToPath, Client, StdioClientTransport, newIdentity, Roster, signEnvelope, sealBeacon, authedRequest, peerCertificate, Local, readIdentity, VERSION, openStore, BIN, EXE, PRE, ROOT, sleep, BASE, NODES, EXTRA_PORTS, routes, IDS, TESTER, NET, OTHER_NET, home, envFor, localOf, procs, startNode, stopNode, cliAsync, cliFails, cli, adapter, waitFor, acked, running, ensureNode, memberPost, envelope, outsiderGet, curlBin, killPorts, step, setupEnv, setup, scli, sLocal, parseInvite, joinArgs, run, FRAMED,
}
