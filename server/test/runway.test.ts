import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveRunwayConfig, predictArrivalRunway, predictDepartureRunway } from '../src/runway.ts';
import { destinationPoint } from '../src/geo.ts';
import type { LatLon } from '../src/geo.ts';
import type { UpstreamAircraft } from '../src/upstream.ts';
import type { RunwayConfig, Weather } from '../../shared/types.ts';

/* ------------------------------------------------------------------ *
 * Fixtures — Heathrow geometry per SPEC.md §5 / data/airport.json
 * ------------------------------------------------------------------ */

const THR_27R: LatLon = { lat: 51.477675, lon: -0.433283 };
const THR_27L: LatLon = { lat: 51.46495, lon: -0.4341 };
const THR_09L: LatLon = { lat: 51.4775, lon: -0.485 };
const THR_09R: LatLon = { lat: 51.464792, lon: -0.482314 };

const BRG_27 = 269.71;
const BRG_09 = 89.67;

const NOW = Date.UTC(2026, 6, 14, 13, 0, 0);

let serial = 0;

function aircraft(partial: Partial<UpstreamAircraft>): UpstreamAircraft {
  serial += 1;
  return {
    hex: partial.hex ?? `4ca${serial.toString(16).padStart(3, '0')}`,
    callsign: partial.callsign ?? null,
    registration: partial.registration ?? null,
    type: partial.type ?? 'A388',
    lat: partial.lat ?? null,
    lon: partial.lon ?? null,
    altitude: partial.altitude ?? null,
    onGround: partial.onGround ?? false,
    groundKnown: partial.groundKnown ?? true,
    groundSpeed: partial.groundSpeed ?? null,
    track: partial.track ?? null,
    verticalRate: partial.verticalRate ?? null,
    squawk: partial.squawk ?? null,
    ageSeconds: partial.ageSeconds ?? 2,
    receivedAt: partial.receivedAt ?? NOW,
  };
}

/**
 * An aircraft established on final for a runway, `milesOut` nm down its extended centreline.
 * `offsetNm` displaces it sideways (positive = right of the approach path).
 */
function onFinal(
  threshold: LatLon,
  runwayBearing: number,
  milesOut: number,
  offsetNm = 0,
): UpstreamAircraft {
  const reciprocal = (runwayBearing + 180) % 360;
  const centreline = destinationPoint(threshold, reciprocal, milesOut);
  const point =
    offsetNm === 0
      ? centreline
      : destinationPoint(centreline, (runwayBearing + 90) % 360, offsetNm);
  return aircraft({
    lat: point.lat,
    lon: point.lon,
    // Roughly a 3° glideslope: 320 ft per nm, plus the 83 ft field elevation.
    altitude: Math.round(milesOut * 320 + 83),
    groundSpeed: 150,
    track: runwayBearing,
    verticalRate: -700,
  });
}

/** An aircraft climbing away off a runway, `milesOut` nm beyond the threshold it started from. */
function onDeparture(threshold: LatLon, runwayBearing: number, milesOut: number): UpstreamAircraft {
  const point = destinationPoint(threshold, runwayBearing, milesOut);
  return aircraft({
    lat: point.lat,
    lon: point.lon,
    altitude: Math.round(milesOut * 500 + 200),
    groundSpeed: 190,
    track: runwayBearing,
    verticalRate: 2600,
  });
}

function metar(windDirection: number | null, windSpeed: number | null, extra: Partial<Weather> = {}): Weather {
  return {
    raw: extra.raw ?? null,
    windDirection,
    windSpeed,
    windGust: extra.windGust ?? null,
    temperature: extra.temperature ?? 18,
    visibility: extra.visibility ?? '10+',
    cloudCover: extra.cloudCover ?? 'FEW',
    qnh: extra.qnh ?? 1013,
    observedAt: extra.observedAt ?? NOW - 4 * 60_000,
  };
}

/* ------------------------------------------------------------------ *
 * deriveRunwayConfig — direction from traffic
 * ------------------------------------------------------------------ */

