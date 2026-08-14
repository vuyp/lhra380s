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

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

import type { Snapshot } from '../../shared/types.ts';
import { SSE_EVENT_PING, SSE_EVENT_SNAPSHOT } from '../../shared/types.ts';
import { CONFIG } from './config.ts';
import { createLogger } from './log.ts';
import { createTracker } from './tracker.ts';
import { stopUpstream, upstreamHealth } from './upstream.ts';

const log = createLogger('http');
const gzipAsync = promisify(gzip);

/** Below this, compression costs more than it saves. */
const GZIP_MIN_BYTES = 1024;

/** SSE keepalive cadence — comfortably inside every proxy idle timeout. */
const SSE_KEEPALIVE_MS = 25_000;

/** Generous cap; the memory cost of an idle SSE client is a socket and a closure. */
const SSE_MAX_CLIENTS = 5000;

/**
 * A client whose socket has not accepted a byte for this long is not a slow client, it is a dead
 * one holding a buffer. Dropping it is the only way memory stays bounded; the browser reconnects
 * on its own five seconds later.
 */
const SSE_STALL_LIMIT_MS = 120_000;

/**
 * Hard ceiling on the bytes Node may hold for one client. Coalescing keeps at most one frame
 * queued, but the frame already handed to the socket is buffered in full, so per-client memory
 * would otherwise scale with snapshot size. Past this the client is not reading and is dropped.
 */
const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

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

/**
 * The one inline script the app ships — the pre-paint theme switch in client/index.html, which
 * has to run before first paint or the page flashes the wrong scheme. It is allowed by hash
 * rather than by `'unsafe-inline'`, and the hash is taken from the built file itself so it can
 * never drift out of date. Anything else inline is blocked, which is the point.
 */
function inlineScriptHashes(): string[] {
  try {
    // `resolve` rather than DIST_ROOT: this runs while the module is still being evaluated.
    const html = readFileSync(join(resolve(CONFIG.clientDistDir), 'index.html'), 'utf8');
    const hashes: string[] = [];
    for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attributes = match[1] ?? '';
      const body = match[2] ?? '';
      if (/\bsrc\s*=/i.test(attributes)) continue;
      const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase();
      if (type !== undefined && type !== 'module' && type !== 'text/javascript') continue;
      if (body.trim() === '') continue;
      hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    }
    return hashes;
  } catch {
    // No bundle yet (`npm start` before `npm run build`): the API still works and there is no
    // HTML to protect.
    return [];
  }
}

/**
 * What this app is allowed to talk to, stated to the browser rather than merely observed to be
 * true. It serves its own JS, CSS and fonts, calls only its own origin for data (`connect-src`
 * covers the SSE stream), and takes map tiles from CARTO's keyless basemap CDN. Nothing else,
 * and no page may frame it.
 *
 * `style-src 'unsafe-inline'` is required and narrow: Leaflet writes inline styles onto every
 * pane and marker it positions, and the app sets its own CSS custom properties (airline accent
 * colours, marker transforms) through the `style` attribute. `script-src` carries no such
 * allowance — only the hash of the app's own pre-paint theme script.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  ["script-src 'self'", ...inlineScriptHashes()].join(' '),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.basemaps.cartocdn.com",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

/** Sent with every response. */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': CSP,
  'referrer-policy': 'no-referrer',
};

