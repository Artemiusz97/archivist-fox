import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChannelType, PermissionFlagsBits, AttachmentBuilder } from 'discord.js';
import { config, isChannelAllowed, isLinkBackupChannel } from './config.js';
import {
  extractMediaLinksAsync,
  extractMessageAttachments,
  extractAllUrlsAsync,
  normalizeUrl,
  extractPlatformMediaId,
  shouldSpoilerMedia,
} from './urlExtractor.js';
import { downloadDirect } from './directDownloader.js';
import { downloadPlatformMedia } from './downloaderCore.js';
import { archiveLocalMedia, prepareSubtitleAttachments, readArchivedSidecar } from './archiver.js';
import { computeMediaFingerprint } from './phasher.js';
import { saveRecordBatch, findDuplicateByUrl, findDuplicate } from './db.js';
import { saveLinkRecordBatch, findDuplicateLink } from './linkDb.js';
import { ensureWithinLimit } from './compress.js';
import { applyThumbnailPreview, findThumbnailFile } from './thumbnailPreview.js';
import { processDualFormatMedia } from './gifHandler.js';
import { downloadQueue } from './queue.js';
import { isPlaylistDownloading } from './playlistHandler.js';
import { isRestoreRunning, requestRestoreStop } from './linkRestorer.js';
import {
  scheduleAutoDelete,
  killAllDownloadProcesses,
  isAbortError,
  safeReply,
  formatDiscordAuthor,
  isModeratorOrOwner,
  isVideo,
  isAudio,
  formatMediaMessageContent,
  isStopRequested,
  requestStop,
  clearStopRequested,
} from './utils.js';

export { isStopRequested, requestStop, clearStopRequested };

let isScanningActive = false;
let scanAbortController = null;
let activeScanDownloads = 0;

export function isScanRunning() {
  return isScanningActive;
}

export function setScanRunning(val) {
  isScanningActive = Boolean(val);
  clearStopRequested();
}

export function requestScanStop() {
  if (isScanningActive) {
    requestStop();
    if (scanAbortController) {
      try {
        scanAbortController.abort();
      } catch (err) {
    void err;
  }
    }
    return true;
  }
  return false;
}

export function stopActiveTasks() {
  const scanRunning = isScanningActive;
  const playlistRunning = isPlaylistDownloading();
  const restoreRunning = isRestoreRunning();
  requestStop();
  if (scanAbortController) {
    try {
      scanAbortController.abort();
    } catch (err) {
    void err;
  }
  }
  requestRestoreStop();
  const { activeStopped, queueCleared } = downloadQueue.stopAll();
  const killedProcCount = killAllDownloadProcesses();
  const activeDownloadsStopped = Math.max(activeStopped, killedProcCount, activeScanDownloads);
  const queueItemsCleared = queueCleared;
  return { scanRunning, playlistRunning, restoreRunning, queueItemsCleared, activeDownloadsStopped };
}

/**
 * Formats the summary returned by `stopActiveTasks()` for `/stop` and `!stop`.
 */
export function formatStopSummary(stopped = {}) {
  const hasActiveTasks = Boolean(
    stopped.scanRunning ||
    stopped.playlistRunning ||
    stopped.restoreRunning ||
    (stopped.queueItemsCleared || 0) > 0 ||
    (stopped.activeDownloadsStopped || 0) > 0
  );

  let message;
  if (hasActiveTasks) {
    message = '🛑 **Stopped active tasks:**\n';
    if (stopped.scanRunning) message += '• Aborted active channel rescan / media crawl.\n';
    if (stopped.restoreRunning) message += '• Aborted active link restoration / reposting.\n';
    if (stopped.playlistRunning) message += '• Aborted active playlist download.\n';
    if (stopped.activeDownloadsStopped > 0) {
      message += `• Aborted **${stopped.activeDownloadsStopped}** download(s) in progress.\n`;
    }
    if (stopped.queueItemsCleared > 0) {
      message += `• Cleared **${stopped.queueItemsCleared}** queued download(s).\n`;
    }
    message = message.trimEnd();
  } else {
    message = 'ℹ️ No active downloads, rescan, playlist download, restoration, or queued tasks are currently running.';
  }

  return {
    hasActiveTasks,
    message,
    toString() {
      return message;
    },
    [Symbol.toPrimitive]() {
      return message;
    },
  };
}

/**
 * Parses user arguments for !rescan and !repost-missing commands.
 * Examples:
 *   !rescan
 *   !rescan 100
 *   !rescan #general
 *   !rescan all
 *   !rescan --repost-missing
 *   !repost-missing
 *   !repost-missing #music
 *   !repost-missing all
 */
export function parseRescanArgs(content, currentChannel) {
  const clean = content.trim();
  const isDirectRepostMissingCmd = clean.toLowerCase().startsWith('!repost-missing') || clean.toLowerCase().startsWith('!fix-missing');
  const parts = clean.split(/\s+/).slice(1);

  let target = 'current'; // 'current', 'all', or channel ID
  let limit = Infinity;   // default is all history
  let upload = false;
  let force = false;
  let repostMissing = isDirectRepostMissingCmd; // Default true if !repost-missing command
  let targetChannelId = null;
  let concurrency = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lower = part.toLowerCase();
    
    if (lower === '--concurrency' || lower === '-c') {
      if (i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) {
        concurrency = parseInt(parts[i + 1], 10);
        i++; // skip next part
      }
    } else if (lower === 'all') {
      target = 'all';
    } else if (lower === '--upload' || lower === '-u') {
      upload = true;
    } else if (lower === '--force' || lower === '-f') {
      force = true;
    } else if (lower === '--repost-missing' || lower === '--missing' || lower === '-m' || lower === '--upload-missing') {
      repostMissing = true;
    } else if (/^\d+$/.test(part) && parseInt(part, 10) > 0) {
      const num = parseInt(part, 10);
      if (part.length > 15) {
        // Likely a channel ID snowflake
        targetChannelId = part;
      } else {
        limit = num;
      }
    } else {
      const channelMentionMatch = part.match(/^<#(\d+)>$/);
      if (channelMentionMatch) {
        targetChannelId = channelMentionMatch[1];
      } else if (part.startsWith('#') || !part.startsWith('-')) {
        targetChannelId = part;
      }
    }
  }

  if (targetChannelId) {
    target = targetChannelId;
  }

  return { target, limit, upload, force, repostMissing, concurrency };
}

