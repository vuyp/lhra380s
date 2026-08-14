/**
 * Whale Watch LHR — server configuration.
 *
 * Every tunable lives here, every tunable is overridable by environment variable, and every
 * default is the value the app should run with on a plain `npm start` with no environment at
 * all. Paths are resolved against the repository root derived from `import.meta.url`, so the
 * server behaves identically regardless of the current working directory.
 */

import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function envString(name: string, fallback: string): string {
  return readEnv(name) ?? fallback;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = readEnv(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = readEnv(name);
  if (raw === null) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envLogLevel(name: string, fallback: LogLevel): LogLevel {
  const raw = readEnv(name);
  if (raw === null) return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'debug' || lower === 'info' || lower === 'warn' || lower === 'error' || lower === 'silent') {
    return lower;
  }
  return fallback;
}

/** Absolute path of the repository root (the directory holding package.json). */
export const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fromRoot(candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(REPO_ROOT, candidate);
}

/** Curated static reference data (`data/`). Read-only at runtime. */
export const DATA_DIR: string = fromRoot(envString('DATA_DIR', 'data'));

/** Mutable runtime state (`data/runtime/`). Created on demand, git-ignored. */
export const RUNTIME_DIR: string = fromRoot(envString('RUNTIME_DIR', join(DATA_DIR, 'runtime')));

/** Append-only JSONL movement log. */
export const MOVEMENT_LOG_FILE: string = fromRoot(
  envString('MOVEMENT_LOG_FILE', join(RUNTIME_DIR, 'movements.jsonl')),
);

/** Built client bundle, served as static files by the API process in production. */
export const CLIENT_DIST_DIR: string = fromRoot(envString('CLIENT_DIST_DIR', join('client', 'dist')));

export const PORT: number = envInt('PORT', 8787, 1, 65535);
export const HOST: string = envString('HOST', '0.0.0.0');

/** Sent upstream on every request so the data providers can identify us. */
export const USER_AGENT = 'whale-watch-lhr/1.0 (+planespotting tool)';

export const LOG_LEVEL: LogLevel = envLogLevel('LOG_LEVEL', 'info');

const ADSB_BASE = envString('ADSB_BASE_URL', 'https://api.adsb.lol');
const AREA_LAT = envFloat('AREA_LAT', 51.4706, -90, 90);
const AREA_LON = envFloat('AREA_LON', -0.4619, -180, 180);
const AREA_RADIUS_NM = envInt('AREA_RADIUS_NM', 60, 1, 250);

export interface UpstreamConfig {
  /** Every A380 (ICAO type A388) currently transmitting, worldwide. */
  readonly a380Url: string;
  /** All traffic within `AREA_RADIUS_NM` of Heathrow — used to derive the runway config. */
  readonly areaUrl: string;
  /** EGLL METAR, JSON format. */
  readonly weatherUrl: string;
  /** Per-request abort timeout, milliseconds. */
  readonly timeoutMs: number;
  /** No upstream host may be contacted more often than this, milliseconds. */
  readonly minIntervalMs: number;
  /** First backoff step after a failure; doubles per consecutive failure. */
  readonly backoffStartMs: number;
  /** Ceiling for the exponential backoff. */
  readonly backoffMaxMs: number;
  readonly userAgent: string;
}

export interface PollConfig {
  /** Worldwide A380 sweep. SPEC §2: every 5 s. */
  readonly fleetMs: number;
  /** Heathrow-area traffic for runway derivation. SPEC §2: every 15 s. */
  readonly areaMs: number;
  /** METAR. SPEC §2: every 5 min. */
  readonly weatherMs: number;
}

export interface Config {
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly movementLogFile: string;
  readonly clientDistDir: string;
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly userAgent: string;
  /** Hard cap on movement log entries held in memory and on disk. */
  readonly movementLogMax: number;
  /** Two log entries for the same airframe + kind inside this window are the same event. */
  readonly movementDedupeMs: number;
  /** A movement is dropped after this long without data (SPEC §5: 20 min coverage gaps). */
  readonly staleMovementMs: number;
  /** Snapshot older than this marks the feed stale in `FeedHealth`. */
  readonly staleFeedMs: number;
  /** Maximum trail points retained per airframe. */
  readonly trailMaxPoints: number;
  /** How long completed movements stay in the snapshot log. */
  readonly logWindowHours: number;
  readonly upstream: UpstreamConfig;
  readonly poll: PollConfig;
}

export const CONFIG: Config = {
  repoRoot: REPO_ROOT,
  dataDir: DATA_DIR,
  runtimeDir: RUNTIME_DIR,
  movementLogFile: MOVEMENT_LOG_FILE,
  clientDistDir: CLIENT_DIST_DIR,
  port: PORT,
  host: HOST,
  logLevel: LOG_LEVEL,
  userAgent: USER_AGENT,
  movementLogMax: envInt('MOVEMENT_LOG_MAX', 5000, 100, 100_000),
  movementDedupeMs: envInt('MOVEMENT_DEDUPE_MS', 10 * 60_000, 1_000, 6 * 3_600_000),
  staleMovementMs: envInt('STALE_MOVEMENT_MS', 20 * 60_000, 60_000, 6 * 3_600_000),
  staleFeedMs: envInt('STALE_FEED_MS', 60_000, 5_000, 3_600_000),
  trailMaxPoints: envInt('TRAIL_MAX_POINTS', 240, 10, 5_000),
  logWindowHours: envInt('LOG_WINDOW_HOURS', 24, 1, 24 * 30),
  upstream: {
    a380Url: envString('ADSB_A388_URL', `${ADSB_BASE}/v2/type/A388`),
    areaUrl: envString('ADSB_AREA_URL', `${ADSB_BASE}/v2/point/${AREA_LAT}/${AREA_LON}/${AREA_RADIUS_NM}`),
    weatherUrl: envString(
      'METAR_URL',
      'https://aviationweather.gov/api/data/metar?ids=EGLL&format=json',
    ),
    timeoutMs: envInt('UPSTREAM_TIMEOUT_MS', 12_000, 1_000, 60_000),
    minIntervalMs: envInt('UPSTREAM_MIN_INTERVAL_MS', 4_000, 0, 60_000),
    backoffStartMs: envInt('UPSTREAM_BACKOFF_START_MS', 2_000, 250, 60_000),
    backoffMaxMs: envInt('UPSTREAM_BACKOFF_MAX_MS', 60_000, 1_000, 600_000),
    userAgent: USER_AGENT,
  },
  poll: {
    fleetMs: envInt('POLL_FLEET_MS', 5_000, 1_000, 600_000),
    areaMs: envInt('POLL_AREA_MS', 15_000, 1_000, 600_000),
    weatherMs: envInt('POLL_WEATHER_MS', 300_000, 30_000, 3_600_000),
  },
};

function emit(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[CONFIG.logLevel]) return;
  const prefix = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}`;
  if (level === 'warn' || level === 'error') {
    console.error(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

/** Tiny level-filtered logger. Everything server-side logs through this. */
export const log = {
  debug(...args: unknown[]): void {
    emit('debug', args);
  },
  info(...args: unknown[]): void {
    emit('info', args);
  },
  warn(...args: unknown[]): void {
    emit('warn', args);
  },
  error(...args: unknown[]): void {
    emit('error', args);
  },
};

export default CONFIG;
