import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';
import { getBrowserUserAgent } from '../src/utils.js';
import { getCookieForUrl } from '../src/cookieVault.js';

function parseCliArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let limit = 0;
  let channelFilter = null;
  let urlFilter = null;
  let keepBackup = false;
  let cookiesFromBrowser = config.cookiesFromBrowser || 'firefox';
  let cookiesFile = config.cookiesPath || null;
  let delayMs = 1500;
  let maxRes = 0; // 0 = best (4K), or e.g. 1080, 720
  let fragments = 4; // concurrent connections per download (default 4)

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run' || a === '-d') dryRun = true;
    else if (a === '--limit' || a === '-l') limit = parseInt(args[++i], 10);
    else if (a === '--channel' || a === '-c') channelFilter = args[++i];
    else if (a === '--url' || a === '-u') urlFilter = args[++i];
    else if (a === '--backup' || a === '-b') keepBackup = true;
    else if (a === '--cookies-from-browser' || a === '-C') cookiesFromBrowser = args[++i];
    else if (a === '--no-browser-cookies') cookiesFromBrowser = null;
    else if (a === '--cookies') cookiesFile = args[++i];
    else if (a === '--delay') delayMs = parseInt(args[++i], 10);
    else if (a === '--max-res' || a === '-m') maxRes = parseInt(args[++i], 10);
    else if (a === '--fragments' || a === '-N') fragments = parseInt(args[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log(`
Archivist Fox — High-Speed YouTube Quality Upgrade Utility

Usage:
  node scripts/redownload_youtube.js [options]
  npm run redownload-youtube -- [options]

Options:
  --dry-run, -d                   Scan and list affected low-res videos without downloading anything
  --limit <N>, -l <N>             Limit processing to first N affected videos
  --channel <name>, -c <name>     Only process videos from a specific channel folder
  --url <url>, -u <url>           Upgrade a single specific video by YouTube URL or ID
  --max-res <height>, -m <height> Cap max resolution (e.g. 1080, 720). Default: 0 (uncapped / best / 4K)
  --fragments <N>, -N <N>         Concurrent connection fragments per download (default: 4, 3x-5x faster)
  --backup, -b                    Keep old 360p files renamed as .mp4.bak instead of deleting them
  --cookies-from-browser, -C <br> Browser to load YouTube cookies from (firefox, chrome, edge, brave). Default: ${config.cookiesFromBrowser || 'firefox'}
  --no-browser-cookies            Disable browser cookie extraction
  --cookies <file>                Path to a Netscape-format cookies.txt file
  --delay <ms>                    Delay between video downloads in milliseconds (default: 1500ms)
  --help, -h                      Show this help message

Performance Tips:
  # Fast mode: cap at 1080p with 4 concurrent fragments (4x faster, 75% smaller downloads)
  npm run redownload-youtube -- --max-res 1080 -N 4

  # Full 4K mode with 8 concurrent fragments
  npm run redownload-youtube -- -N 8
      `);
      process.exit(0);
    }
  }

  return { dryRun, limit, channelFilter, urlFilter, keepBackup, cookiesFromBrowser, cookiesFile, delayMs, maxRes, fragments };
}

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
    }
  });
}

function runYtDlpWithLiveProgress(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let lastProgressLine = '';

      child.stdout.on('data', (d) => {
        const text = d.toString();
        stdout += text;
        const lines = text.split(/[\r\n]+/);
        for (const line of lines) {
          if (line.includes('[download]') && line.includes('%')) {
            const clean = line.replace(/\[download\]\s*/, '').trim();
            if (clean && clean !== lastProgressLine) {
              lastProgressLine = clean;
              // Cleanly print live progress in-place on current console line
              process.stdout.write(`\r     ⏳ [download] ${clean}          `);
            }
          } else if (line.includes('[Merger]') || line.includes('[ffmpeg]')) {
            process.stdout.write(`\r     ⚙️ [muxing] Merging video + audio streams with ffmpeg...          `);
          }
        }
      });

      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
      child.on('close', (code) => {
        // Clear live progress line
        process.stdout.write('\r                                                                                \r');
        resolve({ code, stdout, stderr });
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
    }
  });
}

