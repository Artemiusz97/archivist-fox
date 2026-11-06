import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { isAbortError, isVideo, isAudio, runProcess, probeMedia } from './utils.js';

const AUDIO_BITRATE_KBPS = 96;
const SAFETY_MARGIN = 0.92; // leave some headroom under the target size

let detectedGpuEncoder = undefined;

export async function run(cmd, args, timeoutMs = 4 * 60 * 1000, signal = null) {
  const { stdout, stderr } = await runProcess(cmd, args, { timeoutMs, signal });
  return { stdout, stderr };
}

/**
 * Detects the best available hardware video encoder or falls back to libx264.
 */
export async function getBestVideoEncoder() {
  if (detectedGpuEncoder !== undefined) return detectedGpuEncoder;

  if (config.gpuAcceleration === 'off') {
    detectedGpuEncoder = 'libx264';
    return detectedGpuEncoder;
  }

  if (['nvenc', 'h264_nvenc'].includes(config.gpuAcceleration)) {
    detectedGpuEncoder = 'h264_nvenc';
    return detectedGpuEncoder;
  }
  if (['qsv', 'h264_qsv'].includes(config.gpuAcceleration)) {
    detectedGpuEncoder = 'h264_qsv';
    return detectedGpuEncoder;
  }
  if (['amf', 'h264_amf'].includes(config.gpuAcceleration)) {
    detectedGpuEncoder = 'h264_amf';
    return detectedGpuEncoder;
  }

  try {
    const { stdout } = await runProcess(config.ffmpegPath, ['-encoders'], {
      timeoutMs: 15000,
      registerProcess: false,
    });
    if (stdout.includes('h264_nvenc')) {
      console.log('[GPU] NVIDIA NVENC hardware acceleration enabled.');
      detectedGpuEncoder = 'h264_nvenc';
      return detectedGpuEncoder;
    }
    if (stdout.includes('h264_qsv')) {
      console.log('[GPU] Intel QuickSync hardware acceleration enabled.');
      detectedGpuEncoder = 'h264_qsv';
      return detectedGpuEncoder;
    }
    if (stdout.includes('h264_amf')) {
      console.log('[GPU] AMD AMF hardware acceleration enabled.');
      detectedGpuEncoder = 'h264_amf';
      return detectedGpuEncoder;
    }
  } catch (err) {
    void err;
  }

  detectedGpuEncoder = 'libx264';
  return detectedGpuEncoder;
}

function getEncoderArgs(encoder, videoKbps) {
  const maxrate = Math.floor(videoKbps * 1.3);
  const bufsize = videoKbps * 2;

  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', `${videoKbps}k`, '-maxrate', `${maxrate}k`, '-bufsize', `${bufsize}k`, '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'fast', '-b:v', `${videoKbps}k`, '-maxrate', `${maxrate}k`, '-bufsize', `${bufsize}k`, '-pix_fmt', 'yuv420p'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-b:v', `${videoKbps}k`, '-maxrate', `${maxrate}k`, '-bufsize', `${bufsize}k`, '-pix_fmt', 'yuv420p'];
    default:
      return ['-c:v', 'libx264', '-preset', 'fast', '-b:v', `${videoKbps}k`, '-maxrate', `${maxrate}k`, '-bufsize', `${bufsize}k`, '-pix_fmt', 'yuv420p'];
  }
}

async function getMediaInfo(filePath, signal = null, preProbed = null) {
  const info = preProbed || (await probeMedia(filePath, { signal }));
  if (!info.duration || Number.isNaN(info.duration)) {
    throw new Error('Could not determine video duration for compression');
  }
  return {
    duration: info.duration,
    audioCodec: info.audioCodec || null,
    audioBitrate: info.audioBitrate || 0,
    width: info.width || 0,
    height: info.height || 0,
  };
}

/**
 * Re-encodes a video down to fit under maxBytes. Tries progressively lower
 * bitrates/resolutions across a few attempts. If thumbPath is provided,
 * injects the 0.15s preview overlay directly in the same encoding pass.
 */
export async function compressVideo(inputPath, maxBytes, thumbPath = null, options = {}) {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new Error('DOWNLOAD_ABORTED');
  }

  const { duration, audioCodec, audioBitrate, width, height } = await getMediaInfo(
    inputPath,
    signal,
    options?.mediaInfo || null
  );
  const videoDim = { width, height };
  const attempts = [
    { scale: null },       // original resolution, bitrate cut to fit
    { scale: 720 },        // downscale to 720p if still too big
    { scale: 480 },        // downscale to 480p as a last resort
  ];

  const primaryEncoder = await getBestVideoEncoder();
  let lastError;

  const MIN_ACCEPTABLE_TOTAL_KBPS = 280;
  const targetTotalKbps = (maxBytes * 8 * SAFETY_MARGIN) / duration / 1000;
  if (targetTotalKbps < MIN_ACCEPTABLE_TOTAL_KBPS) {
    throw new Error('QUALITY_PRESERVATION_LIMIT');
  }

  const canCopyAudio = (audioCodec === 'aac' || audioCodec === 'opus') && audioBitrate > 0 && audioBitrate <= 140000;
  const audioArgs = canCopyAudio
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', `${AUDIO_BITRATE_KBPS}k`];

  for (const attempt of attempts) {
    if (signal?.aborted) {
      throw new Error('DOWNLOAD_ABORTED');
    }

    const estimatedAudioKbps = canCopyAudio ? audioBitrate / 1000 : AUDIO_BITRATE_KBPS;
    const videoKbps = Math.max(150, Math.floor(targetTotalKbps - estimatedAudioKbps));

    const outputPath = path.join(
      path.dirname(inputPath),
      `compressed-${attempt.scale || 'orig'}-${path.basename(inputPath, path.extname(inputPath))}.mp4`
    );

    let success = await tryEncode(
      primaryEncoder,
      inputPath,
      outputPath,
      videoKbps,
      attempt.scale,
      maxBytes,
      audioArgs,
      thumbPath,
      videoDim,
      signal
    );
    if (success) return outputPath;

    if (primaryEncoder !== 'libx264') {
      console.warn(`[GPU] ${primaryEncoder} failed, falling back to CPU libx264...`);
      success = await tryEncode(
        'libx264',
        inputPath,
        outputPath,
        videoKbps,
        attempt.scale,
        maxBytes,
        audioArgs,
        thumbPath,
        videoDim,
        signal
      );
      if (success) return outputPath;
    }

    lastError = new Error(`Compressed file still too large at ${attempt.scale || 'original'} resolution`);
  }

  throw lastError || new Error('Compression failed');
}

