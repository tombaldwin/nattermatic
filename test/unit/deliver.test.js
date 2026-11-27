// What a node does with a name two machines claim, and with more delivered envelopes than it checks
// at once: nothing goes to the wrong machine, and nothing honest is dropped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { newIdentity } from '../../src/cert.js'
import { Roster } from '../../src/roster.js'
import { signEnvelope } from '../../src/crypto.js'
import { createPeers } from '../../src/peers.js'
import { createMessages, CHECK_BUDGET } from '../../src/messages.js'
import { leaseApi } from '../../src/lease-api.js'

/** A node called a.test with members b.test and c.test, no network and no store: just the routing. */
function node() {
  const A = newIdentity(), B = newIdentity(), C = newIdentity()
  const roster = Roster.genesis(A, 'a.test')
  roster.add(A, 'b.test', B.cert)
  roster.add(A, 'c.test', C.cert)
  const cfg = /** @type {any} */ ({ host: 'a.test', port: 7777, routes: {}, peers: [], maxWaiting: 2000, maxStoreBytes: 1 << 30, ttlMs: 3600_000 })
  /** @type {Map<string, any>} */
  const rows = new Map()
  const noop = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }
  const q = new Proxy({}, { get: () => noop })
  let clock = 1_700_000_000_000
  const now = () => clock
  /** @type {string[]} */
  const logs = []
  const log = (/** @type {unknown[]} */ ...a) => logs.push(a.join(' '))
  const isSelf = (/** @type {string} */ h) => h === 'a.test'
  const member = (/** @type {string} */ h) => { const m = roster.byHost.get(h); return m && m.fp !== A.fp ? m : undefined }
  const peerRow = (/** @type {string} */ h) => rows.get(h)
  const peers = createPeers(/** @type {any} */ ({
    cfg, me: A, roster, q, peerRow, allPeers: () => [...rows.values()], now, log, isSelf, member,
    removedHost: () => false, adoptSelfAlias: () => false, mergeRoster: () => false, kick: () => {},
  }))
  const messages = createMessages(/** @type {any} */ ({
    cfg, q, roster, me: A, now, log, tx: (/** @type {() => void} */ f) => f(), msgRow: () => undefined, isSelf, member, peerRow, allPeers: () => [...rows.values()],
    selfAliases: new Set(), adoptSelfAlias: () => false, hub: { pump() {}, awake: () => false, status: () => '' },
    call: async () => { throw new Error('no network here') }, hello: async () => {}, resolveName: async () => null,
    notMember: peers.notMember, contested: peers.contested, knownPeers: peers.knownPeers,
  }))
  /** @param {{ host: string, key: string }} from @param {Record<string, unknown>} [extra] @param {string} [signer] */
  const envelope = (from, extra = {}, signer = from.key) => {
    const e = { id: crypto.randomUUID(), from: `x@${from.host}`, to: 'bob@a.test', body: 'hi', sent_at: now(), expires_at: now() + 60_000, ...extra }
    return { ...e, sig: signEnvelope(signer, e) }
  }
  return { A, B: { ...B, host: 'b.test' }, C: { ...C, host: 'c.test' }, roster, rows, peers, messages, logs, envelope, tick: (/** @type {number} */ ms) => { clock += ms }, cfg, member, now }
}

