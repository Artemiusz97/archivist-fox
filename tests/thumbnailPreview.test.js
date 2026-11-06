import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findThumbnailFile } from '../src/thumbnailPreview.js';

describe('thumbnailPreview', () => {
  it('finds existing thumbnail matching video filename', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'thumb-test-'));
    const videoFile = path.join(tempDir, 'sample_video.mp4');
    const thumbFile = path.join(tempDir, 'sample_video.jpg');

    await fs.promises.writeFile(videoFile, 'fake video content');
    await fs.promises.writeFile(thumbFile, 'fake image content');

    try {
      const found = await findThumbnailFile(videoFile, tempDir);
      assert.strictEqual(found, thumbFile);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('exports valid function interfaces', () => {
    assert.strictEqual(typeof findThumbnailFile, 'function');
  });
});
