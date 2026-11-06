import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { extractPlatformMediaId } from './urlExtractor.js';
import {

  isAudio,
  killProcessTree,
  probeMedia,
  registerDownloadProcess,
  unregisterDownloadProcess,
  isAbortError,
} from './utils.js';

/**
 * Computes fast cryptographic SHA-256 hex digest of a file.
 *
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
export async function computeSha256(filePath) {
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Probes media duration and properties using canonical `probeMedia`
 * (ignoring embedded cover art on audio files).
 *
 * @param {string} filePath
 * @param {AbortSignal|null} [signal=null]
 * @returns {Promise<{ duration: number, isVideo: boolean, width: number, height: number, attachedPicStreamIndex: number|null, audioCodec: string, audioBitrate: number }>}
 */
export async function getMediaMetadata(filePath, signal = null) {
  const p = await probeMedia(filePath, { signal });
  return {
    duration: p.duration,
    isVideo: p.isVideo,
    width: p.width,
    height: p.height,
    attachedPicStreamIndex: p.attachedPicStreamIndex,
    audioCodec: p.audioCodec,
    audioBitrate: p.audioBitrate,
  };
}

/**
 * Extracts a 9x8 raw grayscale bitmap frame at a specified timestamp.
 * Evaluates pixel variance to reject uniform / solid black / flat frames.
 *
 * @param {string} filePath
 * @param {number|string} timestamp - Seek position (e.g. 2.0 or '00:00:02')
 * @param {AbortSignal|null} [signal=null]
 * @returns {Promise<{ hash: string|null, isFlat: boolean }>}
 */
export async function extractFrameHash(filePath, timestamp = 0, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('DOWNLOAD_ABORTED'));
    }

    const seekStr = typeof timestamp === 'number' ? timestamp.toFixed(2) : String(timestamp);
    const args = [
      '-ss', seekStr,
      '-i', filePath,
      '-vframes', '1',
      '-s', '9x8',
      '-pix_fmt', 'gray',
      '-f', 'rawvideo',
      'pipe:1',
    ];

    let settled = false;
    let onAbort = null;
    const child = spawn(config.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    registerDownloadProcess(child);
    const chunks = [];

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterDownloadProcess(child);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      fn(val);
    };

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(resolve, { hash: null, isFlat: true });
    }, 15000);
    timer.unref?.();

    if (signal) {
      onAbort = () => {
        killProcessTree(child);
        finish(reject, new Error('DOWNLOAD_ABORTED'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });
    // Drain stderr continuously so Windows 64 KB pipe buffer never blocks ffmpeg
    child.stderr.resume();

    child.on('error', () => {
      if (signal?.aborted) {
        finish(reject, new Error('DOWNLOAD_ABORTED'));
      } else {
        finish(resolve, { hash: null, isFlat: true });
      }
    });

    child.on('close', (code) => {
      if (signal?.aborted) {
        return finish(reject, new Error('DOWNLOAD_ABORTED'));
      }
      if (code !== 0) return finish(resolve, { hash: null, isFlat: true });
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 72) return finish(resolve, { hash: null, isFlat: true });

      let min = 255;
      let max = 0;
      let sum = 0;

      for (let i = 0; i < 72; i++) {
        const val = buffer[i];
        if (val < min) min = val;
        if (val > max) max = val;
        sum += val;
      }

      const mean = sum / 72;
      let variance = 0;
      for (let i = 0; i < 72; i++) {
        variance += (buffer[i] - mean) ** 2;
      }
      variance /= 72;

      if (max - min < 12 || variance < 10) {
        return finish(resolve, { hash: null, isFlat: true });
      }

      let bits = '';
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const left = buffer[row * 9 + col];
          const right = buffer[row * 9 + col + 1];
          bits += left > right ? '1' : '0';
        }
      }

      if (!bits.includes('1') || !bits.includes('0')) {
        return finish(resolve, { hash: null, isFlat: true });
      }

      let hex = '';
      for (let i = 0; i < 64; i += 4) {
        const nibble = parseInt(bits.substring(i, i + 4), 2);
        hex += nibble.toString(16);
      }

      finish(resolve, { hash: hex, isFlat: false });
    });
  });
}

/**
 * Computes perceptual dHash for media (single frame for images, 3-point temporal
 * composite for videos).
 */
export async function computeDHash(filePath, resolvedMeta = null, signal = null) {
  if (isAudio(filePath)) {
    return null;
  }

  const meta = resolvedMeta || (await getMediaMetadata(filePath, signal));

  if (!meta.isVideo || meta.duration <= 0) {
    const result = await extractFrameHash(filePath, 0, signal);
    return result.hash;
  }

  const duration = meta.duration;
  const targetPercents = [0.2, 0.5, 0.8];
  const validHashes = [];

  for (const pct of targetPercents) {
    if (signal?.aborted) throw new Error('DOWNLOAD_ABORTED');
    const t = Math.max(0.5, duration * pct);
    let result = await extractFrameHash(filePath, t, signal);

    if (result.isFlat && duration > 2) {
      const retryOffsets = [1.0, 2.0, -1.0];
      for (const offset of retryOffsets) {
        const retryT = Math.max(0.2, Math.min(duration - 0.2, t + offset));
        const retryResult = await extractFrameHash(filePath, retryT, signal);
        if (!retryResult.isFlat && retryResult.hash) {
          result = retryResult;
          break;
        }
      }
    }

    if (result.hash) {
      validHashes.push(result.hash);
    }
  }

  if (validHashes.length === 0) {
    return null;
  }

  return validHashes.join(':');
}

