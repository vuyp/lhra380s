/**
 * The arrivals board, scored against a recording of the real feed.
 *
 * `looksLikeArrival` can be unit-tested on synthetic single frames, and arrival.test.ts does that.
 * It is not enough. The decision that matters is made over a sequence — an aircraft is boarded
 * because of what it has been doing for the last twenty minutes, not because of one position — and
 * the two cases that have to be told apart look identical in any single frame.
 *
 * So these fixtures are real. Both tracks below were recorded off api.adsb.lol/v2/type/A388 on a
 * Friday evening at Heathrow, thinned to a few dozen positions each, and they are replayed through
 * the production state machine by the same ingest path the live poller uses.
 *
 *   A6-EUF / UAE70M — an Emirates A380 inbound to Heathrow. Held FL400 to 150 nm, descended,
 *     tracked 38 nm wide of the field for the next 70 nm, then turned onto the arrival and landed.
 *   D-AIMC / DLH3Y  — a Lufthansa A380 crossing southern England at FL360, closing on Heathrow,
 *     pointing within 8° of it, passing 18 nm from the field without ever leaving cruise.
 *
 * The second one is the whole problem: for most of the recording DLH3Y is *better* aimed at
 * Heathrow than the aeroplane that actually landed there.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createReplayTracker, type ArrivalGrade } from '../src/tracker.ts';
import type { UpstreamAircraft } from '../src/upstream.ts';
import { crossTrackNm, destinationPoint, distanceNm, type LatLon } from '../src/geo.ts';

const LHR: LatLon = { lat: 51.4706, lon: -0.4619 };

/** One recorded position: [t+seconds, lat, lon, altitudeFt, groundSpeedKt, track, verticalRateFpm, onGround]. */
type Fix = [number, number, number, number | null, number | null, number | null, number | null, boolean];

/* ------------------------------------------------------------------ *
 * Recorded fixtures
 * ------------------------------------------------------------------ */

// LANDED — A6-EUF UAE70M, 41 positions,
// 180 nm out down to 0.4 nm.
const UAE70M_ARRIVAL: Fix[] = [
  // t+s      lat        lon     alt    gs   track     vr  onGround
  [    0,  51.1772,    4.3067,  40000,  443,  289.8,      0, false],
  [   61,  51.2192,    4.1202,  40000,  442,  289.6,      0, false],
  [  120,  51.2595,    3.9394,  40000,  441,  289.5,      0, false],
  [  180,  51.3002,    3.7552,  40000,  442,  289.3,      0, false],
  [  241,  51.3409,    3.5694,  40000,  442,  289.3,      0, false],
  [  300,  51.3809,    3.3848,  39100,  450,  288.9,  -1024, false],
  [  360,  51.4212,    3.1979,  38150,  448,    289,   -960, false],
  [  421,  51.4621,    3.0057,  36650,  450,  288.8,  -1536, false],
  [  483,  51.5028,    2.8131,  35050,  439,  288.6,  -1536, false],
  [  561,  51.5521,     2.577,  33075,  427,  288.4,  -1536, false],
  [  620,  51.5887,    2.3999,  31625,  417,  288.3,  -1408, false],
  [  681,  51.6244,    2.2259,  30175,  408,    288,  -1408, false],
  [  741,  51.6594,    2.0532,  28725,  397,  288.1,  -1472, false],
  [  801,  51.6926,    1.8885,  27325,  387,  287.9,  -1408, false],
  [  861,   51.725,    1.7263,  25900,  379,  287.8,  -1600, false],
  [  921,  51.7446,    1.5627,  24925,  375,  262.2,  -1216, false],
  [  982,  51.7331,    1.3873,  22475,  385,  264.5,  -1664, false],
  [ 1040,  51.7228,    1.2276,  19200,  357,  263.7,  -3456, false],
  [ 1101,  51.7121,    1.0694,  17025,  358,  263.8,  -1024, false],
  [ 1160,  51.7014,    0.9131,  16100,  337,  263.7,   -960, false],
  [ 1221,  51.6916,    0.7724,  15150,  305,  263.4,  -1408, false],
  [ 1281,  51.6822,    0.6406,  14050,  293,  263.5,  -1088, false],
  [ 1341,  51.6728,    0.5113,  12750,  289,  263.2,  -1024, false],
  [ 1401,  51.6637,    0.3862,  11900,  267,  263.3,   -448, false],
  [ 1461,  51.6554,    0.2749,  11150,  250,  263.1,  -1920, false],
  [ 1521,   51.647,    0.1632,   9425,  238,  263.2,  -1984, false],
  [ 1581,  51.6488,    0.0552,   7900,  248,  271.4,   -960, false],
  [ 1641,  51.6494,   -0.0563,   7025,  251,  270.7,   -320, false],
  [ 1701,  51.6504,   -0.1669,   7000,  248,  271.1,      0, false],
  [ 1761,  51.6312,   -0.2644,   7000,  243,  201.3,    -64, false],
  [ 1821,  51.5847,   -0.2087,   6625,  241,  104.2,   -896, false],
  [ 1881,  51.5678,   -0.1045,   5500,  244,  104.7,  -1600, false],
  [ 1941,  51.5389,   -0.0056,   4550,  244,  120.6,   -768, false],
  [ 2002,  51.4898,   -0.0014,   4000,  193,  236.2,   -256, false],
  [ 2061,  51.4668,    -0.076,   3975,  191,  262.5,     64, false],
  [ 2120,  51.4661,   -0.1544,   3425,  166,    271,   -704, false],
  [ 2192,  51.4654,   -0.2505,   2200,  172,    270,   -640, false],
  [ 2251,  51.4653,   -0.3178,   1425,  140,    270,   -704, false],
  [ 2311,  51.4651,   -0.3782,    725,  135,  270.4,   -640, false],
  [ 2371,  51.4649,   -0.4395,     25,  139,  269.2,   -192, false],
  [ 2412,  51.4649,   -0.4646,   null,   27,    270,   -256, true],
];
// hex 89645b  callsign UAE70M  reg A6-EUF

