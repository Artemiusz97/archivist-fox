import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { config } from './config.js';
import { sanitizePathSegment, runProcess } from './utils.js';

/**
 * Resolves subfolder relative path based on user's configured format.
 */
function getSubfolderPath(context = {}) {
  const format = (config.archiveSubfolderFormat || 'channel/date').toLowerCase();
  if (format === 'flat' || format === 'none' || format === 'off') {
    return '';
  }

  const dateStr = new Date().toISOString().slice(0, 7); // e.g. "2026-08"
  const channelName = sanitizePathSegment(context.channel || 'general', 60, 'general');

  if (format === 'channel/date') {
    return path.join(channelName, dateStr);
  }
  if (format === 'date/channel') {
    return path.join(dateStr, channelName);
  }
  if (format === 'channel') {
    return channelName;
  }
  if (format === 'date') {
    return dateStr;
  }

  return path.join(channelName, dateStr);
}

/**
 * Permanently archives an uncompressed original media file to the local PC archive folder,
 * organizing it into smart subdirectories and saving a matching metadata JSON sidecar.
 *
 * @param {string} sourceFilePath - Path to the newly downloaded uncompressed file
 * @param {object} context - Metadata object containing link URL, author, channel name, etc.
 * @returns {Promise<string|null>} Target archived file path or null if disabled
 */
