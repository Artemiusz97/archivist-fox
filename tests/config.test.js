import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  config,
  normalizeChannelName,
  isChannelAllowed,
  isLinkBackupChannel,
} from '../src/config.js';

describe('config', () => {
  describe('normalizeChannelName', () => {
    it('strips leading # character and trims whitespace', () => {
      assert.strictEqual(normalizeChannelName('#general'), 'general');
      assert.strictEqual(normalizeChannelName('  #media-feed  '), 'media-feed');
    });

    it('strips unicode emojis and symbols', () => {
      assert.strictEqual(normalizeChannelName('misc-links🔗'), 'misc-links');
      assert.strictEqual(normalizeChannelName('#anime🗾'), 'anime');
      assert.strictEqual(normalizeChannelName('columbina-x-sandrone🌙🗝️'), 'columbina-x-sandrone');
      assert.strictEqual(normalizeChannelName('Gaming Channels! 🎮'), 'gaming-channels');
    });

    it('replaces spaces with hyphens and collapses duplicate hyphens', () => {
      assert.strictEqual(normalizeChannelName('art   and   crafts'), 'art-and-crafts');
      assert.strictEqual(normalizeChannelName('music---video'), 'music-video');
    });

    it('handles empty or undefined values gracefully', () => {
      assert.strictEqual(normalizeChannelName(''), '');
      assert.strictEqual(normalizeChannelName(null), '');
      assert.strictEqual(normalizeChannelName(undefined), '');
    });
  });

  describe('isChannelAllowed', () => {
    let originalAllowed;
    let originalDisallowed;

    beforeEach(() => {
      originalAllowed = [...config.allowedChannelIds];
      originalDisallowed = [...config.disallowedChannelIds];
    });

    afterEach(() => {
      config.allowedChannelIds = originalAllowed;
      config.disallowedChannelIds = originalDisallowed;
    });

    it('allows all channels when both allowed and disallowed lists are empty', () => {
      config.allowedChannelIds = [];
      config.disallowedChannelIds = [];
      assert.strictEqual(isChannelAllowed('111111111111111111'), true);
      assert.strictEqual(isChannelAllowed('222222222222222222'), true);
    });

    it('only allows explicitly listed channels when allowedChannelIds is non-empty', () => {
      config.allowedChannelIds = ['111111111111111111'];
      config.disallowedChannelIds = [];
      assert.strictEqual(isChannelAllowed('111111111111111111'), true);
      assert.strictEqual(isChannelAllowed('999999999999999999'), false);
    });

    it('denies listed channels when disallowedChannelIds is set', () => {
      config.allowedChannelIds = [];
      config.disallowedChannelIds = ['999999999999999999'];
      assert.strictEqual(isChannelAllowed('111111111111111111'), true);
      assert.strictEqual(isChannelAllowed('999999999999999999'), false);
    });

    it('prioritizes allowedChannelIds over disallowedChannelIds', () => {
      config.allowedChannelIds = ['111111111111111111'];
      config.disallowedChannelIds = ['111111111111111111'];
      assert.strictEqual(isChannelAllowed('111111111111111111'), true);
    });
  });

  describe('isLinkBackupChannel', () => {
    let originalBackupChannels;
    let originalAllowed;

    beforeEach(() => {
      originalBackupChannels = [...config.linkBackupChannels];
      originalAllowed = [...config.allowedChannelIds];
    });

    afterEach(() => {
      config.linkBackupChannels = originalBackupChannels;
      config.allowedChannelIds = originalAllowed;
    });

    it('falls back to isChannelAllowed when linkBackupChannels is empty', () => {
      config.linkBackupChannels = [];
      config.allowedChannelIds = ['111111111111111111'];
      assert.strictEqual(isLinkBackupChannel({ id: '111111111111111111', name: 'general' }), true);
      assert.strictEqual(isLinkBackupChannel({ id: '222222222222222222', name: 'random' }), false);
    });

    it('matches by exact snowflake ID', () => {
      config.linkBackupChannels = ['123456789012345678'];
      assert.strictEqual(isLinkBackupChannel({ id: '123456789012345678', name: 'some-chan' }), true);
      assert.strictEqual(isLinkBackupChannel({ id: '999999999999999999', name: 'other-chan' }), false);
    });

    it('matches by channel name (with or without #)', () => {
      config.linkBackupChannels = ['art-gallery', 'clips'];
      assert.strictEqual(isLinkBackupChannel({ id: '1', name: 'art-gallery' }), true);
      assert.strictEqual(isLinkBackupChannel({ id: '2', name: '#clips' }), true);
      assert.strictEqual(isLinkBackupChannel({ id: '3', name: 'general' }), false);
    });

    it('matches by slug / normalized name ignoring emojis and symbols', () => {
      config.linkBackupChannels = ['misc-links', 'anime-art'];
      assert.strictEqual(isLinkBackupChannel({ id: '1', name: 'misc-links🔗' }), true);
      assert.strictEqual(isLinkBackupChannel({ id: '2', name: '#anime-art🗾✨' }), true);
      assert.strictEqual(isLinkBackupChannel({ id: '3', name: 'gaming-zone🎮' }), false);
    });

    it('returns false for null or undefined channel', () => {
      assert.strictEqual(isLinkBackupChannel(null), false);
      assert.strictEqual(isLinkBackupChannel(undefined), false);
    });
  });
});
