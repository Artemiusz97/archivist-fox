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
import { processDualFormatMedia } from './gifHandler.js';
import {
  isAudioUrl,
  isDeviantArtUrl,
  extractMediaLinksAsync,
  canonicalizeBilibiliUrl,
  stripQueryAndTrailingPunctuation,
} from './urlExtractor.js';
import {
  getHumanJitterMs,
  paceDomainRequest,
  purgeTempDownloadArtifacts,
  isAbortError,
  sleep,
  isVideo,
  isAudio,
  isImage,
} from './utils.js';

export { isVideo, isAudio, isImage, paceDomainRequest };

async function makeTempDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'archivist-fox-core-'));
}

async function cleanupDir(dir) {
  if (!config.cleanupTempFiles) return;
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function isTransientDownloadError(err) {
  const msg = err?.message || '';
  return (
    msg.includes('TIMEOUT') ||
    msg.includes('429') ||
    msg.toLowerCase().includes('rate limit') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  );
}

function isNoVideoFoundError(err) {
  const msg = err?.message || String(err || '');
  return (
    msg === 'YTDLP_NO_MEDIA_FOUND' ||
    /no video (could be|formats) found/i.test(msg) ||
    /no downloadable media/i.test(msg) ||
    /no media found/i.test(msg)
  );
}

/**
 * Downloads a platform link (Twitter, YouTube, TikTok, Reddit, etc.)
 * with automatic engine fallback (yt-dlp -> gallery-dl) and transient error retries.
 */
export async function downloadPlatformMedia(rawUrl, destDir, maxRetries = 2, dlOptions = {}) {
  let lastErr = null;
  const signal = dlOptions?.signal;
  if (signal?.aborted) {
    throw new Error('DOWNLOAD_ABORTED');
  }

  const url = canonicalizeBilibiliUrl(stripQueryAndTrailingPunctuation(rawUrl ? String(rawUrl).trim() : ''));
  if (!url) {
    throw new Error('INVALID_URL');
  }

  const ytdlpRunner = dlOptions?.ytdlpRunner || downloadWithYtDlp;
  const gallerydlRunner = dlOptions?.gallerydlRunner || downloadWithGalleryDl;
  const getRetryDelayMs = (attempt, err) => {
    if (err?.retryAfterMs && typeof err.retryAfterMs === 'number') {
      return err.retryAfterMs;
    }
    return dlOptions?.retryDelayMs ?? attempt * 3000;
  };

  const options = {
    extractAudio: dlOptions.audioOnly || isAudioUrl(url),
    sleepRequests: dlOptions.sleepRequests,
    signal,
  };

  if (config.enableHumanJitter && !dlOptions.skipJitter) {
    const jitterMs = getHumanJitterMs(config.humanJitterMinMs, config.humanJitterMaxMs);
    if (jitterMs > 0) {
      await sleep(jitterMs, signal);
    }
  }

  await paceDomainRequest(url, signal);

  // DeviantArt fast-path: yt-dlp has no DeviantArt extractor, so skip directly to gallery-dl.
  if (isDeviantArtUrl(url)) {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (signal?.aborted) {
        throw new Error('DOWNLOAD_ABORTED');
      }
      try {
        return await gallerydlRunner(url, destDir, { signal });
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          throw err;
        }
        lastErr = err;
        if (isTransientDownloadError(err) && attempt <= maxRetries) {
          await sleep(getRetryDelayMs(attempt, err), signal);
          continue;
        }
        break;
      }
    }
    throw lastErr || new Error('DeviantArt download failed');
  }

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (signal?.aborted) {
      throw new Error('DOWNLOAD_ABORTED');
    }
    try {
      return await ytdlpRunner(url, destDir, options);
    } catch (ytErr) {
      if (isAbortError(ytErr) || signal?.aborted) {
        throw ytErr;
      }
      const msg = ytErr?.message || '';
      if (msg.startsWith('COMMAND_NOT_FOUND')) {
        throw ytErr;
      }
      try {
        await purgeTempDownloadArtifacts(destDir);
        return await gallerydlRunner(url, destDir, { signal });
      } catch (galleryErr) {
        if (isAbortError(galleryErr) || signal?.aborted) {
          throw galleryErr;
        }
        if (galleryErr?.message?.includes('Unsupported URL')) {
          lastErr = isNoVideoFoundError(ytErr) ? galleryErr : ytErr;
        } else {
          lastErr = galleryErr;
        }

        if (isTransientDownloadError(lastErr) && attempt <= maxRetries) {
          await sleep(getRetryDelayMs(attempt, lastErr), signal);
          continue;
        }
        break;
      }
    }
  }

  throw lastErr || new Error('Download failed');
}

