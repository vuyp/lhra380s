/**
 * MovementLog — what actually happened at Heathrow today.
 *
 * This is a record of observation, not a schedule. Every row here is an A380 the poller
 * genuinely watched touch down or roll. Nothing is backfilled, so the empty state says so
 * plainly rather than implying the day was quiet.
 *
 * Rendering discipline:
 *  - grouping is memoised on the log array, so a snapshot with identical content is free
 *  - rows are memoised on the fields they actually paint, so the 5-second snapshot refresh
 *    does not repaint the list just because object identities changed
 *  - only rows inside the last hour subscribe to the ticking clock for their "14 min ago"
 *    stamp; the rest render a fixed wall-clock time and never re-render on a tick
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { LoggedMovement } from '../../../../shared/types.ts';
import { useNow } from '../../api/useSnapshot.ts';
import { EmptyState } from '../../components/ui/EmptyState.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import { formatClock, formatRelative } from '../../lib/format.ts';
import { useSelection } from '../../state/selection.tsx';
import './MovementLog.css';

const LONDON = 'Europe/London';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** How far back the "load earlier" control reaches. */
const EXTENDED_HOURS = 48;

/* ---- London calendar helpers ---------------------------------------------------- */

const dayPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dayLabelFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const hourPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  hour: '2-digit',
  hourCycle: 'h23',
});

/**
 * A sortable `YYYY-MM-DD` key for the London calendar day a timestamp falls in.
 * Shared with the world-fleet view so "seen at Heathrow today" means the same thing there.
 */
