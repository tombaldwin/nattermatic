// Leases: an agent's claim on a shared resource outside git (a test database, a checkout, a port, a
// deploy), so other agents can see it's in use and wait for it instead of colliding.
//
// A resource is named like an agent, `testdb@buffy.local`, and the node of the machine it names is
// the only one that keeps its leases ("the authority"). Nothing is replicated and nothing needs a
// consensus: one node decides each claim, one at a time. If that machine is offline its resources
// can't be claimed, which is fine: nobody can use them either. Leases are advisory: a tool that
// wants to enforce them asks the node (GET /local/lease) before acting.
//
// A lease ends at whichever comes first:
//   - its holder releases it
//   - it isn't renewed in time (its ttl). A renewal only ever extends a lease that still exists: a
//     lease that has ended is never taken again except by a new claim. A session's lease is renewed
//     by its node while the session itself is active (its heartbeat after each tool call, its turns,
//     its own claims), and a `natter lease run` lease while its command runs
//   - its hard cap, set when it was taken, whatever renews it
//   - its holder's session has gone: the authority asks the holder's machine, and if that machine
//     can't be reached the lease is kept until its ttl (it fails safe). A session that comes back
//     under the same name on the same machine, before then, keeps its leases (an adapter restart)
//   - a person breaks it (`natter lease break`, never an agent tool); the holder is told
//
// When a lease ends, its holder and anyone waiting for the resource get a notice from leases@ on
// their own machine. For a holder or waiter on another machine, the authority sends an ordinary
// signed message from leases@ itself: readable text, with the fixed fields (what ended, why, who held
// it) on its last line. So it travels like any message (queued while that machine is off, with copies,
// one id, the sender's allowance). The holder's node, taking the message for one of its sessions,
// writes the notice itself from the fields, as leases@ there, if that session claimed or asked about
// that resource on that machine (see `inbound`): no words of another machine's reach a session as
// nattermatic's, and a member can only have notices about its own resources written, for sessions
// that dealt with them. Anything else from leases@ elsewhere is shown as what it is, a peer's message.
//
// A session's lease is held by the session (its id), not just its name: a new session in the same
// folder can't renew or release it without saying it's taking it over. A terminal's claims and
// `lease run`'s are held by processes, which never count as the same holder as a session. Times are
// kept on the authority's clock and reported as seconds left, so clocks that disagree don't matter,
// and expiry is worked out when a lease is read, so a machine that sleeps needs no timers to fire.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { normHost, sanitizeName, MAX_TTL_MS as MAX_MESSAGE_TTL_MS } from './config.js'

export const DEFAULT_TTL_MS = 15 * 60_000
export const MAX_TTL_MS = 4 * 3600_000
export const MAX_CAP_MS = 4 * 3600_000
// with a session missing from its machine's list for this long, its leases end (a reconnect is quicker)
export const GONE_GRACE_MS = Number(process.env.NATTERMATIC_LEASE_GRACE_MS) || 60_000
// the shortest ttl (the end-to-end tests make it shorter, to watch leases run out)
export const MIN_TTL_MS = Number(process.env.NATTERMATIC_LEASE_MIN_MS) || 60_000
export const MAX_HELD = 64            // leases one holder may have on one machine
// ...and between all of one machine's agents: names are anyone's to make up, and the store is shared
// with messages (a machine with many sessions has far fewer leases than this)
export const MAX_HELD_HOST = 1000
const MAX_WAITERS = 50                // agents waiting to hear one resource is free
export const MAX_WAITERS_HOST = 1000  // waits by all of one machine's agents, on this machine's resources
export const MAX_NOTE = 500
export const MAX_RESOURCE = 200
const RETRY_MS = 60_000               // a machine that couldn't be reached is tried again after this
// how long a session's claim or wait on another machine's resource vouches for notices about it: a
// lease lasts at most its cap, and the notice about its end at most as long as a message can
export const INTEREST_MS = MAX_CAP_MS + MAX_MESSAGE_TTL_MS
/** The last line of a notice sent to another machine: the fixed fields, for the node there. */
export const NOTICE_TAG = 'lease-notice: '
export const SID = /^[\w-]{16,64}$/

/** @typedef {{ host: string, name: string, sid: string, kind: 'session' | 'process' }} Holder */
/**
 * @typedef {{ resource: string, holder_host: string, holder_name: string, holder_sid: string, kind: string,
 *   note: string, id: string, acquired_at: number, expires_at: number, cap_at: number, ttl_ms: number }} LeaseRow
 */
