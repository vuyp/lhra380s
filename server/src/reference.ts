/**
 * Whale Watch LHR — curated static reference data.
 *
 * Everything here is loaded once at boot from `data/*.json` and never changes at runtime. These
 * are published facts (airport geometry, fleet lists, airline branding, timetabled rotations),
 * not observations — nothing in this module invents a live value.
 *
 * Every file is optional. A missing or malformed file degrades to an empty set with a warning;
 * the server must still start and still serve live traffic without any of it. The only exception
 * is the airport itself, which falls back to the constants in SPEC.md §5 because the whole app is
 * geometry relative to Heathrow.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Airframe, Airline, Place, Provenance, RouteInfo, RunwayEnd, SpotLocation } from '../../shared/types.ts';
import { CONFIG, log } from './config.ts';

export type AirportRef = {
  icao: string;
  iata: string;
  name: string;
  lat: number;
  lon: number;
  elevationFt: number;
  timezone: string;
  runways: RunwayEnd[];
  /** Airport perimeter as [lat, lon] pairs, closed. */
  boundary: Array<[number, number]>;
};

/** Neutral slate used whenever an operator cannot be identified. */
const UNKNOWN_COLOR = '#8A94A6';

const UNKNOWN_AIRLINE: Airline = {
  icao: null,
  iata: null,
  name: 'Unknown',
  color: UNKNOWN_COLOR,
};

/* ------------------------------------------------------------------ *
 * Loading helpers
 * ------------------------------------------------------------------ */

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