test('three arrivals on the 27R centreline give confident westerly ops', () => {
  const traffic = [
    onFinal(THR_27R, BRG_27, 4),
    onFinal(THR_27R, BRG_27, 7),
    onFinal(THR_27R, BRG_27, 10),
  ];
  const config = deriveRunwayConfig(traffic, null, NOW);

  assert.equal(config.direction, 'westerly');
  assert.deepEqual(config.landing, ['27R']);
  assert.deepEqual(config.departing, ['27L']);
  assert.equal(config.sampleSize, 3);
  assert.ok(config.confidence > 0.6, `expected confident derivation, got ${config.confidence}`);
  assert.equal(config.summary, 'Westerly ops · landing 27R · departing 27L');
  assert.equal(config.updatedAt, NOW);
});

test('arrivals on the 09L centreline give easterly ops with 09R departing', () => {
  const traffic = [onFinal(THR_09L, BRG_09, 5), onFinal(THR_09L, BRG_09, 9)];
  const config = deriveRunwayConfig(traffic, null, NOW);

  assert.equal(config.direction, 'easterly');
  assert.deepEqual(config.landing, ['09L']);
  assert.deepEqual(config.departing, ['09R']);
  assert.equal(config.sampleSize, 2);
  assert.ok(config.confidence > 0.4);
  assert.equal(config.summary, 'Easterly ops · landing 09L · departing 09R');
});

test('arrivals are attributed to the nearer centreline, not both runways', () => {
  // 27L and 27R are only 0.77 nm apart, well inside the 2 nm approach corridor, so a naive
  // implementation credits an aircraft to both.
  const config = deriveRunwayConfig([onFinal(THR_27L, BRG_27, 6)], null, NOW);
  assert.deepEqual(config.landing, ['27L']);
  assert.deepEqual(config.departing, ['27R']);
});

test('landings on one runway and departures on the other agree on the assignment', () => {
  const traffic = [
    onFinal(THR_27L, BRG_27, 5),
    onFinal(THR_27L, BRG_27, 8),
    onDeparture(THR_27R, BRG_27, 3),
  ];
  const config = deriveRunwayConfig(traffic, null, NOW);

  assert.equal(config.direction, 'westerly');
  assert.deepEqual(config.landing, ['27L']);
  assert.deepEqual(config.departing, ['27R']);
  assert.equal(config.sampleSize, 3);
});

test('departures alone fix the direction but leave the assignment to the departure evidence', () => {
  const config = deriveRunwayConfig([onDeparture(THR_09R, BRG_09, 4)], null, NOW);

  assert.equal(config.direction, 'easterly');
  assert.deepEqual(config.departing, ['09R']);
  assert.deepEqual(config.landing, ['09L']);
  // A single departure is thin evidence.
  assert.ok(config.confidence < 0.7, `single departure should not be certain, got ${config.confidence}`);
});

test('confidence rises with the size of an agreeing sample', () => {
  const one = deriveRunwayConfig([onFinal(THR_27R, BRG_27, 6)], null, NOW);
  const four = deriveRunwayConfig(
    [
      onFinal(THR_27R, BRG_27, 4),
      onFinal(THR_27R, BRG_27, 6),
      onFinal(THR_27R, BRG_27, 8),
      onFinal(THR_27R, BRG_27, 10),
    ],
    null,
    NOW,
  );

  assert.equal(one.direction, 'westerly');
  assert.equal(four.direction, 'westerly');
  assert.ok(
    four.confidence > one.confidence,
    `four aircraft (${four.confidence}) should beat one (${one.confidence})`,
  );
  assert.ok(four.confidence <= 1 && one.confidence >= 0);
});