/** @typedef {{ authority: string, resource: string, name: string, sid: string, kind: string, ttl_ms: number, renewed_at: number }} HeldRow */
/** Why a lease ended: a code, never text, so the machine that hears it writes its own words. */
/** @typedef {'cap' | 'expired' | 'released' | 'broken' | 'gone'} Why */
/**
 * A notice about a lease on one machine's resource, for a holder ('ended') or a waiter ('free') on
 * another, in fixed fields. `resource` is its bare name: the machine it's on is whoever sends this.
 * `by`: who broke it, as `name@host`.
 * @typedef {{ kind: 'ended' | 'free', resource: string, why: Why, by?: string, holder: string, claimed_at: number }} Notice
 */
const WHY = {
  cap: () => 'reached its hard cap', expired: () => 'ran out (it was not renewed)', released: () => 'was released',
  broken: (/** @type {string} */ by) => `was broken by ${by}`, gone: () => 'ended because its session had gone',
}
/** @param {Pick<Notice, 'why' | 'by'>} n */
const whyText = n => WHY[n.why](n.by || 'someone')

/** `name@host`, both as a node writes them, or throw. @param {unknown} h */
function cleanAddr(h) {
  const s = String(h ?? ''), at = s.lastIndexOf('@')
  if (at < 1) throw new Error('not an address')
  return `${sanitizeName(s.slice(0, at))}@${normHost(s.slice(at + 1))}`
}

/**
 * A notice as another machine sent it, rebuilt from checked parts: each field is a code, a name as a
 * node makes it, or a number. null if it doesn't add up. @param {unknown} n @param {string} authority
 */
export function cleanNotice(n, authority) {
  const d = /** @type {Record<string, unknown>} */ (n && typeof n === 'object' ? n : {})
  const kind = d.kind === 'ended' || d.kind === 'free' ? d.kind : null
  const why = typeof d.why === 'string' && Object.hasOwn(WHY, d.why) ? /** @type {Why} */ (d.why) : null
  if (!kind || !why) return null
  try {
    const resource = parseResource(d.resource, authority).name
    const by = why === 'broken' ? { by: cleanAddr(d.by) } : {}
    const at = Number.isSafeInteger(d.claimed_at) && /** @type {number} */ (d.claimed_at) >= 0 && /** @type {number} */ (d.claimed_at) <= 8.64e15 ? /** @type {number} */ (d.claimed_at) : 0
    return /** @type {Notice} */ ({ kind, resource, why, holder: cleanAddr(d.holder), claimed_at: at, ...by })
  } catch { return null }
}

/** The notice as a session reads it, written by its own node. @param {Notice} n @param {string} authority the machine whose resource it is */
export function noticeText(n, authority) {
  const res = `${n.resource}@${authority}`, why = whyText(n)
  if (n.kind === 'free') return `nattermatic: ${res} is free now (${n.holder}'s lease ${why}). It isn't yours yet: claim it if you still need it.`
  // by name, so a session that restarted under it hears (its leases carry over to it); but a new
  // agent given the same name later may get it too (#7), so it says which claim it was
  const at = new Date(n.claimed_at).toISOString().slice(0, 16).replace('T', ' ')
  const name = n.holder.slice(0, n.holder.lastIndexOf('@'))
  return `nattermatic: your lease on ${res} has ended: it ${why}. You no longer hold it: if you still need ${res}, claim it again before using it, and check nothing changed meanwhile. (It was claimed at ${at} UTC by a session named ${name}: if you never claimed ${res}, this was for an earlier session with your name, and you can ignore it.)`
}

/**
 * A notice as it's sent to a holder or waiter on another machine: the text a node there without
 * `inbound` shows as it is (a message from leases@ the authority), and the fields on the last line,
 * from which a node that has it writes the notice itself. @param {Notice} n @param {string} authority
 */
export const noticeBody = (n, authority) => `${noticeText(n, authority)}\n\n${NOTICE_TAG}${JSON.stringify(n)}`

/**
 * The fields of a notice sent from leases@ `authority`, rebuilt from checked parts (cleanNotice), or
 * null for anything else that machine's leases@ sent. @param {string} body @param {string} authority
 */
export function parseNotice(body, authority) {
  const line = body.slice(body.lastIndexOf('\n') + 1)
  if (!line.startsWith(NOTICE_TAG) || line.length > 2000) return null
  try { return cleanNotice(JSON.parse(line.slice(NOTICE_TAG.length)), authority) } catch { return null }
}

