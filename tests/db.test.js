import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initLinkDb, closeLinkDb, getDb } from '../src/linkDb.js';
import { saveRecord, saveRecordBatch, findDuplicate, findDuplicateByUrl, ensureMediaStmts, getTotalArchiveSize } from '../src/db.js';
import { matchDuplicate, hammingDistance } from '../src/phasher.js';

describe('DB & Phasher Cascading Deduplication (clean-room verification)', () => {
  before(() => {
    closeLinkDb();
    initLinkDb(':memory:');
    ensureMediaStmts();
  });

  after(() => {
    closeLinkDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM media_records;');
    db.exec('DELETE FROM posted_links;');
  });

  describe('Cascading Multi-Factor Filter (Tiers 1–4)', () => {
    it('Tier 1: Matches duplicate immediately via Platform Media ID with score 0', async () => {
      await saveRecord({
        mediaId: 'yt-dQw4w9WgXcQ',
        originalUrl: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Rick Astley',
        channel: 'music',
        fileName: 'rick.mp4',
        relativePath: 'music/2026-11/rick.mp4',
        fileSize: 1048576,
      });

      const candidate = {
        mediaId: 'yt-dQw4w9WgXcQ',
        sha256: 'unmatched-sha',
        duration: 212,
        hash: '1111222233334444',
      };

      const result = await findDuplicate(candidate);
      assert.ok(result.match, 'Should find existing record by mediaId');
      assert.strictEqual(result.distance, 0);
      assert.ok(result.reason.includes('Platform Media ID'));
    });

    it('Matches duplicate for signed direct CDN URL despite trailing backslash', async () => {
      await saveRecord({
        mediaId: null,
        sha256: 'signed-cdn-sha256',
        originalUrl: 'https://cdn.example.com/art.png?Signature=abc&Expires=999',
        title: 'Direct Art',
        channel: 'art',
        fileName: 'art.png',
      });

      const duplicate = await findDuplicateByUrl('https://cdn.example.com/art.png?Signature=abc&Expires=999\\');
      assert.ok(duplicate, 'Should find duplicate for signed direct CDN URL with trailing backslash');
      assert.strictEqual(duplicate.fileName, 'art.png');
    });

    it('Tier 2: Matches duplicate via SHA-256 byte digest when mediaId is absent', async () => {
      const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      await saveRecord({
        sha256: sha,
        originalUrl: 'https://cdn.example.com/art.png',
        title: 'Art',
        channel: 'art',
        fileName: 'art.png',
        relativePath: 'art/2026-11/art.png',
        fileSize: 4096,
      });

      const candidate = {
        mediaId: null,
        sha256: sha,
        duration: 0,
        hash: 'ffff0000ffff0000',
      };

      const result = await findDuplicate(candidate);
      assert.ok(result.match, 'Should find existing record by SHA-256');
      assert.strictEqual(result.distance, 0);
      assert.ok(result.reason.includes('SHA-256'));
    });

    it('Tier 3: Duration gate rejects candidates differing by > 1.5s despite matching visual hashes', () => {
      const candidate = {
        duration: 10.0,
        hash: '1234567890abcdef',
      };
      const record = {
        duration: 12.0, // difference = 2.0s > 1.5s tolerance
        hash: '1234567890abcdef',
      };

      const matchResult = matchDuplicate(candidate, record, 5);
      assert.strictEqual(matchResult.isDuplicate, false);
      assert.strictEqual(matchResult.reason, 'Duration mismatch');

      // But within tolerance (<= 1.5s), comparison proceeds to perceptual hash
      const closeRecord = {
        duration: 11.2, // difference = 1.2s <= 1.5s tolerance
        hash: '1234567890abcdef',
      };
      const closeResult = matchDuplicate(candidate, closeRecord, 5);
      assert.strictEqual(closeResult.isDuplicate, true);
    });

    it('Tier 4: Rejects corrupted/blank flat hashes (0000000000000000 & ffffffffffffffff)', () => {
      const distZero = hammingDistance('0000000000000000', '0000000000000000');
      assert.strictEqual(distZero, Infinity, 'Flat 0000000000000000 distance must be Infinity');

      const distFull = hammingDistance('ffffffffffffffff', 'ffffffffffffffff');
      assert.strictEqual(distFull, Infinity, 'Flat ffffffffffffffff distance must be Infinity');

      const matchRes = matchDuplicate(
        { hash: '0000000000000000' },
        { hash: '0000000000000000' }
      );
      assert.strictEqual(matchRes.isDuplicate, false);
    });
  });

  describe('Persistence of relative_path, file_size & O(1) Archive Size', () => {
    it('persists and retrieves relative_path and file_size in media_records and sums via SQL', async () => {
      await saveRecordBatch([
        {
          originalUrl: 'https://example.com/video.mp4',
          title: 'Sample Video',
          channel: 'videos',
          fileName: 'video.mp4',
          relativePath: 'videos/2026-11/video.mp4',
          fileSize: 5242880,
        },
        {
          originalUrl: 'https://example.com/audio.mp3',
          title: 'Sample Audio',
          channel: 'music',
          fileName: 'audio.mp3',
          relativePath: 'music/2026-11/audio.mp3',
          fileSize: 1048576,
        },
      ]);

      const db = getDb();
      const row = db.prepare('SELECT relative_path, file_size FROM media_records WHERE file_name = ?').get('video.mp4');

      assert.ok(row, 'Row must exist');
      assert.strictEqual(row.relative_path, 'videos/2026-11/video.mp4');
      assert.strictEqual(row.file_size, 5242880);

      const urlLookup = await findDuplicateByUrl('https://example.com/video.mp4');
      assert.strictEqual(urlLookup?.relativePath, 'videos/2026-11/video.mp4');
      assert.strictEqual(urlLookup?.fileSize, 5242880);

      const totalBytes = await getTotalArchiveSize(true);
      assert.strictEqual(totalBytes, 5242880 + 1048576);
    });
  });

  describe('Re-Initialization & Prepared Statements Safety (ORA-A1 / ORA-B2)', () => {
    it('safely re-attaches media statements when database is closed and re-opened in memory', async () => {
      // Step 1: Initialize, save, and query
      await saveRecord({
        mediaId: 'reinit-test-1',
        originalUrl: 'https://example.com/1',
        title: 'Post 1',
        fileName: 'p1.mp4',
      });

      // Step 2: Close database completely
      closeLinkDb();

      // Step 3: Re-open in memory (as happens between independent test files)
      initLinkDb(':memory:');
      ensureMediaStmts();

      // Step 4: Verify querying new DB does NOT throw TypeError
      const found = await findDuplicate({ mediaId: 'reinit-test-1' });
      assert.strictEqual(found.match, null, 'New memory DB should be empty');
    });
  });
});
