/**
 * Static map furniture: the Heathrow runways, their extended centrelines, and the spotting pins.
 *
 * Every coordinate in here is a fact from SPEC.md §5 (the four published thresholds) or is
 * derived from one by great-circle maths. Nothing is drawn that we cannot point at a source for:
 * a runway is highlighted only when `snapshot.runwayConfig` actually names it.
 *
 * Colours live in MapTab.css and are applied through `className` on every Leaflet path, so the
 * overlay follows the design tokens and the light/dark theme without a single literal here.
 */

import * as L from 'leaflet';
import type { RunwayConfig, SpotEvaluation, SpotLocation } from '../../../../shared/types.ts';

export interface LatLon {
  lat: number;
  lon: number;
}

/** EGLL aerodrome reference point. */
export const AIRPORT: LatLon = { lat: 51.4706, lon: -0.4619 };

/** The view the "recentre" control returns to: both runways plus a little breathing room. */
export const AIRPORT_ZOOM = 12;

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_NM = 1.852;

/** Drawn a shade wider than the real 50 m so the strip stays visible at airport zoom. */
const RUNWAY_HALF_WIDTH_KM = 0.035;

/** How far the approach and departure centrelines are drawn. */
export const CENTRELINE_NM = 10;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

function normaliseBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Point at `km` along `bearingDeg` from `from`, on the sphere. */
export function destination(from: LatLon, bearingDeg: number, km: number): LatLon {
  const angular = km / EARTH_RADIUS_KM;
  const bearing = toRadians(bearingDeg);
  const lat1 = toRadians(from.lat);
  const lon1 = toRadians(from.lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDegrees(lat2), lon: normaliseLongitude(toDegrees(lon2)) };
}

function normaliseLongitude(lon: number): number {
  return ((lon + 540) % 360) - 180;
}

/** Initial great-circle bearing from `a` to `b`, degrees true. */
export function bearingBetween(a: LatLon, b: LatLon): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLon = toRadians(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normaliseBearing(toDegrees(Math.atan2(y, x)));
}

export interface RunwayEndGeometry {
  /** e.g. "27R". */
  designator: string;
  /** True bearing of the centreline in this direction of use. */
  bearing: number;
  /** Published threshold. */
  lat: number;
  lon: number;
}

export interface RunwayGeometry {
  /** e.g. "09L/27R". */
  id: string;
  /** The two ends of the same strip of concrete. */
  ends: readonly [RunwayEndGeometry, RunwayEndGeometry];
}

/** The two Heathrow runways. Thresholds and bearings are the published values in SPEC.md §5. */
export const RUNWAYS: readonly RunwayGeometry[] = [
  {
    id: '09L/27R',
    ends: [
      { designator: '09L', bearing: 89.7, lat: 51.4775, lon: -0.4845 },
      { designator: '27R', bearing: 269.7, lat: 51.4779, lon: -0.4334 },
    ],
  },
  {
    id: '09R/27L',
    ends: [
      { designator: '09R', bearing: 89.7, lat: 51.4647, lon: -0.4825 },
      { designator: '27L', bearing: 269.7, lat: 51.465, lon: -0.4341 },
    ],
  },
];

function endsOf(runway: RunwayGeometry): { a: RunwayEndGeometry; b: RunwayEndGeometry } {
  return { a: runway.ends[0], b: runway.ends[1] };
}

/** The four corners of the paved strip, in order, for a filled polygon. */
function runwayCorners(runway: RunwayGeometry): L.LatLngTuple[] {
  const { a, b } = endsOf(runway);
  const axis = bearingBetween(a, b);
  const left = axis - 90;
  const right = axis + 90;
  const corners = [
    destination(a, left, RUNWAY_HALF_WIDTH_KM),
    destination(b, left, RUNWAY_HALF_WIDTH_KM),
    destination(b, right, RUNWAY_HALF_WIDTH_KM),
    destination(a, right, RUNWAY_HALF_WIDTH_KM),
  ];
  return corners.map((point) => [point.lat, point.lon] as L.LatLngTuple);
}

/** Bounds covering both runways — used by the "recentre on Heathrow" control. */
export function airportBounds(): L.LatLngBounds {
  const points: L.LatLngTuple[] = [];
  for (const runway of RUNWAYS) {
    for (const end of runway.ends) points.push([end.lat, end.lon]);
  }
  return L.latLngBounds(points).pad(1.6);
}

type RunwayRole = 'landing' | 'departing' | 'idle';

function roleOf(runway: RunwayGeometry, config: RunwayConfig | null): RunwayRole {
  if (!config) return 'idle';
  for (const end of runway.ends) {
    if (config.landing.includes(end.designator)) return 'landing';
  }
  for (const end of runway.ends) {
    if (config.departing.includes(end.designator)) return 'departing';
  }
  return 'idle';
}

function runwayTooltip(runway: RunwayGeometry, config: RunwayConfig | null): string {
  const landing = runway.ends.filter((end) => config?.landing.includes(end.designator));
  const departing = runway.ends.filter((end) => config?.departing.includes(end.designator));
  const parts: string[] = [];
  if (landing.length > 0) parts.push(`landing ${landing.map((end) => end.designator).join(', ')}`);
  if (departing.length > 0) {
    parts.push(`departing ${departing.map((end) => end.designator).join(', ')}`);
  }
  if (parts.length === 0) return `Runway ${runway.id} — not in use for A380 traffic right now`;
  return `Runway ${runway.id} — ${parts.join(' · ')}`;
}

