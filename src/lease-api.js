// The node's lease requests: from this machine (sessions, `natter lease`, the heartbeat), and from
// other machines about this one's resources. Leases themselves are kept by leases.js; this decides
// which machine keeps a resource's leases, asks it, and checks what comes back.
import { parseResource, sessionId, cleanLease, cleanNotice, noticeText, MAX_RESOURCE, SID } from './leases.js'
import { normHost, sanitizeName, errMsg } from './config.js'
import { httpErr, PeerAnswered } from './errors.js'

/**
 * @param {{
 *   cfg: { host: string },
 *   leases: ReturnType<typeof import('./leases.js').createLeases>,
 *   sessions: Map<string, { token: string, owner: number, lastActive: number }>,
 *   now: () => number,
 *   member: (h: string) => unknown, knownPeers: () => string[], notMember: (h: string) => string,
 *   routeFor: (h: string) => Promise<string | null>,
 *   call: (host: string, method: 'GET' | 'POST', p: string, obj?: object, o?: { timeout?: number }) => Promise<any>,
 *   version: (h: string) => string | null | undefined,
 *   ownedBy: (pids: number[], cwd?: string | null) => [string, { lastActive: number }] | undefined,
 *   notice: (to: string, body: string) => Promise<unknown>,
 * }} o notice: a message from leases@ this machine to `to` (a session here, or one elsewhere: then held for it)
 */
