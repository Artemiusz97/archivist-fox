import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';

export const PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv', '.m4v', '.ts', '.wmv',
]);

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.flac', '.aac', '.alac', '.aiff',
]);

export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.tiff', '.svg',
]);

export function isVideo(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

export function isAudio(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

export function isImage(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Schedules a bot-sent message for deletion after ERROR_MESSAGE_TTL_SECONDS,
 * if configured. No-ops if the TTL is 0/unset. Failures (message already
 * gone, missing permissions) are swallowed silently.
 *
 * @param {import('discord.js').Message} message
 * @param {number} [ttlMs] - Optional explicit TTL in ms. Defaults to config.errorMessageTtlMs.
 */
export function scheduleAutoDelete(message, ttlMs = config.errorMessageTtlMs) {
  const effectiveTtl = ttlMs !== undefined ? ttlMs : config.errorMessageTtlMs;
  if (!message || effectiveTtl <= 0) return;
  const timer = setTimeout(() => {
    message.delete().catch(() => {});
  }, effectiveTtl);
  timer.unref?.();
}

/**
 * Schedules a user-sent command message (e.g. !retry, !rescan, !stop) for deletion
 * after COMMAND_MESSAGE_TTL_SECONDS, if AUTO_DELETE_COMMAND_MESSAGES is enabled.
 * Requires the bot to have "Manage Messages" permission in the channel.
 * Failures (missing permissions, already deleted) are silently caught.
 *
 * @param {import('discord.js').Message} message
 * @param {number} [ttlMs] - Optional explicit TTL in ms. Defaults to config.commandMessageTtlMs.
 */
export function scheduleCommandMessageDelete(message, ttlMs = config.commandMessageTtlMs) {
  if (!message || !config.autoDeleteCommandMessages) return;
  const delay = ttlMs !== undefined ? ttlMs : config.commandMessageTtlMs;
  if (delay < 0) return;
  const timer = setTimeout(() => {
    message.delete().catch(() => {});
  }, delay);
  timer.unref?.();
}

/**
 * Safely kills a process and all its children across OSes.
 * On Windows, uses taskkill /T /F.
 * On POSIX, uses process.kill(-pid) if possible, or standard child.kill().
 *
 * @param {import('node:child_process').ChildProcess} child
 */
export function killProcessTree(child) {
  if (!child || !child.pid) return;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {
      try { child.kill('SIGKILL'); } catch (err) {
    void err;
  }
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch (err) {
    void err;
  }
    }
  }
}

const activeDownloadProcesses = new Set();

/**
 * Registers an active child process spawned for downloading or media processing.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
export function registerDownloadProcess(child) {
  if (!child || !child.pid) return;
  activeDownloadProcesses.add(child);
  const cleanup = () => {
    activeDownloadProcesses.delete(child);
  };
  child.once('close', cleanup);
  child.once('error', cleanup);
}

/**
 * Unregisters an active child process.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
export function unregisterDownloadProcess(child) {
  activeDownloadProcesses.delete(child);
}

/**
 * Terminates all tracked active download/media processes across OSes.
 *
 * @returns {number} The count of processes terminated.
 */
export function killAllDownloadProcesses() {
  const count = activeDownloadProcesses.size;
  for (const child of activeDownloadProcesses) {
    killProcessTree(child);
  }
  activeDownloadProcesses.clear();
  return count;
}

let stopRequestedState = false;

export function isStopRequested() {
  return stopRequestedState;
}

export function requestStop() {
  stopRequestedState = true;
}

export function clearStopRequested() {
  stopRequestedState = false;
}

/**
 * Returns true if an error was caused by an intentional task/download abortion.
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isAbortError(err) {
  if (!err) return false;
  return (
    err.name === 'AbortError' ||
    err.code === 'ERR_CANCELED' ||
    err.code === 'ABORT_ERR' ||
    err.message === 'DOWNLOAD_ABORTED' ||
    err.message === 'canceled' ||
    err.message?.includes('DOWNLOAD_ABORTED')
  );
}

/**
 * Abortable asynchronous sleep helper.
 *
 * @param {number} ms - Milliseconds to sleep.
 * @param {AbortSignal} [signal] - Optional AbortSignal to cancel sleep immediately.
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('DOWNLOAD_ABORTED'));
    }
    let timer = null;
    let onAbort = null;
    if (signal) {
      onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(new Error('DOWNLOAD_ABORTED'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
  });
}

/**
 * Unified subprocess gateway with continuous stdout/stderr draining (preventing
 * 64 KB pipe deadlocks on Windows), rolling buffer caps, timeout enforcement,
 * AbortSignal cancellation, and OS process-tree cleanup.
 *
 * @param {string} command
 * @param {string[]} [args=[]]
 * @param {object} [options={}]
 * @param {number} [options.timeoutMs=240000]
 * @param {AbortSignal|null} [options.signal=null]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.registerProcess=true]
 * @param {boolean} [options.rejectOnNonZero=true]
 * @param {number} [options.maxBufferBytes=2097152]
 * @param {boolean} [options.rollingBuffer=true]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runProcess(command, args = [], options = {}) {
  const {
    timeoutMs = 4 * 60 * 1000,
    signal = null,
    cwd = undefined,
    env = undefined,
    registerProcess = true,
    rejectOnNonZero = true,
    maxBufferBytes = 2 * 1024 * 1024,
    rollingBuffer = true,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('DOWNLOAD_ABORTED'));
    }

    let settled = false;
    let timer = null;
    let onAbort = null;

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (registerProcess) {
      registerDownloadProcess(child);
    }

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (registerProcess) unregisterDownloadProcess(child);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      fn(val);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killProcessTree(child);
        finish(reject, new Error(`TIMEOUT: ${command} took too long`));
      }, timeoutMs);
      timer.unref?.();
    }

    if (signal) {
      onAbort = () => {
        killProcessTree(child);
        finish(reject, new Error('DOWNLOAD_ABORTED'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      stdout += stdoutDecoder.write(chunk);
      if (maxBufferBytes > 0 && stdout.length > maxBufferBytes) {
        if (rollingBuffer) {
          stdout = stdout.slice(-maxBufferBytes);
        } else {
          killProcessTree(child);
          const err = new Error(`BUFFER_OVERFLOW: ${command} stdout exceeded ${maxBufferBytes} bytes`);
          err.code = 'BUFFER_OVERFLOW';
          finish(reject, err);
        }
      }
    });

    child.stderr?.on('data', (chunk) => {
      if (settled) return;
      stderr += stderrDecoder.write(chunk);
      if (maxBufferBytes > 0 && stderr.length > maxBufferBytes) {
        if (rollingBuffer) {
          stderr = stderr.slice(-maxBufferBytes);
        } else {
          killProcessTree(child);
          const err = new Error(`BUFFER_OVERFLOW: ${command} stderr exceeded ${maxBufferBytes} bytes`);
          err.code = 'BUFFER_OVERFLOW';
          finish(reject, err);
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      if (signal?.aborted) {
        finish(reject, new Error('DOWNLOAD_ABORTED'));
      } else if (err.code === 'ENOENT') {
        finish(reject, new Error(`COMMAND_NOT_FOUND: ${command} is not installed or not on PATH`));
      } else {
        finish(reject, err);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (maxBufferBytes > 0 && !rollingBuffer && (stdout.length > maxBufferBytes || stderr.length > maxBufferBytes)) {
        const err = new Error(`BUFFER_OVERFLOW: ${command} output exceeded ${maxBufferBytes} bytes`);
        err.code = 'BUFFER_OVERFLOW';
        return finish(reject, err);
      }
      if (maxBufferBytes > 0 && rollingBuffer) {
        if (stdout.length > maxBufferBytes) stdout = stdout.slice(-maxBufferBytes);
        if (stderr.length > maxBufferBytes) stderr = stderr.slice(-maxBufferBytes);
      }
      if (signal?.aborted) {
        finish(reject, new Error('DOWNLOAD_ABORTED'));
      } else if (code !== 0 && rejectOnNonZero) {
        const error = new Error(`${command} exited with code ${code}: ${stderr.trim().slice(-500)}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(reject, error);
      } else {
        finish(resolve, { code: code ?? 0, stdout, stderr });
      }
    });
  });
}

/**
 * Canonical single-pass ffprobe inspector. Distinguishes genuine video streams
 * from embedded cover-art pictures (`disposition.attached_pic === 1`) so audio
 * tracks with album art are never misclassified as video files.
 *
 * @param {string} filePath
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts={}]
 */
export async function probeMedia(filePath, opts = {}) {
  const defaultResult = {
    duration: 0,
    width: 0,
    height: 0,
    fps: 30,
    hasVideo: false,
    hasAudio: false,
    isVideo: isVideo(filePath),
    videoCodec: '',
    audioCodec: '',
    videoBitrate: 0,
    audioBitrate: 0,
    totalBitrate: 0,
    attachedPicStreamIndex: null,
    streams: [],
    format: {},
  };

  if (!filePath || !fs.existsSync(filePath)) return defaultResult;

  try {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,bit_rate,r_frame_rate:stream_disposition=attached_pic',
      '-of', 'json',
      filePath,
    ];
    const execFn = opts.execFn || runProcess;
    const { stdout } = await execFn(config.ffprobePath || 'ffprobe', args, {
      timeoutMs: opts.timeoutMs || 15000,
      signal: opts.signal,
      registerProcess: false,
    });

    const data = JSON.parse(stdout || '{}');
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const format = data.format || {};
    const duration = parseFloat(format.duration || '0') || 0;
    const sizeBytes = parseInt(format.size || '0', 10) || 0;
    const formatBitrate = parseInt(format.bit_rate || '0', 10) || 0;
    const totalBitrate =
      formatBitrate > 0
        ? formatBitrate
        : duration > 0 && sizeBytes > 0
          ? Math.round((sizeBytes * 8) / duration)
          : 0;

    // Strictly ignore attached cover-art picture streams when identifying video
    const videoStream = streams.find(
      (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1
    );
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    const attachedStream = streams.find(
      (s) =>
        s.disposition?.attached_pic === 1 ||
        (s.codec_type === 'video' && s !== videoStream && ['mjpeg', 'png', 'webp'].includes(s.codec_name))
    );

    let fps = 30;
    if (videoStream?.r_frame_rate) {
      const [num, den] = String(videoStream.r_frame_rate).split('/').map(Number);
      if (num && den && den > 0) {
        fps = Math.round(num / den);
      }
    }

    return {
      duration,
      width: parseInt(videoStream?.width || '0', 10) || 0,
      height: parseInt(videoStream?.height || '0', 10) || 0,
      fps: fps || 30,
      hasVideo: Boolean(videoStream),
      hasAudio: Boolean(audioStream),
      isVideo: Boolean(videoStream) || (isVideo(filePath) && !audioStream),
      videoCodec: videoStream?.codec_name || '',
      audioCodec: audioStream?.codec_name || '',
      videoBitrate: parseInt(videoStream?.bit_rate || '0', 10) || 0,
      audioBitrate: parseInt(audioStream?.bit_rate || '0', 10) || 0,
      totalBitrate,
      attachedPicStreamIndex: attachedStream ? attachedStream.index : null,
      streams,
      format,
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return defaultResult;
  }
}

/**
 * Returns true if an IPv4 or IPv6 address belongs to loopback, link-local,
 * RFC 1918 private, CGNAT,unspecified, or cloud metadata ranges.
 *
 * @param {string} rawIp
 * @returns {boolean}
 */
export function isPrivateIp(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return true;
  const ip = rawIp.trim().replace(/^\[|\]$/g, '').toLowerCase();

  // Check IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    if (net.isIPv4(mapped)) {
      return isPrivateIp(mapped);
    }
    // Hex form ::ffff:7f00:1
    const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIp(v4);
    }
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true;                             // 0.0.0.0/8
    if (a === 10) return true;                            // 10.0.0.0/8
    if (a === 127) return true;                           // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                            // Multicast & reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 Unique Local
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // fe80::/10 Link-Local
    if (ip.startsWith('ff')) return true; // Multicast
    return false;
  }

  return true;
}

