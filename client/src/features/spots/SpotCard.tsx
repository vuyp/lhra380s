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
import type { SpotEvaluation, SpotLocation, SunInfo } from '../../../../shared/types.ts';
import { Card } from '../../components/ui/Card.tsx';
import { Chip } from '../../components/ui/Chip.tsx';
import { Icon } from '../../components/ui/Icon.tsx';
import type { Tone } from '../../components/ui/Chip.tsx';
import { compassPoint } from '../../lib/format.ts';
import { navigateTo } from '../../state/route.ts';
import { SunDial, lightLabel, lightMeaning } from './SunDial.tsx';
import './SpotCard.css';

type Rating = SpotEvaluation['rating'];
type Light = SpotEvaluation['light'];

/** What a spot is set up to watch, derived from the two runway lists — never stated twice. */
type Sees = 'arrivals' | 'departures' | 'both' | 'none';
type Role = 'arrivals' | 'departures';

function seesOf(spot: SpotLocation): Sees {
  const arrivals = spot.arrivalsFor.length > 0;
  const departures = spot.departuresFor.length > 0;
  if (arrivals && departures) return 'both';
  if (arrivals) return 'arrivals';
  return departures ? 'departures' : 'none';
}

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
  none: 'What it sees is unrecorded',
};

const SEES_SENTENCES: Record<Sees, string> = {
  arrivals: 'Landing traffic only — aircraft on final, wheels down, coming towards you.',
  departures: 'Departing traffic only — the roll, the rotation and the climb-out.',
  both: 'Both boards: arrivals on final and departures climbing out.',
  none: 'What this spot sees is not recorded.',
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

/**
 * A runway is only "in use" for this spot when it is in use *in the role this spot watches it in*.
 * Stanwell Moor stands under the 27L climb-out: 27L landing means the aeroplanes touch down four
 * kilometres east of the village and stop, which is not something you can see from the beer
 * garden, and the chip must not imply otherwise.
 */
function runwayInUse(runway: string, role: Role, landing: string[], departing: string[]): boolean {
  return role === 'arrivals' ? landing.includes(runway) : departing.includes(runway);
}

function runwayTone(runway: string, role: Role, landing: string[], departing: string[]): Tone {
  if (!runwayInUse(runway, role, landing, departing)) return 'neutral';
  return role === 'arrivals' ? 'arrival' : 'departure';
}

function runwayTitle(runway: string, role: Role, landing: string[], departing: string[]): string {
  if (runwayInUse(runway, role, landing, departing)) {
    return role === 'arrivals'
      ? `${runway} is landing right now, and its approach passes this spot`
      : `${runway} is departing right now, and its departures pass this spot`;
  }
  return role === 'arrivals'
    ? `${runway} is not landing in the current configuration`
    : `${runway} is not departing in the current configuration`;
}

/** Colour alone must not carry the "in use" fact, so the live runways say so in words too. */
function runwayChipLabel(runway: string, role: Role, landing: string[], departing: string[]): string {
  if (!runwayInUse(runway, role, landing, departing)) return runway;
  return role === 'arrivals' ? `${runway} · landing now` : `${runway} · departing now`;
}

function Detail(p: { term: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="spot-fact">
      <dt>{p.term}</dt>
      <dd>{p.children}</dd>
    </div>
  );
}

/** DOM id for a spot's card, so the tab can scroll the one the map pointed at into view. */
export function spotCardDomId(spotId: string): string {
  return `spot-card-${spotId}`;
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
  const sees = seesOf(spot);
  const airside = spot.accessType === 'airside';
  const roles: Array<{ role: Role; title: string; runways: string[] }> = [
    { role: 'arrivals', title: 'Arrivals', runways: spot.arrivalsFor },
    { role: 'departures', title: 'Departures', runways: spot.departuresFor },
  ];

  // Carry the spot with us: the map opens on this pin with its card up, rather than on eleven
  // identical pins and no clue which one was asked for.
  const showOnMap = (): void => navigateTo('map', spot.id);

  return (
    <Card
      as="li"
      id={spotCardDomId(spot.id)}
      className={expanded ? 'spot spot--open' : 'spot'}
      accent={RATING_ACCENTS[rating]}
    >
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
              <Chip size="sm">{SEES_CHIPS[sees]}</Chip>
              {airside ? (
                <Chip
                  tone="warn"
                  size="sm"
                  title="Past security in Terminal 4 — there is no landside way in"
                >
                  Airside only
                </Chip>
              ) : null}
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
              {sees === 'none' ? (
                <p className="spot-plain">No specific runways are recorded for this spot.</p>
              ) : (
                <>
                  {roles.map((entry) =>
                    entry.runways.length === 0 ? null : (
                      <div className="spot-runway-role" key={entry.role}>
                        <span className="spot-runway-role-name">{entry.title}</span>
                        <ul className="spot-runways">
                          {entry.runways.map((runway) => (
                            <li key={runway}>
                              <Chip
                                tone={runwayTone(runway, entry.role, landing, departing)}
                                size="sm"
                                title={runwayTitle(runway, entry.role, landing, departing)}
                              >
                                {runwayChipLabel(runway, entry.role, landing, departing)}
                              </Chip>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ),
                  )}
                  <p className="spot-plain">
                    Each runway is listed under the movement you can watch from here — the
                    approach and the climb-out are at opposite ends of the same strip of concrete.
                    The ones marked "now" are what Heathrow is using this minute.
                  </p>
                </>
              )}
            </div>

            <dl className="spot-facts">
              <Detail term="What you'll see">{SEES_SENTENCES[sees]}</Detail>
              <Detail term="Getting in">
                {airside
                  ? 'Airside — past security in Terminal 4, so only on a day you are flying.'
                  : 'Public — a street, verge or free viewing area, open to anyone.'}
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
