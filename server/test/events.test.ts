/**
 * The movement log is permanent, so what gets written into it has to be earned.
 *
 * Every case here comes from a defect the live feed produced: a Mode-S-only frame read as an
 * air/ground transition (which fabricated a departure *and* an arrival for an aeroplane that never
 * moved), a just-landed whale labelled "Taxiing out" because ten seconds of stillness counted as
 * the three-minute stand dwell, and a countdown that kept counting from a position that had
 * stopped arriving.
 *
 * These run the production state machine through `createReplayTracker` — the same ingest path the
 * poller uses, with the network replaced by an array.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { classifyGroundMovement, createReplayTracker, type TaxiEvidence } from '../src/tracker.ts';
import { parseAircraftPayload, type UpstreamAircraft } from '../src/upstream.ts';
import { destinationPoint, type LatLon } from '../src/geo.ts';

const dirs: string[] = [];

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whale-events-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const LHR: LatLon = { lat: 51.4706, lon: -0.4619 };
/** A stand on the eastern apron, inside the airport boundary polygon. */
const STAND: LatLon = { lat: 51.4712, lon: -0.4485 };

/**
 * The clock these scenarios run on. It has to be roughly the wall clock, not an arbitrary epoch:
 * the movement store windows its answers against `Date.now()`, so a log written a week in the
 * past would never come back in the snapshot.
 */
const T0 = Date.now() - 60_000;

function frame(over: Partial<UpstreamAircraft> & { hex: string }): UpstreamAircraft {
  return {
    callsign: 'UAE4CK',
    registration: 'A6-EUH',
    type: 'A388',
    lat: null,
    lon: null,
    altitude: null,
    onGround: false,
    groundKnown: true,
    groundSpeed: null,
    track: null,
    verticalRate: null,
    squawk: null,
    ageSeconds: 2,
    receivedAt: T0,
    ...over,
  };
}

function parked(at: number): UpstreamAircraft {
  return frame({
    hex: 'abc123',
    lat: STAND.lat,
    lon: STAND.lon,
    onGround: true,
    groundSpeed: 0,
    track: 91,
    receivedAt: at,
  });
}

describe('a degraded upstream frame is not a physical event', () => {
  /**
   * The exact shape the live A388 sweep emits several times an hour: a hex, an age, and nothing
   * else. Built through the real parser so the test cannot drift from what upstream produces.
   */
  function modeSOnly(at: number): UpstreamAircraft {
    const parsed = parseAircraftPayload({ now: at, ac: [{ hex: 'abc123', seen: 8.7 }] });
    assert.ok(parsed !== null && parsed.length === 1, 'the parser rejected the frame outright');
    const only = parsed[0];
    assert.ok(only !== undefined);
    return only;
  }

  it('reads no altitude at all as "unknown", never as airborne', () => {
    const degraded = modeSOnly(T0);
    assert.equal(degraded.groundKnown, false);
    assert.equal(degraded.altitude, null);
    assert.equal(degraded.lat, null);
  });

  it('writes nothing to the log when a parked whale drops to a Mode-S frame and back', () => {
    const tracker = createReplayTracker({ dataDir: workDir() });

    tracker.feed([parked(T0)], T0);
    tracker.feed([parked(T0 + 5_000)], T0 + 5_000);
    // The frame that used to fabricate a departure…
    tracker.feed([modeSOnly(T0 + 10_000)], T0 + 10_000);
    // …and then, on the way back, an arrival.
    const after = tracker.feed([parked(T0 + 15_000)], T0 + 15_000);

    assert.deepEqual(after.log, [], `log wrote ${after.log.map((e) => e.kind).join(', ')}`);
    assert.equal(after.stats.arrivalsToday, 0);
    assert.equal(after.stats.departuresToday, 0);
    assert.deepEqual(after.departures, []);
    assert.equal(after.ground.length, 1);
    assert.equal(after.ground[0]?.telemetry.onGround, true);
  });

  it('keeps the aircraft on the ground list rather than bouncing it through climb_out', () => {
    const tracker = createReplayTracker({ dataDir: workDir() });
    const phases = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const at = T0 + i * 5_000;
      const snapshot = tracker.feed([i === 3 || i === 6 ? modeSOnly(at) : parked(at)], at);
      for (const movement of [...snapshot.arrivals, ...snapshot.departures, ...snapshot.ground]) {
        phases.add(movement.phase);
      }
    }
    assert.equal(phases.has('climb_out'), false, 'a degraded frame took off');
    assert.equal(phases.has('landed'), false, 'a degraded frame landed');
  });
});