test('a member name another member has answered under is no one\'s: nothing is routed to either until one is removed', async () => {
  const n = node()
  const { routeFor } = n.messages
  assert.equal(await routeFor('b.test'), 'b.test')
  // b.test has answered at desk.ts.net (its Tailscale name): messages for that name go to it
  n.rows.set('desk.ts.net', { host: 'desk.ts.net', addr: 'desk.ts.net:7777', last_seen: n.now(), configured: 0, alias_of: 'b.test' })
  assert.equal(await routeFor('desk.ts.net'), 'b.test')
  assert.equal(n.peers.contested('desk.ts.net'), null)
  // then a member lists a machine of its own as desk.ts.net
  const D = newIdentity()
  n.roster.add(n.C, 'desk.ts.net', D.cert)
  assert.ok(n.member('desk.ts.net'), 'it is a member under that name')
  assert.equal(await routeFor('desk.ts.net'), null, 'neither machine gets what is addressed to the name')
  const c = n.peers.contested('desk.ts.net')
  assert.equal(c?.named.fp, D.fp)
  assert.equal(c?.answered.fp, n.B.fp)
  const why = n.peers.notMember('desk.ts.net')
  assert.match(why, /desk\.ts\.net is two machines' name: b\.test has answered under it, and a machine added by c\.test is listed as desk\.ts\.net/)
  assert.match(why, /natter remove desk\.ts\.net removes the listed one, natter remove b\.test the other/)
  // leases on its resources are no one's either, and say why
  const api = leaseApi(/** @type {any} */ ({ cfg: n.cfg, leases: {}, sessions: new Map(), now: n.now, member: n.member, knownPeers: n.peers.knownPeers, notMember: n.peers.notMember, routeFor, call: async () => ({}), version: () => null, ownedBy: () => undefined }))
  await assert.rejects(api.authorityFor('desk.ts.net'), (/** @type {any} */ e) => e.status === 409 && /two machines' name/.test(e.message))
  assert.equal(await api.authorityFor('b.test'), 'b.test')
  assert.equal(await api.authorityFor('a.test'), 'a.test')
  await assert.rejects(api.authorityFor('nowhere.test'), (/** @type {any} */ e) => e.status === 404 && /not a machine on this network/.test(e.message))
  // a send from here is refused with the reason, not queued or sent to one of them
  await assert.rejects(n.messages.localSend({ to: 'x@desk.ts.net', body: 'who gets this?' }), (/** @type {any} */ e) => e.status === 409 && /two machines' name/.test(e.message))
  // the listed machine removed: the name is b.test's again
  n.roster.remove(n.A, D.fp)
  assert.equal(await routeFor('desk.ts.net'), 'b.test')
  assert.equal(n.peers.contested('desk.ts.net'), null)
  // b.test removed instead: the listed machine keeps its name, and a stale alias doesn't contest it
  const D2 = newIdentity()
  n.roster.add(n.A, 'desk2.ts.net', D2.cert)
  n.rows.set('desk2.ts.net', { host: 'desk2.ts.net', addr: null, last_seen: n.now(), configured: 0, alias_of: 'c.test' })
  n.roster.remove(n.A, n.C.fp)
  assert.equal(await routeFor('desk2.ts.net'), 'desk2.ts.net')
  // a member reached under its own name is not two machines
  n.rows.set('b.test', { host: 'b.test', addr: null, last_seen: n.now(), configured: 0, alias_of: 'b.test' })
  assert.equal(await routeFor('b.test'), 'b.test')
  // this machine's own names stay its own, whatever a member lists
  n.rows.set('a.test', { host: 'a.test', addr: null, last_seen: n.now(), configured: 0, alias_of: 'b.test' })
  assert.equal(await routeFor('a.test'), 'self')
})

test('a member\'s delivered envelopes are checked up to an allowance; the rest are answered "try later", never dropped', () => {
  const n = node()
  const { checkEnv, accept } = n.messages
  const from = n.B.fp                                          // the delivering member, by its key
  for (let i = 0; i < CHECK_BUDGET; i++) assert.equal(checkEnv(n.envelope(n.B), from), 'ok')
  const next = n.envelope(n.B)
  assert.equal(checkEnv(next, from), 'over', 'the allowance is spent')
  assert.equal(accept(next, undefined, undefined, from), 'full', 'the sender hears what it hears for a full store: try again later')
  assert.equal(n.logs.filter(l => /b\.test delivered more messages than this machine checks at once/.test(l)).length, 1, 'said once')
  checkEnv(n.envelope(n.B), from)
  assert.equal(n.logs.filter(l => /checks at once/.test(l)).length, 1, 'not again within the minute')
  // what costs nothing to refuse isn't counted, and isn't held back
  assert.equal(checkEnv({ ...n.envelope(n.B), body: 'cut \0 short' }, from), 'bad')
  assert.equal(checkEnv(n.envelope({ host: 'nobody.test', key: newIdentity().key }), from), 'unknown-sender')
  // another member's deliveries, and this machine's own sends, are not held back by it
  assert.equal(checkEnv(n.envelope(n.B), n.C.host), 'ok')
  assert.equal(checkEnv(n.envelope(n.B)), 'ok')
  // it refills by the minute
  n.tick(60_000)
  assert.equal(checkEnv(next, from), 'ok')
})

test('an envelope that failed its check is remembered, so sending it again costs nothing, and only that one is refused', () => {
  const n = node()
  const { checkEnv } = n.messages
  const by = 'deliverer'
  const real = n.envelope(n.B)
  const forged = n.envelope(n.B, {}, n.C.key)                   // claims b.test, signed by c.test
  const altered = { ...real, body: 'altered' }                 // the real signature on changed text
  assert.equal(checkEnv(forged, by), 'bad')
  assert.equal(checkEnv(altered, by), 'bad')
  assert.equal(checkEnv(real, by), 'ok', 'the real one still passes: a copy of its signature on other text blocks nothing')
  // spend the allowance: a remembered forgery is still refused at once, where a new envelope must wait
  for (let i = 0; checkEnv(n.envelope(n.B), by) === 'ok'; i++) assert.ok(i <= CHECK_BUDGET)
  assert.equal(checkEnv(forged, by), 'bad')
  assert.equal(checkEnv(altered, by), 'bad')
  assert.equal(checkEnv(n.envelope(n.B), by), 'over')
  // a machine back under a new key, before we heard of it: what failed against the old key passes against the new
  const B2 = newIdentity()
  const early = n.envelope({ host: 'b.test', key: B2.key })
  n.tick(60_000)
  assert.equal(checkEnv(early, by), 'bad')
  n.roster.remove(n.A, n.B.fp)
  n.roster.add(n.A, 'b.test', B2.cert)
  assert.equal(checkEnv(early, by), 'ok')
})