/**
 * Validates an outbound HTTP/HTTPS URL against SSRF to loopback, link-local,
 * metadata, or private RFC 1918 networks (including DNS resolution checks).
 *
 * @param {string} targetUrl
 * @param {{ lookup?: typeof dns.promises.lookup }} [options={}]
 * @returns {Promise<URL>}
 */
export async function validateSsrfTarget(targetUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error('SSRF_BLOCKED: Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SSRF_BLOCKED: Unsupported protocol ${parsed.protocol}`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isTestEnv =
    process.env.NODE_ENV === 'test' ||
    process.execArgv.includes('--test') ||
    Boolean(process.env.NODE_TEST_CONTEXT);
  if (
    isTestEnv &&
    options.allowLoopback === true &&
    (host === 'localhost' || host === '127.0.0.1' || host === '::1')
  ) {
    return parsed;
  }

  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0'
  ) {
    throw new Error(`SSRF_BLOCKED: Blocked private/loopback hostname (${host})`);
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`SSRF_BLOCKED: Blocked private/loopback IP (${host})`);
    }
    return parsed;
  }

  const lookupFn = options.lookup || dns.promises.lookup;
  const records = await lookupFn(host, { all: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`DNS_LOOKUP_FAILED: Could not resolve ${host}`);
  }

  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      throw new Error(`SSRF_BLOCKED: Host ${host} resolved to private/loopback IP (${rec.address})`);
    }
  }

  return parsed;
}

