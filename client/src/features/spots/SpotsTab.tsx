/**
 * SpotsTab — where to stand, right now.
 *
 * The server does the ranking: /api/spots returns the locations already scored and sorted for
 * the live runway configuration, the sun and the wind. This tab's job is to explain that
 * ranking (so it can be trusted), to keep it fresh (every minute, and immediately when the
 * airport turns around), and to let a spotter standing on a verge sort by what is nearest —
 * but only ever after they have asked for that themselves.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { RunwayConfig, SpotEvaluation, Weather } from '../../../../shared/types.ts';
import { useNow, useSnapshot } from '../../api/useSnapshot.ts';
import { Chip } from '../../components/ui/Chip.tsx';
import { EmptyState } from '../../components/ui/EmptyState.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import { Segmented } from '../../components/ui/Segmented.tsx';
import { Skeleton } from '../../components/ui/Skeleton.tsx';
import { compassPoint, formatRelative, formatSpeed } from '../../lib/format.ts';
import { haversineKm, useGeolocation } from '../../lib/geo.ts';
import type { GeolocationState } from '../../lib/geo.ts';
import { useSettings } from '../../state/settings.tsx';
import { SpotCard } from './SpotCard.tsx';
import './SpotsTab.css';

type SortMode = 'best' | 'near';

const SORTS: Array<{ value: SortMode; label: string }> = [
  { value: 'best', label: 'Best now' },
  { value: 'near', label: 'Nearest' },
];

const REFRESH_MS = 60_000;

/** Cheap shape check — we never render a payload we cannot recognise. */
function isEvaluationList(value: unknown): value is SpotEvaluation[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Partial<SpotEvaluation>;
    if (typeof candidate.score !== 'number' || !Array.isArray(candidate.reasons)) return false;
    const spot = candidate.spot;
    if (typeof spot !== 'object' || spot === null) return false;
    return (
      typeof spot.id === 'string' &&
      typeof spot.name === 'string' &&
      typeof spot.lat === 'number' &&
      typeof spot.lon === 'number'
    );
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The spotting list could not be loaded';
}

/**
 * 'Nearest' is a blend, not a pure distance sort: a mediocre fence 200 m away should not beat
 * an excellent one a mile up the road when the whales are landing the other way.
 */
function proximityRank(evaluation: SpotEvaluation): number {
  const km = evaluation.distanceKm;
  if (km === undefined || !Number.isFinite(km)) return evaluation.score * 0.55;
  const closeness = Math.max(0, 1 - km / 20) * 100;
  return evaluation.score * 0.55 + closeness * 0.45;
}

function windSentence(weather: Weather | null, units: 'metric' | 'imperial'): string {
  if (!weather || weather.windSpeed === null) return 'Wind unavailable';
  if (weather.windSpeed === 0) return 'Wind calm';
  const from =
    weather.windDirection === null
      ? 'Variable'
      : `${compassPoint(weather.windDirection)} ${Math.round(weather.windDirection)}°`;
  const gust =
    weather.windGust !== null && weather.windGust > weather.windSpeed
      ? `, gusting ${formatSpeed(weather.windGust, units)}`
      : '';
  return `Wind ${from} at ${formatSpeed(weather.windSpeed, units)}${gust}`;
}

/**
 * The one line under the controls. Every geolocation outcome gets a real sentence — a refused
 * or missing permission is explained, never silently swallowed.
 */
function locationNote(state: GeolocationState, sort: SortMode, hasPosition: boolean): string {
  switch (state) {
    case 'denied':
      return 'Location permission was refused, so distances are off. Everything else still works — re-allow location for this site in your browser settings if you want the walk sorted for you.';
    case 'unavailable':
      return 'This device cannot share a location, so distances are not available. The ranking below is unaffected.';
    case 'asking':
      return 'Asking your device where you are…';
    default:
      break;
  }
  if (sort !== 'near') return '';
  if (!hasPosition) {
    return 'Turn on location to sort by how far you would have to walk. Until then this is still the best-now order.';
  }
  return 'Nearest blends the walk with how good the spot is right now, so a great fence a mile away still beats a poor one next door.';
}

function configUnconfirmed(config: RunwayConfig): boolean {
  return config.direction === 'unknown' || config.confidence < 0.5 || config.sampleSize === 0;
}

/* ---- Header ---------------------------------------------------------------------- */

