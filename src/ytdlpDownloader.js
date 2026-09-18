import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { mergeOrphanedAudioVideo } from './streamMerge.js';
import { getCookieForUrl } from './cookieVault.js';
import { killProcessTree, getBrowserUserAgent } from './utils.js';
import { isAudioUrl } from './urlExtractor.js';

const TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes (allows buffer for large downloads and rate-limits)

/**
 * Uses yt-dlp to download media from a platform link (Twitter/X, TikTok,
 * Instagram, Reddit, etc). Returns an array of downloaded file paths.
 * yt-dlp handles the size cap itself via --max-filesize.
 */
export async function downloadWithYtDlp(url, destDir, options = {}) {
  await fs.promises.mkdir(destDir, { recursive: true });

  // Cap at the hard cap here, not the target upload size: if the file comes
  // in over the target we still want the bytes on disk so compress.js has
  // something to shrink. The target-size check happens after download.
  const hardCapMB = Math.max(1, Math.floor(config.hardCapBytes / (1024 * 1024)));
  // Use the post/video's actual full title for the filename, Windows-safe without stripping Unicode or spaces
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
      // Priority order:
      //  1. Native MP4+M4A streams — zero remux, fully Discord-compatible
      //  2. Best video + best audio (any container) merged via ffmpeg
      //  3. Best pre-merged single stream (e.g. platforms with no separate streams)
      '-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b',
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

  // --- Caption / Subtitle Extraction ---
  if (config.enableSubtitles && (url.includes('youtube.com') || url.includes('youtu.be'))) {
    if (config.subtitleSource === 'all') {
      args.push('--write-sub', '--write-auto-subs');
    } else {
      args.push('--write-sub');
    }
    args.push('--sub-langs', config.subtitleLangs || 'all');
    args.push('--convert-subs', config.subtitleFormat || 'srt');
  }

  if (config.ffmpegPath && fs.existsSync(config.ffmpegPath)) {
    args.push('--ffmpeg-location', config.ffmpegPath);
  }

  // Resolve browser impersonation & User-Agent
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

  // Set aligned User-Agent
  const activeBrowserType = !isImpersonateDisabled ? impersonateTarget : config.cookiesFromBrowser || 'chrome';
  args.push('--user-agent', getBrowserUserAgent(activeBrowserType));

  const cookiePath = getCookieForUrl(url);
  if (config.cookiesFromBrowser) {
    const isYoutube = /youtube\.com|youtu\.be/i.test(url);
    if (config.preferBrowserCookies || isYoutube || !cookiePath || !fs.existsSync(cookiePath)) {
      args.push('--cookies-from-browser', config.cookiesFromBrowser);
    } else {
      args.push('--cookies', cookiePath);
    }
  } else if (cookiePath && fs.existsSync(cookiePath)) {
    args.push('--cookies', cookiePath);
  }

  await runProcess(config.ytdlpPath, args);

  const files = await fs.promises.readdir(destDir);
  if (files.length === 0) {
    throw new Error('YTDLP_NO_MEDIA_FOUND');
  }

  const filePaths = files.map((f) => path.join(destDir, f));

  // If media files exist, filter out any leftover loose thumbnail image files
  const mediaExtensions = new Set([
    '.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v',
    '.mp3', '.m4a', '.opus', '.ogg', '.flac', '.wav', '.aac', '.alac', '.aiff'
  ]);
  const mediaFiles = filePaths.filter((f) => mediaExtensions.has(path.extname(f).toLowerCase()));
  const subtitleFiles = filePaths.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return ext === '.srt' || ext === '.vtt' || ext === '.ass';
  });

  const candidateFiles = mediaFiles.length > 0 ? mediaFiles : filePaths;
  const mergedMedia = await mergeOrphanedAudioVideo(candidateFiles, destDir);

  return { mediaFiles: mergedMedia, subtitleFiles };
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error(`TIMEOUT: ${cmd} took too long`));
    }, TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(`COMMAND_NOT_FOUND: ${cmd} is not installed or not on PATH`));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function runProcessWithStdout(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error(`TIMEOUT: ${cmd} took too long`));
    }, 30000); // Shorter timeout for flat playlist extraction

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(`COMMAND_NOT_FOUND: ${cmd} is not installed or not on PATH`));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

/**
 * Extracts flat playlist metadata without downloading media.
 */
export async function fetchFlatPlaylistInfo(url, maxItems = 25) {
  const args = [
    url,
    '--flat-playlist',
    '--playlist-end', `${maxItems}`,
    '--dump-single-json',
    '--no-warnings',
    '--no-check-certificates',
    '--js-runtimes', 'node',
  ];

  // Apply impersonation/cookies exactly like the download pipeline
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
  const isImpersonateDisabled = !impersonateTarget || ['off', 'none', 'false'].includes(impersonateTarget);
  if (!isImpersonateDisabled) {
    args.push('--impersonate', impersonateTarget);
  }
  const activeBrowserType = !isImpersonateDisabled ? impersonateTarget : config.cookiesFromBrowser || 'chrome';
  args.push('--user-agent', getBrowserUserAgent(activeBrowserType));

  const cookiePath = getCookieForUrl(url);
  if (config.cookiesFromBrowser) {
    if (config.preferBrowserCookies || !cookiePath || !fs.existsSync(cookiePath)) {
      args.push('--cookies-from-browser', config.cookiesFromBrowser);
    } else {
      args.push('--cookies', cookiePath);
    }
  } else if (cookiePath && fs.existsSync(cookiePath)) {
    args.push('--cookies', cookiePath);
  }

  const output = await runProcessWithStdout(config.ytdlpPath, args);
  try {
    return JSON.parse(output.trim());
  } catch (err) {
    throw new Error('Failed to parse yt-dlp playlist JSON');
  }
}
