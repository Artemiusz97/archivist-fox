import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ChannelType } from 'discord.js';
import { config } from './config.js';
import { fetchFlatPlaylistInfo } from './ytdlpDownloader.js';
import { handleMessage } from './mediaHandler.js';
import { isStopRequested } from './scanner.js';
import { scheduleAutoDelete, getHumanJitterMs } from './utils.js';

let activePlaylistJob = false;

export function isPlaylistDownloading() {
  return activePlaylistJob;
}

export async function handlePlaylistPromptAndDownload(message, rawUrl, details, options) {
  let playlistInfo = null;
  let loadingMsg = null;

  try {
    loadingMsg = await message.reply({
      content: '⏳ Fetching YouTube playlist metadata...',
      allowedMentions: { repliedUser: false }
    });

    const targetUrl = `https://www.youtube.com/playlist?list=${details.listId}`;
    playlistInfo = await fetchFlatPlaylistInfo(targetUrl, config.maxPlaylistItems);
    
    if (!playlistInfo || !playlistInfo.entries || playlistInfo.entries.length === 0) {
      throw new Error('Playlist is empty or unavailable.');
    }
  } catch (err) {
    console.error('[Playlist] Failed to fetch playlist info:', err);
    if (loadingMsg) {
      await loadingMsg.edit('❌ Failed to fetch playlist information. Proceeding with single video download...').catch(() => {});
      scheduleAutoDelete(loadingMsg, 5000);
    }
    // Fallback to single video download if applicable, else exit
    if (details.isVideoWithPlaylist) {
      return await handleMessage(message, { ...options, ignorePlaylists: true });
    }
    return { found: 0, uploaded: 0, failed: 1 };
  }

  const count = playlistInfo.entries.length;
  const title = playlistInfo.title || 'Unknown Playlist';
  const sessionId = Date.now().toString();

  const row = new ActionRowBuilder();
  let promptContent = '';

  if (details.isVideoWithPlaylist) {
    promptContent = `🎬 **YouTube Video & Playlist Detected**\nThis video is part of the playlist **"${title}"** (${count} videos).\n\nWould you like to download just this video, or archive the entire playlist?`;
    row.addComponents(
      new ButtonBuilder().setCustomId(`pl_vid_${sessionId}`).setLabel('This Video Only').setStyle(ButtonStyle.Primary).setEmoji('🎬'),
      new ButtonBuilder().setCustomId(`pl_all_${sessionId}`).setLabel(`Entire Playlist (${count})`).setStyle(ButtonStyle.Success).setEmoji('📁'),
      new ButtonBuilder().setCustomId(`pl_cancel_${sessionId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );
  } else {
    promptContent = `📁 **YouTube Playlist Detected**\nPlaylist **"${title}"** contains ${count} videos.\n\nWould you like to download and archive this entire playlist?`;
    row.addComponents(
      new ButtonBuilder().setCustomId(`pl_all_${sessionId}`).setLabel(`Download Playlist (${count})`).setStyle(ButtonStyle.Success).setEmoji('📁'),
      new ButtonBuilder().setCustomId(`pl_cancel_${sessionId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );
  }

  const promptMsg = await loadingMsg.edit({
    content: promptContent,
    components: [row]
  }).catch(() => null);

  if (!promptMsg) {
    return { found: 0, uploaded: 0, failed: 0 };
  }

  try {
    const confirmation = await promptMsg.awaitMessageComponent({
      filter: (i) => {
        const isAuthor = i.user.id === message.author.id;
        const isMod = i.memberPermissions?.has(8n) || i.memberPermissions?.has(8192n); // Admin or Manage Messages
        if (isAuthor || isMod) return true;
        i.reply({ content: '❌ Only the person who posted this link or a moderator can make this choice.', ephemeral: true }).catch(() => {});
        return false;
      },
      componentType: ComponentType.Button,
      time: config.playlistPromptTimeoutSeconds * 1000
    });

    if (confirmation.customId === `pl_vid_${sessionId}`) {
      await confirmation.update({ content: '🎬 Downloading single video...', components: [] }).catch(() => {});
      scheduleAutoDelete(promptMsg, 3000);
      return await handleMessage(message, { ...options, ignorePlaylists: true });
    } else if (confirmation.customId === `pl_all_${sessionId}`) {
      await confirmation.update({ content: `📁 Starting playlist download: **"${title}"** (${count} videos)...`, components: [] }).catch(() => {});
      return await downloadAndPostPlaylist(message, playlistInfo, options);
    } else {
      await confirmation.update({ content: '❌ Playlist download cancelled.', components: [] }).catch(() => {});
      scheduleAutoDelete(promptMsg, 5000);
      return { found: 0, uploaded: 0, failed: 0 };
    }
  } catch (err) {
    // Timeout
    if (details.isVideoWithPlaylist) {
      await promptMsg.edit({ content: '⏳ No selection made. Defaulting to downloading this video only...', components: [] }).catch(() => {});
      scheduleAutoDelete(promptMsg, 3000);
      return await handleMessage(message, { ...options, ignorePlaylists: true });
    } else {
      await promptMsg.edit({ content: '⏳ Playlist confirmation timed out.', components: [] }).catch(() => {});
      scheduleAutoDelete(promptMsg, 5000);
      return { found: 0, uploaded: 0, failed: 0 };
    }
  }
}

async function downloadAndPostPlaylist(message, playlistInfo, options) {
  activePlaylistJob = true;
  let targetChannel = null;

  if (config.playlistAutoThread && !message.channel.isThread() && message.channel.type !== ChannelType.DM) {
    try {
      targetChannel = await message.startThread({
        name: `📁 ${playlistInfo.title || 'Playlist'}`.slice(0, 100),
        autoArchiveDuration: 60,
      });
    } catch (threadErr) {
      console.warn('[Playlist] Could not create thread, falling back to channel:', threadErr.message);
    }
  }

  let successCount = 0;
  let failCount = 0;

  try {
    for (const [index, entry] of playlistInfo.entries.entries()) {
      if (isStopRequested()) {
        await (targetChannel || message.channel).send('🛑 Playlist download aborted by user.').catch(() => null);
        break;
      }

      if (!entry.id && !entry.url) {
        failCount++;
        continue;
      }

      const videoUrl = entry.url || `https://www.youtube.com/watch?v=${entry.id}`;
      
      // Create a mock message to reuse the existing pipeline cleanly
      const mockMessage = Object.create(message);
      mockMessage.content = videoUrl;
      mockMessage.channel = message.channel;
      // We intercept the reply method for the mock message so if safeReply is called without overrideChannel, it doesn't double-reply to the original prompt
      mockMessage.reply = (opts) => (targetChannel || message.channel).send(opts);

      const result = await handleMessage(mockMessage, { ...options, ignorePlaylists: true, overrideChannel: targetChannel });
      
      if (result && result.uploaded > 0) {
        successCount += result.uploaded;
      } else {
        failCount++;
      }

      if (index < playlistInfo.entries.length - 1 && !isStopRequested()) {
        const jitter = getHumanJitterMs(1500, 3000);
        await new Promise(r => setTimeout(r, jitter));
      }
    }
  } finally {
    activePlaylistJob = false;
    await (targetChannel || message.channel).send(`✅ **Playlist Complete:** ${successCount} uploaded, ${failCount} failed or skipped.`).catch(() => {});
  }
  
  return { found: playlistInfo.entries.length, uploaded: successCount, failed: failCount };
}
