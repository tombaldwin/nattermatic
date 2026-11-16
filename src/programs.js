// A machine can have more than one nattermatic installed: the app, and an older npm `natter` still on
// the PATH, say. Whichever starts the node (a session, the CLI, the background service), the node
// that runs should be the newest one that speaks this program's protocol: otherwise an older install
// starts an older node, a newer client replaces it, and so on (#4).
//
// Every program that starts a node or runs setup notes its command here. Only commands are kept, never
// versions: a program can be upgraded or downgraded in place, so each one is asked its version when
// a node starts.
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { cmpVersion, writeAtomic, errMsg } from './config.js'

const FILE = 'programs.json'
const MAX = 8
export const ASK_TIMEOUT_MS = 3000

/** @typedef {{ cmd: string[], version: string, proto: number }} Program */

/** A program's identity is its file (the node binary that runs it may move, the script doesn't). @param {string[]} cmd */
const key = cmd => cmd.at(-1) ?? ''

/** The commands noted on this machine, newest note first. @param {string} dir @returns {string[][]} */
export function listPrograms(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
    return Array.isArray(v) ? v.filter(c => Array.isArray(c) && c.length && c.every(a => typeof a === 'string')) : []
  } catch { return [] }
}

/**
 * Note `cmd` as a nattermatic program on this machine, dropping any whose file has gone. Never throws:
 * failing to note itself mustn't stop a node starting.
 * @param {string} dir @param {string[]} cmd
 */
export function noteProgram(dir, cmd) {
  try {
    if (!fs.existsSync(dir)) return
    const was = listPrograms(dir)
    const list = [cmd, ...was.filter(c => key(c) !== key(cmd) && fs.existsSync(key(c)))].slice(0, MAX)
    if (JSON.stringify(list) !== JSON.stringify(was)) writeAtomic(path.join(dir, FILE), JSON.stringify(list) + '\n', 0o600)
  } catch {}
}

/**
 * Ask a program its version and protocol (`natter version --json`). Null if it can't say: it's gone,
 * broken, or older than this question (it prints a bare version), and so never a newer one.
 * @param {string[]} cmd @returns {Promise<Program | null>}
 */
export function askProgram(cmd) {
  return new Promise(resolve => {
    execFile(cmd[0], [...cmd.slice(1), 'version', '--json'], { timeout: ASK_TIMEOUT_MS, maxBuffer: 4096 }, (err, out) => {
      if (err) return resolve(null)
      try {
        const v = JSON.parse(out)
        resolve(typeof v?.version === 'string' && Number.isInteger(v?.proto) ? { cmd, version: v.version, proto: v.proto } : null)
      } catch { resolve(null) }
    })
  })
}

/**
 * Of these, the program to run the node instead of this one: the newest with the same protocol, if
 * it's newer than this one. A newer protocol is never chosen: an older client couldn't use its node,
 * and its sessions would all be told to restart, into the same older client.
 * @param {(Program | null)[]} found @param {{ version: string, proto: number }} self
 */
export function pick(found, self) {
  let best = /** @type {Program | null} */ (null)
  for (const p of found) {
    if (!p || p.proto !== self.proto || cmpVersion(p.version, self.version) <= 0) continue
    if (!best || cmpVersion(p.version, best.version) > 0) best = p
  }
  return best
}

/**
 * The newer program, among those noted, that should run this machine's node, or null for this one.
 * @param {string} dir @param {string[]} self this program's command @param {{ version: string, proto: number }} me
 * @param {(cmd: string[]) => Promise<Program | null>} [ask]
 */
export async function chooseProgram(dir, self, me, ask = askProgram) {
  const others = listPrograms(dir).filter(c => key(c) !== key(self) && fs.existsSync(key(c)))
  return pick(await Promise.all(others.map(ask)), me)
}

/**
 * Run the node of the program chosen instead of this one. Under the background service this process
 * stays as its stand-in (launchd and systemd watch it), passing signals on and exiting as it does.
 * Started on demand, it stays until a node answers or that one exits, so whoever started it sees the
 * node. `up` is false if it exited before any node answered: the caller runs its own node instead,
 * so a broken newer install can't leave the machine with none. `stopped`: it was told to stop (and
 * passed that on), so the caller stops too.
 * @param {Program} p @param {{ onDemand: boolean, up: () => Promise<boolean>, log: (s: string) => void }} o
 * @returns {Promise<{ code: number, up: boolean, stopped: boolean }>}
 */
export function runChosen(p, { onDemand, up, log }) {
  log(`running the node of the newer nattermatic ${p.version} installed at ${key(p.cmd)}`)
  const child = spawn(p.cmd[0], [...p.cmd.slice(1), 'node', '--chosen', ...(onDemand ? ['--on-demand'] : [])], { stdio: 'inherit', env: process.env, detached: onDemand })
  return new Promise(resolve => {
    let done = false, seen = false, stopped = false
    // under the service, a stop is passed on; and this process stops too, rather than running its own node
    const pass = onDemand ? [] : /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP']).map(s => /** @type {const} */ ([s, () => { stopped = true; child.kill(s) }]))
    for (const [s, f] of pass) process.on(s, f)
    const finish = (/** @type {number} */ code) => {
      if (done) return
      done = true
      for (const [s, f] of pass) process.off(s, f)
      resolve({ code, up: seen, stopped })
    }
    child.on('error', e => { log(`couldn't run it: ${errMsg(e)}`); finish(1) })
    child.on('exit', (code, sig) => finish(code ?? (sig ? 1 : 0)))
    if (onDemand) child.unref()
    ;(async () => {
      for (let i = 0; i < 150 && !done && !seen; i++) {
        if (await up()) { seen = true; if (onDemand) finish(0) } else await new Promise(r => setTimeout(r, 200))
      }
    })().catch(() => {})
  })
}
