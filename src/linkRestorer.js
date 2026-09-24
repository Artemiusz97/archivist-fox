import fs from 'node:fs';
import path from 'node:path';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config, normalizeChannelName } from './config.js';
import { getDistinctLinkChannels, getLinksByChannel, getAllLinksGrouped, saveLinkRecord } from './linkDb.js';

let isRestoringActive = false;
let isRestoreStopRequested = false;

export function isRestoreRunning() {
  return isRestoringActive;
}

export function requestRestoreStop() {
  if (isRestoringActive) {
    isRestoreStopRequested = true;
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finds an existing text/announcement channel in the guild by ID, exact name, or normalized name.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} searchNameOrId
 * @returns {import('discord.js').TextChannel|null}
 */
export function findMatchingGuildChannel(guild, searchNameOrId) {
  if (!guild || !searchNameOrId) return null;

  const cleanSearch = searchNameOrId.toLowerCase().replace(/^#/, '').trim();
  const slugSearch = normalizeChannelName(searchNameOrId);

  const channels = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement
  );

  // 1. Check ID
  if (channels.has(searchNameOrId)) {
    return channels.get(searchNameOrId);
  }

  // 2. Check exact channel name
  for (const channel of channels.values()) {
    if (channel.name.toLowerCase() === cleanSearch) {
      return channel;
    }
  }

  // 3. Check normalized / slug name (ignoring emojis/symbols)
  for (const channel of channels.values()) {
    if (slugSearch && normalizeChannelName(channel.name) === slugSearch) {
      return channel;
    }
  }

  return null;
}

/**
 * Loads link records for restoration from either a JSON file or the SQLite database.
 *
 * @param {object} options
 * @param {string} [options.sourceChannel='all']
 * @param {string} [options.backupFile]
 * @returns {Record<string, Array<object>>} Grouped links by channel name
 */
export function loadLinksForRestore({ sourceChannel = 'all', backupFile = null } = {}) {
  let grouped = {};

  if (backupFile) {
    const resolvedPath = path.resolve(backupFile);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Backup file not found: ${resolvedPath}`);
    }
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed.channels && typeof parsed.channels === 'object') {
      grouped = parsed.channels;
    } else if (parsed.links && Array.isArray(parsed.links)) {
      // Single channel export JSON
      const chName = parsed.channel || path.basename(resolvedPath, '.json');
      grouped[chName] = parsed.links;
    } else if (Array.isArray(parsed)) {
      grouped['restored-links'] = parsed;
    }
  } else {
    // Load directly from SQLite link database
    if (sourceChannel === 'all') {
      grouped = getAllLinksGrouped();
    } else {
      const distinct = getDistinctLinkChannels();
      const cleanTarget = sourceChannel.toLowerCase().replace(/^#/, '');
      const slugTarget = normalizeChannelName(sourceChannel);

      const matched = distinct.find((d) => {
        const chName = d.channel_name.toLowerCase().replace(/^#/, '');
        return chName === cleanTarget || (slugTarget && normalizeChannelName(d.channel_name) === slugTarget);
      });

      const actualName = matched ? matched.channel_name : sourceChannel;
      const links = getLinksByChannel(actualName);
      if (links.length > 0) {
        grouped[actualName] = links;
      }
    }
  }

  // If specific channel requested, filter down
  if (sourceChannel !== 'all') {
    const filtered = {};
    const cleanSource = sourceChannel.toLowerCase().replace(/^#/, '');
    const slugSource = normalizeChannelName(sourceChannel);

    for (const [chName, list] of Object.entries(grouped)) {
      if (
        chName.toLowerCase().replace(/^#/, '') === cleanSource ||
        (slugSource && normalizeChannelName(chName) === slugSource)
      ) {
        filtered[chName] = list;
      }
    }
    return filtered;
  }

  return grouped;
}

/**
 * Restores and reposts backed-up links into a Discord server.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild - Discord guild to restore into
 * @param {string} [params.sourceChannel='all'] - Source channel to restore from ('all' or specific name)
 * @param {import('discord.js').TextChannel|string} [params.targetChannel] - Optional target channel (for manual single-channel restore)
 * @param {boolean} [params.autoCreateChannels=false] - Whether to automatically create missing channels
 * @param {boolean} [params.includeAttribution=false] - Whether to include original author and timestamp
 * @param {number} [params.delayMs] - Delay in milliseconds between posts (default from config)
 * @param {boolean} [params.dryRun=false] - If true, tests channel mapping without posting messages
 * @param {string} [params.backupFile] - Optional path to a specific JSON backup file
 * @param {(progress: object) => Promise<void>|void} [params.onProgress] - Progress callback
 * @returns {Promise<{
 *   success: boolean,
 *   totalLinks: number,
 *   postedCount: number,
 *   skippedCount: number,
 *   createdChannels: string[],
 *   channelsProcessed: string[],
 *   wasStopped: boolean,
 *   summary: string
 * }>}
 */
export async function restoreLinks({
  guild,
  sourceChannel = 'all',
  targetChannel = null,
  autoCreateChannels = false,
  includeAttribution = false,
  delayMs = config.restorePaceDelayMs || 1500,
  dryRun = false,
  backupFile = null,
  onProgress = null,
}) {
  if (!guild) {
    throw new Error('A valid Discord Guild instance is required to restore links.');
  }

  if (isRestoringActive) {
    throw new Error('A link restoration task is already in progress.');
  }

  isRestoringActive = true;
  isRestoreStopRequested = false;

  const createdChannels = [];
  const channelsProcessed = [];
  let totalLinks = 0;
  let postedCount = 0;
  let skippedCount = 0;

  try {
    const grouped = loadLinksForRestore({ sourceChannel, backupFile });
    const channelNames = Object.keys(grouped);

    if (channelNames.length === 0) {
      return {
        success: false,
        totalLinks: 0,
        postedCount: 0,
        skippedCount: 0,
        createdChannels: [],
        channelsProcessed: [],
        wasStopped: false,
        summary: `No link records found to restore for "${sourceChannel}".`,
      };
    }

    for (const ch of channelNames) {
      totalLinks += grouped[ch].length;
    }

    console.log(
      `[Link Restorer] Starting restoration: ${totalLinks} link(s) across ${channelNames.length} channel(s) (dryRun=${dryRun}, autoCreate=${autoCreateChannels})...`
    );

    // If manual target channel is provided and single channel is being restored
    let explicitDestination = null;
    if (targetChannel) {
      explicitDestination = typeof targetChannel === 'string'
        ? findMatchingGuildChannel(guild, targetChannel)
        : targetChannel;

      if (!explicitDestination) {
        throw new Error(`Target channel "${targetChannel}" could not be found in server "${guild.name}".`);
      }
    }

    for (const srcChannelName of channelNames) {
      if (isRestoreStopRequested) break;

      const links = grouped[srcChannelName];
      let destination = explicitDestination;

      if (!destination) {
        // Find matching channel in guild
        destination = findMatchingGuildChannel(guild, srcChannelName);

        // If not found and auto-create enabled, create channel
        if (!destination && autoCreateChannels && !dryRun) {
          const botMember = guild.members.me;
          if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
            throw new Error(`Bot lacks "Manage Channels" permission to automatically create #${srcChannelName}.`);
          }

          const cleanName = (normalizeChannelName(srcChannelName) || 'archive').slice(0, 95);

          destination = await guild.channels.create({
            name: cleanName,
            type: ChannelType.GuildText,
            reason: `Archivist Fox Link Restore: channel recreation for #${srcChannelName}`,
          });

          createdChannels.push(destination.name);
          console.log(`[Link Restorer] Created missing channel #${destination.name}`);
        }
      }

      if (!destination) {
        console.warn(`[Link Restorer] Skipping channel #${srcChannelName}: channel does not exist in guild.`);
        skippedCount += links.length;
        continue;
      }

      channelsProcessed.push(destination.name);

      for (let i = 0; i < links.length; i++) {
        if (isRestoreStopRequested) break;

        const record = links[i];
        const rawUrl = record.original_url || record.originalUrl || record.normalized_url || record.normalizedUrl;

        if (!rawUrl) {
          skippedCount++;
          continue;
        }

        let messageText = rawUrl;
        if (includeAttribution) {
          const author = record.author_tag || record.authorTag || 'Unknown';
          const dateStr = record.posted_at
            ? new Date(record.posted_at).toLocaleDateString()
            : 'Unknown date';
          messageText = `${rawUrl}\n_*(Archived from #${srcChannelName} • Originally posted by @${author} on ${dateStr})*_`;
        }

        if (!dryRun) {
          try {
            const sentMessage = await destination.send({
              content: messageText,
              allowedMentions: { parse: [] }, // Never ping users when restoring links
            });
            postedCount++;

            // Index newly posted message in SQLite so duplicate detection and jump links work in the new server
            try {
              saveLinkRecord({
                normalizedUrl: record.normalized_url || record.normalizedUrl || rawUrl,
                originalUrl: rawUrl,
                guildId: guild.id,
                channelId: destination.id,
                channelName: destination.name,
                messageId: sentMessage.id,
                authorId: record.author_id || record.authorId || '0',
                authorTag: record.author_tag || record.authorTag || 'Unknown',
                postedAt: record.posted_at || Date.now(),
                content: record.content || null,
              });
            } catch {}
          } catch (err) {
            console.error(`[Link Restorer] Failed to post link <${rawUrl}> to #${destination.name}:`, err.message);
            skippedCount++;

            // Handle rate limits gracefully
            if (err.status === 429) {
              const waitMs = (err.retryAfter && err.retryAfter > 500)
                ? err.retryAfter
                : ((err.retryAfter || err.rawError?.retry_after || 5) * 1000);
              await sleep(Math.min(waitMs, 60000));
            }
          }
        } else {
          postedCount++;
        }

        // Notify progress callback
        if (onProgress) {
          try {
            await onProgress({
              current: postedCount + skippedCount,
              total: totalLinks,
              channelName: destination.name,
              currentUrl: rawUrl,
              postedCount,
              skippedCount,
            });
          } catch {}
        }

        // Delay between posts to respect Discord rate limits and allow rich embed generation
        if (!dryRun && delayMs > 0 && i < links.length - 1) {
          await sleep(delayMs);
        }
      }
    }

    const wasStopped = isRestoreStopRequested;
    const summary = wasStopped
      ? `🛑 Restoration stopped early! Reposted ${postedCount.toLocaleString()} link(s) across ${channelsProcessed.length} channel(s) (${skippedCount} skipped).`
      : `${dryRun ? '🔍 [Dry Run Preview] ' : '✅ '}Restoration complete! Reposted ${postedCount.toLocaleString()} link(s) across ${channelsProcessed.length} channel(s) (${skippedCount} skipped).`;

    return {
      success: true,
      totalLinks,
      postedCount,
      skippedCount,
      createdChannels,
      channelsProcessed,
      wasStopped,
      summary,
    };
  } finally {
    isRestoringActive = false;
    isRestoreStopRequested = false;
  }
}
