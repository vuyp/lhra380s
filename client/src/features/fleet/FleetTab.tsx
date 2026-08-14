/**
 * FleetTab — the reference and the memory of the app.
 *
 * Two views behind one switch: what Heathrow has actually seen today, and what the whole A380
 * fleet is doing right now. The stats row above them is the day in four numbers and stays put
 * whichever view is open, so switching never feels like leaving the page.
 *
 * The cross-reference sets built here are the reason the two views know about each other: the
 * world list can mark an airframe as being at Heathrow, and the log can surface the livery note
 * we hold for that hex. All of it comes from the snapshot — nothing is inferred or invented.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Snapshot } from '../../../../shared/types.ts';
import { useSnapshot } from '../../api/useSnapshot.ts';
import { Segmented } from '../../components/ui/Segmented.tsx';
import { Skeleton } from '../../components/ui/Skeleton.tsx';
import { Stat } from '../../components/ui/Stat.tsx';
import { useRouteDetail } from '../../state/route.ts';
import { MovementLog } from './MovementLog.tsx';
import { WorldFleet } from './WorldFleet.tsx';
import './FleetTab.css';

type FleetView = 'log' | 'world';

const VIEWS: Array<{ value: FleetView; label: string }> = [
  { value: 'log', label: "Today's log" },
  { value: 'world', label: 'World fleet' },
];

function isFleetView(value: string | null): value is FleetView {
  return value === 'log' || value === 'world';
}

const counter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

function count(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? counter.format(value) : '—';
}

/* ---- Cross-references ---------------------------------------------------------------- */

/** Every hex with a live Heathrow relationship: inbound, on stand, or rolling. */
function heathrowHexes(snapshot: Snapshot): Set<string> {
  const hexes = new Set<string>();
  for (const movement of snapshot.arrivals) hexes.add(movement.id.toLowerCase());
  for (const movement of snapshot.departures) hexes.add(movement.id.toLowerCase());
  for (const movement of snapshot.ground) hexes.add(movement.id.toLowerCase());
  return hexes;
}

/**
 * Livery and airframe notes, keyed by hex. Only airframes currently in the Heathrow lists carry
 * reference data on the wire, so this map is deliberately partial — a row without an entry
 * simply shows no note rather than a guess.
 */
function airframeNotes(snapshot: Snapshot): Map<string, string> {
  const notes = new Map<string, string>();
  for (const movement of [...snapshot.arrivals, ...snapshot.departures, ...snapshot.ground]) {
    const note = movement.airframe.note?.trim();
    if (note) notes.set(movement.airframe.hex.toLowerCase(), note);
  }
  return notes;
}

/* ---- Loading ---------------------------------------------------------------------------- */

function FleetSkeleton(): ReactElement {
  return (
    <div className="fleet" aria-hidden="true">
      <div className="fleet-stats">
        {[0, 1, 2, 3].map((slot) => (
          <div className="fleet-stat" key={slot}>
            <Skeleton height={11} width="70%" />
            <Skeleton height={23} width="45%" />
          </div>
        ))}
      </div>
      <Skeleton height={44} radius="var(--radius-full)" />
      <Skeleton height={18} width="38%" />
      <Skeleton height={64} radius="var(--radius-md)" />
      <Skeleton height={64} radius="var(--radius-md)" />
      <Skeleton height={64} radius="var(--radius-md)" />
    </div>
  );
}

/* ---- Tab ---------------------------------------------------------------------------------- */

export function FleetTab(): ReactElement {
  const { snapshot } = useSnapshot();
  // `#fleet/world` opens the world fleet directly, so the airborne count elsewhere in the app can
  // be a link rather than a number the reader has to go hunting for.
  const routeView = useRouteDetail('fleet');
  const [chosen, setChosen] = useState<FleetView | null>(null);

  useEffect(() => {
    if (isFleetView(routeView)) setChosen(routeView);
  }, [routeView]);

  /*
   * Which view opens by default is decided once, on the first snapshot, and then left alone.
   * The movement log is the better landing place when there is something in it, and it is empty
   * for most of the early morning and after every restart — sending a first-time reader to a
   * blank list hides the thing this tab is best at. Freezing the choice matters as much as
   * making it: recomputing would swap the view under someone the moment the first whale landed.
   */
  const defaultView = useRef<FleetView | null>(null);
  if (snapshot && defaultView.current === null) {
    defaultView.current = snapshot.log.length === 0 ? 'world' : 'log';
  }
  const view = chosen ?? defaultView.current ?? 'log';

  const lhrHexes = useMemo(
    () => (snapshot ? heathrowHexes(snapshot) : new Set<string>()),
    [snapshot],
  );
  const notesByHex = useMemo(
    () => (snapshot ? airframeNotes(snapshot) : new Map<string, string>()),
    [snapshot],
  );

  if (!snapshot) {
    return (
      <>
        <p className="app-visually-hidden" role="status">
          Loading the Heathrow movement log and the world A380 fleet
        </p>
        <FleetSkeleton />
      </>
    );
  }

  const { stats } = snapshot;

  return (
    <div className="fleet">
      <section className="fleet-stats" aria-label="Heathrow A380 activity today">
        <div className="fleet-stat">
          <Stat label="Arrivals today" value={count(stats.arrivalsToday)} sub="observed at LHR" />
        </div>
        <div className="fleet-stat">
          <Stat
            label="Departures today"
            value={count(stats.departuresToday)}
            sub="observed at LHR"
          />
        </div>
        <div className="fleet-stat">
          <Stat
            label="Airframes today"
            value={count(stats.airframesToday)}
            sub="distinct registrations"
          />
        </div>
        <div className="fleet-stat">
          <Stat
            label="Airborne now"
            value={count(stats.airborneWorldwide)}
            sub="A380s worldwide"
          />
        </div>
      </section>

      <div className="fleet-switch">
        <Segmented
          options={VIEWS}
          value={view}
          onChange={(next) => setChosen(next)}
          ariaLabel="Choose a fleet view"
        />
      </div>

      {view === 'log' ? (
        <MovementLog log={snapshot.log} notesByHex={notesByHex} />
      ) : (
        <WorldFleet
          aircraft={snapshot.worldwide}
          log={snapshot.log}
          lhrHexes={lhrHexes}
          notesByHex={notesByHex}
        />
      )}
    </div>
  );
}
