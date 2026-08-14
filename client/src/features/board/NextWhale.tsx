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
import type { Movement, Snapshot } from '../../../../shared/types.ts';
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

  return (
    <article className="next next--idle">
      <div className="next-idle-head">
        <span className="next-idle-icon" aria-hidden="true">
          <Icon name="binoculars" size={24} />
        </span>
        <div>
          <h2 className="next-idle-title">No whale inbound right now</h2>
          <p className="next-idle-message">
            Whale Watch is following every A380 transmitting a position anywhere in the world —
            {' '}
            {snapshot.stats.airborneWorldwide} airborne at the moment — and this panel fills the
            second one turns for Heathrow.
          </p>
        </div>
      </div>

      <div className="next-facts">
        <Stat
          label="Last movement"
          value={
            last
              ? `${last.flightNumber ?? last.callsign ?? last.registration ?? 'A380'} ${
                  last.kind === 'arrival' ? 'landed' : 'departed'
                }`
              : 'None logged'
          }
          sub={
            last
              ? `${formatRelative(last.at, now)}${last.runway ? ` · ${last.runway}` : ''}`
              : 'nothing in the last 24 h'
          }
        />
        <Stat
          label="On the ground"
          value={ground}
          sub={ground === 0 ? 'no whales parked' : ground === 1 ? 'airframe at LHR' : 'airframes at LHR'}
        />
        <Stat
          label="Logged today"
          value={`${snapshot.stats.arrivalsToday} in · ${snapshot.stats.departuresToday} out`}
          sub={`${snapshot.stats.airframesToday} airframe${
            snapshot.stats.airframesToday === 1 ? '' : 's'
          } seen`}
        />
      </div>
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
  const runway = runwayHint(movement.runway);
  const ends = routeEnds(movement.route, movement.kind);
  const age = positionAgeSeconds(movement, lastUpdate, now);
  const stale = movement.coasting || age >= STALE_AFTER_SECONDS;
  const down = movement.phase === 'landed' || movement.phase === 'stand';
  const touchedDownAt = movement.actualAt ?? movement.lastSeen;

  const countdown = down ? formatClock(touchedDownAt) : formatCountdown(movement.eta.minutes);
  const countdownLabel = down ? 'Touched down' : 'Touchdown in';
  const countdownSub = down
    ? formatRelative(touchedDownAt, now)
    : movement.eta.at !== null
      ? `~${formatClock(movement.eta.at)} at the fence`
      : 'ETA unavailable';

  const spoken = down
    ? `${flightTitle(movement)} has landed`
    : movement.eta.minutes !== null
      ? `${flightTitle(movement)} lands in ${formatCountdown(movement.eta.minutes)}`
      : `${flightTitle(movement)} inbound, arrival time unavailable`;

  const accent = { '--next-accent': movement.airline.color } as CSSProperties;

  return (
    <article className="next" style={accent}>
      <header className="next-head">
        <h2 className="next-eyebrow app-eyebrow">Next whale into Heathrow</h2>
        <Chip tone={phaseTone(movement.phase)} size="sm">
          {phaseLabel(movement.phase)}
        </Chip>
      </header>

      <div className="next-main">
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
          <p className="next-airline">{movement.airline.name}</p>
          <p className="next-line">
            <span className="next-reg app-numeric">
              {movement.airframe.registration ?? 'Reg unknown'}
            </span>
            <span className="next-dot" aria-hidden="true">
              ·
            </span>
            <span className="next-route">
              {ends ? `${ends.from} → ${ends.to}` : routeLabel(movement.route, movement.kind)}
            </span>
          </p>
          {movement.airframe.note ? (
            <p className="next-note">
              <Chip size="sm" tone="neutral" title={movement.airframe.note}>
                {movement.airframe.note}
              </Chip>
            </p>
          ) : null}
        </div>

        <div className="next-count">
          <p className="next-count-label app-eyebrow">{countdownLabel}</p>
          <p className="next-value app-numeric">{countdown}</p>
          <p className="next-count-sub app-numeric">{countdownSub}</p>
        </div>
      </div>

      <p className="app-visually-hidden" aria-live="polite">
        {spoken}
      </p>

      <div className="next-track">
        {progress ? (
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
        <Stat label="Runway" value={runway.label} sub={runway.short} />
        <Stat
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
          label="Altitude"
          value={formatAltitude(telemetry.altitude, telemetry.onGround, settings.units)}
          sub={
            telemetry.onGround
              ? 'on the ground'
              : (formatVerticalRate(telemetry.verticalRate) ?? 'vertical rate unavailable')
          }
        />
        <Stat
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