describe('an aircraft found on the ground is not assumed to be leaving', () => {
  /** A movement log holding one touchdown for this airframe, `agoMs` ago and nothing since. */
  function dirWithArrival(agoMs: number): string {
    const dir = workDir();
    writeFileSync(
      join(dir, 'movements.jsonl'),
      `${JSON.stringify({
        id: 'abc123',
        kind: 'arrival',
        at: T0 - agoMs,
        callsign: 'UAE4CK',
        flightNumber: null,
        registration: 'A6-EUH',
        operator: 'Emirates',
        operatorColor: '#d71921',
        runway: '27L',
        city: 'Dubai',
      })}\n`,
      'utf8',
    );
    return dir;
  }

  function taxiing(at: number): UpstreamAircraft {
    return frame({
      hex: 'abc123',
      lat: STAND.lat,
      lon: STAND.lon,
      onGround: true,
      groundSpeed: 14,
      track: 91,
      receivedAt: at,
    });
  }

  it('reads a whale found moving after a logged touchdown as taxiing in, not out', () => {
    const tracker = createReplayTracker({ dataDir: dirWithArrival(3 * 60_000) });
    tracker.feed([taxiing(T0)], T0);
    tracker.feed([taxiing(T0 + 5_000)], T0 + 5_000);
    assert.equal(tracker.phaseOf('abc123'), 'taxi_in');
  });

  it('does not let a brief stillness turn that arrival into a departure', () => {
    // The field case: the server restarts three minutes after a landing it had already logged.
    // Two stationary polls used to satisfy the three-minute stand dwell, which pinned the
    // airframe to taxi_out — a departure chip and a departure runway on an aeroplane that had
    // just arrived — for the rest of the session.
    const tracker = createReplayTracker({ dataDir: dirWithArrival(3 * 60_000) });
    tracker.feed([parked(T0)], T0);
    tracker.feed([parked(T0 + 5_000)], T0 + 5_000);
    tracker.feed([taxiing(T0 + 10_000)], T0 + 10_000);
    const snapshot = tracker.feed([taxiing(T0 + 15_000)], T0 + 15_000);
    assert.equal(tracker.phaseOf('abc123'), 'taxi_in');
    assert.equal(snapshot.ground.length, 1);
    assert.equal(snapshot.departures.length, 0);
  });

  it('still calls it taxiing out once a real three-minute dwell has been observed', () => {
    const tracker = createReplayTracker({ dataDir: dirWithArrival(3 * 60_000) });
    let at = T0;
    for (let i = 0; i < 7; i += 1) {
      tracker.feed([parked(at)], at);
      at += 60_000;
    }
    assert.equal(tracker.phaseOf('abc123'), 'stand');
    tracker.feed([taxiing(at)], at);
    tracker.feed([taxiing(at + 5_000)], at + 5_000);
    assert.equal(tracker.phaseOf('abc123'), 'taxi_out');
  });

  it('gives a parked whale no route rather than "London → LHR"', () => {
    const tracker = createReplayTracker({ dataDir: workDir() });
    tracker.feed([parked(T0)], T0);
    const snapshot = tracker.feed([parked(T0 + 5_000)], T0 + 5_000);
    const ground = snapshot.ground[0];
    assert.ok(ground !== undefined);
    assert.equal(ground.route.origin, null);
    assert.equal(ground.route.destination, null);
    assert.equal(ground.route.source, 'unknown');
  });
});

