import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { RunwayConfig } from '../../../shared/types.ts';
import { useNow, useSnapshot } from '../api/useSnapshot.ts';
import { compassPoint, formatClock, formatRelative } from '../lib/format.ts';
import { useArrivalAlerts } from '../lib/notifications.ts';
import { ALERT_LEAD_CHOICES, useSettings } from '../state/settings.tsx';
import type { Settings } from '../state/settings.tsx';
import { Chip } from './ui/Chip.tsx';
import { Icon, A380_PLANFORM_PATH } from './ui/Icon.tsx';
import { Segmented } from './ui/Segmented.tsx';
import { Sheet } from './ui/Sheet.tsx';
import { Skeleton } from './ui/Skeleton.tsx';
import './AppHeader.css';

/* ---- Runway configuration --------------------------------------------------- */

function runwayList(designators: string[] | undefined, separator: string): string | null {
  if (!Array.isArray(designators)) return null;
  const cleaned = designators.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return cleaned.length > 0 ? cleaned.join(separator) : null;
}

/**
 * More than one runway in a role means the traffic did not tell us which of the pair is which.
 * The server says as much in its summary; the header has to say it too, because "Landing 27L +
 * 27R · Departing 27L + 27R" reads as both runways doing both jobs, which is never true.
 */
function isUnconfirmed(landing: string[] | undefined, departing: string[] | undefined): boolean {
  const count = (list: string[] | undefined): number => (Array.isArray(list) ? list.length : 0);
  return count(landing) > 1 || count(departing) > 1;
}

interface ConfidenceBadge {
  label: string;
  tone: 'live' | 'warn' | 'neutral';
  title: string;
}

function confidenceBadge(
  confidence: number,
  sampleSize: number,
  unconfirmed: boolean,
): ConfidenceBadge | null {
  const sample = `${sampleSize} aircraft observed`;
  if (unconfirmed) {
    return {
      label: 'Unconfirmed',
      tone: 'warn',
      title: `The traffic did not separate the two runways — ${sample}`,
    };
  }
  if (!Number.isFinite(confidence) || confidence < 0.4) {
    return { label: 'Unconfirmed', tone: 'warn', title: `Low agreement — ${sample}` };
  }
  if (confidence < 0.75) {
    return { label: 'Likely', tone: 'neutral', title: `Partial agreement — ${sample}` };
  }
  return null;
}

/**
 * Which of the two parallel runways a designator names.
 *
 * Left and right are read from the flight deck, so they swap with the direction of use: pointing
 * west along 27, left is the southern strip; pointing east along 09, left is the northern one.
 * Same tarmac, opposite ends — which is the part "27L" never says out loud.
 */
function runwaySide(designator: string): 'northern' | 'southern' | null {
  const match = /^(09|27)([LR])$/.exec(designator.trim().toUpperCase());
  if (match === null) return null;
  const heading = match[1];
  const hand = match[2];
  if (heading === '27') return hand === 'L' ? 'southern' : 'northern';
  return hand === 'L' ? 'northern' : 'southern';
}

/** The one runway in a role, or null when the traffic named none or could not separate a pair. */
function soleRunway(designators: string[] | undefined): string | null {
  if (!Array.isArray(designators)) return null;
  const cleaned = designators.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return cleaned.length === 1 ? (cleaned[0] ?? null) : null;
}

/**
 * Where the aeroplanes physically are, each way round. Heathrow works into the wind, so westerly
 * ops means arrivals from the east and departures to the west, and easterly ops is the mirror of
 * it. Getting this backwards would send a reader to the wrong end of the airport.
 */
const GEOGRAPHY: Record<'westerly' | 'easterly', { arriving: string; departing: string }> = {
  westerly: {
    arriving: 'Aircraft come in from the east, over Hounslow and Hatton Cross.',
    departing: 'Aircraft climb away to the west, out towards Windsor.',
  },
  easterly: {
    arriving: 'Aircraft come in from the west, over Windsor and Datchet.',
    departing: 'Aircraft climb away to the east, over Hatton Cross and Hounslow.',
  },
};

/**
 * The plain-English reading of the configuration, opened on demand from the header.
 *
 * "Landing 27L" is complete information to a spotter and nothing at all to the passenger standing
 * next to them, so the expansion answers the two questions the code hides: which end of the
 * airport, and which way the aeroplanes will be flying.
 */