function ConfigHeader(p: {
  config: RunwayConfig | null;
  weather: Weather | null;
  units: 'metric' | 'imperial';
  now: number;
}): ReactElement {
  const { config, weather, units, now } = p;

  if (!config) {
    return (
      <header className="spots-head">
        <p className="app-eyebrow">Where to stand right now</p>
        <h2 className="spots-config">Waiting for the live runway configuration</h2>
        <p className="spots-meta">
          The ranking below is the server's, but until the feed reports which way Heathrow is
          running we cannot tell you how current it is.
        </p>
      </header>
    );
  }

  const unconfirmed = configUnconfirmed(config);

  return (
    <header className="spots-head">
      <p className="app-eyebrow">Where to stand right now</p>
      <h2 className="spots-config" aria-live="polite">
        {config.summary}
      </h2>

      <div className="spots-facts">
        {config.landing.length > 0 ? (
          <Chip tone="arrival" size="sm" title="Runways in use for landings right now">
            {`Landing ${config.landing.join(' · ')}`}
          </Chip>
        ) : (
          <Chip size="sm">Landing runway unknown</Chip>
        )}
        {config.departing.length > 0 ? (
          <Chip tone="departure" size="sm" title="Runways in use for departures right now">
            {`Departing ${config.departing.join(' · ')}`}
          </Chip>
        ) : (
          <Chip size="sm">Departure runway unknown</Chip>
        )}
        {unconfirmed ? (
          <Chip tone="warn" size="sm" title="Not enough observed traffic to be certain">
            Unconfirmed
          </Chip>
        ) : null}
      </div>

      <p className="spots-meta app-numeric">
        {windSentence(weather, units)}
        {' · '}
        {config.sampleSize > 0
          ? `derived from ${config.sampleSize} aircraft`
          : 'no traffic observed yet'}
        {' · '}
        {`updated ${formatRelative(config.updatedAt, now)}`}
      </p>

      {unconfirmed ? (
        <p className="spots-warn">
          <Icon name="alert" size={16} />
          <span>
            Too little traffic to be sure which way Heathrow is running. Treat the order below as
            provisional and check the map before you set off.
          </span>
        </p>
      ) : null}

      <p className="spots-note">
        Heathrow swaps its landing runway during the day. This ranking follows the live
        configuration, never a published alternation schedule — it re-sorts itself the moment the
        airport turns around.
      </p>
    </header>
  );
}

/* ---- Loading ---------------------------------------------------------------------- */

function SpotsSkeleton(): ReactElement {
  return (
    <div className="spots-skeleton" aria-hidden="true">
      <Skeleton height={44} radius="var(--radius-full)" />
      {[0, 1, 2, 3, 4].map((key) => (
        <Skeleton key={key} height={132} radius="var(--radius-lg)" />
      ))}
    </div>
  );
}

/* ---- Tab ---------------------------------------------------------------------------- */

