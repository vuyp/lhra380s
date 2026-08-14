/**
 * AircraftSheet — everything we hold on one airframe.
 *
 * A bottom sheet on a phone (drag it down to dismiss), a side panel from 900px. It is its own
 * dialog rather than the shell's Sheet primitive because it needs the side-panel form and the
 * swipe affordance; the modal behaviour — focus trap, Escape, scroll lock, focus restore — is
 * implemented here to the same contract.
 *
 * The fetched detail is the record; the live snapshot is layered over it so telemetry keeps
 * ticking without re-fetching. Nothing is filled in: every gap in the fleet reference says so.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import type {
  AircraftDetail,
  Airline,
  FlightPhase,
  GlobalAircraft,
  LoggedMovement,
  Movement,
  Place,
} from '../../../../shared/types.ts';
import { useNow, useSnapshot } from '../../api/useSnapshot.ts';
import { useSelection } from '../../state/selection.tsx';
import { useSettings } from '../../state/settings.tsx';
import { Chip } from '../../components/ui/Chip.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import { collectTabbable } from '../../components/ui/Sheet.tsx';
import { Skeleton } from '../../components/ui/Skeleton.tsx';
import { Stat } from '../../components/ui/Stat.tsx';
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
} from '../../lib/format.ts';
import {
  STALE_AFTER_SECONDS,
  flightTitle,
  formatAge,
  formatVerticalRate,
  positionAgeSeconds,
  runwayHint,
} from '../board/MovementCard.tsx';
import './AircraftSheet.css';

const DASH = '—';
const UNKNOWN = 'Not on file';

/** Every phase on the tarmac: none of them counts down to anything. */
const GROUND_PHASES: ReadonlySet<FlightPhase> = new Set<FlightPhase>([
  'landed',
  'taxi_in',
  'stand',
  'taxi_out',
  'taxi_unknown',
]);

/** Past this distance dragged, or this downward speed, the sheet goes. */
const DISMISS_PX = 110;
const DISMISS_VELOCITY = 0.55;

const dayFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/London',
});

const isoDayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' });

function dayLabel(ts: number, now: number): string {
  if (!Number.isFinite(ts)) return DASH;
  return isoDayFormatter.format(ts) === isoDayFormatter.format(now)
    ? 'Today'
    : dayFormatter.format(ts);
}

