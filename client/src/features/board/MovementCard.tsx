/**
 * One A380 on the board — an arrival, a departure, or a frame parked at Heathrow.
 *
 * The card is the unit of trust in this product: every value on it is either observed or
 * explicitly labelled as a prediction, and anything we do not know says so out loud.
 * A few small helpers are exported because the hero and the detail sheet must describe the
 * same aircraft in exactly the same words.
 */

import type { ReactElement } from 'react';
import type {
  Movement,
  MovementKind,
  Place,
  Provenance,
  RunwayPrediction,
} from '../../../../shared/types.ts';
import { useSnapshot } from '../../api/useSnapshot.ts';
import { useSelection } from '../../state/selection.tsx';
import { useSettings } from '../../state/settings.tsx';
import { Card } from '../../components/ui/Card.tsx';
import { Chip } from '../../components/ui/Chip.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import {
  compassPoint,
  formatAltitude,
  formatClock,
  formatCountdown,
  formatDistance,
  formatSpeed,
  phaseLabel,
  phaseTone,
  routeLabel,
} from '../../lib/format.ts';
import './MovementCard.css';

const DASH = '—';

/** A position fix older than this is worth flagging on the card. */
export const STALE_AFTER_SECONDS = 45;

/** Flight number if the callsign resolved to one, else the raw callsign, else the honest gap. */
export function flightTitle(movement: Movement): string {
  return movement.flightNumber ?? movement.callsign ?? 'No callsign';
}

/** Best human name we hold for a place. Never invents one. */
export function placeLabel(place: Place | null): string | null {
  if (!place) return null;
  const name = place.city ?? place.iata ?? place.icao;
  return name && name.trim().length > 0 ? name.trim() : null;
}

/**
 * How old the newest position fix is, in seconds.
 *
 * The server tells us the age at the moment the snapshot was built; we add the time that has
 * passed on this device since that snapshot landed. Using the client's own receipt time rather
 * than the server's clock keeps the number right even when the two clocks disagree.
 */
export function positionAgeSeconds(
  movement: Movement,
  snapshotReceivedAt: number | null,
  now: number,
): number {
  const reported = Number.isFinite(movement.telemetry.ageSeconds)
    ? Math.max(0, movement.telemetry.ageSeconds)
    : 0;
  if (snapshotReceivedAt === null) return reported;
  const drift = Math.max(0, (now - snapshotReceivedAt) / 1000);
  return reported + drift;
}

/** "42 s" / "6 min" / "1 h 04" — deliberately coarse, so it does not flicker. */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return DASH;
  const total = Math.round(seconds);
  if (total < 90) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}

const SOURCE_WORDS: Record<Provenance, string> = {
  observed: 'from live traffic',
  schedule: 'from the rotation table',
  inferred: 'inferred from the track',
  unknown: 'no basis yet',
};

function confidenceWord(confidence: number): string {
  if (!Number.isFinite(confidence)) return 'confidence unknown';
  if (confidence >= 0.75) return 'high confidence';
  if (confidence >= 0.45) return 'moderate confidence';
  return 'low confidence';
}

/** A runway prediction, described as a prediction — never as fact. */
export function runwayHint(runway: RunwayPrediction): {
  label: string;
  /** One short line for a stat caption. */
  short: string;
  /** The full sentence, for a tooltip or a wider row. */
  detail: string;
} {
  if (!runway.runway) {
    return {
      label: 'TBC',
      short: 'not predictable yet',
      detail: 'Runway not predictable yet — not enough of the approach flown',
    };
  }
  const source = SOURCE_WORDS[runway.source] ?? SOURCE_WORDS.unknown;
  const confidence = confidenceWord(runway.confidence);
  return {
    label: runway.runway,
    short: `predicted · ${confidence}`,
    detail: `Predicted runway ${runway.runway} — ${source}, ${confidence}`,
  };
}

/** Named ends of a route, or null when we have not matched the far end to a real place. */
export function routeEnds(
  route: { origin: Place | null; destination: Place | null },
  kind: MovementKind,
): { from: string; to: string } | null {
  const origin = placeLabel(route.origin);
  const destination = placeLabel(route.destination);
  if (kind === 'arrival') return origin ? { from: origin, to: 'LHR' } : null;
  if (kind === 'departure') return destination ? { from: 'LHR', to: destination } : null;
  // Parked: name whichever leg we actually hold.
  if (origin) return { from: origin, to: 'LHR' };
  if (destination) return { from: 'LHR', to: destination };
  return null;
}

const rateFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/** "descending 1,100 fpm" / "climbing 900 fpm" / "level", or null when the rate is unknown. */
export function formatVerticalRate(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  const rounded = Math.round(Math.abs(rate) / 50) * 50;
  if (rate <= -250) return `descending ${rateFormatter.format(rounded)} fpm`;
  if (rate >= 250) return `climbing ${rateFormatter.format(rounded)} fpm`;
  return 'level';
}

