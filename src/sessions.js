// The node's local sessions: each connected agent's event stream, the messages offered to it and not
// yet acknowledged, and the wait behind `natter wake` that wakes an idle session when one arrives.
// Messages themselves are in the store; this only decides what each session is shown, and when.
import { NODE_NAMES } from './config.js'

const PUMP_WINDOW = 256                // messages a session may hold unacknowledged: the rest wait here
const PUMP_BUFFER = 1 << 20            // bytes waiting for a session to read before we stop writing
const PING_MS = 20_000

/** @typedef {import('node:http').ServerResponse} Res */
/**
 * @typedef {{
 *   res: Res, sent: Set<string>, token: string, live: boolean, owner: number, cwd: string,
 *   notified: Set<string>, waiter: Res | null, more: boolean, draining: boolean, lastActive: number,
 * }} Session
 * live: woken by channel pushes; sent: offered, not yet acknowledged; notified: told about already,
 * so a session that doesn't read a message isn't woken for it again and again
 */

/** @param {Res} res @param {string} event @param {unknown} data */
export function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }

/** Start an event stream: its headers, a ping to keep it open, and `onClose` when it ends. @param {Res} res @param {() => void} onClose */
function openStream(res, onClose) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
  res.on('close', () => { clearInterval(ping); onClose() })
}

/**
 * @param {{
 *   q: ReturnType<typeof import('./store.js').queries>,
 *   msgRow: (id: string) => import('./types.js').MessageRow | undefined,
 *   tx: (fn: () => void) => void,
 *   now: () => number,
 *   safe: (fn: () => void) => void,
 *   host: () => string,
 * }} o
 */
