import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function isValidCookieFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Returns the best matching cookie file path for a given media URL.
 * Checks for dedicated platform cookies in `cookies/<platform>.txt` before
 * falling back to root `cookies.txt` or `COOKIES_FILE_PATH`.
 *
 * @param {string} url - Target media URL
 * @returns {string|null} Path to valid cookie file, or null if none found
 */
export function getCookieForUrl(url) {
  try {
    const cookiesDir = config.cookiesDir || path.join(process.cwd(), 'cookies');
    if (!fs.existsSync(cookiesDir)) {
      fs.mkdirSync(cookiesDir, { recursive: true });
    }

    if (url) {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      let targetSite = null;
      if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
        targetSite = 'youtube';
      } else if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
        targetSite = 'twitter';
      } else if (hostname.includes('facebook.com') || hostname.includes('fb.watch') || hostname.includes('fb.com')) {
        targetSite = 'facebook';
      } else if (hostname.includes('instagram.com')) {
        targetSite = 'instagram';
      } else if (hostname.includes('threads.net')) {
        targetSite = 'threads';
      } else if (hostname.includes('reddit.com') || hostname.includes('redd.it')) {
        targetSite = 'reddit';
      } else if (hostname.includes('tiktok.com')) {
        targetSite = 'tiktok';
      } else if (hostname.includes('bsky.app') || hostname.includes('bluesky')) {
        targetSite = 'bluesky';
      } else if (hostname.includes('pixiv.net')) {
        targetSite = 'pixiv';
      } else if (hostname.includes('twitch.tv')) {
        targetSite = 'twitch';
      } else if (hostname.includes('bilibili.com')) {
        targetSite = 'bilibili';
      } else if (hostname.includes('deviantart.com') || hostname === 'fav.me' || hostname === 'sta.sh') {
        targetSite = 'deviantart';
      }

      if (targetSite) {
        // Support aliases (e.g. facebook.txt or fb.txt, twitter.txt or x.txt, bluesky.txt or bsky.txt)
        let candidateNames = [`${targetSite}.txt`];
        if (targetSite === 'facebook') candidateNames = ['facebook.txt', 'fb.txt'];
        else if (targetSite === 'twitter') candidateNames = ['twitter.txt', 'x.txt'];
        else if (targetSite === 'youtube') candidateNames = ['youtube.txt', 'yt.txt'];
        else if (targetSite === 'instagram') candidateNames = ['instagram.txt', 'ig.txt'];
        else if (targetSite === 'bluesky') candidateNames = ['bluesky.txt', 'bsky.txt'];
        else if (targetSite === 'deviantart') candidateNames = ['deviantart.txt', 'da.txt'];

        for (const filename of candidateNames) {
          const platformCookie = path.join(cookiesDir, filename);
          if (isValidCookieFile(platformCookie)) {
            return platformCookie;
          }
        }
      }
    }
  } catch {}

  // Fallback to configured global cookiesPath or root cookies.txt
  if (isValidCookieFile(config.cookiesPath)) {
    return config.cookiesPath;
  }

  const rootCookie = path.join(process.cwd(), 'cookies.txt');
  if (isValidCookieFile(rootCookie)) {
    return rootCookie;
  }

  return null;
}
