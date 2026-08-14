/**
 * WorldFleet — every A380 in the air, right now, anywhere.
 *
 * The reference half of the Fleet tab. It exists to make the scale of the type legible
 * ("37 superjumbos airborne worldwide right now") and to let a spotter find a specific
 * airframe by registration, callsign or operator.
 *
 * Two markers earn their place: an airframe with a live Heathrow relationship, and one whose
 * registration already appears in today's log. Both are cross-referenced from the snapshot —
 * neither is inferred.
 *
 * Rows are memoised on the fields they paint so the five-second snapshot refresh repaints
 * only the aircraft whose numbers actually moved.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { GlobalAircraft, LoggedMovement } from '../../../../shared/types.ts';
import { EmptyState } from '../../components/ui/EmptyState.tsx';
import { Chip } from '../../components/ui/Chip.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import { formatAltitude, formatSpeed } from '../../lib/format.ts';
import { useSelection } from '../../state/selection.tsx';
import { useSettings } from '../../state/settings.tsx';
import { londonDayKey } from './MovementLog.tsx';
import './WorldFleet.css';

/** Long enough that typing does not thrash the filter, short enough to feel instant. */
const SEARCH_DEBOUNCE_MS = 200;

const UNKNOWN_OPERATOR = 'Operator unknown';

type Units = 'metric' | 'imperial';

/* ---- Grouping ---------------------------------------------------------------------- */

interface OperatorGroup {
  key: string;
  operator: string;
  /** False for the catch-all group, which sorts last and reads differently. */
  known: boolean;
  aircraft: GlobalAircraft[];
}

function normalise(value: string | null): string {
  return value ? value.trim().toLowerCase() : '';
}

function matches(aircraft: GlobalAircraft, query: string): boolean {
  if (query === '') return true;
  return (
    normalise(aircraft.registration).includes(query) ||
    normalise(aircraft.callsign).includes(query) ||
    normalise(aircraft.operator).includes(query) ||
    normalise(aircraft.hex).includes(query)
  );
}

/** Registration ascending, nulls last, hex as the tie-break so the order never wobbles. */
function byRegistration(a: GlobalAircraft, b: GlobalAircraft): number {
  const left = a.registration ?? '';
  const right = b.registration ?? '';
  if (left && right && left !== right) return left.localeCompare(right, 'en');
  if (left && !right) return -1;
  if (!left && right) return 1;
  return a.hex.localeCompare(b.hex, 'en');
}

function groupByOperator(aircraft: GlobalAircraft[]): OperatorGroup[] {
  const groups = new Map<string, OperatorGroup>();

  for (const item of aircraft) {
    const name = item.operator?.trim();
    // Namespaced keys so a carrier literally called "unknown" cannot fall into the catch-all.
    const key = name ? `named:${name.toLowerCase()}` : 'unnamed';
    let group = groups.get(key);
    if (!group) {
      group = { key, operator: name ?? UNKNOWN_OPERATOR, known: Boolean(name), aircraft: [] };
      groups.set(key, group);
    }
    group.aircraft.push(item);
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.known !== b.known) return a.known ? -1 : 1;
    return a.operator.localeCompare(b.operator, 'en');
  });

  for (const group of ordered) group.aircraft.sort(byRegistration);
  return ordered;
}

/* ---- Row ----------------------------------------------------------------------------- */

interface FleetRowProps {
  aircraft: GlobalAircraft;
  units: Units;
  /** Currently arriving at, sitting on, or departing from Heathrow. */
  atHeathrow: boolean;
  /** This registration appears in today's Heathrow log. */
  seenToday: boolean;
  /** Livery or airframe note, where the reference data holds one. */
  note: string | null;
  onSelect: (hex: string) => void;
}

