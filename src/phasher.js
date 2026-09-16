import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { extractPlatformMediaId } from './urlExtractor.js';
import { killProcessTree } from './utils.js';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'flv', 'wmv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'aac', 'alac', 'aiff']);

/**
 * Checks if a file path has a video extension.
 */
export function isVideoFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

/**
 * Checks if a file path has an audio extension.
 */
export function isAudioFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

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
 * Probes media duration and properties using ffprobe.
 *
 * @param {string} filePath
 * @returns {Promise<{ duration: number, isVideo: boolean, width: number, height: number }>}
 */
export async function getMediaMetadata(filePath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,width,height',
      '-of', 'json',
      filePath,
    ];

    const child = spawn(config.ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';

    const timer = setTimeout(() => {
      killProcessTree(child);
      resolve({ duration: 0, isVideo: isVideoFile(filePath), width: 0, height: 0 });
    }, 15000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ duration: 0, isVideo: isVideoFile(filePath), width: 0, height: 0 });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return resolve({ duration: 0, isVideo: isVideoFile(filePath), width: 0, height: 0 });
      }

      try {
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format?.duration || '0') || 0;
        const videoStream = (data.streams || []).find((s) => s.codec_type === 'video');
        const isVideo = Boolean(videoStream) || isVideoFile(filePath);
        const width = videoStream?.width || 0;
        const height = videoStream?.height || 0;

        resolve({ duration, isVideo, width, height });
      } catch {
        resolve({ duration: 0, isVideo: isVideoFile(filePath), width: 0, height: 0 });
      }
    });
  });
}

/**
 * Extracts a 9x8 raw grayscale bitmap frame at a specified timestamp.
 * Evaluates pixel variance to reject uniform / solid black / flat frames.
 *
 * @param {string} filePath
 * @param {number|string} timestamp - Seek position (e.g. 2.0 or '00:00:02')
 * @returns {Promise<{ hash: string|null, isFlat: boolean }>}
 */
export async function extractFrameHash(filePath, timestamp = 0) {
  return new Promise((resolve) => {
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

    const child = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];

    const timer = setTimeout(() => {
      killProcessTree(child);
      resolve({ hash: null, isFlat: true });
    }, 15000);

    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ hash: null, isFlat: true });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ hash: null, isFlat: true });
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 72) return resolve({ hash: null, isFlat: true });

      // Calculate pixel statistics to detect flat / blank / solid black frames
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

      // If dynamic range is under 12 or variance is under 10, the frame is essentially flat/blank
      if (max - min < 12 || variance < 10) {
        return resolve({ hash: null, isFlat: true });
      }

      // Compute 64-bit dHash (difference between adjacent horizontal pixels)
      let bits = '';
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const left = buffer[row * 9 + col];
          const right = buffer[row * 9 + col + 1];
          bits += left > right ? '1' : '0';
        }
      }

      // If all bits are 0s or all bits are 1s, it is a uniform artifact
      if (!bits.includes('1') || !bits.includes('0')) {
        return resolve({ hash: null, isFlat: true });
      }

      // Convert 64-bit binary string to 16-character hex string
      let hex = '';
      for (let i = 0; i < 64; i += 4) {
        const nibble = parseInt(bits.substring(i, i + 4), 2);
        hex += nibble.toString(16);
      }

      resolve({ hash: hex, isFlat: false });
    });
  });
}

/**
 * Computes perceptual dHash for media:
 * - For images: extracts frame, rejecting flat/blank images.
 * - For videos: avoids the 00:00:00 black-frame trap by sampling representative timestamps (e.g. 20%, 50%, 80%)
 *   and constructing a composite temporal fingerprint.
 *
 * @param {string} filePath - Local path to media file
 * @param {{ duration: number, isVideo: boolean }|null} [resolvedMeta] - Optional pre-resolved metadata to avoid a
 *   second ffprobe invocation when called from computeMediaFingerprint (which already probed the file).
 * @returns {Promise<string|null>} Hex perceptual hash (or composite "hash1:hash2:hash3"), or null if unhashable/flat
 */
