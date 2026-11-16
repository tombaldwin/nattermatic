// The message state machine (#3): every statement that changes a message's state, tried on a
// message in every role and state, moves exactly the ones the table of moves allows. A bystander in
// the same role and state, for another machine and not yet expired, is never moved: a statement
// that lost its row filter would move it too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore, queries, MOVES } from '../../src/store.js'

const ROLES = ['outbox', 'held', 'inbox']
const STATES = ['pending', 'forwarded', 'queued', 'pushed', 'delivered', 'expired', 'failed']

test('each statement makes only the moves in the table', () => {
  const db = openStore(':memory:')
  const q = queries(db)
  const T = 1_000_000
  /** statement -> how to run it on message `id` (to host 'h'), and where a moved message ends up */
  const runs = {
    forwarded: { run: (/** @type {string} */ id) => q.forwarded.run(T, id), to: 'forwarded' },
    failed: { run: (/** @type {string} */ id) => q.failed.run('no', T, id), to: 'failed' },
    expire: { run: () => q.expire.run(T, T + 1), to: 'expired' },
    toInbox: { run: () => q.toInbox.all('me', T, 'h'), to: 'inbox:queued' },
    claim: { run: (/** @type {string} */ id) => q.claim.run('me', 'api', T, id), to: 'inbox:queued', only: ['held:pending'] },
    pushed: { run: (/** @type {string} */ id) => q.pushed.run(T, id), to: 'pushed' },
    delivered: { run: (/** @type {string} */ id) => q.delivered.run(T, id), to: 'delivered' },
  }
  for (const [name, { run, to, only }] of Object.entries(runs)) {
    const allowed = /** @type {string[]} */ (only ?? MOVES[/** @type {keyof typeof MOVES} */ (to)])
    for (const role of ROLES) for (const state of STATES) {
      db.exec('DELETE FROM messages')
      // expires at T: past for `expire`, which is the only statement that looks at it
      q.insert.run('m', 'a@x', 'b@h', 'h', 'b', 'text', 1, T, 'sig', role, state, 0, 1)
      q.insert.run('other', 'a@x', 'b@g', 'g', 'b', 'text', 1, T + 10, 'sig', role, state, 0, 1)
      run('m')
      const o = /** @type {any} */ (db.prepare('SELECT role, state FROM messages WHERE id=?').get('other'))
      assert.equal(`${o.role}:${o.state}`, `${role}:${state}`, `${name} moved a message it wasn't run on`)
      const r = /** @type {any} */ (db.prepare('SELECT role, state FROM messages WHERE id=?').get('m'))
      const now = to.includes(':') ? `${r.role}:${r.state}` : r.state
      const moved = `${r.role}:${r.state}` !== `${role}:${state}`
      const should = allowed.includes(`${role}:${state}`)
      if (should) assert.equal(now, to, `${name} moves ${role}:${state} to ${to}`)
      else assert.ok(!moved, `${name} must not move ${role}:${state} (it became ${r.role}:${r.state})`)
    }
  }
  db.close()
})

test('a message handed over elsewhere meanwhile is not then marked failed', () => {
  const db = openStore(':memory:')
  const q = queries(db)
  q.insert.run('m', 'a@x', 'b@h', 'h', 'b', 'text', 1, 9e12, 'sig', 'outbox', 'pending', 0, 1)
  q.forwarded.run(2, 'm')
  q.failed.run('rejected by h', 3, 'm')
  assert.equal(/** @type {any} */ (db.prepare('SELECT state FROM messages').get()).state, 'forwarded')
  db.close()
})
