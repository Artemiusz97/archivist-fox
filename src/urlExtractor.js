import { config } from './config.js';
import { validateSsrfTarget, getBrowserHeaders } from './utils.js';

export const URL_REGEX = /https?:\/\/[^\s<>()\[\]"`\\]+/gi;

const SHORTENER_HOSTS = new Set([
  't.co',
  'bit.ly',
  'tinyurl.com',
  'pin.it',
  'vt.tiktok.com',
  'vm.tiktok.com',
  'is.gd',
  'buff.ly',
  'ow.ly',
  'on.soundcloud.com',
  'fav.me',  // DeviantArt shortlink (resolves to deviantart.com/USER/art/SLUG-ID)
  'b23.tv',  // Bilibili shortlink (resolves to bilibili.com/video/BV...)
]);

const DIRECT_MEDIA_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff',
  'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v',
  'mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'aac', 'alac', 'aiff',
]);

export const AUDIO_PLATFORM_DOMAINS = new Set([
  'soundcloud.com', 'm.soundcloud.com',
  'bandcamp.com',
  'mixcloud.com',
  'audiomack.com',
  'music.youtube.com',
]);

// Domains handed off to yt-dlp. yt-dlp supports far more than this out of the
// box, but keeping an allow-list here avoids spawning a process for every
// random link (e.g. a github.com or docs link) posted in chat.
const PLATFORM_DOMAINS = [
  'twitter.com', 'x.com', 'mobile.twitter.com',
  'vxtwitter.com', 'fxtwitter.com', 'fixupx.com', 'twittpr.com', 'fixvx.com',
  'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'vxtiktok.com', 'tiktxk.com',
  'instagram.com', 'ddinstagram.com', 'instagramez.com',
  'reddit.com', 'redd.it', 'old.reddit.com', 'v.redd.it', 'vxreddit.com', 'rxddit.com',
  'threads.net', 'threads.com',
  'bsky.app',
  'facebook.com', 'fb.watch', 'fb.com',
  'youtube.com', 'youtu.be', 'm.youtube.com', 'shorts.youtube.com', 'music.youtube.com',
  'streamable.com',
  'imgur.com', 'i.imgur.com',
  'twitch.tv', 'clips.twitch.tv',
  'redgifs.com',
  'pixiv.net',
  'pinterest.com', 'pin.it',
  'bilibili.com', 'b23.tv',
  'soundcloud.com', 'm.soundcloud.com',
  'bandcamp.com',
  'mixcloud.com',
  'audiomack.com',
  'deviantart.com',  // DeviantArt image/artwork gallery
  'fav.me',          // DeviantArt shortlink (resolved first via SHORTENER_HOSTS)
  'sta.sh',          // DeviantArt Sta.sh upload links
  'danbooru.donmai.us',
  'gelbooru.com',
  'e621.net',
  'e926.net',
  'rule34.xxx',
  'kemono.su',
  'kemono.party',
  'coomer.su',
  'coomer.party',
];

export const KNOWN_NSFW_DOMAINS = new Set([
  'redgifs.com',
  'gelbooru.com',
  'danbooru.donmai.us',
  'e621.net',
  'e926.net',
  'rule34.xxx',
  'rule34.paheal.net',
  'nhentai.net',
  'hentai-foundry.com',
  'pornhub.com',
  'xvideos.com',
  'xnxx.com',
  'erome.com',
  'kemono.party',
  'kemono.su',
  'coomer.party',
  'coomer.su',
]);

