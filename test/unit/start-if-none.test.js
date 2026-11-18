// A request that finds nothing on the node's port (#13): sessions and commands start a node and send it
// again, once; hooks, a stop, and an uninstalled machine don't.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newIdentity } from '../../src/cert.js'
import { Local } from '../../src/local.js'

const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', () => r(null))); const p = /** @type {net.AddressInfo} */ (s.address()).port; await new Promise(r => s.close(r)); return p }

test('nothing on the port: a node is started and the request sent again, only where that is wanted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-start-'))
  try {
    const port = await freePort()
    const local = new Local({ identity: newIdentity(), port, dir })
    let started = 0
    local.ensureNode = async () => { started++; return /** @type {any} */ (null) }   // starts nothing: the second try is refused too

    await assert.rejects(local.req('GET', '/local/status'), /cannot reach the nattermatic node/)
    assert.equal(started, 0, 'off by default (hooks)')

    local.startIfNone = true
    await assert.rejects(local.req('GET', '/local/status'), /cannot reach the nattermatic node[^]*ECONNREFUSED/)
    assert.equal(started, 1, 'started once, and sent once more')

    await assert.rejects(local.req('POST', '/local/shutdown', undefined, '', 1000, true))
    assert.equal(started, 1, 'not to stop a node')

    fs.writeFileSync(path.join(dir, 'disabled'), '')
    await assert.rejects(local.req('GET', '/local/status'))
    assert.equal(started, 1, 'not once nattermatic is uninstalled')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
