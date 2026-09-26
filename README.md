# Archivist Fox

[![Support on Ko-fi](https://img.shields.io/badge/Support_on_Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/artemszafik)

A Discord bot that watches messages for media links — either direct file
links (`.jpg`, `.mp4`, `.mp3`, etc.), social platform posts & art galleries
(Twitter/X, TikTok, Instagram, Reddit, DeviantArt, and more), or audio/music
tracks (SoundCloud, Bandcamp, Mixcloud, Audiomack, YouTube Music) — downloads
the media, and replies to the original poster with it as a file attachment.

## How it works

1. On every message, the bot scans for URLs.
2. Direct media URLs (ending in a known image/video extension) are downloaded directly.
3. Social platform links are handed to [yt-dlp](https://github.com/yt-dlp/yt-dlp) first (best for video/GIF posts). If yt-dlp reports no video was found — e.g. a plain photo post — the bot falls back to [gallery-dl](https://github.com/mikf/gallery-dl), which is built specifically for image galleries across Twitter/X, Instagram, Reddit, Tumblr, Pixiv, DeviantArt, and more.
4. The bot replies to the original message with the downloaded file(s) attached.
5. If a video is too big for Discord's upload limit, the bot tries to re-encode it down with ffmpeg (optional, and can be turned off).

## Requirements

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and on your PATH
  - Easiest install: `pip install -U yt-dlp` (or `pipx install yt-dlp`)
  - Keep it updated regularly — social sites change their internals often and yt-dlp ships frequent fixes
- [gallery-dl](https://github.com/mikf/gallery-dl) installed and on your PATH — handles image-only posts that yt-dlp won't touch
  - Install: `pip install -U gallery-dl`
- ffmpeg + ffprobe on your PATH — **strongly recommended even if you don't want compression**. Many sites (notably Reddit) serve video and audio as separate streams that yt-dlp needs ffmpeg to merge; without it, those downloads will fail outright.
  - Install via your OS package manager, e.g. `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Debian/Ubuntu)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a Discord application and bot:
   - Go to https://discord.com/developers/applications → New Application
   - Go to the "Bot" tab → enable **Message Content Intent** (under Privileged Gateway Intents)
   - Copy the bot token

3. Invite the bot to your server with these permissions: **View Channel, Send Messages, Attach Files, Read Message History, Add Reactions** (the last one is for the retry command's ✅/❌ feedback).
   You can generate an invite link from the "OAuth2 → URL Generator" tab (scope: `bot`).

4. Configure the bot:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and paste in your `DISCORD_TOKEN`. Adjust the other options as you like — they're documented inline.

5. Run it:
   ```bash
   npm start
   ```

## Configuration options (`.env`)

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | — | Your bot's token (required) |
| `ALLOWED_CHANNEL_IDS` | (all channels) | Comma-separated channel IDs to restrict the bot to. If set, `DISALLOWED_CHANNEL_IDS` is ignored |
| `DISALLOWED_CHANNEL_IDS` | (none) | Comma-separated channel IDs to exclude — the bot runs everywhere else. Only applies when `ALLOWED_CHANNEL_IDS` is empty |
| `MAX_FILE_SIZE_MB` | `10` | Max size the bot will upload. Match this to your server's boost level (10 / 50 / 100 MB) |
| `ENABLE_COMPRESSION` | `true` | Re-encode oversized videos down with ffmpeg to fit the limit |
| `HARD_CAP_MB` | `2000` | Largest file the bot will ever download, even when trying to compress |
| `CLEANUP_TEMP_FILES` | `true` | Delete downloaded files after uploading (recommended) |
| `YTDLP_PATH` / `GALLERYDL_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | on PATH | Override if those binaries aren't on your system PATH |
| `ERROR_MESSAGE_TTL_SECONDS` | `0` | Auto-delete error/status messages after this many seconds. `0` = never delete |
| `RETRY_COMMAND` | `!repost` | Reply to a message with a link and send this to retry it (see below) |
| `REUP_COMMAND` | `!reup` | Reply to a message to force re-upload media, bypassing duplicate checks |
| `AUTO_DELETE_COMMAND_MESSAGES` | `true` | Automatically delete user command messages (`!repost`, `!reup`, `!rescan`, etc.) |
| `COMMAND_MESSAGE_TTL_SECONDS` | `4` | Delay in seconds before deleting user command messages |
| `INCLUDE_TITLE_IN_MESSAGE` | `true` | Include the original media/post title in the bot's reply |
| `EMBED_THUMBNAIL` | `true` | Embed thumbnail artwork into downloaded video files via ffmpeg |
| `PREPEND_THUMBNAIL_PREVIEW` | `true` | Inject a 0.15s frozen thumbnail frame into videos to ensure instant Discord video player previews |
| `AUTO_SPOILER_NSFW` | `true` | Automatically spoiler NSFW/adult media from known domains or metadata flags |
| `SPOILER_NON_NSFW_CHANNELS_ONLY` | `true` | Only apply spoilers in regular channels (allows NSFW channels to display unspoilered) |
| `SPOILER_USER_FLAGGED_LINKS` | `true` | Automatically spoiler attachments if the user typed their link inside `\|\|...\|\|` |
| `SPOILER_TITLES` | `true` | Format message titles as `\|\|**Title**\|\|` when attachments are spoilered |
| `ENABLE_AUDIO_EXTRACTION` | `true` | Extract and process audio tracks from SoundCloud, Bandcamp, YouTube Music, etc. |
| `AUDIO_FORMAT` | `mp3` | Target audio format for downloaded songs/tracks |
| `AUDIO_QUALITY` | `0` | VBR audio quality (`0` = highest quality / ~320kbps) |
| `MAX_AUDIO_BITRATE_KBPS` | `320` | Max audio bitrate allowed before compressing oversized audio |
| `ENABLE_LOCAL_ARCHIVE` | `true` | Permanently save full-quality uncompressed media to your local PC |
| `ARCHIVE_DIRECTORY` | `./archives` | Folder path on your PC where original files are preserved |
| `ARCHIVE_SAVE_METADATA` | `true` | Save a matching `.json` metadata file (URL, author, channel, date) alongside media |
| `ENABLE_DUPLICATE_PREVENTION` | `true` | Detect visual duplicates, prevent redundant downloads, and send auto-deleting notices |
| `DUPLICATE_HAMMING_THRESHOLD` | `5` | Maximum bit difference allowed for visual similarity matching (0 to 64) |
| `GPU_ACCELERATION` | `auto` | GPU video compression (`auto`, `nvenc` for NVIDIA, `qsv` for Intel, `amf` for AMD, `off` for CPU) |
| `ENABLE_AUTO_UPDATE_BINARIES` | `true` | Periodically update yt-dlp & gallery-dl in the background |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | How often (in hours) to check for scraper binary updates |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Maximum concurrent media downloads/compressions in the queue |
| `MAX_QUEUE_DEPTH` | `50` | Maximum number of tasks allowed in the download queue at once |
| `ENABLE_PLAYLIST_DOWNLOAD` | `true` | Enable fetching and interactive prompting for YouTube playlists |
| `MAX_PLAYLIST_ITEMS` | `25` | Maximum number of videos to parse and download from a single playlist |
| `PLAYLIST_AUTO_THREAD` | `true` | Automatically create a thread to post playlist videos to avoid channel clutter |
| `PLAYLIST_PROMPT_TIMEOUT_SECONDS` | `30` | Timeout in seconds before defaulting to single video download or cancelling |
| `ENABLE_SUBTITLES` | `true` | Automatically download and archive creator-provided subtitles/captions |
| `UPLOAD_SUBTITLES_TO_DISCORD` | `false` | Upload subtitle files into Discord (`false` = archive locally on PC only, keeping Discord clean) |
| `SUBTITLE_SOURCE` | `creator` | Source of subtitles (`creator` or `all` for auto-generated) |
| `SUBTITLE_LANGS` | `all` | Preferred subtitle languages (`all`, `en`, `en.*,ja`) |
| `SUBTITLE_FORMAT` | `srt` | Target subtitle format (`srt`, `vtt`) |
| `ZIP_MULTI_SUBTITLES` | `true` | Zips subtitle files if a video has many language tracks to avoid Discord spam |
| `MAX_INDIVIDUAL_SUBTITLES` | `3` | Max subtitle files to upload individually before bundling into a .zip archive |
| `AUTO_SUPPRESS_EMBEDS` | `true` | Automatically suppress the original link's preview embed after uploading media |
| `ARCHIVE_SUBFOLDER_FORMAT` | `channel/date` | Smart subfolder structure on PC (`channel/date`, `date/channel`, `channel`, `flat`) |
| `ENABLE_GENERAL_DUPLICATE_DETECTOR` | `true` | Detect when any link (media, news, docs, articles, websites) has been posted before |
| `DUPLICATE_LINK_SCOPE` | `channel` | Duplicate detection scope: `channel` (per-channel) or `guild` (server-wide) |
| `DUPLICATE_LINK_RETENTION_DAYS` | `0` | Retention memory window in days (`0` = disabled / remember links forever) |
| `SELF_REPOST_GRACE_SECONDS` | `300` | Grace window (seconds) to ignore duplicate warnings if same user reposts/edits |
| `DUPLICATE_LINK_ALERT_TTL_SECONDS` | `0` | Auto-delete duplicate link alert notices after this many seconds (`0` = never delete) |
| `LINK_DB_PATH` | `./data/links.db` | SQLite database file path for tracking posted links |
| `LINK_BACKUP_CHANNELS` | (all) | Comma-separated channel names or IDs to export/backup (leave blank for all) |
| `LINK_BACKUP_DIR` | `./backups/links` | Local destination folder for link exports (JSON, Markdown, CSV) |
| `RESTORE_PACE_DELAY_MS` | `1500` | Delay in milliseconds between reposting links during restoration to respect rate limits |
| `RESCAN_COMMAND` | `!rescan` | Command to crawl past channel/server history and batch-archive media to PC |
| `SCANNER_CONCURRENCY` | `3` | Number of parallel download workers during a channel rescan/crawl |
| `AUTO_SCAN_ON_STARTUP` | `true` | Automatically scan recent messages on startup to catch up on links posted while PC was off |
| `AUTO_SCAN_HOURS` | `24` | How many hours back from bot startup to scan across all allowed channels |
| `AUTO_SCAN_REPOST_MISSING` | `true` | Repost missing media attachments to Discord during the startup catch-up scan |
| `AUTO_SCAN_CONCURRENCY` | `3` | Number of parallel download workers during the startup catch-up scan |
| `COOKIES_FROM_BROWSER` | `firefox` | Directly read login cookies from your local browser (`firefox`, `chrome`, `edge`, `brave`) |
| `PREFER_BROWSER_COOKIES` | `false` | Prioritize browser cookies over manual cookie files in `./cookies` |
| `PIXIV_REFRESH_TOKEN` | — | Pixiv OAuth refresh token (auto-cached by `pixiv_login.bat`) |
| `IMPERSONATE_BROWSER` | `auto` | Mimic real browser fingerprint (`auto`, `chrome`, `firefox`, `edge`, `safari`, `off`) to bypass anti-bot blocks |
| `ENABLE_HUMAN_JITTER` | `true` | Add subtle randomized delays between download requests to prevent rate limits |
| `HUMAN_JITTER_MIN_MS` | `1500` | Minimum delay in milliseconds for human jitter |
| `HUMAN_JITTER_MAX_MS` | `3500` | Maximum delay in milliseconds for human jitter |
| `ENABLE_WEB_UI` | `true` | Launch the browser-based Web Downloader & Dashboard on startup |
| `WEB_PORT` | `3000` | Port for the Web UI server |
| `WEB_HOST` | `0.0.0.0` | Host binding for Web UI (`0.0.0.0` allows LAN access, `127.0.0.1` for local only) |

## Slash Commands & Context Menu Apps

Archivist Fox includes modern Discord Application Commands:

- **`/help` (or `!help` in chat)**:
  - Displays a complete visual guide in chat showing all available slash commands, apps, prefix commands, and features.
- **Message Context Menu ("Apps $\rightarrow$ Repost / Archive Media")**:
  - Right-click (or tap & hold on mobile) on any Discord message containing media links and choose **Apps $\rightarrow$ Repost / Archive Media** to re-trigger downloading and archiving on that message.
- **`/status`**:
  - Displays a live system diagnostics dashboard showing yt-dlp & gallery-dl binary versions, detected hardware GPU video encoder (NVENC, QSV, AMF, or CPU), database record counts, local archive disk size, and loaded platform cookies.
- **`/stats`**:
  - Server-wide link and media archiving statistics, including total links tracked, total files preserved, top channels, and top uploaders.
- **`/rescan [channel] [limit] [missing_only] [force] [concurrency]`**:
  - Interactive slash command to scan channel message history and bulk-archive media directly from Discord.
  - Prefix command equivalent: `!rescan 500 --repost-missing -c 4` (use `-c` or `--concurrency` to control parallel download speed).
- **`/export-links [channel] [format]`**:
  - Export tracked server links to structured JSON, Markdown tables, or CSV spreadsheets with rich summary embeds and direct file attachments.
- **`/restore [source_channel] [target_channel] [auto_create_channels] [attribution] [dry_run]`**:
  - Disaster recovery tool that reposts links from backup files sequentially into Discord channels with rate-limit safe pacing and channel auto-creation.
  - Prefix command equivalent: `!restore misc-links` (or `!restore all`).
- **`/stop`**:
  - Immediately aborts and halts any running `/rescan` channel crawl, `/restore` link restoration session, bulk archiving, or queued background tasks.
- **Duplicate Notice "Delete Post" & "Dismiss" Buttons**:
  - When all links in a message are duplicates, the bot attaches both a `🗑️ Delete Post` button and a `✖️ Dismiss` button. The original poster or server moderators can delete the duplicate message and alert in one click.

## Re-scanning & Bulk Archiving (`!rescan` / `!crawl` / `!repost-missing`)

You can crawl past message history across channels or the entire server to download and archive media in maximum quality (4K, 1080p, original images), as well as repost any missing media attachments that were skipped:

- `!repost-missing` &mdash; Scans current channel for any media links that never received a bot attachment upload (e.g. from past false-positive duplicate flags or offline downtime) and uploads them!
- `!repost-missing #channel` &mdash; Reposts missing media for a specific channel.
- `!repost-missing all` &mdash; Server-wide check: finds and reposts missing media uploads across all channels.
- `!rescan` &mdash; Scans and archives the entire message history of the current channel to PC.
- `!rescan #channel-name` &mdash; Scans a specific channel.
- `!rescan all` &mdash; Server-wide crawl: traverses every readable channel in the server.
- `!rescan 100` &mdash; Scans the last 100 messages in the channel.
- `!rescan --missing` &mdash; Same as `!repost-missing` (archives to PC and reposts missing media to Discord).
- `!rescan all --upload` &mdash; Re-uploads attachments for all messages in Discord.
- `!rescan --force` &mdash; Re-downloads and re-indexes all media even if already in database.

*Note: Requires `Manage Messages` or `Administrator` permission.*

## Automatic Catch-Up on Startup (Offline Catch-Up)

If you don't run the bot 24/7 or turn off your PC at night, the bot automatically catches up as soon as you turn it on:
- **Zero Configuration Needed**: Enabled by default (`AUTO_SCAN_ON_STARTUP=true`).
- **24-Hour Scan Window**: Automatically checks all messages posted within the last 24 hours (`AUTO_SCAN_HOURS=24`).
- **Channel Whitelist/Blacklist Aware**: Only scans channels allowed by `ALLOWED_CHANNEL_IDS` and excludes any in `DISALLOWED_CHANNEL_IDS`.
- **Downloads & Reposts**: Saves high-quality original files to your local PC archive (`./archives`), and reposts any missing attachments to Discord for messages that never received bot replies while offline.
- **Fast History Cutoff**: Stops fetching channel history as soon as it reaches messages older than the time window, saving bandwidth and Discord API limits.

## YouTube Playlists & Auto-Threading

When a YouTube playlist link or video link containing a `&list=` parameter is shared in chat:
- **Interactive Action Buttons**: Attaches an interactive prompt message with buttons:
  - `🎬 This Video Only` &mdash; Downloads and processes only the single video link.
  - `📁 Entire Playlist (N)` &mdash; Downloads and archives the entire playlist batch up to `MAX_PLAYLIST_ITEMS` (default: 25).
  - `❌ Cancel` &mdash; Dismisses the prompt and cancels downloading.
- **Permission Guarded**: Only the user who posted the link or server moderators (`Manage Messages`) can interact with the action buttons.
- **Automatic Thread Isolation (`PLAYLIST_AUTO_THREAD=true`)**: Creates a dedicated Discord thread to upload the playlist videos sequentially, preventing main channel chat spam.
- **Graceful Timeout**: If no selection is clicked within 30 seconds (`PLAYLIST_PROMPT_TIMEOUT_SECONDS`), the bot automatically defaults to downloading just the single video.

## Subtitle & Caption Extraction

Archivist Fox can automatically capture video subtitles and captions alongside downloads:
- **Creator & Auto-Captions**: Downloads manual creator-provided captions or YouTube auto-generated captions in `.srt` or `.vtt` format (`SUBTITLE_SOURCE=creator|all`).
- **Permanent Local Storage**: Subtitles are saved directly into your local `./archives` folder alongside the video file and metadata JSON.
- **Multi-Language ZIP Bundling (`ZIP_MULTI_SUBTITLES=true`)**: If a video contains more than 3 subtitle tracks (`MAX_INDIVIDUAL_SUBTITLES=3`), the bot bundles them into a single clean `.zip` file before uploading to Discord.
- **Clean Chat Mode (`UPLOAD_SUBTITLES_TO_DISCORD=false`)**: Keep Discord chat clutter-free by saving subtitles to your PC archive only, or toggle `true` to attach them directly into Discord messages.

## Web Dashboard & Direct Downloader

Archivist Fox includes a built-in browser-based control center and media player:
- **How to Launch**:
  - Double-click `run_web.bat` (or run `npm run web`), or set `ENABLE_WEB_UI=true` in `.env` to start automatically alongside the Discord bot.
- **Access**: Open `http://localhost:3000` (or your configured `WEB_PORT`) in any browser.
- **Features**:
  - **Direct Downloader**: Paste any supported media link into the web input to download and archive immediately with real-time SSE progress indicators (`checking`, `downloading`, `processing`, `archiving`).
  - **Integrated Archive Explorer**: Browse your local `./archives` library with responsive image, video, and audio players.
  - **Windows Explorer Shortcut**: Click the folder icon to instantly reveal any downloaded file in your Windows file manager.
  - **Live Telemetry & Diagnostics**: View live database link counts, active download queue depths, and archive disk usage.

## Auto-Spoiler System (NSFW & Sensitive Media)

Keep your Discord server clean and compliant with automatic spoiler tagging:
- **Domain & Platform Detection**: Automatically flags links from known adult/NSFW platforms (e.g. RedGifs, Danbooru, Gelbooru, etc.).
- **Deep Metadata Inspection**: Automatically checks yt-dlp (`age_limit >= 18`) and gallery-dl metadata (`is_mature`, `r-18`, `nsfw`) to spoiler age-gated content.
- **In-Chat User Spoiler Syntax**: If a user posts their link inside spoiler tags (`||https://...||`), the bot automatically marks the downloaded file attachments as spoilers too (`SPOILER_USER_FLAGGED_LINKS=true`).
- **Spoilered Titles (`SPOILER_TITLES=true`)**: Formats titles as `||**Title**||` when attachments are spoilered.
- **Smart Channel Scoping (`SPOILER_NON_NSFW_CHANNELS_ONLY=true`)**: Regular channels receive spoilers, while age-restricted/NSFW channels display media unspoilered unless explicitly spoilered by the user.

## Pixiv OAuth Authentication

To download high-resolution Pixiv illustrations and multi-image manga works without manual cookie extraction:
1. Double-click `pixiv_login.bat` (or run `npm run pixiv-login`).
2. Follow the prompt in your browser to log into Pixiv, right-click the login button, copy the callback URL, and paste it back into the terminal.
3. The script automatically writes `PIXIV_REFRESH_TOKEN` to `.env` and configures gallery-dl.
4. For detailed step-by-step instructions, see `PIXIV_LOGIN_GUIDE.txt`.

## Link Backup & Disaster Recovery (`/export-links` & `/restore`)

Archivist Fox includes an export, backup, and disaster-recovery engine for your server's link database:

### 1. Multi-Format Link Exports (`/export-links` or CLI)
Export your link history at any time directly through Discord or the terminal:
- **Discord Slash Command**: `/export-links [channel] [format]` (JSON, Markdown, or CSV) displays a statistical summary embed and attaches downloadable backup files.
- **Command-Line Interface**: Run `npm run export-links` (or `node scripts/export_links.js [channel] [format]`).
- **Formats Generated** (saved to `./backups/links`):
  - **Master JSON**: `links_backup_<timestamp>.json` and `latest.json` containing complete metadata and user message commentary context.
  - **Per-Channel JSON**: `channels/<channel>.json` for individual channel archives.
  - **Human-Readable Markdown**: `markdown/<channel>.md` formatted as neat Markdown tables with links, user tags, timestamps, and message comments.
  - **Spreadsheet CSV**: `csv/<channel>.csv` for analysis in Excel or Google Sheets.

### 2. Automated Link Restoration & Reposting (`/restore` or CLI)
If a Discord channel is accidentally deleted, wiped, or you are migrating links:
- **Discord Slash Command**: `/restore source_channel:misc-links target_channel:#misc-links`
  - Interactive autocomplete for available backup channels.
  - Live in-place status editing as links are reposted.
- **Chat Prefix Shortcut**: `!restore misc-links` (reposts links directly into the current channel).
- **Command-Line Tool**: Run `npm run restore-links -- --channel=misc-links --guild=YOUR_GUILD_ID` with options `--auto-create`, `--attribution`, and `--dry-run`.
- **Channel Auto-Creation (`auto_create_channels: true`)**: Automatically recreates missing text channels if they were deleted.
- **Author Attribution (`attribution: true`)**: Attaches `(originally shared by @User on YYYY-MM-DD)` alongside original message commentary.
- **Rate-Limit Safe**: Automatically paces reposting (`RESTORE_PACE_DELAY_MS=1500`) to strictly avoid Discord API rate limits.
- **Cancel Anytime**: Full support for `/stop` or `!stop` to halt an active restoration task.

## Running Tests

Archivist Fox includes a native test suite with 69 unit and integration tests covering commands, configuration, database operations, export formatting, and URL extraction:

```bash
# Run all tests
npm test

# Run tests in watch mode during development
npm run test:watch

# Run tests with code coverage analysis
npm run test:coverage
```

## Retrying and Re-uploading links

### Standard Retry (`!repost` / `!retry`)
If a link was posted while the bot wasn't running (or a download failed), reply to that message with `!repost` (or whatever `RETRY_COMMAND` is set to). The bot re-runs the download/upload pipeline on the message you replied to and reacts with ✅ or ❌ so you get quiet feedback without extra clutter. If duplicate prevention is enabled, it will still skip already-archived media.

### Force Re-upload (`!reup` / `!retry --force`)
If you explicitly want the bot to upload a piece of media that it previously archived or flagged as a duplicate, reply to the message with `!reup` (or `!reupload`, `!force`, or `!retry --force`). This overrides duplicate detection and forces the bot to upload the attachment. As a bonus, if the bot finds the pristine original file in your local `ARCHIVE_DIRECTORY`, it will instantly use it to save bandwidth and skip re-downloading!

Sending `!repost` without replying to anything gets you a short reminder of how to use it.

## Fixing Reddit's "blocked by network security" error

Reddit has been flagging gallery-dl's default requests as bot traffic. The fix is to make gallery-dl authenticate through Reddit's real API instead of scraping pages directly:

1. Go to **https://www.reddit.com/prefs/apps** (log into Reddit first).
2. Click **"create app"** (or "create another app") near the bottom.
3. Fill in:
   - **name**: anything, e.g. `archivist-fox`
   - **type**: select **script**
   - **description**: optional
   - **redirect uri**: `http://localhost:6414/` (required by the form, not actually used for this)
4. Click **"create app"**. You'll see your new app listed — the string of letters/numbers directly under the app name (next to "personal use script") is your **client ID**.
5. In your `.env` file, set:
   ```
   REDDIT_CLIENT_ID=the_client_id_you_just_copied
   REDDIT_USER_AGENT=archivist-fox:v1.0 (by /u/your_reddit_username)
   ```
   (Reddit requires a descriptive user-agent in roughly that `platform:app-id:version (by /u/user)` format — see [their API rules](https://github.com/reddit-archive/reddit/wiki/API#rules).)
6. Restart the bot. Reddit image links routed through gallery-dl will now authenticate via the API instead of looking like a scraper.

This only covers public content — no login or refresh token needed. If you still hit the block occasionally after this, it's a known, evolving issue on Reddit's side (see [gallery-dl's issue tracker](https://github.com/mikf/gallery-dl/issues?q=blocked+by+network+security)); waiting a bit and retrying usually works.

## Notes & limitations

- Whether an image-only post (e.g. a plain photo tweet) downloads correctly depends on yt-dlp/gallery-dl's extractor support for that site and post type — this is generally solid for Twitter/X, Instagram, and Reddit, but can vary.
- Some sites (notably Reddit) serve video and audio as separate streams. yt-dlp normally merges these via ffmpeg, but if ffmpeg isn't properly detected, it silently falls back to leaving them as two separate files. The bot double-checks for this after every platform download and merges any leftover video-only + audio-only pair itself — but this still requires a working ffmpeg install. **On Windows especially**, `pip install`-ing yt-dlp/gallery-dl does *not* install ffmpeg — you need to download it separately (e.g. from https://www.gyan.dev/ffmpeg/builds/) and add its `bin` folder to your PATH, then confirm with `ffmpeg -version` in a fresh terminal.
- X (Twitter) has increasingly restricted unauthenticated scraping. If gallery-dl starts failing on X links specifically, you may need to supply login cookies — see [gallery-dl's Twitter docs](https://github.com/mikf/gallery-dl/blob/master/docs/configuration.rst) for how to configure `cookies`.
- The bot currently recognizes a fixed list of platform domains (see `PLATFORM_DOMAINS` in `src/urlExtractor.js`) so it doesn't spawn yt-dlp for every random link posted in chat. Add more domains there if you want to support additional sites — yt-dlp itself supports a very long list (see their [supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)).
- The bot monitors incoming chat messages in real time. Historical channel messages can be crawled and archived anytime using `/rescan` (or `!rescan`), and recently missed messages during host downtime are automatically caught up on startup (`AUTO_SCAN_ON_STARTUP=true`).
