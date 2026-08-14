/**
 * SpotCard — one spotting location, scored for right now.
 *
 * Collapsed, it is three lines: what the place is called, what it feels like, and the two facts
 * that decide whether you walk there (how good it is right now, and what the light is doing).
 * Six of these fit on a phone screen. Expanded, it becomes the full briefing — the server's own
 * reasons verbatim, the sun instrument, the runways it works for with the live ones lit up, and
 * how to actually get there.
 *
 * Nothing here is invented: fields the reference data leaves empty are printed as not recorded.
 */

import { useId } from 'react';
import type { ReactElement } from 'react';
import type { SpotEvaluation, SunInfo } from '../../../../shared/types.ts';
import { Card } from '../../components/ui/Card.tsx';
import { Chip } from '../../components/ui/Chip.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import type { Tone } from '../../components/ui/Chip.tsx';
import { compassPoint } from '../../lib/format.ts';
import { SunDial, lightLabel, lightMeaning } from './SunDial.tsx';
import './SpotCard.css';

type Rating = SpotEvaluation['rating'];
type Light = SpotEvaluation['light'];
type Sees = SpotEvaluation['spot']['sees'];

const KM_PER_MILE = 1.609344;

const RATING_WORDS: Record<Rating, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};

/** Accent colour for the card's edge strip. Tokens only — never a raw hex. */
const RATING_ACCENTS: Record<Rating, string> = {
  excellent: 'var(--brand-cyan)',
  good: 'var(--success)',
  fair: 'var(--warning)',
  poor: 'var(--text-muted)',
};

const LIGHT_TONES: Record<Light, Tone> = {
  ideal: 'arrival',
  workable: 'neutral',
  backlit: 'warn',
  dark: 'neutral',
};

const SEES_CHIPS: Record<Sees, string> = {
  arrivals: 'Arrivals',
  departures: 'Departures',
  both: 'Arrivals & departures',
};

const SEES_SENTENCES: Record<Sees, string> = {
  arrivals: 'Landing traffic only — aircraft on final, wheels down, coming towards you.',
  departures: 'Departing traffic only — the roll, the rotation and the climb-out.',
  both: 'Both boards: arrivals on final and departures climbing out.',
};

/**
 * Ground distance in the unit the reader chose. Kilometres and miles — nautical miles are for
 * the aircraft, not for the walk from the station.
 */
