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
import { Skeleton } from '../../components/ui/Skeleton.tsx';
import { Stat } from '../../components/ui/Stat.tsx';
import {
  compassPoint,
  formatAltitude,
  formatClock,
  formatCountdown,
  formatDistance,
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const sourceNote =
    route.source === 'schedule'
      ? 'Matched to the curated Heathrow A380 rotation table'
      : route.source === 'inferred'
        ? 'Direction inferred from the track — the far end is not confirmed'
        : 'No schedule match: we will not name a city we have not verified';

  return (
    <section className="det-section">
      <SectionHead>Route</SectionHead>
      <div className="det-route">
        <RouteEnd place={route.origin} heathrow={kind === 'departure'} role="Origin" />
        <div className="det-route-link" aria-hidden="true">
          <span className="det-route-track" />
          <Icon name="plane" size={18} className="det-route-plane" />
        </div>
        <RouteEnd place={route.destination} heathrow={kind !== 'departure'} role="Destination" />
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
  const runway = runwayHint(movement.runway);
  const age = positionAgeSeconds(movement, lastUpdate, now);
  const stale = movement.coasting || age >= STALE_AFTER_SECONDS;
  const arriving = movement.kind === 'arrival';

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

      <div className="det-facts">
        <Stat
          label={arriving ? 'Touchdown in' : 'Off blocks in'}
          value={
            <span aria-live="polite" className="det-live-eta">
              {formatCountdown(movement.eta.minutes)}
            </span>
          }
          sub={movement.eta.at === null ? 'ETA unavailable' : `~${formatClock(movement.eta.at)}`}
        />
        <Stat label="Runway" value={runway.label} sub={runway.short} />
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
            telemetry.track === null
              ? 'track unavailable'
              : `track ${Math.round(telemetry.track)}° ${compassPoint(telemetry.track)}`
          }
        />
        <Stat
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
          label="Callsign"
          value={aircraft.callsign ?? 'Not transmitting'}
          sub={aircraft.operator ?? 'operator unknown'}
        />
        <Stat
          label="Altitude"
          value={formatAltitude(aircraft.altitude, aircraft.onGround, settings.units)}
          sub={aircraft.onGround ? 'on the ground' : 'barometric'}
        />
        <Stat
          label="Ground speed"
          value={formatSpeed(aircraft.groundSpeed, settings.units)}
          sub={aircraft.track === null ? 'track unavailable' : `tracking ${compassPoint(aircraft.track)}`}
        />
        <Stat
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

function AirframeBlock(p: { airframe: AircraftDetail['airframe'] }): ReactElement {
  const { airframe } = p;
  return (
    <section className="det-section">
      <SectionHead>Airframe</SectionHead>
      <div className="det-facts">
        <Stat label="Operator" value={airframe.operator ?? UNKNOWN} sub="fleet reference" />
        <Stat
          label="Registration"
          value={airframe.registration ?? UNKNOWN}
          sub={`hex ${airframe.hex.toUpperCase()}`}
        />
        <Stat label="MSN" value={airframe.msn ?? UNKNOWN} sub="serial number" />
        <Stat
          label="Delivered"
          value={airframe.deliveredYear ?? UNKNOWN}
          sub={airframe.deliveredYear === null ? 'year unknown' : 'first flown / handed over'}
        />
        <Stat
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
  const operator =
    movement?.airline.name ?? airframe?.operator ?? detail?.global?.operator ?? null;
  const title = movement
    ? flightTitle(movement)
    : (detail?.global?.callsign ?? registration ?? hex.toUpperCase());

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
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
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
            <p className="det-head-operator">{operator ?? 'Operator unknown'}</p>
            <h2 className="det-head-title app-numeric" id={titleId}>
              {title}
            </h2>
            <p className="det-head-reg">
              {registration ? (
                <span className="det-head-reg-value app-numeric">{registration}</span>
              ) : (
                <span className="det-head-reg-none">Registration unknown</span>
              )}
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

        <footer className="det-actions">
          <button type="button" className="det-action" onClick={onShowMap}>
            <Icon name="map" size={18} />
            Show on map
          </button>
        </footer>
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