/**
 * Computes complete media fingerprint containing Platform ID, SHA-256, duration,
 * visual hashes, and cached probe metadata (`mediaInfo`) so downstream thumbnail
 * preview and compression never need to re-spawn `ffprobe` on the same file.
 */
export async function computeMediaFingerprint(filePath, originalUrl = null, options = {}) {
  const signal = options?.signal || null;
  try {
    const [sha256, meta] = await Promise.all([
      computeSha256(filePath),
      getMediaMetadata(filePath, signal),
    ]);

    const hash = await computeDHash(filePath, meta, signal);
    const mediaId = originalUrl ? extractPlatformMediaId(originalUrl) : null;

    return {
      mediaId,
      sha256,
      duration: meta.duration,
      isVideo: meta.isVideo,
      hash,
      mediaInfo: meta,
    };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    throw err;
  }
}

export function hammingDistance(hex1, hex2) {
  if (!hex1 || !hex2) return Infinity;

  if (hex1.includes('0000000000000000') || hex2.includes('0000000000000000')) return Infinity;
  if (hex1.includes('ffffffffffffffff') || hex2.includes('ffffffffffffffff')) return Infinity;

  const parts1 = hex1.split(':').filter((h) => h.length === 16);
  const parts2 = hex2.split(':').filter((h) => h.length === 16);

  if (parts1.length === 0 || parts2.length === 0) return Infinity;

  if (parts1.length === 1 && parts2.length === 1) {
    return singleHammingDistance(parts1[0], parts2[0]);
  }

  const minFrames = Math.min(parts1.length, parts2.length);
  let totalDist = 0;

  for (let i = 0; i < minFrames; i++) {
    const d = singleHammingDistance(parts1[i], parts2[i]);
    if (d === Infinity) return Infinity;
    totalDist += d;
  }

  return Math.round(totalDist / minFrames);
}

function singleHammingDistance(h1, h2) {
  if (
    !h1 ||
    !h2 ||
    typeof h1 !== 'string' ||
    typeof h2 !== 'string' ||
    h1.length !== 16 ||
    h2.length !== 16 ||
    !/^[0-9a-f]{16}$/i.test(h1) ||
    !/^[0-9a-f]{16}$/i.test(h2)
  ) {
    return Infinity;
  }
  let dist = 0;
  for (let i = 0; i < 16; i += 8) {
    const v1 = parseInt(h1.substring(i, i + 8), 16);
    const v2 = parseInt(h2.substring(i, i + 8), 16);
    let xor = (v1 ^ v2) >>> 0;
    xor = xor - ((xor >>> 1) & 0x55555555);
    xor = (xor & 0x33333333) + ((xor >>> 2) & 0x33333333);
    xor = (xor + (xor >>> 4)) & 0x0f0f0f0f;
    dist += Math.imul(xor, 0x01010101) >>> 24;
  }
  return dist;
}

export function matchDuplicate(candidate, record, threshold = config.duplicateThreshold || 5) {
  if (!candidate || !record) {
    return { isDuplicate: false, reason: null, score: Infinity };
  }

  // Tier 1: Platform Media ID
  if (candidate.mediaId && record.mediaId && candidate.mediaId === record.mediaId) {
    return { isDuplicate: true, reason: `Platform Media ID (${candidate.mediaId})`, score: 0 };
  }

  if (candidate.mediaId && record.originalUrl) {
    const legacyMediaId = extractPlatformMediaId(record.originalUrl);
    if (legacyMediaId && candidate.mediaId === legacyMediaId) {
      return { isDuplicate: true, reason: `Platform Media ID (${candidate.mediaId})`, score: 0 };
    }
  }

  // Tier 2: Cryptographic SHA-256 Match
  if (candidate.sha256 && record.sha256 && candidate.sha256 === record.sha256) {
    return { isDuplicate: true, reason: 'Exact File Byte Match (SHA-256)', score: 0 };
  }

  // Tier 3: Duration Gate for Videos (rejects mismatch > 1.5s)
  if (candidate.duration > 0 && record.duration > 0) {
    const diff = Math.abs(candidate.duration - record.duration);
    if (diff > 1.5) {
      return { isDuplicate: false, reason: 'Duration mismatch', score: Infinity };
    }
  }

  // Tier 4: Perceptual Visual Hash Comparison
  if (candidate.hash && record.hash) {
    if (record.hash.includes('0000000000000000') || candidate.hash.includes('0000000000000000')) {
      return { isDuplicate: false, reason: 'Ignored flat hash', score: Infinity };
    }

    const dist = hammingDistance(candidate.hash, record.hash);
    if (dist <= threshold) {
      return { isDuplicate: true, reason: `Visual match (dist=${dist})`, score: dist };
    }
  }

  return { isDuplicate: false, reason: null, score: Infinity };
}
