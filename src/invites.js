// Invites, and the certificate the node presents, which they decide.
//
// While an invite is open, the node presents the invite key: the one its curl line pins, shared by
// all open invites, kept across restarts, and deleted once none are open. Otherwise it presents a
// fresh key for each connection, or at most each second (key generation costs about a millisecond),
// so connecting to the port shows nothing that identifies the machine.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { sha256, randomToken } from './crypto.js'
import { fingerprint, newIdentity, selfSignedCert } from './cert.js'
import { errMsg } from './config.js'

export const INVITE_TTL_MS = 24 * 3600_000

/** @typedef {{ key: string, cert: string, fp: string }} Identity */

/**
 * @param {{
 *   present: (id: { key: string, cert: string }) => void,
 *   q: ReturnType<typeof import('./store.js').queries>,
 *   dir: string,
 *   now: () => number,
 *   log: (...a: unknown[]) => void,
 * }} o present: make the server show this key to new connections
 */
export function createInvites({ present, q, dir, now, log }) {
  const keyPath = path.join(dir, 'invite.key')
  /** @type {Identity | null} */
  let invite = null
  let presenting = '', rotatedAt = 0
  /** @type {NodeJS.Timeout | null} */
  let timer = null

  /** The invite key if any invite is open (deleted once none is). */
  function inviteIdentity() {
    if (!q.openInvite.get(now())) {
      if (invite || fs.existsSync(keyPath)) { fs.rmSync(keyPath, { force: true }); invite = null }
      return null
    }
    if (!invite) {
      try {
        const key = fs.readFileSync(keyPath, 'utf8'), k = crypto.createPrivateKey(key)
        invite = { key, cert: selfSignedCert(k), fp: fingerprint(k) }
      } catch {}
    }
    return invite
  }

  /** Called as each connection arrives, and whenever the invites change. */
  function rotate() {
    let inv = null
    try { inv = inviteIdentity() } catch (e) { log('invite key:', errMsg(e)) }
    if (inv) {
      if (presenting !== inv.fp) { present(inv); presenting = inv.fp }
      return
    }
    // the current key has just been shown: replace it now, or once a second has passed since the last
    // replacement, so no two connections a second or more apart ever see the same key
    const wait = presenting === 'throwaway' ? 1000 - (now() - rotatedAt) : 0
    if (wait > 0) {
      timer ||= setTimeout(() => { timer = null; rotate() }, wait)
      timer.unref()
      return
    }
    present(newIdentity())
    presenting = 'throwaway'
    rotatedAt = now()
  }

  /** A new invite token; makes the invite key if none is open. */
  function create() {
    if (!inviteIdentity()) {
      const id = newIdentity()
      fs.writeFileSync(keyPath, id.key, { mode: 0o600 })
      invite = id
    }
    const inv = /** @type {Identity} */ (invite)
    const token = randomToken()
    q.addInvite.run(sha256(token), now(), now() + INVITE_TTL_MS)
    rotate()
    return { token, fp: inv.fp, expires_at: now() + INVITE_TTL_MS }
  }

  /** Can this token still be used? @param {string} token */
  function valid(token) {
    const row = /** @type {{ expires_at: number, used_at: number | null } | undefined} */ (q.invite.get(sha256(token)))
    return !!row && !row.used_at && row.expires_at > now()
  }

  /** The token has added its machine. @param {string} token */
  function use(token) {
    q.useInvite.run(now(), sha256(token))
    setImmediate(rotate)          // after the reply: the last open invite's key goes once it's used
  }

  /** Revoke every open invite; returns how many. */
  function revokeAll() {
    const n = Number(q.revokeInvites.run().changes)
    rotate()
    return n
  }

  return { rotate, create, valid, use, revokeAll, fp: () => invite?.fp || '' }
}
