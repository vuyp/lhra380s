import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EARTH_RADIUS_NM,
  alongTrackNm,
  angularDelta,
  bearing,
  crossTrackNm,
  destinationPoint,
  distanceNm,
  normaliseBearing,
  normaliseLon,
  pointInPolygon,
} from '../src/geo.ts';
import type { LatLon } from '../src/geo.ts';

/** Heathrow ARP, per SPEC.md §5. */
const LHR: LatLon = { lat: 51.4706, lon: -0.4619 };
const JFK: LatLon = { lat: 40.6413, lon: -73.7781 };
const DXB: LatLon = { lat: 25.2532, lon: 55.3657 };
const SIN: LatLon = { lat: 1.3644, lon: 103.9915 };

/** 09L/27R thresholds, per SPEC.md §5. */
const THR_09L: LatLon = { lat: 51.4775, lon: -0.4845 };
const THR_27R: LatLon = { lat: 51.4779, lon: -0.4334 };

/** One degree of arc in nautical miles on our sphere. */
const NM_PER_DEGREE = (EARTH_RADIUS_NM * Math.PI) / 180; // 60.0345…

function close(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ±${tolerance}, got ${actual}`,
  );
}

test('distanceNm matches published great-circle distances', () => {
  // LHR–JFK is 5539 km = 2991 nm.
  close(distanceNm(LHR, JFK), 2991, 3, 'LHR→JFK');
  // LHR–DXB is 5498 km = 2969 nm.
  close(distanceNm(LHR, DXB), 2969, 3, 'LHR→DXB');
  // LHR–SIN is 10 875 km = 5872 nm — the longest A380 rotation into Heathrow.
  close(distanceNm(LHR, SIN), 5872, 6, 'LHR→SIN');
});

test('distanceNm is symmetric and zero for identical points', () => {
  assert.equal(distanceNm(LHR, LHR), 0);
  close(distanceNm(JFK, LHR), distanceNm(LHR, JFK), 1e-9, 'symmetry');
});

test('distanceNm handles one degree of latitude and the antimeridian', () => {
  // A degree of latitude is 60.03 nm on a sphere of radius 3440.065 nm.
  close(distanceNm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), NM_PER_DEGREE, 1e-6, 'one degree lat');
  // 179E to 179W is two degrees apart, not 358.
  close(distanceNm({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }), 2 * NM_PER_DEGREE, 1e-6, 'antimeridian');
  close(distanceNm({ lat: 60, lon: 179.9 }, { lat: 60, lon: -179.9 }), 0.2 * NM_PER_DEGREE * Math.cos((60 * Math.PI) / 180), 0.01, 'antimeridian at 60N');
});

test('distanceNm handles antipodal points without NaN', () => {
  const half = Math.PI * EARTH_RADIUS_NM;
  close(distanceNm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }), half, 1e-6, 'antipodal on equator');
  close(distanceNm({ lat: 90, lon: 0 }, { lat: -90, lon: 0 }), half, 1e-6, 'pole to pole');
});

test('bearing gives the published initial great-circle azimuths', () => {
  // The LHR–JFK great circle departs to the north-west, curving over Newfoundland.
  close(bearing(LHR, JFK), 288, 1, 'LHR→JFK');
  close(bearing(LHR, DXB), 100, 1, 'LHR→DXB');
  // The reciprocal of a long great circle is not the reverse bearing.
  close(bearing(JFK, LHR), 51.2, 1, 'JFK→LHR');
});

test('bearing gives the cardinal directions', () => {
  close(bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 0, 1e-9, 'north');
  close(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 90, 1e-9, 'east');
  close(bearing({ lat: 0, lon: 0 }, { lat: -1, lon: 0 }), 180, 1e-9, 'south');
  close(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: -1 }), 270, 1e-9, 'west');
});

test('bearing of identical points is 0, never NaN', () => {
  assert.equal(bearing(LHR, LHR), 0);
  assert.equal(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }), 0);
});

test('bearing is always in [0, 360)', () => {
  for (let lat = -80; lat <= 80; lat += 20) {
    for (let lon = -180; lon < 180; lon += 30) {
      const b = bearing(LHR, { lat, lon });
      assert.ok(b >= 0 && b < 360, `bearing to ${lat},${lon} out of range: ${b}`);
    }
  }
});

test('bearing along the 09L/27R centreline matches the published 89.7 degrees', () => {
  // SPEC.md quotes true bearings of 89.7 / 269.7 for the Heathrow runways.
  close(bearing(THR_09L, THR_27R), 89.7, 0.6, '09L→27R');
  close(bearing(THR_27R, THR_09L), 269.7, 0.6, '27R→09L');
  // The 09L/27R pavement is 3902 m = 2.11 nm; threshold to threshold is a little less.
  close(distanceNm(THR_09L, THR_27R), 1.91, 0.1, 'runway length');
});

test('angularDelta is the shortest way round, 0..180', () => {
  assert.equal(angularDelta(10, 350), 20);
  assert.equal(angularDelta(350, 10), 20);
  assert.equal(angularDelta(0, 180), 180);
  assert.equal(angularDelta(270, 90), 180);
  assert.equal(angularDelta(89.7, 89.7), 0);
  close(angularDelta(269.7, 270), 0.3, 1e-9, 'near-identical headings');
  // Unnormalised inputs are handled.
  assert.equal(angularDelta(-10, 10), 20);
  assert.equal(angularDelta(730, 10), 0);
  // A westerly approach track versus the easterly runway: 180 apart.
  close(angularDelta(269.7, 89.7), 180, 1e-9, 'reciprocal runway');
});

test('destinationPoint round-trips with distanceNm and bearing', () => {
  for (const brg of [0, 45, 89.7, 180, 269.7, 350]) {
    for (const dist of [1, 25, 250, 2500]) {
      const p = destinationPoint(LHR, brg, dist);
      close(distanceNm(LHR, p), dist, 1e-6, `distance back from ${brg}/${dist}`);
      close(angularDelta(bearing(LHR, p), brg), 0, 1e-6, `bearing back from ${brg}/${dist}`);
    }
  }
});

test('destinationPoint moves the expected way on the equator', () => {
  const east = destinationPoint({ lat: 0, lon: 0 }, 90, NM_PER_DEGREE);
  close(east.lat, 0, 1e-9, 'stays on the equator');
  close(east.lon, 1, 1e-9, 'one degree east');

  const north = destinationPoint({ lat: 0, lon: 0 }, 0, NM_PER_DEGREE);
  close(north.lat, 1, 1e-9, 'one degree north');
  close(north.lon, 0, 1e-9, 'same meridian');
});

test('destinationPoint normalises longitude across the antimeridian', () => {
  const p = destinationPoint({ lat: 0, lon: 179.5 }, 90, 60);
  assert.ok(p.lon >= -180 && p.lon <= 180, `longitude not normalised: ${p.lon}`);
  close(p.lon, -179.5006, 0.001, 'wrapped past 180');

  const q = destinationPoint({ lat: 0, lon: -179.5 }, 270, 60);
  assert.ok(q.lon >= -180 && q.lon <= 180, `longitude not normalised: ${q.lon}`);
  close(q.lon, 179.5006, 0.001, 'wrapped past -180');
});

test('destinationPoint with zero distance returns the origin', () => {
  const p = destinationPoint(LHR, 123, 0);
  close(p.lat, LHR.lat, 1e-12, 'lat');
  close(p.lon, LHR.lon, 1e-12, 'lon');
});

test('crossTrackNm is signed: positive to the right of the track', () => {
  const start: LatLon = { lat: 0, lon: 0 };
  const end: LatLon = { lat: 1, lon: 0 }; // due north
  // 0.1 degrees east of a northbound track is 6.00 nm to the right.
  close(crossTrackNm({ lat: 0.5, lon: 0.1 }, start, end), 0.1 * NM_PER_DEGREE, 0.01, 'east/right');
  close(crossTrackNm({ lat: 0.5, lon: -0.1 }, start, end), -0.1 * NM_PER_DEGREE, 0.01, 'west/left');
  close(crossTrackNm({ lat: 0.5, lon: 0 }, start, end), 0, 1e-9, 'on track');
});

test('crossTrackNm measures displacement from the extended runway centreline', () => {
  // Two miles out on the 27R centreline: essentially zero cross-track.
  const onCentreline = destinationPoint(THR_27R, 89.7, 2);
  const base = crossTrackNm(onCentreline, THR_09L, THR_27R);
  close(base, 0, 0.05, 'on the centreline');

  // Half a mile to the north of that point, i.e. to the left of an eastbound
  // track: half a mile of cross-track, negative.
  const offset = destinationPoint(onCentreline, 359.7, 0.5);
  const displaced = crossTrackNm(offset, THR_09L, THR_27R);
  assert.ok(displaced < base, `north of an eastbound track must be negative: ${displaced}`);
  close(base - displaced, 0.5, 0.02, 'displaced 0.5 nm');
});

test('crossTrackNm and alongTrackNm degrade gracefully on degenerate input', () => {
  assert.equal(crossTrackNm(LHR, LHR, JFK), 0);
  assert.equal(crossTrackNm(JFK, LHR, LHR), 0);
  assert.equal(alongTrackNm(LHR, LHR, JFK), 0);
  assert.equal(alongTrackNm(JFK, LHR, LHR), 0);
});

test('alongTrackNm projects onto the path and signs points behind the start', () => {
  const start: LatLon = { lat: 0, lon: 0 };
  const end: LatLon = { lat: 1, lon: 0 };
  close(alongTrackNm({ lat: 0.5, lon: 0.01 }, start, end), 0.5 * NM_PER_DEGREE, 0.05, 'half way');
  close(alongTrackNm({ lat: -0.5, lon: 0 }, start, end), -0.5 * NM_PER_DEGREE, 0.05, 'behind the start');
  close(alongTrackNm({ lat: 2, lon: 0 }, start, end), 2 * NM_PER_DEGREE, 0.05, 'beyond the end');
  close(alongTrackNm(start, start, end), 0, 1e-9, 'at the start');
});

test('alongTrackNm places a 10 nm final approach fix correctly', () => {
  // 10 nm east of the 27R threshold, i.e. on final for landing west.
  const tenMileFinal = destinationPoint(THR_27R, 89.7, 10);
  // Measured along the 09L→27R axis, that is the runway length plus 10 nm.
  const runwayLength = distanceNm(THR_09L, THR_27R);
  close(alongTrackNm(tenMileFinal, THR_09L, THR_27R), runwayLength + 10, 0.05, 'along the axis');
});

test('pointInPolygon detects the Heathrow perimeter', () => {
  // A rectangle comfortably containing the airfield, as [lat, lon] pairs.
  const boundary: Array<[number, number]> = [
    [51.4530, -0.4900],
    [51.4530, -0.4200],
    [51.4900, -0.4200],
    [51.4900, -0.4900],
  ];
  assert.equal(pointInPolygon(LHR, boundary), true);
  assert.equal(pointInPolygon(THR_09L, boundary), true);
  assert.equal(pointInPolygon(THR_27R, boundary), true);
  // Terminal 5 car park is inside; Windsor Castle and central London are not.
  assert.equal(pointInPolygon({ lat: 51.4820, lon: -0.4300 }, boundary), true);
  assert.equal(pointInPolygon({ lat: 51.4839, lon: -0.6044 }, boundary), false);
  assert.equal(pointInPolygon({ lat: 51.5074, lon: -0.1278 }, boundary), false);
  // Just outside each edge.
  assert.equal(pointInPolygon({ lat: 51.4529, lon: -0.4600 }, boundary), false);
  assert.equal(pointInPolygon({ lat: 51.4901, lon: -0.4600 }, boundary), false);
  assert.equal(pointInPolygon({ lat: 51.4700, lon: -0.4901 }, boundary), false);
  assert.equal(pointInPolygon({ lat: 51.4700, lon: -0.4199 }, boundary), false);
});

test('pointInPolygon handles concave shapes and degenerate rings', () => {
  // An L-shape: the notch in the top right must read as outside.
  const lShape: Array<[number, number]> = [
    [0, 0],
    [0, 4],
    [2, 4],
    [2, 2],
    [4, 2],
    [4, 0],
  ];
  assert.equal(pointInPolygon({ lat: 1, lon: 1 }, lShape), true);
  assert.equal(pointInPolygon({ lat: 1, lon: 3 }, lShape), true);
  assert.equal(pointInPolygon({ lat: 3, lon: 1 }, lShape), true);
  assert.equal(pointInPolygon({ lat: 3, lon: 3 }, lShape), false);
  assert.equal(pointInPolygon({ lat: 5, lon: 5 }, lShape), false);

  assert.equal(pointInPolygon({ lat: 1, lon: 1 }, []), false);
  assert.equal(pointInPolygon({ lat: 1, lon: 1 }, [[0, 0], [0, 1]]), false);
  assert.equal(pointInPolygon({ lat: Number.NaN, lon: 1 }, lShape), false);
});

test('pointInPolygon works across the antimeridian', () => {
  const box: Array<[number, number]> = [
    [-1, 179],
    [-1, -179],
    [1, -179],
    [1, 179],
  ];
  assert.equal(pointInPolygon({ lat: 0, lon: 180 }, box), true);
  assert.equal(pointInPolygon({ lat: 0, lon: -179.5 }, box), true);
  assert.equal(pointInPolygon({ lat: 0, lon: 179.5 }, box), true);
  assert.equal(pointInPolygon({ lat: 0, lon: 178 }, box), false);
  assert.equal(pointInPolygon({ lat: 0, lon: 0 }, box), false);
});

test('normalisation helpers wrap correctly', () => {
  assert.equal(normaliseBearing(0), 0);
  assert.equal(normaliseBearing(360), 0);
  assert.equal(normaliseBearing(-90), 270);
  assert.equal(normaliseBearing(450), 90);
  assert.equal(normaliseLon(-0.4619), -0.4619);
  assert.equal(normaliseLon(190), -170);
  assert.equal(normaliseLon(-190), 170);
  // The antimeridian normalises to the -180 branch; both are the same meridian.
  assert.equal(Math.abs(normaliseLon(180)), 180);
});
