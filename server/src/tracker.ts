/**
 * Whale Watch LHR — the tracker.
 *
 * One poller per process, three independent timers, one in-memory state machine, and a snapshot
 * that any number of HTTP clients can read for free.
 *
 *   fetchA380s()      every  5 s   worldwide A388 sweep — drives everything
 *   fetchAreaTraffic() every 15 s   LHR-area traffic     — drives the runway config
 *   fetchWeather()    every  5 min  EGLL METAR
 *
 * The timers are staggered so they never fire in the same tick, they are `unref`ed so the process
 * can still exit, and no callback is allowed to throw: an upstream failure marks the feed stale and
 * the last good state keeps being served.
 *
 * Honesty rules that this module exists to enforce (SPEC §5, §7):
 *
 *  - Nothing is invented. A field we do not observe stays null, and every derived value carries a
 *    `Provenance` saying where it came from.
 *  - Arrival intent has to be earned. A flight is `inbound` only while it is actually closing on
 *    Heathrow with its track pointing here, and a timetable that says somewhere else is a veto.
 *    Geometry alone may assert an arrival within 180 nm, where the descent profile can separate
 *    an arrival from an overflight; beyond that it takes a curated rotation naming EGLL, because
 *    Emirates, Lufthansa and Qatar A380s cross southern England at cruise every day, closing on
 *    Heathrow and pointing straight at it, on their way to America.
 *  - Phases are hysteretic: a new phase must be seen on two consecutive polls before it takes
 *    effect. The two exceptions are `landed` and `departing`, which are observable physical events
 *    (wheels down inside the airport, 60 kt+ on a centreline) and apply the moment they happen.
 *  - ADS-B coverage has holes the size of the Atlantic. A flight that stops transmitting keeps its
 *    last known state with `coasting: true` for 20 minutes (90 for `outbound`, which is leaving
 *    coverage by definition) before it is dropped.
 */

import { join } from 'node:path';

import type {
  AircraftDetail,
  Airframe,
  Airline,
  EtaInfo,
  FeedHealth,
  FlightPhase,
  GlobalAircraft,
  LoggedMovement,
  Movement,
  MovementKind,
  Place,
  Provenance,
  RouteInfo,
  RunwayConfig,
  RunwayEnd,
  RunwayPrediction,
  Snapshot,
  SpotEvaluation,
  SunInfo,
  TrailPoint,
  Weather,
} from '../../shared/types.ts';

import { parseCallsign } from './callsign.ts';
import { CONFIG } from './config.ts';
import {
  alongTrackNm,
  angularDelta,
  bearing,
  crossTrackNm,
  destinationPoint,
  distanceNm,
  pointInPolygon,
  type LatLon,
} from './geo.ts';
import { createLogger } from './log.ts';
import { AIRPORT, getAirframe, getAirline, getSpots, lookupRoute } from './reference.ts';
import { deriveRunwayConfig, predictArrivalRunway, predictDepartureRunway } from './runway.ts';
import { evaluateSpots } from './spots.ts';
import { MovementStore } from './store.ts';
import { sunInfo } from './sun.ts';
import { fetchA380s, fetchAreaTraffic, fetchWeather, type UpstreamAircraft } from './upstream.ts';

const log = createLogger('tracker');

/* ------------------------------------------------------------------ *
 * Tunables (the ones SPEC pins down are named after the rule they serve)
 * ------------------------------------------------------------------ */

/** Trail points are only appended when the aircraft actually moved… */
const TRAIL_MIN_MOVE_NM = 0.05;
/** …or when this long has passed, so a holding aircraft still leaves a trace. */
const TRAIL_MIN_INTERVAL_MS = 20_000;

/** SPEC §5: a flight survives 20 minutes without data. */
const COAST_MS = CONFIG.staleMovementMs;
/** …except `outbound`, which is flying out of receiver coverage on purpose. */
const OUTBOUND_COAST_MS = 90 * 60_000;

/** A movement is `coasting` once the feed has been quiet for this long. */
const COASTING_AFTER_MS = 30_000;
/** …or once the last position report is this old, wherever it came from. */
const COASTING_AGE_SECONDS = 120;

/** `worldwide` shows every A380 seen in this window. */
const WORLDWIDE_WINDOW_MS = 15 * 60_000;

/**
 * The furthest back a movement-log query may reach. The store holds `movementLogMax` entries with
 * no age limit, so this is a bound on the answer's size rather than on what is known.
 */
const MAX_MOVEMENT_QUERY_HOURS = 7 * 24;

/** Beyond this an aircraft is not shown as an arrival, however well it lines up. */
const INBOUND_MAX_NM = 2500;
/** Bearing-to-LHR must be within this of the track for a flight to count as closing. */
const INBOUND_CONE_DEG = 55;

/**
 * Geometry alone may only assert an arrival inside this range.
 *
 * Beyond it, an A380 closing on Heathrow at cruise is indistinguishable from an A380 crossing
 * the UK on its way somewhere else — and a great many of them do: Emirates DXB–JFK/IAD/ORD,
 * Lufthansa FRA–LAX/SFO and Qatar DOH–JFK all overfly southern England at cruise, pointing
 * straight at Heathrow for the better part of an hour. Past this radius the only thing that may
 * put an aircraft on the arrivals board is the curated timetable saying it is coming here.
 *
 * It is also bounded from the other side, by the descent test that replaced the old cruise veto.
 * "Descending and closing on Heathrow" is true of every A380 landing at Paris, Amsterdam or
 * Brussels, and the recording contains a Singapore A380 descending hard through FL300 while still
 * 475 nm from Heathrow, bound for somewhere else entirely. Charles de Gaulle is 188 nm from
 * Heathrow and Schiphol 200 nm, so the window has to stop short of them or their arrivals
 * become ours.
 */
const GEOMETRIC_INBOUND_MAX_NM = 175;

/**
 * The descent profile an arrival has to be under, feet: the standard 3:1 slope with generous
 * slack for a late descent (26 400 ft at 40 nm, 36 300 ft at 100 nm).
 */
const PROFILE_BASE_FT = 3000;
const PROFILE_SLOPE_FT_PER_NM = 330;

/**
 * How far above that slope an aircraft may still be claimed as an arrival, given it is coming
 * down. A descent starting late is normal and the slope above is deliberately generous, but there
 * is a point past which no vertical rate rescues the geometry: the recorded Lufthansa overflight
 * crossed 18 nm from Heathrow at FL360, some 27 000 ft above the slope, and a single -300 fpm
 * sample in the middle of that must never be enough to put it on the board.
 */
const PROFILE_SLACK_FT = 12_000;

/**
 * Inside this range an arrival has unambiguously left cruise: nothing landing at Heathrow is
 * still in the flight levels at 60 nm, so altitude alone separates an arrival from an overflight
 * and the corridor may be opened up to swallow radar vectors and base legs.
 */
const TERMINAL_NM = 60;

/**
 * A descent is *observed* when the aircraft has come down this far from the highest level it has
 * been seen at in this session.
 *
 * This is the relative test the absolute one could not do. An A380 that cruises at FL430 and
 * steps down to FL330 is plainly descending, but a fixed 29 000 ft ceiling calls it "still at
 * cruise", and a vertical rate sampled between step-downs reads zero. Watching each airframe
 * against its own cruise level catches both.
 */
const DESCENT_FROM_CRUISE_FT = 2_500;
const DESCENT_FPM = -250;

/**
 * Ground speed decay, knots below the aircraft's own observed cruise speed, that corroborates an
 * arrival. Overflights hold 470–520 kt across the whole crossing; arrivals wash off speed as they
 * come down. Corroboration only — it is never sufficient on its own.
 */
const SPEED_DECAY_KTS = 45;

/**
 * How far the aircraft's own track may pass from the airport before "pointing this way" stops
 * meaning "coming here".
 *
 * An arrival is not aimed at the field: it is aimed at whichever of the four stacks it has been
 * given — Bovingdon, Lambourne, Ockham or Biggin, all of them 17 to 22 nm out — and further out it
 * is on an airway that misses Heathrow by more than that. The recorded Emirates arrival in
 * server/test/replay.test.ts held a 38 nm offset from 180 nm all the way in to 80 nm, and only then
 * turned; its offset collapsed to 7 nm in the four minutes that followed. A corridor tight enough
 * to look decisive would have thrown that flight away for the whole hour it was worth showing.
 *
 * So this is a bound on "pointing this way", not a discriminator, and it is deliberately loose:
 * the same recording has an overflight holding a 10 nm offset across the entire crossing, so a
 * tight corridor would not have separated them anyway. The descent test does the real work.
 */
const INBOUND_CORRIDOR_MIN_NM = 40;
const INBOUND_CORRIDOR_MAX_NM = 55;
const INBOUND_CORRIDOR_RATIO = 0.35;

/**
 * Arrivals are sticky. Radar vectors put an aircraft on a downwind leg heading away from the
 * field, and a hold points it at every compass point in turn; neither means it stopped arriving.
 * A confirmed arrival stays one until it climbs away from its closest approach.
 */
const STICKY_ARRIVAL_MAX_NM = 150;
const STICKY_ARRIVAL_SLACK_NM = 30;

/** Vertical rate above which an aircraft is climbing away, not descending in. */
const CLIMBING_FPM = 500;

/** Inside this an arrival is on approach rather than en route. */
const APPROACH_NM = 25;
/** …and it must be below this, or descending, and lined up with a runway. */
const APPROACH_CEILING_FT = 6000;
const APPROACH_ALIGN_DEG = 35;