/**
 * Safely replies to a Discord message, falling back to `channel.send()` if the
 * original message was deleted mid-download (Discord error 50035 / 10008).
 *
 * @param {import('discord.js').Message} message
 * @param {object} payload
 * @param {import('discord.js').TextBasedChannel|null} [overrideChannel=null]
 */
export async function safeReply(message, payload, overrideChannel = null) {
  if (overrideChannel) {
    return await overrideChannel.send(payload);
  }
  const replyPayload = {
    ...payload,
    allowedMentions: payload.allowedMentions || { repliedUser: false },
  };
  try {
    return await message.reply(replyPayload);
  } catch (err) {
    const isUnknownRef =
      err?.code === 50035 ||
      err?.code === 10008 ||
      err?.message?.includes('MESSAGE_REFERENCE_UNKNOWN_MESSAGE') ||
      err?.message?.includes('Unknown Message');

    if (isUnknownRef && message.channel?.send) {
      return await message.channel.send(payload);
    }
    throw err;
  }
}

/**
 * Builds the interactive Discord button row for duplicate link/media alerts.
 * Includes `🗑️ Delete Post` only when `canDeletePost` is true (e.g. 0 unique
 * links in the post), plus `✖️ Dismiss`.
 *
 * @param {{ messageId?: string, authorId?: string, canDeletePost?: boolean }} opts
 * @returns {ActionRowBuilder}
 */
