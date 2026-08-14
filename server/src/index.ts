/**
 * Whale Watch LHR — the HTTP server.
 *
 * `node:http` and nothing else. One shared tracker fans out to unlimited browsers:
 *
 *   GET /api/snapshot            the whole world, as JSON
 *   GET /api/spots               spotting locations ranked for right now
 *   GET /api/movements?hours=24  the movement log
 *   GET /api/aircraft/:hex       one airframe, with trail and history
 *   GET /api/health              liveness + feed health
 *   GET /api/stream              SSE: a snapshot on connect, then every update
 *   GET /*                       the built client (client/dist), SPA fallback
 *
 * Everything is gzipped when the client asks for it (snapshots are large), nothing is cached
 * except hashed assets, and the static handler cannot be walked out of its root. When the client
 * has not been built the API still works and `/` explains how to build it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

import type { Snapshot } from '../../shared/types.ts';
import { SSE_EVENT_PING, SSE_EVENT_SNAPSHOT } from '../../shared/types.ts';
import { CONFIG } from './config.ts';
import { createLogger } from './log.ts';
import { createTracker } from './tracker.ts';

const log = createLogger('http');
const gzipAsync = promisify(gzip);

/** Below this, compression costs more than it saves. */
const GZIP_MIN_BYTES = 1024;

/** SSE keepalive cadence — comfortably inside every proxy idle timeout. */
const SSE_KEEPALIVE_MS = 25_000;

/** Generous cap; the memory cost of an idle SSE client is a socket and a closure. */
const SSE_MAX_CLIENTS = 5000;

/** Static assets whose name carries a content hash may be cached forever. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=3600';
const NO_CACHE = 'no-cache, no-store, must-revalidate';

const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
]);

/** Text-ish payloads are worth gzipping; images and fonts are already compressed. */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|manifest\+json|javascript)|image\/svg\+xml)/;

const CLIENT_MISSING_HINT = [
  'Whale Watch LHR — the API is running, the client is not built.',
  '',
  `Expected the built client at: ${CONFIG.clientDistDir}`,
  '',
  'Build it with:  npm run build',
  'Or develop with: npm run dev   (Vite on :5173, proxying /api here)',
  '',
  'The API is live regardless:',
  '  /api/snapshot   /api/spots   /api/movements   /api/aircraft/:hex   /api/health   /api/stream',
  '',
].join('\n');

/* ------------------------------------------------------------------ *
 * Response helpers
 * ------------------------------------------------------------------ */

function acceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers['accept-encoding'];
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  return /\bgzip\b/i.test(value);
}

interface SendOptions {
  status?: number;
  contentType: string;
  cacheControl: string;
  etag?: string;
  extraHeaders?: Record<string, string>;
}

/** The single exit point for every non-SSE response: gzip, headers, HEAD handling. */
async function send(req: IncomingMessage, res: ServerResponse, body: Buffer, options: SendOptions): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': options.contentType,
    'cache-control': options.cacheControl,
    vary: 'Accept-Encoding',
    'x-content-type-options': 'nosniff',
    ...options.extraHeaders,
  };
  if (options.etag !== undefined) headers['etag'] = options.etag;

  let payload = body;
  if (
    acceptsGzip(req) &&
    body.length >= GZIP_MIN_BYTES &&
    COMPRESSIBLE.test(options.contentType) &&
    req.method !== 'HEAD'
  ) {
    try {
      payload = await gzipAsync(body);
      headers['content-encoding'] = 'gzip';
    } catch (err) {
      log.warn('gzip failed, sending plain:', err);
      payload = body;
    }
  }

  headers['content-length'] = String(payload.length);
  res.writeHead(options.status ?? 200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(payload);
}

async function sendJson(req: IncomingMessage, res: ServerResponse, value: unknown, status = 200): Promise<void> {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  await send(req, res, body, {
    status,
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'no-store',
  });
}

async function sendText(
  req: IncomingMessage,
  res: ServerResponse,
  text: string,
  status = 200,
  cacheControl = NO_CACHE,
): Promise<void> {
  await send(req, res, Buffer.from(text, 'utf8'), {
    status,
    contentType: 'text/plain; charset=utf-8',
    cacheControl,
  });
}

function sendError(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
  void sendJson(req, res, { error: message, status }, status).catch((err: unknown) => {
    log.error('failed to send error response:', err);
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(message);
  });
}

/* ------------------------------------------------------------------ *
 * Static files
 * ------------------------------------------------------------------ */

const DIST_ROOT = resolve(CONFIG.clientDistDir);

