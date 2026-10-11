import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run') || args.includes('-d');
const isAll = args.includes('--all') || args.includes('-a');
const explicitPathArg = args.find(a => !a.startsWith('-'));

const archiveRoot = path.resolve(config.archiveDirectory || 'archives');
const dbPath = path.resolve(config.linkDbPath || 'data/links.db');

function getTargetDirs() {
  if (explicitPathArg) {
    const resolved = path.resolve(explicitPathArg);
    return [resolved];
  }
  if (isAll) {
    const entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => path.join(archiveRoot, e.name));
  }
  // Default to music🎵 or archive root
  const defaultMusic = path.join(archiveRoot, 'music\u{1F3B5}');
  if (fs.existsSync(defaultMusic)) {
    return [defaultMusic];
  }
  return [archiveRoot];
}

const targetDirs = getTargetDirs();

console.log('========================================================');
console.log('            Archivist Fox - Archive Deduplicator        ');
console.log('========================================================');
console.log(`Mode: ${isDryRun ? 'DRY RUN (no files will be deleted)' : 'LIVE (redundant duplicates will be removed)'}`);
console.log(`Targets: ${targetDirs.length} directory(ies)`);
console.log('--------------------------------------------------------');

// Backup SQLite database before modifying
if (!isDryRun && fs.existsSync(dbPath)) {
  const backupPath = `${dbPath}.bak-${Date.now()}`;
  fs.copyFileSync(dbPath, backupPath);
  console.log(`[Backup] Backed up database to ${backupPath}`);
}

let grandPreserved = 0;
let grandDeletedMedia = 0;
let grandDeletedJson = 0;
let grandReclaimedBytes = 0;

let db = null;
let updateStmt = null;
if (!isDryRun && fs.existsSync(dbPath)) {
  try {
    db = new DatabaseSync(dbPath);
    updateStmt = db.prepare('UPDATE media_records SET file_name = ? WHERE channel = ? AND (media_id = ? OR original_url = ?)');
  } catch {}
}

for (const targetDir of targetDirs) {
  if (!fs.existsSync(targetDir)) {
    console.warn(`[Skip] Directory not found: ${targetDir}`);
    continue;
  }

  const dirName = path.basename(targetDir);
  const files = fs.readdirSync(targetDir);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const groups = new Map();

  for (const jf of jsonFiles) {
    try {
      const raw = fs.readFileSync(path.join(targetDir, jf), 'utf-8');
      const meta = JSON.parse(raw);
      const mediaName = jf.slice(0, -5);
      const mediaPath = path.join(targetDir, mediaName);
      const exists = fs.existsSync(mediaPath);
      const size = exists ? fs.statSync(mediaPath).size : (meta.fileSizeBytes || 0);

      const key = meta.mediaId || meta.originalUrl || meta.sha256;
      if (!key) continue;

      if (!groups.has(key)) {
        groups.set(key, []);
      }

      const hasTimestampSuffix = /_(?:[a-z0-9]{8}(?:_[a-z0-9]{8})*|\d{4}-\d{2}-\d{2}T[\d-]+Z)\.[^.]+$/i.test(mediaName);

      groups.get(key).push({
        jsonFile: jf,
        jsonPath: path.join(targetDir, jf),
        mediaName,
        mediaPath,
        exists,
        size,
        meta,
        archivedAt: meta.archivedAt ? new Date(meta.archivedAt).getTime() : 0,
        hasTimestampSuffix,
      });
    } catch {}
  }

  let preserved = 0;
  let deletedMedia = 0;
  let deletedJson = 0;
  let reclaimedBytes = 0;

  for (const [key, items] of groups.entries()) {
    items.sort((a, b) => {
      if (a.hasTimestampSuffix !== b.hasTimestampSuffix) {
        return a.hasTimestampSuffix ? 1 : -1;
      }
      return a.archivedAt - b.archivedAt;
    });

    const canonical = items.find(it => it.exists) || items[0];
    if (!canonical || !canonical.exists) continue;

    preserved++;
    const duplicates = items.filter(it => it !== canonical);

    for (const dup of duplicates) {
      if (dup.exists) {
        deletedMedia++;
        reclaimedBytes += dup.size;
        if (!isDryRun) {
          try {
            fs.unlinkSync(dup.mediaPath);
          } catch (e) {
            console.error(`Failed to delete media ${dup.mediaPath}:`, e.message);
          }
        }
      }
      if (fs.existsSync(dup.jsonPath)) {
        deletedJson++;
        if (!isDryRun) {
          try {
            fs.unlinkSync(dup.jsonPath);
          } catch (e) {
            console.error(`Failed to delete json ${dup.jsonPath}:`, e.message);
          }
        }
      }
    }

    if (!isDryRun && fs.existsSync(canonical.jsonPath)) {
      try {
        const currentMeta = JSON.parse(fs.readFileSync(canonical.jsonPath, 'utf-8'));
        currentMeta.fileName = canonical.mediaName;
        currentMeta.fileSizeBytes = fs.statSync(canonical.mediaPath).size;
        fs.writeFileSync(canonical.jsonPath, JSON.stringify(currentMeta, null, 2), 'utf-8');
      } catch {}
    }

    if (!isDryRun && updateStmt) {
      try {
        updateStmt.run(canonical.mediaName, dirName, key, key);
      } catch {}
    }
  }

  // Clean up orphaned compressed-orig files
  const compressedOrigFiles = files.filter(f => f.startsWith('compressed-orig-') && !f.endsWith('.json'));
  for (const cof of compressedOrigFiles) {
    const p = path.join(targetDir, cof);
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size;
      deletedMedia++;
      reclaimedBytes += size;
      if (!isDryRun) {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }
  }

  if (deletedMedia > 0 || deletedJson > 0) {
    console.log(
      `✓ ${dirName}: Preserved ${preserved}, removed ${deletedMedia} media files & ${deletedJson} sidecars, reclaimed ${(reclaimedBytes / 1024 / 1024).toFixed(1)} MB`
    );
  }

  grandPreserved += preserved;
  grandDeletedMedia += deletedMedia;
  grandDeletedJson += deletedJson;
  grandReclaimedBytes += reclaimedBytes;
}

console.log('--------------------------------------------------------');
console.log('Summary:');
console.log(`Preserved canonical media: ${grandPreserved}`);
console.log(`Duplicate media files removed: ${grandDeletedMedia}`);
console.log(`Duplicate JSON sidecars removed: ${grandDeletedJson}`);
console.log(`Total storage reclaimed: ${(grandReclaimedBytes / 1024 / 1024 / 1024).toFixed(2)} GB (${grandReclaimedBytes.toLocaleString()} bytes)`);
console.log('========================================================');
