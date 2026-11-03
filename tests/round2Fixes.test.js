import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { config } from '../src/config.js';
import {
  getBrowserHeaders,
  getHumanJitterMs,
  isPartialTempFile,
  isCookieLockError,
  validateSsrfTarget,
  runProcess,
  paceDomainRequest,
} from '../src/utils.js';
import { mergeOrphanedAudioVideo } from '../src/streamMerge.js';
import { downloadDirect } from '../src/directDownloader.js';
import { hammingDistance } from '../src/phasher.js';
import { buildYtDlpAuthArgs, buildYtDlpArgs } from '../src/ytdlpDownloader.js';
import { initLinkDb, closeLinkDb, backupDatabaseSafely } from '../src/linkDb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Round 2 Audit Fixes, Architecture & Anti-Bot Human Mimicry', () => {
  let configSnapshot = {};

  before(() => {
    configSnapshot = { ...config };
  });

  after(() => {
    Object.assign(config, configSnapshot);
    closeLinkDb();
  });

  describe('1. Stream Merge Data-Preservation & Windows Overwrite (src/streamMerge.js)', () => {
    it('merges orphaned video+audio while preserving already-muxed clips, sidecars, and overwriting pre-existing target', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-mux-test-'));
      try {
        const videoOnly = path.join(tempDir, 'clip.f137.mp4');
        const audioOnly = path.join(tempDir, 'clip.f140.m4a');
        const alreadyMuxed = path.join(tempDir, 'bonus_muxed.mp4');
        const sidecarImg = path.join(tempDir, 'cover.jpg');
        // Pre-existing target file that would fail fs.rename on Windows if not unlinked
        const expectedMergedPath = path.join(tempDir, 'clip.f137.mp4');

        fs.writeFileSync(videoOnly, 'RAW_VIDEO');
        fs.writeFileSync(audioOnly, 'RAW_AUDIO');
        fs.writeFileSync(alreadyMuxed, 'MUXED_VIDEO_AUDIO');
        fs.writeFileSync(sidecarImg, 'JPEG_DATA');

        const mockProbe = async (file) => {
          if (file === videoOnly) return { hasVideo: true, hasAudio: false };
          if (file === audioOnly) return { hasVideo: false, hasAudio: true };
          if (file === alreadyMuxed) return { hasVideo: true, hasAudio: true };
          return { hasVideo: false, hasAudio: false };
        };

        const mockRunProcess = async (_cmd, args) => {
          const outPath = args[args.length - 1];
          fs.writeFileSync(outPath, 'MERGED_MP4_PAYLOAD');
          return { code: 0, stdout: '', stderr: '' };
        };

        const result = await mergeOrphanedAudioVideo(
          [videoOnly, audioOnly, alreadyMuxed, sidecarImg],
          tempDir,
          { probeMedia: mockProbe, runProcess: mockRunProcess }
        );

        assert.strictEqual(result.length, 3, 'Must return merged file + alreadyMuxed + sidecarImg');
        assert.ok(result.includes(expectedMergedPath), 'Must include merged output path');
        assert.ok(result.includes(alreadyMuxed), 'Must retain already-muxed clip (no data loss)');
        assert.ok(result.includes(sidecarImg), 'Must retain non-AV sidecar image');
        assert.strictEqual(
          fs.readFileSync(expectedMergedPath, 'utf-8'),
          'MERGED_MP4_PAYLOAD',
          'Pre-existing target path must be cleanly replaced with merged output'
        );
        assert.strictEqual(fs.existsSync(audioOnly), false, 'Orphaned audio stream must be cleaned up');
        assert.strictEqual(fs.existsSync(alreadyMuxed), true, 'Already-muxed clip must remain on disk');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('2. Browser Header Impersonation, Referer & Retry-After (src/utils.js, src/directDownloader.js)', () => {
    it('emits Sec-CH-UA strictly for Chromium families and omits it for Firefox/Safari', () => {
      const chromeHeaders = getBrowserHeaders('chrome', 'https://example.com/file.mp4');
      assert.ok(chromeHeaders['Sec-CH-UA']?.includes('Google Chrome'));
      assert.strictEqual(chromeHeaders['Sec-CH-UA-Mobile'], '?0');

      const edgeHeaders = getBrowserHeaders('edge', 'https://example.com/file.mp4');
      assert.ok(edgeHeaders['Sec-CH-UA']?.includes('Microsoft Edge'));

      const firefoxHeaders = getBrowserHeaders('firefox', 'https://example.com/file.mp4');
      assert.ok(firefoxHeaders['User-Agent'].includes('Firefox'));
      assert.strictEqual(firefoxHeaders['Sec-CH-UA'], undefined, 'Firefox never sends Sec-CH-UA');
      assert.strictEqual(firefoxHeaders['Sec-CH-UA-Platform'], undefined);

      const safariHeaders = getBrowserHeaders('safari', 'https://example.com/file.mp4');
      assert.ok(safariHeaders['User-Agent'].includes('Safari'));
      assert.strictEqual(safariHeaders['Sec-CH-UA'], undefined, 'Safari never sends Sec-CH-UA');
    });

    it('injects anti-hotlinking Referer headers for Pixiv, Bilibili, Twitter/X, and Reddit CDNs', () => {
      assert.strictEqual(
        getBrowserHeaders('https://i.pximg.net/img-original/img/123_p0.png').Referer,
        'https://www.pixiv.net/'
      );
      assert.strictEqual(
        getBrowserHeaders('https://i0.hdslb.com/bfs/archive/sample.jpg').Referer,
        'https://www.bilibili.com/'
      );
      assert.strictEqual(
        getBrowserHeaders('https://pbs.twimg.com/media/sample.jpg').Referer,
        'https://x.com/'
      );
      assert.strictEqual(
        getBrowserHeaders('https://i.redd.it/sample123.png').Referer,
        'https://www.reddit.com/'
      );
    });

    it('blocks loopback SSRF by default and sends realistic headers + parses HTTP 429 Retry-After in downloadDirect', async () => {
      // Production SSRF behavior (without allowLoopback: true) must strictly block 127.0.0.1
      await assert.rejects(
        () => validateSsrfTarget('http://127.0.0.1:8080/internal'),
        /SSRF_BLOCKED/
      );

      let capturedHeaders = null;
      const mockServer = http.createServer((req, res) => {
        capturedHeaders = req.headers;
        if (req.url === '/rate-limited.jpg') {
          res.writeHead(429, { 'Retry-After': '7', 'Content-Type': 'text/plain' });
          res.end('Too Many Requests');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(Buffer.from('MOCK_JPEG_BYTES'));
      });

      await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
      const { port } = mockServer.address();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-direct-test-'));

      try {
        const savedPath = await downloadDirect(
          `http://127.0.0.1:${port}/artwork.jpg`,
          tempDir,
          10 * 1024 * 1024,
          { allowLoopback: true, referer: 'https://www.pixiv.net/' }
        );
        assert.ok(fs.existsSync(savedPath));
        assert.ok(
          !String(capturedHeaders['user-agent'] || '').includes('ArchivistFox'),
          'Must never send bot User-Agent'
        );
        assert.ok(String(capturedHeaders['user-agent'] || '').includes('Mozilla/5.0'));
        assert.strictEqual(capturedHeaders.referer, 'https://www.pixiv.net/');

        await assert.rejects(
          async () => {
            await downloadDirect(
              `http://127.0.0.1:${port}/rate-limited.jpg`,
              tempDir,
              10 * 1024 * 1024,
              { allowLoopback: true }
            );
          },
          (err) => {
            assert.strictEqual(err.statusCode, 429);
            assert.strictEqual(err.retryAfterMs, 7000);
            return true;
          }
        );
      } finally {
        await new Promise((resolve) => mockServer.close(resolve));
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('3. Log-Normal Human Jitter, Domain Pacing & SWAR Popcount (src/utils.js, src/phasher.js)', () => {
    it('samples right-skewed human jitter strictly within [minMs, maxMs] and returns 0 when disabled', () => {
      config.enableHumanJitter = true;
      for (let i = 0; i < 200; i++) {
        const val = getHumanJitterMs(400, 800);
        assert.ok(val >= 400 && val <= 800, `Expected jitter in [400, 800], got ${val}`);
      }

      config.enableHumanJitter = false;
      assert.strictEqual(getHumanJitterMs(400, 800), 0);
      config.enableHumanJitter = true;
    });

    it('computes exact 64-bit SWAR popcount while preserving flat-frame and malformed guards', () => {
      // Exact 64-bit inverse pairs (non-blank frames) -> distance 64
      assert.strictEqual(hammingDistance('aaaaaaaaaaaaaaaa', '5555555555555555'), 64);
      assert.strictEqual(hammingDistance('123456789abcdef0', 'edcba9876543210f'), 64);

      // Single-bit flips on upper and lower 32-bit halves -> distance 1
      assert.strictEqual(hammingDistance('1000000000000000', '1000000000000001'), 1);
      assert.strictEqual(hammingDistance('9000000000000000', '1000000000000000'), 1);

      // Identical non-flat hash -> distance 0
      assert.strictEqual(hammingDistance('123456789abcdef0', '123456789abcdef0'), 0);

      // Malformed hex, flat blank/white frames, short/null -> Infinity
      assert.strictEqual(hammingDistance('not_hex_chars_!!', '123456789abcdef0'), Infinity);
      assert.strictEqual(hammingDistance('0000000000000000', '123456789abcdef0'), Infinity);
      assert.strictEqual(hammingDistance('ffffffffffffffff', '123456789abcdef0'), Infinity);
      assert.strictEqual(hammingDistance(null, '123456789abcdef0'), Infinity);
      assert.strictEqual(hammingDistance('abc', 'def'), Infinity);
    });

    it('honors AbortSignal immediately in paceDomainRequest when forced', async () => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => paceDomainRequest('https://cdn.example.test/a.mp4', controller.signal, { force: true }),
        /DOWNLOAD_ABORTED/
      );
    });
  });

  describe('4. Partial Temp Artifact Safeguards & Browser Cookie Lock Fallback (src/utils.js, src/ytdlpDownloader.js)', () => {
    it('flags .part, .ytdl, .temp, and .f137 chunks while strictly preserving .flac and .flv media', () => {
      assert.strictEqual(isPartialTempFile('video.mp4.part'), true);
      assert.strictEqual(isPartialTempFile('video.ytdl'), true);
      assert.strictEqual(isPartialTempFile('clip.temp'), true);
      assert.strictEqual(isPartialTempFile('stream.f137'), true);
      assert.strictEqual(isPartialTempFile('stream.F251'), true);

      assert.strictEqual(isPartialTempFile('lossless_track.flac'), false, '.flac must never be purged');
      assert.strictEqual(isPartialTempFile('legacy_stream.flv'), false, '.flv must never be purged');
      assert.strictEqual(isPartialTempFile('final_video.mp4'), false);
      assert.strictEqual(isPartialTempFile('podcast.mp3'), false);
    });

    it('omits --cookies-from-browser when disableBrowserCookies is set and detects SQLite lock errors', () => {
      config.cookiesFromBrowser = 'chrome';
      config.preferBrowserCookies = true;

      const normalArgs = buildYtDlpAuthArgs('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      assert.ok(normalArgs.includes('--cookies-from-browser'));

      const fallbackArgs = buildYtDlpAuthArgs('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
        disableBrowserCookies: true,
      });
      assert.strictEqual(
        fallbackArgs.includes('--cookies-from-browser'),
        false,
        'Cookie-lock retry must omit --cookies-from-browser'
      );

      const sleepArgs = buildYtDlpArgs('https://www.youtube.com/watch?v=dQw4w9WgXcQ', os.tmpdir(), {
        sleepRequests: '0.75',
      });
      const sleepIdx = sleepArgs.indexOf('--sleep-requests');
      assert.ok(sleepIdx !== -1 && sleepArgs[sleepIdx + 1] === '0.75');

      assert.strictEqual(
        isCookieLockError(new Error('ERROR: Could not copy Chrome cookie database')),
        true
      );
      assert.strictEqual(isCookieLockError(new Error('sqlite3.OperationalError: database is locked')), true);
      assert.strictEqual(isCookieLockError(new Error('HTTP Error 404: Not Found')), false);
    });
  });

  describe('5. SQLite WAL busy_timeout, Safe Backup & Deduplicate Script (src/linkDb.js, scripts/deduplicate_archive.js)', () => {
    it('configures PRAGMA busy_timeout >= 5000 on disk DBs and updates relative_path with forward slashes in deduplicate_archive.js', async () => {
      const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-dedup-test-'));
      const tempArchive = path.join(tempWorkspace, 'archives');
      const musicDir = path.join(tempArchive, 'music');
      const tempDbPath = path.join(tempWorkspace, 'data', 'links.db');
      fs.mkdirSync(musicDir, { recursive: true });

      try {
        closeLinkDb();
        const db = initLinkDb(tempDbPath);

        const timeoutRow = db.prepare('PRAGMA busy_timeout').get();
        const timeoutVal = Number(Object.values(timeoutRow || {})[0] || 0);
        assert.ok(timeoutVal >= 5000, `Expected busy_timeout >= 5000, got ${timeoutVal}`);

        // Verify safe backup helper
        const manualBackup = path.join(tempWorkspace, 'manual-backup.db');
        backupDatabaseSafely(db, manualBackup);
        assert.ok(fs.existsSync(manualBackup), 'backupDatabaseSafely must produce valid DB snapshot');

        // Seed canonical + timestamped duplicate files and sidecar metadata
        const canonicalMedia = path.join(musicDir, 'song.mp3');
        const canonicalJson = `${canonicalMedia}.json`;
        const dupMedia = path.join(musicDir, 'song_2026-01-01T00-00-00Z.mp3');
        const dupJson = `${dupMedia}.json`;

        fs.writeFileSync(canonicalMedia, 'CANONICAL_MP3_DATA');
        fs.writeFileSync(
          canonicalJson,
          JSON.stringify({
            mediaId: 'yt:abc123xyz',
            originalUrl: 'https://youtu.be/abc123xyz',
            archivedAt: '2026-01-01T00:00:00.000Z',
            fileName: 'song.mp3',
          })
        );

        fs.writeFileSync(dupMedia, 'DUPLICATE_MP3_DATA');
        fs.writeFileSync(
          dupJson,
          JSON.stringify({
            mediaId: 'yt:abc123xyz',
            originalUrl: 'https://youtu.be/abc123xyz',
            archivedAt: '2026-01-02T00:00:00.000Z',
            fileName: 'song_2026-01-01T00-00-00Z.mp3',
          })
        );

        // Seed DB record pointing at the old duplicate filename & backslash path
        db.prepare(
          `INSERT INTO media_records (media_id, original_url, channel, file_name, relative_path)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          'yt:abc123xyz',
          'https://youtu.be/abc123xyz',
          'music',
          'song_2026-01-01T00-00-00Z.mp3',
          'music\\song_2026-01-01T00-00-00Z.mp3'
        );

        closeLinkDb();

        const scriptPath = path.resolve(__dirname, '../scripts/deduplicate_archive.js');
        await runProcess(process.execPath, [scriptPath, musicDir], {
          env: {
            ...process.env,
            NODE_ENV: 'test',
            ARCHIVE_DIRECTORY: tempArchive,
            LINK_DB_PATH: tempDbPath,
          },
        });

        assert.strictEqual(fs.existsSync(canonicalMedia), true, 'Canonical media must be preserved');
        assert.strictEqual(fs.existsSync(dupMedia), false, 'Duplicate media must be unlinked');
        assert.strictEqual(fs.existsSync(dupJson), false, 'Duplicate sidecar JSON must be unlinked');

        const verifyDb = new DatabaseSync(tempDbPath);
        try {
          const updated = verifyDb
            .prepare('SELECT file_name, relative_path FROM media_records WHERE media_id = ?')
            .get('yt:abc123xyz');
          assert.strictEqual(updated.file_name, 'song.mp3');
          assert.strictEqual(
            updated.relative_path,
            'music/song.mp3',
            'relative_path must be updated and normalized with forward slashes'
          );
        } finally {
          verifyDb.close();
        }
      } finally {
        closeLinkDb();
        fs.rmSync(tempWorkspace, { recursive: true, force: true });
      }
    });
  });

  describe('6. Acyclic DAG Module Topology (mediaHandler, scanner, playlistHandler)', () => {
    it('resolves static imports cleanly with zero dynamic cycle workarounds', async () => {
      const mediaHandlerMod = await import('../src/mediaHandler.js');
      const scannerMod = await import('../src/scanner.js');
      const playlistMod = await import('../src/playlistHandler.js');

      assert.strictEqual(typeof mediaHandlerMod.handleMessage, 'function');
      assert.strictEqual(typeof scannerMod.crawlChannel, 'function');
      assert.strictEqual(typeof scannerMod.runStartupScan, 'function');
      assert.strictEqual(typeof scannerMod.isStopRequested, 'function');
      assert.strictEqual(typeof playlistMod.handlePlaylistPromptAndDownload, 'function');

      const mediaHandlerSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/mediaHandler.js'),
        'utf-8'
      );
      assert.strictEqual(
        mediaHandlerSrc.includes("import('./playlistHandler.js')"),
        false,
        'Dynamic import cycle workaround must be eliminated from mediaHandler.js'
      );
    });
  });
});