function readJson(fileName: string): unknown {
  const path = join(CONFIG.dataDir, fileName);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    log.warn(`reference: ${fileName} unavailable (${message(err)}) — continuing without it`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * data/airport.json
 * ------------------------------------------------------------------ */

/** SPEC.md §5 — used only if data/airport.json cannot be read. */
const FALLBACK_AIRPORT: AirportRef = {
  icao: 'EGLL',
  iata: 'LHR',
  name: 'London Heathrow',
  lat: 51.4706,
  lon: -0.4619,
  elevationFt: 83,
  timezone: 'Europe/London',
  runways: [
    { designator: '09L', bearing: 89.67, lat: 51.4775, lon: -0.485 },
    { designator: '27R', bearing: 269.71, lat: 51.4779, lon: -0.4334 },
    { designator: '09R', bearing: 89.68, lat: 51.4647, lon: -0.4825 },
    { designator: '27L', bearing: 269.72, lat: 51.465, lon: -0.4341 },
  ],
  boundary: [],
};

function parseRunways(value: unknown): RunwayEnd[] {
  if (!Array.isArray(value)) return [];
  const out: RunwayEnd[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const designator = str(item['designator']);
    const bearing = num(item['bearing']);
    const lat = num(item['lat']);
    const lon = num(item['lon']);
    if (designator === null || bearing === null || lat === null || lon === null) continue;
    out.push({ designator: designator.toUpperCase(), bearing, lat, lon });
  }
  return out;
}

function parseBoundary(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[number, number]> = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const lat = num(item[0]);
    const lon = num(item[1]);
    if (lat === null || lon === null) continue;
    out.push([lat, lon]);
  }
  return out;
}

function loadAirport(): AirportRef {
  const raw = readJson('airport.json');
  if (!isRecord(raw)) return FALLBACK_AIRPORT;

  const lat = num(raw['lat']);
  const lon = num(raw['lon']);
  if (lat === null || lon === null) {
    log.warn('reference: airport.json has no usable position — using built-in EGLL constants');
    return FALLBACK_AIRPORT;
  }

  const runways = parseRunways(raw['runways']);
  if (runways.length === 0) {
    log.warn('reference: airport.json lists no usable runways — using built-in EGLL runways');
  }

  return {
    icao: (str(raw['icao']) ?? FALLBACK_AIRPORT.icao).toUpperCase(),
    iata: (str(raw['iata']) ?? FALLBACK_AIRPORT.iata).toUpperCase(),
    name: str(raw['name']) ?? FALLBACK_AIRPORT.name,
    lat,
    lon,
    elevationFt: int(raw['elevationFt']) ?? FALLBACK_AIRPORT.elevationFt,
    timezone: str(raw['timezone']) ?? FALLBACK_AIRPORT.timezone,
    runways: runways.length > 0 ? runways : FALLBACK_AIRPORT.runways,
    boundary: parseBoundary(raw['boundary']),
  };
}

/** Heathrow, as published. Loaded at boot from data/airport.json. */
export const AIRPORT: AirportRef = loadAirport();

/* ------------------------------------------------------------------ *
 * data/airlines.json
 * ------------------------------------------------------------------ */

interface AirlineRow {
  icao: string;
  iata: string | null;
  name: string;
  color: string;
}

function loadAirlines(): Map<string, AirlineRow> {
  const out = new Map<string, AirlineRow>();
  const raw = readJson('airlines.json');
  if (!isRecord(raw)) return out;
  for (const [code, value] of Object.entries(raw)) {
    const icao = str(code);
    if (icao === null || !isRecord(value)) continue;
    const name = str(value['name']);
    if (name === null) continue;
    out.set(icao.toUpperCase(), {
      icao: icao.toUpperCase(),
      iata: str(value['iata'])?.toUpperCase() ?? null,
      name,
      color: str(value['color']) ?? UNKNOWN_COLOR,
    });
  }
  return out;
}

const AIRLINES: Map<string, AirlineRow> = loadAirlines();

/* ------------------------------------------------------------------ *
 * data/fleet.json
 * ------------------------------------------------------------------ */

interface FleetRow {
  reg: string;
  hex: string | null;
  operatorIcao: string | null;
  operator: string | null;
  msn: string | null;
  delivered: number | null;
  seats: number | null;
  note: string | null;
}

interface FleetIndex {
  rows: FleetRow[];
  byReg: Map<string, FleetRow>;
  byHex: Map<string, FleetRow>;
  /** Registration prefix ("G", "A6", "9V") → the operators using it in the fleet file. */
  operatorsByPrefix: Map<string, Set<string>>;
}

/** "G-XLEA" → "G", "A6-EUA" → "A6". Falls back to the leading alphanumerics. */
function registrationPrefix(registration: string): string {
  const dash = registration.indexOf('-');
  if (dash > 0) return registration.slice(0, dash);
  const match = /^[A-Z]{1,2}[0-9]?/.exec(registration);
  return match !== null ? match[0] : registration.slice(0, 2);
}

function loadFleet(): FleetIndex {
  const index: FleetIndex = {
    rows: [],
    byReg: new Map(),
    byHex: new Map(),
    operatorsByPrefix: new Map(),
  };

  const raw = readJson('fleet.json');
  if (!Array.isArray(raw)) return index;

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const reg = str(item['reg'])?.toUpperCase() ?? null;
    if (reg === null) continue;

    const row: FleetRow = {
      reg,
      hex: str(item['hex'])?.toLowerCase() ?? null,
      operatorIcao: str(item['operatorIcao'])?.toUpperCase() ?? null,
      operator: str(item['operator']),
      msn: str(item['msn']),
      delivered: int(item['delivered']),
      seats: int(item['seats']),
      note: str(item['note']),
    };

    index.rows.push(row);
    if (!index.byReg.has(row.reg)) index.byReg.set(row.reg, row);
    if (row.hex !== null && !index.byHex.has(row.hex)) index.byHex.set(row.hex, row);

    if (row.operatorIcao !== null) {
      const prefix = registrationPrefix(row.reg);
      const operators = index.operatorsByPrefix.get(prefix) ?? new Set<string>();
      operators.add(row.operatorIcao);
      index.operatorsByPrefix.set(prefix, operators);
    }
  }

  return index;
}

const FLEET: FleetIndex = loadFleet();

/* ------------------------------------------------------------------ *
 * data/places.json + data/routes.json
 * ------------------------------------------------------------------ */

