import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { findMatchingGuildChannel, loadLinksForRestore } from '../src/linkRestorer.js';
import { initLinkDb, closeLinkDb, saveLinkRecordBatch } from '../src/linkDb.js';

describe('linkRestorer', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-restore-test-'));
    closeLinkDb();
    initLinkDb(':memory:');
  });

  after(() => {
    closeLinkDb();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('findMatchingGuildChannel', () => {
    // Mock Discord Guild object with channels cache
    const mockChannels = new Map([
      ['1001', { id: '1001', name: 'general', type: ChannelType.GuildText }],
      ['1002', { id: '1002', name: 'art-gallery🎨', type: ChannelType.GuildText }],
      ['1003', { id: '1003', name: 'announcements', type: ChannelType.GuildAnnouncement }],
      ['1004', { id: '1004', name: 'voice-chat', type: ChannelType.GuildVoice }],
    ]);

    const mockGuild = {
      channels: {
        cache: {
          filter: (predicate) => {
            const filtered = new Map();
            for (const [k, v] of mockChannels.entries()) {
              if (predicate(v)) filtered.set(k, v);
            }
            return filtered;
          },
        },
      },
    };

    it('matches channel by snowflake ID', () => {
      const match = findMatchingGuildChannel(mockGuild, '1001');
      assert.ok(match);
      assert.strictEqual(match.name, 'general');
    });

    it('matches channel by exact name (with or without #)', () => {
      const match1 = findMatchingGuildChannel(mockGuild, 'general');
      assert.ok(match1);
      assert.strictEqual(match1.id, '1001');

      const match2 = findMatchingGuildChannel(mockGuild, '#announcements');
      assert.ok(match2);
      assert.strictEqual(match2.id, '1003');
    });

    it('matches channel by slug ignoring emojis', () => {
      const match = findMatchingGuildChannel(mockGuild, 'art-gallery');
      assert.ok(match);
      assert.strictEqual(match.id, '1002');
    });

    it('ignores non-text / non-announcement channels', () => {
      const match = findMatchingGuildChannel(mockGuild, 'voice-chat');
      assert.strictEqual(match, null);
    });

    it('returns null when no matching channel exists', () => {
      const match = findMatchingGuildChannel(mockGuild, 'non-existent-channel');
      assert.strictEqual(match, null);
    });
  });

  describe('loadLinksForRestore', () => {
    it('loads links from a backup JSON file', () => {
      const backupPath = path.join(tmpDir, 'backup.json');
      const testBackup = {
        channels: {
          'test-channel': [
            {
              original_url: 'https://twitter.com/test/status/1',
              normalized_url: 'https://twitter.com/test/status/1',
              author_tag: 'Tester#1111',
              posted_at: 1000,
            },
          ],
        },
      };
      fs.writeFileSync(backupPath, JSON.stringify(testBackup, null, 2), 'utf8');

      const loaded = loadLinksForRestore({ backupFile: backupPath });
      assert.ok(loaded['test-channel']);
      assert.strictEqual(loaded['test-channel'].length, 1);
      assert.strictEqual(loaded['test-channel'][0].author_tag, 'Tester#1111');
    });

    it('loads and filters links directly from SQLite database', () => {
      saveLinkRecordBatch([
        {
          normalized_url: 'https://pixiv.net/artworks/123',
          original_url: 'https://pixiv.net/artworks/123',
          channel_name: 'pixiv-drops',
          channel_id: 'chan-1',
          message_id: 'm-1',
          author_id: 'u-1',
          author_tag: 'User#1',
          posted_at: Date.now(),
        },
      ]);

      const loadedAll = loadLinksForRestore({ sourceChannel: 'all' });
      assert.ok(loadedAll['pixiv-drops']);
      assert.strictEqual(loadedAll['pixiv-drops'].length, 1);

      const loadedSpecific = loadLinksForRestore({ sourceChannel: 'pixiv-drops' });
      assert.ok(loadedSpecific['pixiv-drops']);
      assert.strictEqual(loadedSpecific['pixiv-drops'].length, 1);

      const loadedEmpty = loadLinksForRestore({ sourceChannel: 'non-existent' });
      assert.deepStrictEqual(loadedEmpty, {});
    });
  });
});
