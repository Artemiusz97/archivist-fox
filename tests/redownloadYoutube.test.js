import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { config, withConfigOverrides } from '../src/config.js';
import { initLinkDb, closeLinkDb } from '../src/linkDb.js';
import { saveRecordBatch } from '../src/db.js';
import { computeSha256 } from '../src/phasher.js';
import {
  parseUpgradeCliArgs,
  buildUpgradeYtDlpArgs,
  parseRemoteFormatInfo,
  inspectRemoteBestQuality,
  evaluateQualityUpgrade,
  upgradeYoutubeArchive,
} from '../src/youtubeUpgrader.js';
import { runProcess } from '../src/utils.js';

function createEncodedVideo(outputPath, { width = 1920, height = 1080, duration = 2, videoKbps = 300, audioKbps = 96 } = {}) {
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc2=duration=${duration}:size=${width}x${height}:rate=24`,
    '-f', 'lavfi',
    '-i', `anoisesrc=duration=${duration}:color=white`,
    '-vf', 'noise=alls=60:allf=t',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-b:v', `${videoKbps}k`,
    '-minrate', `${videoKbps}k`,
    '-maxrate', `${videoKbps}k`,
    '-bufsize', `${videoKbps * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', `${audioKbps}k`,
    outputPath,
  ];
  const res = spawnSync(config.ffmpegPath, args, { stdio: 'ignore' });
  if (res.status !== 0) {
    throw new Error(`Failed to generate test video at ${outputPath}`);
  }
}

function createMp3WithCoverArt(outputPath) {
  const dir = path.dirname(outputPath);
  const coverPath = path.join(dir, 'cover_tmp.jpg');
  spawnSync(
    config.ffmpegPath,
    ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=600x600:d=1', '-frames:v', '1', coverPath],
    { stdio: 'ignore' }
  );
  const res = spawnSync(
    config.ffmpegPath,
    [
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=880:duration=1',
      '-i', coverPath,
      '-map', '0:a',
      '-map', '1:v',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-c:v', 'copy',
      '-id3v2_version', '3',
      '-disposition:v:0', 'attached_pic',
      outputPath,
    ],
    { stdio: 'ignore' }
  );
  fs.rmSync(coverPath, { force: true });
  if (res.status !== 0) {
    throw new Error(`Failed to generate MP3 with cover art at ${outputPath}`);
  }
}