function contentTypeFor(path: string): string {
  return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream';
}

function cacheControlFor(urlPath: string, filePath: string): string {
  if (extname(filePath).toLowerCase() === '.html') return NO_CACHE;
  if (urlPath.startsWith('/assets/') || HASHED_ASSET.test(filePath)) return IMMUTABLE_CACHE;
  return SHORT_CACHE;
}

/**
 * Resolve a URL path inside the dist root, or null when it escapes it. `normalize` collapses
 * `..` segments and the prefix check rejects anything that still points outside — belt and braces,
 * because a traversal here would serve the whole filesystem.
 */
function resolveStatic(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const normalised = normalize(decoded).replace(/^([/\\])+/, '');
  if (normalised === '' || normalised === '.') return join(DIST_ROOT, 'index.html');

  const full = resolve(DIST_ROOT, normalised);
  if (full !== DIST_ROOT && !full.startsWith(DIST_ROOT + sep)) return null;
  return full;
}

interface StaticFile {
  path: string;
  body: Buffer;
  etag: string;
}

async function readStatic(path: string): Promise<StaticFile | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const body = await readFile(path);
    return { path, body, etag: `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"` };
  } catch {
    return null;
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
  const target = resolveStatic(urlPath);
  if (target === null) {
    await sendText(req, res, 'Forbidden', 403);
    return;
  }

  const found = await readStatic(target);
  let file: StaticFile;
  let servedPath = urlPath;

  if (found === null) {
    // SPA fallback: any path the client router owns resolves to index.html.
    const index = await readStatic(join(DIST_ROOT, 'index.html'));
    if (index === null) {
      if (urlPath === '/' || urlPath === '') {
        await sendText(req, res, CLIENT_MISSING_HINT, 200);
      } else {
        await sendText(req, res, 'Not found', 404);
      }
      return;
    }
    file = index;
    servedPath = '/index.html';
  } else {
    file = found;
  }

  const etag = file.etag;
  const ifNoneMatch = req.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    res.writeHead(304, { etag, 'cache-control': cacheControlFor(servedPath, file.path) });
    res.end();
    return;
  }

  await send(req, res, file.body, {
    contentType: contentTypeFor(file.path),
    cacheControl: cacheControlFor(servedPath, file.path),
    etag,
  });
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const tracker = createTracker();

interface SseClient {
  res: ServerResponse;
  keepalive: NodeJS.Timeout;
  unsubscribe: () => void;
}

const sseClients = new Set<SseClient>();

function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function closeSseClient(client: SseClient): void {
  if (!sseClients.delete(client)) return;
  clearInterval(client.keepalive);
  try {
    client.unsubscribe();
  } catch (err) {
    log.error('SSE unsubscribe failed:', err);
  }
  try {
    client.res.end();
  } catch {
    // The socket is already gone; nothing to do.
  }
}