/** A departure stays `climb_out` inside this radius while it is still climbing. */
const CLIMB_OUT_NM = 30;

/** SPEC §5: stationary this long on the ground at LHR is a stand, not a pause. */
const STAND_AFTER_MS = 3 * 60_000;
/** Ground speed below this counts as stationary. */
const STATIONARY_KTS = 3;
/** Ground speed above this on a centreline is a take-off roll. */
const TAKEOFF_ROLL_KTS = 60;
/** No A380 lands and departs again inside this — it is a roll-out, not a take-off. */
const TURNAROUND_MIN_MS = 10 * 60_000;
/**
 * A logged touchdown this recent, with no departure after it, still describes what an airframe
 * found on the ground is doing: taxiing in. Long enough to cover a slow taxi to a remote stand,
 * short enough that it can never speak for the next rotation.
 */
const RECENT_ARRIVAL_MS = 45 * 60_000;

/** ETA smoothing (SPEC §5: the countdown must not jitter). */
const ETA_ALPHA = 0.35;
/** SPEC §5: pads for sequencing/holding. */
const ETA_PAD_FAR_MIN = 6;
const ETA_PAD_NEAR_MIN = 3;
const ETA_PAD_BOUNDARY_NM = 80;
/** Anything beyond this is absurd — show "—" instead. */
const ETA_MAX_MIN = 16 * 60;
/** Below this a ground speed cannot support a sane ETA. */
const ETA_MIN_GROUND_SPEED_KTS = 60;

/** Timer stagger, so the three pollers never fire in the same tick. */
const AREA_OFFSET_MS = 2_000;
const WEATHER_OFFSET_MS = 4_000;

/** Touchdown is only believed from a plausible height. */
const TOUCHDOWN_MAX_ALTITUDE_FT = 4000;
/** Wheels-up is only believed within this of the airport… */
const WHEELS_UP_MAX_NM = 6;
/** …at a plausible rotation speed. */
const WHEELS_UP_MIN_KTS = 60;

/** One aircraft cannot produce two of the same event this close together. */
const EVENT_DEBOUNCE_MS = 10 * 60_000;

const AIRPORT_POSITION: LatLon = { lat: AIRPORT.lat, lon: AIRPORT.lon };

/** Used when the boundary polygon is unavailable — a Heathrow-sized disc. */
const AIRPORT_RADIUS_NM = 2.5;

const UNKNOWN_RUNWAY: RunwayPrediction = { runway: null, source: 'unknown', confidence: 0 };

const UNKNOWN_ETA: EtaInfo = { at: null, minutes: null, source: 'unknown' };

const EMPTY_WEATHER: Weather = {
  raw: null,
  windDirection: null,
  windSpeed: null,
  windGust: null,
  temperature: null,
  visibility: null,
  cloudCover: null,
  qnh: null,
  observedAt: null,
};

/** Heathrow as a route endpoint. Published fact, not an inference about any one flight. */
const AIRPORT_PLACE: Place = {
  iata: AIRPORT.iata,
  icao: AIRPORT.icao,
  city: 'London',
  country: 'United Kingdom',
  lat: AIRPORT.lat,
  lon: AIRPORT.lon,
};

const UNKNOWN_ROUTE: RouteInfo = { origin: null, destination: null, source: 'unknown', blockMinutes: null };
const ROUTE_TO_AIRPORT: RouteInfo = {
  origin: null,
  destination: AIRPORT_PLACE,
  source: 'inferred',
  blockMinutes: null,
};
const ROUTE_FROM_AIRPORT: RouteInfo = {
  origin: AIRPORT_PLACE,
  destination: null,
  source: 'inferred',
  blockMinutes: null,
};

/* ------------------------------------------------------------------ *
 * Runway geometry, precomputed once
 * ------------------------------------------------------------------ */

interface RunwayLine {
  end: RunwayEnd;
  start: LatLon;
  finish: LatLon;
  lengthNm: number;
}

/** Heathrow's runways are 12 000–12 800 ft; 2.2 nm covers both with room at the far end. */
const RUNWAY_LENGTH_NM = 2.2;

const RUNWAY_LINES: RunwayLine[] = AIRPORT.runways.map((end) => {
  const start: LatLon = { lat: end.lat, lon: end.lon };
  return {
    end,
    start,
    finish: destinationPoint(start, end.bearing, RUNWAY_LENGTH_NM),
    lengthNm: RUNWAY_LENGTH_NM,
  };
});

/** Half-width of the "on the centreline" corridor, nautical miles (~165 m). */
const CENTRELINE_HALF_WIDTH_NM = 0.09;

/**
 * Tolerances for naming the runway a departure has just left the ground from. Wider than the
 * ground-roll corridor because the first airborne fix is already drifting off the centreline, and
 * extended past the far threshold because rotation happens near the end of the roll and the fix
 * may land beyond it.
 */
const ROTATION_HALF_WIDTH_NM = 0.25;
const ROTATION_BEHIND_NM = 0.25;
const ROTATION_AHEAD_NM = 2;

function insideAirport(position: LatLon | null): boolean {
  if (position === null) return false;
  if (AIRPORT.boundary.length >= 3) return pointInPolygon(position, AIRPORT.boundary);
  return distanceNm(position, AIRPORT_POSITION) <= AIRPORT_RADIUS_NM;
}

/** True when the aircraft is on a runway surface, rolling in that runway's direction. */
function onRunwayCentreline(position: LatLon | null, track: number | null): boolean {
  if (position === null) return false;
  for (const line of RUNWAY_LINES) {
    if (Math.abs(crossTrackNm(position, line.start, line.finish)) > CENTRELINE_HALF_WIDTH_NM) continue;
    const along = alongTrackNm(position, line.start, line.finish);
    if (along < -0.25 || along > line.lengthNm + 0.25) continue;
    if (track !== null && angularDelta(track, line.end.bearing) > APPROACH_ALIGN_DEG) continue;
    return true;
  }
  return false;
}

/**
 * Which runway the aircraft is physically over, in the direction it is travelling — the runway a
 * departure has just rotated off.
 *
 * This is the only honest way to name a departure runway. The active configuration cannot do it:
 * it describes the airport, not this aeroplane, and if the landing/departing assignment is
 * unconfirmed or came from the METAR wind it is a guess. Nothing here is invented — when the
 * geometry does not put the aircraft on a runway, the answer is "no runway".
 */
function runwayUnderAircraft(position: LatLon | null, track: number | null): RunwayPrediction {
  if (position === null) return UNKNOWN_RUNWAY;
  let best: { designator: string; cross: number } | null = null;
  for (const line of RUNWAY_LINES) {
    const cross = Math.abs(crossTrackNm(position, line.start, line.finish));
    if (cross > ROTATION_HALF_WIDTH_NM) continue;
    const along = alongTrackNm(position, line.start, line.finish);
    if (along < -ROTATION_BEHIND_NM || along > line.lengthNm + ROTATION_AHEAD_NM) continue;
    if (track === null || angularDelta(track, line.end.bearing) > APPROACH_ALIGN_DEG) continue;
    if (best === null || cross < best.cross) best = { designator: line.end.designator, cross };
  }
  if (best === null) return UNKNOWN_RUNWAY;
  return { runway: best.designator, source: 'observed', confidence: 0.9 };
}

