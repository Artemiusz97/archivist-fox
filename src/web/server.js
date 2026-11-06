import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { initLinkDb, getDb } from '../linkDb.js';
import { ensureBinaries } from '../ensureBinaries.js';
import { downloadMediaItem } from '../downloaderCore.js';

const MAX_FILE_CACHE = 500;
const MAX_TASKS = 200;

// Cache for fast file resolution: `${archiveRoot}::${basename}` -> fullPath
const fileLocationCache = new Map();

function isTestMode() {
  return (
    process.env.NODE_ENV === 'test' ||
    process.execArgv.includes('--test') ||
    Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function isLoopbackAddress(remoteAddress = '') {
  const addr = String(remoteAddress).trim().toLowerCase();
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('::ffff:127.')
  );
}

/**
 * Verifies via `fs.promises.realpath` that `candidatePath` exists and resides
 * strictly inside `archiveRoot` (blocking `..`, `.env`, symlinks, and sibling-prefix escapes).
 *
 * @param {string} candidatePath
 * @param {string} archiveRoot
 * @param {{ allowRootDir?: boolean }} [opts={}]
 * @returns {Promise<string|null>}
 */
async function verifyContainedRealPath(candidatePath, archiveRoot, { allowRootDir = false } = {}) {
  if (!candidatePath || !archiveRoot) return null;
  try {
    const realArchive = await fs.promises.realpath(archiveRoot);
    const realCandidate = await fs.promises.realpath(candidatePath);
    const rel = path.relative(realArchive, realCandidate);
    if (rel === '') {
      return allowRootDir ? realCandidate : null;
    }
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return realCandidate;
    }
  } catch (err) {
    void err;
  }
  return null;
}

function cacheArchiveLocation(cacheKey, resolvedPath) {
  fileLocationCache.set(cacheKey, resolvedPath);
  if (fileLocationCache.size > MAX_FILE_CACHE) {
    const oldestKey = fileLocationCache.keys().next().value;
    fileLocationCache.delete(oldestKey);
  }
}

async function findArchivedFile(targetFile) {
  if (!targetFile || typeof targetFile !== 'string') return null;
  const archiveRoot = path.resolve(config.archiveDirectory);
  if (!fs.existsSync(archiveRoot)) return null;

  const rawCandidate = path.isAbsolute(targetFile)
    ? path.resolve(targetFile)
    : path.resolve(archiveRoot, targetFile);

  // Reject any path whose lexical resolution already escapes archiveRoot before touching disk/DB
  const realArchiveRoot = await fs.promises.realpath(archiveRoot).catch(() => null);
  if (!realArchiveRoot) return null;

  const lexicalRel = path.relative(archiveRoot, rawCandidate);
  if (lexicalRel.startsWith('..') || path.isAbsolute(lexicalRel)) {
    return null;
  }

  // 1. Direct path check inside archiveRoot
  const directContained = await verifyContainedRealPath(rawCandidate, realArchiveRoot);
  if (directContained) {
    const st = await fs.promises.stat(directContained).catch(() => null);
    if (st?.isFile()) {
      return directContained;
    }
  }

  const basename = path.basename(targetFile);
  if (!basename || basename === '.' || basename === '..') return null;

  const cacheKey = `${realArchiveRoot}::${basename}`;
  if (fileLocationCache.has(cacheKey)) {
    const cached = await verifyContainedRealPath(fileLocationCache.get(cacheKey), realArchiveRoot);
    if (cached) return cached;
    fileLocationCache.delete(cacheKey);
  }

  // 2. O(1) SQLite lookup via relative_path or channel/date folder
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT relative_path, channel, archived_at FROM media_records WHERE file_name = ? LIMIT 1')
      .get(basename);
    if (row) {
      const dbCandidates = [];
      if (row.relative_path) {
        dbCandidates.push(path.join(realArchiveRoot, row.relative_path));
      }
      if (row.channel) {
        dbCandidates.push(path.join(realArchiveRoot, row.channel, basename));
        if (row.archived_at) {
          const dateStr = row.archived_at.slice(0, 7);
          dbCandidates.push(path.join(realArchiveRoot, row.channel, dateStr, basename));
          dbCandidates.push(path.join(realArchiveRoot, dateStr, row.channel, basename));
        }
      }
      for (const cand of dbCandidates) {
        const contained = await verifyContainedRealPath(cand, realArchiveRoot);
        if (contained) {
          const st = await fs.promises.stat(contained).catch(() => null);
          if (st?.isFile()) {
            cacheArchiveLocation(cacheKey, contained);
            return contained;
          }
        }
      }
    }
  } catch (err) {
    void err;
  }

  // 3. Fallback recursive search inside realArchiveRoot
  async function searchDir(dir) {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await searchDir(full);
          if (found) return found;
        } else if (entry.isFile() && entry.name === basename) {
          return await verifyContainedRealPath(full, realArchiveRoot);
        }
      }
    } catch (err) {
    void err;
  }
    return null;
  }

  const found = await searchDir(realArchiveRoot);
  if (found) {
    cacheArchiveLocation(cacheKey, found);
  }
  return found;
}