test('a dissenting aircraft lowers confidence without flipping the answer', () => {
  const agreeing = [
    onFinal(THR_27R, BRG_27, 4),
    onFinal(THR_27R, BRG_27, 7),
    onFinal(THR_27R, BRG_27, 10),
  ];
  const clean = deriveRunwayConfig(agreeing, null, NOW);
  const muddied = deriveRunwayConfig([...agreeing, onDeparture(THR_09L, BRG_09, 3)], null, NOW);

  assert.equal(muddied.direction, 'westerly');
  assert.ok(
    muddied.confidence < clean.confidence,
    `dissent should cost confidence: ${muddied.confidence} vs ${clean.confidence}`,
  );
  assert.equal(muddied.sampleSize, 4);
});

/* ------------------------------------------------------------------ *
 * deriveRunwayConfig — what gets ignored
 * ------------------------------------------------------------------ */

test('high overflights and distant traffic are not evidence', () => {
  const overflight = onFinal(THR_27R, BRG_27, 8);
  overflight.altitude = 33_000;
  overflight.verticalRate = 0;

  const distant = onFinal(THR_27R, BRG_27, 40);

  const config = deriveRunwayConfig([overflight, distant], null, NOW);
  assert.equal(config.direction, 'unknown');
  assert.equal(config.sampleSize, 0);
});

test('an aircraft crossing the approach at right angles is not an arrival', () => {
  const crossing = onFinal(THR_27R, BRG_27, 6);
  crossing.track = 0;
  const config = deriveRunwayConfig([crossing], null, NOW);
  assert.equal(config.direction, 'unknown');
  assert.equal(config.sampleSize, 0);
});

test('an aircraft well off the centreline is not an arrival', () => {
  const wide = onFinal(THR_27R, BRG_27, 8, 5);
  const config = deriveRunwayConfig([wide], null, NOW);
  assert.equal(config.sampleSize, 0);
});

test('the same airframe listed twice votes once', () => {
  const first = onFinal(THR_27R, BRG_27, 5);
  const second = onFinal(THR_27R, BRG_27, 5.1);
  second.hex = first.hex;
  const config = deriveRunwayConfig([first, second], null, NOW);
  assert.equal(config.sampleSize, 1);
});

/* ------------------------------------------------------------------ *
 * deriveRunwayConfig — no traffic
 * ------------------------------------------------------------------ */

test('no traffic and no weather is honestly unknown', () => {
  const config = deriveRunwayConfig([], null, NOW);

  assert.equal(config.direction, 'unknown');
  assert.equal(config.confidence, 0);
  assert.deepEqual(config.landing, []);
  assert.deepEqual(config.departing, []);
  assert.equal(config.sampleSize, 0);
  assert.match(config.summary, /unknown/i);
  assert.equal(config.updatedAt, NOW);
});

test('a westerly METAR alone gives westerly ops, low confidence, both runways', () => {
  const config = deriveRunwayConfig([], metar(250, 14), NOW);

  assert.equal(config.direction, 'westerly');
  assert.equal(config.sampleSize, 0);
  assert.ok(config.confidence > 0, 'the wind is evidence, just weak evidence');
  assert.ok(config.confidence <= 0.35, `METAR-only confidence must stay low, got ${config.confidence}`);
  assert.deepEqual(config.landing, ['27L', '27R']);
  assert.deepEqual(config.departing, ['27L', '27R']);
  assert.match(config.summary, /METAR/);
  assert.match(config.summary, /unconfirmed/);
});

test('a strong easterly METAR turns the airport round', () => {
  const config = deriveRunwayConfig([], metar(90, 18), NOW);

  assert.equal(config.direction, 'easterly');
  assert.deepEqual(config.landing, ['09L', '09R']);
  assert.ok(config.confidence <= 0.35);
  assert.match(config.summary, /Easterly ops from METAR/);
});

test('light and calm winds are worked westerly — Heathrow’s standing preference', () => {
  for (const weather of [metar(90, 3), metar(0, 0), metar(null, 2), metar(70, 4)]) {
    const config = deriveRunwayConfig([], weather, NOW);
    assert.equal(config.direction, 'westerly', `wind ${weather.windDirection}/${weather.windSpeed}`);
    assert.ok(config.confidence <= 0.35);
    assert.match(config.summary, /westerly in light winds/);
  }
});

