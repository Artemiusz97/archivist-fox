import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle } from 'discord.js';
import {
  initLinkDb,
  closeLinkDb,
  getDb,
  saveLinkRecord,
  findDuplicateLink,
  deleteLinksByMessageId,
  getTotalLinkCount,
  getDistinctLinkChannels,
} from '../src/linkDb.js';
import { checkAndHandleDuplicateLinks, buildDuplicateActionRow } from '../src/linkDetector.js';
import { withConfigOverrides } from '../src/config.js';

describe('Duplicate Alerts & Link Backup Invariants (clean-room verification)', () => {
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

  describe('Action Row & Delete Post Button Generation', () => {
    it('includes Delete Post + Dismiss buttons when message contains 0 new URLs (all duplicates)', () => {
      const row = buildDuplicateActionRow({
        messageId: 'msg-100',
        authorId: 'user-200',
        canDeletePost: true,
      });

      const components = row.components;
      assert.strictEqual(components.length, 2, 'Must include both Delete Post and Dismiss buttons');

      const deleteBtn = components[0].data;
      assert.strictEqual(deleteBtn.custom_id, 'delete_duplicate:msg-100:user-200');
      assert.strictEqual(deleteBtn.style, ButtonStyle.Danger);

      const dismissBtn = components[1].data;
      assert.strictEqual(dismissBtn.custom_id, 'dismiss_alert:user-200');
      assert.strictEqual(dismissBtn.style, ButtonStyle.Secondary);
    });

    it('omits Delete Post button and includes ONLY Dismiss when message has mixed new URLs', () => {
      const row = buildDuplicateActionRow({
        messageId: 'msg-100',
        authorId: 'user-200',
        canDeletePost: false,
      });

      const components = row.components;
      assert.strictEqual(components.length, 1, 'Must include ONLY the Dismiss button');
      assert.strictEqual(components[0].data.custom_id, 'dismiss_alert:user-200');
      assert.strictEqual(components[0].data.style, ButtonStyle.Secondary);
    });
  });

  describe('Non-Backup Channel Duplicate Detection & Clean Backups (ORA-B3)', () => {
    it('records is_backup = 0 for non-backup channels without polluting export queries', async () => {
      // 1. Link posted in non-backup channel (#general)
      saveLinkRecord({
        normalizedUrl: 'https://twitter.com/news/1',
        originalUrl: 'https://twitter.com/news/1',
        channelId: 'chan-general',
        channelName: 'general',
        messageId: 'msg-gen-1',
        authorId: 'user-1',
        authorTag: 'User1',
        isBackup: false, // is_backup = 0
      });

      // 2. Link posted in backup channel (#resources)
      saveLinkRecord({
        normalizedUrl: 'https://twitter.com/art/2',
        originalUrl: 'https://twitter.com/art/2',
        channelId: 'chan-resources',
        channelName: 'resources',
        messageId: 'msg-res-2',
        authorId: 'user-2',
        authorTag: 'User2',
        isBackup: true, // is_backup = 1
      });

      // Duplicate detector in #general detects the reposted link
      const dupCheck = findDuplicateLink('https://twitter.com/news/1', {
        scope: 'channel',
        channelId: 'chan-general',
      });
      assert.strictEqual(dupCheck.isDuplicate, true, 'General channel must detect its duplicate');

      // Verify backup queries strictly ignore is_backup = 0
      const distinctBackupChannels = getDistinctLinkChannels();
      assert.strictEqual(distinctBackupChannels.length, 1, 'Only backup-eligible channels appear in exports/autocomplete');
      assert.strictEqual(distinctBackupChannels[0].channel_name, 'resources');

      // Also verify checkAndHandleDuplicateLinks sends interactive duplicate notice
      let sentReply = null;
      await withConfigOverrides(
        {
          enableGeneralDuplicateDetector: true,
          duplicateLinkScope: 'channel',
          linkBackupChannels: ['resources'],
          errorMessageTtlMs: 0,
        },
        async () => {
          const res = await checkAndHandleDuplicateLinks({
            id: 'msg-gen-dup',
            content: 'Check this out https://twitter.com/news/1',
            channelId: 'chan-general',
            guildId: 'guild-1',
            channel: { id: 'chan-general', name: 'general' },
            author: { id: 'user-9', username: 'Poster9', discriminator: '0' },
            reply: async (payload) => {
              sentReply = payload;
              return { delete: async () => {} };
            },
          });
          assert.strictEqual(res.duplicateUrls.length, 1);
          assert.ok(sentReply, 'Should send duplicate alert reply');
          assert.strictEqual(sentReply.components?.length, 1);
        }
      );
    });
  });

  describe('deleteLinksByMessageId on Duplicate Deletion', () => {
    it('removes posted_links rows when duplicate post is deleted', () => {
      saveLinkRecord({
        normalizedUrl: 'https://example.com/dup',
        originalUrl: 'https://example.com/dup',
        channelId: 'chan-1',
        channelName: 'chat',
        messageId: 'msg-to-delete',
        authorId: 'user-1',
        authorTag: 'User1',
      });

      assert.strictEqual(getTotalLinkCount(), 1);

      const deletedCount = deleteLinksByMessageId('msg-to-delete');
      assert.strictEqual(deletedCount, 1, 'Must delete 1 row');
      assert.strictEqual(getTotalLinkCount(), 0, 'Database must be empty after deletion');

      const check = findDuplicateLink('https://example.com/dup', {
        scope: 'channel',
        channelId: 'chan-1',
      });
      assert.strictEqual(check.isDuplicate, false, 'Deleted message link must not trigger duplicate alert');
    });
  });
});
