import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { probeMedia, runProcess } from './utils.js';

/**
 * Safety net that muxes orphaned single video-only + single audio-only files
 * (e.g. from Reddit DASH streams if yt-dlp couldn't merge) into one `.mp4`,
 * while preserving all other media/sidecar files in `files`.
 */
export async function mergeOrphanedAudioVideo(files, destDir, opts = {}) {
  if (!Array.isArray(files) || files.length < 2) return files;

  const probeMediaFn = opts.probeMedia || probeMedia;
  const runProcessFn = opts.runProcess || runProcess;

  const classified = [];
  const otherFiles = [];
  for (const file of files) {
    const kind = await classifyStreams(file, probeMediaFn);
    if (!kind) {
      otherFiles.push(file);
    } else {
      classified.push({ file, ...kind });
    }
  }

  const videoOnly = classified.filter((c) => c.hasVideo && !c.hasAudio);
  const audioOnly = classified.filter((c) => c.hasAudio && !c.hasVideo);

  if (videoOnly.length !== 1 || audioOnly.length !== 1) {
    return files;
  }

  const unmergedClassified = classified
    .filter((c) => c.file !== videoOnly[0].file && c.file !== audioOnly[0].file)
    .map((c) => c.file);

  const originalBase = path.basename(videoOnly[0].file, path.extname(videoOnly[0].file));
  const finalMergedPath = path.join(destDir, `${originalBase}.mp4`);
  const tempMergedPath = path.join(destDir, `tmp_mux_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`);
  try {
    await runProcessFn(config.ffmpegPath, [
      '-y',
      '-i', videoOnly[0].file,
      '-i', audioOnly[0].file,
      '-c', 'copy',
      '-movflags', '+faststart',
      tempMergedPath,
    ]);
    await fs.promises.unlink(videoOnly[0].file).catch(() => {});
    await fs.promises.unlink(audioOnly[0].file).catch(() => {});
    await fs.promises.unlink(finalMergedPath).catch(() => {});

    try {
      await fs.promises.rename(tempMergedPath, finalMergedPath);
    } catch (renameErr) {
      if (renameErr.code === 'EXDEV' || renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
        await fs.promises.copyFile(tempMergedPath, finalMergedPath);
        await fs.promises.unlink(tempMergedPath).catch(() => {});
      } else {
        throw renameErr;
      }
    }

    return [finalMergedPath, ...unmergedClassified, ...otherFiles];
  } catch {
    await fs.promises.unlink(tempMergedPath).catch(() => {});
    return files;
  }
}

async function classifyStreams(filePath, probeMediaFn = probeMedia) {
  try {
    const p = await probeMediaFn(filePath);
    if (!p.hasVideo && !p.hasAudio) return null;
    return {
      hasVideo: p.hasVideo,
      hasAudio: p.hasAudio,
    };
  } catch {
    return null;
  }
}
