import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('index', () => {
  it('defines valid Discord gateway intents and error listeners in entry point source', () => {
    const indexPath = path.join(process.cwd(), 'src', 'index.js');
    assert.ok(fs.existsSync(indexPath), 'src/index.js must exist');

    const content = fs.readFileSync(indexPath, 'utf-8');
    assert.ok(content.includes('GatewayIntentBits.Guilds'), 'Must declare Guilds intent');
    assert.ok(content.includes('GatewayIntentBits.GuildMessages'), 'Must declare GuildMessages intent');
    assert.ok(content.includes('GatewayIntentBits.MessageContent'), 'Must declare MessageContent intent');
    assert.ok(content.includes('Events.ClientReady'), 'Must register ClientReady event handler');
    assert.ok(content.includes('handleShutdown'), 'Must implement graceful shutdown handlers');
  });
});
