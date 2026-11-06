import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('app', () => {
  it('implements authenticated web UI client logic securely', () => {
    const appPath = path.join(process.cwd(), 'src', 'web', 'public', 'app.js');
    assert.ok(fs.existsSync(appPath), 'src/web/public/app.js must exist');

    const content = fs.readFileSync(appPath, 'utf-8');
    assert.ok(content.includes('DOMContentLoaded'), 'Must wait for DOMContentLoaded');
    assert.ok(content.includes('X-Auth-Token'), 'Must send X-Auth-Token header');
    assert.ok(content.includes('buildAuthorizedUrl'), 'Must use buildAuthorizedUrl helper');
    assert.ok(!content.includes('onclick='), 'Must not use inline onclick attributes');
  });
});