export function isKnownNsfwUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    if (KNOWN_NSFW_DOMAINS.has(host)) return true;
    for (const d of KNOWN_NSFW_DOMAINS) {
      if (host.endsWith(`.${d}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Evaluates whether platform metadata from gallery-dl or yt-dlp indicates NSFW / sensitive content.
 *
 * @param {object} meta - Parsed metadata object
 * @param {number} [depth=0] - Internal recursion guard for nested post/tweet wrappers
 * @returns {boolean}
 */
export function checkNsfwInMetadata(meta, depth = 0) {
  if (!meta || typeof meta !== 'object') return false;

  // Generic explicit NSFW / adult flags (Imgur, Mastodon, Lemmy, RedGifs, Tumblr, etc.)
  if (
    meta.nsfw === true ||
    meta.is_nsfw === true ||
    meta.mature === true ||
    meta.adult === true ||
    meta.mature_content === true ||
    meta.sexual === true
  ) {
    return true;
  }

  // Twitter / X: possibly_sensitive: true, sensitive: true
  if (meta.possibly_sensitive === true || meta.sensitive === true) return true;

  // Reddit: over_18: true, spoiler: true
  if (meta.over_18 === true || meta.spoiler === true) return true;

  // Pixiv: x_restrict > 0 (1 = R-18, 2 = R-18G), age_limit >= 18 (yt-dlp universal age gate)
  if (typeof meta.x_restrict === 'number' && meta.x_restrict > 0) return true;
  if (typeof meta.age_limit === 'number' && meta.age_limit >= 18) return true;

  // Boorus & art sites: rating = 'e', 'q', 'explicit', 'questionable', 'r18', 'nsfw', 'adult', 'mature'
  if (typeof meta.rating === 'string') {
    const r = meta.rating.toLowerCase().trim();
    if (
      ['e', 'q', 'explicit', 'questionable', 'r18', 'r-18', 'r-18g', 'nsfw', 'adult', 'mature', 'xxx', '18+'].includes(
        r
      )
    ) {
      return true;
    }
  }

  // Bluesky / ATProto: labels array containing "sexual", "nudity", "porn", "nsfw", "graphic-media", "gore", "adult"
  if (Array.isArray(meta.labels)) {
    const nsfwLabels = new Set(['sexual', 'nudity', 'porn', 'nsfw', 'graphic-media', 'gore', 'adult']);
    for (const label of meta.labels) {
      const val = (typeof label === 'string' ? label : label?.val || label?.value || '').toLowerCase().trim();
      if (nsfwLabels.has(val)) return true;
    }
  }

  // DeviantArt: is_mature: true
  if (meta.is_mature === true) return true;

  // Tags check: "R-18", "R-18G", "NSFW", "18+", "explicit", "uncensored", "hentai" (strings or { name } objects)
  const tags = Array.isArray(meta.tags)
    ? meta.tags
    : typeof meta.tags === 'string'
      ? meta.tags.split(/[\s,]+/)
      : [];

  const nsfwTags = new Set(['r-18', 'r-18g', 'r18', 'r18g', 'nsfw', '18+', 'explicit', 'uncensored', 'hentai']);
  for (const tag of tags) {
    const rawTag = typeof tag === 'object' && tag !== null ? (tag.name || tag.tag || tag.value || '') : tag;
    const t = String(rawTag).toLowerCase().trim();
    if (nsfwTags.has(t)) return true;
  }

  // Check common nested post wrappers emitted by gallery-dl / yt-dlp
  if (depth < 1) {
    for (const key of ['tweet', 'post', 'illust', 'submission']) {
      if (meta[key] && typeof meta[key] === 'object' && checkNsfwInMetadata(meta[key], depth + 1)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluates whether a downloaded media item should be uploaded to Discord with spoiler blurring.
 *
 * @param {object} params
 * @param {boolean} [params.isDownloadedNsfw=false]
 * @param {boolean} [params.isKnownNsfw=false]
 * @param {string} [params.url='']
 * @param {boolean} [params.isUserSpoiler=false]
 * @param {boolean} [params.isChannelNsfw=false]
 * @returns {boolean}
 */
export function shouldSpoilerMedia({
  isDownloadedNsfw = false,
  isKnownNsfw = false,
  url = '',
  isUserSpoiler = false,
  isChannelNsfw = false,
} = {}) {
  const spoilerByUser = Boolean(isUserSpoiler && config.spoilerUserFlaggedLinks);
  const isNsfwMedia = Boolean((isDownloadedNsfw || isKnownNsfw || isKnownNsfwUrl(url)) && config.autoSpoilerNsfw);
  const spoilerByNsfw = isNsfwMedia && (!config.spoilerNonNsfwChannelsOnly || !isChannelNsfw);
  return spoilerByUser || spoilerByNsfw;
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'igshid',
  'si',
  'feature',
  'ref',
  'ref_src',
  'ref_url',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'dclid',
]);

const BILIBILI_WEB_HOSTS = new Set([
  'bilibili.com',
  'www.bilibili.com',
  'm.bilibili.com',
  'mobile.bilibili.com',
]);

const BILIBILI_LOCALE_VIDEO_PATH_REGEX =
  /^\/(?:(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})?|s)\/)?(video\/|bangumi\/play\/)/i;

const BILIBILI_TRACKING_PARAMS = new Set([
  'vd_source',
  'spm_id_from',
  'from_spmid',
  'share_source',
  'share_medium',
  'share_plat',
  'share_session_id',
  'share_tag',
  'share_times',
  'unique_k',
  'is_story_h5',
  'buvid',
  'up_id',
  'plat_id',
]);

/**
 * Canonicalizes Bilibili video/bangumi URLs so `yt-dlp`'s `BiliBiliIE` matches
 * instead of falling back to the generic HTML extractor on locale/SEO prefixes
 * (e.g. `/en/video/BV...`, `/zh-Hans/video/BV...`, `/s/video/BV...`, `m.bilibili.com`)
 * or direct `b23.tv/BV...` vanity links. Leaves subdomains like `live.bilibili.com` untouched.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function canonicalizeBilibiliUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return rawUrl;
    }
    const host = parsed.hostname.toLowerCase();

    if (host === 'b23.tv' || host === 'www.b23.tv') {
      const bvMatch = parsed.pathname.match(/^\/(BV[a-zA-Z0-9]{10})(\/?)$/i);
      if (bvMatch) {
        const normalizedBv = `BV${bvMatch[1].slice(2)}`;
        parsed.protocol = 'https:';
        parsed.hostname = 'www.bilibili.com';
        parsed.pathname = `/video/${normalizedBv}${bvMatch[2] || ''}`;
        return parsed.toString();
      }
      return rawUrl;
    }

    if (BILIBILI_WEB_HOSTS.has(host) && BILIBILI_LOCALE_VIDEO_PATH_REGEX.test(parsed.pathname)) {
      parsed.protocol = 'https:';
      parsed.hostname = 'www.bilibili.com';
      parsed.pathname = parsed.pathname.replace(
        /^\/(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})?|s)\/(video\/|bangumi\/play\/)/i,
        '/$1'
      );
      return parsed.toString();
    }
  } catch (err) {
    void err;
  }
  return rawUrl;
}

export function stripQueryAndTrailingPunctuation(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  // Strip common trailing punctuation, backslashes, angle brackets, and Discord markdown delimiters (` * ~)
  // while preserving valid mid-URL RFC 3986 characters (~, *) and signed query parameter ordering.
  return rawUrl.trim().replace(/[.,!?;:)'"|\\`*~<>]+$/g, '');
}

function getExtension(pathname) {
  const match = /\.([a-z0-9]+)$/i.exec(pathname);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Normalizes a URL for consistent deduplication matching:
 * - Lowercases scheme and hostname
 * - Removes 'www.', 'm.', 'mobile.', 'old.' prefixes
 * - Canonicalizes shortlinks like youtu.be/ID to youtube.com/watch?v=ID
 * - Strips known analytics/tracking parameters (utm_*, fbclid, si, igshid, etc.)
 * - Sorts remaining query parameters alphabetically
 * - Normalizes trailing slashes on non-root paths
 */
export function normalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  const cleaned = stripQueryAndTrailingPunctuation(rawUrl.trim());

  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }

  // Only handle http / https URLs
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  // Normalize protocol
  parsed.protocol = 'https:';

  // Normalize hostname
  let host = parsed.hostname.toLowerCase();
  host = host.replace(/^(www\.|m\.|mobile\.|old\.)/, '');

  // Canonicalize domain aliases & social embed fixer proxies
  if (
    host === 'x.com' ||
    host === 'vxtwitter.com' ||
    host === 'fxtwitter.com' ||
    host === 'fixupx.com' ||
    host === 'twittpr.com' ||
    host === 'fixvx.com'
  ) {
    host = 'twitter.com';
  } else if (host === 'ddinstagram.com' || host === 'instagramez.com') {
    host = 'instagram.com';
  } else if (host === 'vxreddit.com' || host === 'rxddit.com') {
    host = 'reddit.com';
  } else if (host === 'vxtiktok.com' || host === 'tiktxk.com') {
    host = 'tiktok.com';
  }

  parsed.hostname = host;

  // Handle youtu.be shortlinks -> youtube.com/watch?v=ID
  if (host === 'youtu.be' && parsed.pathname.length > 1) {
    const videoId = parsed.pathname.slice(1).split('/')[0];
    parsed.hostname = 'youtube.com';
    parsed.pathname = '/watch';
    parsed.searchParams.set('v', videoId);
  }

  // Special-case twitter / x share params (s, t)
  if (host === 'b23.tv') {
    const bvMatch = parsed.pathname.match(/^\/(BV[a-zA-Z0-9]{10})\/?$/i);
    if (bvMatch) {
      host = 'bilibili.com';
      parsed.hostname = host;
      parsed.pathname = `/video/BV${bvMatch[1].slice(2)}`;
    }
  }

  if (parsed.hostname === 'bilibili.com') {
    parsed.pathname = parsed.pathname.replace(
      /^\/(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})?|s)\/(video\/|bangumi\/play\/)/i,
      '/$1'
    );
  }

  const isBilibili = parsed.hostname === 'bilibili.com';
  const isTwitter = parsed.hostname === 'twitter.com';

  // Filter tracking query params
  const searchParams = new URLSearchParams(parsed.search);
  const filteredParams = [];

  for (const [key, value] of searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (TRACKING_PARAMS.has(lowerKey)) continue;
    if (isTwitter && (lowerKey === 's' || lowerKey === 't')) continue;
    if (isBilibili && BILIBILI_TRACKING_PARAMS.has(lowerKey)) continue;
    filteredParams.push([key, value]);
  }

  // Sort remaining query params for determinism
  filteredParams.sort((a, b) => a[0].localeCompare(b[0]));

  const newSearch = new URLSearchParams();
  for (const [key, value] of filteredParams) {
    newSearch.append(key, value);
  }
  parsed.search = newSearch.toString() ? `?${newSearch.toString()}` : '';

  // Remove fragment hash
  parsed.hash = '';

  // Normalize trailing slash on non-root paths
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}

