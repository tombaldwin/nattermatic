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
import { openStore, queries } from '../../src/store.js'

/**
 * A node called a.test with members b.test and c.test, no network and no store: just the routing.
 * `q` overrides single statements of the (otherwise inert) store; `msgRow` the lookup of a stored message.
 * @param {{ q?: Record<string, any>, msgRow?: (id: string) => any }} [o]
 */
function node({ q: statements = {}, msgRow = () => undefined } = {}) {
  const A = newIdentity(), B = newIdentity(), C = newIdentity()
  const roster = Roster.genesis(A, 'a.test')
  roster.add(A, 'b.test', B.cert)
  roster.add(A, 'c.test', C.cert)
  const cfg = /** @type {any} */ ({ host: 'a.test', port: 7777, routes: {}, peers: [], maxWaiting: 2000, maxStoreBytes: 1 << 30, ttlMs: 3600_000 })
  /** @type {Map<string, any>} */
  const rows = new Map()
  const noop = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }
  // the peers table is `rows`: an alias set by the code under test lands there
  statements.setAlias ??= { run: (/** @type {string} */ alias, /** @type {string} */ host) => { const r = rows.get(host); if (r) r.alias_of = alias; return { changes: r ? 1 : 0 } } }
  statements.insert ??= { run: () => ({ changes: 1 }) }                  // a store that takes everything
  const q = new Proxy({}, { get: (_, k) => statements[String(k)] ?? noop })
  /** @type {string[]} names the code under test took for this machine's own */
  const adopted = []
  const adoptSelfAlias = (/** @type {string} */ name) => { adopted.push(name); return false }
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
    removedHost: () => false, adoptSelfAlias, mergeRoster: () => false, kick: () => {},
  }))
  const messages = createMessages(/** @type {any} */ ({
    cfg, q, roster, me: A, now, log, tx: (/** @type {() => void} */ f) => f(), msgRow, isSelf, member, peerRow, allPeers: () => [...rows.values()],
    selfAliases: new Set(), adoptSelfAlias, hub: { pump() {}, awake: () => false, status: () => '' },
    call: async () => { throw new Error('no network here') }, hello: async () => {}, resolveName: async () => null,
    notMember: peers.notMember, nameOf: peers.nameOf, contested: peers.contested, knownPeers: peers.knownPeers,
  }))
  /**
   * What the signature check said of an envelope member `by` delivered, read off what accept did with
   * it: stored, refused for good, or not taken for now (the answer for a full store, which these
   * nodes never have unless a test makes it so). @param {any} e @param {string} [by]
   */
  const check = (e, by) => { const st = messages.accept(e, undefined, undefined, by); return st === 'queued' || st === 'live' ? 'ok' : st === 'full' ? 'over' : st === null ? 'bad' : st }
  /** @param {{ host: string, key: string }} from @param {Record<string, unknown>} [extra] @param {string} [signer] */
  const envelope = (from, extra = {}, signer = from.key) => {
    const e = { id: crypto.randomUUID(), from: `x@${from.host}`, to: 'bob@a.test', body: 'hi', sent_at: now(), expires_at: now() + 60_000, ...extra }
    return { ...e, sig: signEnvelope(signer, e) }
  }
  return { A, B: { ...B, host: 'b.test' }, C: { ...C, host: 'c.test' }, roster, rows, peers, messages, check, statements, adopted, logs, envelope, tick: (/** @type {number} */ ms) => { clock += ms }, cfg, member, now }
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
  const { check: checkEnv } = n, { accept } = n.messages
  const from = n.B.fp                                          // the delivering member, by its key
  for (let i = 0; i < CHECK_BUDGET; i++) assert.equal(checkEnv(n.envelope(n.B), from), 'ok')
  const next = n.envelope(n.B, { expires_at: n.now() + 600_000 })     // (still good after the minute below)
  assert.equal(accept(next, undefined, undefined, from), 'full', 'the allowance is spent: the sender hears what it hears for a full store, try again later')
  assert.equal(n.logs.filter(l => /b\.test delivered more messages than this machine checks at once/.test(l)).length, 1, 'said once')
  checkEnv(n.envelope(n.B), from)
  assert.equal(n.logs.filter(l => /checks at once/.test(l)).length, 1, 'not again within the minute')
  // what costs nothing to refuse isn't counted, and isn't held back
  assert.equal(checkEnv({ ...n.envelope(n.B), body: 'cut \0 short' }, from), 'bad')
  assert.equal(checkEnv(n.envelope({ host: 'nobody.test', key: newIdentity().key }), from), 'unknown-sender')
  // another member's own mail, and this machine's own sends, are not held back by it
  assert.equal(checkEnv(n.envelope(n.C), n.C.fp), 'ok')
  assert.equal(checkEnv(n.envelope(n.B)), 'ok')
  // it refills by the minute
  n.tick(60_000)
  assert.equal(checkEnv(next, from), 'ok')
})

