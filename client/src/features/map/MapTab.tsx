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
import type { GlobalAircraft, Movement, SpotEvaluation } from '../../../../shared/types.ts';
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
import type { AircraftMarkerHandle, AircraftVisual, MarkerKind } from './aircraftMarker.ts';
import { createAircraftMarker, createTrailLayer, deadReckon, lerpAngle } from './aircraftMarker.ts';
import { AIRPORT, AIRPORT_ZOOM, airportBounds, createRunwayOverlay, createSpotOverlay } from './overlays.ts';
import './MapTab.css';

const DASH = '—';

/** How far ahead of the last fix we are willing to guess a position. */
const MAX_EXTRAPOLATION_S = 120;
/** How long a marker takes to slide onto a freshly received position. */
const BLEND_MS = 700;

/** Zoom used when another tab points the map at one particular spotting location. */
const SPOT_FOCUS_ZOOM = 14;

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
  const roomForLegend = useMediaQuery('(min-width: 768px)');
  const now = useNow(5000);

  const containerRef = useRef<HTMLDivElement | null>(null);
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

  selectRef.current = select;

  // Open by default where there is room for it, folded away on a phone.
  useEffect(() => setLegendOpen(roomForLegend), [roomForLegend]);

  const announce = useCallback((message: string) => setAnnouncement(message), []);

  useEffect(() => {
    if (announcement === null) return;
    const timer = window.setTimeout(() => setAnnouncement(null), 6000);
    return () => window.clearTimeout(timer);
  }, [announcement]);

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
    if (showSpots && spots && spots.length > 0) overlay.layer.addTo(map);
    else overlay.layer.remove();
  }, [mapReady, showSpots, spots]);

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
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), SPOT_FOCUS_ZOOM), {
      animate: !reducedMotion,
    });
    marker.openPopup();
  }, [focusSpotId, mapReady, reducedMotion, showSpots, spots]);

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const changed = previousSelection.current !== selectedHex;
    previousSelection.current = selectedHex;
    if (!changed || !selectedHex) return;
    const state = statesRef.current.get(selectedHex);
    if (!state) return;
    const point = L.latLng(state.renderLat, state.renderLon);
    if (map.getBounds().pad(-0.15).contains(point)) return;
    map.panTo(point, { animate: !reducedMotion });
  }, [selectedHex, mapReady, reducedMotion]);

  /* -- Controls --------------------------------------------------------------------- */

  const recentre = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setWorldView(false);
    map.setView([AIRPORT.lat, AIRPORT.lon], AIRPORT_ZOOM, { animate: !reducedMotion });
    announce('Recentred on Heathrow');
  }, [announce, reducedMotion]);

  const fitArrivals = useCallback(() => {
    const map = mapRef.current;
    if (!map || !snapshot) return;
    const points: L.LatLngTuple[] = [[AIRPORT.lat, AIRPORT.lon]];
    for (const movement of snapshot.arrivals) {
      const position = positionOf(movement);
      if (position) points.push([position.lat, position.lon]);
    }
    if (points.length < 2) {
      announce('No inbound A380s with a position to fit right now');
      return;
    }
    setWorldView(false);
    map.fitBounds(L.latLngBounds(points), {
      padding: [56, 56],
      maxZoom: 11,
      animate: !reducedMotion,
    });
    announce(`Fitted ${points.length - 1} inbound A380${points.length - 1 === 1 ? '' : 's'}`);
  }, [announce, reducedMotion, snapshot]);

  const toggleWorld = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const next = !worldView;
    setWorldView(next);

    if (!next) {
      map.fitBounds(airportBounds(), { animate: !reducedMotion });
      announce('Back to Heathrow');
      return;
    }

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
  }, [announce, reducedMotion, snapshot, worldView]);

  const toggleSpots = useCallback(() => {
    const next = !showSpots;
    setShowSpots(next);
    announce(next ? 'Spotting locations shown' : 'Spotting locations hidden');
  }, [announce, showSpots]);

  const zoomBy = useCallback(
    (delta: number) => {
      const map = mapRef.current;
      if (!map) return;
      map.setZoom(map.getZoom() + delta, { animate: !reducedMotion });
    },
    [reducedMotion],
  );

  /* -- Status line ------------------------------------------------------------------ */

  const counts = useMemo(() => {
    if (!snapshot) return { arrivals: 0, departures: 0, ground: 0, near: 0, world: 0 };
    const arrivals = snapshot.arrivals.filter((movement) => positionOf(movement)).length;
    const departures = snapshot.departures.filter((movement) => positionOf(movement)).length;
    const ground = snapshot.ground.filter((movement) => positionOf(movement)).length;
    return {
      arrivals,
      departures,
      ground,
      near: arrivals + departures + ground,
      world: snapshot.worldwide.length,
    };
  }, [snapshot]);

  let status: string;
  if (!snapshot) {
    status = loading ? 'Connecting to the live feed…' : 'No live data yet';
  } else if (worldView) {
    status = `World view · ${counts.world} A380${counts.world === 1 ? '' : 's'} on the feed`;
  } else if (counts.near === 0) {
    status =
      counts.world > 0
        ? `No A380s at Heathrow · ${counts.world} elsewhere in the world`
        : 'No A380s at Heathrow right now';
  } else {
    const bits: string[] = [];
    if (counts.arrivals > 0) bits.push(`${counts.arrivals} inbound`);
    if (counts.departures > 0) bits.push(`${counts.departures} outbound`);
    if (counts.ground > 0) bits.push(`${counts.ground} on the ground`);
    status = bits.join(' · ');
  }

  const stale = snapshot?.health.stale ?? false;
  const live = connected && !stale;

  return (
    <section className="map-tab" aria-label="Live map of Heathrow A380 traffic">
      {/*
        The controls and the legend come first in the DOM on purpose. Leaflet appends every
        marker inside the canvas, so with the natural order a keyboard user had to tab past
        eleven spot pins and every aircraft on screen — 52 presses in world view — to reach the
        zoom buttons, and world view can only be turned off from those buttons. Both blocks are
        absolutely positioned, so nothing about the layout changes.
      */}
      <div className="map-controls" role="group" aria-label="Map controls">
        <button type="button" className="map-btn" onClick={() => zoomBy(1)} title="Zoom in">
          <span className="map-btn-glyph" aria-hidden="true">
            +
          </span>
          <span className="app-visually-hidden">Zoom in</span>
        </button>
        <button type="button" className="map-btn" onClick={() => zoomBy(-1)} title="Zoom out">
          <span className="map-btn-glyph" aria-hidden="true">
            −
          </span>
          <span className="app-visually-hidden">Zoom out</span>
        </button>
        <button type="button" className="map-btn" onClick={recentre} title="Recentre on Heathrow">
          <Icon name="runway" size={20} />
          <span className="app-visually-hidden">Recentre on Heathrow</span>
        </button>
        <button type="button" className="map-btn" onClick={fitArrivals} title="Fit all arrivals">
          <Icon name="arrival" size={20} />
          <span className="app-visually-hidden">Fit all inbound A380s in view</span>
        </button>
        <button
          type="button"
          className={showSpots ? 'map-btn map-btn--on' : 'map-btn'}
          onClick={toggleSpots}
          aria-pressed={showSpots}
          title={showSpots ? 'Hide spotting locations' : 'Show spotting locations'}
        >
          <Icon name="binoculars" size={20} />
          <span className="app-visually-hidden">Spotting locations</span>
        </button>
        <button
          type="button"
          className={worldView ? 'map-btn map-btn--on' : 'map-btn'}
          onClick={toggleWorld}
          aria-pressed={worldView}
          title={worldView ? 'Back to Heathrow' : 'Show every A380 in the world'}
        >
          <Icon name="map" size={20} />
          <span className="app-visually-hidden">World view</span>
        </button>
      </div>

      <details
        className="map-legend"
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

      <div className="map-topleft">
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
