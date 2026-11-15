import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/*
 * messages.role:
 *   outbox - we are the sender's node; must hand to the recipient's node
 *   held   - we are holding a copy for an offline machine; must hand to the recipient's node
 *   inbox  - recipient is on this machine; must push to the local session
 * messages.state:
 *   pending (outbox/held: still to hand over) -> forwarded
 *   queued  (inbox: waiting for session)      -> pushed (shown in a channel session; no read receipt)
 *                                             -> delivered (read with the inbox tool)
 *   expired | failed
 */
/** @param {string} file */
export function openStore(file) {
  const db = new DatabaseSync(file)
  // it holds messages and lease notes as they are: this user's only, even if its folder were shared
  for (const f of [file, `${file}-wal`, `${file}-shm`]) try { fs.chmodSync(f, 0o600) } catch {}
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS messages(
      id TEXT PRIMARY KEY,
      from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, to_host TEXT NOT NULL, to_name TEXT NOT NULL,
      body TEXT NOT NULL, sent_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, sig TEXT NOT NULL,
      role TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      replicated INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_due ON messages(state, next_attempt);
    CREATE INDEX IF NOT EXISTS ix_inbox ON messages(role, to_name, state);
    CREATE INDEX IF NOT EXISTS ix_expiry ON messages(state, expires_at);
    CREATE INDEX IF NOT EXISTS ix_waiting ON messages(to_host, to_name) WHERE state IN ('pending','queued');
    CREATE TABLE IF NOT EXISTS peers(
      host TEXT PRIMARY KEY, addr TEXT, last_seen INTEGER NOT NULL, configured INTEGER NOT NULL DEFAULT 0,
      alias_of TEXT);
    CREATE TABLE IF NOT EXISTS invites(
      hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
  `)
  try { db.exec(`ALTER TABLE peers ADD COLUMN alias_of TEXT`) } catch {}  // older databases
  try { db.exec(`ALTER TABLE peers ADD COLUMN version TEXT`) } catch {}   // from 0.3.0: the version each machine says it runs
  return db
}

/**
 * Every statement the node runs against its store, prepared once. The message states and the moves
 * between them are all here: a message is changed only through these.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function queries(db) {
  return {
    insert: db.prepare(`INSERT OR IGNORE INTO messages
      (id,from_addr,to_addr,to_host,to_name,body,sent_at,expires_at,sig,role,state,next_attempt,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    get: db.prepare(`SELECT * FROM messages WHERE id=?`),
    // the names with something due, those tried least first, so a backlog for a machine that's off
    // can't keep the others waiting; what's due for one name, the oldest first; and the names nothing
    // has identified, the same way, so a crowd of made-up names can't keep a real one waiting
    due: db.prepare(`SELECT to_host FROM messages WHERE state='pending' AND next_attempt<=? AND expires_at>? AND to_host IN (SELECT value FROM json_each(?)) GROUP BY to_host ORDER BY MIN(attempts)`),
    dueFor: db.prepare(`SELECT id,to_host,role,attempts,replicated FROM messages WHERE state='pending' AND next_attempt<=? AND expires_at>? AND to_host=? ORDER BY sent_at LIMIT 2000`),
    dueNames: db.prepare(`SELECT to_host FROM messages WHERE state='pending' AND next_attempt<=? AND expires_at>? AND to_host NOT IN (SELECT value FROM json_each(?)) GROUP BY to_host ORDER BY MIN(attempts) LIMIT ?`),
    // handed over: the text has no more use here, and shouldn't sit on a holder until the message expires
    forwarded: db.prepare(`UPDATE messages SET state='forwarded', body='', updated_at=? WHERE id=? AND state='pending'`),
    failed: db.prepare(`UPDATE messages SET state='failed', last_error=?, updated_at=? WHERE id=?`),
    retry: db.prepare(`UPDATE messages SET attempts=attempts+1, next_attempt=?, last_error=?, updated_at=? WHERE id=? AND state='pending'`),
    replicated: db.prepare(`UPDATE messages SET replicated=1 WHERE id=?`),
    wake: db.prepare(`UPDATE messages SET next_attempt=0 WHERE state='pending' AND to_host=?`),
    toInbox: db.prepare(`UPDATE messages SET role='inbox', state='queued', to_host=?, updated_at=? WHERE to_host=? AND state='pending' RETURNING to_name`),
    inboxQueued: db.prepare(`SELECT id FROM messages WHERE role='inbox' AND to_name=? AND state='queued' AND expires_at>? ORDER BY sent_at LIMIT ?`),
    // the machine's own copy of something it was holding as a copy for a name it didn't know was its own
    claim: db.prepare(`UPDATE messages SET role='inbox', state='queued', to_host=?, to_name=?, updated_at=? WHERE id=? AND role='held' AND state='pending'`),
    delivered: db.prepare(`UPDATE messages SET state='delivered', updated_at=? WHERE id=? AND role='inbox'`),
    // pushed into a channel session: Claude Code gives no receipt, so this means "shown", not "read"
    pushed: db.prepare(`UPDATE messages SET state='pushed', updated_at=? WHERE id=? AND role='inbox' AND state='queued'`),
    // newest to arrive: sent_at is whatever the sender says
    history: db.prepare(`SELECT * FROM messages WHERE role='inbox' AND to_name=? ORDER BY rowid DESC LIMIT ?`),
    expire: db.prepare(`UPDATE messages SET state='expired', updated_at=? WHERE state IN ('pending','queued') AND expires_at<=?`),
    gc: db.prepare(`DELETE FROM messages WHERE expires_at < ?`),
    counts: db.prepare(`SELECT role, state, count(*) n FROM messages GROUP BY role, state`),
    waiting: db.prepare(`SELECT count(*) n FROM messages WHERE to_host=? AND to_name=? AND state IN ('pending','queued')`),
    // pages in use: what's been freed is used again before the file grows
    stored: db.prepare(`SELECT (p.page_count - f.freelist_count) * s.page_size n FROM pragma_page_count p, pragma_freelist_count f, pragma_page_size s`),
    upsertPeer: db.prepare(`INSERT INTO peers(host,addr,last_seen,configured) VALUES(?,?,?,?)
      ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen,
        addr=COALESCE(excluded.addr, peers.addr), configured=MAX(peers.configured, excluded.configured)`),
    peer: db.prepare(`SELECT * FROM peers WHERE host=?`),
    peers: db.prepare(`SELECT * FROM peers ORDER BY host`),
    setAlias: db.prepare(`UPDATE peers SET alias_of=? WHERE host=?`),
    setVersion: db.prepare(`INSERT INTO peers(host,last_seen,configured,version) VALUES(?,?,0,?)
      ON CONFLICT(host) DO UPDATE SET version=excluded.version`),
    deletePeer: db.prepare(`DELETE FROM peers WHERE host=?`),
    clearAddr: db.prepare(`UPDATE peers SET addr=NULL WHERE host=?`),
    forgetPeers: db.prepare(`DELETE FROM peers WHERE configured=0 AND last_seen < ?`),
    addInvite: db.prepare(`INSERT INTO invites(hash, created_at, expires_at) VALUES(?,?,?)`),
    invite: db.prepare(`SELECT * FROM invites WHERE hash=?`),
    useInvite: db.prepare(`UPDATE invites SET used_at=? WHERE hash=? AND used_at IS NULL`),
    revokeInvites: db.prepare(`DELETE FROM invites WHERE used_at IS NULL`),
    gcInvites: db.prepare(`DELETE FROM invites WHERE expires_at < ?`),
    openInvite: db.prepare(`SELECT 1 FROM invites WHERE used_at IS NULL AND expires_at > ? LIMIT 1`),
    openInvites: db.prepare(`SELECT created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at`),
  }
}
