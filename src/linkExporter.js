import fs from 'node:fs';
import path from 'node:path';
import { config, normalizeChannelName } from './config.js';
import { getDistinctLinkChannels, getLinksByChannel, getAllLinksGrouped } from './linkDb.js';

/**
 * Sanitizes a filename so channel names with emojis/symbols can be written safely on Windows/Linux/macOS.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  if (!name) return 'channel';
  // Replace illegal filesystem characters with underscore
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'channel';
}

/**
 * Generates human-friendly ISO date string.
 *
 * @param {number} timestampMs
 * @returns {string}
 */
function formatDate(timestampMs) {
  try {
    return new Date(timestampMs).toISOString().replace('T', ' ').substring(0, 19);
  } catch {
    return 'Unknown date';
  }
}

/**
 * Escapes CSV cell values.
 *
 * @param {string} val
 * @returns {string}
 */
function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

/**
 * Exports saved links into portable formats (JSON, Markdown, and CSV).
 *
 * @param {object} options
 * @param {string} [options.channel='all'] - Specific channel name to export, or 'all'
 * @param {'all'|'json'|'markdown'|'csv'} [options.format='all'] - Format(s) to export
 * @param {string} [options.outputDir] - Custom export directory
 * @returns {Promise<{
 *   success: boolean,
 *   totalLinks: number,
 *   channelsExported: string[],
 *   files: string[],
 *   masterJsonPath: string|null,
 *   summary: string
 * }>}
 */
