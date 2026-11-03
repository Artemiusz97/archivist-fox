import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDisplayTitle, describeError } from '../src/mediaHandler.js';

describe('mediaHandler', () => {
  describe('isValidDisplayTitle', () => {
    it('accepts legitimate video/artwork titles', () => {
      assert.strictEqual(isValidDisplayTitle('Never Gonna Give You Up'), true);
      assert.strictEqual(isValidDisplayTitle('Cool Artwork by Artist'), true);
      assert.strictEqual(isValidDisplayTitle('Sunset at the beach 🌅'), true);
    });

    it('rejects generic or placeholder names', () => {
      assert.strictEqual(isValidDisplayTitle('video'), false);
      assert.strictEqual(isValidDisplayTitle('IMAGE'), false);
      assert.strictEqual(isValidDisplayTitle('audio'), false);
      assert.strictEqual(isValidDisplayTitle('media'), false);
      assert.strictEqual(isValidDisplayTitle('download'), false);
    });

    it('rejects temporary file prefixes and random hashes', () => {
      assert.strictEqual(isValidDisplayTitle('file-12345'), false);
      assert.strictEqual(isValidDisplayTitle('tmp_download'), false);
      assert.strictEqual(isValidDisplayTitle('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), false); // 64 char hex hash
      assert.strictEqual(isValidDisplayTitle('123456789012345'), false); // numeric snowflake / ID
    });

    it('rejects empty, whitespace, null, or undefined values', () => {
      assert.strictEqual(isValidDisplayTitle(''), false);
      assert.strictEqual(isValidDisplayTitle('   '), false);
      assert.strictEqual(isValidDisplayTitle(null), false);
      assert.strictEqual(isValidDisplayTitle(undefined), false);
      assert.strictEqual(isValidDisplayTitle(12345), false);
    });
  });

  describe('describeError classification', () => {
    it('classifies "No video could be found" as no downloadable media rather than deleted post', () => {
      assert.strictEqual(
        describeError(new Error('ERROR: [twitter] 2116421485594382571: No video could be found in this tweet')),
        'no downloadable media found (or it exceeded the size limit)'
      );
      assert.strictEqual(
        describeError(new Error('ERROR: no video formats found')),
        'no downloadable media found (or it exceeded the size limit)'
      );
      assert.strictEqual(
        describeError(new Error('YTDLP_NO_MEDIA_FOUND')),
        'no downloadable media found (or it exceeded the size limit)'
      );
      assert.strictEqual(
        describeError(new Error('GALLERYDL_NO_MEDIA_FOUND')),
        'no downloadable media found (or it exceeded the size limit)'
      );
    });

    it('still classifies genuine deleted/404 posts as post was not found or deleted', () => {
      assert.strictEqual(describeError(new Error('Tweet could not be found')), 'post was not found or deleted');
      assert.strictEqual(describeError(new Error('NotFoundError: status 404')), 'post was not found or deleted');
      assert.strictEqual(
        describeError(new Error('Unavailable')),
        'post is unavailable (deleted, private, or age-restricted)'
      );
    });
  });
});
