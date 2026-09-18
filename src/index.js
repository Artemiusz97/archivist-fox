import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import { config, isChannelAllowed } from './config.js';
import { handleMessage } from './mediaHandler.js';
import { processMessageLinks } from './linkDetector.js';
import { initLinkDb, pruneExpiredLinks, closeLinkDb, checkpointWal } from './linkDb.js';
import { scheduleAutoDelete, cleanupStaleTempDirs } from './utils.js';
import { ensureBinaries } from './ensureBinaries.js';
import { initAutoUpdater } from './autoUpdater.js';
import { handleRescanCommand, stopActiveTasks, runStartupScan } from './scanner.js';
import { registerCommands, handleInteraction, getHelpEmbed } from './commands.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});
client.on(Events.Error, (err) => {
  console.error('[Discord Client] Network or client error:', err?.message || err);
});

client.on(Events.ShardError, (err, shardId) => {
  console.error(`[Discord Client] WebSocket shard ${shardId} error:`, err?.message || err);
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag} (Archivist Fox v${config.version})`);
  if (config.allowedChannelIds.length > 0) {
    console.log(`Restricted to channels: ${config.allowedChannelIds.join(', ')}`);
  } else if (config.disallowedChannelIds.length > 0) {
    console.log(`Active in all channels except: ${config.disallowedChannelIds.join(', ')}`);
  }
  console.log(
    `Duplicate Link Detector: ${
      config.enableGeneralDuplicateDetector
        ? `Enabled (scope: ${config.duplicateLinkScope}, retention: ${
            config.duplicateLinkRetentionDays > 0
              ? `${config.duplicateLinkRetentionDays} days`
              : 'forever'
          })`
        : 'Disabled'
    }`
  );
  console.log(`Retry command: reply to a message with "${config.retryCommand}"`);
  console.log(`Rescan command: "${config.rescanCommand}" or "!crawl" (use "${config.rescanCommand} all" for server-wide crawl)`);
  console.log(`Slash commands: /status, /stats, /rescan and Context Menu "Repost / Archive Media"`);
  
  // Register Slash Commands and Context Menu Apps
  registerCommands(client).catch((err) => {
    console.error('[Commands] Registration error on ready:', err);
  });

  // Automatic catch-up scan for links posted while the bot / PC was offline
  if (config.autoScanOnStartup) {
    console.log(
      `[Startup Scan] Automatic catch-up scan scheduled in 2.5s (window: last ${config.autoScanHours} hour(s), repostMissing=${config.autoScanRepostMissing})...`
    );
    setTimeout(() => {
      runStartupScan(client).catch((err) => {
        console.error('[Startup Scan] Unexpected error during startup catch-up scan:', err);
      });
    }, 2500);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  await handleInteraction(interaction);
});

function isRetryCommand(content) {
  const firstWord = content.trim().toLowerCase().split(/\s+/)[0];
  const retryCmd = (config.retryCommand || '!repost').toLowerCase();
  return firstWord === retryCmd;
}

function isRescanCommand(content) {
  const firstWord = content.trim().toLowerCase().split(/\s+/)[0];
  const rescanCmd = (config.rescanCommand || '!rescan').toLowerCase();
  return (
    firstWord === rescanCmd ||
    firstWord === '!crawl' ||
    firstWord === '!scan' ||
    firstWord === '!repost-missing' ||
    firstWord === '!fix-missing'
  );
}

function isStopCommand(content) {
  const firstWord = content.trim().toLowerCase().split(/\s+/)[0];
  return firstWord === '!stop' || firstWord === '!cancel' || firstWord === '!abort' || firstWord === '!stop-scan';
}

/**
 * Handles `!repost` (or whatever RETRY_COMMAND is set to): reply to the
 * message containing a link with this command, and the bot re-runs the
 * download/upload pipeline on the message you replied to. Useful for
 * catching up on links posted while the bot was offline.
 */
async function handleRetryCommand(commandMessage) {
  if (!commandMessage.reference) {
    const notice = await commandMessage.reply({
      content: `Reply to a message containing a link, then send \`${config.retryCommand}\` to retry it.`,
      allowedMentions: { repliedUser: false },
    });
    scheduleAutoDelete(notice);
    return;
  }

  let hourglassReaction = null;
  try {
    hourglassReaction = await commandMessage.react('⏳').catch(() => null);
    const target = await commandMessage.fetchReference();
    await handleMessage(target, { notifyIfEmpty: true });
    await commandMessage.react('✅').catch(() => {});
  } catch (err) {
    console.error(`Retry command failed for message ${commandMessage.id}:`, err);
    await commandMessage.react('❌').catch(() => {});
  } finally {
    if (hourglassReaction) {
      await hourglassReaction.users.remove(client.user.id).catch(() => {});
    }
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!isChannelAllowed(message.channelId)) return;

  try {
    if (message.content.trim().toLowerCase() === '!help') {
      await message.reply({
        embeds: [getHelpEmbed()],
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    if (isStopCommand(message.content)) {
      const isMod =
        message.member?.permissions?.has(PermissionFlagsBits.ManageMessages) ||
        message.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
        message.guild?.ownerId === message.author.id;

      if (!isMod) {
        const notice = await message.reply({
          content: '❌ You need the `Manage Messages` or `Administrator` permission to stop running tasks.',
          allowedMentions: { repliedUser: false },
        });
        scheduleAutoDelete(notice);
        return;
      }

      const stopped = stopActiveTasks();
      if (stopped.scanRunning || stopped.playlistRunning || stopped.queueItemsCleared > 0) {
        let msg = '🛑 **Stopped active tasks:**\n';
        if (stopped.scanRunning) msg += '• Aborted active channel rescan / media crawl.\n';
        if (stopped.playlistRunning) msg += '• Aborted active playlist download.\n';
        if (stopped.queueItemsCleared > 0) msg += `• Cleared **${stopped.queueItemsCleared}** queued download(s).\n`;
        await message.reply({ content: msg, allowedMentions: { repliedUser: false } });
      } else {
        const notice = await message.reply({
          content: 'ℹ️ No active rescan, playlist download, or queued tasks are currently running.',
          allowedMentions: { repliedUser: false },
        });
        scheduleAutoDelete(notice);
      }
      return;
    }

    if (isRetryCommand(message.content)) {
      await handleRetryCommand(message);
      return;
    }

    if (isRescanCommand(message.content)) {
      await handleRescanCommand(message);
      return;
    }

    // 1. General Duplicate Link Detector (runs across all links in the message)
    const linkResult = await processMessageLinks(message);

    // 2. Media Handler (downloads and uploads attachments if media links are present)
    await handleMessage(message, {
      duplicateUrls: linkResult.duplicateUrls,
    });
  } catch (err) {
    console.error(`Failed to handle message ${message.id}:`, err);
  }
});

/**
 * Connects to Discord with exponential backoff retries to tolerate transient
 * gateway hiccups, rate limits, or HTTP 500/502/503/504 errors.
 */
async function loginWithRetry(discordClient, token, maxRetries = 5) {
  if (!token) {
    throw new Error('DISCORD_TOKEN is not defined. Please configure DISCORD_TOKEN in your .env file.');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[Login] Re-attempting connection to Discord (Attempt ${attempt}/${maxRetries})...`);
      }
      await discordClient.login(token);
      return;
    } catch (err) {
      const isLastAttempt = attempt === maxRetries;
      const isAuthError =
        err.code === 'TokenInvalid' ||
        err.message?.includes('An invalid token was provided');

      if (isAuthError) {
        console.error('[Login] ❌ Fatal Authentication Error: The DISCORD_TOKEN in your .env file is invalid.');
        throw err;
      }

      if (
        err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        err.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      ) {
        console.error(
          '[Login] ❌ SSL Certificate Verification Error: Your Windows network or security software requires Windows Root CA certificates.\n' +
          'Please launch the bot using "npm start" or "start.bat" (which includes the --use-system-ca flag).'
        );
        throw err;
      }

      const status = err.status || err.httpStatus || '';
      const statusPrefix = status ? `[HTTP ${status}] ` : '';
      console.warn(`[Login] ⚠️ Attempt ${attempt}/${maxRetries} failed: ${statusPrefix}${err.message || err}`);

      if (isLastAttempt) {
        console.error(`[Login] ❌ Failed to connect to Discord after ${maxRetries} attempts.`);
        throw err;
      }

      const delayMs = Math.min(3000 * Math.pow(2, attempt - 1), 30000); // 3s, 6s, 12s, 24s, 30s
      console.log(`[Login] ⏳ Waiting ${delayMs / 1000}s before retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function start() {
  await cleanupStaleTempDirs();
  initLinkDb();
  if (config.duplicateLinkRetentionDays > 0) {
    const pruned = pruneExpiredLinks();
    if (pruned > 0) {
      console.log(`[Link Detector] Pruned ${pruned} expired links on startup.`);
    }
  }
  await ensureBinaries();
  await loginWithRetry(client, config.token);
  initAutoUpdater();
}

let isShuttingDown = false;
async function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Shutdown] Received ${signal}. Gracefully checkpointing database and closing...`);
  try {
    closeLinkDb();
    await client.destroy().catch(() => {});
  } catch {}
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Promise Rejection:', reason);
  checkpointWal('PASSIVE');
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  checkpointWal('PASSIVE');
  if (err?.code === 'EADDRINUSE' || err?.code === 'ENOSPC') {
    handleShutdown('FATAL_EXCEPTION');
  }
});

start().catch((err) => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