/**
 * Downloads media from any URL (direct file or platform link) with
 * duplicate checking, perceptual fingerprinting, and local archiving.
 */
export async function downloadMediaItem(rawUrl, options = {}) {
  const url = canonicalizeBilibiliUrl(stripQueryAndTrailingPunctuation(rawUrl ? String(rawUrl).trim() : ''));
  if (!url) {
    throw new Error('INVALID_URL');
  }
  const {
    audioOnly = false,
    force = false,
    saveToArchive = config.enableLocalArchive,
    author = 'WebUI',
    channel = 'web',
    onProgress = () => {},
  } = options;

  const tempDir = await makeTempDir();
  const archiveRoot = path.resolve(config.archiveDirectory);

  try {
    onProgress({ stage: 'checking', message: 'Checking for duplicates...' });

    if (config.enableDuplicatePrevention && !force) {
      const existingMatch = await findDuplicateByUrl(url);
      if (existingMatch) {
        onProgress({
          stage: 'completed',
          message: `Already archived previously! (by ${existingMatch.postedBy || 'Unknown'})`,
          data: { isDuplicate: true, existingMatch },
        });

        const existingRelOrName = existingMatch.relativePath || existingMatch.fileName;
        return {
          success: true,
          url,
          isDuplicate: true,
          duplicateInfo: existingMatch,
          files: existingRelOrName
            ? [
                {
                  filename: existingMatch.fileName || path.basename(existingRelOrName),
                  title: existingMatch.title || existingMatch.fileName,
                  path: path.join(archiveRoot, existingRelOrName),
                  relativePath: existingMatch.relativePath || null,
                  isArchived: true,
                },
              ]
            : [],
        };
      }
    }

    onProgress({ stage: 'downloading', message: 'Downloading media from link...' });

    const detectedLinks = await extractMediaLinksAsync(url);
    const linkType = detectedLinks[0]?.type || 'platform';
    const targetUrl = detectedLinks[0]?.url || url;

    let dlResult;
    if (linkType === 'direct') {
      const filePath = await downloadDirect(targetUrl, tempDir, config.hardCapBytes, { signal: options.signal });
      dlResult = [filePath];
    } else {
      dlResult = await downloadPlatformMedia(targetUrl, tempDir, 2, {
        audioOnly,
        signal: options.signal,
        skipJitter: options.skipJitter,
      });
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

      const fingerprint = await computeMediaFingerprint(filePath, url, { signal: options.signal });

      if (config.enableDuplicatePrevention && !force) {
        const { match, reason, distance } = await findDuplicate(fingerprint);

        if (match) {
          onProgress({
            stage: 'completed',
            message: `Identical visual media already exists (${reason || `dist=${distance}`})`,
            data: { isDuplicate: true, match },
          });

          const matchRelOrName = match.relativePath || match.fileName;
          return {
            success: true,
            url,
            isDuplicate: true,
            duplicateInfo: match,
            files: [
              {
                filename: match.fileName || path.basename(filePath),
                title: match.title || cleanTitle,
                path: matchRelOrName ? path.join(archiveRoot, matchRelOrName) : filePath,
                relativePath: match.relativePath || null,
                isArchived: true,
              },
            ],
          };
        }
      }

      let companionFiles = [];
      if (config.enableGifPipeline) {
        try {
          const dualResult = await processDualFormatMedia(filePath, tempDir, {
            metadata: { is_gif: dlResult?.isOriginalGif },
            signal: options.signal,
          });
          companionFiles = dualResult.companionFiles || [];
        } catch (gifErr) {
          if (isAbortError(gifErr) || options.signal?.aborted) throw gifErr;
        }
      }

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
          companionFiles: config.archiveBothFormats ? companionFiles : [],
        });

        if (archivedPath) {
          finalFilePath = archivedPath;
        }
      }

      const stat = await fs.promises.stat(finalFilePath).catch(() => null);
      const relativePath = archivedPath ? path.relative(archiveRoot, archivedPath).split(path.sep).join('/') : null;

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
        relativePath,
        fileSize: stat ? stat.size : null,
      });

      processedFiles.push({
        path: finalFilePath,
        relativePath,
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
