/**
 * The live map.
 *
 * React owns the chrome (controls, legend, status line); Leaflet owns the canvas. The two meet
 * in a handful of effects: one creates and destroys the map, one swaps the basemap when the
 * theme changes, one reconciles the aircraft markers against each snapshot, and one animation
 * loop dead-reckons those markers between snapshots so the map breathes instead of teleporting.
 *
 * Nothing is drawn that the wire did not give us: an aircraft without a position is simply not
 * on the map, and a runway is only highlighted when the derived config names it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type {
  GlobalAircraft,
  Movement,
  MovementKind,
  Snapshot,
  SpotEvaluation,
} from '../../../../shared/types.ts';
import { useNow, useSnapshot } from '../../api/useSnapshot.ts';
import { navigateTo, useRouteDetail } from '../../state/route.ts';
import { useSelection } from '../../state/selection.tsx';
import { useSettings } from '../../state/settings.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import {
  compassPoint,
  formatAltitude,
  formatDistance,
  formatRelative,
  phaseLabel,
  routeLabel,
} from '../../lib/format.ts';
import { haversineKm } from '../../lib/geo.ts';
import type { AircraftMarkerHandle, AircraftVisual, MarkerKind } from './aircraftMarker.ts';
import { createAircraftMarker, createTrailLayer, deadReckon, lerpAngle } from './aircraftMarker.ts';
import type { FrameChrome } from './overlays.ts';
import { AIRPORT, AIRPORT_ZOOM, applyFrame, createRunwayOverlay, createSpotOverlay } from './overlays.ts';
import './MapTab.css';

const DASH = '—';
const KM_PER_NM = 1.852;

/** How far ahead of the last fix we are willing to guess a position. */
const MAX_EXTRAPOLATION_S = 120;
/** How long a marker takes to slide onto a freshly received position. */
const BLEND_MS = 700;

/** Zoom used when another tab points the map at one particular spotting location. */
const SPOT_FOCUS_ZOOM = 14;
/** Space between the bottom of an opened spot card and its pin: the tip, and room to breathe. */
const SPOT_PIN_CLEARANCE = 26;

const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

