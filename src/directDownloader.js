import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { sanitizePathSegment } from './utils.js';

const MIME_EXTENSION_MAP = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
};

function inferExtensionFromContentType(contentType) {
  if (!contentType) return null;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return MIME_EXTENSION_MAP[mime] || null;
}

/**
 * Downloads a direct media URL (e.g. https://example.com/photo.jpg) to disk.
 * Aborts early if the server reports a content-length larger than maxBytes.
 * Returns the path of the downloaded file.
 */
export async function downloadDirect(url, destDir, maxBytes) {
  let rawBase = `file-${Date.now()}`;
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname);
    const base = path.basename(decodedPath);
    if (base) rawBase = base;
  } catch {
    try {
      rawBase = path.basename(new URL(url).pathname) || rawBase;
    } catch {}
  }

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 60000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ArchivistFox/1.0)' },
    validateStatus: (status) => status >= 200 && status < 300,
  });

  let ext = path.extname(rawBase).toLowerCase();
  if (!ext || ext.length < 2) {
    const inferred = inferExtensionFromContentType(response.headers['content-type']);
    if (inferred) {
      ext = inferred;
    }
  }

  const rawNameWithoutExt = path.basename(rawBase, path.extname(rawBase)) || `file-${Date.now()}`;
  // Use centralized NTFS-safe sanitizer: strips reserved names, control chars, trailing dots/spaces
  const safeName = `${sanitizePathSegment(rawNameWithoutExt, 100)}${ext || '.bin'}`;
  const destPath = path.join(destDir, `${Date.now()}-${safeName}`);

  const contentLength = Number(response.headers['content-length'] || 0);
  if (contentLength && contentLength > maxBytes) {
    response.data.destroy();
    throw new Error(`FILE_TOO_LARGE:${contentLength}`);
  }

  await new Promise((resolve, reject) => {
    // Idempotent settle guard: prevents double-rejection when destroy() triggers
    // a secondary 'error' event on an already-settled Promise (common on Windows
    // where stream teardown can race with file handle release).
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    let downloaded = 0;
    const writer = fs.createWriteStream(destPath);

    const abort = (err) => {
      // Destroy write stream first to release file handle, then remove partial file
      writer.destroy();
      response.data.destroy();
      fs.promises.unlink(destPath).catch(() => {});
      settle(reject, err);
    };

    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      if (downloaded > maxBytes) {
        abort(new Error(`FILE_TOO_LARGE:${downloaded}`));
      }
    });

    response.data.pipe(writer);
    writer.on('finish', () => settle(resolve, undefined));
    writer.on('error', (err) => abort(err));
    response.data.on('error', (err) => abort(err));
  });

  return destPath;
}