function loadPlaces(): Map<string, Place> {
  const out = new Map<string, Place>();
  const raw = readJson('places.json');
  if (!isRecord(raw)) return out;
  for (const [code, value] of Object.entries(raw)) {
    const icao = str(code)?.toUpperCase() ?? null;
    if (icao === null || !isRecord(value)) continue;
    out.set(icao, {
      iata: str(value['iata'])?.toUpperCase() ?? null,
      icao,
      city: str(value['city']),
      country: str(value['country']),
      lat: num(value['lat']),
      lon: num(value['lon']),
    });
  }
  return out;
}

const PLACES: Map<string, Place> = loadPlaces();

interface RouteRow {
  callsign: string;
  origin: string | null;
  destination: string | null;
  blockMinutes: number | null;
}

function loadRoutes(): Map<string, RouteRow> {
  const out = new Map<string, RouteRow>();
  const raw = readJson('routes.json');
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const callsign = str(item['callsign'])?.toUpperCase().replace(/\s+/g, '') ?? null;
    if (callsign === null) continue;
    out.set(callsign, {
      callsign,
      origin: str(item['origin'])?.toUpperCase() ?? null,
      destination: str(item['destination'])?.toUpperCase() ?? null,
      blockMinutes: int(item['blockMinutes']),
    });
  }
  return out;
}

const ROUTES: Map<string, RouteRow> = loadRoutes();

/* ------------------------------------------------------------------ *
 * data/spots.json
 * ------------------------------------------------------------------ */

function parseSees(value: unknown): SpotLocation['sees'] {
  const text = str(value)?.toLowerCase();
  return text === 'arrivals' || text === 'departures' ? text : 'both';
}

function loadSpots(): SpotLocation[] {
  const raw = readJson('spots.json');
  if (!Array.isArray(raw)) return [];

  const out: SpotLocation[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = str(item['id']);
    const name = str(item['name']);
    const lat = num(item['lat']);
    const lon = num(item['lon']);
    if (id === null || name === null || lat === null || lon === null) continue;

    const goodFor = Array.isArray(item['goodFor'])
      ? item['goodFor'].flatMap((entry) => {
          const designator = str(entry);
          return designator === null ? [] : [designator.toUpperCase()];
        })
      : [];

    out.push(
      Object.freeze({
        id,
        name,
        tagline: str(item['tagline']) ?? '',
        lat,
        lon,
        goodFor,
        sees: parseSees(item['sees']),
        viewBearing: ((num(item['viewBearing']) ?? 0) % 360 + 360) % 360,
        access: str(item['access']) ?? '',
        notes: str(item['notes']) ?? '',
        transport: str(item['transport']),
        facilities: str(item['facilities']),
      }),
    );
  }
  return Object.freeze(out) as SpotLocation[];
}

const SPOTS: SpotLocation[] = loadSpots();

log.info(
  `reference: ${FLEET.rows.length} airframes, ${AIRLINES.size} airlines, ${ROUTES.size} rotations, ` +
    `${PLACES.size} places, ${SPOTS.length} spots, ${AIRPORT.runways.length} runway ends`,
);

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function toAirline(row: AirlineRow): Airline {
  return { icao: row.icao, iata: row.iata, name: row.name, color: row.color };
}

function soleOperatorForPrefix(prefix: string): AirlineRow | null {
  const operators = FLEET.operatorsByPrefix.get(prefix);
  if (operators === undefined || operators.size !== 1) return null;
  const only = operators.values().next().value;
  if (typeof only !== 'string') return null;
  return AIRLINES.get(only) ?? null;
}

/**
 * Resolve the operator from the callsign's airline code, falling back to the airframe's
 * registration (exact fleet match first, then an unambiguous registration prefix). Returns a
 * neutral grey "Unknown" airline when nothing matches — never a guess dressed up as a fact.
 */
