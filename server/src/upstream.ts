/**
 * Whale Watch LHR — upstream feed clients.
 *
 * Three keyless public endpoints (adsb.lol ×2, aviationweather.gov ×1), polled once per process
 * and fanned out to every client by the tracker. Everything here is defensive:
 *
 *  - no function ever throws on a network, protocol or parse failure — it returns empty/null and
 *    records the failure in `upstreamHealth()`;
 *  - no upstream host is contacted more than once per `minIntervalMs`, even if a caller loops.
 *    A request that arrives inside the window waits for the next slot rather than being dropped,
 *    so a fast poller can never starve a slow one;
 *  - consecutive failures back off exponentially (2 s, 4 s, 8 s … capped at 60 s) per endpoint,
 *    and only one warning is logged per failed attempt — never per retry;
 *  - nothing is invented. Fields absent upstream stay `null`, values outside physical range are
 *    dropped rather than clamped (a clamp is a guess), and the only payload ever replayed from
 *    cache is one that is still inside the rate-limit window — with its `ageSeconds` advanced by
 *    the real elapsed time.
 *
 * The distinction between "throttled" and "unavailable" is the load-bearing one. A throttled call
 * made no request because the last one was seconds ago, so the cache is genuinely current and the
 * caller may use it. An unavailable call means the endpoint is failing or in its backoff window:
 * the caller gets nothing, so the tracker's health block goes stale and the UI can say so. Replaying
 * cache through a backoff window is how a server ends up reporting a healthy feed for an upstream
 * that has been dead for an hour.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { Weather } from '../../shared/types.ts';
import { CONFIG, log } from './config.ts';

export type UpstreamAircraft = {
  /** ICAO 24-bit address, lowercase. The stable identity of an airframe. */
  hex: string;
  /** Trimmed callsign — upstream pads it with trailing spaces. */
  callsign: string | null;
  registration: string | null;
  /** ICAO type designator, e.g. "A388". */
  type: string | null;
  lat: number | null;
  lon: number | null;
  /** Feet. Null when on the ground or not transmitted. */
  altitude: number | null;
  onGround: boolean;
  /**
   * Whether this frame actually said anything about the air/ground state.
   *
   * `alt_baro` carries both facts at once: the string "ground" means on the ground, a number means
   * airborne, and *nothing at all* means neither — a Mode-S-only frame (`{hex, seen}`) is not an
   * airborne aeroplane, it is an aeroplane we heard from without hearing an altitude. `onGround`
   * is false in that case only because the field has to hold something; the caller must consult
   * this flag before treating a change in `onGround` as a physical event.
   */
  groundKnown: boolean;
  /** Knots. */
  groundSpeed: number | null;
  /** Degrees true, 0–360. */
  track: number | null;
  /** Feet per minute, positive = climbing. */
  verticalRate: number | null;
  squawk: string | null;
  /** Age of the position report in seconds. */
  ageSeconds: number;
  /** Epoch ms the position was received upstream. */
  receivedAt: number;
};

/* ------------------------------------------------------------------ *
 * Health + rate limiting
 * ------------------------------------------------------------------ */

let lastSuccessAt: number | null = null;
let consecutiveFailures = 0;

export interface EndpointHealth {
  label: string;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** Consecutive failures for this endpoint. */
  failures: number;
  /** Epoch ms before which this endpoint will not be retried; 0 when it is not backing off. */
  nextAttemptAt: number;
  /** Why the last attempt failed. Null once it has recovered. */
  lastError: string | null;
}

export interface UpstreamHealth {
  lastSuccessAt: number | null;
  failures: number;
  endpoints: EndpointHealth[];
}

/**
 * Per-endpoint feed health. Exposed on /api/health so an outage can be diagnosed from outside
 * the process — which endpoint, since when, with what error, and when it will be retried.
 */