async function getVideoDimensions(filePath) {
  const res = await runCommand(config.ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    filePath,
  ]);
  if (res.code !== 0 || !res.stdout.trim()) return null;
  const parts = res.stdout.trim().split(',');
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);
  return { width, height };
}

function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

async function main() {
  const { dryRun, limit, channelFilter, urlFilter, keepBackup, cookiesFromBrowser, cookiesFile, delayMs, maxRes, fragments } = parseCliArgs();

  const archiveRoot = path.resolve(config.archiveDirectory || 'archives');
  const dbPath = path.resolve(config.linkDbPath || 'data/links.db');

  console.log('================================================================');
  console.log('       Archivist Fox — YouTube Quality Upgrade Utility          ');
  console.log('================================================================');
  console.log(`Archive directory:  ${archiveRoot}`);
  console.log(`Database:           ${dbPath}`);
  console.log(`Mode:               ${dryRun ? 'DRY-RUN (audit only, no files changed)' : 'LIVE UPGRADE'}`);
  console.log(`Max resolution:     ${maxRes > 0 ? `${maxRes}p (optimized size & speed)` : 'Best available (up to 4K)'}`);
  console.log(`Multi-connections:  ${fragments} parallel fragments per stream`);
  if (cookiesFromBrowser) console.log(`Cookies source:     Browser (${cookiesFromBrowser})`);
  else if (cookiesFile)   console.log(`Cookies source:     File (${cookiesFile})`);
  else                    console.log(`Cookies source:     None (anonymous)`);
  if (channelFilter)      console.log(`Filter channel:     ${channelFilter}`);
  if (urlFilter)          console.log(`Filter URL:         ${urlFilter}`);
  if (limit > 0)          console.log(`Limit:              Up to ${limit} videos`);
  console.log('----------------------------------------------------------------\n');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath);

  // 1. Index archive files recursively for fast O(1) lookups
  console.log('🔍 Indexing archive files...');
  const fileMap = new Map();
  function indexDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          indexDir(full);
        } else if (entry.isFile()) {
          fileMap.set(entry.name, full);
        }
      }
    } catch {}
  }
  indexDir(archiveRoot);
  console.log(`Indexed ${fileMap.size} files in local archive.`);

  // 2. Fetch all YouTube records from DB
  const query = `
    SELECT id, media_id, original_url, title, channel, archived_at, file_name, sha256 
    FROM media_records 
    WHERE media_id LIKE 'youtube:%' OR original_url LIKE '%youtube.com%' OR original_url LIKE '%youtu.be%'
    ORDER BY archived_at ASC
  `;
  const records = db.prepare(query).all();
  console.log(`Found ${records.length} YouTube records in database.\n`);

  // 3. Filter candidates that are low-res (<= 360p)
  console.log('🔎 Checking which videos are low-res (<= 360p)...');
  const candidates = [];

  for (const r of records) {
    if (urlFilter && !r.original_url.includes(urlFilter)) continue;
    if (channelFilter && r.channel !== channelFilter && !r.channel.includes(channelFilter)) continue;

    const filePath = fileMap.get(r.file_name);
    if (!filePath || !fs.existsSync(filePath)) continue;

    const dims = await getVideoDimensions(filePath);
    if (!dims) continue;

    // Check if the video is low resolution (360p or lower, portrait or landscape)
    const isLowRes = Math.min(dims.width, dims.height) <= 360;

    if (isLowRes) {
      candidates.push({
        record: r,
        filePath,
        currentDims: dims,
      });
    }
  }

  console.log(`Found ${candidates.length} videos stored at 360p or lower.\n`);

  if (candidates.length === 0) {
    console.log('✨ All matching YouTube videos in your archive are already at high quality! Nothing to do.');
    db.close();
    return;
  }

  const toProcess = limit > 0 ? candidates.slice(0, limit) : candidates;

  if (dryRun) {
    console.log(`📋 [DRY-RUN] The following ${toProcess.length} videos would be upgraded:\n`);
    toProcess.forEach((c, idx) => {
      const displayTitle = c.record.title || path.parse(c.filePath).name;
      console.log(`  ${idx + 1}. [${c.currentDims.width}x${c.currentDims.height}] [${c.record.channel}] ${displayTitle}`);
      console.log(`     URL: ${c.record.original_url}`);
      console.log(`     File: ${c.filePath}\n`);
    });
    console.log(`To execute this upgrade, re-run without --dry-run`);
    db.close();
    return;
  }

  // Backup SQLite database before upgrading
  const dbBackup = `${dbPath}.upgrade-bak-${Date.now()}`;
  fs.copyFileSync(dbPath, dbBackup);
  console.log(`💾 Backed up database to ${dbBackup}\n`);

  const updateMediaStmt = db.prepare(`
    UPDATE media_records 
    SET sha256 = ?, file_name = ?
    WHERE id = ?
  `);

  let upgradedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const item = toProcess[i];
    const { record, filePath, currentDims } = item;
    const progressTag = `[${i + 1}/${toProcess.length}]`;

    const itemTitle = record.title || path.parse(filePath).name;
    console.log(`\n${progressTag} Upgrading: "${itemTitle}" (${currentDims.width}x${currentDims.height})`);
    console.log(`     URL: ${record.original_url}`);

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytdlp-upgrade-'));
    const tempOutputTemplate = path.join(tempDir, '%(title).150s.%(ext)s');

    // Build format selector respecting max-res if set
    let formatSpec = 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b';
    if (maxRes > 0) {
      formatSpec = `bv*[height<=${maxRes}][ext=mp4]+ba[ext=m4a]/bv*[height<=${maxRes}]+ba/b[height<=${maxRes}][ext=mp4]/b[height<=${maxRes}]/bv*+ba/b`;
    }

    const ytdlpArgs = [
      record.original_url,
      '-o', tempOutputTemplate,
      '--no-playlist',
      '--windows-filenames',
      '--no-check-certificates',
      '--no-warnings',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=web,default',
      '--concurrent-fragments', `${Math.max(1, fragments)}`,
      '-f', formatSpec,
      '--merge-output-format', 'mp4',
    ];

    if (config.ffmpegPath && fs.existsSync(config.ffmpegPath)) {
      ytdlpArgs.push('--ffmpeg-location', config.ffmpegPath);
    }

    // Apply browser cookies or file cookies
    const cookieVaultPath = getCookieForUrl(record.original_url);
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      ytdlpArgs.push('--cookies', cookiesFile);
    } else if (cookiesFromBrowser) {
      ytdlpArgs.push('--cookies-from-browser', cookiesFromBrowser);
    } else if (cookieVaultPath && fs.existsSync(cookieVaultPath)) {
      ytdlpArgs.push('--cookies', cookieVaultPath);
    }

    // Apply impersonation & browser headers
    let impersonateTarget = config.impersonateBrowser;
    if (impersonateTarget === 'auto') {
      if (cookiesFromBrowser) {
        const lower = cookiesFromBrowser.toLowerCase();
        if (lower.includes('firefox')) impersonateTarget = 'firefox';
        else if (lower.includes('edge')) impersonateTarget = 'edge';
        else if (lower.includes('safari')) impersonateTarget = 'safari';
        else impersonateTarget = 'chrome';
      } else {
        impersonateTarget = 'chrome';
      }
    }
    const isImpersonateDisabled = !impersonateTarget || ['off', 'none', 'false'].includes(impersonateTarget);
    if (!isImpersonateDisabled) {
      ytdlpArgs.push('--impersonate', impersonateTarget);
    }
    const activeBrowserType = !isImpersonateDisabled ? impersonateTarget : cookiesFromBrowser || 'chrome';
    ytdlpArgs.push('--user-agent', getBrowserUserAgent(activeBrowserType));

    // Run with real-time live terminal download progress
    const dlResult = await runYtDlpWithLiveProgress(config.ytdlpPath, ytdlpArgs);

    if (dlResult.code !== 0) {
      const allLines = dlResult.stderr.trim().split('\n');
      const errLine = allLines.find((l) => l.includes('ERROR:')) || allLines[0] || 'Unknown error';

      if (dlResult.stderr.includes('Sign in to confirm') || dlResult.stderr.includes('bot')) {
        console.warn(`     🚫 Bot check triggered by YouTube: "Sign in to confirm you're not a bot"`);
        console.warn(`        Fix: Ensure ${cookiesFromBrowser || 'your browser'} is logged into YouTube, or export cookies to cookies/youtube.txt`);
      } else {
        console.warn(`     ⚠️ Download failed: ${errLine}`);
      }

      failedCount++;
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    // Locate newly downloaded file
    const downloadedFiles = (await fs.promises.readdir(tempDir))
      .filter((f) => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'))
      .map((f) => path.join(tempDir, f));

    if (downloadedFiles.length === 0) {
      console.warn(`     ⚠️ No video file found after download.`);
      failedCount++;
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    const newFilePath = downloadedFiles[0];
    const newDims = await getVideoDimensions(newFilePath);
    const newStat = await fs.promises.stat(newFilePath);
    const oldStat = await fs.promises.stat(filePath);

    if (!newDims || Math.min(newDims.width, newDims.height) <= Math.min(currentDims.width, currentDims.height)) {
      console.log(`     ℹ️ No higher resolution available on YouTube (new is ${newDims?.width}x${newDims?.height}). Keeping original.`);
      skippedCount++;
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    console.log(`     🚀 Higher quality found: ${currentDims.width}x${currentDims.height} -> ${newDims.width}x${newDims.height} (${formatBytes(oldStat.size)} -> ${formatBytes(newStat.size)})`);

    // Backup or remove old file
    if (keepBackup) {
      await fs.promises.rename(filePath, `${filePath}.bak`).catch(() => {});
    } else {
      await fs.promises.unlink(filePath).catch(() => {});
    }

    // Determine target path in archive
    const targetDir = path.dirname(filePath);
    const newFileName = path.basename(newFilePath);
    const targetFilePath = path.join(targetDir, newFileName);

    await fs.promises.copyFile(newFilePath, targetFilePath);
    const newSha256 = await computeSha256(targetFilePath);

    // Update sidecar metadata JSON if present
    const metaPath = `${filePath}.json`;
    const newMetaPath = `${targetFilePath}.json`;

    let metadata = {};
    if (fs.existsSync(metaPath)) {
      try {
        metadata = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
      } catch {}
    }
    metadata.fileSizeBytes = newStat.size;
    metadata.sha256 = newSha256;
    metadata.fileName = newFileName;
    metadata.upgradedAt = new Date().toISOString();
    metadata.upgradedResolution = `${newDims.width}x${newDims.height}`;

    if (metaPath !== newMetaPath && fs.existsSync(metaPath)) {
      await fs.promises.unlink(metaPath).catch(() => {});
    }
    await fs.promises.writeFile(newMetaPath, JSON.stringify(metadata, null, 2), 'utf-8');

    // Update SQLite database
    try {
      updateMediaStmt.run(newSha256, newFileName, record.id);
    } catch (err) {
      console.warn(`     [DB] Failed to update record ID ${record.id}:`, err.message);
    }

    // Clean temp
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});

    console.log(`     ✅ Successfully replaced with high-quality version: ${newFileName}`);
    upgradedCount++;

    // Polite delay between downloads to prevent YouTube IP rate limiting
    if (delayMs > 0 && i < toProcess.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log('\n================================================================');
  console.log('                    Upgrade Summary                             ');
  console.log('================================================================');
  console.log(`Total processed: ${toProcess.length}`);
  console.log(`Upgraded:        ${upgradedCount}`);
  console.log(`Skipped (max):   ${skippedCount}`);
  console.log(`Failed / unavail:${failedCount}`);
  console.log('================================================================\n');

  db.close();
}

main().catch((err) => {
  console.error('Fatal upgrade error:', err);
  process.exit(1);
});