/** True when the track lines up with any Heathrow runway direction. */
function alignedWithRunway(track: number | null): boolean {
  if (track === null) return false;
  for (const line of RUNWAY_LINES) {
    if (angularDelta(track, line.end.bearing) <= APPROACH_ALIGN_DEG) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Internal per-airframe state
 * ------------------------------------------------------------------ */

interface TrackedFlight {
  readonly hex: string;
  callsign: string | null;
  flightNumber: string | null;
  registration: string | null;
  airline: Airline;
  airframe: Airframe;
  /** Curated timetable entry for the current callsign, when one exists. */
  scheduledRoute: RouteInfo | null;

  /** The most recent upstream record, verbatim. */
  last: UpstreamAircraft;
  /** Last known position — retained through gaps in the feed. */
  position: LatLon | null;
  distance: number | null;
  bearingFromAirport: number | null;
  /** Smoothed change in distance per report; negative means closing. */
  distanceTrend: number | null;
  closing: boolean;

  /**
   * The highest altitude and ground speed this airframe has been seen at while airborne. An
   * aircraft's own cruise is the only honest baseline for "has it started coming down / slowing
   * up"; a fixed threshold mistakes a high cruise for a descent and a step-down for cruise.
   */
  cruiseAltitudeFt: number | null;
  cruiseSpeedKts: number | null;
  /** How well the evidence supports the arrival, once one has been asserted. */
  arrivalGrade: ArrivalGrade;

  trail: TrailPoint[];

  phase: FlightPhase;
  pendingPhase: FlightPhase | null;
  pendingCount: number;
  /** Closest the aircraft has come to LHR since it was confirmed as an arrival. */
  arrivalMinDistance: number | null;

  firstSeen: number;
  /** Epoch ms of the most recent *position*. */
  lastSeen: number;
  /** Epoch ms we last saw this airframe in the feed at all. */
  lastSeenInFeed: number;

  /** Smoothed ETA in minutes (unrounded). */
  etaMinutes: number | null;
  etaAt: number | null;

  departedThisSession: boolean;
  hasBeenAtStand: boolean;
  /** When the aircraft last became stationary on the ground. */
  stationarySince: number | null;
  /** When the aircraft last settled on a stand. */
  standSince: number | null;

  lastOnGround: boolean | null;
  /** Ground speed at the previous on-ground report — separates a take-off roll from a roll-out. */
  lastGroundSpeed: number | null;
  /** Altitude of the last airborne report — guards the touchdown test. */
  lastAirborneAltitude: number | null;
  /** Last airborne fix, used to name the runway at touchdown. */
  lastAirborneFix: { lat: number | null; lon: number | null; track: number | null; altitude: number | null } | null;

  actualAt: number | null;
  /** Runway observed/predicted at the moment of the event. */
  eventRunway: RunwayPrediction | null;

  loggedArrivalAt: number | null;
  loggedDepartureAt: number | null;
}

/* ------------------------------------------------------------------ *
 * Public shape
 * ------------------------------------------------------------------ */

export type Tracker = {
  start(): void;
  stop(): void;
  snapshot(): Snapshot;
  /**
   * Completed movements from the last `hours` hours, newest first.
   *
   * Deliberately not a filter over `snapshot().log`: that list is capped at the snapshot window,
   * so answering "the last 48 hours" from it would hand back 24 hours of rows and call them 48.
   * The store keeps everything it has been told about, and this reads it directly.
   */
  movements(hours: number): LoggedMovement[];
  aircraftDetail(hex: string): AircraftDetail | null;
  spots(): SpotEvaluation[];
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
};

export function createTracker(options?: { dataDir?: string }): Tracker {
  return new TrackerImpl(options?.dataDir);
}

/**
 * Offline replay, for scoring the state machine against a recorded feed.
 *
 * The arrivals board cannot be developed against live traffic — the interesting events are an hour
 * apart and never repeat — so a recording of the upstream A388 sweep is fed through *this exact
 * state machine*, sample by sample, and the phase decisions are scored against what the aircraft
 * turned out to do. Nothing here is a second implementation: `feed` is the same ingest path the
 * poller uses, just with the network replaced by a file.
 */
export interface ReplayTracker {
  /** Push one recorded sweep through the state machine and return the resulting snapshot. */
  feed(list: UpstreamAircraft[], now: number): Snapshot;
  /** The tracked phase for one airframe, or null when it is not being tracked. */
  phaseOf(hex: string): FlightPhase | null;
  /** How well the evidence currently supports the arrival — 'none' when it is not an arrival. */
  gradeOf(hex: string): ArrivalGrade;
}

export function createReplayTracker(options?: { dataDir?: string }): ReplayTracker {
  return new TrackerImpl(options?.dataDir);
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

class TrackerImpl implements Tracker, ReplayTracker {
  private readonly store: MovementStore;

  private readonly flights = new Map<string, TrackedFlight>();

  private readonly listeners = new Set<(snapshot: Snapshot) => void>();

  private readonly startedAt = Date.now();

  private weather: Weather | null = null;

  private runwayConfig: RunwayConfig;

  /** The most recent LHR-area sample, kept so the config can be re-derived when the METAR lands. */
  private areaTraffic: UpstreamAircraft[] = [];
  private areaTrafficAt = 0;

  private cached: Snapshot | null = null;

  private cachedSpots: { at: number; value: SpotEvaluation[] } | null = null;

  private lastPollAt: number | null = null;

  private failures = 0;

  private running = false;

  private fleetTimer: NodeJS.Timeout | null = null;
  private areaTimer: NodeJS.Timeout | null = null;
  private weatherTimer: NodeJS.Timeout | null = null;
  private readonly startupTimers = new Set<NodeJS.Timeout>();

  private fleetBusy = false;
  private areaBusy = false;
  private weatherBusy = false;

  constructor(dataDir?: string) {
    const file = typeof dataDir === 'string' && dataDir.length > 0 ? join(dataDir, 'movements.jsonl') : CONFIG.movementLogFile;
    this.store = new MovementStore(file);
    this.runwayConfig = deriveRunwayConfig([], null, this.startedAt);
  }

  /* ------------------------------ lifecycle ------------------------------ */

  start(): void {
    if (this.running) return;
    this.running = true;

    // The first sweep runs immediately; the other two are offset so no two pollers ever land in
    // the same tick, then repeat on their own intervals.
    this.runFleetPoll();
    this.fleetTimer = this.repeat(() => this.runFleetPoll(), CONFIG.poll.fleetMs);

    this.after(AREA_OFFSET_MS, () => {
      this.runAreaPoll();
      this.areaTimer = this.repeat(() => this.runAreaPoll(), CONFIG.poll.areaMs);
    });

    this.after(WEATHER_OFFSET_MS, () => {
      this.runWeatherPoll();
      this.weatherTimer = this.repeat(() => this.runWeatherPoll(), CONFIG.poll.weatherMs);
    });

    log.info(
      `polling A388 every ${Math.round(CONFIG.poll.fleetMs / 1000)}s, LHR area every ${Math.round(
        CONFIG.poll.areaMs / 1000,
      )}s, METAR every ${Math.round(CONFIG.poll.weatherMs / 60_000)} min`,
    );
  }

  stop(): void {
    this.running = false;
    for (const timer of [this.fleetTimer, this.areaTimer, this.weatherTimer]) {
      if (timer !== null) clearInterval(timer);
    }
    this.fleetTimer = null;
    this.areaTimer = null;
    this.weatherTimer = null;
    for (const timer of this.startupTimers) clearTimeout(timer);
    this.startupTimers.clear();
    this.listeners.clear();
  }

  /** An interval that never keeps the process alive on its own. */
  private repeat(fn: () => void, everyMs: number): NodeJS.Timeout {
    const timer = setInterval(fn, everyMs);
    timer.unref();
    return timer;
  }

  private after(delayMs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.startupTimers.delete(timer);
      if (!this.running) return;
      fn();
    }, delayMs);
    timer.unref();
    this.startupTimers.add(timer);
  }

  /* ------------------------------ polling ------------------------------ */

  /**
   * Every poller funnels through here: overlapping runs are skipped rather than queued, and no
   * rejection may ever escape into the timer that called it.
   */
  private guard(label: string, busy: () => boolean, setBusy: (value: boolean) => void, body: () => Promise<void>): void {
    if (!this.running || busy()) return;
    setBusy(true);
    body()
      .catch((err: unknown) => {
        this.failures += 1;
        log.error(`${label} poll failed:`, err);
      })
      .finally(() => setBusy(false));
  }

  private runFleetPoll(): void {
    this.guard(
      'fleet',
      () => this.fleetBusy,
      (value) => {
        this.fleetBusy = value;
      },
      async () => {
        const list = await fetchA380s();
        const now = Date.now();
        if (list.length === 0) {
          // adsb.lol always sees A380s somewhere on earth — an empty list means the feed, not the
          // sky, is empty. Keep the last good state and let the health block say so.
          this.failures += 1;
          log.warn(`A388 sweep returned no aircraft (${this.failures} in a row) — serving last good state`);
        } else {
          this.failures = 0;
          this.lastPollAt = now;
          this.ingest(list, now);
        }
        this.rebuild(now);
        this.emit();
      },
    );
  }

  private runAreaPoll(): void {
    this.guard(
      'area',
      () => this.areaBusy,
      (value) => {
        this.areaBusy = value;
      },
      async () => {
        const traffic = await fetchAreaTraffic();
        const now = Date.now();
        if (traffic.length > 0) {
          this.areaTraffic = traffic;
          this.areaTrafficAt = now;
          this.runwayConfig = deriveRunwayConfig(traffic, this.weather, now);
          log.debug(
            `runway config: ${this.runwayConfig.summary} (confidence ${this.runwayConfig.confidence.toFixed(2)}, n=${
              this.runwayConfig.sampleSize
            })`,
          );
        }
        this.rebuild(now);
      },
    );
  }

  private runWeatherPoll(): void {
    this.guard(
      'weather',
      () => this.weatherBusy,
      (value) => {
        this.weatherBusy = value;
      },
      async () => {
        const weather = await fetchWeather();
        const now = Date.now();
        if (weather !== null) {
          this.weather = weather;
          // The wind cross-checks the runway derivation, so re-derive — but only against the
          // traffic we actually have. A fresh METAR must never erase a good observed config.
          const traffic = now - this.areaTrafficAt <= CONFIG.poll.areaMs * 4 ? this.areaTraffic : [];
          if (traffic.length > 0 || this.runwayConfig.sampleSize === 0) {
            this.runwayConfig = deriveRunwayConfig(traffic, weather, now);
          }
          log.debug(`METAR: ${weather.raw ?? 'unavailable'}`);
        }
        this.rebuild(now);
      },
    );
  }

  /* ------------------------------ ingest ------------------------------ */

  private ingest(list: UpstreamAircraft[], now: number): void {
    const seen = new Set<string>();

    for (const ac of list) {
      if (ac.hex.length === 0) continue;
      seen.add(ac.hex);
      const flight = this.flights.get(ac.hex);
      if (flight === undefined) this.flights.set(ac.hex, this.create(ac, now));
      else this.update(flight, ac, now);
    }

    for (const [hex, flight] of this.flights) {
      if (seen.has(hex)) continue;
      const limit = flight.phase === 'outbound' ? OUTBOUND_COAST_MS : COAST_MS;
      if (now - flight.lastSeenInFeed > limit) {
        this.flights.delete(hex);
        log.debug(`dropped ${flight.callsign ?? hex} after ${Math.round((now - flight.lastSeenInFeed) / 60_000)} min of silence`);
      }
    }
  }

  private create(ac: UpstreamAircraft, now: number): TrackedFlight {
    const parsed = parseCallsign(ac.callsign);
    const airline = getAirline(parsed.airlineIcao, ac.registration);
    const flight: TrackedFlight = {
      hex: ac.hex,
      callsign: parsed.callsign,
      flightNumber: flightNumberFor(airline, parsed.number, parsed.callsign),
      registration: ac.registration,
      airline,
      airframe: getAirframe(ac.hex, ac.registration),
      scheduledRoute: lookupRoute(parsed.callsign),
      last: ac,
      position: null,
      distance: null,
      bearingFromAirport: null,
      distanceTrend: null,
      closing: false,
      cruiseAltitudeFt: null,
      cruiseSpeedKts: null,
      arrivalGrade: 'none',
      trail: [],
      phase: 'elsewhere',
      pendingPhase: null,
      pendingCount: 0,
      arrivalMinDistance: null,
      firstSeen: now,
      lastSeen: Math.min(now, ac.receivedAt),
      lastSeenInFeed: now,
      etaMinutes: null,
      etaAt: null,
      departedThisSession: false,
      hasBeenAtStand: false,
      stationarySince: null,
      standSince: null,
      lastOnGround: null,
      lastGroundSpeed: null,
      lastAirborneAltitude: null,
      lastAirborneFix: null,
      actualAt: null,
      eventRunway: null,
      loggedArrivalAt: null,
      loggedDepartureAt: null,
    };
    this.update(flight, ac, now);
    return flight;
  }

  private update(flight: TrackedFlight, raw: UpstreamAircraft, now: number): void {
    // A frame that says nothing about the air/ground state does not get to change it. Upstream
    // emits Mode-S-only frames (`{hex, seen}` and nothing else) for A380s several times an hour,
    // and reading those as "airborne" turned a parked aeroplane into a departure and then an
    // arrival, both of them written to the permanent log. The last observed state is carried
    // forward instead, which is what coasting already does with position.
    const ac: UpstreamAircraft =
      raw.groundKnown || flight.lastOnGround === null
        ? raw
        : { ...raw, onGround: flight.lastOnGround };

    flight.lastSeenInFeed = now;
    flight.last = ac;

    if (ac.registration !== null && ac.registration !== flight.registration) {
      flight.registration = ac.registration;
      flight.airframe = getAirframe(flight.hex, ac.registration);
    }

    const parsed = parseCallsign(ac.callsign);
    if (parsed.callsign !== null && parsed.callsign !== flight.callsign) {
      flight.callsign = parsed.callsign;
      flight.airline = getAirline(parsed.airlineIcao, flight.registration);
      flight.flightNumber = flightNumberFor(flight.airline, parsed.number, parsed.callsign);
      flight.scheduledRoute = lookupRoute(parsed.callsign);
    }

    const position: LatLon | null = ac.lat !== null && ac.lon !== null ? { lat: ac.lat, lon: ac.lon } : null;
    const previousDistance = flight.distance;
    const previousSeen = flight.lastSeen;

    if (position !== null) {
      const receivedAt = Math.min(now, ac.receivedAt > 0 ? ac.receivedAt : now);
      const distance = distanceNm(position, AIRPORT_POSITION);

      if (previousDistance !== null && receivedAt - previousSeen >= 1_000) {
        const delta = distance - previousDistance;
        // A jump of hundreds of miles between reports is a feed artefact, not a manoeuvre.
        if (Math.abs(delta) < 200) {
          flight.distanceTrend = flight.distanceTrend === null ? delta : flight.distanceTrend * 0.6 + delta * 0.4;
          flight.closing = flight.distanceTrend < -0.05;
        }
      }

      flight.position = position;
      flight.distance = distance;
      flight.bearingFromAirport = bearing(AIRPORT_POSITION, position);
      // Feed timestamps jitter by a second either way; the age of our state may only go forwards.
      flight.lastSeen = Math.max(flight.lastSeen, receivedAt);
      this.appendTrail(flight, position, ac.altitude, receivedAt);
    }

    // Each airframe's own cruise, the baseline the descent and deceleration tests measure against.
    // Only sampled while airborne and well clear of the circuit, so a go-around cannot reset it.
    if (!ac.onGround) {
      if (ac.altitude !== null && (flight.cruiseAltitudeFt === null || ac.altitude > flight.cruiseAltitudeFt)) {
        flight.cruiseAltitudeFt = ac.altitude;
      }
      if (ac.groundSpeed !== null && (flight.cruiseSpeedKts === null || ac.groundSpeed > flight.cruiseSpeedKts)) {
        flight.cruiseSpeedKts = ac.groundSpeed;
      }
    }

    // Stationary bookkeeping, needed for the stand / taxi_out distinction.
    const groundSpeed = ac.groundSpeed;
    if (ac.onGround && (groundSpeed === null || groundSpeed < STATIONARY_KTS)) {
      if (flight.stationarySince === null) flight.stationarySince = now;
    } else {
      flight.stationarySince = null;
    }

    this.detectEvents(flight, ac, position, now);

    const candidate = this.classify(flight, ac, position, now);
    this.applyPhase(flight, candidate, now);
    trackArrivalDistance(flight);

    this.updateEta(flight, ac, now);

    // Only a frame that actually reported an altitude may rewrite what we know about the last
    // airborne moment — a degraded frame carrying no altitude and no position would otherwise
    // erase the fix the touchdown runway is named from.
    if (!ac.onGround && raw.groundKnown) {
      flight.lastAirborneAltitude = ac.altitude;
      if (ac.lat !== null && ac.lon !== null) {
        flight.lastAirborneFix = { lat: ac.lat, lon: ac.lon, track: ac.track, altitude: ac.altitude };
      }
    }
    flight.lastOnGround = ac.onGround;
    flight.lastGroundSpeed = ac.onGround ? ac.groundSpeed : null;
  }

  private appendTrail(flight: TrackedFlight, position: LatLon, altitude: number | null, at: number): void {
    const previous = flight.trail.length > 0 ? flight.trail[flight.trail.length - 1] : undefined;
    if (previous !== undefined) {
      const moved = distanceNm({ lat: previous.lat, lon: previous.lon }, position);
      if (moved < TRAIL_MIN_MOVE_NM && at - previous.t < TRAIL_MIN_INTERVAL_MS) return;
      if (at <= previous.t) return;
    }
    flight.trail.push({ t: at, lat: position.lat, lon: position.lon, alt: altitude });
    if (flight.trail.length > CONFIG.trailMaxPoints) {
      flight.trail.splice(0, flight.trail.length - CONFIG.trailMaxPoints);
    }
  }

  /* ------------------------------ events ------------------------------ */

  /**
   * Touchdown and wheels-up are the only two things this app can state as fact rather than
   * prediction, so they are detected from the raw air/ground transition, independently of the
   * phase machine, and logged exactly once.
   */
  private detectEvents(flight: TrackedFlight, ac: UpstreamAircraft, position: LatLon | null, now: number): void {
    const wasOnGround = flight.lastOnGround;
    if (wasOnGround === null) return;
    if (wasOnGround === ac.onGround) return;

    // A movement is a physical event, so it takes a position from *this* frame to claim one. The
    // last known position is fine for describing where an aeroplane is; it is not evidence that
    // anything happened, and combined with a degraded frame it invented whole flights.
    if (position === null) return;

    const inside = insideAirport(position);
    const distance = flight.distance;

    if (ac.onGround) {
      const from = flight.lastAirborneAltitude;
      // Wheels-down inside the airport, from a height an aeroplane can land from. A transition
      // with no airborne altitude behind it at all is a gap in the feed, not a touchdown.
      if (!inside) return;
      if (from === null || from > TOUCHDOWN_MAX_ALTITUDE_FT) return;
      this.logEvent(flight, 'arrival', now, { position, track: ac.track });
      return;
    }

    if (
      (inside || (distance !== null && distance <= WHEELS_UP_MAX_NM)) &&
      (ac.groundSpeed === null || ac.groundSpeed >= WHEELS_UP_MIN_KTS) &&
      // No A380 lands and departs again inside a turnaround: a wheels-up minutes after a logged
      // touchdown, from an aeroplane that has not reached a stand, is the roll-out being reported
      // ragged. `isTakeoffRoll` already refuses it for the phase; the log must refuse it too.
      !withinTurnaround(flight, now)
    ) {
      this.logEvent(flight, 'departure', now, { position, track: ac.track });
    }
  }

  private logEvent(
    flight: TrackedFlight,
    kind: 'arrival' | 'departure',
    now: number,
    at: { position: LatLon | null; track: number | null },
  ): void {
    const previous = kind === 'arrival' ? flight.loggedArrivalAt : flight.loggedDepartureAt;
    if (previous !== null && now - previous < EVENT_DEBOUNCE_MS) return;

    const runway =
      kind === 'arrival'
        ? this.arrivalRunwayAtTouchdown(flight)
        : runwayUnderAircraft(at.position, at.track);
    // A prediction with no runway in it is not a prediction; let the live view fall back to the
    // configuration rather than pinning "TBC" to the movement for ever.
    flight.eventRunway = runway.runway === null ? null : runway;
    flight.actualAt = now;

    if (kind === 'arrival') {
      flight.loggedArrivalAt = now;
      flight.departedThisSession = false;
      flight.hasBeenAtStand = false;
      flight.standSince = null;
      this.commitPhase(flight, 'landed', now);
    } else {
      flight.loggedDepartureAt = now;
      flight.departedThisSession = true;
      flight.hasBeenAtStand = false;
      flight.standSince = null;
      this.commitPhase(flight, 'climb_out', now);
    }

    const route = flight.scheduledRoute;
    const city = kind === 'arrival' ? (route?.origin?.city ?? null) : (route?.destination?.city ?? null);

    const entry: LoggedMovement = {
      id: flight.hex,
      kind,
      at: now,
      callsign: flight.callsign,
      flightNumber: flight.flightNumber,
      registration: flight.registration,
      operator: flight.airline.name,
      operatorColor: flight.airline.color,
      // The log is a record of what was seen. A runway the geometry did not actually show us —
      // the active configuration's guess, say — is a prediction, and LoggedMovement carries no
      // provenance for the UI to qualify it with, so it is left out rather than stated as fact.
      runway: runway.source === 'observed' ? runway.runway : null,
      city,
    };
    this.store.append(entry);
    log.info(
      `${kind === 'arrival' ? 'ARRIVED' : 'DEPARTED'} ${flight.callsign ?? flight.hex}` +
        `${flight.registration === null ? '' : ` (${flight.registration})`}` +
        `${runway.runway === null ? '' : ` runway ${runway.runway}`}` +
        `${city === null ? '' : ` ${kind === 'arrival' ? 'from' : 'to'} ${city}`}`,
    );
  }

  /** The runway is named from the last airborne fix, which is on final approach. */
  private arrivalRunwayAtTouchdown(flight: TrackedFlight): RunwayPrediction {
    const fix = flight.lastAirborneFix;
    if (fix === null) return predictArrivalRunway({ lat: null, lon: null, track: null, altitude: null }, this.runwayConfig);
    return predictArrivalRunway(fix, this.runwayConfig);
  }

  /**
   * Did this airframe land at Heathrow recently, with nothing logged since?
   *
   * Consulted only on first contact with an aeroplane already on the ground, where the phase
   * machine itself knows nothing. The log holds the touchdown the poller watched happen, and a
   * whale that landed twenty minutes ago and has not departed is on its way to a stand.
   */
  private arrivedRecently(hex: string, now: number): boolean {
    const history = this.store.forAirframe(hex);
    const latest = history[0]; // newest first: a departure since would be ahead of the arrival
    if (latest === undefined || latest.kind !== 'arrival') return false;
    return now - latest.at <= RECENT_ARRIVAL_MS;
  }

  /* ------------------------------ classification ------------------------------ */

  private classify(flight: TrackedFlight, ac: UpstreamAircraft, position: LatLon | null, now: number): FlightPhase {
    const where = position ?? flight.position;
    const previous = flight.phase;

    if (ac.onGround) {
      if (!insideAirport(where)) return 'elsewhere';

      const groundSpeed = ac.groundSpeed ?? 0;
      if (
        groundSpeed > TAKEOFF_ROLL_KTS &&
        onRunwayCentreline(where, ac.track) &&
        isTakeoffRoll(flight, groundSpeed, now)
      ) {
        return 'departing';
      }

      const stationaryFor = flight.stationarySince === null ? 0 : now - flight.stationarySince;
      if (groundSpeed < STATIONARY_KTS && stationaryFor > STAND_AFTER_MS) {
        // SPEC §5: the dwell is what makes it a stand, and only the observed dwell may set the
        // flag that later licenses `taxi_out`. Ten seconds of stillness is a pause at a hold.
        flight.hasBeenAtStand = true;
        return 'stand';
      }
      if (previous === 'stand' && groundSpeed < STATIONARY_KTS) return 'stand';

      if (flight.hasBeenAtStand) return 'taxi_out';
      if (previous === 'inbound' || previous === 'approach' || previous === 'landed') return 'landed';
      if (previous === 'departing' || previous === 'taxi_out') return 'taxi_out';
      // First contact on the ground at Heathrow: the phase machine has no history, but the
      // movement log may — an airframe that landed here a few minutes ago and has not departed
      // since is taxiing *in*, whatever it looks like from one frame.
      if (this.arrivedRecently(flight.hex, now)) return 'landed';
      return groundSpeed < STATIONARY_KTS ? 'stand' : 'taxi_out';
    }

    const distance = flight.distance;
    if (distance === null || where === null) {
      // Airborne but no position has ever been received — nothing can be said about intent.
      return previous === 'elsewhere' ? 'elsewhere' : previous;
    }

    const altitude = ac.altitude;
    const verticalRate = ac.verticalRate;
    const track = ac.track;

    if (flight.departedThisSession) {
      const climbing = verticalRate !== null ? verticalRate > 200 : altitude !== null && altitude < 10_000;
      if (distance <= CLIMB_OUT_NM && climbing) return 'climb_out';
      if (!flight.closing || distance > CLIMB_OUT_NM) return 'outbound';
      // Turned back towards the field — fall through and let the arrival tests decide.
    }

    const wasArriving = previous === 'inbound' || previous === 'approach';
    const sticky = this.stillArriving(flight, distance);
    const intent = this.arrivalIntent(flight, ac, where, distance);
    // The grade is what the UI reports as confidence, so it tracks the live evidence rather than
    // freezing at whatever the aircraft looked like when it first reached the board. A sticky
    // arrival that is no longer producing evidence is honestly `likely`, not `confirmed`.
    if (intent !== 'none') flight.arrivalGrade = intent;
    else if (sticky || wasArriving) flight.arrivalGrade = 'likely';
    else flight.arrivalGrade = 'none';

    // Inside 25 nm, below 6 000 ft, coming down and lined up with a Heathrow runway: there is
    // nowhere else this aircraft can be going. The one thing that has to be excluded is a
    // departure climbing out along the same centreline, which looks identical apart from its
    // vertical rate.
    const descending = verticalRate !== null && verticalRate < -200;
    const climbingAway = verticalRate !== null && verticalRate > CLIMBING_FPM;
    const low = altitude !== null && altitude < APPROACH_CEILING_FT;
    if (
      distance <= APPROACH_NM &&
      !climbingAway &&
      (descending || low) &&
      alignedWithRunway(track) &&
      this.routeAllowsArrival(flight) &&
      (sticky || wasArriving || intent !== 'none')
    ) {
      // Wheels-down is minutes away and the aeroplane is low, slow and lined up: nothing about
      // this is a guess any more.
      flight.arrivalGrade = 'confirmed';
      return 'approach';
    }

    if (sticky) return 'inbound';
    if (intent !== 'none') return 'inbound';

    if (flight.departedThisSession) return 'outbound';
    return 'elsewhere';
  }

  /**
   * Is this aircraft, right now, on its way to Heathrow?
   *
   * Two things can answer yes, and both need the geometry to agree that it is closing and
   * pointing this way:
   *
   *  - the curated timetable says this callsign's destination is EGLL. That is a published fact
   *    about the rotation, so it carries the aircraft from as far out as we track;
   *  - failing any timetable entry, the aircraft is inside `GEOMETRIC_INBOUND_MAX_NM`, its own
   *    track passes close enough to the field, and it is where a jet descending into Heathrow
   *    would be. Beyond that range geometry cannot tell an arrival from an overflight, and this
   *    app does not guess.
   */
  private arrivalIntent(
    flight: TrackedFlight,
    ac: UpstreamAircraft,
    where: LatLon,
    distance: number,
  ): ArrivalGrade {
    if (flight.departedThisSession) return 'none';
    if (!this.routeAllowsArrival(flight)) return 'none';
    return assessArrival({
      position: where,
      distanceNm: distance,
      track: ac.track,
      altitudeFt: ac.altitude,
      verticalRateFpm: ac.verticalRate,
      groundSpeedKts: ac.groundSpeed,
      closing: flight.closing,
      scheduledToAirport: routeAssertsArrival(flight),
      cruiseAltitudeFt: flight.cruiseAltitudeFt,
      cruiseSpeedKts: flight.cruiseSpeedKts,
    });
  }

  /**
   * A confirmed arrival stays one through vectoring and holding.
   *
   * Downwind legs point away from the field and holds point everywhere in turn, so the intent
   * test above cannot be re-run frame by frame without the aircraft falling off the board every
   * time it turns. Instead the arrival is held until it climbs away from its own closest
   * approach — which is what a go-around-and-divert, or a false positive, actually looks like.
   */
  private stillArriving(flight: TrackedFlight, distance: number): boolean {
    if (flight.phase !== 'inbound' && flight.phase !== 'approach') return false;
    if (flight.departedThisSession) return false;
    if (distance > STICKY_ARRIVAL_MAX_NM) return false;
    const closest = flight.arrivalMinDistance;
    if (closest !== null && distance > closest + STICKY_ARRIVAL_SLACK_NM) return false;
    return this.routeAllowsArrival(flight);
  }

  /**
   * The timetable may veto an arrival: a curated rotation whose destination is not Heathrow means
   * this flight is not arriving here, whatever its geometry happens to look like for a few
   * minutes. No schedule at all is not an objection.
   */
  private routeAllowsArrival(flight: TrackedFlight): boolean {
    const destination = flight.scheduledRoute?.destination ?? null;
    if (destination === null) return true;
    if (destination.icao === null) return true;
    return destination.icao.toUpperCase() === AIRPORT.icao;
  }

  /**
   * SPEC §5: two consecutive polls before a phase flips, so a single ragged report cannot move the
   * board. `landed` and `departing` are exempt — they are observed events, not interpretations.
   */
  private applyPhase(flight: TrackedFlight, candidate: FlightPhase, now: number): void {
    if (candidate === flight.phase) {
      flight.pendingPhase = null;
      flight.pendingCount = 0;
      return;
    }

    if (candidate === 'landed' || candidate === 'departing') {
      this.commitPhase(flight, candidate, now);
      return;
    }

    if (flight.pendingPhase === candidate) flight.pendingCount += 1;
    else {
      flight.pendingPhase = candidate;
      flight.pendingCount = 1;
    }

    if (flight.pendingCount >= 2) this.commitPhase(flight, candidate, now);
  }

  private commitPhase(flight: TrackedFlight, phase: FlightPhase, now: number): void {
    if (flight.phase === phase) {
      flight.pendingPhase = null;
      flight.pendingCount = 0;
      return;
    }
    log.debug(`${flight.callsign ?? flight.hex}: ${flight.phase} → ${phase}`);
    flight.phase = phase;
    flight.pendingPhase = null;
    flight.pendingCount = 0;

    // `hasBeenAtStand` is deliberately NOT set here: reaching the `stand` phase is not the same
    // as having served the three-minute dwell SPEC §5 defines, and only the dwell may license
    // `taxi_out` afterwards. classify() sets it when it actually observes one.
    if (phase === 'stand') flight.standSince = now;
    if (phase === 'climb_out' || phase === 'departing') {
      flight.hasBeenAtStand = false;
    }
  }

  /* ------------------------------ ETA ------------------------------ */

  private updateEta(flight: TrackedFlight, ac: UpstreamAircraft, now: number): void {
    if (!isArrivalPhase(flight.phase)) {
      flight.etaMinutes = null;
      flight.etaAt = null;
      return;
    }

    const raw = rawEtaMinutes(flight.distance, ac.groundSpeed);
    if (raw === null) {
      // No usable speed: keep counting the last good estimate down rather than blanking it, but
      // never invent a new one.
      if (flight.etaMinutes !== null && flight.etaAt !== null) {
        const remaining = (flight.etaAt - now) / 60_000;
        flight.etaMinutes = remaining > 0 ? remaining : null;
        if (flight.etaMinutes === null) flight.etaAt = null;
      }
      return;
    }

    flight.etaMinutes = flight.etaMinutes === null ? raw : flight.etaMinutes + ETA_ALPHA * (raw - flight.etaMinutes);
    flight.etaAt = now + flight.etaMinutes * 60_000;
  }

  /* ------------------------------ snapshot ------------------------------ */

  private rebuild(now: number): void {
    const arrivals: Movement[] = [];
    const departures: Movement[] = [];
    const ground: Movement[] = [];
    const worldwide: GlobalAircraft[] = [];
    let airborneWorldwide = 0;

    for (const flight of this.flights.values()) {
      if (now - flight.lastSeenInFeed <= WORLDWIDE_WINDOW_MS) {
        worldwide.push(toGlobal(flight));
        if (!flight.last.onGround) airborneWorldwide += 1;
      }

      const kind = kindForPhase(flight.phase);
      if (kind === null) continue;
      const movement = this.toMovement(flight, kind, now);
      if (kind === 'arrival') arrivals.push(movement);
      else if (kind === 'departure') departures.push(movement);
      else ground.push(movement);
    }

    arrivals.sort(byEtaThenDistance);
    departures.sort(byDepartureImminence);
    ground.sort(byGroundOrder);
    worldwide.sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));

    const counts = this.store.todayCounts();

    this.cached = {
      ts: now,
      arrivals,
      departures,
      ground,
      runwayConfig: this.runwayConfig,
      weather: this.weather ?? EMPTY_WEATHER,
      sun: this.sun(now),
      worldwide,
      log: this.store.recent(CONFIG.logWindowHours),
      stats: {
        airborneWorldwide,
        arrivalsToday: counts.arrivals,
        departuresToday: counts.departures,
        airframesToday: counts.airframes,
      },
      health: this.health(now),
    };
  }

  private sun(now: number): SunInfo {
    return sunInfo(now, AIRPORT.lat, AIRPORT.lon);
  }

  private health(now: number): FeedHealth {
    const lastPollAt = this.lastPollAt;
    return {
      lastPollAt,
      stale: lastPollAt === null || now - lastPollAt > CONFIG.staleFeedMs,
      failures: this.failures,
      pollIntervalSeconds: Math.round(CONFIG.poll.fleetMs / 1000),
      uptimeSeconds: Math.round((now - this.startedAt) / 1000),
    };
  }

  private toMovement(flight: TrackedFlight, kind: MovementKind, now: number): Movement {
    const ac = flight.last;
    const ageSeconds = Math.max(0, Math.round((now - flight.lastSeen) / 1000));
    const coasting = ageSeconds > COASTING_AGE_SECONDS || now - flight.lastSeenInFeed > COASTING_AFTER_MS;

    return {
      id: flight.hex,
      kind,
      phase: flight.phase,
      callsign: flight.callsign,
      flightNumber: flight.flightNumber,
      airline: flight.airline,
      airframe: flight.airframe,
      route: this.routeFor(flight, kind),
      telemetry: {
        altitude: ac.altitude,
        onGround: ac.onGround,
        groundSpeed: ac.groundSpeed,
        track: ac.track,
        verticalRate: ac.verticalRate,
        lat: flight.position?.lat ?? null,
        lon: flight.position?.lon ?? null,
        squawk: ac.squawk,
        ageSeconds,
      },
      distanceNm: flight.distance === null ? null : Math.round(flight.distance * 10) / 10,
      bearingFromAirport: flight.bearingFromAirport === null ? null : Math.round(flight.bearingFromAirport),
      eta: this.etaFor(flight, kind, now, coasting),
      runway: this.runwayFor(flight, kind),
      actualAt: flight.actualAt,
      firstSeen: flight.firstSeen,
      lastSeen: flight.lastSeen,
      coasting,
      trail: flight.trail.slice(),
    };
  }

  private routeFor(flight: TrackedFlight, kind: MovementKind): RouteInfo {
    const scheduled = flight.scheduledRoute;
    if (scheduled !== null) return scheduled;
    // An aeroplane on the tarmac has no known far end. It came from somewhere we did not watch it
    // leave and is going somewhere nobody has told us about, so the honest answer is neither —
    // "London → LHR" is not a route, it is the airport twice.
    if (kind === 'ground') return UNKNOWN_ROUTE;
    if (kind === 'arrival') return ROUTE_TO_AIRPORT;
    if (kind === 'departure') return ROUTE_FROM_AIRPORT;
    return UNKNOWN_ROUTE;
  }

  private etaFor(flight: TrackedFlight, kind: MovementKind, now: number, coasting: boolean): EtaInfo {
    if (kind === 'arrival') {
      // A held position cannot support a live countdown. The aeroplane stopped transmitting; the
      // clock did not, and re-serving the last estimate every five seconds turns "5 min" into a
      // number that has been wrong for a quarter of an hour.
      if (coasting) return UNKNOWN_ETA;
      const at = flight.etaAt;
      if (flight.etaMinutes === null || at === null) return UNKNOWN_ETA;
      // SPEC §5: recomputed against the clock every frame, never re-served frozen.
      const rounded = Math.round((at - now) / 60_000);
      if (rounded < 0 || rounded > ETA_MAX_MIN) return UNKNOWN_ETA;
      // How much this countdown is worth, and the honest answer differs across the board: a jet on
      // final has an ETA good to a minute, one converging at cruise from 200 nm is on the board
      // because the geometry says so and the number is a projection.
      //   observed — the aeroplane's own position and speed, established on the approach
      //   inferred — the same arithmetic, but the arrival itself is not yet confirmed
      // 'schedule' is deliberately never used: no ETA in this app comes from a timetable. Every
      // one of them is distance ÷ ground speed plus the SPEC pad, whether or not the callsign
      // happens to match a curated rotation.
      const source: Provenance = flight.arrivalGrade === 'confirmed' ? 'observed' : 'inferred';
      return { at: Math.round(at), minutes: rounded, source };
    }
    if (flight.actualAt !== null) return { at: flight.actualAt, minutes: null, source: 'observed' };
    return UNKNOWN_ETA;
  }

  private runwayFor(flight: TrackedFlight, kind: MovementKind): RunwayPrediction {
    if (kind === 'arrival') {
      const predicted = predictArrivalRunway(
        {
          lat: flight.position?.lat ?? null,
          lon: flight.position?.lon ?? null,
          track: flight.last.track,
          altitude: flight.last.altitude,
        },
        this.runwayConfig,
      );
      if (predicted.runway !== null) return predicted;
      // SPEC §5: until the geometry can say, fall back to the active configuration — and only
      // when it names a single landing runway, at a confidence that says "this is the config
      // talking, not this aeroplane".
      return this.defaultLandingRunway();
    }
    // Once the wheels have touched or left the ground, the runway is observed, not predicted.
    if (flight.eventRunway !== null) return flight.eventRunway;
    if (kind === 'departure' || flight.phase === 'taxi_out') return predictDepartureRunway(this.runwayConfig);
    return UNKNOWN_RUNWAY;
  }

  private defaultLandingRunway(): RunwayPrediction {
    const config = this.runwayConfig;
    if (config.direction === 'unknown' || config.landing.length !== 1) return UNKNOWN_RUNWAY;
    const runway = config.landing[0];
    if (runway === undefined || runway.length === 0 || config.confidence <= 0) return UNKNOWN_RUNWAY;
    return { runway, source: 'inferred', confidence: Math.round(config.confidence * 0.3 * 100) / 100 };
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        log.error('snapshot listener threw:', err);
      }
    }
  }

  /* ------------------------------ replay surface ------------------------------ */

  feed(list: UpstreamAircraft[], now: number): Snapshot {
    if (list.length > 0) {
      this.lastPollAt = now;
      this.ingest(list, now);
    }
    this.rebuild(now);
    return this.cached ?? emptySnapshot(now, this.runwayConfig, this.weather, this.sun(now), this.health(now));
  }

  phaseOf(hex: string): FlightPhase | null {
    return this.flights.get(hex)?.phase ?? null;
  }

  gradeOf(hex: string): ArrivalGrade {
    return this.flights.get(hex)?.arrivalGrade ?? 'none';
  }

  /* ------------------------------ public surface ------------------------------ */

  snapshot(): Snapshot {
    const now = Date.now();
    const cached = this.cached;
    if (cached === null) {
      this.rebuild(now);
      // rebuild() always assigns; fall back defensively rather than asserting.
      return this.cached ?? emptySnapshot(now, this.runwayConfig, this.weather, this.sun(now), this.health(now));
    }
    return { ...cached, ts: now, health: this.health(now) };
  }

  movements(hours: number): LoggedMovement[] {
    const span = Number.isFinite(hours) ? Math.min(MAX_MOVEMENT_QUERY_HOURS, Math.max(0, hours)) : 0;
    return this.store.recent(span);
  }

  aircraftDetail(hex: string): AircraftDetail | null {
    // ICAO 24-bit addresses are six hex digits; adsb.lol prefixes non-ICAO (TIS-B) addresses
    // with `~`. Anything else cannot be one of ours.
    const id = hex.trim().toLowerCase();
    if (!/^~?[0-9a-f]{6}$/.test(id)) return null;

    const flight = this.flights.get(id);
    const history = this.store.forAirframe(id);

    if (flight === undefined) {
      if (history.length === 0) return null;
      const first = history[0];
      return {
        movement: null,
        global: null,
        airframe: getAirframe(id, first?.registration ?? null),
        history,
      };
    }

    const now = Date.now();
    const kind = kindForPhase(flight.phase);
    return {
      movement: kind === null ? null : this.toMovement(flight, kind, now),
      global: toGlobal(flight),
      airframe: flight.airframe,
      history,
    };
  }

  spots(): SpotEvaluation[] {
    const now = Date.now();
    const cached = this.cachedSpots;
    // Sun and runway config move slowly; a short cache keeps /api/spots free under fan-out.
    if (cached !== null && now - cached.at < 30_000) return cached.value;
    const value = evaluateSpots(getSpots(), this.runwayConfig, this.sun(now), this.weather, now);
    this.cachedSpots = { at: now, value };
    return value;
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/**
 * The human flight number, when the callsign actually carries one.
 *
 * `UAE1` is Emirates flight EK1 and saying so is a translation, not a guess. `UAE70M` is not
 * "EK70M": that flight does not exist and never has. Most A380 operators now transmit an
 * operational callsign with an alphanumeric suffix that is deliberately *not* the flight number —
 * two thirds of the airframes in a recorded sweep of the live A388 feed were of that shape — and
 * mapping the designator across produces a plausible, searchable, wrong answer for every one of
 * them. So a suffixed callsign has no derivable flight number and says so; the UI then shows the
 * callsign that was actually transmitted, which is the true thing we know.
 */
function flightNumberFor(airline: Airline, number: string | null, callsign: string | null): string | null {
  if (number === null) return null;
  // parseCallsign appends any operational suffix to the digits, so a non-digit means there was one.
  if (!/^\d+$/.test(number)) return null;
  if (airline.iata !== null) return `${airline.iata}${number}`;
  if (airline.icao !== null) return `${airline.icao}${number}`;
  return callsign;
}

/**
 * A landing roll-out and a take-off roll look identical in a single frame: both are an aeroplane
 * doing 100 kt down a centreline. Three things tell them apart.
 *
 * First, an aeroplane that has just touched down here cannot be taking off — it has a runway to
 * vacate and a stand to reach, and no A380 turns round in ten minutes. Second, the previous
 * report being airborne means this is the roll-out from that landing. Third, a take-off roll
 * accelerates; anything else does not. That last test is deliberately strict: the feed repeats
 * an unchanged position for several polls at a time, and treating a repeated 120 kt as
 * "not decelerating" put a freshly landed aircraft on the departures board.
 *
 * Missing a `departing` frame costs nothing — wheels-up is detected separately, from the actual
 * air/ground transition — whereas claiming one is a lie on the board.
 */
export interface RollEvidence {
  /** Epoch ms of the touchdown logged for this airframe in this session, if any. */
  loggedArrivalAt: number | null;
  hasBeenAtStand: boolean;
  /** Whether the previous report had the aircraft on the ground. Null before the first report. */
  lastOnGround: boolean | null;
  /** Ground speed at the previous on-ground report, knots. */
  lastGroundSpeed: number | null;
}

/**
 * True while an airframe is inside the turnaround that must follow its own logged touchdown: it
 * has landed here, it has not reached a stand since, and no A380 is going anywhere in that time.
 */
export function withinTurnaround(flight: RollEvidence, now: number): boolean {
  return (
    flight.loggedArrivalAt !== null &&
    !flight.hasBeenAtStand &&
    now - flight.loggedArrivalAt < TURNAROUND_MIN_MS
  );
}

export function isTakeoffRoll(flight: RollEvidence, groundSpeed: number, now: number): boolean {
  if (withinTurnaround(flight, now)) return false;
  // The previous report was airborne: this is the roll-out from a landing.
  if (flight.lastOnGround === false) return false;
  const previous = flight.lastGroundSpeed;
  // First ever contact, mid-roll. The centreline speed is all the evidence there is; the next
  // poll will correct it either way.
  if (previous === null) return true;
  return groundSpeed > previous;
}

function isArrivalPhase(phase: FlightPhase): boolean {
  return phase === 'inbound' || phase === 'approach';
}

/**
 * How well the evidence supports "this aircraft is coming to Heathrow".
 *
 * The board is the product, so the answer is graded rather than binary. A `likely` arrival is
 * shown, and shown as unconfirmed — the honest reading of an aircraft that is converging on the
 * field from range but has not yet done anything only an arrival does.
 */
export type ArrivalGrade = 'confirmed' | 'likely' | 'none';

/** Everything the arrival test is allowed to look at. Exported so it can be tested honestly. */
export interface ArrivalEvidence {
  position: LatLon;
  distanceNm: number;
  /** Track over ground, degrees true. */
  track: number | null;
  altitudeFt: number | null;
  verticalRateFpm: number | null;
  groundSpeedKts: number | null;
  /** Distance to Heathrow has been decreasing. */
  closing: boolean;
  /** The curated timetable names EGLL as this callsign's destination. */
  scheduledToAirport: boolean;
  /** Highest altitude this airframe has been seen at while airborne, feet. */
  cruiseAltitudeFt: number | null;
  /** Highest ground speed this airframe has been seen at while airborne, knots. */
  cruiseSpeedKts: number | null;
}

/**
 * Is this aircraft on its way to Heathrow, and how sure are we? Pure, and the whole of the
 * false-positive defence.
 *
 * The hard case is not the aeroplane over Singapore — that one fails on distance and heading
 * alone. It is the Emirates DXB–JFK, the Lufthansa FRA–LAX and the Qatar DOH–IAD, all of which
 * cross southern England at cruise, closing on Heathrow, pointing straight at it, for the better
 * part of an hour. The single frame cannot tell them apart on altitude, because an arrival 140 nm
 * out has not started down either.
 *
 * What does tell them apart, measured against a recorded feed, is *where the track goes*. An
 * aircraft still en route to Heathrow is established on an arrival routing that passes within a
 * few miles of the field. A transatlantic overflight is aimed at the oceanic entry points north
 * west of London and misses Heathrow by tens of miles — while still pointing "at" it to within
 * the 55° cone, because at 200 nm a 15° track error is only 12° of bearing.
 *
 * So the corridor does the work, and the descent is what promotes `likely` to `confirmed`.
 */
export function assessArrival(evidence: ArrivalEvidence): ArrivalGrade {
  const { distanceNm: distance, track } = evidence;
  if (!Number.isFinite(distance) || distance > INBOUND_MAX_NM) return 'none';
  if (!evidence.closing) return 'none';
  if (track === null) return 'none';
  if (angularDelta(track, bearing(evidence.position, AIRPORT_POSITION)) > INBOUND_CONE_DEG) return 'none';

  const descending = isDescending(evidence);
  // The 3:1 slope is a *veto*, not evidence. It is a real constraint inside 100 nm — an overflight
  // at FL360 is above it from 100 nm in — and worthless beyond, where it allows FL370 and more.
  const profileCeiling = PROFILE_BASE_FT + PROFILE_SLOPE_FT_PER_NM * distance;
  const aboveProfile = evidence.altitudeFt !== null && evidence.altitudeFt > profileCeiling;
  // Hopelessly high for this range: no descent claim can make this an arrival here.
  const farAboveProfile = evidence.altitudeFt !== null && evidence.altitudeFt > profileCeiling + PROFILE_SLACK_FT;

  // The timetable is a published fact about the rotation, so it reaches as far as we track. It is
  // only `confirmed` once the aeroplane is close enough for its own behaviour to corroborate the
  // schedule — a rotation that says Heathrow while still an ocean away is a plan, not an
  // observation, however convincingly it happens to be pointing this way.
  if (evidence.scheduledToAirport) {
    const corroborated = distance <= GEOMETRIC_INBOUND_MAX_NM && (descending || distance <= TERMINAL_NM);
    return corroborated ? 'confirmed' : 'likely';
  }

  if (distance > GEOMETRIC_INBOUND_MAX_NM) return 'none';
  if (farAboveProfile) return 'none';
  if (aboveProfile && !descending) return 'none';
  if (pathOffsetNm(evidence.position, track, distance) > corridorToleranceNm(distance)) return 'none';

  // Inside the terminal area, altitude is decisive on its own: nothing landing at Heathrow is
  // still in the flight levels at 60 nm, and nothing overflying it is down at 8 000 ft. An
  // aircraft transmitting no altitude at all cannot clear that bar, so it stays unconfirmed.
  if (distance <= TERMINAL_NM) {
    if (evidence.altitudeFt === null) return 'likely';
    return aboveProfile ? 'likely' : 'confirmed';
  }

  // En route, the aircraft must be visibly coming down. This is the whole discriminator, and it is
  // the one the recording supports: a Frankfurt–US A380 crossing 10 nm north of Heathrow at 100 nm
  // holds FL360 to the coast without losing 100 ft, while a Heathrow arrival has left its cruise by
  // 150 nm. Being aimed at the field proves nothing — the overflight is aimed at it too.
  if (!descending) return 'none';
  return isDecelerating(evidence) ? 'confirmed' : 'likely';
}

/**
 * Backwards-compatible boolean view of the arrival test: anything the tracker is willing to put
 * on the board, at either grade.
 */
export function looksLikeArrival(evidence: ArrivalEvidence): boolean {
  return assessArrival(evidence) !== 'none';
}

/**
 * Has the aircraft left its cruise? True on an instantaneous vertical rate, and also when it has
 * come down from the highest level it has been seen at — which catches the step-down descents
 * where the rate reads zero between levels.
 */
function isDescending(evidence: ArrivalEvidence): boolean {
  if (evidence.verticalRateFpm !== null && evidence.verticalRateFpm < DESCENT_FPM) return true;
  const cruise = evidence.cruiseAltitudeFt;
  const altitude = evidence.altitudeFt;
  if (cruise === null || altitude === null) return false;
  return cruise - altitude >= DESCENT_FROM_CRUISE_FT;
}

/** Has the aircraft washed off speed against its own observed cruise? */
function isDecelerating(evidence: ArrivalEvidence): boolean {
  const cruise = evidence.cruiseSpeedKts;
  const speed = evidence.groundSpeedKts;
  if (cruise === null || speed === null) return false;
  return cruise - speed >= SPEED_DECAY_KTS;
}

/**
 * The curated timetable positively states that this callsign terminates at Heathrow.
 *
 * Worth knowing how rarely this fires. Most A380 operators no longer transmit the flight number as
 * their callsign: in a recorded sweep of the live A388 feed, 29 of 47 callsigns were operational
 * ones with an alphanumeric suffix (UAE70M, ETD71M, UAE79Y, QTR65H…), and *none* of the aircraft
 * observed arriving at, sitting on, or departing from Heathrow matched a curated rotation. The
 * suffix cannot be stripped to recover the flight number either — UAE7V and UAE7TR would both
 * collapse onto EK7, and two aeroplanes cannot be the same flight.
 *
 * So the timetable is a bonus, not the mechanism. The geometry and the descent have to carry the
 * board on their own, which is what `assessArrival` is built to do.
 */
function routeAssertsArrival(flight: TrackedFlight): boolean {
  const icao = flight.scheduledRoute?.destination?.icao ?? null;
  return icao !== null && icao.toUpperCase() === AIRPORT.icao;
}

/**
 * How far the airport lies from the great circle the aircraft is currently flying, in nautical
 * miles. An aircraft "pointing at Heathrow" from 150 nm out with a 20° track error will pass
 * 50 nm away; the cone test alone cannot see that, and this can.
 */
function pathOffsetNm(where: LatLon, track: number, distance: number): number {
  const ahead = destinationPoint(where, track, Math.max(distance, 1));
  return Math.abs(crossTrackNm(AIRPORT_POSITION, where, ahead));
}

/**
 * How far the aircraft's own track may pass from the airport, at this range.
 *
 * Tightening this with range is the obvious idea and the recording says it is wrong: a genuine
 * Heathrow arrival still 140 nm out is established on an airway that misses the field by 40 nm and
 * only turns towards it later, while the Frankfurt–US overflight that must be rejected is aimed
 * within 10 nm of the field the whole way across. The corridor cannot separate them and must not
 * pretend to; it is a sanity bound on "pointing this way", nothing more, and the descent test does
 * the actual work.
 */
function corridorToleranceNm(distance: number): number {
  const scaled = distance * INBOUND_CORRIDOR_RATIO;
  return Math.min(INBOUND_CORRIDOR_MAX_NM, Math.max(INBOUND_CORRIDOR_MIN_NM, scaled));
}

/** Remember how close a confirmed arrival has come, so `stillArriving` can tell if it left. */
function trackArrivalDistance(flight: TrackedFlight): void {
  if (!isArrivalPhase(flight.phase)) {
    flight.arrivalMinDistance = null;
    flight.arrivalGrade = 'none';
    return;
  }
  const distance = flight.distance;
  if (distance === null) return;
  flight.arrivalMinDistance =
    flight.arrivalMinDistance === null ? distance : Math.min(flight.arrivalMinDistance, distance);
}

function kindForPhase(phase: FlightPhase): MovementKind | null {
  switch (phase) {
    case 'inbound':
    case 'approach':
      return 'arrival';
    case 'landed':
    case 'stand':
    case 'taxi_out':
      return 'ground';
    case 'departing':
    case 'climb_out':
    case 'outbound':
      return 'departure';
    case 'elsewhere':
      return null;
    default:
      return null;
  }
}

/** SPEC §5: distance ÷ ground speed, plus the sequencing pad. Absurd values become null. */
function rawEtaMinutes(distance: number | null, groundSpeed: number | null): number | null {
  if (distance === null || groundSpeed === null) return null;
  if (!Number.isFinite(distance) || !Number.isFinite(groundSpeed)) return null;
  if (groundSpeed < ETA_MIN_GROUND_SPEED_KTS) return null;
  const pad = distance > ETA_PAD_BOUNDARY_NM ? ETA_PAD_FAR_MIN : ETA_PAD_NEAR_MIN;
  const minutes = (distance / groundSpeed) * 60 + pad;
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > ETA_MAX_MIN) return null;
  return minutes;
}

