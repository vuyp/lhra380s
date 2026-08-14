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
 *  - nothing is invented. Fields absent upstream stay `null`, and cached payloads returned while
 *    a request is rate-limited have their `ageSeconds` advanced by the real elapsed time.
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

/** Module-level feed health, surfaced in `Snapshot.health`. */
export function upstreamHealth(): { lastSuccessAt: number | null; failures: number } {
  return { lastSuccessAt, failures: consecutiveFailures };
}

interface EndpointState {
  /** Consecutive failures for this endpoint — drives its backoff. */
  failures: number;
  /** Epoch ms before which this endpoint must not be retried. */
  nextAttemptAt: number;
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

function endpointState(url: string): EndpointState {
  const existing = endpoints.get(url);
  if (existing) return existing;
  const created: EndpointState = { failures: 0, nextAttemptAt: 0 };
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
    if (waitMs > 0) await delay(waitMs);
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
  /** Rate-limited or backing off — no request was made, the caller should serve what it has. */
  | { status: 'skipped' }
  | { status: 'failed' };

async function requestJson(url: string, label: string): Promise<FetchOutcome> {
  const state = endpointState(url);
  if (Date.now() < state.nextAttemptAt) return { status: 'skipped' };
  if (!(await acquireHostSlot(url))) return { status: 'skipped' };
  // The backoff may have been extended by a concurrent failure while we waited for the slot.
  if (Date.now() < state.nextAttemptAt) return { status: 'skipped' };

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(CONFIG.upstream.timeoutMs),
      redirect: 'follow',
      headers: {
        'user-agent': CONFIG.upstream.userAgent,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      // Drain the body so the socket can be reused.
      await response.text().catch(() => '');
      return recordFailure(state, label, `HTTP ${response.status} ${response.statusText}`.trim());
    }
    const body: unknown = await response.json();
    state.failures = 0;
    state.nextAttemptAt = 0;
    consecutiveFailures = 0;
    lastSuccessAt = Date.now();
    return { status: 'ok', body };
  } catch (err) {
    return recordFailure(state, label, describeError(err));
  }
}

function recordFailure(state: EndpointState, label: string, reason: string): FetchOutcome {
  state.failures += 1;
  consecutiveFailures += 1;
  const wait = backoffMs(state.failures);
  state.nextAttemptAt = Date.now() + wait;
  // One line per failed attempt. Backoff guarantees this cannot spam during an outage.
  log.warn(
    `upstream ${label} failed (${state.failures} consecutive): ${reason} — retrying in ${Math.round(wait / 1000)}s`,
  );
  return { status: 'failed' };
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

function latitude(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= -90 && n <= 90 ? n : null;
}

function longitude(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= -180 && n <= 180 ? n : null;
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
    altitude = num(altBaro);
    if (altitude === null) {
      // Some frames transmit only a geometric altitude; it is real data, not a guess.
      altitude = num(raw['alt_geom']);
    }
  }
  // A few feeders flag ground state on the geometric field instead.
  const altGeom = raw['alt_geom'];
  if (!onGround && typeof altGeom === 'string' && altGeom.trim().toLowerCase() === 'ground') {
    onGround = true;
    altitude = null;
  }

  const ageSeconds = Math.max(0, num(raw['seen_pos']) ?? num(raw['seen']) ?? 0);

  return {
    hex,
    callsign: upper(raw['flight']),
    registration: upper(raw['r']),
    type: upper(raw['t']),
    lat: latitude(raw['lat']),
    lon: longitude(raw['lon']),
    altitude: onGround ? null : altitude,
    onGround,
    groundSpeed: num(raw['gs']),
    track: normaliseDegrees(num(raw['track']) ?? num(raw['true_heading'])),
    verticalRate: num(raw['baro_rate']) ?? num(raw['geom_rate']),
    squawk: str(raw['squawk']),
    ageSeconds,
    receivedAt: Math.round(feedNowMs - ageSeconds * 1000),
  };
}

function parseAircraftPayload(body: unknown): UpstreamAircraft[] {
  if (!isRecord(body)) return [];
  const raw = body['ac'] ?? body['aircraft'];
  if (!Array.isArray(raw)) return [];
  const feedNowMs = timestampMs(body['now']) ?? Date.now();
  const out: UpstreamAircraft[] = [];
  for (const item of raw) {
    const aircraft = normaliseAircraft(item, feedNowMs);
    if (aircraft !== null) out.push(aircraft);
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
let weatherCache: Weather | null = null;

/** Replay a cached list with its ages advanced by the real elapsed time. */
function replay(cache: AircraftCache): UpstreamAircraft[] {
  const elapsed = Math.max(0, (Date.now() - cache.at) / 1000);
  if (elapsed === 0) return cache.data.map((ac) => ({ ...ac }));
  return cache.data.map((ac) => ({
    ...ac,
    ageSeconds: Math.round((ac.ageSeconds + elapsed) * 10) / 10,
  }));
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Every A380 transmitting worldwide. adsb.lol `/v2/type/A388`. */
export async function fetchA380s(): Promise<UpstreamAircraft[]> {
  const outcome = await requestJson(CONFIG.upstream.a380Url, 'A388 fleet');
  if (outcome.status === 'ok') {
    // The endpoint is already type-scoped; drop anything that positively contradicts it.
    const list = parseAircraftPayload(outcome.body).filter(
      (ac) => ac.type === null || ac.type === 'A388',
    );
    a380Cache = { at: Date.now(), data: list };
    return list;
  }
  if (outcome.status === 'skipped' && a380Cache !== null) return replay(a380Cache);
  return [];
}

/** All traffic within 60 nm of Heathrow, used to derive the live runway config. */
export async function fetchAreaTraffic(): Promise<UpstreamAircraft[]> {
  const outcome = await requestJson(CONFIG.upstream.areaUrl, 'LHR area traffic');
  if (outcome.status === 'ok') {
    const list = parseAircraftPayload(outcome.body);
    areaCache = { at: Date.now(), data: list };
    return list;
  }
  if (outcome.status === 'skipped' && areaCache !== null) return replay(areaCache);
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

function parseMetar(body: unknown): Weather | null {
  const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body['data']) ? body['data'] : null;
  if (list === null) return null;

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
    windSpeed: num(chosen['wspd']),
    windGust: num(chosen['wgst']),
    temperature: num(chosen['temp']),
    visibility: visibility(chosen['visib']),
    cloudCover: upper(chosen['cover']) ?? cloudCoverFromLayers(chosen['clouds']),
    qnh: qnhHpa(chosen['altim']),
    observedAt: Number.isFinite(chosenAt) ? chosenAt : null,
  };
}

/** Latest EGLL METAR. Returns null when unavailable — never throws. */
export async function fetchWeather(): Promise<Weather | null> {
  const outcome = await requestJson(CONFIG.upstream.weatherUrl, 'EGLL METAR');
  if (outcome.status === 'ok') {
    const parsed = parseMetar(outcome.body);
    if (parsed !== null) weatherCache = parsed;
    return parsed;
  }
  if (outcome.status === 'skipped' && weatherCache !== null) return { ...weatherCache };
  return null;
}