/**
 * Tracks download speed, item throughput, and ETA during channel crawling.
 */
class CrawlSpeedTracker {
  constructor() {
    this.startTime = Date.now();
    this.history = []; // { time, bytes }
    this.processedItems = 0;
  }

  recordBytes(bytes) {
    const now = Date.now();
    this.history.push({ time: now, bytes });
    const cutoff = now - 20000;
    while (this.history.length > 0 && this.history[0].time < cutoff) {
      this.history.shift();
    }
  }

  recordItem() {
    this.processedItems++;
  }

  getSpeedInfo(totalBytesArchived, remainingItems = 0, isFetchingDone = false) {
    const now = Date.now();
    const totalElapsedSec = Math.max(1, (now - this.startTime) / 1000);

    // Instantaneous / rolling speed over recent 15 seconds
    const recentCutoff = now - 15000;
    const recentWindow = this.history.filter((h) => h.time >= recentCutoff);
    let speedBytesPerSec = 0;
    if (recentWindow.length > 1) {
      const windowBytes = recentWindow.reduce((sum, h) => sum + h.bytes, 0);
      const oldestTime = recentWindow[0].time;
      const windowSec = Math.max(1, (now - oldestTime) / 1000);
      speedBytesPerSec = windowBytes / windowSec;
    } else {
      speedBytesPerSec = totalBytesArchived / totalElapsedSec;
    }

    const mbPerSec = speedBytesPerSec / (1024 * 1024);
    const speedStr = `${mbPerSec >= 10 ? mbPerSec.toFixed(1) : mbPerSec.toFixed(2)} MB/s`;

    const itemsPerSec = this.processedItems / totalElapsedSec;
    const itemsPerMin = (itemsPerSec * 60).toFixed(1);

    let etaStr = '';
    if (isFetchingDone && remainingItems > 0 && itemsPerSec > 0) {
      const estSec = Math.round(remainingItems / itemsPerSec);
      etaStr = ` | ETA: ${formatDuration(estSec * 1000)}`;
    } else if (!isFetchingDone) {
      etaStr = ' | Scanning history...';
    }

    return { speedStr, itemsPerMin, etaStr };
  }
}

function truncateUrl(url, maxLen = 65) {
  if (!url) return '';
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 3) + '...';
}

function resolveArchivedFilePath(existing, archiveRoot, channelName) {
  if (!existing) return null;
  const candidates = [];
  if (existing.relativePath) {
    candidates.push(path.join(archiveRoot, existing.relativePath));
  }
  if (existing.fileName) {
    if (existing.channel) {
      candidates.push(path.join(archiveRoot, existing.channel, existing.fileName));
    }
    candidates.push(path.join(archiveRoot, channelName, existing.fileName));
    candidates.push(path.join(archiveRoot, existing.fileName));
  }
  for (const cp of candidates) {
    if (fs.existsSync(cp)) return cp;
  }
  return null;
}

/**
 * Crawls a single Discord text channel, fetching messages in batches of 100,
 * extracting media links, archiving them to PC, and optionally reposting missing attachments.
 */
