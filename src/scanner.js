import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChannelType, PermissionFlagsBits, AttachmentBuilder } from 'discord.js';
import { config, isChannelAllowed } from './config.js';
import { extractMediaLinksAsync, extractAllUrlsAsync, normalizeUrl, extractPlatformMediaId, isDeviantArtUrl } from './urlExtractor.js';
import { downloadDirect } from './directDownloader.js';
import { downloadWithYtDlp } from './ytdlpDownloader.js';
import { downloadWithGalleryDl } from './galleryDlDownloader.js';
import { archiveLocalMedia } from './archiver.js';
import { computeMediaFingerprint, isVideoFile, isAudioFile } from './phasher.js';
import { saveRecord, findDuplicateByUrl, findDuplicate } from './db.js';
import { saveLinkRecord, findDuplicateLink } from './linkDb.js';
import { ensureWithinLimit, isValidDisplayTitle } from './mediaHandler.js';
import { applyThumbnailPreview } from './thumbnailPreview.js';
import { downloadQueue } from './queue.js';

let isScanningActive = false;
let isScanStopRequested = false;

export function isScanRunning() {
  return isScanningActive;
}

export function isStopRequested() {
  return isScanStopRequested;
}

export function setScanRunning(val) {
  isScanningActive = Boolean(val);
  if (!val) {
    isScanStopRequested = false;
  }
}

export function requestScanStop() {
  if (isScanningActive) {
    isScanStopRequested = true;
    return true;
  }
  return false;
}

export function stopActiveTasks() {
  const scanRunning = requestScanStop();
  const queueItemsCleared = downloadQueue.clear();
  return { scanRunning, queueItemsCleared };
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
 * Downloads a platform or direct media link with automatic retries for transient errors.
 * DeviantArt has no yt-dlp extractor and is routed directly to gallery-dl.
 */
async function downloadMedia(link, destDir, maxRetries = 2) {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      if (link.type === 'direct') {
        const filePath = await downloadDirect(link.url, destDir, config.hardCapBytes);
        return [filePath];
      }

      // DeviantArt fast-path: yt-dlp has no DeviantArt extractor, go straight to gallery-dl.
      if (isDeviantArtUrl(link.url)) {
        try {
          return await downloadWithGalleryDl(link.url, destDir);
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
              `[Scanner] DeviantArt download of <${link.url}> hit transient error (${err.message}), retrying attempt ${attempt + 1}/${maxRetries + 1}...`
            );
            await new Promise((r) => setTimeout(r, attempt * 3000));
            continue;
          }
          throw err;
        }
      }

      try {
        return await downloadWithYtDlp(link.url, destDir);
      } catch (ytErr) {
        const msg = ytErr?.message || '';
        if (msg.startsWith('COMMAND_NOT_FOUND')) {
          throw ytErr;
        }
        try {
          return await downloadWithGalleryDl(link.url, destDir);
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
              `[Scanner] Download of <${link.url}> hit rate-limit/timeout (${lastErr.message}), retrying attempt ${attempt + 1}/${maxRetries + 1}...`
            );
            await new Promise((r) => setTimeout(r, attempt * 3000));
            continue;
          }
        }
      }
    } catch (err) {
      lastErr = err;
      if (attempt <= maxRetries) {
        await new Promise((r) => setTimeout(r, attempt * 3000));
        continue;
      }
    }
  }

  throw lastErr || new Error('Download failed');
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

/**
 * Crawls a single Discord text channel, fetching messages in batches of 100,
 * extracting media links, archiving them to PC, and optionally reposting missing attachments.
 * Uses a pipelined producer-consumer model to download and archive concurrently.
 */
