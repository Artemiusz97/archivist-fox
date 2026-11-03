import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { mergeOrphanedAudioVideo } from './streamMerge.js';
import { getCookieForUrl } from './cookieVault.js';
import {
  getBrowserUserAgent,
  runProcess,
  isPartialTempFile,
  isCookieLockError,
  purgeTempDownloadArtifacts,
  isAbortError,
} from './utils.js';
import { isAudioUrl, checkNsfwInMetadata } from './urlExtractor.js';

const TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes (allows buffer for large downloads and rate-limits)

/**
 * Builds shared browser-impersonation, User-Agent, and cookie authentication
 * CLI flags for `yt-dlp` (shared between single downloads and playlist fetches).
 *
 * @param {string} url
 * @param {{ disableBrowserCookies?: boolean }} [options={}]
 * @returns {string[]}
 */
export function buildYtDlpAuthArgs(url, options = {}) {
  const args = [];

  let impersonateTarget = config.impersonateBrowser;
  if (impersonateTarget === 'auto') {
    if (config.cookiesFromBrowser) {
      const lower = config.cookiesFromBrowser.toLowerCase();
      if (lower.includes('firefox')) impersonateTarget = 'firefox';
      else if (lower.includes('edge')) impersonateTarget = 'edge';
      else if (lower.includes('safari')) impersonateTarget = 'safari';
      else impersonateTarget = 'chrome';
    } else {
      impersonateTarget = 'chrome';
    }
  }

  const isImpersonateDisabled =
    !impersonateTarget ||
    impersonateTarget === 'off' ||
    impersonateTarget === 'none' ||
    impersonateTarget === 'false';

  if (!isImpersonateDisabled) {
    args.push('--impersonate', impersonateTarget);
  }

  const activeBrowserType = !isImpersonateDisabled ? impersonateTarget : config.cookiesFromBrowser || 'chrome';
  args.push('--user-agent', getBrowserUserAgent(activeBrowserType));

  const cookiePath = getCookieForUrl(url);
  const allowBrowserCookies = Boolean(config.cookiesFromBrowser && !options.disableBrowserCookies);
  if (allowBrowserCookies) {
    const isYoutube = /youtube\.com|youtu\.be/i.test(url);
    if (config.preferBrowserCookies || isYoutube || !cookiePath || !fs.existsSync(cookiePath)) {
      args.push('--cookies-from-browser', config.cookiesFromBrowser);
    } else {
      args.push('--cookies', cookiePath);
    }
  } else if (cookiePath && fs.existsSync(cookiePath)) {
    args.push('--cookies', cookiePath);
  }

  return args;
}

/**
 * Builds the complete `yt-dlp` CLI argument array for a media URL.
 * Supports original titles, thumbnails, and English-by-default subtitle extraction
 * across YouTube and all other video platforms supported by `yt-dlp`.
 *
 * @param {string} url
 * @param {string} destDir
 * @param {object} [options={}]
 * @returns {string[]}
 */
export function buildYtDlpArgs(url, destDir, options = {}) {
  const hardCapMB = Math.max(1, Math.floor(config.hardCapBytes / (1024 * 1024)));
  const outputTemplate = path.join(destDir, '%(title).150s.%(ext)s');

  const args = [
    url,
    '-o', outputTemplate,
    '--no-playlist',
    '--windows-filenames',
    '--no-check-certificates',
    '--no-warnings',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=web,default',
    '--max-filesize', `${hardCapMB}M`,
    '--write-info-json',
  ];

  const shouldExtractAudio = config.enableAudioExtraction && (options.extractAudio || isAudioUrl(url));

  if (shouldExtractAudio) {
    args.push(
      '--extract-audio',
      '--audio-format', config.audioFormat || 'mp3',
      '--audio-quality', config.audioQuality || '0',
      '--embed-metadata'
    );
    if (config.embedThumbnail) {
      args.push('--embed-thumbnail');
    }
  } else {
    args.push(
      '-f', 'bv*+ba/b',
      '-S', 'res,br,fps',
      '--merge-output-format', 'mp4'
    );
    if (config.embedThumbnail) {
      args.push('--embed-thumbnail');
    }
    if (config.prependThumbnailPreview) {
      args.push('--write-thumbnail');
    }
    if (config.embedThumbnail || config.prependThumbnailPreview) {
      args.push('--convert-thumbnails', 'jpg');
    }
  }

  // Universal Caption / Subtitle Extraction (English default across all video sites)
  if (config.enableSubtitles && !shouldExtractAudio) {
    if (config.subtitleSource === 'all') {
      args.push('--write-sub', '--write-auto-subs');
    } else {
      args.push('--write-sub');
    }
    args.push('--sub-langs', config.subtitleLangs || 'en.*,en');
    args.push('--convert-subs', config.subtitleFormat || 'srt');
  }

  if (options.sleepRequests) {
    args.push('--sleep-requests', String(options.sleepRequests));
  }

  if (config.ffmpegPath && fs.existsSync(config.ffmpegPath)) {
    args.push('--ffmpeg-location', config.ffmpegPath);
  }

  args.push(...buildYtDlpAuthArgs(url, options));
  return args;
}

