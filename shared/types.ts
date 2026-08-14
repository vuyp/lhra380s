/**
 * Whale Watch LHR — the wire contract.
 *
 * Imported verbatim by both the server and the client. Nothing in here may depend on
 * anything else in the repo, and nothing here may be changed without updating SPEC.md.
 */

export const AIRPORT_ICAO = 'EGLL';
export const AIRPORT_IATA = 'LHR';

/** Where an A380 sits in its relationship with Heathrow. See SPEC.md §5. */
export type FlightPhase =
  | 'inbound'
  | 'approach'
  | 'landed'
  | 'stand'
  | 'taxi_out'
  | 'departing'
  | 'climb_out'
  | 'outbound'
  | 'elsewhere';

/** Which board a movement belongs on. */
export type MovementKind = 'arrival' | 'departure' | 'ground';

/** How confident we are about a derived value — the UI must surface this honestly. */
export type Provenance = 'observed' | 'schedule' | 'inferred' | 'unknown';

export interface Telemetry {
  /** Barometric altitude in feet, or null when the aircraft is on the ground. */
  altitude: number | null;
  onGround: boolean;
  /** Ground speed, knots. */
  groundSpeed: number | null;
  /** Track over ground, degrees true. */
  track: number | null;
  /** Vertical rate, feet per minute. Positive = climbing. */
  verticalRate: number | null;
  lat: number | null;
  lon: number | null;
  squawk: string | null;
  /** Seconds since this position was received upstream. */
  ageSeconds: number;
}

export interface Airline {
  /** ICAO airline code parsed from the callsign, e.g. "UAE". */
  icao: string | null;
  /** IATA code where known, e.g. "EK". */
  iata: string | null;
  name: string;
  /** Brand colour used for the accent bar. Hex, e.g. "#d71921". */
  color: string;
}

export interface Airframe {
  /** ICAO 24-bit address, lowercase hex. The stable identity of an airframe. */
  hex: string;
  /** Registration, e.g. "G-XLEF". */
  registration: string | null;
  /** Airline that operates this frame, from the fleet reference. */
  operator: string | null;
  /** Manufacturer serial number, from the fleet reference. */
  msn: string | null;
  /** First flight / delivery year, from the fleet reference. */
  deliveredYear: number | null;
  /** Passenger capacity of this operator's A380 configuration. */
  seats: number | null;
  /** Special livery or notable fact, if any. */
  note: string | null;
}

export interface Place {
  iata: string | null;
  icao: string | null;
  /** City name for display, e.g. "Dubai". */
  city: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
}

export interface RouteInfo {
  origin: Place | null;
  destination: Place | null;
  source: Provenance;
  /** Scheduled block time from the reference table, in minutes, when known. */
  blockMinutes: number | null;
}

export interface RunwayPrediction {
  /** Runway designator, e.g. "27R". */
  runway: string | null;
  source: Provenance;
  /** 0–1. */
  confidence: number;
}

export interface EtaInfo {
  /** Epoch ms of predicted touchdown / actual off-block, or null when unknowable. */
  at: number | null;
  /** Minutes remaining, already smoothed and rounded. Null when unknowable. */
  minutes: number | null;
  source: Provenance;
}

/** One A380 with a live relationship to Heathrow. */
export interface Movement {
  /** Stable id: the ICAO hex. */
  id: string;
  kind: MovementKind;
  phase: FlightPhase;
  /** Trimmed callsign, e.g. "UAE1". Null when the aircraft is not transmitting one. */
  callsign: string | null;
  /** Human flight number where derivable from the callsign, e.g. "EK1". */
  flightNumber: string | null;
  airline: Airline;
  airframe: Airframe;
  route: RouteInfo;
  telemetry: Telemetry;
  /** Great-circle distance to LHR in nautical miles. */
  distanceNm: number | null;
  /** True bearing from LHR to the aircraft, degrees. */
  bearingFromAirport: number | null;
  eta: EtaInfo;
  runway: RunwayPrediction;
  /** Epoch ms of the actual event (touchdown or wheels-up) once observed. */
  actualAt: number | null;
  /** Epoch ms when this movement was first seen in this session. */
  firstSeen: number;
  /** Epoch ms of the most recent position update. */
  lastSeen: number;
  /** True when the feed has gone quiet and we are coasting on the last known state. */
  coasting: boolean;
  /** Recent positions, oldest first, for the map trail. */
  trail: TrailPoint[];
}

export interface TrailPoint {
  t: number;
  lat: number;
  lon: number;
  alt: number | null;
}

export interface RunwayEnd {
  /** e.g. "27R". */
  designator: string;
  /** True bearing of the runway centreline in this direction. */
  bearing: number;
  /** Threshold coordinates. */
  lat: number;
  lon: number;
}

