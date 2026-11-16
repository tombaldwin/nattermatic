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
  const { s, port, asked } = await server(Date.now() + 700)
  try {
    const me = newIdentity()
    await assert.rejects(authedRequest({ addr: `127.0.0.1:${port}`, path: '/health', identity: me, accept: new Map(), dks: [], timeout: 1000 }), StartingError)
    const t0 = Date.now()
    const h = await new Local({ identity: me, port, dir }).health()
    assert.ok(Date.now() - t0 >= 500, 'it waited for the node to finish starting')
    assert.ok(asked() > 2, 'asking again as it went')
    // ready, and (here) not this machine's node: that's only decided once it has answered for real
    assert.deepEqual(h, { foreign: true })
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