/**
 * Uses yt-dlp to download media from a platform link (YouTube, Twitter/X, TikTok,
 * Instagram, Reddit, Vimeo, etc).
 */
export async function downloadWithYtDlp(url, destDir, options = {}) {
  if (options?.signal?.aborted) {
    throw new Error('DOWNLOAD_ABORTED');
  }

  await fs.promises.mkdir(destDir, { recursive: true });

  const runDl = async (extraOpts = {}) => {
    const combinedOpts = { ...options, ...extraOpts };
    const args = buildYtDlpArgs(url, destDir, combinedOpts);
    return runProcess(config.ytdlpPath, args, {
      timeoutMs: TIMEOUT_MS,
      signal: options?.signal,
    });
  };

  try {
    await runDl();
  } catch (err) {
    if (options?.signal?.aborted || isAbortError(err)) throw err;
    if (config.cookiesFromBrowser && isCookieLockError(err) && !options.disableBrowserCookies) {
      console.warn('[yt-dlp] Browser cookie database locked; retrying without browser cookies...');
      await purgeTempDownloadArtifacts(destDir);
      await runDl({ disableBrowserCookies: true });
    } else {
      throw err;
    }
  }

  const files = await fs.promises.readdir(destDir);
  if (files.length === 0) {
    throw new Error('YTDLP_NO_MEDIA_FOUND');
  }

  const filePaths = files.map((f) => path.join(destDir, f));

  const mediaExtensions = new Set([
    '.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.gif',
    '.mp3', '.m4a', '.opus', '.ogg', '.flac', '.wav', '.aac', '.alac', '.aiff',
  ]);
  const mediaFiles = filePaths.filter(
    (f) => mediaExtensions.has(path.extname(f).toLowerCase()) && !isPartialTempFile(f)
  );
  const subtitleFiles = filePaths.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return ext === '.srt' || ext === '.vtt' || ext === '.ass';
  });
  const subtitleSet = new Set(subtitleFiles);

  const candidateFiles =
    mediaFiles.length > 0
      ? mediaFiles
      : filePaths.filter((f) => !f.endsWith('.json') && !subtitleSet.has(f) && !isPartialTempFile(f));
  const mergedMedia = await mergeOrphanedAudioVideo(candidateFiles, destDir);

  let isNsfw = false;
  let isOriginalGif = false;
  const jsonFiles = filePaths.filter((f) => f.endsWith('.info.json') || f.endsWith('.json'));
  for (const jsonPath of jsonFiles) {
    try {
      const raw = await fs.promises.readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (checkNsfwInMetadata(parsed)) {
        isNsfw = true;
      }
      if (
        parsed.is_gif === true ||
        (parsed.extractor_key === 'Twitter' && parsed.duration && parsed.duration <= 6 && (!parsed.acodec || parsed.acodec === 'none')) ||
        (parsed.webpage_url && parsed.webpage_url.includes('/tweet_video/'))
      ) {
        isOriginalGif = true;
      }
    } catch {}
  }

  return { mediaFiles: mergedMedia, subtitleFiles, isNsfw, isOriginalGif };
}

/**
 * Extracts flat playlist metadata without downloading media.
 */
export async function fetchFlatPlaylistInfo(url, maxItems = 25, options = {}) {
  const args = [
    url,
    '--flat-playlist',
    '--playlist-end', `${maxItems}`,
    '--dump-single-json',
    '--no-warnings',
    '--no-check-certificates',
    '--js-runtimes', 'node',
    ...buildYtDlpAuthArgs(url),
  ];

  const execFn = options?.execFn || runProcess;
  const { stdout } = await execFn(config.ytdlpPath, args, {
    timeoutMs: 30000,
    signal: options?.signal,
    maxBufferBytes: 32 * 1024 * 1024,
    rollingBuffer: false,
  });

  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error('Failed to parse yt-dlp playlist JSON');
  }
}