export async function archiveLocalMedia(sourceFilePath, context = {}) {
  if (!config.enableLocalArchive) return null;

  try {
    const rootDir = path.resolve(config.archiveDirectory);
    const subfolder = getSubfolderPath(context);
    const targetDir = path.join(rootDir, subfolder);

    await fs.promises.mkdir(targetDir, { recursive: true });

    const parsed = path.parse(sourceFilePath);
    const ext = parsed.ext.slice(0, 10);
    const safeBaseName = sanitizePathSegment(parsed.name, 90);
    let targetBasename = `${safeBaseName}${ext}`;
    let destPath = path.join(targetDir, targetBasename);

    // If source file is already at destination path, do not re-copy
    if (path.resolve(sourceFilePath) === path.resolve(destPath)) {
      return destPath;
    }

    // Check if destPath already exists and is the same media
    if (fs.existsSync(destPath)) {
      const sourceStat = await fs.promises.stat(sourceFilePath).catch(() => null);
      const destStat = await fs.promises.stat(destPath).catch(() => null);
      let isSameMedia = false;
      const metadataPath = `${destPath}.json`;

      if (fs.existsSync(metadataPath)) {
        try {
          const existingMeta = JSON.parse(await fs.promises.readFile(metadataPath, 'utf-8'));
          if (context.mediaId && existingMeta.mediaId && context.mediaId === existingMeta.mediaId) {
            isSameMedia = true;
          } else if (context.url && existingMeta.originalUrl && context.url === existingMeta.originalUrl) {
            isSameMedia = true;
          } else if (context.sha256 && existingMeta.sha256 && context.sha256 === existingMeta.sha256) {
            isSameMedia = true;
          }
        } catch {}
      }

      if (!isSameMedia && sourceStat && destStat && sourceStat.size === destStat.size && sourceStat.size > 0) {
        isSameMedia = true;
      }

      if (isSameMedia) {
        console.log(`[Archiver] Media already preserved at ${destPath}, skipping duplicate copy.`);
        // Update metadata sidecar with any newly discovered fields if missing
        if (config.archiveSaveMetadata) {
          try {
            let meta = {};
            if (fs.existsSync(metadataPath)) {
              meta = JSON.parse(await fs.promises.readFile(metadataPath, 'utf-8'));
            }
            meta.title = meta.title || context.title || parsed.name;
            meta.mediaId = meta.mediaId || context.mediaId || null;
            meta.sha256 = meta.sha256 || context.sha256 || null;
            meta.originalUrl = meta.originalUrl || context.url || null;
            meta.postedBy = meta.postedBy || context.author || null;
            meta.channel = meta.channel || context.channel || null;
            meta.fileName = targetBasename;
            meta.relativePath = path.relative(rootDir, destPath).split(path.sep).join('/');
            meta.fileSizeBytes = destStat.size;
            if (context.isNsfw) meta.isNsfw = true;
            await fs.promises.writeFile(metadataPath, JSON.stringify(meta, null, 2), 'utf-8');
          } catch {}
        }
        return destPath;
      }

      // If different media has the same base name, check if a collision file was already preserved for this media
      let foundExistingCollidedPath = null;
      if (context.mediaId || context.url || context.sha256) {
        try {
          const existingFiles = await fs.promises.readdir(targetDir);
          const prefix = `${safeBaseName.slice(0, 75)}_`;
          const jsonCandidates = existingFiles.filter(f => f.startsWith(prefix) && f.endsWith(`${ext}.json`));
          for (const jf of jsonCandidates) {
            try {
              const candidateMeta = JSON.parse(await fs.promises.readFile(path.join(targetDir, jf), 'utf-8'));
              if (
                (context.mediaId && candidateMeta.mediaId === context.mediaId) ||
                (context.sha256 && candidateMeta.sha256 === context.sha256) ||
                (context.url && candidateMeta.originalUrl === context.url)
              ) {
                const candidateMediaName = jf.slice(0, -5);
                const candidateMediaPath = path.join(targetDir, candidateMediaName);
                if (fs.existsSync(candidateMediaPath)) {
                  foundExistingCollidedPath = candidateMediaPath;
                  break;
                }
              }
            } catch {}
          }
        } catch {}
      }

      if (foundExistingCollidedPath) {
        console.log(`[Archiver] Found previously preserved copy at ${foundExistingCollidedPath}, skipping duplicate copy.`);
        return foundExistingCollidedPath;
      }

      // Truly distinct media with name collision: append timestamp to prevent overwriting
      const timestamp = Date.now().toString(36);
      targetBasename = `${safeBaseName.slice(0, 75)}_${timestamp}${ext}`;
      destPath = path.join(targetDir, targetBasename);
    }

    // Copy original uncompressed file to permanent archive destination
    await fs.promises.copyFile(sourceFilePath, destPath);

    // Save sidecar metadata JSON if enabled
    if (config.archiveSaveMetadata) {
      const metadataPath = `${destPath}.json`;
      const metadata = {
        title: context.title || parsed.name,
        mediaId: context.mediaId || null,
        sha256: context.sha256 || null,
        originalUrl: context.url || null,
        postedBy: context.author || null,
        channel: context.channel || null,
        isNsfw: Boolean(context.isNsfw),
        archivedAt: new Date().toISOString(),
        fileName: targetBasename,
        relativePath: path.relative(rootDir, destPath).split(path.sep).join('/'),
        fileSizeBytes: (await fs.promises.stat(destPath)).size,
      };
      if (context.companionFiles && Array.isArray(context.companionFiles) && context.companionFiles.length > 0) {
        metadata.companionFiles = context.companionFiles.map((cf) => `${path.parse(destPath).name}${path.extname(cf).toLowerCase()}`);
      }
      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    }

    // Save associated companion files (e.g. dual-format MP4/GIF)
    if (context.companionFiles && Array.isArray(context.companionFiles)) {
      const baseStem = path.parse(destPath).name;
      for (const compFile of context.companionFiles) {
        if (fs.existsSync(compFile)) {
          const compExt = path.extname(compFile).toLowerCase();
          const targetCompPath = path.join(targetDir, `${baseStem}${compExt}`);
          if (path.resolve(compFile) !== path.resolve(targetCompPath)) {
            await fs.promises.copyFile(compFile, targetCompPath).catch(() => {});
            console.log(`[Archiver] Preserved companion dual-format file to ${targetCompPath}`);
          }
        }
      }
    }

    // Save associated subtitle files
    if (context.subtitleFiles && Array.isArray(context.subtitleFiles)) {
      const videoStem = path.parse(destPath).name;
      for (const subFile of context.subtitleFiles) {
        if (fs.existsSync(subFile)) {
          const subExt = path.extname(subFile).toLowerCase();
          const subBase = path.basename(subFile, subExt);
          const match = subBase.match(/(?:^|[._-])([a-zA-Z]{2,3}(?:-[A-Za-z]{2,4})?)(?:-[a-zA-Z0-9_-]+)?$/i);
          const langSuffix = match ? `.${match[1]}` : subBase.replace(parsed.name, '');
          
          const targetSubPath = path.join(targetDir, `${videoStem}${langSuffix}${subExt}`);
          await fs.promises.copyFile(subFile, targetSubPath).catch(() => {});
        }
      }
    }

    console.log(`[Archiver] Preserved high-quality media to ${destPath}`);
    return destPath;
  } catch (err) {
    console.error('[Archiver] Failed to save local media archive:', err);
    return null;
  }
}

/**
 * Reads the `.json` sidecar metadata saved next to a local archived media file, if present.
 *
 * @param {string|null} archivedFilePath
 * @returns {Promise<object|null>}
 */
