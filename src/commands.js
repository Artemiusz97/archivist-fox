import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { config, isChannelAllowed } from './config.js';
import { getDb } from './linkDb.js';
import { getBestVideoEncoder } from './compress.js';
import { handleMessage } from './mediaHandler.js';
import { downloadQueue } from './queue.js';
import { crawlChannel, isScanRunning, setScanRunning, stopActiveTasks, isStopRequested } from './scanner.js';

function runCmdOutput(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (out += d.toString()));
      child.on('error', () => resolve('Not found'));
      child.on('close', (code) => resolve(code === 0 ? out.trim() : 'Error'));
    } catch {
      resolve('Error');
    }
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Formats a duration in seconds into a human-readable "Xd Xh Xm Xs" uptime string.
 * @param {number} seconds
 * @returns {string}
 */
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

async function getDirectorySize(dirPath) {
  let total = 0;
  if (!fs.existsSync(dirPath)) return 0;

  async function walk(dir) {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.promises.stat(full);
            total += stat.size;
          } catch {}
        }
      }
    } catch {}
  }

  await walk(dirPath);
  return total;
}

/**
 * Returns command definitions for Discord registration.
 */
export function getCommandDefinitions() {
  const helpCommand = new SlashCommandBuilder()
    .setName('help')
    .setDescription('Lists all available commands, apps, and features in Archivist Fox');

  const contextMenu = new ContextMenuCommandBuilder()
    .setName('Repost / Archive Media')
    .setType(ApplicationCommandType.Message);

  const statusCommand = new SlashCommandBuilder()
    .setName('status')
    .setDescription('Displays live bot health, scraper versions, GPU encoder, and storage stats');

  const statsCommand = new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Displays server link and media archiving statistics');

  const rescanCommand = new SlashCommandBuilder()
    .setName('rescan')
    .setDescription('Crawl and archive past message history for media links')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Specific channel to scan (defaults to current channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('limit')
        .setDescription('Maximum number of messages to scan')
        .setMinValue(1)
        .setMaxValue(10000)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('missing_only')
        .setDescription('Only repost attachments for media that was missed/skipped')
    )
    .addBooleanOption((opt) =>
      opt
        .setName('force')
        .setDescription('Re-download and re-index media even if already in database')
    )
    .addIntegerOption((opt) =>
      opt
        .setName('concurrency')
        .setDescription('Number of parallel download workers (1-8, default 3)')
        .setMinValue(1)
        .setMaxValue(8)
    );

  const stopCommand = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stops any currently running rescan, crawl, or queued background tasks')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

  return [helpCommand, contextMenu, statusCommand, statsCommand, rescanCommand, stopCommand];
}

/**
 * Registers application commands globally or to the active guilds.
 */
export async function registerCommands(client) {
  try {
    const commands = getCommandDefinitions().map((cmd) => cmd.toJSON());
    console.log(`[Commands] Registering ${commands.length} application commands...`);

    if (client.application) {
      await client.application.commands.set(commands);
      
      // Also register directly to existing guilds for instant zero-delay availability
      const guilds = Array.from(client.guilds.cache.values());
      for (const guild of guilds) {
        await guild.commands.set(commands).catch(() => {});
      }
      console.log(`[Commands] Successfully registered application commands globally & to ${guilds.length} active guild(s)!`);
    }
  } catch (err) {
    console.error('[Commands] Failed to register application commands:', err);
  }
}

/**
 * Generates the rich help embed listing all commands and capabilities.
 */
