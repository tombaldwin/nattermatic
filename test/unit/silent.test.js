// A node too busy to answer still holds its port (#6): a client waits for it, for a span of time, and
// never starts another node to lose the race for the port.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newIdentity } from '../../src/cert.js'
import { Local } from '../../src/local.js'

/** @param {net.Server} s */
const listen = async s => { await new Promise(r => s.listen(0, '127.0.0.1', () => r(null))); return /** @type {net.AddressInfo} */ (s.address()).port }

test('something holding the port that never answers: waited for once, then named, and no node is started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-silent-'))
  /** @type {net.Socket[]} */
  const socks = []
  const s = net.createServer(c => { socks.push(c) })        // accepts, says nothing
  const port = await listen(s)
  try {
    const local = new Local({ identity: newIdentity(), port, dir })
    local.heldWaitMs = 1500
    assert.equal(await local.health(), null, 'health alone: no answer')
    assert.ok(await local.listening())
    const t0 = Date.now()
    await assert.rejects(local.ensureNode(), /held by something that isn't answering[^]*lsof/)
    const took = Date.now() - t0
    assert.ok(took >= 1500 && took < 6000, `one span of waiting (took ${took} ms)`)
    assert.ok(!fs.existsSync(path.join(dir, 'node.log')), 'no node was started')
  } finally { for (const c of socks) c.destroy(); s.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a node that answers again within the wait is the one used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-silent-'))
  const id = newIdentity()
  const readyAt = Date.now() + 2000
  // busy until readyAt, then it answers (here as something else, which ends the wait without starting a node)
  const s = https.createServer({ key: id.key, cert: id.cert }, (req, res) => {
    setTimeout(() => { res.writeHead(404); res.end('{}') }, Math.max(0, readyAt - Date.now()))
  })
  const port = await listen(s)
  try {
    const local = new Local({ identity: newIdentity(), port, dir })
    await assert.rejects(local.ensureNode(), /not this machine's nattermatic node/)
    assert.ok(Date.now() >= readyAt, 'it waited for an answer')
    assert.ok(!fs.existsSync(path.join(dir, 'node.log')), 'no node was started')
  } finally { s.closeAllConnections(); s.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('nothing on the port: no waiting', async () => {
  const s = net.createServer(); const port = await listen(s); s.close()
  const local = new Local({ identity: newIdentity(), port, dir: os.tmpdir() })
  const t0 = Date.now()
  assert.equal(await local.listening(), false)
  assert.ok(Date.now() - t0 < 400)
})
