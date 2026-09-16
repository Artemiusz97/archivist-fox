import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

let dbInstance = null;

/**
 * Initializes the SQLite database connection and sets up tables and indexes.
 *
 * @param {string} [customPath]
 * @returns {DatabaseSync}
 */
export function initLinkDb(customPath) {
  if (dbInstance) return dbInstance;

  const dbPath = customPath || config.linkDbPath || path.join(process.cwd(), 'data', 'links.db');
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new DatabaseSync(dbPath);

  // Enable WAL for non-blocking concurrent reads during crawls.
  // synchronous=NORMAL is crash-safe in WAL mode (SQLite docs §8.1) and avoids
  // the blocking fsync() that FULL mode forces on every commit — delivering a
  // 10x–50x write speedup during bulk channel scans.
  // temp_store=MEMORY keeps temp tables off disk. cache_size=-64000 sets a 64 MB
  // shared page cache to reduce repeat disk I/O for hot duplicate-check queries.
  dbInstance.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous   = NORMAL;
    PRAGMA temp_store    = MEMORY;
    PRAGMA cache_size    = -64000;
  `);

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS posted_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_url TEXT NOT NULL,
      original_url TEXT NOT NULL,
      guild_id TEXT,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      message_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_tag TEXT NOT NULL,
      posted_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_links_url_channel ON posted_links (normalized_url, channel_id);
    CREATE INDEX IF NOT EXISTS idx_links_url_guild ON posted_links (normalized_url, guild_id);
    CREATE INDEX IF NOT EXISTS idx_links_posted_at ON posted_links (posted_at);

    CREATE TABLE IF NOT EXISTS media_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT,
      sha256 TEXT,
      duration REAL,
      hash TEXT,
      original_url TEXT,
      title TEXT,
      posted_by TEXT,
      channel TEXT,
      archived_at TEXT,
      file_name TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_media_id ON media_records (media_id);
    CREATE INDEX IF NOT EXISTS idx_media_sha256 ON media_records (sha256);
    CREATE INDEX IF NOT EXISTS idx_media_url ON media_records (original_url);
    CREATE INDEX IF NOT EXISTS idx_media_duration ON media_records (duration);
  `);

  // Cache hot prepared statements on the instance so SQLite doesn't re-parse
  // and compile the same SQL strings on every chat message and crawl iteration.
  dbInstance._stmts = {
    findByUrlChannel: dbInstance.prepare(
      'SELECT * FROM posted_links WHERE normalized_url = ? AND channel_id = ? AND posted_at >= ? ORDER BY posted_at ASC LIMIT 1'
    ),
    findByUrlGuild: dbInstance.prepare(
      'SELECT * FROM posted_links WHERE normalized_url = ? AND guild_id = ? AND posted_at >= ? ORDER BY posted_at ASC LIMIT 1'
    ),
    insertLink: dbInstance.prepare(
      'INSERT INTO posted_links (normalized_url, original_url, guild_id, channel_id, channel_name, message_id, author_id, author_tag, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    updateLink: dbInstance.prepare(
      'UPDATE posted_links SET message_id = ?, channel_id = ?, channel_name = ?, posted_at = ? WHERE id = ?'
    ),
    pruneLinks: dbInstance.prepare('DELETE FROM posted_links WHERE posted_at < ?'),
  };

  return dbInstance;
}

/**
 * Ensures the database is initialized before querying.
 */
export function getDb() {
  if (!dbInstance) {
    return initLinkDb();
  }
  return dbInstance;
}

/**
 * Searches for a previously posted occurrence of the given normalized URL.
 *
 * @param {string} normalizedUrl
 * @param {object} options
 * @param {string} [options.scope='channel'] - 'channel' or 'guild'
 * @param {string} [options.guildId]
 * @param {string} [options.channelId]
 * @param {string} [options.authorId]
 * @param {number} [options.retentionDays=0] - 0 means no expiration (search forever)
 * @param {number} [options.selfRepostGraceSeconds=300]
 * @returns {{ isDuplicate: boolean, isSelfGrace: boolean, record: object|null }}
 */
