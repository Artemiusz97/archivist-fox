import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureBinaries } from '../src/ensureBinaries.js';

describe('ensureBinaries', () => {
  it('exports ensureBinaries as an async function', () => {
    assert.strictEqual(typeof ensureBinaries, 'function');
  });

  it('runs binary verification without throwing on current system', async () => {
    // Should complete cleanly using locally available or configured binaries
    await assert.doesNotReject(async () => {
      await ensureBinaries();
    });
  });
});
