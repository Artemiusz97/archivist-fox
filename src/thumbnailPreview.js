import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { run, getBestVideoEncoder } from './compress.js';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'm4v']);

function isVideo(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

/**
 * Finds or extracts a thumbnail image associated with the given video file.
 *
 * @param {string} videoPath - Absolute path to video
 * @param {string} [destDir] - Temp directory containing downloads
 * @returns {Promise<string|null>} Path to thumbnail file or null
 */
export async function findThumbnailFile(videoPath, destDir) {
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
  const extracted = await extractEmbeddedThumbnail(videoPath, tempExtractedThumb);
  if (extracted) {
    return tempExtractedThumb;
  } else {
    await fs.promises.unlink(tempExtractedThumb).catch(() => {});
  }

  return null;
}

/**
 * Injects a ~0.15s freeze frame of the YouTube/platform thumbnail at 00:00:00.
 * This forces Discord's chat player snapshot mechanism (which strictly captures frame 0)
 * to display the official thumbnail instead of a blank/black frame.
 * The audio track is stream-copied (-c:a copy) so audio is 100% preserved with zero drift.
 *
 * @param {string} videoPath - Absolute path to the downloaded video
 * @param {string} [destDir] - Temp directory where thumbnail might be located
 * @param {string} [providedThumbPath] - Optional pre-discovered thumbnail path
 * @returns {Promise<string>} - The resulting video path
 */
export async function applyThumbnailPreview(videoPath, destDir, providedThumbPath = null) {
  if (!config.prependThumbnailPreview) return videoPath;
  if (!isVideo(videoPath)) return videoPath;

  const directory = destDir || path.dirname(videoPath);
  const parsed = path.parse(videoPath);

  let thumbPath = providedThumbPath && fs.existsSync(providedThumbPath)
    ? providedThumbPath
    : await findThumbnailFile(videoPath, directory);

  if (!thumbPath) {
    return videoPath; // No thumbnail available to inject
  }

  const isTempExtracted = path.basename(thumbPath).startsWith('temp_thumb_');
  const tempOutput = path.join(directory, `thumb_injected_${Date.now()}_${parsed.name}.mp4`);

  try {
    // 2. Probe video dimensions
    const dimensions = await getVideoDimensions(videoPath);
    if (!dimensions || !dimensions.width || !dimensions.height) {
      return videoPath;
    }

    // Ensure even dimensions for H.264 encoder compatibility
    const width = dimensions.width % 2 === 0 ? dimensions.width : dimensions.width - 1;
    const height = dimensions.height % 2 === 0 ? dimensions.height : dimensions.height - 1;

    const primaryEncoder = await getBestVideoEncoder();
    let success = await tryInject(primaryEncoder, videoPath, thumbPath, width, height, tempOutput);

    // Fall back to CPU libx264 if GPU encoder failed
    if (!success && primaryEncoder !== 'libx264') {
      console.warn(`[ThumbnailPreview] ${primaryEncoder} failed, falling back to libx264...`);
      success = await tryInject('libx264', videoPath, thumbPath, width, height, tempOutput);
    }

    if (success && fs.existsSync(tempOutput)) {
      const stat = await fs.promises.stat(tempOutput);
      if (stat.size > 0) {
        return tempOutput;
      }
      await fs.promises.unlink(tempOutput).catch(() => {});
    }
  } catch (err) {
    console.warn(`[ThumbnailPreview] Failed to inject thumbnail preview for ${parsed.base}:`, err.message);
    await fs.promises.unlink(tempOutput).catch(() => {});
  } finally {
    // Clean up temporary extracted thumbnail image
    if (isTempExtracted) {
      await fs.promises.unlink(thumbPath).catch(() => {});
    }
  }

  return videoPath;
}

async function tryInject(encoder, videoPath, thumbPath, width, height, tempOutput) {
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
    // Move MP4 moov atom to the front of the file so Discord can start streaming
    // immediately without waiting for the full download to complete.
    '-movflags', '+faststart',
    tempOutput,
  ];

  try {
    await run(config.ffmpegPath, args);
    return fs.existsSync(tempOutput);
  } catch {
    await fs.promises.unlink(tempOutput).catch(() => {});
    return false;
  }
}

export async function getVideoDimensions(videoPath) {
  try {
    const { stdout } = await run(config.ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      videoPath,
    ]);
    const parts = stdout.trim().split('x');
    if (parts.length >= 2) {
      const width = parseInt(parts[0], 10);
      const height = parseInt(parts[1], 10);
      if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
        return { width, height };
      }
    }
  } catch {}
  return null;
}

async function extractEmbeddedThumbnail(videoPath, destThumbPath) {
  try {
    // 1. Probe for any embedded image stream (e.g. mjpeg/png attached picture)
    const probeProc = spawn(config.ffprobePath || 'ffprobe', [
      '-v', 'error',
      '-select_streams', 'v',
      '-show_entries', 'stream=index,codec_name',
      '-of', 'json',
      videoPath,
    ]);
    let probeOut = '';
    probeProc.stdout.on('data', (d) => (probeOut += d.toString()));
    await new Promise((r) => probeProc.on('close', r));

    let thumbStreamIndex = null;
    try {
      const data = JSON.parse(probeOut);
      const imgStream = data.streams?.find(
        (s) => s.codec_name === 'mjpeg' || s.codec_name === 'png' || s.codec_name === 'webp'
      );
      if (imgStream) {
        thumbStreamIndex = imgStream.index;
      }
    } catch {}

    if (thumbStreamIndex !== null) {
      await run(config.ffmpegPath, [
        '-y',
        '-i', videoPath,
        '-map', `0:${thumbStreamIndex}`,
        '-c:v', 'copy',
        '-frames:v', '1',
        destThumbPath,
      ]);
      const stat = await fs.promises.stat(destThumbPath).catch(() => null);
      if (stat && stat.size > 0) return true;
    }

    // 2. Fallback for older videos without embedded cover art: use FFmpeg smart representative frame filter
    try {
      await run(config.ffmpegPath, [
        '-y',
        '-i', videoPath,
        '-vf', 'thumbnail=300',
        '-frames:v', '1',
        '-q:v', '2',
        destThumbPath,
      ]);
      const stat = await fs.promises.stat(destThumbPath).catch(() => null);
      if (stat && stat.size > 0) return true;
    } catch {}

    // 3. Last-resort fallback: extract frame from 1.0s
    await run(config.ffmpegPath, [
      '-y',
      '-ss', '00:00:01.000',
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '2',
      destThumbPath,
    ]);
    const stat = await fs.promises.stat(destThumbPath).catch(() => null);
    return Boolean(stat && stat.size > 0);
  } catch {
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
