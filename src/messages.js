// Messages on their way: storing what arrives (for a session here, or held for another machine),
// the loop that hands messages on to the machine they're for, copies left with other machines while
// it's offline, and a send from a session or the CLI. Each row's moves are in store.js's MOVES.
import crypto from 'node:crypto'
import { signEnvelope, verifyEnvelope, sha256 } from './crypto.js'
import { httpErr } from './errors.js'
import { HELLO_CONCURRENCY } from './peers.js'
import { recordBudget } from './roster.js'
import { parseAddr, sanitizeName, errMsg, MAX_TTL_MS } from './config.js'

const MAX_BATCH = 256 << 10            // bytes of envelopes per request (well under the request limit)
export const MAX_MSG = 64 * 1024
// signature checks one member may cost this node in a burst, then per minute: twice what a request may
// carry, so a backlog handed over in batches flows, while a member can't keep a core busy. What's over is
// answered as 'full', and the sender tries it again later (#9)
export const CHECK_BUDGET = 4000
const MAX_FORGED = 20_000              // envelopes that failed their check, remembered so a resent one costs nothing
const BACKOFF_MAX = 60_000
const REPLICATE_TO = 3                 // max other nodes that hold a copy for an offline machine
const IN_FLIGHT_MS = 30_000            // a send being delivered directly is hidden from the flush loop
const FLUSH_HOSTS = 8                  // machines being delivered to at once
const CLOCK_SLACK_MS = 86400_000       // how far ahead of us a sender's clock can put a message's expiry
const SEND_WAIT_MS = 10_000            // a send answers by then: it's stored, and clients stop waiting at 15 s

const backoff = (/** @type {number} */ n) => Math.min(BACKOFF_MAX, 2000 * 2 ** Math.min(n, 5))

/** @typedef {import('./types.js').Envelope} Envelope */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').PeerRow} PeerRow */
/** What the forwarding loop needs of a row: the text is read only when it's being sent. */
/** @typedef {Pick<MessageRow, 'id' | 'to_host' | 'role' | 'attempts' | 'replicated'>} DueRow */

/**
 * @param {{
 *   cfg: import('./types.js').Config,
 *   q: ReturnType<typeof import('./store.js').queries>,
 *   roster: import('./roster.js').Roster,
 *   me: import('./types.js').Identity,
 *   now: () => number,
 *   log: (...a: unknown[]) => void,
 *   tx: (fn: () => void) => void,
 *   msgRow: (id: string) => MessageRow | undefined,
 *   isSelf: (h: string) => boolean,
 *   member: (h: string) => { host: string, fp: string } | undefined,
 *   peerRow: (h: string) => PeerRow | undefined,
 *   allPeers: () => PeerRow[],
 *   selfAliases: Set<string>,
 *   adoptSelfAlias: (name: string) => boolean,
 *   hub: ReturnType<typeof import('./sessions.js').createSessions>,
 *   call: ReturnType<typeof import('./peers.js').createPeers>['call'],
 *   hello: ReturnType<typeof import('./peers.js').createPeers>['hello'],
 *   resolveName: ReturnType<typeof import('./peers.js').createPeers>['resolveName'],
 *   notMember: (h: string) => string,
 *   contested: ReturnType<typeof import('./peers.js').createPeers>['contested'],
 *   knownPeers: () => string[],
 * }} o
 */
