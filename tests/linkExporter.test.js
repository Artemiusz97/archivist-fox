import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeFilename, exportLinks } from '../src/linkExporter.js';
import { initLinkDb, closeLinkDb, saveLinkRecordBatch, getDb } from '../src/linkDb.js';

describe('linkExporter', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-export-test-'));
    closeLinkDb();
    initLinkDb(':memory:');
  });

  after(() => {
    closeLinkDb();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('sanitizeFilename', () => {
    it('replaces filesystem reserved characters with underscores', () => {
      assert.strictEqual(sanitizeFilename('channel:name/with\\slashes*and?quotes"'), 'channel_name_with_slashes_and_quotes_');
      assert.strictEqual(sanitizeFilename('<test>|pipe'), '_test__pipe');
    });

    it('preserves clean unicode channel names', () => {
      assert.strictEqual(sanitizeFilename('art-gallery'), 'art-gallery');
      assert.strictEqual(sanitizeFilename('anime-art🗾'), 'anime-art🗾');
    });

    it('falls back to "channel" for empty or null inputs', () => {
      assert.strictEqual(sanitizeFilename(''), 'channel');
      assert.strictEqual(sanitizeFilename(null), 'channel');
      assert.strictEqual(sanitizeFilename('   '), 'channel');
    });
  });

  describe('exportLinks', () => {
    it('returns empty result when no links exist', async () => {
      const res = await exportLinks({ outputDir: tmpDir });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.totalLinks, 0);
    });

    it('successfully exports links to JSON, Markdown, and CSV', async () => {
      saveLinkRecordBatch([
        {
          normalized_url: 'https://twitter.com/artist/status/111',
          original_url: 'https://twitter.com/artist/status/111?s=20',
          channel_name: 'art-feed',
          channel_id: 'chan-1',
          message_id: 'msg-1',
          author_id: 'user-1',
          author_tag: 'Artist#0001',
          posted_at: Date.now(),
          content: 'Here is some art',
        },
        {
          normalized_url: 'https://youtube.com/watch?v=222',
          original_url: 'https://youtu.be/222',
          channel_name: 'music',
          channel_id: 'chan-2',
          message_id: 'msg-2',
          author_id: 'user-2',
          author_tag: 'Musician#0002',
          posted_at: Date.now(),
          content: 'Great song',
        },
      ]);

      const res = await exportLinks({ outputDir: tmpDir, format: 'all' });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.totalLinks, 2);
      assert.strictEqual(res.channelsExported.length, 2);
      assert.ok(res.files.length >= 6); // 2 channels * 3 formats + master json

      // Verify master JSON file
      assert.ok(res.masterJsonPath);
      assert.ok(fs.existsSync(res.masterJsonPath));
      const masterContent = JSON.parse(fs.readFileSync(res.masterJsonPath, 'utf8'));
      assert.strictEqual(masterContent.total_links, 2);
      assert.ok(masterContent.channels['art-feed']);
      assert.ok(masterContent.channels['music']);
    });
  });
});