/** A session's id as leases know it: never its token, which reclaims its name. @param {string} token */
export const sessionId = token => token ? crypto.createHash('sha256').update(`nattermatic-session:${token}`).digest('base64url').slice(0, 22) : ''

/**
 * "testdb@buffy" | "testdb" -> { name, host }. Resource names keep a few more characters than agent
 * names (a path or a port: `checkout:web-site`, `port:5432`), and are compared lower-cased.
 * @param {unknown} input @param {string} selfHost
 */
export function parseResource(input, selfHost) {
  const a = String(input ?? '').trim()
  if (a.length > MAX_RESOURCE + 300) throw new Error(`resource names are at most ${MAX_RESOURCE} characters`)
  const i = a.lastIndexOf('@')
  const name = (i < 0 ? a : a.slice(0, i)).toLowerCase().replace(/[^a-z0-9._:/+-]+/g, '-').replace(/^[-.:/]+/, '').replace(/[-.:/]+$/, '')
  if (!name) throw new Error('a resource name is needed, such as testdb or testdb@laptop.local')
  if (name.length > MAX_RESOURCE) throw new Error(`resource names are at most ${MAX_RESOURCE} characters`)
  return { name, host: i < 0 ? selfHost : normHost(a.slice(i + 1)) }
}

/** @param {number} ms */
export function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * A lease as another machine described it, rebuilt from checked parts: what another machine writes
 * must not reach a session as nattermatic's own words. Its note is the holder's own text, shown
 * quoted and marked as theirs. null if it doesn't add up.
 * @param {any} l @param {string} authority
 */