/** The single exit point for every non-SSE response: gzip, headers, HEAD handling. */
async function send(req: IncomingMessage, res: ServerResponse, body: Buffer, options: SendOptions): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': options.contentType,
    'cache-control': options.cacheControl,
    vary: 'Accept-Encoding',
    ...SECURITY_HEADERS,
    ...options.extraHeaders,
  };
  if (options.etag !== undefined) headers['etag'] = options.etag;

  let payload = body;
  // HEAD is compressed too, discarded body and all: its headers must describe the response a GET
  // would produce, and a content-length measured on the uncompressed body would be a lie.
  if (acceptsGzip(req) && body.length >= GZIP_MIN_BYTES && COMPRESSIBLE.test(options.contentType)) {
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

/**
 * The same root with every symlink in it already resolved. Every file we are willing to serve must
 * live under this path *after* its own symlinks are resolved, which is the only check that stops a
 * link inside the bundle from pointing at /etc/passwd. `resolve()` alone is purely lexical and
 * cannot see a symlink at all.
 */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Falls back to the lexical root until the bundle exists — `npm start` may precede `npm run build`. */
let distRealRoot: string = realpathOrNull(DIST_ROOT) ?? DIST_ROOT;

function insideDistRoot(path: string): boolean {
  if (path === distRealRoot || path.startsWith(distRealRoot + sep)) return true;
  // The bundle may have appeared (or moved behind a symlink) since boot; resolve once more before
  // calling it an escape.
  const resolved = realpathOrNull(DIST_ROOT);
  if (resolved === null || resolved === distRealRoot) return false;
  distRealRoot = resolved;
  return path === distRealRoot || path.startsWith(distRealRoot + sep);
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream';
}

function cacheControlFor(urlPath: string, filePath: string): string {
  if (extname(filePath).toLowerCase() === '.html') return NO_CACHE;
  // The service worker decides what every other request does, so a stale copy of it is a stale
  // copy of the whole app. Browsers already refuse to cache it for long; intermediaries do not.
  if (urlPath === '/sw.js') return NO_CACHE;
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

type StaticLookup =
  | { kind: 'file'; file: StaticFile }
  | { kind: 'missing' }
  /** The path exists but resolves outside the bundle — a symlink pointing off the root. */
  | { kind: 'escaped' };

async function readStatic(path: string): Promise<StaticLookup> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return { kind: 'missing' };
  }
  if (!insideDistRoot(real)) return { kind: 'escaped' };

  try {
    const info = await stat(real);
    if (!info.isFile()) return { kind: 'missing' };
    const body = await readFile(real);
    return {
      kind: 'file',
      file: { path: real, body, etag: `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"` },
    };
  } catch {
    return { kind: 'missing' };
  }
}

/**
 * Whether a miss should fall through to index.html. The client is a hash-routed single page, so
 * only a document request can legitimately want it. Handing index.html to a request for a missing
 * `/sw.js` or `/assets/app-x.js` would answer a script with HTML, which the browser reports as a
 * MIME type error rather than as the 404 it is.
 */
