import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { withConfigOverrides } from '../src/config.js';
import { initLinkDb, closeLinkDb, getDb } from '../src/linkDb.js';
import { parseRescanArgs, getScannableChannels, formatStopSummary } from '../src/scanner.js';

describe('Scanner Test Suite (clean-room verification)', () => {
  before(() => {
    closeLinkDb();
    initLinkDb(':memory:');
  });

  after(() => {
    closeLinkDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM posted_links;');
    db.exec('DELETE FROM media_records;');
  });

  describe('parseRescanArgs', () => {
    it('parses default rescan arguments on current channel', () => {
      const res = parseRescanArgs('!rescan', { id: 'chan-1', name: 'general' });
      assert.strictEqual(res.target, 'current');
      assert.strictEqual(res.limit, Infinity);
      assert.strictEqual(res.upload, false);
      assert.strictEqual(res.force, false);
      assert.strictEqual(res.repostMissing, false);
      assert.strictEqual(res.concurrency, null);
    });

    it('parses numeric message limit correctly', () => {
      const res = parseRescanArgs('!rescan 50', { id: 'chan-1' });
      assert.strictEqual(res.limit, 50);
      assert.strictEqual(res.target, 'current');
    });

    it('parses Discord channel mentions and snowflake IDs as targets', () => {
      const mentionRes = parseRescanArgs('!rescan <#123456789012345678>', { id: 'chan-1' });
      assert.strictEqual(mentionRes.target, '123456789012345678');

      const snowflakeRes = parseRescanArgs('!rescan 987654321098765432', { id: 'chan-1' });
      assert.strictEqual(snowflakeRes.target, '987654321098765432');
    });

    it('parses "all", --upload, --force, and --concurrency flags', () => {
      const res = parseRescanArgs('!rescan all --upload --force -c 4', { id: 'chan-1' });
      assert.strictEqual(res.target, 'all');
      assert.strictEqual(res.upload, true);
      assert.strictEqual(res.force, true);
      assert.strictEqual(res.concurrency, 4);
    });

    it('defaults repostMissing to true for !repost-missing and !fix-missing commands', () => {
      const res1 = parseRescanArgs('!repost-missing 25', { id: 'chan-1' });
      assert.strictEqual(res1.repostMissing, true);
      assert.strictEqual(res1.limit, 25);

      const res2 = parseRescanArgs('!fix-missing #media', { id: 'chan-1' });
      assert.strictEqual(res2.repostMissing, true);
      assert.strictEqual(res2.target, '#media');
    });
  });

  describe('getScannableChannels', () => {
    it('preserves LINK_BACKUP_CHANNELS when ALLOWED_CHANNEL_IDS whitelist is active', async () => {
      const allowedId = '111111111111111111';
      const backupId = '222222222222222222';

      const mockChannels = new Map([
        [
          allowedId,
          {
            id: allowedId,
            name: 'media-channel',
            type: ChannelType.GuildText,
            viewable: true,
            guild: { id: 'g1' },
            permissionsFor: () => ({ has: () => true }),
          },
        ],
        [
          backupId,
          {
            id: backupId,
            name: 'resources-backup',
            type: ChannelType.GuildText,
            viewable: true,
            guild: { id: 'g1' },
            permissionsFor: () => ({ has: () => true }),
          },
        ],
      ]);

      const mockClient = {
        channels: {
          fetch: async (id) => mockChannels.get(id) || null,
        },
        guilds: {
          cache: new Map([
            [
              'g1',
              {
                id: 'g1',
                channels: { fetch: async () => mockChannels },
                members: { me: { permissions: { has: () => true } } },
              },
            ],
          ]),
        },
      };

      await withConfigOverrides(
        {
          allowedChannelIds: [allowedId],
          linkBackupChannels: [backupId],
        },
        async () => {
          const scannable = await getScannableChannels(mockClient);
          const scannableIds = scannable.map((c) => c.id);

          assert.ok(scannableIds.includes(allowedId), 'Allowed media channel must be present');
          assert.ok(scannableIds.includes(backupId), 'Link backup channel must NOT be filtered out by media whitelist');
        }
      );
    });
  });

  describe('formatStopSummary', () => {
    it('returns idle message when no active tasks were running', () => {
      const summary = formatStopSummary({
        scanRunning: false,
        playlistRunning: false,
        restoreRunning: false,
        queueItemsCleared: 0,
        activeDownloadsStopped: 0,
      });

      const text = typeof summary === 'string' ? summary : summary?.message || '';
      assert.strictEqual(summary.hasActiveTasks, false);
      assert.ok(text.includes('No active downloads') || text.includes('no active'), 'Should report idle state');
    });

    it('summarizes stopped rescans and aborted downloads', () => {
      const summary = formatStopSummary({
        scanRunning: true,
        playlistRunning: false,
        restoreRunning: false,
        queueItemsCleared: 2,
        activeDownloadsStopped: 3,
      });

      const text = typeof summary === 'string' ? summary : summary?.message || '';
      assert.strictEqual(summary.hasActiveTasks, true);
      assert.ok(text.includes('rescan') || text.includes('crawl'), 'Should mention aborted rescan');
      assert.ok(text.includes('3'), 'Should state 3 active downloads stopped');
      assert.ok(text.includes('2'), 'Should state 2 queued downloads cleared');
    });
  });

  describe('Database Deduplication in Channel Scans', () => {
    it('enforces UNIQUE(message_id, normalized_url) constraint against duplicate inserts', () => {
      const db = getDb();
      const insertStmt = db.prepare(`
        INSERT INTO posted_links (normalized_url, original_url, channel_id, message_id, author_id, author_tag, posted_at, is_backup)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `);

      // First insert succeeds
      insertStmt.run('https://twitter.com/art/status/1', 'https://twitter.com/art/status/1?s=20', 'c1', 'm1', 'u1', 'User', 1000);

      // Duplicate insert of same message_id and normalized_url must throw constraint error
      assert.throws(() => {
        insertStmt.run('https://twitter.com/art/status/1', 'https://twitter.com/art/status/1?ref=copy', 'c1', 'm1', 'u1', 'User', 1000);
      }, /UNIQUE constraint failed/);

      const count = db.prepare('SELECT COUNT(*) as cnt FROM posted_links WHERE message_id = ?').get('m1').cnt;
      assert.strictEqual(count, 1, 'Exactly one row must exist for (m1, url)');
    });
  });
});
