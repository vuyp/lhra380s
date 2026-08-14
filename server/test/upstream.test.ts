/**
 * adsb.lol is a free, community-fed firehose: fields vanish, `alt_baro` is sometimes the string
 * "ground", and a badly sited receiver will happily report a latitude of 999 or a groundspeed of
 * −1. None of that may reach the wire, and none of it may take the process down.
 *
 * The second half of this file is the rule that matters most for honesty: while an endpoint is
 * failing or backing off, the fetchers return nothing at all. Handing back the cached payload
 * would make the tracker record a successful poll, and the app would then report a healthy live
 * feed for an upstream that has been dead for an hour.
 */

import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

/* ---- a controllable stand-in for adsb.lol ---------------------------------- */

type StubMode = 'ok' | 'error' | 'garbage' | 'empty';

let mode: StubMode = 'ok';
let requests = 0;

const fleetPayload = {
  now: 1786725000000,
  ac: [{ hex: '400001', flight: 'UAE1    ', r: 'A6-EUA', t: 'A388', alt_baro: 3000, gs: 210, track: 268, lat: 51.4, lon: 0.2 }],
};

const stub: Server = createServer((req, res) => {
  requests += 1;
  if (mode === 'error') {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('boom');
    return;
  }
  if (mode === 'garbage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'no aircraft here' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(mode === 'empty' ? { now: 1786725000000, ac: [] } : fleetPayload));
});

await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
const port = (stub.address() as AddressInfo).port;

process.env['LOG_LEVEL'] = 'silent';
process.env['ADSB_A388_URL'] = `http://127.0.0.1:${port}/fleet`;
// Port 1 is never listening: the area feed exists here purely to prove a refused connection is
// survivable.
process.env['ADSB_AREA_URL'] = 'http://127.0.0.1:1/area';
process.env['METAR_URL'] = `http://127.0.0.1:${port}/metar`;
process.env['UPSTREAM_MIN_INTERVAL_MS'] = '0';
process.env['UPSTREAM_TIMEOUT_MS'] = '1000';
process.env['UPSTREAM_BACKOFF_START_MS'] = '250';
process.env['UPSTREAM_BACKOFF_MAX_MS'] = '1000';

const { fetchA380s, fetchAreaTraffic, parseAircraftPayload, parseMetar, upstreamHealth } = await import(
  '../src/upstream.ts'
);

after(() => {
  stub.close();
});

function one(over: Record<string, unknown>): ReturnType<typeof parseAircraftPayload> {
  return parseAircraftPayload({ now: 1786725000000, ac: [{ hex: '400001', ...over }] });
}

/* ---- normalisation --------------------------------------------------------- */

describe('upstream normalisation — the shapes adsb.lol actually sends', () => {
  it('reads a complete aircraft', () => {
    const list = parseAircraftPayload(fleetPayload);
    assert.ok(list !== null);
    assert.equal(list.length, 1);
    const ac = list[0];
    assert.equal(ac?.hex, '400001');
    assert.equal(ac?.callsign, 'UAE1', 'the trailing pad is trimmed');
    assert.equal(ac?.registration, 'A6-EUA');
    assert.equal(ac?.altitude, 3000);
    assert.equal(ac?.onGround, false);
    assert.equal(ac?.groundSpeed, 210);
    assert.equal(ac?.track, 268);
  });

  it('treats alt_baro "ground" as on the ground with no altitude', () => {
    for (const value of ['ground', 'GROUND', ' Ground ']) {
      const list = one({ alt_baro: value, gs: 12 });
      assert.equal(list?.[0]?.onGround, true, `${JSON.stringify(value)} means on the ground`);
      assert.equal(list?.[0]?.altitude, null, 'an aircraft on the ground has no altitude to report');
    }
  });

  it('accepts the same marker on alt_geom', () => {
    const list = one({ alt_geom: 'ground', alt_baro: 275 });
    assert.equal(list?.[0]?.onGround, true);
    assert.equal(list?.[0]?.altitude, null);
  });

  it('keeps a geometric altitude when the barometric one is missing', () => {
    const list = one({ alt_geom: 37000 });
    assert.equal(list?.[0]?.altitude, 37000);
    assert.equal(list?.[0]?.onGround, false);
  });

  it('reports an absent field as null rather than zero', () => {
    const ac = one({})?.[0];
    assert.equal(ac?.lat, null);
    assert.equal(ac?.lon, null);
    assert.equal(ac?.altitude, null);
    assert.equal(ac?.groundSpeed, null);
    assert.equal(ac?.track, null);
    assert.equal(ac?.verticalRate, null);
    assert.equal(ac?.squawk, null);
    assert.equal(ac?.callsign, null);
  });

  it('drops values that are outside physical range instead of clamping them', () => {
    const ac = one({ lat: 999, lon: -999, alt_baro: 1e12, gs: -1, baro_rate: 1e9, seen_pos: -5 })?.[0];
    assert.equal(ac?.lat, null, 'latitude 999 is not a position');
    assert.equal(ac?.lon, null);
    assert.equal(ac?.altitude, null);
    assert.equal(ac?.groundSpeed, null, 'a negative groundspeed is unknown, not zero');
    assert.equal(ac?.verticalRate, null);
    assert.equal(ac?.ageSeconds, 0);
  });

  it('never lets NaN or Infinity through', () => {
    const ac = one({ lat: 'NaN', lon: 'Infinity', alt_baro: 'NaN', gs: 'nope', track: 'NaN', seen: 'NaN' })?.[0];
    for (const value of [ac?.lat, ac?.lon, ac?.altitude, ac?.groundSpeed, ac?.track]) assert.equal(value, null);
    assert.ok(Number.isFinite(ac?.ageSeconds));
    assert.ok(Number.isFinite(ac?.receivedAt));
  });

  it('wraps a track onto the compass', () => {
    assert.equal(one({ track: 720.5 })?.[0]?.track, 0.5);
    assert.equal(one({ track: -450 })?.[0]?.track, 270);
    assert.equal(one({ track: 0 })?.[0]?.track, 0);
  });

  it('only accepts a squawk that is a real Mode A code', () => {
    assert.equal(one({ squawk: '7700' })?.[0]?.squawk, '7700');
    assert.equal(one({ squawk: 723 })?.[0]?.squawk, '0723', 'a numeric code is padded, not invented');
    assert.equal(one({ squawk: 12345 })?.[0]?.squawk, null);
    assert.equal(one({ squawk: '9999' })?.[0]?.squawk, null, 'squawks are octal');
  });

  it('survives null members, wrong types and a missing hex', () => {
    const list = parseAircraftPayload({
      now: 1786725000000,
      ac: [null, 'a string', [], 42, { flight: 'NOHEX' }, { hex: '400002', lat: null, lon: null }],
    });
    assert.equal(list?.length, 1, 'only the entry with a hex is an aircraft');
    assert.equal(list?.[0]?.hex, '400002');
    assert.equal(list?.[0]?.lat, null);
  });

  it('distinguishes an empty feed from a body that is not a feed', () => {
    assert.deepEqual(parseAircraftPayload({ ac: [], now: 1 }), [], 'an empty sky is an answer');
    assert.equal(parseAircraftPayload({ ac: { not: 'an array' } }), null);
    assert.equal(parseAircraftPayload({}), null);
    assert.equal(parseAircraftPayload([1, 2, 3]), null);
    assert.equal(parseAircraftPayload(null), null);
    assert.equal(parseAircraftPayload('<!doctype html>'), null);
  });

  it('ages a position from the feed clock, in milliseconds', () => {
    const ac = parseAircraftPayload({ now: 1786725000000, ac: [{ hex: '400001', seen_pos: 12.5 }] })?.[0];
    assert.equal(ac?.ageSeconds, 12.5);
    assert.equal(ac?.receivedAt, 1786725000000 - 12_500);

    // A feed clock in seconds is tolerated and converted.
    const seconds = parseAircraftPayload({ now: 1786725000, ac: [{ hex: '400001', seen_pos: 0 }] })?.[0];
    assert.equal(seconds?.receivedAt, 1786725000000);
  });
});

describe('METAR parsing', () => {
  it('reads the newest observation and leaves unknowns null', () => {
    const weather = parseMetar([
      { rawOb: 'EGLL 141450Z 27010KT 9999 FEW030 20/12 Q1015', obsTime: 1786722600, wdir: 270, wspd: 10, altim: 1015 },
      { rawOb: 'EGLL 141550Z 30005KT 9999 NCD 33/14 Q1015', obsTime: 1786726200, wdir: 300, wspd: 5, temp: 33, altim: 1015 },
    ]);
    assert.equal(weather?.raw, 'EGLL 141550Z 30005KT 9999 NCD 33/14 Q1015');
    assert.equal(weather?.windDirection, 300);
    assert.equal(weather?.temperature, 33);
    assert.equal(weather?.observedAt, 1786726200000);
    assert.equal(weather?.windGust, null);
    assert.equal(weather?.visibility, null);
  });

  it('reports a variable wind as unknown rather than as a bearing', () => {
    const weather = parseMetar([{ rawOb: 'EGLL VRB03KT', wdir: 'VRB', wspd: 3 }]);
    assert.equal(weather?.windDirection, null);
    assert.equal(weather?.windSpeed, 3);
  });

  it('drops impossible values', () => {
    const weather = parseMetar([{ rawOb: 'x', wspd: -3, temp: 'hot', altim: 99999, wgst: 1e9 }]);
    assert.equal(weather?.windSpeed, null);
    assert.equal(weather?.temperature, null);
    assert.equal(weather?.qnh, null);
    assert.equal(weather?.windGust, null);
  });

  it('converts inches of mercury but refuses nonsense', () => {
    assert.equal(parseMetar([{ altim: 29.92 }])?.qnh, 1013);
    assert.equal(parseMetar([{ altim: 1015 }])?.qnh, 1015);
    assert.equal(parseMetar([{ altim: 0 }])?.qnh, null);
  });

  it('returns null for a list with nothing usable in it', () => {
    assert.equal(parseMetar([]), null);
    assert.equal(parseMetar([null, 'x', 5]), null);
  });
});

/* ---- failure behaviour ----------------------------------------------------- */

describe('upstream failure — cache may never impersonate a live feed', () => {
  it('serves live data, then nothing at all while the endpoint is failing', async () => {
    mode = 'ok';
    const good = await fetchA380s();
    assert.equal(good.length, 1, 'a healthy endpoint returns its aircraft');

    mode = 'error';
    const duringFailure = await fetchA380s();
    assert.deepEqual(duringFailure, [], 'a 500 returns nothing, so the tracker can go stale');

    // Immediately afterwards the endpoint is inside its backoff window: still nothing, and — the
    // point of the backoff — no request is made either.
    const before = requests;
    const duringBackoff = await fetchA380s();
    assert.deepEqual(duringBackoff, [], 'the cached payload is not replayed as if it were fresh');
    assert.equal(requests, before, 'the dead host is not hammered while it is backing off');

    const health = upstreamHealth().endpoints.find((e) => e.label === 'A388 fleet');
    assert.ok(health !== undefined);
    assert.ok(health.failures >= 1);
    assert.ok(health.nextAttemptAt > Date.now(), 'the backoff window is visible in the health block');
    assert.match(health.lastError ?? '', /500/);
  });

  it('recovers by itself once the endpoint comes back', async () => {
    mode = 'ok';
    await sleep(1200); // ride out the backoff
    const recovered = await fetchA380s();
    assert.equal(recovered.length, 1);
    const health = upstreamHealth().endpoints.find((e) => e.label === 'A388 fleet');
    assert.equal(health?.failures, 0);
    assert.equal(health?.lastError, null);
  });

  it('treats a 200 that is not an aircraft feed as a failure worth backing off from', async () => {
    mode = 'garbage';
    const list = await fetchA380s();
    assert.deepEqual(list, []);
    const health = upstreamHealth().endpoints.find((e) => e.label === 'A388 fleet');
    assert.ok((health?.failures ?? 0) >= 1, 'a valid-JSON non-feed still counts as a failure');
    assert.match(health?.lastError ?? '', /aircraft array/);
  });

  it('passes an empty sky straight through without calling it a failure', async () => {
    mode = 'empty';
    await sleep(1200);
    const list = await fetchA380s();
    assert.deepEqual(list, []);
    const health = upstreamHealth().endpoints.find((e) => e.label === 'A388 fleet');
    assert.equal(health?.failures, 0, 'the endpoint answered; it is the sky that was empty');
  });

  it('survives a refused connection without throwing', async () => {
    const dead = await fetchAreaTraffic();
    assert.deepEqual(dead, [], 'nothing listening means no traffic, not an exception');
    const health = upstreamHealth().endpoints.find((e) => e.label === 'LHR area traffic');
    assert.ok((health?.failures ?? 0) >= 1);
    assert.match(health?.lastError ?? '', /fetch failed|ECONNREFUSED|bad port/);
  });
});
