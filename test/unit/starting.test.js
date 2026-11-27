// A node answers every request with 503 "starting" from binding its port until it's ready. A client
// must wait for it: it's neither absent (a second node would be started to fight it for the port) nor
// something else on the port (setup and the CLI would give up).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newIdentity } from '../../src/cert.js'
import { authedRequest, StartingError } from '../../src/tls.js'
import { Local } from '../../src/local.js'
import { createPeers } from '../../src/peers.js'
import crypto from 'node:crypto'

/** A server that says it's starting until `readyAt`, then answers like something that isn't a node. @param {number} readyAt */
async function server(readyAt) {
  const id = newIdentity()
  let asked = 0
  const s = https.createServer({ key: id.key, cert: id.cert, minVersion: 'TLSv1.2' }, (req, res) => {
    asked++
    if (Date.now() < readyAt) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"starting"}') }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}')
  })
  await new Promise(r => s.listen(0, '127.0.0.1', () => r(null)))
  const port = /** @type {import('node:net').AddressInfo} */ (s.address()).port
  return { s, port, asked: () => asked }
}

test('a node that is starting says so, and the client waits for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-starting-'))
  const ready = Date.now() + 700
  const { s, port, asked } = await server(ready)
  try {
    const me = newIdentity()
    await assert.rejects(authedRequest({ addr: `127.0.0.1:${port}`, path: '/health', identity: me, accept: new Map(), dks: [], timeout: 1000 }), StartingError)
    const h = await new Local({ identity: me, port, dir }).health()
    // against the moment it was ready, not a stopwatch: a busy machine may take a while to get here
    assert.ok(Date.now() >= ready, 'it waited for the node to finish starting')
    assert.ok(asked() > 2, 'asking again as it went')
    // ready, and (here) not this machine's node: that's only decided once it has answered for real
    assert.deepEqual(h, { foreign: true })
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('something that never stops saying it is starting is waited for once, then taken for foreign', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-starting-'))
  const { s, port } = await server(Infinity)
  try {
    const local = new Local({ identity: newIdentity(), port, dir })
    local.startingWaitMs = 400
    let t0 = Date.now()
    assert.deepEqual(await local.health(), { foreign: true })
    assert.ok(Date.now() - t0 >= 350, 'one wait')
    // a caller polling in a loop isn't made to wait it out again on every call
    t0 = Date.now()
    for (let i = 0; i < 3; i++) assert.deepEqual(await local.health(), { foreign: true })
    assert.ok(Date.now() - t0 < 300, `polling after the wait answers at once (took ${Date.now() - t0} ms)`)
    await assert.rejects(local.req('GET', '/local/status'), /still starting/)
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test("another machine's node that is starting: not unreachable, and its address is tried again sooner", async () => {
  const { s, port, asked } = await server(Infinity)
  const addr = `127.0.0.1:${port}`
  try {
    const peerId = newIdentity()
    const B = { host: 'b.test', fp: peerId.fp, publicKey: crypto.createPublicKey(peerId.key) }
    /** @type {Map<string, any>} */
    const rows = new Map()
    /** @type {string[]} */
    const logs = []
    let clock = 1_000_000
    const noop = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }
    const q = new Proxy({}, { get: (_, k) => k === 'upsertPeer' ? { run: (/** @type {string} */ h, /** @type {string} */ a) => { if (a) rows.set(h, { host: h, addr: a }); return { changes: 1 } } } : noop })
    const peers = createPeers(/** @type {any} */ ({
      cfg: { host: 'a.test', port: 7777, routes: {}, peers: [] }, me: newIdentity(),
      roster: { members: new Map([[B.fp, B]]), byHost: new Map([[B.host, B]]), dks: [], records: [] },
      q, peerRow: (/** @type {string} */ h) => rows.get(h), allPeers: () => [...rows.values()], now: () => clock, log: (/** @type {unknown[]} */ ...a) => logs.push(a.join(' ')),
      isSelf: (/** @type {string} */ h) => h === 'a.test', member: (/** @type {string} */ h) => h === B.host ? B : undefined,
      removedHost: () => false, adoptSelfAlias: () => false, mergeRoster: () => false, kick: () => {},
    }))
    rows.set(B.host, { host: B.host, addr })
    await assert.rejects(peers.call(B.host, 'GET', '/v1/sessions'), (/** @type {any} */ e) => e instanceof StartingError && /starting/.test(e.reason))
    assert.deepEqual(logs, [], 'not logged as unreachable')

    rows.delete(B.host)
    const n0 = asked()
    await peers.probe(B.host, addr)
    assert.equal(asked(), n0 + 1, 'probed')
    clock += 10_000
    await peers.probe(B.host, addr)
    assert.equal(asked(), n0 + 1, 'not again at once: the claim is unproved')
    clock += 25_000
    await peers.probe(B.host, addr)
    assert.equal(asked(), n0 + 2, 'but well before the 10 minutes a failed check waits')
  } finally { s.close() }
})
