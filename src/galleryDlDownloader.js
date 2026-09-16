import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { getGalleryDlConfigPath } from './galleryDlConfig.js';
import { getCookieForUrl } from './cookieVault.js';
import { killProcessTree, getBrowserUserAgent } from './utils.js';

const TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes (allows buffer for platform rate-limit waits)

/**
 * Uses gallery-dl to download image(s) from a platform link (Twitter/X,
 * Instagram, Reddit, Tumblr, Pixiv, etc). gallery-dl is built for image
 * galleries, unlike yt-dlp which targets video. Returns an array of
 * downloaded file paths.
 */
export async function downloadWithGalleryDl(url, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });

  const hardCapMB = Math.max(1, Math.floor(config.hardCapBytes / (1024 * 1024)));

  const activeBrowser = config.cookiesFromBrowser || 'chrome';
  const args = [
    '-d', destDir,
    '--no-mtime',
    '--no-check-certificate',
    '--filesize-max', `${hardCapMB}M`,
    '--user-agent', getBrowserUserAgent(activeBrowser),
  ];

  const cookiePath = getCookieForUrl(url);
  if (config.cookiesFromBrowser && (config.preferBrowserCookies || !cookiePath || !fs.existsSync(cookiePath))) {
    args.push('--cookies-from-browser', config.cookiesFromBrowser);
  } else if (cookiePath && fs.existsSync(cookiePath)) {
    args.push('--cookies', cookiePath);
  } else if (config.cookiesFromBrowser) {
    args.push('--cookies-from-browser', config.cookiesFromBrowser);
  }

  const gdlConfigPath = await getGalleryDlConfigPath();
  if (gdlConfigPath) {
    args.push('-c', gdlConfigPath);
  }

  args.push(url);

  if (config.usePythonGalleryDl) {
    await runProcess('python3', ['-m', 'gallery_dl', ...args]);
  } else {
    await runProcess(config.gallerydlPath, args);
  }

  const files = await walkFiles(destDir);
  if (files.length === 0) {
    throw new Error('GALLERYDL_NO_MEDIA_FOUND');
  }

  return files;
}

// gallery-dl nests downloads in site/user subdirectories by default, so we
// walk the whole tree rather than assuming a flat structure.
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
