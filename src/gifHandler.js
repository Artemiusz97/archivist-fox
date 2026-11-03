import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { isAbortError, isVideo, probeMedia, runProcess } from './utils.js';

/**
 * Probes media file duration, dimensions, framerate, and audio presence using ffprobe.
 * Strictly ignores embedded cover art (`disposition.attached_pic === 1`) so MP3s
 * with album art are never treated as video files.
 *
 * @param {string} filePath
 * @returns {Promise<{ duration: number, hasAudio: boolean, hasVideo: boolean, codec: string, width: number, height: number, fps: number }>}
 */
export async function probeMediaForGif(filePath) {
  const p = await probeMedia(filePath);
  return {
    duration: p.duration,
    hasAudio: p.hasAudio,
    hasVideo: p.hasVideo,
    codec: p.videoCodec || '',
    width: p.width,
    height: p.height,
    fps: p.fps || 30,
  };
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
  if (isVideo(filePath)) {
    const probe = await probeMediaForGif(filePath);
    if (!probe.hasAudio && probe.hasVideo && probe.duration > 0 && probe.duration <= config.gifMaxDurationSeconds) {
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
 */
export async function generateHighQualityGif(inputPath, outputPath, options = {}) {
  const sourceFps = options.fps || 30;
  const targetFps = Math.min(config.gifMaxFps || 30, Math.max(10, Math.round(sourceFps)));

  const filter = `[0:v]fps=${targetFps},split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;

  await runProcess(
    config.ffmpegPath,
    ['-y', '-i', inputPath, '-filter_complex', filter, outputPath],
    { timeoutMs: 3 * 60 * 1000, signal: options.signal }
  );

  if (!fs.existsSync(outputPath)) {
    throw new Error('GIF generation failed: output file not created');
  }

  return outputPath;
}

/**
 * Converts an oversized GIF to a near-lossless MP4 (CRF 18) for Discord delivery
 * when the original or generated GIF exceeds Discord's file size limit.
 */
export async function convertGifToMp4(inputPath, outputPath, options = {}) {
  const filter = 'scale=max(2\\,trunc(iw/2)*2):max(2\\,trunc(ih/2)*2)';

  await runProcess(
    config.ffmpegPath,
    [
      '-y',
      '-i', inputPath,
      '-vf', filter,
      '-c:v', 'libx264',
      '-crf', '18',
      '-preset', 'fast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath,
    ],
    { timeoutMs: 3 * 60 * 1000, signal: options.signal }
  );

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
 *  - If GIF is too large: switches to MP4 for Discord upload while keeping both formats in local archive.
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
