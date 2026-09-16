import { config } from './config.js';

class DownloadQueue {
  constructor(concurrency = 2, maxDepth = 50) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    // Maximum number of tasks that may wait in the queue at once.
    // Tasks beyond this limit are rejected gracefully to protect against memory
    // exhaustion from link floods or rapid bulk posting.
    this.maxDepth = maxDepth;
  }

  /**
   * Enqueues a message for media processing with live Method 3 status indicators.
   *
   * @param {import('discord.js').Message} message
   * @param {(statusHook: { onStatus: (status: 'downloading'|'compressing'|'done') => Promise<void> }) => Promise<any>} taskFn
   * @returns {Promise<any>}
   */
  async add(message, taskFn) {
    // Guard against queue flooding: reject new tasks when the pending queue is saturated.
    if (this.queue.length >= this.maxDepth) {
      const notice = await message.reply({
        content: '⚠️ The download queue is currently full. Please try again in a moment.',
        allowedMentions: { repliedUser: false },
      }).catch(() => null);
      // Auto-delete the notice after 15 seconds if error TTL is not configured
      if (notice) {
        const ttl = (config.errorMessageTtlMs > 0 ? config.errorMessageTtlMs : 15000);
        const timer = setTimeout(() => notice.delete().catch(() => {}), ttl);
        timer.unref?.();
      }
      return { found: 0, uploaded: 0, failed: 0, dropped: true };
    }

    let queuedReaction = null;

    // If queue is busy, react with ⏳ while waiting
    if (this.running >= this.concurrency) {
      queuedReaction = await message.react('⏳').catch(() => null);
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        message,
        taskFn,
        queuedReaction,
        resolve,
        reject,
      });

      this.processNext();
    });
  }

  /**
   * Clears any pending queued messages that have not yet started.
   *
   * @returns {number} The number of tasks cleared.
   */
  clear() {
    const count = this.queue.length;
    for (const item of this.queue) {
      if (item.queuedReaction) {
        const botUserId = item.message.client?.user?.id;
        item.message.reactions?.resolve(item.queuedReaction)?.users?.remove(botUserId).catch(() => {});
      }
      item.resolve({ found: 0, uploaded: 0, failed: 0, stopped: true });
    }
    this.queue = [];
    return count;
  }

  async processNext() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.running++;
    const item = this.queue.shift();
    const { message, taskFn, queuedReaction, resolve, reject } = item;

    const activeReactions = new Map();
    let typingInterval = null;

    const removeBotReaction = async (reactionOrEmoji) => {
      try {
        if (!reactionOrEmoji) return;
        const botUserId = message.client?.user?.id;
        if (typeof reactionOrEmoji === 'string') {
          const reaction =
            message.reactions?.cache?.find((r) => r.emoji?.name === reactionOrEmoji) ||
            message.reactions?.cache?.get(reactionOrEmoji) ||
            message.reactions?.resolve(reactionOrEmoji);
          if (reaction) {
            await reaction.users.remove(botUserId).catch(() => {});
          }
        } else if (reactionOrEmoji.users) {
          await reactionOrEmoji.users.remove(botUserId).catch(() => {});
        }
      } catch {}
    };

    const cleanupReactions = async () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }

      // Remove queued reaction if still present
      if (queuedReaction) {
        await removeBotReaction(queuedReaction);
      }

      // Remove all progress reactions added during execution
      for (const emoji of ['⏳', '📥', '⚙️']) {
        const storedReaction = activeReactions.get(emoji);
        if (storedReaction) {
          await removeBotReaction(storedReaction);
        }
        await removeBotReaction(emoji);
      }
    };

    const onStatus = async (status) => {
      try {
        if (status === 'downloading') {
          if (queuedReaction) {
            await removeBotReaction(queuedReaction);
          }
          const prevCompress = activeReactions.get('⚙️');
          if (prevCompress) {
            await removeBotReaction(prevCompress);
            activeReactions.delete('⚙️');
          }
          const react = await message.react('📥').catch(() => null);
          if (react) activeReactions.set('📥', react);
        } else if (status === 'compressing') {
          const prevDownload = activeReactions.get('📥');
          if (prevDownload) {
            await removeBotReaction(prevDownload);
            activeReactions.delete('📥');
          }
          const react = await message.react('⚙️').catch(() => null);
          if (react) activeReactions.set('⚙️', react);
        }
      } catch {}
    };

    try {
      if (queuedReaction) {
        await removeBotReaction(queuedReaction);
      }

      await onStatus('downloading');

      // Native typing indicator heartbeat
      message.channel?.sendTyping?.().catch(() => {});
      typingInterval = setInterval(() => {
        message.channel?.sendTyping?.().catch(() => {});
      }, 8000);
      typingInterval.unref?.();

      const result = await taskFn({ onStatus });
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      await cleanupReactions();
      this.running--;
      this.processNext();
    }
  }
}

export const downloadQueue = new DownloadQueue(config.maxConcurrentDownloads || 2, config.maxQueueDepth || 50);