test('a light easterly tailwind still leaves the airport westerly, a strong one does not', () => {
  // 4 kt straight down the westerly runways is inside the tolerance; 12 kt is not.
  assert.equal(deriveRunwayConfig([], metar(90, 4), NOW).direction, 'westerly');
  assert.equal(deriveRunwayConfig([], metar(90, 12), NOW).direction, 'easterly');
});

test('a pure crosswind leaves the westerly preference intact', () => {
  const config = deriveRunwayConfig([], metar(180, 15), NOW);
  assert.equal(config.direction, 'westerly');
});

test('a METAR with no usable wind is not a direction', () => {
  const config = deriveRunwayConfig([], metar(null, null), NOW);
  assert.equal(config.direction, 'unknown');
  assert.equal(config.confidence, 0);
});

test('observed traffic beats the METAR when the two disagree', () => {
  const traffic = [onFinal(THR_09L, BRG_09, 5), onFinal(THR_09L, BRG_09, 8)];
  const config = deriveRunwayConfig(traffic, metar(250, 20), NOW);

  assert.equal(config.direction, 'easterly');
  assert.ok(config.confidence > 0.35, 'observation should outrank the wind');
  assert.doesNotMatch(config.summary, /METAR/);
});

test('evenly split traffic falls back to the wind and says so', () => {
  const traffic = [onFinal(THR_27R, BRG_27, 6), onFinal(THR_09L, BRG_09, 6)];
  const config = deriveRunwayConfig(traffic, metar(250, 16), NOW);

  assert.equal(config.direction, 'westerly');
  assert.equal(config.sampleSize, 2);
  assert.ok(config.confidence <= 0.35);
  assert.match(config.summary, /traffic split/);
});

test('evenly split traffic with no wind is unknown rather than a coin toss', () => {
  const traffic = [onFinal(THR_27R, BRG_27, 6), onFinal(THR_09L, BRG_09, 6)];
  const config = deriveRunwayConfig(traffic, null, NOW);

  assert.equal(config.direction, 'unknown');
  assert.equal(config.confidence, 0);
  assert.equal(config.sampleSize, 2);
});

/* ------------------------------------------------------------------ *
 * deriveRunwayConfig — robustness
 * ------------------------------------------------------------------ */

test('deriveRunwayConfig never throws on rubbish input', () => {
  const junk = [
    aircraft({ lat: Number.NaN, lon: Number.NaN, altitude: 1000, track: 270 }),
    aircraft({ lat: 51.47, lon: -0.45, altitude: null, track: null }),
    aircraft({ lat: 91, lon: 400, altitude: 500, track: 270, verticalRate: -600 }),
    null as unknown as UpstreamAircraft,
  ];

  for (const now of [NOW, Number.NaN]) {
    const config = deriveRunwayConfig(junk, null, now);
    assert.ok(Number.isFinite(config.updatedAt));
    assert.ok(config.confidence >= 0 && config.confidence <= 1);
    assert.ok(config.summary.length > 0);
  }

  const fromNothing = deriveRunwayConfig(
    undefined as unknown as UpstreamAircraft[],
    undefined as unknown as Weather,
    NOW,
  );
  assert.equal(fromNothing.direction, 'unknown');
});

/* ------------------------------------------------------------------ *
 * predictArrivalRunway
 * ------------------------------------------------------------------ */

function westerlyConfig(landing: string[], departing: string[], confidence: number): RunwayConfig {
  return {
    landing,
    departing,
    direction: 'westerly',
    confidence,
    sampleSize: 4,
    summary: 'test',
    updatedAt: NOW,
  };
}

const UNKNOWN_CONFIG: RunwayConfig = {
  landing: [],
  departing: [],
  direction: 'unknown',
  confidence: 0,
  sampleSize: 0,
  summary: 'test',
  updatedAt: NOW,
};