export function MovementCard(p: { movement: Movement; now: number }): ReactElement {
  const { movement, now } = p;
  const { settings } = useSettings();
  const { selectedHex, select } = useSelection();
  const { lastUpdate } = useSnapshot();

  const { telemetry, route, kind } = movement;
  const age = positionAgeSeconds(movement, lastUpdate, now);
  const stale = movement.coasting || age >= STALE_AFTER_SECONDS;
  const runway = runwayHint(movement.runway);
  const ends = routeEnds(route, kind);
  const registration = movement.airframe.registration;
  const note = movement.airframe.note;

  // The countdown is the arrival's headline; a departure only gets one once the server has an
  // off-block estimate. Everything else leads with its phase.
  const countdown = kind === 'ground' ? null : movement.eta.minutes;
  const showCountdown = countdown !== null;
  const etaClock = movement.eta.at !== null ? formatClock(movement.eta.at) : null;
  const etaWord = kind === 'departure' ? 'off' : 'land';

  const classes = ['mv', `mv--${kind}`];
  if (selectedHex === movement.id) classes.push('mv--selected');

  const vertical = telemetry.onGround ? null : formatVerticalRate(telemetry.verticalRate);

  return (
    <Card
      as="li"
      accent={movement.airline.color}
      onClick={() => select(movement.id)}
      className={classes.join(' ')}
    >
      <div className="mv-head">
        <div className="mv-ident">
          <span className="mv-flightline">
            <span className="mv-flight app-numeric">{flightTitle(movement)}</span>
            {movement.callsign && movement.callsign !== movement.flightNumber ? (
              <span className="mv-callsign app-numeric" title="Transmitted callsign">
                {movement.callsign}
              </span>
            ) : null}
          </span>
          <span className="mv-airline">{movement.airline.name}</span>
        </div>

        <div className="mv-status">
          {showCountdown ? (
            <>
              <span
                className="mv-countdown app-numeric"
                title={
                  movement.eta.source === 'observed'
                    ? 'Estimated from the live position'
                    : 'Estimated — recomputed every update'
                }
              >
                {formatCountdown(countdown)}
              </span>
              <span className="mv-eta app-numeric">
                {etaClock ? `${etaWord} ~${etaClock}` : 'time unavailable'}
              </span>
            </>
          ) : null}
          <Chip tone={phaseTone(movement.phase)} size="sm">
            {phaseLabel(movement.phase)}
          </Chip>
        </div>
      </div>

      <p className={ends ? 'mv-route' : 'mv-route mv-route--unknown'}>
        <Icon
          name={kind === 'departure' ? 'departure' : 'arrival'}
          size={16}
          className="mv-route-icon"
        />
        {ends ? (
          <span className="mv-route-text">
            <span className="mv-place">{ends.from}</span>
            <span className="mv-arrow" aria-hidden="true">
              →
            </span>
            <span className="mv-place">{ends.to}</span>
          </span>
        ) : (
          <span className="mv-route-text">{routeLabel(route, kind)}</span>
        )}
        {route.source === 'inferred' ? (
          <Chip size="sm" title="Direction inferred from the track, not from a schedule">
            inferred
          </Chip>
        ) : null}
      </p>

      <p className="mv-frame">
        {registration ? (
          <span className="mv-reg app-numeric">{registration}</span>
        ) : (
          <span className="mv-reg mv-reg--unknown">Registration unknown</span>
        )}
        {note ? (
          <Chip size="sm" tone="neutral" title={note}>
            {note}
          </Chip>
        ) : null}
      </p>

      <dl className="mv-telem">
        <div className="mv-telem-item">
          <dt>Altitude</dt>
          <dd className="app-numeric">
            {formatAltitude(telemetry.altitude, telemetry.onGround, settings.units)}
          </dd>
        </div>
        <div className="mv-telem-item">
          <dt>Speed</dt>
          <dd className="app-numeric">{formatSpeed(telemetry.groundSpeed, settings.units)}</dd>
        </div>
        <div className="mv-telem-item">
          <dt>Distance</dt>
          <dd className="app-numeric">
            {movement.distanceNm === null
              ? DASH
              : `${formatDistance(movement.distanceNm, settings.units)} ${compassPoint(
                  movement.bearingFromAirport,
                )}`}
          </dd>
        </div>
        <div className="mv-telem-item">
          <dt>Est. runway</dt>
          <dd className="app-numeric" title={runway.detail}>
            {runway.label}
          </dd>
        </div>
      </dl>

      {stale || vertical !== null ? (
        <p className="mv-foot">
          {stale ? (
            <Chip
              size="sm"
              tone="warn"
              title="No fresh ADS-B position — the last known state is being held"
            >
              {movement.coasting ? 'Coasting' : 'Stale'} · {formatAge(age)} old
            </Chip>
          ) : null}
          {vertical !== null ? <span className="mv-vertical app-numeric">{vertical}</span> : null}
        </p>
      ) : null}
    </Card>
  );
}