/**
 * The taxi-direction decision, one evidence combination at a time.
 *
 * The defect: a whale that had just landed, met for the first time by a server that was not running
 * when it did, fell through to `taxi_out` and was announced as "Taxiing out" in departure colours.
 * The honest answers are three, not two — taxiing in, taxiing out, and taxiing without our knowing
 * which — and the last of those is the *normal* answer on a cold start.
 */
describe('which way a whale on the tarmac is taxiing', () => {
  /** A point `nm` along the 27L take-off run, tracking down it: where a departure lines up. */
  function linedUpOn27L(nm: number): LatLon {
    return destinationPoint({ lat: 51.46495, lon: -0.4341 }, 269.72, nm);
  }

  function evidence(over: Partial<TaxiEvidence>): TaxiEvidence {
    return {
      previousPhase: 'elsewhere',
      hasBeenAtStand: false,
      landedThisSession: false,
      arrivedRecently: false,
      groundSpeedKts: 14,
      position: STAND,
      track: 91,
      ...over,
    };
  }

  it('says so plainly when nothing at all says which way — the cold-start case', () => {
    // First contact: moving on the apron, no session history, an empty movement log. This is the
    // frame that used to read "Taxiing out".
    assert.equal(classifyGroundMovement(evidence({})), 'taxi_unknown');
  });

  it('calls a whale taxiing in when this session watched it land', () => {
    assert.equal(classifyGroundMovement(evidence({ landedThisSession: true })), 'taxi_in');
    assert.equal(classifyGroundMovement(evidence({ previousPhase: 'landed' })), 'taxi_in');
    assert.equal(classifyGroundMovement(evidence({ previousPhase: 'taxi_in' })), 'taxi_in');
  });

  it('calls it taxiing in on the persisted log alone, across a restart', () => {
    assert.equal(classifyGroundMovement(evidence({ arrivedRecently: true })), 'taxi_in');
  });

  it('keeps calling the roll-out a landing until it is down to taxi speed', () => {
    const rollingOut = evidence({ previousPhase: 'approach', groundSpeedKts: 95 });
    assert.equal(classifyGroundMovement(rollingOut), 'landed');
    assert.equal(classifyGroundMovement({ ...rollingOut, groundSpeedKts: 18 }), 'taxi_in');
  });

  it('calls it taxiing out only once a stand dwell has actually been observed', () => {
    // The turnaround: the dwell outranks the arrival that preceded it, log entry and all.
    assert.equal(
      classifyGroundMovement(evidence({ hasBeenAtStand: true, arrivedRecently: true })),
      'taxi_out',
    );
    assert.equal(classifyGroundMovement(evidence({ previousPhase: 'departing' })), 'taxi_out');
    assert.equal(classifyGroundMovement(evidence({ previousPhase: 'taxi_out' })), 'taxi_out');
  });

  it('reads a line-up on the runway as a departure, with no history behind it', () => {
    const lined = evidence({ position: linedUpOn27L(0.2), track: 270, groundSpeedKts: 10 });
    assert.equal(classifyGroundMovement(lined), 'taxi_out');
    // Stopped on the centreline waiting for clearance is still going flying, not "at stand".
    assert.equal(classifyGroundMovement({ ...lined, groundSpeedKts: 0 }), 'taxi_out');
    // And it is a fact about this frame, so it beats a touchdown logged up to 45 minutes ago.
    assert.equal(classifyGroundMovement({ ...lined, arrivedRecently: true }), 'taxi_out');
  });

  it('does not read a landing roll-out as a line-up just because it is on the runway', () => {
    // Same asphalt, same alignment — but at 110 kt this is the landing, and it is not slow at the
    // near end of a runway it is still rolling down.
    const rollingOut = evidence({
      previousPhase: 'approach',
      position: linedUpOn27L(0.3),
      track: 270,
      groundSpeedKts: 110,
    });
    assert.equal(classifyGroundMovement(rollingOut), 'landed');
  });

  it('parks a stationary whale it knows nothing about rather than inventing a direction', () => {
    assert.equal(classifyGroundMovement(evidence({ groundSpeedKts: 0 })), 'stand');
    assert.equal(classifyGroundMovement(evidence({ groundSpeedKts: null })), 'stand');
  });

  it('puts every taxi on the ground board, never on departures', () => {
    const tracker = createReplayTracker({ dataDir: workDir() });
    const moving = (at: number): UpstreamAircraft =>
      frame({
        hex: 'abc123',
        lat: STAND.lat,
        lon: STAND.lon,
        onGround: true,
        groundSpeed: 12,
        track: 91,
        receivedAt: at,
      });

    tracker.feed([moving(T0)], T0);
    const snapshot = tracker.feed([moving(T0 + 5_000)], T0 + 5_000);

    assert.equal(tracker.phaseOf('abc123'), 'taxi_unknown');
    assert.equal(snapshot.ground.length, 1);
    assert.equal(snapshot.departures.length, 0);
    assert.equal(snapshot.arrivals.length, 0);
    // No direction means no departure runway either — that would be the same guess, restated.
    assert.equal(snapshot.ground[0]?.runway.runway, null);
    assert.equal(snapshot.log.length, 0);
  });

  it('promotes an unknown taxi to a taxi out the moment it lines up', () => {
    const tracker = createReplayTracker({ dataDir: workDir() });
    const somewhere = (at: number): UpstreamAircraft =>
      frame({ hex: 'abc123', lat: STAND.lat, lon: STAND.lon, onGround: true, groundSpeed: 12, track: 91, receivedAt: at });
    const lined = (at: number): UpstreamAircraft => {
      const where = linedUpOn27L(0.15);
      return frame({
        hex: 'abc123',
        lat: where.lat,
        lon: where.lon,
        onGround: true,
        groundSpeed: 8,
        track: 270,
        receivedAt: at,
      });
    };

    tracker.feed([somewhere(T0)], T0);
    tracker.feed([somewhere(T0 + 5_000)], T0 + 5_000);
    assert.equal(tracker.phaseOf('abc123'), 'taxi_unknown');

    tracker.feed([lined(T0 + 10_000)], T0 + 10_000);
    tracker.feed([lined(T0 + 15_000)], T0 + 15_000);
    assert.equal(tracker.phaseOf('abc123'), 'taxi_out');
  });
});