/**
 * Extracts all URLs from a message content string, normalizing and deduplicating them.
 *
 * @param {string} content
 * @returns {Array<{ originalUrl: string, normalizedUrl: string }>}
 */
export function extractAllUrls(content) {
  if (!content) return [];
  const rawMatches = content.match(URL_REGEX) || [];
  const results = [];
  const seenNormalized = new Set();

  for (const raw of rawMatches) {
    const cleaned = canonicalizeBilibiliUrl(stripQueryAndTrailingPunctuation(raw));
    const normalized = normalizeUrl(cleaned);
    if (!normalized) continue;
    if (seenNormalized.has(normalized)) continue;
    seenNormalized.add(normalized);

    results.push({
      originalUrl: cleaned,
      normalizedUrl: normalized,
    });
  }

  return results;
}

/**
 * Pulls all URLs out of a message and classifies each one.
 * Returns an array of { url, type } where type is 'direct', 'platform', or null (unsupported).
 * Unsupported links are filtered out.
 */
/**
 * Extracts a canonical platform media ID from a supported platform URL.
 * Returns a string formatted as "platform:ID" (e.g. "youtube:dQw4w9WgXcQ") or null.
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function extractPlatformMediaId(rawUrl) {
  if (!rawUrl) return null;
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    // YouTube: watch?v=ID, /shorts/ID, /embed/ID, /v/ID, /live/ID, /playlist?list=ID
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v) return `youtube:${v}`;

      const list = parsed.searchParams.get('list');
      if (list && pathname.startsWith('/playlist')) {
        return `youtube:playlist:${list}`;
      }

      const match = pathname.match(/^\/(?:shorts|embed|v|live)\/([a-zA-Z0-9_-]{11})/);
      if (match) return `youtube:${match[1]}`;

      if (host === 'youtu.be') {
        const id = pathname.slice(1).split('/')[0];
        if (id && id.length === 11) return `youtube:${id}`;
      }
    }

    // Twitter / X: /status/ID or /i/web/status/ID
    if (host === 'twitter.com' || host === 'x.com') {
      const match = pathname.match(/\/status(?:es)?\/(\d+)/i);
      if (match) return `twitter:${match[1]}`;
    }

    // TikTok: /@user/video/ID or /v/ID
    if (host.includes('tiktok.com')) {
      const match = pathname.match(/\/(?:video|v)\/(\d+)/i);
      if (match) return `tiktok:${match[1]}`;
    }

    // Instagram: /p/SHORTCODE, /reel/SHORTCODE, /tv/SHORTCODE
    if (host.includes('instagram.com')) {
      const match = pathname.match(/\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/i);
      if (match) return `instagram:${match[1]}`;
    }

    // Reddit: /r/SUB/comments/POST_ID/... or redd.it/POST_ID
    if (host.includes('reddit.com') || host === 'redd.it') {
      if (host === 'redd.it') {
        const id = pathname.slice(1).split('/')[0];
        if (id) return `reddit:${id}`;
      }
      const match = pathname.match(/\/comments\/([a-zA-Z0-9]+)/i);
      if (match) return `reddit:${match[1]}`;
    }

    // Bluesky: /profile/USER/post/POST_ID
    if (host.includes('bsky.app')) {
      const match = pathname.match(/\/profile\/[^\/]+\/post\/([a-zA-Z0-9]+)/i);
      if (match) return `bsky:${match[1]}`;
    }

    // Threads: /@user/post/POST_ID
    if (host.includes('threads.net') || host.includes('threads.com')) {
      const match = pathname.match(/\/post\/([a-zA-Z0-9_-]+)/i);
      if (match) return `threads:${match[1]}`;
    }

    // RedGifs: /watch/ID
    if (host.includes('redgifs.com')) {
      const match = pathname.match(/\/watch\/([a-zA-Z0-9]+)/i);
      if (match) return `redgifs:${match[1]}`;
    }

    // Pixiv: /artworks/ID
    if (host.includes('pixiv.net')) {
      const match = pathname.match(/\/artworks\/(\d+)/i);
      if (match) return `pixiv:${match[1]}`;
    }

    // Pinterest: /pin/ID
    if (host.includes('pinterest.com')) {
      const match = pathname.match(/\/pin\/(\d+)/i);
      if (match) return `pinterest:${match[1]}`;
    }

    // Facebook: /reel/ID, /watch/?v=ID, /videos/ID, fb.watch/ID
    if (host.includes('facebook.com') || host.includes('fb.watch') || host.includes('fb.com')) {
      const v = parsed.searchParams.get('v');
      if (v) return `facebook:${v}`;
      if (host === 'fb.watch') {
        const id = pathname.slice(1).split('/')[0];
        if (id) return `facebook:${id}`;
      }
      const match = pathname.match(/\/(?:reel|videos|watch|posts)\/([0-9]+)/i);
      if (match) return `facebook:${match[1]}`;
    }

    // Bilibili: /video/BV... or /video/av...
    if (host.includes('bilibili.com')) {
      const match = pathname.match(/\/video\/([a-zA-Z0-9]+)/i);
      if (match) return `bilibili:${match[1]}`;
    }

    // Streamable: /CODE
    if (host.includes('streamable.com')) {
      const match = pathname.match(/^\/([a-zA-Z0-9]+)$/i);
      if (match) return `streamable:${match[1]}`;
    }

    // SoundCloud: /artist/track (ignore /tags, /search, etc)
    if (host.includes('soundcloud.com')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && !['search', 'tags', 'discover', 'pages'].includes(parts[0])) {
        return `soundcloud:${parts[0]}/${parts[1]}`;
      }
    }

    // Bandcamp: /track/ID or /album/ID
    if (host.includes('bandcamp.com')) {
      const parts = pathname.split('/').filter(Boolean);
      const subdomain = host.split('.')[0];
      if (parts.length >= 2 && (parts[0] === 'track' || parts[0] === 'album')) {
        return `bandcamp:${subdomain}/${parts[0]}/${parts[1]}`;
      }
    }

    // Mixcloud: /user/show/
    if (host.includes('mixcloud.com')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return `mixcloud:${parts[0]}/${parts[1]}`;
      }
    }

    // Audiomack: /artist/song/track
    if (host.includes('audiomack.com')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 3 && parts[1] === 'song') {
        return `audiomack:${parts[0]}/${parts[2]}`;
      }
    }

    // DeviantArt: /USER/art/SLUG-DEVIATIONID or /view/DEVIATIONID
    if (host.includes('deviantart.com')) {
      // Standard artwork URL: /USER/art/title-12345678, /art/title-12345678, /view/12345678
      const artMatch = pathname.match(/\/(?:art|view)\/(?:.*-)?(\d+)\/?$/i);
      if (artMatch) return `deviantart:${artMatch[1]}`;
      // Stash URL: /stash/ALPHANUMID
      const stashMatch = pathname.match(/\/stash\/([a-zA-Z0-9]+)\/?$/i);
      if (stashMatch) return `deviantart:stash:${stashMatch[1]}`;
    }

    // DeviantArt shortlink via fav.me: https://fav.me/d<base36_id>
    // fav.me links use base-36 deviation IDs prefixed by 'd' (e.g. dfpp9ce -> 950161550).
    // Decoding this yields the identical canonical ID as the full deviantart.com URL.
    if (host === 'fav.me') {
      const rawId = pathname.slice(1).split('/')[0];
      if (rawId) {
        const stripped = rawId.replace(/^d/i, '');
        const numericId = parseInt(stripped, 36);
        if (!isNaN(numericId) && numericId > 0) {
          return `deviantart:${numericId}`;
        }
        return `deviantart:favme:${rawId}`;
      }
    }

    // DeviantArt Sta.sh: https://sta.sh/ALPHANUMID
    if (host === 'sta.sh') {
      const id = pathname.slice(1).split('/')[0];
      if (id) return `deviantart:stash:${id}`;
    }

    // Discord CDN / Media attachments: /attachments/<channelId>/<attachmentId>/<filename>
    if (
      host === 'cdn.discordapp.com' ||
      host === 'media.discordapp.net' ||
      host.endsWith('.discordapp.com') ||
      host.endsWith('.discordapp.net')
    ) {
      const match = pathname.match(/^\/attachments\/\d+\/(\d+)\//i);
      if (match) return `discord:${match[1]}`;
    }
  } catch (err) {
    void err;
  }

  return null;
}

/**
 * Helper to determine if a domain is strictly an audio platform.
 */