function blockLabel(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours} h ${String(rest).padStart(2, '0')}` : `${rest} min`;
}

function isAircraftDetail(value: unknown): value is AircraftDetail {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AircraftDetail>;
  return (
    typeof candidate.airframe === 'object' &&
    candidate.airframe !== null &&
    Array.isArray(candidate.history)
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The server did not answer';
}

/* ---- Sections -------------------------------------------------------------------- */

function SectionHead(p: { children: string }): ReactElement {
  return <h3 className="det-section-head app-eyebrow">{p.children}</h3>;
}

function RouteEnd(p: { place: Place | null; heathrow: boolean; role: string }): ReactElement {
  // The Heathrow end is not an inference: this app only tracks movements at EGLL.
  if (p.heathrow) {
    return (
      <div className="det-route-end">
        <span className="det-route-code app-numeric">LHR</span>
        <span className="det-route-city">London Heathrow</span>
      </div>
    );
  }
  const code = p.place?.iata ?? p.place?.icao ?? null;
  const city = p.place?.city ?? p.place?.country ?? null;
  return (
    <div className="det-route-end">
      <span className={code ? 'det-route-code app-numeric' : 'det-route-code det-route-code--none'}>
        {code ?? '???'}
      </span>
      <span className="det-route-city">{city ?? `${p.role} unknown`}</span>
    </div>
  );
}

function RouteBlock(p: { movement: Movement }): ReactElement {
  const { route, kind } = p.movement;
  const block = blockLabel(route.blockMinutes);
  /*
   * The unknown case is the common one and the one that looks like a fault on the board, so this
   * is where it gets explained rather than merely restated.
   */
  const sourceNote =
    route.source === 'schedule'
      ? 'Matched to the curated Heathrow A380 rotation table'
      : route.source === 'inferred'
        ? 'Direction inferred from the track — the far end is not confirmed'
        : 'No rotation on file matches this callsign, so no city is named. Most A380s now ' +
          'transmit a suffixed operational callsign — UAE1H rather than UAE1 — which the curated ' +
          'table cannot match, and a plausible city would be worse than an honest gap.';

  return (
    <section className="det-section">
      <SectionHead>Route</SectionHead>
      <div className="det-route">
        {/*
          Only an arrival's destination and a departure's origin are Heathrow by definition. A
          movement on the ground is neither: forcing its far end to LHR rendered "LHR London →
          LHR London Heathrow", which is the airport twice and a route never.
        */}
        <RouteEnd place={route.origin} heathrow={kind === 'departure'} role="Origin" />
        <div className="det-route-link" aria-hidden="true">
          <span className="det-route-track" />
          <Icon name="plane" size={18} className="det-route-plane" />
        </div>
        <RouteEnd place={route.destination} heathrow={kind === 'arrival'} role="Destination" />
      </div>
      <p className="det-note">
        {sourceNote}
        {block ? ` · scheduled block ${block}` : ''}
      </p>
    </section>
  );
}

function LiveBlock(p: { movement: Movement; now: number }): ReactElement {
  const { movement, now } = p;
  const { settings } = useSettings();
  const { lastUpdate } = useSnapshot();
  const { telemetry } = movement;
  const age = positionAgeSeconds(movement, lastUpdate, now);
  const stale = movement.coasting || age >= STALE_AFTER_SECONDS;
  const arriving = movement.kind === 'arrival';

  /*
   * A frame that is already down has no countdown, and printing "Off blocks in —" over the top
   * of the panel says nothing — worse, it says "departure" about a whale that has just landed.
   * Every phase on the tarmac reports the event we actually watched happen instead.
   */
  const down = GROUND_PHASES.has(movement.phase);
  const runway = runwayHint(movement.runway, down || telemetry.onGround ? 'ground' : 'air');
  const downAt = movement.actualAt ?? movement.lastSeen;
  const headline = down
    ? {
        label: movement.actualAt !== null ? 'Touched down' : 'Last seen',
        value: formatClock(downAt),
        sub: formatRelative(downAt, now),
      }
    : {
        label: arriving ? 'Touchdown in' : 'Off blocks in',
        value: formatCountdown(movement.eta.minutes),
        sub: movement.eta.at === null ? 'ETA unavailable' : `~${formatClock(movement.eta.at)}`,
      };

  return (
    <section className="det-section">
      <SectionHead>Live</SectionHead>

      <div className="det-live-top">
        <Chip tone={phaseTone(movement.phase)}>{phaseLabel(movement.phase)}</Chip>
        {stale ? (
          <Chip tone="warn" size="sm" title="No fresh ADS-B position — last known state held">
            {movement.coasting ? 'Coasting' : 'Stale'} · {formatAge(age)} old
          </Chip>
        ) : null}
      </div>

      {/* Three taxi phases, three amounts of knowledge. This is the one with the least. */}
      {movement.phase === 'taxi_unknown' ? (
        <p className="det-note">
          Moving on the ground at Heathrow, direction not established. Calling a taxi inbound or
          outbound needs something watched — a touchdown, a stand dwell, or a line-up on a runway —
          and none of those is on record for this aircraft. Until one is, it stays on the ground
          board rather than departures.
        </p>
      ) : null}

      <div className="det-facts">
        <Stat
          wrap
          label={headline.label}
          value={
            <span aria-live="polite" className="det-live-eta">
              {headline.value}
            </span>
          }
          sub={headline.sub}
        />
        <Stat wrap label="Runway" value={runway.label} sub={runway.short} />
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
            telemetry.track === null
              ? 'track unavailable'
              : `track ${Math.round(telemetry.track)}° ${compassPoint(telemetry.track)}`
          }
        />
        <Stat
          wrap
          label="Distance"
          value={
            movement.distanceNm === null ? DASH : formatDistance(movement.distanceNm, settings.units)
          }
          sub={
            movement.bearingFromAirport === null
              ? 'bearing unavailable'
              : `${compassPoint(movement.bearingFromAirport)} of LHR`
          }
        />
        <Stat
          wrap
          label="Position fix"
          value={formatAge(age)}
          sub={telemetry.squawk ? `squawk ${telemetry.squawk}` : 'squawk unavailable'}
        />
      </div>
    </section>
  );
}

function GlobalBlock(p: { aircraft: GlobalAircraft }): ReactElement {
  const { aircraft } = p;
  const { settings } = useSettings();
  const hasPosition = aircraft.lat !== null && aircraft.lon !== null;

  return (
    <section className="det-section">
      <SectionHead>Live</SectionHead>
      <p className="det-note">
        This airframe has no Heathrow movement right now — it is being tracked as part of the
        world fleet.
      </p>
      <div className="det-facts">
        <Stat
          wrap
          label="Callsign"
          value={aircraft.callsign ?? 'Not transmitting'}
          sub={aircraft.operator ?? 'operator unknown'}
        />
        <Stat
          wrap
          label="Altitude"
          value={formatAltitude(aircraft.altitude, aircraft.onGround, settings.units)}
          sub={aircraft.onGround ? 'on the ground' : 'barometric'}
        />
        <Stat
          wrap
          label="Ground speed"
          value={formatSpeed(aircraft.groundSpeed, settings.units)}
          sub={aircraft.track === null ? 'track unavailable' : `tracking ${compassPoint(aircraft.track)}`}
        />
        <Stat
          wrap
          label="Position"
          value={
            hasPosition
              ? `${(aircraft.lat ?? 0).toFixed(2)}, ${(aircraft.lon ?? 0).toFixed(2)}`
              : DASH
          }
          sub={hasPosition ? 'latitude, longitude' : 'position unavailable'}
        />
      </div>
    </section>
  );
}

/** "G-" from "G-XLEF" — the part a prefix inference is actually built on. */
function registrationPrefix(registration: string | null): string | null {
  if (!registration) return null;
  const index = registration.indexOf('-');
  return index > 0 ? registration.slice(0, index + 1) : null;
}

/**
 * The caveat on an operator we worked out rather than watched.
 *
 * A name at the top of this panel reads as fact, and for `callsign` and `fleet` it is one. A
 * `registration_prefix` match is not: it says only that every A380 on file with this prefix
 * belongs to that airline, and the A380 that is *not* on the file is exactly the one worth
 * standing at the fence for. The board card stays clean; the sheet is where this belongs.
 */
function OperatorNote(p: { airline: Airline; registration: string | null }): ReactElement | null {
  const { airline, registration } = p;

  if (airline.source === 'registration_prefix') {
    const prefix = registrationPrefix(registration);
    return (
      <section className="det-section">
        <p className="det-note det-note--caution">
          <strong>{airline.name} is inferred, not observed.</strong> Nothing this aircraft
          transmitted names an airline
          {prefix
            ? `, and ${airline.name} is the only A380 operator on file with a ${prefix} registration.`
            : ', and it is the only A380 operator on file with this registration prefix.'}{' '}
          A visiting or leased frame would be named wrongly here.
        </p>
      </section>
    );
  }

  if (airline.source === 'unknown') {
    return (
      <section className="det-section">
        <p className="det-note det-note--caution">
          <strong>The operator is not known.</strong> The callsign carries no airline code we hold
          and the registration is not in the fleet reference, so nothing here names an airline. We
          would rather leave it blank than pick the likeliest one.
        </p>
      </section>
    );
  }

  return null;
}

function AirframeBlock(p: { airframe: AircraftDetail['airframe'] }): ReactElement {
  const { airframe } = p;
  return (
    <section className="det-section">
      <SectionHead>Airframe</SectionHead>
      <div className="det-facts">
        <Stat wrap label="Operator" value={airframe.operator ?? UNKNOWN} sub="fleet reference" />
        <Stat
          wrap
          label="Registration"
          value={airframe.registration ?? UNKNOWN}
          sub={`hex ${airframe.hex.toUpperCase()}`}
        />
        <Stat wrap label="MSN" value={airframe.msn ?? UNKNOWN} sub="serial number" />
        <Stat
          wrap
          label="Delivered"
          value={airframe.deliveredYear ?? UNKNOWN}
          sub={airframe.deliveredYear === null ? 'year unknown' : 'first flown / handed over'}
        />
        <Stat
          wrap
          label="Seats"
          value={airframe.seats ?? UNKNOWN}
          sub={airframe.seats === null ? 'configuration unknown' : 'this operator’s layout'}
        />
      </div>
      {airframe.note ? <p className="det-airframe-note">{airframe.note}</p> : null}
    </section>
  );
}

function HistoryBlock(p: { history: LoggedMovement[]; now: number }): ReactElement {
  const { history, now } = p;

  return (
    <section className="det-section">
      <SectionHead>Logged movements</SectionHead>
      {history.length === 0 ? (
        <p className="det-note">
          Nothing logged for this airframe yet. Whale Watch only records what it has watched
          happen, so the log starts the first time this frame moves at Heathrow while the server
          is running.
        </p>
      ) : (
        <ul className="det-history">
          {history.map((entry) => (
            <li className="det-history-row" key={`${entry.id}-${entry.at}-${entry.kind}`}>
              <span
                className={`det-history-icon det-history-icon--${entry.kind}`}
                aria-hidden="true"
              >
                <Icon name={entry.kind === 'arrival' ? 'arrival' : 'departure'} size={16} />
              </span>
              <span className="det-history-main">
                <span className="det-history-flight app-numeric">
                  {entry.flightNumber ?? entry.callsign ?? 'No callsign'}
                </span>
                <span className="det-history-city">
                  {entry.city ??
                    (entry.kind === 'arrival' ? 'Origin unknown' : 'Destination unknown')}
                </span>
              </span>
              <span className="det-history-when">
                <span className="det-history-time app-numeric">
                  {dayLabel(entry.at, now)} {formatClock(entry.at)}
                </span>
                <span className="det-history-meta app-numeric">
                  {entry.runway ? `RWY ${entry.runway}` : 'runway not logged'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DetailSkeleton(): ReactElement {
  return (
    <div className="det-skeleton" aria-hidden="true">
      <Skeleton height={20} width="34%" />
      <Skeleton height={84} radius="var(--radius-lg)" />
      <Skeleton height={20} width="28%" />
      <Skeleton height={120} radius="var(--radius-lg)" />
      <Skeleton height={20} width="40%" />
      <Skeleton height={96} radius="var(--radius-lg)" />
    </div>
  );
}

/* ---- The panel -------------------------------------------------------------------- */

type Status = 'loading' | 'ready' | 'error';

function DetailPanel(p: { hex: string; onClose: () => void; onShowMap: () => void }): ReactElement {
  const { hex, onClose, onShowMap } = p;
  const { snapshot, lastUpdate } = useSnapshot();
  const now = useNow(1000);
  const titleId = useId();

  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const [detail, setDetail] = useState<AircraftDetail | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  /* ---- Data ---- */

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setFailure(null);

    void (async () => {
      try {
        const response = await fetch(`/api/aircraft/${encodeURIComponent(hex)}`, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Server responded ${response.status}`);
        const payload = (await response.json()) as unknown;
        if (!isAircraftDetail(payload)) throw new Error('Unrecognised response from the server');
        if (controller.signal.aborted) return;
        setDetail(payload);
        setStatus('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure(errorMessage(error));
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [hex, attempt]);

  /** The snapshot is fresher than the fetch — prefer it whenever this frame is on the board. */
  const live = useMemo<Movement | null>(() => {
    if (!snapshot) return null;
    for (const list of [snapshot.arrivals, snapshot.departures, snapshot.ground]) {
      const found = list.find((movement) => movement.id === hex);
      if (found) return found;
    }
    return null;
  }, [snapshot, hex]);

  const movement = live ?? detail?.movement ?? null;
  const airframe = detail?.airframe ?? movement?.airframe ?? null;
  const registration = movement?.airframe.registration ?? airframe?.registration ?? null;
  // "Unknown" is the airline's own name for nothing-identified it, and it is not an operator.
  // Where the fleet reference does know the frame, that is the better answer.
  const airline = movement?.airline ?? null;
  const operator =
    (airline !== null && airline.source !== 'unknown' ? airline.name : null) ??
    airframe?.operator ??
    detail?.global?.operator ??
    null;
  const operatorInferred = airline?.source === 'registration_prefix';
  const title = movement
    ? flightTitle(movement)
    : (detail?.global?.callsign ?? registration ?? hex.toUpperCase());
  // The title already falls back to the registration, so only print it again when it adds
  // something. "G-XLEJ" over "G-XLEJ 406D1A" is the same fact twice in two sizes.
  const showRegistrationLine = registration !== null && registration !== title;

  /**
   * Whether there is anywhere on the map to send the reader. An airframe with no position is one
   * the map cannot draw, and this panel has just said so — offering to show it there anyway is a
   * button that does nothing, which is a small promise broken.
   */
  const plottable =
    (movement?.telemetry.lat ?? null) !== null && (movement?.telemetry.lon ?? null) !== null
      ? true
      : (detail?.global?.lat ?? null) !== null && (detail?.global?.lon ?? null) !== null;

  const accent: CSSProperties | undefined = movement
    ? ({ '--det-accent': movement.airline.color } as CSSProperties)
    : undefined;

  /* ---- Modal behaviour ---- */

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeRef.current();
      return;
    }
    if (event.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;
    // Shared with the settings sheet, tabbability filter and all: this panel has no roving
    // tabindex in it today, and the trap must not depend on that staying true.
    const items = collectTabbable(panel);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      panel.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    document.addEventListener('keydown', onKeyDown, true);
    const raf = window.requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
      returnFocusRef.current?.focus();
    };
  }, [onKeyDown]);

  /* ---- Swipe down to dismiss (touch, phone layout only) ---- */

  const dragRef = useRef<{ id: number; startY: number; lastY: number; lastT: number; v: number } | null>(
    null,
  );

  const canDrag = (): boolean =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 899px)').matches;

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'mouse' || !canDrag()) return;
    if (event.target instanceof Element && event.target.closest('button, a')) return;
    const panel = panelRef.current;
    if (!panel) return;

    dragRef.current = {
      id: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      lastT: event.timeStamp,
      v: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    panel.style.transition = 'none';
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dy = Math.max(0, event.clientY - drag.startY);
    const dt = event.timeStamp - drag.lastT;
    if (dt > 0) drag.v = (event.clientY - drag.lastY) / dt;
    drag.lastY = event.clientY;
    drag.lastT = event.timeStamp;
    const panel = panelRef.current;
    if (panel) panel.style.transform = `translate3d(0, ${dy}px, 0)`;
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;

    const panel = panelRef.current;
    if (panel) {
      panel.style.transition = '';
      panel.style.transform = '';
    }
    const dy = Math.max(0, event.clientY - drag.startY);
    if (dy > DISMISS_PX || drag.v > DISMISS_VELOCITY) closeRef.current();
  };

  const dragProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
  };

  /* ---- Render ---- */

  return createPortal(
    <div className="det-root">
      <button
        type="button"
        className="det-scrim"
        aria-label="Close aircraft details"
        tabIndex={-1}
        onClick={onClose}
      />

      <div
        className="det-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        style={accent}
      >
        <div className="det-grab" {...dragProps}>
          <span className="det-grab-bar" aria-hidden="true" />
        </div>

        <header className="det-head" {...dragProps}>
          <div className="det-head-main">
            <p className="det-head-operator">
              {operator ?? 'Operator unknown'}
              {operatorInferred ? (
                // The same tag, in the same words, as the board card and the hero.
                <span
                  className="app-inferred-tag det-head-operator-tag"
                  title="Worked out from the registration prefix, not from anything this aircraft transmitted"
                >
                  inferred
                </span>
              ) : null}
            </p>
            <h2 className="det-head-title app-numeric" id={titleId}>
              {title}
            </h2>
            <p className="det-head-reg">
              {showRegistrationLine ? (
                <span className="det-head-reg-value app-numeric">{registration}</span>
              ) : registration === null ? (
                <span className="det-head-reg-none">Registration unknown</span>
              ) : null}
              <span className="det-head-hex app-numeric">{hex.toUpperCase()}</span>
            </p>
          </div>
          <button type="button" className="det-close" onClick={onClose}>
            <Icon name="close" size={20} />
            <span className="app-visually-hidden">Close aircraft details</span>
          </button>
        </header>

        <div className="det-body">
          {status === 'loading' && !movement ? (
            <>
              <p className="app-visually-hidden" role="status">
                Loading aircraft details
              </p>
              <DetailSkeleton />
            </>
          ) : null}

          {movement ? <LiveBlock movement={movement} now={now} /> : null}
          {!movement && detail?.global ? <GlobalBlock aircraft={detail.global} /> : null}
          {/*
            The "nothing named it" note only makes sense while nothing has: the fleet reference
            can still know an airframe whose callsign told us nothing, and the header shows that.
          */}
          {airline && (airline.source !== 'unknown' || operator === null) ? (
            <OperatorNote airline={airline} registration={registration} />
          ) : null}
          {movement ? <RouteBlock movement={movement} /> : null}
          {airframe ? <AirframeBlock airframe={airframe} /> : null}
          {detail ? <HistoryBlock history={detail.history} now={now} /> : null}
          {!detail && status === 'loading' && movement ? (
            // The live blocks are already up; only the logged history is still in flight.
            <section className="det-section" aria-hidden="true">
              <SectionHead>Logged movements</SectionHead>
              <Skeleton height={132} radius="var(--radius-lg)" />
            </section>
          ) : null}

          {status === 'error' ? (
            <section className="det-section det-error" role="alert">
              <p className="det-error-title">Could not load this airframe</p>
              <p className="det-note">
                {`${failure}. `}
                {movement ? 'The live position above is still current. ' : ''}
                Nothing is being filled in from memory.
              </p>
              <button
                type="button"
                className="det-retry"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            </section>
          ) : null}

          {status === 'ready' && !movement && !detail?.global ? (
            <section className="det-section">
              <p className="det-note">
                This airframe is not transmitting a position at the moment. Everything above comes
                from the fleet reference and the movement log.
              </p>
            </section>
          ) : null}

          <p className="det-updated app-numeric">
            Live feed updated {formatClock(lastUpdate ?? snapshot?.ts ?? null)} · London time
          </p>
        </div>

        {plottable ? (
          <footer className="det-actions">
            <button type="button" className="det-action" onClick={onShowMap}>
              <Icon name="map" size={18} />
              Show on map
            </button>
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/* ---- Public component ---------------------------------------------------------------- */

export function AircraftSheet(): ReactElement | null {
  const { selectedHex, select } = useSelection();
  // "Show on map" keeps the selection so the map can highlight the aircraft, but the panel has
  // to get out of the way. Remembering which hex was dismissed does that without dropping it.
  const [dismissedHex, setDismissedHex] = useState<string | null>(null);

  if (!selectedHex || selectedHex === dismissedHex) return null;

  return (
    <DetailPanel
      key={selectedHex}
      hex={selectedHex}
      onClose={() => select(null)}
      onShowMap={() => {
        setDismissedHex(selectedHex);
        if (window.location.hash !== '#map') window.location.hash = '#map';
      }}
    />
  );
}
