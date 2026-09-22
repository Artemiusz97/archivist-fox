import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { initLinkDb, getDb } from '../linkDb.js';
import { ensureBinaries } from '../ensureBinaries.js';
import { downloadMediaItem } from '../downloaderCore.js';

// Cache for fast file resolution: filename -> fullPath
const fileLocationCache = new Map();

async function findArchivedFile(targetFile) {
  if (!targetFile) return null;
  const basename = path.basename(targetFile);

  // Check cache first
  if (fileLocationCache.has(basename)) {
    const cached = fileLocationCache.get(basename);
    if (fs.existsSync(cached)) return cached;
    fileLocationCache.delete(basename);
  }

  const archiveRoot = path.resolve(config.archiveDirectory);

  // 1. Direct path check
  const directPath = path.isAbsolute(targetFile) ? path.resolve(targetFile) : path.resolve(archiveRoot, targetFile);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    fileLocationCache.set(basename, directPath);
    return directPath;
  }

  // 2. Query database for channel subfolder (e.g. archiveRoot/channel/filename)
  try {
    const db = getDb();
    const row = db.prepare('SELECT channel, archived_at FROM media_records WHERE file_name = ? LIMIT 1').get(basename);
    if (row && row.channel) {
      const channelFolder = path.join(archiveRoot, row.channel, basename);
      if (fs.existsSync(channelFolder)) {
        fileLocationCache.set(basename, channelFolder);
        return channelFolder;
      }
      if (row.archived_at) {
        const dateStr = row.archived_at.slice(0, 7);
        const sub1 = path.join(archiveRoot, row.channel, dateStr, basename);
        if (fs.existsSync(sub1)) {
          fileLocationCache.set(basename, sub1);
          return sub1;
        }
        const sub2 = path.join(archiveRoot, dateStr, row.channel, basename);
        if (fs.existsSync(sub2)) {
          fileLocationCache.set(basename, sub2);
          return sub2;
        }
      }
    }
  } catch {}

  // 3. Recursive search in archiveRoot
  async function searchDir(dir) {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await searchDir(full);
          if (found) return found;
        } else if (entry.isFile() && entry.name === basename) {
          return full;
        }
      }
    } catch {}
    return null;
  }

  const found = await searchDir(archiveRoot);
  if (found) {
    fileLocationCache.set(basename, found);
  }
  return found;
}

async function openFolderOrFile(targetPath) {
  const archiveRoot = path.resolve(config.archiveDirectory);
  let resolved = targetPath ? (await findArchivedFile(targetPath)) : archiveRoot;

  if (!resolved || !fs.existsSync(resolved)) {
    resolved = archiveRoot;
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
  }

  if (process.platform === 'win32') {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('explorer.exe', [`/select,${resolved}`], { detached: true, stdio: 'ignore' }).unref();
    }
  } else if (process.platform === 'darwin') {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      spawn('open', [resolved], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('open', ['-R', resolved], { detached: true, stdio: 'ignore' }).unref();
    }
  } else {
    const stat = fs.statSync(resolved);
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

function broadcastTaskUpdate(taskId, update) {
  const task = tasks.get(taskId);
  if (!task) return;

  Object.assign(task, update);

  const listeners = sseSubscribers.get(taskId);
  if (listeners && listeners.size > 0) {
    const payload = `data: ${JSON.stringify(task)}\n\n`;
    for (const res of listeners) {
      try {
        res.write(payload);
      } catch {}
    }
  }
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
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function serveStaticFile(req, res, reqPath) {
  let relativePath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  // Sanitize path to prevent directory traversal
  const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
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

    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleDownloadFile(req, res, query) {
  const targetFile = query.get('file') || query.get('path');
  if (!targetFile) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing "file" query parameter');
    return;
  }

  const archiveRoot = path.resolve(config.archiveDirectory);
  const resolvedPath = await findArchivedFile(targetFile);

  // Security guard: Ensure file exists and is inside archiveDirectory or cwd
  if (!resolvedPath || (!resolvedPath.startsWith(archiveRoot) && !resolvedPath.startsWith(path.resolve(process.cwd())))) {
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

    // Support HTTP range requests for media streaming (video/audio seeking)
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });

      fs.createReadStream(resolvedPath, { start, end }).pipe(res);
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
      fs.createReadStream(resolvedPath).pipe(res);
    }
  });
}

function handleHistory(req, res, query) {
  try {
    const db = getDb();
    const limit = Math.min(100, Math.max(1, parseInt(query.get('limit') || '50', 10)));
    const offset = Math.max(0, parseInt(query.get('offset') || '0', 10));
    const searchQuery = query.get('q')?.trim();

    let rows;
    if (searchQuery) {
      const stmt = db.prepare(`
        SELECT id, media_id, sha256, duration, hash, original_url, title, posted_by, channel, archived_at, file_name
        FROM media_records
        WHERE title LIKE ? OR original_url LIKE ? OR file_name LIKE ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `);
      const term = `%${searchQuery}%`;
      rows = stmt.all(term, term, term, limit, offset);
    } else {
      const stmt = db.prepare(`
        SELECT id, media_id, sha256, duration, hash, original_url, title, posted_by, channel, archived_at, file_name
        FROM media_records
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `);
      rows = stmt.all(limit, offset);
    }

    sendJson(res, 200, { ok: true, records: rows });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleApiDownload(req, res) {
  try {
    const body = await parseJsonBody(req);
    const url = body.url?.trim();
    if (!url) {
      return sendJson(res, 400, { ok: false, error: 'URL is required' });
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

    // Limit in-memory tasks to last 100
    if (tasks.size > 100) {
      const oldestKey = tasks.keys().next().value;
      tasks.delete(oldestKey);
    }

    // Start background processing
    (async () => {
      try {
        const result = await downloadMediaItem(url, {
          audioOnly: task.audioOnly,
          force: task.force,
          saveToArchive: task.saveToArchive,
          author: 'WebUI',
          channel: 'web',
          onProgress: (prog) => {
            broadcastTaskUpdate(taskId, {
              stage: prog.stage,
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
      }
    })();

    sendJson(res, 202, { ok: true, taskId });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
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
    'Access-Control-Allow-Origin': '*',
  });

  if (!sseSubscribers.has(taskId)) {
    sseSubscribers.set(taskId, new Set());
  }
  sseSubscribers.get(taskId).add(res);

  // Send current state immediately
  res.write(`data: ${JSON.stringify(task)}\n\n`);

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
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
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
      sendJson(res, 200, { ok: true, tasks: Array.from(tasks.values()).slice(-20).reverse() });
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
      try {
        const body = await parseJsonBody(req);
        const opened = await openFolderOrFile(body.path);
        sendJson(res, 200, { ok: true, openedPath: opened });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, {
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
  startWebServer().catch(() => {
    process.exit(1);
  });
}
