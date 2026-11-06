import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { getBrowserUserAgent, probeMedia, runProcess, isCookieLockError, isVideo } from './utils.js';
import { computeSha256 } from './phasher.js';
import { getCookieForUrl } from './cookieVault.js';
import { backupDatabaseSafely } from './linkDb.js';

/**
 * Parses CLI arguments for the YouTube resolution & Premium bitrate upgrade utility.
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 */
export function parseUpgradeCliArgs(argv = process.argv.slice(2)) {
  let dryRun = false;
  let lowResOnly = false;
  let force = false;
  let limit = 0;
  let channelFilter = null;
  let urlFilter = null;
  let keepBackup = false;
  let cookiesFromBrowser = undefined;
  let cookiesFile = null;
  let noBrowserCookies = false;
  let delayMs = 1500;
  let maxRes = 0;
  let fragments = 4;
  let concurrency = 5;
  let minBitrateGainPct = 5;
  let showHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-d') dryRun = true;
    else if (a === '--low-res-only') lowResOnly = true;
    else if (a === '--premium' || a === '--upgrade-bitrate') lowResOnly = false;
    else if (a === '--force' || a === '-f') force = true;
    else if (a === '--limit' || a === '-l') limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--channel' || a === '-c') channelFilter = argv[++i] || null;
    else if (a === '--url' || a === '-u') urlFilter = argv[++i] || null;
    else if (a === '--backup' || a === '-b') keepBackup = true;
    else if (a === '--cookies-from-browser' || a === '-C') {
      cookiesFromBrowser = argv[++i] || null;
      noBrowserCookies = false;
    } else if (a === '--no-browser-cookies') {
      noBrowserCookies = true;
      cookiesFromBrowser = null;
    } else if (a === '--cookies') {
      cookiesFile = argv[++i] || null;
      noBrowserCookies = true;
      cookiesFromBrowser = null;
    } else if (a === '--delay') delayMs = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--max-res' || a === '-m') maxRes = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--fragments' || a === '-N') fragments = Math.max(1, parseInt(argv[++i], 10) || 4);
    else if (a === '--concurrency' || a === '-P') concurrency = Math.min(16, Math.max(1, parseInt(argv[++i], 10) || 5));
    else if (a === '--min-bitrate-gain') minBitrateGainPct = Math.max(1, parseFloat(argv[++i]) || 5);
    else if (a === '--help' || a === '-h') showHelp = true;
  }

  return {
    dryRun,
    lowResOnly,
    force,
    limit,
    channelFilter,
    urlFilter,
    keepBackup,
    cookiesFromBrowser,
    cookiesFile,
    noBrowserCookies,
    delayMs,
    maxRes,
    fragments,
    concurrency,
    minBitrateGainPct,
    showHelp,
  };
}

/**
 * Resolves cookie source precedence:
 * 1. Explicit `--cookies <file>` CLI option
 * 2. Explicit `-C / --cookies-from-browser <browser>` CLI option
 * 3. `--no-browser-cookies` -> platform cookie vault (`cookies/youtube.txt` or `cookies.txt`)
 * 4. `.env` `COOKIES_FROM_BROWSER` / `PREFER_BROWSER_COOKIES` / platform cookie vault
 */
export function resolveUpgradeCookieSource(url, options = {}) {
  const { cookiesFile, cookiesFromBrowser, noBrowserCookies } = options;

  if (cookiesFile && fs.existsSync(cookiesFile)) {
    return { type: 'file', value: cookiesFile };
  }

  if (typeof cookiesFromBrowser === 'string' && cookiesFromBrowser.trim()) {
    return { type: 'browser', value: cookiesFromBrowser.trim() };
  }

  const vaultPath = getCookieForUrl(url);

  if (noBrowserCookies || cookiesFromBrowser === null) {
    if (vaultPath && fs.existsSync(vaultPath)) {
      return { type: 'file', value: vaultPath };
    }
    return { type: 'none', value: null };
  }

  const envBrowser = (config.cookiesFromBrowser || '').trim();
  if (envBrowser && (config.preferBrowserCookies || !vaultPath || !fs.existsSync(vaultPath))) {
    return { type: 'browser', value: envBrowser };
  }

  if (vaultPath && fs.existsSync(vaultPath)) {
    return { type: 'file', value: vaultPath };
  }

  if (envBrowser) {
    return { type: 'browser', value: envBrowser };
  }

  return { type: 'none', value: null };
}