export function getHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`🦊 Archivist Fox v${config.version} — Commands & Features Guide`)
    .setDescription(
      'Archivist Fox automatically detects media links in chat, downloads them in high quality, uploads them as native Discord attachments, and preserves them to your local PC archive.'
    )
    .addFields(
      {
        name: '⚡ Slash Commands (`/`)',
        value: [
          '• **`/help`** — Displays this list of commands and functions.',
          '• **`/status`** — Live diagnostics: scraper versions (yt-dlp, gallery-dl), GPU hardware encoder, database record counts, and archive disk usage.',
          '• **`/stats`** — Server-wide archiving analytics (total links, files preserved, top channels, and top uploaders).',
          '• **`/rescan [channel] [limit] [missing_only] [force]`** — Scans message history to bulk-archive media to PC and backfill missed uploads.',
          '• **`/stop`** — Stops any currently running channel rescan, media crawl, or queued background tasks.',
        ].join('\n'),
        inline: false,
      },
      {
        name: '📱 Message Context Menu (Apps)',
        value: [
          '• **Right-click / Long-press any message ➔ Apps ➔ Repost / Archive Media**',
          '  _Re-triggers media extraction and archiving on any message containing supported links._',
        ].join('\n'),
        inline: false,
      },
      {
        name: '💬 Chat Prefix Commands',
        value: [
          `• **Reply with \`${config.retryCommand}\`** — Retry downloading or reposting media from a message posted while the bot was offline.`,
          `• **\`${config.rescanCommand}\` / \`!crawl\`** — Crawl message history in the current channel.`,
          `• **\`${config.rescanCommand} #channel\`** — Crawl a specific channel.`,
          `• **\`${config.rescanCommand} all\`** — Server-wide historical crawl across all readable channels.`,
          `• **\`!repost-missing\`** — Scans for media links that never received an attachment upload and reposts them.`,
          `• **\`!stop\` / \`!cancel\`** — Stops the active channel rescan or crawl immediately.`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '✨ Automatic Features',
        value: [
          '• **Fast Video Streaming:** Uses `+faststart` so videos play immediately while buffering.',
          '• **Duplicate Protection:** Prevents duplicate visual media and duplicate link spam.',
          '• **Interactive Dismiss:** Duplicate alerts include a `🗑️ Dismiss` button for instant cleanup.',
          '• **Shortlink Resolution:** Automatically resolves `t.co`, `bit.ly`, `pin.it`, `fav.me`, and TikTok shortlinks.',
          '• **Supported Video/Image:** YouTube, Twitter/X, TikTok, Instagram, Reddit, Threads, Facebook, Bilibili, Bluesky, Streamable, RedGifs, Pixiv, Pinterest, Imgur, **DeviantArt**.',
          '• **Supported Audio/Music:** SoundCloud, Bandcamp, Mixcloud, Audiomack, YouTube Music, Podcasts, and direct MP3/audio URLs.',

        ].join('\n'),
        inline: false,
      }
    )
    .setFooter({ text: `Archivist Fox v${config.version}` })
    .setTimestamp();
}

/**
 * Handles all interaction events (slash commands, context menu apps, and buttons).
 */