export async function crawlChannel(channel, options = {}, onProgress = null) {
  const stats = {
    channelName: channel.name || channel.id,
    messagesScanned: 0,
    mediaLinksFound: 0,
    linksBackedUp: 0,
    archivedCount: 0,
    repostedMissingCount: 0,
    skippedCount: 0,
    failedCount: 0,
    totalBytesArchived: 0,
  };

  const botId = channel.client?.user?.id;
  const repliedWithAttachmentMessageIds = new Set();
  const channelUploadedMediaKeys = new Set();
  const concurrency = options.concurrency || config.scannerConcurrency || 3;
  const archiveRoot = path.resolve(config.archiveDirectory);

  const workQueue = [];
  const candidateMessages = [];
  let isFetchingDone = false;
  let uploadMutex = Promise.resolve(); // Serializes Discord API uploads
  const inFlightUrls = new Set(); // Prevents parallel workers from downloading the exact same link
  const speedTracker = new CrawlSpeedTracker();

  scanAbortController = new AbortController();
  console.log(`[Scanner] 🚀 Crawl started for #${channel.name} (Concurrency: ${concurrency} workers)`);

  // Worker Loop (spawned once candidateMessages are queued in chronological order)
  const workerLoop = async (workerId) => {
    while (workQueue.length > 0) {
      if (isStopRequested()) {
        console.log(`[Scanner] [W${workerId}] 🛑 Stop requested. Worker exiting...`);
        break;
      }

      const message = workQueue.shift();
      if (!message || message.author.bot) continue;

      const isBackupChan = isLinkBackupChannel(channel);
      const authorTag = formatDiscordAuthor(message.author);
      const authorId = message.author?.id || '0';
      const postedAt = message.createdTimestamp || Date.now();
      const channelName = channel.name || 'chat';

      // 1. General duplicate link detector & Link Backup batch indexing
      if (config.enableGeneralDuplicateDetector || isBackupChan) {
        const allUrls = await extractAllUrlsAsync(message.content);
        const linksToSave = [];
        for (const { originalUrl, normalizedUrl } of allUrls) {
          const { isDuplicate } = findDuplicateLink(normalizedUrl, {
            scope: config.duplicateLinkScope,
            guildId: channel.guildId || null,
            channelId: channel.id,
          });
          if (!isDuplicate) {
            linksToSave.push({
              normalizedUrl,
              originalUrl,
              guildId: channel.guildId || null,
              channelId: channel.id,
              channelName,
              messageId: message.id,
              authorId,
              authorTag,
              postedAt,
              content: message.content || null,
              isBackup: isBackupChan,
            });
            if (isBackupChan) {
              stats.linksBackedUp++;
            }
          }
        }
        if (linksToSave.length > 0) {
          saveLinkRecordBatch(linksToSave);
        }
      }

      // If this channel is disallowed for media downloading (e.g. a link-backup-only channel),
      // skip downloading and uploading media files.
      if (!isChannelAllowed(channel.id)) {
        if (onProgress) {
          onProgress(stats).catch(() => {});
        }
        continue;
      }

      const textLinks = await extractMediaLinksAsync(message.content);
      const attachmentLinks = config.enableLocalArchive ? extractMessageAttachments(message) : [];
      const links = [...textLinks, ...attachmentLinks];
      if (links.length === 0) continue;

      const hasBotAttachment = repliedWithAttachmentMessageIds.has(message.id);
      const shouldUploadToDiscord = options.upload || (options.repostMissing && !hasBotAttachment);

      const messageAttachmentsToUpload = [];
      const tempDirsToCleanup = [];

      try {
        for (const link of links) {
          if (isStopRequested()) break;
          stats.mediaLinksFound++;
          const normalized = normalizeUrl(link.url);
          const platformMediaId = link.mediaId || extractPlatformMediaId(link.url);
          const itemShouldUploadToDiscord = !link.archiveOnly && shouldUploadToDiscord;
          const lockKey = platformMediaId || normalized || link.url;

          // If this message ALREADY has bot attachments in Discord, record its keys so duplicate posts won't re-upload
          if (hasBotAttachment && !link.archiveOnly) {
            if (normalized) channelUploadedMediaKeys.add(normalized);
            if (platformMediaId) channelUploadedMediaKeys.add(platformMediaId);
            channelUploadedMediaKeys.add(link.url);
          }

          // Check if this link is a duplicate of an earlier post in this channel/guild
          let isDuplicateOfEarlierPost = false;
          if (!link.archiveOnly && (config.enableDuplicatePrevention || config.enableGeneralDuplicateDetector)) {
            if (normalized && channelUploadedMediaKeys.has(normalized)) {
              isDuplicateOfEarlierPost = true;
            } else if (platformMediaId && channelUploadedMediaKeys.has(platformMediaId)) {
              isDuplicateOfEarlierPost = true;
            } else if (channelUploadedMediaKeys.has(link.url)) {
              isDuplicateOfEarlierPost = true;
            } else if (normalized) {
              const linkDup = findDuplicateLink(normalized, {
                scope: config.duplicateLinkScope,
                channelId: channel.id,
                guildId: channel.guildId || null,
              });
              if (
                linkDup.isDuplicate &&
                linkDup.record &&
                linkDup.record.message_id !== message.id &&
                linkDup.record.posted_at < postedAt
              ) {
                isDuplicateOfEarlierPost = true;
              }
            }
          }

          // If this is a duplicate repost of media already posted earlier in this channel, skip Discord upload!
          if (isDuplicateOfEarlierPost) {
            stats.skippedCount++;
            speedTracker.recordItem();
            console.log(
              `[Scanner] [W${workerId}] ⏭️ Skipped duplicate post in #${channel.name}: ${truncateUrl(link.url)}`
            );
            continue;
          }

          // Fast skip if already indexed in database AND we are not uploading to Discord
          if (!options.force && !itemShouldUploadToDiscord && (normalized || platformMediaId)) {
            const existing = await findDuplicateByUrl(link.url, platformMediaId);
            if (existing) {
              stats.skippedCount++;
              speedTracker.recordItem();
              console.log(`[Scanner] [W${workerId}] ⏭️ Skipped (already in archive): ${truncateUrl(link.url)}`);
              continue;
            }
          }

          // Concurrency lock for exact same media ID / URL
          if (lockKey) {
            if (inFlightUrls.has(lockKey)) {
              stats.skippedCount++;
              speedTracker.recordItem();
              console.log(`[Scanner] [W${workerId}] ⏭️ Skipped (duplicate in queue): ${truncateUrl(link.url)}`);
              continue;
            }
            inFlightUrls.add(lockKey);
          }

          let localArchiveCandidate = null;
          if (normalized || platformMediaId) {
            const existing = await findDuplicateByUrl(link.url, platformMediaId);
            localArchiveCandidate = resolveArchivedFilePath(existing, archiveRoot, channelName);
          }

          if (localArchiveCandidate) {
            console.log(`[Scanner] [W${workerId}] 📂 Reusing local archive copy for: ${truncateUrl(link.url)}`);
          } else {
            console.log(`[Scanner] [W${workerId}] 📥 Downloading: ${truncateUrl(link.url)}`);
          }

          const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archivist-scan-'));
          tempDirsToCleanup.push(tempDir);

          try {
            let dlResult = null;
            let filePaths = [];
            let subtitleFiles = [];
            let isArchivedNsfw = false;

            if (localArchiveCandidate) {
              filePaths = [localArchiveCandidate];
              const sidecar = await readArchivedSidecar(localArchiveCandidate);
              isArchivedNsfw = Boolean(sidecar?.isNsfw);
            } else {
              try {
                activeScanDownloads++;
                const signal = scanAbortController?.signal;
                dlResult = link.type === 'direct'
                  ? [
                      await downloadDirect(link.url, tempDir, config.hardCapBytes, {
                        signal,
                        filename: link.filename,
                        allowLoopback: options.allowLoopback,
                      }),
                    ]
                  : await downloadPlatformMedia(link.url, tempDir, 2, {
                      signal,
                      skipJitter: true,
                      ytdlpRunner: options.ytdlpRunner,
                      gallerydlRunner: options.gallerydlRunner,
                    });
                filePaths = Array.isArray(dlResult) ? dlResult : (dlResult?.mediaFiles || []);
                subtitleFiles = Array.isArray(dlResult) ? [] : (dlResult?.subtitleFiles || []);
              } catch (dlErr) {
                if (isAbortError(dlErr) || isStopRequested()) {
                  throw dlErr;
                }
                // Fallback: check if media is already preserved in local archive
                const existing = (normalized || platformMediaId)
                  ? await findDuplicateByUrl(link.url, platformMediaId)
                  : null;
                const fallbackArchive = resolveArchivedFilePath(existing, archiveRoot, channelName);
                if (fallbackArchive) {
                  filePaths = [fallbackArchive];
                  const sidecar = await readArchivedSidecar(fallbackArchive);
                  isArchivedNsfw = Boolean(sidecar?.isNsfw);
                  console.log(`[Scanner] [W${workerId}] 📂 Reusing local archive copy for: ${truncateUrl(link.url)}`);
                }
                if (filePaths.length === 0) {
                  throw dlErr;
                }
              } finally {
                activeScanDownloads = Math.max(0, activeScanDownloads - 1);
              }
            }

            const isDownloadedNsfw = Boolean(dlResult?.isNsfw || isArchivedNsfw);
            const shouldSpoiler = shouldSpoilerMedia({
              isDownloadedNsfw,
              isKnownNsfw: Boolean(link.isKnownNsfw),
              url: link.url,
              isUserSpoiler: Boolean(link.isSpoiler),
              isChannelNsfw: Boolean(channel?.nsfw),
            });

            const postRecordsToSave = [];
            let firstCleanTitle = '';
            let addedLinkMediaCount = 0;

            for (const filePath of filePaths) {
              const parsed = path.parse(filePath);
              const cleanTitle = parsed.name;
              if (!firstCleanTitle) firstCleanTitle = cleanTitle;
              const fileSize = (await fs.promises.stat(filePath)).size;

              const fingerprint = await computeMediaFingerprint(filePath, link.url, {
                signal: scanAbortController?.signal,
              });
              if (platformMediaId && !fingerprint.mediaId) {
                fingerprint.mediaId = platformMediaId;
              }

              // Skip saving duplicate content if already archived (e.g., manual upload of previously posted media)
              if (config.enableDuplicatePrevention && !options.force && !itemShouldUploadToDiscord) {
                const { match } = await findDuplicate(fingerprint);
                if (match) {
                  stats.skippedCount++;
                  speedTracker.recordItem();
                  console.log(
                    `[Scanner] [W${workerId}] ⏭️ Skipped duplicate media (already archived from #${match.channel}): ${cleanTitle}`
                  );
                  continue;
                }
              }

              // Dual-Format High-Quality GIF Pipeline
              let dualResult = { primaryFile: filePath, companionFiles: [], isGif: false };
              if (config.enableGifPipeline) {
                try {
                  dualResult = await processDualFormatMedia(filePath, tempDir, {
                    metadata: { is_gif: dlResult?.isOriginalGif },
                    signal: scanAbortController?.signal,
                  });
                } catch (gifErr) {
                  if (isAbortError(gifErr) || scanAbortController?.signal?.aborted) throw gifErr;
                }
              }

              // Save high quality file to permanent PC archive (with dual-format companions if generated)
              const archivedPath = await archiveLocalMedia(filePath, {
                url: link.url,
                author: authorTag,
                channel: channelName,
                title: cleanTitle,
                mediaId: fingerprint.mediaId,
                sha256: fingerprint.sha256,
                isNsfw: isDownloadedNsfw || Boolean(link.isKnownNsfw),
                subtitleFiles,
                companionFiles: config.archiveBothFormats ? dualResult.companionFiles : [],
              });

              if (archivedPath) {
                stats.archivedCount++;
                stats.totalBytesArchived += fileSize;
                speedTracker.recordBytes(fileSize);
                speedTracker.recordItem();

                const { speedStr, itemsPerMin, etaStr } = speedTracker.getSpeedInfo(
                  stats.totalBytesArchived,
                  workQueue.length,
                  isFetchingDone
                );

                const ext = path.extname(archivedPath);
                console.log(
                  `[Scanner] [W${workerId}] 💾 Saved: "${cleanTitle}${ext}" (${formatBytes(fileSize)}) | Speed: ${speedStr} (${itemsPerMin} dl/min)${etaStr}`
                );

                const archivedStat = await fs.promises.stat(archivedPath).catch(() => null);
                const relativePath = path.relative(archiveRoot, archivedPath).split(path.sep).join('/');

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
                  fileName: path.basename(archivedPath),
                  relativePath,
                  fileSize: archivedStat ? archivedStat.size : fileSize,
                });

                // Prepare Discord attachment if upload is needed (use permanent archived file if present)
                if (itemShouldUploadToDiscord) {
                  const sourceForUpload = dualResult.primaryFile || (fs.existsSync(filePath) ? filePath : archivedPath);
                  const isTargetGif = dualResult.isGif || path.extname(sourceForUpload).toLowerCase() === '.gif';
                  const uploadStat = await fs.promises.stat(sourceForUpload).catch(() => null);
                  const needsCompression =
                    config.enableCompression &&
                    !isTargetGif &&
                    isVideo(sourceForUpload) &&
                    (uploadStat?.size || 0) > config.maxFileSizeBytes;

                  let discoveredThumb = null;
                  if (config.prependThumbnailPreview && !isTargetGif && isVideo(sourceForUpload)) {
                    discoveredThumb = await findThumbnailFile(sourceForUpload, tempDir);
                  }

                  const preProbed = sourceForUpload === filePath ? fingerprint.mediaInfo : undefined;
                  let uploadCandidate = sourceForUpload;
                  if (!needsCompression && !isTargetGif && isVideo(sourceForUpload)) {
                    uploadCandidate = await applyThumbnailPreview(sourceForUpload, tempDir, discoveredThumb, {
                      signal: scanAbortController?.signal,
                      mediaInfo: preProbed,
                    });
                  }
                  const finalPath = await ensureWithinLimit(
                    uploadCandidate,
                    null,
                    needsCompression ? discoveredThumb : null,
                    {
                      signal: scanAbortController?.signal,
                      mediaInfo: uploadCandidate === filePath ? preProbed : undefined,
                    }
                  );
                  if (finalPath) {
                    const finalExt = path.extname(finalPath);
                    const attachmentName = `${cleanTitle}${finalExt}`;
                    const mediaBuilder = new AttachmentBuilder(finalPath, { name: attachmentName });
                    if (shouldSpoiler) {
                      mediaBuilder.setSpoiler(true);
                    }
                    messageAttachmentsToUpload.push({
                      builder: mediaBuilder,
                      tempFilePath: (finalPath !== archivedPath && finalPath !== filePath) ? finalPath : null,
                      title: cleanTitle,
                      isVideo: isVideo(finalPath),
                      isAudio: isAudio(finalPath),
                      isSubtitle: false,
                      isSpoiler: shouldSpoiler,
                    });
                    addedLinkMediaCount++;
                  }
                }

                // Record in channelUploadedMediaKeys so subsequent duplicate posts in this channel are skipped
                if (normalized) channelUploadedMediaKeys.add(normalized);
                if (platformMediaId) channelUploadedMediaKeys.add(platformMediaId);
                if (fingerprint?.mediaId) channelUploadedMediaKeys.add(fingerprint.mediaId);
                channelUploadedMediaKeys.add(link.url);
              }
            }

            if (itemShouldUploadToDiscord && addedLinkMediaCount > 0 && config.uploadSubtitlesToDiscord && subtitleFiles.length > 0) {
              const subAttachments = await prepareSubtitleAttachments(
                subtitleFiles,
                firstCleanTitle,
                tempDir,
                shouldSpoiler,
                scanAbortController?.signal
              );
              for (const subBuilder of subAttachments) {
                messageAttachmentsToUpload.push({
                  builder: subBuilder,
                  tempFilePath: null,
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
          } catch (downloadErr) {
            if (isAbortError(downloadErr) || isStopRequested()) {
              console.log(`[Scanner] [W${workerId}] 🛑 Download aborted by user: ${truncateUrl(link.url)}`);
              break;
            }
            stats.failedCount++;
            speedTracker.recordItem();
            console.warn(`[Scanner] [W${workerId}] ⚠️ Failed: ${truncateUrl(link.url)} (${downloadErr.message})`);
          } finally {
            if (lockKey) {
              inFlightUrls.delete(lockKey);
            }
          }

          if (onProgress) {
            // Do not block the worker on discord status edits
            onProgress(stats).catch(() => {});
          }
        } // end links loop

        // Repost media attachments to Discord if needed (Throttled globally across all workers)
        if (messageAttachmentsToUpload.length > 0) {
          uploadMutex = uploadMutex.then(async () => {
            try {
              const attachmentBuilders = messageAttachmentsToUpload.map((item) => item.builder);
              const totalBatches = Math.ceil(attachmentBuilders.length / 10);
              for (let i = 0; i < attachmentBuilders.length; i += 10) {
                const chunk = attachmentBuilders.slice(i, i + 10);
                const chunkItems = messageAttachmentsToUpload.slice(i, i + 10);
                const batchNum = Math.floor(i / 10) + 1;
                const replyOptions = {
                  files: chunk,
                  allowedMentions: { repliedUser: false },
                };

                const content = formatMediaMessageContent(chunkItems, { batchNum, totalBatches });
                if (content) {
                  replyOptions.content = content;
                }

                await safeReply(message, replyOptions);
              }

              if (config.autoSuppressEmbeds) {
                try {
                  await message.suppressEmbeds(true);
                } catch {
                  setTimeout(() => message.suppressEmbeds(true).catch(() => {}), 1500).unref?.();
                }
              }

              stats.repostedMissingCount++;
              repliedWithAttachmentMessageIds.add(message.id);
              console.log(`[Scanner] [Upload] 📤 Reposted attachments for message ${message.id} to #${channel.name}`);
              
              // Strict pacing between discord uploads to prevent HTTP 429 Rate Limits
              await new Promise((r) => setTimeout(r, 1200));
            } catch (uploadErr) {
              console.error(`[Scanner] Failed to repost attachments for message ${message.id}:`, uploadErr.message);
            } finally {
              // Clean up any generated compressed temp files
              for (const item of messageAttachmentsToUpload) {
                if (item.tempFilePath) {
                  await fs.promises.unlink(item.tempFilePath).catch(() => {});
                }
              }
            }
          });
          
          await uploadMutex; // Worker waits for its upload to finish before proceeding to the next message
        }
      } finally {
        // Clean up temporary download folders for this message
        for (const dir of tempDirsToCleanup) {
          await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    } // end while(workQueue.length > 0)
  }; // end workerLoop

  // Producer Loop: Fetch messages first so they can be sorted oldest-to-newest without worker spin-waiting
  let lastMessageId = null;
  let remainingLimit = options.limit || Infinity;

  try {
    while (remainingLimit > 0) {
      if (isStopRequested()) {
        console.log('[Scanner] 🛑 Stop requested. Producer exiting...');
        break;
      }
      const fetchLimit = Math.min(100, remainingLimit);
      const fetchOptions = { limit: fetchLimit };
      if (lastMessageId) {
        fetchOptions.before = lastMessageId;
      }

      let messages;
      try {
        messages = await channel.messages.fetch(fetchOptions);
      } catch (err) {
        console.error(`[Scanner] Error fetching messages in #${channel.name}:`, err.message);
        break;
      }

      if (!messages || messages.size === 0) {
        break; // Reached beginning of channel history
      }

      stats.messagesScanned += messages.size;

      let hitCutoff = false;
      for (const msg of messages.values()) {
        lastMessageId = msg.id;

        // Stop scanning if the message was posted before options.sinceTimestamp
        if (options.sinceTimestamp && msg.createdTimestamp < options.sinceTimestamp) {
          hitCutoff = true;
          break;
        }

        // Track existing bot attachment replies to prevent duplicate reposts (supports current bot and prior bot instances)
        if ((msg.author?.id === botId || msg.author?.bot) && msg.reference?.messageId && msg.attachments?.size > 0) {
          repliedWithAttachmentMessageIds.add(msg.reference.messageId);
        }

        // Collect candidate messages that actually contain links or manual user media uploads
        const hasHttpLink = Boolean(msg.content && msg.content.includes('http'));
        const hasUserAttachments = Boolean(
          config.enableLocalArchive &&
          config.archiveUserAttachments &&
          isChannelAllowed(channel.id) &&
          extractMessageAttachments(msg).length > 0
        );
        if (!msg.author.bot && (hasHttpLink || hasUserAttachments)) {
          candidateMessages.push(msg);
        }
      }

      if (hitCutoff) {
        break; // Stop fetching older history
      }

      if (stats.messagesScanned % 500 === 0 || messages.size < fetchLimit) {
        console.log(`[Scanner] 📨 Producer: Scanned ${stats.messagesScanned.toLocaleString()} messages (${candidateMessages.length} candidate messages found)...`);
      }

      remainingLimit -= messages.size;
      if (messages.size < fetchLimit) {
        break; // Reached end of history
      }

      await new Promise((r) => setTimeout(r, 200)); // Discord API pacing
    }
  } finally {
    // Reverse candidate messages into chronological order (oldest to newest)
    // so original posts are processed and archived first, and newer duplicate reposts are properly skipped
    candidateMessages.reverse();
    workQueue.push(...candidateMessages);
    isFetchingDone = true;
    console.log(`[Scanner] 📨 Producer: Finished scanning history (${stats.messagesScanned.toLocaleString()} messages checked, ${workQueue.length} queued items to process in chronological order)`);
  }

  try {
    if (workQueue.length > 0 && !isStopRequested()) {
      const workerCount = Math.min(concurrency, workQueue.length);
      const workers = Array.from({ length: workerCount }).map((_, i) => workerLoop(i + 1));
      await Promise.all(workers);
    }
  } finally {
    scanAbortController = null;
  }

  const totalElapsed = Date.now() - speedTracker.startTime;
  const avgSpeed = stats.totalBytesArchived > 0 && totalElapsed > 0
    ? (stats.totalBytesArchived / (totalElapsed / 1000) / (1024 * 1024)).toFixed(1)
    : '0';

  const backupSummary = stats.linksBackedUp > 0 ? `, ${stats.linksBackedUp} links backed up` : '';
  console.log(
    `[Scanner] ✅ Finished #${channel.name} in ${formatDuration(totalElapsed)}: ` +
    `${stats.archivedCount} archived (${formatBytes(stats.totalBytesArchived)})${backupSummary}, ` +
    `${stats.skippedCount} skipped, ${stats.failedCount} failed | Avg Speed: ${avgSpeed} MB/s`
  );

  return stats;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Main entry point for the `!rescan`, `!crawl`, or `!repost-missing` command.
 */
export async function handleRescanCommand(commandMessage) {
  if (isScanningActive) {
    const notice = await commandMessage.reply({
      content: '⚠️ A rescan or media crawl is already running. Please wait for it to complete.',
      allowedMentions: { repliedUser: false },
    });
    scheduleAutoDelete(notice);
    return;
  }

  // Permission Check: Requires Manage Messages or Administrator permissions (or server owner)
  if (!isModeratorOrOwner(commandMessage.member, commandMessage.guild, commandMessage.author?.id)) {
    const notice = await commandMessage.reply({
      content: '❌ You need the `Manage Messages` or `Administrator` permission to run a channel rescan.',
      allowedMentions: { repliedUser: false },
    });
    scheduleAutoDelete(notice);
    return;
  }

  const { target, limit, upload, force, repostMissing, concurrency } = parseRescanArgs(commandMessage.content, commandMessage.channel);
  const guild = commandMessage.guild;

  // Resolve target channels
  let targetChannels = [];

  if (target === 'all' && guild) {
    const channels = await guild.channels.fetch();
    targetChannels = Array.from(channels.values()).filter(
      (c) =>
        c &&
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
        c.viewable &&
        c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ReadMessageHistory) &&
        (isChannelAllowed(c.id) || isLinkBackupChannel(c))
    );
  } else if (target === 'current') {
    if (!isChannelAllowed(commandMessage.channel.id) && !isLinkBackupChannel(commandMessage.channel)) {
      const notice = await commandMessage.reply({
        content: `❌ Archivist Fox is not enabled in ${commandMessage.channel}. Check your \`ALLOWED_CHANNEL_IDS\` / \`DISALLOWED_CHANNEL_IDS\` or \`LINK_BACKUP_CHANNELS\` configuration.`,
        allowedMentions: { repliedUser: false },
      });
      scheduleAutoDelete(notice);
      return;
    }
    targetChannels = [commandMessage.channel];
  } else {
    let specificChannel = null;
    if (/^\d+$/.test(target)) {
      specificChannel = await guild.channels.fetch(target).catch(() => null);
    }
    if (!specificChannel) {
      const cleanName = target.replace(/^#/, '').toLowerCase();
      const allChannels = await guild.channels.fetch().catch(() => null);
      if (allChannels) {
        specificChannel = allChannels.find(
          (c) =>
            c &&
            c.name?.toLowerCase() === cleanName &&
            (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        );
      }
    }

    if (specificChannel && specificChannel.viewable && specificChannel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ReadMessageHistory)) {
      if (!isChannelAllowed(specificChannel.id) && !isLinkBackupChannel(specificChannel)) {
        const notice = await commandMessage.reply({
          content: `❌ Archivist Fox is not enabled in ${specificChannel}. Check your \`ALLOWED_CHANNEL_IDS\` / \`DISALLOWED_CHANNEL_IDS\` or \`LINK_BACKUP_CHANNELS\` configuration.`,
          allowedMentions: { repliedUser: false },
        });
        scheduleAutoDelete(notice);
        return;
      }
      targetChannels = [specificChannel];
    } else {
      const notice = await commandMessage.reply({
        content: `❌ Could not find or access text channel \`${target}\`.`,
        allowedMentions: { repliedUser: false },
      });
      scheduleAutoDelete(notice);
      return;
    }
  }

  if (targetChannels.length === 0) {
    const notice = await commandMessage.reply({
      content: '❌ No accessible text channels found to scan.',
      allowedMentions: { repliedUser: false },
    });
    scheduleAutoDelete(notice);
    return;
  }

  isScanningActive = true;
  const startTime = Date.now();

  const modeName = repostMissing ? 'Reposting Missing Media & Archiving' : 'Media Archiving Rescan';
  const effectiveConcurrency = concurrency || config.scannerConcurrency;

  const statusMsg = await commandMessage.reply({
    content: `🔍 **Starting ${modeName}...**\n📍 Target: ${
      target === 'all' ? `All accessible channels (${targetChannels.length})` : `#${targetChannels[0].name}`
    }\n⚙️ Options: limit=${limit === Infinity ? 'all' : limit}, repostMissing=${repostMissing}, force=${force}, uploadAll=${upload}, concurrency=${effectiveConcurrency}`,
    allowedMentions: { repliedUser: false },
  });

  const aggregate = {
    channelsCount: targetChannels.length,
    messagesScanned: 0,
    mediaLinksFound: 0,
    linksBackedUp: 0,
    archivedCount: 0,
    repostedMissingCount: 0,
    skippedCount: 0,
    failedCount: 0,
    totalBytes: 0,
  };

  let lastStatusUpdate = 0;

  try {
    for (let i = 0; i < targetChannels.length; i++) {
      if (isStopRequested()) {
        console.log('[Scanner] 🛑 Rescan stopped early by user request.');
        break;
      }
      const ch = targetChannels[i];
      const channelIndexStr = targetChannels.length > 1 ? ` (${i + 1}/${targetChannels.length})` : '';

      const chStats = await crawlChannel(ch, { limit, upload, force, repostMissing, concurrency }, async (currentChannelStats) => {
        const now = Date.now();
        // Update Discord status message at most once every 5 seconds to avoid edit rate limits
        if (now - lastStatusUpdate > 5000) {
          lastStatusUpdate = now;
          const elapsed = formatDuration(now - startTime);
          const totalMsgs = aggregate.messagesScanned + currentChannelStats.messagesScanned;
          const totalLinks = aggregate.mediaLinksFound + currentChannelStats.mediaLinksFound;
          const totalArchived = aggregate.archivedCount + currentChannelStats.archivedCount;
          const totalReposted = aggregate.repostedMissingCount + currentChannelStats.repostedMissingCount;
          const totalStorage = formatBytes(aggregate.totalBytes + currentChannelStats.totalBytesArchived);
          const totalBackedUp = aggregate.linksBackedUp + (currentChannelStats.linksBackedUp || 0);

          let statusContent =
            `⏳ **${modeName} in Progress...**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 Current Channel: **#${ch.name}**${channelIndexStr}\n` +
            `📨 Messages Scanned: **${totalMsgs.toLocaleString()}**\n` +
            `🎬 Media Links Found: **${totalLinks.toLocaleString()}**\n` +
            (totalBackedUp > 0 ? `🔗 Links Backed Up: **${totalBackedUp.toLocaleString()}**\n` : '') +
            `💾 Archived to PC: **${totalArchived} files** (${totalStorage})\n`;

          if (repostMissing || upload) {
            statusContent += `📤 Reposted to Discord: **${totalReposted} missing uploads**\n`;
          }
          statusContent += `⏱️ Elapsed Time: **${elapsed}**`;

          await statusMsg.edit({ content: statusContent }).catch(() => {});
        }
      });

      // Accumulate channel stats
      aggregate.messagesScanned += chStats.messagesScanned;
      aggregate.mediaLinksFound += chStats.mediaLinksFound;
      aggregate.linksBackedUp += (chStats.linksBackedUp || 0);
      aggregate.archivedCount += chStats.archivedCount;
      aggregate.repostedMissingCount += chStats.repostedMissingCount;
      aggregate.skippedCount += chStats.skippedCount;
      aggregate.failedCount += chStats.failedCount;
      aggregate.totalBytes += chStats.totalBytesArchived;
    }

    const totalElapsed = formatDuration(Date.now() - startTime);
    const finalSize = formatBytes(aggregate.totalBytes);
    const wasStopped = isStopRequested();

    let finalSummary = wasStopped
      ? `🛑 **${modeName} Stopped Early by User!**\n`
      : `✅ **${modeName} Complete!**\n`;

    finalSummary +=
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📁 Channels Scanned: **${aggregate.channelsCount}**\n` +
      `📨 Total Messages Scanned: **${aggregate.messagesScanned.toLocaleString()}**\n` +
      `🎬 Total Media Links Found: **${aggregate.mediaLinksFound.toLocaleString()}**\n` +
      (aggregate.linksBackedUp > 0 ? `🔗 Links Backed Up to Database: **${aggregate.linksBackedUp.toLocaleString()}**\n` : '') +
      `💾 High-Quality Files Archived: **${aggregate.archivedCount} files**\n`;

    if (aggregate.repostedMissingCount > 0 || repostMissing || upload) {
      finalSummary += `📤 Reposted Missing Media to Discord: **${aggregate.repostedMissingCount} messages**\n`;
    }

    finalSummary +=
      `⏭️ Already Archived (Skipped): **${aggregate.skippedCount}**\n` +
      `📦 Total Storage Added: **${finalSize}**\n` +
      `⏱️ Total Time Elapsed: **${totalElapsed}**\n` +
      `📁 Local PC Archive: \`${config.archiveDirectory}\``;

    await statusMsg.edit({ content: finalSummary });
  } catch (err) {
    console.error('[Scanner] Critical error during rescan:', err);
    await statusMsg
      .edit({
        content: `❌ **Operation stopped due to an error:** ${err.message}`,
      })
      .catch(() => {});
  } finally {
    isScanningActive = false;
    clearStopRequested();
  }
}

/**
 * Resolves all text and announcement channels across all guilds that the bot can view and read history for,
 * strictly filtered by whitelist (`ALLOWED_CHANNEL_IDS`) or blacklist (`DISALLOWED_CHANNEL_IDS`) while
 * always preserving `LINK_BACKUP_CHANNELS` so link backups are never dropped during startup catch-up scans.
 */
export async function getScannableChannels(client) {
  const targetChannels = new Map();

  // 1. Discover eligible media & link-backup channels across all active guilds
  if (client.guilds?.cache) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const me =
          guild.members?.me ||
          (guild.members?.fetchMe ? await guild.members.fetchMe().catch(() => null) : null);
        const channels = await guild.channels.fetch().catch(() => null);
        if (!channels) continue;
        for (const ch of channels.values()) {
          if (
            ch &&
            (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) &&
            ch.viewable &&
            (!me || ch.permissionsFor(me)?.has(PermissionFlagsBits.ReadMessageHistory)) &&
            (isChannelAllowed(ch.id) || isLinkBackupChannel(ch))
          ) {
            targetChannels.set(ch.id, ch);
          }
        }
      } catch (err) {
        console.warn(`[Scanner] Could not fetch channels for guild ${guild.name} (${guild.id}):`, err.message);
      }
    }
  }

  // 2. Also fetch any explicit channel IDs in ALLOWED_CHANNEL_IDS not yet in targetChannels
  if (config.allowedChannelIds.length > 0 && client.channels?.fetch) {
    for (const channelId of config.allowedChannelIds) {
      if (targetChannels.has(channelId)) continue;
      try {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (
          ch &&
          (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) &&
          ch.viewable &&
          ch.guild
        ) {
          const me =
            ch.guild.members?.me ||
            (ch.guild.members?.fetchMe ? await ch.guild.members.fetchMe().catch(() => null) : null);
          if (!me || ch.permissionsFor(me)?.has(PermissionFlagsBits.ReadMessageHistory)) {
            targetChannels.set(ch.id, ch);
          }
        }
      } catch (err) {
        console.warn(`[Scanner] Could not access allowed channel ${channelId}:`, err.message);
      }
    }
  }

  return Array.from(targetChannels.values());
}

