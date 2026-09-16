import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { getCookieForUrl } from './cookieVault.js';

let cachedConfigPath = null;

/**
 * Reddit has started flagging gallery-dl's default scraping-style requests
 * as bot traffic ("You've been blocked by network security"). The
 * documented fix is to have gallery-dl authenticate against Reddit's real
 * API instead — see https://gdl-org.github.io/docs/configuration.html#extractor-reddit-client-id-user-agent
 *
 * If REDDIT_CLIENT_ID + REDDIT_USER_AGENT are set, this builds a small
 * gallery-dl config file once and returns its path so it can be passed via
 * `-c`. Returns null if no Reddit credentials are configured, in which case
 * gallery-dl falls back to its unauthenticated default behavior.
 */
export async function getGalleryDlConfigPath() {
  if (cachedConfigPath) return cachedConfigPath;

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
  let hasConfig = true;

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

  const instagramConfig = { videos: true };
  const igCookies = getCookieForUrl('https://www.instagram.com');
  if (igCookies) {
    instagramConfig['cookies'] = igCookies;
  }
  if (config.instagramUsername && config.instagramPassword) {
    instagramConfig['username'] = config.instagramUsername;
    instagramConfig['password'] = config.instagramPassword;
  }

  gdlConfig.extractor.instagram = instagramConfig;

  const configPath = path.join(os.tmpdir(), 'archivist-fox-gallerydl-config.json');
  await fs.promises.writeFile(configPath, JSON.stringify(gdlConfig, null, 2));
  cachedConfigPath = configPath;
  return configPath;
}

