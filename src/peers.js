// The other machines on the network: how to reach each one, and requests to them.
//
// An address is used for a member only once the machine there proves it holds that member's key.
// Addresses come from beacons, from requests members send us, from what other members tell us, and
// from configured names; each is a hint until a handshake there verifies it.
import { authedRequest, PinError, ProtoError, StartingError, MAX_BODY as MAX_REQ, MIN_RATE } from './tls.js'
import { PeerAnswered } from './errors.js'
import { normHost, validAddr, errMsg, netHint, VERSION } from './config.js'

const MAX_REPLY = 1 << 20              // a reply to anything but a hello: only a hello carries a roster
const PROBE_RETRY_MS = 10 * 60_000     // don't re-probe an address that just failed verification
const STARTING_RETRY_MS = 30_000       // ...or, sooner, one whose node said it was starting
const MAX_PROBES = 8, MAX_PROBES_PER_HOST = 2
export const HELLO_CONCURRENCY = 2     // offline .local names tie up a DNS (libuv) thread each for seconds

/** @typedef {import('./types.js').PeerRow} PeerRow */

/**
 * @param {{
 *   cfg: import('./types.js').Config,
 *   me: import('./types.js').Identity,
 *   roster: import('./roster.js').Roster,
 *   q: ReturnType<typeof import('./store.js').queries>,
 *   peerRow: (host: string) => PeerRow | undefined,
 *   allPeers: () => PeerRow[],
 *   now: () => number,
 *   log: (...a: unknown[]) => void,
 *   isSelf: (h: string) => boolean,
 *   member: (h: string) => import('./types.js').Member | undefined,
 *   removedHost: (h: string) => boolean,
 *   adoptSelfAlias: (name: string) => boolean,
 *   mergeRoster: (records: unknown) => boolean,
 *   kick: () => void,
 * }} o kick: start the forwarding loop (a machine became reachable)
 */