export function getAirline(airlineIcao: string | null, registration: string | null): Airline {
  const code = str(airlineIcao)?.toUpperCase() ?? null;
  if (code !== null) {
    const row = AIRLINES.get(code);
    if (row !== undefined) return toAirline(row);
  }

  const reg = str(registration)?.toUpperCase() ?? null;
  if (reg !== null) {
    const frame = FLEET.byReg.get(reg);
    if (frame !== undefined) {
      const byOperator = frame.operatorIcao !== null ? AIRLINES.get(frame.operatorIcao) : undefined;
      if (byOperator !== undefined) return toAirline(byOperator);
      if (frame.operator !== null) {
        return { icao: frame.operatorIcao, iata: null, name: frame.operator, color: UNKNOWN_COLOR };
      }
    }

    const byPrefix = soleOperatorForPrefix(registrationPrefix(reg));
    if (byPrefix !== null) return toAirline(byPrefix);
  }

  return { ...UNKNOWN_AIRLINE };
}

/** Everything published about one airframe. Unknown frames come back with null detail, not zeros. */
export function getAirframe(hex: string, registration: string | null): Airframe {
  const id = str(hex)?.toLowerCase() ?? '';
  const reg = str(registration)?.toUpperCase() ?? null;

  const frame = FLEET.byHex.get(id) ?? (reg !== null ? FLEET.byReg.get(reg) : undefined);
  if (frame === undefined) {
    return {
      hex: id,
      registration: reg,
      operator: null,
      msn: null,
      deliveredYear: null,
      seats: null,
      note: null,
    };
  }

  return {
    hex: id,
    registration: frame.reg,
    operator: frame.operator,
    msn: frame.msn,
    deliveredYear: frame.delivered,
    seats: frame.seats,
    note: frame.note,
  };
}

function toPlace(icao: string | null): Place | null {
  if (icao === null) return null;
  const known = PLACES.get(icao);
  if (known !== undefined) return { ...known };
  // We know the airport code but have no gazetteer entry — say exactly that, invent nothing.
  return { iata: null, icao, city: null, country: null, lat: null, lon: null };
}

/** Strip a trailing alpha suffix: "BAW117A" → "BAW117". */
function stripAlphaSuffix(callsign: string): string | null {
  const match = /^([A-Z]{2,3}\d{1,5})[A-Z]{1,2}$/.exec(callsign);
  return match !== null && match[1] !== undefined ? match[1] : null;
}

/** Drop leading zeros in the numeric part: "BAW0117" → "BAW117". */
function stripLeadingZeros(callsign: string): string | null {
  const match = /^([A-Z]{2,3})0+(\d+[A-Z]{0,2})$/.exec(callsign);
  if (match === null) return null;
  const prefix = match[1];
  const rest = match[2];
  return prefix !== undefined && rest !== undefined ? `${prefix}${rest}` : null;
}

/**
 * Look up a curated LHR rotation. Exact callsign first, then the same callsign with a trailing
 * alpha suffix or leading zeros removed. Returns null when nothing matches — the caller marks the
 * route `unknown` rather than inferring a city.
 */
export function lookupRoute(callsign: string | null): RouteInfo | null {
  const base = str(callsign)?.toUpperCase().replace(/\s+/g, '') ?? null;
  if (base === null) return null;

  const candidates: string[] = [base];
  const withoutSuffix = stripAlphaSuffix(base);
  if (withoutSuffix !== null) candidates.push(withoutSuffix);
  for (const candidate of [...candidates]) {
    const withoutZeros = stripLeadingZeros(candidate);
    if (withoutZeros !== null) candidates.push(withoutZeros);
  }

  for (const candidate of candidates) {
    const row = ROUTES.get(candidate);
    if (row === undefined) continue;
    const source: Provenance = 'schedule';
    return {
      origin: toPlace(row.origin),
      destination: toPlace(row.destination),
      source,
      blockMinutes: row.blockMinutes,
    };
  }

  return null;
}

/** The curated spotting locations, ranked later by spots.ts for the live conditions. */
export function getSpots(): SpotLocation[] {
  return SPOTS;
}

/** How many A380 airframes the fleet reference knows about. */
export function fleetSize(): number {
  return FLEET.rows.length;
}
