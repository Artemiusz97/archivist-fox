import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getBestVideoEncoder } from './compress.js';
import { isAbortError, isVideo, probeMedia, runProcess } from './utils.js';

/**
 * Finds or extracts a thumbnail image associated with the given video file.
 *
 * @param {string} videoPath - Absolute path to video
 * @param {string} [destDir] - Temp directory containing downloads
 * @param {{ signal?: AbortSignal, mediaInfo?: object }} [options={}]
 * @returns {Promise<string|null>} Path to thumbnail file or null
 */
export async function findThumbnailFile(videoPath, destDir, options = {}) {
  const directory = destDir || path.dirname(videoPath);
  const parsed = path.parse(videoPath);
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];

  // 1. Look for matching thumbnail file written by yt-dlp
  for (const ext of imageExts) {
    const candidate = path.join(directory, `${parsed.name}${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 2. Look for any image file in directory
  try {
    const files = await fs.promises.readdir(directory);
    for (const file of files) {
      if (imageExts.includes(path.extname(file).toLowerCase())) {
        return path.join(directory, file);
      }
    }
  } catch {}

  // 3. Extract embedded cover art or representative frame
  const tempExtractedThumb = path.join(directory, `temp_thumb_${Date.now()}.jpg`);
  const extracted = await extractEmbeddedThumbnail(videoPath, tempExtractedThumb, options);
  if (extracted) {
    return tempExtractedThumb;
  } else {
    await fs.promises.unlink(tempExtractedThumb).catch(() => {});
  }

  return null;
}

/**
 * Injects a ~0.15s freeze frame of the YouTube/platform thumbnail at 00:00:00.
 * Forces Discord's chat player snapshot (frame 0) to display the official
 * thumbnail instead of a blank/black frame while stream-copying audio (`-c:a copy`).
 */
export async function applyThumbnailPreview(videoPath, destDir, providedThumbPath = null, options = {}) {
  if (!config.prependThumbnailPreview) return videoPath;
  if (!isVideo(videoPath)) return videoPath;

  const directory = destDir || path.dirname(videoPath);
  const parsed = path.parse(videoPath);

  const thumbPath = providedThumbPath && fs.existsSync(providedThumbPath)
    ? providedThumbPath
    : await findThumbnailFile(videoPath, directory, options);

  if (!thumbPath) {
    return videoPath;
  }

  const isTempExtracted = path.basename(thumbPath).startsWith('temp_thumb_');
  const tempOutput = path.join(directory, `thumb_injected_${Date.now()}_${parsed.name}.mp4`);

  try {
    const dimensions =
      options.mediaInfo?.width > 0 && options.mediaInfo?.height > 0
        ? { width: options.mediaInfo.width, height: options.mediaInfo.height }
        : await getVideoDimensions(videoPath, options.signal);

    if (!dimensions || !dimensions.width || !dimensions.height) {
      return videoPath;
    }

    const width = Math.max(2, dimensions.width % 2 === 0 ? dimensions.width : dimensions.width - 1);
    const height = Math.max(2, dimensions.height % 2 === 0 ? dimensions.height : dimensions.height - 1);

    const primaryEncoder = await getBestVideoEncoder();
    let success = await tryInject(primaryEncoder, videoPath, thumbPath, width, height, tempOutput, options.signal);

    if (!success && primaryEncoder !== 'libx264') {
      console.warn(`[ThumbnailPreview] ${primaryEncoder} failed, falling back to libx264...`);
      success = await tryInject('libx264', videoPath, thumbPath, width, height, tempOutput, options.signal);
    }

    if (success && fs.existsSync(tempOutput)) {
      const stat = await fs.promises.stat(tempOutput);
      if (stat.size > 0) {
        return tempOutput;
      }
      await fs.promises.unlink(tempOutput).catch(() => {});
    }
  } catch (err) {
    await fs.promises.unlink(tempOutput).catch(() => {});
    if (isAbortError(err) || options.signal?.aborted) throw err;
    console.warn(`[ThumbnailPreview] Failed to inject thumbnail preview for ${parsed.base}:`, err.message);
  } finally {
    if (isTempExtracted) {
      await fs.promises.unlink(thumbPath).catch(() => {});
    }
  }

  return videoPath;
}

async function tryInject(encoder, videoPath, thumbPath, width, height, tempOutput, signal = null) {
  const encoderArgs = getEncoderArgs(encoder);
  const filter = `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[t];[0:v][t]overlay=enable='between(t,0,0.15)'[v]`;

  const args = [
    '-y',
    '-i', videoPath,
    '-i', thumbPath,
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '0:a?',
    ...encoderArgs,
    '-c:a', 'copy',
    '-movflags', '+faststart',
    tempOutput,
  ];

  try {
    await runProcess(config.ffmpegPath, args, { timeoutMs: 4 * 60 * 1000, signal });
    return fs.existsSync(tempOutput);
  } catch (err) {
    await fs.promises.unlink(tempOutput).catch(() => {});
    if (isAbortError(err) || signal?.aborted) throw err;
    return false;
  }
}

export async function getVideoDimensions(videoPath, signal = null) {
  const info = await probeMedia(videoPath, { timeoutMs: 30000, signal });
  if (info.width > 0 && info.height > 0) {
    return { width: info.width, height: info.height };
  }
  return null;
}

async function extractEmbeddedThumbnail(videoPath, destThumbPath, options = {}) {
  const signal = options?.signal || null;
  try {
    const info = options?.mediaInfo?.attachedPicStreamIndex !== undefined
      ? options.mediaInfo
      : await probeMedia(videoPath, { timeoutMs: 15000, signal });

    const thumbStreamIndex = info.attachedPicStreamIndex ?? null;

    if (thumbStreamIndex !== null) {
      await runProcess(
        config.ffmpegPath,
        [
          '-y',
          '-i', videoPath,
          '-map', `0:${thumbStreamIndex}`,
          '-c:v', 'copy',
          '-frames:v', '1',
          destThumbPath,
        ],
        { timeoutMs: 30000, signal }
      );
      const stat = await fs.promises.stat(destThumbPath).catch(() => null);
      if (stat && stat.size > 0) return true;
    }

    try {
      await runProcess(
        config.ffmpegPath,
        [
          '-y',
          '-i', videoPath,
          '-vf', 'thumbnail=300',
          '-frames:v', '1',
          '-q:v', '2',
          destThumbPath,
        ],
        { timeoutMs: 30000, signal }
      );
      const stat = await fs.promises.stat(destThumbPath).catch(() => null);
      if (stat && stat.size > 0) return true;
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw err;
    }

    await runProcess(
      config.ffmpegPath,
      [
        '-y',
        '-ss', '00:00:01.000',
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '2',
        destThumbPath,
      ],
      { timeoutMs: 30000, signal }
    );
    const stat = await fs.promises.stat(destThumbPath).catch(() => null);
    return Boolean(stat && stat.size > 0);
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    return false;
  }
}

function getEncoderArgs(encoder) {
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'fast', '-global_quality', '23', '-pix_fmt', 'yuv420p'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23', '-pix_fmt', 'yuv420p'];
    default:
      return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p'];
  }
}