export function buildDuplicateActionRow({ messageId, authorId, canDeletePost = false } = {}) {
  const safeAuthorId = authorId || '0';
  const buttons = [];

  if (canDeletePost && messageId) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`delete_duplicate:${messageId}:${safeAuthorId}`)
        .setLabel('Delete Post')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️')
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`dismiss_alert:${safeAuthorId}`)
      .setLabel('Dismiss')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('✖️')
  );

  return new ActionRowBuilder().addComponents(buttons);
}

/**
 * Formats a Discord User object into a readable author string without legacy `#0`.
 *
 * @param {any} user
 * @returns {string}
 */
export function formatDiscordAuthor(user) {
  if (!user) return 'Unknown';
  if (user.discriminator && user.discriminator !== '0') {
    return `${user.username}#${user.discriminator}`;
  }
  return user.tag && !user.tag.endsWith('#0') ? user.tag : (user.username || user.globalName || 'Unknown');
}

/**
 * Checks whether a guild member/user holds Moderator (`ManageMessages` / `Administrator`)
 * permissions or is the Guild Owner.
 *
 * @param {any} memberOrPermissions
 * @param {any} [guild]
 * @param {string} [userId]
 * @returns {boolean}
 */
export function isModeratorOrOwner(memberOrPermissions, guild = null, userId = null) {
  if (guild && userId && guild.ownerId === userId) return true;
  const perms = memberOrPermissions?.permissions ?? memberOrPermissions;
  if (!perms || typeof perms.has !== 'function') return false;
  return Boolean(
    perms.has(PermissionFlagsBits.ManageMessages) ||
    perms.has(PermissionFlagsBits.Administrator)
  );
}

/**
 * Cleans up leftover archivist-fox-* temporary directories in os.tmpdir()
 * older than maxAgeMs (default: 1 hour).
 */