// OVERFLIGHT — D-AIMC DLH3Y, 30 positions: in from 106 nm, closest approach 17.9 nm,
// back out to 123.5 nm. FL360 throughout, never more than 25 ft off its cruise level.
const DLH3Y_OVERFLIGHT: Fix[] = [
  // t+s      lat        lon     alt    gs   track     vr  onGround
  [    0,  51.3996,    2.3648,  36025,  469,  280.9,    -64, false],
  [   61,  51.4249,    2.1553,  36000,  475,  281.1,      0, false],
  [  120,  51.4449,    1.9501,  36000,  474,  277.5,      0, false],
  [  181,  51.4633,    1.7424,  36000,  472,  278.3,      0, false],
  [  241,  51.4821,    1.5341,  36000,  471,  278.1,      0, false],
  [  301,  51.5002,    1.3285,  36000,  470,    278,      0, false],
  [  361,  51.5179,    1.1227,  36000,  467,  277.8,      0, false],
  [  421,  51.5354,    0.9162,  36000,  469,  277.6,      0, false],
  [  483,  51.5668,    0.7054,  36000,  472,  287.5,      0, false],
  [  561,  51.6156,    0.4452,  36000,  469,  286.7,      0, false],
  [  621,  51.6526,    0.2469,  36000,  466,  286.6,      0, false],
  [  680,  51.6891,    0.0485,  36000,  466,  286.4,      0, false],
  [  741,  51.7258,   -0.1529,  36000,  467,  286.2,      0, false],
  [  801,  51.7617,   -0.3523,  36000,  467,    286,      0, false],
  [  861,   51.797,   -0.5508,  36000,  464,  285.9,      0, false],
  [  921,  51.8322,   -0.7509,  36000,  463,  285.8,      0, false],
  [  982,  51.8676,   -0.9533,  36000,  465,  287.3,      0, false],
  [ 1040,  51.9177,   -1.1401,  36000,  472,  295.4,      0, false],
  [ 1101,  51.9743,   -1.3337,  36000,  472,  295.3,      0, false],
  [ 1160,  52.0296,   -1.5243,  36000,  470,  295.2,      0, false],
  [ 1221,  52.0768,   -1.7205,  36000,  463,  288.1,      0, false],
  [ 1281,   52.118,   -1.9177,  36000,  465,  288.7,      0, false],
  [ 1341,  52.1589,    -2.116,  36000,  462,  288.6,      0, false],
  [ 1402,  52.1995,   -2.3153,  36000,  459,  288.3,     64, false],
  [ 1461,  52.2388,   -2.5092,  36000,  459,  288.2,      0, false],
  [ 1521,  52.2783,   -2.7066,  36000,  456,    288,      0, false],
  [ 1581,  52.3173,   -2.9032,  36000,  456,  287.9,      0, false],
  [ 1641,  52.3555,   -3.0984,  36000,  452,  287.6,      0, false],
  [ 1701,  52.3931,   -3.2921,  36000,  450,  287.6,      0, false],
  [ 1742,  52.4186,   -3.4244,  36000,  451,  287.4,      0, false],
];
// hex 3c65a3  callsign DLH3Y  reg D-AIMC