function buildSharedYtDlpSelectionAndAuthArgs(url, options = {}) {
  const maxRes = Number(options.maxRes) || 0;
  const formatSpec =
    maxRes > 0
      ? `bv*[height<=${maxRes}]+ba/b[height<=${maxRes}]/bv*+ba/b`
      : 'bv*+ba/b';

  const args = [
    '--no-playlist',
    '--no-check-certificates',
    '--no-warnings',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=web,default;skip=translated_subs',
    '-f', formatSpec,
    '-S', 'res,br,fps',
  ];

  const cookieSource = resolveUpgradeCookieSource(url, options);
  if (cookieSource.type === 'file') {
    args.push('--cookies', cookieSource.value);
  } else if (cookieSource.type === 'browser') {
    args.push('--cookies-from-browser', cookieSource.value);
  }

  const activeCookieBrowser =
    (typeof options.impersonateBrowserHint === 'string' && options.impersonateBrowserHint.trim()) ||
    (cookieSource.type === 'browser' ? cookieSource.value : '');
  let impersonateTarget = config.impersonateBrowser;
  if (impersonateTarget === 'auto') {
    if (activeCookieBrowser) {
      const lower = activeCookieBrowser.toLowerCase();
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
    args.push('--impersonate', impersonateTarget);
  }
  const activeBrowserType = !isImpersonateDisabled ? impersonateTarget : activeCookieBrowser || 'chrome';
  args.push('--user-agent', getBrowserUserAgent(activeBrowserType));

  return args;
}

/**
 * Builds the `yt-dlp` download argument list for upgrading a YouTube video at
 * the highest available resolution and bitrate (including YouTube Premium streams).
 */
export function buildUpgradeYtDlpArgs(url, tempOutputTemplate, options = {}) {
  const fragments = Math.max(1, Number(options.fragments) || 4);
  const args = [
    url,
    '-o', tempOutputTemplate,
    '--windows-filenames',
    '--concurrent-fragments', String(fragments),
    ...buildSharedYtDlpSelectionAndAuthArgs(url, options),
    '--merge-output-format', 'mp4',
  ];

  if (config.ffmpegPath && fs.existsSync(config.ffmpegPath)) {
    args.push('--ffmpeg-location', config.ffmpegPath);
  }

  return args;
}

/**
 * Extracts selected video/audio resolution, bitrates (kbps), format ID, and
 * YouTube Premium status from `yt-dlp --dump-single-json` output.
 */
export function parseRemoteFormatInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const duration = Number(info.duration) || 0;
  const requested = Array.isArray(info.requested_formats) ? info.requested_formats : [];

  if (requested.length > 0) {
    const videoFmt = requested.find((f) => f && f.vcodec && f.vcodec !== 'none') || requested[0];
    const audioFmt =
      requested.find((f) => f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) ||
      requested.find((f) => f && f !== videoFmt && f.acodec && f.acodec !== 'none') ||
      null;

    const width = Number(videoFmt?.width || info.width) || 0;
    const height = Number(videoFmt?.height || info.height) || 0;

    const exactVSize = Number(videoFmt?.filesize) || 0;
    const approxVSize = Number(videoFmt?.filesize_approx) || 0;
    const exactASize = Number(audioFmt?.filesize) || 0;
    const approxASize = Number(audioFmt?.filesize_approx) || 0;

    const videoBitrateKbps =
      (duration > 0 && exactVSize > 0 ? (exactVSize * 8) / duration / 1000 : 0) ||
      Number(videoFmt?.vbr || videoFmt?.tbr) ||
      (duration > 0 && approxVSize > 0 ? (approxVSize * 8) / duration / 1000 : 0);
    const audioBitrateKbps =
      (duration > 0 && exactASize > 0 ? (exactASize * 8) / duration / 1000 : 0) ||
      Number(audioFmt?.abr || audioFmt?.tbr) ||
      (duration > 0 && approxASize > 0 ? (approxASize * 8) / duration / 1000 : 0);
    const totalBitrateKbps =
      videoBitrateKbps + audioBitrateKbps ||
      Number(info.tbr) ||
      0;

    const formatId = requested.map((f) => f?.format_id).filter(Boolean).join('+') || String(info.format_id || '');
    const formatNote =
      requested.map((f) => f?.format_note || f?.format).filter(Boolean).join(' + ') ||
      String(info.format_note || info.format || '');
    const isPremium =
      requested.some((f) => /premium/i.test(`${f?.format_note || ''} ${f?.format || ''}`)) ||
      /premium/i.test(`${info.format_note || ''} ${info.format || ''}`);

    return {
      width,
      height,
      videoBitrateKbps: Math.round(videoBitrateKbps * 100) / 100,
      audioBitrateKbps: Math.round(audioBitrateKbps * 100) / 100,
      totalBitrateKbps: Math.round(totalBitrateKbps * 100) / 100,
      formatId,
      formatNote,
      isPremium,
    };
  }

  const width = Number(info.width) || 0;
  const height = Number(info.height) || 0;
  const fSize = Number(info.filesize || info.filesize_approx) || 0;
  const videoBitrateKbps = Number(info.vbr) || 0;
  const audioBitrateKbps = Number(info.abr) || 0;
  const totalBitrateKbps =
    Number(info.tbr) ||
    videoBitrateKbps + audioBitrateKbps ||
    (duration > 0 && fSize > 0 ? (fSize * 8) / duration / 1000 : 0);
  const formatId = String(info.format_id || '');
  const formatNote = String(info.format_note || info.format || '');
  const isPremium = /premium/i.test(formatNote);

  return {
    width,
    height,
    videoBitrateKbps: Math.round(videoBitrateKbps * 100) / 100,
    audioBitrateKbps: Math.round(audioBitrateKbps * 100) / 100,
    totalBitrateKbps: Math.round(totalBitrateKbps * 100) / 100,
    formatId,
    formatNote,
    isPremium,
  };
}

/**
 * Queries YouTube metadata (without downloading video bytes) to determine the
 * exact highest-resolution & highest-bitrate stream pair available for `url`.
 */
