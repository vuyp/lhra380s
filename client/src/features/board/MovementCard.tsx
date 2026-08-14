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
  Airline,
  FlightPhase,
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
import type { IconName } from '../../components/ui/Icon.tsx';
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

/**
 * The operator's name, plus the one word that says when it was worked out rather than read.
 *
 * `callsign` and `fleet` are identifications the app made from something the aeroplane
 * transmitted; `registration_prefix` is an inference about every A380 sharing a country prefix,
 * and printing it in the same voice as the other two is exactly what the wire's provenance field
 * exists to prevent. The tag is the whole of it here — the detail sheet gives the reason in full,
 * in the same word, so the two never read as different claims.
 */
export function OperatorName(p: { airline: Airline; className: string }): ReactElement {
  return (
    <span className={p.className}>
      <span className={`${p.className}-name`}>{p.airline.name}</span>
      {p.airline.source === 'registration_prefix' ? (
        <span
          className="app-inferred-tag"
          title="Worked out from the registration prefix, not from anything this aircraft transmitted"
        >
          inferred
        </span>
      ) : null}
    </span>
  );
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
  observed: 'read off this aircraft',
  schedule: 'from the rotation table',
  // Covers both an approach not yet established and the active configuration standing in for one,
  // so it must not claim the track was what produced it.
  inferred: 'derived, not observed',
  unknown: 'no basis yet',
};

function confidenceWord(confidence: number): string {
  if (!Number.isFinite(confidence)) return 'confidence unknown';
  if (confidence >= 0.75) return 'high confidence';
  if (confidence >= 0.45) return 'moderate confidence';
  return 'low confidence';
}

/**
 * A runway prediction, described as a prediction — never as fact.
 *
 * `where` only changes what we say when there is no runway at all: "not enough of the approach
 * flown" is the reason in the air and nonsense on the tarmac, where the real answer is that
 * nothing was watched landing or lining up.
 */
export function runwayHint(
  runway: RunwayPrediction,
  where: 'air' | 'ground' = 'air',
): {
  label: string;
  /** One short line for a stat caption. */
  short: string;
  /** The full sentence, for a tooltip or a wider row. */
  detail: string;
} {
  if (!runway.runway) {
    if (where === 'ground') {
      return {
        label: DASH,
        short: 'none claimed',
        detail: 'No runway claimed — we did not watch this aircraft land or line up',
      };
    }
    return {
      label: 'TBC',
      short: 'not predictable yet',
      detail: 'Runway not predictable yet — not enough of the approach flown',
    };
  }
  const source = SOURCE_WORDS[runway.source] ?? SOURCE_WORDS.unknown;
  const confidence = confidenceWord(runway.confidence);
  // A runway read off the aircraft's own geometry is a fact; only the rest are predictions.
  if (runway.source === 'observed') {
    return {
      label: runway.runway,
      short: `observed · ${confidence}`,
      detail: `Runway ${runway.runway} — ${source}, ${confidence}`,
    };
  }
  return {
    label: runway.runway,
    short: `predicted · ${confidence}`,
    detail: `Predicted runway ${runway.runway} — ${source}, ${confidence}`,
  };
}

/** True for the Heathrow end of a route — never a valid *far* end of one. */
function isHeathrow(place: Place | null): boolean {
  if (!place) return false;
  return place.icao?.toUpperCase() === 'EGLL' || place.iata?.toUpperCase() === 'LHR';
}

/**
 * Named ends of a route, or null when we have not matched the far end to a real place.
 *
 * The Heathrow end is never the far end. A parked aircraft whose only known endpoint was
 * Heathrow itself used to render "London → LHR", which reads as a flight from London to London
 * and is not a route at all — it is the one place we already know it is.
 */