/* ------------------------------------------------------------------ *
 * Replay harness
 * ------------------------------------------------------------------ */

function aircraft(hex: string, callsign: string, registration: string, fix: Fix, at: number): UpstreamAircraft {
  const [, lat, lon, altitude, groundSpeed, track, verticalRate, onGround] = fix;
  return {
    hex,
    callsign,
    registration,
    type: 'A388',
    lat,
    lon,
    altitude: onGround ? null : altitude,
    onGround,
    groundKnown: true,
    groundSpeed,
    track,
    verticalRate,
    squawk: null,
    ageSeconds: 0,
    receivedAt: at,
  };
}

interface ReplayResult {
  /** Distance in nm at which the aircraft first appeared on the arrivals board, or null. */
  boardedAtNm: number | null;
  /** Every phase the movement was ever given. */
  phases: Set<string>;
  /** The strongest arrival grade reached. */
  bestGrade: ArrivalGrade;
  /** eta.source values the movement carried while on the arrivals board. */
  etaSources: Set<string>;
  /** Number of samples it spent on the arrivals board. */
  framesOnBoard: number;
  /**
   * Samples where the aircraft vanished from the board after having been boarded, while still
   * airborne. Any of these is a movement blinking out from under the spotter.
   */
  dropOuts: number;
}

const GRADE_RANK: Record<ArrivalGrade, number> = { none: 0, likely: 1, confirmed: 2 };

