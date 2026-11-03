import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AttachmentBuilder } from 'discord.js';
import { config, isChannelAllowed } from './config.js';
import {
  extractMediaLinksAsync,
  extractMessageAttachments,
  extractPlatformMediaId,
  normalizeUrl,
  extractYouTubePlaylistDetails,
  shouldSpoilerMedia,
  stripQueryAndTrailingPunctuation,
  URL_REGEX,
} from './urlExtractor.js';
import { downloadDirect } from './directDownloader.js';
import { downloadPlatformMedia } from './downloaderCore.js';
import { ensureWithinLimit } from './compress.js';
import {
  isVideo,
  isAudio,
  scheduleAutoDelete,
  isAbortError,
  safeReply,
  buildDuplicateActionRow,
  formatDiscordAuthor,
  isValidDisplayTitle,
  formatMediaMessageContent,
  getHumanJitterMs,
  sleep,
} from './utils.js';
import { archiveLocalMedia, prepareSubtitleAttachments, readArchivedSidecar } from './archiver.js';
import { computeMediaFingerprint } from './phasher.js';
import { findDuplicate, findDuplicateByUrl, saveRecordBatch } from './db.js';
import { downloadQueue } from './queue.js';
import { applyThumbnailPreview, findThumbnailFile } from './thumbnailPreview.js';
import { processDualFormatMedia } from './gifHandler.js';
import { handlePlaylistPromptAndDownload } from './playlistHandler.js';

export { safeReply, isValidDisplayTitle, ensureWithinLimit };

// Mutex map to prevent duplicate parallel processing of the same URL
const inFlightDownloads = new Map();

async function makeTempDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'archivist-fox-'));
}

async function cleanup(dir) {
  if (!config.cleanupTempFiles) return;
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Resolves a previously archived local copy in O(1) via `relativePath` or channel folder,
 * falling back to a recursive search only for legacy unindexed files.
 */
async function resolveLocalArchiveCopy(urlMatch, tempDir) {
  const rootDir = path.resolve(config.archiveDirectory);
  const directCandidates = [];

  if (urlMatch.relativePath) {
    directCandidates.push(path.join(rootDir, urlMatch.relativePath));
  }
  if (urlMatch.fileName) {
    if (urlMatch.channel) {
      directCandidates.push(path.join(rootDir, urlMatch.channel, urlMatch.fileName));
    }
    directCandidates.push(path.join(rootDir, urlMatch.fileName));
  }

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) {
      const destPath = path.join(tempDir, path.basename(candidate));
      await fs.promises.copyFile(candidate, destPath);
      const sidecar = await readArchivedSidecar(candidate);
      console.log(`[Reup] ⚡ Found local archive copy: ${path.basename(candidate)}, skipping re-download.`);
      return { destPath, isNsfw: Boolean(sidecar?.isNsfw) };
    }
  }

  if (!urlMatch.fileName || !fs.existsSync(rootDir)) return null;

  try {
    const entries = await fs.promises.readdir(rootDir, { recursive: true, withFileTypes: true });
    const found = entries.find((e) => e.isFile() && e.name === urlMatch.fileName);
    if (found) {
      const foundPath = path.join(found.parentPath || found.path, found.name);
      const destPath = path.join(tempDir, found.name);
      await fs.promises.copyFile(foundPath, destPath);
      const sidecar = await readArchivedSidecar(foundPath);
      console.log(`[Reup] ⚡ Found local archive copy: ${found.name}, skipping re-download.`);
      return { destPath, isNsfw: Boolean(sidecar?.isNsfw) };
    }
  } catch (err) {
    console.error('[Reup] Could not search local archive:', err.message);
  }

  return null;
}

/**
 * Internal execution pipeline for processing a message.
 */
