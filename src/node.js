// The per-machine node: durable store, local session hub, peer-to-peer delivery, LAN discovery.
//
// Every connection, in and out, is TLS. The certificate this node presents is a throwaway (a fresh
// key per connection; while invites are open, the invite key), so connecting to the port shows
// nothing that identifies the machine. Who is who is proved inside the connection (see tls.js):
// outgoing connections accept only the machine the roster says should be at the other end, so an
// address is usable for a machine exactly when the machine there proves it holds that key, and a
// stranger who happens to hold a stored address is never told who we are or sent a request.
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openStore, queries } from './store.js'
import { startDiscovery } from './discovery.js'
import { gateOk, proveAuth, checkAuth } from './crypto.js'
import { fingerprint, shortFp, newIdentity } from './cert.js'
import { Roster, MAX_ROSTER_BYTES, recordBudget } from './roster.js'
import { exporterOf, PROTO, MAX_BODY as MAX_REQ } from './tls.js'
import { SEA, PKG_ROOT, readAsset, appBundle } from './self.js'
import { renameOldDb } from './legacy.js'
import { httpErr } from './errors.js'
import { leaseApi } from './lease-api.js'
import { createSessions } from './sessions.js'
import { createInvites } from './invites.js'
import { createPeers } from './peers.js'
import { createMessages } from './messages.js'
import { createLeases, sessionId, noticeText } from './leases.js'
import { parsePeer, normHost, machineName, sanitizeName, shQuote, validAddr, tailscaleNameAsync, localIPv4s, errMsg, ensureHomeDir, rosterPath, MAX_TTL_MS, VERSION } from './config.js'

const MAX_JOIN_REQ = 16 << 10          // a join request (before any identity check) is small
const MAX_NEWCOMER_REQ = 2 * MAX_ROSTER_BYTES   // a new member's first hello, read before it has proved its key
const MAX_JOIN_CHAIN = 4               // add records an unknown client may submit (it, whoever added it, ...)
const HELLO_EVERY = 120_000
const PEER_FORGET_MS = 30 * 86400_000
const PEERS_WAIT_MS = 5000             // `peers` answers by then: a machine that slow counts as offline
const COMPACT_WAIT_MS = 100_000        // to catch up before a snapshot: the command waits a little longer
const MAX_LOG = 10 << 20               // node.log is cut back to its last MB past this
const LOG_ERRORS_PER_MIN = 10          // failed requests logged: anyone can cause one

/** @typedef {import('./types.js').Config} Config */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').PeerRow} PeerRow */
/** @typedef {http.ServerResponse} Res */

const execFileP = promisify(execFile)
const now = () => Date.now()
const ignore = () => {}

