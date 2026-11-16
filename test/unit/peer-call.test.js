// A request to another member (#2): one that hasn't heard we joined is told and asked once more, all
// within the one request's time; and a request that runs out of time says so by its kind, not its text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import crypto from 'node:crypto'
import { newIdentity } from '../../src/cert.js'
import { exporterOf, PROTO } from '../../src/tls.js'
import { proveAuth } from '../../src/crypto.js'
import { createPeers } from '../../src/peers.js'
import { TimeoutError } from '../../src/errors.js'

/**
 * A member machine that proves its key, then answers each request with `answer`.
 * @param {(path: string, res: import('node:http').ServerResponse) => void} answer
 */
async function member(answer) {
  const id = newIdentity()
  /** @type {string[]} */
  const asked = []
  const s = https.createServer({ key: id.key, cert: id.cert, minVersion: 'TLSv1.3' }, (req, res) => {
    const p = String(req.url)
    if (p === '/v1/auth') {
      const ekm = exporterOf(/** @type {import('node:tls').TLSSocket} */ (req.socket))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ fp: id.fp, sig: proveAuth(id.key, 'server', ekm), proto: PROTO }))
    }
    asked.push(p)
    req.resume()
    req.on('end', () => answer(p, res))
  })
  await new Promise(r => s.listen(0, '127.0.0.1', () => r(null)))
  const port = /** @type {import('node:net').AddressInfo} */ (s.address()).port
  const B = { host: 'b.test', fp: id.fp, publicKey: crypto.createPublicKey(id.key) }
  /** @type {string[]} */
  const logs = []
  const noop = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }
  const peers = createPeers(/** @type {any} */ ({
    cfg: { host: 'a.test', port: 7777, routes: { [B.host]: `127.0.0.1:${port}` }, peers: [] }, me: newIdentity(),
    roster: { members: new Map([[B.fp, B]]), byHost: new Map([[B.host, B]]), dks: [], records: [] },
    q: new Proxy({}, { get: () => noop }), peerRow: () => undefined, allPeers: () => [], now: () => Date.now(),
    log: (/** @type {unknown[]} */ ...a) => logs.push(a.join(' ')),
    isSelf: (/** @type {string} */ h) => h === 'a.test', member: (/** @type {string} */ h) => h === B.host ? B : undefined,
    removedHost: () => false, adoptSelfAlias: () => false, mergeRoster: () => false, kick: () => {},
  }))
  return { s, peers, asked, logs, host: B.host }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {object} [body] */
const reply = (res, status, body = {}) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

test("a member that hasn't heard we joined is told, and asked once more", async () => {
  let told = false
  const m = await member((p, res) => {
    if (p === '/v1/hello') { told = true; return reply(res, 200, {}) }
    reply(res, told ? 200 : 403, told ? { ok: 1 } : {})
  })
  try {
    assert.deepEqual(await m.peers.call(m.host, 'GET', '/v1/sessions'), { ok: 1 })
    assert.deepEqual(m.asked, ['/v1/sessions', '/v1/hello', '/v1/sessions'])
  } finally { m.s.closeAllConnections(); m.s.close() }
})

test('asked once more only once: still refused is an answer', async () => {
  const m = await member((p, res) => reply(res, p === '/v1/hello' ? 200 : 403))
  try {
    await assert.rejects(m.peers.call(m.host, 'GET', '/v1/sessions'), (/** @type {any} */ e) => e.peerStatus === 403)
    assert.deepEqual(m.asked, ['/v1/sessions', '/v1/hello', '/v1/sessions'])
  } finally { m.s.closeAllConnections(); m.s.close() }
})

test('telling it and asking again fit in the one request\'s time', async () => {
  // refuses, then is slow to take the hello: before, the hello and the second ask each had a time of their own
  const m = await member((p, res) => p === '/v1/hello' ? setTimeout(() => reply(res, 200), 5000) : reply(res, 403))
  try {
    const t0 = Date.now()
    await assert.rejects(m.peers.call(m.host, 'GET', '/v1/sessions', undefined, { timeout: 3000, deadline: 1200 }), TimeoutError)
    const took = Date.now() - t0
    assert.ok(took >= 1000 && took < 2500, `within the deadline (took ${took} ms)`)
  } finally { m.s.closeAllConnections(); m.s.close() }
})

test('no answer in time: a TimeoutError, with why the machine could not be reached', async () => {
  const m = await member(() => {})          // proves its key, then says nothing
  try {
    await assert.rejects(m.peers.call(m.host, 'GET', '/v1/sessions', undefined, { timeout: 300 }),
      (/** @type {any} */ e) => e instanceof TimeoutError && /b\.test at 127\.0\.0\.1:\d+: timed out/.test(e.message) && /timed out/.test(e.reason))
    assert.ok(m.logs.some(l => /cannot reach b\.test: .*timed out/.test(l)), 'logged as unreachable')
  } finally { m.s.closeAllConnections(); m.s.close() }
})

test('no time left before asking: a TimeoutError, and the machine is not marked unreachable', async () => {
  const m = await member((p, res) => reply(res, 200))
  try {
    await assert.rejects(m.peers.call(m.host, 'GET', '/v1/sessions', undefined, { deadline: 0 }), TimeoutError)
    assert.deepEqual(m.asked, [], 'nothing was sent')
    assert.deepEqual(m.logs, [], 'not logged as unreachable')
  } finally { m.s.closeAllConnections(); m.s.close() }
})