export function isAudioPlatform(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    return AUDIO_PLATFORM_DOMAINS.has(host) || host.endsWith('.bandcamp.com');
  } catch {
    return false;
  }
}

/**
 * Helper to determine if a URL should be treated as audio-only.
 * True if it's from an audio platform OR has a direct audio extension.
 */
export function isAudioUrl(rawUrl) {
  if (isAudioPlatform(rawUrl)) return true;
  
  try {
    const parsed = new URL(rawUrl);
    const ext = /\/([^\/]+\.([a-z0-9]+))$/i.exec(parsed.pathname);
    if (ext && ext[2]) {
      const checkExt = ext[2].toLowerCase();
      // Only match pure audio extensions
      const audioExts = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'aac', 'alac', 'aiff']);
      return audioExts.has(checkExt);
    }
  } catch (err) {
    void err;
  }
  return false;
}

/**
 * Helper to determine if a URL is a DeviantArt link.
 * DeviantArt has no yt-dlp extractor, so gallery-dl should be tried directly
 * (skipping the yt-dlp attempt that would always fail and waste time).
 */
export function isDeviantArtUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    return host === 'deviantart.com' || host === 'fav.me' || host === 'sta.sh';
  } catch {
    return false;
  }
}

/**
 * Fast resolution of known URL shorteners (e.g. t.co, bit.ly, pin.it, vt.tiktok.com)
 * Uses native `fetch` with manual hop-by-hop redirect resolution and SSRF checks.
 */