export function upstreamHealth(): UpstreamHealth {
  const list: EndpointHealth[] = [];
  for (const state of endpoints.values()) {
    list.push({
      label: state.label,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      failures: state.failures,
      nextAttemptAt: state.nextAttemptAt,
      lastError: state.lastError,
    });
  }
  return { lastSuccessAt, failures: consecutiveFailures, endpoints: list };
}

interface EndpointState {
  /** Human label, used in logs and in the health block. */
  label: string;
  /** Consecutive failures for this endpoint — drives its backoff. */
  failures: number;
  /** Epoch ms before which this endpoint must not be retried. */
  nextAttemptAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

interface HostSlot {
  /** Epoch ms the next request to this host may be issued. */
  nextAt: number;
  /** Callers currently parked waiting for a slot. */
  waiting: number;
}

/** At most this many callers may queue for a host slot; further callers are told to skip. */
const MAX_HOST_WAITERS = 2;

const endpoints = new Map<string, EndpointState>();
const hosts = new Map<string, HostSlot>();

/**
 * Aborted when the process is shutting down. Without it a poll that is parked waiting for its
 * rate-limit slot, or one waiting out a 12 s upstream timeout, keeps the event loop alive after
 * every socket has been closed — the process then lingers until something kills it.
 */
const shutdownController = new AbortController();

/** Abandon anything in flight. Called from the SIGTERM path; polling never resumes afterwards. */
export function stopUpstream(): void {
  if (!shutdownController.signal.aborted) shutdownController.abort();
}

function endpointState(url: string, label: string): EndpointState {
  const existing = endpoints.get(url);
  if (existing) return existing;
  const created: EndpointState = {
    label,
    failures: 0,
    nextAttemptAt: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
  endpoints.set(url, created);
  return created;
}

function hostSlot(url: string): HostSlot {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const existing = hosts.get(host);
  if (existing) return existing;
  const created: HostSlot = { nextAt: 0, waiting: 0 };
  hosts.set(host, created);
  return created;
}

/**
 * Reserve the next transmit slot for a host, waiting for it if it is close enough. Returns false
 * when the caller should skip this round entirely (queue already deep).
 */
async function acquireHostSlot(url: string): Promise<boolean> {
  const slot = hostSlot(url);
  const interval = CONFIG.upstream.minIntervalMs;
  const now = Date.now();

  if (now >= slot.nextAt) {
    slot.nextAt = now + interval;
    return true;
  }
  if (slot.waiting >= MAX_HOST_WAITERS) return false;

  const scheduledAt = slot.nextAt;
  slot.nextAt = scheduledAt + interval;
  slot.waiting += 1;
  try {
    const waitMs = scheduledAt - Date.now();
    // `ref: false` so a parked poller cannot hold the process open on the way out; the HTTP server
    // is what keeps this process alive, and once it is closed nothing here should.
    if (waitMs > 0) await delay(waitMs, undefined, { ref: false, signal: shutdownController.signal });
  } catch {
    return false; // shutting down: skip this round entirely
  } finally {
    slot.waiting -= 1;
  }
  return true;
}

function backoffMs(failures: number): number {
  const { backoffStartMs, backoffMaxMs } = CONFIG.upstream;
  const step = backoffStartMs * Math.pow(2, Math.max(0, failures - 1));
  return Math.min(backoffMaxMs, step);
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout() rejects with a TimeoutError DOMException.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return `timed out after ${CONFIG.upstream.timeoutMs} ms`;
    }
    const cause = err.cause;
    if (cause instanceof Error && cause.message && cause.message !== err.message) {
      return `${err.message} (${cause.message})`;
    }
    return err.message || err.name;
  }
  return String(err);
}

type FetchOutcome =
  | { status: 'ok'; body: unknown }
  /**
   * No request was made because this host was contacted moments ago. Whatever we already hold is
   * still current, so the caller may serve it.
   */
  | { status: 'throttled' }
  /**
   * The endpoint failed, or is inside the backoff window of a previous failure. The caller has
   * nothing fresh and must say so — it may not dress up cached data as a successful poll.
   */
  | { status: 'unavailable' };