test('an envelope that failed its check is remembered, so sending it again costs nothing, and only that one is refused', () => {
  const n = node()
  const { check: checkEnv } = n
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
  const early = n.envelope({ host: 'b.test', key: B2.key }, { expires_at: n.now() + 600_000 })
  n.tick(60_000)
  assert.equal(checkEnv(early, by), 'bad')
  n.roster.remove(n.A, n.B.fp)
  n.roster.add(n.A, 'b.test', B2.cert)
  assert.equal(checkEnv(early, by), 'ok')
})

test('what can\'t be stored is refused before its signature is checked, so retrying it costs the sender nothing', () => {
  /** @type {Map<string, any>} */
  const stored = new Map()
  // every session here is full
  const n = node({ q: { waiting: { get: () => ({ n: 2000 }) } }, msgRow: id => stored.get(id) })
  const { accept } = n.messages
  const by = n.B.fp
  for (let i = 0; i < CHECK_BUDGET + 5; i++) assert.equal(accept(n.envelope(n.B), undefined, undefined, by), 'full')
  const old = { sent_at: n.now() - 120_000, expires_at: n.now() - 1 }
  for (let i = 0; i < CHECK_BUDGET + 5; i++) assert.equal(accept(n.envelope(n.B, old), undefined, undefined, by), 'expired')
  // a copy of a message already here is taken again (it was checked when it was stored) ...
  const e = n.envelope(n.B)
  stored.set(e.id, { id: e.id, from_addr: e.from, to_addr: e.to, body: e.body, sent_at: e.sent_at, expires_at: e.expires_at, role: 'inbox', state: 'queued' })
  for (let i = 0; i < CHECK_BUDGET + 5; i++) assert.equal(accept(e, undefined, undefined, by), 'queued')
  // ... and another message under an id already here is refused, whoever signed it
  assert.equal(accept({ ...n.envelope(n.B, { body: 'another' }), id: e.id }, undefined, undefined, by), null)
  n.statements.waiting = { get: () => ({ n: 0 }) }                      // room again
  assert.equal(n.check(n.envelope(n.B), by), 'ok', 'none of that counted against the allowance')
  assert.equal(n.logs.filter(l => /checks at once/.test(l)).length, 0)
})

test('a check is charged to the machine whose signature it is, and a failed one to the machine that delivered it', () => {
  const n = node()
  const { check: checkEnv } = n
  // c.test hands on b.test's mail (copies it held for us): that is b.test's allowance, not c.test's
  for (let i = 0; i < CHECK_BUDGET; i++) assert.equal(checkEnv(n.envelope(n.B), n.C.fp), 'ok')
  assert.equal(checkEnv(n.envelope(n.B), n.C.fp), 'over', "b.test's allowance is spent")
  assert.equal(checkEnv(n.envelope(n.B), n.B.fp), 'over', 'however its mail arrives')
  assert.equal(checkEnv(n.envelope(n.C), n.C.fp), 'ok', "c.test's own mail still gets through")
  assert.equal(checkEnv(n.envelope(n.C), n.B.fp), 'over', 'b.test, with nothing left, delivers nothing for now: not even what it holds for c.test')
  assert.match(n.logs.join('\n'), /c\.test delivered more messages from b\.test than this machine checks at once/)
  // forgeries in b.test's name, delivered by c.test, cost c.test, not b.test
  n.tick(60_000)
  for (let i = 0; i < CHECK_BUDGET; i++) assert.equal(checkEnv(n.envelope(n.B, {}, n.C.key), n.C.fp), 'bad')
  assert.equal(checkEnv(n.envelope(n.B), n.C.fp), 'over', "c.test has nothing left: nothing it delivers is checked, in anyone's name")
  assert.equal(checkEnv(n.envelope(n.C), n.B.fp), 'over', 'nor what others deliver in its name')
  assert.equal(checkEnv(n.envelope(n.B), n.B.fp), 'ok', "b.test's own allowance is whole")
})