function handleStream(req: IncomingMessage, res: ServerResponse): void {
  if (sseClients.size >= SSE_MAX_CLIENTS) {
    res.writeHead(503, {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': '30',
      'cache-control': 'no-store',
    });
    res.end('Too many streaming clients — retry shortly, or poll /api/snapshot.');
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'transfer-encoding': 'chunked',
  });
  // Get the headers on the wire before anything else, so the browser opens the stream at once.
  res.flushHeaders();
  res.write(`retry: 5000\n\n`);

  // Nagle would hold small SSE frames back for tens of milliseconds.
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  // A stream is idle by design; never let the server time it out.
  res.setTimeout(0);

  const write = (chunk: string): boolean => {
    try {
      return res.write(chunk);
    } catch {
      return false;
    }
  };

  const client: SseClient = {
    res,
    keepalive: setInterval(() => {
      // A comment line keeps proxies honest; the named event lets the client see liveness.
      if (!write(`: keepalive\n${sseFrame(SSE_EVENT_PING, { t: Date.now() })}`)) closeSseClient(client);
    }, SSE_KEEPALIVE_MS),
    unsubscribe: () => {
      /* replaced immediately below */
    },
  };
  client.keepalive.unref();

  const onSnapshot = (snapshot: Snapshot): void => {
    if (!write(sseFrame(SSE_EVENT_SNAPSHOT, snapshot))) closeSseClient(client);
  };

  client.unsubscribe = tracker.subscribe(onSnapshot);
  sseClients.add(client);

  // The current state goes out immediately — the UI must never show a spinner.
  write(sseFrame(SSE_EVENT_SNAPSHOT, tracker.snapshot()));

  const cleanup = (): void => closeSseClient(client);
  res.on('close', cleanup);
  res.on('error', cleanup);
  req.on('close', cleanup);
  req.on('error', cleanup);

  log.debug(`SSE client connected (${sseClients.size} open)`);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;

  if (path === '/api/snapshot') {
    await sendJson(req, res, tracker.snapshot());
    return true;
  }

  if (path === '/api/spots') {
    await sendJson(req, res, tracker.spots());
    return true;
  }

  if (path === '/api/movements') {
    const raw = url.searchParams.get('hours');
    const parsed = raw === null ? 24 : Number.parseFloat(raw);
    const hours = Number.isFinite(parsed) ? Math.min(CONFIG.logWindowHours, Math.max(0, parsed)) : 24;
    // The snapshot already carries the log window, newest first; narrow it to what was asked for
    // rather than opening a second reader onto the same file.
    const cutoff = Date.now() - hours * 3_600_000;
    await sendJson(
      req,
      res,
      tracker.snapshot().log.filter((entry) => entry.at >= cutoff),
    );
    return true;
  }

  if (path === '/api/health') {
    const health = tracker.snapshot().health;
    // Always 200: `ok` carries the truth, and a monitor that reads the body gets the detail. A
    // cold start is not an outage.
    await sendJson(req, res, { ok: !health.stale, ...health });
    return true;
  }

  if (path.startsWith('/api/aircraft/')) {
    const raw = path.slice('/api/aircraft/'.length);
    let hex = raw;
    try {
      hex = decodeURIComponent(raw);
    } catch {
      hex = raw; // Malformed escapes are simply not a hex code; the lookup below says 404.
    }
    const detail = hex.length === 0 ? null : tracker.aircraftDetail(hex);
    if (detail === null) {
      await sendJson(req, res, { error: 'Unknown aircraft', hex }, 404);
      return true;
    }
    await sendJson(req, res, detail);
    return true;
  }

  return false;
}

const server = createServer((req, res) => {
  const started = Date.now();
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';

  let url: URL;
  try {
    url = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    sendError(req, res, 400, 'Bad request URL');
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  res.on('finish', () => {
    log.debug(`${method} ${url.pathname} → ${res.statusCode} in ${Date.now() - started}ms`);
  });

  if (url.pathname === '/api/stream') {
    if (method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' });
      res.end();
      return;
    }
    try {
      handleStream(req, res);
    } catch (err) {
      log.error('SSE setup failed:', err);
      if (!res.headersSent) sendError(req, res, 500, 'Stream unavailable');
      else res.end();
    }
    return;
  }

  const work = url.pathname.startsWith('/api/')
    ? handleApi(req, res, url).then(async (handled) => {
        if (!handled) await sendJson(req, res, { error: 'Unknown endpoint', path: url.pathname }, 404);
      })
    : serveStatic(req, res, url.pathname);

  work.catch((err: unknown) => {
    log.error(`${method} ${url.pathname} failed:`, err);
    if (!res.headersSent) sendError(req, res, 500, 'Internal error');
    else res.end();
  });
});

// Long-polling browsers and SSE clients must not be cut off by the default socket timeouts.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
  log.debug(`client error: ${err.message}`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`port ${CONFIG.port} is already in use — set PORT to something else`);
  } else {
    log.error('server error:', err);
  }
  process.exitCode = 1;
  shutdown('server error');
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

let shuttingDown = false;

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down (${reason})…`);

  tracker.stop();
  for (const client of [...sseClients]) closeSseClient(client);

  // A shutdown triggered by a failed `listen` (EADDRINUSE) has nothing to close, and asking
  // anyway only logs a second, misleading error on top of the real one.
  if (server.listening) {
    server.close((err?: Error) => {
      if (err !== undefined && err !== null) log.error('error while closing server:', err);
      else log.info('closed cleanly');
    });
    server.closeIdleConnections();
  }

  // Nothing may hold the process open for more than a couple of seconds.
  const force = setTimeout(() => {
    log.warn('forcing exit');
    process.exit();
  }, 2_500);
  force.unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log.error('uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection:', reason);
});

tracker.start();

server.listen(CONFIG.port, CONFIG.host, () => {
  const shown = CONFIG.host === '0.0.0.0' || CONFIG.host === '::' ? 'localhost' : CONFIG.host;
  log.info(`Whale Watch LHR listening on http://${shown}:${CONFIG.port}`);
  log.info(`serving client from ${CONFIG.clientDistDir}`);
});
