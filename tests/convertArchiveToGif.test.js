import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { walkDirectory, convertArchiveToGifs } from '../scripts/convert_archive_to_gif.js';
import { config } from '../src/config.js';

describe('convertArchiveToGifs script', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archive-gif-test-'));
  });

  afterEach(async () => {
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

  it('walkDirectory discovers video files recursively and ignores non-videos', async () => {
    const subDir = path.join(tempDir, 'subfolder');
    await fs.promises.mkdir(subDir, { recursive: true });

    await fs.promises.writeFile(path.join(tempDir, 'text.txt'), 'hello');
    await fs.promises.writeFile(path.join(tempDir, 'image.jpg'), 'fake img');

    const vid1 = path.join(tempDir, 'video1.mp4');
    const vid2 = path.join(subDir, 'video2.mkv');
    createTestVideo(vid1, 1, false);
    createTestVideo(vid2, 1, false);

    const found = await walkDirectory(tempDir);
    assert.strictEqual(found.length, 2);
    assert.ok(found.includes(vid1));
    assert.ok(found.includes(vid2));
  });

  it('identifies candidates in dryRun without writing gif files', async () => {
    const vid = path.join(tempDir, 'short_silent.mp4');
    createTestVideo(vid, 2, false);

    const stats = await convertArchiveToGifs({
      targetDir: tempDir,
      maxDuration: 6,
      dryRun: true,
    });

    assert.strictEqual(stats.totalScanned, 1);
    assert.strictEqual(stats.candidates, 1);
    assert.strictEqual(stats.converted, 0);

    const expectedGif = path.join(tempDir, 'short_silent.gif');
    assert.strictEqual(fs.existsSync(expectedGif), false);
  });

  it('converts short silent video to gif in live mode and updates json sidecar', async () => {
    const vid = path.join(tempDir, 'silent_clip.mp4');
    createTestVideo(vid, 1, false);

    const sidecarPath = `${vid}.json`;
    await fs.promises.writeFile(
      sidecarPath,
      JSON.stringify({ title: 'Silent Clip', author: 'tester' }, null, 2),
      'utf8'
    );

    const stats = await convertArchiveToGifs({
      targetDir: tempDir,
      maxDuration: 6,
      dryRun: false,
    });

    assert.strictEqual(stats.totalScanned, 1);
    assert.strictEqual(stats.candidates, 1);
    assert.strictEqual(stats.converted, 1);

    const expectedGif = path.join(tempDir, 'silent_clip.gif');
    assert.strictEqual(fs.existsSync(expectedGif), true);

    const updatedMeta = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8'));
    assert.ok(Array.isArray(updatedMeta.companionFiles));
    assert.ok(updatedMeta.companionFiles.includes('silent_clip.gif'));
  });

  it('filters out videos with audio and videos exceeding maxDuration', async () => {
    const audioVid = path.join(tempDir, 'has_audio.mp4');
    createTestVideo(audioVid, 1, true);

    const longVid = path.join(tempDir, 'too_long.mp4');
    createTestVideo(longVid, 8, false);

    const stats = await convertArchiveToGifs({
      targetDir: tempDir,
      maxDuration: 6,
      dryRun: false,
    });

    assert.strictEqual(stats.totalScanned, 2);
    assert.strictEqual(stats.candidates, 0);
    assert.strictEqual(stats.ineligibleAudio, 1);
    assert.strictEqual(stats.ineligibleLong, 1);
    assert.strictEqual(stats.converted, 0);
  });

  it('skips already converted gifs unless force is true', async () => {
    const vid = path.join(tempDir, 'clip.mp4');
    createTestVideo(vid, 1, false);

    const gif = path.join(tempDir, 'clip.gif');
    await fs.promises.writeFile(gif, 'dummy gif');

    // First run with force: false
    const stats1 = await convertArchiveToGifs({
      targetDir: tempDir,
      maxDuration: 6,
      dryRun: false,
      force: false,
    });

    assert.strictEqual(stats1.alreadyConverted, 1);
    assert.strictEqual(stats1.converted, 0);

    // Second run with force: true
    const stats2 = await convertArchiveToGifs({
      targetDir: tempDir,
      maxDuration: 6,
      dryRun: false,
      force: true,
    });

    assert.strictEqual(stats2.alreadyConverted, 0);
    assert.strictEqual(stats2.converted, 1);
  });
});
