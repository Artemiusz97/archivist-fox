import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMediaLinks,
  isKnownNsfwUrl,
  checkNsfwInMetadata,
  normalizeUrl,
  stripQueryAndTrailingPunctuation,
  getSpoilerRanges,
  isAudioPlatform,
  isAudioUrl,
  isDeviantArtUrl,
  extractPlatformMediaId,
  extractYouTubePlaylistDetails,
} from '../src/urlExtractor.js';

describe('urlExtractor', () => {
  describe('extractMediaLinks & Spoiler Detection', () => {
    it('detects a link cleanly wrapped in spoiler tags (||url||)', () => {
      const text = '||https://twitter.com/art/status/123456789||';
      const links = extractMediaLinks(text);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].url, 'https://twitter.com/art/status/123456789');
      assert.strictEqual(links[0].isSpoiler, true);
    });

    it('detects a spoilered link with whitespace inside spoiler markers', () => {
      const text = 'Check out this art: || https://twitter.com/art/status/123456789 || cool right?';
      const links = extractMediaLinks(text);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].isSpoiler, true);
    });

    it('identifies unspoilered links as isSpoiler: false', () => {
      const text = 'Normal post: https://twitter.com/art/status/123456789 not spoilered';
      const links = extractMediaLinks(text);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].isSpoiler, false);
    });

    it('accurately parses mixed spoilered and unspoilered links in the same message', () => {
      const text = 'Safe: https://twitter.com/safe/status/111 and secret: ||https://twitter.com/nsfw/status/222||';
      const links = extractMediaLinks(text);
      assert.strictEqual(links.length, 2);
      assert.strictEqual(links[0].isSpoiler, false);
      assert.strictEqual(links[1].isSpoiler, true);
    });

    it('correctly calculates spoiler index ranges', () => {
      const text = 'prefix ||inside|| middle ||second|| suffix';
      const ranges = getSpoilerRanges(text);
      assert.strictEqual(ranges.length, 2);
      assert.strictEqual(text.slice(ranges[0].start, ranges[0].end), '||inside||');
      assert.strictEqual(text.slice(ranges[1].start, ranges[1].end), '||second||');
    });
  });

  describe('isKnownNsfwUrl', () => {
    it('returns true for known adult domains and boorus', () => {
      assert.strictEqual(isKnownNsfwUrl('https://redgifs.com/watch/funnycat'), true);
      assert.strictEqual(isKnownNsfwUrl('https://danbooru.donmai.us/posts/12345'), true);
      assert.strictEqual(isKnownNsfwUrl('https://gelbooru.com/index.php?page=post&s=view&id=123'), true);
      assert.strictEqual(isKnownNsfwUrl('https://e621.net/posts/12345'), true);
      assert.strictEqual(isKnownNsfwUrl('https://rule34.xxx/index.php?page=post&s=view&id=123'), true);
      assert.strictEqual(isKnownNsfwUrl('https://kemono.su/fanbox/user/123'), true);
      assert.strictEqual(isKnownNsfwUrl('https://coomer.party/onlyfans/user/123'), true);
    });

    it('returns false for safe / general platforms', () => {
      assert.strictEqual(isKnownNsfwUrl('https://twitter.com/user/status/123'), false);
      assert.strictEqual(isKnownNsfwUrl('https://youtube.com/watch?v=123'), false);
      assert.strictEqual(isKnownNsfwUrl('https://instagram.com/p/123'), false);
      assert.strictEqual(isKnownNsfwUrl(''), false);
      assert.strictEqual(isKnownNsfwUrl(null), false);
    });
  });

  describe('checkNsfwInMetadata', () => {
    it('detects Twitter sensitive content flag', () => {
      assert.strictEqual(checkNsfwInMetadata({ possibly_sensitive: true }), true);
      assert.strictEqual(checkNsfwInMetadata({ sensitive: true }), true);
      assert.strictEqual(checkNsfwInMetadata({ possibly_sensitive: false }), false);
    });

    it('detects Reddit over_18 and spoiler flags', () => {
      assert.strictEqual(checkNsfwInMetadata({ over_18: true }), true);
      assert.strictEqual(checkNsfwInMetadata({ spoiler: true }), true);
      assert.strictEqual(checkNsfwInMetadata({ over_18: false }), false);
    });

    it('detects Pixiv x_restrict and age_limit', () => {
      assert.strictEqual(checkNsfwInMetadata({ x_restrict: 1 }), true);
      assert.strictEqual(checkNsfwInMetadata({ x_restrict: 2 }), true);
      assert.strictEqual(checkNsfwInMetadata({ x_restrict: 0 }), false);
      assert.strictEqual(checkNsfwInMetadata({ age_limit: 18 }), true);
      assert.strictEqual(checkNsfwInMetadata({ age_limit: 17 }), false);
    });

    it('detects booru ratings (e, q, explicit, questionable)', () => {
      assert.strictEqual(checkNsfwInMetadata({ rating: 'e' }), true);
      assert.strictEqual(checkNsfwInMetadata({ rating: 'q' }), true);
      assert.strictEqual(checkNsfwInMetadata({ rating: 'explicit' }), true);
      assert.strictEqual(checkNsfwInMetadata({ rating: 'questionable' }), true);
      assert.strictEqual(checkNsfwInMetadata({ rating: 's' }), false);
      assert.strictEqual(checkNsfwInMetadata({ rating: 'general' }), false);
    });

    it('detects Bluesky NSFW/nudity labels', () => {
      assert.strictEqual(checkNsfwInMetadata({ labels: ['sexual'] }), true);
      assert.strictEqual(checkNsfwInMetadata({ labels: [{ val: 'porn' }] }), true);
      assert.strictEqual(checkNsfwInMetadata({ labels: ['clean', 'art'] }), false);
    });

    it('detects DeviantArt mature flag', () => {
      assert.strictEqual(checkNsfwInMetadata({ is_mature: true }), true);
      assert.strictEqual(checkNsfwInMetadata({ is_mature: false }), false);
    });

    it('detects adult tags', () => {
      assert.strictEqual(checkNsfwInMetadata({ tags: ['anime', 'R-18', 'illustration'] }), true);
      assert.strictEqual(checkNsfwInMetadata({ tags: 'art, 18+, sketch' }), true);
      assert.strictEqual(checkNsfwInMetadata({ tags: ['landscape', 'scenery'] }), false);
    });

    it('handles null, undefined, and non-object metadata gracefully', () => {
      assert.strictEqual(checkNsfwInMetadata(null), false);
      assert.strictEqual(checkNsfwInMetadata(undefined), false);
      assert.strictEqual(checkNsfwInMetadata('string'), false);
    });
  });

  describe('normalizeUrl', () => {
    it('normalizes protocol and strips tracking parameters', () => {
      const url = 'http://twitter.com/user/status/12345?utm_source=twitter&utm_medium=social&t=abc';
      assert.strictEqual(normalizeUrl(url), 'https://twitter.com/user/status/12345');
    });

    it('canonicalizes domain proxies to their original service', () => {
      assert.strictEqual(
        normalizeUrl('https://vxtwitter.com/art/status/123'),
        'https://twitter.com/art/status/123'
      );
      assert.strictEqual(
        normalizeUrl('https://fixupx.com/art/status/123'),
        'https://twitter.com/art/status/123'
      );
      assert.strictEqual(
        normalizeUrl('https://ddinstagram.com/p/abc123/'),
        'https://instagram.com/p/abc123'
      );
      assert.strictEqual(
        normalizeUrl('https://vxreddit.com/r/pics/comments/xyz'),
        'https://reddit.com/r/pics/comments/xyz'
      );
    });

    it('canonicalizes youtu.be shortlinks to youtube.com/watch?v=', () => {
      assert.strictEqual(
        normalizeUrl('https://youtu.be/dQw4w9WgXcQ?feature=share'),
        'https://youtube.com/watch?v=dQw4w9WgXcQ'
      );
    });

    it('sorts remaining non-tracking query parameters deterministically', () => {
      const url = 'https://example.com/item?z=last&a=first&m=middle';
      assert.strictEqual(normalizeUrl(url), 'https://example.com/item?a=first&m=middle&z=last');
    });

    it('returns null for invalid or non-http URLs', () => {
      assert.strictEqual(normalizeUrl('not-a-url'), null);
      assert.strictEqual(normalizeUrl('ftp://ftp.example.com/file'), null);
      assert.strictEqual(normalizeUrl(''), null);
      assert.strictEqual(normalizeUrl(null), null);
    });
  });

  describe('stripQueryAndTrailingPunctuation', () => {
    it('strips punctuation from URLs ending a sentence', () => {
      assert.strictEqual(
        stripQueryAndTrailingPunctuation('https://example.com/file.png...'),
        'https://example.com/file.png'
      );
      assert.strictEqual(
        stripQueryAndTrailingPunctuation('https://example.com/post,!?'),
        'https://example.com/post'
      );
      assert.strictEqual(
        stripQueryAndTrailingPunctuation('(https://example.com/page)'),
        '(https://example.com/page'
      );
    });
  });

  describe('Audio & DeviantArt Helpers', () => {
    it('identifies audio platform domains and subdomains', () => {
      assert.strictEqual(isAudioPlatform('https://soundcloud.com/artist/track'), true);
      assert.strictEqual(isAudioPlatform('https://myartist.bandcamp.com/album/lp'), true);
      assert.strictEqual(isAudioPlatform('https://youtube.com/watch?v=123'), false);
    });

    it('identifies direct audio file extensions via isAudioUrl', () => {
      assert.strictEqual(isAudioUrl('https://cdn.example.com/track.mp3'), true);
      assert.strictEqual(isAudioUrl('https://cdn.example.com/track.flac'), true);
      assert.strictEqual(isAudioUrl('https://cdn.example.com/video.mp4'), false);
    });

    it('identifies DeviantArt links', () => {
      assert.strictEqual(isDeviantArtUrl('https://www.deviantart.com/artist/art/Drawing-12345'), true);
      assert.strictEqual(isDeviantArtUrl('https://sta.sh/0123abc'), true);
      assert.strictEqual(isDeviantArtUrl('https://twitter.com/art/status/123'), false);
    });
  });

  describe('extractPlatformMediaId', () => {
    it('extracts platform media IDs accurately', () => {
      assert.strictEqual(
        extractPlatformMediaId('https://twitter.com/artist/status/9876543210'),
        'twitter:9876543210'
      );
      assert.strictEqual(
        extractPlatformMediaId('https://www.pixiv.net/en/artworks/11223344'),
        'pixiv:11223344'
      );
      assert.strictEqual(
        extractPlatformMediaId('https://youtube.com/watch?v=dQw4w9WgXcQ'),
        'youtube:dQw4w9WgXcQ'
      );
    });
  });

  describe('extractYouTubePlaylistDetails', () => {
    it('extracts video ID and playlist ID from YouTube URLs', () => {
      const res = extractYouTubePlaylistDetails('https://www.youtube.com/watch?v=xyz123&list=PLabc456&index=2');
      assert.ok(res);
      assert.strictEqual(res.isPlaylist, true);
      assert.strictEqual(res.isVideoWithPlaylist, true);
      assert.strictEqual(res.videoId, 'xyz123');
      assert.strictEqual(res.listId, 'PLabc456');
    });

    it('returns isPlaylist: false for non-playlist YouTube URLs', () => {
      const res = extractYouTubePlaylistDetails('https://www.youtube.com/watch?v=xyz123');
      assert.ok(res);
      assert.strictEqual(res.isPlaylist, false);
      assert.strictEqual(res.listId, null);
    });
  });
});
