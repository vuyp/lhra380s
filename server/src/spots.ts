/**
 * Ranking Heathrow's spotting locations for *right now*.
 *
 * A spot is not good or bad in the abstract. Myrtle Avenue is the best place in London to watch
 * an A380 on a westerly afternoon and a waste of a Tube fare on an easterly morning. What
 * changes is the runway configuration, the sun, and the weather — so those three things, and
 * nothing else, decide the ranking.
 *
 * The score is built additively from a small number of honest factors:
 *
 *   base                       20   every curated spot is a real place worth standing in
 *   the active runway       0–45   does this spot cover a runway that is actually in use,
 *                                  for the kind of movement it is set up to watch
 *   light                   0–25   sun behind the photographer is ideal, into the lens is not
 *   golden hour              0–8   the hour either side of sunrise and sunset
 *   configuration penalty  −12–0   we do not know the config well enough to send you there
 *   weather penalty        −18–0   you will not see much through fog, or hold a lens in a gale
 *
 * A spot whose runways are not in use is capped at 32 — "poor" — however beautiful the light,
 * because there will be nothing to photograph.
 *
 * Everything here is a pure function of its arguments. No clock, no randomness, no I/O: the
 * same inputs always produce the same ranking, in the same order.
 */

import type {
  RunwayConfig,
  SpotEvaluation,
  SpotLocation,
  SunInfo,
  Weather,
} from '../../shared/types.ts';
import { angularDelta } from './geo.ts';
import { sunPosition } from './sun.ts';

type Light = SpotEvaluation['light'];
type Rating = SpotEvaluation['rating'];

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

const BASE_SCORE = 20;

/** The spot covers a landing runway and is set up to watch arrivals. */
const SCORE_LANDING_MATCH = 45;
/** The runway this spot covers is landing, but the spot only really works for departures. */
const SCORE_LANDING_MISMATCH = 14;
/** The spot covers a departure runway and is set up to watch departures. */
const SCORE_DEPARTING_MATCH = 32;
/** The runway this spot covers is departing, but the spot only really works for arrivals. */
const SCORE_DEPARTING_MISMATCH = 12;
/** We do not know which way the airport is working, so every spot is equally plausible. */
const SCORE_DIRECTION_UNKNOWN = 20;

/** Ceiling applied when none of the spot's runways are in use. */
const WRONG_RUNWAY_CAP = 32;
/** Ceiling applied when the visibility means there is nothing to see from anywhere. */
const FOG_CAP = 45;

const SCORE_LIGHT: Record<Light, number> = {
  ideal: 25,
  workable: 14,
  backlit: 4,
  dark: 0,
};

const SCORE_GOLDEN: Record<Light, number> = {
  ideal: 8,
  workable: 8,
  backlit: 4,
  dark: 0,
};

/** Below this the configuration is little more than a hint. */
const CONFIDENCE_WEAK = 0.4;
const CONFIDENCE_SOFT = 0.65;
const PENALTY_CONFIDENCE_WEAK = 12;
const PENALTY_CONFIDENCE_SOFT = 5;

/** Sun within this of the direction you are looking: you are shooting into it. */
const BACKLIT_DEG = 45;
/** Sun at least this far from the direction you are looking: it is behind you. */
const IDEAL_DEG = 135;
/**
 * Above this elevation the sun is overhead rather than in front of or behind anyone, so its
 * bearing stops mattering. At Heathrow's latitude this only happens around midsummer noon.
 */
const HIGH_SUN_DEG = 50;
/** Geometric elevation of the sun's centre at sunrise/sunset — matches sun.ts. */
const HORIZON_DEG = -0.833;

/** Resolution of the "sun behind you until …" search. */
const LIGHT_STEP_MS = 15 * 60_000;
const LIGHT_HORIZON_MS = 12 * 3_600_000;
const LIGHT_BISECTIONS = 4;

const RATING_EXCELLENT = 80;
const RATING_GOOD = 60;
const RATING_FAIR = 35;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

const LONDON_CLOCK = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/London',
});