/** b.test has answered under desk.ts.net, and then a machine of c.test's is listed as desk.ts.net. @param {ReturnType<typeof node>} n */
function contest(n) {
  n.rows.set('desk.ts.net', { host: 'desk.ts.net', addr: 'desk.ts.net:7777', last_seen: n.now(), configured: 0, alias_of: 'b.test' })
  const D = newIdentity()
  n.roster.add(n.C, 'desk.ts.net', D.cert)
  assert.ok(n.peers.contested('desk.ts.net'))
  return { ...D, host: 'desk.ts.net' }
}

test('a contest ends when the listed machine answers at the name, and until then outlasts a quiet month', async () => {
  const n = node()
  contest(n)
  assert.deepEqual(n.peers.contestedNames(), ['desk.ts.net'], 'the row that carries the contest is kept from gc')
  // b.test answering there again changes nothing
  n.peers.settle('desk.ts.net', /** @type {any} */ (n.member('b.test')))
  assert.ok(n.peers.contested('desk.ts.net'))
  // another member answering there: the name stands for that one now, and is still two machines' name
  n.peers.settle('desk.ts.net', /** @type {any} */ (n.member('c.test')))
  assert.equal(n.peers.contested('desk.ts.net')?.answered.host, 'c.test')
  assert.match(n.peers.notMember('desk.ts.net'), /c\.test has answered under it/)
  // this machine answering there changes nothing either: the name is a listed member's, and can't become
  // one of ours (its mail would come to sessions here)
  n.peers.settle('desk.ts.net', /** @type {any} */ (n.roster.members.get(n.A.fp)))
  assert.ok(n.peers.contested('desk.ts.net'))
  assert.deepEqual(n.adopted, [], 'not taken as a name of this machine')
  assert.match(n.logs.join('\n'), /desk\.ts\.net is answered by this machine, but is listed as another's/)
  // the listed machine answering there (by its key): the alias was stale, and the name is its alone
  n.peers.settle('desk.ts.net', /** @type {any} */ (n.member('desk.ts.net')))
  assert.equal(n.peers.contested('desk.ts.net'), null)
  assert.deepEqual(n.peers.contestedNames(), [])
  assert.equal(await n.messages.routeFor('desk.ts.net'), 'desk.ts.net')
  assert.equal(n.rows.get('desk.ts.net')?.alias_of, null, 'no alias: not of itself either')
  assert.match(n.logs.join('\n'), /desk\.ts\.net is answered by the machine listed under it/)
})

test('an address the listed machine answered at is refused like the name, and what it sends under the name waits', async () => {
  const n = node()
  const D = contest(n)
  const { routeFor, localSend, accept } = n.messages
  // the listed machine has answered at an address (by key): that address stands for the contested name
  n.rows.set('100.64.0.5', { host: '100.64.0.5', addr: '100.64.0.5:7777', last_seen: n.now(), configured: 0, alias_of: 'desk.ts.net' })
  assert.equal(await routeFor('100.64.0.5'), null)
  await assert.rejects(localSend({ to: 'x@100.64.0.5', body: 'to whom?' }), (/** @type {any} */ e) =>
    e.status === 409 && /^100\.64\.0\.5 is answered by the machine listed as desk\.ts\.net, and desk\.ts\.net is two machines' name: b\.test has answered under it/.test(e.message))
  // what the listed machine sends under the name isn't shown to a session here as that name's: it
  // waits (unchecked) like mail to the name, until one of them is removed
  assert.equal(accept(n.envelope(D), undefined, undefined, D.fp), 'full')
  assert.equal(accept(n.envelope(D, { to: 'x@c.test' }), undefined, undefined, D.fp), 'full', 'nor held for another machine')
  assert.match(n.logs.join('\n'), /desk\.ts\.net is two machines' name: its messages wait/)
  assert.equal(accept(n.envelope(n.B), undefined, undefined, n.B.fp), 'queued', "b.test's own mail is unaffected")
  // b.test removed: the listed machine keeps the name, and its address
  n.roster.remove(n.A, n.B.fp)
  assert.equal(await routeFor('100.64.0.5'), 'desk.ts.net')
  assert.equal(accept(n.envelope(D), undefined, undefined, D.fp), 'queued')
})

test('mail queued under a name while two machines claim it waits, then goes to the one that is left', async () => {
  const db = openStore(':memory:')
  const q = queries(db)
  const n = node()
  // the same node, over a real store
  const rows = () => /** @type {any[]} */ (q.peers.all())
  const peerRow = (/** @type {string} */ h) => /** @type {any} */ (q.peer.get(h))
  const isSelf = (/** @type {string} */ h) => h === 'a.test'
  const peers = createPeers(/** @type {any} */ ({
    cfg: n.cfg, me: n.A, roster: n.roster, q, peerRow, allPeers: rows, now: n.now, log: () => {}, isSelf, member: n.member,
    removedHost: () => false, adoptSelfAlias: () => false, mergeRoster: () => false, kick: () => {},
  }))
  /** @type {{ host: string, body: any }[]} */
  const calls = []
  const messages = createMessages(/** @type {any} */ ({
    cfg: n.cfg, q, roster: n.roster, me: n.A, now: n.now, log: () => {}, tx: (/** @type {() => void} */ f) => f(), msgRow: (/** @type {string} */ id) => q.get.get(id), isSelf, member: n.member, peerRow, allPeers: rows,
    selfAliases: new Set(), adoptSelfAlias: () => false, hub: { pump() {}, awake: () => false, status: () => '' },
    call: async (/** @type {string} */ host, /** @type {string} */ _m, /** @type {string} */ _p, /** @type {any} */ body) => { calls.push({ host, body }); return { results: Object.fromEntries(body.messages.map((/** @type {any} */ e) => [e.id, 'queued'])) } },
    hello: async () => {}, resolveName: async () => null, notMember: peers.notMember, nameOf: peers.nameOf, contested: peers.contested, knownPeers: peers.knownPeers,
  }))
  const settled = () => new Promise(r => setTimeout(r, 20))
  // desk.ts.net is a nickname only this machine uses for b.test; then c.test lists a machine as desk.ts.net
  q.upsertPeer.run('desk.ts.net', 'desk.ts.net:7777', n.now(), 0)
  q.setAlias.run('b.test', 'desk.ts.net')
  const D = newIdentity()
  n.roster.add(n.C, 'desk.ts.net', D.cert)
  q.insert.run('m1', 'cli@a.test', 'x@desk.ts.net', 'desk.ts.net', 'x', 'queued earlier, under the nickname', n.now(), n.now() + 3600_000, 'sig', 'outbox', 'pending', 0, n.now())
  messages.flush()
  await settled()
  let r = /** @type {any} */ (q.get.get('m1'))
  assert.equal(r.state, 'pending', 'it waits')
  assert.match(r.last_error, /desk\.ts\.net is two machines' name/)
  assert.equal(calls.length, 0, 'and goes to neither')
  // the listed machine is removed: it goes to b.test, as mail for a name only we use for it
  n.roster.remove(n.A, D.fp)
  n.tick(120_000)
  messages.flush()
  await settled()
  r = q.get.get('m1')
  assert.equal(r.state, 'forwarded')
  assert.deepEqual(calls.map(c => [c.host, c.body.mine]), [['b.test', ['m1']]])
  db.close()
})
