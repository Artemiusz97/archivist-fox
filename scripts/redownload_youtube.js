#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import {
  parseUpgradeCliArgs,
  resolveUpgradeCookieSource,
  buildUpgradeYtDlpArgs,
  parseRemoteFormatInfo,
  inspectRemoteBestQuality,
  probeVideoQuality,
  evaluateQualityUpgrade,
  upgradeYoutubeArchive,
} from '../src/youtubeUpgrader.js';

export {
  parseUpgradeCliArgs,
  resolveUpgradeCookieSource,
  buildUpgradeYtDlpArgs,
  parseRemoteFormatInfo,
  inspectRemoteBestQuality,
  probeVideoQuality,
  evaluateQualityUpgrade,
  upgradeYoutubeArchive,
};

function printHelp() {
  console.log(`
Archivist Fox — YouTube Highest Resolution & Premium Bitrate Upgrade Utility

Usage:
  npm run redownload-youtube -- [options]
  node scripts/redownload_youtube.js [options]

Options:
  --dry-run, -d                   Audit archived YouTube videos for higher resolution/bitrate without modifying files
  --premium, --upgrade-bitrate    Check all archived YouTube videos for higher resolution & Premium bitrate (default)
  --low-res-only                  Fast local filter: only upgrade videos stored at <= 360p
  --force, -f                     Force re-downloading and replacing even if resolution/bitrate already matches
  --limit <N>, -l <N>             Stop after finding/upgrading N eligible videos
  --channel <name>, -c <name>     Only process videos from a specific channel folder
  --url <url>, -u <url>           Upgrade a single specific video by YouTube URL or ID
  --max-res <height>, -m <height> Optional max resolution cap (e.g. 1080, 1440). Default: 0 (uncapped 4K/8K + highest bitrate)
  --concurrency <N>, -P <N>       Parallel metadata inspection workers (default: 5, max: 16)
  --fragments <N>, -N <N>         Concurrent connection fragments per stream (default: 4)
  --min-bitrate-gain <pct>        Minimum % bitrate increase required to replace same-resolution video (default: 5)
  --backup, -b                    Keep previous video file as <filename>.bak before replacing
  --cookies-from-browser, -C <br> Browser to read YouTube Premium cookies from (firefox, chrome, edge, brave). Default: ${config.cookiesFromBrowser || 'auto'}
  --no-browser-cookies            Disable browser cookie extraction and use cookies/youtube.txt instead
  --cookies <file>                Explicit path to a Netscape-format cookies.txt file
  --delay <ms>                    Delay between video downloads in milliseconds (default: 1500ms)
  --help, -h                      Show this help message

Examples:
  # Preview all YouTube videos that have higher resolution (4K) or YouTube Premium Enhanced Bitrate available:
  npm run redownload-youtube -- --dry-run -C firefox

  # Upgrade all eligible YouTube videos to highest resolution & highest bitrate with 8 parallel fragments:
  npm run redownload-youtube -- -C firefox -N 8

  # Upgrade using an exported Netscape cookie file (e.g. cookies/youtube.txt):
  npm run redownload-youtube -- --cookies cookies/youtube.txt -N 8
  `);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const cliOptions = parseUpgradeCliArgs(process.argv.slice(2));
  if (cliOptions.showHelp) {
    printHelp();
    process.exit(0);
  }

  upgradeYoutubeArchive(cliOptions).catch((err) => {
    console.error('Fatal upgrade error:', err.message || err);
    process.exit(1);
  });
}