export function londonDayKey(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return 'unknown';
  let year = '';
  let month = '';
  let day = '';
  for (const part of dayPartsFormatter.formatToParts(date)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/** Two-digit London hour, e.g. "07" — the grouping key inside a day. */
function londonHour(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '--';
  for (const part of hourPartsFormatter.formatToParts(date)) {
    if (part.type === 'hour') return part.value.padStart(2, '0');
  }
  return '--';
}

function dayLabel(key: string, sampleTs: number, now: number): string {
  const todayKey = londonDayKey(now);
  if (key === todayKey) return 'Today';
  const yesterdayKey = londonDayKey(now - DAY_MS);
  if (key === yesterdayKey && yesterdayKey !== todayKey) return 'Yesterday';
  return dayLabelFormatter.format(new Date(sampleTs));
}

/* ---- Grouping -------------------------------------------------------------------- */

interface HourGroup {
  key: string;
  label: string;
  rows: LoggedMovement[];
}

interface DayGroup {
  key: string;
  sampleTs: number;
  count: number;
  hours: HourGroup[];
}

/**
 * Newest first, throughout: days descend, hours descend inside a day, rows descend inside
 * an hour. The server already sorts newest-first; we sort anyway so a merged extended fetch
 * cannot disturb the order.
 */
function groupByDay(movements: LoggedMovement[]): DayGroup[] {
  const days = new Map<string, DayGroup>();

  const ordered = [...movements].sort((a, b) => b.at - a.at);

  for (const movement of ordered) {
    if (!Number.isFinite(movement.at)) continue;
    const key = londonDayKey(movement.at);
    let day = days.get(key);
    if (!day) {
      day = { key, sampleTs: movement.at, count: 0, hours: [] };
      days.set(key, day);
    }
    day.count += 1;

    const hourKey = londonHour(movement.at);
    const lastHour = day.hours.length > 0 ? day.hours[day.hours.length - 1] : undefined;
    if (lastHour && lastHour.key === hourKey) {
      lastHour.rows.push(movement);
    } else {
      day.hours.push({ key: hourKey, label: `${hourKey}:00`, rows: [movement] });
    }
  }

  return [...days.values()];
}

/* ---- Row --------------------------------------------------------------------------- */

function cityLabel(movement: LoggedMovement): string {
  const city = movement.city?.trim();
  if (city) return movement.kind === 'arrival' ? `from ${city}` : `to ${city}`;
  return movement.kind === 'arrival' ? 'Origin unknown' : 'Destination unknown';
}

function flightLabel(movement: LoggedMovement): string {
  return movement.flightNumber ?? movement.callsign ?? 'No callsign';
}

/** Ticks only for the handful of rows inside the last hour. */
function RecentStamp(p: { at: number }): ReactElement {
  const now = useNow(30_000);
  return <span className="log-ago">{formatRelative(p.at, now)}</span>;
}

interface LogRowProps {
  movement: LoggedMovement;
  /** Within the last hour — gets a live relative stamp instead of a static one. */
  recent: boolean;
  /** Livery or airframe note, when we hold one for this hex. */
  note: string | null;
  onSelect: (hex: string) => void;
}

function LogRowImpl(p: LogRowProps): ReactElement {
  const { movement, recent, note, onSelect } = p;
  const arrival = movement.kind === 'arrival';
  const clock = formatClock(movement.at);
  const city = cityLabel(movement);
  const flight = flightLabel(movement);
  const registration = movement.registration ?? 'Reg unknown';
  const runway = movement.runway;

  const label = [
    arrival ? 'Arrival' : 'Departure',
    flight,
    `at ${clock}`,
    registration,
    city,
    runway ? `runway ${runway}` : 'runway not recorded',
  ].join(', ');

  return (
    <li className="log-row">
      <button
        type="button"
        className="log-btn"
        style={{ '--log-accent': movement.operatorColor } as CSSProperties}
        onClick={() => onSelect(movement.id)}
        aria-label={label}
      >
        <time className="log-time app-numeric" dateTime={new Date(movement.at).toISOString()}>
          {clock}
        </time>

        <span className="log-body">
          <span className="log-primary">
            <Icon
              name={arrival ? 'arrival' : 'departure'}
              size={17}
              className={arrival ? 'log-glyph log-glyph--arrival' : 'log-glyph log-glyph--departure'}
            />
            <span className="log-flight">{flight}</span>
            <span className={movement.city ? 'log-city' : 'log-city log-city--unknown'}>{city}</span>
          </span>

          <span className="log-secondary">
            <span className={movement.registration ? 'log-reg' : 'log-reg log-reg--unknown'}>
              {registration}
            </span>
            <span className="log-op">{movement.operator}</span>
            {recent ? <RecentStamp at={movement.at} /> : null}
          </span>

          {note ? <span className="log-note">{note}</span> : null}
        </span>

        {runway ? (
          <span className="log-runway app-numeric">{runway}</span>
        ) : (
          <span className="log-runway log-runway--unknown" title="Runway not recorded">
            —
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * Compare the painted fields rather than object identity: every snapshot deserialises fresh
 * objects, and an unchanged movement must not cause a repaint.
 */
function sameRow(a: LogRowProps, b: LogRowProps): boolean {
  if (a.recent !== b.recent || a.note !== b.note || a.onSelect !== b.onSelect) return false;
  const x = a.movement;
  const y = b.movement;
  return (
    x.id === y.id &&
    x.at === y.at &&
    x.kind === y.kind &&
    x.callsign === y.callsign &&
    x.flightNumber === y.flightNumber &&
    x.registration === y.registration &&
    x.operator === y.operator &&
    x.operatorColor === y.operatorColor &&
    x.runway === y.runway &&
    x.city === y.city
  );
}

const LogRow = memo(LogRowImpl, sameRow);

/* ---- Extended history ------------------------------------------------------------- */

type LoadState = 'idle' | 'loading' | 'error' | 'loaded';

function isLoggedMovement(value: unknown): value is LoggedMovement {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LoggedMovement>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.at === 'number' &&
    Number.isFinite(candidate.at) &&
    (candidate.kind === 'arrival' || candidate.kind === 'departure') &&
    typeof candidate.operator === 'string' &&
    typeof candidate.operatorColor === 'string'
  );
}

/** One movement is one airframe at one instant in one direction. */
function rowKey(movement: LoggedMovement): string {
  return `${movement.id}:${movement.at}:${movement.kind}`;
}

/* ---- View ---------------------------------------------------------------------------- */

export function MovementLog(p: {
  log: LoggedMovement[];
  notesByHex: ReadonlyMap<string, string>;
}): ReactElement {
  const { log, notesByHex } = p;
  const { select } = useSelection();

  const [earlier, setEarlier] = useState<LoggedMovement[] | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const loadEarlier = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadState('loading');
    try {
      const response = await fetch(`/api/movements?hours=${EXTENDED_HOURS}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Server responded ${response.status}`);
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) throw new Error('Unexpected response');
      if (controller.signal.aborted) return;
      setEarlier(payload.filter(isLoggedMovement));
      setLoadState('loaded');
    } catch {
      if (controller.signal.aborted) return;
      setLoadState('error');
    }
  }, []);

  /**
   * The live log wins on collision — it is the freshest version of the same event — while the
   * fetched history supplies everything that has already aged out of the snapshot.
   */
  const movements = useMemo(() => {
    if (!earlier) return log;
    const merged = new Map<string, LoggedMovement>();
    for (const movement of earlier) merged.set(rowKey(movement), movement);
    for (const movement of log) merged.set(rowKey(movement), movement);
    return [...merged.values()].sort((a, b) => b.at - a.at);
  }, [log, earlier]);

  const days = useMemo(() => groupByDay(movements), [movements]);

  // A minute-resolution clock: enough to retire a row's live stamp, slow enough that the
  // memoised rows below simply skip the re-render.
  const now = useNow(60_000);
  const recentCutoff = now - HOUR_MS;

  if (movements.length === 0) {
    return (
      <div className="log">
        <EmptyState
          title="No movements logged yet"
          message={
            'Whale Watch builds this log live, from A380s it actually sees on ADS-B — it never ' +
            'backfills flights from before it started watching. The first whale to touch down or ' +
            'roll at Heathrow appears here within seconds of it happening.'
          }
          icon={<Icon name="fleet" size={26} />}
          action={
            loadState === 'loaded' ? null : (
              <button
                type="button"
                className="log-more-btn"
                onClick={() => void loadEarlier()}
                disabled={loadState === 'loading'}
              >
                {loadState === 'loading' ? 'Looking…' : 'Check the last 48 hours'}
              </button>
            )
          }
        />
        {loadState === 'error' ? (
          <p className="log-error" role="status">
            Could not reach the movement history. Check your connection and try again.
          </p>
        ) : null}
        {loadState === 'loaded' ? (
          <p className="log-more-note log-more-note--centred">
            Nothing in the last {EXTENDED_HOURS} hours either.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="log">
      <p className="app-visually-hidden" role="status" aria-live="polite">
        {movements.length === 1 ? '1 movement logged' : `${movements.length} movements logged`}
      </p>

      {days.map((day) => {
        const headingId = `log-day-${day.key}`;
        return (
          <section className="log-day-group" key={day.key} aria-labelledby={headingId}>
            <h3 className="log-day" id={headingId}>
              <span className="log-day-name">{dayLabel(day.key, day.sampleTs, now)}</span>
              <span className="log-day-count app-numeric">
                {day.count === 1 ? '1 movement' : `${day.count} movements`}
              </span>
            </h3>

            {day.hours.map((hour) => (
              <div className="log-hour" key={`${day.key}-${hour.key}`}>
                <h4 className="log-hour-label app-numeric">{hour.label}</h4>
                <ol className="log-rows">
                  {hour.rows.map((movement) => (
                    <LogRow
                      key={rowKey(movement)}
                      movement={movement}
                      recent={movement.at >= recentCutoff}
                      note={notesByHex.get(movement.id.toLowerCase()) ?? null}
                      onSelect={select}
                    />
                  ))}
                </ol>
              </div>
            ))}
          </section>
        );
      })}

      <div className="log-more">
        {loadState === 'loaded' ? (
          <p className="log-more-note">
            Showing everything observed in the last {EXTENDED_HOURS} hours.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="log-more-btn"
              onClick={() => void loadEarlier()}
              disabled={loadState === 'loading'}
            >
              {loadState === 'loading' ? 'Loading earlier…' : 'Load earlier'}
            </button>
            <p className="log-more-note">
              {loadState === 'error'
                ? 'Could not reach the movement history. Tap to try again.'
                : `Reaches back ${EXTENDED_HOURS} hours.`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
