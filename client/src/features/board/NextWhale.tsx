/**
 * NextWhale — the hero, and the reason the app exists.
 *
 * One question, answered in under two seconds: is a whale coming, when, and on which runway.
 * The approach rail is an instrument, not decoration: it plots the distance still to run
 * against the furthest point at which we picked this flight up, so it only ever fills with
 * ground the aircraft has actually covered.
 */

import { useRef } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { FlightPhase, Movement, Snapshot } from '../../../../shared/types.ts';
import { useSnapshot } from '../../api/useSnapshot.ts';
import { useSelection } from '../../state/selection.tsx';
import { useSettings } from '../../state/settings.tsx';
import { Chip } from '../../components/ui/Chip.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import { Stat } from '../../components/ui/Stat.tsx';
import { haversineKm } from '../../lib/geo.ts';
import {
  compassPoint,
  formatAltitude,
  formatClock,
  formatCountdown,
  formatDistance,
  formatRelative,
  formatSpeed,
  phaseLabel,
  phaseTone,
  routeLabel,
} from '../../lib/format.ts';
import {
  OperatorName,
  STALE_AFTER_SECONDS,
  flightTitle,
  formatAge,
  formatVerticalRate,
  positionAgeSeconds,
  routeEnds,
  runwayHint,
} from './MovementCard.tsx';
import './NextWhale.css';

/** Heathrow's aerodrome reference point — SPEC §5. */
const LHR = { lat: 51.4706, lon: -0.4619 };
const KM_PER_NM = 1.852;

/** Every phase that is on the tarmac. None of them has a countdown to a touchdown. */
const GROUND_PHASES: ReadonlySet<FlightPhase> = new Set<FlightPhase>([
  'landed',
  'taxi_in',
  'stand',
  'taxi_out',
  'taxi_unknown',
]);

/**
 * What the approach rail says once the wheels are down. "Taxiing in" is a claim about direction
 * and only two of these phases have earned it — the rest say where the aircraft is and stop.
 */
const GROUND_LINE: Record<string, string> = {
  landed: 'On the ground at Heathrow — rolling out',
  taxi_in: 'On the ground at Heathrow — taxiing in',
  stand: 'On stand at Heathrow',
  taxi_out: 'On the ground at Heathrow — taxiing out',
  taxi_unknown: 'On the ground at Heathrow — taxiing, direction not established',
};

