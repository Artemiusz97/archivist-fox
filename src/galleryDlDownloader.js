import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getGalleryDlConfigPath } from './galleryDlConfig.js';
import { getCookieForUrl } from './cookieVault.js';
import {
  getBrowserUserAgent,
  runProcess,
  PYTHON_BIN,
  isPartialTempFile,
  isCookieLockError,
  purgeTempDownloadArtifacts,
  isAbortError,
} from './utils.js';
import { checkNsfwInMetadata } from './urlExtractor.js';

const TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes (allows buffer for platform rate-limit waits)

/**
 * Uses gallery-dl to download image(s) from a platform link (Twitter/X,
 * Instagram, Reddit, Tumblr, Pixiv, etc). Returns an array of downloaded
 * file paths with `mediaFiles` and `isNsfw` properties attached.
 */
export async function downloadWithGalleryDl(url, destDir, options = {}) {
  if (options?.signal?.aborted) {
    throw new Error('DOWNLOAD_ABORTED');
  }

  await fs.promises.mkdir(destDir, { recursive: true });

  const hardCapMB = Math.max(1, Math.floor(config.hardCapBytes / (1024 * 1024)));

  const activeBrowser = config.cookiesFromBrowser || 'chrome';
  const gdlConfigPath = await getGalleryDlConfigPath();

  const buildArgs = (disableBrowserCookies = false) => {
    const args = [
      '-d', destDir,
      '--no-mtime',
      '--no-check-certificate',
      '--filesize-max', `${hardCapMB}M`,
      '--user-agent', getBrowserUserAgent(activeBrowser),
      '--write-metadata',
    ];

    const cookiePath = getCookieForUrl(url);
    const allowBrowser = Boolean(config.cookiesFromBrowser && !disableBrowserCookies);
    if (allowBrowser && (config.preferBrowserCookies || !cookiePath || !fs.existsSync(cookiePath))) {
      args.push('--cookies-from-browser', config.cookiesFromBrowser);
    } else if (cookiePath && fs.existsSync(cookiePath)) {
      args.push('--cookies', cookiePath);
    }

    if (gdlConfigPath) {
      args.push('-c', gdlConfigPath);
    }
    args.push(url);
    return args;
  };

  const executeGalleryDl = async (disableBrowserCookies = false) => {
    const args = buildArgs(disableBrowserCookies);
    if (config.usePythonGalleryDl) {
      return runProcess(PYTHON_BIN, ['-m', 'gallery_dl', ...args], {
        timeoutMs: TIMEOUT_MS,
        signal: options?.signal,
      });
    }
    return runProcess(config.gallerydlPath, args, {
      timeoutMs: TIMEOUT_MS,
      signal: options?.signal,
    });
  };

  try {
    await executeGalleryDl(false);
  } catch (err) {
    if (options?.signal?.aborted || isAbortError(err)) throw err;
    if (config.cookiesFromBrowser && isCookieLockError(err)) {
      console.warn('[gallery-dl] Browser cookie database locked; retrying without browser cookies...');
      await purgeTempDownloadArtifacts(destDir);
      await executeGalleryDl(true);
    } else {
      throw err;
    }
  }

  const allFiles = await walkFiles(destDir);
  const jsonFiles = allFiles.filter((f) => f.endsWith('.json'));
  const mediaFiles = allFiles.filter(
    (f) => !f.endsWith('.json') && !f.endsWith('.txt') && !isPartialTempFile(f)
  );

  if (mediaFiles.length === 0) {
    throw new Error('GALLERYDL_NO_MEDIA_FOUND');
  }

  let isNsfw = false;
  for (const jsonPath of jsonFiles) {
    try {
      const raw = await fs.promises.readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (checkNsfwInMetadata(parsed)) {
        isNsfw = true;
        break;
      }
    } catch {}
  }

  return Object.assign(mediaFiles, { mediaFiles, isNsfw });
}

async function walkFiles(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}