export function cleanLease(l, authority) {
  if (!l || typeof l !== 'object') return null
  let res, holder
  try {
    res = parseResource(String(l.resource ?? ''), authority)
    const h = String(l.holder ?? ''), at = h.lastIndexOf('@')
    if (at < 1) return null
    holder = `${sanitizeName(h.slice(0, at))}@${normHost(h.slice(at + 1))}`
  } catch { return null }
  const n = (/** @type {unknown} */ v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : 0
  return {
    resource: `${res.name}@${authority}`, holder, kind: l.kind === 'process' ? 'process' : 'session',
    note: String(l.note ?? '').slice(0, MAX_NOTE), left_s: n(l.left_s), cap_s: n(l.cap_s), held_s: n(l.held_s), ttl_s: n(l.ttl_s),
  }
}

/** @param {any} l */
export function formatLease(l) {
  return `held by ${l.holder}${l.kind === 'process' ? ' (a terminal or a running command)' : ''} for ${fmtLeft(l.held_s * 1000)}, ${fmtLeft(l.left_s * 1000)} left unless renewed${l.note ? `; the holder's note: ${JSON.stringify(l.note)}` : ''}`
}
/** @param {any} r */
export function formatLeases(r) {
  const lines = r.leases?.length ? r.leases.map((/** @type {any} */ l) => `- ${l.resource}: ${formatLease(l)}`) : [`No leases on ${r.host}'s resources.`]
  if (r.held?.length) lines.push('', 'Held by agents on this machine:', ...r.held.map((/** @type {any} */ h) => `- ${h.resource} (${h.holder})`))
  return lines.join('\n')
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function leaseTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leases(
      resource TEXT PRIMARY KEY, holder_host TEXT NOT NULL, holder_name TEXT NOT NULL, holder_sid TEXT NOT NULL,
      kind TEXT NOT NULL, note TEXT NOT NULL, id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, cap_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_waiters(
      resource TEXT NOT NULL, host TEXT NOT NULL, name TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY(resource, host, name));
    CREATE TABLE IF NOT EXISTS held(
      authority TEXT NOT NULL, resource TEXT NOT NULL, name TEXT NOT NULL, sid TEXT NOT NULL, kind TEXT NOT NULL,
      ttl_ms INTEGER NOT NULL, renewed_at INTEGER NOT NULL, PRIMARY KEY(authority, resource));
    CREATE TABLE IF NOT EXISTS lease_interest(
      authority TEXT NOT NULL, resource TEXT NOT NULL, name TEXT NOT NULL, until INTEGER NOT NULL,
      PRIMARY KEY(authority, resource, name));
    CREATE INDEX IF NOT EXISTS ix_leases_expiry ON leases(expires_at);
    CREATE INDEX IF NOT EXISTS ix_leases_holder ON leases(holder_host, holder_name);
    CREATE INDEX IF NOT EXISTS ix_lease_waiters_host ON lease_waiters(host);
    DROP TABLE IF EXISTS lease_notices;
  `)
}

/**
 * The lease side of a node.
 * `tell`: send `body` as a message from leases@ this machine to `to` (`name@host`): delivered now to a
 * session here, queued for one elsewhere like any message.
 * @param {{
 *   db: import('node:sqlite').DatabaseSync, host: () => string, dir: string,
 *   sessions: Map<string, { token: string, owner: number, lastActive: number }>,
 *   call: (host: string, method: string, p: string, obj?: unknown, o?: { timeout?: number }) => Promise<any>,
 *   tell: (to: string, body: string) => void,
 *   log: (...a: unknown[]) => void, now?: () => number,
 * }} o
 */
export function createLeases({ db, host, dir, sessions, call, tell: send, log, now = Date.now }) {
  leaseTables(db)
  const q = {
    get: db.prepare(`SELECT * FROM leases WHERE resource=?`),
    all: db.prepare(`SELECT * FROM leases ORDER BY resource`),
    expired: db.prepare(`SELECT * FROM leases WHERE expires_at<=?`),
    sessionLeases: db.prepare(`SELECT * FROM leases WHERE kind='session'`),
    put: db.prepare(`INSERT OR REPLACE INTO leases(resource,holder_host,holder_name,holder_sid,kind,note,id,acquired_at,expires_at,cap_at,ttl_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    renew: db.prepare(`UPDATE leases SET expires_at=?, ttl_ms=?, note=?, holder_name=? WHERE resource=? AND id=?`),
    rebind: db.prepare(`UPDATE leases SET holder_sid=?, holder_name=? WHERE resource=? AND holder_host=? AND holder_sid=?`),
    del: db.prepare(`DELETE FROM leases WHERE resource=? AND id=?`),
    count: db.prepare(`SELECT COUNT(*) AS n FROM leases WHERE holder_host=? AND holder_name=?`),
    countHost: db.prepare(`SELECT COUNT(*) AS n FROM leases WHERE holder_host=?`),
    wait: db.prepare(`INSERT OR IGNORE INTO lease_waiters(resource,host,name,added_at) VALUES (?,?,?,?)`),
    waiters: db.prepare(`SELECT host, name FROM lease_waiters WHERE resource=?`),
    nWaiters: db.prepare(`SELECT COUNT(*) AS n FROM lease_waiters WHERE resource=?`),
    nWaitersHost: db.prepare(`SELECT COUNT(*) AS n FROM lease_waiters WHERE host=?`),
    waiting: db.prepare(`SELECT 1 FROM lease_waiters WHERE resource=? AND host=? AND name=?`),
    unwait: db.prepare(`DELETE FROM lease_waiters WHERE resource=?`),
    interest: db.prepare(`INSERT OR REPLACE INTO lease_interest(authority,resource,name,until) VALUES (?,?,?,?)`),
    interested: db.prepare(`SELECT 1 FROM lease_interest WHERE authority=? AND resource=? AND name=? AND until>?`),
    gcInterest: db.prepare(`DELETE FROM lease_interest WHERE until<=?`),
    hold: db.prepare(`INSERT OR REPLACE INTO held(authority,resource,name,sid,kind,ttl_ms,renewed_at) VALUES (?,?,?,?,?,?,?)`),
    renewed: db.prepare(`UPDATE held SET renewed_at=?, ttl_ms=? WHERE authority=? AND resource=? AND sid=?`),
    reheld: db.prepare(`UPDATE held SET sid=?, name=? WHERE sid=?`),
    heldOne: db.prepare(`SELECT * FROM held WHERE authority=? AND resource=?`),
    held: db.prepare(`SELECT * FROM held`),
    unhold: db.prepare(`DELETE FROM held WHERE authority=? AND resource=?`),
    unholdBy: db.prepare(`DELETE FROM held WHERE authority=? AND resource=? AND sid=?`),
  }
  /** A count a statement returned. @param {unknown} row */
  const n = row => Number(/** @type {any} */ (row)?.n)
  /** @type {Map<string, number>} lease id -> when its holder's session was first found missing */
  const missing = new Map()
  /** @type {Map<string, number>} authority -> when it last couldn't be reached */
  const unreachable = new Map()

  // ---------------- the authority: leases on this machine's resources ----------------

  /** The lease on `resource`, ending it first if its time is up. @param {string} resource */
  function current(resource) {
    const row = /** @type {LeaseRow | undefined} */ (q.get.get(resource))
    if (!row) return null
    const t = now()
    if (t < row.expires_at && t < row.cap_at) return row
    end(row, t >= row.cap_at ? 'cap' : 'expired')
    return null
  }

  /** @param {LeaseRow} row */
  const view = row => ({
    resource: `${row.resource}@${host()}`, holder: `${row.holder_name}@${row.holder_host}`, kind: row.kind, note: row.note,
    left_s: Math.max(0, Math.round((Math.min(row.expires_at, row.cap_at) - now()) / 1000)),
    cap_s: Math.max(0, Math.round((row.cap_at - now()) / 1000)), held_s: Math.round((now() - row.acquired_at) / 1000),
    ttl_s: Math.round(row.ttl_ms / 1000),
  })

  /** Is `h` the holder of `row`? A session is its id (its name may change on a reconnect); a process its name and id. @param {LeaseRow} row @param {Holder} h */
  const holds = (row, h) => row.holder_host === h.host && row.kind === h.kind && row.holder_sid === h.sid && (h.kind === 'session' || row.holder_name === h.name)
  /** An earlier session of the same name, on the same machine. @param {LeaseRow} row @param {Holder} h */
  const earlierSelf = (row, h) => h.kind === 'session' && row.kind === 'session' && row.holder_host === h.host && row.holder_name === h.name && row.holder_sid !== h.sid

  /**
   * End a lease and tell whoever should hear: its holder (unless it let go) and anyone waiting for
   * it. @param {LeaseRow} row @param {Why} why @param {{ by?: string, tellHolder?: boolean }} [o] by: who broke it
   */
  function end(row, why, { by, tellHolder = true } = {}) {
    if (!q.del.run(row.resource, row.id).changes) return
    missing.delete(row.id)
    const holder = `${row.holder_name}@${row.holder_host}`
    log(`lease on ${row.resource}@${host()} (${holder}) ended: it ${whyText({ why, by })}`)
    /** @type {Omit<Notice, 'kind'>} */
    const about = { resource: row.resource, why, ...(by ? { by } : {}), holder, claimed_at: row.acquired_at }
    if (tellHolder && row.kind === 'session') tell(row.holder_host, row.holder_name, { kind: 'ended', ...about })
    const waiters = /** @type {{ host: string, name: string }[]} */ (q.waiters.all(row.resource))
    q.unwait.run(row.resource)
    for (const w of waiters) tell(w.host, w.name, { kind: 'free', ...about })
  }

  /**
   * A notice for `name` on machine `to`: as this node's own words to a session here, and to another
   * machine as a message from leases@ here, with the fields its node writes the notice from (noticeBody).
   * @param {string} to @param {string} name @param {Notice} notice
   */
  function tell(to, name, notice) {
    send(`${name}@${to}`, to === host() ? noticeText(notice, host()) : noticeBody(notice, host()))
  }

  /**
   * A claim on one of this machine's resources. Claiming what you hold renews it.
   * @param {{ resource: string, holder: Holder, note?: unknown, ttl_ms?: unknown, cap_ms?: unknown, notify?: unknown, takeover?: unknown }} d
   */
  function claim(d) {
    const { resource, holder } = d
    const t = now()
    const ttl = clamp(d.ttl_ms, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS)
    const note = String(d.note ?? '').slice(0, MAX_NOTE)
    const row = current(resource)
    if (row && holds(row, holder)) {
      q.renew.run(Math.min(t + ttl, row.cap_at), ttl, note || row.note, holder.name, resource, row.id)
      return { ok: true, renewed: true, lease: view(/** @type {LeaseRow} */ (q.get.get(resource))) }
    }
    if (row && !(earlierSelf(row, holder) && d.takeover === true)) {
      // notify: true in the answer means it will hear when the resource is free, so it's true only when
      // its wait is recorded: already (asking again is fine), or now, within the limits
      let waits = false
      if (d.notify === true) {
        waits = !!q.waiting.get(resource, holder.host, holder.name)
        if (!waits) {
          if (n(q.nWaitersHost.get(holder.host)) >= MAX_WAITERS_HOST) throw Object.assign(new Error(`agents on ${holder.host} already have ${MAX_WAITERS_HOST} waits on this machine's resources between them`), { status: 429 })
          if (n(q.nWaiters.get(resource)) < MAX_WAITERS) waits = q.wait.run(resource, holder.host, holder.name, t).changes > 0
        }
      }
      return { ok: false, lease: view(row), same_name: earlierSelf(row, holder), notify: waits }
    }
    if (!row) {
      if (n(q.count.get(holder.host, holder.name)) >= MAX_HELD) throw Object.assign(new Error(`${holder.name}@${holder.host} already holds ${MAX_HELD} leases here`), { status: 429 })
      if (n(q.countHost.get(holder.host)) >= MAX_HELD_HOST) throw Object.assign(new Error(`agents on ${holder.host} already hold ${MAX_HELD_HOST} leases here, between them`), { status: 429 })
    }
    const cap = clamp(d.cap_ms, MAX_CAP_MS, MIN_TTL_MS, MAX_CAP_MS)
    // a takeover hands the lease on as it is (its cap, and anyone waiting for it, stay)
    const id = row?.id ?? crypto.randomUUID(), acquired = row?.acquired_at ?? t, capAt = row?.cap_at ?? t + cap
    q.put.run(resource, holder.host, holder.name, holder.sid, holder.kind, note, id, acquired, Math.min(t + ttl, capAt), capAt, ttl)
    missing.delete(id)
    log(`lease on ${resource}@${host()} ${row ? 'taken over' : 'taken'} by ${holder.name}@${holder.host}`)
    return { ok: true, renewed: false, lease: view(/** @type {LeaseRow} */ (q.get.get(resource))) }
  }

  /**
   * A renewal: extends the holder's lease if it still has it, and never takes one that has ended.
   * @param {{ resource: string, holder: Holder, ttl_ms?: unknown }} d
   */
  function renew({ resource, holder, ttl_ms }) {
    const row = current(resource)
    if (!row || !holds(row, holder)) return { ok: false, gone: true }
    const ttl = clamp(ttl_ms, row.ttl_ms, MIN_TTL_MS, MAX_TTL_MS)
    q.renew.run(Math.min(now() + ttl, row.cap_at), ttl, row.note, holder.name, resource, row.id)
    return { ok: true, lease: view(/** @type {LeaseRow} */ (q.get.get(resource))) }
  }

  /**
   * A session that came back under the same name after its adapter restarted keeps its leases, if
   * its earlier self has gone. @param {{ resource: string, holder: Holder, old_sid: string }} d
   */
  function rebind({ resource, holder, old_sid }) {
    const row = current(resource)
    if (!row || row.kind !== 'session' || row.holder_host !== holder.host || row.holder_name !== holder.name || row.holder_sid !== old_sid) return { ok: false }
    q.rebind.run(holder.sid, holder.name, resource, holder.host, old_sid)
    missing.delete(row.id)
    return { ok: true, lease: view(/** @type {LeaseRow} */ (q.get.get(resource))) }
  }

  /** @param {{ resource: string, holder: Holder, takeover?: unknown }} d */
  function release({ resource, holder, takeover }) {
    const row = current(resource)
    if (!row) return { ok: true, released: false }
    if (!holds(row, holder) && !(earlierSelf(row, holder) && takeover === true)) return { ok: false, lease: view(row), same_name: earlierSelf(row, holder) }
    end(row, 'released', { tellHolder: false })
    return { ok: true, released: true }
  }

  /** A person, from a terminal on some machine of the network. @param {{ resource: string, by: string }} d */
  function breakLease({ resource, by }) {
    const row = current(resource)
    if (!row) return { ok: true, broken: false }
    end(row, 'broken', { by })
    return { ok: true, broken: true, lease: view(row) }
  }

  /** The leases held here (the first 1000: a list is for reading, and names are anyone's to make up). */
  function list() {
    return /** @type {LeaseRow[]} */ (q.all.all()).filter(r => current(r.resource)).slice(0, 1000).map(view)
  }

  /**
   * End leases whose time is up, and those whose holder's session has gone. A holder's machine that
   * can't be reached keeps its leases until their ttl.
   */
  async function sweep() {
    // by index, not the whole table: a lease's expiry is never later than its cap
    const t = now()
    q.gcInterest.run(t)
    for (const r of /** @type {LeaseRow[]} */ (q.expired.all(t))) end(r, t >= r.cap_at ? 'cap' : 'expired')
    /** @type {Map<string, LeaseRow[]>} */
    const byHost = new Map()
    for (const r of /** @type {LeaseRow[]} */ (q.sessionLeases.all())) byHost.set(r.holder_host, [...(byHost.get(r.holder_host) || []), r])
    await Promise.all([...byHost].map(async ([h, rs]) => {
      /** @type {Set<string> | null} */
      let live = null
      if (h === host()) live = new Set([...sessions.values()].map(s => sessionId(s.token)))
      else {
        try {
          const r = await call(h, 'GET', '/v1/sessions', undefined, { timeout: 3000 })
          if (Array.isArray(r?.sids)) live = new Set(r.sids.map(String))
        } catch {}
      }
      if (!live) return
      for (const r of rs) {
        if (live.has(r.holder_sid)) { missing.delete(r.id); continue }
        const since = missing.get(r.id) ?? now()
        missing.set(r.id, since)
        if (now() - since < GONE_GRACE_MS) continue
        const still = current(r.resource)
        // its holder is told, by name: if it's back under that name (a restart), it hears
        if (still && still.id === r.id) end(still, 'gone')
      }
    }))
  }

  // ---------------- the holder side: leases this machine's sessions hold, anywhere ----------------

  /**
   * `name` here claimed, renewed or asked about `resource` on `authority`: a notice about it from that
   * machine is written as this node's own (see inbound), for as long as one can be on its way.
   * @param {string} authority @param {string} resource @param {string} name
   */
  function noteInterest(authority, resource, name) { q.interest.run(authority, resource, name, now() + INTEREST_MS) }
  /** Remember a lease one of this machine's holders has. @param {string} authority @param {string} resource @param {Holder} holder @param {number} ttl */
  function noteHeld(authority, resource, holder, ttl) {
    q.hold.run(authority, resource, holder.name, holder.sid, holder.kind, ttl, now())
    noteInterest(authority, resource, holder.name)
    marks()
  }
  /** Forget a lease held here: `sid`'s, if given (another holder here may have it now). @param {string} authority @param {string} resource @param {string} [sid] */
  function forget(authority, resource, sid) { if (sid) q.unholdBy.run(authority, resource, sid); else q.unhold.run(authority, resource); marks() }
  /** @param {string} authority @param {string} resource @param {string} sid @param {number} ttl @param {string} name the holder's name now (it may have changed on a reconnect) */
  function noteRenewed(authority, resource, sid, ttl, name) { q.renewed.run(now(), ttl, authority, resource, sid); noteInterest(authority, resource, name) }
  const heldRows = () => /** @type {HeldRow[]} */ (q.held.all())

  /**
   * A message from leases@ `from` (a member, proved by its key) for session `name` here: the notice
   * this node writes for it, in its own words, or null to show the message as what it is, a message
   * from leases@ that machine. It's written only if it carries the fields of a notice about one of
   * `from`'s own resources (parseNotice: the resource is named for the sender, whatever it says) that
   * `name` claimed or asked about there, as far as this node knows (noteInterest), so a member can't
   * have a session told about a resource it never dealt with. The holder named in an 'ended' notice is
   * the session it's for: that's whose lease ended, whatever the message says.
   * @param {string} from @param {string} name @param {string} body
   */
  function inbound(from, name, body) {
    const n = parseNotice(body, from)
    if (!n || !q.interested.get(from, n.resource, name, now())) return null
    return noticeText(n.kind === 'ended' ? { ...n, holder: `${name}@${host()}` } : n, from)
  }

  /**
   * Renew the leases of sessions that have themselves been active since they were last renewed, a
   * third of the way through their ttl. A lease the authority no longer has is forgotten, and so is
   * one whose holder has been gone longer than its ttl. `lease run` renews its own.
   * @param {(authority: string, body: Record<string, unknown>) => Promise<any>} ask
   */
  async function renewActive(ask) {
    const bySid = new Map([...sessions].map(([name, s]) => [sessionId(s.token), { name, s }]))
    for (const h0 of heldRows()) {
      // read again: it may have been released while an earlier renewal waited
      const h = /** @type {HeldRow | undefined} */ (q.heldOne.get(h0.authority, h0.resource))
      if (!h || h.sid !== h0.sid) continue
      // after a failed try, wait before asking that machine again: never so long a short lease runs out
      const waiting = now() - (unreachable.get(h.authority) ?? 0) < Math.min(RETRY_MS, h.ttl_ms / 6)
      const found = h.kind === 'session' ? bySid.get(h.sid) : null
      if (!found) {
        // its session restarted under the same name, and carrying it over failed then: try again
        const again = h.kind === 'session' ? sessions.get(h.name) : null
        if (again && !waiting) { await rebindRow(h, h.name, sessionId(again.token), ask); continue }
        if (now() - h.renewed_at > h.ttl_ms) forget(h.authority, h.resource, h.sid)
        continue
      }
      if (!(found.s.lastActive > h.renewed_at) || now() - h.renewed_at < h.ttl_ms / 3 || waiting) continue
      try {
        const r = await ask(h.authority, { op: 'renew', resource: h.resource, name: found.name, sid: h.sid, kind: 'session', ttl_ms: h.ttl_ms })
        unreachable.delete(h.authority)
        if (r?.ok) noteRenewed(h.authority, h.resource, h.sid, h.ttl_ms, found.name)
        else forget(h.authority, h.resource, h.sid)
      } catch (e) {
        if (unaskable(h, e, 'renew')) continue
        unreachable.set(h.authority, now())
        log(`could not renew the lease on ${h.resource}@${h.authority}: ${/** @type {any} */ (e)?.message || e}`)
      }
    }
  }

  /**
   * `ask` refused to ask `h.authority` at all (409): its name is two machines' now (see contested in
   * peers.js), and will be until a person removes one. Nothing can renew or release the lease, so it
   * runs out there on its own, and this machine's record of it goes rather than being tried every pass.
   * @param {HeldRow} h @param {unknown} e @param {string} what
   */
  function unaskable(h, e, what) {
    if (/** @type {any} */ (e)?.status !== 409) return false
    forget(h.authority, h.resource, h.sid)
    log(`could not ${what} the lease on ${h.resource}@${h.authority}, and won't try again (it runs out there): ${/** @type {any} */ (e)?.message || e}`)
    return true
  }

  /**
   * A session connected with a new id under a name whose earlier session held leases and has gone:
   * the same agent, its adapter restarted. Its leases move to it.
   * @param {string} name @param {string} sid
   * @param {(authority: string, body: Record<string, unknown>) => Promise<any>} ask
   */
  async function carryOver(name, sid, ask) {
    const live = new Set([...sessions.values()].map(s => sessionId(s.token)))
    for (const h of heldRows()) {
      if (h.kind !== 'session' || h.name !== name || h.sid === sid || live.has(h.sid)) continue
      await rebindRow(h, name, sid, ask)
    }
    marks()
  }

  /**
   * Move one held lease to a session's new id. If its machine can't be reached, the row stays as it
   * is and renewActive tries again (until the lease would have run out).
   * @param {HeldRow} h @param {string} name @param {string} sid
   * @param {(authority: string, body: Record<string, unknown>) => Promise<any>} ask
   */
  async function rebindRow(h, name, sid, ask) {
    try {
      const r = await ask(h.authority, { op: 'rebind', resource: h.resource, name, sid, kind: 'session', old_sid: h.sid })
      unreachable.delete(h.authority)
      if (r?.ok) {
        q.unholdBy.run(h.authority, h.resource, h.sid)
        q.hold.run(h.authority, h.resource, name, sid, 'session', h.ttl_ms, h.renewed_at)
        noteInterest(h.authority, h.resource, name)
        log(`${name}'s lease on ${h.resource}@${h.authority} carried over to its new session`)
        marks()
      } else forget(h.authority, h.resource, h.sid)
    } catch (e) {
      if (unaskable(h, e, 'carry over')) return
      unreachable.set(h.authority, now())
      log(`could not carry over the lease on ${h.resource}@${h.authority}: ${/** @type {any} */ (e)?.message || e}`)
    }
  }

  /**
   * One file per session process that holds a lease (`hold-<pid>`), so the heartbeat hook can tell
   * in a shell test, without starting anything, whether there's a lease to keep alive.
   */
  function marks() {
    const sids = new Set(heldRows().filter(h => h.kind === 'session').map(h => h.sid))
    const want = new Set([...sessions.values()].filter(s => s.owner && sids.has(sessionId(s.token))).map(s => `hold-${s.owner}`))
    try {
      for (const f of fs.readdirSync(dir)) if (/^hold-\d+$/.test(f) && !want.has(f)) fs.rmSync(path.join(dir, f), { force: true })
      for (const f of want) if (!fs.existsSync(path.join(dir, f))) fs.writeFileSync(path.join(dir, f), '', { mode: 0o600 })
    } catch {}
  }

  return { db, claim, renew, rebind, release, breakLease, list, current, view, sweep, noteHeld, noteRenewed, noteInterest, inbound, forget, heldRows, renewActive, carryOver, marks }
}

/** @param {unknown} v @param {number} dflt @param {number} lo @param {number} hi */
function clamp(v, dflt, lo, hi) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt
}