export function leaseApi({ cfg, leases, sessions, now, member, knownPeers, notMember, routeFor, call, version, ownedBy, notice }) {
  /**
   * The member name of the machine a resource names, or throw. The same route as for messages, so a
   * name two machines claim is no one's here either (see contested in peers.js).
   * @param {string} h
   */
  async function authorityFor(h) {
    const r = await routeFor(h).catch(() => null)     // this machine's and members' names answer at once
    if (r === 'self') return cfg.host
    if (r && member(r)) return r
    if (member(h)) throw httpErr(409, notMember(h))    // a member name routeFor refused: it's contested
    throw httpErr(404, `${h} is not a machine on this network (machines: ${[cfg.host, ...knownPeers()].join(', ')})`)
  }

  /**
   * Ask the machine that keeps a resource's leases. A machine on a version without leases answers
   * 404 to any path it doesn't know: say which version it runs, if it has said.
   * @param {string} auth @param {Record<string, unknown>} body
   */
  async function askAuthority(auth, body) {
    if (auth === cfg.host) return remoteLease(cfg.host, body)
    let r
    try { r = await call(auth, 'POST', '/v1/lease', body, { timeout: 5000 }) } catch (e) {
      if (e instanceof PeerAnswered && e.peerStatus === 404) {
        const v = version(auth)
        throw httpErr(501, `${auth} runs ${v ? `nattermatic ${v}` : 'an older nattermatic'}, which doesn't have leases: it needs upgrading first`)
      }
      if (e instanceof PeerAnswered) throw httpErr(502, errMsg(e))
      throw httpErr(503, `${auth} can't be reached, so its resources can't be claimed or released now (${errMsg(e)})`)
    }
    // what another machine says is rebuilt from checked parts: none of its words reach a session as ours
    const flag = (/** @type {string} */ k) => r?.[k] === true
    const lease = cleanLease(r?.lease, auth)
    // a reply that must describe the lease and can't be read is an error, not a lease without details
    const needs = body.op === 'claim' || (body.op === 'renew' && flag('ok')) || (body.op === 'release' && !flag('ok'))
    if (needs && !lease) throw httpErr(502, `${auth} gave an answer about ${body.resource} that couldn't be read`)
    return {
      ok: flag('ok'), renewed: flag('renewed'), released: flag('released'), broken: flag('broken'), same_name: flag('same_name'), notify: flag('notify'), gone: flag('gone'),
      lease,
      ...(body.op === 'list' ? { host: auth, leases: (Array.isArray(r?.leases) ? r.leases.slice(0, 1000) : []).map((/** @type {unknown} */ l) => cleanLease(l, auth)).filter(Boolean) } : {}),
    }
  }

  /**
   * A lease request from a machine of the network (or this one), about one of this machine's
   * resources. The holder's machine is the one that proved its key; its node vouches for the name.
   * @param {string} from @param {Record<string, any>} d
   */
  function remoteLease(from, d) {
    const op = String(d.op || '')
    if (op === 'list') return { ok: true, host: cfg.host, leases: leases.list() }
    const resource = String(d.resource || '')
    let parsed = null
    try { parsed = resource && resource.length <= MAX_RESOURCE ? parseResource(resource, cfg.host).name : null } catch {}
    if (!parsed || resource !== parsed) throw httpErr(400, 'bad resource name')
    if (op === 'check') { const row = leases.current(resource); return { ok: true, lease: row ? leases.view(row) : null } }
    const name = sanitizeName(d.name)
    if (op === 'break') return leases.breakLease({ resource, by: `${name}@${from}` })
    const sid = String(d.sid || '')
    if (!SID.test(sid)) throw httpErr(400, 'a lease needs the session that holds it')
    /** @type {import('./leases.js').Holder} */
    const holder = { host: from, name, sid, kind: d.kind === 'process' ? 'process' : 'session' }
    if (op === 'claim') return leases.claim({ resource, holder, note: d.note, ttl_ms: d.ttl_ms, cap_ms: d.cap_ms, notify: d.notify, takeover: d.takeover })
    if (op === 'release') return leases.release({ resource, holder, takeover: d.takeover })
    if (op === 'renew') return leases.renew({ resource, holder, ttl_ms: d.ttl_ms })
    if (op === 'rebind' && holder.kind === 'session' && SID.test(String(d.old_sid || ''))) return leases.rebind({ resource, holder, old_sid: String(d.old_sid) })
    throw httpErr(400, `unknown lease request "${op}"`)
  }

  /**
   * A notice from the machine that keeps a lease, for a holder or waiter here. It reaches the session
   * from leases@ this machine, in this node's own words, built from checked fields: the resource is
   * the sender's, whatever it says, and nothing it wrote is passed on. 429 or 503 if it can't be
   * stored now (the sender tries again); 400 if it doesn't add up.
   * @param {string} from @param {Record<string, any>} d
   */
  async function remoteNotice(from, d) {
    const to = typeof d.to === 'string' && sanitizeName(d.to) === d.to ? d.to : ''
    const n = cleanNotice(d.notice, from)
    if (!to || !n) throw httpErr(400, 'bad lease notice')
    // a holder's notice is about the session it's addressed to
    await notice(`${to}@${cfg.host}`, noticeText(n.kind === 'ended' ? { ...n, holder: `${to}@${cfg.host}` } : n, from))
    return { ok: true }
  }

  /**
   * Hand a notice about a lease here to the machine its holder or waiter is on, so their node can
   * deliver it as its own. 'sent', or 'dropped' when that machine isn't a member or refused it;
   * throws when it can't be reached (the notice waits). A machine on a version without this (404)
   * is sent the notice as a message from leases@ here, as before: held for it if it's offline.
   * @param {string} host @param {string} name @param {import('./leases.js').Notice} n
   */
  async function sendNotice(host, name, n) {
    if (!member(host)) return 'dropped'
    try { await call(host, 'POST', '/v1/lease-notice', { to: name, notice: n }, { timeout: 5000 }) } catch (e) {
      if (e instanceof PeerAnswered && e.peerStatus === 404) { await notice(`${name}@${host}`, noticeText(n, cfg.host)); return 'sent' }
      if (e instanceof PeerAnswered && e.peerStatus === 400) return 'dropped'
      throw e
    }
    return 'sent'
  }

  /**
   * A lease request from this machine: a session's tool call (by its name: the node knows which
   * session that is), a `natter lease` command (a process with its own id), or the heartbeat hook.
   * @param {Record<string, any>} d
   */
  async function localLease(d) {
    const op = String(d.op || '')
    if (op === 'beat') {
      const pids = (Array.isArray(d.pids) ? d.pids : []).map(Number).filter(Boolean)
      const found = ownedBy(pids, typeof d.cwd === 'string' && d.cwd ? d.cwd : null)   // a folder: from a Codex session
      if (!found) return { ok: false }
      found[1].lastActive = now()
      return { ok: true, name: found[0] }
    }
    if (op === 'list') {
      let host = cfg.host
      if (d.host) try { host = normHost(String(d.host)) } catch { throw httpErr(400, `bad machine name "${d.host}"`) }
      const auth = host === cfg.host ? host : await authorityFor(host)
      const r = await askAuthority(auth, { op: 'list' })
      return { ...r, held: leases.heldRows().map(h => ({ resource: `${h.resource}@${h.authority}`, holder: `${h.name}@${cfg.host}`, kind: h.kind })) }
    }
    let res
    try { res = parseResource(d.resource, cfg.host) } catch (e) { throw httpErr(400, errMsg(e)) }
    const auth = await authorityFor(res.host)
    const resource = `${res.name}@${auth}`
    if (op === 'check') return { ...(await askAuthority(auth, { op, resource: res.name })), resource }
    if (op === 'break') return { ...(await askAuthority(auth, { op, resource: res.name, name: d.by || 'cli' })), resource }
    /** @type {import('./leases.js').Holder} */
    let holder
    if (d.kind === 'process') {
      if (!SID.test(String(d.sid || ''))) throw httpErr(400, 'a lease needs the process that holds it')
      holder = { host: cfg.host, name: sanitizeName(d.name || 'cli'), sid: String(d.sid), kind: 'process' }
    } else {
      const s = sessions.get(String(d.name || ''))
      if (!s?.token) throw httpErr(409, `no session named ${d.name || '(none)'} is connected to this machine's node`)
      s.lastActive = now()
      holder = { host: cfg.host, name: String(d.name), sid: sessionId(s.token), kind: 'session' }
    }
    if (!['claim', 'release', 'renew'].includes(op)) throw httpErr(400, `unknown lease request "${op}"`)
    const ask = () => askAuthority(auth, { op, resource: res.name, name: holder.name, sid: holder.sid, kind: holder.kind, note: d.note, ttl_ms: d.ttl_ms, cap_ms: d.cap_ms, notify: d.notify, takeover: d.takeover })
    // a release is forgotten here whatever happens: if the machine can't be told, the lease runs out
    // (only this holder's own record: a refused release mustn't drop the real holder's)
    if (op === 'release') { try { return { ...(await ask()), resource } } finally { leases.forget(auth, res.name, holder.sid) } }
    const r = await ask()
    if (r.ok && r.lease) {
      if (op === 'claim') leases.noteHeld(auth, res.name, holder, r.lease.ttl_s * 1000)
      else leases.noteRenewed(auth, res.name, holder.sid, r.lease.ttl_s * 1000)
    } else if (op === 'renew') leases.forget(auth, res.name, holder.sid)
    return { ...r, resource }
  }

  return { authorityFor, askAuthority, remoteLease, remoteNotice, sendNotice, localLease }
}