/**
 * Automatically scans recent message history (default: last 24 hours) across all
 * whitelisted / non-blacklisted / backup channels on bot startup. Downloads media and backfills
 * any missed uploads to Discord.
 */
export async function runStartupScan(client) {
  if (isScanningActive) {
    console.log('[Startup Scan] A scan is already running. Skipping automatic startup scan.');
    return;
  }

  isScanningActive = true;
  clearStopRequested();

  const hours = config.autoScanHours || 24;
  const sinceTimestamp = Date.now() - hours * 60 * 60 * 1000;
  const sinceDateStr = new Date(sinceTimestamp).toLocaleString();
  const concurrency = config.autoScanConcurrency || config.scannerConcurrency || 3;
  const repostMissing = config.autoScanRepostMissing;

  console.log(
    `\n[Startup Scan] 🔍 Starting automatic catch-up scan for links posted in the last ${hours} hour(s) (since ${sinceDateStr})...`
  );
  console.log(
    `[Startup Scan] ⚙️ Options: repostMissing=${repostMissing}, concurrency=${concurrency}, localArchive=${config.enableLocalArchive}`
  );

  const startTime = Date.now();

  try {
    const targetChannels = await getScannableChannels(client);

    if (targetChannels.length === 0) {
      console.log('[Startup Scan] ℹ️ No accessible channels matching whitelist/blacklist rules found to scan.');
      return;
    }

    console.log(
      `[Startup Scan] 📋 Found ${targetChannels.length} eligible channel(s) to scan: ${targetChannels
        .map((c) => `#${c.name}`)
        .join(', ')}`
    );

    const aggregate = {
      channelsCount: targetChannels.length,
      messagesScanned: 0,
      mediaLinksFound: 0,
      linksBackedUp: 0,
      archivedCount: 0,
      repostedMissingCount: 0,
      skippedCount: 0,
      failedCount: 0,
      totalBytes: 0,
    };

    for (let i = 0; i < targetChannels.length; i++) {
      if (isStopRequested()) {
        console.log('[Startup Scan] 🛑 Startup scan aborted by user request.');
        break;
      }

      const ch = targetChannels[i];
      console.log(`[Startup Scan] ⏳ Scanning #${ch.name} (${i + 1}/${targetChannels.length})...`);

      const chStats = await crawlChannel(ch, {
        sinceTimestamp,
        repostMissing,
        concurrency,
      });

      aggregate.messagesScanned += chStats.messagesScanned;
      aggregate.mediaLinksFound += chStats.mediaLinksFound;
      aggregate.linksBackedUp += (chStats.linksBackedUp || 0);
      aggregate.archivedCount += chStats.archivedCount;
      aggregate.repostedMissingCount += chStats.repostedMissingCount;
      aggregate.skippedCount += chStats.skippedCount;
      aggregate.failedCount += chStats.failedCount;
      aggregate.totalBytes += chStats.totalBytesArchived;
    }

    const totalElapsed = formatDuration(Date.now() - startTime);
    const finalSize = formatBytes(aggregate.totalBytes);

    console.log(
      `\n[Startup Scan] ✅ Catch-up scan complete in ${totalElapsed}!` +
      `\n[Startup Scan] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━` +
      `\n[Startup Scan] • Channels scanned: ${aggregate.channelsCount}` +
      `\n[Startup Scan] • Messages scanned: ${aggregate.messagesScanned.toLocaleString()}` +
      `\n[Startup Scan] • Media links found: ${aggregate.mediaLinksFound.toLocaleString()}` +
      (aggregate.linksBackedUp > 0 ? `\n[Startup Scan] • Links backed up: ${aggregate.linksBackedUp.toLocaleString()}` : '') +
      `\n[Startup Scan] • Files archived to PC: ${aggregate.archivedCount} (${finalSize})` +
      (repostMissing ? `\n[Startup Scan] • Reposted missing to Discord: ${aggregate.repostedMissingCount}` : '') +
      `\n[Startup Scan] • Already archived (skipped): ${aggregate.skippedCount}` +
      (aggregate.failedCount > 0 ? `\n[Startup Scan] • Failed downloads: ${aggregate.failedCount}` : '') +
      `\n[Startup Scan] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    );
  } catch (err) {
    console.error('[Startup Scan] ❌ Error during startup catch-up scan:', err);
  } finally {
    isScanningActive = false;
    clearStopRequested();
  }
}