export function SpotsTab(): ReactElement {
  const { snapshot } = useSnapshot();
  const { settings } = useSettings();
  const now = useNow(30_000);

  const [evaluations, setEvaluations] = useState<SpotEvaluation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [sort, setSort] = useState<SortMode>('best');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());

  const config = snapshot?.runwayConfig ?? null;
  // Re-rank whenever the derived configuration moves on. updatedAt is the server's own stamp for
  // "this is a new derivation", so it is the honest trigger even if the runways came out the same.
  const configStamp = config ? `${config.updatedAt}` : 'none';

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();

    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/spots', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Server responded ${response.status}`);
        const payload: unknown = await response.json();
        if (!alive) return;
        if (!isEvaluationList(payload)) {
          throw new Error('The spots feed returned something we did not recognise');
        }
        setEvaluations(payload);
        setFetchedAt(Date.now());
        setError(null);
      } catch (caught) {
        if (!alive || controller.signal.aborted) return;
        setError(errorMessage(caught));
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, REFRESH_MS);

    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [configStamp, reloadToken]);

  /* Location is opt-in: the hook watches nothing until the control below is pressed. */
  const { position, state: geoState, request } = useGeolocation();

  const autoSorted = useRef(false);
  useEffect(() => {
    if (!position || autoSorted.current) return;
    autoSorted.current = true;
    setSort('near');
  }, [position]);

  const ranked = useMemo<SpotEvaluation[]>(() => {
    if (!evaluations) return [];
    const withDistance = position
      ? evaluations.map((evaluation) => ({
          ...evaluation,
          distanceKm: haversineKm(position, {
            lat: evaluation.spot.lat,
            lon: evaluation.spot.lon,
          }),
        }))
      : evaluations;

    // 'Best now' keeps the server's order exactly — it knows the scoring, we do not re-guess it.
    if (sort !== 'near' || !position) return withDistance;
    return [...withDistance].sort((a, b) => proximityRank(b) - proximityRank(a));
  }, [evaluations, position, sort]);

  const toggle = useCallback((id: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloadToken((token) => token + 1);
  }, []);

  if (loading && !evaluations) {
    return (
      <div className="spots">
        <p className="app-visually-hidden" role="status">
          Ranking the Heathrow spotting locations for the current conditions
        </p>
        <ConfigHeader
          config={config}
          weather={snapshot?.weather ?? null}
          units={settings.units}
          now={now}
        />
        <SpotsSkeleton />
      </div>
    );
  }

  if (!evaluations && error) {
    return (
      <div className="spots">
        <EmptyState
          icon={<Icon name="alert" size={24} />}
          title="The spotting list is unavailable"
          message={`${error}. Rather than show you a ranking we cannot stand behind, we are showing you nothing — try again in a moment.`}
          action={
            <button type="button" className="app-button" onClick={retry}>
              Try again
            </button>
          }
        />
      </div>
    );
  }

  const staleWarning = error !== null && evaluations !== null;

  return (
    <div className="spots">
      <ConfigHeader
        config={config}
        weather={snapshot?.weather ?? null}
        units={settings.units}
        now={now}
      />

      <div className="spots-controls">
        <Segmented
          options={SORTS}
          value={sort}
          onChange={setSort}
          ariaLabel="Sort the spotting locations"
        />

        {geoState === 'ok' ? (
          <p className="spots-geo spots-geo--on">
            <Icon name="location" size={16} />
            Distances are from where you are
          </p>
        ) : (
          <button
            type="button"
            className="spots-locate"
            onClick={request}
            disabled={geoState === 'asking' || geoState === 'unavailable'}
          >
            <Icon name="location" size={18} />
            {geoState === 'asking' ? 'Finding you…' : 'Use my location'}
          </button>
        )}
      </div>

      <p className="spots-geo-note" role="status">
        {locationNote(geoState, sort, position !== null)}
      </p>

      {staleWarning ? (
        <p className="spots-warn">
          <Icon name="alert" size={16} />
          <span>
            The last refresh failed ({error}). This ranking is from{' '}
            {formatRelative(fetchedAt, now)} and may no longer match the runways in use.
          </span>
        </p>
      ) : null}

      {ranked.length === 0 ? (
        <EmptyState
          icon={<Icon name="binoculars" size={24} />}
          title="No spotting locations are listed"
          message="The server returned an empty list, so there is nothing to rank. The board and the map are still live."
          action={
            <button type="button" className="app-button" onClick={retry}>
              Reload the list
            </button>
          }
        />
      ) : (
        <>
          <p className="app-visually-hidden" role="status">
            {`${ranked.length} spotting locations, ${
              sort === 'near' && position ? 'nearest first' : 'best for the current conditions first'
            }`}
          </p>
          <ul className="spots-list">
            {ranked.map((evaluation) => (
              <SpotCard
                key={evaluation.spot.id}
                evaluation={evaluation}
                sun={snapshot?.sun ?? null}
                landing={config?.landing ?? []}
                departing={config?.departing ?? []}
                units={settings.units}
                expanded={open.has(evaluation.spot.id)}
                onToggle={() => toggle(evaluation.spot.id)}
              />
            ))}
          </ul>
        </>
      )}

      <p className="spots-updated app-numeric">
        {fetchedAt === null
          ? 'Ranking not yet refreshed'
          : `Ranking refreshed ${formatRelative(fetchedAt, now)} · re-checked every minute and whenever the runways change`}
      </p>

      <section className="spots-etiquette" aria-labelledby="spots-etiquette-title">
        <h3 className="spots-etiquette-title" id="spots-etiquette-title">
          Spotting etiquette
        </h3>
        <ul className="spots-etiquette-list">
          <li>
            Stay on public land — verges, footpaths and car parks. Never airport operational areas
            or private property.
          </li>
          <li>Do not block driveways, gates or the road. People live and work here.</li>
          <li>
            No drones anywhere near the airport. It is illegal inside the flight restriction zone
            and it stops aircraft moving.
          </li>
          <li>After dark, be visible: hi-vis or a light, and stand well clear of moving traffic.</li>
          <li>Take your litter home. Police are used to spotters — be easy to talk to.</li>
        </ul>
      </section>
    </div>
  );
}
