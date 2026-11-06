import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  sanitizePathSegment,
  validateSsrfTarget,
  isAbortError,
  getBrowserHeaders,
  parseRetryAfterMs,
} from './utils.js';

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

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Downloads a direct media URL (e.g. https://example.com/photo.jpg) to disk
 * using Node's native `fetch` with hop-by-hop SSRF validation and hard byte caps.
 * Returns the path of the downloaded file.
 */
export async function downloadDirect(url, destDir, maxBytes, options = {}) {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new Error('DOWNLOAD_ABORTED');
  }

  let currentUrl = url;
  let response = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await validateSsrfTarget(currentUrl, options);

    const fetchSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: fetchSignal,
        headers: getBrowserHeaders(currentUrl, {
          fetchDest: 'document',
          fetchMode: 'navigate',
          fetchSite: 'none',
          referer: options.referer,
          headers: options.headers,
        }),
      });
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        throw new Error('DOWNLOAD_ABORTED');
      }
      throw err;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new Error(`HTTP redirect ${response.status} missing Location header`);
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error('TOO_MANY_REDIRECTS');
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    break;
  }

  if (!response || !response.ok) {
    const status = response?.status || 0;
    const retryAfterHeader = response?.headers?.get('retry-after');
    await response?.body?.cancel().catch(() => {});
    const err = new Error(`HTTP_ERROR:${status}`);
    err.statusCode = status;
    if (status === 429 || retryAfterHeader) {
      const retryMs = parseRetryAfterMs(retryAfterHeader);
      if (retryMs) {
        err.retryAfterMs = retryMs;
      }
    }
    throw err;
  }

  let rawBase = typeof options.filename === 'string' && options.filename.trim()
    ? options.filename.trim()
    : `file-${Date.now()}`;
  if (!options.filename) {
    try {
      const parsed = new URL(currentUrl);
      const decodedPath = decodeURIComponent(parsed.pathname);
      const base = path.basename(decodedPath);
      if (base) rawBase = base;
    } catch {
      try {
        rawBase = path.basename(new URL(url).pathname) || rawBase;
      } catch (err) {
    void err;
  }
    }
  }

  let ext = path.extname(rawBase).toLowerCase();
  if (!ext || ext.length < 2) {
    const inferred = inferExtensionFromContentType(response.headers.get('content-type'));
    if (inferred) {
      ext = inferred;
    }
  }

  const rawNameWithoutExt = path.basename(rawBase, path.extname(rawBase)) || `file-${Date.now()}`;
  const cleanStem = sanitizePathSegment(rawNameWithoutExt, 100);
  const finalExt = ext || '.bin';
  const safeName = `${cleanStem}${finalExt}`;
  await fs.promises.mkdir(destDir, { recursive: true });

  let destPath;
  if (options.filename) {
    destPath = path.join(destDir, safeName);
    if (fs.existsSync(destPath)) {
      destPath = path.join(destDir, `${cleanStem}_${Date.now().toString(36)}${finalExt}`);
    }
  } else {
    destPath = path.join(destDir, `${Date.now()}-${safeName}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (maxBytes > 0 && contentLength && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`FILE_TOO_LARGE:${contentLength}`);
  }

  if (!response.body) {
    throw new Error('EMPTY_RESPONSE_BODY');
  }

  const bodyStream = Readable.fromWeb(response.body);

  await new Promise((resolve, reject) => {
    let settled = false;
    let onAbort = null;

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      fn(val);
    };

    let downloaded = 0;
    const writer = fs.createWriteStream(destPath);

    const abort = (err) => {
      writer.destroy();
      bodyStream.destroy();
      fs.promises.unlink(destPath).catch(() => {});
      settle(reject, err);
    };

    if (signal) {
      onAbort = () => abort(new Error('DOWNLOAD_ABORTED'));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    bodyStream.on('data', (chunk) => {
      downloaded += chunk.length;
      if (maxBytes > 0 && downloaded > maxBytes) {
        abort(new Error(`FILE_TOO_LARGE:${downloaded}`));
      }
    });

    bodyStream.pipe(writer);
    writer.on('finish', () => settle(resolve, undefined));
    writer.on('error', (err) => abort(err));
    bodyStream.on('error', (err) => abort(signal?.aborted ? new Error('DOWNLOAD_ABORTED') : err));
  });

  return destPath;
}