export function findDuplicateLink(normalizedUrl, options = {}) {
  if (!normalizedUrl) {
    return { isDuplicate: false, isSelfGrace: false, record: null };
  }

  const db = getDb();
  const scope = options.scope || config.duplicateLinkScope || 'channel';
  const retentionDays = options.retentionDays ?? config.duplicateLinkRetentionDays ?? 0;
  const selfRepostGraceSeconds = options.selfRepostGraceSeconds ?? config.selfRepostGraceSeconds ?? 300;
  const cutoffTime = retentionDays > 0 ? Date.now() - retentionDays * 86400 * 1000 : 0;

  let record = null;

  if (scope === 'guild' && options.guildId) {
    record = db._stmts.findByUrlGuild.get(normalizedUrl, options.guildId, cutoffTime) || null;
  } else if (options.channelId) {
    record = db._stmts.findByUrlChannel.get(normalizedUrl, options.channelId, cutoffTime) || null;
  }

  if (!record) {
    return { isDuplicate: false, isSelfGrace: false, record: null };
  }

  // Check self-repost grace period:
  // If the same user posted this recently within selfRepostGraceSeconds, treat as grace/edit
  if (options.authorId && record.author_id === options.authorId) {
    const timeDiffMs = Date.now() - record.posted_at;
    if (timeDiffMs < selfRepostGraceSeconds * 1000) {
      return { isDuplicate: false, isSelfGrace: true, record };
    }
  }

  return { isDuplicate: true, isSelfGrace: false, record };
}

/**
 * Saves a new link record to the database.
 *
 * @param {object} record
 * @returns {number} Inserted row ID
 */
export function saveLinkRecord({
  normalizedUrl,
  originalUrl,
  guildId = null,
  channelId,
  channelName = 'chat',
  messageId,
  authorId,
  authorTag,
  postedAt = Date.now(),
}) {
  const db = getDb();
  const result = db._stmts.insertLink.run(
    normalizedUrl,
    originalUrl,
    guildId,
    channelId,
    channelName,
    messageId,
    authorId,
    authorTag,
    postedAt
  );

  return result.lastInsertRowid;
}

/**
 * Updates an existing link record (used when same author reposts within grace window).
 *
 * @param {number} id
 * @param {object} updates
 */
export function updateLinkRecord(id, { messageId, channelId, channelName, postedAt = Date.now() }) {
  const db = getDb();
  db._stmts.updateLink.run(messageId, channelId, channelName, postedAt, id);
}

/**
 * Checkpoints the SQLite WAL file to keep file size controlled.
 * @param {'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE'} [mode='PASSIVE']
 */
export function checkpointWal(mode = 'PASSIVE') {
  try {
    const db = getDb();
    db.exec(`PRAGMA wal_checkpoint(${mode});`);
  } catch (err) {
    console.error(`[DB] Failed to checkpoint WAL (${mode}):`, err.message);
  }
}

/**
 * Prunes links older than retentionDays.
 *
 * @param {number} [retentionDays]
 * @returns {number} Number of deleted records
 */
export function pruneExpiredLinks(retentionDays) {
  const days = retentionDays ?? config.duplicateLinkRetentionDays ?? 0;
  if (days <= 0) return 0;

  const db = getDb();
  const cutoff = Date.now() - days * 86400 * 1000;
  const info = db._stmts.pruneLinks.run(cutoff);
  checkpointWal('PASSIVE');
  return info.changes;
}

/**
 * Closes the database instance (mainly for testing or graceful shutdown).
 */
export function closeLinkDb() {
  if (dbInstance) {
    checkpointWal('TRUNCATE');
    dbInstance.close();
    dbInstance = null;
  }
}
