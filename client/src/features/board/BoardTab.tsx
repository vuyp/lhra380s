/**
 * BoardTab — the front page.
 *
 * Hero first, then arrivals, departures and the frames parked at Heathrow. Server order is
 * preserved exactly: the sequencing the poller produces is the sequencing the fence sees.
 * Every count can legitimately be zero at 04:00, and the screen is designed for that case
 * rather than apologising for it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Movement } from '../../../../shared/types.ts';
import { useNow, useSnapshot } from '../../api/useSnapshot.ts';
import { Chip } from '../../components/ui/Chip.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import type { IconName } from '../../components/ui/Icon.tsx';
import { Segmented } from '../../components/ui/Segmented.tsx';
import { Skeleton } from '../../components/ui/Skeleton.tsx';
import { formatClock, formatCountdown } from '../../lib/format.ts';
import { MovementCard, flightTitle, placeLabel } from './MovementCard.tsx';
import { NextWhale } from './NextWhale.tsx';
import './BoardTab.css';

type Filter = 'all' | 'arrivals' | 'departures';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'arrivals', label: 'Arrivals' },
  { value: 'departures', label: 'Departures' },
];

/**
 * The most imminent arrival: the soonest predicted touchdown among the flights still in the
 * air. A flight with no usable ETA still qualifies — it is ranked by distance instead, and the
 * hero shows an honest dash rather than pretending to know.
 */
function pickNextWhale(arrivals: Movement[]): Movement | null {
  let soonest: Movement | null = null;
  let soonestAt = Number.POSITIVE_INFINITY;
  let closest: Movement | null = null;
  let closestNm = Number.POSITIVE_INFINITY;
  let anyAirborne: Movement | null = null;

  for (const movement of arrivals) {
    if (movement.phase !== 'inbound' && movement.phase !== 'approach') continue;
    anyAirborne ??= movement;

    const at = movement.eta.at;
    if (at !== null && Number.isFinite(at)) {
      if (at < soonestAt) {
        soonestAt = at;
        soonest = movement;
      }
      continue;
    }

    const distance = movement.distanceNm;
    if (distance !== null && Number.isFinite(distance) && distance < closestNm) {
      closestNm = distance;
      closest = movement;
    }
  }

  // A real ETA wins; then the closest; then anything still flying; then whatever the server
  // put first, which will be a flight that has just landed.
  return soonest ?? closest ?? anyAirborne ?? arrivals[0] ?? null;
}

function describeNewArrival(movement: Movement): string {
  const origin = placeLabel(movement.route.origin);
  const when =
    movement.eta.minutes !== null ? `, ${formatCountdown(movement.eta.minutes)} out` : '';
  return `${flightTitle(movement)}${origin ? ` from ${origin}` : ''} is now inbound${when}`;
}

/** Announces arrivals that were not on the previous frame. Silent on the first snapshot. */
function useArrivalAnnouncement(arrivals: Movement[] | null): string {
  const knownRef = useRef<Set<string> | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!arrivals) return;
    const ids = new Set(arrivals.map((movement) => movement.id));
    const known = knownRef.current;
    knownRef.current = ids;
    if (!known) return;

    const fresh = arrivals.filter((movement) => !known.has(movement.id));
    if (fresh.length === 0) return;
    setMessage(fresh.map(describeNewArrival).join('. '));
  }, [arrivals]);

  return message;
}

/* ---- Sections ------------------------------------------------------------------ */

function Section(p: {
  title: string;
  icon: IconName;
  movements: Movement[];
  now: number;
  empty: string;
  tone: 'arrival' | 'departure' | 'neutral';
}): ReactElement {
  const { title, icon, movements, now, empty, tone } = p;
  const headingId = `board-section-${title.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <section className="board-section" aria-labelledby={headingId}>
      <h2 className={`board-head board-head--${tone}`} id={headingId}>
        <span className="board-head-title">
          <Icon name={icon} size={18} className="board-head-icon" />
          {title}
        </span>
        <span className="board-count app-numeric">{movements.length}</span>
      </h2>

      {movements.length === 0 ? (
        <p className="board-none">{empty}</p>
      ) : (
        <ul className="board-list">
          {movements.map((movement) => (
            <MovementCard key={movement.id} movement={movement} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BoardSkeleton(): ReactElement {
  return (
    <div className="board" aria-hidden="true">
      <Skeleton height={232} radius="var(--radius-xl)" />
      <Skeleton height={44} radius="var(--radius-full)" />
      <Skeleton height={26} width="42%" />
      <Skeleton height={168} radius="var(--radius-lg)" />
      <Skeleton height={168} radius="var(--radius-lg)" />
    </div>
  );
}

/* ---- Tab ------------------------------------------------------------------------ */

export function BoardTab(): ReactElement {
  const { snapshot, connected, lastUpdate } = useSnapshot();
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('all');

  const arrivals = snapshot?.arrivals ?? null;
  const announcement = useArrivalAnnouncement(arrivals);
  const next = useMemo(() => (arrivals ? pickNextWhale(arrivals) : null), [arrivals]);

  if (!snapshot) {
    return (
      <>
        <p className="app-visually-hidden" role="status">
          Loading the Heathrow A380 board
        </p>
        <BoardSkeleton />
      </>
    );
  }

  const showArrivals = filter === 'all' || filter === 'arrivals';
  const showDepartures = filter === 'all' || filter === 'departures';
  const feedTrouble = !connected || snapshot.health.stale;

  return (
    <div className="board">
      <NextWhale movement={next} snapshot={snapshot} now={now} />

      <div className="board-controls">
        <Segmented
          options={FILTERS}
          value={filter}
          onChange={setFilter}
          ariaLabel="Filter the board"
        />
        {feedTrouble ? (
          <Chip tone="warn" size="sm" title="Positions are held until the feed recovers">
            {snapshot.health.lastPollAt === null
              ? 'Feed unavailable'
              : `Feed quiet · last data ${formatClock(snapshot.health.lastPollAt)}`}
          </Chip>
        ) : (
          <span className="board-updated app-numeric">
            Updated {formatClock(lastUpdate ?? snapshot.ts)}
          </span>
        )}
      </div>

      <p className="app-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      {showArrivals ? (
        <Section
          title="Arrivals"
          icon="arrival"
          tone="arrival"
          movements={snapshot.arrivals}
          now={now}
          empty="No A380 is inbound to Heathrow at the moment. The board fills itself the moment one turns for London — nothing here is scheduled or guessed."
        />
      ) : null}

      {showDepartures ? (
        <Section
          title="Departures"
          icon="departure"
          tone="departure"
          movements={snapshot.departures}
          now={now}
          empty="Nothing pushing back or rolling right now. Departures appear once an A380 starts moving at Heathrow."
        />
      ) : null}

      {filter === 'all' ? (
        <Section
          title="On the ground at Heathrow"
          icon="fleet"
          tone="neutral"
          movements={snapshot.ground}
          now={now}
          empty="No A380 is parked at Heathrow right now."
        />
      ) : null}
    </div>
  );
}