export async function computeDHash(filePath, resolvedMeta = null) {
  if (isAudioFile(filePath)) {
    return null; // Audio has no visual perceptual hash
  }

  // Re-use caller-supplied metadata to avoid spawning a second ffprobe process for the same file.
  const meta = resolvedMeta || (await getMediaMetadata(filePath));

  if (!meta.isVideo || meta.duration <= 0) {
    // Static image or unknown duration
    const result = await extractFrameHash(filePath, 0);
    return result.hash;
  }

  // For video: sample 3 candidate temporal points (skipping 00:00:00)
  const duration = meta.duration;
  const targetPercents = [0.2, 0.5, 0.8];
  const validHashes = [];

  for (const pct of targetPercents) {
    let t = Math.max(0.5, duration * pct);
    let result = await extractFrameHash(filePath, t);

    // If frame is flat, try advancing seek timestamp slightly
    if (result.isFlat && duration > 2) {
      const retryOffsets = [1.0, 2.0, -1.0];
      for (const offset of retryOffsets) {
        const retryT = Math.max(0.2, Math.min(duration - 0.2, t + offset));
        const retryResult = await extractFrameHash(filePath, retryT);
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
    return null; // Entire video is blank/featureless
  }

  // Join multi-frame hashes into a composite temporal hash
  return validHashes.join(':');
}

/**
 * Computes complete media fingerprint containing Platform ID, SHA-256, duration, and visual hashes.
 * Runs SHA-256 and ffprobe in parallel, then passes the resolved metadata to computeDHash
 * so that the file is only probed once (not twice) per download.
 *
 * @param {string} filePath
 * @param {string} [originalUrl]
 * @returns {Promise<{
 *   mediaId: string|null,
 *   sha256: string|null,
 *   duration: number,
 *   isVideo: boolean,
 *   hash: string|null
 * }>}
 */
export async function computeMediaFingerprint(filePath, originalUrl = null) {
  // Probe SHA-256 and metadata in parallel (both are I/O-bound and independent).
  // Then feed the resolved meta into computeDHash so ffprobe runs only once total.
  const [sha256, meta] = await Promise.all([
    computeSha256(filePath),
    getMediaMetadata(filePath),
  ]);

  const hash = await computeDHash(filePath, meta);
  const mediaId = originalUrl ? extractPlatformMediaId(originalUrl) : null;

  return {
    mediaId,
    sha256,
    duration: meta.duration,
    isVideo: meta.isVideo,
    hash,
  };
}

/**
 * Computes the Hamming distance (number of differing bits) between two hex-encoded dHashes.
 * Supports composite colon-delimited hashes ("hash1:hash2:hash3").
 *
 * @param {string} hex1 - First hash
 * @param {string} hex2 - Second hash
 * @returns {number} Differing bits (or average bits across composite frames), or Infinity if invalid/flat
 */
export function hammingDistance(hex1, hex2) {
  if (!hex1 || !hex2) return Infinity;

  // Filter out legacy or corrupt flat hashes
  if (hex1.includes('0000000000000000') || hex2.includes('0000000000000000')) return Infinity;
  if (hex1.includes('ffffffffffffffff') || hex2.includes('ffffffffffffffff')) return Infinity;

  const parts1 = hex1.split(':').filter((h) => h.length === 16);
  const parts2 = hex2.split(':').filter((h) => h.length === 16);

  if (parts1.length === 0 || parts2.length === 0) return Infinity;

  // Single hash vs Single hash
  if (parts1.length === 1 && parts2.length === 1) {
    return singleHammingDistance(parts1[0], parts2[0]);
  }

  // Composite multi-frame hashes: compare common frame positions
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
  if (!h1 || !h2 || h1.length !== 16 || h2.length !== 16) return Infinity;
  let dist = 0;
  for (let i = 0; i < 16; i += 8) {
    const v1 = parseInt(h1.substring(i, i + 8), 16);
    const v2 = parseInt(h2.substring(i, i + 8), 16);
    let xor = (v1 ^ v2) >>> 0;
    while (xor > 0) {
      dist += xor & 1;
      xor >>>= 1;
    }
  }
  return dist;
}

/**
 * Compares two media records/fingerprints using the Cascading Multi-Factor Filter:
 * Tier 1: Canonical Platform Media ID (YouTube ID, Twitter status ID, etc.)
 * Tier 2: Exact SHA-256 byte match
 * Tier 3: Structural Video Duration Gating (rejects mismatch > 1.5s)
 * Tier 4: Multi-Frame Perceptual dHash Distance
 *
 * @param {object} candidate - New media fingerprint
 * @param {object} record - Existing media record in database
 * @param {number} [threshold=5] - Maximum allowed Hamming distance for visual match
 * @returns {{ isDuplicate: boolean, reason: string|null, score: number }}
 */
export function matchDuplicate(candidate, record, threshold = config.duplicateThreshold || 5) {
  if (!candidate || !record) {
    return { isDuplicate: false, reason: null, score: Infinity };
  }

  // Tier 1: Platform Media ID
  if (candidate.mediaId && record.mediaId && candidate.mediaId === record.mediaId) {
    return { isDuplicate: true, reason: `Platform Media ID (${candidate.mediaId})`, score: 0 };
  }

  // Also check originalUrl if mediaId was not stored in legacy records
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

  // Tier 3: Duration Gate for Videos (A 3-minute video cannot duplicate a 15-second clip)
  if (candidate.duration > 0 && record.duration > 0) {
    const diff = Math.abs(candidate.duration - record.duration);
    if (diff > 1.5) {
      return { isDuplicate: false, reason: 'Duration mismatch', score: Infinity };
    }
  }

  // Tier 4: Perceptual Visual Hash Comparison
  if (candidate.hash && record.hash) {
    // Ignore legacy flat hashes
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