function tileUrl(theme: 'dark' | 'light'): string {
  const style = theme === 'light' ? 'light_all' : 'dark_all';
  return `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
}

/* ---- Environment hooks --------------------------------------------------------- */

function readTheme(): 'dark' | 'light' {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'light' || forced === 'dark') return forced;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Follows both the explicit `data-theme` override and the system preference. */
function useMapTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(readTheme);

  useEffect(() => {
    const sync = (): void => setTheme(readTheme());
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', sync);
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    sync();
    return () => {
      media.removeEventListener('change', sync);
      observer.disconnect();
    };
  }, []);

  return theme;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = (): void => setMatches(media.matches);
    media.addEventListener('change', sync);
    sync();
    return () => media.removeEventListener('change', sync);
  }, [query]);

  return matches;
}

/* ---- Turning the wire into markers ---------------------------------------------- */

interface TrackedAircraft {
  hex: string;
  lat: number;
  lon: number;
  track: number | null;
  groundSpeed: number | null;
  ageSeconds: number;
  visual: AircraftVisual;
}

interface TrackState {
  handle: AircraftMarkerHandle;
  baseLat: number;
  baseLon: number;
  baseTime: number;
  /**
   * Whether this marker may be dead-reckoned forward at all. False once the movement is coasting:
   * the fix is minutes old, and sliding the icon a fixed two minutes of flight ahead of it — up to
   * 16 nm at cruise — draws invented track exactly where the data is least trustworthy.
   */
  extrapolate: boolean;
  track: number | null;
  groundSpeed: number | null;
  renderLat: number;
  renderLon: number;
  renderHeading: number;
  fromLat: number;
  fromLon: number;
  fromHeading: number;
  blendStart: number;
}

function positionOf(movement: Movement): { lat: number; lon: number } | null {
  const { lat, lon } = movement.telemetry;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function movementKind(movement: Movement): MarkerKind {
  if (movement.telemetry.onGround) return 'ground';
  return movement.kind === 'departure' ? 'departure' : 'arrival';
}

function aircraftLabel(movement: Movement, units: 'metric' | 'imperial'): string {
  const name =
    movement.callsign ?? movement.airframe.registration ?? `A380 ${movement.id.toUpperCase()}`;
  const parts: string[] = [
    `${name}, ${movement.airline.name}`,
    `${phaseLabel(movement.phase)}, ${routeLabel(movement.route, movement.kind)}`,
  ];

  const altitude = formatAltitude(
    movement.telemetry.altitude,
    movement.telemetry.onGround,
    units,
  );
  if (altitude !== DASH) parts.push(altitude);

  const distance = formatDistance(movement.distanceNm, units);
  if (distance !== DASH) {
    const compass = compassPoint(movement.bearingFromAirport);
    parts.push(compass === DASH ? `${distance} from Heathrow` : `${distance} ${compass} of Heathrow`);
  }

  if (movement.coasting) parts.push('Last known position, feed quiet');

  return `${parts.join('. ')}.`;
}

function globalLabel(aircraft: GlobalAircraft, units: 'metric' | 'imperial'): string {
  const name = aircraft.callsign ?? aircraft.registration ?? `A380 ${aircraft.hex.toUpperCase()}`;
  const operator = aircraft.operator ?? 'Operator unknown';
  const altitude = formatAltitude(aircraft.altitude, aircraft.onGround, units);
  const parts = [`${name}, ${operator}`, 'Elsewhere in the world'];
  if (altitude !== DASH) parts.push(altitude);
  return `${parts.join('. ')}.`;
}

function buildTracked(
  movements: readonly Movement[][],
  worldwide: readonly GlobalAircraft[] | null,
  selectedHex: string | null,
  units: 'metric' | 'imperial',
): TrackedAircraft[] {
  const tracked: TrackedAircraft[] = [];
  const seen = new Set<string>();

  for (const group of movements) {
    for (const movement of group) {
      const position = positionOf(movement);
      if (!position || seen.has(movement.id)) continue;
      seen.add(movement.id);
      tracked.push({
        hex: movement.id,
        lat: position.lat,
        lon: position.lon,
        track: movement.telemetry.track,
        groundSpeed: movement.telemetry.groundSpeed,
        ageSeconds: movement.telemetry.ageSeconds,
        visual: {
          label: aircraftLabel(movement, units),
          kind: movementKind(movement),
          accent: movement.airline.color || null,
          onGround: movement.telemetry.onGround,
          selected: movement.id === selectedHex,
          coasting: movement.coasting,
        },
      });
    }
  }

  if (worldwide) {
    for (const aircraft of worldwide) {
      if (seen.has(aircraft.hex)) continue;
      if (typeof aircraft.lat !== 'number' || typeof aircraft.lon !== 'number') continue;
      if (!Number.isFinite(aircraft.lat) || !Number.isFinite(aircraft.lon)) continue;
      seen.add(aircraft.hex);
      tracked.push({
        hex: aircraft.hex,
        lat: aircraft.lat,
        lon: aircraft.lon,
        track: aircraft.track,
        groundSpeed: aircraft.groundSpeed,
        ageSeconds: 0,
        visual: {
          label: globalLabel(aircraft, units),
          kind: 'world',
          accent: null,
          onGround: aircraft.onGround,
          selected: aircraft.hex === selectedHex,
          coasting: false,
        },
      });
    }
  }

  return tracked;
}

/* ---- Animation ------------------------------------------------------------------ */

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Advances every marker to where the aircraft should be right now: dead-reckoned from its last
 * fix, eased across from wherever it was drawn a moment ago. With motion reduced, markers simply
 * sit on the reported position.
 */
function stepAircraft(states: Map<string, TrackState>, animate: boolean, now: number): void {
  for (const state of states.values()) {
    let lat = state.baseLat;
    let lon = state.baseLon;
    let heading = state.track ?? state.renderHeading;

    if (animate) {
      if (state.extrapolate) {
        const seconds = Math.min(Math.max((now - state.baseTime) / 1000, 0), MAX_EXTRAPOLATION_S);
        const predicted = deadReckon(state.baseLat, state.baseLon, state.track, state.groundSpeed, seconds);
        lat = predicted.lat;
        lon = predicted.lon;
      }

      const elapsed = now - state.blendStart;
      // Never ease across the antimeridian — that would send the marker the long way round.
      const wraps = Math.abs(state.fromLon - lon) > 180;
      if (state.blendStart > 0 && elapsed < BLEND_MS && !wraps) {
        const t = easeOut(elapsed / BLEND_MS);
        lat = state.fromLat + (lat - state.fromLat) * t;
        lon = state.fromLon + (lon - state.fromLon) * t;
        heading = lerpAngle(state.fromHeading, heading, t);
      }
    }

    state.renderLat = lat;
    state.renderLon = lon;
    state.renderHeading = heading;
    state.handle.setPose(lat, lon, heading);
  }
}

/* ---- Framing --------------------------------------------------------------------- */

/**
 * What "the right view" is, and when the map is allowed to take it.
 *
 * The reader arrives here from a Board that is counting down an inbound whale. An LHR-centred
 * view spanning ten miles answers none of that: the aeroplane they came to see is thirty miles
 * off the edge and the map reads as broken. So the opening view is fitted to Heathrow *plus the
 * A380s that have a relationship with it*.
 *
 * Two rules keep that from becoming a nuisance.
 *
 * The near field wins. An inbound 20 nm out and one 400 nm out cannot share a useful frame, so
 * the frame is scaled to the closest inbound and given room to breathe; anything much further out
 * is still drawn, still counted, and said out loud rather than silently framed in. The single
 * exception is the closest inbound itself, which is always held in view however far out it is —
 * subject to the zoom floor in overlays.ts, past which the honest answer is "off this view".
 *
 * And the map never argues with the hand on it. The moment the reader pans, pinches, wheels or
 * presses a zoom control, automatic framing stops until they ask for it back.
 */

/** The frame never scales tighter than this, so a whale on short final still has its context. */
const FRAME_NEAR_NM = 60;
/** Room allowed around the closest inbound, as a multiple of its distance. */
const FRAME_SPAN_FACTOR = 2.5;
/** How far a *second* aircraft may pull the frame out once a closer one has set the scale. */
const FRAME_LIMIT_NM = 600;
/** A departure stops being map news out here; from then on it is the Board's story, not ours. */
const FRAME_DEPARTURE_NM = 80;
/** A re-frame that no aircraft arrived or left to justify waits at least this long. */
const MIN_AUTO_FRAME_MS = 10_000;

/** The keys Leaflet's own keyboard handler pans and zooms with — pressing one is steering. */
const PAN_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  '+',
  '=',
  '-',
  '_',
]);

/** Whether the map is following the traffic or the reader. */
type Framing = 'auto' | 'manual';

interface FrameSubject {
  hex: string;
  /** Which board it is on: what it is doing, not where it is. */
  kind: MovementKind;
  lat: number;
  lon: number;
  distanceNm: number;
}

interface FramePlan {
  /** Every A380 with a Heathrow relationship *and* a position — the whole truth. */
  subjects: FrameSubject[];
  /** The positions the frame must hold. Heathrow itself is always included on top of these. */
  points: L.LatLngTuple[];
  /** Identity of the framed set; the frame is re-applied when this changes. */
  key: string;
  /** Distance of the furthest framed aircraft, nm. Zero when only the airport is framed. */
  spanNm: number;
  inbound: number;
  outbound: number;
  onGround: number;
  /** Tracked aircraft deliberately left outside the frame, nearest first. */
  beyond: FrameSubject[];
  /** Arrivals the tracker is holding that have no position to draw. */
  unplotted: number;
}

const EMPTY_PLAN: FramePlan = {
  subjects: [],
  points: [],
  key: '',
  spanNm: 0,
  inbound: 0,
  outbound: 0,
  onGround: 0,
  beyond: [],
  unplotted: 0,
};

/**
 * Distance to Heathrow. The wire carries one; it is only recomputed when the server had no answer
 * but we do have a position, and never invented when we have neither.
 */
function distanceNmOf(movement: Movement, position: { lat: number; lon: number }): number {
  const reported = movement.distanceNm;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) return reported;
  return haversineKm(AIRPORT, position) / KM_PER_NM;
}

function buildFramePlan(snapshot: Snapshot | null): FramePlan {
  if (!snapshot) return EMPTY_PLAN;

  const groups: readonly (readonly [MovementKind, readonly Movement[]])[] = [
    ['arrival', snapshot.arrivals],
    ['departure', snapshot.departures],
    ['ground', snapshot.ground],
  ];

  const subjects: FrameSubject[] = [];
  const seen = new Set<string>();
  let unplotted = 0;

  for (const [kind, group] of groups) {
    for (const movement of group) {
      if (seen.has(movement.id)) continue;
      const position = positionOf(movement);
      if (!position) {
        // Tracked, but out of ADS-B coverage. It is not on the map and must not be framed as if
        // it were — the empty state says so instead of leaving a hole.
        if (kind === 'arrival') unplotted += 1;
        continue;
      }
      seen.add(movement.id);
      subjects.push({
        hex: movement.id,
        kind,
        lat: position.lat,
        lon: position.lon,
        distanceNm: distanceNmOf(movement, position),
      });
    }
  }

  const closest = subjects
    .filter((subject) => subject.kind === 'arrival')
    .reduce<FrameSubject | null>(
      (best, subject) => (best === null || subject.distanceNm < best.distanceNm ? subject : best),
      null,
    );

  const reach =
    closest === null
      ? FRAME_DEPARTURE_NM
      : Math.min(FRAME_LIMIT_NM, Math.max(FRAME_NEAR_NM, closest.distanceNm * FRAME_SPAN_FACTOR));

  const framed: FrameSubject[] = [];
  const beyond: FrameSubject[] = [];

  for (const subject of subjects) {
    const limit = subject.kind === 'departure' ? Math.min(reach, FRAME_DEPARTURE_NM) : reach;
    const keep = subject.kind === 'ground' || subject === closest || subject.distanceNm <= limit;
    (keep ? framed : beyond).push(subject);
  }
  beyond.sort((a, b) => a.distanceNm - b.distanceNm);

  return {
    subjects,
    points: framed.map((subject) => [subject.lat, subject.lon] as L.LatLngTuple),
    // The kind is part of the identity: an arrival that lands keeps its hex and becomes a
    // completely different framing problem.
    key: framed
      .map((subject) => `${subject.hex}:${subject.kind}`)
      .sort()
      .join(' '),
    spanNm: framed.reduce((max, subject) => Math.max(max, subject.distanceNm), 0),
    inbound: framed.filter((subject) => subject.kind === 'arrival').length,
    outbound: framed.filter((subject) => subject.kind === 'departure').length,
    onGround: framed.filter((subject) => subject.kind === 'ground').length,
    beyond,
    unplotted,
  };
}

/**
 * Whether the traffic has moved enough to be worth a new frame. Ratios rather than thresholds, so
 * an aeroplane loitering either side of a fixed distance cannot make the map twitch every poll.
 */
function scaleChangedMaterially(before: number, after: number): boolean {
  if (before <= 0) return after > 0;
  return after < before * 0.55 || after > before * 1.9;
}

/** What the map just did, in a sentence, including what it could not fit. */
function frameSummary(plan: FramePlan, units: 'metric' | 'imperial'): string {
  const bits: string[] = [];
  if (plan.inbound > 0) bits.push(`${plan.inbound} inbound`);
  if (plan.outbound > 0) bits.push(`${plan.outbound} outbound`);
  if (plan.onGround > 0) bits.push(`${plan.onGround} on the ground`);

  const furthest = plan.beyond[0];
  const tail =
    furthest === undefined
      ? ''
      : plan.beyond.length === 1
        ? ` · 1 more A380, ${formatDistance(furthest.distanceNm, units)} out`
        : ` · ${plan.beyond.length} more A380s, ${formatDistance(furthest.distanceNm, units)} and beyond`;

  if (bits.length === 0) return `Framed on Heathrow — nothing else to show right now${tail}`;
  return `Framed on Heathrow · ${bits.join(' · ')}${tail}`;
}

/* ---- Spots ---------------------------------------------------------------------- */

function isSpotEvaluation(value: unknown): value is SpotEvaluation {
  if (typeof value !== 'object' || value === null) return false;
  const spot = (value as { spot?: unknown }).spot;
  if (typeof spot !== 'object' || spot === null) return false;
  const { lat, lon, name } = spot as { lat?: unknown; lon?: unknown; name?: unknown };
  return typeof lat === 'number' && typeof lon === 'number' && typeof name === 'string';
}

/* ---- Component ------------------------------------------------------------------ */

export function MapTab(): ReactElement {
  const { snapshot, connected, error, lastUpdate, loading } = useSnapshot();
  const { selectedHex, select } = useSelection();
  const { settings } = useSettings();
  const theme = useMapTheme();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  // Height matters as much as width: a landscape phone is wide enough for the legend and has
  // nowhere to put it, so it opened on top of the status pill over a 130 px strip of map.
  const roomForLegend = useMediaQuery('(min-width: 768px) and (min-height: 560px)');
  const now = useNow(5000);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDetailsElement | null>(null);
  const topLeftRef = useRef<HTMLDivElement | null>(null);
  const emptyRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const aircraftLayerRef = useRef<L.LayerGroup | null>(null);
  const runwayRef = useRef<ReturnType<typeof createRunwayOverlay> | null>(null);
  const spotRef = useRef<ReturnType<typeof createSpotOverlay> | null>(null);
  const trailRef = useRef<ReturnType<typeof createTrailLayer> | null>(null);
  const statesRef = useRef<Map<string, TrackState>>(new Map());
  const selectRef = useRef(select);
  const previousSelection = useRef<string | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [basemapDown, setBasemapDown] = useState(false);
  const [showSpots, setShowSpots] = useState(true);
  const [worldView, setWorldView] = useState(false);
  const [spots, setSpots] = useState<SpotEvaluation[] | null>(null);
  const [spotsError, setSpotsError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(roomForLegend);

  /** True while a spot card is open on the map — it is what the reader asked to look at. */
  const [spotCardOpen, setSpotCardOpen] = useState(false);
  /** Auto until the reader touches the map; then theirs until they hand it back. */
  const [framing, setFraming] = useState<Framing>('auto');
  const framingRef = useRef<Framing>('auto');
  /** How many tracked A380s are currently outside the visible rectangle, however it got there. */
  const [offView, setOffView] = useState(0);

  selectRef.current = select;

  // Open by default where there is room for it, folded away on a phone.
  useEffect(() => setLegendOpen(roomForLegend), [roomForLegend]);

  const announce = useCallback((message: string) => setAnnouncement(message), []);

  /**
   * The floating chrome, measured rather than assumed. The rail reflows to two rows of three on
   * a short screen and the legend is open on a desktop and folded on a phone; a frame built on
   * assumed sizes is a frame that hides an aeroplane under a panel.
   *
   * Declared up here because two different things need it: the framing, and the spot popups,
   * which Leaflet would otherwise open underneath the status stack.
   */
  const chromeInsets = useCallback((): FrameChrome => {
    const gap = 12;
    const rail = controlsRef.current?.getBoundingClientRect().width ?? 44;
    const stack = topLeftRef.current?.getBoundingClientRect().height ?? 0;
    const legend = legendOpen ? (legendRef.current?.getBoundingClientRect().width ?? 0) : 0;
    return {
      // The status stack grows: the framing chip, the empty-state card and the "tiles are not
      // loading" note all live in it, and on a phone that is a third of the map.
      top: Math.round(stack) + gap,
      right: Math.round(rail) + gap,
      bottom: 34, // the tile attribution
      left: legend > 0 ? Math.round(legend) + gap : 0,
    };
  }, [legendOpen]);

  /**
   * The same measurement, for a spot card that is about to open.
   *
   * The "nothing to draw" card is discounted because opening this popup is what hides it: measure
   * the stack as it stands and the card is panned clear of a panel that will not be there, which
   * on a phone pushes it off the bottom of the map instead.
   */
  const popupChrome = useCallback((): FrameChrome => {
    const chrome = chromeInsets();
    const empty = emptyRef.current?.getBoundingClientRect().height ?? 0;
    // The legend sits bottom-left, and even folded away it is a button the card must not land on
    // — but only where it stays put. On a phone it stands down while a card is open, so reserving
    // its height there would push the card up for a panel that will not be there.
    const legend = roomForLegend ? (legendRef.current?.getBoundingClientRect().height ?? 0) : 0;
    return {
      ...chrome,
      top: empty > 0 ? Math.max(12, chrome.top - Math.round(empty) - 8) : chrome.top,
      bottom: Math.max(chrome.bottom, Math.round(legend) + 12),
    };
  }, [chromeInsets, roomForLegend]);

  useEffect(() => {
    if (announcement === null) return;
    const timer = window.setTimeout(() => setAnnouncement(null), 6000);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  /** Every framing change goes through here, so the gesture watcher can see "already manual". */
  const setFramingMode = useCallback((mode: Framing) => {
    framingRef.current = mode;
    setFraming(mode);
  }, []);

  /* -- Map lifecycle ------------------------------------------------------------- */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = L.map(container, {
      center: [AIRPORT.lat, AIRPORT.lon],
      zoom: AIRPORT_ZOOM,
      minZoom: 2,
      maxZoom: 17,
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      preferCanvas: false,
    });
    map.attributionControl.setPrefix(false);
    mapRef.current = map;

    const runways = createRunwayOverlay();
    runways.layer.addTo(map);
    runwayRef.current = runways;

    const trail = createTrailLayer();
    trail.layer.addTo(map);
    trailRef.current = trail;

    const aircraft = L.layerGroup().addTo(map);
    aircraftLayerRef.current = aircraft;

    const spotOverlay = createSpotOverlay({
      // Carry the spot across: the Spots tab opens with this card expanded and in view.
      onOpenSpot: (spot) => navigateTo('spots', spot.id),
    });
    spotRef.current = spotOverlay;

    const onPopupOpen = (): void => setSpotCardOpen(true);
    const onPopupClose = (): void => setSpotCardOpen(false);
    map.on('popupopen', onPopupOpen);
    map.on('popupclose', onPopupClose);

    // The tab area changes with rotation, keyboard, and desktop resize.
    const resize = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    resize.observe(container);
    const onOrientation = (): void => {
      map.invalidateSize({ animate: false });
    };
    window.addEventListener('orientationchange', onOrientation);

    setMapReady(true);

    return () => {
      window.removeEventListener('orientationchange', onOrientation);
      map.off('popupopen', onPopupOpen);
      map.off('popupclose', onPopupClose);
      resize.disconnect();
      for (const state of statesRef.current.values()) state.handle.marker.remove();
      statesRef.current.clear();
      map.remove();
      mapRef.current = null;
      tileRef.current = null;
      aircraftLayerRef.current = null;
      runwayRef.current = null;
      spotRef.current = null;
      trailRef.current = null;
      setMapReady(false);
    };
  }, []);

  /* -- Basemap, swapped with the theme -------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const previous = tileRef.current;
    const layer = L.tileLayer(tileUrl(theme), {
      attribution: TILE_ATTRIBUTION,
      subdomains: 'abcd',
      maxZoom: 19,
      zIndex: previous ? 2 : 1,
    });
    layer.addTo(map);
    tileRef.current = layer;

    /*
     * The basemap is the one thing on this screen we do not serve ourselves. When CARTO cannot
     * be reached — a captive portal, a blocked CDN, a dead 4G cell — Leaflet just leaves the
     * canvas empty, which reads as "the app is broken". Say what actually happened instead:
     * everything we do own (runways, centrelines, aircraft, spots) is still live and drawn.
     */
    let failures = 0;
    const onTileError = (): void => {
      failures += 1;
      if (failures >= 4) setBasemapDown(true);
    };
    const onTileLoad = (): void => {
      failures = 0;
      setBasemapDown(false);
    };
    layer.on('tileerror', onTileError);
    layer.on('tileload', onTileLoad);

    let dropped = false;
    const dropPrevious = (): void => {
      if (dropped) return;
      dropped = true;
      if (previous) previous.remove();
      layer.setZIndex(1);
    };

    // Keep the old tiles until the new ones have painted, so the theme swap never flashes.
    if (previous) layer.once('load', dropPrevious);
    else dropped = true;

    return () => {
      layer.off('tileerror', onTileError);
      layer.off('tileload', onTileLoad);
      layer.off('load', dropPrevious);
      dropPrevious();
    };
  }, [mapReady, theme]);

  /* -- Runways -------------------------------------------------------------------- */

  const config = snapshot?.runwayConfig ?? null;
  const configKey = config
    ? `${config.direction}|${config.landing.join(',')}|${config.departing.join(',')}`
    : 'none';
  const configRef = useRef(config);
  configRef.current = config;

  // Keyed on the config's identity, not the snapshot: rebuilding the geometry 12 times a minute
  // for an unchanged runway configuration would be pure churn.
  useEffect(() => {
    if (!mapReady) return;
    runwayRef.current?.update(configRef.current);
  }, [mapReady, configKey]);

  /* -- Spotting locations ---------------------------------------------------------- */

  // Ratings depend on the runway config and the sun, so refresh on a config change and slowly.
  const spotsBucket = Math.floor(now / 600_000);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();

    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/spots', {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Server responded ${response.status}`);
        const data: unknown = await response.json();
        if (!alive) return;
        if (!Array.isArray(data)) throw new Error('Unexpected response');
        setSpots(data.filter(isSpotEvaluation));
        setSpotsError(null);
      } catch {
        if (!alive || controller.signal.aborted) return;
        setSpots(null);
        setSpotsError('Spotting locations could not be loaded');
      }
    };

    void load();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [configKey, spotsBucket]);

  useEffect(() => {
    const map = mapRef.current;
    const overlay = spotRef.current;
    if (!map || !overlay || !mapReady) return;
    overlay.update(spots ?? []);
    // Measured after the update, so a popup opened by a tap clears whatever the stack is now.
    overlay.setChrome(popupChrome(), map.getSize().y);
    if (showSpots && spots && spots.length > 0) overlay.layer.addTo(map);
    else overlay.layer.remove();
  }, [mapReady, popupChrome, showSpots, spots]);

  /* -- A spot handed to us by the Spots tab ----------------------------------------- */

  /**
   * `#map/<spot-id>`: someone pressed "show on map" on a specific fence. Centre it and open its
   * card — arriving at the standing Heathrow view with eleven identical pins answers nothing.
   */
  const focusSpotId = useRouteDetail('map');
  const focusedRef = useRef<string | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    const overlay = spotRef.current;
    if (!map || !overlay || !mapReady || focusSpotId === null) return;
    if (focusedRef.current === focusSpotId) return;
    const marker = overlay.markerFor(focusSpotId);
    if (!marker) return; // spots may not have loaded yet; this effect re-runs when they do
    if (!showSpots || !map.hasLayer(overlay.layer)) {
      // The pins are hidden: turn them on and come back on the next pass, once the layer is up.
      setShowSpots(true);
      return;
    }
    focusedRef.current = focusSpotId;
    setWorldView(false);
    // Someone named a fence. Automatic framing would take it away again on the next material
    // change, so this counts as the reader steering.
    setFramingMode('manual');
    /*
     * The pin is placed rather than centred, and the view is cut rather than flown.
     *
     * A spot card opens upwards out of its pin and is most of the height of a phone map, so a
     * centred pin puts the card through the top of the canvas and behind the status stack — the
     * one thing the reader asked to see, hidden by our own furniture. Leaflet's auto-pan is meant
     * to fix that and cannot be relied on here: it is undone by a zoom animation still in flight,
     * and it measures a container it does not know is two-thirds covered. So the arithmetic is
     * done here instead — drop the pin far enough below the chrome for the card to stand up in —
     * and auto-pan stays configured as the backstop for a pin tapped directly on the map.
     */
    const chrome = popupChrome();
    const size = map.getSize();
    const zoom = Math.max(map.getZoom(), SPOT_FOCUS_ZOOM);
    const cardHeight = overlay.setChrome(chrome, size.y);
    const pinY = Math.min(chrome.top + cardHeight + SPOT_PIN_CLEARANCE, size.y - chrome.bottom);
    const centre = map.unproject(
      map.project(marker.getLatLng(), zoom).subtract([0, pinY - size.y / 2]),
      zoom,
    );
    map.setView(centre, zoom, { animate: false });
    marker.openPopup();
  }, [focusSpotId, mapReady, popupChrome, setFramingMode, showSpots, spots]);

  /* -- Aircraft -------------------------------------------------------------------- */

  const tracked = useMemo(
    () =>
      buildTracked(
        snapshot ? [snapshot.arrivals, snapshot.departures, snapshot.ground] : [],
        worldView ? (snapshot?.worldwide ?? []) : null,
        selectedHex,
        settings.units,
      ),
    [snapshot, worldView, selectedHex, settings.units],
  );

  useEffect(() => {
    const group = aircraftLayerRef.current;
    if (!group || !mapReady) return;

    const states = statesRef.current;
    const timestamp = Date.now();
    const present = new Set<string>();

    for (const item of tracked) {
      present.add(item.hex);
      const age = Math.min(Math.max(item.ageSeconds, 0), MAX_EXTRAPOLATION_S);
      const baseTime = timestamp - age * 1000;
      // Smoothing between five-second polls is honest; guessing on top of a held position is not.
      const extrapolate = !item.visual.coasting;
      const existing = states.get(item.hex);

      if (existing) {
        existing.fromLat = existing.renderLat;
        existing.fromLon = existing.renderLon;
        existing.fromHeading = existing.renderHeading;
        existing.blendStart = timestamp;
        existing.baseLat = item.lat;
        existing.baseLon = item.lon;
        existing.baseTime = baseTime;
        existing.extrapolate = extrapolate;
        existing.track = item.track;
        existing.groundSpeed = item.groundSpeed;
        existing.handle.setVisual(item.visual);
        continue;
      }

      const heading = item.track ?? 0;
      const handle = createAircraftMarker({
        lat: item.lat,
        lon: item.lon,
        heading,
        visual: item.visual,
        onSelect: () => selectRef.current(item.hex),
      });
      handle.marker.addTo(group);
      states.set(item.hex, {
        handle,
        baseLat: item.lat,
        baseLon: item.lon,
        baseTime,
        extrapolate,
        track: item.track,
        groundSpeed: item.groundSpeed,
        renderLat: item.lat,
        renderLon: item.lon,
        renderHeading: heading,
        fromLat: item.lat,
        fromLon: item.lon,
        fromHeading: heading,
        blendStart: 0,
      });
    }

    for (const [hex, state] of states) {
      if (present.has(hex)) continue;
      group.removeLayer(state.handle.marker);
      states.delete(hex);
    }

    stepAircraft(states, !reducedMotion, Date.now());
  }, [tracked, mapReady, reducedMotion]);

  useEffect(() => {
    if (reducedMotion || !mapReady) return;
    let frame = 0;
    const tick = (): void => {
      stepAircraft(statesRef.current, true, Date.now());
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [reducedMotion, mapReady]);

  /* -- Selection: trail and a nudge into view --------------------------------------- */

  const selectedMovement = useMemo<Movement | null>(() => {
    if (!snapshot || !selectedHex) return null;
    for (const group of [snapshot.arrivals, snapshot.departures, snapshot.ground]) {
      const found = group.find((movement) => movement.id === selectedHex);
      if (found) return found;
    }
    return null;
  }, [snapshot, selectedHex]);

  const selectedRef = useRef(selectedMovement);
  selectedRef.current = selectedMovement;
  // The trail only changes when a new point lands — not on every snapshot.
  const trailKey = selectedMovement
    ? `${selectedMovement.id}:${selectedMovement.trail.length}:${selectedMovement.trail.at(-1)?.t ?? 0}`
    : '';

  useEffect(() => {
    const trail = trailRef.current;
    if (!trail || !mapReady) return;
    const movement = selectedRef.current;
    if (!movement) {
      trail.clear();
      return;
    }
    trail.update(movement.trail, movementKind(movement));
  }, [trailKey, mapReady]);

  /** The world fleet, for a selection that has no Heathrow movement behind it. */
  const worldwideRef = useRef<readonly GlobalAircraft[]>([]);
  worldwideRef.current = snapshot?.worldwide ?? [];

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const changed = previousSelection.current !== selectedHex;
    previousSelection.current = selectedHex;
    if (!changed || !selectedHex) return;
    const state = statesRef.current.get(selectedHex);
    if (!state) {
      /*
       * "Show on map" was pressed on an airframe with no Heathrow movement — the fleet browser is
       * full of them. Only the LHR traffic is drawn until world view is on, so the map opened on
       * Heathrow with the aeroplane nowhere on it and no way to tell that had happened. Turn the
       * world on and go to it: the button offered to show it, so it shows it.
       */
      const aircraft = worldwideRef.current.find((item) => item.hex === selectedHex);
      const lat = aircraft?.lat ?? null;
      const lon = aircraft?.lon ?? null;
      if (lat === null || lon === null) return;
      setWorldView(true);
      // The reader named one aeroplane; automatic framing would take it away at the next change.
      setFramingMode('manual');
      map.setView([lat, lon], Math.max(map.getZoom(), 5), { animate: false });
      announce('Showing this A380 in the world view — it has no Heathrow movement right now');
      return;
    }
    const point = L.latLng(state.renderLat, state.renderLon);
    if (map.getBounds().pad(-0.15).contains(point)) return;
    map.panTo(point, { animate: !reducedMotion });
  }, [announce, selectedHex, mapReady, reducedMotion, setFramingMode]);

  /* -- Framing: where the map points ------------------------------------------------- */

  const framePlan = useMemo(() => buildFramePlan(snapshot), [snapshot]);
  const planRef = useRef(framePlan);
  planRef.current = framePlan;
  const lastFrameRef = useRef<{ key: string; spanNm: number; at: number } | null>(null);

  /** Applies the current plan and remembers what it framed. Returns the sentence describing it. */
  const frameNow = useCallback((): string => {
    const map = mapRef.current;
    const plan = planRef.current;
    if (!map) return '';
    applyFrame(map, plan.points, { animate: !reducedMotion, chrome: chromeInsets() });
    lastFrameRef.current = { key: plan.key, spanNm: plan.spanNm, at: Date.now() };
    return frameSummary(plan, settings.units);
  }, [chromeInsets, reducedMotion, settings.units]);

  /**
   * The reader has taken the map. Built from the input events themselves rather than from
   * Leaflet's move events, because those cannot tell a hand from our own `setView` — wiring it
   * that way would have the map switching its own framing off every time it framed something.
   */
  const takeControl = useCallback(() => {
    if (framingRef.current === 'manual') return;
    setFramingMode('manual');
    announce('Auto-framing paused — the map stays where you put it');
  }, [announce, setFramingMode]);

  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container || !mapReady) return;

    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length > 1) takeControl();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (PAN_KEYS.has(event.key)) takeControl();
    };

    map.on('dragstart', takeControl);
    map.on('boxzoomstart', takeControl);
    container.addEventListener('wheel', takeControl, { passive: true });
    container.addEventListener('dblclick', takeControl);
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('keydown', onKeyDown);

    return () => {
      map.off('dragstart', takeControl);
      map.off('boxzoomstart', takeControl);
      container.removeEventListener('wheel', takeControl);
      container.removeEventListener('dblclick', takeControl);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('keydown', onKeyDown);
    };
  }, [mapReady, takeControl]);

  // Re-frame on a material change only: a whale appearing, landing or leaving the set, or the
  // scale of the thing being watched changing by enough to be worth the move.
  //
  // `framingRef` is consulted as well as the state, and it is the one that matters on a first
  // render: the effects that point the map at one named thing — a spot handed over from the Spots
  // tab, an airframe handed over from the fleet — run before this one and hand control over
  // through `setFramingMode`, whose state update this pass cannot see. Reading the state alone,
  // this effect framed the traffic straight back over the top of whatever the reader had asked
  // for, and only on the very render where they had asked for it.
  //
  // A spot handed over in the URL is held off for the same reason and one more: the opening frame
  // is animated, so even after the hand-over has taken control the frame that was already flying
  // lands a moment later and takes the view back. Nothing is framed until that fence has been
  // shown; after it has, framing is manual and this effect is done anyway.
  useEffect(() => {
    if (!mapReady || !snapshot || worldView || framing !== 'auto' || framingRef.current !== 'auto') {
      return;
    }
    if (focusSpotId !== null && focusedRef.current !== focusSpotId) return;
    const last = lastFrameRef.current;

    if (last !== null && last.key === framePlan.key) {
      if (!scaleChangedMaterially(last.spanNm, framePlan.spanNm)) return;
      if (Date.now() - last.at < MIN_AUTO_FRAME_MS) return;
      frameNow();
      return;
    }

    const message = frameNow();
    // Speak only when the cast changed, and never for the opening frame — an aria-live region
    // that narrates every zoom step is a nuisance to the people who depend on it most.
    if (last !== null) announce(message);
  }, [announce, focusSpotId, framePlan, frameNow, framing, mapReady, snapshot, worldView]);

  /* -- What is not on screen ---------------------------------------------------------- */

  /**
   * However the map came to be framed, it must never quietly hide a whale it is tracking. This is
   * measured against the real visible rectangle rather than assumed from the frame we asked for.
   */
  const subjectsRef = useRef(framePlan.subjects);
  subjectsRef.current = framePlan.subjects;

  const recountOffView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    let count = 0;
    for (const subject of subjectsRef.current) {
      if (!bounds.contains(L.latLng(subject.lat, subject.lon))) count += 1;
    }
    setOffView(count);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.on('moveend', recountOffView);
    map.on('zoomend', recountOffView);
    return () => {
      map.off('moveend', recountOffView);
      map.off('zoomend', recountOffView);
    };
  }, [mapReady, recountOffView]);

  // Aircraft move too: one can leave the view without the map moving at all.
  useEffect(() => {
    if (!mapReady) return;
    recountOffView();
  }, [framePlan, mapReady, recountOffView]);

  /* -- Controls --------------------------------------------------------------------- */

  const recentre = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setWorldView(false);
    // A deliberate "show me the airport" is a framing decision of the reader's own; keeping the
    // automatic frame alive would take it back off them at the next material change.
    setFramingMode('manual');
    map.setView([AIRPORT.lat, AIRPORT.lon], AIRPORT_ZOOM, { animate: !reducedMotion });
    announce('Centred on Heathrow · auto-framing paused');
  }, [announce, reducedMotion, setFramingMode]);

  const fitTraffic = useCallback(() => {
    if (!mapRef.current) return;
    setWorldView(false);
    setFramingMode('auto');
    announce(frameNow());
  }, [announce, frameNow, setFramingMode]);

  const toggleWorld = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    if (worldView) {
      setWorldView(false);
      setFramingMode('auto');
      announce(frameNow());
      return;
    }

    setWorldView(true);
    setFramingMode('manual');

    const points: L.LatLngTuple[] = [];
    for (const aircraft of snapshot?.worldwide ?? []) {
      if (typeof aircraft.lat === 'number' && typeof aircraft.lon === 'number') {
        points.push([aircraft.lat, aircraft.lon]);
      }
    }
    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 6, animate: false });
      announce(`World view — ${points.length} A380s with a position`);
    } else {
      map.setView([25, 0], 2, { animate: false });
      announce('World view — no A380 positions on the feed right now');
    }
  }, [announce, frameNow, setFramingMode, snapshot, worldView]);

  const toggleSpots = useCallback(() => {
    const next = !showSpots;
    setShowSpots(next);
    announce(next ? 'Spotting locations shown' : 'Spotting locations hidden');
  }, [announce, showSpots]);

  const zoomBy = useCallback(
    (delta: number) => {
      const map = mapRef.current;
      if (!map) return;
      takeControl();
      map.setZoom(map.getZoom() + delta, { animate: !reducedMotion });
    },
    [reducedMotion, takeControl],
  );

  /* -- Status line ------------------------------------------------------------------ */

  // Counted off the same list the framing works from, so the pill and the frame can never
  // disagree about how many whales there are.
  const counts = useMemo(() => {
    const subjects = framePlan.subjects;
    const arrivals = subjects.filter((subject) => subject.kind === 'arrival').length;
    const departures = subjects.filter((subject) => subject.kind === 'departure').length;
    const ground = subjects.filter((subject) => subject.kind === 'ground').length;
    return {
      arrivals,
      departures,
      ground,
      near: subjects.length,
      world: snapshot?.worldwide.length ?? 0,
    };
  }, [framePlan, snapshot]);

  const stale = snapshot?.health.stale ?? false;
  const live = connected && !stale;

  let status: string;
  if (!snapshot) {
    status = loading ? 'Connecting to the live feed…' : 'No live data yet';
  } else if (worldView) {
    status = `World view · ${counts.world} A380${counts.world === 1 ? '' : 's'} on the feed`;
  } else if (counts.near === 0) {
    if (framePlan.unplotted > 0) {
      // "Nothing here" would be a lie: the tracker is holding an arrival, it just has no fix.
      status = `${framePlan.unplotted} inbound tracked · no position on the feed yet`;
    } else {
      status =
        counts.world > 0
          ? `No A380s at Heathrow · ${counts.world} elsewhere in the world`
          : 'No A380s at Heathrow right now';
    }
  } else {
    const bits: string[] = [];
    if (counts.arrivals > 0) bits.push(`${counts.arrivals} inbound`);
    if (counts.departures > 0) bits.push(`${counts.departures} outbound`);
    if (counts.ground > 0) bits.push(`${counts.ground} on the ground`);
    // A whale that is tracked but off the edge of the view has to be admitted to. Silence there
    // is how a map ends up quietly lying about how much it knows.
    if (offView > 0) bits.push(`${offView} off this view`);
    status = bits.join(' · ');
  }

  /* -- Framing chip: the mode, in words, with the way out of it --------------------- */

  const autoFraming = framing === 'auto' && !worldView;
  const frameChip: {
    className: string;
    icon: 'arrival' | 'map';
    label: string;
    detail: string;
    action: () => void;
  } = worldView
    ? {
        className: 'map-frame map-frame--world',
        icon: 'map',
        label: 'World view',
        detail: ' — press to come back to Heathrow and follow its A380s.',
        action: toggleWorld,
      }
    : autoFraming
      ? {
          className: 'map-frame map-frame--auto',
          icon: 'arrival',
          // "Following traffic" over an empty airfield would be a small boast about nothing.
          label: counts.near > 0 ? 'Following traffic' : 'Watching for traffic',
          detail: ' — the map re-frames itself when the traffic changes. Press to fit it again now.',
          action: fitTraffic,
        }
      : {
          className: 'map-frame map-frame--manual',
          icon: 'arrival',
          label: 'Fit traffic',
          detail: ' — frames Heathrow and its A380s, and follows them again.',
          action: fitTraffic,
        };

  /* -- Nothing to draw --------------------------------------------------------------- */

  /*
   * "Nothing to draw" is a statement about aircraft, and the reader who has just opened a spot
   * card has asked about a fence. On a phone the two do not fit: the stack is 300 px of a 440 px
   * map and the card opens underneath it. The pill above still carries the fact, so the card that
   * was asked for wins and this one waits until it is closed.
   */
  const showEmptyState = snapshot !== null && !worldView && counts.near === 0 && !spotCardOpen;
  const emptyTitle =
    framePlan.unplotted > 0
      ? `${framePlan.unplotted} inbound, no position yet`
      : 'Nothing to draw right now';
  const emptyLines: string[] = [];
  if (framePlan.unplotted > 0) {
    emptyLines.push(
      framePlan.unplotted === 1
        ? 'The feed has no position for it — ADS-B coverage over the ocean is patchy, so it will appear here the moment there is a fix.'
        : 'The feed has no position for them — ADS-B coverage over the ocean is patchy, so they will appear here the moment there is a fix.',
    );
  } else {
    emptyLines.push(
      'Every A380 in the world is being watched for one arriving here or leaving. The runways below show the configuration in use right now.',
    );
  }
  if (!live) {
    emptyLines.push('The feed has gone quiet, so this is the last picture we had.');
  }

  return (
    <section className="map-tab" aria-label="Live map of Heathrow A380 traffic">
      {/*
        The controls and the legend come first in the DOM on purpose. Leaflet appends every
        marker inside the canvas, so with the natural order a keyboard user had to tab past
        eleven spot pins and every aircraft on screen — 52 presses in world view — to reach the
        zoom buttons, and world view can only be turned off from those buttons. Both blocks are
        absolutely positioned, so nothing about the layout changes.

        Every control names itself, too. The labels are real elements rather than `title`
        attributes: a native tooltip needs a mouse, waits a second, cannot be styled and is never
        read out — which left the whole rail, including the control that fixes a badly framed
        map, as six unexplained glyphs. These show on hover *and* on keyboard focus, and they are
        the accessible name of the button rather than a duplicate of it.
      */}
      <div className="map-controls" role="group" aria-label="Map controls" ref={controlsRef}>
        <button type="button" className="map-btn" onClick={() => zoomBy(1)}>
          <span className="map-btn-glyph" aria-hidden="true">
            +
          </span>
          <span className="map-btn-label">Zoom in</span>
        </button>
        <button type="button" className="map-btn" onClick={() => zoomBy(-1)}>
          <span className="map-btn-glyph" aria-hidden="true">
            −
          </span>
          <span className="map-btn-label">Zoom out</span>
        </button>
        <button type="button" className="map-btn" onClick={recentre}>
          <Icon name="runway" size={20} />
          <span className="map-btn-label">Centre on Heathrow</span>
        </button>
        <button
          type="button"
          className={autoFraming ? 'map-btn map-btn--on' : 'map-btn'}
          onClick={fitTraffic}
        >
          <Icon name="arrival" size={20} />
          <span className="map-btn-label">Fit traffic</span>
          <span className="app-visually-hidden">
            {autoFraming
              ? ' — Heathrow and its A380s. Auto-framing is on.'
              : ' — Heathrow and its A380s. Auto-framing is paused.'}
          </span>
        </button>
        <button
          type="button"
          className={showSpots ? 'map-btn map-btn--on' : 'map-btn'}
          onClick={toggleSpots}
          aria-pressed={showSpots}
        >
          <Icon name="binoculars" size={20} />
          <span className="map-btn-label">Spotting locations</span>
        </button>
        <button
          type="button"
          className={worldView ? 'map-btn map-btn--on' : 'map-btn'}
          onClick={toggleWorld}
          aria-pressed={worldView}
        >
          <Icon name="map" size={20} />
          <span className="map-btn-label">Every A380 in the world</span>
        </button>
      </div>

      {/*
        On a phone the legend and an opened spot card are competing for the same corner of a 440 px
        map, and the card is the thing the reader asked for. Where there is room for both — the
        desktop and a tablet — nothing is taken away.
      */}
      <details
        className={
          spotCardOpen && !roomForLegend ? 'map-legend map-legend--hidden' : 'map-legend'
        }
        ref={legendRef}
        open={legendOpen}
        onToggle={(event) => setLegendOpen(event.currentTarget.open)}
      >
        <summary className="map-legend-summary">Legend</summary>
        {/*
          The swatches have to describe what the map actually draws. Aircraft are painted in their
          operator's brand colour with a coloured glow for their role, so the aircraft rows are
          glows around a neutral planform — a flat teal square here matched nothing on screen.
        */}
        <ul className="map-legend-list">
          <li className="map-legend-item">
            <span className="map-swatch map-swatch--glow-arrival" aria-hidden="true" />
            Arriving — teal glow, chevron down
          </li>
          <li className="map-legend-item">
            <span className="map-swatch map-swatch--glow-departure" aria-hidden="true" />
            Departing — amber glow, chevron up
          </li>
          <li className="map-legend-item">
            <span className="map-swatch map-swatch--glow-ground" aria-hidden="true" />
            On the ground — no glow, no chevron
          </li>
          {worldView ? (
            <li className="map-legend-item">
              <span className="map-swatch map-swatch--glow-world" aria-hidden="true" />
              Elsewhere in the world — grey, no Heathrow movement
            </li>
          ) : null}
          <li className="map-legend-item">
            <span className="map-swatch map-swatch--landing" aria-hidden="true" />
            Landing runway and its approach
          </li>
          <li className="map-legend-item">
            <span className="map-swatch map-swatch--departing" aria-hidden="true" />
            Departure runway and its climb-out
          </li>
          {showSpots && spots && spots.length > 0 ? (
            <li className="map-legend-item">
              <span className="map-swatch map-swatch--spot" aria-hidden="true" />
              Spotting location — ringed ones rate excellent right now
            </li>
          ) : null}
        </ul>
        <p className="map-legend-note">
          Each aircraft is drawn in its airline's colour; the glow around it is what says whether
          it is arriving or departing.
        </p>
        {showSpots && spotsError ? <p className="map-legend-note">{spotsError}</p> : null}
        {config && config.summary ? <p className="map-legend-note">{config.summary}</p> : null}
      </details>

      <div
        className="map-canvas"
        ref={containerRef}
        role="application"
        aria-label="Map. Aircraft and spotting locations are focusable; use arrow keys to pan and plus or minus to zoom."
      />

      <div className="map-topleft" ref={topLeftRef}>
        <div className="map-status">
          <p className="map-status-line" aria-live="polite">
            <span
              className={live ? 'map-dot map-dot--live' : 'map-dot map-dot--stale'}
              aria-hidden="true"
            />
            <span className="map-status-text">{announcement ?? status}</span>
          </p>
          <p className="map-status-meta">
            {connected
              ? `Live · updated ${formatRelative(lastUpdate, now)}`
              : error !== null && !snapshot
                ? 'Offline — no data received'
                : `Reconnecting · last update ${formatRelative(lastUpdate, now)}`}
          </p>
        </div>

        {/*
          What the map is doing with itself, in words, and the way back. "Following traffic" is
          the state the map opens in; the moment the reader pans or zooms it becomes "Fit traffic"
          — an offer, not a nag, and the one control that undoes a lost view.
        */}
        <button type="button" className={frameChip.className} onClick={frameChip.action}>
          <Icon name={frameChip.icon} size={15} />
          <span>{frameChip.label}</span>
          <span className="app-visually-hidden">{frameChip.detail}</span>
        </button>

        {/*
          Nothing to draw is an answer, and it belongs in the same column as every other thing the
          map has to say about itself — centred over the airfield it would land on the status
          stack on a phone, which is how a designed empty state turns into a pile-up. Not a live
          region: the status pill above already announces the same fact, and twice is worse.
        */}
        {showEmptyState ? (
          <div className="map-empty" ref={emptyRef}>
            <p className="map-empty-head">
              <span className="map-empty-icon" aria-hidden="true">
                <Icon name="binoculars" size={16} />
              </span>
              <span className="map-empty-title">{emptyTitle}</span>
            </p>
            <p className="map-empty-text">{emptyLines.join(' ')}</p>
            {counts.world > 0 ? (
              <button type="button" className="map-empty-action" onClick={toggleWorld}>
                Show all {counts.world} A380s worldwide
              </button>
            ) : null}
          </div>
        ) : null}

        {basemapDown ? (
          <p className="map-basemap-note" role="status">
            <Icon name="info" size={15} />
            <span>
              Basemap tiles are not loading. The runways, centrelines, aircraft and spot pins are
              ours, and they are still live.
            </span>
          </p>
        ) : null}
      </div>

      {loading && !snapshot ? (
        <div className="map-overlay" role="status">
          <span className="map-overlay-pulse" aria-hidden="true" />
          <p className="map-overlay-title">Finding the whales</p>
          <p className="map-overlay-text">
            Waiting for the first snapshot from the tracker. The map is live as soon as it lands.
          </p>
        </div>
      ) : null}

      {!loading && !snapshot && error !== null ? (
        <div className="map-overlay" role="alert">
          <span className="map-overlay-icon" aria-hidden="true">
            <Icon name="alert" size={22} />
          </span>
          <p className="map-overlay-title">No live feed</p>
          <p className="map-overlay-text">
            {error}. The runways below are drawn from published data, but nothing is flying on this
            map until the feed returns — we would rather show you nothing than invent traffic.
          </p>
        </div>
      ) : null}

    </section>
  );
}
