import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite store for the Mesh server.
 *  - sessions: mirror of the extension's sessions (last-write-wins by rev).
 *  - pages:    archived readable text of every saved URL (link-rot insurance).
 *  - pages_fts: FTS5 full-text index over archived pages (powers search + RAG).
 */
export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      rev         INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      deleted     INTEGER NOT NULL DEFAULT 0,
      payload     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

    CREATE TABLE IF NOT EXISTS pages (
      url_hash    TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      title       TEXT,
      site        TEXT,
      fetched_at  INTEGER,
      status      TEXT NOT NULL DEFAULT 'pending'  -- pending | ok | error
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      url_hash UNINDEXED, url UNINDEXED, title, site UNINDEXED, body,
      tokenize = 'porter unicode61'
    );
  `);

  return db;
}

export function hashUrl(url) {
  return createHash('sha1').update(url).digest('hex');
}

export function makeQueries(db) {
  return {
    // ---- sync ----
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, rev, updated_at, deleted, payload)
      VALUES (@id, @rev, @updated_at, @deleted, @payload)
      ON CONFLICT(id) DO UPDATE SET
        rev = excluded.rev, updated_at = excluded.updated_at,
        deleted = excluded.deleted, payload = excluded.payload
      WHERE excluded.rev > sessions.rev
         OR (excluded.rev = sessions.rev AND excluded.updated_at > sessions.updated_at)
    `),
    getSession: db.prepare(`SELECT rev, updated_at FROM sessions WHERE id = ?`),
    changedSince: db.prepare(`
      SELECT id, rev, updated_at, deleted, payload FROM sessions WHERE updated_at > ?
    `),

    // ---- archive ----
    pageExists: db.prepare(`SELECT status FROM pages WHERE url_hash = ?`),
    insertPagePending: db.prepare(`
      INSERT OR IGNORE INTO pages (url_hash, url, status) VALUES (?, ?, 'pending')
    `),
    markPageOk: db.prepare(`
      UPDATE pages SET title=?, site=?, fetched_at=?, status='ok' WHERE url_hash=?
    `),
    markPageError: db.prepare(`UPDATE pages SET status='error', fetched_at=? WHERE url_hash=?`),
    pendingPages: db.prepare(`SELECT url_hash, url FROM pages WHERE status='pending' LIMIT ?`),

    ftsDelete: db.prepare(`DELETE FROM pages_fts WHERE url_hash = ?`),
    ftsInsert: db.prepare(`
      INSERT INTO pages_fts (url_hash, url, title, site, body) VALUES (?, ?, ?, ?, ?)
    `),
    // ranked full-text search; bm25() lower = better
    ftsSearch: db.prepare(`
      SELECT url_hash, url, title, site,
             snippet(pages_fts, 4, '«', '»', '…', 12) AS snippet,
             bm25(pages_fts) AS score
      FROM pages_fts WHERE pages_fts MATCH ? ORDER BY score LIMIT ?
    `),
    ftsRetrieve: db.prepare(`
      SELECT url, title, body, bm25(pages_fts) AS score
      FROM pages_fts WHERE pages_fts MATCH ? ORDER BY score LIMIT ?
    `),
    getBody: db.prepare(`SELECT url, title, body FROM pages_fts WHERE url_hash = ?`),

    // ---- web companion ----
    listSessions: db.prepare(`
      SELECT payload FROM sessions WHERE deleted=0 ORDER BY updated_at DESC LIMIT ?
    `),

    stats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions WHERE deleted=0) AS sessions,
        (SELECT COUNT(*) FROM pages WHERE status='ok')  AS archived,
        (SELECT COUNT(*) FROM pages WHERE status='pending') AS queued
    `),
  };
}
