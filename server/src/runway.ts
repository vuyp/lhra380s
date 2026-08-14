/**
 * Which way Heathrow is working, right now.
 *
 * Heathrow runs two parallel runways in one of two directions: **westerly** (27L/27R, the
 * prevailing case — the wind at LHR is south-westerly most of the year) or **easterly**
 * (09L/09R). In segregated mode one runway takes the landings and the other takes the
 * departures, and the pair swaps at 15:00 local under the noise alternation agreement. None of
 * that is published in a machine-readable feed anywhere, so we derive it from what the aircraft
 * are actually doing.
 *
 * The derivation is deliberately conservative:
 *
 *  - only traffic below 4 000 ft and within 15 nm of the field is considered at all;
 *  - an aircraft counts as a landing only if it is descending (or already low), tracking within
 *    35° of a runway bearing, sitting within 2 nm of that runway's extended centreline and
 *    inside 12 nm of the threshold on the approach side;
 *  - a departure needs a positive climb, the same heading agreement, and a position over or just
 *    beyond the runway;
 *  - landing evidence is weighted twice as heavily as departure evidence, because approaches are
 *    flown down a centreline for ten miles while departures turn almost immediately;
 *  - when there is no usable traffic at all we fall back to the METAR wind, and say so, at a
 *    deliberately low confidence.
 *
 * When the traffic cannot tell us *which* of the two runways is landing and which is departing,
 * we report both candidates and label the assignment unconfirmed. Guessing "27R because it is
 * usually 27R in the morning" would be inventing a fact, and this app does not do that.
 *
 * Nothing in this module throws. A malformed feed degrades to an honest "unknown".
 */

import type { RunwayConfig, RunwayEnd, RunwayPrediction, Weather } from '../../shared/types.ts';
import type { LatLon } from './geo.ts';
import type { UpstreamAircraft } from './upstream.ts';
import { alongTrackNm, angularDelta, crossTrackNm, destinationPoint, distanceNm } from './geo.ts';
import { log } from './config.ts';
import { AIRPORT } from './reference.ts';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Traffic above this is en route, not working the airport. */
const MAX_EVIDENCE_ALT_FT = 4000;
/** Traffic further out than this is not yet committed to a runway. */
const MAX_EVIDENCE_RANGE_NM = 15;
/** Heading agreement required before an aircraft is credited to a runway axis. */
const AXIS_ALIGN_DEG = 35;

/** Half-width of the approach corridor, either side of the extended centreline. */
const APPROACH_CROSS_NM = 2;
/** How far back down the extended centreline an approach still counts. */
const APPROACH_ALONG_NM = 12;
/** Allowance for an aircraft just past the threshold — the flare and touchdown zone. */
const APPROACH_OVERSHOOT_NM = 0.5;

/** Departures fan out faster than approaches converge, so the corridor is wider. */
const DEPARTURE_CROSS_NM = 3;
const DEPARTURE_ALONG_NM = 12;
/** A departure may still be a touch short of the threshold when first seen airborne. */
const DEPARTURE_BEHIND_NM = 1;

/** A ground roll only counts on the runway itself — 0.1 nm ≈ 185 m either side. */
const GROUND_ROLL_CROSS_NM = 0.1;
const GROUND_ROLL_MIN_SPEED_KT = 60;
/** How far along the runway a roll may be: from just behind the threshold to the far end. */
const GROUND_ROLL_BEHIND_NM = 0.6;
const GROUND_ROLL_AHEAD_NM = 3;

/** Descending, or low enough that it no longer matters. */
const DESCENT_FPM = -100;
const LOW_ALT_FT = 2500;
/** A genuine climb-out, not turbulence. */
const CLIMB_FPM = 300;

/** Landing evidence is worth twice a departure. */
const LANDING_WEIGHT = 2;
const DEPARTURE_WEIGHT = 1;
const GROUND_ROLL_WEIGHT = 1;

/** Evidence count at which the sample is considered full strength. */
const FULL_SAMPLE = 5;

/**
 * Heathrow keeps westerly operations until the tailwind component exceeds roughly this much;
 * light and calm winds are worked westerly by preference. This is a real operating practice,
 * not a modelling convenience.
 */
const WESTERLY_PREFERENCE_TAILWIND_KT = 5;