test('an arrival on the 27R centreline is matched to 27R even when both are candidates', () => {
  const ac = onFinal(THR_27R, BRG_27, 7);
  const prediction = predictArrivalRunway(
    { lat: ac.lat, lon: ac.lon, track: ac.track, altitude: ac.altitude },
    westerlyConfig(['27L', '27R'], ['27L', '27R'], 0.3),
  );

  assert.equal(prediction.runway, '27R');
  assert.ok(prediction.confidence > 0);
  assert.ok(prediction.confidence <= 0.3, 'a prediction may never outrank its config');
});

test('an arrival on the 27L centreline is matched to 27L', () => {
  const ac = onFinal(THR_27L, BRG_27, 6);
  const prediction = predictArrivalRunway(
    { lat: ac.lat, lon: ac.lon, track: ac.track, altitude: ac.altitude },
    westerlyConfig(['27L', '27R'], ['27L', '27R'], 0.9),
  );

  assert.equal(prediction.runway, '27L');
  assert.equal(prediction.source, 'observed');
  assert.ok(prediction.confidence > 0.5);
});

test('confidence falls with distance to run', () => {
  const config = westerlyConfig(['27R'], ['27L'], 0.9);
  const near = onFinal(THR_27R, BRG_27, 4);
  const far = onFinal(THR_27R, BRG_27, 22);

  const nearPrediction = predictArrivalRunway(
    { lat: near.lat, lon: near.lon, track: near.track, altitude: near.altitude },
    config,
  );
  const farPrediction = predictArrivalRunway(
    { lat: far.lat, lon: far.lon, track: far.track, altitude: far.altitude },
    config,
  );

  assert.equal(nearPrediction.runway, '27R');
  assert.equal(farPrediction.runway, '27R');
  assert.ok(
    nearPrediction.confidence > farPrediction.confidence,
    `${nearPrediction.confidence} should beat ${farPrediction.confidence}`,
  );
  assert.equal(nearPrediction.source, 'observed');
  assert.equal(farPrediction.source, 'inferred');
});

test('a prediction never claims more confidence than the config it rests on', () => {
  for (const configConfidence of [0.1, 0.35, 0.6, 0.95]) {
    const ac = onFinal(THR_27R, BRG_27, 3);
    const prediction = predictArrivalRunway(
      { lat: ac.lat, lon: ac.lon, track: ac.track, altitude: ac.altitude },
      westerlyConfig(['27R'], ['27L'], configConfidence),
    );
    assert.ok(
      prediction.confidence <= configConfidence + 1e-9,
      `${prediction.confidence} exceeded config ${configConfidence}`,
    );
  }
});

test('an unknown config yields no runway at all', () => {
  const ac = onFinal(THR_27R, BRG_27, 5);
  const prediction = predictArrivalRunway(
    { lat: ac.lat, lon: ac.lon, track: ac.track, altitude: ac.altitude },
    UNKNOWN_CONFIG,
  );

  assert.equal(prediction.runway, null);
  assert.equal(prediction.source, 'unknown');
  assert.equal(prediction.confidence, 0);
});

test('an aircraft far from the field gets no runway', () => {
  const far = onFinal(THR_27R, BRG_27, 60);
  const prediction = predictArrivalRunway(
    { lat: far.lat, lon: far.lon, track: far.track, altitude: 12_000 },
    westerlyConfig(['27R'], ['27L'], 0.9),
  );

  assert.equal(prediction.runway, null);
  assert.equal(prediction.source, 'unknown');
  assert.equal(prediction.confidence, 0);
});

test('with a position but no alignment, a single-runway config is inferred and a two-runway one is not', () => {
  // Overhead the field, tracking north — lined up with nothing.
  const overhead = { lat: 51.4706, lon: -0.4619, track: 5, altitude: 3000 };

  const single = predictArrivalRunway(overhead, westerlyConfig(['27R'], ['27L'], 0.8));
  assert.equal(single.runway, '27R');
  assert.equal(single.source, 'inferred');
  assert.ok(single.confidence > 0 && single.confidence < 0.8);

  const both = predictArrivalRunway(overhead, westerlyConfig(['27L', '27R'], ['27L', '27R'], 0.3));
  assert.equal(both.runway, null);
  assert.equal(both.source, 'unknown');
});

