import axios from 'axios';

const URL_REGEX = /https?:\/\/[^\s<>()\[\]"]+/gi;

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
  'bilibili.com',
  'soundcloud.com', 'm.soundcloud.com',
  'bandcamp.com',
  'mixcloud.com',
  'audiomack.com',
  'deviantart.com',  // DeviantArt image/artwork gallery
  'fav.me',          // DeviantArt shortlink (resolved first via SHORTENER_HOSTS)
  'sta.sh',          // DeviantArt Sta.sh upload links
];

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

export function stripQueryAndTrailingPunctuation(rawUrl) {
  // Strip common trailing punctuation that gets swept up by the regex
  // (e.g. a link at the end of a sentence followed by a period, brackets, or wrapping quotes).
  return rawUrl.replace(/[.,!?;:)'"]+$/g, '');
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
  const isTwitter = parsed.hostname === 'twitter.com';

  // Filter tracking query params
  const searchParams = new URLSearchParams(parsed.search);
  const filteredParams = [];

  for (const [key, value] of searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (TRACKING_PARAMS.has(lowerKey)) continue;
    if (isTwitter && (lowerKey === 's' || lowerKey === 't')) continue;
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
    const cleaned = stripQueryAndTrailingPunctuation(raw);
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
  } catch {}

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
  } catch {}
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
 * Uses HEAD request with timeout, falling back to streamed GET if HEAD is rejected (405/403).
 */
export async function resolveShortUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    if (!SHORTENER_HOSTS.has(host)) {
      return rawUrl;
    }

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };

    // fav.me does not listen on HTTPS port 443 and DeviantArt destination blocks automated HEAD requests.
    // Reading the Location header via HTTP with maxRedirects: 0 unshortens in ~150ms cleanly.
    if (host === 'fav.me') {
      try {
        const httpUrl = rawUrl.replace(/^https:\/\//i, 'http://');
        const res = await axios.get(httpUrl, {
          maxRedirects: 0,
          timeout: 3000,
          headers,
          validateStatus: (s) => (s >= 300 && s < 400) || (s >= 200 && s < 300),
        });
        const loc = res.headers?.location;
        if (loc) return loc;
      } catch (favErr) {
        const loc = favErr.response?.headers?.location;
        if (loc) return loc;
      }
      return rawUrl;
    }

    try {
      const res = await axios.head(rawUrl, {
        maxRedirects: 5,
        timeout: 3500,
        headers,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      const finalUrl = res.request?.res?.responseUrl || res.config?.url;
      if (finalUrl && finalUrl !== rawUrl) {
        return finalUrl;
      }
    } catch (headErr) {
      // Fallback: If server rejects HEAD with 405 (Method Not Allowed), 403, or 400, try streamed GET
      const status = headErr?.response?.status;
      if (status === 405 || status === 403 || status === 400) {
        const res = await axios.get(rawUrl, {
          maxRedirects: 5,
          timeout: 3500,
          responseType: 'stream',
          headers,
          validateStatus: (s) => s >= 200 && s < 400,
        });
        const finalUrl = res.request?.res?.responseUrl || res.config?.url;
        res.data?.destroy?.();
        if (finalUrl && finalUrl !== rawUrl) {
          return finalUrl;
        }
      }
    }
  } catch {}
  return rawUrl;
}

export function extractMediaLinks(content) {
  const rawMatches = content.match(URL_REGEX) || [];
  const results = [];
  const seen = new Set();

  for (const raw of rawMatches) {
    const cleaned = stripQueryAndTrailingPunctuation(raw);
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

    if (ext && DIRECT_MEDIA_EXTENSIONS.has(ext)) {
      results.push({ url: cleaned, type: 'direct' });
    } else if (PLATFORM_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      results.push({ url: cleaned, type: 'platform' });
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
      const cleaned = stripQueryAndTrailingPunctuation(raw);
      return resolveShortUrl(cleaned);
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
  const rawMatches = content.match(URL_REGEX) || [];
  const results = [];
  const seen = new Set();

  const resolvedUrls = await Promise.all(
    rawMatches.map(async (raw) => {
      const cleaned = stripQueryAndTrailingPunctuation(raw);
      return resolveShortUrl(cleaned);
    })
  );

  for (const cleaned of resolvedUrls) {
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

    if (ext && DIRECT_MEDIA_EXTENSIONS.has(ext)) {
      results.push({ url: cleaned, type: 'direct' });
    } else if (PLATFORM_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      results.push({ url: cleaned, type: 'platform' });
    }
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

  try {
    const parsed = new URL(rawUrl);
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
  } catch {}

  return result;
}
