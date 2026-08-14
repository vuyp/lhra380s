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

/** Nose-up planform in a 64-unit box: nose at y=3, tail at y=60, span 4.3 → 59.7. */
const PLANFORM = [
  // Fuselage — long, wide, tapered at both ends.
  '<path class="map-plane-body" d="M32 3c2.3 0 3.4 4.8 3.4 9.6V46c0 6-.8 10.6-2 14.4h-2.8c-1.2-3.8-2-8.4-2-14.4V12.6C28.6 7.8 29.7 3 32 3Z"/>',
  // Wings — swept, tips raked back.
  '<path class="map-plane-body" d="M35.4 21 58.6 41.4c.7.6 1.1 1.5 1.1 2.4v1.4c0 .9-.9 1.5-1.8 1.2L35.4 39.2Z"/>',
  '<path class="map-plane-body" d="M28.6 21 5.4 41.4c-.7.6-1.1 1.5-1.1 2.4v1.4c0 .9.9 1.5 1.8 1.2L28.6 39.2Z"/>',
  // Tailplane.
  '<path class="map-plane-body" d="M35.1 51.4l11.5 6.2c.5.3.8.8.8 1.3v.7c0 .6-.5 1-1.1.8l-11.2-3Z"/>',
  '<path class="map-plane-body" d="M28.9 51.4 17.4 57.6c-.5.3-.8.8-.8 1.3v.7c0 .6.5 1 1.1.8l11.2-3Z"/>',
  // Four engines, inboard pair ahead of the outboard pair.
  '<rect class="map-plane-body" x="40.8" y="25.6" width="3.4" height="6.6" rx="1.7"/>',
  '<rect class="map-plane-body" x="48.8" y="32.7" width="3.4" height="6.6" rx="1.7"/>',
  '<rect class="map-plane-body" x="19.8" y="25.6" width="3.4" height="6.6" rx="1.7"/>',
  '<rect class="map-plane-body" x="11.8" y="32.7" width="3.4" height="6.6" rx="1.7"/>',
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
