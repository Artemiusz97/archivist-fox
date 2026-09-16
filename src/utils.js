import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * Schedules a bot-sent message for deletion after ERROR_MESSAGE_TTL_SECONDS,
 * if configured. No-ops if the TTL is 0/unset. Failures (message already
 * gone, missing permissions) are swallowed silently.
 */
export function scheduleAutoDelete(message) {
  if (!message || config.errorMessageTtlMs <= 0) return;
  const timer = setTimeout(() => {
    message.delete().catch(() => {});
  }, config.errorMessageTtlMs);
  timer.unref?.();
}

/**
 * Safely kills a process and all its children across OSes.
 * On Windows, uses taskkill /T /F.
 * On POSIX, uses process.kill(-pid) if possible, or standard child.kill().
 * 
 * @param {import('node:child_process').ChildProcess} child
 */
export function killProcessTree(child) {
  if (!child || !child.pid) return;
  
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', child.pid, '/T', '/F'], { stdio: 'ignore' }).on('error', () => {
      // Fallback
      try { child.kill('SIGKILL'); } catch {}
    });
  } else {
    try {
      // Try to kill the process group (if it has its own group)
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

/**
 * Cleans up leftover archivist-fox-* temporary directories in os.tmpdir()
 * older than maxAgeMs (default: 1 hour).
 */
export async function cleanupStaleTempDirs(maxAgeMs = 60 * 60 * 1000) {
  try {
    const tmpDir = os.tmpdir();
    const entries = await fs.promises.readdir(tmpDir, { withFileTypes: true });
    const now = Date.now();
    let cleanedCount = 0;

    for (const entry of entries) {
      if (entry.isDirectory() && (entry.name.startsWith('archivist-fox-') || entry.name.startsWith('archivist-scan-'))) {
        const fullPath = path.join(tmpDir, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.promises.rm(fullPath, { recursive: true, force: true });
            cleanedCount++;
          }
        } catch {}
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Cleaner] Purged ${cleanedCount} stale temporary directories from previous runs.`);
    }
  } catch {}
}

/**
 * Windows NTFS reserved device names that cannot be used as file or folder names.
 * Using them (with or without an extension) causes EINVAL / EPERM OS errors.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Sanitizes a single path segment (filename or folder name) for safe use on
 * Windows NTFS and all other platforms. Handles:
 *   - NTFS-illegal characters: / \ ? % * : | " < > and ASCII control chars (\x00–\x1f)
 *   - Windows reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9) — prefixed with _
 *   - Trailing dots and spaces (NTFS silently strips or rejects them)
 *   - Empty or whitespace-only strings
 *   - Maximum length truncation (default: 100 characters)
 *
 * @param {string} str - Raw filename or folder name to sanitize
 * @param {number} [maxLen=100] - Maximum character length of the result
 * @param {string} [fallback='file'] - Value to use if sanitization yields an empty string
 * @returns {string}
 */
export function sanitizePathSegment(str, maxLen = 100, fallback = 'file') {
  if (!str || typeof str !== 'string') return fallback;

  let s = str
    // Strip NTFS-illegal characters and ASCII control characters
    .replace(/[\x00-\x1f/\\?%*:|"<>]/g, '_')
    // Collapse runs of whitespace to a single space
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return fallback;

  // Detect and prefix Windows reserved device names (case-insensitive, with or without extension)
  const upperBase = s.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(upperBase)) {
    s = `_${s}`;
  }

  // Remove trailing dots and spaces (NTFS rejects filenames ending with '.' or ' ')
  s = s.replace(/[. ]+$/, '');

  if (!s) return fallback;

  // Truncate to max length
  return s.slice(0, maxLen) || fallback;
}

/**
 * Generates a randomized human jitter delay (in ms) between minMs and maxMs.
 * Adds natural micro-variance to mimic human pacing and prevent burst detection.
 */
export function getHumanJitterMs(minMs = 1500, maxMs = 3500) {
  const min = Math.max(100, minMs);
  const max = Math.max(min, maxMs);
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Returns a standard modern desktop User-Agent string corresponding to the
 * requested browser family (firefox, chrome, edge, safari).
 */
export function getBrowserUserAgent(browserType = 'chrome') {
  const b = (browserType || '').toLowerCase();
  if (b.includes('firefox')) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0';
  }
  if (b.includes('edge')) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0';
  }
  if (b.includes('safari') && !b.includes('chrome')) {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';
  }
  // Default to modern Chrome
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
}
