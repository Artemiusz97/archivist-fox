import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { archiveLocalMedia } from '../src/archiver.js';
import { config } from '../src/config.js';

describe('archiver', () => {
  let tempArchiveDir;
  let tempSourceDir;
  let originalArchiveDir;
  let originalEnableArchive;
  let originalSaveMetadata;
  let originalSubfolderFormat;

  beforeEach(async () => {
    tempArchiveDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archiver-test-archive-'));
    tempSourceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archiver-test-source-'));

    originalArchiveDir = config.archiveDirectory;
    originalEnableArchive = config.enableLocalArchive;
    originalSaveMetadata = config.archiveSaveMetadata;
    originalSubfolderFormat = config.archiveSubfolderFormat;

    config.archiveDirectory = tempArchiveDir;
    config.enableLocalArchive = true;
    config.archiveSaveMetadata = true;
    config.archiveSubfolderFormat = 'channel';
  });

  afterEach(async () => {
    config.archiveDirectory = originalArchiveDir;
    config.enableLocalArchive = originalEnableArchive;
    config.archiveSaveMetadata = originalSaveMetadata;
    config.archiveSubfolderFormat = originalSubfolderFormat;

    await fs.promises.rm(tempArchiveDir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(tempSourceDir, { recursive: true, force: true }).catch(() => {});
  });

  it('archives new media file and generates json metadata sidecar', async () => {
    const srcFile = path.join(tempSourceDir, 'test_song.mp4');
    await fs.promises.writeFile(srcFile, 'dummy video content 123');

    const context = {
      channel: 'music',
      title: 'Test Song',
      mediaId: 'youtube:12345',
      sha256: 'abc123hash',
      url: 'https://youtube.com/watch?v=12345',
      author: 'Tester',
    };

    const archivedPath = await archiveLocalMedia(srcFile, context);
    assert.ok(archivedPath);
    assert.strictEqual(fs.existsSync(archivedPath), true);
    assert.strictEqual(fs.existsSync(`${archivedPath}.json`), true);

    const meta = JSON.parse(await fs.promises.readFile(`${archivedPath}.json`, 'utf-8'));
    assert.strictEqual(meta.mediaId, 'youtube:12345');
    assert.strictEqual(meta.title, 'Test Song');
  });

  it('skips duplicate copying when identical media is archived again', async () => {
    const srcFile = path.join(tempSourceDir, 'test_song.mp4');
    await fs.promises.writeFile(srcFile, 'dummy video content 123');

    const context = {
      channel: 'music',
      title: 'Test Song',
      mediaId: 'youtube:12345',
      sha256: 'abc123hash',
      url: 'https://youtube.com/watch?v=12345',
      author: 'Tester',
    };

    const firstArchivedPath = await archiveLocalMedia(srcFile, context);
    const secondArchivedPath = await archiveLocalMedia(srcFile, context);

    // Both calls must return the same path without creating a second file with timestamp suffix
    assert.strictEqual(firstArchivedPath, secondArchivedPath);

    const channelDir = path.join(tempArchiveDir, 'music');
    const allFiles = await fs.promises.readdir(channelDir);
    const mediaFiles = allFiles.filter(f => !f.endsWith('.json'));

    assert.strictEqual(mediaFiles.length, 1);
    assert.strictEqual(mediaFiles[0], 'test_song.mp4');
  });

  it('appends timestamp suffix only for truly distinct media colliding on filename', async () => {
    const srcFile1 = path.join(tempSourceDir, 'video.mp4');
    await fs.promises.writeFile(srcFile1, 'video content A (short)');

    const context1 = {
      channel: 'general',
      title: 'Video',
      mediaId: 'youtube:AAA',
      sha256: 'hash_AAA',
    };

    const firstPath = await archiveLocalMedia(srcFile1, context1);

    const srcFile2 = path.join(tempSourceDir, 'video_distinct.mp4');
    // Different content and different size
    await fs.promises.writeFile(srcFile2, 'video content B (much longer content to differ in size)');

    const context2 = {
      channel: 'general',
      title: 'video', // will map to video.mp4 targetBasename
      mediaId: 'youtube:BBB',
      sha256: 'hash_BBB',
    };

    const secondPath = await archiveLocalMedia(srcFile2, context2);

    assert.notStrictEqual(firstPath, secondPath);
    assert.strictEqual(fs.existsSync(firstPath), true);
    assert.strictEqual(fs.existsSync(secondPath), true);

    const allFiles = await fs.promises.readdir(path.join(tempArchiveDir, 'general'));
    const mediaFiles = allFiles.filter(f => !f.endsWith('.json'));
    assert.strictEqual(mediaFiles.length, 2);
  });
});
