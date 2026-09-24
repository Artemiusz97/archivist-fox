import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDisplayTitle } from '../src/mediaHandler.js';

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
});