function clockTime(epochMs: number): string {
  return LONDON_CLOCK.format(new Date(epochMs));
}

function ratingFor(score: number): Rating {
  if (score >= RATING_EXCELLENT) return 'excellent';
  if (score >= RATING_GOOD) return 'good';
  if (score >= RATING_FAIR) return 'fair';
  return 'poor';
}

/* ------------------------------------------------------------------ *
 * Light
 * ------------------------------------------------------------------ */

/**
 * Where the sun is relative to the way you are facing.
 *
 * 'ideal'    — behind you, lighting the aircraft's near side.
 * 'workable' — off to one side, or high enough that its bearing hardly matters.
 * 'backlit'  — in front of you, in the frame; silhouettes only.
 * 'dark'     — below the horizon.
 */
function classifyLight(azimuth: number, elevation: number, viewBearing: number): Light {
  if (!Number.isFinite(elevation) || elevation <= HORIZON_DEG) return 'dark';
  if (!Number.isFinite(azimuth) || !Number.isFinite(viewBearing)) return 'workable';
  const delta = angularDelta(azimuth, viewBearing);
  if (elevation >= HIGH_SUN_DEG) return delta >= IDEAL_DEG ? 'ideal' : 'workable';
  if (delta <= BACKLIT_DEG) return 'backlit';
  if (delta >= IDEAL_DEG) return 'ideal';
  return 'workable';
}

/**
 * When the light at this spot stops being what it is now — the moment the sun crosses out of
 * the current band, or below the horizon. Stepped forward a quarter of an hour at a time and
 * then bisected to about a minute. Returns null when nothing changes within half a day.
 */
function lightChangesAt(spot: SpotLocation, now: number, current: Light): number | null {
  let previous = now;
  for (let t = now + LIGHT_STEP_MS; t <= now + LIGHT_HORIZON_MS; t += LIGHT_STEP_MS) {
    const at = sunPosition(new Date(t), spot.lat, spot.lon);
    if (classifyLight(at.azimuth, at.elevation, spot.viewBearing) === current) {
      previous = t;
      continue;
    }
    // The change happened between `previous` and `t`; close in on it.
    let lo = previous;
    let hi = t;
    for (let i = 0; i < LIGHT_BISECTIONS; i += 1) {
      const mid = (lo + hi) / 2;
      const midAt = sunPosition(new Date(mid), spot.lat, spot.lon);
      if (classifyLight(midAt.azimuth, midAt.elevation, spot.viewBearing) === current) lo = mid;
      else hi = mid;
    }
    return Math.round(hi / 60_000) * 60_000;
  }
  return null;
}

function lightReason(spot: SpotLocation, now: number, light: Light): string {
  const changesAt = lightChangesAt(spot, now, light);
  const until = changesAt === null ? null : clockTime(changesAt);
  switch (light) {
    case 'ideal':
      return until === null ? 'Sun behind you — ideal light' : `Sun behind you until ${until}`;
    case 'workable':
      return until === null
        ? 'Sun off to one side — workable light'
        : `Sun off to one side until ${until}`;
    case 'backlit':
      return until === null
        ? 'You are shooting into the sun here'
        : `Into the sun until ${until}`;
    case 'dark':
      return until === null ? 'Dark — lights and sound only' : `Dark until ${until}`;
  }
}

/* ------------------------------------------------------------------ *
 * Weather
 * ------------------------------------------------------------------ */

interface WeatherCaveat {
  penalty: number;
  reason: string;
  /** Hard ceiling on the score, for weather that makes the whole exercise pointless. */
  cap?: number;
}

/** METAR visibility comes through as a number, "10+", "1/2SM" or similar. Take what is parseable. */
function visibilityMiles(raw: string | null): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const fraction = /^(\d+)\s*\/\s*(\d+)/.exec(text);
  if (fraction !== null) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return numerator / denominator;
    }
  }
  const plain = /^(\d+(?:\.\d+)?)/.exec(text);
  if (plain === null) return null;
  const value = Number(plain[1]);
  return Number.isFinite(value) ? value : null;
}

