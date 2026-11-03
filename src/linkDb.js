import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

let dbInstance = null;

function isTestMode() {
  return (
    process.env.NODE_ENV === 'test' ||
    process.execArgv.includes('--test') ||
    Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

/**
 * Initializes the SQLite database connection and sets up tables and indexes.
 *
 * @param {string} [customPath]
 * @returns {DatabaseSync}
 */
export function initLinkDb(customPath) {
  if (dbInstance) return dbInstance;

  const dbPath =
    customPath ||
    (isTestMode() ? ':memory:' : (config.linkDbPath || path.join(process.cwd(), 'data', 'links.db')));

  if (dbPath !== ':memory:') {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  dbInstance = new DatabaseSync(dbPath);
  dbInstance._isMemory = dbPath === ':memory:';
  dbInstance._dbPath = dbPath;

  // Enable WAL for non-blocking concurrent reads during crawls on disk-backed DBs.
  if (!dbInstance._isMemory) {
    dbInstance.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout  = 5000;
      PRAGMA synchronous   = NORMAL;
      PRAGMA temp_store    = MEMORY;
      PRAGMA cache_size    = -64000;
    `);
  }

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
      posted_at INTEGER NOT NULL,
      content TEXT,
      is_backup INTEGER NOT NULL DEFAULT 1,
      UNIQUE(message_id, normalized_url)
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
      file_name TEXT,
      relative_path TEXT,
      file_size INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_media_id ON media_records (media_id);
    CREATE INDEX IF NOT EXISTS idx_media_sha256 ON media_records (sha256);
    CREATE INDEX IF NOT EXISTS idx_media_url ON media_records (original_url);
    CREATE INDEX IF NOT EXISTS idx_media_duration ON media_records (duration);
  `);

  // Safe schema migrations for existing production databases
  try {
    const linkCols = dbInstance.prepare('PRAGMA table_info(posted_links)').all();
    if (!linkCols.some((col) => col.name === 'content')) {
      dbInstance.exec('ALTER TABLE posted_links ADD COLUMN content TEXT;');
    }
    if (!linkCols.some((col) => col.name === 'is_backup')) {
      dbInstance.exec('ALTER TABLE posted_links ADD COLUMN is_backup INTEGER NOT NULL DEFAULT 1;');
    }
    // Deduplicate any pre-existing duplicate (message_id, normalized_url) rows before adding unique index
    const hasUniqueIdx = dbInstance
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_posted_links_msg_url'")
      .get();
    if (!hasUniqueIdx) {
      dbInstance.exec(`
        DELETE FROM posted_links
        WHERE id NOT IN (
          SELECT MIN(id) FROM posted_links GROUP BY message_id, normalized_url
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_posted_links_msg_url ON posted_links (message_id, normalized_url);
      `);
    }
  } catch {}

  try {
    const mediaCols = dbInstance.prepare('PRAGMA table_info(media_records)').all();
    if (!mediaCols.some((col) => col.name === 'relative_path')) {
      dbInstance.exec('ALTER TABLE media_records ADD COLUMN relative_path TEXT;');
    }
    if (!mediaCols.some((col) => col.name === 'file_size')) {
      dbInstance.exec('ALTER TABLE media_records ADD COLUMN file_size INTEGER;');
    }
    dbInstance.exec(
      'CREATE INDEX IF NOT EXISTS idx_media_image_hashes ON media_records(id) WHERE (duration = 0 OR duration IS NULL) AND hash IS NOT NULL;'
    );
  } catch {}

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
      'INSERT OR IGNORE INTO posted_links (normalized_url, original_url, guild_id, channel_id, channel_name, message_id, author_id, author_tag, posted_at, content, is_backup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    findByMsgUrl: dbInstance.prepare(
      'SELECT id, is_backup FROM posted_links WHERE message_id = ? AND normalized_url = ? LIMIT 1'
    ),
    promoteBackup: dbInstance.prepare(
      'UPDATE posted_links SET is_backup = 1 WHERE id = ?'
    ),
    updateLink: dbInstance.prepare(
      'UPDATE posted_links SET message_id = ?, channel_id = ?, channel_name = ?, posted_at = ?, content = ? WHERE id = ?'
    ),
    deleteByMessageId: dbInstance.prepare(
      'DELETE FROM posted_links WHERE message_id = ?'
    ),
    pruneLinks: dbInstance.prepare('DELETE FROM posted_links WHERE posted_at < ?'),
  };

  return dbInstance;
}

/**
 * Ensures the database is initialized before querying.
 * Automatically opens `:memory:` when running inside the test suite so tests
 * never mutate `./data/links.db`.
 */
export function getDb() {
  if (!dbInstance) {
    return initLinkDb(isTestMode() ? ':memory:' : undefined);
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
 * Saves a new link record to the database (idempotent on message_id + normalized_url).
 *
 * @param {object} record
 * @returns {number} Inserted or existing row ID
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
  content = null,
  isBackup = true,
  is_backup = undefined,
}) {
  const db = getDb();
  const backupFlag = isBackup === false || is_backup === 0 || is_backup === false ? 0 : 1;
  const result = db._stmts.insertLink.run(
    normalizedUrl,
    originalUrl,
    guildId,
    channelId,
    channelName,
    messageId,
    authorId,
    authorTag,
    postedAt,
    content || null,
    backupFlag
  );

  if (result.changes === 0) {
    const existing = db._stmts.findByMsgUrl.get(messageId, normalizedUrl);
    if (existing) {
      if (backupFlag === 1 && existing.is_backup === 0) {
        db._stmts.promoteBackup.run(existing.id);
      }
      return Number(existing.id);
    }
    return 0;
  }

  return Number(result.lastInsertRowid);
}

/**
 * Updates an existing link record (used when same author reposts within grace window).
 *
 * @param {number} id
 * @param {object} updates
 */
export function updateLinkRecord(id, { messageId, channelId, channelName, postedAt = Date.now(), content = null }) {
  const db = getDb();
  db._stmts.updateLink.run(messageId, channelId, channelName, postedAt, content || null, id);
}

/**
 * Deletes all saved link records associated with a deleted Discord message ID.
 *
 * @param {string} messageId
 * @returns {number} Number of deleted rows
 */
export function deleteLinksByMessageId(messageId) {
  if (!messageId) return 0;
  const db = getDb();
  const info = db._stmts.deleteByMessageId.run(String(messageId));
  return info.changes || 0;
}

/**
 * Returns a list of distinct channel names that have saved links, with summary counts.
 * Filters to backup-eligible links (`is_backup = 1`) by default so non-backup
 * duplicate-tracking rows never pollute exports or `/restore` lists.
 *
 * @param {{ backupOnly?: boolean }} [options]
 * @returns {Array<{ channel_name: string, count: number, earliest: number, latest: number }>}
 */
export function getDistinctLinkChannels({ backupOnly = true } = {}) {
  const db = getDb();
  const backupClause = backupOnly ? 'AND is_backup = 1' : '';
  return db.prepare(`
    SELECT 
      channel_name, 
      COUNT(*) as count, 
      MIN(posted_at) as earliest, 
      MAX(posted_at) as latest 
    FROM posted_links 
    WHERE channel_name IS NOT NULL AND channel_name != '' ${backupClause}
    GROUP BY channel_name 
    ORDER BY count DESC
  `).all();
}

/**
 * Retrieves all saved link records for a specific channel name, sorted chronologically.
 *
 * @param {string} channelName
 * @param {{ backupOnly?: boolean }} [options]
 * @returns {Array<object>}
 */
export function getLinksByChannel(channelName, { backupOnly = true } = {}) {
  const db = getDb();
  const backupClause = backupOnly ? 'AND is_backup = 1' : '';
  return db.prepare(`
    SELECT * FROM posted_links 
    WHERE LOWER(channel_name) = LOWER(?) ${backupClause}
    ORDER BY posted_at ASC
  `).all(channelName);
}

/**
 * Retrieves all saved link records organized into a dictionary grouped by channel name.
 *
 * @param {{ backupOnly?: boolean }} [options]
 * @returns {Record<string, Array<object>>}
 */
export function getAllLinksGrouped({ backupOnly = true } = {}) {
  const db = getDb();
  const whereClause = backupOnly ? 'WHERE is_backup = 1' : '';
  const rows = db.prepare(`
    SELECT * FROM posted_links 
    ${whereClause}
    ORDER BY posted_at ASC
  `).all();

  const grouped = {};
  for (const row of rows) {
    const ch = row.channel_name || 'general';
    if (!grouped[ch]) grouped[ch] = [];
    grouped[ch].push(row);
  }
  return grouped;
}

/**
 * Returns total count of saved links, optionally filtered by channel name.
 *
 * @param {string|null} [channelName]
 * @param {{ backupOnly?: boolean }} [options]
 * @returns {number}
 */
export function getTotalLinkCount(channelName = null, { backupOnly = false } = {}) {
  const db = getDb();
  if (channelName) {
    const backupClause = backupOnly ? 'AND is_backup = 1' : '';
    return (
      db
        .prepare(`SELECT COUNT(*) as count FROM posted_links WHERE LOWER(channel_name) = LOWER(?) ${backupClause}`)
        .get(channelName)?.count || 0
    );
  }
  const whereClause = backupOnly ? 'WHERE is_backup = 1' : '';
  return db.prepare(`SELECT COUNT(*) as count FROM posted_links ${whereClause}`).get()?.count || 0;
}

/**
 * Batch inserts link records inside a single SQLite transaction.
 *
 * @param {Array<object>} records
 * @returns {number} Count of inserted records
 */
export function saveLinkRecordBatch(records) {
  if (!records || records.length === 0) return 0;
  const db = getDb();
  const insert = db._stmts.insertLink;
  db.exec('BEGIN IMMEDIATE;');
  let count = 0;
  try {
    for (const r of records) {
      const normalizedUrl = r.normalized_url || r.normalizedUrl;
      const originalUrl = r.original_url || r.originalUrl;
      if (!normalizedUrl || !originalUrl) continue;
      const messageId = r.message_id || r.messageId || '0';
      const backupFlag =
        r.isBackup === false || r.is_backup === 0 || r.is_backup === false ? 0 : 1;

      const res = insert.run(
        normalizedUrl,
        originalUrl,
        r.guild_id || r.guildId || null,
        r.channel_id || r.channelId || '0',
        r.channel_name || r.channelName || 'chat',
        messageId,
        r.author_id || r.authorId || '0',
        r.author_tag || r.authorTag || 'Unknown',
        r.posted_at || r.postedAt || Date.now(),
        r.content || null,
        backupFlag
      );
      if (res.changes > 0) {
        count++;
      } else if (backupFlag === 1) {
        const existing = db._stmts.findByMsgUrl.get(messageId, normalizedUrl);
        if (existing && existing.is_backup === 0) {
          db._stmts.promoteBackup.run(existing.id);
        }
      }
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return count;
}

/**
 * Checkpoints the SQLite WAL file to keep file size controlled.
 * @param {'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE'} [mode='PASSIVE']
 */
export function checkpointWal(mode = 'PASSIVE') {
  try {
    if (!dbInstance || dbInstance._isMemory) return;
    dbInstance.exec(`PRAGMA wal_checkpoint(${mode});`);
  } catch (err) {
    console.error(`[DB] Failed to checkpoint WAL (${mode}):`, err.message);
  }
}

/**
 * Creates an atomic, WAL-consistent backup of a SQLite database using `VACUUM INTO`,
 * falling back to a passive WAL checkpoint + file copy if needed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} backupPath
 */
export function backupDatabaseSafely(db, backupPath) {
  if (!db) {
    throw new Error('Database instance is required for backup');
  }

  const normalizedBackupPath = path.resolve(backupPath);
  if (fs.existsSync(normalizedBackupPath)) {
    fs.rmSync(normalizedBackupPath, { force: true });
  }

  const escapedPath = normalizedBackupPath.split(path.sep).join('/').replace(/'/g, "''");
  try {
    db.exec(`VACUUM INTO '${escapedPath}';`);
  } catch (err) {
    try {
      db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch {}
    const sourcePath = db._dbPath || config.linkDbPath || path.join(process.cwd(), 'data', 'links.db');
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, normalizedBackupPath);
    } else {
      throw err;
    }
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
    if (!dbInstance._isMemory) {
      checkpointWal('TRUNCATE');
    }
    dbInstance.close();
    dbInstance = null;
  }
}
