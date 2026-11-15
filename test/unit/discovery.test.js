// LAN discovery: a beacon is taken once. A copy sent again (from anywhere: anyone on the LAN can capture
// one) sets off no second probe and no second reply.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import { startDiscovery } from '../../src/discovery.js'
import { sealBeacon, openBeacon } from '../../src/crypto.js'
import { sleep } from '../../src/config.js'

test('a beacon sent again is ignored: one sighting, one reply', async () => {
  const dk = crypto.randomBytes(32).toString('base64')
  const them = dgram.createSocket('udp4')
  await new Promise(r => them.bind(0, '127.0.0.1', () => r(null)))
  const theirPort = them.address().port
  /** @type {string[]} */
  const replies = []
  them.on('message', buf => { const b = openBeacon([dk], buf); if (b?.reply) replies.push(b.host) })
  // our node listens on a port of its own; replies go to the sender's discovery port, which is its port here
  const port = 20000 + Math.floor(Math.random() * 20000)
  /** @type {string[]} */
  const seen = []
  const cfg = /** @type {any} */ ({ host: 'me.test', port, discoveryPort: theirPort === port ? port + 1 : undefined, identity: { fp: 'me' } })
  const d = startDiscovery(cfg, () => [dk], p => seen.push(p.addr), () => {})
  try {
    await sleep(100)
    const beacon = sealBeacon(dk, { host: 'peer.test', fp: 'peer', port: 7777, ts: Date.now(), reply: false })
    for (let i = 0; i < 5; i++) { them.send(beacon, cfg.discoveryPort || port, '127.0.0.1'); await sleep(20) }
    await sleep(150)
    assert.deepEqual(seen, ['127.0.0.1:7777'], 'one sighting')
    // a new beacon from the same machine is a new sighting
    them.send(sealBeacon(dk, { host: 'peer.test', fp: 'peer', port: 7777, ts: Date.now(), reply: false }), cfg.discoveryPort || port, '127.0.0.1')
    await sleep(150)
    assert.equal(seen.length, 2)
  } finally { d.stop(); them.close() }
})
