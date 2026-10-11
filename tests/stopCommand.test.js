import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isAbortError, sleep, registerDownloadProcess, unregisterDownloadProcess, killAllDownloadProcesses } from '../src/utils.js';
import { DownloadQueue } from '../src/queue.js';
import { stopActiveTasks, setScanRunning } from '../src/scanner.js';
import { getCommandDefinitions } from '../src/commands.js';

describe('stop command & abort handling', () => {
  describe('isAbortError', () => {
    it('correctly identifies various abort and cancellation errors', () => {
      assert.strictEqual(isAbortError(new Error('DOWNLOAD_ABORTED')), true);
      assert.strictEqual(isAbortError({ name: 'AbortError', message: 'The operation was aborted' }), true);
      assert.strictEqual(isAbortError({ code: 'ERR_CANCELED' }), true);
      assert.strictEqual(isAbortError({ code: 'ABORT_ERR' }), true);
      assert.strictEqual(isAbortError(new Error('canceled')), true);
      assert.strictEqual(isAbortError(new Error('Process was terminated: DOWNLOAD_ABORTED')), true);
    });

    it('returns false for standard non-abort errors and falsy inputs', () => {
      assert.strictEqual(isAbortError(null), false);
      assert.strictEqual(isAbortError(undefined), false);
      assert.strictEqual(isAbortError(new Error('ECONNRESET')), false);
      assert.strictEqual(isAbortError(new Error('File not found')), false);
    });
  });

  describe('sleep with abort signal', () => {
    it('resolves after specified milliseconds when not aborted', async () => {
      const start = Date.now();
      await sleep(20);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 15);
    });

    it('rejects immediately when passed an already-aborted signal', async () => {
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(
        async () => {
          await sleep(5000, ac.signal);
        },
        (err) => err.message === 'DOWNLOAD_ABORTED'
      );
    });

    it('rejects immediately when signal aborts during sleep', async () => {
      const ac = new AbortController();
      const sleepPromise = sleep(5000, ac.signal);
      setTimeout(() => ac.abort(), 20);

      await assert.rejects(
        sleepPromise,
        (err) => err.message === 'DOWNLOAD_ABORTED'
      );
    });
  });

  describe('DownloadQueue.stopAll', () => {
    it('aborts active tasks and clears pending queue without unhandled rejections', async () => {
      const queue = new DownloadQueue(2, 10);
      const mockMsg = {
        id: 'msg_1',
        reactions: { cache: new Map() },
        client: { user: { id: 'bot_1' } },
        react: async () => ({ users: { remove: async () => {} } }),
        channel: { sendTyping: async () => {} },
      };

      let task1Started = false;
      let task1Aborted = false;

      // Add a long-running active task
      const p1 = queue.add(mockMsg, async ({ signal }) => {
        task1Started = true;
        await sleep(5000, signal);
        return { found: 1, uploaded: 1, failed: 0 };
      });

      // Add a pending queued item (concurrency is 2, so let's add 2 active + 1 queued)
      let task2Started = false;
      const p2 = queue.add(mockMsg, async ({ signal }) => {
        task2Started = true;
        await sleep(5000, signal);
        return { found: 1, uploaded: 1, failed: 0 };
      });

      const p3 = queue.add(mockMsg, async () => {
        return { found: 1, uploaded: 1, failed: 0 };
      });

      // Wait a moment for active tasks to start
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(task1Started, true);
      assert.strictEqual(task2Started, true);
      assert.strictEqual(queue.getActiveCount(), 2);
      assert.strictEqual(queue.getDepth(), 1);

      // Trigger stopAll()
      const { activeStopped, queueCleared } = queue.stopAll();
      assert.strictEqual(activeStopped, 2);
      assert.strictEqual(queueCleared, 1);

      // Verify tasks resolve with stopped: true rather than rejecting
      const res1 = await p1;
      const res2 = await p2;
      assert.strictEqual(res1.stopped, true);
      assert.strictEqual(res2.stopped, true);

      // Queue should now be empty and inactive
      assert.strictEqual(queue.getActiveCount(), 0);
      assert.strictEqual(queue.getDepth(), 0);
    });
  });

  describe('process tracking & killAllDownloadProcesses', () => {
    it('registers and unregisters download child processes', () => {
      const mockChild = new EventEmitter();
      mockChild.pid = 99999;

      registerDownloadProcess(mockChild);
      unregisterDownloadProcess(mockChild);
      const killed = killAllDownloadProcesses();
      assert.strictEqual(killed, 0);
    });

    it('kills tracked child processes on killAllDownloadProcesses', () => {
      const mockChild = new EventEmitter();
      mockChild.pid = 99999;
      let killed = false;
      mockChild.kill = () => { killed = true; };

      registerDownloadProcess(mockChild);
      const count = killAllDownloadProcesses();
      assert.strictEqual(count, 1);
      assert.strictEqual(killAllDownloadProcesses(), 0);
    });
  });

  describe('stopActiveTasks', () => {
    it('aborts active tasks and returns accurate counts', () => {
      setScanRunning(true);
      const stopped = stopActiveTasks();
      assert.strictEqual(stopped.scanRunning, true);
      assert.strictEqual(typeof stopped.activeDownloadsStopped, 'number');
      assert.strictEqual(typeof stopped.queueItemsCleared, 'number');
      setScanRunning(false);
    });
  });

  describe('/stop command definition', () => {
    it('verifies /stop slash command description includes active downloads', () => {
      const commands = getCommandDefinitions();
      const stopCmd = commands.find((c) => c.name === 'stop');
      assert.ok(stopCmd);
      const json = stopCmd.toJSON();
      assert.strictEqual(json.name, 'stop');
      assert.ok(json.description.toLowerCase().includes('active downloads'));
    });
  });
});
