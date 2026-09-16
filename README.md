# Archivist Fox

A Discord bot that watches messages for media links — either direct file
links (`.jpg`, `.mp4`, etc.) or social platform posts (Twitter/X, TikTok,
Instagram, Reddit, and more) — downloads the media, and replies to the
original poster with it as a file attachment.

## How it works

1. On every message, the bot scans for URLs.
2. Direct media URLs (ending in a known image/video extension) are downloaded directly.
3. Social platform links are handed to [yt-dlp](https://github.com/yt-dlp/yt-dlp) first (best for video/GIF posts). If yt-dlp reports no video was found — e.g. a plain photo post — the bot falls back to [gallery-dl](https://github.com/mikf/gallery-dl), which is built specifically for image galleries across Twitter/X, Instagram, Reddit, Tumblr, Pixiv, and more.
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
| `HARD_CAP_MB` | `200` | Largest file the bot will ever download, even when trying to compress |
| `CLEANUP_TEMP_FILES` | `true` | Delete downloaded files after uploading (recommended) |
| `YTDLP_PATH` / `GALLERYDL_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | on PATH | Override if those binaries aren't on your system PATH |
| `ERROR_MESSAGE_TTL_SECONDS` | `0` | Auto-delete error/status messages after this many seconds. `0` = never delete |
| `RETRY_COMMAND` | `!repost` | Reply to a message with a link and send this to retry it (see below) |
| `ENABLE_LOCAL_ARCHIVE` | `true` | Permanently save full-quality uncompressed media to your local PC |
| `ARCHIVE_DIRECTORY` | `./archives` | Folder path on your PC where original files are preserved |
| `ARCHIVE_SAVE_METADATA` | `true` | Save a matching `.json` metadata file (URL, author, channel, date) alongside media |
| `ENABLE_DUPLICATE_PREVENTION` | `true` | Detect visual duplicates, prevent redundant downloads, and send auto-deleting notices |
| `DUPLICATE_HAMMING_THRESHOLD` | `5` | Maximum bit difference allowed for visual similarity matching (0 to 64) |
| `GPU_ACCELERATION` | `auto` | GPU video compression (`auto`, `nvenc` for NVIDIA, `qsv` for Intel, `amf` for AMD, `off` for CPU) |
| `ENABLE_AUTO_UPDATE_BINARIES` | `true` | Periodically update yt-dlp & gallery-dl in the background |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | How often (in hours) to check for scraper binary updates |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | Maximum concurrent media downloads/compressions in the queue |
| `AUTO_SUPPRESS_EMBEDS` | `true` | Automatically suppress the original link's preview embed after uploading media |
| `ARCHIVE_SUBFOLDER_FORMAT` | `channel/date` | Smart subfolder structure on PC (`channel/date`, `date/channel`, `channel`, `flat`) |
| `ENABLE_GENERAL_DUPLICATE_DETECTOR` | `true` | Detect when any link (media, news, docs, articles, websites) has been posted before |
| `DUPLICATE_LINK_SCOPE` | `channel` | Duplicate detection scope: `channel` (per-channel) or `guild` (server-wide) |
| `DUPLICATE_LINK_RETENTION_DAYS` | `0` | Retention memory window in days (`0` = disabled / remember links forever) |
| `SELF_REPOST_GRACE_SECONDS` | `300` | Grace window (seconds) to ignore duplicate warnings if same user reposts/edits |
| `DUPLICATE_LINK_ALERT_TTL_SECONDS` | `0` | Auto-delete duplicate link alert notices after this many seconds (`0` = never delete) |
| `LINK_DB_PATH` | `./data/links.db` | SQLite database file path for tracking posted links |
| `RESCAN_COMMAND` | `!rescan` | Command to crawl past channel/server history and batch-archive media to PC |
| `SCANNER_CONCURRENCY` | `3` | Number of parallel download workers during a channel rescan/crawl |
| `AUTO_SCAN_ON_STARTUP` | `true` | Automatically scan recent messages on startup to catch up on links posted while PC was off |
| `AUTO_SCAN_HOURS` | `24` | How many hours back from bot startup to scan across all allowed channels |
| `AUTO_SCAN_REPOST_MISSING` | `true` | Repost missing media attachments to Discord during the startup catch-up scan |
| `AUTO_SCAN_CONCURRENCY` | `3` | Number of parallel download workers during the startup catch-up scan |

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
- **Duplicate Notice "Dismiss" Button**:
  - When the bot sends an alert that a link has already been posted, a `🗑️ Dismiss` button is attached. The original poster or server moderators can click it to immediately clear the alert and keep chat clean.

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

## Retrying a link

If a link was posted while the bot wasn't running (or a download failed), reply to that message with `!repost` (or whatever `RETRY_COMMAND` is set to). The bot re-runs the download/upload pipeline on the message you replied to and reacts with ✅ or ❌ so you get quiet feedback without extra clutter.

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
- This only reacts to new messages; it won't retroactively scan message history.
