/**
 * Display formatting. Every function is total: a null in gives an honest string out,
 * never a guess and never "NaN".
 */

import type { FlightPhase, MovementKind, RouteInfo } from '../../../shared/types.ts';
import type { Tone } from '../components/ui/Chip.tsx';

/** What we print when a value genuinely is not known. */
const DASH = '—';

const LONDON = 'Europe/London';

const clockFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: LONDON,
});

const integerFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const oneDecimalFormatter = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const KM_PER_NM = 1.852;
const M_PER_FT = 0.3048;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** ETAs beyond this are not credible for an A380 sector into Heathrow — show a dash instead. */
const MAX_SENSIBLE_MINUTES = 16 * 60;

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * "14 min" under an hour, "1 h 12" above it, "now" at zero.
 * Null, negative and absurd values all collapse to an em dash.
 */
export function formatCountdown(minutes: number | null): string {
  if (!isFiniteNumber(minutes)) return DASH;
  const total = Math.round(minutes);
  if (total < 0 || total > MAX_SENSIBLE_MINUTES) return DASH;
  if (total === 0) return 'now';
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `${hours} h ${String(rest).padStart(2, '0')}`;
}

/** Wall-clock time at Heathrow, 24-hour. */
export function formatClock(ts: number | null): string {
  if (!isFiniteNumber(ts)) return DASH;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return DASH;
  return clockFormatter.format(date);
}

/** "just now", "40 s ago", "2 min ago", "3 h ago", "2 d ago". Handles future stamps too. */
export function formatRelative(ts: number | null, now: number): string {
  if (!isFiniteNumber(ts)) return DASH;
  const delta = now - ts;
  const ago = delta >= 0;
  const abs = Math.abs(delta);

  if (abs < 10_000) return 'just now';
  if (abs < MINUTE) {
    const s = Math.round(abs / 1000);
    return ago ? `${s} s ago` : `in ${s} s`;
  }
  if (abs < HOUR) {
    const m = Math.round(abs / MINUTE);
    return ago ? `${m} min ago` : `in ${m} min`;
  }
  if (abs < DAY) {
    const h = Math.round(abs / HOUR);
    return ago ? `${h} h ago` : `in ${h} h`;
  }
  const d = Math.round(abs / DAY);
  return ago ? `${d} d ago` : `in ${d} d`;
}

/** Feet or metres. On the ground we say so rather than printing a meaningless zero. */
export function formatAltitude(
  ft: number | null,
  onGround: boolean,
  units: 'metric' | 'imperial',
): string {
  if (onGround) return 'On ground';
  if (!isFiniteNumber(ft)) return DASH;
  if (units === 'metric') {
    const metres = Math.round((ft * M_PER_FT) / 10) * 10;
    return `${integerFormatter.format(metres)} m`;
  }
  return `${integerFormatter.format(Math.round(ft / 25) * 25)} ft`;
}

/** Knots for imperial (the aviation native), km/h for metric. */
export function formatSpeed(kt: number | null, units: 'metric' | 'imperial'): string {
  if (!isFiniteNumber(kt) || kt < 0) return DASH;
  if (units === 'metric') return `${integerFormatter.format(Math.round(kt * KM_PER_NM))} km/h`;
  return `${integerFormatter.format(Math.round(kt))} kt`;
}

/** Nautical miles for imperial, kilometres for metric. Sub-10 gets one decimal. */
export function formatDistance(nm: number | null, units: 'metric' | 'imperial'): string {
  if (!isFiniteNumber(nm) || nm < 0) return DASH;
  const value = units === 'metric' ? nm * KM_PER_NM : nm;
  const suffix = units === 'metric' ? 'km' : 'nm';
  if (value < 10) return `${oneDecimalFormatter.format(value)} ${suffix}`;
  return `${integerFormatter.format(Math.round(value))} ${suffix}`;
}

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

/** 16-point compass label for a true bearing. */
export function compassPoint(deg: number | null): string {
  if (!isFiniteNumber(deg)) return DASH;
  const normalised = ((deg % 360) + 360) % 360;
  const index = Math.round(normalised / 22.5) % 16;
  return COMPASS[index] ?? DASH;
}

/**
 * The three taxi phases have to read as three different amounts of knowledge.
 *
 * "Taxiing in" and "Taxiing out" are claims about where an aeroplane is going, and the tracker only
 * makes them when it has watched something that says so. `taxi_unknown` is the case where it has
 * not — which, on a cold start, is most of them.
 *
 * Its label is the bare verb, and that is the deliberate answer rather than a shortened one. It
 * states the whole of what is known (this whale is taxiing) and none of what is not, and it is read
 * beside its two siblings: a grey "Taxiing" sitting between a blue "Taxiing in" and an amber
 * "Taxiing out" says *we have not established which* far more plainly than any parenthesis would,
 * and it still fits in a chip on a phone in the sun. What it must never do is borrow one of their
 * tones — a departure-coloured chip on a whale that has just landed is the same lie told in paint.
 */
const PHASE_LABELS: Record<FlightPhase, string> = {
  inbound: 'Inbound',
  approach: 'On approach',
  landed: 'Landed',
  taxi_in: 'Taxiing in',
  stand: 'At stand',
  taxi_out: 'Taxiing out',
  taxi_unknown: 'Taxiing',
  departing: 'Departing',
  climb_out: 'Climbing out',
  outbound: 'Outbound',
  elsewhere: 'En route',
};

export function phaseLabel(phase: FlightPhase): string {
  return PHASE_LABELS[phase] ?? 'Unknown';
}

const PHASE_TONES: Record<FlightPhase, Tone> = {
  inbound: 'arrival',
  approach: 'live',
  landed: 'arrival',
  taxi_in: 'arrival',
  stand: 'neutral',
  taxi_out: 'departure',
  taxi_unknown: 'neutral',
  departing: 'departure',
  climb_out: 'departure',
  outbound: 'departure',
  elsewhere: 'neutral',
};

export function phaseTone(phase: FlightPhase): Tone {
  return PHASE_TONES[phase] ?? 'neutral';
}

/** Best human name we hold for a place — city, else IATA, else ICAO, else nothing. */
function placeName(place: RouteInfo['origin']): string | null {
  if (!place) return null;
  const name = place.city ?? place.iata ?? place.icao;
  return name && name.trim().length > 0 ? name : null;
}

/**
 * "from Dubai" / "to Los Angeles". When the reference table has no match we say the origin
 * is unknown — we never name a city we have not actually matched.
 */
export function routeLabel(route: RouteInfo, kind: MovementKind): string {
  const origin = placeName(route.origin);
  const destination = placeName(route.destination);

  if (kind === 'departure') {
    return destination ? `to ${destination}` : 'Destination unknown';
  }
  if (kind === 'arrival') {
    return origin ? `from ${origin}` : 'Origin unknown';
  }
  // On the ground at Heathrow: the far end is the interesting one, and Heathrow itself is not it.
  // "to London" about an aeroplane parked at London is noise dressed as information.
  if (destination && !isHeathrow(route.destination)) return `to ${destination}`;
  if (origin && !isHeathrow(route.origin)) return `from ${origin}`;
  return 'Route unknown';
}

function isHeathrow(place: RouteInfo['origin']): boolean {
  if (!place) return false;
  return place.icao?.toUpperCase() === 'EGLL' || place.iata?.toUpperCase() === 'LHR';
}
