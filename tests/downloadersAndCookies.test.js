import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withConfigOverrides } from '../src/config.js';
import { getCookieForUrl } from '../src/cookieVault.js';
import { getGalleryDlConfigPath, resetGalleryDlConfigCache } from '../src/galleryDlConfig.js';
import { buildYtDlpArgs, downloadWithYtDlp, fetchFlatPlaylistInfo } from '../src/ytdlpDownloader.js';
import { downloadDirect } from '../src/directDownloader.js';
import { downloadPlatformMedia } from '../src/downloaderCore.js';
import { probeMedia, isPrivateIp, runProcess } from '../src/utils.js';

describe('Downloaders, Cookie Precedence, SSRF & Probe Guards (clean-room verification)', () => {
  let tempCookiesDir = '';

  before(() => {
    tempCookiesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-test-cookies-'));
  });

  after(() => {
    fs.rmSync(tempCookiesDir, { recursive: true, force: true });
  });

  describe('cookieVault Domain Mapping', () => {
    it('maps social platform URLs to matching platform cookie files', () => {
      fs.writeFileSync(path.join(tempCookiesDir, 'youtube.txt'), '# Netscape HTTP Cookie File');
      fs.writeFileSync(path.join(tempCookiesDir, 'twitter.txt'), '# Netscape HTTP Cookie File');
      fs.writeFileSync(path.join(tempCookiesDir, 'instagram.txt'), '# Netscape HTTP Cookie File');
      fs.writeFileSync(
        path.join(tempCookiesDir, 'bilibili.txt'),
        '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t1820744486\tbuvid3\tguest_only_token\n'
      );

      withConfigOverrides({ cookiesDir: tempCookiesDir, cookiesPath: null }, () => {
        assert.ok(getCookieForUrl('https://www.youtube.com/watch?v=123')?.endsWith('youtube.txt'));
        assert.ok(getCookieForUrl('https://x.com/user/status/123')?.endsWith('twitter.txt'));
        assert.ok(getCookieForUrl('https://instagram.com/p/123')?.endsWith('instagram.txt'));
        assert.strictEqual(
          getCookieForUrl('https://www.bilibili.com/video/BV1Fb4y1j7cs/'),
          null,
          'Guest-only bilibili.txt without SESSDATA must not be treated as authenticated'
        );
      });

      fs.writeFileSync(
        path.join(tempCookiesDir, 'bilibili.txt'),
        '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t1893456000\tSESSDATA\tmember_sess_token\n'
      );

      withConfigOverrides({ cookiesDir: tempCookiesDir }, () => {
        assert.ok(getCookieForUrl('https://www.youtube.com/watch?v=123')?.endsWith('youtube.txt'));
        assert.ok(getCookieForUrl('https://x.com/user/status/123')?.endsWith('twitter.txt'));
        assert.ok(getCookieForUrl('https://instagram.com/p/123')?.endsWith('instagram.txt'));
        assert.ok(getCookieForUrl('https://b23.tv/BV1Fb4y1j7cs')?.endsWith('bilibili.txt'));
      });
    });

    it('honors alias naming such as x.txt and ig.txt', () => {
      const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-alias-cookies-'));
      fs.writeFileSync(path.join(aliasDir, 'x.txt'), '# Netscape Cookie');
      fs.writeFileSync(path.join(aliasDir, 'ig.txt'), '# Netscape Cookie');

      try {
        withConfigOverrides({ cookiesDir: aliasDir }, () => {
          assert.ok(getCookieForUrl('https://twitter.com/user/1')?.endsWith('x.txt'));
          assert.ok(getCookieForUrl('https://www.instagram.com/reel/1')?.endsWith('ig.txt'));
        });
      } finally {
        fs.rmSync(aliasDir, { recursive: true, force: true });
      }
    });
  });

  describe('galleryDlConfig Browser Cookie Priority', () => {
    it('omits static instagram.cookies when preferBrowserCookies is active with cookiesFromBrowser', async () => {
      fs.writeFileSync(path.join(tempCookiesDir, 'instagram.txt'), '# Netscape Cookie');

      await withConfigOverrides(
        {
          cookiesDir: tempCookiesDir,
          cookiesFromBrowser: 'firefox',
          preferBrowserCookies: true,
        },
        async () => {
          resetGalleryDlConfigCache?.();
          const configPath = await getGalleryDlConfigPath();
          const raw = fs.readFileSync(configPath, 'utf8');
          const parsed = JSON.parse(raw);

          assert.strictEqual(
            parsed.extractor?.instagram?.cookies,
            undefined,
            'instagram.cookies must be omitted so CLI --cookies-from-browser takes precedence'
          );
        }
      );
    });

    it('includes static instagram.cookies when preferBrowserCookies is false', async () => {
      fs.writeFileSync(path.join(tempCookiesDir, 'instagram.txt'), '# Netscape Cookie');

      await withConfigOverrides(
        {
          cookiesDir: tempCookiesDir,
          cookiesFromBrowser: 'firefox',
          preferBrowserCookies: false,
        },
        async () => {
          resetGalleryDlConfigCache?.();
          const configPath = await getGalleryDlConfigPath();
          const raw = fs.readFileSync(configPath, 'utf8');
          const parsed = JSON.parse(raw);

          assert.ok(
            parsed.extractor?.instagram?.cookies?.endsWith('instagram.txt'),
            'Static instagram.cookies must be set when browser cookies are not preferred'
          );
        }
      );
    });
  });

  describe('yt-dlp Argument Builder Invariants', () => {
    it('defaults subtitles to English (en.*,en), supports non-YouTube video platforms, and avoids invalid compat-options', () => {
      withConfigOverrides(
        {
          enableSubtitles: true,
          subtitleLangs: 'en.*,en',
        },
        () => {
          const vimeoArgs = buildYtDlpArgs('https://vimeo.com/12345678', os.tmpdir(), {});
          assert.ok(vimeoArgs.includes('--write-sub'), 'Should extract subtitles for non-YouTube video platforms');
          assert.ok(vimeoArgs.includes('--sub-langs'), 'Should specify --sub-langs');
          assert.ok(!vimeoArgs.includes('no-sub-error'), 'Must never pass nonexistent no-sub-error compat option');

          const subLangsIndex = vimeoArgs.indexOf('--sub-langs');
          assert.strictEqual(vimeoArgs[subLangsIndex + 1], 'en.*,en', 'Subtitle language must default to English');
        }
      );

      withConfigOverrides(
        {
          enableSubtitles: true,
          subtitleLangs: 'all',
          subtitleFormat: 'srt',
        },
        () => {
          const biliSubArgs = buildYtDlpArgs('https://www.bilibili.com/video/BV1Fb4y1j7cs/', os.tmpdir(), {});
          const subIdx = biliSubArgs.indexOf('--sub-langs');
          assert.strictEqual(
            biliSubArgs[subIdx + 1],
            'all,-danmaku,-live_chat',
            'SUBTITLE_LANGS=all must exclude danmaku and live_chat so ffmpeg SubtitlesConvertor never crashes on XML/JSON'
          );
        }
      );
    });

    it('prioritizes highest resolution and bitrate (-f bv*+ba/b -S res,br,fps) for video downloads without restricting streams to mp4/m4a', () => {
      withConfigOverrides(
        {
          enableAudioExtraction: true,
        },
        () => {
          const ytArgs = buildYtDlpArgs('https://www.youtube.com/watch?v=dQw4w9WgXcQ', os.tmpdir(), {});
          const fIdx = ytArgs.indexOf('-f');
          assert.notStrictEqual(fIdx, -1, 'Should specify -f format selector');
          assert.strictEqual(ytArgs[fIdx + 1], 'bv*+ba/b', 'Must allow VP9/AV1/Opus Premium and 4K streams before muxing');

          const sortIdx = ytArgs.indexOf('-S');
          assert.notStrictEqual(sortIdx, -1, 'Should specify -S format sort order');
          assert.strictEqual(ytArgs[sortIdx + 1], 'res,br,fps', 'Must sort by highest resolution first, then highest bitrate');

          const mergeIdx = ytArgs.indexOf('--merge-output-format');
          assert.notStrictEqual(mergeIdx, -1);
          assert.strictEqual(ytArgs[mergeIdx + 1], 'mp4');

          const audioArgs = buildYtDlpArgs('https://soundcloud.com/artist/track', os.tmpdir(), {});
          assert.strictEqual(audioArgs.includes('-S'), false, 'Audio-only extraction should not inject video format sort');
          assert.ok(audioArgs.includes('--extract-audio'));
        }
      );
    });
  });

  describe('directDownloader SSRF & maxBytes Guards', () => {
    it('rejects loopback, link-local, IPv6, IPv4-mapped IPv6, and private RFC-1918 addresses', async () => {
      assert.strictEqual(isPrivateIp('::ffff:127.0.0.1'), true);
      assert.strictEqual(isPrivateIp('::ffff:7f00:1'), true);
      assert.strictEqual(isPrivateIp('93.184.216.34'), false);

      const privateTargets = [
        'http://127.0.0.1:3000/api/file?file=.env',
        'http://localhost:3000/api/file?file=.env',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/admin',
        'http://192.168.1.1/router',
        'http://[::1]:3000/secret',
      ];

      for (const target of privateTargets) {
        await assert.rejects(
          async () => downloadDirect(target, os.tmpdir(), 10 * 1024 * 1024),
          /SSRF_BLOCKED|BLOCKED_IP|private\/loopback/i,
          `Should block private destination: ${target}`
        );
      }
    });

    it('enforces maxBytes cap on streaming bodies without Content-Length and cleans up partial file', async () => {
      const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-dl-cap-'));
      const origFetch = globalThis.fetch;

      try {
        globalThis.fetch = async () => {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(64));
              controller.enqueue(new Uint8Array(64));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
          });
        };

        await assert.rejects(
          async () =>
            downloadDirect('https://cdn.example.com/oversized.mp4', dlDir, 100, {
              lookup: async () => [{ address: '93.184.216.34', family: 4 }],
            }),
          /FILE_TOO_LARGE/
        );

        // Wait briefly for async unlink cleanup
        await new Promise((r) => setTimeout(r, 30));
        const remaining = fs.readdirSync(dlDir);
        assert.strictEqual(remaining.length, 0, 'Partial oversized file must be deleted');
      } finally {
        globalThis.fetch = origFetch;
        fs.rmSync(dlDir, { recursive: true, force: true });
      }
    });
  });

  describe('probeMedia Cover-Art Safety (DEF-02)', () => {
    it('does not misclassify MP3 audio with attached_pic cover art as video', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-probe-'));
      const dummyMp3 = path.join(tmpDir, 'track.mp3');
      fs.writeFileSync(dummyMp3, 'ID3');

      const mockPayload = JSON.stringify({
        format: { duration: '185.4', size: '4200000' },
        streams: [
          { index: 0, codec_type: 'audio', codec_name: 'mp3', bit_rate: '320000', disposition: { attached_pic: 0 } },
          { index: 1, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } },
        ],
      });

      try {
        let capturedArgs = [];
        const info = await probeMedia(dummyMp3, {
          execFn: async (_cmd, args) => {
            capturedArgs = args;
            return { code: 0, stdout: mockPayload, stderr: '' };
          },
        });
        assert.ok(capturedArgs.some((a) => a.includes('disposition')), 'ffprobe query must request stream disposition');
        assert.strictEqual(info.hasAudio, true);
        assert.strictEqual(info.hasVideo, false, 'Embedded album art must NOT set hasVideo=true');
        assert.strictEqual(info.isVideo, false, 'Audio with cover art must NOT be marked isVideo=true');
        assert.strictEqual(info.attachedPicStreamIndex, 1);
        assert.strictEqual(info.audioCodec, 'mp3');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('extracts format bit_rate and video stream bit_rate with size/duration fallback', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-probe-br-'));
      const dummyMp4 = path.join(tmpDir, 'clip.mp4');
      fs.writeFileSync(dummyMp4, '0000');

      const mockPayload = JSON.stringify({
        format: { duration: '10.0', size: '5000000', bit_rate: '4000000' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'vp9', width: 1920, height: 1080, bit_rate: '3744000', disposition: { attached_pic: 0 } },
          { index: 1, codec_type: 'audio', codec_name: 'opus', bit_rate: '256000', disposition: { attached_pic: 0 } },
        ],
      });

      try {
        let capturedArgs = [];
        const info = await probeMedia(dummyMp4, {
          execFn: async (_cmd, args) => {
            capturedArgs = args;
            return { code: 0, stdout: mockPayload, stderr: '' };
          },
        });
        assert.ok(capturedArgs.some((a) => a.includes('format=duration,size,bit_rate')), 'ffprobe must query format bit_rate');
        assert.strictEqual(info.totalBitrate, 4000000);
        assert.strictEqual(info.videoBitrate, 3744000);
        assert.strictEqual(info.audioBitrate, 256000);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('downloadPlatformMedia Pre-Sanitization, DI Runners & Fallback Attribution', () => {
    it('pre-sanitizes entry URL and falls back to gallery-dl when yt-dlp finds no video', async () => {
      let capturedYtUrl = null;
      let capturedGalleryUrl = null;

      const result = await downloadPlatformMedia(
        'https://x.com/Dev_Voxy/status/2116421485594382571\\',
        os.tmpdir(),
        0,
        {
          skipJitter: true,
          ytdlpRunner: async (u) => {
            capturedYtUrl = u;
            throw new Error('yt-dlp exited with code 1: ERROR: [twitter] 2116421485594382571: No video could be found in this tweet');
          },
          gallerydlRunner: async (u) => {
            capturedGalleryUrl = u;
            return Object.assign(['/tmp/image1.jpg'], { mediaFiles: ['/tmp/image1.jpg'], isNsfw: false });
          },
        }
      );

      assert.strictEqual(capturedYtUrl, 'https://x.com/Dev_Voxy/status/2116421485594382571');
      assert.strictEqual(capturedGalleryUrl, 'https://x.com/Dev_Voxy/status/2116421485594382571');
      assert.deepStrictEqual(result.mediaFiles, ['/tmp/image1.jpg']);
    });

    it('does NOT overwrite gallery-dl Unsupported URL error with yt-dlp "no video found" error', async () => {
      const noVideoErrors = [
        'ERROR: [twitter] 2116421485594382571: No video could be found in this tweet',
        'no video formats found',
        'YTDLP_NO_MEDIA_FOUND',
      ];

      for (const errMsg of noVideoErrors) {
        await assert.rejects(
          async () =>
            downloadPlatformMedia('https://x.com/user/status/123', os.tmpdir(), 0, {
              skipJitter: true,
              ytdlpRunner: async () => {
                throw new Error(errMsg);
              },
              gallerydlRunner: async () => {
                throw new Error('Unsupported URL: https://x.com/user/status/123');
              },
            }),
          (err) => {
            assert.strictEqual(
              err.message.includes('Unsupported URL'),
              true,
              `Expected gallery-dl error to be preserved instead of ${err.message}`
            );
            return true;
          }
        );
      }
    });

    it('preserves transient retry behavior when yt-dlp returns 429 and gallery-dl returns Unsupported URL', async () => {
      let attempts = 0;
      const res = await downloadPlatformMedia('https://youtube.com/watch?v=123', os.tmpdir(), 1, {
        skipJitter: true,
        retryDelayMs: 10,
        ytdlpRunner: async () => {
          attempts++;
          if (attempts === 1) throw new Error('HTTP Error 429: Too Many Requests');
          return { mediaFiles: ['/tmp/recovered.mp4'], subtitleFiles: [] };
        },
        gallerydlRunner: async () => {
          throw new Error('Unsupported URL');
        },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(res.mediaFiles, ['/tmp/recovered.mp4']);
    });

    it('canonicalizes locale-prefixed Bilibili URLs before invoking yt-dlp in both downloadPlatformMedia and buildYtDlpArgs', async () => {
      let capturedYtUrl = null;
      const biliRes = await downloadPlatformMedia(
        'https://www.bilibili.com/en/video/BV1Fb4y1j7cs/',
        os.tmpdir(),
        0,
        {
          skipJitter: true,
          ytdlpRunner: async (u) => {
            capturedYtUrl = u;
            return { mediaFiles: ['/tmp/bili.mp4'], subtitleFiles: [] };
          },
        }
      );

      assert.strictEqual(capturedYtUrl, 'https://www.bilibili.com/video/BV1Fb4y1j7cs/');
      assert.deepStrictEqual(biliRes.mediaFiles, ['/tmp/bili.mp4']);

      const args = buildYtDlpArgs('https://www.bilibili.com/en/video/BV1Fb4y1j7cs/', os.tmpdir(), {});
      assert.strictEqual(args[0], 'https://www.bilibili.com/video/BV1Fb4y1j7cs/');
    });

    it('uses 10M HTTP chunks on Bilibili, caps unauthenticated Bilibili at 720p, and retries at 720p on 1080p trial cutoff', async () => {
      const emptyCookieDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-bili-nocookie-'));
      const dlTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-bili-dl-'));

      try {
        // 1. Unauthenticated Bilibili immediately caps format at <=720p and uses 10M HTTP chunks
        withConfigOverrides(
          {
            cookiesDir: emptyCookieDir,
            cookiesPath: null,
            cookiesFromBrowser: '',
          },
          () => {
            const guestArgs = buildYtDlpArgs('https://www.bilibili.com/video/BV1Fb4y1j7cs/', dlTempDir, {});
            const fIdx = guestArgs.indexOf('-f');
            assert.strictEqual(guestArgs[fIdx + 1], 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b');

            const chunkIdx = guestArgs.indexOf('--http-chunk-size');
            assert.notStrictEqual(chunkIdx, -1, 'Bilibili downloads must set --http-chunk-size to avoid CDN burst throttling');
            assert.strictEqual(guestArgs[chunkIdx + 1], '10M');
          }
        );

        // 2. When cookiesFromBrowser is set (or SESSDATA expired), tries full bv*+ba/b first, then falls back to <=720p on trial stream cutoff
        await withConfigOverrides(
          {
            cookiesDir: emptyCookieDir,
            cookiesPath: null,
            cookiesFromBrowser: 'firefox',
          },
          async () => {
            const capturedFormatSelectors = [];
            const outMp4 = path.join(dlTempDir, 'AI-4K-Hires.mp4');

            const res = await downloadWithYtDlp('https://www.bilibili.com/video/BV1Fb4y1j7cs/', dlTempDir, {
              execFn: async (_cmd, cliArgs) => {
                const fIdx = cliArgs.indexOf('-f');
                capturedFormatSelectors.push(cliArgs[fIdx + 1]);
                if (capturedFormatSelectors.length === 1) {
                  fs.writeFileSync(path.join(dlTempDir, 'AI-4K-Hires.f30080.mp4.part'), 'partial');
                  const err = new Error(
                    'yt-dlp exited with code 1: ERROR: [download] Got error: 108 bytes read, 58986935 more expected. Giving up after 2 retries'
                  );
                  err.stderr = 'ERROR: [download] Got error: 108 bytes read, 58986935 more expected. Giving up after 2 retries\n';
                  throw err;
                }
                fs.writeFileSync(outMp4, 'valid-mp4-bytes');
                return { code: 0, stdout: '', stderr: '' };
              },
            });

            assert.deepStrictEqual(capturedFormatSelectors, [
              'bv*+ba/b',
              'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
            ]);
            assert.deepStrictEqual(res.mediaFiles, [outMp4]);
            assert.strictEqual(
              fs.existsSync(path.join(dlTempDir, 'AI-4K-Hires.f30080.mp4.part')),
              false,
              'Partial .part artifact from failed 1080p trial attempt must be purged before 720p retry'
            );
          }
        );
      } finally {
        fs.rmSync(emptyCookieDir, { recursive: true, force: true });
        fs.rmSync(dlTempDir, { recursive: true, force: true });
      }
    });
  });

  describe('runProcess Subprocess Gateway & fetchFlatPlaylistInfo Large JSON Integrity', () => {
    it('decodes multi-byte UTF-8 codepoints split across pipe chunks without replacement characters', async () => {
      const script = [
        'process.stdout.write(Buffer.from([0xF0, 0x9F]));',
        'setTimeout(() => {',
        '  process.stdout.write(Buffer.from([0x98, 0xAD, 0x0A]));',
        '  process.stderr.write(Buffer.from([0xEF, 0xBD]));',
        '  setTimeout(() => {',
        '    process.stderr.write(Buffer.from([0x9C, 0x0A]));',
        '  }, 25);',
        '}, 25);',
      ].join(' ');

      const res = await runProcess(process.execPath, ['-e', script]);
      assert.strictEqual(res.stdout, '😭\n');
      assert.strictEqual(res.stderr, '｜\n');
      assert.strictEqual(res.stdout.includes('\uFFFD'), false);
      assert.strictEqual(res.stderr.includes('\uFFFD'), false);
    });

    it('fails closed with BUFFER_OVERFLOW when rollingBuffer is false and output exceeds maxBufferBytes', async () => {
      const script = 'process.stdout.write("Z".repeat(5000));';
      await assert.rejects(
        async () =>
          runProcess(process.execPath, ['-e', script], {
            maxBufferBytes: 1024,
            rollingBuffer: false,
          }),
        (err) => {
          assert.strictEqual(err.code, 'BUFFER_OVERFLOW');
          assert.ok(err.message.includes('BUFFER_OVERFLOW'));
          return true;
        }
      );
    });

    it('parses >3 MB playlist JSON through real runProcess without 2 MB head-truncation', async () => {
      const script = [
        'const entries = Array.from({ length: 30 }, (_, i) => ({',
        '  id: "vid_" + i,',
        '  title: "Track 😭 ｜ " + i,',
        '  description: "P".repeat(120 * 1024),',
        '}));',
        'process.stdout.write(JSON.stringify({ _type: "playlist", id: "PL_BIG", title: "Big Playlist", entries }));',
      ].join(' ');

      let forwardedOpts = null;
      const info = await fetchFlatPlaylistInfo('https://www.youtube.com/playlist?list=PL_BIG', 30, {
        execFn: (_cmd, _args, opts) => {
          forwardedOpts = opts;
          return runProcess(process.execPath, ['-e', script], opts);
        },
      });

      assert.strictEqual(forwardedOpts?.rollingBuffer, false);
      assert.strictEqual(forwardedOpts?.maxBufferBytes, 32 * 1024 * 1024);
      assert.strictEqual(info._type, 'playlist');
      assert.strictEqual(info.entries.length, 30);
      assert.strictEqual(info.entries[0].title, 'Track 😭 ｜ 0');
    });
  });
});
