import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { downloadDirect } from './directDownloader.js';
import { downloadWithYtDlp } from './ytdlpDownloader.js';
import { downloadWithGalleryDl } from './galleryDlDownloader.js';
import { archiveLocalMedia } from './archiver.js';
import { computeMediaFingerprint } from './phasher.js';
import { findDuplicate, findDuplicateByUrl, saveRecord } from './db.js';
import {
  extractPlatformMediaId,
  normalizeUrl,
  isAudioUrl,
  isDeviantArtUrl,
  extractMediaLinksAsync,
} from './urlExtractor.js';
import { getHumanJitterMs, sanitizePathSegment } from './utils.js';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'aac', 'alac', 'aiff']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg']);

export function isVideo(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

export function isAudio(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

export function isImage(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

async function makeTempDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'archivist-fox-core-'));
}

async function cleanupDir(dir) {
  if (!config.cleanupTempFiles) return;
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Downloads a platform link (Twitter, YouTube, TikTok, Reddit, etc.)
 * with automatic engine fallback (yt-dlp -> gallery-dl) and transient error retries.
 */
export async function downloadPlatformMedia(url, destDir, maxRetries = 2, dlOptions = {}) {
  let lastErr = null;
  const options = {
    extractAudio: dlOptions.audioOnly || isAudioUrl(url),
  };

  // Anti-Bot: apply randomized human reaction jitter on initial request attempt
  if (config.enableHumanJitter && !dlOptions.skipJitter) {
    const jitterMs = getHumanJitterMs(config.humanJitterMinMs, config.humanJitterMaxMs);
    await new Promise((r) => setTimeout(r, jitterMs));
  }

  // DeviantArt fast-path: yt-dlp has no DeviantArt extractor, so skip directly to gallery-dl.
  if (isDeviantArtUrl(url)) {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        return await downloadWithGalleryDl(url, destDir);
      } catch (err) {
        lastErr = err;
        const isTransient =
          err?.message?.includes('TIMEOUT') ||
          err?.message?.includes('429') ||
          err?.message?.includes('rate limit') ||
          err?.message?.includes('ECONNRESET') ||
          err?.message?.includes('ETIMEDOUT');

        if (isTransient && attempt <= maxRetries) {
          await new Promise((r) => setTimeout(r, attempt * 3000));
          continue;
        }
        break;
      }
    }
    throw lastErr || new Error('DeviantArt download failed');
  }

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await downloadWithYtDlp(url, destDir, options);
    } catch (ytErr) {
      const msg = ytErr?.message || '';
      if (msg.startsWith('COMMAND_NOT_FOUND')) {
        throw ytErr;
      }
      try {
        return await downloadWithGalleryDl(url, destDir);
      } catch (galleryErr) {
        if (galleryErr?.message?.includes('Unsupported URL')) {
          lastErr = ytErr;
        } else {
          lastErr = galleryErr;
        }

        const isTransient =
          lastErr?.message?.includes('TIMEOUT') ||
          lastErr?.message?.includes('429') ||
          lastErr?.message?.includes('rate limit') ||
          lastErr?.message?.includes('ECONNRESET') ||
          lastErr?.message?.includes('ETIMEDOUT');

        if (isTransient && attempt <= maxRetries) {
          await new Promise((r) => setTimeout(r, attempt * 3000));
          continue;
        }
      }
    }
  }

  throw lastErr || new Error('Download failed');
}

/**
 * Downloads media from any URL (direct file or platform link) with
 * duplicate checking, perceptual fingerprinting, and local archiving.
 *
 * @param {string} url - Target media link
 * @param {object} [options]
 * @param {boolean} [options.audioOnly=false] - Force audio extraction
 * @param {boolean} [options.force=false] - Bypass duplicate check
 * @param {boolean} [options.saveToArchive=true] - Save to permanent PC archives
 * @param {string} [options.author='WebUI'] - Author tag for metadata
 * @param {string} [options.channel='web'] - Channel or source identifier
 * @param {Function} [options.onProgress] - Callback for live progress: ({ stage, percent, message, data })
 * @returns {Promise<object>} Download result
 */
