/**
 * Solar position and sunrise/sunset, computed locally.
 *
 * This is the NOAA Solar Calculator algorithm (the same one behind
 * gml.noaa.gov/grad/solcalc), which is accurate to well under a minute of arc for
 * dates within a few centuries of 2000 — vastly more than a photographer standing
 * at the Myrtle Avenue fence needs. No network, no dependencies.
 *
 * Elevations returned here are *geometric* (true) altitudes, uncorrected for
 * atmospheric refraction. That keeps `sunPosition` exactly consistent with
 * `sunTimes`: at the instants returned by `sunTimes`, the elevation is -0.833°,
 * the standard sunrise/sunset zenith of 90.833° (34' of refraction plus the 16'
 * semi-diameter of the disc).
 */

import type { SunInfo } from '../../shared/types.ts';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Standard zenith angle of the sun's upper limb at sunrise/sunset. */
const SUNRISE_ZENITH_DEG = 90.833;

/** Geometric elevation corresponding to SUNRISE_ZENITH_DEG. */
const HORIZON_ELEVATION_DEG = 90 - SUNRISE_ZENITH_DEG; // -0.833

/** Golden hour: the sun low enough to be warm, high enough to light the subject. */
const GOLDEN_HOUR_MIN_ELEVATION = -4;
const GOLDEN_HOUR_MAX_ELEVATION = 8;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

function toRad(deg: number): number {
  return deg * DEG;
}

function toDeg(rad: number): number {
  return rad * RAD;
}

function clampUnit(value: number): number {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

/** Positive modulo. */
function mod(value: number, modulus: number): number {
  const r = value % modulus;
  return r < 0 ? r + modulus : r;
}

/** Julian day number for an epoch-millisecond timestamp. */
export function julianDay(epochMs: number): number {
  return epochMs / MS_PER_DAY + 2440587.5;
}

/** Julian centuries since J2000.0. */
export function julianCentury(jd: number): number {
  return (jd - 2451545) / 36525;
}

interface SolarState {
  /** Solar declination, degrees. */
  declination: number;
  /** Equation of time, minutes (apparent solar time minus mean solar time). */
  eqTime: number;
}

/** Declination and equation of time for a given Julian century. */
function solarState(t: number): SolarState {
  // Geometric mean longitude of the sun, degrees.
  const meanLongitude = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
  // Geometric mean anomaly of the sun, degrees.
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  // Eccentricity of Earth's orbit.
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const mRad = toRad(meanAnomaly);
  const centre =
    Math.sin(mRad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mRad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mRad) * 0.000289;

  const trueLongitude = meanLongitude + centre;
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(toRad(omega));

  // Mean obliquity of the ecliptic, degrees, plus the nutation correction.
  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(toRad(omega));

  const declination = toDeg(
    Math.asin(clampUnit(Math.sin(toRad(obliquity)) * Math.sin(toRad(apparentLongitude)))),
  );

  const y = Math.tan(toRad(obliquity / 2)) ** 2;
  const l0Rad = toRad(meanLongitude);
  const eqTime =
    4 *
    toDeg(
      y * Math.sin(2 * l0Rad) -
        2 * eccentricity * Math.sin(mRad) +
        4 * eccentricity * y * Math.sin(mRad) * Math.cos(2 * l0Rad) -
        0.5 * y * y * Math.sin(4 * l0Rad) -
        1.25 * eccentricity * eccentricity * Math.sin(2 * mRad),
    );

  return { declination, eqTime };
}

function solarStateAt(epochMs: number): SolarState {
  return solarState(julianCentury(julianDay(epochMs)));
}

/** Minutes elapsed since 00:00 UTC on the day containing `epochMs`. */
function utcMinutesOfDay(epochMs: number): number {
  return mod(epochMs, MS_PER_DAY) / MS_PER_MINUTE;
}

/** 00:00:00 UTC on the day containing `epochMs`. */
function utcDayStart(epochMs: number): number {
  return Math.floor(epochMs / MS_PER_DAY) * MS_PER_DAY;
}

/**
 * Position of the sun as seen from (lat, lon) at the given instant.
 *
 * @returns azimuth in degrees true (0 = north, 90 = east) and geometric
 *          elevation in degrees above the horizon (negative below).
 */
export function sunPosition(at: Date, lat: number, lon: number): { azimuth: number; elevation: number } {
  const epochMs = at.getTime();
  if (!Number.isFinite(epochMs) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { azimuth: 0, elevation: 0 };
  }

  const { declination, eqTime } = solarStateAt(epochMs);

  // Apparent solar time at this longitude, in minutes past solar midnight.
  const trueSolarTime = mod(utcMinutesOfDay(epochMs) + eqTime + 4 * lon, 1440);
  // Hour angle: negative before local solar noon, positive after.
  const hourAngle = trueSolarTime / 4 - 180;

  const latRad = toRad(lat);
  const declRad = toRad(declination);
  const haRad = toRad(hourAngle);

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinDecl = Math.sin(declRad);
  const cosDecl = Math.cos(declRad);

  const cosZenith = clampUnit(sinLat * sinDecl + cosLat * cosDecl * Math.cos(haRad));
  const zenith = Math.acos(cosZenith);
  const elevation = 90 - toDeg(zenith);

  const azDenominator = cosLat * Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(azDenominator) < 1e-9) {
    // Observer at a pole, or the sun exactly overhead: azimuth is undefined.
    // Fall back to the meridian the sun is nearest, which is all a caller can use.
    azimuth = lat >= 0 ? 180 : 0;
  } else {
    const acosArg = clampUnit((sinLat * cosZenith - sinDecl) / azDenominator);
    const azFromSouth = toDeg(Math.acos(acosArg));
    azimuth = hourAngle > 0 ? mod(azFromSouth + 180, 360) : mod(540 - azFromSouth, 360);
  }

  return { azimuth, elevation };
}