describe('a departure runway is read off the ground, not off the configuration', () => {
  const THRESHOLD_27L: LatLon = { lat: 51.46495, lon: -0.4341 };

  /** A point `nm` down the 27L runway from its threshold, tracking along it. */
  function on27L(nm: number): LatLon {
    return destinationPoint(THRESHOLD_27L, 269.72, nm);
  }

  function rolling(at: number, nm: number, groundSpeed: number): UpstreamAircraft {
    const where = on27L(nm);
    return frame({
      hex: 'aaa111',
      callsign: 'BAW55G',
      registration: 'G-XLEJ',
      lat: where.lat,
      lon: where.lon,
      onGround: true,
      groundSpeed,
      track: 270,
      receivedAt: at,
    });
  }

  function airborneOver(at: number, nm: number, altitude: number): UpstreamAircraft {
    const where = on27L(nm);
    return frame({
      hex: 'aaa111',
      callsign: 'BAW55G',
      registration: 'G-XLEJ',
      lat: where.lat,
      lon: where.lon,
      altitude,
      groundSpeed: 180,
      track: 270,
      verticalRate: 2600,
      receivedAt: at,
    });
  }

  it('names the runway the aeroplane actually rotated off', () => {
    const tracker = createReplayTracker({ dataDir: workDir() });
    tracker.feed([rolling(T0, 0.2, 70)], T0);
    tracker.feed([rolling(T0 + 5_000, 1.0, 130)], T0 + 5_000);
    const snapshot = tracker.feed([airborneOver(T0 + 10_000, 1.8, 300)], T0 + 10_000);

    const logged = snapshot.log[0];
    assert.ok(logged !== undefined, 'the departure was never logged');
    assert.equal(logged.kind, 'departure');
    assert.equal(logged.runway, '27L');
  });

  it('logs no runway at all when the wheels-up fix is nowhere near one', () => {
    const tracker = createReplayTracker({ dataDir: workDir() });
    // Pushed back and rolling on the apron, then a first airborne fix off to the side: this is a
    // ragged feed, not a take-off we watched. The configuration must not fill the gap in.
    tracker.feed([parked(T0)], T0);
    const away = frame({
      hex: 'abc123',
      lat: STAND.lat,
      lon: STAND.lon,
      altitude: 900,
      groundSpeed: 190,
      track: 270,
      verticalRate: 2200,
      receivedAt: T0 + 5_000,
    });
    const snapshot = tracker.feed([away], T0 + 5_000);
    const logged = snapshot.log[0];
    assert.ok(logged !== undefined, 'the departure was never logged');
    assert.equal(logged.runway, null);
  });

  it('refuses a wheels-up frame inside the turnaround after its own touchdown', () => {
    const tracker = createReplayTracker({ dataDir: workDir() });
    // Short final, touchdown, then one ragged frame during the roll-out that reports an altitude
    // instead of "ground" — which used to log a departure ten seconds after the landing.
    tracker.feed([airborneOver(T0, -1.2, 400)], T0);
    const down = tracker.feed([rolling(T0 + 5_000, 0.4, 120)], T0 + 5_000);
    assert.equal(down.log[0]?.kind, 'arrival', 'the touchdown itself was not logged');

    const ragged = tracker.feed([airborneOver(T0 + 15_000, 1.4, 120)], T0 + 15_000);
    assert.equal(ragged.log.length, 1, 'a phantom departure was written during the roll-out');
    assert.equal(ragged.stats.departuresToday, 0);
  });
});