export async function resolveShortUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    if (!SHORTENER_HOSTS.has(host)) {
      return rawUrl;
    }

    const headers = getBrowserHeaders(rawUrl, {
      fetchDest: 'document',
      fetchMode: 'navigate',
    });

    // fav.me does not listen on HTTPS port 443 and DeviantArt destination blocks automated HEAD requests.
    if (host === 'fav.me') {
      const httpUrl = rawUrl.replace(/^https:\/\//i, 'http://');
      await validateSsrfTarget(httpUrl);
      const res = await fetch(httpUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
        headers,
      });
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get('location');
      if (loc) {
        const resolved = new URL(loc, httpUrl).toString();
        await validateSsrfTarget(resolved);
        return resolved;
      }
      return rawUrl;
    }

    let currentUrl = rawUrl;
    let method = 'HEAD';
    const maxHops = 5;

    for (let hop = 0; hop < maxHops; hop++) {
      await validateSsrfTarget(currentUrl);
      const res = await fetch(currentUrl, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(3500),
        headers,
      });
      await res.body?.cancel().catch(() => {});

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) break;
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }

      if (method === 'HEAD' && (res.status === 405 || res.status === 403 || res.status === 400)) {
        method = 'GET';
        hop--;
        continue;
      }

      break;
    }

    if (currentUrl && currentUrl !== rawUrl) {
      await validateSsrfTarget(currentUrl);
      return currentUrl;
    }
  } catch (err) {
    void err;
  }
  return rawUrl;
}

