import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { killProcessTree, registerDownloadProcess, unregisterDownloadProcess, isAbortError } from './utils.js';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']);

function run(cmd, args, timeoutMs = 3 * 60 * 1000, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('DOWNLOAD_ABORTED'));
    }

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    registerDownloadProcess(child);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      unregisterDownloadProcess(child);
      killProcessTree(child);
      reject(new Error(`TIMEOUT: ${cmd} took too long (${Math.round(timeoutMs / 1000)}s limit)`));
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      unregisterDownloadProcess(child);
      killProcessTree(child);
      reject(new Error('DOWNLOAD_ABORTED'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      clearTimeout(timer);
      unregisterDownloadProcess(child);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      unregisterDownloadProcess(child);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new Error('DOWNLOAD_ABORTED'));
      } else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Probes media file duration, dimensions, framerate, and audio presence using ffprobe.
 *
 * @param {string} filePath
 * @returns {Promise<{ duration: number, hasAudio: boolean, hasVideo: boolean, codec: string, width: number, height: number, fps: number }>}
 */
export async function probeMediaForGif(filePath) {
  try {
    const { stdout } = await run(config.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate',
      '-of', 'json',
      filePath,
    ]);
    const data = JSON.parse(stdout || '{}');
    const duration = parseFloat(data.format?.duration || '0') || 0;
    const streams = data.streams || [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStreams = streams.filter((s) => s.codec_type === 'audio');

    let fps = 30;
    if (videoStream?.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
      if (num && den && den > 0) {
        fps = Math.round(num / den);
      }
    }

    return {
      duration,
      hasAudio: audioStreams.length > 0,
      hasVideo: Boolean(videoStream),
      codec: videoStream?.codec_name || '',
      width: parseInt(videoStream?.width || '0', 10),
      height: parseInt(videoStream?.height || '0', 10),
      fps: fps || 30,
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return {
      duration: 0,
      hasAudio: false,
      hasVideo: false,
      codec: '',
      width: 0,
      height: 0,
      fps: 30,
    };
  }
}

/**
 * Checks whether a downloaded file qualifies for the GIF pipeline:
 *  - Already in .gif format
 *  - Platform metadata explicitly indicates an original GIF (e.g. Reddit is_gif, Twitter tweet_video)
 *  - Short video clip (duration <= gifMaxDurationSeconds) with no audio track
 *
 * @param {string} filePath
 * @param {object|null} metadata
 * @returns {Promise<{ isCandidate: boolean, isOriginalGif?: boolean, format?: 'gif'|'video', probe?: object }>}
 */
export async function isGifCandidate(filePath, metadata = null) {
  if (!config.enableGifPipeline) {
    return { isCandidate: false };
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();

  // 1. Direct or downloaded .gif file
  if (ext === 'gif') {
    return {
      isCandidate: true,
      isOriginalGif: true,
      format: 'gif',
    };
  }

  // 2. Platform metadata explicitly flags original GIF
  if (metadata?.is_gif === true) {
    const probe = await probeMediaForGif(filePath);
    return {
      isCandidate: true,
      isOriginalGif: true,
      format: 'video',
      probe,
    };
  }

  // 3. Short video without audio
  if (VIDEO_EXTENSIONS.has(ext)) {
    const probe = await probeMediaForGif(filePath);
    if (!probe.hasAudio && probe.duration > 0 && probe.duration <= config.gifMaxDurationSeconds) {
      return {
        isCandidate: true,
        isOriginalGif: false,
        format: 'video',
        probe,
      };
    }
  }

  return { isCandidate: false };
}

/**
 * Generates an uncompromising high-quality GIF using FFmpeg's two-pass
 * custom palette generation (`palettegen` + `paletteuse` with Sierra2_4a dithering).
 * Preserves full native resolution without downscaling.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {object} [options]
 * @returns {Promise<string>}
 */
export async function generateHighQualityGif(inputPath, outputPath, options = {}) {
  const sourceFps = options.fps || 30;
  const targetFps = Math.min(config.gifMaxFps || 30, Math.max(10, Math.round(sourceFps)));

  // Two-pass palettegen + paletteuse filter (full native resolution preserved)
  const filter = `[0:v]fps=${targetFps},split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;

  await run(config.ffmpegPath, [
    '-y',
    '-i', inputPath,
    '-filter_complex', filter,
    outputPath,
  ], 3 * 60 * 1000, options.signal);

  if (!fs.existsSync(outputPath)) {
    throw new Error('GIF generation failed: output file not created');
  }

  return outputPath;
}

/**
 * Converts an oversized GIF to a near-lossless MP4 (CRF 18) for Discord delivery
 * when the original or generated GIF exceeds Discord's file size limit.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {object} [options]
 * @returns {Promise<string>}
 */
export async function convertGifToMp4(inputPath, outputPath, options = {}) {
  // scale=trunc(iw/2)*2:trunc(ih/2)*2 guarantees even dimensions required by H.264 yuv420p
  const filter = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

  await run(config.ffmpegPath, [
    '-y',
    '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'fast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ], 3 * 60 * 1000, options.signal);

  if (!fs.existsSync(outputPath)) {
    throw new Error('GIF to MP4 conversion failed: output file not created');
  }

  return outputPath;
}

/**
 * Dual-Format Adaptive Pipeline:
 *  - Creates/maintains both MP4 and GIF representations in top quality.
 *  - Checks whether the GIF fits within Discord's upload limit (`config.maxFileSizeBytes`).
 *  - If GIF fits: selects GIF as primary upload candidate.
 *  - If GIF is too large: switches to MP4 for Discord upload to avoid sacrificing quality or failing the upload.
 *  - Prepares companion files so the permanent local archive retains both formats.
 *
 * @param {string} filePath - Path to original downloaded media file
 * @param {string} tempDir - Temp working directory for companion files
 * @param {object} [options]
 * @returns {Promise<{ primaryFile: string, companionFiles: string[], isGif: boolean, isDualFormat: boolean, usedFallback: boolean }>}
 */
export async function processDualFormatMedia(filePath, tempDir, options = {}) {
  const candidate = await isGifCandidate(filePath, options.metadata);

  if (!candidate.isCandidate) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return {
      primaryFile: filePath,
      companionFiles: [],
      isGif: ext === 'gif',
      isDualFormat: false,
      usedFallback: false,
    };
  }

  const baseName = path.basename(filePath, path.extname(filePath));

  // Case A: Candidate is a video (short video with no audio, or platform MP4 of an original GIF)
  if (candidate.format === 'video') {
    const targetGifPath = path.join(tempDir, `${baseName}.gif`);
    try {
      console.log(`[GIF Pipeline] 🎨 Generating full-fidelity GIF for "${baseName}"...`);
      await generateHighQualityGif(filePath, targetGifPath, { fps: candidate.probe?.fps, signal: options.signal });

      const gifStat = await fs.promises.stat(targetGifPath);
      const gifSizeMB = (gifStat.size / (1024 * 1024)).toFixed(2);
      const discordLimitMB = (config.maxFileSizeBytes / (1024 * 1024)).toFixed(1);

      if (gifStat.size <= config.maxFileSizeBytes) {
        console.log(`[GIF Pipeline] ✨ Full-fidelity GIF (${gifSizeMB} MB) fits Discord limit (${discordLimitMB} MB). Uploading as native GIF.`);
        return {
          primaryFile: targetGifPath,
          companionFiles: config.archiveBothFormats ? [filePath] : [],
          isGif: true,
          isDualFormat: true,
          usedFallback: false,
        };
      }

      // Over Discord size limit: do NOT degrade or crush the GIF!
      // Switch to the MP4 file for Discord upload while keeping the high-quality GIF in the local archive.
      console.log(
        `[GIF Pipeline] ⚡ Full-fidelity GIF (${gifSizeMB} MB) exceeds Discord upload limit (${discordLimitMB} MB). Automatically switching to MP4 for Discord delivery while keeping both formats in local archive.`
      );
      return {
        primaryFile: filePath,
        companionFiles: config.archiveBothFormats ? [targetGifPath] : [],
        isGif: false,
        isDualFormat: true,
        usedFallback: true,
      };
    } catch (err) {
      if (isAbortError(err) || options.signal?.aborted) throw err;
      console.warn(`[GIF Pipeline] GIF generation failed (${err.message}). Retaining original video.`);
      return {
        primaryFile: filePath,
        companionFiles: [],
        isGif: false,
        isDualFormat: false,
        usedFallback: false,
      };
    }
  }

  // Case B: Candidate is an original .gif file
  if (candidate.format === 'gif') {
    const gifStat = await fs.promises.stat(filePath).catch(() => null);
    const gifSize = gifStat ? gifStat.size : 0;
    const gifSizeMB = (gifSize / (1024 * 1024)).toFixed(2);
    const discordLimitMB = (config.maxFileSizeBytes / (1024 * 1024)).toFixed(1);

    if (gifSize <= config.maxFileSizeBytes) {
      // If archiving both formats is desired, we can generate a companion MP4
      let companionFiles = [];
      if (config.archiveBothFormats) {
        try {
          const targetMp4Path = path.join(tempDir, `${baseName}.mp4`);
          await convertGifToMp4(filePath, targetMp4Path, { signal: options.signal });
          companionFiles = [targetMp4Path];
        } catch (err) {
          if (isAbortError(err) || options.signal?.aborted) throw err;
        }
      }

      return {
        primaryFile: filePath,
        companionFiles,
        isGif: true,
        isDualFormat: companionFiles.length > 0,
        usedFallback: false,
      };
    }

    // Original GIF exceeds Discord limit: convert to pristine MP4 for Discord upload to avoid rejection
    try {
      console.log(
        `[GIF Pipeline] ⚡ Original GIF (${gifSizeMB} MB) exceeds Discord limit (${discordLimitMB} MB). Converting to near-lossless MP4 for Discord delivery while preserving original untouched GIF for local PC archive.`
      );
      const targetMp4Path = path.join(tempDir, `${baseName}.mp4`);
      await convertGifToMp4(filePath, targetMp4Path, { signal: options.signal });

      return {
        primaryFile: targetMp4Path,
        companionFiles: config.archiveBothFormats ? [filePath] : [],
        isGif: false,
        isDualFormat: true,
        usedFallback: true,
      };
    } catch (err) {
      if (isAbortError(err) || options.signal?.aborted) throw err;
      console.warn(`[GIF Pipeline] GIF-to-MP4 conversion failed (${err.message}). Uploading original GIF.`);
      return {
        primaryFile: filePath,
        companionFiles: [],
        isGif: true,
        isDualFormat: false,
        usedFallback: false,
      };
    }
  }

  return {
    primaryFile: filePath,
    companionFiles: [],
    isGif: false,
    isDualFormat: false,
    usedFallback: false,
  };
}