export async function handleInteraction(interaction) {
  try {
    // 1. Button Interactions (e.g. Dismiss button on duplicate alert)
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('dismiss_alert:')) {
        const authorId = interaction.customId.split(':')[1];
        const isAuthor = interaction.user.id === authorId;
        const isMod =
          interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
          interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

        if (isAuthor || isMod) {
          await interaction.deferUpdate().catch(() => {});
          await interaction.message.delete().catch(() => {});
        } else {
          await interaction.reply({
            content: '❌ Only the person who posted the link or a moderator can dismiss this notice.',
            ephemeral: true,
          });
        }
      }
      return;
    }

    // 2. Message Context Menu ("Repost / Archive Media")
    if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName === 'Repost / Archive Media') {
        const targetMessage = interaction.targetMessage;

        // Enforce channel-gating: respect ALLOWED_CHANNEL_IDS / DISALLOWED_CHANNEL_IDS
        // so users cannot bypass channel restrictions by right-clicking messages.
        if (!isChannelAllowed(targetMessage.channelId)) {
          await interaction.reply({
            content: '❌ Archivist Fox is not enabled in that channel.',
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          const result = await handleMessage(targetMessage, { notifyIfEmpty: true });
          if (result.found === 0) {
            await interaction.editReply({ content: 'ℹ️ No supported media links found in that message.' });
          } else {
            await interaction.editReply({
              content: `✅ Done! Found ${result.found} media link(s), uploaded ${result.uploaded} attachment(s).`,
            });
          }
        } catch (err) {
          await interaction.editReply({ content: `❌ Failed to process message: ${err.message}` });
        }
      }
      return;
    }

    // 3. Slash Commands
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'help') {
        const embed = getHelpEmbed();
        await interaction.reply({ embeds: [embed] });
        return;
      }

      if (commandName === 'status') {
        await interaction.deferReply();

        const [ytdlpVer, gallerydlVer, gpuEncoder, archiveBytes] = await Promise.all([
          runCmdOutput(config.ytdlpPath, ['--version']),
          config.usePythonGalleryDl
            ? runCmdOutput('python3', ['-m', 'gallery_dl', '--version'])
            : runCmdOutput(config.gallerydlPath, ['--version']),
          getBestVideoEncoder(),
          getDirectorySize(path.resolve(config.archiveDirectory)),
        ]);

        const db = getDb();
        let linkCount = 0;
        let mediaCount = 0;
        try {
          linkCount = db.prepare('SELECT COUNT(*) as count FROM posted_links').get()?.count || 0;
          mediaCount = db.prepare('SELECT COUNT(*) as count FROM media_records').get()?.count || 0;
        } catch {}

        let dbFileSize = 0;
        try {
          const dbPath = config.linkDbPath || path.join(process.cwd(), 'data', 'links.db');
          if (fs.existsSync(dbPath)) {
            dbFileSize = (await fs.promises.stat(dbPath)).size;
          }
        } catch {}

        // Check active cookies
        const cookiesDir = config.cookiesDir || path.join(process.cwd(), 'cookies');
        let detectedCookies = [];
        if (fs.existsSync(cookiesDir)) {
          detectedCookies = (await fs.promises.readdir(cookiesDir))
            .filter((f) => f.endsWith('.txt'))
            .map((f) => path.basename(f, '.txt'));
        }

        const embed = new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle('🦊 Archivist Fox — System Status')
          .addFields(
            {
              name: '⚙️ Scraper Binaries',
              value: [
                `**yt-dlp:** \`${ytdlpVer}\``,
                `**gallery-dl:** \`${gallerydlVer}\` ${config.usePythonGalleryDl ? '(Python module)' : ''}`,
                `**FFmpeg Encoder:** \`${gpuEncoder}\``,
              ].join('\n'),
              inline: false,
            },
            {
              name: '🗄️ Database & Storage',
              value: [
                `**Indexed Links:** \`${linkCount.toLocaleString()}\``,
                `**Archived Media Records:** \`${mediaCount.toLocaleString()}\``,
                `**Database File:** \`${formatBytes(dbFileSize)}\``,
                `**Local Archive Directory:** \`${formatBytes(archiveBytes)}\``,
              ].join('\n'),
              inline: false,
            },
            {
              name: '🍪 Platform Cookies',
              value:
                detectedCookies.length > 0
                  ? detectedCookies.map((c) => `• \`${c}\``).join(', ')
                  : '_No platform cookie files detected in `cookies/`_',
              inline: false,
            },
            {
              name: '🖥️ System Environment',
              value: [
                `**Bot Version:** \`v${config.version}\``,
                `**Startup Catch-Up:** \`${config.autoScanOnStartup ? `Enabled (last ${config.autoScanHours}h)` : 'Disabled'}\``,
                `**Node.js:** \`${process.version}\``,
                `**Platform:** \`${process.platform} (${process.arch})\``,
                `**RAM Usage:** \`${formatBytes(process.memoryUsage().rss)}\``,
                `**Uptime:** \`${formatUptime(Math.floor(process.uptime()))}\``,
              ].join('\n'),
              inline: false,
            },
            {
              name: '⚡ Live Pipeline Activity',
              value: [
                `**Active Downloads:** \`${downloadQueue.running}\` / \`${downloadQueue.concurrency}\``,
                `**Queue Depth:** \`${downloadQueue.queue.length}\` / \`${downloadQueue.maxDepth}\``,
                `**Channel Scanner:** \`${isScanRunning() ? '🔄 Running' : '✅ Idle'}\``,
              ].join('\n'),
              inline: false,
            }
          )
          .setFooter({ text: `Archivist Fox v${config.version}` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (commandName === 'stats') {
        await interaction.deferReply();

        const db = getDb();
        const guildId = interaction.guildId;

        let totalLinks = 0;
        let totalMedia = 0;
        let topChannels = [];
        let topUsers = [];

        try {
          totalLinks = db.prepare('SELECT COUNT(*) as count FROM posted_links').get()?.count || 0;
          totalMedia = db.prepare('SELECT COUNT(*) as count FROM media_records').get()?.count || 0;

          if (guildId) {
            topChannels = db
              .prepare(
                'SELECT channel_name, COUNT(*) as count FROM posted_links WHERE guild_id = ? GROUP BY channel_name ORDER BY count DESC LIMIT 5'
              )
              .all(guildId);
            topUsers = db
              .prepare(
                'SELECT author_tag, COUNT(*) as count FROM posted_links WHERE guild_id = ? GROUP BY author_tag ORDER BY count DESC LIMIT 5'
              )
              .all(guildId);
          } else {
            topChannels = db
              .prepare(
                'SELECT channel_name, COUNT(*) as count FROM posted_links GROUP BY channel_name ORDER BY count DESC LIMIT 5'
              )
              .all();
            topUsers = db
              .prepare(
                'SELECT author_tag, COUNT(*) as count FROM posted_links GROUP BY author_tag ORDER BY count DESC LIMIT 5'
              )
              .all();
          }
        } catch (err) {
          console.error('[Commands] Stats query error:', err);
        }

        const archiveBytes = await getDirectorySize(path.resolve(config.archiveDirectory));

        const channelLines =
          topChannels.length > 0
            ? topChannels.map((c, i) => `${i + 1}. **#${c.channel_name}**: \`${c.count}\` links`).join('\n')
            : '_No channel data recorded yet._';

        const userLines =
          topUsers.length > 0
            ? topUsers.map((u, i) => `${i + 1}. **@${u.author_tag}**: \`${u.count}\` links`).join('\n')
            : '_No user data recorded yet._';

        const embed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('📊 Archivist Fox — Server Archive Statistics')
          .addFields(
            {
              name: '📈 Global Overview',
              value: [
                `**Total Links Tracked:** \`${totalLinks.toLocaleString()}\``,
                `**Total Media Files Preserved:** \`${totalMedia.toLocaleString()}\``,
                `**Total Archive Storage:** \`${formatBytes(archiveBytes)}\``,
              ].join('\n'),
              inline: false,
            },
            {
              name: '🏆 Top Channels',
              value: channelLines,
              inline: true,
            },
            {
              name: '👥 Top Contributors',
              value: userLines,
              inline: true,
            }
          )
          .setFooter({ text: `Archivist Fox v${config.version}` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (commandName === 'rescan') {
        const isMod =
          interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
          interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
          interaction.guild?.ownerId === interaction.user.id;

        if (!isMod) {
          await interaction.reply({
            content: '❌ You need the `Manage Messages` or `Administrator` permission to run a channel rescan.',
            ephemeral: true,
          });
          return;
        }

        if (isScanRunning()) {
          await interaction.reply({
            content: '⚠️ A rescan or media crawl is already running. Please wait for it to complete.',
            ephemeral: true,
          });
          return;
        }

        const channel = interaction.options.getChannel('channel') || interaction.channel;
        const limit = interaction.options.getInteger('limit') || Infinity;
        const missingOnly = interaction.options.getBoolean('missing_only') || false;
        const force = interaction.options.getBoolean('force') || false;
        const concurrency = interaction.options.getInteger('concurrency') || undefined;

        // Enforce channel-gating: respect ALLOWED_CHANNEL_IDS / DISALLOWED_CHANNEL_IDS.
        if (!isChannelAllowed(channel.id)) {
          await interaction.reply({
            content: `❌ Archivist Fox is not enabled in ${channel}. Check your \`ALLOWED_CHANNEL_IDS\` / \`DISALLOWED_CHANNEL_IDS\` configuration.`,
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply();
        setScanRunning(true);

        try {
          const progressNotice = await interaction.editReply({
            content: `⏳ Starting media scan of ${channel} (limit: ${limit === Infinity ? 'all' : limit} messages)...`,
          });

          let lastEditTime = Date.now();
          const onProgress = async (progress) => {
            const now = Date.now();
            if (now - lastEditTime > 4000) {
              lastEditTime = now;
              await interaction
                .editReply({
                  content: `⏳ Scanning ${channel}...\nMessages scanned: **${progress.messagesScanned}** | Media links: **${progress.mediaLinksFound}** | Archived: **${progress.archivedCount}**`,
                })
                .catch(() => {});
            }
          };

          const stats = await crawlChannel(
            channel,
            {
              limit,
              upload: false,
              force,
              repostMissing: missingOnly,
              concurrency,
            },
            onProgress
          );

          const wasStopped = isStopRequested();
          const summaryText = wasStopped
            ? `🛑 Scan stopped early for ${channel}!\n• Messages checked: **${stats.messagesScanned}**\n• Media links found: **${stats.mediaLinksFound}**\n• New items archived: **${stats.archivedCount}**\n• Missing reposted: **${stats.repostedMissingCount}**\n• Skipped: **${stats.skippedCount}**`
            : `✅ Scan complete for ${channel}!\n• Messages checked: **${stats.messagesScanned}**\n• Media links found: **${stats.mediaLinksFound}**\n• New items archived: **${stats.archivedCount}**\n• Missing reposted: **${stats.repostedMissingCount}**\n• Skipped/duplicates: **${stats.skippedCount}**`;

          try {
            await interaction.editReply({ content: summaryText });
          } catch {
            // Interaction token expired (>15 min) — deliver summary via channel.send
            if (interaction.channel?.send) {
              await interaction.channel.send({ content: `${interaction.user}: ${summaryText}` }).catch(() => {});
            }
          }
        } catch (err) {
          try {
            await interaction.editReply({ content: `❌ Rescan failed: ${err.message}` });
          } catch {
            if (interaction.channel?.send) {
              await interaction.channel.send({ content: `${interaction.user}: ❌ Rescan failed: ${err.message}` }).catch(() => {});
            }
          }
        } finally {
          setScanRunning(false);
        }
        return;
      }

      if (commandName === 'stop') {
        const isMod =
          interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
          interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
          interaction.guild?.ownerId === interaction.user.id;

        if (!isMod) {
          await interaction.reply({
            content: '❌ You need the `Manage Messages` or `Administrator` permission to stop running tasks.',
            ephemeral: true,
          });
          return;
        }

        const stopped = stopActiveTasks();
        if (stopped.scanRunning || stopped.playlistRunning || stopped.queueItemsCleared > 0) {
          let msg = '🛑 **Stopped active tasks:**\n';
          if (stopped.scanRunning) msg += '• Aborted active channel rescan / media crawl.\n';
          if (stopped.playlistRunning) msg += '• Aborted active playlist download.\n';
          if (stopped.queueItemsCleared > 0) msg += `• Cleared **${stopped.queueItemsCleared}** queued download(s).\n`;
          await interaction.reply({ content: msg });
        } else {
          await interaction.reply({
            content: 'ℹ️ No active rescan, playlist download, or queued tasks are currently running.',
            ephemeral: true,
          });
        }
        return;
      }
    }
  } catch (err) {
    console.error('[Commands] Interaction error:', err);
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content: '❌ An error occurred while executing this command.' }).catch(() => {});
    }
  }
}