export function getSpoilerRanges(content) {
  const ranges = [];
  if (!content) return ranges;
  const regex = /\|\|([\s\S]*?)\|\|/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    ranges.push({
      start: match.index,
      end: regex.lastIndex,
    });
  }
  return ranges;
}

export function extractMediaLinks(content) {
  if (!content) return [];
  const spoilerRanges = getSpoilerRanges(content);
  const regex = new RegExp(URL_REGEX.source, 'gi');
  const rawMatches = [...content.matchAll(regex)];
  const results = [];
  const seen = new Set();

  for (const match of rawMatches) {
    const raw = match[0];
    const cleaned = canonicalizeBilibiliUrl(stripQueryAndTrailingPunctuation(raw));
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);

    let parsed;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }

    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const ext = getExtension(parsed.pathname);
    const isSpoiler = spoilerRanges.some((r) => match.index >= r.start && match.index < r.end);
    const isNsfw = isKnownNsfwUrl(cleaned);

    if (ext && DIRECT_MEDIA_EXTENSIONS.has(ext)) {
      results.push({ url: cleaned, type: 'direct', isSpoiler, isKnownNsfw: isNsfw });
    } else if (PLATFORM_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      results.push({ url: cleaned, type: 'platform', isSpoiler, isKnownNsfw: isNsfw });
    }
    // else: not a recognized media link, ignore
  }

  return results;
}