export function createMessages({ cfg, q, roster, me, now, log, tx, msgRow, isSelf, member, peerRow, allPeers, selfAliases, adoptSelfAlias, hub, call, hello, resolveName, notMember, contested, knownPeers }) {
  const { pump } = hub
  const dueRows = (/** @type {unknown[]} */ rows) => /** @type {DueRow[]} */ (rows)

  /** @type {(r: MessageRow) => Envelope} */
  const envOf = r => ({ id: r.id, from: r.from_addr, to: r.to_addr, body: r.body, sent_at: r.sent_at, expires_at: r.expires_at, sig: r.sig })

  /** @type {Set<string>} envelopes whose signature didn't check out: that can't change, so they aren't checked twice */
  const forged = new Set()
  /**
   * What a failed check is remembered under: the whole envelope, its signature and the key it was
   * checked against. Never the signature alone (a holder has seen the real one, and could send it on
   * an altered copy to get the real message refused), and not without the key (a machine back under
   * a new key, before we heard of it, sends envelopes that will check out once we have).
   * @param {Envelope} e @param {string} fp
   */
  const envKey = (e, fp) => sha256(JSON.stringify([e.id, e.from, e.to, e.sent_at, e.expires_at, e.body, e.sig, fp]))
  const checks = recordBudget({ cap: CHECK_BUDGET, perMs: 60_000, now })
  /** @type {Map<string, number>} what was last logged about a member or a name, and when: once a minute each */
  const said = new Map()
  /** @param {string} key @param {string} text */
  function once(key, text) {
    if (now() - (said.get(key) || 0) <= 60_000) return
    said.set(key, now())
    log(text)
  }

  /**
   * Is this a well-formed envelope, as a node writes one? Its addresses if so (exactly as a node writes
   * them: only the host is proved, so whatever else `from` held, a line break, a NUL, could otherwise
   * pass for another sender when it's shown to a session), else null. Nothing here is signed for.
   * @param {any} e
   */
  function shape(e) {
    if (!(e && typeof e === 'object' &&
      ['id', 'from', 'to', 'body', 'sig'].every(k => typeof e[k] === 'string') &&
      /^[\w-]{1,64}$/.test(e.id) && e.from.length <= 320 && e.to.length <= 320 &&
      // text that wouldn't survive the store unchanged would fail its signature once re-read
      e.body.isWellFormed() && !e.body.includes('\0') &&
      // safe, bounded integers: anything else can't be stored and read back reliably
      Number.isSafeInteger(e.sent_at) && Number.isSafeInteger(e.expires_at) && e.sent_at >= 0 &&
      e.expires_at - now() <= MAX_TTL_MS + CLOCK_SLACK_MS && e.sent_at - now() <= MAX_TTL_MS &&
      Buffer.byteLength(e.body) <= MAX_MSG)) return null
    let from, to
    try { from = parseAddr(e.from, ''); to = parseAddr(e.to, '') } catch (err) { log('rejected envelope:', errMsg(err)); return null }
    if (e.from !== `${from.name}@${from.host}` || e.to !== `${to.name}@${to.host}`) return null
    return { from, to }
  }

  /**
   * Is a well-formed envelope signed by the machine named in its sender address (`host`)?
   * 'unknown-sender' if that names a machine we haven't heard of (yet): it may have joined while we
   * were offline. 'over' if the check isn't allowed for now: nothing is said about the envelope, and
   * member `by` (its key), which delivered it, should try it again later.
   *
   * A check is charged to the allowance of the machine whose signature it is, so a member can't spend
   * another's by handing on its mail (copies it holds, as it should); one that fails is charged to the
   * machine that delivered it, so a member can't spend another's by forging in its name. Both must have
   * room before anything is checked: a member with nothing left can make nothing be checked, in
   * anyone's name. Nothing refused before is checked twice.
   * @param {Envelope} e @param {string} host @param {string} [by] none for a message from this machine
   * @returns {'ok' | 'unknown-sender' | 'bad' | 'over'}
   */
  function checkSig(e, host, by) {
    const sender = roster.byHost.get(host)
    if (!sender) {
      const gone = removedKey(host), key = gone && roster.ranked.get(gone)?.publicKey
      if (!key) return 'unknown-sender'
      if (by && !room(by, gone)) return 'over'
      // signed by another key, it may be that name's machine back with a new one we haven't heard of.
      // So may a key that was dropped, which we can't check: its holder tries again, and tells us what it knows
      const ok = verifyEnvelope(key, e)
      if (by) checks.take(ok ? gone : by, 1)
      return ok ? 'bad' : 'unknown-sender'
    }
    const k = envKey(e, sender.fp)
    if (forged.has(k)) return 'bad'
    if (by && !room(by, sender.fp)) return 'over'
    const ok = verifyEnvelope(sender.publicKey, e)
    if (by) checks.take(ok ? sender.fp : by, 1)
    if (ok) return 'ok'
    if (forged.size >= MAX_FORGED) forged.clear()
    forged.add(k)
    return 'bad'
  }
  /** Have the deliverer and the signer both room for a check? Said once a minute: the sender sees only 'no room'. @param {string} by @param {string} signer */
  function room(by, signer) {
    if (checks.has(by) && checks.has(signer)) return true
    const name = (/** @type {string} */ fp) => roster.members.get(fp)?.host ?? roster.ranked.get(fp)?.host ?? fp
    once(by, `${name(by)} delivered more messages${checks.has(by) ? ` from ${name(signer)}` : ''} than this machine checks at once: the rest wait for its next try`)
    return false
  }
  /**
   * Is this a well-formed envelope signed by the machine it claims to come from? The two checks above,
   * as one: `by`, when given, is charged as checkSig says.
   * @param {any} e @param {string} [by] @returns {'ok' | 'unknown-sender' | 'bad' | 'over'}
   */
  function checkEnv(e, by) {
    const s = shape(e)
    return s ? checkSig(e, s.from.host, by) : 'bad'
  }
  /** The key of a machine called `host` that was removed, or whose add never counted (it never will). @param {string} host */
  const removedKey = host => {
    const fp = [...roster.records].reverse().find(r => r.type === 'add' && r.host === host)?.fp ?? [...roster.ranked.values()].reverse().find(m => m.host === host)?.fp
    return fp && (roster.removed.has(fp) || roster.dropped.has(fp)) ? fp : null
  }
  /** @param {string} host */
  const removedHost = host => removedKey(host) !== null
  /**
   * Store a row unless one with that id exists. An existing id is only fine for the same message:
   * a different message reusing an id someone has seen is refused, not reported as delivered. (The
   * same message, not the same signature: a copy can carry another encoding of it, and the envelope
   * has been verified by now. Nothing keeps the text of what it has passed on.)
   * @param {Envelope} e @param {string} toHost @param {string} toName @param {'inbox' | 'held'} role @param {'queued' | 'pending'} state
   */
  function store(e, toHost, toName, role, state) {
    if (q.insert.run(e.id, e.from, e.to, toHost, toName, e.body, e.sent_at, e.expires_at, e.sig, role, state, 0, now()).changes) return true
    const r = msgRow(e.id)
    return !!r && same(r, e)
  }
  /** Is stored row `r` this message? @param {MessageRow} r @param {Envelope} e */
  const same = (r, e) => r.from_addr === e.from && r.to_addr === e.to && r.sent_at === e.sent_at && r.expires_at === e.expires_at && (r.body === e.body || r.state === 'forwarded')

  /**
   * Is there no room for another message to this session? Whatever sends too much, a script gone wrong
   * or agents stuck in a loop, is held back at the sender, and everything else keeps moving. The limit
   * on the store as a whole is for what no one recipient's limit sees: any number of made-up names, or
   * messages read as fast as they come. Nothing is lost by this: the sender keeps trying until the
   * message expires, and a session here is told at once.
   * @param {string} host @param {string} name
   */
  const full = (host, name) => Number(q.waiting.get(host, name)?.n) >= cfg.maxWaiting || Number(q.stored.get()?.n) >= cfg.maxStoreBytes

  /**
   * Store an incoming envelope durably. Returns 'live' | 'queued' | 'held' | 'expired' |
   * 'full' (not stored: no room for now, and the sender should retry) |
   * 'unknown-sender' (not stored: the sender should tell us its membership records, then retry) |
   * null (rejected: the envelope itself is bad, and the sender must not retry it). Storage errors (disk full,
   * database busy) throw, so callers can report a temporary failure and the sender retries.
   * @param {unknown} e
   * @param {Set<string>} [toPump] collect local recipients here instead of pumping each one now
   * @param {string} [mine] the machine delivering this says its name for the recipient's machine (a
   *   nickname of its own, which we may not know) means us. Believed only from the message's own
   *   sender: a holder could otherwise turn a copy addressed elsewhere into a message for a session here.
   * @param {string} [by] the key of the member delivering it, charged for the signature check as
   *   checkSig says; none for a message from this machine
   * @returns {import('./types.js').AcceptResult}
   */
  function accept(e, toPump, mine, by) {
    const s = shape(e)
    if (!s) return null
    const env = /** @type {Envelope} */ (e), from = s.from.host, to = s.to
    // What can't be stored anyway is refused first, so retrying it costs the sender nothing of its
    // allowance. Nothing up to the signature check changes anything: these only read.
    if (env.expires_at <= now()) return 'expired'
    // a name two machines claim (see contested) is no one's as a sender too: a session here would take
    // the listed machine's words for the other's. Its mail waits, like mail to the name, until one is removed
    if (contested(from)) { once(from, `${from} is two machines' name: its messages wait (${notMember(from)})`); return 'full' }
    const local = isSelf(to.host) || (mine && mine === from && !member(to.host) && !removedHost(to.host))
    const had = msgRow(env.id)
    // a copy of a message already here was checked when it was stored (the fields compared are the
    // signed ones); a different message under an id we have seen is refused, whoever signed it
    if (had) { if (!same(had, env)) return null }
    else {
      if (full(local ? cfg.host : to.host, to.name)) return 'full'
      const v = checkSig(env, from, by)
      if (v === 'unknown-sender') return v
      if (v === 'over') return 'full'      // the same answer: not stored for now, and it's tried again later
      if (v !== 'ok') return null
    }
    if (local) {
      if (!store(env, cfg.host, to.name, 'inbox', 'queued')) return null
      q.claim.run(cfg.host, to.name, now(), env.id)
      const live = hub.awake(to.name)               // before pumping: a wait ends once it has woken the session
      if (toPump) toPump.add(to.name)
      else pump(to.name)
      return live ? 'live' : 'queued'
    }
    if (!store(env, to.host, to.name, 'held', 'pending')) return null
    kick()
    return 'held'
  }

  /**
   * Rows still to hand over, in request-sized batches, read as they're needed: a machine that doesn't
   * answer costs one batch, however much is waiting for it.
   * @param {DueRow[]} rows @returns {Generator<MessageRow[]>}
   */
  function* batches(rows) {
    /** @type {MessageRow[]} */
    let cur = []
    let size = 0
    for (const { id } of rows) {
      const r = msgRow(id)
      if (r?.state !== 'pending') continue
      const n = Buffer.byteLength(JSON.stringify(envOf(r))) + 1
      if (cur.length && size + n > MAX_BATCH) { yield cur; cur = []; size = 0 }
      cur.push(r)
      size += n
    }
    if (cur.length) yield cur
  }

  /**
   * Hand rows to member `host`'s node. Returns null on success, else the error.
   * @param {string} host
   * @param {DueRow[]} rows
   * @returns {Promise<null | { err: unknown, rest: DueRow[] }>}
   */
  async function handOver(host, rows) {
    for (const batch of batches(rows)) {
      try {
        // addressed under a name only we use for this machine: tell it they're for it
        const res = await call(host, 'POST', '/v1/deliver', { messages: batch.map(envOf), mine: batch.filter(r => r.role === 'outbox' && r.to_host !== host).map(r => r.id) })
        const results = res.results || {}
        const unknown = new Set(Array.isArray(res.unknown) ? res.unknown : [])
        const noRoom = new Set(Array.isArray(res.full) ? res.full : [])
        let tell = false
        tx(() => {
          for (const r of batch) {
            if (results[r.id]) q.forwarded.run(now(), r.id)
            // it hasn't heard of the sending machine yet: tell it what we know, then try again later
            else if (unknown.has(r.id)) { q.retry.run(now() + backoff(r.attempts), `${host} doesn't know the sender yet`, now(), r.id); tell ||= r.attempts < 3 }
            else if (noRoom.has(r.id)) q.retry.run(now() + backoff(r.attempts), `no room on ${host} for now`, now(), r.id)
            else q.failed.run(`rejected by ${host} (invalid or malformed message)`, now(), r.id)
          }
        })
        if (tell) setImmediate(() => { hello(host).catch(e => log(`hello to ${host} failed: ${errMsg(e)}`)) })
      } catch (err) {
        const rest = rows.slice(rows.findIndex(r => r.id === batch[0].id))
        tx(() => { for (const r of rest) q.retry.run(now() + backoff(r.attempts), errMsg(err), now(), r.id) })
        return { err, rest }
      }
    }
    return null
  }

  /**
   * Which member should messages for `host` go to? A member name is used as is, unless another member
   * has answered under it (see contested): then it's no one's, and nothing goes out under it, nor under
   * an address or nickname the listed machine answered at, which would go to it under that name. Any
   * other name is resolved by asking who answers at its address. 'self' if it turns out to be this machine.
   * @param {string} host @returns {Promise<string | 'self' | null>}
   */
  async function routeFor(host) {
    if (isSelf(host)) return 'self'
    const uncontested = (/** @type {string} */ h) => contested(h) ? null : h
    if (member(host)) return uncontested(host)
    const alias = peerRow(host)?.alias_of
    if (alias && member(alias)) return uncontested(alias)
    const r = await resolveName(host)
    return r === cfg.host ? 'self' : r ? uncontested(r) : null
  }

  // ---------- forwarding loop ----------
  /** @type {Set<string>} sends being handed over directly: not for the flush loop too */
  const inFlight = new Set()
  /** @type {Set<string>} names being delivered to now: a machine that's slow to answer holds up only itself */
  const busy = new Set()
  let delivering = 0, lookingUp = 0
  let kicked = false
  /** Flush soon: once, however many messages came in together. */
  const kick = () => { if (!kicked) { kicked = true; setImmediate(() => { kicked = false; flush() }) } }

  function flush() {
    try {
      const t = now()
      q.expire.run(t, t)
      // every name we can put a machine to
      const known = [cfg.host, ...selfAliases, ...knownPeers(), ...allPeers().filter(p => member(p.alias_of || '')).map(p => p.host)]
      for (const row of q.due.all(t, t, JSON.stringify(known.filter(h => !busy.has(h))))) {
        if (delivering >= FLUSH_HOSTS) break
        const host = String(row.to_host)
        const rows = dueRows(q.dueFor.all(t, t, host)).filter(r => !inFlight.has(r.id))
        if (!rows.length) continue
        delivering++
        busy.add(host)
        deliver(host, rows).catch(e => log('flush error', errMsg(e))).finally(() => { busy.delete(host); delivering-- })
      }
      // A name nothing has identified yet costs a hello and a name lookup, and any member can queue
      // thousands of them: a few at a time, off to the side of what's going to machines we know
      if (lookingUp >= HELLO_CONCURRENCY) return
      for (const row of q.dueNames.all(t, t, JSON.stringify([...known, ...busy]), HELLO_CONCURRENCY - lookingUp)) {
        const host = String(row.to_host)
        lookingUp++
        busy.add(host)
        deliver(host, dueRows(q.dueFor.all(t, t, host)).filter(r => !inFlight.has(r.id))).catch(e => log('flush error', errMsg(e))).finally(() => { busy.delete(host); lookingUp-- })
      }
    } catch (e) { log('flush error', errMsg(e)) }
  }

  /** @param {string} host @param {DueRow[]} rows */
  async function deliver(host, rows) {
    const dest = await routeFor(host)
    if (dest === 'self') { if (isSelf(host)) adoptSelfAlias(host); return }
    if (!dest) {
      const why = notMember(host)
      tx(() => { for (const r of rows) q.retry.run(now() + backoff(r.attempts), why, now(), r.id) })
      return
    }
    const failure = await handOver(dest, rows)
    // in the background: trying several (possibly offline) holders must not stall deliveries
    if (failure) replicate(dest, failure.rest.filter(r => r.role === 'outbox' && !r.replicated))
  }

  /** Other recently seen members that could hold copies for `host` while it is offline. @param {string} host */
  function holderCandidates(host) {
    const cutoff = now() - 10 * 60_000
    return allPeers()
      .filter(p => member(p.host) && p.host !== host && p.last_seen >= cutoff)
      .sort((a, b) => b.last_seen - a.last_seen)
  }

  /** @type {Set<string>} hosts with a replication in progress */
  const replicating = new Set()
  /** Hand copies to other reachable members so they can deliver when `host` comes back. @param {string} host @param {DueRow[]} rows */
  async function replicate(host, rows) {
    if (!rows.length || replicating.has(host)) return
    replicating.add(host)
    try { await replicateInner(host, rows) } catch (e) { log('replicate error', errMsg(e)) } finally { replicating.delete(host) }
  }
  /** @param {string} host @param {DueRow[]} rows */
  async function replicateInner(host, rows) {
    /** @type {Map<string, number>} message -> how many holders stored it */
    const copies = new Map()
    let holders = 0
    for (const p of holderCandidates(host)) {
      if (holders >= REPLICATE_TO) break
      try {
        let stored = 0
        for (const batch of batches(rows)) {
          const { results } = await call(p.host, 'POST', '/v1/deliver', { messages: batch.map(envOf) }, { timeout: 3000 })
          for (const r of batch) if (results?.[r.id]) { copies.set(r.id, (copies.get(r.id) || 0) + 1); stored++ }
        }
        if (stored) holders++
      } catch {}
    }
    for (const id of copies.keys()) q.replicated.run(id)
  }


  /** @param {{ from?: unknown, to?: unknown, body?: unknown, ttl_ms?: unknown }} d */
  async function localSend(d) {
    if (typeof d.body !== 'string' || !d.body) throw httpErr(400, 'message body required')
    const body = /** @type {any} */ (d.body).toWellFormed().replaceAll('\0', '\uFFFD')     // what the store can give back unchanged
    if (Buffer.byteLength(body) > MAX_MSG) throw httpErr(413, `message too large (max ${MAX_MSG} bytes)`)
    if (!d.to) throw httpErr(400, 'recipient required (name@host)')
    let to
    try { to = parseAddr(d.to, cfg.host) } catch (e) { throw httpErr(400, `bad recipient "${d.to}": ${errMsg(e)}`) }
    // address it to the machine's member name if we can tell (e.g. desk.tailnet.ts.net -> desk.local)
    if (!isSelf(to.host) && !member(to.host)) {
      const r = await routeFor(to.host).catch(() => null)
      if (r === 'self') to.host = cfg.host
      else if (r) to.host = r
    }
    if (isSelf(to.host)) to.host = cfg.host
    // a name two machines claim, or an address the listed one answered at: say so, rather than pick one
    // (see contested in peers.js; notMember says which name and why)
    if (to.host !== cfg.host && contested(member(to.host) ? to.host : peerRow(to.host)?.alias_of || '')) throw httpErr(409, notMember(to.host))
    // not a machine on this network (a typo, or a machine that hasn't joined): say so now rather
    // than queue it for days. Names configured as peers (a Tailscale name, an IP) are queued: the
    // machine may just be offline, and is found when it answers.
    if (to.host !== cfg.host && !member(to.host) && removedHost(to.host)) throw httpErr(410, `${to.host} was removed from the network`)
    if (to.host !== cfg.host && !member(to.host) && !peerRow(to.host)?.configured) {
      const known = [cfg.host, ...knownPeers()].join(', ')
      throw httpErr(404, `${to.host} is not a machine on this network, and nothing at that name answered as one (machines: ${known}). If it is new, run \`natter invite\` and join it first.`)
    }
    if (full(to.host, to.name)) throw fullError(`${to.name}@${to.host}`)
    /** @type {Omit<Envelope, 'sig'>} */
    const unsigned = {
      id: crypto.randomUUID(),
      from: `${sanitizeName(d.from || 'cli')}@${cfg.host}`,
      to: `${to.name}@${to.host}`,
      body,
      sent_at: now(),
      expires_at: now() + (Number(d.ttl_ms) > 0 ? Math.min(Number(d.ttl_ms), cfg.ttlMs) : cfg.ttlMs),
    }
    /** @type {Envelope} */
    const e = { ...unsigned, sig: signEnvelope(me.key, unsigned) }
    if (to.host === cfg.host) {
      let st
      try { st = accept(e) } catch (err) { throw httpErr(503, `could not queue message: ${errMsg(err)}`) }
      if (st === 'unknown-sender') throw httpErr(409, `this machine (${cfg.host}) isn't on its member list, so nothing was sent: run \`natter setup\``)
      if (st === 'expired') throw httpErr(400, 'the message expired before it could be queued')
      if (st === 'full') throw fullError(e.to)
      if (!st) throw httpErr(500, 'could not queue message')
      return { id: e.id, to: e.to, status: `${d.to !== e.to && String(d.to).includes('@') ? `${parseAddr(d.to, cfg.host).host} is this machine — ` : ''}${hub.status(to.name, st === 'live')}` }
    }
    // hidden from the flush loop while we try the direct hand-off, so it isn't sent twice
    inFlight.add(e.id)
    q.insert.run(e.id, e.from, e.to, to.host, to.name, e.body, e.sent_at, e.expires_at, e.sig, 'outbox', 'pending', now() + IN_FLIGHT_MS, now())
    let remote = null, copies = false, refused = false
    try {
      if (!member(to.host)) throw new Error(notMember(to.host))
      /** @type {NodeJS.Timeout | undefined} */
      let wait
      const res = await Promise.race([
        call(to.host, 'POST', '/v1/deliver', { messages: [e] }, { deadline: SEND_WAIT_MS }),   // ended, not just left running
        new Promise((_, reject) => { wait = setTimeout(() => reject(new Error('no answer yet')), SEND_WAIT_MS) }),
      ]).finally(() => clearTimeout(wait))
      remote = res.results?.[e.id]
      if (remote) q.forwarded.run(now(), e.id)
      else if (Array.isArray(res.unknown) && res.unknown.includes(e.id)) throw new Error(`${to.host} doesn't know this machine yet`)
      else if (Array.isArray(res.full) && res.full.includes(e.id)) { refused = true; q.retry.run(now() + backoff(0), `no room on ${to.host} for now`, now(), e.id) }
      else q.failed.run(`rejected by ${to.host} (invalid or malformed message)`, now(), e.id)
    } catch (err) {
      q.retry.run(now() + backoff(0), errMsg(err), now(), e.id)
      const row = msgRow(e.id)
      // the message is stored durably now: answer the client and hand out copies in the background
      // (trying several offline candidates in turn could otherwise outlast the client's timeout)
      if (row?.state === 'pending' && member(to.host) && holderCandidates(to.host).length) { copies = true; replicate(to.host, [row]) }
    } finally { inFlight.delete(e.id) }
    const r = msgRow(e.id)
    if (!r) throw httpErr(500, 'message vanished from the store')
    let status
    if (r.role === 'inbox') status = `${to.host} is this machine — ${hub.status(to.name)}`
    else if (r.state === 'forwarded') status = remote === 'live' ? `pushed to ${e.to}'s live session` : `stored on ${to.host}; ${to.name} will get it when it next connects or checks its inbox`
    else if (r.state === 'failed') status = `FAILED: ${r.last_error}`
    else if (refused) status = `${to.host} has no room for more messages to ${to.name} for now; queued here — will deliver once it has`
    else status = `${to.host} unreachable (${r.last_error}); queued — will deliver when it comes back` + (copies ? ' (also offering copies to other online machines)' : '')
    return { id: e.id, to: e.to, status }
  }

  /** @param {string} to */
  const fullError = to => httpErr(429, `not sent: too many messages are waiting for ${to}, or this machine's message store is full. Try again once they've been read`)

  return { envOf, checkEnv, removedHost, full, accept, kick, flush, routeFor, holderCandidates, replicate, localSend, fullError, inFlight }
}
