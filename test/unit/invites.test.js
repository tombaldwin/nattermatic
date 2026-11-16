// Invites and the key the node presents: the invite key exactly while an invite is open, a throwaway
// otherwise, and a token works once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore, queries } from '../../src/store.js'
import { createInvites } from '../../src/invites.js'
import { fingerprint } from '../../src/cert.js'

test('an invite key is presented while an invite is open, and deleted once none is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-invites-'))
  const db = openStore(path.join(dir, 'test.db'))
  try {
    /** @type {string[]} */
    const shown = []
    const inv = createInvites({ present: id => shown.push(fingerprint(id.key)), q: queries(db), dir, now: Date.now, log: () => {} })
    inv.rotate()
    assert.equal(shown.length, 1, 'a throwaway key at first')
    assert.equal(inv.fp(), '')

    const a = inv.create(), b = inv.create()
    assert.equal(a.fp, b.fp, 'open invites share one key')
    assert.equal(shown.at(-1), a.fp, 'and it is the one presented')
    assert.ok(fs.existsSync(path.join(dir, 'invite.key')))
    assert.equal(fs.statSync(path.join(dir, 'invite.key')).mode & 0o777, 0o600)
    inv.rotate()
    assert.equal(shown.at(-1), a.fp, 'still presented as connections come in')

    assert.ok(inv.valid(a.token))
    assert.ok(!inv.valid('not-a-token'))
    inv.use(a.token)
    assert.ok(!inv.valid(a.token), 'a token works once')
    assert.ok(inv.valid(b.token))

    assert.equal(inv.revokeAll(), 1)
    assert.ok(!inv.valid(b.token))
    assert.ok(!fs.existsSync(path.join(dir, 'invite.key')), 'no invite open: its key is gone')
    assert.notEqual(shown.at(-1), a.fp, 'and a throwaway is presented again')
    await new Promise(r => setImmediate(r))     // let use()'s deferred rotate run before closing
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