async function tryEncode(
  encoder,
  inputPath,
  outputPath,
  videoKbps,
  scale,
  maxBytes,
  audioArgs,
  thumbPath = null,
  videoDim = null,
  signal = null
) {
  const encArgs = getEncoderArgs(encoder, videoKbps);
  const args = ['-y', '-i', inputPath];

  const hasThumb =
    thumbPath &&
    fs.existsSync(thumbPath) &&
    videoDim &&
    videoDim.width > 0 &&
    videoDim.height > 0;

  if (hasThumb) {
    args.push('-i', thumbPath);
    let targetWidth = videoDim.width;
    let targetHeight = videoDim.height;
    if (scale && videoDim.height > scale) {
      targetHeight = scale;
      targetWidth = Math.round((videoDim.width * (scale / videoDim.height)) / 2) * 2;
    }
    targetWidth = Math.max(2, targetWidth % 2 === 0 ? targetWidth : targetWidth - 1);
    targetHeight = Math.max(2, targetHeight % 2 === 0 ? targetHeight : targetHeight - 1);

    let filter = '';
    if (scale && videoDim.height > scale) {
      filter = `[0:v]scale=${targetWidth}:${targetHeight}[base];[1:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[t];[base][t]overlay=enable='between(t,0,0.15)'[v]`;
    } else {
      filter = `[1:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[t];[0:v][t]overlay=enable='between(t,0,0.15)'[v]`;
    }
    args.push('-filter_complex', filter, '-map', '[v]', '-map', '0:a?');
  } else if (scale) {
    args.push('-vf', `scale=-2:${scale}`);
  }

  args.push(...encArgs, ...audioArgs, '-movflags', '+faststart', outputPath);

  try {
    await run(config.ffmpegPath, args, 4 * 60 * 1000, signal);
    const { size } = await fs.promises.stat(outputPath);
    if (size <= maxBytes) {
      return true;
    }
    await fs.promises.unlink(outputPath).catch(() => {});
    return false;
  } catch (err) {
    await fs.promises.unlink(outputPath).catch(() => {});
    if (isAbortError(err) || signal?.aborted) {
      throw err;
    }
    return false;
  }
}

export async function compressAudio(inputPath, maxBytes, options = {}) {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new Error('DOWNLOAD_ABORTED');
  }

  const { duration } = await getMediaInfo(inputPath, signal, options?.mediaInfo || null);

  const targetBitrateKbps = Math.floor((maxBytes * 8 * SAFETY_MARGIN) / duration / 1000);
  if (targetBitrateKbps < 32) {
    throw new Error('QUALITY_PRESERVATION_LIMIT');
  }

  const audioKbps = Math.min(config.maxAudioBitrateKbps || 320, Math.max(32, targetBitrateKbps));

  const outputPath = path.join(
    path.dirname(inputPath),
    `compressed-${audioKbps}k-${path.basename(inputPath, path.extname(inputPath))}.mp3`
  );

  const args = [
    '-y',
    '-i', inputPath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', `${audioKbps}k`,
    outputPath,
  ];

  try {
    await run(config.ffmpegPath, args, 4 * 60 * 1000, signal);
    const { size } = await fs.promises.stat(outputPath);
    if (size <= maxBytes) {
      return outputPath;
    }
    await fs.promises.unlink(outputPath).catch(() => {});
    return null;
  } catch (err) {
    await fs.promises.unlink(outputPath).catch(() => {});
    if (isAbortError(err) || signal?.aborted) {
      throw err;
    }
    return null;
  }
}

/**
 * Ensures a file is at or under config.maxFileSizeBytes, compressing it if
 * it's a video/audio and compression is enabled. If thumbPath is provided,
 * compressVideo applies the thumbnail preview directly in the same encoding pass.
 */
export async function ensureWithinLimit(filePath, onStatus, thumbPath = null, options = {}) {
  const { size } = await fs.promises.stat(filePath);
  if (size <= config.maxFileSizeBytes) return filePath;

  if (config.enableCompression) {
    if (isVideo(filePath)) {
      try {
        if (onStatus) {
          await onStatus('compressing');
        }
        return await compressVideo(filePath, config.maxFileSizeBytes, thumbPath, options);
      } catch (err) {
        if (isAbortError(err) || err?.message?.startsWith('QUALITY_PRESERVATION_LIMIT')) {
          throw err;
        }
        return null;
      }
    } else if (isAudio(filePath)) {
      try {
        if (onStatus) {
          await onStatus('compressing');
        }
        return await compressAudio(filePath, config.maxFileSizeBytes, options);
      } catch (err) {
        if (isAbortError(err) || err?.message?.startsWith('QUALITY_PRESERVATION_LIMIT')) {
          throw err;
        }
        return null;
      }
    }
  }
  return null;
}