function RunwayExplainer(p: { config: RunwayConfig; id: string }): ReactElement | null {
  const { config, id } = p;
  if (config.direction !== 'westerly' && config.direction !== 'easterly') return null;

  const geography = GEOGRAPHY[config.direction];
  const unconfirmed = isUnconfirmed(config.landing, config.departing);
  const separator = unconfirmed ? ' or ' : ' and ';
  const landing = runwayList(config.landing, separator);
  const departing = runwayList(config.departing, separator);
  if (landing === null && departing === null) return null;

  const landingSole = soleRunway(config.landing);
  const departingSole = soleRunway(config.departing);
  const landingSide = landingSole === null ? null : runwaySide(landingSole);
  const departingSide = departingSole === null ? null : runwaySide(departingSole);

  return (
    <div className="hdr-ops-explain" id={id}>
      <ul className="hdr-explain-list">
        {landing !== null ? (
          <li className="hdr-explain-item">
            <span className="hdr-explain-lead">
              Landing on <b className="hdr-explain-runway app-numeric">{landing}</b>
              {landingSide === null ? '' : `, the ${landingSide} runway`}.
            </span>{' '}
            {geography.arriving}
          </li>
        ) : null}
        {departing !== null ? (
          <li className="hdr-explain-item">
            <span className="hdr-explain-lead">
              Departing from <b className="hdr-explain-runway app-numeric">{departing}</b>
              {departingSide === null ? '' : `, the ${departingSide} runway`}.
            </span>{' '}
            {geography.departing}
          </li>
        ) : null}
      </ul>
      {/*
        The "or" above is the whole answer for a pair the traffic has not separated, and until now
        it was explained only by the badge's `title` — which needs a mouse, and this app is read on
        a phone. Same claim as that tooltip, in a sentence, where the reader who tapped for an
        explanation is already looking.
      */}
      {unconfirmed ? (
        <p className="hdr-explain-note">
          Not enough traffic has been watched to separate the two parallel runways, so both are
          named. We would rather show you the pair than pick one and be wrong.
        </p>
      ) : null}
      <p className="hdr-explain-note">
        A runway is numbered for the compass heading it points along — 27 is west, 09 is east — and
        L and R tell the two parallel runways apart. Heathrow lands and departs into the wind, so
        the direction changes with the weather.
      </p>
    </div>
  );
}

function RunwayConfigLine(p: {
  expanded: boolean;
  onToggle: () => void;
  panelId: string;
}): ReactElement {
  const { expanded, onToggle, panelId } = p;
  const { snapshot } = useSnapshot();

  if (!snapshot) {
    return (
      <div className="hdr-ops-block">
        <span className="hdr-ops-icon" aria-hidden="true">
          <Icon name="runway" size={18} />
        </span>
        <Skeleton width={190} height={17} />
      </div>
    );
  }

  const config = snapshot.runwayConfig;
  const unconfirmed = isUnconfirmed(config.landing, config.departing);
  // "27L or 27R" is the honest reading of an unseparated pair; "27L + 27R" claims both.
  const separator = unconfirmed ? ' or ' : ' + ';
  const landing = runwayList(config.landing, separator);
  const departing = runwayList(config.departing, separator);
  const badge = confidenceBadge(config.confidence, config.sampleSize, unconfirmed);
  const known = config.direction !== 'unknown' && (landing !== null || departing !== null);

  const spoken = (
    <span className="app-visually-hidden">
      {config.summary || 'Active runway configuration is not yet known.'}
    </span>
  );

  // Nothing to expand until the traffic has told us which way the airport is working.
  if (!known) {
    return (
      <div className="hdr-ops-block">
        <span className="hdr-ops-icon" aria-hidden="true">
          <Icon name="runway" size={18} />
        </span>
        <p className="hdr-ops-text hdr-ops-text--unknown">
          <span className="hdr-ops-lead">
            Runway configuration not yet derived
            {badge ? (
              <Chip tone={badge.tone} size="sm" title={badge.title}>
                {badge.label}
              </Chip>
            ) : null}
          </span>
          <span className="hdr-ops-note">too little low traffic to be sure</span>
        </p>
        {spoken}
      </div>
    );
  }

  // The control names itself with the server's own sentence rather than with the four fragments
  // painted inside it, so a screen reader hears "Westerly operations — landing 27L, departing
  // 27R" once, and hears what the control is for.
  const spokenLabel = `${config.summary || `${config.direction} operations, landing ${landing ?? 'unknown'}, departing ${departing ?? 'unknown'}`}${
    badge ? `. ${badge.label}` : ''
  }. Explain this configuration`;

  return (
    <button
      type="button"
      className="hdr-ops-block hdr-ops-toggle"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={panelId}
      aria-label={spokenLabel}
    >
      <span className="hdr-ops-icon" aria-hidden="true">
        <Icon name="runway" size={18} />
      </span>

      <span className="hdr-ops-text">
        {/*
          The confidence badge rides on the direction's own line. As a sibling of this block
          it wrapped onto a line of its own, and appearing or disappearing with the traffic
          pushed the entire page down 30px and back — the header must never do that.
        */}
        <span className="hdr-ops-lead">
          <span className="hdr-ops-direction">
            {config.direction === 'westerly' ? 'Westerly ops' : 'Easterly ops'}
          </span>
          {badge ? (
            <Chip tone={badge.tone} size="sm" title={badge.title}>
              {badge.label}
            </Chip>
          ) : null}
        </span>
        <span className="hdr-ops-pair hdr-ops-pair--land">
          <span className="hdr-ops-key">Landing</span>
          <span className="hdr-ops-runway">{landing ?? 'unknown'}</span>
        </span>
        <span className="hdr-ops-pair hdr-ops-pair--dep">
          <span className="hdr-ops-key">Departing</span>
          <span className="hdr-ops-runway">{departing ?? 'unknown'}</span>
        </span>
      </span>

      <Icon
        name="chevron"
        size={16}
        className={expanded ? 'hdr-ops-chevron hdr-ops-chevron--open' : 'hdr-ops-chevron'}
      />
    </button>
  );
}