/** Beyond this an arrival has not committed to a centreline and we will not name a runway. */
const MAX_PREDICTION_RANGE_NM = 30;
/** Cross-track error at which a runway is no longer a plausible match at all. */
const PREDICTION_CROSS_NM = 4;
/** Heading error at which a runway is no longer a plausible match at all. */
const PREDICTION_ALIGN_DEG = 45;

/** Tolerances for calling an arrival *established* rather than merely likely. */
const ESTABLISHED_RANGE_NM = 12;
const ESTABLISHED_CROSS_NM = 1.5;
const ESTABLISHED_ALIGN_DEG = 20;
const ESTABLISHED_MAX_ALT_FT = 10_000;

/* ------------------------------------------------------------------ *
 * Runway geometry, built once from the reference data
 * ------------------------------------------------------------------ */

type OpsDirection = 'westerly' | 'easterly';

interface RunwayGeometry {
  designator: string;
  /** True bearing in the direction of travel on this runway end. */
  bearing: number;
  direction: OpsDirection;
  /** Landing threshold. */
  threshold: LatLon;
  /** A point down the runway bearing from the threshold; the two define the axis. */
  axisEnd: LatLon;
}

/** Length of the synthetic axis segment. Any positive length works; 10 nm keeps it well conditioned. */
const AXIS_LENGTH_NM = 10;

function opsDirectionOf(bearing: number): OpsDirection | null {
  if (angularDelta(bearing, 270) <= 45) return 'westerly';
  if (angularDelta(bearing, 90) <= 45) return 'easterly';
  return null;
}

function buildGeometry(ends: RunwayEnd[]): RunwayGeometry[] {
  const out: RunwayGeometry[] = [];
  for (const end of ends) {
    if (
      !Number.isFinite(end.bearing) ||
      !Number.isFinite(end.lat) ||
      !Number.isFinite(end.lon) ||
      typeof end.designator !== 'string'
    ) {
      continue;
    }
    const direction = opsDirectionOf(end.bearing);
    // Heathrow has only east-west runways; anything else in the data is not ours to interpret.
    if (direction === null) continue;
    const threshold: LatLon = { lat: end.lat, lon: end.lon };
    out.push({
      designator: end.designator.toUpperCase(),
      bearing: end.bearing,
      direction,
      threshold,
      axisEnd: destinationPoint(threshold, end.bearing, AXIS_LENGTH_NM),
    });
  }
  return out;
}

const RUNWAYS: RunwayGeometry[] = buildGeometry(AIRPORT.runways);
const FIELD: LatLon = { lat: AIRPORT.lat, lon: AIRPORT.lon };

function endsFacing(direction: OpsDirection): string[] {
  return RUNWAYS.filter((rw) => rw.direction === direction)
    .map((rw) => rw.designator)
    .sort();
}

const WESTERLY_ENDS: string[] = endsFacing('westerly');
const EASTERLY_ENDS: string[] = endsFacing('easterly');