export async function readArchivedSidecar(archivedFilePath) {
  if (!archivedFilePath) return null;
  const metaPath = `${archivedFilePath}.json`;
  try {
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Builds a clean, Windows-safe subtitle filename preserving the language tag
 * (e.g. `Video Title.en.srt`).
 *
 * @param {string} subPath
 * @param {string} [baseTitle]
 * @returns {string}
 */
export function getCleanSubtitleFilename(subPath, baseTitle = '') {
  const ext = path.extname(subPath).toLowerCase() || '.srt';
  const rawBase = path.basename(subPath, ext);
  const langMatch = rawBase.match(/(?:^|[._-])([a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$/);
  const langSuffix = langMatch ? `.${langMatch[1]}` : '';
  const stemSource = baseTitle || (langMatch ? rawBase.slice(0, rawBase.length - langMatch[0].length) : rawBase);
  const safeStem = sanitizePathSegment(stemSource || 'subtitles', 80, 'subtitles');
  return `${safeStem}${langSuffix}${ext}`;
}

/**
 * Prepares Discord `AttachmentBuilder` items for downloaded subtitle sidecars.
 * Uses asynchronous `runProcess('tar', ...)` when zipping many language tracks
 * so the Node.js event loop and Discord gateway heartbeat never block.
 *
 * @param {string[]} subtitleFiles
 * @param {string} cleanTitle
 * @param {string} tempDir
 * @param {boolean} [shouldSpoiler=false]
 * @param {AbortSignal|null} [signal=null]
 * @returns {Promise<AttachmentBuilder[]>}
 */
export async function prepareSubtitleAttachments(
  subtitleFiles,
  cleanTitle,
  tempDir,
  shouldSpoiler = false,
  signal = null
) {
  if (!config.uploadSubtitlesToDiscord || !Array.isArray(subtitleFiles) || subtitleFiles.length === 0) {
    return [];
  }

  const validSubs = [];
  for (const subPath of subtitleFiles) {
    try {
      const stat = await fs.promises.stat(subPath);
      if (stat.size > 0 && stat.size <= config.maxFileSizeBytes) {
        validSubs.push(subPath);
      }
    } catch {}
  }

  if (validSubs.length === 0) return [];

  // Prioritize English subtitle tracks first (e.g. .en.srt, .en-US.srt)
  const enRegex = /(?:^|[._-])en(?:[-_][a-zA-Z0-9]+)?\.(?:srt|vtt|ass)$/i;
  validSubs.sort((a, b) => {
    const aEn = enRegex.test(path.basename(a)) ? 0 : 1;
    const bEn = enRegex.test(path.basename(b)) ? 0 : 1;
    return aEn - bEn;
  });

  const maxIndividual = config.maxIndividualSubtitles || 3;
  if (config.zipMultiSubtitles && validSubs.length > maxIndividual && tempDir) {
    const stageDir = path.join(tempDir, `subs-${Date.now()}`);
    try {
      await fs.promises.mkdir(stageDir, { recursive: true });
      const stagedNames = [];
      for (const subPath of validSubs) {
        const cleanName = getCleanSubtitleFilename(subPath, cleanTitle);
        await fs.promises.copyFile(subPath, path.join(stageDir, cleanName));
        stagedNames.push(cleanName);
      }
      const safeStem = sanitizePathSegment(cleanTitle || 'subtitles', 75, 'subtitles');
      const zipBaseName = `${safeStem}_subtitles.zip`;
      const zipPath = path.join(tempDir, zipBaseName);

      await runProcess('tar', ['-a', '-c', '-f', zipPath, ...stagedNames], {
        cwd: stageDir,
        timeoutMs: 30000,
        signal,
        registerProcess: false,
      });

      const zipStat = await fs.promises.stat(zipPath).catch(() => null);
      if (zipStat && zipStat.size > 0 && zipStat.size <= config.maxFileSizeBytes) {
        const attachment = new AttachmentBuilder(zipPath, { name: zipBaseName });
        if (shouldSpoiler) {
          attachment.setSpoiler(true);
        }
        return [attachment];
      }
    } catch {
      // Fall back to attaching up to maxIndividual subtitle files individually
    }
  }

  const attachments = [];
  for (const subPath of validSubs.slice(0, maxIndividual)) {
    const cleanName = getCleanSubtitleFilename(subPath, cleanTitle);
    const attachment = new AttachmentBuilder(subPath, { name: cleanName });
    if (shouldSpoiler) {
      attachment.setSpoiler(true);
    }
    attachments.push(attachment);
  }
  return attachments;
}