export function createSessions({ q, msgRow, tx, now, safe, host }) {
  /** @type {Map<string, Session>} name -> session */
  const map = new Map()
  const ids = (/** @type {unknown} */ v) => Array.isArray(v) ? v.map(String) : []

  /**
   * Offer `name`'s queued messages to its live session, if it has one. A few at a time: the session's
   * acknowledgements bring the next ones, so a big queue is never in memory here or in the session.
   * @param {string} name
   */
  function pump(name) {
    const s = map.get(name)
    if (!s) return
    let more = false
    for (const { id } of q.inboxQueued.all(name, now(), 2 * PUMP_WINDOW)) {     // ids first: most may have been offered already
      if (s.sent.has(String(id))) continue
      if (s.sent.size >= PUMP_WINDOW || s.res.writableLength > PUMP_BUFFER) { more = true; break }
      const r = msgRow(String(id))
      if (!r) continue
      s.sent.add(r.id)
      sse(s.res, 'message', { id: r.id, from: r.from_addr, to: r.to_addr, body: r.body, sent_at: r.sent_at })
    }
    if (s.res.writableLength > PUMP_BUFFER && !s.draining) {
      s.draining = true
      s.res.once('drain', () => { s.draining = false; safe(() => pump(name)) })
    }
    if (more !== s.more) { s.more = more; sse(s.res, 'queue', { more }) }
    nudge(name)
  }

  /** Wake `name`'s session if a wait is open and it has messages it hasn't been told about. @param {string} name */
  function nudge(name) {
    const s = map.get(name)
    if (!s?.waiter) return
    const fresh = [...s.sent].filter(id => !s.notified.has(id))
    if (!fresh.length) return
    for (const id of fresh) s.notified.add(id)
    sse(s.waiter, 'wake', { name, count: fresh.length })
    s.waiter.end()
    s.waiter = null
  }

  /**
   * A session's event stream opens. A reconnecting session (same token) replaces its own stale
   * stream and keeps its name; anyone else asking for a name in use gets a new one.
   * @param {Res} res
   * @param {{ want: string, token: string, live: boolean, owner: number, cwd: string }} p
   * @param {() => void} onClose
   * @returns {{ name: string, reconnected: boolean }}
   */
  function connect(res, { want, token, live, owner, cwd }, onClose) {
    let name = want
    const existing = map.get(want)
    const reconnecting = existing && token && existing.token === token ? existing : null
    if (reconnecting) { reconnecting.res.end(); reconnecting.waiter?.end(); map.delete(want) }
    // a name in use, or one the node sends as itself, gets a number; stays within the 48-char name limit
    for (let i = 2; map.has(name) || NODE_NAMES.has(name); i++) name = `${want.slice(0, 47 - String(i).length)}-${i}`
    /** @type {Session} */
    const s = {
      res, sent: new Set(), token, live, owner, cwd,
      notified: reconnecting?.notified ?? new Set(), waiter: null, more: false, draining: false,
      lastActive: reconnecting?.lastActive ?? 0,     // only the session's own actions count
    }
    map.set(name, s)
    openStream(res, () => { s.waiter?.end(); if (map.get(name) === s) map.delete(name); onClose() })
    sse(res, 'hello', { name, address: `${name}@${host()}`, host: host() })
    return { name, reconnected: !!reconnecting }
  }

  /**
   * The session these processes belong to: by process, nearest first (a Claude started from inside
   * another Claude's session belongs to the inner one). Codex starts every session's adapter from one
   * shared app-server, so a Codex hook also says which folder: the newest session there.
   * @param {number[]} pids @param {string | null} [cwd]
   */
  const ownedBy = (pids, cwd = null) => cwd
    ? [...map].reverse().find(([, x]) => pids.includes(x.owner) && x.cwd === cwd)
    : pids.map(pid => [...map].find(([, x]) => x.owner === pid)).find(Boolean)

  /**
   * The wait behind `natter wake`: answers once, when there's news. By process, nearest first: a
   * Claude started from inside another Claude's session belongs to the inner one. Codex starts every
   * session's adapter from one shared app-server, so its waiter also says which folder: the newest
   * session there, if there are several. False if no session is found.
   * @param {Res} res @param {number[]} pids @param {string | null} cwd
   */
  function wait(res, pids, cwd) {
    const found = ownedBy(pids, cwd)
    if (!found) return false
    const [name, s] = found
    s.lastActive = now()                  // the hook waits again at each turn: the session is active
    openStream(res, () => { if (s.waiter === res) s.waiter = null })
    if (s.live) { sse(res, 'done', {}); res.end(); return true }   // a channel session is woken by the push itself
    if (s.waiter) { sse(s.waiter, 'done', {}); s.waiter.end() }
    s.waiter = res
    nudge(name)
    return true
  }

  /**
   * The session has these now (state 'pushed': shown in a channel session, with no read receipt). A
   * message the session has is done with: nothing need remember it for the session's life.
   * @param {string} name @param {unknown} list @param {unknown} state
   */
  function ack(name, list, state) {
    const s = map.get(name)
    const mark = state === 'pushed' ? q.pushed : q.delivered
    tx(() => { for (const id of ids(list)) { mark.run(now(), id); s?.sent.delete(id); s?.notified.delete(id) } })
    if (s) pump(name)
  }

  /** A session has read these; or not (a cancelled read), and it should hear of them again. @param {string} name @param {unknown} list @param {boolean} told */
  function told(name, list, told) {
    const s = map.get(name)
    for (const id of ids(list)) { if (told) s?.notified.add(id); else s?.notified.delete(id) }
    if (s) nudge(name)
  }

  /** The session couldn't take these: offer them again shortly. @param {string} name @param {unknown} list */
  function nack(name, list) {
    const s = map.get(name)
    for (const id of ids(list)) s?.sent.delete(id)
    if (s) setTimeout(() => safe(() => pump(name)), 2000)
  }

  /** Will a message for `name` be shown to it now? @param {string} name */
  const awake = name => { const s = map.get(name); return !!(s?.live || s?.waiter) }

  /** How a message stored for `name` reaches it. @param {string} name @param {boolean} [live] it was just told (its wait, having woken it, is over) */
  function status(name, live) {
    const s = map.get(name)
    return live || s?.live || s?.waiter ? 'pushed to its live session' : s ? `waiting in ${name}'s inbox (the session is connected but reads with the inbox tool)` : `queued until ${name} connects`
  }

  function closeAll() { for (const s of map.values()) s.res.end() }

  return { map, pump, nudge, connect, wait, ownedBy, ack, told, nack, awake, status, closeAll }
}
