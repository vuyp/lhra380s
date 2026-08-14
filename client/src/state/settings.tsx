/** User preferences: theme, units, arrival alerts. Persisted to localStorage, parsed defensively. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

export type Settings = {
  theme: 'system' | 'dark' | 'light';
  units: 'metric' | 'imperial';
  alertLeadMinutes: number;
  alertsEnabled: boolean;
};

const STORAGE_KEY = 'whalewatch.settings';

/** Aviation-native units by default: feet, knots, nautical miles. */
const DEFAULTS: Settings = {
  theme: 'system',
  units: 'imperial',
  alertLeadMinutes: 15,
  alertsEnabled: false,
};

export const ALERT_LEAD_CHOICES = [5, 10, 15, 30] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Never trust storage: validate every field and fall back per-field, not wholesale. */
function parseSettings(raw: string | null): Settings {
  if (!raw) return DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULTS;
  }
  if (!isRecord(parsed)) return DEFAULTS;

  const theme = parsed['theme'];
  const units = parsed['units'];
  const lead = parsed['alertLeadMinutes'];
  const alerts = parsed['alertsEnabled'];

  return {
    theme: theme === 'dark' || theme === 'light' || theme === 'system' ? theme : DEFAULTS.theme,
    units: units === 'metric' || units === 'imperial' ? units : DEFAULTS.units,
    alertLeadMinutes:
      typeof lead === 'number' && Number.isFinite(lead) && lead >= 1 && lead <= 120
        ? Math.round(lead)
        : DEFAULTS.alertLeadMinutes,
    alertsEnabled: typeof alerts === 'boolean' ? alerts : DEFAULTS.alertsEnabled,
  };
}

function readSettings(): Settings {
  if (typeof localStorage === 'undefined') return DEFAULTS;
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can throw outright in private modes / blocked third-party contexts.
    return DEFAULTS;
  }
}

const OVERRIDE_META_ID = 'ww-theme-color';

/**
 * index.html ships two media-scoped theme-color metas so the very first paint is right.
 * When the user forces a scheme we insert an unscoped meta *before* them — browsers take the
 * first meta whose media matches — and remove it again when they go back to "system".
 */
function syncThemeColor(forced: boolean): void {
  if (typeof document === 'undefined') return;
  const head = document.head;
  const existing = document.getElementById(OVERRIDE_META_ID);

  if (!forced) {
    existing?.remove();
    return;
  }

  const colour = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (!colour) return;

  const meta = existing instanceof HTMLMetaElement ? existing : document.createElement('meta');
  meta.id = OVERRIDE_META_ID;
  meta.name = 'theme-color';
  meta.content = colour;
  if (!meta.isConnected) head.insertBefore(meta, head.firstChild);
}

export interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider(props: { children: ReactNode }): ReactElement {
  const [settings, setSettings] = useState<Settings>(readSettings);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next: Settings = { ...prev, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Preferences simply do not persist when storage is unavailable; the session still works.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
    syncThemeColor(settings.theme !== 'system');
  }, [settings.theme]);

  // Keep multiple open tabs in step.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setSettings(parseSettings(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<SettingsContextValue>(() => ({ settings, update }), [settings, update]);

  return <SettingsContext.Provider value={value}>{props.children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useSettings must be used inside <SettingsProvider>');
  return value;
}
