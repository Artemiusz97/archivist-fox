import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { matchDuplicate, hammingDistance } from './phasher.js';
import { extractPlatformMediaId, normalizeUrl, stripQueryAndTrailingPunctuation } from './urlExtractor.js';
import { getDb } from './linkDb.js';

let cachedArchiveSizeBytes = null;
let cachedArchiveSizeTimestamp = 0;
const ARCHIVE_SIZE_TTL_MS = 60 * 1000;

function getLegacyDbPath() {
  const archiveDir = path.resolve(config.archiveDirectory);
  return path.join(archiveDir, 'index.json');
}

/**
 * Ensures any legacy `archives/index.json` records are migrated once and that
 * `media_records` prepared statements are attached to the active SQLite instance
 * (including after `closeLinkDb()` -> `initLinkDb(':memory:')` in clean-room tests).
 */
export function ensureMediaStmts() {
  const db = getDb();

  if (!db._legacyChecked && !db._isMemory) {
    db._legacyChecked = true;
    const legacyPath = getLegacyDbPath();
    if (fs.existsSync(legacyPath)) {
      console.log('[DB] Found legacy index.json. Migrating to SQLite...');
      try {
        const content = fs.readFileSync(legacyPath, 'utf-8');
        const records = JSON.parse(content);
        if (Array.isArray(records)) {
          const stmt = db.prepare(`
            INSERT INTO media_records (media_id, sha256, duration, hash, original_url, title, posted_by, channel, archived_at, file_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          db.exec('BEGIN IMMEDIATE;');
          try {
            for (const r of records) {
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
            db.exec('COMMIT;');
          } catch (txErr) {
            db.exec('ROLLBACK;');
            throw txErr;
          }
          console.log(`[DB] Successfully migrated ${records.length} records to SQLite.`);
        }
        fs.renameSync(legacyPath, `${legacyPath}.bak`);
      } catch (err) {
        console.error('[DB] Failed to migrate index.json:', err);
      }
    }
  }

  if (!db._mediaStmts) {
    db._mediaStmts = {
      findById: db.prepare('SELECT * FROM media_records WHERE id = ?'),
      findByMediaId: db.prepare('SELECT * FROM media_records WHERE media_id = ?'),
      findBySha256: db.prepare('SELECT * FROM media_records WHERE sha256 = ?'),
      findByDurationRange: db.prepare(
        'SELECT * FROM media_records WHERE duration BETWEEN ? AND ?'
      ),
      findImageHashes: db.prepare(
        "SELECT id, hash FROM media_records WHERE (duration = 0 OR duration IS NULL) AND hash IS NOT NULL AND hash != ''"
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
            file_name = COALESCE(?, file_name),
            relative_path = COALESCE(?, relative_path),
            file_size = COALESCE(?, file_size)
        WHERE id = ?
      `),
      insertRecord: db.prepare(`
        INSERT INTO media_records (media_id, sha256, duration, hash, original_url, title, posted_by, channel, archived_at, file_name, relative_path, file_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      sumFileSizes: db.prepare(`
        SELECT
          COALESCE(SUM(file_size), 0) AS total_bytes,
          COUNT(*) AS total_rows,
          SUM(CASE WHEN file_size IS NOT NULL AND file_size > 0 THEN 1 ELSE 0 END) AS sized_rows
        FROM media_records
      `),
    };
  }

  return db;
}

function mapMediaRow(r) {
  return {
    mediaId: r.media_id,
    sha256: r.sha256,
    duration: r.duration,
    hash: r.hash,
    originalUrl: r.original_url,
    title: r.title,
    postedBy: r.posted_by,
    channel: r.channel,
    archivedAt: r.archived_at,
    fileName: r.file_name,
    relativePath: r.relative_path || null,
    fileSize: r.file_size ?? null,
  };
}

export async function findDuplicate(candidate, options = {}) {
  const db = ensureMediaStmts();
  if (!candidate) return { match: null, reason: null, distance: Infinity };

  const candidateFp = typeof candidate === 'string'
    ? { hash: candidate, mediaId: null, sha256: null, duration: 0 }
    : candidate;

  const maxThreshold = typeof options === 'number'
    ? options
    : (options?.maxThreshold !== undefined ? options.maxThreshold : (config.duplicateThreshold || 5));

  const ignoreMediaId = typeof options === 'object' ? options?.ignoreMediaId : null;
  const ignoreOriginalUrl = typeof options === 'object' ? options?.ignoreOriginalUrl : null;

  let bestMatch = null;
  let bestReason = null;
  let minScore = Infinity;

  const processRow = (r) => {
    if (!r) return;
    if (ignoreMediaId && r.media_id && r.media_id === ignoreMediaId) return;
    if (ignoreOriginalUrl && r.original_url && r.original_url === ignoreOriginalUrl) return;

    const record = mapMediaRow(r);
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

  // Phase 2: Perceptual Hash match (range-limited for videos, lightweight hash projection for images)
  if (candidateFp.hash && candidateFp.hash !== '0000000000000000' && candidateFp.hash !== 'ffffffffffffffff') {
    if (candidateFp.duration > 0) {
      const rows = db._mediaStmts.findByDurationRange.all(
        candidateFp.duration - 1.5,
        candidateFp.duration + 1.5
      );
      for (const r of rows) {
        if (r.hash) processRow(r);
        if (minScore === 0) break;
      }
    } else {
      const lightRows = db._mediaStmts.findImageHashes.all();
      for (const lr of lightRows) {
        const dist = hammingDistance(candidateFp.hash, lr.hash);
        if (dist <= maxThreshold && dist < minScore) {
          const fullRow = db._mediaStmts.findById.get(lr.id);
          processRow(fullRow);
          if (minScore === 0) break;
        }
      }
    }
  }

  return { match: bestMatch, reason: bestReason, distance: minScore };
}

export async function findDuplicateByUrl(url, explicitMediaId = null) {
  const db = ensureMediaStmts();
  if (!url && !explicitMediaId) return null;
  const target = url ? stripQueryAndTrailingPunctuation(String(url).trim()) : '';
  if (!target && !explicitMediaId) return null;
  const targetMediaId = explicitMediaId || extractPlatformMediaId(target);

  let row = null;

  if (targetMediaId) {
    row = db._mediaStmts.findByMediaId.get(targetMediaId);
  }

  if (!row && target) {
    const normalizedTarget = normalizeUrl(target);
    if (normalizedTarget) {
      row = db._mediaStmts.findFullRowByUrl.get(target, normalizedTarget);
    } else {
      row = db._mediaStmts.findFullRowByUrlOnly.get(target);
    }
  }

  return row ? mapMediaRow(row) : null;
}

function upsertSingleMediaRecord(db, record) {
  if (!record) return;
  let hash = record.hash || null;
  if (hash === '0000000000000000' || hash === 'ffffffffffffffff') {
    hash = null;
  }

  const relativePath = record.relativePath ?? record.relative_path ?? null;
  const fileSize = record.fileSize ?? record.file_size ?? null;

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
    db._mediaStmts.updateRecord.run(
      record.sha256 || null,
      record.duration || 0,
      record.duration || 0,
      hash,
      record.title || null,
      record.postedBy || null,
      record.channel || null,
      record.archivedAt || null,
      record.fileName || null,
      relativePath,
      fileSize,
      existing.id
    );
    return;
  }

  db._mediaStmts.insertRecord.run(
    record.mediaId || null,
    record.sha256 || null,
    record.duration || 0,
    hash,
    record.originalUrl || null,
    record.title || null,
    record.postedBy || null,
    record.channel || null,
    record.archivedAt || null,
    record.fileName || null,
    relativePath,
    fileSize
  );
}

export async function saveRecord(record) {
  const db = ensureMediaStmts();
  try {
    upsertSingleMediaRecord(db, record);
    cachedArchiveSizeBytes = null;
  } catch (err) {
    console.error('[DB] Failed to save media record:', err);
  }
}

export async function saveRecordBatch(records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const db = ensureMediaStmts();
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const r of records) {
      upsertSingleMediaRecord(db, r);
    }
    db.exec('COMMIT;');
    cachedArchiveSizeBytes = null;
    return records.length;
  } catch (err) {
    db.exec('ROLLBACK;');
    console.error('[DB] Failed to batch-save media records:', err);
    return 0;
  }
}

async function computeDirectoryBytesFallback(dirPath) {
  let total = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await computeDirectoryBytesFallback(fullPath);
      } else if (entry.isFile() && !entry.name.endsWith('.json')) {
        const stat = await fs.promises.stat(fullPath).catch(() => null);
        if (stat) total += stat.size;
      }
    }
  } catch (err) {
    void err;
  }
  return total;
}

/**
 * Returns total archived media size in bytes using SQLite `SUM(file_size)` when
 * available, falling back to an async directory walk cached for 60s.
 *
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<number>}
 */
export async function getTotalArchiveSize(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedArchiveSizeBytes !== null && now - cachedArchiveSizeTimestamp < ARCHIVE_SIZE_TTL_MS) {
    return cachedArchiveSizeBytes;
  }

  const db = ensureMediaStmts();
  const summary = db._mediaStmts.sumFileSizes.get();
  if (summary && summary.total_rows > 0 && summary.sized_rows === summary.total_rows) {
    cachedArchiveSizeBytes = Number(summary.total_bytes) || 0;
    cachedArchiveSizeTimestamp = now;
    return cachedArchiveSizeBytes;
  }

  const dirBytes = await computeDirectoryBytesFallback(path.resolve(config.archiveDirectory));
  cachedArchiveSizeBytes = Math.max(Number(summary?.total_bytes || 0), dirBytes);
  cachedArchiveSizeTimestamp = now;
  return cachedArchiveSizeBytes;
}
