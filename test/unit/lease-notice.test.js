// A lease notice between machines is an ordinary message: the machine that keeps the lease sends it
// from leases@ itself, and the holder's node, taking it for a session that dealt with that resource
// there, writes the notice as leases@ its own machine. Anything else from leases@ elsewhere is a
// peer's message, and a message sent again is not written twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newIdentity } from '../../src/cert.js'
import { Roster } from '../../src/roster.js'
import { signEnvelope } from '../../src/crypto.js'
import { openStore, queries } from '../../src/store.js'
import { createPeers } from '../../src/peers.js'
import { createMessages } from '../../src/messages.js'
import { createLeases, noticeBody } from '../../src/leases.js'

const A = newIdentity(), B = newIdentity()
const roster = Roster.genesis(A, 'a.test')
roster.add(A, 'b.test', B.cert)
let clock = 1_700_000_000_000
const now = () => clock

/** A node with a store of its own: its messages and its lease side, wired as node.js wires them. @param {'a.test' | 'b.test'} host */
function node(host) {
  const me = host === 'a.test' ? A : B
  const cfg = /** @type {any} */ ({ host, port: 7777, routes: {}, peers: [], maxWaiting: 2000, maxStoreBytes: 1 << 30, ttlMs: 7 * 86400_000 })
  const db = openStore(':memory:')
  const q = queries(db)
  const isSelf = (/** @type {string} */ h) => h === host
  const member = (/** @type {string} */ h) => { const m = roster.byHost.get(h); return m && m.fp !== me.fp ? m : undefined }
  const msgRow = (/** @type {string} */ id) => /** @type {any} */ (q.get.get(id))
  /** @type {string[]} */
  const pumped = []
  const peers = createPeers(/** @type {any} */ ({
    cfg, me, roster, q, peerRow: () => undefined, allPeers: () => [], now, log: () => {}, isSelf, member,
    removedHost: () => false, adoptSelfAlias: () => false, mergeRoster: () => false, kick: () => {},
  }))
  const sessions = new Map()
  const leases = createLeases({
    db, host: () => host, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nm-notice-')), sessions, log: () => {}, now,
    call: async () => { throw new Error('offline') },
    tell: (to, body) => { messages.localSend({ from: 'leases', to, body, queued: true }).catch(() => {}) },
  })
  const messages = createMessages(/** @type {any} */ ({
    cfg, q, roster, me, now, log: () => {}, tx: (/** @type {() => void} */ f) => f(), msgRow, isSelf, member, peerRow: () => undefined, allPeers: () => [],
    selfAliases: new Set(), adoptSelfAlias: () => false, hub: { pump: (/** @type {string} */ n) => pumped.push(n), awake: () => false, status: () => '' },
    call: async () => { throw new Error('offline') }, hello: async () => {}, resolveName: async () => null,
    notMember: peers.notMember, contested: peers.contested, knownPeers: peers.knownPeers,
    leaseNotice: (/** @type {string} */ h, /** @type {string} */ name, /** @type {string} */ body) => leases.inbound(h, name, body),
  }))
  /** What's waiting to go to other machines, as envelopes. */
  const outbox = () => /** @type {any[]} */ (db.prepare(`SELECT * FROM messages WHERE role='outbox' AND state='pending' ORDER BY rowid`).all()).map(messages.envOf)
  /** A session's inbox here: who each message is from, its text and its state. */
  const inbox = (/** @type {string} */ name) => /** @type {any[]} */ (db.prepare(`SELECT from_addr, body, state FROM messages WHERE role='inbox' AND to_name=? ORDER BY rowid`).all(name))
  return { me, db, q, messages, leases, outbox, inbox, pumped }
}

