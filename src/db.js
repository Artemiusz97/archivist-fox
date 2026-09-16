import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { matchDuplicate, hammingDistance } from './phasher.js';
import { extractPlatformMediaId, normalizeUrl } from './urlExtractor.js';
import { getDb } from './linkDb.js';

let isMigrated = false;

function getLegacyDbPath() {
  const archiveDir = path.resolve(config.archiveDirectory);
  return path.join(archiveDir, 'index.json');
}

/**
 * Performs a one-time migration from index.json to SQLite
 */
function checkMigration() {
  if (isMigrated) return;
  const legacyPath = getLegacyDbPath();
  if (fs.existsSync(legacyPath)) {
    console.log('[DB] Found legacy index.json. Migrating to SQLite...');
    try {
      const content = fs.readFileSync(legacyPath, 'utf-8');
      const records = JSON.parse(content);
      if (Array.isArray(records)) {
        const db = getDb();
        const stmt = db.prepare(`
          INSERT INTO media_records (media_id, sha256, duration, hash, original_url, title, posted_by, channel, archived_at, file_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of records) {
          // Do not migrate invalid/flat hashes
          if (typeof r.hash === 'string' && (r.hash === '0000000000000000' || r.hash === 'ffffffffffffffff')) {
            r.hash = null;
          }
          
          let mediaId = r.mediaId || null;
          if (!mediaId && r.originalUrl) {
            mediaId = extractPlatformMediaId(r.originalUrl);
          }

          stmt.run(
            mediaId,
            r.sha256 || null,
            r.duration || 0,
            r.hash || null,
            r.originalUrl || null,
            r.title || null,
            r.postedBy || null,
            r.channel || null,
            r.archivedAt || null,
            r.fileName || null
          );
        }
        console.log(`[DB] Successfully migrated ${records.length} records to SQLite.`);
      }
      fs.renameSync(legacyPath, `${legacyPath}.bak`);
    } catch (err) {
      console.error('[DB] Failed to migrate index.json:', err);
    }
  }

  isMigrated = true;

  const db = getDb();

  // Cache hot media_records prepared statements if not already done.
  // These run on every download and every duplicate fingerprint check.
  if (!db._mediaStmts) {
    db._mediaStmts = {
      findByMediaId: db.prepare('SELECT * FROM media_records WHERE media_id = ?'),
      findBySha256: db.prepare('SELECT * FROM media_records WHERE sha256 = ?'),
      findByDurationRange: db.prepare(
        'SELECT * FROM media_records WHERE duration BETWEEN ? AND ?'
      ),
      findImages: db.prepare(
        'SELECT * FROM media_records WHERE duration = 0 OR duration IS NULL'
      ),
      findIdByMediaId: db.prepare(
        'SELECT id FROM media_records WHERE media_id = ? LIMIT 1'
      ),
      findIdByUrl: db.prepare(
        'SELECT id FROM media_records WHERE original_url = ? OR original_url = ? LIMIT 1'
      ),
      findIdByUrlOnly: db.prepare(
        'SELECT id FROM media_records WHERE original_url = ? LIMIT 1'
      ),
      // Full-row variants used by findDuplicateByUrl (needs all columns to build the return object)
      findFullRowByUrl: db.prepare(
        'SELECT * FROM media_records WHERE original_url = ? OR original_url = ? LIMIT 1'
      ),
      findFullRowByUrlOnly: db.prepare(
        'SELECT * FROM media_records WHERE original_url = ? LIMIT 1'
      ),
      updateRecord: db.prepare(`
        UPDATE media_records
        SET sha256 = COALESCE(?, sha256),
            duration = CASE WHEN ? > 0 THEN ? ELSE duration END,
            hash = COALESCE(?, hash),
            title = COALESCE(?, title),
            posted_by = COALESCE(?, posted_by),
            channel = COALESCE(?, channel),
            archived_at = COALESCE(?, archived_at),
            file_name = COALESCE(?, file_name)
        WHERE id = ?
      `),
      insertRecord: db.prepare(`
        INSERT INTO media_records (media_id, sha256, duration, hash, original_url, title, posted_by, channel, archived_at, file_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    };
  }
}

export async function findDuplicate(candidate, options = {}) {
  checkMigration();
  if (!candidate) return { match: null, reason: null, distance: Infinity };

  const candidateFp = typeof candidate === 'string'
    ? { hash: candidate, mediaId: null, sha256: null, duration: 0 }
    : candidate;

  const maxThreshold = typeof options === 'number'
    ? options
    : (options?.maxThreshold !== undefined ? options.maxThreshold : (config.duplicateThreshold || 5));
  
  const ignoreMediaId = typeof options === 'object' ? options?.ignoreMediaId : null;
  const ignoreOriginalUrl = typeof options === 'object' ? options?.ignoreOriginalUrl : null;

  const db = getDb();
  let bestMatch = null;
  let bestReason = null;
  let minScore = Infinity;
  
  const processRow = (r) => {
    if (ignoreMediaId && r.media_id && r.media_id === ignoreMediaId) return;
    if (ignoreOriginalUrl && r.original_url && r.original_url === ignoreOriginalUrl) return;
    
    // Map db row format to old format for matchDuplicate compatibility
    const record = {
      mediaId: r.media_id,
      sha256: r.sha256,
      duration: r.duration,
      hash: r.hash,
      originalUrl: r.original_url,
      title: r.title,
      postedBy: r.posted_by,
      channel: r.channel,
      archivedAt: r.archived_at,
      fileName: r.file_name
    };

    const res = matchDuplicate(candidateFp, record, maxThreshold);
    if (res.isDuplicate && res.score < minScore) {
      minScore = res.score;
      bestMatch = record;
      bestReason = res.reason;
    }
  };

  // Phase 1: Exact matches via index
  if (candidateFp.mediaId) {
    const rows = db._mediaStmts.findByMediaId.all(candidateFp.mediaId);
    for (const r of rows) {
      processRow(r);
      if (minScore === 0) return { match: bestMatch, reason: bestReason, distance: 0 };
    }
  }
  
  if (candidateFp.sha256) {
    const rows = db._mediaStmts.findBySha256.all(candidateFp.sha256);
    for (const r of rows) {
      processRow(r);
      if (minScore === 0) return { match: bestMatch, reason: bestReason, distance: 0 };
    }
  }

  // Phase 2: Perceptual Hash match (Range limited by duration to avoid scanning whole table)
  if (candidateFp.hash && candidateFp.hash !== '0000000000000000' && candidateFp.hash !== 'ffffffffffffffff') {
    let rows;
    if (candidateFp.duration > 0) {
      // Videos: Only check videos with similar duration (+/- 1.5s)
      rows = db._mediaStmts.findByDurationRange.all(candidateFp.duration - 1.5, candidateFp.duration + 1.5);
    } else {
      // Images: duration is 0 or null
      rows = db._mediaStmts.findImages.all();
    }
    
    for (const r of rows) {
      if (r.hash) processRow(r);
      if (minScore === 0) break;
    }
  }

  return { match: bestMatch, reason: bestReason, distance: minScore };
}

export async function findDuplicateByUrl(url) {
  checkMigration();
  if (!url) return null;
  const target = url.trim();
  const targetMediaId = extractPlatformMediaId(target);
  
  const db = getDb();
  let row = null;
  
  if (targetMediaId) {
    row = db._mediaStmts.findByMediaId.get(targetMediaId);
  }
  
  if (!row) {
    const normalizedTarget = normalizeUrl(target);
    if (normalizedTarget) {
      row = db._mediaStmts.findFullRowByUrl.get(target, normalizedTarget);
    } else {
      row = db._mediaStmts.findFullRowByUrlOnly.get(target);
    }
  }
  
  if (row) {
    return {
      mediaId: row.media_id,
      sha256: row.sha256,
      duration: row.duration,
      hash: row.hash,
      originalUrl: row.original_url,
      title: row.title,
      postedBy: row.posted_by,
      channel: row.channel,
      archivedAt: row.archived_at,
      fileName: row.file_name
    };
  }
  
  return null;
}

export async function saveRecord(record) {
  checkMigration();
  try {
    const archiveDir = path.resolve(config.archiveDirectory);
    await fs.promises.mkdir(archiveDir, { recursive: true });

    if (record.hash === '0000000000000000' || record.hash === 'ffffffffffffffff') {
      record.hash = null;
    }

    const db = getDb();

    // Check if record already exists by media_id or original_url to prevent duplicate rows
    let existing = null;
    if (record.mediaId) {
      existing = db._mediaStmts.findIdByMediaId.get(record.mediaId);
    }
    if (!existing && record.originalUrl) {
      const normalizedTarget = normalizeUrl(record.originalUrl);
      if (normalizedTarget) {
        existing = db._mediaStmts.findIdByUrl.get(record.originalUrl, normalizedTarget);
      } else {
        existing = db._mediaStmts.findIdByUrlOnly.get(record.originalUrl);
      }
    }

    if (existing) {
      // Update existing record rather than inserting a duplicate row
      db._mediaStmts.updateRecord.run(
        record.sha256 || null,
        record.duration || 0,
        record.duration || 0,
        record.hash || null,
        record.title || null,
        record.postedBy || null,
        record.channel || null,
        record.archivedAt || null,
        record.fileName || null,
        existing.id
      );
      return;
    }

    db._mediaStmts.insertRecord.run(
      record.mediaId || null,
      record.sha256 || null,
      record.duration || 0,
      record.hash || null,
      record.originalUrl || null,
      record.title || null,
      record.postedBy || null,
      record.channel || null,
      record.archivedAt || null,
      record.fileName || null
    );
  } catch (err) {
    console.error('[DB] Failed to save media record:', err);
  }
}
