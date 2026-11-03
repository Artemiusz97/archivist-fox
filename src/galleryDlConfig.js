import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { getCookieForUrl } from './cookieVault.js';

let cachedConfigPath = null;
let cachedConfigSerialized = null;

/**
 * Resets the cached gallery-dl JSON configuration path (useful in tests or
 * when runtime cookie/credential configuration changes).
 */
export function resetGalleryDlConfigCache() {
  cachedConfigPath = null;
  cachedConfigSerialized = null;
}

/**
 * Builds and caches a temporary `gallery-dl` JSON config file for extractor
 * options (Reddit OAuth, Pixiv refresh token, Instagram cookies/credentials).
 * When `cookiesFromBrowser` and `preferBrowserCookies` are active, static
 * `instagram.cookies` is omitted so CLI `--cookies-from-browser` takes precedence.
 */
export async function getGalleryDlConfigPath() {
  const gdlConfig = {
    extractor: {
      twitter: {
        expand: false,
        videos: true,
      },
      bluesky: {
        videos: true,
      },
    },
  };

  if (config.redditClientId && config.redditUserAgent) {
    const redditConfig = {
      'client-id': config.redditClientId,
      'user-agent': config.redditUserAgent,
    };
    if (config.redditRefreshToken) {
      redditConfig['refresh-token'] = config.redditRefreshToken;
    }
    gdlConfig.extractor.reddit = redditConfig;
  }

  if (config.pixivRefreshToken) {
    gdlConfig.extractor.pixiv = {
      'refresh-token': config.pixivRefreshToken,
    };
  }

  const instagramConfig = { videos: true };
  const preferBrowser = Boolean(config.cookiesFromBrowser && config.preferBrowserCookies);
  if (!preferBrowser) {
    const igCookies = getCookieForUrl('https://www.instagram.com');
    if (igCookies) {
      instagramConfig['cookies'] = igCookies;
    }
  }
  if (config.instagramUsername && config.instagramPassword) {
    instagramConfig['username'] = config.instagramUsername;
    instagramConfig['password'] = config.instagramPassword;
  }

  gdlConfig.extractor.instagram = instagramConfig;

  const serialized = JSON.stringify(gdlConfig, null, 2);
  if (cachedConfigPath && cachedConfigSerialized === serialized && fs.existsSync(cachedConfigPath)) {
    return cachedConfigPath;
  }

  const configPath = path.join(os.tmpdir(), 'archivist-fox-gallerydl-config.json');
  await fs.promises.writeFile(configPath, serialized, 'utf8');
  cachedConfigPath = configPath;
  cachedConfigSerialized = serialized;
  return configPath;
}
