import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downloadWithGalleryDl } from '../src/galleryDlDownloader.js';

describe('galleryDlDownloader', () => {
  it('exports downloadWithGalleryDl as a function', () => {
    assert.strictEqual(typeof downloadWithGalleryDl, 'function');
  });

  it('rejects with DOWNLOAD_ABORTED when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      async () => {
        await downloadWithGalleryDl('https://example.com/test.jpg', './temp', {
          signal: controller.signal,
        });
      },
      { message: 'DOWNLOAD_ABORTED' }
    );
  });
});
