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

/**
 * Bounds covering both runways with a little apron around them.
 *
 * This is the seed every automatic frame starts from, which is why the padding is modest: the
 * frame gets its breathing room in pixels (see `framePadding`), and padding it twice put the
 * airport in the middle of forty kilometres of Berkshire on a phone.
 */
export function airportBounds(): L.LatLngBounds {
  const points: L.LatLngTuple[] = [];
  for (const runway of RUNWAYS) {
    for (const end of runway.ends) points.push([end.lat, end.lon]);
  }
  return L.latLngBounds(points).pad(0.35);
}

/* ---- Framing -------------------------------------------------------------------- */

/**
 * The zoom band automatic framing is allowed to use.
 *
 * The ceiling stops the map diving to street level when every whale is on stand and the bounds
 * collapse to a few hundred metres of taxiway; the floor stops it retreating to an orbital view
 * because one aeroplane the curated rotations claim for Heathrow is still over the Gulf. Outside
 * the band the honest answer is "that one is off this view", which the caller says out loud,
 * rather than a frame in which nothing can be read.
 */
const FRAME_MIN_ZOOM = 5;
const FRAME_MAX_ZOOM = AIRPORT_ZOOM;

/** Pixels along each edge that floating chrome is sitting on. Measured by the caller. */
export interface FrameChrome {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** No chrome at all — the default when a caller does not care. */
const NO_CHROME: FrameChrome = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Breathing room kept around a fitted frame, per side, in pixels.
 *
 * Asymmetric, because the chrome is: the control rail on the right, the tile attribution along
 * the bottom, the status stack top-left, the legend bottom-left. A symmetric fit is what puts the
 * inbound whale under the zoom buttons — visible only in the sense that its wingtip pokes out.
 * The base is proportional to the viewport so a phone in landscape is not left with a keyhole,
 * and capped so a desktop map is not mostly margin.
 */
function framePadding(map: L.Map, chrome: FrameChrome): FrameChrome {
  const size = map.getSize();
  const x = Math.round(Math.min(48, Math.max(16, size.x * 0.06)));
  const y = Math.round(Math.min(48, Math.max(16, size.y * 0.08)));

  // However much chrome is floating over the map, the aeroplanes get the majority of it.
  const scaleX = Math.min(1, (size.x * 0.45) / Math.max(1, x * 2 + chrome.left + chrome.right));
  const scaleY = Math.min(1, (size.y * 0.45) / Math.max(1, y * 2 + chrome.top + chrome.bottom));

  return {
    top: Math.round((y + chrome.top) * scaleY),
    right: Math.round((x + chrome.right) * scaleX),
    bottom: Math.round((y + chrome.bottom) * scaleY),
    left: Math.round((x + chrome.left) * scaleX),
  };
}

/** The airport, plus whatever aircraft the caller wants held in view. */
function frameBounds(points: readonly L.LatLngTuple[]): L.LatLngBounds {
  const bounds = airportBounds();
  for (const point of points) bounds.extend(point);
  return bounds;
}

/**
 * Move the map to hold `points` and Heathrow, within the zoom band and clear of the chrome.
 *
 * `fitBounds` cannot express a minimum zoom, so the zoom is computed and clamped here and applied
 * with `setView`. That means doing what `fitBounds` does internally: `getBoundsZoom` takes the
 * *total* padding rather than the per-side figure, and uneven padding is applied by shifting the
 * centre by half the difference.
 */
export function applyFrame(
  map: L.Map,
  points: readonly L.LatLngTuple[],
  options: { animate: boolean; chrome?: FrameChrome },
): void {
  const bounds = frameBounds(points);
  const pad = framePadding(map, options.chrome ?? NO_CHROME);
  const total = L.point(pad.left + pad.right, pad.top + pad.bottom);
  const zoom = Math.min(
    FRAME_MAX_ZOOM,
    Math.max(FRAME_MIN_ZOOM, map.getBoundsZoom(bounds, false, total)),
  );

  const southWest = map.project(bounds.getSouthWest(), zoom);
  const northEast = map.project(bounds.getNorthEast(), zoom);
  const offset = L.point(pad.right - pad.left, pad.bottom - pad.top).divideBy(2);
  const centre = map.unproject(southWest.add(northEast).divideBy(2).add(offset), zoom);

  map.setView(centre, zoom, { animate: options.animate });
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
      const description = runwayTooltip(runway, config);
      strip.bindTooltip(description, {
        direction: 'top',
        className: 'map-tooltip',
      });
      // The strip is a tab stop, so it has to say what it is. A Leaflet tooltip is hover-only and
      // is never exposed as the element's accessible name, which left two silent focus stops
      // between the map canvas and everything else on it.
      strip.on('add', () => {
        strip.getElement()?.setAttribute('aria-label', description);
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
              // Long dashes for the approach, short ones for the climb-out below: the two lines
              // must be tellable apart without relying on their colour.
              dashArray: '14 8',
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
              dashArray: '3 7',
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
  /**
   * The marker for one spot id, or null when it is not on the map. Used when another tab hands
   * the map a specific spot to show, so it can be centred and opened rather than left as one
   * anonymous pin among eleven.
   */
  markerFor(spotId: string): L.Marker | null;
  /**
   * Tell the popups how much of the map is covered by our own floating chrome.
   *
   * Leaflet keeps an opening popup inside the *container*, which is the wrong rectangle: on a
   * phone the status stack, the framing chip and the empty-state card occupy the top-left third
   * of that container, and a popup opened under them is simply invisible. Feeding the measured
   * insets in as auto-pan padding makes Leaflet pan the map until the card clears them.
   *
   * `mapHeight` caps the card itself. A spot popup is 368 px of briefing and the map on a 390 px
   * phone is 440 px tall, so at full height it hung out of the top of the canvas and under the
   * app header however well it was panned. Capped, Leaflet scrolls the overflow inside the card.
   *
   * Returns the cap that was applied, which is how tall the card may now be — the caller needs it
   * to place the pin itself when it is opening one deliberately.
   */
  setChrome(chrome: FrameChrome, mapHeight: number): number;
}

/** The tallest a spot card is ever allowed to be, and the least it is worth shrinking to. */
const SPOT_POPUP_MAX_HEIGHT = 380;
const SPOT_POPUP_MIN_HEIGHT = 170;
/** The pin, the card's tip and its shadow, which sit below the scrollable body. */
const SPOT_POPUP_TAIL = 56;

/**
 * A pin per spotting location, rated for right now. Hover shows the name, tap opens a card with
 * the honest reason it scored that way and a jump into the Spots tab.
 */
export function createSpotOverlay(options: { onOpenSpot: (spot: SpotLocation) => void }): SpotOverlay {
  const layer = L.layerGroup();
  const markers = new Map<string, L.Marker>();
  /** Latest measured chrome, applied to every popup as it is bound and whenever it changes. */
  let chrome: FrameChrome = NO_CHROME;
  let popupMaxHeight = SPOT_POPUP_MAX_HEIGHT;

  /** Leaflet reads these when the popup opens, so they must be set before `openPopup()`. */
  const applyChrome = (marker: L.Marker): void => {
    const popup = marker.getPopup();
    if (!popup) return;
    const gap = 16;
    popup.options.autoPanPaddingTopLeft = L.point(chrome.left + gap, chrome.top + gap);
    popup.options.autoPanPaddingBottomRight = L.point(chrome.right + gap, chrome.bottom + gap);
    popup.options.maxHeight = popupMaxHeight;
  };

  const setChrome = (next: FrameChrome, mapHeight: number): number => {
    chrome = next;
    const room = mapHeight - next.top - next.bottom - SPOT_POPUP_TAIL;
    popupMaxHeight = Math.round(
      Math.min(SPOT_POPUP_MAX_HEIGHT, Math.max(SPOT_POPUP_MIN_HEIGHT, room)),
    );
    for (const marker of markers.values()) applyChrome(marker);
    return popupMaxHeight;
  };

  const update = (spots: readonly SpotEvaluation[]): void => {
    layer.clearLayers();
    markers.clear();

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
      applyChrome(marker);
      if (typeof evaluation.spot.id === 'string') markers.set(evaluation.spot.id, marker);
    }
  };

  return { layer, update, markerFor: (spotId) => markers.get(spotId) ?? null, setChrome };
}
