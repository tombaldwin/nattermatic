// LAN discovery by encrypted UDP broadcast beacons. Deliberately does NOT use mDNS/Bonjour, so it
// can never interfere with the OS's own hostname announcements.
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import os from 'node:os'
import { sealBeacon, openBeacon } from './crypto.js'

const EVERY = 30_000
const MAX_SKEW = 5 * 60_000
const MAX_KEYS_TRIED = 64              // anyone can send a packet; a machine on an older key is found other ways

function broadcastAddrs() {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue
      const ip = i.address.split('.').map(Number), mask = i.netmask.split('.').map(Number)
      out.add(ip.map((o, k) => (o | (~mask[k] & 255)) >>> 0).join('.'))
    }
  }
  return [...out]
}

/**
 * onPeer({host, fp, addr}) is called for each beacon from another member. Beacons are encrypted
 * under the network's discovery key, so outsiders can neither read nor forge them; but a captured
 * beacon can be replayed and a member could lie, so callers treat addr as a hint and only route to
 * it once a TLS handshake there presents that member's key.
 * @param {import('./types.js').Config} cfg
 * @param {() => string[]} keys discovery keys to accept, current (used for sending) last
 * @param {(peer: { host: string, fp: string, addr: string }) => void} onPeer
 * @param {(...a: any[]) => void} log
 */
export function startDiscovery(cfg, keys, onPeer, log) {
  const port = cfg.discoveryPort || cfg.port
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  /** @param {boolean} reply */
  const beacon = reply => {
    const dk = keys().at(-1)
    return dk ? sealBeacon(dk, { host: cfg.host, fp: cfg.identity.fp, port: cfg.port, ts: Date.now(), reply }) : null
  }
  const announce = () => {
    const msg = beacon(false)
    if (msg) for (const a of broadcastAddrs()) sock.send(msg, port, a, () => {})
  }
  // Each beacon is taken once, from the first address it comes from. Anyone on the LAN can capture one
  // and send it again from other addresses: without this, every copy would set off a probe (a
  // connection) and a reply. Beacons older than MAX_SKEW are refused anyway, so that's all it keeps.
  /** @type {Map<string, number>} */
  const seen = new Map()
  sock.on('message', (buf, rinfo) => {
    const id = crypto.createHash('sha256').update(buf).digest('base64url')
    if (seen.has(id)) return
    const b = openBeacon(keys().slice(-MAX_KEYS_TRIED), buf)
    if (!b || typeof b.host !== 'string' || typeof b.fp !== 'string' || b.fp === cfg.identity.fp) return
    if (!Number.isFinite(b.ts) || Math.abs(Date.now() - b.ts) > MAX_SKEW) return
    seen.set(id, Date.now())
    if (seen.size > 512) for (const [k, t] of seen) if (Date.now() - t > 2 * MAX_SKEW || seen.size > 4096) seen.delete(k)
    if (!Number.isInteger(b.port) || b.port <= 0 || b.port >= 65536) return
    if (!b.reply) { const r = beacon(true); if (r) sock.send(r, port, rinfo.address, () => {}) }   // answer so discovery is instant both ways
    onPeer({ host: b.host, fp: b.fp, addr: `${rinfo.address}:${b.port}` })
  })
  sock.on('error', e => log('discovery socket error:', e.message))
  sock.bind(port, () => {
    sock.setBroadcast(true)
    announce()
  })
  const t = setInterval(announce, EVERY)
  return { announce, stop() { clearInterval(t); try { sock.close() } catch {} } }
}