export function createPeers({ cfg, me, roster, q, peerRow, allPeers, now, log, isSelf, member, removedHost, adoptSelfAlias, mergeRoster, kick }) {
  const addrOf = (/** @type {string} */ host) => cfg.routes[host] || peerRow(host)?.addr || `${host}:${cfg.port}`
  const helloBody = () => ({ peers: shareablePeers(), records: roster.records, version: VERSION })
  const knownPeers = () => [...roster.members.values()].filter(m => m.fp !== me.fp).map(m => m.host)

  /** @type {Map<string, string>} host -> why it was last unreachable ('' once reached) */
  const reach = new Map()
  /** @type {Map<string, number>} host -> when it last answered */
  const reachedAt = new Map()
  /**
   * Log when a machine becomes unreachable, or reachable again (not every attempt).
   * @param {string} host @param {string | null} reason null: reached
   */
  function noteReach(host, reason) {
    if (reason === null) reachedAt.set(host, now())
    const prev = reach.get(host)
    if (reason === null) {
      if (prev) log(`${host} is reachable again`)
      reach.set(host, '')
    } else if (prev !== reason) {
      log(`cannot reach ${host}: ${reason}`)
      reach.set(host, reason)
    }
  }

  /**
   * The version a member says it runs. Only from that member's own hello (request or reply), whose
   * sender proved its key: what one machine says about another's version is never taken.
   * @param {string} host @param {unknown} v
   */
  function noteVersion(host, v) {
    if (typeof v !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,20})?$/.test(v) || !member(host) || host === cfg.host) return
    if (peerRow(host)?.version !== v) q.setVersion.run(host, now(), v)
  }

  /** Why `host` can't be sent to. @param {string} host */
  const notMember = host => removedHost(host) ? `${host} was removed from the network` : `${host} is not a known machine on this network (yet)`

  /**
   * Request to another member. The machine at the address must prove it holds that member's key
   * before we say who we are or send the request: anyone else gets nothing.
   * `addr` dials an explicit, not yet verified address instead of the stored route for `host`.
   * @param {string} host
   * @param {'GET'|'POST'} method
   * @param {string} p
   * @param {object} [obj]
   * @param {{ timeout?: number, addr?: string, retried?: boolean, deadline?: number }} [opts]
   * @returns {Promise<any>}
   */
  async function call(host, method, p, obj, { timeout = 4000, addr, retried = false, deadline } = {}) {
    const m = member(host)
    if (!m) throw new Error(notMember(host))
    const body = obj === undefined ? '' : JSON.stringify(obj)
    timeout += Math.ceil(Buffer.byteLength(body) / MIN_RATE)   // big batches on slow links still finish
    const target = addr || addrOf(host)
    if (!validAddr(target)) throw new Error(`invalid address for ${host}: ${target}`)
    let r
    try {
      r = await authedRequest({ addr: target, method, path: p, body, headers: { 'x-agentlink-port': String(cfg.port) }, identity: me, accept: new Map([[m.fp, m.publicKey]]), dks: roster.dks, timeout, deadline }, p === '/v1/hello' ? MAX_REQ : MAX_REPLY)
    } catch (e) {
      // its node is starting (unproved): not unreachable, and not to be logged as if it were
      if (e instanceof StartingError) throw Object.assign(new StartingError(`${host} at ${target}: its node is starting`), { reason: `${target}: its node is starting` })
      // reason: why the machine can't be reached, without its name (peers shows it next to the name)
      const reason = e instanceof PinError ? `${target} is answered by a different machine (not ${host}'s key)`
        : e instanceof ProtoError ? e.message
        : `${target}: ${errMsg(e)}${netHint(e)}`
      if (!addr) noteReach(host, reason)   // a probe of an unverified address says nothing about the machine
      throw Object.assign(new Error(e instanceof ProtoError ? `${host}: ${reason}` : `${host} at ${reason}`), { reason })
    }
    if (!addr) noteReach(host, null)
    // a member that hasn't heard we joined yet: tell it (hello carries the records that add us), then retry
    if (r.status === 403 && p !== '/v1/hello' && !retried) {
      await call(host, 'POST', '/v1/hello', helloBody(), { timeout: 2500, addr })
      return call(host, method, p, obj, { timeout, addr, retried: true, deadline })
    }
    /** @type {any} */
    let data = {}
    try { data = r.text ? JSON.parse(r.text) : {} } catch { throw new Error(`${host}: bad reply`) }
    // only the status: what another machine writes here would reach sessions and terminals as our own words
    if (r.status < 200 || r.status >= 300) throw new PeerAnswered(host, r.status)
    q.upsertPeer.run(host, null, now(), 0)
    if (data.records) mergeRoster(data.records)
    return data
  }

  /**
   * Which machine answers at `addr`? Any member is accepted (including us); returns that
   * member, or throws. Used for names that aren't member names: IPs, Tailscale names, configured peers.
   * @param {string} addr
   */
  async function identify(addr, timeout = 2500) {
    if (!validAddr(addr)) throw new Error(`invalid address ${addr}`)
    const accept = new Map([...roster.members.values()].map(m => [m.fp, m.publicKey]))
    let r
    try {
      r = await authedRequest({ addr, method: 'POST', path: '/v1/hello', body: JSON.stringify(helloBody()), headers: { 'x-agentlink-port': String(cfg.port) }, identity: me, accept, dks: roster.dks, timeout }, MAX_REQ)
    } catch (e) { throw new Error(e instanceof PinError ? `${addr}: not a machine on this network` : `${addr}: ${errMsg(e)}`) }
    const m = roster.members.get(r.peerFp)
    if (!m) throw new Error(`${addr}: not a machine on this network`)
    if (r.status === 200 && m.fp !== me.fp) { try { const d = JSON.parse(r.text); mergeRoster(d.records); learnPeers(d.peers); noteVersion(m.host, d.version) } catch {} }
    return m
  }

  /**
   * Work out which member a non-member name (IP, Tailscale name, configured peer) refers to, and
   * remember it. Returns the member's host (cfg.host if it's us), or null.
   * @param {string} name
   */
  async function resolveName(name) {
    const real = peerRow(name)?.alias_of
    if (real && (member(real) || real === cfg.host)) return real
    const addr = addrOf(name)
    let m
    try { m = await identify(addr) } catch { return null }
    if (m.fp === me.fp) return adoptSelfAlias(name) ? cfg.host : null
    q.upsertPeer.run(name, addr, now(), 0)
    q.setAlias.run(m.host, name)
    if (!cfg.routes[m.host]) q.upsertPeer.run(m.host, addr, now(), 0)
    log(`${name} is ${m.host}`)
    return m.host
  }

  const probing = new Set()
  /** @type {Map<string, number>} "host addr" -> when verification last failed */
  const probeFailed = new Map()
  /**
   * Start routing member `host` to `addr`, but only once the machine there proves it holds its key.
   * @param {string} host @param {string} addr @param {{ refresh?: boolean }} [opts] refresh: a fresh sighting (beacon, request)
   */
  async function probe(host, addr, { refresh = true } = {}) {
    if (!validAddr(addr) || isSelf(host) || !member(host)) return
    const key = `${host} ${addr}`
    try {   // nothing awaits this, so a failed write here (a full disk) must stop here too
      const cur = peerRow(host)
      if (cur?.addr === addr) {
        if (!refresh) return
        q.upsertPeer.run(host, null, now(), 0)
        if (q.wake.run(host).changes) kick()
        return
      }
      if (probing.has(key) || now() - (probeFailed.get(key) || 0) < PROBE_RETRY_MS) return
      // a few at a time, and few per machine: beacons can be replayed from any address on the LAN,
      // and each probe is a connection and a copy of the roster (a real move is seen again in 30 s)
      if (probing.size >= MAX_PROBES || [...probing].filter(k => k.startsWith(`${host} `)).length >= MAX_PROBES_PER_HOST) return
      probing.add(key)
      try {
        const data = await call(host, 'POST', '/v1/hello', helloBody(), { addr, timeout: 2500 })
        if (!cfg.routes[host]) q.upsertPeer.run(host, addr, now(), 0)
        learnPeers(data.peers)
        noteVersion(host, data.version)
        log(`${host} is at ${addr}`)
        if (q.wake.run(host).changes) kick()
      } catch (e) {
        // a node still starting hasn't failed the check: it may be tried again sooner. Not at once: the
        // claim is unproved, and an address that always makes it mustn't get past the throttle
        probeFailed.set(key, e instanceof StartingError ? now() - PROBE_RETRY_MS + STARTING_RETRY_MS : now())
      } finally { probing.delete(key) }
      // forget the oldest failures, never all of them: clearing them would end the throttle under a flood
      if (probeFailed.size > 1000) for (const k of [...probeFailed.keys()].slice(0, probeFailed.size - 1000)) probeFailed.delete(k)
    } catch (e) { log('probe error', errMsg(e)) }
  }

  /** Track a member that sent us a request from `remoteIp` (its listening port in the header). @param {string} host @param {string | undefined} remoteIp @param {unknown} portHdr */
  function notePeer(host, remoteIp, portHdr) {
    q.upsertPeer.run(host, null, now(), 0)
    const ip = String(remoteIp || '').replace(/^::ffff:/, '')
    const port = Number(portHdr)
    if (ip && !/^(127\.|::1$)/.test(ip) && Number.isInteger(port) && port > 0 && port < 65536) {
      const addr = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`
      if (peerRow(host)?.addr !== addr && !cfg.routes[host]) probe(host, addr)
    }
  }

  /** @type {Map<string, Set<string>>} member -> addresses other members have told us about */
  const heard = new Map()
  /**
   * Other places `host` might be when its stored address stops answering: what it was configured or
   * first found under (a Tailscale name, an IP), what other members told us, and its own name. A
   * laptop that moves between networks keeps an address that no beacon will ever replace.
   * @param {string} host
   */
  function otherAddrs(host) {
    const cur = addrOf(host)
    const names = allPeers().filter(r => r.alias_of === host).map(r => addrOf(r.host))
    // what we were told comes last, newest first: any member can say anything, and can't crowd out the rest
    return [...new Set([...names, `${host}:${cfg.port}`, ...[...(heard.get(host) || [])].reverse()])].filter(a => a !== cur && validAddr(a))
  }

  /** Addresses worth telling other members about (so every node learns the whole network). */
  function shareablePeers() {
    const cutoff = now() - 86400_000
    return allPeers().filter(r => member(r.host) && r.last_seen >= cutoff && r.addr).map(r => ({ host: r.host, addr: /** @type {string} */ (r.addr) }))
  }
  /**
   * Addresses another member told us about. They may be stale (DHCP reuse) or wrong, so they are
   * never used directly: each is probed, and only used once the handshake there presents the key.
   * @param {unknown} list
   */
  function learnPeers(list) {
    for (const pe of Array.isArray(list) ? list.slice(0, 200) : []) {
      if (typeof pe?.host !== 'string' || !validAddr(pe?.addr)) continue
      let h
      try { h = normHost(pe.host) } catch { continue }
      if (!member(h) || cfg.routes[h]) continue
      if (!peerRow(h)?.addr) probe(h, pe.addr, { refresh: false })
      else if (pe.addr !== peerRow(h)?.addr) {
        if (!heard.has(h)) heard.set(h, new Set())
        const known = /** @type {Set<string>} */ (heard.get(h))
        known.delete(pe.addr)
        known.add(pe.addr)                                    // newest last; the oldest makes way
        if (known.size > 8) known.delete(/** @type {string} */ (known.values().next().value))
      }
    }
  }

  /** A member's hello to us: what it knows, and its version. @param {string} host @param {any} d */
  function greeted(host, d) {
    if (q.wake.run(host).changes) kick()
    mergeRoster(d.records)
    learnPeers(d.peers)
    noteVersion(host, d.version)
  }

  /** @param {string} host */
  async function hello(host) {
    try {
      const r = await call(host, 'POST', '/v1/hello', helloBody(), { timeout: 2500 })
      learnPeers(r.peers)
      noteVersion(host, r.version)
      if (q.wake.run(host).changes) kick()   // it's reachable: retry anything waiting for it now
    } catch {
      // nothing answers where we think it is: look for it. Each address must prove it holds the key.
      if (!cfg.routes[host]) await Promise.all(otherAddrs(host).slice(0, 4).map(addr => probe(host, addr)))
    }
  }
  /** @type {Promise<void> | null} */
  let helloing = null
  /** Say hello to everyone: finished when the round in progress, or a new one, is. */
  const helloAll = () => helloing ??= helloRound().finally(() => { helloing = null })
  async function helloRound() {
    try {
      // configured names that aren't member names (an IP, a Tailscale name): find out who they are
      for (const pe of cfg.peers) if (!member(pe.host) && !isSelf(pe.host) && !peerRow(pe.host)?.alias_of) await resolveName(pe.host)
      const hosts = knownPeers()
      let i = 0
      await Promise.all(Array.from({ length: Math.min(HELLO_CONCURRENCY, hosts.length) }, async () => {
        while (i < hosts.length) await hello(hosts[i++])
      }))
    } catch (e) { log('hello error', errMsg(e)) }
  }
  /** A hello round begun after this is called: what every machine knows now. */
  const freshRound = async () => { await helloing; await helloAll() }

  return {
    call, identify, resolveName, probe, notePeer, learnPeers, shareablePeers, greeted, hello, helloAll, freshRound,
    knownPeers, notMember, reachedAt: (/** @type {string} */ h) => reachedAt.get(h),
  }
}