/** Crosswind component across an east-west runway, knots. */
function crosswindKt(weather: Weather, runwayBearing: number): number | null {
  const dir = finite(weather.windDirection);
  const speed = finite(weather.windSpeed);
  if (dir === null || speed === null) return null;
  return Math.abs(speed * Math.sin(((dir - runwayBearing) * Math.PI) / 180));
}

/**
 * The single worst thing the weather is doing to this spot right now, or null when the weather
 * is unremarkable. Only one caveat is returned — a spotter needs the headline, not a forecast.
 */
function weatherCaveat(weather: Weather | null, direction: RunwayConfig['direction']): WeatherCaveat | null {
  if (weather === null || typeof weather !== 'object') return null;

  const candidates: WeatherCaveat[] = [];

  const vis = visibilityMiles(weather.visibility);
  if (vis !== null && vis < 1.5) {
    candidates.push({
      penalty: 18,
      // No spot is better than any other inside a cloud, however good the runway or the sun.
      cap: FOG_CAP,
      reason: 'Visibility under 1.5 miles — you will hear more than you see',
    });
  } else if (vis !== null && vis < 4) {
    candidates.push({ penalty: 8, reason: `Visibility ${vis} miles — hazy and flat` });
  }

  if (direction !== 'unknown') {
    const runwayBearing = direction === 'westerly' ? 270 : 90;
    const crosswind = crosswindKt(weather, runwayBearing);
    if (crosswind !== null && crosswind >= 20) {
      candidates.push({
        penalty: 8,
        reason: `Crosswind ${Math.round(crosswind)} kt — approaches will be crabbed and rough`,
      });
    }
  }

  const gust = finite(weather.windGust);
  const speed = finite(weather.windSpeed);
  if ((gust !== null && gust >= 30) || (speed !== null && speed >= 25)) {
    const worst = Math.max(gust ?? 0, speed ?? 0);
    candidates.push({
      penalty: 6,
      reason: `Gusting ${Math.round(worst)} kt — exposed and cold at the fence`,
    });
  }

  let worst: WeatherCaveat | null = null;
  for (const candidate of candidates) {
    if (worst === null || candidate.penalty > worst.penalty) worst = candidate;
  }
  return worst;
}

/* ------------------------------------------------------------------ *
 * Runway relevance
 * ------------------------------------------------------------------ */

interface RunwayFit {
  score: number;
  reason: string;
  /** True when none of the spot's runways are in use — the score gets capped. */
  offConfig: boolean;
}

function firstMatch(goodFor: string[], active: string[]): string | null {
  for (const designator of goodFor) {
    if (typeof designator !== 'string') continue;
    const wanted = designator.toUpperCase();
    for (const candidate of active) {
      if (typeof candidate === 'string' && candidate.toUpperCase() === wanted) return wanted;
    }
  }
  return null;
}

function runwayFit(spot: SpotLocation, config: RunwayConfig): RunwayFit {
  const goodFor = Array.isArray(spot.goodFor) ? spot.goodFor : [];

  if (config.direction === 'unknown') {
    return {
      score: SCORE_DIRECTION_UNKNOWN,
      reason: 'Runway direction unknown — this ranking is provisional',
      offConfig: false,
    };
  }

  const landing = Array.isArray(config.landing) ? config.landing : [];
  const departing = Array.isArray(config.departing) ? config.departing : [];
  const seesArrivals = spot.sees === 'arrivals' || spot.sees === 'both';
  const seesDepartures = spot.sees === 'departures' || spot.sees === 'both';

  // Landings first: they are the reason almost everyone comes, and they are the thing this app
  // can predict. A spot that covers a landing runway is scored on that even if it also happens
  // to cover a departure runway.
  const landingMatch = firstMatch(goodFor, landing);
  if (landingMatch !== null) {
    return seesArrivals
      ? {
          score: SCORE_LANDING_MATCH,
          reason: `Landing ${landingMatch} — a runway this spot covers`,
          offConfig: false,
        }
      : {
          score: SCORE_LANDING_MISMATCH,
          reason: `${landingMatch} is landing today, and this is a departures spot`,
          offConfig: false,
        };
  }

  const departingMatch = firstMatch(goodFor, departing);
  if (departingMatch !== null) {
    return seesDepartures
      ? {
          score: SCORE_DEPARTING_MATCH,
          reason: `Departing ${departingMatch} — a runway this spot covers`,
          offConfig: false,
        }
      : {
          score: SCORE_DEPARTING_MISMATCH,
          reason: `${departingMatch} is departing today, and this is an arrivals spot`,
          offConfig: false,
        };
  }

  const covered = goodFor.length > 0 ? goodFor.join('/') : 'this spot';
  return {
    score: 0,
    reason: `Nothing on ${covered} under ${config.direction} operations`,
    offConfig: true,
  };
}

