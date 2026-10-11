#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { probeMediaForGif, generateHighQualityGif } from '../src/gifHandler.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);

/**
 * Recursively scans directory for video files.
 *
 * @param {string} dir
 * @param {string[]} [videoFiles]
 * @returns {Promise<string[]>}
 */
export async function walkDirectory(dir, videoFiles = []) {
  if (!fs.existsSync(dir)) return videoFiles;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(fullPath, videoFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        videoFiles.push(fullPath);
      }
    }
  }
  return videoFiles;
}

/**
 * Scans archive directory for short silent videos and converts them to high-quality GIFs.
 *
 * @param {object} [options]
 * @param {string} [options.targetDir]
 * @param {number} [options.maxDuration]
 * @param {number} [options.fps]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.force]
 * @param {Function} [options.onProgress]
 * @returns {Promise<object>}
 */
export async function convertArchiveToGifs(options = {}) {
  const {
    targetDir = path.resolve(config.archiveDirectory || 'archives'),
    maxDuration = config.gifMaxDurationSeconds || 6,
    fps = config.gifMaxFps || 30,
    dryRun = false,
    force = false,
    onProgress = null,
  } = options;

  const resolvedDir = path.resolve(targetDir);
  const stats = {
    totalScanned: 0,
    candidates: 0,
    alreadyConverted: 0,
    converted: 0,
    ineligibleLong: 0,
    ineligibleAudio: 0,
    failed: 0,
  };

  const videoFiles = await walkDirectory(resolvedDir);
  stats.totalScanned = videoFiles.length;

  for (const videoPath of videoFiles) {
    const dir = path.dirname(videoPath);
    const parsed = path.parse(videoPath);
    const gifPath = path.join(dir, `${parsed.name}.gif`);

    if (fs.existsSync(gifPath) && !force) {
      stats.alreadyConverted++;
      if (onProgress) {
        onProgress({ stage: 'skipped', file: videoPath, reason: 'GIF already exists' });
      }
      continue;
    }

    const probe = await probeMediaForGif(videoPath);
    if (probe.hasAudio) {
      stats.ineligibleAudio++;
      continue;
    }
    if (probe.duration <= 0 || probe.duration > maxDuration) {
      stats.ineligibleLong++;
      continue;
    }

    stats.candidates++;

    if (dryRun) {
      if (onProgress) {
        onProgress({
          stage: 'candidate',
          file: videoPath,
          duration: probe.duration,
          width: probe.width,
          height: probe.height,
        });
      }
      continue;
    }

    try {
      if (onProgress) {
        onProgress({ stage: 'converting', file: videoPath });
      }
      await generateHighQualityGif(videoPath, gifPath, { fps: probe.fps || fps });
      stats.converted++;

      // Update metadata sidecar JSON if it exists
      const metadataPath = `${videoPath}.json`;
      if (fs.existsSync(metadataPath)) {
        try {
          const raw = await fs.promises.readFile(metadataPath, 'utf8');
          const meta = JSON.parse(raw);
          const compName = `${parsed.name}.gif`;
          if (!meta.companionFiles) meta.companionFiles = [];
          if (!meta.companionFiles.includes(compName)) {
            meta.companionFiles.push(compName);
            await fs.promises.writeFile(metadataPath, JSON.stringify(meta, null, 2), 'utf8');
          }
        } catch {}
      }

      if (onProgress) {
        onProgress({ stage: 'converted', file: videoPath, gifPath });
      }
    } catch (err) {
      stats.failed++;
      if (onProgress) {
        onProgress({ stage: 'failed', file: videoPath, error: err.message });
      }
    }
  }

  return stats;
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || args.includes('-d');
  const isForce = args.includes('--force') || args.includes('-f');

  const maxDurationIdx = args.findIndex((a) => a === '--max-duration' || a === '-m');
  const maxDurationVal = maxDurationIdx !== -1 && args[maxDurationIdx + 1] ? Number(args[maxDurationIdx + 1]) : config.gifMaxDurationSeconds || 6;

  const fpsIdx = args.findIndex((a) => a === '--fps');
  const fpsVal = fpsIdx !== -1 && args[fpsIdx + 1] ? Number(args[fpsIdx + 1]) : config.gifMaxFps || 30;

  const explicitDir = args.find((a, i) => !a.startsWith('-') && i !== maxDurationIdx + 1 && i !== fpsIdx + 1);
  const targetDir = explicitDir ? path.resolve(explicitDir) : path.resolve(config.archiveDirectory || 'archives');

  console.log('========================================================');
  console.log('     Archivist Fox - Video to GIF Archive Scanner       ');
  console.log('========================================================');
  console.log(`Target Directory : ${targetDir}`);
  console.log(`Execution Mode   : ${isDryRun ? '🔍 DRY RUN (scan only, no files written)' : '⚡ LIVE (converting candidates to GIF)'}`);
  console.log(`Max Duration     : <= ${maxDurationVal}s`);
  console.log(`Target Framerate : ${fpsVal} fps`);
  console.log(`Force Overwrite  : ${isForce ? 'Yes' : 'No (skips existing GIFs)'}`);
  console.log('--------------------------------------------------------');

  if (!fs.existsSync(targetDir)) {
    console.error(`[Error] Target directory does not exist: ${targetDir}`);
    process.exit(1);
  }

  console.log('Scanning archive files...\n');

  const onProgress = ({ stage, file, gifPath, duration, width, height, error, reason }) => {
    const relFile = path.relative(targetDir, file);
    switch (stage) {
      case 'candidate':
        console.log(`[Found] 🎯 "${relFile}" (${duration.toFixed(1)}s, ${width}x${height}, no audio) -> qualifies for GIF`);
        break;
      case 'converting':
        console.log(`[Processing] 🎨 Converting: "${relFile}"...`);
        break;
      case 'converted':
        console.log(`[Success] ✨ Created: "${path.relative(targetDir, gifPath)}"`);
        break;
      case 'skipped':
        // Only log skipped if verbose or keep output tidy
        break;
      case 'failed':
        console.error(`[Error] ❌ Failed to convert "${relFile}": ${error}`);
        break;
    }
  };

  convertArchiveToGifs({
    targetDir,
    maxDuration: maxDurationVal,
    fps: fpsVal,
    dryRun: isDryRun,
    force: isForce,
    onProgress,
  })
    .then((stats) => {
      console.log('\n========================================================');
      console.log('                 Conversion Summary                     ');
      console.log('========================================================');
      console.log(`Total Videos Scanned : ${stats.totalScanned}`);
      console.log(`Eligible Candidates  : ${stats.candidates}`);
      if (isDryRun) {
        console.log(`Would Convert to GIF : ${stats.candidates}`);
      } else {
        console.log(`Successfully Created : ${stats.converted}`);
      }
      console.log(`Already Had GIFs     : ${stats.alreadyConverted}`);
      console.log(`Ineligible (> ${maxDurationVal}s)  : ${stats.ineligibleLong}`);
      console.log(`Ineligible (Audio)   : ${stats.ineligibleAudio}`);
      if (stats.failed > 0) {
        console.log(`Failed Conversions   : ${stats.failed}`);
      }
      console.log('========================================================');
    })
    .catch((err) => {
      console.error('[Fatal Error]:', err);
      process.exit(1);
    });
}