async function requestJson(url: string, label: string): Promise<FetchOutcome> {
  const state = endpointState(url, label);
  if (Date.now() < state.nextAttemptAt) return { status: 'unavailable' };
  if (!(await acquireHostSlot(url))) return { status: 'throttled' };
  // The backoff may have been extended by a concurrent failure while we waited for the slot.
  if (Date.now() < state.nextAttemptAt) return { status: 'unavailable' };

  if (shutdownController.signal.aborted) return { status: 'unavailable' };

  try {
    const response = await fetch(url, {
      // Whichever comes first: the per-request timeout, or the process going away.
      signal: AbortSignal.any([AbortSignal.timeout(CONFIG.upstream.timeoutMs), shutdownController.signal]),
      redirect: 'follow',
      headers: {
        'user-agent': CONFIG.upstream.userAgent,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      // Drain the body so the socket can be reused.
      await response.text().catch(() => '');
      return recordFailure(state, `HTTP ${response.status} ${response.statusText}`.trim());
    }
    const body: unknown = await response.json();
    const now = Date.now();
    state.failures = 0;
    state.nextAttemptAt = 0;
    state.lastSuccessAt = now;
    state.lastError = null;
    consecutiveFailures = 0;
    lastSuccessAt = now;
    return { status: 'ok', body };
  } catch (err) {
    // A request cut short because the process is going away is not an upstream failure, and
    // recording it as one would leave a misleading last line in the log.
    if (shutdownController.signal.aborted) return { status: 'unavailable' };
    return recordFailure(state, describeError(err));
  }
}

/**
 * A 200 whose body is not the feed we asked for is an outage wearing a success code. It gets the
 * same backoff as a 500 — otherwise a permanently misbehaving endpoint is polled every five
 * seconds for as long as the process lives, which is neither useful to us nor kind to a free
 * public API.
 */
function recordPayloadFailure(url: string, reason: string): void {
  const state = endpoints.get(url);
  if (state === undefined) return;
  recordFailure(state, reason);
}

function recordFailure(state: EndpointState, reason: string): FetchOutcome {
  const now = Date.now();
  state.failures += 1;
  consecutiveFailures += 1;
  const wait = backoffMs(state.failures);
  state.nextAttemptAt = now + wait;
  state.lastFailureAt = now;
  state.lastError = reason;
  // One line per failed attempt. Backoff guarantees this cannot spam during an outage.
  log.warn(
    `upstream ${state.label} failed (${state.failures} consecutive): ${reason} — retrying in ${Math.round(
      wait / 1000,
    )}s`,
  );
  return { status: 'unavailable' };
}

/* ------------------------------------------------------------------ *
 * Value coercion — every upstream field is optional, none may be assumed
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number, or a numeric string (adsb.lol occasionally stringifies values). */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function upper(value: unknown): string | null {
  const s = str(value);
  return s === null ? null : s.toUpperCase();
}

function normaliseDegrees(value: number | null): number | null {
  if (value === null) return null;
  const wrapped = ((value % 360) + 360) % 360;
  return Math.round(wrapped * 10) / 10;
}

/**
 * A value outside its physical range is noise, not data: `gs: -1`, `lat: 999`, `alt_baro: 1e12`
 * all turn up in the wild. They are dropped, never clamped — clamping -1 kt to 0 kt would put a
 * moving aeroplane at a standstill on the board, which is a guess dressed as an observation.
 */
function bounded(value: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  return value >= min && value <= max ? value : null;
}

/** Concorde cruised at 1 150 kt; an A380 does 560. Anything past this is a corrupt frame. */
const MAX_GROUND_SPEED_KT = 1200;
/** The lowest airfield on earth sits at −1 266 ft; the highest airliners reach FL450. */
const MIN_ALTITUDE_FT = -2000;
const MAX_ALTITUDE_FT = 70000;
/** A fighter does 50 000 fpm; an airliner a tenth of that. */
const MAX_VERTICAL_RATE_FPM = 30000;
/** A position report older than a day tells us nothing except that the aircraft is gone. */
const MAX_AGE_SECONDS = 86400;

/**
 * Roughly 250 A380s exist and about 12 000 aircraft are airborne worldwide at peak. Either feed
 * returning more than this is broken or hostile, and every byte of it would be copied into every
 * snapshot, every SSE frame and every open response. The ceiling costs nothing in normal
 * operation and keeps one bad payload from taking the process with it.
 */
const MAX_AIRCRAFT_PER_PAYLOAD = 5000;

function latitude(value: unknown): number | null {
  return bounded(num(value), -90, 90);
}

function longitude(value: unknown): number | null {
  return bounded(num(value), -180, 180);
}

/**
 * Mode A squawk: four octal digits. adsb.lol sends it as a string, some feeders as a number —
 * "0723" and 723 are the same code, and 12345 is not a code at all.
 */
function squawkCode(value: unknown): string | null {
  let text: string | null = null;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 7777) {
    text = String(value).padStart(4, '0');
  }
  if (text === null || !/^[0-7]{4}$/.test(text)) return null;
  return text;
}

/** adsb.lol reports `now` in epoch ms; tolerate a seconds-based value defensively. */
function timestampMs(value: unknown): number | null {
  const n = num(value);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function normaliseAircraft(raw: unknown, feedNowMs: number): UpstreamAircraft | null {
  if (!isRecord(raw)) return null;

  const hexRaw = str(raw['hex']);
  if (hexRaw === null) return null;
  const hex = hexRaw.toLowerCase();

  // `alt_baro` is a number OR the literal string "ground".
  const altBaro = raw['alt_baro'];
  let onGround = false;
  let altitude: number | null = null;
  if (typeof altBaro === 'string' && altBaro.trim().toLowerCase() === 'ground') {
    onGround = true;
  } else {
    altitude = bounded(num(altBaro), MIN_ALTITUDE_FT, MAX_ALTITUDE_FT);
    if (altitude === null) {
      // Some frames transmit only a geometric altitude; it is real data, not a guess.
      altitude = bounded(num(raw['alt_geom']), MIN_ALTITUDE_FT, MAX_ALTITUDE_FT);
    }
  }
  // A few feeders flag ground state on the geometric field instead.
  const altGeom = raw['alt_geom'];
  if (!onGround && typeof altGeom === 'string' && altGeom.trim().toLowerCase() === 'ground') {
    onGround = true;
    altitude = null;
  }
  // "on the ground" is stated; "airborne" is only ever inferred from a usable altitude. Neither
  // present means the frame said nothing about it at all.
  const groundKnown = onGround || altitude !== null;

  const rawAge = bounded(num(raw['seen_pos']) ?? num(raw['seen']), 0, MAX_AGE_SECONDS);
  // An absent age is not "brand new" — but it is all we have, and the caller ages it forward from
  // here, so 0 is the only starting point that does not invent staleness either way.
  const ageSeconds = rawAge ?? 0;

  return {
    hex,
    callsign: upper(raw['flight']),
    registration: upper(raw['r']),
    type: upper(raw['t']),
    lat: latitude(raw['lat']),
    lon: longitude(raw['lon']),
    altitude: onGround ? null : altitude,
    onGround,
    groundKnown,
    groundSpeed: bounded(num(raw['gs']), 0, MAX_GROUND_SPEED_KT),
    track: normaliseDegrees(num(raw['track']) ?? num(raw['true_heading'])),
    verticalRate:
      bounded(num(raw['baro_rate']), -MAX_VERTICAL_RATE_FPM, MAX_VERTICAL_RATE_FPM) ??
      bounded(num(raw['geom_rate']), -MAX_VERTICAL_RATE_FPM, MAX_VERTICAL_RATE_FPM),
    squawk: squawkCode(raw['squawk']),
    ageSeconds,
    receivedAt: Math.round(feedNowMs - ageSeconds * 1000),
  };
}

/**
 * Returns null when the body is not an aircraft feed at all (a captive-portal page, an error
 * envelope, `{}`), and an array — possibly empty — when it is. The difference matters: an empty
 * feed is an answer, a body with no aircraft array is a broken endpoint that we should back off
 * from rather than poll every five seconds forever.
 */
export function parseAircraftPayload(body: unknown): UpstreamAircraft[] | null {
  if (!isRecord(body)) return null;
  const raw = body['ac'] ?? body['aircraft'];
  if (!Array.isArray(raw)) return null;
  const feedNowMs = timestampMs(body['now']) ?? Date.now();
  const out: UpstreamAircraft[] = [];
  for (const item of raw) {
    const aircraft = normaliseAircraft(item, feedNowMs);
    if (aircraft !== null) out.push(aircraft);
    if (out.length >= MAX_AIRCRAFT_PER_PAYLOAD) {
      log.warn(
        `upstream payload carried more than ${MAX_AIRCRAFT_PER_PAYLOAD} aircraft — ignoring the rest`,
      );
      break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Caches — only ever replayed while a request is rate-limited
 * ------------------------------------------------------------------ */

interface AircraftCache {
  at: number;
  data: UpstreamAircraft[];
}

let a380Cache: AircraftCache | null = null;
let areaCache: AircraftCache | null = null;

/**
 * A cached payload may only stand in for a live one while the rate limiter is the reason we did
 * not ask again. Twice the minimum interval is the whole of that window, plus one poll of slack.
 */
function replayLimitMs(): number {
  return Math.max(2 * CONFIG.upstream.minIntervalMs, CONFIG.poll.fleetMs) + 1_000;
}

/**
 * Replay a cached list with its ages advanced by the real elapsed time, or null when the cache is
 * too old to speak for the present.
 */
function replay(cache: AircraftCache | null): UpstreamAircraft[] | null {
  if (cache === null) return null;
  const elapsed = (Date.now() - cache.at) / 1000;
  if (elapsed < 0 || elapsed * 1000 > replayLimitMs()) return null;
  if (elapsed === 0) return cache.data.map((ac) => ({ ...ac }));
  return cache.data.map((ac) => ({
    ...ac,
    ageSeconds: Math.round((ac.ageSeconds + elapsed) * 10) / 10,
  }));
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Every A380 transmitting worldwide. adsb.lol `/v2/type/A388`.
 *
 * Returns an empty list when the feed is unavailable — the caller must treat that as "no data",
 * not as "no aeroplanes", and mark the snapshot stale.
 */
export async function fetchA380s(): Promise<UpstreamAircraft[]> {
  const url = CONFIG.upstream.a380Url;
  const outcome = await requestJson(url, 'A388 fleet');
  if (outcome.status === 'ok') {
    const parsed = parseAircraftPayload(outcome.body);
    if (parsed === null) {
      recordPayloadFailure(url, 'response carries no aircraft array');
      return [];
    }
    // The endpoint is already type-scoped; drop anything that positively contradicts it.
    const list = parsed.filter((ac) => ac.type === null || ac.type === 'A388');
    a380Cache = { at: Date.now(), data: list };
    return list;
  }
  if (outcome.status === 'throttled') return replay(a380Cache) ?? [];
  return [];
}

/** All traffic within 60 nm of Heathrow, used to derive the live runway config. */
export async function fetchAreaTraffic(): Promise<UpstreamAircraft[]> {
  const url = CONFIG.upstream.areaUrl;
  const outcome = await requestJson(url, 'LHR area traffic');
  if (outcome.status === 'ok') {
    const list = parseAircraftPayload(outcome.body);
    if (list === null) {
      recordPayloadFailure(url, 'response carries no aircraft array');
      return [];
    }
    areaCache = { at: Date.now(), data: list };
    return list;
  }
  if (outcome.status === 'throttled') return replay(areaCache) ?? [];
  return [];
}

/* ---------------------------- METAR ---------------------------- */

const COVER_RANK: Record<string, number> = {
  SKC: 0,
  CLR: 0,
  CAVOK: 0,
  NCD: 0,
  NSC: 0,
  FEW: 1,
  SCT: 2,
  BKN: 3,
  OVC: 4,
  OVX: 5,
};

/** The layer a spotter cares about: the most significant cover reported. */
function cloudCoverFromLayers(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let best: string | null = null;
  let bestRank = -1;
  for (const layer of value) {
    if (!isRecord(layer)) continue;
    const cover = upper(layer['cover']);
    if (cover === null) continue;
    const rank = COVER_RANK[cover] ?? 1;
    if (rank > bestRank) {
      bestRank = rank;
      best = cover;
    }
  }
  return best;
}

/** `wdir` is a number, the string "VRB" for variable wind, or absent. */
function windDirection(value: unknown): number | null {
  if (typeof value === 'string' && value.trim().toUpperCase() === 'VRB') return null;
  const n = num(value);
  if (n === null) return null;
  return normaliseDegrees(n === 360 ? 360 : n);
}

/** `visib` is a number (statute miles) or a string such as "10+". Reported verbatim. */
function visibility(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : null;
  }
  return str(value);
}

/** `altim` is hectopascals from this API, but tolerate inches of mercury. */
function qnhHpa(value: unknown): number | null {
  const n = num(value);
  if (n === null) return null;
  if (n >= 800 && n <= 1100) return Math.round(n);
  if (n >= 25 && n <= 33) return Math.round(n * 33.8639);
  return null;
}

function observationTime(record: Record<string, unknown>): number | null {
  const obs = timestampMs(record['obsTime']);
  if (obs !== null) return obs;
  for (const key of ['reportTime', 'receiptTime']) {
    const text = str(record[key]);
    if (text === null) continue;
    // These come back as "2026-08-14 12:20:00" (UTC, no zone marker).
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)
      ? `${text.replace(' ', 'T')}Z`
      : text;
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** The observation list, or null when the body is not a METAR response at all. */
function metarList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body['data'])) return body['data'];
  return null;
}

/** Newest observation in the list, or null when the list holds nothing usable. */
export function parseMetar(list: readonly unknown[]): Weather | null {
  let chosen: Record<string, unknown> | null = null;
  let chosenAt = -Infinity;
  for (const item of list) {
    if (!isRecord(item)) continue;
    const at = observationTime(item) ?? -Infinity;
    if (chosen === null || at > chosenAt) {
      chosen = item;
      chosenAt = at;
    }
  }
  if (chosen === null) return null;

  return {
    raw: str(chosen['rawOb']),
    windDirection: windDirection(chosen['wdir']),
    // The strongest surface wind ever recorded is 231 kt; −80 °C is colder than Vostok.
    windSpeed: bounded(num(chosen['wspd']), 0, 250),
    windGust: bounded(num(chosen['wgst']), 0, 250),
    temperature: bounded(num(chosen['temp']), -80, 60),
    visibility: visibility(chosen['visib']),
    cloudCover: upper(chosen['cover']) ?? cloudCoverFromLayers(chosen['clouds']),
    qnh: qnhHpa(chosen['altim']),
    observedAt: chosenAt > 0 && Number.isFinite(chosenAt) ? chosenAt : null,
  };
}

/**
 * Latest EGLL METAR, or null when it is unavailable — never throws.
 *
 * There is deliberately no cache here: a METAR carries its own `observedAt`, and the tracker keeps
 * the last one it was given, so an outage leaves an observation that is visibly an hour old rather
 * than a fresh-looking copy of it.
 */
export async function fetchWeather(): Promise<Weather | null> {
  const url = CONFIG.upstream.weatherUrl;
  const outcome = await requestJson(url, 'EGLL METAR');
  if (outcome.status !== 'ok') return null;

  const list = metarList(outcome.body);
  if (list === null) {
    recordPayloadFailure(url, 'response is not a METAR list');
    return null;
  }
  // An empty list is a real answer: no current observation for EGLL. Nothing to report, nothing
  // to back off from.
  return parseMetar(list);
}
