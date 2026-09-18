import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AttachmentBuilder } from 'discord.js';
import { config } from './config.js';
import { extractMediaLinksAsync, extractPlatformMediaId, normalizeUrl, isAudioUrl, isDeviantArtUrl, extractYouTubePlaylistDetails } from './urlExtractor.js';
import { downloadDirect } from './directDownloader.js';
import { downloadWithYtDlp } from './ytdlpDownloader.js';
import { downloadWithGalleryDl } from './galleryDlDownloader.js';
import { compressVideo, compressAudio } from './compress.js';
import { scheduleAutoDelete, getHumanJitterMs } from './utils.js';
import { archiveLocalMedia } from './archiver.js';
import { computeMediaFingerprint } from './phasher.js';
import { findDuplicate, findDuplicateByUrl, saveRecord } from './db.js';
import { downloadQueue } from './queue.js';
import { applyThumbnailPreview, findThumbnailFile } from './thumbnailPreview.js';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'aac', 'alac', 'aiff']);

// Mutex map to prevent duplicate parallel processing of the same URL
const inFlightDownloads = new Map();

function isVideo(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function isAudio(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

export function isValidDisplayTitle(title) {
  if (!title || typeof title !== 'string') return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('file-') || trimmed.startsWith('tmp_')) return false;
  const lower = trimmed.toLowerCase();
  if (['video', 'image', 'audio', 'media', 'download'].includes(lower)) return false;
  if (/^[0-9a-f]{20,}$/i.test(trimmed)) return false;
  if (/^\d{12,}$/.test(trimmed)) return false;
  return true;
}

async function makeTempDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'archivist-fox-'));
}