function wantsSpaFallback(req: IncomingMessage, urlPath: string): boolean {
  const extension = extname(urlPath).toLowerCase();
  if (extension !== '' && extension !== '.html') return false;
  const accept = req.headers.accept;
  const header = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  // No Accept header at all (curl, a health check) is treated as a document request.
  return header === '' || header.includes('text/html') || header.includes('*/*');
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
  const target = resolveStatic(urlPath);
  if (target === null) {
    await sendText(req, res, 'Forbidden', 403);
    return;
  }

  const found = await readStatic(target);
  if (found.kind === 'escaped') {
    log.warn(`refusing ${urlPath}: it resolves outside ${distRealRoot}`);
    await sendText(req, res, 'Forbidden', 403);
    return;
  }

  let file: StaticFile;
  let servedPath = urlPath;

  if (found.kind === 'missing') {
    const index = wantsSpaFallback(req, urlPath) ? await readStatic(join(DIST_ROOT, 'index.html')) : null;
    if (index === null || index.kind !== 'file') {
      if (urlPath === '/' || urlPath === '') {
        await sendText(req, res, CLIENT_MISSING_HINT, 200);
      } else {
        await sendText(req, res, 'Not found', 404);
      }
      return;
    }
    file = index.file;
    servedPath = '/index.html';
  } else {
    file = found.file;
  }

  const etag = file.etag;
  const ifNoneMatch = req.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    res.writeHead(304, {
      etag,
      'cache-control': cacheControlFor(servedPath, file.path),
      ...SECURITY_HEADERS,
    });
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

/**
 * One connected browser.
 *
 * A frame is written straight to the socket unless that socket is still draining the last one, in
 * which case the newest frame replaces whatever was queued: a client that cannot keep up wants the
 * current state, not a backlog of stale ones. That keeps the memory held for a stalled client at
 * one reference to a string every other client is holding too, however long it stalls.
 */
interface SseClient {
  res: ServerResponse;
  /** Newest frame not yet handed to the socket, or null when the socket is keeping up. */
  pending: string | null;
  /** True between a `write()` that returned false and the socket's `drain`. */
  draining: boolean;
  /** Epoch ms the socket last accepted a write. Drives the keepalive and the stall watchdog. */
  lastProgressAt: number;
}

const sseClients = new Set<SseClient>();

/** Active tracker subscriptions owned by this module — proof that listeners do not accumulate. */
let snapshotSubscriptions = 0;

function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function closeSseClient(client: SseClient): void {
  if (!sseClients.delete(client)) return;
  client.pending = null;
  const stuck = client.draining;
  try {
    client.res.end();
    // A client dropped for backpressure has megabytes queued behind it and is not reading any of
    // them; `end()` alone would wait on a socket that will never drain. A client that was keeping
    // up gets the ordinary close, so its last frame still lands.
    if (stuck) client.res.socket?.destroy();
  } catch {
    // The socket is already gone; nothing to do.
  }
}

/** Bytes Node is holding for this client: queued in the response plus queued in the socket. */
function bufferedBytes(client: SseClient): number {
  const socket = client.res.socket;
  return client.res.writableLength + (socket === null ? 0 : socket.writableLength);
}

/**
 * Hand a frame to one client. Never throws, never blocks, and never grows without bound: at most
 * one frame is queued per client, and that frame is the same string every other client is holding.
 */
function writeToClient(client: SseClient, frame: string): void {
  const { res } = client;
  if (res.writableEnded || res.destroyed) {
    closeSseClient(client);
    return;
  }

  if (client.draining) {
    // Coalesce: the newest snapshot supersedes anything still queued.
    client.pending = frame;
    const stalledFor = Date.now() - client.lastProgressAt;
    if (stalledFor > SSE_STALL_LIMIT_MS || bufferedBytes(client) > SSE_MAX_BUFFERED_BYTES) {
      log.debug(`dropping a stalled SSE client (${Math.round(stalledFor / 1000)}s, ${bufferedBytes(client)} bytes)`);
      closeSseClient(client);
    }
    return;
  }

  let accepted: boolean;
  try {
    accepted = res.write(frame);
  } catch {
    closeSseClient(client);
    return;
  }

  if (accepted) {
    client.lastProgressAt = Date.now();
    return;
  }

  // Backpressure is normal on a phone with one bar — it is not a reason to hang up. Wait for the
  // socket to drain and send whatever is current by then.
  client.draining = true;
  res.once('drain', () => {
    client.draining = false;
    client.lastProgressAt = Date.now();
    const queued = client.pending;
    client.pending = null;
    if (queued !== null && sseClients.has(client)) writeToClient(client, queued);
  });
}

/**
 * Fan one snapshot out to every client. The JSON is built once per snapshot, not once per client,
 * so the cost of a thousand spotters watching is a thousand socket writes of the same string.
 */
function broadcast(snapshot: Snapshot): void {
  if (sseClients.size === 0) return;
  const frame = sseFrame(SSE_EVENT_SNAPSHOT, snapshot);
  for (const client of [...sseClients]) writeToClient(client, frame);
}

const unsubscribeBroadcast = tracker.subscribe(broadcast);
snapshotSubscriptions += 1;

/**
 * One timer for the whole process rather than one per client. Clients that have just been sent a
 * snapshot need nothing; only a genuinely idle connection gets a keepalive.
 */
// The sweep runs twice as often as the keepalive period so a connection is never idle for more
// than one and a half periods — a single interval at the full period would let it reach two.
const keepaliveTimer = setInterval(() => {
  if (sseClients.size === 0) return;
  const now = Date.now();
  const frame = `: keepalive\n${sseFrame(SSE_EVENT_PING, { t: now })}`;
  for (const client of [...sseClients]) {
    if (now - client.lastProgressAt < SSE_KEEPALIVE_MS) continue;
    writeToClient(client, frame);
  }
}, Math.round(SSE_KEEPALIVE_MS / 2));
keepaliveTimer.unref();

function handleStream(req: IncomingMessage, res: ServerResponse): void {
  if (sseClients.size >= SSE_MAX_CLIENTS) {
    res.writeHead(503, {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': '30',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
    });
    res.end('Too many streaming clients — retry shortly, or poll /api/snapshot.');
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...SECURITY_HEADERS,
  });
  // Get the headers on the wire before anything else, so the browser opens the stream at once.
  res.flushHeaders();

  // Nagle would hold small SSE frames back for tens of milliseconds.
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  // A stream is idle by design; never let the server time it out.
  res.setTimeout(0);

  const client: SseClient = {
    res,
    pending: null,
    draining: false,
    lastProgressAt: Date.now(),
  };
  sseClients.add(client);

  const cleanup = (): void => closeSseClient(client);
  res.on('close', cleanup);
  res.on('error', cleanup);
  req.on('close', cleanup);
  req.on('error', cleanup);

  // The current state goes out immediately — the UI must never show a spinner.
  writeToClient(client, `retry: 5000\n\n${sseFrame(SSE_EVENT_SNAPSHOT, tracker.snapshot())}`);

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
    // The tracker bounds this itself; asking for more than it will serve is not an error, and a
    // window wider than the snapshot's is exactly what the client's "load earlier" is for.
    await sendJson(req, res, tracker.movements(Number.isFinite(parsed) ? Math.max(0, parsed) : 24));
    return true;
  }

  if (path === '/api/health') {
    const health = tracker.snapshot().health;
    const memory = process.memoryUsage();
    // Always 200: `ok` carries the truth, and a monitor that reads the body gets the detail. A
    // cold start is not an outage. The diagnostics below exist so an operator can tell a slow
    // upstream from a leaking process without attaching a debugger to a live server.
    await sendJson(req, res, {
      ok: !health.stale,
      ...health,
      upstream: upstreamHealth(),
      server: {
        sseClients: sseClients.size,
        snapshotSubscriptions,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        pid: process.pid,
      },
    });
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
    res.writeHead(405, {
      allow: 'GET, HEAD',
      'content-type': 'text/plain; charset=utf-8',
      ...SECURITY_HEADERS,
    });
    res.end('Method not allowed');
    return;
  }

  res.on('finish', () => {
    log.debug(`${method} ${url.pathname} → ${res.statusCode} in ${Date.now() - started}ms`);
  });

  if (url.pathname === '/api/stream') {
    if (method === 'HEAD') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        ...SECURITY_HEADERS,
      });
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

  // `/api` with no trailing slash is an API request too: it must get the JSON 404 the client's
  // fetch layer can read, never the SPA shell.
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');

  const work = isApi
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

  clearInterval(keepaliveTimer);
  try {
    unsubscribeBroadcast();
    snapshotSubscriptions = Math.max(0, snapshotSubscriptions - 1);
  } catch (err) {
    log.error('failed to unsubscribe from the tracker:', err);
  }
  tracker.stop();
  // Anything still in flight upstream would otherwise hold the event loop open for its full
  // timeout after every socket here has already been closed.
  stopUpstream();
  for (const client of [...sseClients]) closeSseClient(client);

  // A shutdown triggered by a failed `listen` (EADDRINUSE) has nothing to close, and asking
  // anyway only logs a second, misleading error on top of the real one.
  if (server.listening) {
    server.close((err?: Error) => {
      if (err !== undefined && err !== null) log.error('error while closing server:', err);
      else log.info('closed cleanly');
    });
    server.closeIdleConnections();

    // `close()` only stops new connections; a client that walked away mid-request — a phone that
    // lost signal, a browser that abandoned a stream without a FIN — holds its socket, and with it
    // the event loop, indefinitely. Give responses a moment to flush, then take the rest down.
    const grace = setTimeout(() => {
      server.closeAllConnections();
    }, 250);
    grace.unref();
  }

  // Nothing may hold the process open for more than a couple of seconds. If something does, say
  // what it was — a supervisor restarting a hung process deserves better than silence.
  const force = setTimeout(() => {
    log.warn(`forcing exit; still active: ${process.getActiveResourcesInfo().join(', ') || 'nothing'}`);
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