export async function crawlChannel(channel, options = {}, onProgress = null) {
  const stats = {
    channelName: channel.name || channel.id,
    messagesScanned: 0,
    mediaLinksFound: 0,
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

  const workQueue = [];
  const candidateMessages = [];
  let isFetchingDone = false;
  let uploadMutex = Promise.resolve(); // Serializes Discord API uploads
  const inFlightUrls = new Set(); // Prevents parallel workers from downloading the exact same link
  const speedTracker = new CrawlSpeedTracker();

  console.log(`[Scanner] 🚀 Crawl started for #${channel.name} (Concurrency: ${concurrency} workers)`);

  // Worker Loop
  const workerLoop = async (workerId) => {
    while (true) {
      if (isScanStopRequested) {
        console.log(`[Scanner] [W${workerId}] 🛑 Stop requested. Worker exiting...`);
        break;
      }

      if (workQueue.length === 0) {
        if (isFetchingDone) break;
        await new Promise((r) => setTimeout(r, 100)); // Wait for producer
        continue;
      }

      const message = workQueue.shift();
      if (message.author.bot) continue;

      // 1. General duplicate link detector
      if (config.enableGeneralDuplicateDetector) {
        const allUrls = await extractAllUrlsAsync(message.content);
        for (const { originalUrl, normalizedUrl } of allUrls) {
          const { isDuplicate } = findDuplicateLink(normalizedUrl, {
            scope: config.duplicateLinkScope,
            guildId: channel.guildId || null,
            channelId: channel.id,
          });
          if (!isDuplicate) {
            saveLinkRecord({
              normalizedUrl,
              originalUrl,
              guildId: channel.guildId || null,
              channelId: channel.id,
              channelName: channel.name || 'chat',
              messageId: message.id,
              authorId: message.author?.id || '0',
              authorTag: message.author?.tag || message.author?.username || 'Unknown',
              postedAt: message.createdTimestamp || Date.now(),
            });
          }
        }
      }

      const links = await extractMediaLinksAsync(message.content);
      if (links.length === 0) continue;

      const hasBotAttachment = repliedWithAttachmentMessageIds.has(message.id);
      const shouldUploadToDiscord = options.upload || (options.repostMissing && !hasBotAttachment);

      const messageAttachmentsToUpload = [];
      const tempDirsToCleanup = [];

      try {
        for (const link of links) {
          if (isScanStopRequested) break;
          stats.mediaLinksFound++;
          const normalized = normalizeUrl(link.url);
          const platformMediaId = extractPlatformMediaId(link.url);

          // If this message ALREADY has bot attachments in Discord, record its keys so duplicate posts won't re-upload
          if (hasBotAttachment) {
            if (normalized) channelUploadedMediaKeys.add(normalized);
            if (platformMediaId) channelUploadedMediaKeys.add(platformMediaId);
            channelUploadedMediaKeys.add(link.url);
          }

          // Check if this link is a duplicate of an earlier post in this channel/guild
          let isDuplicateOfEarlierPost = false;
          if (config.enableDuplicatePrevention || config.enableGeneralDuplicateDetector) {
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
                linkDup.record.posted_at < (message.createdTimestamp || Date.now())
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
          if (!options.force && !shouldUploadToDiscord && normalized) {
            const existing = await findDuplicateByUrl(link.url);
            if (existing) {
              stats.skippedCount++;
              speedTracker.recordItem();
              console.log(`[Scanner] [W${workerId}] ⏭️ Skipped (already in archive): ${truncateUrl(link.url)}`);
              continue;
            }
          }

          // Concurrency lock for exact same URL
          if (normalized) {
            if (inFlightUrls.has(normalized)) {
              stats.skippedCount++;
              speedTracker.recordItem();
              console.log(`[Scanner] [W${workerId}] ⏭️ Skipped (duplicate in queue): ${truncateUrl(link.url)}`);
              continue;
            }
            inFlightUrls.add(normalized);
          }

          console.log(`[Scanner] [W${workerId}] 📥 Downloading: ${truncateUrl(link.url)}`);

          const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archivist-scan-'));
          tempDirsToCleanup.push(tempDir);

          try {
            let filePaths = [];
            try {
              filePaths = await downloadMedia(link, tempDir);
            } catch (dlErr) {
              // Fallback: check if media is already preserved in local archive
              const existing = normalized ? await findDuplicateByUrl(link.url) : null;
              if (existing?.fileName) {
                const candidateArchive = path.join(
                  path.resolve(config.archiveDirectory),
                  existing.channel || '',
                  existing.fileName
                );
                if (fs.existsSync(candidateArchive)) {
                  filePaths = [candidateArchive];
                  console.log(`[Scanner] [W${workerId}] 📂 Reusing local archive copy for: ${truncateUrl(link.url)}`);
                }
              }
              if (filePaths.length === 0) {
                throw dlErr;
              }
            }
            const authorTag = message.author?.tag || message.author?.username || 'Unknown';
            const authorId = message.author?.id || '0';
            const channelName = channel.name || 'chat';
            const postedAt = message.createdTimestamp || Date.now();

            const postRecordsToSave = [];

            for (const filePath of filePaths) {
              const parsed = path.parse(filePath);
              const cleanTitle = parsed.name;
              const fileSize = (await fs.promises.stat(filePath)).size;

              const fingerprint = await computeMediaFingerprint(filePath, link.url);

              // Save high quality file to permanent PC archive
              const archivedPath = await archiveLocalMedia(filePath, {
                url: link.url,
                author: authorTag,
                channel: channelName,
                title: cleanTitle,
                mediaId: fingerprint.mediaId,
                sha256: fingerprint.sha256,
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
                });

                // Save to SQLite link database
                if (normalized) {
                  saveLinkRecord({
                    normalizedUrl: normalized,
                    originalUrl: link.url,
                    guildId: channel.guildId || null,
                    channelId: channel.id,
                    channelName,
                    messageId: message.id,
                    authorId,
                    authorTag,
                    postedAt,
                  });
                }

                // Prepare Discord attachment if upload is needed (use permanent archived file if present)
                if (shouldUploadToDiscord) {
                  const sourceForUpload = fs.existsSync(filePath) ? filePath : archivedPath;
                  const uploadCandidate = await applyThumbnailPreview(sourceForUpload, tempDir);
                  const finalPath = await ensureWithinLimit(uploadCandidate);
                  if (finalPath) {
                    const finalExt = path.extname(finalPath);
                    const attachmentName = `${cleanTitle}${finalExt}`;
                    messageAttachmentsToUpload.push({
                      builder: new AttachmentBuilder(finalPath, { name: attachmentName }),
                      tempFilePath: (finalPath !== archivedPath && finalPath !== filePath) ? finalPath : null,
                      title: cleanTitle,
                      isVideo: isVideoFile(finalPath),
                      isAudio: isAudioFile(finalPath),
                    });
                  }
                }

                // Record in channelUploadedMediaKeys so subsequent duplicate posts in this channel are skipped
                if (normalized) channelUploadedMediaKeys.add(normalized);
                if (platformMediaId) channelUploadedMediaKeys.add(platformMediaId);
                if (fingerprint?.mediaId) channelUploadedMediaKeys.add(fingerprint.mediaId);
                channelUploadedMediaKeys.add(link.url);
              }
            }

            // Save all records from this post together
            for (const record of postRecordsToSave) {
              await saveRecord(record);
            }
          } catch (downloadErr) {
            stats.failedCount++;
            speedTracker.recordItem();
            console.warn(`[Scanner] [W${workerId}] ⚠️ Failed: ${truncateUrl(link.url)} (${downloadErr.message})`);
          } finally {
            if (normalized) {
              inFlightUrls.delete(normalized);
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

                if (config.includeTitleInMessage) {
                  const validItems = chunkItems.filter((item) => isValidDisplayTitle(item.title));
                  const uniqueTitles = [...new Set(validItems.map((item) => item.title.replace(/[\r\n]+/g, ' ').trim()))];

                  if (totalBatches > 1) {
                    const albumTitle = uniqueTitles.length === 1 ? ` — **${uniqueTitles[0]}**` : '';
                    replyOptions.content = `🖼️ Album Part ${batchNum}/${totalBatches} (${chunk.length} items)${albumTitle}:`;
                  } else if (uniqueTitles.length === 1) {
                    const singleItem = validItems[0] || chunkItems[0];
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

                await message.reply(replyOptions);
              }

              if (config.autoSuppressEmbeds) {
                await message.suppressEmbeds(true).catch(() => {});
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
    } // end while(true)
  }; // end workerLoop

  // Spawn Workers
  const workers = Array.from({ length: concurrency }).map((_, i) => workerLoop(i + 1));

  // Producer Loop: Fetch messages and enqueue them
  let lastMessageId = null;
  let remainingLimit = options.limit || Infinity;

  try {
    while (remainingLimit > 0) {
      if (isScanStopRequested) {
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

        // Collect candidate messages that actually contain links
        if (!msg.author.bot && msg.content && msg.content.includes('http')) {
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

  // Wait for all workers to finish processing the queue
  await Promise.all(workers);

  const totalElapsed = Date.now() - speedTracker.startTime;
  const avgSpeed = stats.totalBytesArchived > 0 && totalElapsed > 0
    ? (stats.totalBytesArchived / (totalElapsed / 1000) / (1024 * 1024)).toFixed(1)
    : '0';

  console.log(
    `[Scanner] ✅ Finished #${channel.name} in ${formatDuration(totalElapsed)}: ` +
    `${stats.archivedCount} archived (${formatBytes(stats.totalBytesArchived)}), ` +
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
    await commandMessage.reply({
      content: '⚠️ A rescan or media crawl is already running. Please wait for it to complete.',
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  // Permission Check: Requires Manage Messages or Administrator permissions (or server owner)
  if (commandMessage.member && !commandMessage.member.permissions.has(PermissionFlagsBits.ManageMessages) && !commandMessage.member.permissions.has(PermissionFlagsBits.Administrator)) {
    await commandMessage.reply({
      content: '❌ You need the `Manage Messages` or `Administrator` permission to run a channel rescan.',
      allowedMentions: { repliedUser: false },
    });
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
        c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ReadMessageHistory)
    );

    // Apply allowed/disallowed channel filtering if configured
    if (config.allowedChannelIds.length > 0) {
      targetChannels = targetChannels.filter((c) => config.allowedChannelIds.includes(c.id));
    } else if (config.disallowedChannelIds.length > 0) {
      targetChannels = targetChannels.filter((c) => !config.disallowedChannelIds.includes(c.id));
    }
  } else if (target === 'current') {
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
      targetChannels = [specificChannel];
    } else {
      await commandMessage.reply({
        content: `❌ Could not find or access text channel \`${target}\`.`,
        allowedMentions: { repliedUser: false },
      });
      return;
    }
  }

  if (targetChannels.length === 0) {
    await commandMessage.reply({
      content: '❌ No accessible text channels found to scan.',
      allowedMentions: { repliedUser: false },
    });
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
    archivedCount: 0,
    repostedMissingCount: 0,
    skippedCount: 0,
    failedCount: 0,
    totalBytes: 0,
  };

  let lastStatusUpdate = 0;

  try {
    for (let i = 0; i < targetChannels.length; i++) {
      if (isScanStopRequested) {
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

          let statusContent =
            `⏳ **${modeName} in Progress...**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 Current Channel: **#${ch.name}**${channelIndexStr}\n` +
            `📨 Messages Scanned: **${totalMsgs.toLocaleString()}**\n` +
            `🎬 Media Links Found: **${totalLinks.toLocaleString()}**\n` +
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
      aggregate.archivedCount += chStats.archivedCount;
      aggregate.repostedMissingCount += chStats.repostedMissingCount;
      aggregate.skippedCount += chStats.skippedCount;
      aggregate.failedCount += chStats.failedCount;
      aggregate.totalBytes += chStats.totalBytesArchived;
    }

    const totalElapsed = formatDuration(Date.now() - startTime);
    const finalSize = formatBytes(aggregate.totalBytes);
    const wasStopped = isScanStopRequested;

    let finalSummary = wasStopped
      ? `🛑 **${modeName} Stopped Early by User!**\n`
      : `✅ **${modeName} Complete!**\n`;

    finalSummary +=
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📁 Channels Scanned: **${aggregate.channelsCount}**\n` +
      `📨 Total Messages Scanned: **${aggregate.messagesScanned.toLocaleString()}**\n` +
      `🎬 Total Media Links Found: **${aggregate.mediaLinksFound.toLocaleString()}**\n` +
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
    isScanStopRequested = false;
  }
}

/**
 * Resolves all text and announcement channels across all guilds that the bot can view and read history for,
 * strictly filtered by whitelist (ALLOWED_CHANNEL_IDS) or blacklist (DISALLOWED_CHANNEL_IDS).
 */
export async function getScannableChannels(client) {
  const targetChannels = new Map();

  // If whitelist is set, strictly resolve only those channels
  if (config.allowedChannelIds.length > 0) {
    for (const channelId of config.allowedChannelIds) {
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
    return Array.from(targetChannels.values());
  }

  // Otherwise, discover scannable channels across all active guilds (excluding blacklist)
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
          isChannelAllowed(ch.id)
        ) {
          targetChannels.set(ch.id, ch);
        }
      }
    } catch (err) {
      console.warn(`[Scanner] Could not fetch channels for guild ${guild.name} (${guild.id}):`, err.message);
    }
  }

  return Array.from(targetChannels.values());
}

/**
 * Automatically scans recent message history (default: last 24 hours) across all
 * whitelisted / non-blacklisted channels on bot startup. Downloads media and backfills
 * any missed uploads to Discord.
 */
export async function runStartupScan(client) {
  if (isScanningActive) {
    console.log('[Startup Scan] A scan is already running. Skipping automatic startup scan.');
    return;
  }

  isScanningActive = true;
  isScanStopRequested = false;

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
      archivedCount: 0,
      repostedMissingCount: 0,
      skippedCount: 0,
      failedCount: 0,
      totalBytes: 0,
    };

    for (let i = 0; i < targetChannels.length; i++) {
      if (isScanStopRequested) {
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
    isScanStopRequested = false;
  }
}