export async function exportLinks(options = {}) {
  const targetChannel = (options.channel || 'all').trim();
  const format = (options.format || 'all').toLowerCase().trim();
  const baseDir = options.outputDir || config.linkBackupDir || path.join(process.cwd(), 'backups', 'links');

  const channelsDir = path.join(baseDir, 'channels');
  const markdownDir = path.join(baseDir, 'markdown');
  const csvDir = path.join(baseDir, 'csv');

  await fs.promises.mkdir(baseDir, { recursive: true });
  if (format === 'all' || format === 'json') {
    await fs.promises.mkdir(channelsDir, { recursive: true });
  }
  if (format === 'all' || format === 'markdown') {
    await fs.promises.mkdir(markdownDir, { recursive: true });
  }
  if (format === 'all' || format === 'csv') {
    await fs.promises.mkdir(csvDir, { recursive: true });
  }

  // Gather links grouped by channel
  let groupedData = {};
  if (targetChannel === 'all') {
    groupedData = getAllLinksGrouped();
  } else {
    // Exact or slug match against available channels
    const distinct = getDistinctLinkChannels();
    const cleanTarget = targetChannel.toLowerCase().replace(/^#/, '');
    const slugTarget = normalizeChannelName(targetChannel);

    const matched = distinct.find((d) => {
      const chName = d.channel_name.toLowerCase().replace(/^#/, '');
      return chName === cleanTarget || (slugTarget && normalizeChannelName(d.channel_name) === slugTarget);
    });

    const actualName = matched ? matched.channel_name : targetChannel;
    const links = getLinksByChannel(actualName);
    if (links.length > 0) {
      groupedData[actualName] = links;
    }
  }

  const channelsExported = Object.keys(groupedData);
  if (channelsExported.length === 0) {
    return {
      success: false,
      totalLinks: 0,
      channelsExported: [],
      files: [],
      masterJsonPath: null,
      summary: targetChannel === 'all'
        ? 'No link records found in the database to export.'
        : `No link records found for channel "${targetChannel}".`,
    };
  }

  let totalLinks = 0;
  const createdFiles = [];
  const exportTimestamp = new Date().toISOString();
  const fileDateStamp = exportTimestamp.replace(/[:.]/g, '-').slice(0, 19);

  // Master JSON container
  const masterJson = {
    version: '1.0.0',
    exported_at: exportTimestamp,
    total_channels: channelsExported.length,
    total_links: 0,
    channels: {},
  };

  for (const channelName of channelsExported) {
    const rawLinks = groupedData[channelName];
    totalLinks += rawLinks.length;

    const formattedLinks = rawLinks.map((r) => ({
      original_url: r.original_url,
      normalized_url: r.normalized_url,
      channel_name: r.channel_name,
      channel_id: r.channel_id,
      author_tag: r.author_tag,
      author_id: r.author_id,
      message_id: r.message_id,
      posted_at: r.posted_at,
      posted_at_iso: formatDate(r.posted_at),
      content: r.content || null,
    }));

    masterJson.channels[channelName] = formattedLinks;
    const safeChannelFile = sanitizeFilename(channelName);

    // 1. Per-channel JSON export
    if (format === 'all' || format === 'json') {
      const channelJsonPath = path.join(channelsDir, `${safeChannelFile}.json`);
      await fs.promises.writeFile(
        channelJsonPath,
        JSON.stringify(
          {
            channel: channelName,
            exported_at: exportTimestamp,
            link_count: formattedLinks.length,
            links: formattedLinks,
          },
          null,
          2
        ),
        'utf8'
      );
      createdFiles.push(channelJsonPath);
    }

    // 2. Per-channel Markdown export
    if (format === 'all' || format === 'markdown') {
      const channelMdPath = path.join(markdownDir, `${safeChannelFile}.md`);
      const mdLines = [
        `# Archive: #${channelName}`,
        `> **Exported:** ${formatDate(Date.now())} | **Total Links:** ${formattedLinks.length}`,
        '',
        '| Date | Author | Link | Description / Context |',
        '|---|---|---|---|',
      ];

      for (const item of formattedLinks) {
        const cleanContent = item.content
          ? item.content.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
          : '';
        const displayContext = cleanContent.length > 80 ? `${cleanContent.slice(0, 77)}...` : cleanContent;
        mdLines.push(
          `| ${item.posted_at_iso} | @${item.author_tag} | [${item.original_url}](<${item.original_url}>) | ${displayContext} |`
        );
      }

      await fs.promises.writeFile(channelMdPath, mdLines.join('\n'), 'utf8');
      createdFiles.push(channelMdPath);
    }

    // 3. Per-channel CSV export
    if (format === 'all' || format === 'csv') {
      const channelCsvPath = path.join(csvDir, `${safeChannelFile}.csv`);
      const csvLines = [
        ['Channel', 'OriginalURL', 'NormalizedURL', 'Author', 'Date', 'MessageContent'].map(escapeCsv).join(','),
      ];

      for (const item of formattedLinks) {
        csvLines.push(
          [
            item.channel_name,
            item.original_url,
            item.normalized_url,
            item.author_tag,
            item.posted_at_iso,
            item.content || '',
          ]
            .map(escapeCsv)
            .join(',')
        );
      }

      await fs.promises.writeFile(channelCsvPath, csvLines.join('\n'), 'utf8');
      createdFiles.push(channelCsvPath);
    }
  }

  masterJson.total_links = totalLinks;

  // Master JSON file (consolidated backup of all channels)
  let masterJsonPath = null;
  if (format === 'all' || format === 'json') {
    masterJsonPath = path.join(baseDir, `links_backup_${fileDateStamp}.json`);
    await fs.promises.writeFile(masterJsonPath, JSON.stringify(masterJson, null, 2), 'utf8');
    createdFiles.push(masterJsonPath);

    // Also update a stable 'latest.json' pointer for effortless single-file sync
    const latestPath = path.join(baseDir, 'latest.json');
    await fs.promises.writeFile(latestPath, JSON.stringify(masterJson, null, 2), 'utf8');
  }

  const summary = `Successfully exported ${totalLinks.toLocaleString()} link(s) across ${channelsExported.length} channel(s) to ${baseDir}`;
  console.log(`[Link Exporter] ${summary}`);

  return {
    success: true,
    totalLinks,
    channelsExported,
    files: createdFiles,
    masterJsonPath,
    summary,
  };
}