export async function downloadMediaItem(url, options = {}) {
  const {
    audioOnly = false,
    force = false,
    saveToArchive = config.enableLocalArchive,
    author = 'WebUI',
    channel = 'web',
    onProgress = () => {},
  } = options;

  const tempDir = await makeTempDir();

  try {
    onProgress({ stage: 'checking', message: 'Checking for duplicates...' });

    // 1. Pre-download duplicate check via URL / Media ID
    if (config.enableDuplicatePrevention && !force) {
      const existingMatch = await findDuplicateByUrl(url);
      if (existingMatch) {
        onProgress({
          stage: 'completed',
          message: `Already archived previously! (by ${existingMatch.postedBy || 'Unknown'})`,
          data: { isDuplicate: true, existingMatch },
        });

        return {
          success: true,
          url,
          isDuplicate: true,
          duplicateInfo: existingMatch,
          files: existingMatch.fileName
            ? [
                {
                  filename: existingMatch.fileName,
                  title: existingMatch.title || existingMatch.fileName,
                  path: path.join(path.resolve(config.archiveDirectory), existingMatch.fileName),
                  isArchived: true,
                },
              ]
            : [],
        };
      }
    }

    onProgress({ stage: 'downloading', message: 'Downloading media from link...' });

    // 2. Identify if URL is direct file or platform link
    const detectedLinks = await extractMediaLinksAsync(url);
    const linkType = detectedLinks[0]?.type || 'platform';

    let dlResult;
    if (linkType === 'direct') {
      const filePath = await downloadDirect(url, tempDir, config.hardCapBytes);
      dlResult = [filePath];
    } else {
      dlResult = await downloadPlatformMedia(url, tempDir, 2, { audioOnly });
    }

    const filePaths = Array.isArray(dlResult) ? dlResult : dlResult.mediaFiles || [];
    const subtitleFiles = Array.isArray(dlResult) ? [] : dlResult.subtitleFiles || [];

    if (filePaths.length === 0) {
      throw new Error('No downloadable media files were found for this link.');
    }

    onProgress({ stage: 'processing', message: 'Analyzing and archiving media...' });

    const processedFiles = [];

    for (const filePath of filePaths) {
      const parsedPath = path.parse(filePath);
      const cleanTitle = parsedPath.name;

      // 3. Compute perceptual fingerprint
      const fingerprint = await computeMediaFingerprint(filePath, url);

      // 4. Visual duplicate detection against older media
      if (config.enableDuplicatePrevention && !force) {
        const { match, reason, distance } = await findDuplicate(fingerprint, {
          ignoreMediaId: fingerprint.mediaId,
          ignoreOriginalUrl: url,
        });

        if (match) {
          onProgress({
            stage: 'completed',
            message: `Identical visual media already exists (${reason || `dist=${distance}`})`,
            data: { isDuplicate: true, match },
          });

          return {
            success: true,
            url,
            isDuplicate: true,
            duplicateInfo: match,
            files: [
              {
                filename: match.fileName || path.basename(filePath),
                title: match.title || cleanTitle,
                path: match.fileName ? path.join(path.resolve(config.archiveDirectory), match.fileName) : filePath,
                isArchived: true,
              },
            ],
          };
        }
      }

      // 5. Permanent local archiving
      let finalFilePath = filePath;
      let archivedPath = null;

      if (saveToArchive) {
        onProgress({ stage: 'archiving', message: `Saving "${cleanTitle}" to local archive...` });
        archivedPath = await archiveLocalMedia(filePath, {
          url,
          author,
          channel,
          title: cleanTitle,
          mediaId: fingerprint.mediaId,
          sha256: fingerprint.sha256,
          subtitleFiles,
        });

        if (archivedPath) {
          finalFilePath = archivedPath;
        }
      }

      // 6. Save entry to SQLite database
      await saveRecord({
        mediaId: fingerprint.mediaId,
        sha256: fingerprint.sha256,
        duration: fingerprint.duration,
        hash: fingerprint.hash,
        originalUrl: url,
        title: cleanTitle,
        postedBy: author,
        channel,
        archivedAt: new Date().toISOString(),
        fileName: archivedPath ? path.basename(archivedPath) : path.basename(filePath),
      });

      const stat = await fs.promises.stat(finalFilePath).catch(() => null);

      processedFiles.push({
        path: finalFilePath,
        filename: path.basename(finalFilePath),
        title: cleanTitle,
        size: stat ? stat.size : 0,
        isVideo: isVideo(finalFilePath),
        isAudio: isAudio(finalFilePath),
        isImage: isImage(finalFilePath),
        duration: fingerprint.duration || null,
        mediaId: fingerprint.mediaId,
      });
    }

    onProgress({
      stage: 'finalizing',
      message: `Finalizing ${processedFiles.length} downloaded item(s)...`,
      data: { files: processedFiles },
    });

    const isNsfw = Boolean(dlResult?.isNsfw || detectedLinks[0]?.isKnownNsfw);

    return {
      success: true,
      url,
      isDuplicate: false,
      isNsfw,
      files: processedFiles,
      subtitles: subtitleFiles.map((s) => path.basename(s)),
    };
  } catch (err) {
    onProgress({ stage: 'error', message: err.message || 'Download failed' });
    throw err;
  } finally {
    await cleanupDir(tempDir);
  }
}