async function cleanup(dir) {
  if (!config.cleanupTempFiles) return;
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Sends a reply to a message, falling back to channel.send() if the original
 * trigger message was deleted while the download was running (DiscordAPIError
 * code 10008: "Unknown Message"). This ensures downloaded media is always
 * delivered to the channel even when auto-mod or the user deletes the trigger.
 *
 * @param {import('discord.js').Message} message
 * @param {import('discord.js').MessageCreateOptions} options
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function safeReply(message, options, overrideChannel = null) {
  const targetChannel = overrideChannel || message.channel;
  try {
    if (overrideChannel) {
      return await overrideChannel.send(options);
    }
    return await message.reply(options);
  } catch (err) {
    // 10008 = Unknown Message: the trigger was deleted while we were downloading.
    // Fall back to channel.send() so the upload still reaches the channel.
    if (err?.code === 10008 || err?.message?.includes('Unknown Message')) {
      return targetChannel?.send(options).catch(() => null);
    }
    throw err;
  }
}

/**
 * Ensures a file is at or under config.maxFileSizeBytes, compressing it if
 * it's a video and compression is enabled. If thumbPath is provided, compressVideo
 * applies the thumbnail preview directly in the same encoding pass.
 */
export async function ensureWithinLimit(filePath, onStatus, thumbPath = null) {
  const { size } = await fs.promises.stat(filePath);
  if (size <= config.maxFileSizeBytes) return filePath;

  if (config.enableCompression) {
    if (isVideo(filePath)) {
      try {
        if (onStatus) {
          await onStatus('compressing');
        }
        return await compressVideo(filePath, config.maxFileSizeBytes, thumbPath);
      } catch (err) {
        if (err?.message?.startsWith('QUALITY_PRESERVATION_LIMIT')) {
          throw err;
        }
        return null;
      }
    } else if (isAudio(filePath)) {
      try {
        if (onStatus) {
          await onStatus('compressing');
        }
        return await compressAudio(filePath, config.maxFileSizeBytes);
      } catch (err) {
        if (err?.message?.startsWith('QUALITY_PRESERVATION_LIMIT')) {
          throw err;
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Internal execution pipeline for processing a message.
 */
async function processMessage(message, links, options = {}, onStatus) {
  const tempDir = await makeTempDir();
  const attachments = [];
  const failures = [];

  const notifiedDuplicateMedia = new Set();

  try {
    for (const link of links) {
      try {
        const normalized = normalizeUrl(link.url);
        const lockKey = normalized || link.url;

        if (inFlightDownloads.has(lockKey)) {
          await inFlightDownloads.get(lockKey).catch(() => {});
        }

        const workPromise = (async () => {
          // If general link detector already flagged this URL as duplicate, skip download/upload
          const isDuplicateLink =
            (options.duplicateNormalizedSet && normalized && options.duplicateNormalizedSet.has(normalized)) ||
            (Array.isArray(options.duplicateUrls) &&
              options.duplicateUrls.some(
                (d) => (d.normalizedUrl && d.normalizedUrl === normalized) || d.originalUrl === link.url
              ));
          if (isDuplicateLink) {
            return;
          }

          // Fast Pre-Download Duplicate Check (Platform Media ID / URL match)
          if (config.enableDuplicatePrevention) {
            const urlMatch = await findDuplicateByUrl(link.url);
            if (urlMatch) {
              const matchKey = urlMatch.mediaId || urlMatch.originalUrl || link.url;
              if (!notifiedDuplicateMedia.has(matchKey)) {
                notifiedDuplicateMedia.add(matchKey);
                console.log(
                  `[Duplicate Detector] Duplicate found (Platform Media ID (${urlMatch.mediaId || link.url}))! Originally posted by @${urlMatch.postedBy} in #${urlMatch.channel}`
                );
                const dupNotice = await safeReply(message, {
                  content: `ℹ️ This media was already posted by **@${urlMatch.postedBy}** in **#${urlMatch.channel}**!`,
                  allowedMentions: { repliedUser: false },
                }, options.overrideChannel);
                scheduleAutoDelete(dupNotice);
              }
              return; // Skip downloading and processing this already-archived post entirely
            }
          }

          if (onStatus) {
            await onStatus('downloading');
          }

          const dlResult = link.type === 'direct'
            ? [await downloadDirect(link.url, tempDir, config.hardCapBytes)]
            : await downloadPlatformLink(link.url, tempDir, 2, options);

          const filePaths = Array.isArray(dlResult) ? dlResult : (dlResult.mediaFiles || []);
          const subtitleFiles = Array.isArray(dlResult) ? [] : (dlResult.subtitleFiles || []);

          const currentMediaId = extractPlatformMediaId(link.url);
          const postRecordsToSave = [];

          for (const filePath of filePaths) {
            const authorTag = message.author?.tag || message.author?.username || 'Unknown';
            const channelName = message.channel?.name || message.channelId || 'chat';
            const parsedPath = path.parse(filePath);
            const cleanTitle = parsedPath.name;

            // Compute multi-factor media fingerprint (Platform ID, SHA-256, Duration, Multi-Frame Hash)
            const fingerprint = await computeMediaFingerprint(filePath, link.url);

            // Check for duplicate visual media against older posts (ignoring items from this same post)
            if (config.enableDuplicatePrevention) {
              const { match, reason, distance } = await findDuplicate(fingerprint, {
                ignoreMediaId: currentMediaId,
                ignoreOriginalUrl: link.url,
              });
              if (match) {
                const matchKey = match.mediaId || match.originalUrl || match.hash || link.url;
                if (!notifiedDuplicateMedia.has(matchKey)) {
                  notifiedDuplicateMedia.add(matchKey);
                  console.log(
                    `[Duplicate Detector] Duplicate found (${reason || `dist=${distance}`})! Originally posted by @${match.postedBy} in #${match.channel}`
                  );
                  const dupNotice = await safeReply(message, {
                    content: `ℹ️ This media was already posted by **@${match.postedBy}** in **#${match.channel}**!`,
                    allowedMentions: { repliedUser: false },
                  }, options.overrideChannel);
                  scheduleAutoDelete(dupNotice);
                }
                continue; // Skip saving duplicate file and skip uploading attachment
              }
            }

            // Permanently save uncompressed high-quality file to local archive folder on PC
            const archivedPath = await archiveLocalMedia(filePath, {
              url: link.url,
              author: authorTag,
              channel: channelName,
              title: cleanTitle,
              mediaId: fingerprint.mediaId,
              sha256: fingerprint.sha256,
              subtitleFiles: subtitleFiles,
            });

            // Queue entry into media index database
            postRecordsToSave.push({
              mediaId: fingerprint.mediaId,
              sha256: fingerprint.sha256,
              duration: fingerprint.duration,
              hash: fingerprint.hash,
              originalUrl: link.url,
              title: cleanTitle,
              postedBy: authorTag,
              channel: channelName,
              archivedAt: new Date().toISOString(),
              fileName: archivedPath ? path.basename(archivedPath) : path.basename(filePath),
            });

            // Check if file fits or needs compression
            const originalStat = await fs.promises.stat(filePath).catch(() => null);
            const originalFileSize = originalStat ? originalStat.size : 0;
            const needsCompression =
              config.enableCompression && isVideo(filePath) && originalFileSize > config.maxFileSizeBytes;

            let discoveredThumbPath = null;
            if (config.prependThumbnailPreview && isVideo(filePath)) {
              discoveredThumbPath = await findThumbnailFile(filePath, tempDir);
            }

            let uploadCandidatePath = filePath;
            // If the video already fits within limit, inject thumbnail directly (fast single pass)
            // If oversized, compressVideo will inject discoveredThumbPath directly during compression (single pass)
            if (!needsCompression && discoveredThumbPath) {
              uploadCandidatePath = await applyThumbnailPreview(filePath, tempDir, discoveredThumbPath);
            }

            try {
              const finalPath = await ensureWithinLimit(
                uploadCandidatePath,
                onStatus,
                needsCompression ? discoveredThumbPath : null
              );
              if (finalPath) {
                const finalExt = path.extname(finalPath);
                const attachmentName = `${cleanTitle}${finalExt}`;
                attachments.push({
                  attachment: new AttachmentBuilder(finalPath, { name: attachmentName }),
                  title: cleanTitle,
                  isVideo: isVideo(finalPath),
                  isAudio: isAudio(finalPath),
                });

                // Attach Subtitles (if uploading to Discord is enabled)
                if (config.uploadSubtitlesToDiscord && subtitleFiles && subtitleFiles.length > 0) {
                  // Find English subs (handles .en.srt, .en-US.srt, and YouTube track IDs like .en-eEY6OEpapPo.srt)
                  const enRegex = /(?:^|[._-])en(?:[-_][a-zA-Z0-9]+)?\.(?:srt|vtt)$/i;
                  const englishSubs = subtitleFiles.filter((s) => enRegex.test(path.basename(s)));
                  const nonEnglishSubs = subtitleFiles.filter((s) => !englishSubs.includes(s));

                  // 1. Always prioritize and attach English subtitles individually
                  for (const enSub of englishSubs) {
                    const cleanName = getCleanSubtitleFilename(enSub, cleanTitle);
                    attachments.push({
                      attachment: new AttachmentBuilder(enSub, { name: cleanName }),
                      title: `${cleanTitle} (English CC)`,
                      isVideo: false,
                      isAudio: false,
                    });
                  }

                  // 2. Handle remaining subtitles (Zip if too many)
                  if (nonEnglishSubs.length > 0) {
                    if (config.zipMultiSubtitles && subtitleFiles.length > config.maxIndividualSubtitles) {
                      try {
                        const zipPath = path.join(tempDir, `${cleanTitle}_subtitles.zip`);
                        const { spawnSync } = await import('node:child_process');
                        
                        const zipArgs = ['-a', '-c', '-f', path.basename(zipPath)];
                        // Add ALL subtitle files into the zip for completeness
                        for (const sub of subtitleFiles) {
                          zipArgs.push(path.basename(sub));
                        }
                        
                        const zipRes = spawnSync('tar', zipArgs, { cwd: tempDir, windowsHide: true });
                        if (zipRes.status === 0 && fs.existsSync(zipPath)) {
                          attachments.push({
                            attachment: new AttachmentBuilder(zipPath, { name: path.basename(zipPath) }),
                            title: `${cleanTitle} (All Subtitles)`,
                            isVideo: false,
                            isAudio: false,
                          });
                        } else {
                          console.error('[Subtitles] Failed to zip subtitles:', zipRes.stderr?.toString());
                          // Fallback to individual
                          for (const sub of nonEnglishSubs) {
                            attachments.push({
                              attachment: new AttachmentBuilder(sub, { name: getCleanSubtitleFilename(sub, cleanTitle) }),
                              title: `${cleanTitle} (CC)`,
                              isVideo: false,
                              isAudio: false,
                            });
                          }
                        }
                      } catch (err) {
                        console.error('[Subtitles] Error creating zip:', err);
                      }
                    } else {
                      // Attach remaining non-English subtitles individually
                      for (const sub of nonEnglishSubs) {
                        attachments.push({
                          attachment: new AttachmentBuilder(sub, { name: getCleanSubtitleFilename(sub, cleanTitle) }),
                          title: `${cleanTitle} (CC)`,
                          isVideo: false,
                          isAudio: false,
                        });
                      }
                    }
                  }
                }
              } else {
                failures.push({ url: link.url, reason: 'too large to upload even after compression' });
              }
            } catch (limitErr) {
              failures.push({ url: link.url, reason: describeError(limitErr) });
            }
          }

          // Save all records from this post together
          for (const record of postRecordsToSave) {
            await saveRecord(record);
          }
        })();

        inFlightDownloads.set(lockKey, workPromise);
        try {
          await workPromise;
        } finally {
          if (inFlightDownloads.get(lockKey) === workPromise) {
            inFlightDownloads.delete(lockKey);
          }
        }
      } catch (err) {
        console.error(`Failed to download ${link.url}:`, err);
        failures.push({ url: link.url, reason: describeError(err) });
      }
    }

    if (attachments.length > 0) {
      // Method B: Direct multi-batch replies chunked at Discord's 10-attachment limit
      const totalBatches = Math.ceil(attachments.length / 10);
      for (let i = 0; i < attachments.length; i += 10) {
        const chunk = attachments.slice(i, i + 10);
        const batchNum = Math.floor(i / 10) + 1;
        const files = chunk.map((c) => c.attachment);
        const replyOptions = { files };

        if (config.includeTitleInMessage) {
          const validItems = chunk.filter((item) => isValidDisplayTitle(item.title));
          const uniqueTitles = [...new Set(validItems.map((item) => item.title.replace(/[\r\n]+/g, ' ').trim()))];

          if (totalBatches > 1) {
            const albumTitle = uniqueTitles.length === 1 ? ` — **${uniqueTitles[0]}**` : '';
            replyOptions.content = `🖼️ Album Part ${batchNum}/${totalBatches} (${chunk.length} items)${albumTitle}:`;
          } else if (uniqueTitles.length === 1) {
            const singleItem = validItems[0] || chunk[0];
            const icon = singleItem.isVideo ? '🎬' : singleItem.isAudio ? '🎵' : '🖼️';
            replyOptions.content = `${icon} **${uniqueTitles[0]}**`;
          } else if (uniqueTitles.length > 1) {
            const titleLines = validItems.slice(0, 5).map((item) => {
              const icon = item.isVideo ? '🎬' : item.isAudio ? '🎵' : '🖼️';
              const t = item.title.replace(/[\r\n]+/g, ' ').trim();
              return `${icon} **${t}**`;
            });
            replyOptions.content = [...new Set(titleLines)].join('\n');
          }
        } else if (totalBatches > 1) {
          replyOptions.content = `🖼️ Album Part ${batchNum}/${totalBatches} (${chunk.length} items):`;
        }

        await safeReply(message, replyOptions, options.overrideChannel);
      }

      // Automatically suppress the original link's preview embed to keep chat clean
      if (config.autoSuppressEmbeds) {
        await message.suppressEmbeds(true).catch(() => {});
      }
    }

    if (failures.length > 0) {
      // Cap displayed failures to the first 5 entries to stay within Discord's
      // 2,000-character content limit when a user pastes a large batch of URLs.
      const MAX_SHOWN = 5;
      const shownFailures = failures.slice(0, MAX_SHOWN);
      const overflowCount = failures.length - shownFailures.length;
      const lines = shownFailures.map((f) => `- <${f.url}>: ${f.reason}`);
      if (overflowCount > 0) {
        lines.push(`_…and ${overflowCount} more._`);
      }
      const notice = await safeReply(message, {
        content: `Couldn't fetch some media:\n${lines.join('\n')}`,
        allowedMentions: { repliedUser: false },
      }, options.overrideChannel);
      scheduleAutoDelete(notice);
    }

    return { found: links.length, uploaded: attachments.length, failed: failures.length };
  } finally {
    await cleanup(tempDir);
  }
}

/**
 * Processes a single Discord message: finds media links, queues downloads,
 * and replies with the results as file attachments with live Method 3 status indicators.
 *
 * @param {import('discord.js').Message} message
 * @param {{ notifyIfEmpty?: boolean }} [options]
 * @returns {Promise<{ found: number, uploaded: number, failed: number }>}
 */
export async function handleMessage(message, options = {}) {
  // 1. YouTube Playlist Detection
  if (config.enablePlaylistDownload && !options.isRescan && !options.ignorePlaylists) {
    const urls = message.content.match(/https?:\/\/[^\s<>()\[\]"]+/gi) || [];
    for (const rawUrl of urls) {
      const details = extractYouTubePlaylistDetails(rawUrl);
      if (details.isPlaylist) {
        // We defer to playlistHandler for prompt & download
        // We import it dynamically to avoid circular dependencies
        const { handlePlaylistPromptAndDownload } = await import('./playlistHandler.js');
        return await handlePlaylistPromptAndDownload(message, rawUrl, details, options);
      }
    }
  }

  const links = await extractMediaLinksAsync(message.content);
  if (links.length === 0) {
    if (options.notifyIfEmpty) {
      const notice = await safeReply(message, {
        content: "I didn't find any media links in that message.",
        allowedMentions: { repliedUser: false },
      });
      scheduleAutoDelete(notice);
    }
    return { found: 0, uploaded: 0, failed: 0 };
  }

  const duplicateNormalizedSet = new Set(
    (options.duplicateUrls || []).map((d) => d.normalizedUrl)
  );

  // Route through download concurrency queue with live Method 3 status indicators
  return downloadQueue.add(message, ({ onStatus }) =>
    processMessage(message, links, { ...options, duplicateNormalizedSet }, onStatus)
  );
}

function describeError(err) {
  const msg = err?.message || String(err);
  if (msg.startsWith('QUALITY_PRESERVATION_LIMIT')) {
    return 'media is too long to fit upload limit without severe quality loss (original preserved in local archive)';
  }
  if (msg.startsWith('FILE_TOO_LARGE')) return 'file exceeds the size limit';
  if (msg === 'YTDLP_NO_MEDIA_FOUND' || msg === 'GALLERYDL_NO_MEDIA_FOUND') {
    return 'no downloadable media found (or it exceeded the size limit)';
  }
  if (msg.includes('Unavailable')) {
    return 'post is unavailable (deleted, private, or age-restricted)';
  }
  if (msg.includes('NotFoundError') || msg.includes('could not be found')) {
    return 'post was not found or deleted';
  }
  if (msg.includes('HTTP redirect to login page') || msg.includes('login page') || msg.includes('login required') || msg.includes('AuthenticationError')) {
    return 'post requires login credentials/cookies to download';
  }
  if (msg.includes('GLIBC') || msg.includes('PyInstaller')) {
    return 'server binary incompatibility (run `pip install gallery-dl` on your server)';
  }
  if (msg.startsWith('COMMAND_NOT_FOUND')) return `server misconfiguration (${msg})`;
  if (msg.startsWith('TIMEOUT')) return 'download timed out';
  return 'download failed';
}

/**
 * yt-dlp is best for video/GIF posts; gallery-dl is built for image
 * galleries and handles static-image posts (e.g. a plain photo tweet) that
 * yt-dlp explicitly refuses ("No video could be found in this tweet").
 * Includes automatic retry with exponential backoff for transient timeouts and rate limits.
 *
 * DeviantArt has no yt-dlp extractor, so it is routed directly to gallery-dl
 * to avoid wasting a round-trip on a guaranteed failure.
 */
async function downloadPlatformLink(url, destDir, maxRetries = 2, dlOptions = {}) {
  let lastErr = null;
  const options = { extractAudio: isAudioUrl(url) };

  // Anti-Bot: apply randomized human reaction jitter on initial request attempt
  if (config.enableHumanJitter && !dlOptions.skipJitter) {
    const jitterMs = getHumanJitterMs(config.humanJitterMinMs, config.humanJitterMaxMs);
    console.log(`[Anti-Bot] ⏳ Applied human jitter delay (${(jitterMs / 1000).toFixed(1)}s) before requesting <${url}>`);
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
          console.warn(
            `[Downloader] DeviantArt download of <${url}> hit transient error (${err.message}), retrying attempt ${attempt + 1}/${maxRetries + 1}...`
          );
          await new Promise((r) => setTimeout(r, attempt * 3000));
          continue;
        }
        break;
      }
    }
    throw lastErr || new Error('Download failed');
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
          console.warn(
            `[Downloader] Download of <${url}> encountered transient error (${lastErr.message}), retrying attempt ${attempt + 1}/${maxRetries + 1}...`
          );
          await new Promise((r) => setTimeout(r, attempt * 3000));
          continue;
        }
      }
    }
  }

  throw lastErr || new Error('Download failed');
}

/**
 * Normalizes subtitle filenames to standard '<Title>.<lang>.<ext>' by stripping
 * custom internal YouTube track IDs (e.g. 'Song.ja-eEY6OEpapPo.srt' -> 'Song.ja.srt').
 */
function getCleanSubtitleFilename(subPath, cleanTitle) {
  const ext = path.extname(subPath) || '.srt';
  const base = path.basename(subPath, ext);
  const match = base.match(/(?:^|[._-])([a-zA-Z]{2,3}(?:-[A-Za-z]{2,4})?)(?:-[a-zA-Z0-9_-]+)?$/i);
  return match ? `${cleanTitle}.${match[1]}${ext}` : path.basename(subPath);
}
