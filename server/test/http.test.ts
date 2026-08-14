/**
 * End-to-end tests for the HTTP surface, run against a real server process.
 *
 * Everything here is a thing that can only be got wrong at the edges: a symlink in the bundle
 * pointing at /etc/passwd, an /api typo answered with the SPA shell instead of a JSON 404, a
 * gzipped event stream that no browser can read, a SIGTERM that leaves the process alive.
 *
 * The child is pointed at a dead upstream port so the suite is hermetic and offline: the feed is
 * simply unavailable, which is itself one of the states worth asserting.
 */

import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const here = fileURLToPath(new URL('.', import.meta.url));
const entry = join(here, '..', 'src', 'index.ts');

const workDir = mkdtempSync(join(tmpdir(), 'whale-http-'));
const distDir = join(workDir, 'dist');
const runtimeDir = join(workDir, 'runtime');
mkdirSync(join(distDir, 'assets'), { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>Whale Watch LHR</title><body>app</body>', 'utf8');
writeFileSync(join(distDir, 'assets', 'app-A1b2C3d4.css'), `/* ${'x'.repeat(4000)} */`, 'utf8');
// The attack this guards against: something inside the bundle pointing outside it.
symlinkSync('/etc/passwd', join(distDir, 'leak.txt'));

let child: ChildProcess | null = null;
let port = 0;
let base = '';
let stderr = '';

/** An ephemeral port, so concurrent runs in the same tree cannot collide. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const found = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(found));
    });
  });
}

/** Raw request, so paths that `fetch` would normalise away reach the server intact. */
async function raw(path: string): Promise<string> {
  return await new Promise((resolve) => {
    let body = '';
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      body += chunk;
    });
    socket.on('close', () => resolve(body));
    socket.on('error', () => resolve(body));
    setTimeout(() => {
      socket.destroy();
      resolve(body);
    }, 4000).unref();
  });
}

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CLIENT_DIST_DIR: distDir,
      RUNTIME_DIR: runtimeDir,
      // warn, not silent: the shutdown assertion below reports the server's own diagnosis when it
      // fails, and that diagnosis is a warning.
      LOG_LEVEL: 'warn',
      // Nothing is listening on port 1, so every poll fails fast and nothing leaves the machine.
      ADSB_A388_URL: 'http://127.0.0.1:1/fleet',
      ADSB_AREA_URL: 'http://127.0.0.1:1/area',
      METAR_URL: 'http://127.0.0.1:1/metar',
      UPSTREAM_TIMEOUT_MS: '1000',
      POLL_FLEET_MS: '2000',
      POLL_AREA_MS: '60000',
      POLL_WEATHER_MS: '300000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('the server never started listening');
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        await response.arrayBuffer();
        break;
      }
    } catch {
      // not up yet
    }
    await sleep(150);
  }
});