function geometryFor(designator: string): RunwayGeometry | null {
  const wanted = designator.toUpperCase();
  for (const rw of RUNWAYS) {
    if (rw.designator === wanted) return rw;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Small numeric helpers
 * ------------------------------------------------------------------ */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * Projecting an aircraft onto a runway axis
 * ------------------------------------------------------------------ */

interface Projection {
  /** Nautical miles along the runway bearing from the threshold. Negative = short of it. */
  along: number;
  /** Signed distance from the extended centreline, nm. */
  cross: number;
  /** Heading disagreement with the runway, degrees, or null when no track is transmitted. */
  trackDelta: number | null;
}

function project(point: LatLon, rw: RunwayGeometry, track: number | null): Projection {
  return {
    along: alongTrackNm(point, rw.threshold, rw.axisEnd),
    cross: crossTrackNm(point, rw.threshold, rw.axisEnd),
    trackDelta: track === null ? null : angularDelta(track, rw.bearing),
  };
}

type EvidenceRole = 'landing' | 'departing' | 'roll';

interface Evidence {
  role: EvidenceRole;
  runway: string;
  direction: OpsDirection;
  weight: number;
}

/**
 * Classify one aircraft as evidence for a runway, or not at all.
 *
 * At most one verdict per aircraft: an aircraft on the 27R centreline is also within the 2 nm
 * corridor of 27L (the runways are 0.77 nm apart), so the *best* axis by cross-track error wins
 * rather than both being credited.
 */
function classify(ac: UpstreamAircraft): Evidence | null {
  const lat = finite(ac.lat);
  const lon = finite(ac.lon);
  if (lat === null || lon === null) return null;

  const point: LatLon = { lat, lon };
  if (distanceNm(point, FIELD) > MAX_EVIDENCE_RANGE_NM) return null;

  const altitude = finite(ac.altitude);
  const onGround = ac.onGround === true;
  if (!onGround) {
    // No altitude and airborne: we cannot tell whether this is a jet on final or an airliner
    // at FL350 overhead. Say nothing.
    if (altitude === null || altitude > MAX_EVIDENCE_ALT_FT) return null;
  }

  const track = finite(ac.track);
  const verticalRate = finite(ac.verticalRate);
  const groundSpeed = finite(ac.groundSpeed);

  const descending =
    (verticalRate !== null && verticalRate <= DESCENT_FPM) ||
    (altitude !== null && altitude <= LOW_ALT_FT);
  const climbing = verticalRate !== null && verticalRate >= CLIMB_FPM;
  const rolling = onGround && groundSpeed !== null && groundSpeed >= GROUND_ROLL_MIN_SPEED_KT;

  let landing: { rw: RunwayGeometry; cross: number } | null = null;
  let departing: { rw: RunwayGeometry; cross: number } | null = null;
  let roll: { rw: RunwayGeometry; cross: number } | null = null;

  for (const rw of RUNWAYS) {
    const { along, cross, trackDelta } = project(point, rw, track);
    if (trackDelta === null || trackDelta > AXIS_ALIGN_DEG) continue;
    const absCross = Math.abs(cross);

    if (rolling) {
      if (
        absCross <= GROUND_ROLL_CROSS_NM &&
        along >= -GROUND_ROLL_BEHIND_NM &&
        along <= GROUND_ROLL_AHEAD_NM &&
        (roll === null || absCross < roll.cross)
      ) {
        roll = { rw, cross: absCross };
      }
      // A rolling aircraft is neither approaching nor climbing; nothing else to test.
      continue;
    }
    if (onGround) continue;

    if (
      descending &&
      absCross <= APPROACH_CROSS_NM &&
      along <= APPROACH_OVERSHOOT_NM &&
      along >= -APPROACH_ALONG_NM &&
      (landing === null || absCross < landing.cross)
    ) {
      landing = { rw, cross: absCross };
    }

    if (
      climbing &&
      absCross <= DEPARTURE_CROSS_NM &&
      along >= -DEPARTURE_BEHIND_NM &&
      along <= DEPARTURE_ALONG_NM &&
      (departing === null || absCross < departing.cross)
    ) {
      departing = { rw, cross: absCross };
    }
  }

  if (landing !== null) {
    return {
      role: 'landing',
      runway: landing.rw.designator,
      direction: landing.rw.direction,
      weight: LANDING_WEIGHT,
    };
  }
  if (departing !== null) {
    return {
      role: 'departing',
      runway: departing.rw.designator,
      direction: departing.rw.direction,
      weight: DEPARTURE_WEIGHT,
    };
  }
  if (roll !== null) {
    return {
      role: 'roll',
      runway: roll.rw.designator,
      direction: roll.rw.direction,
      weight: GROUND_ROLL_WEIGHT,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The METAR fallback
 * ------------------------------------------------------------------ */

interface WindVerdict {
  direction: OpsDirection;
  confidence: number;
  /** Human fragment for the summary, e.g. "wind 250° at 12 kt". */
  detail: string;
}

function describeWind(directionDeg: number | null, speed: number | null): string {
  if (speed !== null && speed < 1) return 'calm wind';
  if (directionDeg === null) {
    return speed === null ? 'wind' : `variable wind at ${Math.round(speed)} kt`;
  }
  const compass = String(Math.round(((directionDeg % 360) + 360) % 360)).padStart(3, '0');
  if (speed === null) return `wind ${compass}°`;
  return `wind ${compass}° at ${Math.round(speed)} kt`;
}

/**
 * Decide the operating direction from the reported wind.
 *
 * The headwind component along 270° decides it, with Heathrow's standing preference for
 * westerly operations encoded as a tolerance: the wind has to be pushing more than about 5 kt
 * of tailwind down a westerly runway before the airport turns round.
 */
function directionFromWind(weather: Weather | null): WindVerdict | null {
  if (weather === null || typeof weather !== 'object') return null;

  const speed = finite(weather.windSpeed);
  const dir = finite(weather.windDirection);

  // Calm, or variable at a speed that cannot decide anything: the preference decides.
  if (speed !== null && speed <= WESTERLY_PREFERENCE_TAILWIND_KT) {
    return {
      direction: 'westerly',
      confidence: 0.2,
      detail: `${describeWind(dir, speed)} — Heathrow works westerly in light winds`,
    };
  }
  if (dir === null || speed === null) return null;

  // Positive = headwind for aircraft using the westerly runways.
  const headwind270 = speed * Math.cos(((dir - 270) * Math.PI) / 180);
  const direction: OpsDirection =
    headwind270 >= -WESTERLY_PREFERENCE_TAILWIND_KT ? 'westerly' : 'easterly';

  const strength = Math.abs(headwind270);
  const confidence = strength >= 10 ? 0.3 : strength >= 4 ? 0.25 : 0.2;
  const preference =
    direction === 'westerly' && headwind270 < 0
      ? ' — Heathrow works westerly in light winds'
      : '';

  return { direction, confidence, detail: `${describeWind(dir, speed)}${preference}` };
}

/* ------------------------------------------------------------------ *
 * deriveRunwayConfig
 * ------------------------------------------------------------------ */

function unknownConfig(updatedAt: number, sampleSize = 0, summary?: string): RunwayConfig {
  return {
    landing: [],
    departing: [],
    direction: 'unknown',
    confidence: 0,
    sampleSize,
    summary: summary ?? 'Runway configuration unknown — no low traffic and no wind report',
    updatedAt,
  };
}

interface Assignment {
  landing: string[];
  departing: string[];
  /** True when the observed traffic actually told us which runway is which. */
  confirmed: boolean;
}

/**
 * Split the two runways of the active direction into a landing one and a departing one.
 *
 * Landing evidence decides it where it can; failing that, departure evidence does. When neither
 * separates the pair we report both candidates and flag the assignment as unconfirmed — that is
 * the honest answer, and the UI is built to say so.
 */
function assignRunways(
  pair: string[],
  landingCounts: Map<string, number>,
  departureCounts: Map<string, number>,
): Assignment {
  const a = pair[0];
  const b = pair[1];
  if (a === undefined || b === undefined) {
    return { landing: [...pair], departing: [...pair], confirmed: false };
  }

  const la = landingCounts.get(a) ?? 0;
  const lb = landingCounts.get(b) ?? 0;
  if (la !== lb) {
    const lands = la > lb ? a : b;
    const departs = la > lb ? b : a;
    return { landing: [lands], departing: [departs], confirmed: true };
  }

  const da = departureCounts.get(a) ?? 0;
  const db = departureCounts.get(b) ?? 0;
  if (da !== db) {
    const departs = da > db ? a : b;
    const lands = da > db ? b : a;
    return { landing: [lands], departing: [departs], confirmed: true };
  }

  return { landing: [a, b], departing: [a, b], confirmed: false };
}

function compose(
  direction: OpsDirection,
  assignment: Assignment,
  sourceNote: string,
): string {
  const word = direction === 'westerly' ? 'Westerly ops' : 'Easterly ops';
  const lands = assignment.landing[0];
  const departs = assignment.departing[0];
  if (assignment.confirmed && lands !== undefined && departs !== undefined) {
    return `${word}${sourceNote} · landing ${lands} · departing ${departs}`;
  }
  return `${word}${sourceNote} · runway assignment unconfirmed`;
}

function derive(traffic: UpstreamAircraft[], weather: Weather | null, updatedAt: number): RunwayConfig {
  const landingCounts = new Map<string, number>();
  const departureCounts = new Map<string, number>();
  const counted = new Set<string>();
  let westScore = 0;
  let eastScore = 0;

  for (const ac of Array.isArray(traffic) ? traffic : []) {
    if (ac === null || typeof ac !== 'object') continue;
    // One vote per airframe, even if the feed lists it twice.
    const id = typeof ac.hex === 'string' && ac.hex.length > 0 ? ac.hex.toLowerCase() : null;
    if (id !== null && counted.has(id)) continue;

    const evidence = classify(ac);
    if (evidence === null) continue;
    if (id !== null) counted.add(id);

    if (evidence.direction === 'westerly') westScore += evidence.weight;
    else eastScore += evidence.weight;

    if (evidence.role === 'landing') {
      landingCounts.set(evidence.runway, (landingCounts.get(evidence.runway) ?? 0) + 1);
    } else if (evidence.role === 'departing') {
      departureCounts.set(evidence.runway, (departureCounts.get(evidence.runway) ?? 0) + 1);
    }
    // A ground roll tells us the direction of travel but not whether the aircraft is landing or
    // departing — a rollout and a take-off roll look identical in one frame — so it votes on the
    // direction only and never on the runway assignment.
  }

  const sampleSize = counted.size;
  const total = westScore + eastScore;

  let direction: OpsDirection | null = null;
  let confidence = 0;
  let sourceNote = '';

  if (total > 0 && westScore !== eastScore) {
    direction = westScore > eastScore ? 'westerly' : 'easterly';
    const margin = Math.abs(westScore - eastScore) / total;
    const sampleFactor = Math.min(1, sampleSize / FULL_SAMPLE);
    confidence = clamp01(margin * (0.45 + 0.5 * sampleFactor));
  } else {
    const wind = directionFromWind(weather);
    if (wind !== null) {
      direction = wind.direction;
      confidence = wind.confidence;
      sourceNote =
        total > 0
          ? ` from METAR ${wind.detail} (traffic split)`
          : ` from METAR ${wind.detail}`;
    } else if (total > 0) {
      // Traffic in both directions and no wind to break the tie. We know something is happening,
      // we just cannot say what — and an even split is not a coin to toss.
      return unknownConfig(
        updatedAt,
        sampleSize,
        'Runway direction unclear — traffic observed in both directions',
      );
    }
  }

  if (direction === null) return unknownConfig(updatedAt, sampleSize);

  const pair = direction === 'westerly' ? WESTERLY_ENDS : EASTERLY_ENDS;
  const assignment = assignRunways(pair, landingCounts, departureCounts);

  return {
    landing: assignment.landing,
    departing: assignment.departing,
    direction,
    confidence: round2(confidence),
    sampleSize,
    summary: compose(direction, assignment, sourceNote),
    updatedAt,
  };
}

/**
 * Derive Heathrow's live operating configuration from observed traffic, falling back to the
 * METAR wind. Never throws: on any internal failure the answer is an honest "unknown".
 */
export function deriveRunwayConfig(
  traffic: UpstreamAircraft[],
  weather: Weather | null,
  now: number,
): RunwayConfig {
  const updatedAt = Number.isFinite(now) ? now : Date.now();
  try {
    return derive(traffic, weather, updatedAt);
  } catch (err) {
    log.warn(`runway: derivation failed (${err instanceof Error ? err.message : String(err)})`);
    return unknownConfig(updatedAt);
  }
}

/* ------------------------------------------------------------------ *
 * Per-aircraft predictions
 * ------------------------------------------------------------------ */

const NO_PREDICTION: RunwayPrediction = { runway: null, source: 'unknown', confidence: 0 };

function noPrediction(): RunwayPrediction {
  return { ...NO_PREDICTION };
}

interface Candidate {
  designator: string;
  /** Nautical miles to run to the threshold. Negative once past it. */
  toGo: number;
  cross: number;
  trackDelta: number | null;
  /** 0–1 quality of the geometric fit. */
  score: number;
}

/**
 * Which of the active landing runways this arrival is lining up with.
 *
 * The answer is geometric: cross-track error from each candidate's extended centreline plus
 * heading agreement. Confidence falls with distance to run and is multiplied by the config's own
 * confidence, so a prediction can never be more certain than the configuration it rests on. Far
 * out, or with no configuration to work from, the answer is `null` rather than a guess.
 */
export function predictArrivalRunway(
  ac: { lat: number | null; lon: number | null; track: number | null; altitude: number | null },
  config: RunwayConfig,
): RunwayPrediction {
  try {
    if (
      config === null ||
      typeof config !== 'object' ||
      config.direction === 'unknown' ||
      !Array.isArray(config.landing) ||
      config.landing.length === 0
    ) {
      return noPrediction();
    }

    const configConfidence = clamp01(finite(config.confidence) ?? 0);
    if (configConfidence <= 0) return noPrediction();

    const candidates: RunwayGeometry[] = [];
    for (const designator of config.landing) {
      if (typeof designator !== 'string') continue;
      const rw = geometryFor(designator);
      if (rw !== null) candidates.push(rw);
    }
    if (candidates.length === 0) return noPrediction();

    const only = candidates.length === 1 ? candidates[0] : undefined;

    const lat = finite(ac?.lat ?? null);
    const lon = finite(ac?.lon ?? null);
    if (lat === null || lon === null) {
      // No position. If the field is landing exactly one runway, that runway is still the
      // answer — it is the config speaking, not a guess about this aircraft — but at a much
      // reduced confidence because nothing about this aircraft was checked.
      if (only === undefined) return noPrediction();
      return {
        runway: only.designator,
        source: 'inferred',
        confidence: round2(configConfidence * 0.35),
      };
    }

    const point: LatLon = { lat, lon };
    const track = finite(ac?.track ?? null);
    const altitude = finite(ac?.altitude ?? null);

    if (distanceNm(point, FIELD) > MAX_PREDICTION_RANGE_NM) return noPrediction();

    let best: Candidate | null = null;
    for (const rw of candidates) {
      const { along, cross, trackDelta } = project(point, rw, track);
      const toGo = -along;
      // Well past the threshold: this aircraft has landed and is not lining up with anything.
      if (toGo < -2 || toGo > MAX_PREDICTION_RANGE_NM) continue;

      const absCross = Math.abs(cross);
      if (absCross > PREDICTION_CROSS_NM) continue;
      // Flying across the approach rather than down it is not "nearly lined up", however close
      // to the centreline the aircraft happens to be at this instant.
      if (trackDelta !== null && trackDelta >= PREDICTION_ALIGN_DEG) continue;

      const alignment = 1 - absCross / PREDICTION_CROSS_NM;
      // No transmitted track is not evidence against the runway, so it scores neutral.
      const agreement = trackDelta === null ? 0.5 : 1 - trackDelta / PREDICTION_ALIGN_DEG;
      const score = 0.6 * alignment + 0.4 * agreement;
      if (best === null || score > best.score) {
        best = { designator: rw.designator, toGo, cross, trackDelta, score };
      }
    }

    if (best === null || best.score < 0.15) {
      if (only === undefined) return noPrediction();
      return {
        runway: only.designator,
        source: 'inferred',
        confidence: round2(configConfidence * 0.35),
      };
    }

    // 1.0 on the threshold falling to 0.5 at the edge of the prediction range.
    const distanceFactor = 1 - 0.5 * clamp01(Math.max(0, best.toGo) / MAX_PREDICTION_RANGE_NM);
    const confidence = clamp01(configConfidence * best.score * distanceFactor);

    const established =
      best.toGo <= ESTABLISHED_RANGE_NM &&
      best.toGo >= -2 &&
      Math.abs(best.cross) <= ESTABLISHED_CROSS_NM &&
      best.trackDelta !== null &&
      best.trackDelta <= ESTABLISHED_ALIGN_DEG &&
      (altitude === null || altitude <= ESTABLISHED_MAX_ALT_FT);

    return {
      runway: best.designator,
      source: established ? 'observed' : 'inferred',
      confidence: round2(confidence),
    };
  } catch (err) {
    log.warn(`runway: arrival prediction failed (${err instanceof Error ? err.message : String(err)})`);
    return noPrediction();
  }
}

/**
 * The runway a departure will use. This is purely a statement of the active configuration — a
 * jet at the stand has no geometry to read — so it carries the configuration's own confidence,
 * is always `inferred` rather than observed, and reports nothing at all when the configuration
 * lists more than one candidate.
 */
export function predictDepartureRunway(config: RunwayConfig): RunwayPrediction {
  try {
    if (
      config === null ||
      typeof config !== 'object' ||
      config.direction === 'unknown' ||
      !Array.isArray(config.departing) ||
      config.departing.length !== 1
    ) {
      return noPrediction();
    }

    const runway = config.departing[0];
    if (typeof runway !== 'string' || runway.length === 0) return noPrediction();

    const confidence = clamp01(finite(config.confidence) ?? 0);
    if (confidence <= 0) return noPrediction();

    // Never 'observed'. No geometry was read: this is the airport's configuration speaking about
    // a runway an aeroplane at the stand has not touched yet, however well the traffic agreed.
    return {
      runway,
      source: 'inferred',
      confidence: round2(confidence),
    };
  } catch (err) {
    log.warn(`runway: departure prediction failed (${err instanceof Error ? err.message : String(err)})`);
    return noPrediction();
  }
}