export async function inspectRemoteBestQuality(url, options = {}) {
  const args = [
    url,
    '--dump-single-json',
    ...buildSharedYtDlpSelectionAndAuthArgs(url, options),
  ];

  const execFn = options.execFn || runProcess;
  const { stdout } = await execFn(config.ytdlpPath, args, {
    timeoutMs: 45000,
    registerProcess: false,
    maxBufferBytes: 32 * 1024 * 1024,
    rollingBuffer: false,
  });

  const parsed = JSON.parse(stdout.trim());
  return parseRemoteFormatInfo(parsed);
}

/**
 * Probes a local video file for dimensions and bitrates (kbps).
 */
export async function probeVideoQuality(filePath, probeFn = probeMedia) {
  if (!isVideo(filePath)) return null;
  const info = await probeFn(filePath);
  if (!info || !info.hasVideo || !info.width || !info.height) return null;

  let sizeBytes = 0;
  try {
    sizeBytes = (await fs.promises.stat(filePath)).size;
  } catch (err) {
    void err;
  }

  const duration = Number(info.duration) || 0;
  const totalBps =
    Number(info.totalBitrate) > 0
      ? Number(info.totalBitrate)
      : duration > 0 && sizeBytes > 0
        ? (sizeBytes * 8) / duration
        : 0;
  const audioBps = Number(info.audioBitrate) || 0;
  const videoBps = Number(info.videoBitrate) > 0 ? Number(info.videoBitrate) : Math.max(0, totalBps - audioBps);

  return {
    width: info.width,
    height: info.height,
    duration,
    sizeBytes,
    totalBitrateKbps: Math.round((totalBps / 1000) * 100) / 100,
    videoBitrateKbps: Math.round((videoBps / 1000) * 100) / 100,
    audioBitrateKbps: Math.round((audioBps / 1000) * 100) / 100,
    videoCodec: info.videoCodec || '',
    audioCodec: info.audioCodec || '',
  };
}

/**
 * Decides whether `candidateStats` is a genuine resolution or bitrate upgrade
 * over `currentStats` without allowing accidental resolution downgrades or
 * noisy container muxing churn.
 */
export function evaluateQualityUpgrade(currentStats, candidateStats, options = {}) {
  if (options.force) {
    return { upgrade: true, reason: 'forced' };
  }
  if (!candidateStats || !candidateStats.width || !candidateStats.height) {
    return { upgrade: false, reason: 'invalid_candidate' };
  }

  const curMin = Math.min(currentStats?.width || 0, currentStats?.height || 0);
  const curPixels = (currentStats?.width || 0) * (currentStats?.height || 0);
  const candMin = Math.min(candidateStats.width, candidateStats.height);
  const candPixels = candidateStats.width * candidateStats.height;

  if (candMin < curMin || candPixels < curPixels) {
    return { upgrade: false, reason: 'lower_resolution' };
  }

  if (candMin > curMin || candPixels > curPixels) {
    return { upgrade: true, reason: 'higher_resolution' };
  }

  const minGainRatio = 1 + (options.minBitrateGainPct ?? 5) / 100;
  const curTotal = Number(currentStats?.totalBitrateKbps) || 0;
  const candTotal = Number(candidateStats.totalBitrateKbps) || 0;

  if (curTotal > 0 && candTotal > 0) {
    if (candTotal >= curTotal * minGainRatio) {
      return { upgrade: true, reason: 'higher_bitrate' };
    }

    const curAudio = Number(currentStats?.audioBitrateKbps) || 0;
    const candAudio = Number(candidateStats.audioBitrateKbps) || 0;
    if (
      curAudio > 0 &&
      candAudio >= curAudio * 1.2 &&
      candAudio - curAudio >= 32 &&
      candTotal >= curTotal * 0.97
    ) {
      return { upgrade: true, reason: 'higher_audio_bitrate' };
    }

    return { upgrade: false, reason: 'already_optimal' };
  }

  if (options.allowUnknownRemotePremium && candidateStats.isPremium && !currentStats?.isPremiumFormat) {
    return { upgrade: true, reason: 'premium_format_available' };
  }

  const curSize = Number(currentStats?.sizeBytes) || 0;
  const candSize = Number(candidateStats.sizeBytes) || 0;
  if (curSize > 0 && candSize >= curSize * minGainRatio) {
    return { upgrade: true, reason: 'higher_bitrate' };
  }

  return { upgrade: false, reason: 'already_optimal' };
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function formatDurationShort(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

async function exportBrowserCookiesOnce(browserName, targetFile) {
  const res = await runProcess(
    config.ytdlpPath,
    ['--cookies-from-browser', browserName, '--cookies', targetFile],
    {
      timeoutMs: 20000,
      registerProcess: false,
      rejectOnNonZero: false,
    }
  );
  if (fs.existsSync(targetFile) && fs.statSync(targetFile).size > 0) {
    return { ok: true, stderr: res.stderr || '' };
  }
  return { ok: false, stderr: res.stderr || '' };
}

function runYtDlpWithLiveProgress(cmd, args, silent = false) {
  const MAX_BUFFER = 2 * 1024 * 1024;
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let lastProgressLine = '';

      child.stdout.on('data', (d) => {
        const text = d.toString();
        stdout += text;
        if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER);
        if (!silent) {
          const lines = text.split(/[\r\n]+/);
          for (const line of lines) {
            if (line.includes('[download]') && line.includes('%')) {
              const clean = line.replace(/\[download\]\s*/, '').trim();
              if (clean && clean !== lastProgressLine) {
                lastProgressLine = clean;
                process.stdout.write(`\r     ⏳ [download] ${clean}          `);
              }
            } else if (line.includes('[Merger]') || line.includes('[ffmpeg]')) {
              process.stdout.write('\r     ⚙️ [muxing] Merging highest-bitrate video + audio with ffmpeg...          ');
            }
          }
        }
      });

      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER);
      });

      child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
      child.on('close', (code) => {
        if (!silent) {
          process.stdout.write('\r                                                                                \r');
        }
        resolve({ code, stdout, stderr });
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
    }
  });
}

