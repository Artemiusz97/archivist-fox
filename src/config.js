import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { BOT_VERSION } from './version.js';

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}

function resolveBinaryPath(envVal, defaultName) {
  if (envVal) return envVal;

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, defaultName),
    path.join(cwd, `${defaultName}.exe`),
    path.join(cwd, `${defaultName}.bin`),
    path.join(cwd, 'bin', defaultName),
    path.join(cwd, 'bin', `${defaultName}.exe`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return defaultName;
}

export const config = {
  version: BOT_VERSION,
  token: process.env.DISCORD_TOKEN
    ? process.env.DISCORD_TOKEN.trim().replace(/^["']|["']$/g, '')
    : undefined,
  allowedChannelIds: (process.env.ALLOWED_CHANNEL_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  disallowedChannelIds: (process.env.DISALLOWED_CHANNEL_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_MB || 10) * 1024 * 1024,
  // Upper bound for what we'll download at all when attempting to compress
  // an over-limit video down to size. Prevents runaway downloads of huge files.
  hardCapBytes: Number(process.env.HARD_CAP_MB || 2000) * 1024 * 1024,
  enableCompression: parseBool(process.env.ENABLE_COMPRESSION, true),
  cleanupTempFiles: parseBool(process.env.CLEANUP_TEMP_FILES, true),
  embedThumbnail: parseBool(process.env.EMBED_THUMBNAIL, true),
  prependThumbnailPreview: parseBool(process.env.PREPEND_THUMBNAIL_PREVIEW, true),
  
  // Audio Extraction & Processing Options
  enableAudioExtraction: parseBool(process.env.ENABLE_AUDIO_EXTRACTION, true),
  audioFormat: (process.env.AUDIO_FORMAT || 'mp3').toLowerCase().trim(),
  audioQuality: process.env.AUDIO_QUALITY || '0', // 0 = best VBR for yt-dlp
  maxAudioBitrateKbps: Math.max(32, Number(process.env.MAX_AUDIO_BITRATE_KBPS || 320)),

  ytdlpPath: resolveBinaryPath(process.env.YTDLP_PATH, 'yt-dlp'),
  gallerydlPath: resolveBinaryPath(process.env.GALLERYDL_PATH, 'gallery-dl'),
  usePythonGalleryDl: false,
  // Optional: authenticate gallery-dl against Reddit's real API instead of
  // scraping pages, to avoid Reddit's "blocked by network security" wall.
  // See https://gdl-org.github.io/docs/configuration.html#extractor-reddit-client-id-user-agent
  redditClientId: process.env.REDDIT_CLIENT_ID || '',
  redditUserAgent: process.env.REDDIT_USER_AGENT || '',
  redditRefreshToken: process.env.REDDIT_REFRESH_TOKEN || '',
  // How long (ms) to leave error/status messages up before auto-deleting them. 0 = never delete.
  errorMessageTtlMs: Number(process.env.ERROR_MESSAGE_TTL_SECONDS || 0) * 1000,
  // Text command to retry a link: reply to the message containing the link and send this.
  retryCommand: process.env.RETRY_COMMAND || '!repost',
  // Text command to re-scan/crawl channels for media archiving.
  rescanCommand: process.env.RESCAN_COMMAND || '!rescan',
  // Optional: cookies file for Instagram, YouTube, etc. login-restricted content.
  // Automatically defaults to a cookies.txt file in the root folder if present.
  cookiesPath: process.env.COOKIES_FILE_PATH
    ? process.env.COOKIES_FILE_PATH
    : fs.existsSync(path.join(process.cwd(), 'cookies.txt'))
      ? path.join(process.cwd(), 'cookies.txt')
      : null,
  // Optional: Read cookies directly from an installed browser (e.g. "firefox", "chrome", "edge", "brave")
  cookiesFromBrowser: (process.env.COOKIES_FROM_BROWSER || '').trim(),
  // Prefer browser cookies over static cookies/*.txt files when cookiesFromBrowser is enabled
  preferBrowserCookies: parseBool(process.env.PREFER_BROWSER_COOKIES, false),
  // Anti-Bot & Scraper Hardening (auto = match cookiesFromBrowser or chrome; off = disabled)
  impersonateBrowser: (process.env.IMPERSONATE_BROWSER || 'auto').toLowerCase().trim(),
  enableHumanJitter: parseBool(process.env.ENABLE_HUMAN_JITTER, true),
  humanJitterMinMs: Math.max(200, Number(process.env.HUMAN_JITTER_MIN_MS || 1500)),
  humanJitterMaxMs: Math.max(
    Math.max(200, Number(process.env.HUMAN_JITTER_MIN_MS || 1500)),
    Number(process.env.HUMAN_JITTER_MAX_MS || 3500)
  ),
  instagramUsername: process.env.INSTAGRAM_USERNAME || '',
  instagramPassword: process.env.INSTAGRAM_PASSWORD || '',
  ffmpegPath: resolveBinaryPath(process.env.FFMPEG_PATH, 'ffmpeg'),
  ffprobePath: resolveBinaryPath(process.env.FFPROBE_PATH, 'ffprobe'),
  // Local high-quality archiving configuration
  enableLocalArchive: parseBool(process.env.ENABLE_LOCAL_ARCHIVE, true),
  archiveDirectory: process.env.ARCHIVE_DIRECTORY || path.join(process.cwd(), 'archives'),
  archiveSaveMetadata: parseBool(process.env.ARCHIVE_SAVE_METADATA, true),
  // Perceptual hashing and duplicate prevention settings
  enableDuplicatePrevention: parseBool(process.env.ENABLE_DUPLICATE_PREVENTION, true),
  duplicateThreshold: Number(process.env.DUPLICATE_HAMMING_THRESHOLD || 5),
  // Performance and Media Processing configuration
  gpuAcceleration: (process.env.GPU_ACCELERATION || 'auto').toLowerCase().trim(),
  enableAutoUpdateBinaries: parseBool(process.env.ENABLE_AUTO_UPDATE_BINARIES, true),
  autoUpdateIntervalHours: Math.max(1, Number(process.env.AUTO_UPDATE_INTERVAL_HOURS || 24)),
  maxConcurrentDownloads: Math.max(1, Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2)),
  scannerConcurrency: Math.max(1, Number(process.env.SCANNER_CONCURRENCY || process.env.MAX_CONCURRENT_DOWNLOADS || 3)),
  cookiesDir: path.join(process.cwd(), 'cookies'),
  // UX & Storage Enhancements
  autoSuppressEmbeds: parseBool(process.env.AUTO_SUPPRESS_EMBEDS, true),
  includeTitleInMessage: parseBool(process.env.INCLUDE_TITLE_IN_MESSAGE, true),
  archiveSubfolderFormat: (process.env.ARCHIVE_SUBFOLDER_FORMAT || 'channel/date').toLowerCase().trim(),
  // General Duplicate Link Detector configuration (SQLite)
  enableGeneralDuplicateDetector: parseBool(process.env.ENABLE_GENERAL_DUPLICATE_DETECTOR, true),
  duplicateLinkScope: (process.env.DUPLICATE_LINK_SCOPE || 'channel').toLowerCase().trim(),
  duplicateLinkRetentionDays: Math.max(0, Number(process.env.DUPLICATE_LINK_RETENTION_DAYS || 0)),
  selfRepostGraceSeconds: Math.max(0, Number(process.env.SELF_REPOST_GRACE_SECONDS || 300)),
  duplicateLinkAlertTtlSeconds: Math.max(0, Number(process.env.DUPLICATE_LINK_ALERT_TTL_SECONDS || 0)),
  linkDbPath: process.env.LINK_DB_PATH || path.join(process.cwd(), 'data', 'links.db'),
  // Startup Automatic History Catch-Up Scan configuration
  autoScanOnStartup: parseBool(process.env.AUTO_SCAN_ON_STARTUP, true),
  autoScanHours: Math.max(1, Number(process.env.AUTO_SCAN_HOURS || 24)),
  autoScanRepostMissing: parseBool(process.env.AUTO_SCAN_REPOST_MISSING, true),
  autoScanConcurrency: Math.max(
    1,
    Number(process.env.AUTO_SCAN_CONCURRENCY || process.env.SCANNER_CONCURRENCY || 3)
  ),
  // Maximum number of tasks allowed in the download queue at once.
  // If the queue is saturated, new tasks are rejected with a polite notice.
  maxQueueDepth: Math.max(5, Number(process.env.MAX_QUEUE_DEPTH || 50)),
  // YouTube Playlist Support Configuration
  enablePlaylistDownload: parseBool(process.env.ENABLE_PLAYLIST_DOWNLOAD, true),
  maxPlaylistItems: Math.max(1, Number(process.env.MAX_PLAYLIST_ITEMS || 25)),
  playlistAutoThread: parseBool(process.env.PLAYLIST_AUTO_THREAD, true),
  playlistPromptTimeoutSeconds: Math.max(10, Number(process.env.PLAYLIST_PROMPT_TIMEOUT_SECONDS || 30)),

  // Subtitle/Caption Extraction
  enableSubtitles: parseBool(process.env.ENABLE_SUBTITLES, true),
  uploadSubtitlesToDiscord: parseBool(process.env.UPLOAD_SUBTITLES_TO_DISCORD, false),
  subtitleSource: process.env.SUBTITLE_SOURCE || 'creator', // 'creator' or 'all'
  subtitleLangs: process.env.SUBTITLE_LANGS || 'all',
  subtitleFormat: process.env.SUBTITLE_FORMAT || 'srt',
  zipMultiSubtitles: parseBool(process.env.ZIP_MULTI_SUBTITLES, true),
  maxIndividualSubtitles: Math.max(1, Number(process.env.MAX_INDIVIDUAL_SUBTITLES || 3)),
};

export function isChannelAllowed(channelId) {
  // Allow-list takes priority: if set, ONLY those channels are active.
  if (config.allowedChannelIds.length > 0) {
    return config.allowedChannelIds.includes(channelId);
  }
  // Otherwise, deny-list: every channel is active EXCEPT these.
  if (config.disallowedChannelIds.length > 0) {
    return !config.disallowedChannelIds.includes(channelId);
  }
  return true;
}

if (!config.token) {
  console.error('Missing DISCORD_TOKEN in your .env file. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

if (config.allowedChannelIds.length > 0 && config.disallowedChannelIds.length > 0) {
  console.warn(
    'Both ALLOWED_CHANNEL_IDS and DISALLOWED_CHANNEL_IDS are set — ALLOWED_CHANNEL_IDS takes priority and DISALLOWED_CHANNEL_IDS will be ignored.'
  );
}

// ─── Startup Config Sanity Checks ────────────────────────────────────────────

// Warn if the target upload size exceeds the hard download cap: yt-dlp will
// reject files before they can ever reach compress.js for size reduction.
if (config.maxFileSizeBytes > config.hardCapBytes) {
  console.warn(
    `[Config] Warning: MAX_FILE_SIZE_MB (${Math.round(config.maxFileSizeBytes / 1024 / 1024)} MB) is greater than ` +
    `HARD_CAP_MB (${Math.round(config.hardCapBytes / 1024 / 1024)} MB). ` +
    'yt-dlp will reject downloads larger than HARD_CAP_MB before compress.js can shrink them. ' +
    'Consider raising HARD_CAP_MB or lowering MAX_FILE_SIZE_MB.'
  );
}

// Warn if duplicate perceptual hash threshold is out of the sensible 0–20 range
if (config.duplicateThreshold < 0 || config.duplicateThreshold > 20) {
  console.warn(
    `[Config] Warning: DUPLICATE_HAMMING_THRESHOLD is set to ${config.duplicateThreshold}. ` +
    'Recommended range is 0 (exact match only) to 20. Values above 20 may produce false-positive duplicate detections.'
  );
}

// Validate and filter Discord snowflake IDs (17–20 digit numeric strings)
const SNOWFLAKE_RE = /^\d{17,20}$/;
const invalidAllowed = config.allowedChannelIds.filter((id) => !SNOWFLAKE_RE.test(id));
const invalidDisallowed = config.disallowedChannelIds.filter((id) => !SNOWFLAKE_RE.test(id));

if (invalidAllowed.length > 0) {
  console.warn(
    `[Config] Warning: ALLOWED_CHANNEL_IDS contains non-snowflake value(s) that will be ignored: ${invalidAllowed.join(', ')}`
  );
  config.allowedChannelIds = config.allowedChannelIds.filter((id) => SNOWFLAKE_RE.test(id));
}

if (invalidDisallowed.length > 0) {
  console.warn(
    `[Config] Warning: DISALLOWED_CHANNEL_IDS contains non-snowflake value(s) that will be ignored: ${invalidDisallowed.join(', ')}`
  );
  config.disallowedChannelIds = config.disallowedChannelIds.filter((id) => SNOWFLAKE_RE.test(id));
}
