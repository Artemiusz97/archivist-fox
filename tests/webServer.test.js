import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { initLinkDb, closeLinkDb } from '../src/linkDb.js';
import { createWebServer } from '../src/web/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Web Server Security, Range Streaming & SSE (clean-room verification)', () => {
  let server = null;
  let port = 0;
  let baseUrl = '';
  let tempArchiveDir = '';
  let siblingDir = '';
  let originalConfig = {};

  before(async () => {
    originalConfig = {
      archiveDirectory: config.archiveDirectory,
      enableWebUi: config.enableWebUi,
      webHost: config.webHost,
      webAuthToken: config.webAuthToken,
      maxConcurrentDownloads: config.maxConcurrentDownloads,
    };

    tempArchiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-test-archive-'));
    siblingDir = `${tempArchiveDir}_sibling`;
    fs.mkdirSync(siblingDir, { recursive: true });

    // Populate sample archive file: 100 bytes of ASCII characters
    fs.writeFileSync(path.join(tempArchiveDir, 'sample.mp4'), Buffer.alloc(100, 0x41)); // 'A'
    fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'PRIVATE_LEAK');

    config.archiveDirectory = tempArchiveDir;
    config.enableWebUi = true;
    config.webHost = '127.0.0.1';
    config.webAuthToken = '';

    closeLinkDb();
    initLinkDb(':memory:');

    server = createWebServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeLinkDb();
    Object.assign(config, originalConfig);
    fs.rmSync(tempArchiveDir, { recursive: true, force: true });
    fs.rmSync(siblingDir, { recursive: true, force: true });
  });

  describe('GET /api/file Path Traversal & Security Containment', () => {
    it('returns 404 on attempt to read .env file', async () => {
      const res = await fetch(`${baseUrl}/api/file?file=.env`);
      assert.strictEqual(res.status, 404);
    });

    it('returns 404 on directory traversal via ..', async () => {
      const res = await fetch(`${baseUrl}/api/file?file=../package.json`);
      assert.strictEqual(res.status, 404);
    });

    it('returns 404 on sibling-prefix directory escape (e.g., archives_sibling)', async () => {
      const secretPath = path.join(siblingDir, 'secret.txt');
      const res = await fetch(`${baseUrl}/api/file?file=${encodeURIComponent(secretPath)}`);
      assert.strictEqual(res.status, 404);
    });
  });

  describe('GET /api/file Range Requests (RFC 7233)', () => {
    it('serves full file with HTTP 200 when Range header is absent', async () => {
      const res = await fetch(`${baseUrl}/api/file?file=sample.mp4`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-length'), '100');
      const text = await res.text();
      assert.strictEqual(text.length, 100);
    });

    it('serves partial content with HTTP 206 for valid byte range', async () => {
      const res = await fetch(`${baseUrl}/api/file?file=sample.mp4`, {
        headers: { Range: 'bytes=0-3' },
      });
      assert.strictEqual(res.status, 206);
      assert.strictEqual(res.headers.get('content-range'), 'bytes 0-3/100');
      assert.strictEqual(res.headers.get('content-length'), '4');
      const text = await res.text();
      assert.strictEqual(text.length, 4);
    });

    it('returns HTTP 416 Range Not Satisfiable when range start is beyond file size', async () => {
      const res = await fetch(`${baseUrl}/api/file?file=sample.mp4`, {
        headers: { Range: 'bytes=999999-' },
      });
      assert.strictEqual(res.status, 416);
      assert.ok(res.headers.get('content-range')?.includes('*/100'));
    });
  });

  describe('POST /api/open-folder Host Containment', () => {
    it('rejects paths outside archive directory with HTTP 403', async () => {
      const res = await fetch(`${baseUrl}/api/open-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'C:\\Windows\\System32\\calc.exe' }),
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json().catch(() => ({}));
      assert.strictEqual(data.ok, false);
    });
  });

  describe('SSE /api/progress/:taskId Connection Teardown', () => {
    it('closes event stream upon terminal task stage (completed / error)', async () => {
      // Use a private-IP URL that fails fast via SSRF guard without touching external network
      const postRes = await fetch(`${baseUrl}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1:9/mock-video.mp4' }),
      });

      const { taskId } = await postRes.json();
      assert.ok(taskId, 'Must return taskId');

      const sseRes = await fetch(`${baseUrl}/api/progress/${taskId}`);
      assert.strictEqual(sseRes.status, 200);
      assert.strictEqual(sseRes.headers.get('content-type'), 'text/event-stream');

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let streamFinished = false;
      let combinedPayload = '';

      const timeoutId = setTimeout(() => reader.cancel(), 5000);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            streamFinished = true;
            break;
          }
          combinedPayload += decoder.decode(value);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      assert.strictEqual(streamFinished, true, 'SSE stream must close cleanly when task finishes');
      assert.ok(
        combinedPayload.includes('"completed"') || combinedPayload.includes('"error"'),
        'SSE stream must emit terminal stage before closing'
      );
    });
  });

  describe('WEB_AUTH_TOKEN Enforcement & Frontend Bundle Security', () => {
    it('blocks unauthorized /api/* requests with 401 and accepts X-Auth-Token header or ?token= query param', async () => {
      config.webAuthToken = 'cleanroom-secret-token';
      try {
        // 1. Missing token -> 401
        const unauthStatus = await fetch(`${baseUrl}/api/status`);
        assert.strictEqual(unauthStatus.status, 401);

        // 2. Wrong token -> 401
        const wrongToken = await fetch(`${baseUrl}/api/history`, {
          headers: { 'X-Auth-Token': 'wrong-token' },
        });
        assert.strictEqual(wrongToken.status, 401);

        // 3. Valid X-Auth-Token header -> 200
        const okHeader = await fetch(`${baseUrl}/api/status`, {
          headers: { 'X-Auth-Token': 'cleanroom-secret-token' },
        });
        assert.strictEqual(okHeader.status, 200);

        // 4. Valid ?token= query param on /api/file -> 200 (for <video>/<img>/<a> tags)
        const unauthFile = await fetch(`${baseUrl}/api/file?file=sample.mp4`);
        assert.strictEqual(unauthFile.status, 401);

        const okFile = await fetch(
          `${baseUrl}/api/file?file=sample.mp4&token=cleanroom-secret-token`
        );
        assert.strictEqual(okFile.status, 200);
        assert.strictEqual((await okFile.text()).length, 100);

        // 5. Valid ?token= query param on SSE /api/progress/:taskId
        const dlRes = await fetch(`${baseUrl}/api/download`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': 'cleanroom-secret-token',
          },
          body: JSON.stringify({ url: 'http://127.0.0.1:9/auth-sse.mp4' }),
        });
        assert.strictEqual(dlRes.status, 202);
        const { taskId } = await dlRes.json();

        const unauthSse = await fetch(`${baseUrl}/api/progress/${taskId}`);
        assert.strictEqual(unauthSse.status, 401);

        const okSse = await fetch(
          `${baseUrl}/api/progress/${taskId}?token=cleanroom-secret-token`
        );
        assert.strictEqual(okSse.status, 200);
        await okSse.body?.cancel().catch(() => {});
      } finally {
        config.webAuthToken = '';
      }
    });

    it('contains zero inline onclick= handlers and wires X-Auth-Token in Web UI frontend', () => {
      const publicDir = path.resolve(__dirname, '../src/web/public');
      const appJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf-8');
      const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');

      assert.strictEqual(
        /onclick\s*=/i.test(appJs),
        false,
        'app.js must not inject inline onclick= HTML attributes'
      );
      assert.strictEqual(
        /onclick\s*=/i.test(indexHtml),
        false,
        'index.html must not contain inline onclick= attributes'
      );
      assert.ok(appJs.includes('X-Auth-Token'), 'app.js must attach X-Auth-Token header');
      assert.ok(appJs.includes('buildAuthorizedUrl'), 'app.js must authorize media/SSE URLs');
    });
  });
});
