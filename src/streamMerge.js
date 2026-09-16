import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { run } from './compress.js';

/**
 * Some sites (notably Reddit) serve video and audio as separate streams.
 * yt-dlp is supposed to merge these into one file via ffmpeg, but if ffmpeg
 * isn't detected on the system, yt-dlp silently falls back to leaving both
 * files un-merged rather than erroring — which is confusing (you get two
 * "video" attachments, one silent).
 *
 * This is a safety net that runs after any yt-dlp download: if we see
 * exactly one video-only file and one audio-only file, mux them into a
 * single file ourselves. If ffmpeg/ffprobe aren't available, this quietly
 * no-ops and returns the original file list unchanged.
 */
export async function mergeOrphanedAudioVideo(files, destDir) {
  if (files.length < 2) return files;

  const classified = [];
  const otherFiles = [];
  for (const file of files) {
    const kind = await classifyStreams(file);
    if (!kind) {
      otherFiles.push(file);
    } else {
      classified.push({ file, ...kind });
    }
  }

  const videoOnly = classified.filter((c) => c.hasVideo && !c.hasAudio);
  const audioOnly = classified.filter((c) => c.hasAudio && !c.hasVideo);

  if (videoOnly.length !== 1 || audioOnly.length !== 1) {
    return files; // not the simple orphaned-pair case; leave as-is
  }

  const originalBase = path.basename(videoOnly[0].file, path.extname(videoOnly[0].file));
  const finalMergedPath = path.join(destDir, `${originalBase}.mp4`);
  const tempMergedPath = path.join(destDir, `tmp_mux_${Date.now()}.mp4`);
  try {
    await run(config.ffmpegPath, [
      '-y',
      '-i', videoOnly[0].file,
      '-i', audioOnly[0].file,
      '-c', 'copy',
      // Move MP4 moov atom to front of file for instant Discord streaming playback.
      '-movflags', '+faststart',
      tempMergedPath,
    ]);
    await fs.promises.unlink(videoOnly[0].file).catch(() => {});
    await fs.promises.unlink(audioOnly[0].file).catch(() => {});
    await fs.promises.rename(tempMergedPath, finalMergedPath);
    return [finalMergedPath, ...otherFiles];
  } catch {
    await fs.promises.unlink(tempMergedPath).catch(() => {});
    // Couldn't mux (e.g. incompatible codecs) — fall back to sending both
    // files separately rather than failing the whole thing.
    return files;
  }
}

async function classifyStreams(filePath) {
  try {
    const { stdout } = await run(config.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ]);
    const types = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (types.length === 0) return null; // not a media file ffprobe understands (e.g. a plain image)
    return {
      hasVideo: types.includes('video'),
      hasAudio: types.includes('audio'),
    };
  } catch {
    return null; // ffprobe missing or file unreadable — caller will bail out
  }
}
