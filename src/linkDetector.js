import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from './config.js';
import { extractAllUrlsAsync } from './urlExtractor.js';
import {
  findDuplicateLink,
  saveLinkRecord,
  updateLinkRecord,
} from './linkDb.js';

/**
 * Checks all URLs in a Discord message for duplicates against the SQLite link database.
 * Sends an alert if a duplicate is found (unless within self-repost grace period).
 * Records new links into the database.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<{
 *   hasUrls: boolean,
 *   duplicateUrls: Array<{ originalUrl: string, normalizedUrl: string, record: object }>,
 *   newUrls: Array<{ originalUrl: string, normalizedUrl: string }>
 * }>}
 */
export async function processMessageLinks(message) {
  if (!config.enableGeneralDuplicateDetector) {
    return { hasUrls: false, duplicateUrls: [], newUrls: [] };
  }

  const urls = await extractAllUrlsAsync(message.content);
  if (urls.length === 0) {
    return { hasUrls: false, duplicateUrls: [], newUrls: [] };
  }

  const authorTag = message.author?.tag || message.author?.username || 'Unknown';
  const authorId = message.author?.id || '0';
  const guildId = message.guildId || null;
  const channelId = message.channelId;
  const channelName = message.channel?.name || 'chat';
  const messageId = message.id;
  const postedAt = message.createdTimestamp || Date.now();

  const duplicateUrls = [];
  const newUrls = [];
  const alertLines = [];

  for (const { originalUrl, normalizedUrl } of urls) {
    const { isDuplicate, isSelfGrace, record } = findDuplicateLink(normalizedUrl, {
      scope: config.duplicateLinkScope,
      guildId,
      channelId,
      authorId,
      retentionDays: config.duplicateLinkRetentionDays,
      selfRepostGraceSeconds: config.selfRepostGraceSeconds,
    });

    if (isSelfGrace && record) {
      // User reposted their own link within the grace period (e.g. editing, channel switch)
      // Quietly update the record without triggering an alert
      updateLinkRecord(record.id, {
        messageId,
        channelId,
        channelName,
        postedAt,
      });
      newUrls.push({ originalUrl, normalizedUrl });
    } else if (isDuplicate && record) {
      duplicateUrls.push({ originalUrl, normalizedUrl, record });

      const timestampSec = Math.floor(record.posted_at / 1000);
      const relativeTime = `<t:${timestampSec}:R>`;
      const channelMention =
        record.channel_id === channelId
          ? 'in this channel'
          : `in <#${record.channel_id}>`;

      const jumpUrl = record.guild_id
        ? `https://discord.com/channels/${record.guild_id}/${record.channel_id}/${record.message_id}`
        : `https://discord.com/channels/@me/${record.channel_id}/${record.message_id}`;

      console.log(
        `[Link Detector] Duplicate detected for <${originalUrl}>! Previously posted by @${record.author_tag} in #${record.channel_name} (${record.message_id})`
      );

      alertLines.push(
        `ℹ️ This link was already posted by **@${record.author_tag}** ${channelMention} ${relativeTime}!\n🔗 [Jump to original message](<${jumpUrl}>)`
      );
    } else {
      // First time seeing this link — save to database
      saveLinkRecord({
        normalizedUrl,
        originalUrl,
        guildId,
        channelId,
        channelName,
        messageId,
        authorId,
        authorTag,
        postedAt,
      });
      newUrls.push({ originalUrl, normalizedUrl });
    }
  }

  // If duplicate URLs were found, send an alert reply
  if (alertLines.length > 0) {
    try {
      const dismissRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`dismiss_alert:${authorId}`)
          .setLabel('Dismiss')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🗑️')
      );

      // Cap alert to 3 entries to stay within Discord's 2,000-character limit
      // when a user pastes a message containing many duplicate URLs at once.
      const MAX_ALERT_LINES = 3;
      const visibleLines = alertLines.slice(0, MAX_ALERT_LINES);
      const overflowCount = alertLines.length - visibleLines.length;
      if (overflowCount > 0) {
        visibleLines.push(`_…and ${overflowCount} more duplicate link(s)._`);
      }

      const notice = await message.reply({
        content: visibleLines.join('\n\n'),
        components: [dismissRow],
        allowedMentions: { repliedUser: false },
      });

      if (config.duplicateLinkAlertTtlSeconds > 0) {
        const timer = setTimeout(() => {
          notice.delete().catch(() => {});
        }, config.duplicateLinkAlertTtlSeconds * 1000);
        timer.unref?.();
      }
    } catch (err) {
      console.error('[Link Detector] Failed to send duplicate alert:', err);
    }
  }

  return {
    hasUrls: true,
    duplicateUrls,
    newUrls,
  };
}
