import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_VERSION } from '../src/version.js';
import packageJson from '../package.json' with { type: 'json' };

describe('version', () => {
  it('exports a valid semantic version string matching package.json', () => {
    assert.strictEqual(typeof BOT_VERSION, 'string');
    assert.match(BOT_VERSION, /^\d+\.\d+\.\d+/);
    assert.strictEqual(BOT_VERSION, packageJson.version);
  });
});
