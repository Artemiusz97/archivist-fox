# Changelog

All notable changes to **Archivist Fox** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning (SemVer 2.0.0)](https://semver.org/spec/v2.0.0.html).

---

## 🏷️ Version System Specification

Archivist Fox uses the standard **Semantic Versioning 2.0.0** scheme (`MAJOR.MINOR.PATCH`):

| Level | Identifier | Trigger Criteria | Examples |
| :--- | :--- | :--- | :--- |
| **MAJOR** | `X.0.0` | Architectural overhauls, database engine changes, incompatible configuration breaks, major operational paradigm transitions. | Universal link detector with SQLite (`v2.0.0`), Unified SQLite engine + Discord Slash Commands suite (`v3.0.0`). |
| **MINOR** | `X.Y.0` | Substantial new features, new command suites, platform expansions, pipeline subsystems introduced in a backwards-compatible manner. | Local PC archiving & perceptual hashing (`v1.1.0`), Concurrency queue & GPU encoding (`v1.2.0`), Server history crawler (`v2.1.0`), Command guide & memory overhaul (`v3.1.0`). |
| **PATCH** | `X.Y.Z` | Backwards-compatible bug fixes, timeout protections, platform scraper adjustments, edge-case handling, environment configuration hardening. | Config template & path hardening (`v1.2.1`), Scraper & crawler stability hotfix (`v2.1.1`). |

---

## 📊 Version History Summary

| Version | Release Date | Type | Primary Milestone / Theme |
| :--- | :--- | :--- | :--- |
| **[v3.9.0](#v390---2026-09-18)** | 2026-09-18 | Minor | YouTube Playlist & Subtitle Suite: Interactive playlist prompt buttons, auto-threading, creator/auto-generated subtitle extraction & zip bundling. |
| **[v3.8.0](#v380---2026-09-17)** | 2026-09-17 | Minor | DeviantArt Platform Expansion: Native DeviantArt & Sta.sh scraping, fav.me base-36 canonical unshortening, gallery-dl fast-path routing, DeviantArt cookie vault. |
| **[v3.7.0](#v370---2026-09-16)** | 2026-09-16 | Minor | Message Deletion Fallback, Context Menu Channel-Gating, Faststart Streaming & Live Telemetry. |
| **[v3.6.1](#v361---2026-09-16)** | 2026-09-16 | Patch | Production Hardening Suite: Gateway exponential backoff, Anti-bot browser impersonation & human jitter, SQLite prepared statement cache & WAL tuning, Queue flood protection, Windows NTFS reserved name defense. |
| **[v3.6.0](#v360---2026-09-15)** | 2026-09-15 | Minor | Startup Catch-Up Scanner & Browser Cookies: Automatic offline downtime catch-up scan, Direct browser cookie extraction (Firefox/Chrome/Edge/Brave). |
| **[v3.5.0](#v350---2026-09-12)** | 2026-09-12 | Minor | Dedicated Audio-Only & Music Platform Support: Added SoundCloud, Bandcamp, Mixcloud, Audiomack, YouTube Music, and direct MP3 support. Features FFmpeg audio compression and ID3 tagging. |
| **[v3.4.1](#v341---2026-09-12)** | 2026-09-12 | Patch | Quality-of-Life & Pipeline Polish: Duplicate alert fix, Auto-updater rescan lock, Direct download Unicode preservation, Single-pass video compression & thumbnail injection, FFmpeg startup verification, Social fixer domains. |
| **[v3.4.0](#v340---2026-09-12)** | 2026-09-12 | Minor | Task Cancellation & History Overhaul: Interactive /stop command, Chronological crawling, Smart FFmpeg thumbnail extraction. |
| **[v3.3.0](#v330---2026-09-12)** | 2026-09-12 | Minor | Visual Player Enhancement & Scanner Deduplication: YouTube 0.15s thumbnail freeze frame injection, Multi-bot attachment history crawler deduplication. |
| **[v3.2.1](#v321---2026-09-12)** | 2026-09-12 | Patch | Quality-of-Life & Stability Polish: Discord 15-minute token expiration fallback in /rescan, Normalized URL matching in pre-download duplicate checks. |
| **[v3.2.0](#v320---2026-09-12)** | 2026-09-12 | Minor | Media Pipeline & Network Resilience Upgrade: Direct download MIME Content-Type inference, Shortlink GET method fallback, Windows MAX_PATH defense. |
| **[v3.1.1](#v311---2026-09-12)** | 2026-09-12 | Patch | Backend Reliability Hardening: In-flight mutex leak fix, FFmpeg 4-min execution timeout & zombie killer, Global crash & WAL flush guards. |
| **[v3.1.0](#v310---2026-09-12)** | 2026-09-12 | Minor | Interactive Command Guide (`/help`, `!help`), Crawler Memory Optimization (>90% reduction), Quality Floor Protection, Concurrency Locks. |
| **[v3.0.0](#v300---2026-09-12)** | 2026-09-12 | **MAJOR** | Unified Native SQLite Engine (`db.js`), Discord Slash Commands (`/status`, `/stats`, `/rescan`), Context Menu App, Faststart Video Streaming. |
| **[v2.2.0](#v220---2026-09-10)** | 2026-09-10 | Minor | Dynamic ffmpeg stream preprocessing and initial thumbnail integration exploration. |
| **[v2.1.1](#v211---2026-08-25)** | 2026-08-25 | Patch | Scraper timeouts, Facebook Reels extractor fixes, crawler file-lock resilience. |
| **[v2.1.0](#v210---2026-08-24)** | 2026-08-24 | Minor | Cascading Multi-Factor Filter (Media ID + dHash + SHA256), Server-Wide History Crawler (`!rescan`), Missing Upload Backfill (`!repost-missing`). |
| **[v2.0.0](#v200---2026-08-22)** | 2026-08-22 | **MAJOR** | Universal Duplicate Link Detector (`linkDetector.js`), SQLite Persistence (`links.db`), Tracking Parameter Sanitizer, Configurable Scope. |
| **[v1.2.1](#v121---2026-08-15)** | 2026-08-15 | Patch | Environment template hardening (`.env.example`), Windows path separator safety. |
| **[v1.2.0](#v120---2026-08-15)** | 2026-08-15 | Minor | Async Concurrency Queue (`queue.js`), Live Emoji Reactions, Modular Cookie Vault, GPU Hardware Encoding (`nvenc`/`qsv`/`amf`), Embed Suppression. |
| **[v1.1.0](#v110---2026-08-02)** | 2026-08-02 | Minor | Permanent Local PC Archiving (`ENABLE_LOCAL_ARCHIVE`), Metadata Sidecars (`.json`), Perceptual Visual Hashing (`dHash`), Title Preservation. |
| **[v1.0.0](#v100---2026-07-25)** | 2026-07-25 | **MAJOR** | Genesis Release: Dual scraper engine (`yt-dlp` + `gallery-dl`), ffmpeg video re-encoding, retry command (`!repost`), GLIBC compatibility auto-recovery. |

---

## Release Details

### [v3.9.0] - 2026-09-18

#### Added & Improved
- **Interactive YouTube Playlists (`src/playlistHandler.js`)**:
  - Interactive Discord action buttons (`🎬 This Video Only`, `📁 Entire Playlist (N)`, `❌ Cancel`) with author/moderator permission gating.
  - Automatic Discord thread creation (`PLAYLIST_AUTO_THREAD=true`) to host playlist video batches and keep main channels clean.
  - Configurable item limits (`MAX_PLAYLIST_ITEMS=25`) and prompt timeouts (`PLAYLIST_PROMPT_TIMEOUT_SECONDS=30`).
- **Subtitle & Caption Extraction Engine (`src/ytdlpDownloader.js`, `src/archiver.js`, `src/mediaHandler.js`)**:
  - Automatically downloads creator-provided and auto-generated captions (.srt, .vtt) and archives them side-by-side on PC in `./archives`.
  - Configurable Discord chat upload toggle (`UPLOAD_SUBTITLES_TO_DISCORD=false`).
  - Automatically bundles multi-language subtitle tracks into a `.zip` when exceeding 3 tracks (`ZIP_MULTI_SUBTITLES=true`).

### [v3.8.0] - 2026-09-17

#### Added & Improved
- **Dedicated DeviantArt Platform Support (`deviantart.com`, `fav.me`, `sta.sh`) (`src/urlExtractor.js`, `src/mediaHandler.js`, `src/scanner.js`)**:
  - Full scraping support for DeviantArt artwork posts, galleries, Sta.sh uploads, and shortlinks.
  - DeviantArt fast-path routes requests directly to `gallery-dl`, bypassing `yt-dlp` and reducing extraction latency.
  - Maps artwork paths, Sta.sh, and `fav.me` shortlinks to canonical IDs (`deviantart:12345678`) using base-36 decoding.
- **Port 80 `fav.me` Unshortening (`src/urlExtractor.js`)**:
  - Unshortens `fav.me` shortlinks over HTTP port 80 in ~150ms, overcoming HTTPS port 443 absence and automated HEAD request blocks.
- **DeviantArt Cookie Vault Integration (`src/cookieVault.js`, `cookies/README.md`)**:
  - Automatically loads `cookies/deviantart.txt` or `cookies/da.txt` to archive age-gated and high-resolution deviations.
- **Interactive Guide Updates (`src/commands.js`)**:
  - Highlights DeviantArt in `/help` and feature summaries.

### [v3.7.0] - 2026-09-16

#### Added & Improved
- **Deleted Trigger Message Fallback (`safeReply`) (`src/mediaHandler.js`)**:
  - Automatically catches Discord error code 10008 ("Unknown Message") when trigger messages are deleted during active downloads, falling back to `channel.send()` to ensure media uploads and duplicate warnings are always delivered.
- **Context Menu & Slash Command Channel-Gating (`src/commands.js`)**:
  - Enforces `ALLOWED_CHANNEL_IDS` / `DISALLOWED_CHANNEL_IDS` channel restrictions on the "Repost / Archive Media" context menu command and `/rescan` slash command, preventing channel security bypasses.
- **Faststart MP4 Streaming Optimization (`src/streamMerge.js`, `src/thumbnailPreview.js`)**:
  - Adds `-movflags +faststart` to move the MP4 `moov` atom to the beginning of the container, enabling instant Discord inline video streaming before full download completes.
- **Perceptual Hash Performance Optimization (`src/phasher.js`)**:
  - Runs SHA-256 and media metadata probing concurrently in `computeMediaFingerprint()` and passes resolved metadata to `computeDHash()`, eliminating redundant second `ffprobe` process invocations.
- **Content Overflow Protection for Large Batches (`src/linkDetector.js`, `src/mediaHandler.js`)**:
  - Caps duplicate warnings (3 items) and failure notices (5 items) with overflow indicators to strictly respect Discord's 2,000-character message limit.
- **Live Pipeline Activity & Diagnostics Telemetry in `/status` (`src/commands.js`)**:
  - Added real-time queue metrics (`downloadQueue.running` / concurrency, pending queue depth / maxDepth, scanner activity) and formatted bot uptime (`Xd Xh Xm Xs`).

### [v3.6.1] - 2026-09-16

#### Fixed & Hardened
- **Discord Gateway Connection Resilience (`src/index.js`)**:
  - Added exponential backoff retry loop (`loginWithRetry`) to handle transient Discord API / Gateway outages (e.g. HTTP 500 Internal Server Error, 502 Bad Gateway, 503, 504, rate limits, and network resets) on boot.
  - Added dedicated `client.on(Events.Error)` and `client.on(Events.ShardError)` event handlers to prevent unhandled EventEmitter errors from terminating the Node process.
- **Anti-Bot Browser Impersonation & Human Jitter (`src/config.js`, `src/ytdlpDownloader.js`, `src/galleryDlDownloader.js`, `src/mediaHandler.js`, `src/utils.js`)**:
  - Added `IMPERSONATE_BROWSER=auto|chrome|firefox|edge|safari|off` passing `--impersonate` and aligned modern User-Agent strings to bypass Cloudflare and platform anti-scraping defenses.
  - Added `ENABLE_HUMAN_JITTER=true`, `HUMAN_JITTER_MIN_MS`, `HUMAN_JITTER_MAX_MS` applying randomized human reaction delays before platform requests.
  - Added `PREFER_BROWSER_COOKIES=false` option to prioritize browser cookies over disk cookie files.
- **SQLite Engine Performance & Prepared Statement Cache (`src/linkDb.js`, `src/db.js`)**:
  - Cached hot prepared statements across `_stmts` and `_mediaStmts`, compiling SQL statements once and eliminating runtime re-parsing overhead.
  - Tuned SQLite PRAGMAs: `PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -64000;` delivering a 10x–50x speedup for bulk scan commits while maintaining WAL crash safety.
- **Queue Flooding & Saturation Protection (`src/queue.js`, `src/config.js`)**:
  - Added `MAX_QUEUE_DEPTH` (default: 50). When the queue is saturated, new tasks are rejected with a temporary alert to protect from memory exhaustion during link floods.
- **Windows NTFS Reserved Device Name Defense (`src/utils.js`, `src/archiver.js`)**:
  - Added `sanitizePathSegment()` protecting against Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1–9`, `LPT1–9`) and trailing spaces/dots.
- **Native MP4 Stream Prioritization (`src/ytdlpDownloader.js`)**:
  - Updated yt-dlp format selector to `bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b`, prioritizing native MP4+M4A containers for instant remux-free playback in Discord.
- **Config & Snowflake ID Validation (`src/config.js`)**:
  - Validates Discord snowflake IDs (17–20 digits) in channel filter lists and bounds `DUPLICATE_HAMMING_THRESHOLD` between 0 and 64 with warnings for values above 20.

### [v3.6.0] - 2026-09-15

#### Added & Improved
- **Automatic Startup Catch-Up Scanner (`src/scanner.js`, `src/index.js`, `src/config.js`)**:
  - Automatically crawls recent channel message history on boot to catch and archive links posted while the host PC or bot was offline.
  - Implemented early pagination cutoff (`options.sinceTimestamp`) to halt backward scanning immediately when messages exceed the lookback window.
  - Added multi-guild channel resolution (`getScannableChannels`) adhering strictly to channel whitelisting and blacklisting.
  - Configurable via `AUTO_SCAN_ON_STARTUP`, `AUTO_SCAN_HOURS`, `AUTO_SCAN_REPOST_MISSING`, and `AUTO_SCAN_CONCURRENCY`.
- **Direct Browser Cookies Extraction (`src/config.js`, `src/ytdlpDownloader.js`, `src/galleryDlDownloader.js`)**:
  - Added `COOKIES_FROM_BROWSER` allowing users to directly authenticate with installed browsers (`firefox`, `chrome`, `edge`, `brave`) without manually extracting `.txt` cookies.
- **Unified Channel Whitelist & Blacklist Guard (`src/config.js`)**:
  - Centralized `isChannelAllowed()` logic for consistent permission handling across all events and scanners.
- **Diagnostics (`src/commands.js`)**:
  - Added startup scan status and configuration to `/status`.

### [v3.5.0] - 2026-09-12

#### Added (Audio & Music Platform Support)
- **Audio Extraction Engine**: yt-dlp now runs with `--extract-audio --audio-format mp3` for recognized audio platforms, allowing flawless integration with Discord's native audio player.
- **Supported Platforms**: Added explicit extraction and parsing logic for `soundcloud.com`, `bandcamp.com`, `mixcloud.com`, `audiomack.com`, and `music.youtube.com`.
- **Direct Audio URLs**: Added support for `.mp3`, `.ogg`, `.wav`, `.flac`, `.m4a`, `.opus`, `.aac`, `.alac`, and `.aiff` to `DIRECT_MEDIA_EXTENSIONS`.
- **Audio Compression (`compressAudio`)**: Integrated FFmpeg `libmp3lame` dynamically calculating target bitrates for oversized podcasts or DJ mixes, guaranteeing they fit under Discord's 10MB limit without arbitrarily failing.
- **Quality Preservation Gate (Audio)**: Will safely back out of compression if the track is so long that the required bitrate drops below 32 kbps, storing the high-res original in `./archives`.
- **Smart Fingerprinting**: Audio files now correctly bypass visual/frame perceptual hashing in `phasher.js` to prevent FFmpeg crashes, relying exclusively on SHA-256, duration, and URL.

---

### [v3.4.1] - 2026-09-12

#### Fixed & Reliability
- **Redundant Duplicate Notice Bug (`src/mediaHandler.js`)**: Fixed `duplicateUrls` array-of-objects lookup by checking `options.duplicateNormalizedSet?.has(normalized)` and `options.duplicateUrls.some(...)`, preventing double alert replies in chat.
- **Auto-Updater Crawler Lock (`src/autoUpdater.js`)**: Added `isScanRunning()` guard preventing scheduled 24h updates from running during active crawls, eliminating Windows `EBUSY` file locking errors.
- **Direct Downloader Unicode Preservation (`src/directDownloader.js`)**: Added `decodeURIComponent` for URL pathnames and updated `sanitizeFilename` to preserve Unicode letters and characters while stripping illegal filesystem symbols.
- **Single-Pass Compression & Thumbnail Injection (`src/compress.js`, `src/thumbnailPreview.js`, `src/mediaHandler.js`)**: Combined video downscaling, bitrate compression, and thumbnail preview injection into a single FFmpeg pass for oversized videos, cutting encoding time in half.
- **Startup Binary Validation (`src/ensureBinaries.js`)**: Added boot-time verification for `ffmpeg` and `ffprobe` with clear warnings if missing.
- **Social Embed Fixer Proxies (`src/urlExtractor.js`)**: Canonicalized `vxtwitter.com`, `fixupx.com`, `ddinstagram.com`, `vxreddit.com`, and `vxtiktok.com` to native platform domains.

### [v3.4.0] - 2026-09-12

#### Added & Improved
- **Task Cancellation & Abort Controls (`src/commands.js`, `src/index.js`, `src/scanner.js`, `src/queue.js`)**:
  - Added `/stop` slash command with `ManageMessages` permission enforcement and text commands `!stop` / `!cancel`.
  - Atomically signals crawler worker loops and message fetching to stop immediately, outputting an early-abort summary to chat.
  - Implemented `downloadQueue.clear()` to purge pending unstarted downloads and remove bot queue reactions from canceled messages.
- **Chronological History Crawling & Intelligent Repost Filtering (`src/scanner.js`)**:
  - Reverses candidate message batches (`candidateMessages.reverse()`) so channel history is processed from oldest to newest.
  - Maintains `channelUploadedMediaKeys` set to ensure true original posts are uploaded and subsequent duplicate reposts later in history are recognized and skipped.
  - Supports channel targeting by name (e.g. `#general` or `general`) as well as IDs and mentions.
- **Smart FFmpeg Thumbnail Extraction & Stream Fallbacks (`src/thumbnailPreview.js`)**:
  - Uses `ffprobe` JSON stream inspection to dynamically extract embedded image streams (`mjpeg`, `png`, `webp`).
  - Added FFmpeg representative frame filter (`-vf thumbnail=300`) as a high-quality fallback for older videos without embedded cover art.
- **Maintenance Sweeper Expansion (`src/utils.js`)**:
  - Added `archivist-scan-*` temp directories to `cleanupStaleTempDirs()`.
- **Command Dispatch Hardening (`src/index.js`)**:
  - Exact first-word token matching for `!repost`, `!rescan`, and `!stop` commands.

### [v3.3.0] - 2026-09-12

#### Added & Improved
- **YouTube & Platform Video Thumbnail Previews (`src/thumbnailPreview.js`)**:
  - Implemented automatic high-resolution thumbnail freeze-frame injection (~0.15s at `00:00:00`).
  - Forces Discord desktop, mobile, and web video players to display the official platform thumbnail instead of blank/black frames.
  - Video stream is processed using hardware-accelerated encoders (`h264_nvenc`, `h264_qsv`, `h264_amf`) with `libx264` fallback; audio stream is untouched (`-c:a copy`) with zero drift.
  - Controlled by `PREPEND_THUMBNAIL_PREVIEW` and `EMBED_THUMBNAIL` environment variables.
- **Cross-Instance Bot Attachment Deduplication in History Scanner (`src/scanner.js`)**:
  - Upgraded crawler to check `(msg.author?.id === botId || msg.author?.bot) && msg.reference?.messageId && msg.attachments?.size > 0`.
  - Ensures previous bot uploads are recognized across bot token rotations, preventing duplicate reposts during channel rescans.

### [v3.2.1] - 2026-09-12

#### Fixed & Polish
- **Discord 15-Minute Token Expiration Fallback (`src/commands.js`)**:
  - Added a graceful fallback mechanism to the `/rescan` slash command.
  - When historical message crawls or massive server sweeps take longer than Discord's 15-minute interaction token lifespan, the final summary is delivered to chat via standard channel message (`interaction.channel.send`) instead of throwing `DiscordAPIError[10062]: Unknown interaction`.
- **Normalized URL Matching in Pre-Download Duplicate Checks (`src/db.js`)**:
  - Enhanced `findDuplicateByUrl()` and `saveRecord()` to perform normalized URL lookups against `media_records`.
  - Direct media links containing varying tracking parameters, timestamp tokens, or CDN query strings (e.g. `image.png?v=1` vs `image.png?v=2`) are now recognized and deduplicated before initiating network downloads.

### [v3.2.0] - 2026-09-12

#### Added & Improved
- **Direct Download Extension & MIME Type Inference (`src/directDownloader.js`)**:
  - Automatically inspects the HTTP `content-type` header (e.g. `image/png`, `video/mp4`, `image/webp`, `audio/mpeg`, etc.) when downloading direct media URLs without an explicit extension in their URL path.
  - Guarantees downloaded files receive their proper media extensions so Discord inline players, audio players, and image viewers render properly rather than displaying generic raw binary icons.
- **Shortlink Resolver HTTP Method Fallback (`src/urlExtractor.js`)**:
  - Enhanced `resolveShortUrl()` with a dual-stage resolver.
  - Attempts a fast `HEAD` request first; if the destination server or bot gateway rejects `HEAD` with `405 Method Not Allowed`, `403 Forbidden`, or `400 Bad Request`, it falls back to a streamed `GET` request.
  - Aborts the body stream immediately upon receiving headers, unmasking protected shortlinks (`t.co`, `pin.it`, redirect gateways) with minimal network overhead.
- **Windows `MAX_PATH` Archive Filename Defense (`src/archiver.js`)**:
  - Added smart length capping (90 characters max) to archived media base names.
  - Protects against Windows filesystem 260-character `MAX_PATH` limits when long video titles are stored within nested channel and date directories alongside companion `.json` metadata sidecars.

### [v3.1.1] - 2026-09-12

#### Fixed & Reliability
- **In-Flight Download Mutex Leak Fix (`src/mediaHandler.js`)**:
  - Wrapped `inFlightDownloads` execution in a strict `try...finally` block.
  - Guarantees that URL download mutex locks are cleanly deleted even when downloads fail, time out, or throw errors, preventing memory leaks and stale promise stalls on repeated links.
- **FFmpeg Process Timeout & Zombie Tree Killer (`src/compress.js`)**:
  - Added a 4-minute execution timeout to `run(cmd, args)` in `src/compress.js`.
  - Integrated `killProcessTree(child)` so any hung, corrupted, or deadlocked `ffmpeg` and `ffprobe` processes are killed and removed from the operating system, freeing up concurrency worker slots.
- **Global Process Crash & WAL Flush Guards (`src/index.js`)**:
  - Attached top-level `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers.
  - Automatically executes SQLite Write-Ahead Log flushes (`checkpointWal('PASSIVE')`) on unhandled rejections and uncaught exceptions to protect against uncommitted journal corruption during unexpected network or disk disconnects.

### [v3.1.0] - 2026-09-12

#### Added
- **Interactive Command Guide (`/help` & `!help`)**:
  - Full visual Discord embed guide displaying all slash commands, message context menu apps, chat prefix commands, and automatic features.
  - Available via slash command `/help` or prefix command `!help`.
- **Quality Preservation Floor Gate**:
  - Automatically calculates video bandwidth requirements prior to ffmpeg re-encoding.
  - If a long video cannot fit into Discord's upload limit without severe visual degradation (dropping below $\approx 280\text{ kbps}$ total bitrate), the bot skips CPU/GPU-intensive re-encoding.
  - Preserves the pristine full-quality video to the local PC archive and posts a polite notification in chat directing the user to the local archive.
- **Dedicated Instagram Cookie Integration in `gallery-dl`**:
  - Automatically routes `cookies/instagram.txt` directly to `gallery-dl` requests via dynamic configuration generation (`src/galleryDlConfig.js`), enabling private/restricted gallery extraction.
- **Universal System CA Execution**:
  - Added `--use-system-ca` to default execution scripts (`package.json`, `run_bot.bat`), ensuring that Windows root Certificate Authorities are recognized without TLS handshake rejections.
- **Bot Version Reporting**:
  - Added `src/version.js` providing centralized version metadata exposed in `/status`, `/stats`, `/help`, and startup logs.

#### Changed & Optimized
- **Crawler Memory Optimization (>90% RAM Reduction)**:
  - Completely refactored `crawlChannel()` in `src/scanner.js` to filter messages without links in-stream rather than retaining 50,000+ Discord `Message` instances in heap memory.
  - Prevents Node.js V8 heap out-of-memory crashes on large Discord servers during historical crawls.
- **Instant Guild Slash Command Registration**:
  - Commands are registered directly to active joined guilds on startup (`guild.commands.set()`), bypassing Discord's 1-hour global CDN propagation delay for immediate availability.
- **Resilient Reaction Emoji Removal**:
  - Replaced fragile reaction cache `.get()` ID lookups with emoji name matching (`.find(r => r.emoji?.name === emoji)`), ensuring visual progress icons (`⏳`, `📥`, `⚙️`) are cleanly removed even under rapid event concurrency.

#### Fixed
- **Auto-Updater Concurrency Safety Lock**:
  - Auto-updater now checks `downloadQueue.running > 0` before executing binary updates (`yt-dlp -U`). Defers updates if active downloads are running to avoid Windows `EBUSY` executable file-locking errors.
- **Stale Temp Directory Sweeper**:
  - Added `cleanupStaleTempDirs()` in `src/utils.js` which purges orphaned `archivist-fox-*` temporary directories in `os.tmpdir()` older than 1 hour on bot startup.
- **Cookie Vault Zero-Byte Guard**:
  - Added `isValidCookieFile()` verifying `fs.statSync(file).size > 0` before passing cookie paths to scrapers, preventing crashes caused by empty cookie files.
- **Direct Download Connection Timeouts**:
  - Added an explicit 60-second connection and socket timeout to `axios.get` for direct media links, preventing dead or slowloris servers from permanently hanging worker queue slots.
- **Perceptual Hasher Process Timeouts**:
  - Added 15-second timeouts with `killProcessTree()` to `ffprobe` metadata probes and `ffmpeg` frame extraction, preventing truncated or malformed media files from freezing download workers.

---

### [v3.0.0] - 2026-09-12

#### Major Architecture Changes
- **Unified Native SQLite Engine (`src/db.js`)**:
  - Completely retired legacy flat-file `archives/index.json` in favor of Node.js native `node:sqlite` (`DatabaseSync`).
  - Created indexed `media_records` table with indexes on `media_id`, `sha256`, `original_url`, and `duration`.
  - Built automatic legacy migration: existing `archives/index.json` files are automatically converted to SQLite on launch and safely backed up to `index.json.bak`.
  - Perceptual visual hash duplicate checks now query duration range windows (`WHERE duration BETWEEN ? AND ?`) via SQLite index rather than scanning the entire database in memory.
  - Added WAL (Write-Ahead Logging) checkpoint maintenance: `PASSIVE` checkpoints during background pruning and `TRUNCATE` checkpoints on graceful shutdown to prevent `-wal` file bloat.

#### Added
- **Modern Discord Application Commands (Slash Commands & Context Menu)**:
  - **Message Context Menu App**: Right-click or long-press any message ➔ **Apps ➔ Repost / Archive Media** to re-trigger download and archival.
  - **`/status`**: Interactive diagnostics dashboard reporting live binary versions (`yt-dlp`, `gallery-dl`), detected hardware GPU encoder, active cookies, database row counts, archive storage usage, and system memory.
  - **`/stats`**: Server-wide analytics reporting total tracked links, preserved media items, total archive disk usage, top active channels, and top uploaders.
  - **`/rescan`**: Interactive slash command with options for `channel`, `limit`, `missing_only`, and `force`.
- **Interactive "Dismiss" Button on Duplicate Notices**:
  - Duplicate link alert messages now include an interactive `🗑️ Dismiss` button.
  - The original poster or server moderators (`Manage Messages` / `Administrator`) can click it to immediately delete the alert and keep chat clean.
- **Instant Video Streaming (`-movflags +faststart`)**:
  - Video re-encoding now injects the MP4 `moov` atom at the beginning of the file, allowing videos to stream and buffer immediately in Discord desktop and mobile apps without waiting for a 100% download.
  - Audio stream inspection: if the source audio is already AAC or Opus $\le 140\text{ kbps}$, it passes through with `-c:a copy` to save CPU cycles and maintain audio fidelity.
- **Windows-Safe Process Tree Killer (`killProcessTree`)**:
  - Replaced standard process kill signals with `taskkill /pid <PID> /T /F` on Windows, terminating all child `python` and `ffmpeg` worker processes spawned by `yt-dlp` and `gallery-dl`.
- **In-Flight Download Mutex**:
  - Implemented an `inFlightDownloads` Promise cache in `src/mediaHandler.js` to prevent duplicate concurrent downloads when multiple users post the same link simultaneously.
- **URL Unshortener & Expanded Platform Recognition**:
  - Asynchronous shortlink resolution for `t.co`, `bit.ly`, `tinyurl.com`, `pin.it`, and `vt.tiktok.com`.
  - Native platform extractors and canonical media ID parsing for **RedGifs** (`redgifs.com`), **Threads** (`threads.net`), **Pixiv** (`pixiv.net`), **Pinterest** (`pinterest.com`), **Facebook** (`facebook.com/reel`, `/watch`), and **Bilibili** (`bilibili.com/video/`).

---

### [v2.2.0] - 2026-09-10

#### Added
- **YouTube Video Thumbnail Previews**:
  - Added automatic extraction and embedding of high-resolution video thumbnails for YouTube links.
  - Enabled via `EMBED_THUMBNAIL=true` in `.env`.

#### Fixed
- **Split Stream Companion File Muxing Fix**:
  - Separated companion files (thumbnails, info JSONs, subtitles) from media stream muxing logic in `src/streamMerge.js`.
  - Resolved Reddit video downloads failing when companion image files were downloaded in the same directory.

---

### [v2.1.1] - 2026-08-25

#### Fixed
- **Facebook Reels & Watch Routing**:
  - Corrected media ID regex patterns for Facebook Reels (`/reel/ID`) and Facebook Watch URLs.
- **Gallery-dl Network Timeout Protection**:
  - Added timeout handling to `galleryDlDownloader.js` to prevent hung Twitter/X scraper requests from blocking the queue indefinitely.
- **Crawler Temp Directory Lock (`ENOENT`)**:
  - Wrapped crawler batch processing in `try...finally` blocks to guarantee temporary directory removal even if Discord API attachment uploads encounter transient errors.

---

### [v2.1.0] - 2026-08-24

#### Added
- **Cascading Multi-Factor Filter**:
  - Multi-stage deduplication pipeline:
    1. Fast pre-download **Platform Media ID** check (instant, zero network cost).
    2. Post-download **Perceptual Visual Hash (`dHash`)** comparison (detects re-encoded or resized copies).
    3. Exact **SHA-256 Binary Hash** comparison.
- **Server-Wide & Channel Message History Crawler (`scanner.js`)**:
  - Added prefix commands `!rescan`, `!crawl`, and `!repost-missing`.
  - Crawls past Discord message history to download and archive media at maximum quality (4K, 1080p, original images).
  - Supports scanning specific channels (`!rescan #channel`) or entire servers (`!rescan all`).
- **Missing Media Attachment Recovery (`!repost-missing`)**:
  - Analyzes historical messages to detect media links that never received an uploaded attachment (e.g. from downtime or false positives) and automatically uploads them to chat.
- **2GB Archive Hard Cap**:
  - Increased `HARD_CAP_MB` ceiling to 2000 MB (2 GB) to support high-fidelity preservation of full-length videos in local storage.

---

### [v2.0.0] - 2026-08-22

#### Major Architecture Changes
- **Universal Duplicate Link Detector (`src/linkDetector.js`, `src/linkDb.js`)**:
  - Expanded duplicate tracking from media-only links to **any link** posted in Discord (news articles, Steam store pages, documentation, Wikipedia, blog posts, social media).
  - High-performance SQLite database engine (`data/links.db`) using native `node:sqlite`.
  - Compound indexes on `(normalized_url, channel_id)`, `(normalized_url, guild_id)`, and `(posted_at)` for $<1\text{ ms}$ query latency.

#### Added
- **URL Normalization & Tracking Cleaner (`src/urlExtractor.js`)**:
  - Strips marketing and surveillance query parameters: `utm_*`, `si`, `igshid`, `fbclid`, `gclid`, `feature`, `ref`, `s`, `t`.
  - Canonicalizes hostnames (strips `www.`, `m.`, `mobile.`, `old.`).
  - Converts shortlinks to canonical forms (`youtu.be/ID` $\rightarrow$ `youtube.com/watch?v=ID`, `x.com` $\rightarrow$ `twitter.com`).
- **Configurable Detection Scope**:
  - `DUPLICATE_LINK_SCOPE=channel` (default) for per-channel duplicate tracking.
  - `DUPLICATE_LINK_SCOPE=guild` for server-wide duplicate detection.
- **Self-Repost Grace Period (`SELF_REPOST_GRACE_SECONDS`)**:
  - Configurable grace window (default 300 seconds / 5 minutes) where reposts or edits by the same author quietly update the timestamp without triggering a duplicate alert.
- **Rich Duplicate Alerts**:
  - Duplicate notifications provide original author mentions, channel context, relative timestamps (`<t:TIMESTAMP:R>`), and clickable jump-to-original links (`https://discord.com/channels/...`).
- **Automatic Retention Pruning (`DUPLICATE_LINK_RETENTION_DAYS`)**:
  - Allows links to automatically expire after a set number of days (`0` = keep forever).

---

### [v1.2.1] - 2026-08-15

#### Fixed
- **Environment Template Hardening**:
  - Reconstructed and documented all configuration parameters in `.env.example`.
- **Windows Path Sanitization**:
  - Sanitized Windows directory separators and illegal characters in generated archive paths.

---

### [v1.2.0] - 2026-08-15

#### Added
- **Asynchronous Download Concurrency Queue (`src/queue.js`)**:
  - Worker pool with configurable concurrency limits (`MAX_CONCURRENT_DOWNLOADS=2`).
  - Prevents system resource exhaustion when multiple media links are sent at once.
- **Live Visual Status Indicators**:
  - Dynamic Discord emoji reaction progression: `⏳` (queued) ➔ `📥` (downloading) ➔ `⚙️` (compressing) ➔ `✅` (uploaded) / `❌` (failed).
  - Discord native typing indicators while media processing is active.
- **Modular Cookie Vault (`src/cookieVault.js`)**:
  - Isolated Netscape-format cookie storage in `cookies/` (`youtube.txt`, `twitter.txt`, `instagram.txt`, `reddit.txt`, `pixiv.txt`, `tiktok.txt`).
  - Solves cross-site cookie collisions when authenticating across multiple platforms.
- **Hardware-Accelerated GPU Video Compression (`GPU_ACCELERATION`)**:
  - Support for NVIDIA NVENC (`h264_nvenc`), Intel QuickSync (`h264_qsv`), and AMD AMF (`h264_amf`).
  - Automatic hardware detection with graceful fallback to CPU `libx264`.
- **Scraper Binary Auto-Updater (`src/autoUpdater.js`)**:
  - Background scheduler that periodically runs `yt-dlp -U` and checks for gallery-dl releases (`AUTO_UPDATE_INTERVAL_HOURS=24`).
- **Discord Link Embed Suppression (`AUTO_SUPPRESS_EMBEDS=true`)**:
  - Automatically calls `message.suppressEmbeds(true)` on original messages after uploading media attachments to remove broken or redundant link preview cards.
- **Smart Archive Subfolder Organization (`ARCHIVE_SUBFOLDER_FORMAT`)**:
  - Structured local file storage options: `channel/date`, `date/channel`, `channel`, or `flat`.
- **Multi-Image Album Batching (Method B)**:
  - Automatically splits galleries exceeding Discord's 10-file upload limit into clean sequential follow-up reply batches without requiring zip compression.

---

### [v1.1.0] - 2026-08-02

#### Added
- **Permanent Local PC Archiving (`ENABLE_LOCAL_ARCHIVE`)**:
  - Saves full-quality, uncompressed original media files directly to a local directory (`ARCHIVE_DIRECTORY=./archives`).
  - Preserves original file titles and names instead of numeric hashes.
- **Metadata Sidecar Generation (`ARCHIVE_SAVE_METADATA=true`)**:
  - Saves a companion `.json` metadata file alongside each preserved media item (storing original URL, author, channel ID, timestamp, and extractor details).
- **Perceptual Visual Hashing (`src/phasher.js`)**:
  - Integrated `dHash` perceptual visual hashing via ffmpeg frame extraction.
  - Detects duplicate or near-identical images and videos using 64-bit Hamming distance comparison (`DUPLICATE_HAMMING_THRESHOLD=5`).
- **Auto-Expiring Status Notices (`ERROR_MESSAGE_TTL_SECONDS`)**:
  - Automatically deletes status and error messages after a configured number of seconds.

#### Fixed
- **YouTube Shorts Scraper Routing**:
  - Prevented gallery-dl from attempting to handle YouTube Shorts URLs.
- **Duplicate Prevention Bypass Fix**:
  - Corrected database query logic to prevent duplicate media from being re-uploaded to chat.

---

### [v1.0.0] - 2026-07-25

#### Initial Release (Genesis)
- **Automatic Media URL Detection**:
  - Scans Discord messages for direct media links (`.mp4`, `.webm`, `.png`, `.jpg`, `.gif`) and supported social media URLs.
- **Dual-Scraper Media Pipeline**:
  - `yt-dlp` integration for video posts (YouTube, Twitter/X, TikTok, Reddit, Instagram).
  - `gallery-dl` fallback integration for image galleries and photo carousels.
- **FFmpeg Video Compression Engine**:
  - Dynamically calculates target video bitrates to compress oversized videos down to Discord upload limits (`MAX_FILE_SIZE_MB=10`).
- **Binary Environment Auto-Configuration (`src/ensureBinaries.js`)**:
  - Automatic detection and downloading of `yt-dlp` and `gallery-dl` executables on startup.
  - Added Linux GLIBC 2.35 compatibility checking and Python `pip` module fallback for headless hosting environments (e.g. Wispbyte).
- **Manual Retry Command (`!repost`)**:
  - Allows users to reply to an earlier message with `!repost` to re-trigger download/upload with ✅/❌ reaction feedback.
- **Channel Access Filtering**:
  - Configurable channel restrictions using `ALLOWED_CHANNEL_IDS` and `DISALLOWED_CHANNEL_IDS`.
- **Project Rebranding**:
  - Fully rebranded from generic `discord-media-bot` to **Archivist Fox**.