/**
 * Asynchronously extracts all URLs from content, unshortening any shortener links
 * before returning normalized deduplicated URLs.
 */
export async function extractAllUrlsAsync(content) {
  if (!content) return [];
  const rawMatches = content.match(URL_REGEX) || [];
  const results = [];
  const seenNormalized = new Set();

  const resolvedUrls = await Promise.all(
    rawMatches.map(async (raw) => {
      const cleaned = canonicalizeBilibiliUrl(stripQueryAndTrailingPunctuation(raw));
      return canonicalizeBilibiliUrl(await resolveShortUrl(cleaned));
    })
  );

  for (const resolved of resolvedUrls) {
    const normalized = normalizeUrl(resolved);
    if (!normalized) continue;
    if (seenNormalized.has(normalized)) continue;
    seenNormalized.add(normalized);

    results.push({
      originalUrl: resolved,
      normalizedUrl: normalized,
    });
  }

  return results;
}

/**
 * Asynchronously extracts and classifies media links, unshortening any shortener links.
 */
export async function extractMediaLinksAsync(content) {
  if (!content) return [];
  const spoilerRanges = getSpoilerRanges(content);
  const regex = new RegExp(URL_REGEX.source, 'gi');
  const rawMatches = [...content.matchAll(regex)];
  const results = [];
  const seen = new Set();

  const resolvedUrls = await Promise.all(
    rawMatches.map(async (match) => {
      const cleaned = stripQueryAndTrailingPunctuation(match[0]);
      const resolved = await resolveShortUrl(cleaned);
      const isSpoiler = spoilerRanges.some((r) => match.index >= r.start && match.index < r.end);
      return { resolved, isSpoiler };
    })
  );

  for (const { resolved, isSpoiler } of resolvedUrls) {
    const cleaned = canonicalizeBilibiliUrl(stripQueryAndTrailingPunctuation(resolved));
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);

    let parsed;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }

    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const ext = getExtension(parsed.pathname);
    const isNsfw = isKnownNsfwUrl(cleaned);

    if (ext && DIRECT_MEDIA_EXTENSIONS.has(ext)) {
      results.push({ url: cleaned, type: 'direct', isSpoiler, isKnownNsfw: isNsfw });
    } else if (PLATFORM_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      results.push({ url: cleaned, type: 'platform', isSpoiler, isKnownNsfw: isNsfw });
    }
  }

  return results;
}

const ATTACHMENT_MEDIA_EXTENSIONS = new Set([
  ...DIRECT_MEDIA_EXTENSIONS,
  'avif',
  'flv',
  'wmv',
]);

