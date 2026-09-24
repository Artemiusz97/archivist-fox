#!/usr/bin/env node
import path from 'node:path';
import { exportLinks } from '../src/linkExporter.js';
import { getDistinctLinkChannels } from '../src/linkDb.js';

async function main() {
  const args = process.argv.slice(2);
  let channel = 'all';
  let format = 'all';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
Archivist Fox — Link Backup Exporter CLI
Usage:
  node scripts/export_links.js [channel_name] [format]

Options:
  channel_name   Specific channel name to export, or "all" (default: "all")
  format         "all", "json", "markdown", or "csv" (default: "all")

Examples:
  npm run export-links
  node scripts/export_links.js all json
  node scripts/export_links.js misc-links markdown
      `);
      process.exit(0);
    } else if (['all', 'json', 'markdown', 'csv'].includes(arg.toLowerCase())) {
      format = arg.toLowerCase();
    } else if (!arg.startsWith('-')) {
      channel = arg;
    }
  }

  console.log(`🦊 [Link Exporter] Exporting saved links (channel: "${channel}", format: "${format}")...`);

  try {
    const result = await exportLinks({ channel, format });
    if (!result.success) {
      console.warn(`⚠️ ${result.summary}`);
      const available = getDistinctLinkChannels();
      if (available.length > 0) {
        console.log('\nAvailable channels in database:');
        for (const ch of available) {
          console.log(`  • #${ch.channel_name} (${ch.count} links)`);
        }
      }
      process.exit(1);
    }

    console.log(`\n✅ ${result.summary}`);
    console.log('\nCreated files:');
    for (const f of result.files) {
      console.log(`  📄 ${f}`);
    }
  } catch (err) {
    console.error('❌ Export failed:', err);
    process.exit(1);
  }
}

main();
