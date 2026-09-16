import { spawn } from 'node:child_process';
import { config } from './config.js';
import { downloadQueue } from './queue.js';
import { isScanRunning } from './scanner.js';

function runUpdateCommand(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';

      child.stdout.on('data', (d) => (output += d.toString()));
      child.stderr.on('data', (d) => (output += d.toString()));

      child.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      child.on('close', (code) => {
        resolve({ success: code === 0, output: output.trim() });
      });
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

export async function checkAndApplyUpdates() {
  if ((downloadQueue && downloadQueue.running > 0) || isScanRunning()) {
    console.log(
      `[AutoUpdater] Active tasks in progress (queue: ${downloadQueue?.running || 0}, scanActive: ${isScanRunning()}). Deferring binary update for 2 minutes...`
    );
    setTimeout(() => checkAndApplyUpdates().catch(() => {}), 2 * 60 * 1000);
    return;
  }

  console.log('[AutoUpdater] Checking for yt-dlp and gallery-dl updates in background...');

  // 1. Update yt-dlp
  try {
    const ytdlpResult = await runUpdateCommand(config.ytdlpPath, ['-U', '--no-check-certificates']);
    if (ytdlpResult.success) {
      console.log(`[AutoUpdater] yt-dlp: ${ytdlpResult.output || 'Up to date.'}`);
    } else if (ytdlpResult.error) {
      console.warn(`[AutoUpdater] yt-dlp update notice: ${ytdlpResult.error}`);
    }
  } catch (err) {
    console.warn('[AutoUpdater] yt-dlp update failed:', err.message);
  }

  // 2. Update gallery-dl
  try {
    if (config.usePythonGalleryDl) {
      const gdlPipResult = await runUpdateCommand('python3', ['-m', 'pip', 'install', '-U', 'gallery-dl']);
      if (gdlPipResult.success) {
        console.log('[AutoUpdater] gallery-dl (Python package) updated successfully.');
      }
    } else {
      const gdlResult = await runUpdateCommand(config.gallerydlPath, ['--update']);
      if (gdlResult.success) {
        console.log(`[AutoUpdater] gallery-dl: ${gdlResult.output || 'Up to date.'}`);
      }
    }
  } catch (err) {
    console.warn('[AutoUpdater] gallery-dl update failed:', err.message);
  }
}

/**
 * Initializes the background recurring updater service.
 */
export function initAutoUpdater() {
  if (!config.enableAutoUpdateBinaries) {
    console.log('[AutoUpdater] Auto-updating binaries is disabled in .env');
    return;
  }

  const intervalMs = config.autoUpdateIntervalHours * 60 * 60 * 1000;
  console.log(`[AutoUpdater] Scheduled binary updates every ${config.autoUpdateIntervalHours} hour(s).`);

  // Run initial check 60 seconds after bot boot to allow smooth startup
  setTimeout(() => {
    checkAndApplyUpdates().catch(() => {});
  }, 60 * 1000);

  // Set recurring interval timer
  const timer = setInterval(() => {
    checkAndApplyUpdates().catch(() => {});
  }, intervalMs);

  timer.unref?.();
}
