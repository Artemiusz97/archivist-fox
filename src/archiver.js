import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { sanitizePathSegment } from './utils.js';

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

    // If file with same name exists, append timestamp to prevent overwriting
    if (fs.existsSync(destPath)) {
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
        archivedAt: new Date().toISOString(),
        fileName: targetBasename,
        relativePath: path.relative(rootDir, destPath),
        fileSizeBytes: (await fs.promises.stat(destPath)).size,
      };
      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
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