export async function cleanupStaleTempDirs(maxAgeMs = 60 * 60 * 1000) {
  try {
    const tmpDir = os.tmpdir();
    const entries = await fs.promises.readdir(tmpDir, { withFileTypes: true });
    const now = Date.now();
    let cleanedCount = 0;

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        (entry.name.startsWith('archivist-fox-') ||
          entry.name.startsWith('archivist-scan-') ||
          entry.name.startsWith('ytdlp-upgrade-'))
      ) {
        const fullPath = path.join(tmpDir, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.promises.rm(fullPath, { recursive: true, force: true });
            cleanedCount++;
          }
        } catch (err) {
    void err;
  }
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Cleaner] Purged ${cleanedCount} stale temporary directories from previous runs.`);
    }
  } catch (err) {
    void err;
  }
}

/**
 * Windows NTFS reserved device names that cannot be used as file or folder names.
 * Using them (with or without an extension) causes EINVAL / EPERM OS errors.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Sanitizes a single path segment (filename or folder name) for safe use on
 * Windows NTFS and all other platforms.
 *
 * @param {string} str - Raw filename or folder name to sanitize
 * @param {number} [maxLen=100] - Maximum character length of the result
 * @param {string} [fallback='file'] - Value to use if sanitization yields an empty string
 * @returns {string}
 */
export function sanitizePathSegment(str, maxLen = 100, fallback = 'file') {
  if (!str || typeof str !== 'string') return fallback;

  let s = str
    .replace(/[\x00-\x1f/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return fallback;

  const upperBase = s.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(upperBase)) {
    s = `_${s}`;
  }

  s = s.replace(/[. ]+$/, '');

  if (!s) return fallback;

  return s.slice(0, maxLen) || fallback;
}

/**
 * Generates a right-skewed human jitter delay (in ms) clamped strictly within [minMs, maxMs].
 * Uses Box-Muller log-normal sampling to mimic natural human reaction latencies.
 */
export function getHumanJitterMs(minMs = 1500, maxMs = 3500) {
  if (config && config.enableHumanJitter === false) {
    return 0;
  }
  const min = Math.max(100, minMs);
  const max = Math.max(min, maxMs);
  if (min === max) return min;

  const u1 = Math.max(1e-7, Math.random());
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

  const logMin = Math.log(min);
  const logMax = Math.log(max);
  const mu = logMin + (logMax - logMin) * 0.35;
  const sigma = (logMax - logMin) / 3.0;
  const sample = Math.exp(mu + z0 * sigma);

  return Math.floor(Math.min(max, Math.max(min, sample)));
}

/**
 * Returns a standard modern desktop User-Agent string corresponding to the
 * requested browser family (firefox, chrome, edge, safari).
 */
export function getBrowserUserAgent(browserType = 'chrome') {
  const b = (browserType || '').toLowerCase();
  if (b.includes('firefox')) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0';
  }
  if (b.includes('edge')) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0';
  }
  if (b.includes('safari') && !b.includes('chrome')) {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
}

const KNOWN_BROWSER_FAMILIES = new Set(['chrome', 'firefox', 'edge', 'safari', 'brave', 'chromium', 'auto']);

/**
 * Builds modern desktop browser request headers aligned with active browser impersonation.
 * Supports both `getBrowserHeaders(targetUrl, options)` and `getBrowserHeaders(browserType, targetUrl, options)`.
 * Emits Chromium Client Hints strictly for Chromium profiles (never Firefox/Safari) and injects
 * contextual anti-hotlinking Referer headers.
 */
export function getBrowserHeaders(firstArg, secondArg = {}, thirdArg = {}) {
  let explicitBrowser = '';
  let targetUrl = null;
  let options = {};

  if (
    typeof firstArg === 'string' &&
    KNOWN_BROWSER_FAMILIES.has(firstArg.trim().toLowerCase()) &&
    !/^https?:\/\//i.test(firstArg)
  ) {
    explicitBrowser = firstArg.trim().toLowerCase();
    targetUrl = secondArg && typeof secondArg !== 'object' ? secondArg : (secondArg instanceof URL ? secondArg : null);
    options = (secondArg && typeof secondArg === 'object' && !(secondArg instanceof URL)) ? secondArg : (thirdArg || {});
  } else {
    targetUrl = firstArg;
    options = secondArg && typeof secondArg === 'object' ? secondArg : {};
  }

  let browserFamily = (explicitBrowser || options.browser || config.impersonateBrowser || '').toLowerCase();
  if (browserFamily === 'auto' || !browserFamily) {
    if (config.cookiesFromBrowser) {
      const lower = config.cookiesFromBrowser.toLowerCase();
      if (lower.includes('firefox')) browserFamily = 'firefox';
      else if (lower.includes('edge')) browserFamily = 'edge';
      else if (lower.includes('safari')) browserFamily = 'safari';
      else if (lower.includes('brave')) browserFamily = 'brave';
      else browserFamily = 'chrome';
    } else {
      browserFamily = 'chrome';
    }
  }

  const isChromium = ['chrome', 'edge', 'brave', 'chromium'].some((b) => browserFamily.includes(b));
  const userAgent = options.userAgent || getBrowserUserAgent(browserFamily);

  const headers = {
    'User-Agent': userAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': options.fetchDest || 'empty',
    'Sec-Fetch-Mode': options.fetchMode || 'cors',
    'Sec-Fetch-Site': options.fetchSite || 'cross-site',
  };

  if (isChromium) {
    if (browserFamily.includes('edge')) {
      headers['Sec-CH-UA'] = '"Not(A:Brand";v="99", "Microsoft Edge";v="133", "Chromium";v="133"';
    } else {
      headers['Sec-CH-UA'] = '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"';
    }
    headers['Sec-CH-UA-Mobile'] = '?0';
    headers['Sec-CH-UA-Platform'] = '"Windows"';
  }

  if (targetUrl) {
    try {
      const parsed = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
      const host = parsed.hostname.toLowerCase();
      if (host === 'i.pximg.net' || host.endsWith('.pximg.net') || host === 'pximg.net') {
        headers.Referer = 'https://www.pixiv.net/';
      } else if (host.endsWith('hdslb.com') || host.endsWith('bilibili.com')) {
        headers.Referer = 'https://www.bilibili.com/';
      } else if (host === 'pbs.twimg.com' || host.endsWith('.twimg.com') || host === 'twimg.com') {
        headers.Referer = 'https://x.com/';
      } else if (host === 'i.redd.it' || host === 'v.redd.it' || host.endsWith('.redd.it')) {
        headers.Referer = 'https://www.reddit.com/';
      }
    } catch (err) {
    void err;
  }
  }

  if (options.referer) {
    headers.Referer = options.referer;
  }

  if (options.headers && typeof options.headers === 'object') {
    Object.assign(headers, options.headers);
  }

  return headers;
}

/**
 * Safely parses an HTTP 429 `Retry-After` header value (delta-seconds or HTTP-date),
 * clamped between `minMs` and `maxMs`.
 */
export function parseRetryAfterMs(retryAfterHeader, defaultMs = 3000, minMs = 1000, maxMs = 60000) {
  if (!retryAfterHeader) return null;
  const header = String(retryAfterHeader).trim();
  if (!header) return null;

  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, minMs), maxMs);
  }

  const parsedDate = Date.parse(header);
  if (!Number.isNaN(parsedDate)) {
    const diffMs = parsedDate - Date.now();
    return Math.min(Math.max(diffMs > 0 ? diffMs : minMs, minMs), maxMs);
  }

  return Math.min(Math.max(defaultMs, minMs), maxMs);
}

/**
 * Identifies unfinished temporary download artifacts (`.part`, `.ytdl`, `.temp`, `.f137` chunks)
 * while strictly preserving legitimate media files such as `.flac` and `.flv`.
 */
export function isPartialTempFile(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  const ext = path.extname(base).toLowerCase();
  return (
    ext === '.part' ||
    ext === '.ytdl' ||
    ext === '.temp' ||
    /^\.f\d+$/i.test(ext) ||
    base.endsWith('.part') ||
    base.endsWith('.ytdl') ||
    base.endsWith('.temp')
  );
}

export async function purgeTempDownloadArtifacts(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && isPartialTempFile(entry.name)) {
        await fs.promises.unlink(path.join(dir, entry.name)).catch(() => {});
      }
    }
  } catch (err) {
    void err;
  }
}

export function isCookieLockError(err) {
  const msg = `${err?.stderr || ''} ${err?.message || ''} ${String(err || '')}`.toLowerCase();
  return (
    msg.includes('database is locked') ||
    msg.includes('could not copy') ||
    msg.includes('cookie database') ||
    (msg.includes('permission denied') && (msg.includes('cookie') || msg.includes('sqlite')))
  );
}

const domainPaceTimestamps = new Map();

/**
 * Staggers parallel outbound requests hitting the exact same hostname by 600-1100ms,
 * while requests to distinct hostnames proceed with 0ms wait.
 */
export async function paceDomainRequest(rawUrl, signal, { force = false } = {}) {
  const isTest =
    process.env.NODE_ENV === 'test' ||
    process.execArgv.includes('--test') ||
    Boolean(process.env.NODE_TEST_CONTEXT);
  if (isTest && !force) return;
  if (signal?.aborted) {
    throw new Error('DOWNLOAD_ABORTED');
  }

  let hostname;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return;
  }

  const now = Date.now();
  const lastTime = domainPaceTimestamps.get(hostname) || 0;
  const stagger = Math.floor(600 + Math.random() * 501);
  const scheduledTime = Math.max(now, lastTime + stagger);
  domainPaceTimestamps.set(hostname, scheduledTime);

  if (domainPaceTimestamps.size > 500) {
    for (const [host, time] of domainPaceTimestamps.entries()) {
      if (now > time + 60000) domainPaceTimestamps.delete(host);
    }
  }

  const waitMs = scheduledTime - now;
  if (waitMs > 0) {
    await sleep(waitMs, signal);
  }
}

export function isValidDisplayTitle(title) {
  if (!title || typeof title !== 'string') return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('file-') || trimmed.startsWith('tmp_')) return false;
  const lower = trimmed.toLowerCase();
  if (['video', 'image', 'audio', 'media', 'download'].includes(lower)) return false;
  if (/^[0-9a-f]{20,}$/i.test(trimmed)) return false;
  if (/^\d{12,}$/.test(trimmed)) return false;
  return true;
}

/**
 * Formats Discord message text for an uploaded batch of media items (titles, emojis, album headers).
 */
export function formatMediaMessageContent(chunkItems = [], { batchNum = 1, totalBatches = 1, isSpoilered = false } = {}) {
  const items = Array.isArray(chunkItems) ? chunkItems : [];
  const chunkLength = items.length;
  const chunkIsSpoilered = Boolean(isSpoilered || items.some((c) => c?.isSpoiler));

  if (config.includeTitleInMessage) {
    const mediaItems = items.filter((item) => item && !item.isSubtitle && isValidDisplayTitle(item.title));
    const uniqueTitles = [...new Set(mediaItems.map((item) => item.title.replace(/[\r\n]+/g, ' ').trim()))];

    const formatTitle = (t) => (chunkIsSpoilered && config.spoilerTitles ? `||**${t}**||` : `**${t}**`);

    if (totalBatches > 1) {
      const rawAlbumTitle = uniqueTitles.length === 1 ? uniqueTitles[0] : '';
      const albumTitle = rawAlbumTitle ? ` — ${formatTitle(rawAlbumTitle)}` : '';
      return `🖼️ Album Part ${batchNum}/${totalBatches} (${chunkLength} items)${albumTitle}:`;
    }

    if (uniqueTitles.length === 1) {
      const singleItem = mediaItems[0] || items[0] || {};
      const icon = singleItem.isVideo ? '🎬' : singleItem.isAudio ? '🎵' : '🖼️';
      return `${icon} ${formatTitle(uniqueTitles[0])}`;
    }

    if (uniqueTitles.length > 1) {
      const titleLines = mediaItems.slice(0, 5).map((item) => {
        const icon = item.isVideo ? '🎬' : item.isAudio ? '🎵' : '🖼️';
        const t = item.title.replace(/[\r\n]+/g, ' ').trim();
        return `${icon} ${formatTitle(t)}`;
      });
      return [...new Set(titleLines)].join('\n');
    }
  }

  if (totalBatches > 1) {
    return `🖼️ Album Part ${batchNum}/${totalBatches} (${chunkLength} items):`;
  }

  return undefined;
}
