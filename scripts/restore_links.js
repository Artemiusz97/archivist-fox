#!/usr/bin/env node
import { Client, GatewayIntentBits } from 'discord.js';
import { config, requireDiscordToken } from '../src/config.js';
import { restoreLinks } from '../src/linkRestorer.js';

async function main() {
  const args = process.argv.slice(2);

  let guildId = null;
  let sourceChannel = 'all';
  let targetChannel = null;
  let autoCreate = false;
  let attribution = false;
  let dryRun = false;
  let backupFile = null;
  let delayMs = config.restorePaceDelayMs || 1500;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
Archivist Fox — Link Backup Restoration CLI
Usage:
  node scripts/restore_links.js --guild <GUILD_ID> [options]

Options:
  --guild <ID>            Target Discord server / Guild ID (required)
  --channel <NAME>        Source channel name from backup (e.g. misc-links), or "all" (default: "all")
  --target <NAME_OR_ID>   Target channel name or ID to post links into (for manual restore)
  --auto-create           Automatically recreate channels in Discord if they do not exist
  --attribution           Append original author and timestamp in post footer
  --dry-run               Simulate and check channel mapping without posting any messages
  --file <PATH>           Path to a specific backup JSON file instead of reading database
  --delay <MS>            Delay between messages in milliseconds (default: 1500)

Examples:
  # Dry-run test of all channels
  node scripts/restore_links.js --guild 123456789012345678 --dry-run

  # Restore a specific channel into an existing channel manually
  node scripts/restore_links.js --guild 123456789012345678 --channel misc-links --target my-archive

  # Full server restore with automatic channel creation
  node scripts/restore_links.js --guild 123456789012345678 --all --auto-create
      `);
      process.exit(0);
    } else if (arg === '--guild' || arg === '-g') {
      guildId = args[++i];
    } else if (arg === '--channel' || arg === '-c') {
      sourceChannel = args[++i];
    } else if (arg === '--target' || arg === '-t') {
      targetChannel = args[++i];
    } else if (arg === '--auto-create') {
      autoCreate = true;
    } else if (arg === '--attribution') {
      attribution = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--file' || arg === '-f') {
      backupFile = args[++i];
    } else if (arg === '--delay' || arg === '-d') {
      delayMs = parseInt(args[++i], 10) || 1500;
    } else if (arg === '--all') {
      sourceChannel = 'all';
    }
  }

  requireDiscordToken();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });

  console.log('🦊 [Link Restorer] Connecting to Discord...');

  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.login(config.token).catch(reject);
  });

  console.log(`✅ Connected as ${client.user.tag}`);

  try {

    const guilds = Array.from(client.guilds.cache.values());

    if (!guildId) {
      if (guilds.length === 1) {
        guildId = guilds[0].id;
        console.log(`ℹ️ No --guild specified. Defaulting to only active server: ${guilds[0].name ? `"${guilds[0].name}" ` : ''}(${guildId})`);
      } else {
        console.error('❌ Please specify a target server using --guild <GUILD_ID>.');
        console.log('\nAvailable servers:');
        for (const g of guilds) {
          console.log(`  • "${g.name}" (ID: ${g.id})`);
        }
        process.exit(1);
      }
    }

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      console.error(`❌ Could not fetch guild with ID "${guildId}". Make sure the bot is invited to the server.`);
      process.exit(1);
    }

    // Ensure channels are cached
    await guild.channels.fetch();

    console.log(`Target server: "${guild.name}" (ID: ${guild.id})`);
    console.log(`Source channel: "${sourceChannel}" | Target: "${targetChannel || 'auto-match'}"`);
    console.log(`Auto-create channels: ${autoCreate} | Dry-run: ${dryRun} | Pacing delay: ${delayMs}ms`);

    let lastProgressTime = 0;
    const onProgress = ({ current, total, channelName, postedCount, skippedCount }) => {
      const now = Date.now();
      if (now - lastProgressTime > 1000 || current === total) {
        lastProgressTime = now;
        process.stdout.write(
          `\r[Progress] [${current}/${total}] #${channelName} | Posted: ${postedCount} | Skipped: ${skippedCount}   `
        );
      }
    };

    const result = await restoreLinks({
      guild,
      sourceChannel,
      targetChannel,
      autoCreateChannels: autoCreate,
      includeAttribution: attribution,
      delayMs,
      dryRun,
      backupFile,
      onProgress,
    });

    console.log('\n');
    console.log(result.summary);

    if (result.createdChannels.length > 0) {
      console.log(`Created channels: ${result.createdChannels.map((c) => `#${c}`).join(', ')}`);
    }
  } catch (err) {
    console.error('\n❌ Restoration error:', err.message);
  } finally {
    await client.destroy();
    process.exit(0);
  }
}

main();