export interface RunwayOverlay {
  layer: L.LayerGroup;
  /** Rebuilds the geometry for a new configuration. Safe to call with null (nothing highlighted). */
  update(config: RunwayConfig | null): void;
}

/**
 * Both runways, always drawn; the ones in use are highlighted and get a dashed centreline
 * extended 10 nm — towards the approach for a landing runway, along the climb-out for a
 * departure runway.
 */
export function createRunwayOverlay(): RunwayOverlay {
  const layer = L.layerGroup();

  const update = (config: RunwayConfig | null): void => {
    layer.clearLayers();

    for (const runway of RUNWAYS) {
      const role = roleOf(runway, config);
      const strip = L.polygon(runwayCorners(runway), {
        className: `map-runway map-runway--${role}`,
        weight: 1,
        interactive: true,
        bubblingMouseEvents: false,
      });
      strip.bindTooltip(runwayTooltip(runway, config), {
        direction: 'top',
        className: 'map-tooltip',
      });
      strip.addTo(layer);

      const { a, b } = endsOf(runway);
      for (const end of runway.ends) {
        const other = end === a ? b : a;

        if (config?.landing.includes(end.designator)) {
          // Aircraft fly the final approach in from behind the threshold.
          const outward = normaliseBearing(end.bearing + 180);
          const far = destination(end, outward, CENTRELINE_NM * KM_PER_NM);
          L.polyline(
            [
              [end.lat, end.lon],
              [far.lat, far.lon],
            ],
            {
              className: 'map-centreline map-centreline--landing',
              weight: 2,
              dashArray: '9 11',
              interactive: false,
            },
          ).addTo(layer);
        }

        if (config?.departing.includes(end.designator)) {
          // The roll starts at this threshold and the climb-out continues past the far end.
          const far = destination(other, end.bearing, CENTRELINE_NM * KM_PER_NM);
          L.polyline(
            [
              [other.lat, other.lon],
              [far.lat, far.lon],
            ],
            {
              className: 'map-centreline map-centreline--departing',
              weight: 2,
              dashArray: '9 11',
              interactive: false,
            },
          ).addTo(layer);
        }
      }
    }
  };

  update(null);
  return { layer, update };
}

/* ---- Spotting locations -------------------------------------------------------- */

const RATING_LABEL: Record<SpotEvaluation['rating'], string> = {
  excellent: 'Excellent right now',
  good: 'Good right now',
  fair: 'Fair right now',
  poor: 'Poor right now',
};

const LIGHT_LABEL: Record<SpotEvaluation['light'], string> = {
  ideal: 'Sun behind you',
  workable: 'Light is workable',
  backlit: 'Backlit — sun in frame',
  dark: 'Dark — night shooting',
};

function spotIcon(evaluation: SpotEvaluation): L.DivIcon {
  return L.divIcon({
    className: `map-pin map-pin--${evaluation.rating}`,
    html: '<span class="map-pin-dot"></span><span class="map-pin-ring"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -12],
  });
}

function spotCard(evaluation: SpotEvaluation, onOpen: () => void): HTMLElement {
  const root = L.DomUtil.create('div', 'map-spot-card');

  const name = L.DomUtil.create('p', 'map-spot-name', root);
  name.textContent = evaluation.spot.name;

  const rating = L.DomUtil.create('p', `map-spot-rating map-spot-rating--${evaluation.rating}`, root);
  rating.textContent = `${RATING_LABEL[evaluation.rating]} · ${LIGHT_LABEL[evaluation.light]}`;

  const tagline = L.DomUtil.create('p', 'map-spot-tagline', root);
  tagline.textContent = evaluation.spot.tagline;

  const reason = evaluation.reasons[0];
  if (reason) {
    const why = L.DomUtil.create('p', 'map-spot-reason', root);
    why.textContent = reason;
  }

  const button = L.DomUtil.create('button', 'map-spot-open', root);
  button.type = 'button';
  button.textContent = 'Open in Spots';
  L.DomEvent.on(button, 'click', (event) => {
    L.DomEvent.stop(event);
    onOpen();
  });

  return root;
}

export interface SpotOverlay {
  layer: L.LayerGroup;
  update(spots: readonly SpotEvaluation[]): void;
}

/**
 * A pin per spotting location, rated for right now. Hover shows the name, tap opens a card with
 * the honest reason it scored that way and a jump into the Spots tab.
 */
export function createSpotOverlay(options: { onOpenSpot: (spot: SpotLocation) => void }): SpotOverlay {
  const layer = L.layerGroup();

  const update = (spots: readonly SpotEvaluation[]): void => {
    layer.clearLayers();

    for (const evaluation of spots) {
      const marker = L.marker([evaluation.spot.lat, evaluation.spot.lon], {
        icon: spotIcon(evaluation),
        keyboard: true,
        riseOnHover: true,
        title: `${evaluation.spot.name} — ${RATING_LABEL[evaluation.rating].toLowerCase()}`,
      });

      marker.bindTooltip(evaluation.spot.name, {
        direction: 'top',
        offset: [0, -10],
        className: 'map-tooltip',
      });
      marker.bindPopup(() => spotCard(evaluation, () => options.onOpenSpot(evaluation.spot)), {
        className: 'map-popup',
        closeButton: true,
        autoPanPadding: [24, 24],
      });

      marker.on('add', () => {
        const element = marker.getElement();
        if (!element) return;
        element.setAttribute(
          'aria-label',
          `Spotting location: ${evaluation.spot.name}. ${RATING_LABEL[evaluation.rating]}.`,
        );
      });

      marker.addTo(layer);
    }
  };

  return { layer, update };
}