test('a missing position falls back to the config, or to nothing', () => {
  const noPosition = { lat: null, lon: null, track: null, altitude: null };

  const single = predictArrivalRunway(noPosition, westerlyConfig(['27R'], ['27L'], 0.8));
  assert.equal(single.runway, '27R');
  assert.equal(single.source, 'inferred');
  assert.ok(single.confidence < 0.8);

  const both = predictArrivalRunway(noPosition, westerlyConfig(['27L', '27R'], ['27L', '27R'], 0.3));
  assert.equal(both.runway, null);
});

test('predictArrivalRunway never throws', () => {
  const prediction = predictArrivalRunway(
    { lat: Number.NaN, lon: Number.POSITIVE_INFINITY, track: Number.NaN, altitude: Number.NaN },
    westerlyConfig(['ZZZ'], ['27L'], 0.8),
  );
  assert.equal(prediction.runway, null);

  const fromNull = predictArrivalRunway(
    null as unknown as { lat: null; lon: null; track: null; altitude: null },
    null as unknown as RunwayConfig,
  );
  assert.equal(fromNull.runway, null);
  assert.equal(fromNull.confidence, 0);
});

/* ------------------------------------------------------------------ *
 * predictDepartureRunway
 * ------------------------------------------------------------------ */

test('a single departure runway is reported with the config’s own confidence', () => {
  const prediction = predictDepartureRunway(westerlyConfig(['27R'], ['27L'], 0.82));
  assert.equal(prediction.runway, '27L');
  // However well the traffic agreed, no geometry was read from THIS aeroplane: a configuration
  // is an inference about the airport, never an observation of a departure.
  assert.equal(prediction.source, 'inferred');
  assert.equal(prediction.confidence, 0.82);
});

test('a weakly held departure runway is inferred, not observed', () => {
  const prediction = predictDepartureRunway(westerlyConfig(['27R'], ['27L'], 0.3));
  assert.equal(prediction.runway, '27L');
  assert.equal(prediction.source, 'inferred');
});

test('an unconfirmed assignment names no departure runway', () => {
  const prediction = predictDepartureRunway(westerlyConfig(['27L', '27R'], ['27L', '27R'], 0.3));
  assert.equal(prediction.runway, null);
  assert.equal(prediction.source, 'unknown');
  assert.equal(prediction.confidence, 0);
});

test('an unknown config names no departure runway', () => {
  const prediction = predictDepartureRunway(UNKNOWN_CONFIG);
  assert.equal(prediction.runway, null);
  assert.equal(prediction.confidence, 0);
});

test('predictDepartureRunway never throws', () => {
  const prediction = predictDepartureRunway(null as unknown as RunwayConfig);
  assert.equal(prediction.runway, null);
  assert.equal(prediction.confidence, 0);
});

/* ------------------------------------------------------------------ *
 * End to end: derived config feeds the predictions
 * ------------------------------------------------------------------ */

test('a derived config drives consistent arrival and departure predictions', () => {
  const traffic = [
    onFinal(THR_27R, BRG_27, 4),
    onFinal(THR_27R, BRG_27, 8),
    onDeparture(THR_27L, BRG_27, 2),
  ];
  const config = deriveRunwayConfig(traffic, metar(240, 12), NOW);

  assert.equal(config.direction, 'westerly');
  assert.deepEqual(config.landing, ['27R']);
  assert.deepEqual(config.departing, ['27L']);

  const inbound = onFinal(THR_27R, BRG_27, 11);
  const arrival = predictArrivalRunway(
    { lat: inbound.lat, lon: inbound.lon, track: inbound.track, altitude: inbound.altitude },
    config,
  );
  assert.equal(arrival.runway, '27R');
  assert.ok(arrival.confidence <= config.confidence);

  const departure = predictDepartureRunway(config);
  assert.equal(departure.runway, '27L');
  assert.equal(departure.confidence, config.confidence);
});