describe('YouTube Highest Resolution & Premium Bitrate Upgrader', () => {
  describe('CLI Argument Parsing & Cookie / Format Precedence', () => {
    it('defaults to full resolution + bitrate upgrade mode and configures -f bv*+ba/b -S res,br,fps', () => {
      const parsed = parseUpgradeCliArgs([]);
      assert.strictEqual(parsed.lowResOnly, false, 'Must inspect all resolutions for higher bitrate/res by default');
      assert.strictEqual(parsed.maxRes, 0);
      assert.strictEqual(parsed.concurrency, 5, 'Should default to 5 parallel inspection workers');

      const customConcurrency = parseUpgradeCliArgs(['-P', '8']);
      assert.strictEqual(customConcurrency.concurrency, 8);

      const args = buildUpgradeYtDlpArgs('https://www.youtube.com/watch?v=abc123XYZ00', '/tmp/out.%(ext)s', parsed);
      const fIdx = args.indexOf('-f');
      assert.strictEqual(args[fIdx + 1], 'bv*+ba/b');

      const sIdx = args.indexOf('-S');
      assert.strictEqual(args[sIdx + 1], 'res,br,fps');

      const extIdx = args.indexOf('--extractor-args');
      assert.notStrictEqual(extIdx, -1);
      assert.strictEqual(
        args[extIdx + 1],
        'youtube:player_client=web,default;skip=translated_subs',
        'Must strip auto-translated caption bloat in a single youtube extractor-args value while preserving player_client=web,default'
      );

      const capped = parseUpgradeCliArgs(['--max-res', '1080', '--premium']);
      const cappedArgs = buildUpgradeYtDlpArgs('https://www.youtube.com/watch?v=abc123XYZ00', '/tmp/out.%(ext)s', capped);
      const cappedF = cappedArgs[cappedArgs.indexOf('-f') + 1];
      assert.strictEqual(
        cappedF,
        'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
        'Capped resolution must still allow VP9/Opus Premium streams instead of restricting to ext=mp4'
      );
      assert.strictEqual(cappedArgs[cappedArgs.indexOf('-S') + 1], 'res,br,fps');
    });

    it('honors explicit -C browser cookies over fallback cookies.txt and supports --no-browser-cookies', () => {
      const tmpCookies = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-upg-cookies-'));
      const rootCookieFile = path.join(tmpCookies, 'cookies.txt');
      const vaultDir = path.join(tmpCookies, 'vault');
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(rootCookieFile, '# Netscape HTTP Cookie File\n');
      fs.writeFileSync(path.join(vaultDir, 'youtube.txt'), '# Vault YouTube Cookie\n');

      try {
        withConfigOverrides(
          {
            cookiesPath: rootCookieFile,
            cookiesDir: vaultDir,
            cookiesFromBrowser: 'firefox',
            preferBrowserCookies: true,
          },
          () => {
            // 1. Explicit -C chrome MUST win even when config.cookiesPath exists on disk
            const cliBrowserOpts = parseUpgradeCliArgs(['-C', 'chrome']);
            const argsBrowser = buildUpgradeYtDlpArgs('https://www.youtube.com/watch?v=abc123XYZ00', '/tmp/o', cliBrowserOpts);
            assert.strictEqual(argsBrowser.includes('--cookies'), false, 'Fallback cookies.txt must not shadow explicit -C chrome');
            const cbIdx = argsBrowser.indexOf('--cookies-from-browser');
            assert.notStrictEqual(cbIdx, -1);
            assert.strictEqual(argsBrowser[cbIdx + 1], 'chrome');

            // 2. Explicit --cookies <path> MUST win over config.cookiesFromBrowser
            const customCookie = path.join(tmpCookies, 'custom.txt');
            fs.writeFileSync(customCookie, '# Custom Cookie\n');
            const cliFileOpts = parseUpgradeCliArgs(['--cookies', customCookie]);
            const argsFile = buildUpgradeYtDlpArgs('https://www.youtube.com/watch?v=abc123XYZ00', '/tmp/o', cliFileOpts);
            assert.strictEqual(argsFile.includes('--cookies-from-browser'), false);
            assert.strictEqual(argsFile[argsFile.indexOf('--cookies') + 1], customCookie);

            // 3. --no-browser-cookies falls back to cookieVault (cookies/youtube.txt)
            const noBrowserOpts = parseUpgradeCliArgs(['--no-browser-cookies']);
            const argsVault = buildUpgradeYtDlpArgs('https://www.youtube.com/watch?v=abc123XYZ00', '/tmp/o', noBrowserOpts);
            assert.strictEqual(argsVault.includes('--cookies-from-browser'), false);
            assert.ok(argsVault[argsVault.indexOf('--cookies') + 1].endsWith('youtube.txt'));

            // 4. Cached per-worker cookie file + impersonateBrowserHint keeps Firefox TLS/UA fingerprint
            const cachedArgs = buildUpgradeYtDlpArgs('https://www.youtube.com/watch?v=abc123XYZ00', '/tmp/o', {
              cookiesFile: customCookie,
              noBrowserCookies: true,
              impersonateBrowserHint: 'firefox',
            });
            assert.strictEqual(cachedArgs.includes('--cookies-from-browser'), false);
            assert.strictEqual(cachedArgs[cachedArgs.indexOf('--cookies') + 1], customCookie);
            assert.strictEqual(cachedArgs[cachedArgs.indexOf('--impersonate') + 1], 'firefox');
            assert.ok(cachedArgs[cachedArgs.indexOf('--user-agent') + 1].includes('Firefox'));
          }
        );
      } finally {
        fs.rmSync(tmpCookies, { recursive: true, force: true });
      }
    });
  });

  describe('Remote Metadata Parsing & Quality Upgrade Evaluation', () => {
    it('parses merged video+audio streams, bitrates, format IDs, and YouTube Premium flags from yt-dlp JSON', () => {
      const remote = parseRemoteFormatInfo({
        duration: 180,
        requested_formats: [
          {
            format_id: '356',
            format_note: '1080p Premium',
            width: 1920,
            height: 1080,
            vbr: 4120,
            vcodec: 'vp9',
          },
          {
            format_id: '774',
            format_note: 'medium, Premium',
            abr: 256,
            acodec: 'opus',
          },
        ],
      });

      assert.strictEqual(remote.width, 1920);
      assert.strictEqual(remote.height, 1080);
      assert.strictEqual(remote.videoBitrateKbps, 4120);
      assert.strictEqual(remote.audioBitrateKbps, 256);
      assert.strictEqual(remote.totalBitrateKbps, 4376);
      assert.strictEqual(remote.formatId, '356+774');
      assert.strictEqual(remote.isPremium, true);
    });

    it('inspectRemoteBestQuality streams >3 MB YouTube JSON with 120+ caption URLs through real runProcess without head-truncation', async () => {
      const script = [
        'const captions = {};',
        'for (let i = 0; i < 140; i++) {',
        '  captions["lang_" + i] = [{ url: "https://www.youtube.com/api/timedtext?v=iAu-123&lang=sq&fmt=srv3&signature=0" + "x".repeat(25000) }];',
        '}',
        'process.stdout.write(JSON.stringify({',
        '  id: "iAu-123",',
        '  title: "She’s so silly, I love her 😭 ｜｜ #genshinimpact #genshinshorts",',
        '  duration: 60,',
        '  width: 1080,',
        '  height: 1920,',
        '  automatic_captions: captions,',
        '  requested_formats: [',
        '    { format_id: "356", format_note: "1080p Premium", width: 1080, height: 1920, vbr: 4120, vcodec: "vp9" },',
        '    { format_id: "774", format_note: "medium, Premium", abr: 256, acodec: "opus" }',
        '  ]',
        '}));',
      ].join(' ');

      let capturedArgs = [];
      let capturedOpts = null;
      const result = await inspectRemoteBestQuality('https://www.youtube.com/shorts/iAu-123', {
        noBrowserCookies: true,
        execFn: (_cmd, args, opts) => {
          capturedArgs = args;
          capturedOpts = opts;
          return runProcess(process.execPath, ['-e', script], opts);
        },
      });

      assert.strictEqual(capturedOpts?.rollingBuffer, false);
      assert.strictEqual(capturedOpts?.maxBufferBytes, 32 * 1024 * 1024);
      assert.strictEqual(
        capturedArgs[capturedArgs.indexOf('--extractor-args') + 1],
        'youtube:player_client=web,default;skip=translated_subs'
      );
      assert.strictEqual(result.width, 1080);
      assert.strictEqual(result.height, 1920);
      assert.strictEqual(result.formatId, '356+774');
      assert.strictEqual(result.isPremium, true);
    });

    it('upgrades higher resolution, higher video bitrate (1080p -> 1080p Premium), and higher audio bitrate while rejecting noise and downgrades', () => {
      // 1. Resolution upgrade (360p -> 1080p)
      const resUpgrade = evaluateQualityUpgrade(
        { width: 640, height: 360, totalBitrateKbps: 750, audioBitrateKbps: 96 },
        { width: 1920, height: 1080, totalBitrateKbps: 2200, audioBitrateKbps: 128 }
      );
      assert.deepStrictEqual(resUpgrade, { upgrade: true, reason: 'higher_resolution' });

      // 2. Same-resolution bitrate upgrade (1080p Standard -> 1080p Premium)
      const premiumBitrateUpgrade = evaluateQualityUpgrade(
        { width: 1920, height: 1080, totalBitrateKbps: 1850, audioBitrateKbps: 128 },
        { width: 1920, height: 1080, totalBitrateKbps: 4250, audioBitrateKbps: 256 }
      );
      assert.deepStrictEqual(premiumBitrateUpgrade, { upgrade: true, reason: 'higher_bitrate' });

      // 3. 4K video where total bitrate gain is < 5% (18000 -> 18128 kbps) but audio jumps 128 -> 256 kbps Premium Opus
      const premiumAudioUpgrade = evaluateQualityUpgrade(
        { width: 3840, height: 2160, totalBitrateKbps: 18000, audioBitrateKbps: 128 },
        { width: 3840, height: 2160, totalBitrateKbps: 18128, audioBitrateKbps: 256 }
      );
      assert.deepStrictEqual(premiumAudioUpgrade, { upgrade: true, reason: 'higher_audio_bitrate' });

      // 4. Same resolution & < 5% muxing jitter -> skip
      const muxNoise = evaluateQualityUpgrade(
        { width: 1920, height: 1080, totalBitrateKbps: 2200, audioBitrateKbps: 128 },
        { width: 1920, height: 1080, totalBitrateKbps: 2245, audioBitrateKbps: 132 }
      );
      assert.deepStrictEqual(muxNoise, { upgrade: false, reason: 'already_optimal' });

      // 5. Never downgrade 4K to 1080p even if --max-res 1080 was passed
      const downgradeGuard = evaluateQualityUpgrade(
        { width: 3840, height: 2160, totalBitrateKbps: 15000, audioBitrateKbps: 128 },
        { width: 1920, height: 1080, totalBitrateKbps: 4200, audioBitrateKbps: 256 }
      );
      assert.deepStrictEqual(downgradeGuard, { upgrade: false, reason: 'lower_resolution' });
    });
  });

  describe('End-to-End Archive Upgrade Integration (Real FFmpeg/FFprobe & Isolated SQLite)', () => {
    let tempRoot = '';
    let archiveDir = '';
    let dbPath = '';

    beforeEach(() => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-yt-upgrade-'));
      archiveDir = path.join(tempRoot, 'archives');
      dbPath = path.join(tempRoot, 'data', 'links.db');
      fs.mkdirSync(path.join(archiveDir, 'videos'), { recursive: true });
    });

    afterEach(() => {
      closeLinkDb();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('upgrades existing 1080p videos to higher bitrate in-place without clobbering colliding stems, skips optimal & MP3 files, and is idempotent', async () => {
      const clip1Path = path.join(archiveDir, 'videos', 'Clip.mp4');
      const clip2Path = path.join(archiveDir, 'videos', 'Clip_dup1.mp4');
      const optimalPath = path.join(archiveDir, 'videos', 'AlreadyOptimal.mp4');
      const songPath = path.join(archiveDir, 'videos', 'Track.mp3');

      // Generate real encoded media files
      createEncodedVideo(clip1Path, { width: 1920, height: 1080, duration: 2, videoKbps: 250, audioKbps: 96 });
      createEncodedVideo(clip2Path, { width: 1920, height: 1080, duration: 2, videoKbps: 260, audioKbps: 96 });
      createEncodedVideo(optimalPath, { width: 1920, height: 1080, duration: 2, videoKbps: 2400, audioKbps: 192 });
      createMp3WithCoverArt(songPath);

      for (const [fp, mediaId, url] of [
        [clip1Path, 'youtube:vid11111111', 'https://www.youtube.com/watch?v=vid11111111'],
        [clip2Path, 'youtube:vid22222222', 'https://www.youtube.com/watch?v=vid22222222'],
        [optimalPath, 'youtube:vid33333333', 'https://www.youtube.com/watch?v=vid33333333'],
        [songPath, 'youtube:aud44444444', 'https://music.youtube.com/watch?v=aud44444444'],
      ]) {
        const stat = fs.statSync(fp);
        const sha = await computeSha256(fp);
        fs.writeFileSync(
          `${fp}.json`,
          JSON.stringify(
            {
              title: path.parse(fp).name,
              mediaId,
              originalUrl: url,
              channel: 'videos',
              fileName: path.basename(fp),
              relativePath: `videos/${path.basename(fp)}`,
              fileSizeBytes: stat.size,
              sha256: sha,
            },
            null,
            2
          )
        );
      }

      // Populate isolated SQLite database using real schema
      await withConfigOverrides({ archiveDirectory: archiveDir, linkDbPath: dbPath }, async () => {
        closeLinkDb();
        initLinkDb(dbPath);
        await saveRecordBatch([
          {
            mediaId: 'youtube:vid11111111',
            sha256: await computeSha256(clip1Path),
            duration: 2,
            hash: '1111222233334444',
            originalUrl: 'https://www.youtube.com/watch?v=vid11111111',
            title: 'Clip',
            postedBy: 'alice',
            channel: 'videos',
            archivedAt: '2026-09-01T00:00:00.000Z',
            fileName: 'Clip.mp4',
            relativePath: 'videos/Clip.mp4',
            fileSize: fs.statSync(clip1Path).size,
          },
          {
            mediaId: 'youtube:vid22222222',
            sha256: await computeSha256(clip2Path),
            duration: 2,
            hash: '5555666677778888',
            originalUrl: 'https://www.youtube.com/watch?v=vid22222222',
            title: 'Clip',
            postedBy: 'bob',
            channel: 'videos',
            archivedAt: '2026-09-02T00:00:00.000Z',
            fileName: 'Clip_dup1.mp4',
            relativePath: 'videos/Clip_dup1.mp4',
            fileSize: fs.statSync(clip2Path).size,
          },
          {
            mediaId: 'youtube:vid33333333',
            sha256: await computeSha256(optimalPath),
            duration: 2,
            hash: '9999aaaabbbbcccc',
            originalUrl: 'https://www.youtube.com/watch?v=vid33333333',
            title: 'AlreadyOptimal',
            postedBy: 'carol',
            channel: 'videos',
            archivedAt: '2026-09-03T00:00:00.000Z',
            fileName: 'AlreadyOptimal.mp4',
            relativePath: 'videos/AlreadyOptimal.mp4',
            fileSize: fs.statSync(optimalPath).size,
          },
          {
            mediaId: 'youtube:aud44444444',
            sha256: await computeSha256(songPath),
            duration: 1,
            hash: null,
            originalUrl: 'https://music.youtube.com/watch?v=aud44444444',
            title: 'Track',
            postedBy: 'dave',
            channel: 'videos',
            archivedAt: '2026-09-04T00:00:00.000Z',
            fileName: 'Track.mp3',
            relativePath: 'videos/Track.mp3',
            fileSize: fs.statSync(songPath).size,
          },
        ]);
        closeLinkDb();
      });

      const downloadedUrls = [];
      const inspectFn = async (url) => {
        if (url.includes('vid11111111') || url.includes('vid22222222')) {
          return {
            width: 1920,
            height: 1080,
            videoBitrateKbps: 2200,
            audioBitrateKbps: 256,
            totalBitrateKbps: 2456,
            formatId: '356+774',
            formatNote: '1080p Premium+medium',
            isPremium: true,
          };
        }
        // vid33333333 is already ~2592 kbps locally; remote has ~2550 kbps -> should skip without downloading!
        return {
          width: 1920,
          height: 1080,
          videoBitrateKbps: 2360,
          audioBitrateKbps: 192,
          totalBitrateKbps: 2552,
          formatId: '137+251',
          formatNote: '1080p+medium',
          isPremium: false,
        };
      };

      const downloadFn = async (url, tempDir) => {
        downloadedUrls.push(url);
        // Both vid11111111 and vid22222222 download as "Clip.mp4" inside tempDir (same YouTube title!)
        const outFile = path.join(tempDir, 'Clip.mp4');
        const targetKbps = url.includes('vid11111111') ? 2100 : 2300;
        createEncodedVideo(outFile, { width: 1920, height: 1080, duration: 2, videoKbps: targetKbps, audioKbps: 192 });
        return {
          code: 0,
          filePath: outFile,
          remoteInfo: await inspectFn(url),
        };
      };

      const oldClip1Sha = await computeSha256(clip1Path);
      const oldClip2Sha = await computeSha256(clip2Path);
      const oldOptimalSha = await computeSha256(optimalPath);

      // 1. Dry-run preview must identify exact 2 upgrade candidates and touch zero files
      const dryStats = await upgradeYoutubeArchive({
        archiveDir,
        dbPath,
        dryRun: true,
        delayMs: 0,
        inspectFn,
        downloadFn,
        silent: true,
      });

      assert.strictEqual(dryStats.candidatesCount, 2, 'Dry-run must detect both 1080p Premium bitrate upgrade candidates');
      assert.strictEqual(dryStats.upgradedCount, 0);
      assert.strictEqual(downloadedUrls.length, 0, 'Dry-run must never download media streams');
      assert.strictEqual(await computeSha256(clip1Path), oldClip1Sha);

      // 2. Live upgrade with --backup must upgrade both 1080p clips in-place without colliding, and skip AlreadyOptimal + MP3
      const liveStats = await upgradeYoutubeArchive({
        archiveDir,
        dbPath,
        dryRun: false,
        keepBackup: true,
        delayMs: 0,
        inspectFn,
        downloadFn,
        silent: true,
      });

      assert.strictEqual(liveStats.upgradedCount, 2);
      assert.strictEqual(liveStats.failedCount, 0);
      assert.deepStrictEqual(downloadedUrls, [
        'https://www.youtube.com/watch?v=vid11111111',
        'https://www.youtube.com/watch?v=vid22222222',
      ]);

      // Verify both files still exist distinctly and neither clobbered the other
      const newClip1Sha = await computeSha256(clip1Path);
      const newClip2Sha = await computeSha256(clip2Path);
      assert.notStrictEqual(newClip1Sha, oldClip1Sha);
      assert.notStrictEqual(newClip2Sha, oldClip2Sha);
      assert.notStrictEqual(newClip1Sha, newClip2Sha, 'Colliding YouTube titles must preserve distinct archive stems');
      assert.strictEqual(await computeSha256(optimalPath), oldOptimalSha, 'Already-optimal video must remain untouched');
      assert.ok(fs.existsSync(`${clip1Path}.bak`), 'Should preserve .bak backup when keepBackup=true');
      assert.ok(fs.existsSync(`${clip2Path}.bak`), 'Should preserve .bak backup for second clip');

      // Verify sidecar JSON metadata
      const clip2Meta = JSON.parse(fs.readFileSync(`${clip2Path}.json`, 'utf8'));
      assert.strictEqual(clip2Meta.fileName, 'Clip_dup1.mp4');
      assert.strictEqual(clip2Meta.sha256, newClip2Sha);
      assert.strictEqual(clip2Meta.ytdlpFormatId, '356+774');
      assert.strictEqual(clip2Meta.isPremiumFormat, true);
      assert.ok(clip2Meta.upgradedBitrateKbps > 1500);

      // Verify SQLite records were updated accurately
      const verifyDb = new DatabaseSync(dbPath);
      const rows = verifyDb.prepare('SELECT media_id, file_name, relative_path, sha256, file_size FROM media_records ORDER BY id ASC').all();
      verifyDb.close();

      assert.strictEqual(rows[0].file_name, 'Clip.mp4');
      assert.strictEqual(rows[0].sha256, newClip1Sha);
      assert.strictEqual(rows[0].file_size, fs.statSync(clip1Path).size);

      assert.strictEqual(rows[1].file_name, 'Clip_dup1.mp4');
      assert.strictEqual(rows[1].relative_path, 'videos/Clip_dup1.mp4');
      assert.strictEqual(rows[1].sha256, newClip2Sha);

      // 3. Re-running live upgrade must be idempotent (0 upgrades, 0 downloads)
      downloadedUrls.length = 0;
      const rerunStats = await upgradeYoutubeArchive({
        archiveDir,
        dbPath,
        dryRun: false,
        delayMs: 0,
        inspectFn,
        downloadFn,
        silent: true,
      });
      assert.strictEqual(rerunStats.upgradedCount, 0);
      assert.strictEqual(downloadedUrls.length, 0, 'Idempotent re-run must skip already-upgraded videos before downloading');
    });

    it('runs scripts/redownload_youtube.js CLI cleanly against isolated environment without touching workspace DB', async () => {
      await withConfigOverrides({ archiveDirectory: archiveDir, linkDbPath: dbPath }, async () => {
        closeLinkDb();
        initLinkDb(dbPath);
        closeLinkDb();
      });

      const cliRes = spawnSync(
        process.execPath,
        ['--use-system-ca', path.resolve('scripts/redownload_youtube.js'), '--dry-run'],
        {
          env: {
            ...process.env,
            ARCHIVE_DIRECTORY: archiveDir,
            LINK_DB_PATH: dbPath,
          },
          encoding: 'utf8',
        }
      );

      assert.strictEqual(cliRes.status, 0, `CLI exited with non-zero status: ${cliRes.stderr}`);
      assert.ok(cliRes.stdout.includes('DRY-RUN'), 'CLI stdout should display DRY-RUN mode');
    });

    it('inspects videos in parallel, exports browser cookies once into isolated per-worker files, emits progress, and cleans up temp cookies', async () => {
      const chanDir = path.join(archiveDir, 'videos');
      fs.mkdirSync(chanDir, { recursive: true });

      const samplePath = path.join(chanDir, 'Base.mp4');
      createEncodedVideo(samplePath, { width: 1280, height: 720, duration: 1, videoKbps: 300, audioKbps: 96 });

      const recordsToInsert = [];
      for (let i = 1; i <= 6; i++) {
        const vidPath = path.join(chanDir, `Vid_${i}.mp4`);
        fs.copyFileSync(samplePath, vidPath);
        recordsToInsert.push({
          mediaId: `youtube:par0000000${i}`,
          originalUrl: `https://www.youtube.com/watch?v=par0000000${i}`,
          title: `Parallel Clip ${i}`,
          channel: 'videos',
          archivedAt: `2026-10-0${i}T00:00:00.000Z`,
          sha256: await computeSha256(vidPath),
          fileName: `Vid_${i}.mp4`,
          relativePath: `videos/Vid_${i}.mp4`,
          fileSize: fs.statSync(vidPath).size,
        });
      }
      fs.unlinkSync(samplePath);

      await withConfigOverrides({ archiveDirectory: archiveDir, linkDbPath: dbPath }, async () => {
        closeLinkDb();
        initLinkDb(dbPath);
        saveRecordBatch(recordsToInsert);
        closeLinkDb();
      });

      let cookieExportCalls = 0;
      let exportedCookieDir = null;
      const cookieExportFn = async (browser, targetFile) => {
        cookieExportCalls++;
        exportedCookieDir = path.dirname(targetFile);
        assert.strictEqual(browser, 'firefox');
        fs.writeFileSync(targetFile, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\ttest\n', 'utf8');
        return { ok: true };
      };

      let activeInspections = 0;
      let peakConcurrency = 0;
      const seenWorkerCookieFiles = new Set();
      const progressEvents = [];

      const inspectFn = async (url, opts) => {
        activeInspections++;
        peakConcurrency = Math.max(peakConcurrency, activeInspections);
        assert.strictEqual(opts.impersonateBrowserHint, 'firefox');
        assert.ok(opts.cookiesFile && fs.existsSync(opts.cookiesFile), 'Worker must receive existing cached cookie file');
        seenWorkerCookieFiles.add(opts.cookiesFile);

        await new Promise((r) => setTimeout(r, 45));
        activeInspections--;

        const idx = Number(url.slice(-1));
        return {
          width: 1920,
          height: 1080,
          videoBitrateKbps: 2500 + idx,
          audioBitrateKbps: 256,
          totalBitrateKbps: 2756 + idx,
          formatId: '356+774',
          formatNote: '1080p Premium+medium',
          isPremium: true,
        };
      };

      const stats = await upgradeYoutubeArchive({
        archiveDir,
        dbPath,
        dryRun: true,
        concurrency: 3,
        cookiesFromBrowser: 'firefox',
        cookieExportFn,
        inspectFn,
        onProgress: (ev) => progressEvents.push(ev),
        silent: true,
      });

      assert.strictEqual(cookieExportCalls, 1, 'Browser cookie DB must be exported only ONCE per run');
      assert.ok(peakConcurrency >= 2 && peakConcurrency <= 3, `Expected parallel concurrency 2..3, observed ${peakConcurrency}`);
      assert.ok(seenWorkerCookieFiles.size >= 2, 'Parallel workers must use isolated per-worker cookie files');
      assert.strictEqual(stats.inspectedCount, 6);
      assert.strictEqual(stats.candidatesCount, 6);
      assert.ok(progressEvents.length >= 6, 'Should emit progress updates as records complete');
      assert.strictEqual(progressEvents.at(-1).checked, 6);
      assert.strictEqual(progressEvents.at(-1).total, 6);
      assert.strictEqual(fs.existsSync(exportedCookieDir), false, 'Temp cookie cache directory must be deleted in finally');
    });
  });
});
