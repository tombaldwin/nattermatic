// Local requests and a node of another protocol (#5): only health, stopping an older node and doctor
// reach it; anything else is told why, in a way its caller can act on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newIdentity } from '../../src/cert.js'
import { ProtoError, PROTO } from '../../src/tls.js'
import { Local, StaleError } from '../../src/local.js'
import { waitForWakes } from '../../src/wake.js'

test('a plain request is not sent to a node of another protocol, and the error says what to do', () => {
  const local = new Local({ identity: newIdentity(), port: 1, dir: os.tmpdir() })
  assert.equal(local.opts({ path: '/x' }).anyProto, undefined, 'not by default')
  assert.equal(local.opts({ path: '/x', anyProto: true }).anyProto, true)
  const newer = local.wrap(new ProtoError(PROTO + 1))
  assert.ok(newer instanceof StaleError, 'a newer node: this program must be restarted')
  const older = local.wrap(new ProtoError(PROTO - 1))
  assert.ok(!(older instanceof StaleError), 'an older node: replaced, not a reason to restart')
  assert.match(older.message, /older version/)
})

test('a wake waiter facing a newer protocol stops, rather than polling for the session\'s life', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-proto-'))
  try {
    let asked = 0
    const t0 = Date.now()
    const code = await waitForWakes({ mark: path.join(dir, 'mark'), wait: async () => { asked++; throw new StaleError('upgraded') }, alive: () => true, onWake: () => 0, retryMs: 10 })
    assert.equal(code, 0)
    assert.equal(asked, 1)
    assert.ok(Date.now() - t0 < 1000)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