/** Replay one recorded track through the production state machine, alone in the sky. */
function replay(hex: string, callsign: string, registration: string, track: Fix[]): ReplayResult {
  const tracker = createReplayTracker({ dataDir: mkdtempSync(join(tmpdir(), 'whale-replay-')) });
  const t0 = 1_786_000_000_000;

  const result: ReplayResult = {
    boardedAtNm: null,
    phases: new Set(),
    bestGrade: 'none',
    etaSources: new Set(),
    framesOnBoard: 0,
    dropOuts: 0,
  };

  for (const fix of track) {
    const at = t0 + fix[0] * 1000;
    const snapshot = tracker.feed([aircraft(hex, callsign, registration, fix, at)], at);

    for (const movement of [...snapshot.arrivals, ...snapshot.departures, ...snapshot.ground]) {
      result.phases.add(movement.phase);
    }
    const arrival = snapshot.arrivals.find((m) => m.id === hex);
    if (arrival === undefined) {
      // Absent from the board. That is only acceptable before it was ever boarded, or once it is
      // on the ground and has moved to the ground list.
      if (result.boardedAtNm !== null && !fix[7]) result.dropOuts += 1;
      continue;
    }

    result.framesOnBoard += 1;
    result.etaSources.add(arrival.eta.source);
    const grade = tracker.gradeOf(hex);
    if (GRADE_RANK[grade] > GRADE_RANK[result.bestGrade]) result.bestGrade = grade;
    if (result.boardedAtNm === null) {
      result.boardedAtNm = distanceNm({ lat: fix[1], lon: fix[2] }, LHR);
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

describe('replay — the Emirates A380 that actually landed', () => {
  const result = replay('89645b', 'UAE70M', 'A6-EUF', UAE70M_ARRIVAL);

  it('is on the board from top of descent, not from short final', () => {
    assert.notEqual(result.boardedAtNm, null, 'the arrival never reached the board at all');
    const boarded = result.boardedAtNm ?? 0;
    assert.ok(
      boarded >= 100,
      `boarded at ${boarded.toFixed(0)} nm — a spotter needs this from top of descent, ` +
        'not four minutes before touchdown',
    );
  });

  it('follows it all the way down to the runway', () => {
    assert.ok(result.phases.has('inbound'), 'never went inbound');
    assert.ok(result.phases.has('approach'), 'never reached the approach');
    assert.ok(result.phases.has('landed'), 'never saw it touch down');
  });

  it('holds it on the board through the downwind leg, when it is pointing away', () => {
    // Vectored onto a downwind at 11 nm, this aircraft spent four minutes tracking 104° and 201° —
    // straight away from Heathrow — before turning base. Re-running the intent test frame by frame
    // would drop it off the board at exactly the moment a spotter was walking to the fence.
    assert.equal(
      result.dropOuts,
      0,
      `vanished from the board ${result.dropOuts} time(s) after being boarded`,
    );
  });

  it('states how sure it is, and firms up as the evidence arrives', () => {
    // The same flight is boarded unconfirmed at cruise and confirmed once it is established on
    // the descent. A confidence field that never changes is decoration, not honesty.
    assert.ok(result.etaSources.has('inferred'), 'never showed as unconfirmed');
    assert.ok(result.etaSources.has('observed'), 'never firmed up to observed');
    assert.equal(result.bestGrade, 'confirmed');
  });
});

describe('replay — the Lufthansa A380 that crossed overhead at cruise', () => {
  const result = replay('3c65a3', 'DLH3Y', 'D-AIMC', DLH3Y_OVERFLIGHT);

  it('never reaches the arrivals board, at any range', () => {
    assert.equal(
      result.boardedAtNm,
      null,
      'a Frankfurt–US A380 at FL360 was shown as arriving at Heathrow',
    );
    assert.equal(result.framesOnBoard, 0);
  });

  it('is never even graded as a possible arrival', () => {
    assert.equal(result.bestGrade, 'none');
  });
});

describe('replay — why the approach corridor cannot be the discriminator', () => {
  /** Perpendicular distance from Heathrow to the great circle this fix is flying, nm. */
  function offsetNm(fix: Fix): number {
    const where: LatLon = { lat: fix[1], lon: fix[2] };
    const track = fix[5];
    if (track === null) return Number.POSITIVE_INFINITY;
    const distance = distanceNm(where, LHR);
    const ahead = destinationPoint(where, track, Math.max(distance, 1));
    return Math.abs(crossTrackNm(LHR, where, ahead));
  }

  /** The fixes of a track that lie in a given range band from Heathrow. */
  function inBand(track: Fix[], lo: number, hi: number): Fix[] {
    return track.filter((f) => {
      const d = distanceNm({ lat: f[1], lon: f[2] }, LHR);
      return d >= lo && d < hi;
    });
  }

  it('aims the overflight closer to the field than the en-route arrival ever is', () => {
    // This is the measurement that decides the whole design.
    //
    // Across its entire crossing the aeroplane that was NOT coming to Heathrow never pointed more
    // than ~19 nm wide of it. The aeroplane that landed there was, for the whole of its en-route
    // descent, tracking nearly 40 nm wide — still on the airway that would only turn it towards
    // the field at 80 nm.
    //
    // So any corridor tight enough to reject the overflight would have thrown the real arrival off
    // the board for the entire hour it was worth showing. The corridor is a sanity bound only; the
    // descent is what separates them. If this assertion ever reverses, a tighter corridor becomes
    // viable and this design should be revisited.
    const overflight = inBand(DLH3Y_OVERFLIGHT, 0, 150).map(offsetNm);
    // Beyond 90 nm the arrival has not yet been turned onto the approach.
    const arrivalEnRoute = inBand(UAE70M_ARRIVAL, 90, 180).map(offsetNm);

    assert.ok(overflight.length > 0 && arrivalEnRoute.length > 0, 'fixtures must cover both bands');

    const worstOverflight = Math.max(...overflight);
    const bestArrival = Math.min(...arrivalEnRoute);
    assert.ok(
      worstOverflight < bestArrival,
      `overflight offset peaked at ${worstOverflight.toFixed(1)} nm while the en-route arrival ` +
        `never got closer than ${bestArrival.toFixed(1)} nm`,
    );
  });

  it('separates them on descent instead, which is unambiguous', () => {
    // The overflight holds one level across the whole crossing; the arrival leaves its cruise.
    const overflightAlts = DLH3Y_OVERFLIGHT.map((f) => f[3]).filter((a): a is number => a !== null);
    const arrivalAlts = UAE70M_ARRIVAL.map((f) => f[3]).filter((a): a is number => a !== null);

    const overflightRange = Math.max(...overflightAlts) - Math.min(...overflightAlts);
    const arrivalRange = Math.max(...arrivalAlts) - Math.min(...arrivalAlts);

    assert.ok(overflightRange < 1_000, `overflight varied by ${overflightRange} ft — expected level flight`);
    assert.ok(arrivalRange > 20_000, `arrival only descended ${arrivalRange} ft`);
  });
});