function toGlobal(flight: TrackedFlight): GlobalAircraft {
  return {
    hex: flight.hex,
    callsign: flight.callsign,
    registration: flight.registration,
    operator: flight.airframe.operator ?? (flight.airline.name === 'Unknown' ? null : flight.airline.name),
    lat: flight.position?.lat ?? null,
    lon: flight.position?.lon ?? null,
    altitude: flight.last.altitude,
    track: flight.last.track,
    groundSpeed: flight.last.groundSpeed,
    onGround: flight.last.onGround,
  };
}

function byEtaThenDistance(a: Movement, b: Movement): number {
  const etaA = a.eta.minutes ?? Number.POSITIVE_INFINITY;
  const etaB = b.eta.minutes ?? Number.POSITIVE_INFINITY;
  if (etaA !== etaB) return etaA - etaB;
  const distA = a.distanceNm ?? Number.POSITIVE_INFINITY;
  const distB = b.distanceNm ?? Number.POSITIVE_INFINITY;
  return distA - distB;
}

const DEPARTURE_RANK: Record<string, number> = { departing: 0, climb_out: 1, outbound: 2 };

function byDepartureImminence(a: Movement, b: Movement): number {
  const rankA = DEPARTURE_RANK[a.phase] ?? 3;
  const rankB = DEPARTURE_RANK[b.phase] ?? 3;
  if (rankA !== rankB) return rankA - rankB;
  const atA = a.actualAt ?? 0;
  const atB = b.actualAt ?? 0;
  if (atA !== atB) return atB - atA; // most recent wheels-up first
  const distA = a.distanceNm ?? Number.POSITIVE_INFINITY;
  const distB = b.distanceNm ?? Number.POSITIVE_INFINITY;
  return distA - distB;
}

const GROUND_RANK: Record<string, number> = { taxi_out: 0, landed: 1, stand: 2 };

function byGroundOrder(a: Movement, b: Movement): number {
  const rankA = GROUND_RANK[a.phase] ?? 3;
  const rankB = GROUND_RANK[b.phase] ?? 3;
  if (rankA !== rankB) return rankA - rankB;
  return b.lastSeen - a.lastSeen;
}

function emptySnapshot(
  now: number,
  runwayConfig: RunwayConfig,
  weather: Weather | null,
  sun: SunInfo,
  health: FeedHealth,
): Snapshot {
  return {
    ts: now,
    arrivals: [],
    departures: [],
    ground: [],
    runwayConfig,
    weather: weather ?? EMPTY_WEATHER,
    sun,
    worldwide: [],
    log: [],
    stats: { airborneWorldwide: 0, arrivalsToday: 0, departuresToday: 0, airframesToday: 0 },
    health,
  };
}
