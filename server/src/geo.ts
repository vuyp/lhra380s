/**
 * Spherical geometry helpers.
 *
 * Every function here is pure and side-effect free: no I/O, no clock, no globals.
 * Distances are nautical miles, angles are degrees true unless stated otherwise.
 *
 * The Earth is modelled as a sphere of radius 3440.065 nm (the WGS-84 mean radius,
 * 6371.0088 km). That is accurate to roughly 0.5 % over any distance, which is far
 * finer than the resolution of the data we feed it.
 */

export type LatLon = { lat: number; lon: number };

/** Mean Earth radius in nautical miles. */
export const EARTH_RADIUS_NM = 3440.065;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function toRad(deg: number): number {
  return deg * DEG;
}

function toDeg(rad: number): number {
  return rad * RAD;
}

/** Clamp into [-1, 1] so floating-point drift never turns asin/acos into NaN. */
function clampUnit(value: number): number {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

/** Normalise any angle into [0, 360). */
export function normaliseBearing(deg: number): number {
  if (!Number.isFinite(deg)) return deg;
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Normalise a longitude into [-180, 180]. */
export function normaliseLon(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  // Values already in range are returned untouched: the modulo below is exact in
  // theory but introduces a few ulps of drift in floating point.
  if (lon >= -180 && lon <= 180) return lon;
  return (((lon + 180) % 360) + 360) % 360 - 180;
}

/**
 * Great-circle distance between two points, in nautical miles.
 *
 * Haversine — numerically stable for the short distances that dominate here
 * (an aircraft a few hundred metres from a runway threshold).
 */
export function distanceNm(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  // Longitude difference is taken through the shorter way round, so the
  // antimeridian is not a special case.
  const dLon = toRad(normaliseLon(b.lon - a.lon));

  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLon = Math.sin(dLon / 2);
  const h = sinHalfLat * sinHalfLat + Math.cos(lat1) * Math.cos(lat2) * sinHalfLon * sinHalfLon;
  const c = 2 * Math.asin(Math.sqrt(clampUnit(h)));
  return EARTH_RADIUS_NM * c;
}

/**
 * Initial great-circle bearing (forward azimuth) from `from` to `to`, degrees true, 0..360.
 *
 * Identical points yield 0 rather than NaN — atan2(0, 0) is defined as 0.
 */
export function bearing(from: LatLon, to: LatLon): number {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(normaliseLon(to.lon - from.lon));

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  if (y === 0 && x === 0) return 0;
  return normaliseBearing(toDeg(Math.atan2(y, x)));
}

/** Smallest absolute difference between two headings, 0..180. */
export function angularDelta(a: number, b: number): number {
  const diff = Math.abs(normaliseBearing(a) - normaliseBearing(b));
  return diff > 180 ? 360 - diff : diff;
}

/**
 * The point reached by travelling `distanceNmValue` nm from `from` along `bearingDeg`.
 * Longitude is normalised into [-180, 180], so crossing the antimeridian is safe.
 */
export function destinationPoint(from: LatLon, bearingDeg: number, distanceNmValue: number): LatLon {
  const angular = distanceNmValue / EARTH_RADIUS_NM;
  const brg = toRad(bearingDeg);
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAng = Math.sin(angular);
  const cosAng = Math.cos(angular);

  const sinLat2 = clampUnit(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(brg));
  const lat2 = Math.asin(sinLat2);
  const lon2 =
    lon1 + Math.atan2(Math.sin(brg) * sinAng * cosLat1, cosAng - sinLat1 * sinLat2);

  return { lat: toDeg(lat2), lon: normaliseLon(toDeg(lon2)) };
}

/**
 * Signed cross-track distance of `point` from the great circle through
 * `pathStart` → `pathEnd`, in nautical miles.
 *
 * Positive means the point lies to the **right** of the path as travelled
 * (east of a northbound track); negative means to the left.
 *
 * A degenerate path (start and end at the same place) has no direction, so the
 * result is 0 rather than NaN.
 */
export function crossTrackNm(point: LatLon, pathStart: LatLon, pathEnd: LatLon): number {
  const d13 = distanceNm(pathStart, point);
  if (d13 === 0) return 0;
  if (distanceNm(pathStart, pathEnd) === 0) return 0;

  const angular13 = d13 / EARTH_RADIUS_NM;
  const theta13 = toRad(bearing(pathStart, point));
  const theta12 = toRad(bearing(pathStart, pathEnd));

  const sinXt = clampUnit(Math.sin(angular13) * Math.sin(theta13 - theta12));
  return Math.asin(sinXt) * EARTH_RADIUS_NM;
}

/**
 * Signed along-track distance: how far along the `pathStart` → `pathEnd` great circle
 * the projection of `point` falls, in nautical miles.
 *
 * Negative means the point projects *behind* `pathStart`. Values greater than the
 * path length mean it projects beyond `pathEnd` — both are useful (an aircraft on
 * an extended centreline is "behind" the threshold).
 */
export function alongTrackNm(point: LatLon, pathStart: LatLon, pathEnd: LatLon): number {
  const d13 = distanceNm(pathStart, point);
  if (d13 === 0) return 0;
  if (distanceNm(pathStart, pathEnd) === 0) return 0;

  const angular13 = d13 / EARTH_RADIUS_NM;
  const theta13 = toRad(bearing(pathStart, point));
  const theta12 = toRad(bearing(pathStart, pathEnd));
  const deltaTheta = theta13 - theta12;

  const angularXt = Math.asin(clampUnit(Math.sin(angular13) * Math.sin(deltaTheta)));
  const cosXt = Math.cos(angularXt);
  // cos(cross-track) only vanishes a quarter of the globe off the path; guard anyway.
  if (Math.abs(cosXt) < 1e-12) return 0;

  const angularAt = Math.acos(clampUnit(Math.cos(angular13) / cosXt));
  const sign = Math.cos(deltaTheta) < 0 ? -1 : 1;
  return sign * angularAt * EARTH_RADIUS_NM;
}

/**
 * Ray-casting point-in-polygon test.
 *
 * `polygon` is a list of [lat, lon] pairs (the shape used by data/airport.json).
 * The ring may be open or closed — the last vertex is joined back to the first
 * either way.
 *
 * Longitudes are unwrapped edge by edge into one continuous frame, and the test
 * point is then brought into that same frame, so a polygon straddling the
 * antimeridian works. This assumes the ring is small relative to the globe and
 * that consecutive vertices are less than 180° apart — true of every boundary we
 * use, and of any sane polygon.
 *
 * Points exactly on an edge are not guaranteed to fall on a particular side; the
 * airport boundary is used with metres of margin, so that is immaterial here.
 */
export function pointInPolygon(point: LatLon, polygon: Array<[number, number]>): boolean {
  if (polygon.length < 3) return false;
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return false;

  const xs: number[] = [];
  const ys: number[] = [];
  let previousLon: number | null = null;
  for (const vertex of polygon) {
    if (!vertex) continue;
    const [vLat, vLon] = vertex;
    if (!Number.isFinite(vLat) || !Number.isFinite(vLon)) continue;
    const unwrapped: number =
      previousLon === null ? vLon : previousLon + normaliseLon(vLon - previousLon);
    previousLon = unwrapped;
    ys.push(vLat);
    xs.push(unwrapped);
  }

  const n = xs.length;
  if (n < 3) return false;

  // Bring the test point into the polygon's longitude frame.
  let sumX = 0;
  for (const value of xs) sumX += value;
  const centreX = sumX / n;
  const y = point.lat;
  const x = centreX + normaliseLon(point.lon - centreX);

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = xs[i];
    const yi = ys[i];
    const xj = xs[j];
    const yj = ys[j];
    if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) continue;

    const straddles = yi > y !== yj > y;
    if (!straddles) continue;
    // yj - yi cannot be 0 here: the straddle test already proved they differ.
    const xIntersect = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (x < xIntersect) inside = !inside;
  }
  return inside;
}