/**
 * The same rule as the runway, applied to the operator.
 *
 * `LoggedMovement` and `GlobalAircraft` carry the operator as a bare string with no provenance
 * beside it, so what goes in has to be something the app read rather than something it worked out.
 * "Every G- registered A380 in our fleet file is British Airways, so this one is" is a fair
 * inference on the live board, where the UI can mark it — and a permanent falsehood in a log that
 * cannot. The unlisted G- frame is precisely the aeroplane a spotter came out for.
 */
describe('the permanent log states an operator only when one was identified', () => {
  const THRESHOLD_27L: LatLon = { lat: 51.46495, lon: -0.4341 };

  /** A departure roll for an airframe of our choosing, `nm` down 27L. */
  function rolling(
    at: number,
    nm: number,
    groundSpeed: number,
    who: { callsign: string | null; registration: string | null },
  ): UpstreamAircraft {
    const where = destinationPoint(THRESHOLD_27L, 269.72, nm);
    return frame({
      hex: 'bbb222',
      callsign: who.callsign,
      registration: who.registration,
      lat: where.lat,
      lon: where.lon,
      onGround: true,
      groundSpeed,
      track: 270,
      receivedAt: at,
    });
  }

  /** The roll, then the rotation: the air/ground transition is what writes the log entry. */
  function departureOf(who: { callsign: string | null; registration: string | null }) {
    const tracker = createReplayTracker({ dataDir: workDir() });
    tracker.feed([rolling(T0, 0.2, 70, who)], T0);
    tracker.feed([rolling(T0 + 5_000, 1.0, 130, who)], T0 + 5_000);

    const where = destinationPoint(THRESHOLD_27L, 269.72, 1.8);
    const airborne = frame({
      hex: 'bbb222',
      callsign: who.callsign,
      registration: who.registration,
      lat: where.lat,
      lon: where.lon,
      altitude: 300,
      groundSpeed: 180,
      track: 270,
      verticalRate: 2600,
      receivedAt: T0 + 10_000,
    });
    const snapshot = tracker.feed([airborne], T0 + 10_000);
    const logged = snapshot.log[0];
    assert.ok(logged !== undefined, 'the departure was never logged');
    return { logged, snapshot };
  }

  it('writes the operator when the callsign named it', () => {
    const { logged } = departureOf({ callsign: 'UAE4CK', registration: 'A6-EUH' });
    assert.equal(logged.operator, 'Emirates');
    assert.equal(logged.operatorColor.toLowerCase(), '#d71921');
  });

  it('writes the operator when the curated fleet named this exact airframe', () => {
    // A callsign carrying no code we hold — the registration is what answers.
    const { logged } = departureOf({ callsign: 'ZZZ99', registration: 'G-XLEA' });
    assert.equal(logged.operator, 'British Airways');
  });

  it('writes "Unknown" rather than a registration-prefix guess', () => {
    // G- has exactly one A380 operator on file, so the live board infers British Airways and says
    // it is an inference. The log has nowhere to say that, so it must not say the name at all.
    const { logged, snapshot } = departureOf({ callsign: 'ZZZ99', registration: 'G-ZZZA' });
    assert.equal(logged.operator, 'Unknown');
    assert.notEqual(logged.operator, 'British Airways');
    // The registration is the observation, and it survives — that is what identifies the frame.
    assert.equal(logged.registration, 'G-ZZZA');

    // The live movement still carries the inference, marked, for the UI to qualify.
    const live = [...snapshot.departures, ...snapshot.ground][0];
    assert.ok(live !== undefined);
    assert.equal(live.airline.name, 'British Airways');
    assert.equal(live.airline.source, 'registration_prefix');
  });

  it('leaves the world-fleet operator empty rather than filing the frame under a guess', () => {
    const { snapshot } = departureOf({ callsign: 'ZZZ99', registration: 'G-ZZZA' });
    const global = snapshot.worldwide.find((aircraft) => aircraft.hex === 'bbb222');
    assert.ok(global !== undefined, 'the airframe is missing from the world fleet');
    assert.equal(global.operator, null);
  });
});

