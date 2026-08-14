/**
 * The A380 map marker: an SVG planform drawn from scratch — wide fuselage, deeply swept wings,
 * four engines — rotated to the aircraft's true track.
 *
 * Everything visual is expressed as class names and one custom property (`--map-accent`, the
 * airline's brand colour, which is data rather than design); the actual paint comes from
 * MapTab.css so the marker follows the design tokens and the theme.
 */

import * as L from 'leaflet';
import type { TrailPoint } from '../../../../shared/types.ts';

export type MarkerKind = 'arrival' | 'departure' | 'ground' | 'world';

export interface AircraftVisual {
  /** Accessible name, e.g. "BAW117 British Airways, on approach from New York". */
  label: string;
  kind: MarkerKind;
  /** Airline brand colour from the wire. Null when we do not have one. */
  accent: string | null;
  onGround: boolean;
  selected: boolean;
  /** True when the feed has gone quiet and we are showing the last known position. */
  coasting: boolean;
}

/**
 * Nose-up planform in a 64-unit box, drawn to the A380-800's own proportions rather than to a
 * generic airliner silhouette — this app is about one aeroplane and a spotter reads the shape
 * before the label.
 *
 * Scale: 55.6 units ≈ 72.7 m of length, so one unit ≈ 1.31 m. What that buys, measured:
 *
 * | feature          | real          | drawn        |
 * |------------------|---------------|--------------|
 * | span ÷ length    | 79.8 ÷ 72.7 = 1.10 | 59.8 ÷ 55.6 = 1.08 |
 * | fuselage width   | 7.1 m (0.098 L)    | 6.2 u (0.112 L)    |
 * | tailplane span   | 30.4 m (0.38 span) | 22.8 u (0.38 span) |
 * | engines          | four               | four               |
 *
 * The fuselage runs a little fat and the span a little short on purpose: at 44 px the whale has
 * to survive a 1.6-unit outline on every shape, and a true-to-scale span would have put the
 * wingtips through the edge of the icon box at some headings.
 */
const PLANFORM = [
  // Fuselage — nose at y=4, constant section to y≈46, tail cone to y=59.6.
  '<path class="map-plane-body" d="M32 4c1.9 2.3 3.1 6.2 3.1 10.8v30.8c0 6-.7 10.6-2 14H30.9c-1.3-3.4-2-8-2-14V14.8C28.9 10.2 30.1 6.3 32 4Z"/>',
  // Wings — 37° of leading-edge sweep, raked tips, root chord from y=24.2 to y=38.8.
  '<path class="map-plane-body" d="M35.1 24.2 60.8 43.2q1.4 1 .9 2.7-.5 1.3-2 .9L35.1 38.8Z"/>',
  '<path class="map-plane-body" d="M28.9 24.2 3.2 43.2q-1.4 1-.9 2.7.5 1.3 2 .9L28.9 38.8Z"/>',
  // Tailplane — deliberately small: an oversized one is the thing that makes an A380 read as a 747.
  '<path class="map-plane-body" d="M34.4 49.8 42.8 55.2q.8.5.5 1.4-.3.7-1.2.5L34.4 54.8Z"/>',
  '<path class="map-plane-body" d="M29.6 49.8 21.2 55.2q-.8.5-.5 1.4.3.7 1.2.5L29.6 54.8Z"/>',
  // Four engines. Each nacelle straddles the leading edge at its own station, so the inboard pair
  // sits ahead of the outboard pair — the giveaway that this is not a twin with the wick turned up.
  '<rect class="map-plane-body" x="39.7" y="25.2" width="2.6" height="5.6" rx="1.3"/>',
  '<rect class="map-plane-body" x="46.3" y="30.1" width="2.6" height="5.6" rx="1.3"/>',
  '<rect class="map-plane-body" x="21.7" y="25.2" width="2.6" height="5.6" rx="1.3"/>',
  '<rect class="map-plane-body" x="15.1" y="30.1" width="2.6" height="5.6" rx="1.3"/>',
].join('');