function formatWalk(km: number | undefined, units: 'metric' | 'imperial'): string | null {
  if (km === undefined || !Number.isFinite(km) || km < 0) return null;
  if (units === 'imperial') {
    const miles = km / KM_PER_MILE;
    if (miles < 0.1) return 'right here';
    return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
  }
  if (km < 0.15) return 'right here';
  if (km < 1) return `${Math.round((km * 1000) / 50) * 50} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

function directionsHref(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

function runwayTone(runway: string, landing: string[], departing: string[]): Tone {
  if (landing.includes(runway)) return 'arrival';
  if (departing.includes(runway)) return 'departure';
  return 'neutral';
}

function runwayTitle(runway: string, landing: string[], departing: string[]): string {
  if (landing.includes(runway)) return `${runway} is landing traffic right now`;
  if (departing.includes(runway)) return `${runway} is departing traffic right now`;
  return `${runway} is not in use in the current configuration`;
}

/** Colour alone must not carry the "in use" fact, so the live runways say so in words too. */
function runwayChipLabel(runway: string, landing: string[], departing: string[]): string {
  if (landing.includes(runway)) return `${runway} · landing`;
  if (departing.includes(runway)) return `${runway} · departing`;
  return runway;
}

function Detail(p: { term: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="spot-fact">
      <dt>{p.term}</dt>
      <dd>{p.children}</dd>
    </div>
  );
}

export function SpotCard(p: {
  evaluation: SpotEvaluation;
  sun: SunInfo | null;
  landing: string[];
  departing: string[];
  units: 'metric' | 'imperial';
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  const { evaluation, sun, landing, departing, units, expanded, onToggle } = p;
  const { spot, rating, light, reasons, score } = evaluation;
  // React ids carry colons; strip them so the value is a clean HTML id for aria-controls.
  const reactId = useId();
  const detailId = `spot-detail-${reactId.replace(/:/g, '')}`;

  const walk = formatWalk(evaluation.distanceKm, units);
  const leadReason = reasons[0] ?? null;
  const ratingWord = RATING_WORDS[rating] ?? 'Unrated';

  const showOnMap = (): void => {
    window.location.hash = '#map';
  };

  return (
    <Card as="li" className={expanded ? 'spot spot--open' : 'spot'} accent={RATING_ACCENTS[rating]}>
      {/* Disclosure pattern: the summary is the heading, the heading is the button. */}
      <h3 className="spot-heading">
        <button
          type="button"
          className="spot-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggle}
        >
          <span className="spot-main">
            <span className="spot-head">
              <span className="spot-name">{spot.name}</span>
              <span
                className={`spot-rating spot-rating--${rating}`}
                title={`Scores ${Math.round(score)} out of 100 for the runways, sun and wind right now`}
              >
                {ratingWord}
                <span className="spot-score app-numeric">{Math.round(score)}</span>
              </span>
            </span>

            <span className="spot-tagline">{spot.tagline}</span>

            <span className="spot-chips">
              <Chip tone={LIGHT_TONES[light] ?? 'neutral'} size="sm" title={lightMeaning(light)}>
                {lightLabel(light)}
              </Chip>
              <Chip size="sm">{SEES_CHIPS[spot.sees] ?? 'What it sees is unrecorded'}</Chip>
              {walk ? (
                <Chip size="sm" title="Straight-line distance from your device's location">
                  {walk}
                </Chip>
              ) : null}
            </span>

            {/* Always rendered, so opening the drawer never shortens the header underneath it. */}
            {leadReason ? <span className="spot-lead">{leadReason}</span> : null}
          </span>

          <span className="spot-chevron" aria-hidden="true">
            <Icon name="chevron" size={20} />
          </span>
        </button>
      </h3>

      <div className="spot-drawer">
        <div className="spot-drawer-inner">
          <div className="spot-detail" id={detailId}>
            <div className="spot-block">
              <h4 className="spot-block-title">Why it ranks here</h4>
              {reasons.length > 0 ? (
                <ul className="spot-reasons">
                  {reasons.map((reason, index) => (
                    <li className="spot-reason" key={`${index}-${reason}`}>
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="spot-plain">
                  No scoring notes came back for this spot — it is listed for reference only.
                </p>
              )}
            </div>

            <div className="spot-block">
              <h4 className="spot-block-title">Light and camera</h4>
              <p className="spot-light-meaning">
                <strong>{lightLabel(light)}.</strong> {lightMeaning(light)}.
              </p>
              <SunDial sun={sun} viewBearing={spot.viewBearing} light={light} />
            </div>

            <div className="spot-block">
              <h4 className="spot-block-title">Runways it works for</h4>
              {spot.goodFor.length > 0 ? (
                <>
                  <ul className="spot-runways">
                    {spot.goodFor.map((runway) => (
                      <li key={runway}>
                        <Chip
                          tone={runwayTone(runway, landing, departing)}
                          size="sm"
                          title={runwayTitle(runway, landing, departing)}
                        >
                          {runwayChipLabel(runway, landing, departing)}
                        </Chip>
                      </li>
                    ))}
                  </ul>
                  <p className="spot-plain">
                    Runways marked landing or departing are the ones Heathrow is actually using
                    right now; the rest are what this spot covers when the airport turns around.
                  </p>
                </>
              ) : (
                <p className="spot-plain">No specific runways are recorded for this spot.</p>
              )}
            </div>

            <dl className="spot-facts">
              <Detail term="What you'll see">
                {SEES_SENTENCES[spot.sees] ?? 'What this spot sees is not recorded.'}
              </Detail>
              <Detail term="Looking">
                {`${compassPoint(spot.viewBearing)} · ${Math.round(spot.viewBearing)}° true`}
              </Detail>
              <Detail term="Getting there">{spot.access}</Detail>
              <Detail term="Transport">{spot.transport ?? 'Not recorded.'}</Detail>
              <Detail term="Facilities">{spot.facilities ?? 'Not recorded.'}</Detail>
              <Detail term="Good to know">{spot.notes}</Detail>
              <Detail term="Coordinates">
                <span className="spot-coords app-numeric">
                  {spot.lat.toFixed(4)}, {spot.lon.toFixed(4)}
                </span>
              </Detail>
            </dl>

            <div className="spot-actions">
              <a
                className="spot-action"
                href={directionsHref(spot.lat, spot.lon)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Directions to ${spot.name} — opens Google Maps in a new tab`}
              >
                <Icon name="external" size={16} />
                Directions
              </a>
              <button
                type="button"
                className="spot-action"
                onClick={showOnMap}
                aria-label={`Show ${spot.name} on the live map`}
              >
                <Icon name="map" size={16} />
                Show on map
              </button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