describe('the countdown stops when the evidence does', () => {
  /** An arrival on final from the east, 8 nm out and coming down. */
  function approaching(at: number, distanceNm: number): UpstreamAircraft {
    const position = destinationPoint(LHR, 90, distanceNm);
    return frame({
      hex: 'def456',
      callsign: 'BAW117',
      registration: 'G-XLEA',
      lat: position.lat,
      lon: position.lon,
      altitude: Math.round(300 * distanceNm),
      groundSpeed: 220,
      track: 270,
      verticalRate: -800,
      receivedAt: at,
    });
  }

  it('recomputes against the clock and gives up once the feed goes quiet', () => {
    const tracker = createReplayTracker({ dataDir: workDir() });
    let at = T0;
    let distance = 20;
    let live = tracker.feed([approaching(at, distance)], at);
    for (let i = 0; i < 8; i += 1) {
      at += 10_000;
      distance -= 0.6;
      live = tracker.feed([approaching(at, distance)], at);
    }

    const arrival = live.arrivals.find((movement) => movement.id === 'def456');
    assert.ok(arrival !== undefined, 'the approach never reached the arrivals board');
    assert.ok(arrival.eta.minutes !== null, 'a live approach should carry a countdown');
    assert.notEqual(arrival.eta.source, 'schedule', 'no ETA here comes from a timetable');
    const etaAt = arrival.eta.at;
    assert.ok(etaAt !== null);

    // The aircraft stops transmitting. Fifteen minutes later the ETA it was carrying is history.
    const later = tracker.feed([], at + 15 * 60_000);
    const held = later.arrivals.find((movement) => movement.id === 'def456');
    assert.ok(held !== undefined, 'the flight was dropped rather than coasted');
    assert.equal(held.coasting, true);
    assert.equal(held.eta.minutes, null, 'a coasting flight is still counting down');
    assert.equal(held.eta.at, null);
  });
});