after(() => {
  child?.kill('SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
});

describe('static files', () => {
  it('serves the bundle', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await index.text(), /Whale Watch LHR/);

    const asset = await fetch(`${base}/assets/app-A1b2C3d4.css`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
    await asset.arrayBuffer();
  });

  it('refuses a symlink that points outside the bundle', async () => {
    const response = await fetch(`${base}/leak.txt`);
    const body = await response.text();
    assert.equal(response.status, 403);
    assert.ok(!body.includes('root:'), 'the filesystem must not be reachable through the bundle');
  });

  it('cannot be walked out of its root, however the traversal is spelled', async () => {
    const attempts = [
      '/../../../../etc/passwd',
      '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/%252e%252e%252fetc%252fpasswd',
      '/assets/../../../../etc/passwd',
      '/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/....//....//etc/passwd',
      '/..%5c..%5cetc%5cpasswd',
      '/%c0%ae%c0%ae/etc/passwd',
      '/..%00/etc/passwd',
      '/etc/passwd%00.css',
    ];
    for (const path of attempts) {
      const body = await raw(path);
      assert.ok(!body.includes('root:'), `${path} escaped the bundle`);
      assert.ok(!/^HTTP\/1\.1 (?:200|206)/.test(body) || body.includes('Whale Watch LHR'), `${path} served a file it should not have`);
    }
  });

  it('falls back to the app shell for a route, but not for a missing asset', async () => {
    const route = await fetch(`${base}/board`, { headers: { accept: 'text/html' } });
    assert.equal(route.status, 200);
    assert.match(await route.text(), /Whale Watch LHR/);

    for (const missing of ['/sw.js', '/assets/app-Missing.css', '/icon.svg']) {
      const response = await fetch(`${base}${missing}`);
      const body = await response.text();
      assert.equal(response.status, 404, `${missing} must 404`);
      assert.ok(!body.includes('<!doctype'), `${missing} must not be answered with HTML`);
    }
  });

  it('compresses text when asked and reports the length it actually sent', async () => {
    const spots = await fetch(`${base}/api/spots`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(spots.status, 200);
    assert.equal(spots.headers.get('content-encoding'), 'gzip');
    const length = Number(spots.headers.get('content-length'));
    const bytes = await spots.arrayBuffer();
    assert.ok(length > 0);
    // fetch decompresses transparently, so compare against the raw byte count on the wire.
    assert.ok(bytes.byteLength > length, 'the compressed body must be smaller than the JSON');
  });
});

describe('the API', () => {
  it('answers an unknown API route with JSON, never with the app shell', async () => {
    for (const path of ['/api', '/api/', '/api/nope', '/api/aircraft']) {
      const response = await fetch(`${base}${path}`);
      const body = await response.text();
      assert.equal(response.status, 404, `${path} should be 404`);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/, `${path} should be JSON`);
      assert.ok(!body.includes('<!doctype'), `${path} returned HTML`);
      JSON.parse(body);
    }
  });

  it('reports an unreachable feed as stale rather than pretending', async () => {
    const response = await fetch(`${base}/api/health`);
    const health = (await response.json()) as {
      ok: boolean;
      stale: boolean;
      lastPollAt: number | null;
      failures: number;
      upstream: { endpoints: Array<{ label: string; failures: number; lastError: string | null }> };
      server: { sseClients: number; snapshotSubscriptions: number };
    };
    assert.equal(response.status, 200, 'health always answers, even when the feed is down');
    assert.equal(health.ok, false);
    assert.equal(health.stale, true);
    assert.equal(health.lastPollAt, null, 'a poll that never succeeded is not a poll');
    assert.ok(health.failures > 0);
    const fleet = health.upstream.endpoints.find((e) => e.label === 'A388 fleet');
    assert.ok((fleet?.failures ?? 0) > 0);
    assert.ok(fleet?.lastError !== null);
    assert.equal(health.server.snapshotSubscriptions, 1);
  });

  it('serves a well-formed empty snapshot with no upstream at all', async () => {
    const snapshot = (await (await fetch(`${base}/api/snapshot`)).json()) as Record<string, unknown>;
    for (const key of ['ts', 'arrivals', 'departures', 'ground', 'runwayConfig', 'weather', 'sun', 'worldwide', 'log', 'stats', 'health']) {
      assert.ok(key in snapshot, `snapshot is missing ${key}`);
    }
    assert.deepEqual(snapshot['arrivals'], []);
    assert.deepEqual(snapshot['worldwide'], []);
    assert.ok(typeof snapshot['ts'] === 'number' && (snapshot['ts'] as number) > 1e12, 'ts is epoch ms');

    const text = JSON.stringify(snapshot);
    assert.ok(!/\bNaN\b|\bInfinity\b|\bundefined\b/.test(text), 'no NaN, Infinity or undefined on the wire');
  });

  it('rejects a hex that is not a hex, including a hostile one', async () => {
    // `..%2f` stays inside /api/aircraft/ instead of being normalised away by the client, so the
    // handler really is asked to look up a path traversal.
    const cases = ['zzzzzz', '..%2f..%2fetc%2fpasswd', '%2e%2e%2f%2e%2e%2fetc', "'%20OR%201=1--", 'a'.repeat(300), '400001x'];
    for (const hex of cases) {
      const response = await fetch(`${base}/api/aircraft/${hex}`);
      const body = await response.text();
      assert.equal(response.status, 404, `${hex} should not resolve`);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.ok(!body.includes('root:'));
    }
  });

  it('refuses methods it does not implement', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${base}/api/snapshot`, { method });
      await response.arrayBuffer();
      assert.equal(response.status, 405);
    }
  });

  it('bounds the movement window rather than trusting the query string', async () => {
    for (const query of ['', '?hours=abc', '?hours=-5', '?hours=1e9', '?hours=NaN', '?hours=Infinity']) {
      const response = await fetch(`${base}/api/movements${query}`);
      const body = (await response.json()) as unknown;
      assert.equal(response.status, 200, `movements${query} failed`);
      assert.ok(Array.isArray(body));
    }
  });
});

describe('the event stream', () => {
  it('sends a snapshot immediately, uncompressed, and cleans up on disconnect', async () => {
    const before = (await (await fetch(`${base}/api/health`)).json()) as { server: { sseClients: number } };
    assert.equal(before.server.sseClients, 0);

    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, {
      headers: { accept: 'text/event-stream', 'accept-encoding': 'gzip' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(response.headers.get('content-encoding'), null, 'an event stream may never be gzipped');
    assert.match(response.headers.get('cache-control') ?? '', /no-cache/);

    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /event: snapshot/, 'the first frame arrives on connect, not on the next poll');
    assert.match(text, /"ts":/);

    const during = (await (await fetch(`${base}/api/health`)).json()) as { server: { sseClients: number } };
    assert.equal(during.server.sseClients, 1);

    controller.abort();
    await sleep(300);
    const after = (await (await fetch(`${base}/api/health`)).json()) as {
      server: { sseClients: number; snapshotSubscriptions: number };
    };
    assert.equal(after.server.sseClients, 0, 'the client is forgotten as soon as it goes away');
    assert.equal(after.server.snapshotSubscriptions, 1, 'and the tracker listener is not duplicated');
  });

  it('forgets a hundred clients that connect and vanish', async () => {
    for (let round = 0; round < 4; round += 1) {
      await Promise.all(
        Array.from({ length: 25 }, async () => {
          const controller = new AbortController();
          const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
          const reader = response.body?.getReader();
          await reader?.read();
          controller.abort();
        }),
      );
    }
    await sleep(500);
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      server: { sseClients: number; snapshotSubscriptions: number };
    };
    assert.equal(health.server.sseClients, 0);
    assert.equal(health.server.snapshotSubscriptions, 1);
  });
});

describe('shutdown', () => {
  it('exits promptly and cleanly on SIGTERM, even with a stream open', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/stream`, { signal: controller.signal });
    await stream.body?.getReader().read();

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child?.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const started = Date.now();
    child?.kill('SIGTERM');

    // The server's own last-resort timer fires at 2.5 s. Exiting before that is the proof that
    // nothing — no parked rate-limit delay, no in-flight upstream fetch, no stream — is still
    // holding the event loop.
    const outcome = await Promise.race([exited, sleep(2000).then(() => null)]);
    controller.abort();
    assert.ok(outcome !== null, `the process did not exit within 2s of SIGTERM. Server said:\n${stderr}`);
    assert.notEqual(outcome.signal, 'SIGKILL');
    assert.ok(outcome.code === 0 || outcome.code === null, `unexpected exit code ${String(outcome.code)}`);
    assert.ok(Date.now() - started < 2000);
  });
});