// log lines may quote what another machine sent: control characters in it can't start a line of their own
const oneLine = (/** @type {unknown} */ a) => typeof a === 'string' ? a.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`) : a

/**
 * @param {Config} cfg
 * @param {(...a: any[]) => void} [log]
 */
export async function runNode(cfg, log = (...a) => { try { console.error(new Date().toISOString(), ...a.map(oneLine)) } catch {} }) {
  ensureHomeDir(cfg.dir)
  // a full disk mustn't take the node down with its log. (Once: a standby service gets here on every retry)
  if (!process.stderr.listeners('error').includes(ignore)) process.stderr.on('error', ignore)
  const me = cfg.identity
  // Bind the port before touching the shared database: a node that loses the race for the port
  // (a standby service, a second session-started node) must not reset retry state or leak handles.
  /** @type {(req: http.IncomingMessage, res: Res) => void} */
  let onRequest = (req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"starting"}') }
  // TLS 1.2 is accepted for the installer download (macOS curl's SecureTransport has no TLS 1.3);
  // the identity exchange requires TLS 1.3.
  /** @param {{ key: string, cert: string }} id */
  const tlsOpts = id => ({ key: id.key, cert: id.cert, minVersion: /** @type {const} */ ('TLSv1.2') })
  const server = https.createServer(tlsOpts(newIdentity()), (req, res) => onRequest(req, res))
  server.on('tlsClientError', () => {})
  /** @type {() => void} */
  let rotate = () => {}
  server.on('connection', () => rotate())
  await new Promise(/** @param {(v?: void) => void} resolve */ (resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, () => { server.off('error', reject); resolve() })
  })
  /** @type {import('node:sqlite').DatabaseSync} */
  let db
  /** @type {Roster} */
  let roster
  try {
    roster = Roster.load(rosterPath(cfg.dir))
    renameOldDb(cfg.dir)          // this node has the port, so no other node of this machine has it open
    db = openStore(path.join(cfg.dir, 'nattermatic.db'))
  } catch (e) { server.close(); throw e }
  const myPub = crypto.createPublicKey(me.key)
  // the roster decides this machine's name: under any other, its messages wouldn't be accepted
  const rosterName = roster.members.get(me.fp)?.host
  if (rosterName && rosterName !== cfg.host) {
    log(`this machine is ${rosterName} on its network, not ${cfg.host}: using ${rosterName}`)
    cfg.host = rosterName
  }
  if (!roster.members.has(me.fp)) log(roster.removed.has(me.fp) ? 'this machine has been removed from the network' : 'this machine is not (yet) a member of its network')

  const q = queries(db)


  // ---------- the certificate we present (see invites.js) ----------
  const invites = createInvites({ present: id => server.setSecureContext(tlsOpts(id)), q, dir: cfg.dir, now, log })
  rotate = invites.rotate
  rotate()

  // typed views of the rows node:sqlite returns
  const peerRow = (/** @type {string} */ host) => /** @type {PeerRow | undefined} */ (q.peer.get(host))
  const allPeers = () => /** @type {PeerRow[]} */ (/** @type {unknown} */ (q.peers.all()))
  const msgRow = (/** @type {string} */ id) => /** @type {MessageRow | undefined} */ (q.get.get(id))
  /** One commit for many row updates. @param {() => void} fn */
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE')
    try { fn(); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
  }

  // a promise nothing waits on that fails is a bug to log, not a reason to stop delivering messages
  if (!process.listenerCount('unhandledRejection')) process.on('unhandledRejection', e => log(`internal error (unhandled): ${errMsg(e)}`))
  /** Run a callback from a timer or an event: a failure (a database error, say) is logged, not a crash. @param {() => unknown} fn */
  const safe = fn => { try { fn() } catch (e) { log(`internal error: ${errMsg(e)}`) } }
  const hub = createSessions({ q, msgRow, tx, now, safe, host: () => cfg.host })
  const sessions = hub.map
  const { pump } = hub

  // ---------- identity ----------
  const selfAliases = new Set(cfg.aliases)
  /** @type {{ at: number, name: string | null }} */
  let tsCache = { at: 0, name: null }
  /**
   * This machine's Tailscale name, if it has one now (Tailscale may arrive while the node runs). Asked
   * without blocking, and at most once a minute: a hung Tailscale would otherwise stall the node.
   */
  async function tailscale() {
    if (!cfg.autoAliases) return null
    if (now() - tsCache.at > 60_000) tsCache = { at: now(), name: await tailscaleNameAsync() }
    const name = tsCache.name
    if (name && name !== cfg.host) selfAliases.add(name)
    return name
  }
  // at startup it's waited for, as before: what follows decides what counts as this machine
  await tailscale().catch(ignore)
  selfAliases.delete(cfg.host)
  const isSelf = (/** @type {string} */ h) => h === cfg.host || selfAliases.has(h)
  /** A current member other than this machine, by name. @param {string} host */
  const member = host => { const m = roster.byHost.get(host); return m && m.fp !== me.fp ? m : undefined }
  let leaseBusy = false
  // a notice from this machine's node (leases@ here), with the node's own words: it wakes the session
  const notice = (/** @type {string} */ to, /** @type {string} */ body) => localSend({ from: 'leases', to, body })
  const leases = createLeases({
    db, host: () => cfg.host, dir: cfg.dir, sessions, log,
    call: (h, m, p, o, opts) => call(h, /** @type {'GET'|'POST'} */ (m), p, /** @type {object | undefined} */ (o), opts),
    tellLocal: (name, n) => { notice(`${name}@${cfg.host}`, noticeText(n, cfg.host)).catch(e => log(`could not tell ${name}@${cfg.host} about a lease: ${errMsg(e)}`)) },
    // a holder or waiter on another machine hears from its own node: the notice goes to that node
    tellRemote: (h, name, n) => sendNotice(h, name, n),
  })
  const budget = recordBudget()
  /**
   * Merge membership records; persist if anything changed. Records from a member (`from`, its
   * fingerprint) count against its allowance, so it can't make us check thousands of signatures a
   * request (#9). A newcomer's are a short chain, already capped.
   * @param {unknown} records @param {string} [from]
   */
  function mergeRoster(records, from) {
    if (from) {
      const fresh = roster.unseen(records)
      if (!fresh.length) return false
      records = fresh.slice(0, budget.take(from, fresh.length))
    }
    if (!roster.merge(records)) return false
    try { roster.save() } catch (e) { log('could not save the roster:', errMsg(e)) }
    return true
  }

  /**
   * `name` turned out to be one of this machine's names (an IP, a Tailscale name used by a sender):
   * take delivery of anything queued for it. Configured peers are other machines by definition, so
   * a configured name whose address now reaches us (DHCP reuse) is not adopted.
   * @param {string} name
   */
  function adoptSelfAlias(name) {
    const row = peerRow(name)
    if (row?.configured) {
      log(`address ${row.addr || name} for ${name} now reaches this machine; forgetting it`)
      q.clearAddr.run(name)
      return false
    }
    if (!selfAliases.has(name)) log(`learned that ${name} is this machine`)
    selfAliases.add(name)
    if (row) q.deletePeer.run(name)
    const names = new Set(q.toInbox.all(cfg.host, now(), name).map(r => String(r.to_name)))
    for (const n of names) pump(n)
    return true
  }

  for (const pe of cfg.peers) if (!isSelf(pe.host)) q.upsertPeer.run(pe.host, pe.addr, now(), 1)
  db.exec(`UPDATE messages SET next_attempt=0 WHERE state='pending'`)   // fresh start: retry everything now
  // rows with out-of-range timestamps (stored before they were validated) can't even be read back by
  // node:sqlite, and would stall the forwarding loop for good: drop them without selecting them
  {
    const bad = db.prepare(`DELETE FROM messages WHERE expires_at > ? OR sent_at > ? OR sent_at < 0`).run(now() + 2 * MAX_TTL_MS, now() + 2 * MAX_TTL_MS)
    if (bad.changes) log(`dropped ${bad.changes} stored message(s) with invalid timestamps`)
  }

  // ---------- peers (see peers.js) ----------
  const peers = createPeers({
    cfg, me, roster, q, peerRow, allPeers, now, log, isSelf, member, mergeRoster,
    removedHost: h => removedHost(h), kick: () => kick(), adoptSelfAlias,
  })
  const { call, identify, resolveName, probe, notePeer, shareablePeers, hello, helloAll, knownPeers, notMember } = peers

  // ---------- messages (see messages.js) ----------
  const messages = createMessages({
    cfg, q, roster, me, now, log, tx, msgRow, isSelf, member, peerRow, allPeers, selfAliases, adoptSelfAlias,
    hub, call, hello, resolveName, notMember, knownPeers,
  })
  const { accept, kick, flush, routeFor, removedHost, localSend, fullError } = messages

  function gc() {
    try {
      q.gc.run(now() - 86400_000)
      q.forgetPeers.run(now() - PEER_FORGET_MS)
      q.gcInvites.run(now() - 86400_000)
    } catch (e) { log('gc error', errMsg(e)) }
    trimLog()
  }
  /** Keep node.log from growing without end. It's opened for appending, so writers carry on at the new end. */
  function trimLog() {
    const file = path.join(cfg.dir, 'node.log')
    try {
      const { size } = fs.statSync(file)
      if (size <= MAX_LOG) return
      const fd = fs.openSync(file, 'r')
      const tail = Buffer.alloc(1 << 20)
      try { fs.readSync(fd, tail, 0, tail.length, size - tail.length) } finally { fs.closeSync(fd) }
      fs.truncateSync(file, 0)
      fs.appendFileSync(file, tail.subarray(tail.indexOf(10) + 1))
    } catch {}
  }

  // ---------- local API helpers ----------
  const { askAuthority, remoteLease, remoteNotice, sendNotice, localLease } = leaseApi({
    cfg, leases, sessions, now, isSelf, member, knownPeers,
    routeFor: h => routeFor(h),
    call: (h, m, p, o, opts) => call(h, m, p, o, opts),
    version: h => peerRow(h)?.version,
    ownedBy: hub.ownedBy, notice,
  })

  const rosterStatus = () => {
    const bytes = Buffer.byteLength(JSON.stringify(roster.records))
    return { bytes, limit: MAX_ROSTER_BYTES, ...(bytes > MAX_ROSTER_BYTES * 0.75 ? { note: 'the member list is nearly full: remove any machine flooding it, then run `natter compact` on the founding machine' } : {}) }
  }
  async function localPeers() {
    const remote = await Promise.all(knownPeers().map(async h => {
      try {
        const r = await call(h, 'GET', '/v1/sessions', undefined, { timeout: 1500, deadline: PEERS_WAIT_MS })
        return { host: h, online: true, sessions: sessionNames(r.sessions) }
      } catch (e) { return { host: h, online: false, sessions: [], error: /** @type {any} */ (e).reason || errMsg(e) } }
    }))
    return { self: cfg.host, local: [...sessions.keys()], remote }
  }

  const hostOfFp = (/** @type {string} */ fp) => roster.members.get(fp)?.host ||
    roster.ranked.get(fp)?.host || [...roster.records].reverse().find(r => r.type === 'add' && r.fp === fp)?.host || shortFp(fp)
  function members() {
    // in joining order: each machine can remove the ones listed after it
    return [...roster.members.values()].sort((a, b) => a.rank - b.rank).map(m => ({
      host: m.host, fp: shortFp(m.fp), added_by: m.by === m.fp ? '(founded the network)' : hostOfFp(m.by), added_at: m.at, self: m.fp === me.fp,
      // the version it said it runs when last heard from: null for one older than 0.3.0, or not heard from yet
      version: m.fp === me.fp ? VERSION : peerRow(m.host)?.version ?? null,
    }))
  }

  /**
   * A machine joining with an invite token: add it to the roster (signed by us).
   * @param {{ token?: unknown, host?: unknown, cert?: unknown }} d
   */
  function join(d) {
    if (typeof d.token !== 'string' || !invites.valid(d.token)) throw httpErr(403, 'this invite is not valid (already used, expired or revoked): run `natter invite` on a member for a new one')
    let pem, host
    try { pem = new crypto.X509Certificate(Buffer.from(String(d.cert), 'base64')).toString(); host = normHost(d.host) } catch { throw httpErr(400, 'bad join request') }
    if (!machineName(host)) throw httpErr(400, `"${host}" can't identify a machine: join under a name, by ending the invite line with \`| sh -s -- --host <name>\``)
    const fp = fingerprint(pem)
    const cur = roster.members.get(fp)
    if (cur && cur.host !== host) throw httpErr(409, `this machine is already a member as ${cur.host}. To rename it, run \`natter remove ${cur.host}\` on a machine that joined before it, then run a new invite line with \`| sh -s -- --host ${host}\` at the end`)
    if (!cur) {
      // 410: setup answers it by joining again with a new key (a machine isn't told it was removed)
      if (roster.removed.has(fp)) throw httpErr(410, 'this machine\'s key was removed from the network')
      if (roster.byHost.has(host)) throw httpErr(409, `${host} is already a member of this network with a different key. On a member, run \`natter remove ${host}\` first, or join under another name by ending the invite line with \`| sh -s -- --host <name>\``)
      try { roster.add(me, host, pem) } catch (e) { throw httpErr(507, errMsg(e)) }
      if (!roster.members.has(fp)) throw httpErr(500, 'could not add this machine')
      roster.save()
      log(`${host} joined the network (key ${shortFp(fp)})`)
    }
    invites.use(d.token)
    setImmediate(helloAll)
    return { net: roster.net, records: roster.records, peers: shareablePeers(), host: cfg.host }
  }

  /**
   * The add records for `fp`, then for whoever signed that, and so on (at most a few), ending at a
   * current member: what an unknown client may submit before it has proved who it is.
   * @param {unknown} records @param {string} fp
   */
  function joinChain(records, fp) {
    /** @type {Map<unknown, any>} */
    const adds = new Map()
    for (const r of Array.isArray(records) ? records : []) if (r?.type === 'add' && !adds.has(r.fp)) adds.set(r.fp, r)
    const out = []
    for (let want = fp; out.length < MAX_JOIN_CHAIN && !roster.members.has(want);) {
      if (roster.removed.has(want) || roster.dropped.has(want)) return []   // a chain through a removed machine counts for nothing
      const r = adds.get(want)
      if (!r || typeof r.by !== 'string' || r.by === want) break
      out.push(r)
      want = r.by
    }
    return out.length && roster.members.has(String(out[out.length - 1].by)) ? out : []
  }

  // ---------- HTTPS ----------
  /** @type {WeakSet<import('node:net').Socket>} connections whose client passed the gate */
  const gated = new WeakSet()
  /** @type {WeakMap<import('node:net').Socket, string>} connection -> the client's proven key */
  const authed = new WeakMap()
  /** @param {Res} res @param {number} status @param {unknown} obj */
  function reply(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }

  let errorsLogged = 0, errorMinute = 0
  onRequest = (req, res) => handle(req, res).catch(err => {
    if (!res.headersSent) reply(res, err.status || 500, { error: err.status ? err.message : 'internal error' })
    else res.destroy()
    if (err.status) return
    if (now() - errorMinute > 60_000) { errorMinute = now(); errorsLogged = 0 }
    if (++errorsLogged <= LOG_ERRORS_PER_MIN) log('request error', req.method, (req.url || '').split('?')[0], errMsg(err))   // never log the query: it can hold an invite token
  })

  /** @param {http.IncomingMessage} req @param {Res} res */
  async function handle(req, res) {
    let u
    try { u = new URL(req.url || '/', 'https://x') } catch { return reply(res, 404, { error: 'not found' }) }   // like any unknown path
    const p = u.pathname
    const sock = /** @type {import('node:tls').TLSSocket} */ (req.socket)
    // ---- identity, step 1 (the gate): a client that holds a discovery key learns who we are ----
    // Anyone else gets the same 404 as for any unknown path.
    if (p === '/v1/auth') {
      const ekm = sock.getProtocol() === 'TLSv1.3' ? exporterOf(sock) : null
      if (!ekm || !gateOk(roster.gateDks(), ekm, req.headers['x-agentlink-gate'])) return reply(res, 404, { error: 'not found' })
      gated.add(sock)
      return reply(res, 200, { fp: me.fp, sig: proveAuth(me.key, 'server', ekm), proto: PROTO })
    }
    // ---- joining (an invite token is the credential) ----
    if (req.method === 'GET' && (p === '/join/install' || p === '/join/pkg.tgz' || p === '/join/app.zip')) {
      const t = u.searchParams.get('t')
      if (!t || !invites.valid(t)) return reply(res, 404, { error: 'this invite is not valid (already used, expired or revoked): run `natter invite` on a member for a new one' })
      if (p === '/join/install') {
        res.writeHead(200, { 'content-type': 'text/x-shellscript' })
        return res.end(installScript(req.headers.host, cfg, t, invites.fp()))
      }
      const bundle = appBundle()
      if (p === '/join/app.zip' && !bundle) return reply(res, 404, { error: 'this machine does not run the nattermatic app' })
      let file, size
      try { file = await (p === '/join/app.zip' && bundle ? packApp(cfg.dir, bundle) : packTarball(cfg.dir)); size = (await fs.promises.stat(file)).size } catch (e) {
        log('could not pack nattermatic for an installing machine:', errMsg(e))
        return reply(res, 500, { error: 'package unavailable' })
      }
      const stream = fs.createReadStream(file)
      res.on('close', () => stream.destroy())     // an abandoned download mustn't keep the file open
      stream.on('error', () => { if (!res.headersSent) reply(res, 500, { error: 'package unavailable' }); else res.destroy() })
      stream.on('open', () => {
        res.writeHead(200, { 'content-type': p === '/join/app.zip' ? 'application/zip' : 'application/gzip', 'content-length': size })
        stream.pipe(res)
      })
      return
    }
    const joining = req.method === 'POST' && p === '/join'
    // request bodies are read only for joins (small) and for clients past the gate
    if (!joining && !gated.has(sock)) return reply(res, 404, { error: 'not found' })

    // ---- identity, step 2: the client signs the same connection's exporter with its machine key ----
    let clientFp = authed.get(sock) || ''
    const [fp = '', sig] = joining || clientFp ? [] : String(req.headers['x-agentlink-auth'] || '').split('.')
    /** @param {string} f */
    const proves = f => { const pub = f === me.fp ? myPub : roster.members.get(f)?.publicKey; return !!pub && checkAuth(pub, 'client', exporterOf(sock), sig) }
    if (fp && proves(fp)) { clientFp = fp; authed.set(sock, fp) }
    // A machine we don't know yet can prove itself only by a hello carrying the records that add it,
    // so that body is read before it's proved: no bigger than a roster and the addresses it shares.
    // Anyone else who hasn't proved a key has nothing read (#9).
    const newcomer = !clientFp && !joining && p === '/v1/hello' && !!fp && fp !== me.fp && !roster.members.has(fp)
    const readMax = joining ? MAX_JOIN_REQ : clientFp ? MAX_REQ : newcomer ? MAX_NEWCOMER_REQ : 0
    const body = req.method === 'POST' && readMax ? await readBody(req, readMax) : ''
    /** @type {Record<string, any>} request body (untrusted: every field is checked where it's used) */
    let d = {}
    if (body) { try { d = JSON.parse(body) } catch { return reply(res, 400, { error: 'bad JSON' }) } }
    if (!d || typeof d !== 'object') d = {}
    if (joining) return reply(res, 200, join(d))
    if (newcomer) {
      // it proves it with the records that add it (and those adding whoever added it, if they are new
      // too). Nothing else is taken before the signature checks out. It may be in a snapshot we haven't
      // heard of, with no add left to show: one record, and only the founder can have signed it
      mergeRoster(Array.isArray(d.records) ? d.records.filter((/** @type {any} */ r) => r?.type === 'snapshot').slice(-1) : [])
      if (!roster.members.has(fp)) mergeRoster(joinChain(d.records, fp))
      if (proves(fp)) { clientFp = fp; authed.set(sock, fp) }
    }
    const local = isLoopback(sock.remoteAddress) && clientFp === me.fp   // a process holding this machine's key, on this machine

    if (p === '/health') {
      if (!local) return reply(res, 404, { error: 'not found' })
      return reply(res, 200, { ok: true, host: cfg.host, net: cfg.net, fp: me.fp, version: VERSION, proto: PROTO, pid: process.pid })
    }

    if (p.startsWith('/local/')) {
      if (!local) return reply(res, 403, { error: 'local only' })
      return handleLocal(req, res, u, p, d)
    }
    if (!p.startsWith('/v1/')) return reply(res, 404, { error: 'not found' })
    // ---- node <-> node: the client's key must be a current member's ----
    const peer = roster.members.get(clientFp)
    if (!peer) return reply(res, 403, { error: 'not a member of this network' })
    if (peer.fp !== me.fp) notePeer(peer.host, sock.remoteAddress, req.headers['x-agentlink-port'])

    switch (`${req.method} ${p}`) {
      case 'POST /v1/deliver': {
        /** @type {Record<string, string>} */
        const results = {}
        /** @type {string[]} */
        const unknown = []
        /** @type {string[]} */
        const noRoom = []
        /** @type {Set<string>} */
        const toPump = new Set()    // offer each local recipient its new messages once, not per envelope
        const mine = new Set(Array.isArray(d.mine) ? d.mine.slice(0, 2000) : [])
        try {
          tx(() => {
            for (const e of Array.isArray(d.messages) ? d.messages.slice(0, 2000) : []) {
              const st = accept(e, toPump, mine.has(e?.id) ? peer.host : undefined)
              if (st === 'unknown-sender') unknown.push(e.id)
              else if (st === 'full') noRoom.push(e.id)
              else if (st) results[e.id] = st
            }
          })
        } catch (err) {
          // temporary storage failure: 503 makes the sender back off and retry the whole batch,
          // instead of marking messages permanently failed
          log('could not store delivered messages:', errMsg(err))
          throw httpErr(503, 'temporarily unable to store messages; retry later')
        }
        for (const n of toPump) pump(n)
        return reply(res, 200, { results, unknown, full: noRoom })
      }
      case 'POST /v1/hello': {
        if (peer.fp !== me.fp) {
          peers.greeted(peer.host, d)
          leases.wakeNotices(peer.host)   // it's reachable: any lease notice waiting for it goes now
        }
        return reply(res, 200, { host: cfg.host, peers: shareablePeers(), records: roster.records, version: VERSION })
      }
      case 'GET /v1/sessions':
        return reply(res, 200, { host: cfg.host, sessions: [...sessions.keys()], sids: [...sessions.values()].map(s => sessionId(s.token)).filter(Boolean) })
      case 'POST /v1/lease':
        return reply(res, 200, remoteLease(peer.host, d))
      case 'POST /v1/lease-notice':             // about a lease that machine keeps, for a holder or waiter here
        return reply(res, 200, await remoteNotice(peer.host, d))
    }
    return reply(res, 404, { error: 'not found' })
  }

  /** @param {http.IncomingMessage} req @param {Res} res @param {URL} u @param {string} p @param {Record<string, any>} d */
  async function handleLocal(req, res, u, p, d) {
    switch (`${req.method} ${p}`) {
      case 'GET /local/stream': {
        const token = String(u.searchParams.get('token') || '')
        const { name, reconnected } = hub.connect(res, {
          want: sanitizeName(u.searchParams.get('name')), token, live: u.searchParams.get('mode') !== 'poll',
          owner: Number(u.searchParams.get('owner')) || 0, cwd: u.searchParams.get('cwd') || '',
        }, () => leases.marks())
        log(`session connected: ${name}`)
        leases.marks()
        // the same agent back under its name after its adapter restarted keeps its leases
        if (!reconnected && token) leases.carryOver(name, sessionId(token), askAuthority).catch(e => log('lease carry-over:', errMsg(e)))
        pump(name)
        return
      }
      case 'GET /local/wake': {                 // the wait behind `natter wake`: answers once, when there's news
        const pids = String(u.searchParams.get('pids') || '').split(',').map(Number).filter(Boolean)
        if (!hub.wait(res, pids, u.searchParams.get('cwd'))) return reply(res, 404, { error: 'no session' })
        return
      }
      case 'POST /local/lease':
        return reply(res, 200, await localLease(d))
      case 'GET /local/lease': {               // for tools that enforce leases: who holds this, if anyone
        return reply(res, 200, await localLease({ op: 'check', resource: u.searchParams.get('resource') }))
      }
      case 'POST /local/ack':                 // state 'pushed': shown in a channel session (no read receipt)
        hub.ack(String(d.name), d.ids, d.state)
        return reply(res, 200, { ok: true })
      case 'POST /local/told':                // a session has read these; or not (a cancelled read)
        hub.told(String(d.name), d.ids, !!d.told)
        return reply(res, 200, { ok: true })
      case 'POST /local/nack':                // the session couldn't take these: offer them again
        hub.nack(String(d.name), d.ids)
        return reply(res, 200, { ok: true })
      case 'POST /local/send':
        return reply(res, 200, await localSend(d))
      case 'GET /local/peers':
        return reply(res, 200, await localPeers())
      case 'GET /local/history': {
        const limit = Math.max(1, Math.min(Math.floor(Number(u.searchParams.get('limit'))) || 20, 200))
        const rows = q.history.all(sanitizeName(u.searchParams.get('name')), limit)
        return reply(res, 200, { messages: rows.map(r => ({ id: r.id, from: r.from_addr, body: r.body, sent_at: r.sent_at, state: r.state })) })
      }
      case 'GET /local/status':
        return reply(res, 200, {
          host: cfg.host, aliases: [...selfAliases], net: shortFp(cfg.net), fp: shortFp(me.fp), port: cfg.port, version: VERSION, pid: process.pid,
          member: roster.members.has(me.fp), removed: roster.removed.has(me.fp),
          roster: rosterStatus(),
          members: members(), sessions: [...sessions.keys()], counts: q.counts.all(), peers: allPeers(),
          pending: db.prepare(`SELECT id,to_addr,role,attempts,replicated,last_error FROM messages WHERE state='pending' ORDER BY sent_at LIMIT 20`).all(),
        })
      case 'POST /local/invite': {
        if (!roster.members.has(me.fp)) throw httpErr(409, 'this machine is not a member of its network, so it cannot invite others')
        const { token, fp, expires_at } = invites.create()
        return reply(res, 200, { token, fp, host: cfg.host, port: cfg.port, tailscale: await tailscale(), ip: localIPv4s().find(a => !a.startsWith('127.')), expires_at })
      }
      case 'GET /local/invites':                // open invites (their tokens are stored hashed, so only times)
        return reply(res, 200, { invites: q.openInvites.all(now()) })
      case 'POST /local/invite/revoke': {
        return reply(res, 200, { revoked: invites.revokeAll() })
      }
      case 'POST /local/remove': {
        let host
        try { host = normHost(d.host) } catch { throw httpErr(400, `bad machine name "${d.host}"`) }
        const m = roster.byHost.get(host) || roster.byHost.get(peerRow(host)?.alias_of || '')
        if (!m) throw httpErr(404, `${host} is not a member of this network`)
        if (m.fp === me.fp) throw httpErr(400, 'to take this machine off the network, run `natter uninstall` (or remove it from another member)')
        if (!roster.members.has(me.fp)) throw httpErr(409, 'this machine is not a member of its network')
        if (!roster.canRemove(me.fp, m.fp)) {
          const earlier = [...roster.members.values()].filter(x => x.rank < m.rank).map(x => x.host)
          throw httpErr(403, `${m.host} joined the network before this machine, so only an earlier machine can remove it: ${earlier.join(', ')}`)
        }
        try { roster.remove(me, m.fp) } catch (e) { throw httpErr(507, `could not remove ${m.host}: ${errMsg(e)}`) }
        roster.save()
        log(`removed ${m.host} (key ${shortFp(m.fp)}) from the network`)
        discovery?.announce()
        setImmediate(helloAll)
        return reply(res, 200, { removed: m.host })
      }
      case 'POST /local/compact': {
        if (me.fp !== roster.net) throw httpErr(403, `only the founding machine can do this: ${roster.ranked.get(roster.net)?.host ?? 'the first machine on the network'}`)
        // what the others know first, from a round begun now: an add we haven't heard of would be lost
        const asked = now()
        const catchUp = async () => { await peers.freshRound(); return true }
        /** @type {NodeJS.Timeout | undefined} */
        let limit
        const caughtUp = await Promise.race([catchUp(), new Promise(res => { limit = setTimeout(() => res(false), COMPACT_WAIT_MS) })]).finally(() => clearTimeout(limit))
        const list = [...roster.members.values()].map(m => m.host)
        const offline = list.filter(h => h !== cfg.host && !(Number(peers.reachedAt(h)) >= asked))
        if (!d.confirm) return reply(res, 200, { members: list, offline, caughtUp, ...rosterStatus() })
        if (req.socket.destroyed) return                       // the command was interrupted: that's a no
        if (!caughtUp && !d.force) throw httpErr(504, `not every machine could be checked in time, so nothing was changed. Not reached: ${offline.join(', ')}. Run it again, or add --force to go ahead without them`)
        const before = rosterStatus().bytes
        try { roster.compact(me) } catch (e) { throw httpErr(507, `could not compact: ${errMsg(e)}`) }
        roster.save()
        log(`compacted the member list: ${before} bytes to ${rosterStatus().bytes}`)
        discovery?.announce()
        setImmediate(helloAll)
        return reply(res, 200, { members: list, offline, before, ...rosterStatus() })
      }
      case 'POST /local/shutdown':
        reply(res, 200, { ok: true })
        return setTimeout(() => shutdown(), 50)
    }
    return reply(res, 404, { error: 'not found' })
  }

  log(`nattermatic node ${VERSION} up: ${cfg.host}:${cfg.port} (network ${shortFp(cfg.net)}, key ${shortFp(me.fp)}, pid ${process.pid})`)

  // ---------- discovery ----------
  const discovery = cfg.discovery ? startDiscovery(cfg, () => roster.gateDks(), ({ host, fp, addr }) => {
    const m = roster.members.get(fp)
    if (m && m.host === host && m.fp !== me.fp) probe(m.host, addr)   // beacons are only hints: the handshake verifies
  }, log) : null

  const timers = [
    setInterval(flush, 5000),
    setInterval(helloAll, HELLO_EVERY),
    setInterval(gc, 3600_000),
    setInterval(rotate, 60_000),   // an expired invite's key stops being presented
    setInterval(async () => {
      if (leaseBusy) return                 // a slow machine must not stack up passes
      leaseBusy = true
      try {
        await Promise.all([
          leases.sweep().catch(e => log('lease sweep:', errMsg(e))),
          leases.renewActive((auth, body) => askAuthority(auth, body)).catch(e => log('lease renewal:', errMsg(e))),
          leases.flushNotices().catch(e => log('lease notices:', errMsg(e))),
        ])
      } finally { leaseBusy = false }
    }, Number(process.env.NATTERMATIC_LEASE_SWEEP_MS) || 15_000),
  ]
  helloAll()
  kick()
  gc()

  let closing = false
  function shutdown() {
    if (closing) return
    closing = true
    log('shutting down')
    timers.forEach(clearInterval)
    hub.closeAll()
    discovery?.stop()
    server.close()
    server.closeAllConnections?.()
    setTimeout(() => { try { db.close() } catch {}; process.exit(0) }, 300)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  return { server, shutdown }
}