/* ------------------------------------------------------------------ *
 * evaluateSpots
 * ------------------------------------------------------------------ */

function evaluateOne(
  spot: SpotLocation,
  config: RunwayConfig,
  sun: SunInfo,
  weather: Weather | null,
  now: number,
): SpotEvaluation {
  const fit = runwayFit(spot, config);

  const azimuth = finite(sun?.azimuth ?? null) ?? 0;
  const elevation = finite(sun?.elevation ?? null) ?? -90;
  const light = classifyLight(azimuth, elevation, spot.viewBearing);

  let score = BASE_SCORE + fit.score + SCORE_LIGHT[light];
  if (sun?.goldenHour === true) score += SCORE_GOLDEN[light];

  const reasons: string[] = [fit.reason, lightReason(spot, now, light)];

  const confidence = clamp(finite(config?.confidence ?? null) ?? 0, 0, 1);
  if (config.direction !== 'unknown') {
    if (confidence < CONFIDENCE_WEAK) {
      score -= PENALTY_CONFIDENCE_WEAK;
      reasons.push('Runway config unconfirmed — check before you travel');
    } else if (confidence < CONFIDENCE_SOFT) {
      score -= PENALTY_CONFIDENCE_SOFT;
      reasons.push('Runway config still firming up — it could swap');
    }
  }

  const caveat = weatherCaveat(weather, config.direction);
  if (caveat !== null) {
    score -= caveat.penalty;
    reasons.push(caveat.reason);
    if (caveat.cap !== undefined) score = Math.min(score, caveat.cap);
  }

  if (fit.offConfig) score = Math.min(score, WRONG_RUNWAY_CAP);
  const finalScore = Math.round(clamp(score, 0, 100));

  return {
    spot,
    score: finalScore,
    reasons: reasons.slice(0, 3),
    rating: ratingFor(finalScore),
    light,
  };
}

/**
 * Score and rank the spotting locations for the conditions right now, best first.
 *
 * Ties are broken by name so the order is stable frame to frame — a list that reshuffles under
 * the reader's thumb is worse than useless on a phone at the fence.
 */
export function evaluateSpots(
  spots: SpotLocation[],
  config: RunwayConfig,
  sun: SunInfo,
  weather: Weather | null,
  now: number,
): SpotEvaluation[] {
  const at = Number.isFinite(now) ? now : Date.now();
  const list = Array.isArray(spots) ? spots : [];

  // The tracker calls this on every frame; a malformed config must degrade the ranking, never
  // take the snapshot down with it.
  const safeConfig: RunwayConfig =
    config !== null && typeof config === 'object'
      ? config
      : {
          landing: [],
          departing: [],
          direction: 'unknown',
          confidence: 0,
          sampleSize: 0,
          summary: 'Runway configuration unknown',
          updatedAt: at,
        };

  const evaluated: SpotEvaluation[] = [];
  for (const spot of list) {
    if (spot === null || typeof spot !== 'object') continue;
    if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lon)) continue;
    evaluated.push(evaluateOne(spot, safeConfig, sun, weather, at));
  }

  evaluated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.spot.name ?? '').localeCompare(String(b.spot.name ?? ''), 'en');
  });

  return evaluated;
}