/**
 * Hour angle (degrees) of sunrise for a declination and latitude, or null when the
 * sun does not cross the horizon that day (polar day or polar night).
 */
function sunriseHourAngle(lat: number, declination: number): number | null {
  const latRad = toRad(lat);
  const declRad = toRad(declination);
  const cosH =
    Math.cos(toRad(SUNRISE_ZENITH_DEG)) / (Math.cos(latRad) * Math.cos(declRad)) -
    Math.tan(latRad) * Math.tan(declRad);
  if (!Number.isFinite(cosH) || cosH > 1 || cosH < -1) return null;
  return toDeg(Math.acos(cosH));
}

/**
 * Sunrise and sunset for the UTC calendar day containing `at`.
 *
 * @returns epoch milliseconds, or null for each event that does not occur that day
 *          (inside the polar circles in mid-summer or mid-winter).
 */
export function sunTimes(at: Date, lat: number, lon: number): { sunrise: number | null; sunset: number | null } {
  const epochMs = at.getTime();
  if (!Number.isFinite(epochMs) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { sunrise: null, sunset: null };
  }

  const dayStart = utcDayStart(epochMs);
  const minutesToMs = (minutes: number): number => dayStart + minutes * MS_PER_MINUTE;
  const minutesToEpoch = (minutes: number): number => Math.round(minutesToMs(minutes));

  // Solar noon in minutes past 00:00 UTC, refined against its own answer.
  let solarNoon = 720 - 4 * lon - solarStateAt(dayStart + MS_PER_DAY / 2).eqTime;
  for (let i = 0; i < 2; i += 1) {
    solarNoon = 720 - 4 * lon - solarStateAt(minutesToMs(solarNoon)).eqTime;
  }

  const noonState = solarStateAt(minutesToMs(solarNoon));
  const noonHourAngle = sunriseHourAngle(lat, noonState.declination);
  if (noonHourAngle === null) return { sunrise: null, sunset: null };

  // Refine each event using the declination and equation of time at the event
  // itself rather than at noon — worth a few seconds at high latitudes.
  const refine = (initialMinutes: number, sign: 1 | -1): number => {
    let minutes = initialMinutes;
    for (let i = 0; i < 2; i += 1) {
      const state = solarStateAt(minutesToMs(minutes));
      const ha = sunriseHourAngle(lat, state.declination);
      if (ha === null) return minutes;
      minutes = 720 - 4 * lon - state.eqTime + sign * 4 * ha;
    }
    return minutes;
  };

  const sunriseMinutes = refine(solarNoon - 4 * noonHourAngle, -1);
  const sunsetMinutes = refine(solarNoon + 4 * noonHourAngle, 1);

  return {
    sunrise: minutesToEpoch(sunriseMinutes),
    sunset: minutesToEpoch(sunsetMinutes),
  };
}

/** Resolution of the search for the end of the golden hour, and how far ahead it looks. */
const GOLDEN_STEP_MS = 4 * MS_PER_MINUTE;
const GOLDEN_HORIZON_MS = 4 * 3_600_000;
const GOLDEN_BISECTIONS = 5;

function inGoldenBand(elevation: number): boolean {
  return elevation >= GOLDEN_HOUR_MIN_ELEVATION && elevation <= GOLDEN_HOUR_MAX_ELEVATION;
}

/**
 * When the golden hour in progress ends, or null when there is none (or it somehow outlasts the
 * search horizon, which only happens inside the polar circles).
 *
 * The band is bounded by two elevations, so the honest answer is the next crossing of whichever
 * edge the sun is heading for — the sun climbing out of the top of the band after dawn, or
 * sinking through the bottom of it after dusk. Stepped forward, then bisected to about a minute.
 */
function goldenEndsAt(now: number, lat: number, lon: number): number | null {
  for (let t = now + GOLDEN_STEP_MS; t <= now + GOLDEN_HORIZON_MS; t += GOLDEN_STEP_MS) {
    if (inGoldenBand(sunPosition(new Date(t), lat, lon).elevation)) continue;
    let lo = t - GOLDEN_STEP_MS;
    let hi = t;
    for (let i = 0; i < GOLDEN_BISECTIONS; i += 1) {
      const mid = (lo + hi) / 2;
      if (inGoldenBand(sunPosition(new Date(mid), lat, lon).elevation)) lo = mid;
      else hi = mid;
    }
    return Math.round(hi / MS_PER_MINUTE) * MS_PER_MINUTE;
  }
  return null;
}

/** Assemble the wire-contract SunInfo for a moment and a place. */
export function sunInfo(now: number, lat: number, lon: number): SunInfo {
  const at = new Date(Number.isFinite(now) ? now : Date.now());
  const { azimuth, elevation } = sunPosition(at, lat, lon);
  const { sunrise, sunset } = sunTimes(at, lat, lon);

  // Round first, then derive the flags from the rounded value, so the numbers the
  // UI prints and the badges it shows can never contradict each other.
  const reportedElevation = Math.round(elevation * 100) / 100;
  const goldenHour = inGoldenBand(reportedElevation);

  return {
    azimuth: Math.round(azimuth * 100) / 100,
    elevation: reportedElevation,
    sunriseAt: sunrise,
    sunsetAt: sunset,
    goldenHour,
    goldenUntil: goldenHour ? goldenEndsAt(at.getTime(), lat, lon) : null,
    isDaylight: reportedElevation > HORIZON_ELEVATION_DEG,
  };
}
