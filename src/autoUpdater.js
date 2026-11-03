import { config } from './config.js';
import { downloadQueue } from './queue.js';
import { isScanRunning } from './scanner.js';
import { runProcess, PYTHON_BIN } from './utils.js';

async function runUpdateCommand(cmd, args) {
  try {
    const { code, stdout, stderr } = await runProcess(cmd, args, {
      timeoutMs: 2 * 60 * 1000,
      registerProcess: false,
      rejectOnNonZero: false,
    });
    const combined = `${stdout}\n${stderr}`.trim();
    return code === 0
      ? { success: true, output: combined }
      : { success: false, error: combined || `Exited with code ${code}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function checkAndApplyUpdates() {
  if ((downloadQueue && downloadQueue.running > 0) || isScanRunning()) {
    console.log(
      `[AutoUpdater] Active tasks in progress (queue: ${downloadQueue?.running || 0}, scanActive: ${isScanRunning()}). Deferring binary update for 2 minutes...`
    );
    const deferTimer = setTimeout(() => checkAndApplyUpdates().catch(() => {}), 2 * 60 * 1000);
    deferTimer.unref?.();
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
      const gdlPipResult = await runUpdateCommand(PYTHON_BIN, ['-m', 'pip', 'install', '-U', 'gallery-dl']);
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
  const initialTimer = setTimeout(() => {
    checkAndApplyUpdates().catch(() => {});
  }, 60 * 1000);
  initialTimer.unref?.();

  // Set recurring interval timer
  const timer = setInterval(() => {
    checkAndApplyUpdates().catch(() => {});
  }, intervalMs);

  timer.unref?.();
}
