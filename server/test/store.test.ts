/**
 * The movement log is the only thing this server writes down, and it is the one thing a spotter
 * comes back to tomorrow ("how many whales yesterday?"). It therefore has to survive a half-written
 * line, an unbounded uptime, and — the subtle one — the fact that a London day is not a UTC day for
 * seven months of the year.
 *
 * The environment is set before the modules are imported because config.ts reads it once, at load.
 * `node --test` gives every test file its own process, so this cannot leak into another file.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const workDir = mkdtempSync(join(tmpdir(), 'whale-store-'));

// 100 is the floor config.ts allows; anything smaller is clamped up to it.
process.env['MOVEMENT_LOG_MAX'] = '100';
process.env['MOVEMENT_DEDUPE_MS'] = '600000';
process.env['LOG_LEVEL'] = 'silent';
process.env['RUNTIME_DIR'] = workDir;

const { MovementStore } = await import('../src/store.ts');
const { CONFIG } = await import('../src/config.ts');

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;
function file(): string {
  counter += 1;
  return join(workDir, `movements-${counter}.jsonl`);
}

function entry(over: Partial<Record<string, unknown>> = {}): {
  id: string;
  kind: 'arrival' | 'departure';
  at: number;
  callsign: string | null;
  flightNumber: string | null;
  registration: string | null;
  operator: string;
  operatorColor: string;
  runway: string | null;
  city: string | null;
} {
  return {
    id: '896456',
    kind: 'arrival',
    at: Date.parse('2026-08-14T12:00:00Z'),
    callsign: 'UAE1',
    flightNumber: 'EK1',
    registration: 'A6-EUA',
    operator: 'Emirates',
    operatorColor: '#D71921',
    runway: '27R',
    city: 'Dubai',
    ...over,
  };
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

describe('MovementStore — persistence', () => {
  it('round-trips an append through the file and hands it back newest first', () => {
    const path = file();
    const store = new MovementStore(path);
    const base = Date.parse('2026-08-14T12:00:00Z');
    store.append(entry({ at: base }));
    store.append(entry({ id: '40688b', at: base + 60_000, callsign: 'BAW117' }));

    const recent = store.recent(24, base + 120_000);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]?.callsign, 'BAW117', 'newest must come first');
    assert.equal(recent[1]?.callsign, 'UAE1');

    // A second store over the same file sees exactly the same history.
    const reopened = new MovementStore(path);
    assert.equal(reopened.size, 2);
    assert.equal(reopened.recent(24, base + 120_000)[0]?.callsign, 'BAW117');
  });

  it('skips corrupt lines instead of dying, and compacts them away', () => {
    const path = file();
    const good = JSON.stringify(entry({ at: Date.parse('2026-08-14T10:00:00Z') }));
    const later = JSON.stringify(entry({ id: '40688b', at: Date.parse('2026-08-14T11:00:00Z') }));
    writeFileSync(
      path,
      [
        good,
        '{"id":"broken","kind":"arrival"', // truncated mid-write
        '',
        'not json at all',
        JSON.stringify({ id: 'nokind', at: 1 }), // structurally wrong
        JSON.stringify({ id: 'x', kind: 'arrival', at: 'yesterday' }), // unusable timestamp
        later,
      ].join('\n') + '\n',
      'utf8',
    );

    const store = new MovementStore(path);
    assert.equal(store.size, 2, 'the two readable entries survive');
    assert.equal(lines(path).length, 2, 'the file is rewritten without the damage');
    for (const line of lines(path)) JSON.parse(line); // every surviving line is valid JSON
  });

  it('caps what it holds and what it writes, however long the process runs', () => {
    const path = file();
    const store = new MovementStore(path);
    const base = Date.parse('2026-08-01T00:00:00Z');
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      store.append(entry({ id: (0x400000 + i).toString(16), at: base + i * 3_600_000 }));
    }

    const cap = CONFIG.movementLogMax;
    assert.equal(cap, 100);
    assert.equal(store.size, cap, 'memory is bounded by MOVEMENT_LOG_MAX');
    assert.equal(lines(path).length, cap, 'the file is bounded too');

    // The survivors are the newest `cap` entries, still in ascending order on disk.
    const kept = lines(path).map((line) => JSON.parse(line) as { at: number });
    assert.equal(kept.length, cap);
    assert.equal(kept[0]?.at, base + (total - cap) * 3_600_000);
    for (let i = 1; i < kept.length; i += 1) {
      assert.ok((kept[i]?.at ?? 0) > (kept[i - 1]?.at ?? 0), 'the file stays ordered');
    }
  });

  it('treats a repeat of the same event inside the dedupe window as the same event', () => {
    const path = file();
    const store = new MovementStore(path);
    const at = Date.parse('2026-08-14T12:00:00Z');
    store.append(entry({ at }));
    store.append(entry({ at: at + 60_000 }));
    assert.equal(store.size, 1, 'one touchdown, logged once');

    store.append(entry({ at: at + 60_000, kind: 'departure' }));
    assert.equal(store.size, 2, 'a departure is a different event');

    store.append(entry({ at: at + 20 * 60_000 }));
    assert.equal(store.size, 3, 'the same airframe landing again an hour later is a new event');
  });

  it('refuses a malformed entry rather than writing it', () => {
    const path = file();
    const store = new MovementStore(path);
    store.append(entry({ id: '   ' }));
    store.append(entry({ at: Number.NaN }));
    store.append(entry({ kind: 'diversion' }));
    assert.equal(store.size, 0);
  });
});

describe('MovementStore — the Europe/London day', () => {
  const path = file();
  const store = new MovementStore(path);

  // British Summer Time: London is UTC+1, so 23:30 UTC is already 00:30 tomorrow at the fence.
  const lateOn14th = Date.parse('2026-08-14T22:30:00Z'); // 23:30 BST on the 14th
  const earlyOn15th = Date.parse('2026-08-14T23:30:00Z'); // 00:30 BST on the 15th
  const midMorning15th = Date.parse('2026-08-15T08:00:00Z');

  store.append(entry({ id: '896456', at: lateOn14th, registration: 'A6-EUA' }));
  store.append(entry({ id: '40688b', at: earlyOn15th, registration: 'G-XLEA' }));
  store.append(entry({ id: '406a04', at: midMorning15th, registration: 'G-XLEE', kind: 'departure' }));

  it('puts a 23:30 UTC movement on the next London day during BST', () => {
    const counts = store.todayCounts(Date.parse('2026-08-15T09:00:00Z'));
    assert.deepEqual(counts, { arrivals: 1, departures: 1, airframes: 2 });
  });

  it('keeps the 22:30 UTC movement on the previous London day', () => {
    // 23:45 BST on the 14th: the 22:30 UTC arrival counts, the 23:30 UTC one belongs to tomorrow.
    const counts = store.todayCounts(Date.parse('2026-08-14T22:45:00Z'));
    assert.deepEqual(counts, { arrivals: 1, departures: 0, airframes: 1 });
  });

  it('uses the real offset in winter, when London is on UTC', () => {
    const winter = new MovementStore(file());
    // 23:30 GMT on 15 January is still the 15th in London.
    winter.append(entry({ id: '896456', at: Date.parse('2026-01-15T23:30:00Z') }));
    winter.append(entry({ id: '40688b', at: Date.parse('2026-01-16T00:30:00Z'), kind: 'departure' }));

    assert.deepEqual(winter.todayCounts(Date.parse('2026-01-15T23:59:00Z')), {
      arrivals: 1,
      departures: 0,
      airframes: 1,
    });
    assert.deepEqual(winter.todayCounts(Date.parse('2026-01-16T01:00:00Z')), {
      arrivals: 0,
      departures: 1,
      airframes: 1,
    });
  });

  it('counts distinct airframes, not movements', () => {
    const busy = new MovementStore(file());
    const morning = Date.parse('2026-08-15T07:00:00Z');
    busy.append(entry({ id: '896456', at: morning, registration: 'A6-EUA' }));
    busy.append(entry({ id: '896456', at: morning + 6 * 3_600_000, registration: 'A6-EUA', kind: 'departure' }));
    busy.append(entry({ id: '40688b', at: morning + 3_600_000, registration: 'G-XLEA' }));

    const counts = busy.todayCounts(Date.parse('2026-08-15T20:00:00Z'));
    assert.equal(counts.arrivals, 2);
    assert.equal(counts.departures, 1);
    assert.equal(counts.airframes, 2);
  });

  it('never reports movements from other days', () => {
    assert.deepEqual(store.todayCounts(Date.parse('2026-08-20T12:00:00Z')), {
      arrivals: 0,
      departures: 0,
      airframes: 0,
    });
  });
});

describe('MovementStore — history for one airframe', () => {
  it('returns only that airframe, newest first, and is case-insensitive about the hex', () => {
    const store = new MovementStore(file());
    const base = Date.parse('2026-08-14T06:00:00Z');
    store.append(entry({ id: '896456', at: base }));
    store.append(entry({ id: '40688b', at: base + 3_600_000 }));
    store.append(entry({ id: '896456', at: base + 7_200_000, kind: 'departure' }));

    const history = store.forAirframe('896456');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.kind, 'departure');
    assert.deepEqual(store.forAirframe('896456'), store.forAirframe('  896456  '));
    assert.deepEqual(store.forAirframe(''), []);
  });
});