/* ---- Wind -------------------------------------------------------------------- */

function WindLine(): ReactElement {
  const { snapshot } = useSnapshot();

  if (!snapshot) {
    return (
      <div className="hdr-wind">
        <Icon name="wind" size={16} />
        <Skeleton width={92} height={14} />
      </div>
    );
  }

  const { weather } = snapshot;
  const direction = weather.windDirection;
  const speed = weather.windSpeed;

  let text: string;
  if (speed === null) {
    text = 'Wind unavailable';
  } else if (speed === 0) {
    text = 'Calm';
  } else if (direction === null) {
    text = `${speed} kt, direction unknown`;
  } else {
    text = `${compassPoint(direction)} ${Math.round(direction)}° ${speed} kt`;
  }
  if (speed !== null && speed > 0 && weather.windGust !== null) {
    text += ` G${weather.windGust}`;
  }

  const observed =
    weather.observedAt === null
      ? 'No METAR received'
      : `METAR observed ${formatClock(weather.observedAt)}`;

  return (
    <div className="hdr-wind" title={observed}>
      <Icon name="wind" size={16} />
      <span className="hdr-wind-text app-numeric">{text}</span>
      <span className="app-visually-hidden">. {observed}.</span>
    </div>
  );
}

/* ---- Connection -------------------------------------------------------------- */

type Connection =
  | { kind: 'live' }
  | { kind: 'connecting'; detail: string }
  | { kind: 'delayed'; detail: string }
  | { kind: 'reconnecting'; detail: string }
  | { kind: 'offline'; detail: string };

