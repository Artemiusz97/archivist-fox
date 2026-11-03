import { config } from './config.js';
import { isAbortError } from './utils.js';

export class DownloadQueue {
  constructor(concurrency = 2, maxDepth = 50) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.activeTasks = new Set();
    // Maximum number of tasks that may wait in the queue at once.
    // Tasks beyond this limit are rejected gracefully to protect against memory
    // exhaustion from link floods or rapid bulk posting.
    this.maxDepth = maxDepth;
  }

  /**
   * Enqueues a message for media processing with live Method 3 status indicators.
   *
   * @param {import('discord.js').Message} message
   * @param {(statusHook: { onStatus: (status: 'downloading'|'compressing'|'done') => Promise<void>, signal: AbortSignal }) => Promise<any>} taskFn
   * @param {{ silent?: boolean }} [options={}]
   * @returns {Promise<any>}
   */
  async add(message, taskFn, options = {}) {
    const silent = Boolean(options?.silent);
    // Guard against queue flooding: reject new tasks when the pending queue is saturated.
    if (this.queue.length >= this.maxDepth) {
      if (!silent) {
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
      }
      return { found: 0, archived: 0, uploaded: 0, failed: 0, dropped: true };
    }

    return new Promise((resolve, reject) => {
      const item = {
        message,
        taskFn,
        silent,
        queuedReaction: null,
        reactionPromise: null,
        resolve,
        reject,
      };

      // Enqueue synchronously BEFORE awaiting Discord's REST reaction so
      // concurrent callers cannot bypass maxDepth or invert FIFO arrival order.
      if (!silent && this.running >= this.concurrency) {
        item.reactionPromise = Promise.resolve(message.react?.('⏳'))
          .then((r) => {
            item.queuedReaction = r || null;
            return item.queuedReaction;
          })
          .catch(() => null);
      }

      this.queue.push(item);
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
      const removeQueued = (reaction) => {
        if (!reaction) return;
        try {
          const botUserId = item.message.client?.user?.id;
          if (reaction.users) {
            reaction.users.remove(botUserId).catch(() => {});
          } else if (typeof item.message.reactions?.resolve === 'function') {
            item.message.reactions.resolve(reaction)?.users?.remove(botUserId).catch(() => {});
          }
        } catch {}
      };
      if (item.queuedReaction) {
        removeQueued(item.queuedReaction);
      } else if (item.reactionPromise) {
        item.reactionPromise.then(removeQueued).catch(() => {});
      }
      item.resolve({ found: 0, uploaded: 0, failed: 0, stopped: true });
    }
    this.queue = [];
    return count;
  }

  /**
   * Aborts all downloads currently in progress and clears all pending queued tasks.
   *
   * @returns {{ activeStopped: number, queueCleared: number }}
   */
  stopAll() {
    const activeCount = this.activeTasks.size;
    for (const active of this.activeTasks) {
      try {
        active.abortController.abort();
      } catch {}
      // Remove reactions eagerly for immediate UI responsiveness
      active.cleanupReactions().catch(() => {});
    }

    const queueCleared = this.clear();

    return {
      activeStopped: activeCount,
      queueCleared,
    };
  }

  /**
   * Returns the count of downloads currently running in progress.
   *
   * @returns {number}
   */
  getActiveCount() {
    return this.activeTasks.size;
  }

  /**
   * Returns the count of tasks waiting in the queue.
   *
   * @returns {number}
   */
  getDepth() {
    return this.queue.length;
  }

  async processNext() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.running++;
    const item = this.queue.shift();
    const { message, taskFn, resolve, reject } = item;

    const activeReactions = new Map();
    let typingInterval = null;

    const getQueuedReaction = async () => {
      if (item.queuedReaction) return item.queuedReaction;
      if (item.reactionPromise) return await item.reactionPromise.catch(() => null);
      return null;
    };

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
      const qr = await getQueuedReaction();
      if (qr) {
        await removeBotReaction(qr);
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

    const abortController = new AbortController();
    const activeTask = {
      message,
      abortController,
      cleanupReactions,
    };
    this.activeTasks.add(activeTask);

    const onStatus = async (status) => {
      if (item.silent) return;
      try {
        if (abortController.signal.aborted) return;
        if (status === 'downloading') {
          const qr = await getQueuedReaction();
          if (qr) {
            await removeBotReaction(qr);
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
      const qr = await getQueuedReaction();
      if (qr) {
        await removeBotReaction(qr);
      }

      if (!item.silent) {
        await onStatus('downloading');

        // Native typing indicator heartbeat
        message.channel?.sendTyping?.().catch(() => {});
        typingInterval = setInterval(() => {
          message.channel?.sendTyping?.().catch(() => {});
        }, 8000);
        typingInterval.unref?.();
      }

      const result = await taskFn({ onStatus, signal: abortController.signal });
      resolve(result);
    } catch (err) {
      if (isAbortError(err) || abortController.signal.aborted) {
        resolve({ found: 0, archived: 0, uploaded: 0, failed: 0, stopped: true });
      } else {
        reject(err);
      }
    } finally {
      this.activeTasks.delete(activeTask);
      try {
        await cleanupReactions();
      } catch {}
      this.running--;
      this.processNext();
    }
  }
}

export const downloadQueue = new DownloadQueue(config.maxConcurrentDownloads || 3, config.maxQueueDepth || 50);