export interface RunwayConfig {
  /** Runway designators currently being used for landings, e.g. ["27R"]. */
  landing: string[];
  /** Runway designators currently being used for departures, e.g. ["27L"]. */
  departing: string[];
  /** 'westerly' | 'easterly' — the operating direction. */
  direction: 'westerly' | 'easterly' | 'unknown';
  /** 0–1, from how much traffic agreed. */
  confidence: number;
  /** How many aircraft the derivation was based on. */
  sampleSize: number;
  /** Human sentence, e.g. "Westerly operations — landing 27R, departing 27L". */
  summary: string;
  updatedAt: number;
}

export interface Weather {
  /** Raw METAR text. */
  raw: string | null;
  windDirection: number | null;
  windSpeed: number | null;
  windGust: number | null;
  /** Celsius. */
  temperature: number | null;
  /** Statute miles or "6+" style string as reported. */
  visibility: string | null;
  /** e.g. "CLR", "BKN". */
  cloudCover: string | null;
  /** QNH in hectopascals. */
  qnh: number | null;
  observedAt: number | null;
}

export interface SunInfo {
  /** Degrees true. */
  azimuth: number;
  /** Degrees above the horizon; negative when below. */
  elevation: number;
  sunriseAt: number | null;
  sunsetAt: number | null;
  /** True during the hour after sunrise / before sunset. */
  goldenHour: boolean;
  isDaylight: boolean;
}

export interface SpotLocation {
  id: string;
  name: string;
  /** One-line hook, e.g. "The classic — jets 60 m overhead on short final". */
  tagline: string;
  lat: number;
  lon: number;
  /** Runway ends this spot is good for, e.g. ["27L", "27R"]. */
  goodFor: string[];
  /** 'arrivals' | 'departures' | 'both'. */
  sees: 'arrivals' | 'departures' | 'both';
  /** Compass bearing you look towards from this spot, degrees true. */
  viewBearing: number;
  /** Walking/transport directions. */
  access: string;
  /** What the spot is actually like — honest, practical. */
  notes: string;
  /** Nearest Underground / Elizabeth line / bus. */
  transport: string | null;
  /** Free-form facilities, e.g. "Cafe, toilets, parking (paid)". */
  facilities: string | null;
}

export interface SpotEvaluation {
  spot: SpotLocation;
  /** 0–100 for the current conditions. */
  score: number;
  /** Why it scored that — short, human, e.g. "Landing 27R lines up here · sun behind you". */
  reasons: string[];
  /** 'excellent' | 'good' | 'fair' | 'poor' for the current config. */
  rating: 'excellent' | 'good' | 'fair' | 'poor';
  /** Whether the sun is behind the photographer (good) or in frame (bad). */
  light: 'ideal' | 'workable' | 'backlit' | 'dark';
  /** Straight-line distance from the user, nautical miles — client-side only. */
  distanceKm?: number;
}

/** An A380 somewhere in the world with no current Heathrow relationship. */
export interface GlobalAircraft {
  hex: string;
  callsign: string | null;
  registration: string | null;
  operator: string | null;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  track: number | null;
  groundSpeed: number | null;
  onGround: boolean;
}

/** A completed movement, appended to the log. */
export interface LoggedMovement {
  id: string;
  kind: 'arrival' | 'departure';
  at: number;
  callsign: string | null;
  flightNumber: string | null;
  registration: string | null;
  operator: string;
  operatorColor: string;
  runway: string | null;
  /** Origin for arrivals, destination for departures. */
  city: string | null;
}

export interface FeedHealth {
  /** Epoch ms of the last successful upstream poll. */
  lastPollAt: number | null;
  /** True when the last poll failed or is older than 60s. */
  stale: boolean;
  /** Consecutive upstream failures. */
  failures: number;
  /** Seconds between polls. */
  pollIntervalSeconds: number;
  /** Server uptime in seconds. */
  uptimeSeconds: number;
}

export interface Snapshot {
  /** Epoch ms this snapshot was generated. */
  ts: number;
  arrivals: Movement[];
  departures: Movement[];
  ground: Movement[];
  runwayConfig: RunwayConfig;
  weather: Weather;
  sun: SunInfo;
  /** All A380s worldwide, including the ones above, for the fleet/global view. */
  worldwide: GlobalAircraft[];
  /** Completed movements, newest first, last 24 h. */
  log: LoggedMovement[];
  stats: {
    /** A380s airborne worldwide right now. */
    airborneWorldwide: number;
    /** Arrivals logged today (local London date). */
    arrivalsToday: number;
    departuresToday: number;
    /** Distinct registrations seen at LHR today. */
    airframesToday: number;
  };
  health: FeedHealth;
}

/** GET /api/aircraft/:hex */
export interface AircraftDetail {
  movement: Movement | null;
  global: GlobalAircraft | null;
  airframe: Airframe;
  /** Movements logged for this airframe, newest first. */
  history: LoggedMovement[];
}

/** Server-sent event names on /api/stream. */
export const SSE_EVENT_SNAPSHOT = 'snapshot';
export const SSE_EVENT_PING = 'ping';