export function routeEnds(
  route: { origin: Place | null; destination: Place | null },
  kind: MovementKind,
): { from: string; to: string } | null {
  const origin = isHeathrow(route.origin) ? null : placeLabel(route.origin);
  const destination = isHeathrow(route.destination) ? null : placeLabel(route.destination);
  if (kind === 'arrival') return origin ? { from: origin, to: 'LHR' } : null;
  if (kind === 'departure') return destination ? { from: 'LHR', to: destination } : null;
  // Parked: name whichever leg we actually hold, if either is a real place elsewhere.
  if (destination) return { from: 'LHR', to: destination };
  if (origin) return { from: origin, to: 'LHR' };
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

interface TelemetryCell {
  term: string;
  value: string;
  title?: string;
}

/** The four cells an airborne movement is described by. */
function flightCells(
  movement: Movement,
  units: 'metric' | 'imperial',
  runway: { label: string; detail: string },
): TelemetryCell[] {
  const { telemetry } = movement;
  return [
    {
      term: 'Altitude',
      value: formatAltitude(telemetry.altitude, telemetry.onGround, units),
    },
    { term: 'Speed', value: formatSpeed(telemetry.groundSpeed, units) },
    {
      term: 'Distance',
      value:
        movement.distanceNm === null
          ? DASH
          : `${formatDistance(movement.distanceNm, units)} ${compassPoint(movement.bearingFromAirport)}`,
    },
    { term: 'Est. runway', value: runway.label, title: runway.detail },
  ];
}

/**
 * The runway cell for an aircraft on the tarmac, which is three different questions.
 *
 * A whale on its way out is asking which runway it will use; one that has landed is asking which
 * one it used; and a `taxi_unknown` is not asking either, because the direction of travel has not
 * been earned. Printing "Landing runway —" over that last case reads as a value we lost, and
 * printing a departure runway would be the guess this app refuses to make.
 */
function groundRunwayCell(
  movement: Movement,
  runway: { label: string; detail: string },
): TelemetryCell {
  if (movement.phase === 'taxi_out') {
    return { term: 'Departure runway', value: runway.label, title: runway.detail };
  }
  if (movement.runway.source === 'observed' && movement.runway.runway !== null) {
    return { term: 'Landing runway', value: runway.label, title: runway.detail };
  }
  if (movement.phase === 'taxi_unknown') {
    return {
      term: 'Runway',
      value: DASH,
      title: 'Neither runway is claimed until we have seen this aircraft land or line up',
    };
  }
  return {
    term: 'Landing runway',
    value: DASH,
    title: 'Not observed — the touchdown was not seen from a position we could read a runway from',
  };
}

/**
 * A whale parked at Heathrow, described by facts that are actually about a parked whale.
 *
 * The airborne set reused here read "On ground · 0 kt · 0.7 nm ENE · runway TBC" — four cells
 * saying nothing, including a runway estimate for an aeroplane that is not going anywhere. What a
 * spotter wants is when it landed, how long it has been down, and where on the field it is.
 */
function groundCells(
  movement: Movement,
  now: number,
  units: 'metric' | 'imperial',
  runway: { label: string; detail: string },
): TelemetryCell[] {
  const landedAt = movement.actualAt;
  const moving = (movement.telemetry.groundSpeed ?? 0) >= 3;

  const since: TelemetryCell =
    landedAt !== null
      ? {
          term: 'On the ground',
          value: formatAge(Math.max(0, (now - landedAt) / 1000)),
          title: 'Since the touchdown this app watched happen',
        }
      : {
          term: 'Tracked for',
          value: formatAge(Math.max(0, (now - movement.firstSeen) / 1000)),
          title: 'We did not see it land — this is how long it has been on the feed here',
        };

  const landed: TelemetryCell =
    landedAt !== null
      ? { term: 'Landed', value: formatClock(landedAt) }
      : { term: 'Landed', value: 'not observed', title: 'It was already on the ground when we picked it up' };

  const runwayCell = groundRunwayCell(movement, runway);

  const where: TelemetryCell = moving
    ? { term: 'Taxi speed', value: formatSpeed(movement.telemetry.groundSpeed, units) }
    : {
        term: 'Where',
        value:
          movement.distanceNm === null
            ? DASH
            : `${formatDistance(movement.distanceNm, units)} ${compassPoint(movement.bearingFromAirport)}`,
        title: 'Straight-line distance and direction from the aerodrome reference point',
      };

  return [since, landed, runwayCell, where];
}

/**
 * The arrow beside the route is a claim about which way this aeroplane is going, so it is drawn
 * from the phase rather than from the board it happens to be on. A whale taxiing with no
 * established direction gets the plain planform: neutral, and neither arrow.
 */
const GROUND_ROUTE_ICON: Record<string, IconName> = {
  landed: 'arrival',
  taxi_in: 'arrival',
  taxi_out: 'departure',
};

function routeIcon(kind: MovementKind, phase: FlightPhase): IconName {
  if (kind === 'departure') return 'departure';
  if (kind === 'arrival') return 'arrival';
  return GROUND_ROUTE_ICON[phase] ?? 'plane';
}

export function MovementCard(p: { movement: Movement; now: number }): ReactElement {
  const { movement, now } = p;
  const { settings } = useSettings();
  const { selectedHex, select } = useSelection();
  const { lastUpdate } = useSnapshot();

  const { telemetry, route, kind } = movement;
  const age = positionAgeSeconds(movement, lastUpdate, now);
  const stale = movement.coasting || age >= STALE_AFTER_SECONDS;
  const runway = runwayHint(
    movement.runway,
    kind === 'ground' || telemetry.onGround ? 'ground' : 'air',
  );
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

  const cells =
    kind === 'ground'
      ? groundCells(movement, now, settings.units, runway)
      : flightCells(movement, settings.units, runway);

  const vertical = telemetry.onGround ? null : formatVerticalRate(telemetry.verticalRate);
  const undirected = movement.phase === 'taxi_unknown';
  // The title already falls back to the callsign, so only show it again when it adds something.
  const title = flightTitle(movement);
  const secondaryCallsign = movement.callsign !== null && movement.callsign !== title;

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
            <span className="mv-flight app-numeric">{title}</span>
            {secondaryCallsign ? (
              <span className="mv-callsign app-numeric" title="Transmitted callsign">
                {movement.callsign}
              </span>
            ) : null}
          </span>
          <OperatorName airline={movement.airline} className="mv-airline" />
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
        <Icon name={routeIcon(kind, movement.phase)} size={16} className="mv-route-icon" />
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
        {/*
          An unnamed city is a decision, not a hole. Most A380s now transmit a suffixed
          operational callsign that matches no curated rotation, so "Origin unknown" is the
          honest end of the search — and the chip says we stopped there on purpose. The card
          opens the detail sheet, where the Route block explains why in full. One chip at a
          time: with no city named there is nothing for "inferred" to qualify.
        */}
        {!ends ? (
          <Chip
            size="sm"
            title="No rotation on file matches this callsign, so we name no city — open the aircraft for why"
          >
            not guessed
          </Chip>
        ) : route.source === 'inferred' ? (
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
        {/* A livery note is a sentence, not a token — it wraps rather than being clipped. */}
        {note ? <span className="mv-note">{note}</span> : null}
      </p>

      <dl className="mv-telem">
        {cells.map((cell) => (
          <div className="mv-telem-item" key={cell.term}>
            <dt>{cell.term}</dt>
            <dd className="app-numeric" title={cell.title}>
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>

      {stale || vertical !== null || undirected ? (
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
          {/*
            The chip above this card says "Taxiing" where its neighbours say "Taxiing in" and
            "Taxiing out", and the difference is the whole point: say why in words rather than
            leaving the reader to notice a missing preposition.
          */}
          {undirected ? (
            <span className="mv-undirected">
              Direction not established — we did not watch it land or line up
            </span>
          ) : null}
          {vertical !== null ? <span className="mv-vertical app-numeric">{vertical}</span> : null}
        </p>
      ) : null}
    </Card>
  );
}