const MARKER_BOX = 56;
const ART_SIZE = 44;

const SCALE: Record<'ground' | 'airborne' | 'selected', number> = {
  ground: 0.6,
  airborne: 1,
  selected: 1.3,
};

function iconHtml(): string {
  return (
    '<span class="map-plane-halo" aria-hidden="true"></span>' +
    // Role, told without colour: a chevron pointing down for an arrival, up for a departure.
    // It sits outside the rotating span so it stays screen-oriented at any heading, and it is
    // the second channel the glow alone could not provide.
    '<span class="map-plane-badge" aria-hidden="true"></span>' +
    '<span class="map-plane">' +
    `<svg class="map-plane-art" viewBox="0 0 64 64" width="${ART_SIZE}" height="${ART_SIZE}" ` +
    'aria-hidden="true" focusable="false">' +
    PLANFORM +
    '</svg>' +
    '</span>'
  );
}

function classesFor(visual: AircraftVisual): string[] {
  const classes = ['map-marker', `map-marker--${visual.kind}`];
  if (visual.onGround) classes.push('map-marker--onground');
  if (visual.selected) classes.push('map-marker--selected');
  if (visual.coasting) classes.push('map-marker--coasting');
  return classes;
}

function scaleFor(visual: AircraftVisual): number {
  if (visual.selected) return SCALE.selected;
  if (visual.onGround) return SCALE.ground;
  return SCALE.airborne;
}

export interface AircraftMarkerHandle {
  readonly marker: L.Marker;
  /** Colour, size, selection and the accessible name. */
  setVisual(visual: AircraftVisual): void;
  /** Position and heading. Cheap enough to call every animation frame. */
  setPose(lat: number, lon: number, headingDeg: number): void;
}

/**
 * One aircraft. Built once, then mutated — recreating markers on every snapshot would make the
 * map flicker and would throw away keyboard focus.
 */
export function createAircraftMarker(options: {
  lat: number;
  lon: number;
  heading: number;
  visual: AircraftVisual;
  onSelect: () => void;
}): AircraftMarkerHandle {
  let visual = options.visual;
  let heading = options.heading;
  let appliedClasses = classesFor(visual);

  const marker = L.marker([options.lat, options.lon], {
    icon: L.divIcon({
      className: appliedClasses.join(' '),
      html: iconHtml(),
      iconSize: [MARKER_BOX, MARKER_BOX],
      iconAnchor: [MARKER_BOX / 2, MARKER_BOX / 2],
    }),
    keyboard: true,
    riseOnHover: true,
    title: visual.label,
    zIndexOffset: visual.selected ? 1000 : 0,
  });

  marker.on('click', () => options.onSelect());

  let planeElement: HTMLElement | null = null;
  let keyboardBound = false;

  /** The rotating inner span, re-queried if Leaflet has rebuilt the icon. */
  const plane = (): HTMLElement | null => {
    if (planeElement?.isConnected) return planeElement;
    planeElement = marker.getElement()?.querySelector<HTMLElement>('.map-plane') ?? null;
    return planeElement;
  };

  const applyTransform = (): void => {
    const node = plane();
    if (!node) return;
    node.style.transform = `rotate(${heading.toFixed(1)}deg) scale(${scaleFor(visual)})`;
  };

  const applyElement = (): void => {
    const element = marker.getElement();
    if (!element) return;

    element.setAttribute('aria-label', visual.label);

    // Swap only our own classes — Leaflet owns the rest of the class list on this element.
    const next = classesFor(visual);
    for (const name of appliedClasses) {
      if (!next.includes(name)) element.classList.remove(name);
    }
    for (const name of next) element.classList.add(name);
    appliedClasses = next;

    if (visual.accent) element.style.setProperty('--map-accent', visual.accent);
    else element.style.removeProperty('--map-accent');

    applyTransform();
  };

  marker.on('add', () => {
    const element = marker.getElement();
    // Space activates a role="button"; Leaflet only wires up Enter.
    if (element && !keyboardBound) {
      keyboardBound = true;
      L.DomEvent.on(element, 'keydown', (event) => {
        const key = (event as KeyboardEvent).key;
        if (key !== ' ' && key !== 'Spacebar') return;
        L.DomEvent.stop(event);
        options.onSelect();
      });
    }
    applyElement();
  });

  return {
    marker,
    setVisual(next: AircraftVisual): void {
      const changed =
        next.label !== visual.label ||
        next.kind !== visual.kind ||
        next.accent !== visual.accent ||
        next.onGround !== visual.onGround ||
        next.selected !== visual.selected ||
        next.coasting !== visual.coasting;
      if (!changed) return;
      const selectionChanged = next.selected !== visual.selected;
      visual = next;
      marker.options.title = next.label;
      const element = marker.getElement();
      if (element) element.title = next.label;
      if (selectionChanged) marker.setZIndexOffset(next.selected ? 1000 : 0);
      applyElement();
    },
    setPose(lat: number, lon: number, headingDeg: number): void {
      const current = marker.getLatLng();
      if (Math.abs(current.lat - lat) > 1e-7 || Math.abs(current.lng - lon) > 1e-7) {
        marker.setLatLng([lat, lon]);
      }
      if (Math.abs(headingDeg - heading) > 0.1) {
        heading = headingDeg;
        applyTransform();
      }
    },
  };
}

