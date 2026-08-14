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

  // A real ETA wins; then the closest; then anything still flying. The final fallback is only
  // reached when the arrivals list holds nothing airborne at all, which the server's own
  // `kindForPhase` makes rare — landed and parked aircraft go to the ground list, not this one.
  return soonest ?? closest ?? anyAirborne ?? arrivals[0] ?? null;
}

/** How long a whale that has just touched down stays in the hero before it gives way. */
const JUST_LANDED_MS = 2 * 60_000;

/**
 * The whale that landed a moment ago.
 *
 * Someone who has just watched one come over the fence wants the hero to say "Touched down 20:01
 * · 27L" for a minute or two, not to blank straight to the idle panel. The arrivals list cannot
 * supply this — a landed aircraft is `ground` on the wire — so the hero is handed one from there.
 */
function pickJustLanded(ground: Movement[], now: number): Movement | null {
  let best: Movement | null = null;
  for (const movement of ground) {
    if (movement.phase !== 'landed') continue;
    const at = movement.actualAt;
    if (at === null || !Number.isFinite(at)) continue;
    if (at > now || now - at > JUST_LANDED_MS) continue;
    if (best === null || at > (best.actualAt ?? 0)) best = movement;
  }
  return best;
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
        <p className="board-none">
          <Icon name={icon} size={16} className="board-none-icon" />
          <span>{empty}</span>
        </p>
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
  const { snapshot, connected, lastUpdate, fromCache } = useSnapshot();
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('all');

  const arrivals = snapshot?.arrivals ?? null;
  const ground = snapshot?.ground ?? null;
  const announcement = useArrivalAnnouncement(arrivals);
  // Coarse, so the "just landed" window expires without re-running this every second.
  const landedBucket = Math.floor(now / 10_000);
  const next = useMemo(() => {
    const inbound = arrivals ? pickNextWhale(arrivals) : null;
    if (inbound) return inbound;
    return ground ? pickJustLanded(ground, landedBucket * 10_000) : null;
  }, [arrivals, ground, landedBucket]);

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
  // A dropped browser stream is not a quiet Heathrow feed. Blaming the upstream poller for this
  // device's reconnect told the reader the wrong thing about the wrong system.
  const feedQuiet = snapshot.health.stale;
  const reconnecting = !connected && !feedQuiet && !fromCache;

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
        {feedQuiet ? (
          <Chip tone="warn" size="sm" title="Positions are held until the Heathrow feed recovers">
            {snapshot.health.lastPollAt === null
              ? 'Feed unavailable'
              : `Feed quiet · last data ${formatClock(snapshot.health.lastPollAt)}`}
          </Chip>
        ) : fromCache ? (
          <Chip
            tone="warn"
            size="sm"
            title="The server cannot be reached; this is the copy your browser saved"
          >
            Offline · cached from {formatClock(lastUpdate ?? snapshot.ts)}
          </Chip>
        ) : reconnecting ? (
          <Chip
            tone="warn"
            size="sm"
            title="This device lost the live stream; the data below is the last update it received"
          >
            Reconnecting · last update {formatClock(lastUpdate ?? snapshot.ts)}
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
          empty="Nothing inbound. Arrivals appear here the moment an A380 turns for London — nothing on this board is scheduled or guessed."
        />
      ) : null}

      {showDepartures ? (
        <Section
          title="Departures"
          icon="departure"
          tone="departure"
          movements={snapshot.departures}
          now={now}
          empty="Nothing pushing back or rolling. Departures appear once an A380 starts moving on the ground at Heathrow."
        />
      ) : null}

      {filter === 'all' ? (
        <Section
          title="On the ground at Heathrow"
          icon="fleet"
          tone="neutral"
          movements={snapshot.ground}
          now={now}
          empty="No A380 is parked at Heathrow right now — none of the fleet is on a stand or taxiing."
        />
      ) : null}
    </div>
  );
}