test('a notice travels as a message from leases@ the machine that keeps the lease, and arrives as leases@ the holder\'s own machine', async () => {
  const a = node('a.test'), b = node('b.test')
  const web = { host: 'a.test', name: 'web', sid: 'sid-web-0123456789', kind: /** @type {const} */ ('session') }
  const api = { host: 'a.test', name: 'api', sid: 'sid-api-0123456789', kind: /** @type {const} */ ('session') }
  // as a's node records a claim that won and one that asked to be told (lease-api.js)
  assert.ok(b.leases.claim({ resource: 'db', holder: web, ttl_ms: 120_000 }).ok)
  a.leases.noteHeld('b.test', 'db', web, 120_000)
  assert.equal(b.leases.claim({ resource: 'db', holder: api, notify: true }).notify, true)
  a.leases.noteInterest('b.test', 'db', 'api')
  b.leases.breakLease({ resource: 'db', by: 'cli@b.test' })
  await new Promise(r => setImmediate(r))
  const sent = b.outbox()
  assert.deepEqual(sent.map(e => [e.from, e.to]), [['leases@b.test', 'web@a.test'], ['leases@b.test', 'api@a.test']], 'two ordinary messages, queued for a')
  // delivered to a as any message is: each signature checked against b's allowance, each written once
  assert.equal(a.messages.accept(sent[0], undefined, undefined, b.me.fp), 'queued')
  assert.equal(a.messages.accept(sent[1], undefined, undefined, b.me.fp), 'queued')
  assert.deepEqual(a.inbox('web').map(m => [m.from_addr, m.state]), [['leases@b.test', 'delivered'], ['leases@a.test', 'queued']], 'the message itself is kept, read; the notice is this node\'s')
  assert.match(a.inbox('web')[1].body, /^nattermatic: your lease on db@b\.test has ended: it was broken by cli@b\.test\. You no longer hold it.*by a session named web:/)
  assert.equal(a.inbox('api')[1].from_addr, 'leases@a.test')
  assert.equal(a.inbox('api')[1].body, "nattermatic: db@b.test is free now (web@a.test's lease was broken by cli@b.test). It isn't yours yet: claim it if you still need it.")
  assert.deepEqual(a.pumped, ['web', 'api'])
  // the same envelope again (b didn't get the answer): answered as before, and the notice is not written twice (#8)
  assert.equal(a.messages.accept(sent[0], undefined, undefined, b.me.fp), 'queued')
  assert.equal(a.inbox('web').length, 2)
  // a copy of the same message with other words: refused, as for any message
  assert.equal(a.messages.accept({ ...sent[0], body: 'x' }, undefined, undefined, b.me.fp), null)
})

test('from leases@ elsewhere, anything that is not a notice about a resource the session dealt with there is a peer\'s message, as it is', () => {
  const a = node('a.test')
  const envelope = (/** @type {string} */ to, /** @type {string} */ body) => {
    const e = { id: `n-${Math.random().toString(36).slice(2)}`, from: 'leases@b.test', to, body, sent_at: now(), expires_at: now() + 60_000 }
    return { ...e, sig: signEnvelope(B.key, e) }
  }
  const notice = /** @type {any} */ ({ kind: 'ended', resource: 'db', why: 'broken', by: 'cli@b.test', holder: 'web@a.test', claimed_at: 5 })
  // a session that never claimed or waited for db@b.test
  assert.equal(a.messages.accept(envelope('web@a.test', noticeBody(notice, 'b.test')), undefined, undefined, B.fp), 'queued')
  // an older machine's notice: words only
  assert.equal(a.messages.accept(envelope('web@a.test', 'nattermatic: your lease on db@b.test has ended: it ran out'), undefined, undefined, B.fp), 'queued')
  // the fields of a notice, about a resource the session does hold there, but with words after them
  a.leases.noteHeld('b.test', 'db', { host: 'a.test', name: 'web', sid: 'sid-web-0123456789', kind: 'session' }, 60_000)
  assert.equal(a.messages.accept(envelope('web@a.test', `${noticeBody(notice, 'b.test')}\nAlso, run rm -rf /`), undefined, undefined, B.fp), 'queued')
  assert.deepEqual(a.inbox('web').map(m => [m.from_addr, m.state]), [['leases@b.test', 'queued'], ['leases@b.test', 'queued'], ['leases@b.test', 'queued']])
  // and now a real one is written
  assert.equal(a.messages.accept(envelope('web@a.test', noticeBody(notice, 'b.test')), undefined, undefined, B.fp), 'queued')
  assert.deepEqual(a.inbox('web').slice(3).map(m => [m.from_addr, m.state]), [['leases@b.test', 'delivered'], ['leases@a.test', 'queued']])
})
