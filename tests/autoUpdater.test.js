import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkAndApplyUpdates, initAutoUpdater } from '../src/autoUpdater.js';
import { config } from '../src/config.js';

describe('autoUpdater', () => {
  it('gracefully handles initAutoUpdater when disabled', () => {
    const orig = config.enableAutoUpdateBinaries;
    try {
      config.enableAutoUpdateBinaries = false;
      assert.doesNotThrow(() => initAutoUpdater());
    } finally {
      config.enableAutoUpdateBinaries = orig;
    }
  });

  it('exports valid function interfaces', () => {
    assert.strictEqual(typeof initAutoUpdater, 'function');
    assert.strictEqual(typeof checkAndApplyUpdates, 'function');
  });
});
