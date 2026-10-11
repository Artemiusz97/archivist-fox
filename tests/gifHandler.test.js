import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  probeMediaForGif,
  isGifCandidate,
  generateHighQualityGif,
  convertGifToMp4,
  processDualFormatMedia,
} from '../src/gifHandler.js';
import { archiveLocalMedia } from '../src/archiver.js';
import { config } from '../src/config.js';

describe('gifHandler', () => {
  let tempDir;
  let originalEnableGif;
  let originalMaxDuration;
  let originalMaxFileSizeBytes;
  let originalArchiveBoth;
  let originalArchiveDir;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gif-handler-test-'));

    originalEnableGif = config.enableGifPipeline;
    originalMaxDuration = config.gifMaxDurationSeconds;
    originalMaxFileSizeBytes = config.maxFileSizeBytes;
    originalArchiveBoth = config.archiveBothFormats;
    originalArchiveDir = config.archiveDirectory;

    config.enableGifPipeline = true;
    config.gifMaxDurationSeconds = 6;
    config.maxFileSizeBytes = 10 * 1024 * 1024;
    config.archiveBothFormats = true;
    config.archiveDirectory = path.join(tempDir, 'archives');
  });

  afterEach(async () => {
    config.enableGifPipeline = originalEnableGif;
    config.gifMaxDurationSeconds = originalMaxDuration;
    config.maxFileSizeBytes = originalMaxFileSizeBytes;
    config.archiveBothFormats = originalArchiveBoth;
    config.archiveDirectory = originalArchiveDir;

    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function createTestVideo(outputPath, durationSeconds = 1, withAudio = false) {
    const args = [
      '-y',
      '-f', 'lavfi',
      '-i', `testsrc=duration=${durationSeconds}:size=160x120:rate=10`,
    ];
    if (withAudio) {
      args.push('-f', 'lavfi', '-i', `sine=frequency=1000:duration=${durationSeconds}`);
      args.push('-c:a', 'aac');
    }
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath);
    const res = spawnSync(config.ffmpegPath, args, { stdio: 'ignore' });
    if (res.status !== 0) {
      throw new Error(`Failed to create test video at ${outputPath}`);
    }
  }

  function createTestGif(outputPath, durationSeconds = 1) {
    const args = [
      '-y',
      '-f', 'lavfi',
      '-i', `testsrc=duration=${durationSeconds}:size=160x120:rate=10`,
      outputPath,
    ];
    const res = spawnSync(config.ffmpegPath, args, { stdio: 'ignore' });
    if (res.status !== 0) {
      throw new Error(`Failed to create test gif at ${outputPath}`);
    }
  }

  it('probes media accurately for duration, streams, and audio presence', async () => {
    const silentVideo = path.join(tempDir, 'silent.mp4');
    createTestVideo(silentVideo, 2, false);

    const probe = await probeMediaForGif(silentVideo);
    assert.strictEqual(probe.hasVideo, true);
    assert.strictEqual(probe.hasAudio, false);
    assert.ok(probe.duration >= 1.5 && probe.duration <= 2.5);
    assert.strictEqual(probe.width, 160);
    assert.strictEqual(probe.height, 120);

    const audioVideo = path.join(tempDir, 'audio.mp4');
    createTestVideo(audioVideo, 1, true);
    const audioProbe = await probeMediaForGif(audioVideo);
    assert.strictEqual(audioProbe.hasAudio, true);
  });

  it('identifies short silent videos and original gifs as candidates', async () => {
    const silentVideo = path.join(tempDir, 'short_silent.mp4');
    createTestVideo(silentVideo, 3, false);

    const candidate = await isGifCandidate(silentVideo);
    assert.strictEqual(candidate.isCandidate, true);
    assert.strictEqual(candidate.isOriginalGif, false);
    assert.strictEqual(candidate.format, 'video');

    const gifFile = path.join(tempDir, 'anim.gif');
    createTestGif(gifFile, 1);

    const gifCandidate = await isGifCandidate(gifFile);
    assert.strictEqual(gifCandidate.isCandidate, true);
    assert.strictEqual(gifCandidate.isOriginalGif, true);
    assert.strictEqual(gifCandidate.format, 'gif');
  });

  it('rejects videos that exceed max duration or contain audio', async () => {
    const longVideo = path.join(tempDir, 'long_silent.mp4');
    createTestVideo(longVideo, 8, false);

    const longCandidate = await isGifCandidate(longVideo);
    assert.strictEqual(longCandidate.isCandidate, false);

    const audioVideo = path.join(tempDir, 'short_audio.mp4');
    createTestVideo(audioVideo, 2, true);

    const audioCandidate = await isGifCandidate(audioVideo);
    assert.strictEqual(audioCandidate.isCandidate, false);
  });

  it('generates high quality gif from mp4 and converts gif to mp4', async () => {
    const video = path.join(tempDir, 'input.mp4');
    createTestVideo(video, 1, false);

    const outputGif = path.join(tempDir, 'output.gif');
    await generateHighQualityGif(video, outputGif, { fps: 10 });
    assert.strictEqual(fs.existsSync(outputGif), true);
    const gifStat = await fs.promises.stat(outputGif);
    assert.ok(gifStat.size > 0);

    const convertedMp4 = path.join(tempDir, 'converted.mp4');
    await convertGifToMp4(outputGif, convertedMp4);
    assert.strictEqual(fs.existsSync(convertedMp4), true);
    const mp4Stat = await fs.promises.stat(convertedMp4);
    assert.ok(mp4Stat.size > 0);
  });

  it('uploads gif when within discord limit and saves mp4 companion', async () => {
    const video = path.join(tempDir, 'clip.mp4');
    createTestVideo(video, 1, false);

    config.maxFileSizeBytes = 10 * 1024 * 1024; // 10 MB limit
    const result = await processDualFormatMedia(video, tempDir);

    assert.strictEqual(result.isGif, true);
    assert.strictEqual(path.extname(result.primaryFile).toLowerCase(), '.gif');
    assert.strictEqual(result.usedFallback, false);
    assert.strictEqual(result.companionFiles.length, 1);
    assert.strictEqual(result.companionFiles[0], video);
  });

  it('switches to mp4 upload when gif exceeds discord limit without sacrificing quality', async () => {
    const video = path.join(tempDir, 'clip.mp4');
    createTestVideo(video, 1, false);

    // Set an artificially tiny Discord limit (e.g. 100 bytes) so the GIF exceeds it
    config.maxFileSizeBytes = 100;
    const result = await processDualFormatMedia(video, tempDir);

    assert.strictEqual(result.isGif, false);
    assert.strictEqual(result.primaryFile, video);
    assert.strictEqual(result.usedFallback, true);
    // The high quality GIF is preserved as a companion file for local archiving!
    assert.strictEqual(result.companionFiles.length, 1);
    assert.strictEqual(path.extname(result.companionFiles[0]).toLowerCase(), '.gif');
  });

  it('archives both formats to local PC archive with metadata sidecar', async () => {
    const video = path.join(tempDir, 'source.mp4');
    createTestVideo(video, 1, false);

    const companionGif = path.join(tempDir, 'source.gif');
    createTestGif(companionGif, 1);

    const context = {
      channel: 'memes',
      title: 'Funny Meme',
      companionFiles: [companionGif],
    };

    const archivedPath = await archiveLocalMedia(video, context);
    assert.ok(archivedPath);

    const archiveDir = path.dirname(archivedPath);
    const archivedGif = path.join(archiveDir, 'source.gif');
    assert.strictEqual(fs.existsSync(archivedGif), true);

    const metaPath = `${archivedPath}.json`;
    assert.strictEqual(fs.existsSync(metaPath), true);
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    assert.ok(Array.isArray(meta.companionFiles));
    assert.ok(meta.companionFiles.includes('source.gif'));
  });
});
