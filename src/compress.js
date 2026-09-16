import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { killProcessTree } from './utils.js';

const AUDIO_BITRATE_KBPS = 96;
const SAFETY_MARGIN = 0.92; // leave some headroom under the target size

let detectedGpuEncoder = undefined;

export function run(cmd, args, timeoutMs = 4 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error(`TIMEOUT: ${cmd} took too long (${Math.round(timeoutMs / 1000)}s limit)`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(`COMMAND_NOT_FOUND: ${cmd} is not installed or not on PATH`));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
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

  // 'auto': Probe ffmpeg available encoders
  try {
    const { stdout } = await run(config.ffmpegPath, ['-encoders']);
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
  } catch {}

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

async function getMediaInfo(filePath) {
  const { stdout } = await run(config.ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_name,bit_rate,codec_type,width,height',
    '-of', 'json',
    filePath,
  ]);
  const data = JSON.parse(stdout || '{}');
  const duration = parseFloat(data.format?.duration || '0');
  if (!duration || Number.isNaN(duration)) {
    throw new Error('Could not determine video duration for compression');
  }
  
  let audioCodec = null;
  let audioBitrate = 0;
  let width = 0;
  let height = 0;
  
  if (data.streams) {
    const videoStream = data.streams.find((s) => s.codec_type === 'video');
    if (videoStream) {
      width = parseInt(videoStream.width || '0', 10);
      height = parseInt(videoStream.height || '0', 10);
    }
    const audioStream = data.streams.find((s) => s.codec_type === 'audio');
    if (audioStream) {
      audioCodec = audioStream.codec_name;
      audioBitrate = parseInt(audioStream.bit_rate || '0', 10);
    }
  }

  return { duration, audioCodec, audioBitrate, width, height };
}

/**
 * Re-encodes a video down to fit under maxBytes. Tries progressively lower
 * bitrates/resolutions across a few attempts. If thumbPath is provided,
 * injects the 0.15s preview overlay directly in the same encoding pass.
 * Returns the path to a new, smaller file, or throws if it can't get under the limit.
 */
export async function compressVideo(inputPath, maxBytes, thumbPath = null) {
  const { duration, audioCodec, audioBitrate, width, height } = await getMediaInfo(inputPath);
  const videoDim = { width, height };
  const attempts = [
    { scale: null },       // original resolution, bitrate cut to fit
    { scale: 720 },        // downscale to 720p if still too big
    { scale: 480 },        // downscale to 480p as a last resort
  ];

  const primaryEncoder = await getBestVideoEncoder();
  let lastError;

  // Quality preservation gate: If the video is too long to fit under maxBytes
  // without dropping below acceptable fidelity (~200k video + 80k audio),
  // abort early and preserve the original in the local archive instead of
  // wasting CPU producing an unwatchable pixelated video.
  const MIN_ACCEPTABLE_TOTAL_KBPS = 280;
  const targetTotalKbps = (maxBytes * 8 * SAFETY_MARGIN) / duration / 1000;
  if (targetTotalKbps < MIN_ACCEPTABLE_TOTAL_KBPS) {
    throw new Error('QUALITY_PRESERVATION_LIMIT');
  }
  
  // Decide whether to re-encode audio or just copy it
  // If source is already aac/opus and under ~140kbps, copy to save CPU and quality
  const canCopyAudio = (audioCodec === 'aac' || audioCodec === 'opus') && audioBitrate > 0 && audioBitrate <= 140000;
  const audioArgs = canCopyAudio 
    ? ['-c:a', 'copy'] 
    : ['-c:a', 'aac', '-b:a', `${AUDIO_BITRATE_KBPS}k`];

  for (const attempt of attempts) {
    // If copying audio, subtract the actual source audio bitrate, otherwise subtract our target audio bitrate
    const estimatedAudioKbps = canCopyAudio ? (audioBitrate / 1000) : AUDIO_BITRATE_KBPS;
    const targetTotalKbps = (maxBytes * 8 * SAFETY_MARGIN) / duration / 1000;
    const videoKbps = Math.max(150, Math.floor(targetTotalKbps - estimatedAudioKbps));

    const outputPath = path.join(
      path.dirname(inputPath),
      `compressed-${attempt.scale || 'orig'}-${path.basename(inputPath, path.extname(inputPath))}.mp4`
    );

    // Try primary encoder (GPU or CPU) with optional single-pass thumbnail overlay
    let success = await tryEncode(
      primaryEncoder,
      inputPath,
      outputPath,
      videoKbps,
      attempt.scale,
      maxBytes,
      audioArgs,
      thumbPath,
      videoDim
    );
    if (success) return outputPath;

    // If GPU encoder failed, attempt fallback to CPU libx264
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
        videoDim
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
  videoDim = null
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
    targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth - 1;
    targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight - 1;

    let filter = '';
    if (scale && videoDim.height > scale) {
      filter = `[0:v]scale=${targetWidth}:${targetHeight}[base];[1:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[t];[base][t]overlay=enable='between(t,0,0.15)'[v]`;
    } else {
      filter = `[1:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[t];[0:v][t]overlay=enable='between(t,0,0.15)'[v]`;
    }
    args.push('-filter_complex', filter, '-map', '[v]', '-map', '0:a?');
  } else {
    if (scale) {
      args.push('-vf', `scale=-2:${scale}`);
    }
  }

  args.push(...encArgs, ...audioArgs, '-movflags', '+faststart', outputPath);

  try {
    await run(config.ffmpegPath, args);
    const { size } = await fs.promises.stat(outputPath);
    if (size <= maxBytes) {
      return true;
    }
    await fs.promises.unlink(outputPath).catch(() => {});
    return false;
  } catch (err) {
    await fs.promises.unlink(outputPath).catch(() => {});
    return false;
  }
}

export async function compressAudio(inputPath, maxBytes) {
  const { duration } = await getMediaInfo(inputPath);
  
  // Audio quality preservation gate: don't compress below 32 kbps (e.g. extremely long audio)
  const targetBitrateKbps = Math.floor((maxBytes * 8 * SAFETY_MARGIN) / duration / 1000);
  if (targetBitrateKbps < 32) {
    throw new Error('QUALITY_PRESERVATION_LIMIT');
  }

  // Clamp audio bitrate to sensible ranges
  const audioKbps = Math.min(config.maxAudioBitrateKbps || 320, Math.max(32, targetBitrateKbps));

  const outputPath = path.join(
    path.dirname(inputPath),
    `compressed-${audioKbps}k-${path.basename(inputPath, path.extname(inputPath))}.mp3`
  );

  const args = [
    '-y',
    '-i', inputPath,
    '-vn', // Strip any cover art from the active stream mux to avoid video frame limits
    '-c:a', 'libmp3lame',
    '-b:a', `${audioKbps}k`,
    outputPath
  ];

  try {
    await run(config.ffmpegPath, args);
    const { size } = await fs.promises.stat(outputPath);
    if (size <= maxBytes) {
      return outputPath;
    }
    await fs.promises.unlink(outputPath).catch(() => {});
    return null;
  } catch (err) {
    await fs.promises.unlink(outputPath).catch(() => {});
    return null;
  }
}