/**
 * Evaluates whether a Discord message Attachment object represents media
 * (image, video, GIF, or audio) while rejecting non-media uploads (.zip, .pdf, .txt, .svg, code files).
 *
 * @param {object} att
 * @returns {boolean}
 */
export function isMediaAttachment(att) {
  if (!att || typeof att !== 'object') return false;
  const url = att.url || att.proxyURL;
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;

  const rawMime = typeof att.contentType === 'string' ? att.contentType.split(';')[0].trim().toLowerCase() : '';
  if (rawMime) {
    if (rawMime === 'image/svg+xml') return false;
    if (rawMime.startsWith('image/') || rawMime.startsWith('video/') || rawMime.startsWith('audio/')) {
      return true;
    }
    if (rawMime !== 'application/octet-stream') {
      return false;
    }
  }

  let ext = null;
  if (typeof att.name === 'string' && att.name) {
    ext = getExtension(att.name);
  }
  if (!ext) {
    try {
      ext = getExtension(new URL(url).pathname);
    } catch (err) {
    void err;
  }
  }
  return Boolean(ext && ATTACHMENT_MEDIA_EXTENSIONS.has(ext));
}

/**
 * Extracts user-uploaded Discord media attachments from a message for local backup & deduplication.
 * Marks extracted items with `archiveOnly: true` so the bot backs them up silently without re-uploading a copy.
 *
 * @param {import('discord.js').Message|object} message
 * @returns {Array<{
 *   url: string,
 *   type: 'direct',
 *   archiveOnly: true,
 *   isUserAttachment: true,
 *   mediaId: string|null,
 *   filename: string|undefined,
 *   isSpoiler: boolean,
 *   isKnownNsfw: false
 * }>}
 */
export function extractMessageAttachments(message) {
  if (!config.archiveUserAttachments || !message?.attachments) return [];
  const rawCollection = message.attachments;
  const list =
    typeof rawCollection.values === 'function'
      ? Array.from(rawCollection.values())
      : Array.isArray(rawCollection)
        ? rawCollection
        : [];

  const results = [];
  const seenKeys = new Set();

  for (const att of list) {
    if (!isMediaAttachment(att)) continue;
    const url = stripQueryAndTrailingPunctuation(att.url || att.proxyURL);
    const mediaId = att.id ? `discord:${att.id}` : extractPlatformMediaId(url);
    const dedupeKey = mediaId || url;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    let rawFilename = typeof att.name === 'string' && att.name.trim() ? att.name.trim() : '';
    if (!rawFilename) {
      try {
        rawFilename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      } catch (err) {
    void err;
  }
    }
    const isSpoiler = Boolean(att.spoiler || /^SPOILER_/i.test(rawFilename));
    const cleanFilename = rawFilename.replace(/^(?:SPOILER_)+/i, '') || rawFilename || undefined;

    results.push({
      url,
      type: 'direct',
      archiveOnly: true,
      isUserAttachment: true,
      mediaId: mediaId || null,
      filename: cleanFilename,
      isSpoiler,
      isKnownNsfw: false,
    });
  }

  return results;
}

/**
 * Checks if a URL is a YouTube playlist or a video that is part of a playlist.
 * Returns details about the playlist/video.
 *
 * @param {string} rawUrl
 * @returns {{ isPlaylist: boolean, isVideoWithPlaylist: boolean, videoId: string|null, listId: string|null }}
 */
export function extractYouTubePlaylistDetails(rawUrl) {
  const result = { isPlaylist: false, isVideoWithPlaylist: false, videoId: null, listId: null };
  if (!rawUrl) return result;
  const cleaned = stripQueryAndTrailingPunctuation(String(rawUrl).trim());

  try {
    const parsed = new URL(cleaned);
    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');

    if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
      const v = parsed.searchParams.get('v');
      const list = parsed.searchParams.get('list');

      if (list) {
        result.isPlaylist = true;
        result.listId = list;

        if (v) {
          result.isVideoWithPlaylist = true;
          result.videoId = v;
        } else if (host === 'youtu.be') {
          // e.g. youtu.be/VIDEO_ID?list=PLAYLIST_ID
          const id = parsed.pathname.slice(1).split('/')[0];
          if (id && id.length === 11) {
            result.isVideoWithPlaylist = true;
            result.videoId = id;
          }
        }
      }
    }
  } catch (err) {
    void err;
  }

  return result;
}
