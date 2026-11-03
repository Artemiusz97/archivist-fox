import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config, withConfigOverrides } from '../src/config.js';
import { initLinkDb, closeLinkDb, getDb } from '../src/linkDb.js';
import * as urlExtractor from '../src/urlExtractor.js';
const { checkNsfwInMetadata, extractPlatformMediaId } = urlExtractor;
import { findDuplicateByUrl } from '../src/db.js';
import { handleMessage } from '../src/mediaHandler.js';
import { crawlChannel } from '../src/scanner.js';

// Valid 1x1 PNG buffer so filesystem/stat/sha256 operations work on real bytes
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('NSFW Default Blurring & Manual User Media Backup', () => {
  let tempArchiveDir;

  before(() => {
    closeLinkDb();
    initLinkDb(':memory:');
    tempArchiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-nsfw-backup-'));
  });

  after(() => {
    closeLinkDb();
    fs.rmSync(tempArchiveDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM posted_links;');
    db.exec('DELETE FROM media_records;');
  });

  describe('1. Default NSFW Blurring Configuration & Metadata Detection', () => {
    it('enables AUTO_SPOILER_NSFW and blurs across ALL channels (including NSFW channels) by default', () => {
      assert.strictEqual(config.autoSpoilerNsfw, true, 'AUTO_SPOILER_NSFW must default to true');
      assert.strictEqual(
        config.spoilerNonNsfwChannelsOnly,
        false,
        'SPOILER_NON_NSFW_CHANNELS_ONLY must default to false so NSFW channels also blur site-tagged NSFW media'
      );
    });

    it('detects extended site NSFW flags, nested post/tweet metadata, and object tags in checkNsfwInMetadata', () => {
      assert.strictEqual(checkNsfwInMetadata({ nsfw: true }), true);
      assert.strictEqual(checkNsfwInMetadata({ is_nsfw: true }), true);
      assert.strictEqual(checkNsfwInMetadata({ mature: true }), true);
      assert.strictEqual(checkNsfwInMetadata({ adult: true }), true);
      assert.strictEqual(checkNsfwInMetadata({ tweet: { possibly_sensitive: true } }), true);
      assert.strictEqual(checkNsfwInMetadata({ post: { nsfw: true } }), true);
      assert.strictEqual(checkNsfwInMetadata({ tags: [{ name: 'R-18' }, { name: 'art' }] }), true);

      assert.strictEqual(checkNsfwInMetadata({ nsfw: false, tags: [{ name: 'landscape' }] }), false);
    });

    it('blurs site-tagged NSFW reuploads by default even in NSFW-flagged Discord channels, and toggles off when AUTO_SPOILER_NSFW=false', async () => {
      const nsfwReplies = [];
      const mockYtdlpNsfw = async (_url, destDir) => {
        const outFile = path.join(destDir, 'Spicy Artwork.png');
        fs.writeFileSync(outFile, TINY_PNG);
        return { mediaFiles: [outFile], subtitleFiles: [], isNsfw: true };
      };

      // 1) Default settings in an NSFW channel (channel.nsfw = true) -> MUST blur attachment & title
      await withConfigOverrides(
        {
          archiveDirectory: tempArchiveDir,
          enableLocalArchive: false,
          enableDuplicatePrevention: false,
          enableGifPipeline: false,
          enableHumanJitter: false,
          includeTitleInMessage: true,
          spoilerTitles: true,
        },
        async () => {
          const msg = {
            id: 'msg-nsfw-default',
            content: 'https://x.com/artist/status/100001',
            channelId: 'chan-nsfw',
            channel: { id: 'chan-nsfw', name: 'nsfw-art', nsfw: true, sendTyping: async () => {} },
            author: { id: 'u1', username: 'Alice', discriminator: '0' },
            react: async () => ({ users: { remove: async () => {} } }),
            suppressEmbeds: async () => {},
            reply: async (payload) => {
              nsfwReplies.push(payload);
              return { id: 'bot-reply-1', delete: async () => {} };
            },
          };

          const res = await handleMessage(msg, { ytdlpRunner: mockYtdlpNsfw, skipJitter: true });
          assert.strictEqual(res.uploaded, 1);
          assert.strictEqual(nsfwReplies.length, 1);
          const uploadedBuilder = nsfwReplies[0].files[0];
          assert.ok(
            uploadedBuilder.name.startsWith('SPOILER_'),
            `Expected blurred SPOILER_ filename in NSFW channel by default, got "${uploadedBuilder.name}"`
          );
          assert.ok(
            nsfwReplies[0].content?.includes('||**Spicy Artwork**||'),
            `Expected spoilered title, got "${nsfwReplies[0].content}"`
          );
        }
      );

      // 2) Toggled off via AUTO_SPOILER_NSFW=false -> MUST NOT blur site-tagged NSFW media
      const unblurredReplies = [];
      await withConfigOverrides(
        {
          autoSpoilerNsfw: false,
          archiveDirectory: tempArchiveDir,
          enableLocalArchive: false,
          enableDuplicatePrevention: false,
          enableGifPipeline: false,
          enableHumanJitter: false,
          includeTitleInMessage: true,
          spoilerTitles: true,
        },
        async () => {
          const msg = {
            id: 'msg-nsfw-off',
            content: 'https://x.com/artist/status/100002',
            channelId: 'chan-sfw',
            channel: { id: 'chan-sfw', name: 'general', nsfw: false, sendTyping: async () => {} },
            author: { id: 'u1', username: 'Alice', discriminator: '0' },
            react: async () => ({ users: { remove: async () => {} } }),
            suppressEmbeds: async () => {},
            reply: async (payload) => {
              unblurredReplies.push(payload);
              return { id: 'bot-reply-2', delete: async () => {} };
            },
          };

          const res = await handleMessage(msg, { ytdlpRunner: mockYtdlpNsfw, skipJitter: true });
          assert.strictEqual(res.uploaded, 1);
          const uploadedBuilder = unblurredReplies[0].files[0];
          assert.ok(
            !uploadedBuilder.name.startsWith('SPOILER_'),
            `Expected unblurred filename when AUTO_SPOILER_NSFW=false, got "${uploadedBuilder.name}"`
          );
        }
      );
    });

    it('blurs site-tagged NSFW media when scanner reposts missing uploads during rescan / startup catch-up', async () => {
      const scanReplies = [];
      const mockYtdlpNsfw = async (_url, destDir) => {
        const outFile = path.join(destDir, 'Missed NSFW Post.png');
        fs.writeFileSync(outFile, TINY_PNG);
        return { mediaFiles: [outFile], subtitleFiles: [], isNsfw: true };
      };

      const candidateMsg = {
        id: 'scan-msg-1',
        content: 'https://x.com/artist/status/555555',
        createdTimestamp: Date.now() - 5000,
        author: { id: 'u2', bot: false, username: 'Bob', discriminator: '0' },
        suppressEmbeds: async () => {},
        reply: async (payload) => {
          scanReplies.push(payload);
          return { id: 'scan-reply-1' };
        },
      };

      let fetchedOnce = false;
      const mockChannel = {
        id: '111111111111111111',
        name: 'nsfw-gallery',
        nsfw: true,
        guildId: 'g1',
        client: { user: { id: 'bot-1' } },
        messages: {
          fetch: async () => {
            if (fetchedOnce) return new Map();
            fetchedOnce = true;
            return new Map([[candidateMsg.id, candidateMsg]]);
          },
        },
      };

      await withConfigOverrides(
        {
          archiveDirectory: tempArchiveDir,
          enableLocalArchive: true,
          enableDuplicatePrevention: false,
          enableGeneralDuplicateDetector: false,
          enableGifPipeline: false,
          allowedChannelIds: [],
          disallowedChannelIds: [],
          includeTitleInMessage: true,
          spoilerTitles: true,
        },
        async () => {
          const stats = await crawlChannel(mockChannel, {
            repostMissing: true,
            ytdlpRunner: mockYtdlpNsfw,
          });
          assert.strictEqual(stats.repostedMissingCount, 1);
          assert.strictEqual(scanReplies.length, 1);
          const builder = scanReplies[0].files[0];
          assert.ok(
            builder.name.startsWith('SPOILER_'),
            `Expected scanner repost to blur NSFW media with SPOILER_, got "${builder.name}"`
          );
          assert.ok(
            scanReplies[0].content?.includes('||**Missed NSFW Post**||'),
            `Expected scanner repost to spoiler title, got "${scanReplies[0].content}"`
          );
        }
      );
    });
  });

  describe('2. Manual User Media Upload Backup & Deduplication', () => {
    it('extracts stable discord:<attachmentId> in extractPlatformMediaId across rotating CDN tokens', () => {
      const cdnUrl1 =
        'https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/fox_art.png?ex=6725a1&is=672450&hm=aaa111';
      const mediaUrl2 =
        'https://media.discordapp.net/attachments/111111111111111111/222222222222222222/fox_art.png?ex=999999&is=888888&hm=bbb222';

      assert.strictEqual(extractPlatformMediaId(cdnUrl1), 'discord:222222222222222222');
      assert.strictEqual(extractPlatformMediaId(mediaUrl2), 'discord:222222222222222222');
    });

    it('filters media attachments accurately and strips SPOILER_ prefix while ignoring non-media files', async () => {
      const msg = {
        attachments: new Map([
          [
            '1',
            {
              id: '900000000000000001',
              name: 'SPOILER_character_sheet.png',
              url: 'https://cdn.discordapp.com/attachments/100/900000000000000001/SPOILER_character_sheet.png?ex=1',
              contentType: 'image/png',
            },
          ],
          [
            '2',
            {
              id: '900000000000000002',
              name: 'lossless_song.flac',
              url: 'https://cdn.discordapp.com/attachments/100/900000000000000002/lossless_song.flac?ex=1',
              contentType: 'application/octet-stream',
            },
          ],
          [
            '3',
            {
              id: '900000000000000003',
              name: 'notes.pdf',
              url: 'https://cdn.discordapp.com/attachments/100/900000000000000003/notes.pdf?ex=1',
              contentType: 'application/pdf',
            },
          ],
          [
            '4',
            {
              id: '900000000000000004',
              name: 'script.ts',
              url: 'https://cdn.discordapp.com/attachments/100/900000000000000004/script.ts?ex=1',
              contentType: 'text/plain; charset=utf-8',
            },
          ],
          [
            '5',
            {
              id: '900000000000000005',
              name: 'project.zip',
              url: 'https://cdn.discordapp.com/attachments/100/900000000000000005/project.zip?ex=1',
              contentType: 'application/zip',
            },
          ],
        ]),
      };

      assert.strictEqual(typeof urlExtractor.extractMessageAttachments, 'function');
      const extracted = urlExtractor.extractMessageAttachments(msg);
      assert.strictEqual(extracted.length, 2, 'Should keep image/png and .flac while ignoring pdf, text .ts, and zip');
      assert.strictEqual(extracted[0].archiveOnly, true);
      assert.strictEqual(extracted[0].filename, 'character_sheet.png');
      assert.strictEqual(extracted[1].filename, 'lossless_song.flac');

      await withConfigOverrides({ archiveUserAttachments: false }, () => {
        assert.strictEqual(urlExtractor.extractMessageAttachments(msg).length, 0);
      });
    });

    it('silently backs up live manual uploads, skips re-downloading same attachment ID, and alerts without saving on duplicate content', async () => {
      const hitCounts = new Map();
      const DISTINCT_PNG_A = Buffer.concat([TINY_PNG, Buffer.from('UNIQUE_PAYLOAD_ALPHA')]);
      const DISTINCT_PNG_B = Buffer.concat([TINY_PNG, Buffer.from('UNIQUE_PAYLOAD_BETA')]);

      const server = http.createServer((req, res) => {
        const cleanPath = req.url.split('?')[0];
        hitCounts.set(cleanPath, (hitCounts.get(cleanPath) || 0) + 1);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        if (cleanPath.includes('/8001/') || cleanPath.includes('/8003/')) {
          res.end(DISTINCT_PNG_B);
        } else {
          res.end(DISTINCT_PNG_A);
        }
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const isolatedArchive = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-manual-live-'));

      try {
        await withConfigOverrides(
          {
            archiveDirectory: isolatedArchive,
            archiveSubfolderFormat: 'channel',
            enableLocalArchive: true,
            enableDuplicatePrevention: true,
            archiveUserAttachments: true,
            enableGifPipeline: false,
            enableHumanJitter: false,
            errorMessageTtlMs: 0,
          },
          async () => {
            // 1. User 1 manually uploads SPOILER_fox_painting.png -> silent local backup, 0 replies, 0 reactions
            let reactionsCalled = 0;
            let typingCalled = 0;
            const msg1Replies = [];
            const att1Url = `http://127.0.0.1:${port}/attachments/500/7001/SPOILER_fox_painting.png?ex=token1`;
            // Note: localhost test URL has /attachments/500/7001/...; attachment object also carries id: '7001'
            const msg1 = {
              id: 'manual-msg-1',
              content: '',
              channelId: '500',
              channel: {
                id: '500',
                name: 'art-archive',
                nsfw: false,
                sendTyping: async () => {
                  typingCalled++;
                },
              },
              author: { id: 'user-alice', username: 'Alice', discriminator: '0' },
              attachments: new Map([
                [
                  '7001',
                  {
                    id: '7001',
                    name: 'SPOILER_fox_painting.png',
                    url: att1Url,
                    contentType: 'image/png',
                  },
                ],
              ]),
              react: async () => {
                reactionsCalled++;
                return { users: { remove: async () => {} } };
              },
              reply: async (payload) => {
                msg1Replies.push(payload);
                return { id: 'r1', delete: async () => {} };
              },
            };

            const res1 = await handleMessage(msg1, { allowLoopback: true });
            assert.strictEqual(res1.found, 1);
            assert.strictEqual(res1.archived, 1);
            assert.strictEqual(res1.uploaded, 0, 'Must NOT re-upload user attachment to Discord');
            assert.strictEqual(msg1Replies.length, 0, 'Must stay silent in chat on new manual upload');
            assert.strictEqual(reactionsCalled, 0, 'Must NOT add progress reactions on silent manual upload');
            assert.strictEqual(typingCalled, 0, 'Must NOT show typing indicator on silent manual upload');

            const expectedArchivedFile = path.join(isolatedArchive, 'art-archive', 'fox_painting.png');
            assert.ok(fs.existsSync(expectedArchivedFile), 'Clean filename must exist in local archive');
            assert.strictEqual(hitCounts.get('/attachments/500/7001/SPOILER_fox_painting.png'), 1);

            // 2. Re-processing same attachment ID with rotated ?ex=token2 -> skips BEFORE downloading (0 extra HTTP hits)
            const msg1Rotated = {
              ...msg1,
              attachments: new Map([
                [
                  '7001',
                  {
                    id: '7001',
                    name: 'SPOILER_fox_painting.png',
                    url: `http://127.0.0.1:${port}/attachments/500/7001/SPOILER_fox_painting.png?ex=token2_rotated`,
                    contentType: 'image/png',
                  },
                ],
              ]),
            };
            await handleMessage(msg1Rotated, { allowLoopback: true });
            assert.strictEqual(
              hitCounts.get('/attachments/500/7001/SPOILER_fox_painting.png'),
              1,
              'Same attachment ID must not be downloaded again even when signed query params rotate'
            );
            assert.strictEqual(msg1Replies.length, 0, 'Idempotent re-check of same attachment must not self-alert');

            // Verify findDuplicateByUrl also resolves discord:7001 on cdn.discordapp.com URLs
            const dbMatch = await findDuplicateByUrl(
              'https://cdn.discordapp.com/attachments/500/7001/SPOILER_fox_painting.png?ex=future'
            );
            assert.ok(dbMatch, 'findDuplicateByUrl should match discord:7001 across token rotations');

            // 3. User 2 manually uploads identical bytes under a new attachment ID (7002) -> alerts duplicate & does NOT save copy
            const msg2Replies = [];
            const msg2 = {
              id: 'manual-msg-2',
              content: 'look at this cool pic',
              channelId: '500',
              channel: { id: '500', name: 'art-archive', nsfw: false, sendTyping: async () => {} },
              author: { id: 'user-bob', username: 'Bob', discriminator: '0' },
              attachments: new Map([
                [
                  '7002',
                  {
                    id: '7002',
                    name: 'repost_copy.png',
                    url: `http://127.0.0.1:${port}/attachments/500/7002/repost_copy.png?ex=fresh`,
                    contentType: 'image/png',
                  },
                ],
              ]),
              react: async () => ({ users: { remove: async () => {} } }),
              reply: async (payload) => {
                msg2Replies.push(payload);
                return { id: 'r2', delete: async () => {} };
              },
            };

            const res2 = await handleMessage(msg2, { allowLoopback: true });
            assert.strictEqual(res2.archived, 0, 'Duplicate manual upload must not be archived again');
            assert.strictEqual(
              fs.existsSync(path.join(isolatedArchive, 'art-archive', 'repost_copy.png')),
              false,
              'Duplicate file must NOT be written into archive directory'
            );
            assert.strictEqual(msg2Replies.length, 1, 'Should send live duplicate alert in media-archive channel');
            assert.ok(msg2Replies[0].content.includes('@Alice'));
            assert.strictEqual(msg2Replies[0].components?.length, 1, 'Should include Delete Post / Dismiss action row');

            // 4. Historical / Startup Scan (crawlChannel with repostMissing: true):
            // - Skips already-archived 7001 with 0 HTTP requests
            // - Archives brand-new manual upload 8001 (even with no http link in msg.content) WITHOUT reposting to Discord
            // - Skips duplicate manual upload 8003 (identical bytes to 8001) without writing duplicate file
            const scanReplies = [];
            const scanMessages = new Map([
              [
                'scan-m3-dup',
                {
                  id: 'scan-m3-dup',
                  content: '',
                  createdTimestamp: 3000,
                  author: { id: 'u3', bot: false, username: 'Charlie', discriminator: '0' },
                  attachments: new Map([
                    [
                      '8003',
                      {
                        id: '8003',
                        name: 'duplicate_landscape.png',
                        url: `http://127.0.0.1:${port}/attachments/500/8003/duplicate_landscape.png?ex=dup`,
                        contentType: 'image/png',
                      },
                    ],
                  ]),
                  reply: async (p) => scanReplies.push(p),
                },
              ],
              [
                'scan-m2-new',
                {
                  id: 'scan-m2-new',
                  content: 'my manual photo upload without any links',
                  createdTimestamp: 2000,
                  author: { id: 'u2', bot: false, username: 'Bob', discriminator: '0' },
                  attachments: new Map([
                    [
                      '8001',
                      {
                        id: '8001',
                        name: 'landscape_photo.png',
                        url: `http://127.0.0.1:${port}/attachments/500/8001/landscape_photo.png?ex=new`,
                        contentType: 'image/png',
                      },
                    ],
                  ]),
                  reply: async (p) => scanReplies.push(p),
                },
              ],
              [
                'scan-m1-existing',
                {
                  id: 'scan-m1-existing',
                  content: '',
                  createdTimestamp: 1000,
                  author: { id: 'user-alice', bot: false, username: 'Alice', discriminator: '0' },
                  attachments: new Map([
                    [
                      '7001',
                      {
                        id: '7001',
                        name: 'SPOILER_fox_painting.png',
                        url: `http://127.0.0.1:${port}/attachments/500/7001/SPOILER_fox_painting.png?ex=rotated_in_scan`,
                        contentType: 'image/png',
                      },
                    ],
                  ]),
                  reply: async (p) => scanReplies.push(p),
                },
              ],
            ]);

            let scanFetched = false;
            const scanChannel = {
              id: '500',
              name: 'art-archive',
              nsfw: false,
              guildId: 'g1',
              client: { user: { id: 'bot-1' } },
              messages: {
                fetch: async () => {
                  if (scanFetched) return new Map();
                  scanFetched = true;
                  return scanMessages;
                },
              },
            };

            const scanStats = await crawlChannel(scanChannel, {
              repostMissing: true,
              concurrency: 1,
              allowLoopback: true,
            });

            assert.strictEqual(
              hitCounts.get('/attachments/500/7001/SPOILER_fox_painting.png'),
              1,
              'Scanner must skip already-archived attachment 7001 with 0 network requests'
            );
            assert.strictEqual(scanStats.archivedCount, 1, 'Scanner should archive only the 1 new unique manual upload (8001)');
            assert.strictEqual(scanStats.repostedMissingCount, 0, 'Scanner must NEVER repost manual user attachments into chat');
            assert.strictEqual(scanReplies.length, 0, 'Scanner must stay silent in chat for manual attachments');
            assert.ok(
              fs.existsSync(path.join(isolatedArchive, 'art-archive', 'landscape_photo.png')),
              'New manual upload from history scan must be archived on disk'
            );
            assert.strictEqual(
              fs.existsSync(path.join(isolatedArchive, 'art-archive', 'duplicate_landscape.png')),
              false,
              'Duplicate manual upload in history scan must NOT be saved a second time'
            );
          }
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(isolatedArchive, { recursive: true, force: true });
      }
    });

    it('enforces channel whitelist (ALLOWED_CHANNEL_IDS) and blacklist (DISALLOWED_CHANNEL_IDS) for manual uploads in handleMessage and crawlChannel', async () => {
      let requestsReceived = 0;
      const server = http.createServer((req, res) => {
        requestsReceived++;
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.concat([TINY_PNG, Buffer.from(req.url)]));
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const isolatedArchive = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-channel-gate-'));

      const makeAttachmentMsg = (channelId, attId) => ({
        id: `gate-msg-${channelId}-${attId}`,
        content: '',
        createdTimestamp: Date.now(),
        channelId,
        channel: { id: channelId, name: `chan-${channelId}`, nsfw: false, sendTyping: async () => {} },
        author: { id: 'u1', bot: false, username: 'Alice', discriminator: '0' },
        attachments: new Map([
          [
            attId,
            {
              id: attId,
              name: `upload_${attId}.png`,
              url: `http://127.0.0.1:${port}/attachments/${channelId}/${attId}/upload_${attId}.png?ex=1`,
              contentType: 'image/png',
            },
          ],
        ]),
        react: async () => ({ users: { remove: async () => {} } }),
        reply: async () => ({ id: 'r1', delete: async () => {} }),
      });

      try {
        // Mode A: Whitelist mode (ALLOWED_CHANNEL_IDS set)
        await withConfigOverrides(
          {
            archiveDirectory: isolatedArchive,
            archiveSubfolderFormat: 'channel',
            enableLocalArchive: true,
            archiveUserAttachments: true,
            enableGifPipeline: false,
            allowedChannelIds: ['allowed-chan-1'],
            disallowedChannelIds: [],
          },
          async () => {
            // Non-whitelisted channel -> skipped in handleMessage (0 HTTP hits)
            const resNonWhitelisted = await handleMessage(makeAttachmentMsg('random-chat-999', '9101'), {
              allowLoopback: true,
            });
            assert.strictEqual(resNonWhitelisted.archived, 0);
            assert.strictEqual(requestsReceived, 0, 'Must not download manual uploads from non-whitelisted channels');

            // Whitelisted channel -> backed up cleanly
            const resAllowed = await handleMessage(makeAttachmentMsg('allowed-chan-1', '9104'), {
              allowLoopback: true,
            });
            assert.strictEqual(resAllowed.archived, 1);
            assert.strictEqual(requestsReceived, 1);
            assert.ok(fs.existsSync(path.join(isolatedArchive, 'chan-allowed-chan-1', 'upload_9104.png')));
          }
        );

        // Mode B: Blacklist mode (ALLOWED_CHANNEL_IDS empty, DISALLOWED_CHANNEL_IDS set)
        await withConfigOverrides(
          {
            archiveDirectory: isolatedArchive,
            archiveSubfolderFormat: 'channel',
            enableLocalArchive: true,
            archiveUserAttachments: true,
            enableGifPipeline: false,
            allowedChannelIds: [],
            disallowedChannelIds: ['blacklisted-chan-1'],
          },
          async () => {
            // Blacklisted channel -> skipped in handleMessage & crawlChannel (0 extra HTTP hits)
            const resBlacklisted = await handleMessage(makeAttachmentMsg('blacklisted-chan-1', '9102'), {
              allowLoopback: true,
            });
            assert.strictEqual(resBlacklisted.archived, 0);
            assert.strictEqual(requestsReceived, 1, 'Must not download manual uploads from blacklisted channels');

            let fetchedDisallowed = false;
            const disallowedScanStats = await crawlChannel(
              {
                id: 'blacklisted-chan-1',
                name: 'blacklisted-chan',
                nsfw: false,
                guildId: 'g1',
                client: { user: { id: 'bot-1' } },
                messages: {
                  fetch: async () => {
                    if (fetchedDisallowed) return new Map();
                    fetchedDisallowed = true;
                    const m = makeAttachmentMsg('blacklisted-chan-1', '9103');
                    return new Map([[m.id, m]]);
                  },
                },
              },
              { repostMissing: true, allowLoopback: true }
            );
            assert.strictEqual(disallowedScanStats.archivedCount, 0);
            assert.strictEqual(requestsReceived, 1, 'Scanner must skip manual uploads in blacklisted channels');

            // Non-blacklisted channel -> backed up cleanly
            const resNonBlacklisted = await handleMessage(makeAttachmentMsg('open-archive-chan', '9105'), {
              allowLoopback: true,
            });
            assert.strictEqual(resNonBlacklisted.archived, 1);
            assert.strictEqual(requestsReceived, 2);
            assert.ok(fs.existsSync(path.join(isolatedArchive, 'chan-open-archive-chan', 'upload_9105.png')));
          }
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(isolatedArchive, { recursive: true, force: true });
      }
    });
  });
});