function FleetRowImpl(p: FleetRowProps): ReactElement {
  const { aircraft, units, atHeathrow, seenToday, note, onSelect } = p;

  const callsign = aircraft.callsign?.trim() ?? '';
  const registration = aircraft.registration?.trim() ?? '';
  const altitude = formatAltitude(aircraft.altitude, aircraft.onGround, units);
  const speed = formatSpeed(aircraft.groundSpeed, units);

  const label = [
    registration || `Hex ${aircraft.hex.toUpperCase()}`,
    callsign ? `callsign ${callsign}` : 'no callsign',
    aircraft.operator ?? UNKNOWN_OPERATOR,
    altitude,
    aircraft.onGround ? '' : `ground speed ${speed}`,
    atHeathrow ? 'currently at Heathrow' : seenToday ? 'seen at Heathrow today' : '',
  ]
    .filter((part) => part !== '')
    .join(', ');

  const showMeta = atHeathrow || seenToday || note !== null;

  return (
    <li className="world-row">
      <button type="button" className="world-btn" onClick={() => onSelect(aircraft.hex)} aria-label={label}>
        <span className="world-ident">
          <span className={registration ? 'world-reg' : 'world-reg world-reg--unknown'}>
            {registration || aircraft.hex.toUpperCase()}
          </span>
          <span className={callsign ? 'world-call' : 'world-call world-call--unknown'}>
            {callsign || 'No callsign'}
          </span>
        </span>

        <span className="world-tele app-numeric">
          <span className="world-tele-alt">{altitude}</span>
          <span className="world-tele-speed">{aircraft.onGround ? '—' : speed}</span>
        </span>

        {showMeta ? (
          <span className="world-meta">
            {atHeathrow ? (
              <Chip tone="live" size="sm">
                At Heathrow
              </Chip>
            ) : seenToday ? (
              <Chip tone="arrival" size="sm">
                Seen today
              </Chip>
            ) : null}
            {note ? <span className="world-note">{note}</span> : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function sameFleetRow(a: FleetRowProps, b: FleetRowProps): boolean {
  if (
    a.units !== b.units ||
    a.atHeathrow !== b.atHeathrow ||
    a.seenToday !== b.seenToday ||
    a.note !== b.note ||
    a.onSelect !== b.onSelect
  ) {
    return false;
  }
  const x = a.aircraft;
  const y = b.aircraft;
  return (
    x.hex === y.hex &&
    x.callsign === y.callsign &&
    x.registration === y.registration &&
    x.operator === y.operator &&
    x.altitude === y.altitude &&
    x.groundSpeed === y.groundSpeed &&
    x.onGround === y.onGround
  );
}

const FleetRow = memo(FleetRowImpl, sameFleetRow);

/* ---- Group block ----------------------------------------------------------------------- */

function GroupBlock(p: {
  group: OperatorGroup;
  units: Units;
  lhrHexes: ReadonlySet<string>;
  seenTodayHexes: ReadonlySet<string>;
  seenTodayRegs: ReadonlySet<string>;
  notesByHex: ReadonlyMap<string, string>;
  onSelect: (hex: string) => void;
}): ReactElement {
  const { group, units, lhrHexes, seenTodayHexes, seenTodayRegs, notesByHex, onSelect } = p;
  const headingId = `world-op-${group.key.replace(/[^a-z0-9]+/gi, '-')}`;

  return (
    <section className="world-group" aria-labelledby={headingId}>
      <h4 className="world-group-head" id={headingId}>
        <span className={group.known ? 'world-op' : 'world-op world-op--unknown'}>
          {group.operator}
        </span>
        <span className="world-op-count app-numeric">{group.aircraft.length}</span>
      </h4>

      <ul className="world-rows">
        {group.aircraft.map((aircraft) => {
          const hex = aircraft.hex.toLowerCase();
          const registration = aircraft.registration?.trim().toUpperCase() ?? '';
          return (
            <FleetRow
              key={aircraft.hex}
              aircraft={aircraft}
              units={units}
              atHeathrow={lhrHexes.has(hex)}
              seenToday={
                seenTodayHexes.has(hex) || (registration !== '' && seenTodayRegs.has(registration))
              }
              note={notesByHex.get(hex) ?? null}
              onSelect={onSelect}
            />
          );
        })}
      </ul>
    </section>
  );
}

/* ---- View --------------------------------------------------------------------------------- */

export function WorldFleet(p: {
  aircraft: GlobalAircraft[];
  log: LoggedMovement[];
  lhrHexes: ReadonlySet<string>;
  notesByHex: ReadonlyMap<string, string>;
}): ReactElement {
  const { aircraft, log, lhrHexes, notesByHex } = p;
  const { select } = useSelection();
  const { settings } = useSettings();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const term = debounced.trim().toLowerCase();

  /** Which airframes have already been at Heathrow today, by hex and by registration. */
  const seenToday = useMemo(() => {
    const hexes = new Set<string>();
    const regs = new Set<string>();
    const today = londonDayKey(Date.now());
    for (const movement of log) {
      if (londonDayKey(movement.at) !== today) continue;
      hexes.add(movement.id.toLowerCase());
      const registration = movement.registration?.trim().toUpperCase();
      if (registration) regs.add(registration);
    }
    return { hexes, regs };
  }, [log]);

  const airborneCount = useMemo(
    () => aircraft.reduce((total, item) => (item.onGround ? total : total + 1), 0),
    [aircraft],
  );
  const groundCount = aircraft.length - airborneCount;

  const filtered = useMemo(
    () => aircraft.filter((item) => matches(item, term)),
    [aircraft, term],
  );

  const airborneGroups = useMemo(
    () => groupByOperator(filtered.filter((item) => !item.onGround)),
    [filtered],
  );
  const groundGroups = useMemo(
    () => groupByOperator(filtered.filter((item) => item.onGround)),
    [filtered],
  );

  const searchActive = term !== '';
  const nothingAtAll = aircraft.length === 0;
  const noMatches = !nothingAtAll && filtered.length === 0;

  return (
    <div className="world">
      {/* Suppressed when the feed is empty: the empty state below says it better. */}
      {nothingAtAll ? null : (
        <div className="world-lede">
          <p className="world-headline" aria-live="polite">
            {airborneCount === 0 ? (
              'Not one A380 is airborne anywhere in the world right now'
            ) : (
              <>
                <strong className="world-headline-count app-numeric">{airborneCount}</strong>{' '}
                {airborneCount === 1
                  ? 'superjumbo airborne worldwide right now'
                  : 'superjumbos airborne worldwide right now'}
              </>
            )}
          </p>
          <p className="world-sub">
            {groundCount === 0
              ? 'Every A380 the network can see is in the air.'
              : groundCount === 1
                ? '1 more is on the ground with its transponder on.'
                : `${groundCount} more are on the ground with their transponders on.`}
          </p>
        </div>
      )}

      <div className="world-search">
        <label className="app-visually-hidden" htmlFor="world-search-input">
          Search the world fleet by registration, callsign or operator
        </label>
        <span className="world-search-field">
          <Icon name="binoculars" size={18} className="world-search-icon" />
          <input
            id="world-search-input"
            className="world-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Registration, callsign or airline"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
          />
          {query !== '' ? (
            <button
              type="button"
              className="world-clear"
              onClick={() => setQuery('')}
              aria-label="Clear the search"
            >
              <Icon name="close" size={16} />
            </button>
          ) : null}
        </span>
        <p className="app-visually-hidden" role="status" aria-live="polite">
          {searchActive
            ? filtered.length === 1
              ? '1 aircraft matches'
              : `${filtered.length} aircraft match`
            : ''}
        </p>
      </div>

      {nothingAtAll ? (
        <EmptyState
          title="No A380s in the feed"
          message={
            'The global feed is not reporting a single A380 right now. That usually means an ' +
            'upstream outage rather than an empty sky — the list refills the moment data returns.'
          }
          icon={<Icon name="fleet" size={26} />}
        />
      ) : noMatches ? (
        <EmptyState
          title={`Nothing matches “${debounced.trim()}”`}
          message="Try a partial registration like “A6-”, an airline name, or a callsign such as “UAE”."
          icon={<Icon name="binoculars" size={26} />}
          action={
            <button type="button" className="world-reset" onClick={() => setQuery('')}>
              Clear the search
            </button>
          }
        />
      ) : (
        <>
          {airborneGroups.length > 0 ? (
            <div className="world-section">
              {airborneGroups.map((group) => (
                <GroupBlock
                  key={group.key}
                  group={group}
                  units={settings.units}
                  lhrHexes={lhrHexes}
                  seenTodayHexes={seenToday.hexes}
                  seenTodayRegs={seenToday.regs}
                  notesByHex={notesByHex}
                  onSelect={select}
                />
              ))}
            </div>
          ) : null}

          {groundGroups.length > 0 ? (
            <div className="world-section world-section--ground">
              <h3 className="world-section-head">
                On the ground
                <span className="world-section-note">Parked or taxiing, transponder live</span>
              </h3>
              {groundGroups.map((group) => (
                <GroupBlock
                  key={group.key}
                  group={group}
                  units={settings.units}
                  lhrHexes={lhrHexes}
                  seenTodayHexes={seenToday.hexes}
                  seenTodayRegs={seenToday.regs}
                  notesByHex={notesByHex}
                  onSelect={select}
                />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