/** Distance to Heathrow, in nautical miles, of the oldest position we still hold for a flight. */
function trailStartNm(movement: Movement): number | null {
  const first = movement.trail[0];
  if (!first || !Number.isFinite(first.lat) || !Number.isFinite(first.lon)) return null;
  return haversineKm(LHR, { lat: first.lat, lon: first.lon }) / KM_PER_NM;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

interface ApproachProgress {
  /** 0–1 of the tracked approach already flown. */
  fraction: number;
  startNm: number;
  remainingNm: number;
}

/**
 * Remembers the furthest point at which we have seen the current flight this session, so the
 * rail cannot jump backwards when a coasting flight reappears closer in.
 */
function useApproachProgress(movement: Movement | null): ApproachProgress | null {
  const seenRef = useRef<{ id: string; maxNm: number } | null>(null);

  if (!movement || movement.distanceNm === null || !Number.isFinite(movement.distanceNm)) {
    return null;
  }

  const remainingNm = Math.max(0, movement.distanceNm);
  const candidate = Math.max(remainingNm, trailStartNm(movement) ?? 0);
  const previous = seenRef.current;
  const startNm =
    previous && previous.id === movement.id ? Math.max(previous.maxNm, candidate) : candidate;
  seenRef.current = { id: movement.id, maxNm: startNm };

  if (startNm <= 0) return null;
  return { fraction: clamp01(1 - remainingNm / startNm), startNm, remainingNm };
}

/* ---- Empty state ------------------------------------------------------------- */

function IdleWhale(p: { snapshot: Snapshot; now: number }): ReactElement {
  const { snapshot, now } = p;
  const last = snapshot.log[0];
  const ground = snapshot.ground.length;
  const airborne = snapshot.stats.airborneWorldwide;

  return (
    <article className="next next--idle">
      <div className="next-idle-head">
        <span className="next-idle-icon" aria-hidden="true">
          <Icon name="binoculars" size={24} />
        </span>
        <div className="next-idle-copy">
          <h2 className="next-idle-title">No whale inbound right now</h2>
          <p className="next-idle-message">
            Nothing is turning for Heathrow this minute. This panel fills itself the moment one
            does — there is no schedule behind it, only what the aircraft are transmitting.
          </p>
        </div>
      </div>

      <div className="next-facts next-idle-facts">
        <Stat
          wrap
          label="Last movement"
          // The identifier alone in the value: the value line is a single ellipsised row, and
          // "BAW55G departed" does not fit one column of this grid on a phone — it renders as
          // "BAW55G depa…", which loses the one word that says which way the aeroplane went. The
          // verb belongs with the time, in the caption, which is the box that wraps.
          value={
            last ? (last.flightNumber ?? last.callsign ?? last.registration ?? 'A380') : 'None logged'
          }
          sub={
            last
              ? `${last.kind === 'arrival' ? 'landed' : 'departed'} ${formatRelative(last.at, now)}${
                  last.runway ? ` · ${last.runway}` : ''
                }`
              : 'nothing in the last 24 h'
          }
        />
        <Stat
          wrap
          label="On the ground"
          value={ground}
          sub={ground === 0 ? 'no whales parked' : ground === 1 ? 'airframe at LHR' : 'airframes at LHR'}
        />
        <Stat
          wrap
          label="Logged today"
          value={`${snapshot.stats.arrivalsToday} in · ${snapshot.stats.departuresToday} out`}
          sub={`${snapshot.stats.airframesToday} airframe${
            snapshot.stats.airframesToday === 1 ? '' : 's'
          } seen`}
        />
        <Stat
          wrap
          label="Airborne now"
          value={airborne}
          sub={`A380${airborne === 1 ? '' : 's'} flying worldwide`}
        />
      </div>

      <nav className="next-idle-links" aria-label="While you wait">
        <a className="next-idle-link" href="#spots">
          <Icon name="binoculars" size={16} />
          Find a spot for the current runways
        </a>
        {/* The world fleet is the answer to a quiet Heathrow, so it gets its own way in. */}
        <a className="next-idle-link" href="#fleet/world">
          <Icon name="fleet" size={16} />
          {airborne > 0
            ? `See ${airborne} A380${airborne === 1 ? '' : 's'} airborne worldwide`
            : 'Browse the world A380 fleet'}
        </a>
        <a className="next-idle-link" href="#fleet/log">
          <Icon name="clock" size={16} />
          Today's movement log
        </a>
      </nav>
    </article>
  );
}

/* ---- Hero -------------------------------------------------------------------- */

export function NextWhale(p: { movement: Movement | null; snapshot: Snapshot; now: number }): ReactElement {
  const { movement, snapshot, now } = p;
  const { settings } = useSettings();
  const { select } = useSelection();
  const { lastUpdate } = useSnapshot();
  const progress = useApproachProgress(movement);

  if (!movement) return <IdleWhale snapshot={snapshot} now={now} />;

  const { telemetry } = movement;
  const runway = runwayHint(movement.runway, telemetry.onGround ? 'ground' : 'air');
  const ends = routeEnds(movement.route, movement.kind);
  const age = positionAgeSeconds(movement, lastUpdate, now);
  const stale = movement.coasting || age >= STALE_AFTER_SECONDS;
  const down = GROUND_PHASES.has(movement.phase);
  const touchedDownAt = movement.actualAt ?? movement.lastSeen;

  const countdown = down ? formatClock(touchedDownAt) : formatCountdown(movement.eta.minutes);
  // Only a touchdown this app watched may be called one; otherwise all we have is a last fix.
  const countdownLabel = down
    ? movement.actualAt !== null
      ? 'Touched down'
      : 'Last seen'
    : 'Touchdown in';
  const countdownSub = down
    ? formatRelative(touchedDownAt, now)
    : movement.eta.at !== null
      ? `~${formatClock(movement.eta.at)} at the fence`
      : 'ETA unavailable';

  const spoken = down
    ? movement.actualAt !== null
      ? `${flightTitle(movement)} has landed`
      : `${flightTitle(movement)} is on the ground at Heathrow`
    : movement.eta.minutes !== null
      ? `${flightTitle(movement)} lands in ${formatCountdown(movement.eta.minutes)}`
      : `${flightTitle(movement)} inbound, arrival time unavailable`;

  const accent = { '--next-accent': movement.airline.color } as CSSProperties;

  return (
    <article className="next" style={accent}>
      <header className="next-head">
        <h2 className="next-eyebrow app-eyebrow">
          {!down
            ? 'Next whale into Heathrow'
            : movement.actualAt !== null
              ? 'Just landed at Heathrow'
              : 'On the ground at Heathrow'}
        </h2>
        <Chip tone={phaseTone(movement.phase)} size="sm">
          {phaseLabel(movement.phase)}
        </Chip>
      </header>

      {/*
        The countdown comes first in the source and first on a phone: it is the answer to the
        only question this screen exists for. On a wide screen it moves to the right-hand
        column, where the eye lands on it just as fast.
      */}
      <div className="next-main">
        <div className="next-count">
          <p className="next-count-label app-eyebrow">{countdownLabel}</p>
          <p className="next-value app-numeric">{countdown}</p>
          <p className="next-count-sub app-numeric">{countdownSub}</p>
        </div>

        <div className="next-ident">
          <p className="next-flight">
            <button
              type="button"
              className="next-open"
              onClick={() => select(movement.id)}
              aria-label={`${flightTitle(movement)}, ${movement.airline.name}, ${
                movement.airframe.registration ?? 'registration unknown'
              } — open aircraft details`}
            >
              <span className="app-numeric">{flightTitle(movement)}</span>
              <Icon name="chevron" size={20} className="next-open-chevron" />
            </button>
          </p>
          <p className="next-airline">
            <OperatorName airline={movement.airline} className="next-airline-value" />
          </p>
          <p className="next-line">
            <span className="next-reg app-numeric">
              {movement.airframe.registration ?? 'Reg unknown'}
            </span>
            <span className="next-dot" aria-hidden="true">
              ·
            </span>
            {/* No city named is a decision the app made, and the detail sheet gives the reason. */}
            <span
              className="next-route"
              title={
                ends
                  ? undefined
                  : 'No rotation on file matches this callsign, so we name no city — open the flight for why'
              }
            >
              {ends ? `${ends.from} → ${ends.to}` : routeLabel(movement.route, movement.kind)}
            </span>
          </p>
          {movement.airframe.note ? (
            <p className="next-note">{movement.airframe.note}</p>
          ) : null}
        </div>
      </div>

      <p className="app-visually-hidden" aria-live="polite">
        {spoken}
      </p>

      <div className="next-track">
        {down ? (
          // "3.2 nm to run" is not a true thing to say about an aeroplane that has landed.
          <p className="next-track-void">
            {GROUND_LINE[movement.phase] ?? 'On the ground at Heathrow'}
          </p>
        ) : progress ? (
          <>
            <div
              className="next-track-rail"
              role="img"
              aria-label={`${formatDistance(progress.remainingNm, settings.units)} still to run of the ${formatDistance(
                progress.startNm,
                settings.units,
              )} tracked so far`}
            >
              <span
                className="next-track-fill"
                style={{ inlineSize: `${(progress.fraction * 100).toFixed(2)}%` }}
              />
              <span
                className="next-track-mark"
                style={{ insetInlineStart: `${(progress.fraction * 100).toFixed(2)}%` }}
              />
            </div>
            <div className="next-track-labels">
              <span className="app-numeric">
                {formatDistance(progress.remainingNm, settings.units)} to run
              </span>
              <span className="next-track-end">LHR</span>
            </div>
          </>
        ) : (
          <p className="next-track-void">
            No position in this update — holding the last known state
          </p>
        )}
      </div>

      <div className="next-facts">
        <Stat wrap label="Runway" value={runway.label} sub={runway.short} />
        <Stat
          wrap
          label="Distance"
          value={
            movement.distanceNm === null
              ? '—'
              : formatDistance(movement.distanceNm, settings.units)
          }
          sub={
            movement.bearingFromAirport === null
              ? 'bearing unavailable'
              : `${compassPoint(movement.bearingFromAirport)} of the airport`
          }
        />
        <Stat
          wrap
          label="Altitude"
          value={formatAltitude(telemetry.altitude, telemetry.onGround, settings.units)}
          sub={
            telemetry.onGround
              ? 'on the ground'
              : (formatVerticalRate(telemetry.verticalRate) ?? 'vertical rate unavailable')
          }
        />
        <Stat
          wrap
          label="Ground speed"
          value={formatSpeed(telemetry.groundSpeed, settings.units)}
          sub={
            telemetry.track === null ? 'track unavailable' : `tracking ${compassPoint(telemetry.track)}`
          }
        />
      </div>

      {stale ? (
        <p className="next-warn">
          <Chip tone="warn" size="sm" title="No fresh ADS-B position — the last known state is held">
            {movement.coasting ? 'Coasting' : 'Stale'} · {formatAge(age)} old
          </Chip>
          <span className="next-warn-text">
            Out of receiver coverage. Nothing here is invented — the numbers stop moving until it
            comes back.
          </span>
        </p>
      ) : null}
    </article>
  );
}