async function openFolderOrFile(targetPath) {
  const archiveRoot = path.resolve(config.archiveDirectory);
  let resolved = null;

  if (targetPath !== undefined && targetPath !== null && String(targetPath).trim() !== '') {
    const rawStr = String(targetPath).trim();
    const candidate = path.isAbsolute(rawStr) ? path.resolve(rawStr) : path.resolve(archiveRoot, rawStr);
    resolved =
      (await verifyContainedRealPath(candidate, archiveRoot, { allowRootDir: true })) ||
      (await findArchivedFile(rawStr));

    if (!resolved) {
      const err = new Error('Path outside archive directory or not found');
      err.statusCode = 403;
      throw err;
    }
  } else {
    if (!fs.existsSync(archiveRoot)) {
      await fs.promises.mkdir(archiveRoot, { recursive: true });
    }
    resolved = await fs.promises.realpath(archiveRoot);
  }

  // Never spawn GUI file-explorer windows during automated test suites
  if (isTestMode()) {
    return resolved;
  }

  const stat = await fs.promises.stat(resolved);
  if (process.platform === 'win32') {
    if (stat.isDirectory()) {
      spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else {
      spawn('explorer.exe', [`/select,${resolved}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    }
  } else if (process.platform === 'darwin') {
    if (stat.isDirectory()) {
      spawn('open', [resolved], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('open', ['-R', resolved], { detached: true, stdio: 'ignore' }).unref();
    }
  } else {
    const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
    spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
  }

  return resolved;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

// In-memory active and recent tasks
const tasks = new Map();
const sseSubscribers = new Map(); // taskId -> Set of res

class AsyncSemaphore {
  constructor(getMax) {
    this.getMax = typeof getMax === 'function' ? getMax : () => getMax;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    const limit = Math.max(1, this.getMax());
    if (this.current < limit && this.queue.length === 0) {
      this.current++;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.current = Math.max(0, this.current - 1);
    const limit = Math.max(1, this.getMax());
    while (this.queue.length > 0 && this.current < limit) {
      this.current++;
      const next = this.queue.shift();
      next();
    }
  }
}

const webDownloadSemaphore = new AsyncSemaphore(() => config.maxConcurrentDownloads || 3);

function isTerminalStage(stage) {
  return stage === 'completed' || stage === 'error';
}

function broadcastTaskUpdate(taskId, update) {
  const task = tasks.get(taskId);
  if (!task) return;

  Object.assign(task, update);

  const listeners = sseSubscribers.get(taskId);
  if (listeners && listeners.size > 0) {
    const payload = `data: ${JSON.stringify(task)}\n\n`;
    const shouldClose = isTerminalStage(task.stage);
    for (const res of listeners) {
      try {
        res.write(payload);
        if (shouldClose) {
          res.end();
        }
      } catch (err) {
    void err;
  }
    }
    if (shouldClose) {
      sseSubscribers.delete(taskId);
    }
  }
}

function getCorsOriginHeader(req) {
  const origin = req.headers.origin;
  if (!origin) return 'http://127.0.0.1';
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) {
    return origin;
  }
  return 'null';
}

function checkWebAuth(req, parsedUrl) {
  const expected = config.webAuthToken;
  if (!expected) return true;

  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const headerToken = req.headers['x-auth-token'] || '';
  const queryToken = parsedUrl.searchParams.get('token') || '';
  const candidate = String(bearerToken || headerToken || queryToken);

  if (!candidate || candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(req, res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': getCorsOriginHeader(req),
  });
  res.end(JSON.stringify(data));
}

function pipeStreamSafely(req, res, filePath, options = undefined) {
  const stream = fs.createReadStream(filePath, options);
  const cleanup = () => {
    if (!stream.destroyed) stream.destroy();
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end();
  });
  stream.pipe(res);
}

function serveStaticFile(req, res, reqPath) {
  const relativePath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.resolve(PUBLIC_DIR, safePath);
  const relToPublic = path.relative(PUBLIC_DIR, filePath);

  if (relToPublic.startsWith('..') || path.isAbsolute(relToPublic)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
    });

    pipeStreamSafely(req, res, filePath);
  });
}

function parseHttpByteRange(rangeHeader, fileSize) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!match) return { valid: false };

  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return { valid: false };

  let start;
  let end;
  if (!startStr) {
    // Suffix byte-range-spec: bytes=-500
    const suffixLen = parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0 || fileSize === 0) {
      return { valid: false };
    }
    start = Math.max(0, fileSize - suffixLen);
    end = fileSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= fileSize || start > end) {
      return { valid: false };
    }
    end = Math.min(end, fileSize - 1);
  }

  return { valid: true, start, end };
}

async function handleDownloadFile(req, res, query) {
  const targetFile = query.get('file') || query.get('path');
  if (!targetFile) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing "file" query parameter');
    return;
  }

  const resolvedPath = await findArchivedFile(targetFile);
  if (!resolvedPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 File Not Found');
    return;
  }

  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 File Not Found');
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const filename = path.basename(resolvedPath);

    // Support RFC 7233 HTTP range requests for media streaming (video/audio seeking)
    const range = req.headers.range;
    if (range) {
      const parsedRange = parseHttpByteRange(range, stats.size);
      if (!parsedRange.valid) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stats.size}`,
          'Content-Type': 'text/plain',
        });
        res.end('416 Range Not Satisfiable');
        return;
      }

      const { start, end } = parsedRange;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });

      pipeStreamSafely(req, res, resolvedPath, { start, end });
    } else {
      const isDownload = query.get('download') === '1';
      const headers = {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Accept-Ranges': 'bytes',
      };

      if (isDownload) {
        headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`;
      }

      res.writeHead(200, headers);
      pipeStreamSafely(req, res, resolvedPath);
    }
  });
}

function handleHistory(req, res, query) {
  try {
    const db = getDb();
    const limit = Math.min(100, Math.max(1, parseInt(query.get('limit') || '50', 10) || 50));
    const offset = Math.max(0, parseInt(query.get('offset') || '0', 10) || 0);
    const searchQuery = query.get('q')?.trim();

    let rows;
    if (searchQuery) {
      const stmt = db.prepare(`
        SELECT id, media_id, sha256, duration, hash, original_url, title, posted_by, channel, archived_at, file_name, relative_path, file_size
        FROM media_records
        WHERE title LIKE ? OR original_url LIKE ? OR file_name LIKE ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `);
      const term = `%${searchQuery}%`;
      rows = stmt.all(term, term, term, limit, offset);
    } else {
      const stmt = db.prepare(`
        SELECT id, media_id, sha256, duration, hash, original_url, title, posted_by, channel, archived_at, file_name, relative_path, file_size
        FROM media_records
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `);
      rows = stmt.all(limit, offset);
    }

    sendJson(req, res, 200, { ok: true, records: rows });
  } catch (err) {
    sendJson(req, res, 500, { ok: false, error: err.message });
  }
}

async function handleApiDownload(req, res) {
  try {
    const body = await parseJsonBody(req);
    const url = body.url?.trim();
    if (!url) {
      return sendJson(req, res, 400, { ok: false, error: 'URL is required' });
    }

    const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const task = {
      id: taskId,
      url,
      stage: 'queued',
      message: 'Task enqueued...',
      audioOnly: Boolean(body.audioOnly),
      force: Boolean(body.force),
      saveToArchive: body.saveToArchive !== false,
      createdAt: Date.now(),
      result: null,
      error: null,
    };

    tasks.set(taskId, task);

    // Bound in-memory tasks to MAX_TASKS (200)
    while (tasks.size > MAX_TASKS) {
      const oldestKey = tasks.keys().next().value;
      tasks.delete(oldestKey);
      sseSubscribers.delete(oldestKey);
    }

    // Start bounded background processing
    (async () => {
      await webDownloadSemaphore.acquire();
      try {
        broadcastTaskUpdate(taskId, {
          stage: 'downloading',
          message: 'Starting download...',
        });

        const result = await downloadMediaItem(url, {
          audioOnly: task.audioOnly,
          force: task.force,
          saveToArchive: task.saveToArchive,
          author: 'WebUI',
          channel: 'web',
          onProgress: (prog) => {
            // Avoid premature terminal SSE closure before final result payload is attached
            const interimStage = prog.stage === 'completed' ? 'finalizing' : prog.stage;
            broadcastTaskUpdate(taskId, {
              stage: interimStage,
              message: prog.message,
              data: prog.data,
            });
          },
        });

        const msg = result.isDuplicate
          ? 'Media already exists in archive!'
          : `Successfully downloaded ${result.files?.length || 1} item(s)!`;

        broadcastTaskUpdate(taskId, {
          stage: 'completed',
          message: msg,
          result,
          files: result.files || [],
        });
      } catch (err) {
        broadcastTaskUpdate(taskId, {
          stage: 'error',
          message: err.message || 'Download failed',
          error: err.message || String(err),
        });
      } finally {
        webDownloadSemaphore.release();
      }
    })();

    sendJson(req, res, 202, { ok: true, taskId });
  } catch (err) {
    sendJson(req, res, 400, { ok: false, error: err.message });
  }
}

function handleProgressSse(req, res, taskId) {
  const task = tasks.get(taskId);
  if (!task) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Task not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': getCorsOriginHeader(req),
  });

  // Send current state immediately
  res.write(`data: ${JSON.stringify(task)}\n\n`);

  // If the task already finished before the SSE client subscribed, close cleanly right away
  if (isTerminalStage(task.stage)) {
    res.end();
    return;
  }

  if (!sseSubscribers.has(taskId)) {
    sseSubscribers.set(taskId, new Set());
  }
  sseSubscribers.get(taskId).add(res);

  req.on('close', () => {
    const listeners = sseSubscribers.get(taskId);
    if (listeners) {
      listeners.delete(res);
      if (listeners.size === 0) {
        sseSubscribers.delete(taskId);
      }
    }
  });
}

export function createWebServer() {
  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': getCorsOriginHeader(req),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
      });
      res.end();
      return;
    }

    // Optional bearer/token authentication on API routes when WEB_AUTH_TOKEN is configured
    if (pathname.startsWith('/api/') && !checkWebAuth(req, parsedUrl)) {
      sendJson(req, res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    // API Routes
    if (pathname === '/api/download' && req.method === 'POST') {
      await handleApiDownload(req, res);
      return;
    }

    if (pathname.startsWith('/api/progress/') && req.method === 'GET') {
      const taskId = pathname.slice('/api/progress/'.length);
      handleProgressSse(req, res, taskId);
      return;
    }

    if (pathname === '/api/tasks' && req.method === 'GET') {
      sendJson(req, res, 200, { ok: true, tasks: Array.from(tasks.values()).slice(-20).reverse() });
      return;
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      handleHistory(req, res, parsedUrl.searchParams);
      return;
    }

    if (pathname === '/api/file' && req.method === 'GET') {
      await handleDownloadFile(req, res, parsedUrl.searchParams);
      return;
    }

    if (pathname === '/api/open-folder' && req.method === 'POST') {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        sendJson(req, res, 403, { ok: false, error: 'Host folder opening is restricted to loopback clients' });
        return;
      }
      try {
        const body = await parseJsonBody(req);
        const opened = await openFolderOrFile(body.path);
        sendJson(req, res, 200, { ok: true, openedPath: opened });
      } catch (err) {
        const status = err.statusCode || 500;
        sendJson(req, res, status, { ok: false, error: err.message });
      }
      return;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      sendJson(req, res, 200, {
        ok: true,
        version: config.version,
        archiveDirectory: config.archiveDirectory,
        activeTasks: tasks.size,
      });
      return;
    }

    // Static Assets
    if (req.method === 'GET') {
      serveStaticFile(req, res, pathname);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  });
}

export async function startWebServer(port = config.webPort, host = config.webHost) {
  initLinkDb();
  await ensureBinaries();

  const server = createWebServer();

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[Web UI] ⚠️ Port ${port} is already in use. Web UI could not bind to ${host}:${port}.`);
      } else {
        console.error('[Web UI] ❌ Server error:', err.message);
      }
      reject(err);
    });

    server.listen(port, host, () => {
      const displayHost = host === '0.0.0.0' ? 'localhost' : host;
      console.log(`[Web UI] 🦊 Archivist Fox Web UI running at http://${displayHost}:${port}`);
      resolve(server);
    });
  });
}

// Allow direct execution: `node src/web/server.js`
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  startWebServer().catch(async (err) => {
    if (err?.code === 'EADDRINUSE') {
      try {
        const testRes = await fetch(`http://127.0.0.1:${config.webPort}/api/status`, {
          signal: AbortSignal.timeout(1500),
        });
        if (testRes.ok) {
          const data = await testRes.json();
          if (data?.ok) {
            console.log(`\n[Web UI] ℹ️ Archivist Fox Web UI is ALREADY running at http://localhost:${config.webPort}`);
            console.log(`[Web UI] 💡 It was launched automatically in the background by your running bot instance (ENABLE_WEB_UI=true).`);
            console.log(`[Web UI] You can open http://localhost:${config.webPort} directly in your browser without running run_web.bat.\n`);
            process.exit(0);
          }
        }
      } catch (err) {
    void err;
  }
    }
    process.exit(1);
  });
}
