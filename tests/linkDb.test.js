import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initLinkDb,
  closeLinkDb,
  getDb,
  saveLinkRecord,
  saveLinkRecordBatch,
  findDuplicateLink,
  getDistinctLinkChannels,
  getLinksByChannel,
  getAllLinksGrouped,
  getTotalLinkCount,
  pruneExpiredLinks,
  updateLinkRecord,
} from '../src/linkDb.js';

describe('linkDb', () => {
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

  it('inserts and retrieves link records', () => {
    const id = saveLinkRecord({
      normalizedUrl: 'https://twitter.com/user/status/100',
      originalUrl: 'https://twitter.com/user/status/100?s=20',
      guildId: 'guild-1',
      channelId: 'chan-1',
      channelName: 'art',
      messageId: 'msg-1',
      authorId: 'user-1',
      authorTag: 'User#1234',
      postedAt: 1000,
      content: 'cool art',
    });

    assert.ok(id > 0);
    assert.strictEqual(getTotalLinkCount(), 1);

    const links = getLinksByChannel('art');
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].normalized_url, 'https://twitter.com/user/status/100');
    assert.strictEqual(links[0].content, 'cool art');
  });

  it('finds duplicates within channel scope', () => {
    saveLinkRecord({
      normalizedUrl: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
      originalUrl: 'https://youtu.be/dQw4w9WgXcQ',
      guildId: 'guild-1',
      channelId: 'chan-1',
      channelName: 'music',
      messageId: 'msg-1',
      authorId: 'user-1',
      authorTag: 'User#1',
      postedAt: 1000,
    });

    // Same channel, different user -> duplicate
    const check1 = findDuplicateLink('https://youtube.com/watch?v=dQw4w9WgXcQ', {
      scope: 'channel',
      channelId: 'chan-1',
      authorId: 'user-2',
    });
    assert.strictEqual(check1.isDuplicate, true);
    assert.strictEqual(check1.isSelfGrace, false);
    assert.ok(check1.record);

    // Different channel -> not duplicate in channel scope
    const check2 = findDuplicateLink('https://youtube.com/watch?v=dQw4w9WgXcQ', {
      scope: 'channel',
      channelId: 'chan-2',
      authorId: 'user-2',
    });
    assert.strictEqual(check2.isDuplicate, false);
  });

  it('finds duplicates within guild scope across different channels', () => {
    saveLinkRecord({
      normalizedUrl: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
      originalUrl: 'https://youtu.be/dQw4w9WgXcQ',
      guildId: 'guild-1',
      channelId: 'chan-1',
      channelName: 'music',
      messageId: 'msg-1',
      authorId: 'user-1',
      authorTag: 'User#1',
      postedAt: 1000,
    });

    const check = findDuplicateLink('https://youtube.com/watch?v=dQw4w9WgXcQ', {
      scope: 'guild',
      guildId: 'guild-1',
      channelId: 'chan-2',
      authorId: 'user-2',
    });
    assert.strictEqual(check.isDuplicate, true);
  });

  it('honors self-repost grace period for the original author', () => {
    const now = Date.now();
    saveLinkRecord({
      normalizedUrl: 'https://twitter.com/art/status/999',
      originalUrl: 'https://twitter.com/art/status/999',
      guildId: 'guild-1',
      channelId: 'chan-1',
      channelName: 'art',
      messageId: 'msg-1',
      authorId: 'user-1',
      authorTag: 'User#1',
      postedAt: now - 30 * 1000, // 30 seconds ago
    });

    const result = findDuplicateLink('https://twitter.com/art/status/999', {
      scope: 'channel',
      channelId: 'chan-1',
      authorId: 'user-1',
      selfRepostGraceSeconds: 300,
    });

    assert.strictEqual(result.isDuplicate, false);
    assert.strictEqual(result.isSelfGrace, true);
  });

  it('updates an existing link record when reposted during grace period', () => {
    const id = saveLinkRecord({
      normalizedUrl: 'https://twitter.com/art/status/777',
      originalUrl: 'https://twitter.com/art/status/777',
      guildId: 'guild-1',
      channelId: 'chan-1',
      channelName: 'art',
      messageId: 'msg-old',
      authorId: 'user-1',
      authorTag: 'User#1',
      postedAt: 1000,
    });

    updateLinkRecord(id, {
      messageId: 'msg-new',
      channelId: 'chan-2',
      channelName: 'art-new',
      postedAt: 2000,
      content: 'Updated caption',
    });

    const links = getLinksByChannel('art-new');
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].message_id, 'msg-new');
    assert.strictEqual(links[0].content, 'Updated caption');
  });

  it('batch inserts links within a transaction', () => {
    const records = [
      {
        normalized_url: 'https://twitter.com/a/status/1',
        original_url: 'https://twitter.com/a/status/1',
        channel_name: 'channel-a',
        channel_id: 'c-1',
        message_id: 'm-1',
        author_id: 'u-1',
        author_tag: 'User#1',
        posted_at: 100,
      },
      {
        normalized_url: 'https://twitter.com/b/status/2',
        original_url: 'https://twitter.com/b/status/2',
        channel_name: 'channel-b',
        channel_id: 'c-2',
        message_id: 'm-2',
        author_id: 'u-2',
        author_tag: 'User#2',
        posted_at: 200,
      },
    ];

    const inserted = saveLinkRecordBatch(records);
    assert.strictEqual(inserted, 2);
    assert.strictEqual(getTotalLinkCount(), 2);

    const distinct = getDistinctLinkChannels();
    assert.strictEqual(distinct.length, 2);
    assert.ok(distinct.some((d) => d.channel_name === 'channel-a' && d.count === 1));
    assert.ok(distinct.some((d) => d.channel_name === 'channel-b' && d.count === 1));

    const grouped = getAllLinksGrouped();
    assert.strictEqual(grouped['channel-a'].length, 1);
    assert.strictEqual(grouped['channel-b'].length, 1);
  });

  it('prunes expired links older than retention period', () => {
    const now = Date.now();
    const tenDaysAgo = now - 10 * 86400 * 1000;
    const yesterday = now - 1 * 86400 * 1000;

    saveLinkRecord({
      normalizedUrl: 'https://old.com/link',
      originalUrl: 'https://old.com/link',
      channelId: 'chan-1',
      messageId: 'm-old',
      authorId: 'u-1',
      authorTag: 'User#1',
      postedAt: tenDaysAgo,
    });

    saveLinkRecord({
      normalizedUrl: 'https://recent.com/link',
      originalUrl: 'https://recent.com/link',
      channelId: 'chan-1',
      messageId: 'm-new',
      authorId: 'u-1',
      authorTag: 'User#1',
      postedAt: yesterday,
    });

    assert.strictEqual(getTotalLinkCount(), 2);

    const deleted = pruneExpiredLinks(5); // delete older than 5 days
    assert.strictEqual(deleted, 1);
    assert.strictEqual(getTotalLinkCount(), 1);

    const remaining = getLinksByChannel('chat');
    assert.strictEqual(remaining[0].normalized_url, 'https://recent.com/link');
  });
});
