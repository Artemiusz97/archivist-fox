import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getBestVideoEncoder, ensureWithinLimit } from '../src/compress.js';

describe('compress', () => {
  it('detects a valid video encoder string', async () => {
    const encoder = await getBestVideoEncoder();
    assert.strictEqual(typeof encoder, 'string');
    assert.ok(['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(encoder));
  });

  it('returns original file immediately if under maxFileSizeBytes', async () => {
    const tempFile = path.join(os.tmpdir(), `test-compress-small-${Date.now()}.txt`);
    await fs.promises.writeFile(tempFile, 'small content', 'utf-8');
    try {
      const result = await ensureWithinLimit(tempFile, null);
      assert.strictEqual(result, tempFile);
    } finally {
      await fs.promises.unlink(tempFile).catch(() => {});
    }
  });
});