/* ---- Motion between snapshots --------------------------------------------------- */

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_NM = 1.852;

/**
 * Where an aircraft will be `seconds` from its last fix if it holds track and speed.
 * Used only to smooth the gap between 5-second snapshots — the caller caps how far it will
 * extrapolate, because a guess that runs for minutes stops being a guess and becomes a lie.
 */
export function deadReckon(
  lat: number,
  lon: number,
  trackDeg: number | null,
  groundSpeedKt: number | null,
  seconds: number,
): { lat: number; lon: number } {
  if (trackDeg === null || groundSpeedKt === null || groundSpeedKt <= 0 || seconds <= 0) {
    return { lat, lon };
  }
  const km = (groundSpeedKt * KM_PER_NM * seconds) / 3600;
  const angular = km / EARTH_RADIUS_KM;
  const bearing = (trackDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: (lat2 * 180) / Math.PI, lon: (((lon2 * 180) / Math.PI + 540) % 360) - 180 };
}

/** Interpolate between two headings the short way round. */
export function lerpAngle(from: number, to: number, t: number): number {
  const delta = (((to - from) % 360) + 540) % 360;
  return (from + (delta - 180) * t + 360) % 360;
}

/* ---- Trail ---------------------------------------------------------------------- */

/** Newest segments are brightest; the oldest fade out entirely. */
const TRAIL_MIN_OPACITY = 0.08;
const TRAIL_MAX_OPACITY = 0.75;

export interface TrailOverlay {
  layer: L.LayerGroup;
  update(points: readonly TrailPoint[], kind: MarkerKind): void;
  clear(): void;
}

/** The selected aircraft's recent track, drawn as a polyline that fades into the past. */
export function createTrailLayer(): TrailOverlay {
  const layer = L.layerGroup();

  const clear = (): void => {
    layer.clearLayers();
  };

  const update = (points: readonly TrailPoint[], kind: MarkerKind): void => {
    clear();
    if (points.length < 2) return;

    const tone = kind === 'departure' ? 'departure' : 'arrival';
    const segments = points.length - 1;

    for (let index = 0; index < segments; index += 1) {
      const from = points[index];
      const to = points[index + 1];
      if (!from || !to) continue;
      const progress = segments === 1 ? 1 : index / (segments - 1);
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        {
          className: `map-trail map-trail--${tone}`,
          weight: 2.5,
          opacity: TRAIL_MIN_OPACITY + (TRAIL_MAX_OPACITY - TRAIL_MIN_OPACITY) * progress,
          lineCap: 'round',
          interactive: false,
        },
      ).addTo(layer);
    }
  };

  return { layer, update, clear };
}