async function processMessage(message, links, options = {}, onStatus, signal = null) {
  const effectiveSignal = signal || options?.signal || null;
  const tempDir = await makeTempDir();
  let totalArchived = 0;
  let totalUploaded = 0;
  let totalFailed = 0;
  let hasSuppressedEmbeds = false;
  const failures = [];
  let consecutiveDirectCount = 0;

  const notifiedDuplicateMedia = new Set();
  const canDeletePost = links.length === 1 && !options.overrideChannel;
  const archiveRoot = path.resolve(config.archiveDirectory);

  try {
    for (const link of links) {
      if (effectiveSignal?.aborted) {
        break;
      }
      try {
        const normalized = normalizeUrl(link.url);
        const platformMediaId = link.mediaId || extractPlatformMediaId(link.url);
        const lockKey = platformMediaId || normalized || link.url;

        if (inFlightDownloads.has(lockKey)) {
          await inFlightDownloads.get(lockKey).catch(() => {});
        }
        if (effectiveSignal?.aborted) {
          break;
        }

        const workPromise = (async () => {
          // If general link detector already flagged this URL as duplicate, skip download/upload
          const isDuplicateLink = !link.archiveOnly && !options.force && (
            (options.duplicateNormalizedSet && normalized && options.duplicateNormalizedSet.has(normalized)) ||
            (Array.isArray(options.duplicateUrls) &&
              options.duplicateUrls.some(
                (d) => (d.normalizedUrl && d.normalizedUrl === normalized) || d.originalUrl === link.url
              ))
          );
          if (isDuplicateLink) {
            return;
          }

          let localArchiveCandidate = null;

          // Fast Pre-Download Duplicate Check (Platform Media ID / URL match)
          if (config.enableDuplicatePrevention || options.force || link.archiveOnly) {
            const urlMatch = await findDuplicateByUrl(link.url, platformMediaId);
            if (urlMatch) {
              // If this exact Discord manual attachment ID was already archived, skip silently without re-downloading
              if (link.archiveOnly && !options.force) {
                return;
              }
              if (options.force && (urlMatch.relativePath || urlMatch.fileName)) {
                localArchiveCandidate = await resolveLocalArchiveCopy(urlMatch, tempDir);
              } else if (!options.force) {
                const matchKey = urlMatch.mediaId || urlMatch.originalUrl || link.url;
                if (!notifiedDuplicateMedia.has(matchKey)) {
                  notifiedDuplicateMedia.add(matchKey);
                  console.log(
                    `[Duplicate Detector] Duplicate found (Platform Media ID (${urlMatch.mediaId || link.url}))! Originally posted by @${urlMatch.postedBy} in #${urlMatch.channel}`
                  );
                  const replyOpts = {
                    content: `ℹ️ This media was already posted by **@${urlMatch.postedBy}** in **#${urlMatch.channel}**!`,
                    allowedMentions: { repliedUser: false },
                  };
                  if (!options.overrideChannel) {
                    replyOpts.components = [
                      buildDuplicateActionRow({
                        messageId: message.id,
                        authorId: message.author?.id,
                        canDeletePost,
                      }),
                    ];
                  }
                  const dupNotice = await safeReply(message, replyOpts, options.overrideChannel);
                  scheduleAutoDelete(dupNotice);
                }
                return; // Skip downloading and processing this already-archived post entirely
              }
            }
          }

          if (onStatus && !link.archiveOnly) {
            await onStatus('downloading');
          }

          let dlResult;
          if (localArchiveCandidate) {
            dlResult = { mediaFiles: [localArchiveCandidate.destPath], isNsfw: localArchiveCandidate.isNsfw };
            consecutiveDirectCount = 0;
          } else if (link.type === 'direct') {
            if (config.enableHumanJitter && consecutiveDirectCount > 0) {
              const microJitter = getHumanJitterMs(200, 450);
              if (microJitter > 0) {
                await sleep(microJitter, effectiveSignal);
              }
            }
            consecutiveDirectCount++;
            dlResult = [
              await downloadDirect(link.url, tempDir, config.hardCapBytes, {
                signal: effectiveSignal,
                allowLoopback: options.allowLoopback,
                filename: link.filename,
              }),
            ];
          } else {
            consecutiveDirectCount = 0;
            dlResult = await downloadPlatformMedia(link.url, tempDir, 2, { ...options, signal: effectiveSignal });
          }

          const filePaths = Array.isArray(dlResult) ? dlResult : (dlResult.mediaFiles || []);
          const subtitleFiles = Array.isArray(dlResult) ? [] : (dlResult.subtitleFiles || []);
          const isDownloadedNsfw = Boolean(dlResult?.isNsfw);

          // Determine if media should be spoilered
          const shouldSpoiler = shouldSpoilerMedia({
            isDownloadedNsfw,
            isKnownNsfw: Boolean(link.isKnownNsfw),
            url: link.url,
            isUserSpoiler: Boolean(link.isSpoiler),
            isChannelNsfw: Boolean(message.channel?.nsfw),
          });

          const postRecordsToSave = [];
          const linkAttachments = [];
          let firstCleanTitle = '';

          for (const filePath of filePaths) {
            const authorTag = formatDiscordAuthor(message.author);
            const channelName = message.channel?.name || message.channelId || 'chat';
            const parsedPath = path.parse(filePath);
            const cleanTitle = parsedPath.name;
            if (!firstCleanTitle) firstCleanTitle = cleanTitle;

            // Compute multi-factor media fingerprint (Platform ID, SHA-256, Duration, Multi-Frame Hash)
            const fingerprint = await computeMediaFingerprint(filePath, link.url, { signal: effectiveSignal });
            if (platformMediaId && !fingerprint.mediaId) {
              fingerprint.mediaId = platformMediaId;
            }

            // Check for duplicate visual media against older posts
            if (config.enableDuplicatePrevention && !options.force) {
              const { match, reason, distance } = await findDuplicate(fingerprint);
              if (match) {
                const matchKey = match.mediaId || match.originalUrl || match.hash || link.url;
                if (!notifiedDuplicateMedia.has(matchKey)) {
                  notifiedDuplicateMedia.add(matchKey);
                  console.log(
                    `[Duplicate Detector] Duplicate found (${reason || `dist=${distance}`})! Originally posted by @${match.postedBy} in #${match.channel}`
                  );
                  const replyOpts = {
                    content: `ℹ️ This media was already posted by **@${match.postedBy}** in **#${match.channel}**!`,
                    allowedMentions: { repliedUser: false },
                  };
                  if (!options.overrideChannel) {
                    replyOpts.components = [
                      buildDuplicateActionRow({
                        messageId: message.id,
                        authorId: message.author?.id,
                        canDeletePost,
                      }),
                    ];
                  }
                  const dupNotice = await safeReply(message, replyOpts, options.overrideChannel);
                  scheduleAutoDelete(dupNotice);
                }
                continue; // Skip saving duplicate file and skip uploading attachment
              }
            }

            // Dual-Format High-Quality GIF Pipeline (Detects short silent videos & original GIFs)
            let dualResult = { primaryFile: filePath, companionFiles: [], isGif: false };
            if (config.enableGifPipeline) {
              try {
                dualResult = await processDualFormatMedia(filePath, tempDir, {
                  metadata: { is_gif: dlResult?.isOriginalGif },
                  signal: effectiveSignal,
                });
              } catch (gifErr) {
                if (isAbortError(gifErr) || effectiveSignal?.aborted) throw gifErr;
                console.warn('[GIF Pipeline] Processing error, continuing with original file:', gifErr.message);
              }
            }

            // Permanently save uncompressed high-quality file to local archive folder on PC
            // If dual-format was generated, companionFiles ensures both MP4 & GIF are preserved locally
            const archivedPath = await archiveLocalMedia(filePath, {
              url: link.url,
              author: authorTag,
              channel: channelName,
              title: cleanTitle,
              mediaId: fingerprint.mediaId,
              sha256: fingerprint.sha256,
              isNsfw: isDownloadedNsfw || Boolean(link.isKnownNsfw),
              subtitleFiles: subtitleFiles,
              companionFiles: config.archiveBothFormats ? dualResult.companionFiles : [],
            });

            if (archivedPath) {
              totalArchived++;
            }

            const archivedStat = archivedPath
              ? await fs.promises.stat(archivedPath).catch(() => null)
              : await fs.promises.stat(filePath).catch(() => null);
            const relativePath = archivedPath
              ? path.relative(archiveRoot, archivedPath).split(path.sep).join('/')
              : null;

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
              relativePath,
              fileSize: archivedStat ? archivedStat.size : null,
            });

            // Manual user attachments are already uploaded in Discord chat; skip re-uploading a copy
            if (link.archiveOnly) {
              continue;
            }

            // Adaptive upload candidate: use GIF if fits within Discord limits, else fallback to pristine MP4
            const uploadCandidate = dualResult.primaryFile || filePath;
            const isTargetGif = dualResult.isGif || path.extname(uploadCandidate).toLowerCase() === '.gif';

            // Check if file fits or needs compression (GIFs do not undergo lossy MP4 re-encoding)
            const originalStat = await fs.promises.stat(uploadCandidate).catch(() => null);
            const originalFileSize = originalStat ? originalStat.size : 0;
            const needsCompression =
              config.enableCompression && !isTargetGif && isVideo(uploadCandidate) && originalFileSize > config.maxFileSizeBytes;

            let discoveredThumbPath = null;
            if (config.prependThumbnailPreview && !isTargetGif && isVideo(uploadCandidate)) {
              discoveredThumbPath = await findThumbnailFile(uploadCandidate, tempDir);
            }

            const preProbedInfo = uploadCandidate === filePath ? fingerprint.mediaInfo : undefined;
            let uploadCandidatePath = uploadCandidate;
            // If the video already fits within limit, inject thumbnail directly (fast single pass)
            // If oversized, compressVideo will inject discoveredThumbPath directly during compression (single pass)
            if (!needsCompression && discoveredThumbPath) {
              uploadCandidatePath = await applyThumbnailPreview(uploadCandidate, tempDir, discoveredThumbPath, {
                signal: effectiveSignal,
                mediaInfo: preProbedInfo,
              });
            }

            try {
              const finalPath = await ensureWithinLimit(
                uploadCandidatePath,
                onStatus,
                needsCompression ? discoveredThumbPath : null,
                {
                  signal: effectiveSignal,
                  mediaInfo: uploadCandidatePath === filePath ? preProbedInfo : undefined,
                }
              );
              if (finalPath) {
                const finalExt = path.extname(finalPath);
                const attachmentName = `${cleanTitle}${finalExt}`;
                const mediaAttachment = new AttachmentBuilder(finalPath, { name: attachmentName });
                if (shouldSpoiler) {
                  mediaAttachment.setSpoiler(true);
                }
                linkAttachments.push({
                  attachment: mediaAttachment,
                  title: cleanTitle,
                  isVideo: isVideo(finalPath),
                  isAudio: isAudio(finalPath),
                  isSubtitle: false,
                  isSpoiler: shouldSpoiler,
                });
              } else {
                failures.push({ url: link.url, reason: 'too large to upload even after compression' });
              }
            } catch (limitErr) {
              failures.push({ url: link.url, reason: describeError(limitErr) });
            }
          }

          // Attach Subtitles ONCE per link (outside the filePaths loop so multi-video posts never duplicate .srt sidecars)
          if (linkAttachments.length > 0 && config.uploadSubtitlesToDiscord && subtitleFiles.length > 0) {
            const subAttachments = await prepareSubtitleAttachments(
              subtitleFiles,
              firstCleanTitle,
              tempDir,
              shouldSpoiler,
              effectiveSignal
            );
            for (const subAttachment of subAttachments) {
              linkAttachments.push({
                attachment: subAttachment,
                title: `${firstCleanTitle} (CC)`,
                isVideo: false,
                isAudio: false,
                isSubtitle: true,
                isSpoiler: shouldSpoiler,
              });
            }
          }

          // Save all records from this post together in a single SQLite transaction
          await saveRecordBatch(postRecordsToSave);

          // Upload media attachments for this specific link
          if (linkAttachments.length > 0) {
            const totalBatches = Math.ceil(linkAttachments.length / 10);
            for (let i = 0; i < linkAttachments.length; i += 10) {
              const chunk = linkAttachments.slice(i, i + 10);
              const batchNum = Math.floor(i / 10) + 1;
              const files = chunk.map((c) => c.attachment);
              const replyOptions = { files };

              const content = formatMediaMessageContent(chunk, { batchNum, totalBatches });
              if (content) {
                replyOptions.content = content;
              }

              await safeReply(message, replyOptions, options.overrideChannel);
              totalUploaded += chunk.length;
            }

            // Automatically suppress the original link's preview embed once media is uploaded
            if (config.autoSuppressEmbeds && !hasSuppressedEmbeds) {
              hasSuppressedEmbeds = true;
              try {
                await message.suppressEmbeds(true);
              } catch (suppressErr) {
                // If Discord's unfurler crawler was still generating the embed or socket was congested, retry once after a short delay
                setTimeout(() => {
                  message.suppressEmbeds(true).catch((err) => {
                    console.warn(`[MediaHandler] Could not suppress embed for message ${message.id}:`, err?.message || err);
                  });
                }, 1500).unref?.();
              }
            }
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
        if (isAbortError(err) || effectiveSignal?.aborted) {
          console.log(`[Downloader] Download of <${link.url}> was stopped by user.`);
          break;
        }
        totalFailed++;
        console.error(`Failed to download ${link.url}:`, err);
        if (!link.archiveOnly || options.notifyIfEmpty) {
          failures.push({ url: link.url, reason: describeError(err) });
        }
      }
    }

    if (failures.length > 0 && !effectiveSignal?.aborted) {
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

    return {
      found: links.length,
      archived: totalArchived,
      uploaded: totalUploaded,
      failed: totalFailed || failures.length,
      stopped: Boolean(effectiveSignal?.aborted),
    };
  } finally {
    await cleanup(tempDir);
  }
}

/**
 * Processes a single Discord message: finds media links and user-uploaded attachments,
 * queues downloads/archiving, and replies with link attachments with live Method 3 status indicators.
 *
 * @param {import('discord.js').Message} message
 * @param {{ notifyIfEmpty?: boolean }} [options]
 * @returns {Promise<{ found: number, archived?: number, uploaded: number, failed: number }>}
 */
export async function handleMessage(message, options = {}) {
  const targetChannelId = message?.channelId || message?.channel?.id;
  if (!options.overrideChannel && targetChannelId && !isChannelAllowed(targetChannelId)) {
    return { found: 0, archived: 0, uploaded: 0, failed: 0 };
  }

  // 1. YouTube Playlist Detection
  if (config.enablePlaylistDownload && !options.isRescan && !options.ignorePlaylists) {
    const urls = message.content ? message.content.match(URL_REGEX) || [] : [];
    for (const rawUrl of urls) {
      const cleanUrl = stripQueryAndTrailingPunctuation(rawUrl);
      const details = extractYouTubePlaylistDetails(cleanUrl);
      if (details.isPlaylist) {
        return await handlePlaylistPromptAndDownload(message, cleanUrl, details, options, handleMessage);
      }
    }
  }

  const textLinks = await extractMediaLinksAsync(message.content);
  const attachmentLinks = extractMessageAttachments(message);
  const links = [...textLinks, ...attachmentLinks];

  if (links.length === 0) {
    if (options.notifyIfEmpty) {
      const notice = await safeReply(message, {
        content: "I didn't find any media links in that message.",
        allowedMentions: { repliedUser: false },
      });
      scheduleAutoDelete(notice);
    }
    return { found: 0, archived: 0, uploaded: 0, failed: 0 };
  }

  const duplicateNormalizedSet = new Set(
    (options.duplicateUrls || []).map((d) => d.normalizedUrl)
  );
  const allArchiveOnly = links.every((l) => l.archiveOnly);

  // Route through download concurrency queue (silent mode when only backing up manual user uploads)
  return downloadQueue.add(
    message,
    ({ onStatus, signal }) =>
      processMessage(message, links, { ...options, duplicateNormalizedSet }, onStatus, signal),
    { silent: allArchiveOnly }
  );
}

export function describeError(err) {
  const msg = err?.message || String(err || '');
  if (msg.startsWith('QUALITY_PRESERVATION_LIMIT')) {
    return 'media is too long to fit upload limit without severe quality loss (original preserved in local archive)';
  }
  if (msg.startsWith('FILE_TOO_LARGE')) return 'file exceeds the size limit';
  if (msg.startsWith('SSRF_BLOCKED')) return 'blocked unsafe or private network address';
  if (
    msg === 'YTDLP_NO_MEDIA_FOUND' ||
    msg === 'GALLERYDL_NO_MEDIA_FOUND' ||
    /no video (could be|formats) found/i.test(msg) ||
    /no downloadable media/i.test(msg) ||
    /no media found/i.test(msg)
  ) {
    return 'no downloadable media found (or it exceeded the size limit)';
  }
  if (msg.includes('Unavailable')) {
    return 'post is unavailable (deleted, private, or age-restricted)';
  }
  if (msg.includes('NotFoundError') || msg.toLowerCase().includes('could not be found')) {
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