/**
 * What another machine says its sessions are called, keeping only names as a node makes them: these
 * go straight to a session, so nothing else may ride along.
 * @param {unknown} list
 */
export const sessionNames = list => Array.isArray(list) ? list.filter(s => typeof s === 'string' && sanitizeName(s) === s).slice(0, 200) : []

/** @type {Promise<string> | null} */
let packingApp = null
/** Zip the app this node runs from, for a Mac joining through us. @param {string} dir @param {string} bundle */
function packApp(dir, bundle) {
  return packingApp ||= (async () => {
    const out = path.join(dir, 'dist', 'app')
    fs.mkdirSync(out, { recursive: true })
    const zip = path.join(out, 'nattermatic-app.zip')
    fs.rmSync(zip, { force: true })
    await execFileP('ditto', ['-c', '-k', '--keepParent', bundle, zip])
    return zip
  })().finally(() => setTimeout(() => { packingApp = null }, 60_000))
}

/** @type {Promise<string> | null} */
let packing = null
/** npm-pack this installation so another machine can install it from us. @param {string} dir @returns {Promise<string>} path of the tarball */
function packTarball(dir) {
  return packing ||= (async () => {
    const out = path.join(dir, 'dist', 'pkg')       // its own folder: the app's zip may be in use
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    if (SEA) {   // the app carries the npm package it was built from
      const file = path.join(out, 'nattermatic.tgz')
      fs.writeFileSync(file, readAsset('nattermatic.tgz'))
      return file
    }
    // the npm that came with this node, if any: a private runtime is on no one's PATH
    const bin = path.dirname(process.execPath)
    const npm = fs.existsSync(path.join(bin, 'npm')) ? path.join(bin, 'npm') : 'npm'
    const { stdout } = await execFileP(npm, ['pack', '--silent', '--pack-destination', out], { cwd: PKG_ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    return path.join(out, stdout.trim().split('\n').pop() || '')
  })().finally(() => setTimeout(() => { packing = null }, 60_000))
}

/**
 * install.sh preset to join this network through us: where to fetch the package, the key to pin
 * (the invite key), the invite token, and the network (so a member re-joining keeps its key).
 * @param {string | undefined} hostHeader @param {Pick<Config, 'host' | 'port' | 'net'>} cfg @param {string} token @param {string} pin
 */
export function installScript(hostHeader, cfg, token, pin) {
  const sh = shQuote
  // the name the joining machine used to reach us is, by definition, one that works for it
  const hh = String(hostHeader || '')
  const used = validAddr(hh) ? hh : validAddr(`${hh}:${cfg.port}`) ? `${hh}:${cfg.port}` : `${cfg.host}:${cfg.port}`
  // our own name too, unless that's the same machine name: its address would replace the one that worked
  const peer = parsePeer(used)?.host === cfg.host ? '' : ` --peer ${sh(`${cfg.host}:${cfg.port}`)}`
  const preset = [
    `NATTERMATIC_PKG=${sh(`https://${used}/join/pkg.tgz?t=${token}`)}`,
    // a Mac joining a machine that runs the app gets the same app (Apple silicon only)
    ...(appBundle() ? [`NATTERMATIC_APP_URL=${sh(`https://${used}/join/app.zip?t=${token}`)}`] : []),
    `NATTERMATIC_PIN=${sh(pin)}`,
    // the token is passed in the environment: setup's command line is visible to other users (ps)
    `NATTERMATIC_TOKEN=${sh(token)}; export NATTERMATIC_TOKEN`,
    // what the user added (`| sh -s -- --host <name>`) comes after: it's theirs, and it stays
    `set -- --join ${sh(used)} --pin ${sh(pin)} --net ${sh(cfg.net)}${peer} "$@"`,
  ].join('\n')
  return readAsset('install.sh').toString('utf8').replace('#@@PRESET@@', () => preset)   // no $-patterns
}

const isLoopback = (/** @type {string | undefined} */ a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'

/** @param {http.IncomingMessage} req @returns {Promise<string>} */
function readBody(req, max = MAX_REQ) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (/** @type {Buffer} */ c) => {
      size += c.length
      if (size > max) { reject(httpErr(413, 'request too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
