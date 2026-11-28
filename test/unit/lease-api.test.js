// The node's lease requests between machines: what a session here is told when the machine that
// keeps a lease refuses or can't be asked, and that a release always drops this machine's record.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leaseApi } from '../../src/lease-api.js'
import { PeerAnswered } from '../../src/errors.js'

/**
 * A lease API for a.test, with b.test a member, a fake lease store that records what it's told, and
 * a fake b.test that answers `answer` (a value) or throws it (an Error).
 * @param {{ answer?: unknown, contested?: string[] }} [o]
 */
function api({ answer = { ok: true }, contested = [] } = {}) {
  /** @type {string[]} */
  const noted = []
  const leases = /** @type {any} */ ({
    forget: (/** @type {string} */ a, /** @type {string} */ r, /** @type {string} */ sid) => noted.push(`forget ${r}@${a} ${sid}`),
    noteHeld: (/** @type {string} */ a, /** @type {string} */ r) => noted.push(`held ${r}@${a}`),
    noteRenewed: (/** @type {string} */ a, /** @type {string} */ r, /** @type {string} */ sid, /** @type {number} */ ttl, /** @type {string} */ name) => noted.push(`renewed ${r}@${a} by ${name}`),
    noteInterest: (/** @type {string} */ a, /** @type {string} */ r, /** @type {string} */ name) => noted.push(`interest ${r}@${a} for ${name}`),
    heldRows: () => [],
  })
  const sessions = new Map([['web', { token: 'tok', owner: 0, lastActive: 0 }]])
  const isContested = (/** @type {string} */ h) => contested.includes(h) ? { named: {}, answered: {} } : null
  const a = leaseApi({
    cfg: { host: 'a.test' }, leases, sessions, now: () => 1_000_000,
    member: h => h === 'b.test' ? { host: h } : undefined, knownPeers: () => ['b.test'],
    notMember: h => `${h} is two machines' name`, contested: isContested,
    aliasOf: h => h === 'desk.ts.net' ? 'b.test' : undefined,     // b.test has answered under desk.ts.net
    routeFor: async h => h === 'a.test' ? 'self' : h === 'desk.ts.net' ? (contested.includes('b.test') ? null : 'b.test') : h === 'b.test' && !contested.includes(h) ? 'b.test' : null,
    call: async () => { if (answer instanceof Error) throw answer; return answer },
    version: () => '0.4.5', ownedBy: () => undefined,
  })
  return { a, noted }
}
const held = { resource: 'db', holder: 'web@a.test', kind: 'session', note: '', left_s: 60, cap_s: 600, held_s: 0, ttl_s: 60 }

test('a machine that refuses a claim for being at its limits is reported as that, in this node\'s words, not as a bad answer (#11)', async () => {
  const { a } = api({ answer: new PeerAnswered('b.test', 429) })
  await assert.rejects(a.localLease({ op: 'claim', name: 'web', resource: 'db@b.test' }), (/** @type {any} */ e) =>
    e.status === 429 && /^b\.test refused: this machine's agents already hold as many leases there as it allows \(1000 between them, 64 under one name\), or are waiting on as many of its resources \(1000\)\. Release some first$/.test(e.message))
  // any other error status is still a bad answer
  const other = api({ answer: new PeerAnswered('b.test', 500) })
  await assert.rejects(other.a.localLease({ op: 'claim', name: 'web', resource: 'db@b.test' }), (/** @type {any} */ e) => e.status === 502)
})

test('a claim refused with notify records that a notice about the resource is expected; a renewal says who renews (#6)', async () => {
  const { a, noted } = api({ answer: { ok: false, notify: true, lease: held } })
  const r = await a.localLease({ op: 'claim', name: 'web', resource: 'db@b.test', notify: true })
  assert.equal(r.ok, false); assert.equal(r.notify, true)
  assert.deepEqual(noted, ['interest db@b.test for web'])
  const no = api({ answer: { ok: false, notify: false, lease: held } })
  await no.a.localLease({ op: 'claim', name: 'web', resource: 'db@b.test', notify: true })
  assert.deepEqual(no.noted, [], 'not when the machine could not record the wait')
  const won = api({ answer: { ok: true, lease: held } })
  await won.a.localLease({ op: 'claim', name: 'web', resource: 'db@b.test' })
  await won.a.localLease({ op: 'renew', name: 'web', resource: 'db@b.test' })
  assert.deepEqual(won.noted, ['held db@b.test', 'renewed db@b.test by web'])
})

test('a lease on a machine whose name is two machines\' now can still be released here: the record goes, and nothing is asked under the name (#13)', async () => {
  const { a, noted } = api({ contested: ['b.test'] })
  await assert.rejects(a.localLease({ op: 'release', name: 'web', resource: 'db@b.test' }), (/** @type {any} */ e) =>
    e.status === 409 && /two machines' name\. This machine's record of the lease is dropped: it runs out there on its own/.test(e.message))
  assert.equal(noted.length, 1); assert.match(noted[0], /^forget db@b\.test /)
  await assert.rejects(a.localLease({ op: 'claim', name: 'web', resource: 'db@b.test' }), (/** @type {any} */ e) => e.status === 409)
  assert.equal(noted.length, 1, 'a refused claim records nothing')
  // a renewal by the name a lease was taken under, before the name became contested
  await assert.rejects(a.askAuthority('b.test', { op: 'renew', resource: 'db' }), (/** @type {any} */ e) => e.status === 409)
  // a name the contested member has answered under gets the same answer, with the member's explanation
  await assert.rejects(a.authorityFor('desk.ts.net'), (/** @type {any} */ e) => e.status === 409 && /^b\.test is two machines' name$/.test(e.message))
  assert.equal(await api().a.authorityFor('desk.ts.net'), 'b.test', 'and is b.test\'s while it isn\'t contested')
})