function readJsonSafe(jsonPath) {
  try {
    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
  } catch (err) {
    void err;
  }
  return null;
}

function resolveRecordArchiveFile(record, archiveRoot, fileMap) {
  if (record.relative_path) {
    const relCandidate = path.join(archiveRoot, record.relative_path);
    if (fs.existsSync(relCandidate)) return relCandidate;
  }
  if (record.channel && record.file_name) {
    const chanCandidate = path.join(archiveRoot, record.channel, record.file_name);
    if (fs.existsSync(chanCandidate)) return chanCandidate;
  }
  const matches = fileMap.get(record.file_name) || [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    for (const candidate of matches) {
      const meta = readJsonSafe(`${candidate}.json`);
      if (
        meta &&
        ((record.media_id && meta.mediaId === record.media_id) ||
          (record.original_url && meta.originalUrl === record.original_url))
      ) {
        return candidate;
      }
    }
    return matches[0];
  }
  return null;
}

/**
 * Scans the SQLite archive index for YouTube videos and upgrades any video where
 * YouTube offers a higher resolution (up to 4K/8K) or higher bitrate (including
 * YouTube Premium 1080p Enhanced Bitrate and 256kbps Opus audio).
 */
export async function upgradeYoutubeArchive(options = {}) {
  const {
    archiveDir = config.archiveDirectory || 'archives',
    dbPath: rawDbPath = config.linkDbPath || 'data/links.db',
    dryRun = false,
    lowResOnly = false,
    force = false,
    limit = 0,
    channelFilter = null,
    urlFilter = null,
    keepBackup = false,
    cookiesFromBrowser = undefined,
    cookiesFile = null,
    noBrowserCookies = false,
    delayMs = 1500,
    maxRes = 0,
    fragments = 4,
    concurrency = 5,
    minBitrateGainPct = 5,
    inspectFn = inspectRemoteBestQuality,
    downloadFn = null,
    probeFn = probeMedia,
    cookieExportFn = null,
    onProgress = null,
    silent = false,
  } = options;

  const workerConcurrency = Math.min(16, Math.max(1, Number(concurrency) || 5));
  const hasCustomInspect = typeof options.inspectFn === 'function';
  const log = silent ? () => {} : (...a) => console.log(...a);
  const warn = silent ? () => {} : (...a) => console.warn(...a);

  const archiveRoot = path.resolve(archiveDir);
  const dbPath = path.resolve(rawDbPath);
  const cookieInfo = resolveUpgradeCookieSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    cookiesFromBrowser,
    cookiesFile,
    noBrowserCookies,
  });

  log('================================================================');
  log('   Archivist Fox — YouTube Resolution & Bitrate Upgrade Tool    ');
  log('================================================================');
  log(`Archive directory:  ${archiveRoot}`);
  log(`Database:           ${dbPath}`);
  log(`Mode:               ${dryRun ? 'DRY-RUN (audit only, no files changed)' : 'LIVE UPGRADE'}`);
  log(`Upgrade scope:      ${lowResOnly ? 'Low-res only (<= 360p)' : 'Highest Resolution + Highest Bitrate (YouTube Premium aware)'}`);
  log(`Max resolution:     ${maxRes > 0 ? `${maxRes}p` : 'Uncapped (Best available: 4K / 8K + Premium Bitrate)'}`);
  log(`Inspect workers:    ${workerConcurrency} parallel metadata checks`);
  log(`Multi-connections:  ${fragments} parallel fragments per stream`);
  if (cookieInfo.type === 'browser') log(`Cookies source:     Browser (${cookieInfo.value})`);
  else if (cookieInfo.type === 'file') log(`Cookies source:     File (${cookieInfo.value})`);
  else log('Cookies source:     None (anonymous — pass -C <browser> or --cookies for YouTube Premium!)');
  if (channelFilter) log(`Filter channel:     ${channelFilter}`);
  if (urlFilter) log(`Filter URL:         ${urlFilter}`);
  if (limit > 0) log(`Limit:              Up to ${limit} videos`);
  log('----------------------------------------------------------------\n');

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  let cookieTempDir = null;

  try {
    log('🔍 Indexing archive files...');
    const fileMap = new Map();
    let totalIndexedFiles = 0;
    function indexDir(dir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            indexDir(full);
          } else if (entry.isFile() && !entry.name.endsWith('.json') && !entry.name.endsWith('.bak')) {
            const list = fileMap.get(entry.name) || [];
            list.push(full);
            fileMap.set(entry.name, list);
            totalIndexedFiles++;
          }
        }
      } catch (err) {
    void err;
  }
    }
    indexDir(archiveRoot);
    log(`Indexed ${totalIndexedFiles} media files in local archive.`);

    const tableCols = new Set(db.prepare('PRAGMA table_info(media_records)').all().map((c) => c.name));
    const hasRelCol = tableCols.has('relative_path');
    const hasSizeCol = tableCols.has('file_size');

    const query = `
      SELECT id, media_id, original_url, title, channel, archived_at, file_name, ${hasRelCol ? 'relative_path,' : 'NULL AS relative_path,'} sha256
      FROM media_records
      WHERE media_id LIKE 'youtube:%' OR original_url LIKE '%youtube.com%' OR original_url LIKE '%youtu.be%'
      ORDER BY archived_at ASC
    `;
    const records = db.prepare(query).all();
    log(`Found ${records.length} YouTube records in database.\n`);

    const matchedEntries = [];
    for (const r of records) {
      if (urlFilter && !String(r.original_url || '').includes(urlFilter)) continue;
      if (channelFilter && r.channel !== channelFilter && !String(r.channel || '').includes(channelFilter)) continue;
      const filePath = resolveRecordArchiveFile(r, archiveRoot, fileMap);
      if (!filePath || !fs.existsSync(filePath)) continue;
      matchedEntries.push({ record: r, filePath });
    }

    // One-shot browser cookie extraction: read Firefox/Chrome/Edge SQLite once instead of N times
    let masterCachedCookieFile = null;
    const workerCookieFiles = [];
    const shouldCacheBrowserCookies =
      cookieInfo.type === 'browser' &&
      matchedEntries.length > 0 &&
      (!hasCustomInspect || typeof cookieExportFn === 'function');

    if (shouldCacheBrowserCookies) {
      cookieTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytdlp-cookies-'));
      const candidateMaster = path.join(cookieTempDir, 'cookies-master.txt');
      try {
        const exporter = cookieExportFn || exportBrowserCookiesOnce;
        const expRes = await exporter(cookieInfo.value, candidateMaster);
        if (expRes?.ok && fs.existsSync(candidateMaster)) {
          masterCachedCookieFile = candidateMaster;
          const poolSize = Math.min(workerConcurrency, matchedEntries.length);
          for (let w = 0; w < poolSize; w++) {
            const wFile = path.join(cookieTempDir, `cookies-worker-${w}.txt`);
            await fs.promises.copyFile(masterCachedCookieFile, wFile);
            workerCookieFiles.push(wFile);
          }
          log(`🍪 Cached ${cookieInfo.value} cookies once for ${poolSize} parallel inspection worker(s).\n`);
        } else if (isCookieLockError({ message: expRes?.stderr || '' })) {
          warn(`  🔒 Browser cookie database is locked (${cookieInfo.value}). Close the browser, use -C firefox, or export cookies/youtube.txt.\n`);
        }
      } catch (cookieErr) {
        if (isCookieLockError(cookieErr)) {
          warn(`  🔒 Browser cookie database is locked (${cookieInfo.value}). Close the browser, use -C firefox, or export cookies/youtube.txt.\n`);
        }
      }
    }

    log(
      lowResOnly
        ? '🔎 Checking which archived YouTube videos are low-res (<= 360p)...'
        : '🔎 Inspecting local quality & checking YouTube for higher resolution or Premium bitrate...'
    );

    const totalToCheck = matchedEntries.length;
    const orderedCandidates = new Array(totalToCheck).fill(null);
    let checkedCount = 0;
    let inspectedCount = 0;
    let alreadyOptimalCount = 0;
    let failedCount = 0;
    let foundCandidatesCount = 0;
    const inspectStartMs = Date.now();
    let lastRenderedLen = 0;

    const clearProgressLine = () => {
      if (silent || lastRenderedLen === 0) return;
      process.stdout.write(`\r${' '.repeat(lastRenderedLen)}\r`);
      lastRenderedLen = 0;
    };

    const renderProgressLine = (label = '') => {
      if (silent || totalToCheck === 0) return;
      const pct = Math.round((checkedCount / totalToCheck) * 100);
      const elapsedSec = (Date.now() - inspectStartMs) / 1000;
      const rate = checkedCount > 0 && elapsedSec > 0 ? checkedCount / elapsedSec : 0;
      const etaText =
        rate > 0 && checkedCount < totalToCheck
          ? ` | ETA ${formatDurationShort((totalToCheck - checkedCount) / rate)}`
          : '';
      const prefix = `  ⏳ [${checkedCount}/${totalToCheck} | ${pct}%] upgrades: ${foundCandidatesCount} | optimal: ${alreadyOptimalCount} | failed: ${failedCount}${etaText}`;
      const maxCols = Math.max(65, (process.stdout.columns || 105) - 2);
      const cleanLabel = String(label || '').replace(/[\r\n\t]+/g, ' ').trim();
      let line = cleanLabel ? `${prefix} — ${cleanLabel}` : prefix;
      if (line.length > maxCols) {
        line = `${line.slice(0, Math.max(20, maxCols - 1))}…`;
      }
      const padded = line.length < lastRenderedLen ? line.padEnd(lastRenderedLen, ' ') : line;
      lastRenderedLen = line.length;
      process.stdout.write(`\r${padded}`);
    };

    let cursor = 0;
    const poolCount = Math.min(workerConcurrency, Math.max(1, totalToCheck));

    const buildWorkerCookieOpts = (workerIdx) => {
      if (workerCookieFiles[workerIdx]) {
        return {
          cookiesFromBrowser: null,
          cookiesFile: workerCookieFiles[workerIdx],
          noBrowserCookies: true,
          impersonateBrowserHint: cookieInfo.value,
        };
      }
      return {
        cookiesFromBrowser,
        cookiesFile,
        noBrowserCookies,
      };
    };

    renderProgressLine(matchedEntries[0]?.record?.title || '');

    const workers = Array.from({ length: poolCount }, async (_, workerIdx) => {
      const workerAuthOpts = buildWorkerCookieOpts(workerIdx);

      while (true) {
        if (limit > 0 && foundCandidatesCount >= limit) break;
        const entryIdx = cursor++;
        if (entryIdx >= totalToCheck) break;

        const { record: r, filePath } = matchedEntries[entryIdx];
        const displayTitle = r.title || path.parse(filePath).name;
        renderProgressLine(displayTitle);

        const localStats = await probeVideoQuality(filePath, probeFn);
        if (!localStats) {
          checkedCount++;
          renderProgressLine(displayTitle);
          onProgress?.({
            checked: checkedCount,
            total: totalToCheck,
            inspectedCount,
            candidatesCount: foundCandidatesCount,
            optimalCount: alreadyOptimalCount,
            failedCount,
            title: displayTitle,
          });
          continue;
        }

        inspectedCount++;
        const minDim = Math.min(localStats.width, localStats.height);
        const sidecar = readJsonSafe(`${filePath}.json`) || {};
        localStats.isPremiumFormat = Boolean(sidecar.isPremiumFormat);

        if (lowResOnly) {
          if (minDim <= 360 || force) {
            orderedCandidates[entryIdx] = {
              record: r,
              filePath,
              localStats,
              sidecar,
              remoteInfo: null,
              reason: 'higher_resolution',
            };
            foundCandidatesCount++;
          } else {
            alreadyOptimalCount++;
          }
          checkedCount++;
          renderProgressLine(displayTitle);
          onProgress?.({
            checked: checkedCount,
            total: totalToCheck,
            inspectedCount,
            candidatesCount: foundCandidatesCount,
            optimalCount: alreadyOptimalCount,
            failedCount,
            title: displayTitle,
          });
          continue;
        }

        // Fast path in live mode: <= 360p or --force does not need an extra remote JSON roundtrip before downloading
        if (!dryRun && (minDim <= 360 || force)) {
          orderedCandidates[entryIdx] = {
            record: r,
            filePath,
            localStats,
            sidecar,
            remoteInfo: null,
            reason: force ? 'forced' : 'higher_resolution',
          };
          foundCandidatesCount++;
          checkedCount++;
          renderProgressLine(displayTitle);
          onProgress?.({
            checked: checkedCount,
            total: totalToCheck,
            inspectedCount,
            candidatesCount: foundCandidatesCount,
            optimalCount: alreadyOptimalCount,
            failedCount,
            title: displayTitle,
          });
          continue;
        }

        try {
          const remoteInfo = await inspectFn(r.original_url, {
            ...workerAuthOpts,
            maxRes,
          });

          if (!remoteInfo || (!remoteInfo.width && !remoteInfo.height)) {
            alreadyOptimalCount++;
          } else if (
            !force &&
            remoteInfo.formatId &&
            sidecar.ytdlpFormatId === remoteInfo.formatId &&
            minDim >= Math.min(remoteInfo.width, remoteInfo.height)
          ) {
            alreadyOptimalCount++;
          } else {
            const decision = evaluateQualityUpgrade(localStats, remoteInfo, {
              force,
              minBitrateGainPct,
              allowUnknownRemotePremium: true,
            });

            if (decision.upgrade) {
              orderedCandidates[entryIdx] = {
                record: r,
                filePath,
                localStats,
                sidecar,
                remoteInfo,
                reason: decision.reason,
              };
              foundCandidatesCount++;
            } else {
              alreadyOptimalCount++;
            }
          }
        } catch (inspectErr) {
          clearProgressLine();
          if (isCookieLockError(inspectErr)) {
            warn(`  🔒 Browser cookie database is locked (${cookieInfo.value}). Close the browser, use -C firefox, or export cookies/youtube.txt.`);
          } else {
            warn(`  ⚠️ Could not inspect remote formats for "${r.title || r.original_url}": ${inspectErr.message}`);
          }
          failedCount++;
        }

        checkedCount++;
        renderProgressLine(displayTitle);
        onProgress?.({
          checked: checkedCount,
          total: totalToCheck,
          inspectedCount,
          candidatesCount: foundCandidatesCount,
          optimalCount: alreadyOptimalCount,
          failedCount,
          title: displayTitle,
        });
      }
    });

    await Promise.all(workers);
    clearProgressLine();

    let candidates = orderedCandidates.filter(Boolean);
    if (limit > 0 && candidates.length > limit) {
      candidates = candidates.slice(0, limit);
    }

    log(`Found ${candidates.length} video(s) eligible for quality/bitrate upgrade (already optimal: ${alreadyOptimalCount}).\n`);

    if (candidates.length === 0) {
      log('✨ All matching YouTube videos in your archive are already at maximum available resolution & bitrate!');
      return {
        totalRecords: records.length,
        inspectedCount,
        candidatesCount: 0,
        upgradedCount: 0,
        skippedCount: alreadyOptimalCount,
        failedCount,
      };
    }

    if (dryRun) {
      log(`📋 [DRY-RUN] The following ${candidates.length} video(s) would be upgraded:\n`);
      candidates.forEach((c, idx) => {
        const displayTitle = c.record.title || path.parse(c.filePath).name;
        const localDesc = `${c.localStats.width}x${c.localStats.height} @ ${Math.round(c.localStats.totalBitrateKbps)} kbps`;
        const remoteDesc = c.remoteInfo
          ? ` -> ${c.remoteInfo.width}x${c.remoteInfo.height} @ ${Math.round(c.remoteInfo.totalBitrateKbps)} kbps [${c.remoteInfo.formatId}${c.remoteInfo.isPremium ? ' 🌟 Premium' : ''}]`
          : '';
        log(`  ${idx + 1}. [${localDesc}${remoteDesc}] [${c.record.channel}] ${displayTitle}`);
        log(`     Reason: ${c.reason} | URL: ${c.record.original_url}`);
        log(`     File:   ${c.filePath}\n`);
      });
      log('To execute this upgrade, re-run without --dry-run');
      return {
        totalRecords: records.length,
        inspectedCount,
        candidatesCount: candidates.length,
        upgradedCount: 0,
        skippedCount: alreadyOptimalCount,
        failedCount,
      };
    }

    const dbBackup = `${dbPath}.upgrade-bak-${Date.now()}`;
    backupDatabaseSafely(db, dbBackup);
    log(`💾 Backed up database to ${dbBackup}\n`);

    const updateMediaStmt =
      hasRelCol && hasSizeCol
        ? db.prepare(`
            UPDATE media_records
            SET sha256 = ?, file_name = ?, relative_path = ?, file_size = ?
            WHERE id = ?
          `)
        : db.prepare(`
            UPDATE media_records
            SET sha256 = ?, file_name = ?
            WHERE id = ?
          `);

    let upgradedCount = 0;
    let skippedAfterDownload = 0;

    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i];
      const { record, filePath, localStats } = item;
      const progressTag = `[${i + 1}/${candidates.length}]`;
      const itemTitle = record.title || path.parse(filePath).name;

      log(
        `\n${progressTag} Upgrading: "${itemTitle}" (${localStats.width}x${localStats.height} @ ${Math.round(localStats.totalBitrateKbps)} kbps)`
      );
      log(`     URL: ${record.original_url}`);

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytdlp-upgrade-'));

      try {
        let newFilePath = null;
        let dlRemoteInfo = item.remoteInfo || null;

        const downloadCookieOpts = masterCachedCookieFile
          ? {
              cookiesFromBrowser: null,
              cookiesFile: masterCachedCookieFile,
              noBrowserCookies: true,
              impersonateBrowserHint: cookieInfo.value,
            }
          : {
              cookiesFromBrowser,
              cookiesFile,
              noBrowserCookies,
            };

        if (downloadFn) {
          const customRes = await downloadFn(record.original_url, tempDir, {
            ...downloadCookieOpts,
            maxRes,
            fragments,
          });
          if (!customRes || customRes.code !== 0 || !customRes.filePath) {
            warn(`     ⚠️ Download failed: ${customRes?.stderr || 'Unknown error'}`);
            failedCount++;
            continue;
          }
          newFilePath = customRes.filePath;
          if (customRes.remoteInfo) dlRemoteInfo = customRes.remoteInfo;
        } else {
          const tempOutputTemplate = path.join(tempDir, 'upgrade_media.%(ext)s');
          const ytdlpArgs = buildUpgradeYtDlpArgs(record.original_url, tempOutputTemplate, {
            ...downloadCookieOpts,
            maxRes,
            fragments,
          });
          ytdlpArgs.push('--write-info-json');

          const dlResult = await runYtDlpWithLiveProgress(config.ytdlpPath, ytdlpArgs, silent);
          if (dlResult.code !== 0) {
            const allLines = dlResult.stderr.trim().split('\n');
            const errLine = allLines.find((l) => l.includes('ERROR:')) || allLines[0] || 'Unknown error';
            if (isCookieLockError({ message: dlResult.stderr })) {
              warn(`     🔒 Browser cookie database locked (${cookieInfo.value}). Close browser or export cookies/youtube.txt.`);
            } else if (dlResult.stderr.includes('Sign in to confirm') || dlResult.stderr.includes('bot')) {
              warn('     🚫 Bot check triggered by YouTube: "Sign in to confirm you\'re not a bot"');
              warn(`        Fix: Ensure ${cookieInfo.value || 'your browser'} is logged into YouTube Premium, or export cookies/youtube.txt`);
            } else {
              warn(`     ⚠️ Download failed: ${errLine}`);
            }
            failedCount++;
            continue;
          }

          const dirEntries = await fs.promises.readdir(tempDir);
          const downloadedFiles = dirEntries
            .filter((f) => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'))
            .map((f) => path.join(tempDir, f));

          if (downloadedFiles.length === 0) {
            warn('     ⚠️ No video file found after download.');
            failedCount++;
            continue;
          }
          newFilePath = downloadedFiles[0];

          const infoJsonName = dirEntries.find((f) => f.endsWith('.info.json'));
          if (infoJsonName) {
            const rawInfo = readJsonSafe(path.join(tempDir, infoJsonName));
            const parsedInfo = parseRemoteFormatInfo(rawInfo);
            if (parsedInfo) dlRemoteInfo = parsedInfo;
          }
        }

        const newStats = await probeVideoQuality(newFilePath, probeFn);
        const postDecision = evaluateQualityUpgrade(localStats, newStats, {
          force,
          minBitrateGainPct,
        });

        if (!postDecision.upgrade) {
          log(
            `     ℹ️ Downloaded stream (${newStats?.width}x${newStats?.height} @ ${Math.round(newStats?.totalBitrateKbps || 0)} kbps) does not exceed current quality. Keeping original.`
          );
          skippedAfterDownload++;
          continue;
        }

        log(
          `     🚀 Upgraded (${postDecision.reason}): ${localStats.width}x${localStats.height} @ ${Math.round(localStats.totalBitrateKbps)} kbps (${formatBytes(localStats.sizeBytes)})` +
            ` -> ${newStats.width}x${newStats.height} @ ${Math.round(newStats.totalBitrateKbps)} kbps (${formatBytes(newStats.sizeBytes)})`
        );

        // Preserve existing archive filename stem so sibling files with identical YouTube titles never collide
        const targetDir = path.dirname(filePath);
        const currentStem = path.parse(filePath).name;
        const newExt = path.extname(newFilePath) || '.mp4';
        const newFileName = `${currentStem}${newExt}`;
        const targetFilePath = path.join(targetDir, newFileName);
        const stagingPath = `${targetFilePath}.upgrade-tmp-${process.pid}-${Date.now()}`;

        // Crash-safe replacement: stage full copy on destination volume BEFORE removing original
        await fs.promises.copyFile(newFilePath, stagingPath);

        if (keepBackup) {
          await fs.promises.copyFile(filePath, `${filePath}.bak`);
        }

        if (path.resolve(filePath) !== path.resolve(targetFilePath)) {
          await fs.promises.unlink(filePath).catch(() => {});
        }

        try {
          await fs.promises.rename(stagingPath, targetFilePath);
        } catch {
          await fs.promises.unlink(targetFilePath).catch(() => {});
          await fs.promises.rename(stagingPath, targetFilePath);
        }

        const finalStat = await fs.promises.stat(targetFilePath);
        const newSha256 = await computeSha256(targetFilePath);
        const relPath = path.relative(archiveRoot, targetFilePath).split(path.sep).join('/');

        // Update sidecar JSON metadata
        const oldMetaPath = `${filePath}.json`;
        const newMetaPath = `${targetFilePath}.json`;
        const metadata = readJsonSafe(oldMetaPath) || {};
        metadata.fileSizeBytes = finalStat.size;
        metadata.sha256 = newSha256;
        metadata.fileName = newFileName;
        metadata.relativePath = relPath;
        metadata.upgradedAt = new Date().toISOString();
        metadata.upgradedResolution = `${newStats.width}x${newStats.height}`;
        metadata.upgradedBitrateKbps = Math.round(newStats.totalBitrateKbps);
        if (dlRemoteInfo?.formatId) {
          metadata.ytdlpFormatId = dlRemoteInfo.formatId;
        }
        if (dlRemoteInfo?.isPremium) {
          metadata.isPremiumFormat = true;
        }

        if (oldMetaPath !== newMetaPath && fs.existsSync(oldMetaPath)) {
          await fs.promises.unlink(oldMetaPath).catch(() => {});
        }
        await fs.promises.writeFile(newMetaPath, JSON.stringify(metadata, null, 2), 'utf8');

        // Update SQLite record
        try {
          if (hasRelCol && hasSizeCol) {
            updateMediaStmt.run(newSha256, newFileName, relPath, finalStat.size, record.id);
          } else {
            updateMediaStmt.run(newSha256, newFileName, record.id);
          }
        } catch (dbErr) {
          warn(`     [DB] Failed to update record ID ${record.id}: ${dbErr.message}`);
        }

        log(`     ✅ Saved upgraded file: ${newFileName}`);
        upgradedCount++;
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }

      if (delayMs > 0 && i < candidates.length - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const totalSkipped = alreadyOptimalCount + skippedAfterDownload;
    log('\n================================================================');
    log('                    Upgrade Summary                             ');
    log('================================================================');
    log(`Videos inspected: ${inspectedCount}`);
    log(`Upgraded:         ${upgradedCount}`);
    log(`Already optimal:  ${totalSkipped}`);
    log(`Failed / unavail: ${failedCount}`);
    log('================================================================\n');

    return {
      totalRecords: records.length,
      inspectedCount,
      candidatesCount: candidates.length,
      upgradedCount,
      skippedCount: totalSkipped,
      failedCount,
    };
  } finally {
    db.close();
    if (cookieTempDir) {
      await fs.promises.rm(cookieTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