const BANNER_TITLE: Record<Exclude<Connection['kind'], 'live'>, string> = {
  connecting: 'Connecting',
  delayed: 'Feed delayed',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

function ConnectionBanner(): ReactElement | null {
  const { snapshot, connected, error, lastUpdate, fromCache, loading } = useSnapshot();
  const now = useNow(5000);

  let state: Connection;
  if (fromCache && snapshot) {
    // The service worker is answering, not the server. Saying "showing data from just now" here
    // is the one thing an offline app must never do.
    state = {
      kind: 'offline',
      detail:
        lastUpdate === null
          ? 'showing cached data — no connection to the Whale Watch server'
          : `showing cached data from ${formatClock(lastUpdate)} — no connection to the server`,
    };
  } else if (connected && snapshot?.health.stale) {
    state = {
      kind: 'delayed',
      detail: `Heathrow feed has not refreshed since ${formatRelative(snapshot.health.lastPollAt, now)}`,
    };
  } else if (connected) {
    state = { kind: 'live' };
  } else if (snapshot) {
    state = {
      kind: 'reconnecting',
      detail: `showing data from ${formatRelative(lastUpdate, now)}`,
    };
  } else if (loading) {
    // Nothing has failed yet — the very first request is simply still in flight.
    state = { kind: 'connecting', detail: 'opening the live feed from Heathrow' };
  } else {
    state = { kind: 'offline', detail: error ?? 'no connection to the Whale Watch server' };
  }

  if (state.kind === 'live') return null;

  return (
    <div className={`hdr-banner hdr-banner--${state.kind}`} role="status" aria-live="polite">
      <Icon name={state.kind === 'offline' ? 'alert' : 'info'} size={16} />
      <p className="hdr-banner-text">
        <strong>{BANNER_TITLE[state.kind]}</strong>
        <span> — {state.detail}</span>
      </p>
    </div>
  );
}

/**
 * Two different things can be wrong, and calling both of them "Stale" was a lie about one of
 * them: this browser's stream can drop while the server's poll of Heathrow is perfectly current
 * (data is fresh, we are reconnecting), and the stream can be fine while the upstream feed has
 * gone quiet (connected, data is stale). Only the second is stale data.
 */
function LiveDot(): ReactElement {
  const { snapshot, connected, fromCache, loading } = useSnapshot();

  const state = ((): { className: string; text: string; title: string } => {
    // Before the first snapshot lands there is nothing stale to report — we are simply connecting.
    if (!snapshot && loading) {
      return { className: 'hdr-dot--waiting', text: 'Linking', title: 'Opening the live feed' };
    }
    if (fromCache) {
      return {
        className: 'hdr-dot--down',
        text: 'Offline',
        title: 'Showing cached data — the Whale Watch server cannot be reached',
      };
    }
    if (snapshot?.health.stale === true) {
      return {
        className: 'hdr-dot--down',
        text: 'Stale',
        title: 'The Heathrow feed has not refreshed — positions are being held',
      };
    }
    if (!connected) {
      return {
        className: 'hdr-dot--waiting',
        text: 'Reconnecting',
        title: 'The live stream dropped — the data on screen is still the latest we received',
      };
    }
    return { className: 'hdr-dot--live', text: 'Live', title: 'Streaming live' };
  })();

  return (
    <span className={`hdr-dot ${state.className}`} title={state.title}>
      <span className="hdr-dot-mark" aria-hidden="true" />
      <span className="hdr-dot-text">{state.text}</span>
    </span>
  );
}

/* ---- Settings ----------------------------------------------------------------- */

const THEME_OPTIONS: Array<{ value: Settings['theme']; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const UNIT_OPTIONS: Array<{ value: Settings['units']; label: string }> = [
  { value: 'imperial', label: 'ft · kt · nm' },
  { value: 'metric', label: 'm · km/h · km' },
];

function SettingsPanel(): ReactElement {
  const { settings, update } = useSettings();
  const alerts = useArrivalAlerts();
  const switchId = useId();

  const onToggleAlerts = async (): Promise<void> => {
    if (settings.alertsEnabled) {
      update({ alertsEnabled: false });
      return;
    }
    const granted = alerts.permission === 'granted' ? true : await alerts.enable();
    if (granted) update({ alertsEnabled: true });
  };

  const blocked = alerts.permission === 'denied';

  return (
    <div className="hdr-settings">
      <section className="hdr-set-group" aria-labelledby={`${switchId}-theme`}>
        <h3 className="hdr-set-title" id={`${switchId}-theme`}>
          Appearance
        </h3>
        <Segmented
          options={THEME_OPTIONS}
          value={settings.theme}
          onChange={(theme) => update({ theme })}
          ariaLabel="Colour theme"
        />
      </section>

      <section className="hdr-set-group" aria-labelledby={`${switchId}-units`}>
        <h3 className="hdr-set-title" id={`${switchId}-units`}>
          Units
        </h3>
        <Segmented
          options={UNIT_OPTIONS}
          value={settings.units}
          onChange={(units) => update({ units })}
          ariaLabel="Measurement units"
        />
      </section>

      <section className="hdr-set-group" aria-labelledby={`${switchId}-alerts`}>
        <h3 className="hdr-set-title" id={`${switchId}-alerts`}>
          Arrival alerts
        </h3>

        {!alerts.supported ? (
          <p className="hdr-set-note">
            This browser cannot show notifications, so alerts are unavailable here. On iPhone, add
            Whale Watch to your Home Screen and open it from there — notifications work in that
            mode.
          </p>
        ) : (
          <>
            <div className="hdr-switch-row">
              <label className="hdr-switch-label" htmlFor={switchId}>
                Notify me before a whale lands
              </label>
              <button
                type="button"
                id={switchId}
                role="switch"
                aria-checked={settings.alertsEnabled}
                className={
                  settings.alertsEnabled ? 'hdr-switch hdr-switch--on' : 'hdr-switch'
                }
                disabled={blocked}
                onClick={() => void onToggleAlerts()}
              >
                <span className="hdr-switch-knob" aria-hidden="true" />
              </button>
            </div>

            {blocked ? (
              <p className="hdr-set-note">
                Notifications are blocked for this site in your browser settings. Allow them there
                and reload to turn alerts on.
              </p>
            ) : (
              <>
                <p className="hdr-set-note">
                  One alert per flight, when its estimate first drops inside your lead time.
                </p>
                <div className="hdr-set-lead">
                  <span className="app-eyebrow">Lead time</span>
                  <Segmented
                    options={ALERT_LEAD_CHOICES.map((minutes) => ({
                      value: String(minutes),
                      label: `${minutes} min`,
                    }))}
                    value={String(settings.alertLeadMinutes)}
                    onChange={(value) => update({ alertLeadMinutes: Number(value) })}
                    ariaLabel="Alert lead time"
                  />
                </div>
              </>
            )}
          </>
        )}
      </section>

      <section className="hdr-set-group">
        <h3 className="hdr-set-title">About</h3>
        <p className="hdr-set-note">
          Positions come from adsb.lol, a volunteer-run ADS-B aggregation network; weather from the
          aviationweather.gov METAR service. Runway configuration and ETAs are derived from
          observed traffic, not from an airline schedule — anything we cannot verify is labelled
          unknown. No account, no tracking, no ads.
        </p>
      </section>
    </div>
  );
}

/* ---- Header -------------------------------------------------------------------- */

function nextTheme(theme: Settings['theme']): Settings['theme'] {
  if (theme === 'system') return 'dark';
  if (theme === 'dark') return 'light';
  return 'system';
}

const THEME_NAME: Record<Settings['theme'], string> = {
  system: 'follow the system',
  dark: 'dark',
  light: 'light',
};

export function AppHeader(): ReactElement {
  const { settings, update } = useSettings();
  const { snapshot } = useSnapshot();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Progressive disclosure: the header stays a one-line instrument, and the plain-English
  // reading of the runway configuration is one tap away for anyone who needs it.
  const [opsOpen, setOpsOpen] = useState(false);
  const opsPanelId = useId();

  const upcoming = nextTheme(settings.theme);

  return (
    <header className="hdr" role="banner">
      <div className="hdr-inner">
        <div className="hdr-top">
          <a className="hdr-brand" href="#board">
            <span className="hdr-mark" aria-hidden="true">
              <svg viewBox="0 0 64 64" width="26" height="26" role="presentation">
                <path d={A380_PLANFORM_PATH} fill="currentColor" />
              </svg>
            </span>
            <span className="hdr-wordmark">
              <span className="hdr-wordmark-name">Whale Watch</span>
              <span className="hdr-wordmark-airport">LHR</span>
            </span>
          </a>

          <div className="hdr-actions">
            <LiveDot />
            <button
              type="button"
              className="hdr-btn"
              onClick={() => update({ theme: upcoming })}
              title={`Theme: ${THEME_NAME[settings.theme]}`}
              aria-label={`Theme is set to ${THEME_NAME[settings.theme]}. Switch to ${THEME_NAME[upcoming]}.`}
            >
              <Icon name="sun" size={20} />
            </button>
            <button
              type="button"
              className="hdr-btn"
              onClick={() => setSettingsOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
            >
              <Icon name="bell" size={20} />
              <span className="app-visually-hidden">Alerts and settings</span>
            </button>
          </div>
        </div>

        <div className="hdr-ops">
          <div className="hdr-ops-row">
            <RunwayConfigLine
              expanded={opsOpen}
              onToggle={() => setOpsOpen((open) => !open)}
              panelId={opsPanelId}
            />
            <WindLine />
          </div>
          {opsOpen && snapshot ? (
            <RunwayExplainer config={snapshot.runwayConfig} id={opsPanelId} />
          ) : null}
        </div>

        <ConnectionBanner />
      </div>

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Alerts & settings">
        <SettingsPanel />
      </Sheet>
    </header>
  );
}
