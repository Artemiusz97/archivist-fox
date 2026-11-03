import { config, isLinkBackupChannel } from './config.js';
import { extractAllUrlsAsync } from './urlExtractor.js';
import {
  findDuplicateLink,
  saveLinkRecord,
  updateLinkRecord,
} from './linkDb.js';
import { buildDuplicateActionRow, formatDiscordAuthor, safeReply } from './utils.js';

export { buildDuplicateActionRow };

/**
 * Checks all URLs in a Discord message for duplicates against the SQLite link database.
 * Sends an alert if a duplicate is found (unless within self-repost grace period).
 * Records new links into the database (`is_backup = 1` for backup channels,
 * `is_backup = 0` for non-backup channels so duplicate detection works everywhere
 * without polluting link exports or `/restore`).
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<{
 *   hasUrls: boolean,
 *   duplicateUrls: Array<{ originalUrl: string, normalizedUrl: string, record: object }>,
 *   newUrls: Array<{ originalUrl: string, normalizedUrl: string }>
 * }>}
 */
export async function processMessageLinks(message) {
  const backupEligible = isLinkBackupChannel(message.channel);
  if (!config.enableGeneralDuplicateDetector && !backupEligible) {
    return { hasUrls: false, duplicateUrls: [], newUrls: [] };
  }

  const urls = await extractAllUrlsAsync(message.content);
  if (urls.length === 0) {
    return { hasUrls: false, duplicateUrls: [], newUrls: [] };
  }

  const authorTag = formatDiscordAuthor(message.author);
  const authorId = message.author?.id || '0';
  const guildId = message.guildId || null;
  const channelId = message.channelId;
  const channelName = message.channel?.name || 'chat';
  const messageId = message.id;
  const postedAt = message.createdTimestamp || Date.now();

  // If general duplicate detector is disabled, silently back up links for backup-eligible channels
  if (!config.enableGeneralDuplicateDetector) {
    const newUrls = [];
    for (const { originalUrl, normalizedUrl } of urls) {
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
        content: message.content || null,
        isBackup: true,
      });
      newUrls.push({ originalUrl, normalizedUrl });
    }
    return { hasUrls: true, duplicateUrls: [], newUrls };
  }

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
      updateLinkRecord(record.id, {
        messageId,
        channelId,
        channelName,
        postedAt,
        content: message.content || null,
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
      // Save link record; mark `isBackup: false` on non-backup channels so
      // duplicate detection works across all active channels while exports remain clean.
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
        content: message.content || null,
        isBackup: backupEligible,
      });
      newUrls.push({ originalUrl, normalizedUrl });
    }
  }

  if (alertLines.length > 0) {
    try {
      const alertRow = buildDuplicateActionRow({
        messageId,
        authorId,
        canDeletePost: newUrls.length === 0,
      });

      const MAX_ALERT_LINES = 3;
      const visibleLines = alertLines.slice(0, MAX_ALERT_LINES);
      const overflowCount = alertLines.length - visibleLines.length;
      if (overflowCount > 0) {
        visibleLines.push(`_…and ${overflowCount} more duplicate link(s)._`);
      }

      const notice = await safeReply(message, {
        content: visibleLines.join('\n\n'),
        components: [alertRow],
        allowedMentions: { repliedUser: false },
      });

      if (config.duplicateLinkAlertTtlSeconds > 0 && notice) {
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

export const checkAndHandleDuplicateLinks = processMessageLinks;
