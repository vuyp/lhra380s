/**
 * The hash route: `#<tab>` and, when one screen hands a specific thing to another, `#<tab>/<id>`.
 *
 * "Show this spot on the map" used to be `window.location.hash = '#map'`, which dropped the one
 * fact the reader had supplied: which spot. They arrived at the standing Heathrow view with eleven
 * identical pins on it. The detail segment carries that identity across, and it survives a reload
 * and a shared link — which is the whole reason the tab lives in the URL in the first place.
 */

import { useEffect, useState } from 'react';

export interface HashRoute {
  tab: string;
  /** The thing the previous screen was pointing at, when there was one. */
  detail: string | null;
}

/** Ids we are willing to put in, or read out of, the URL. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseHashRoute(hash: string): HashRoute {
  const value = hash.replace(/^#\/?/, '').trim().toLowerCase();
  const [tab = '', detail] = value.split('/');
  return { tab, detail: detail !== undefined && ID_PATTERN.test(detail) ? detail : null };
}

/** Move to a tab, optionally naming what should be in focus when it opens. */
export function navigateTo(tab: string, detail?: string | null): void {
  const suffix = typeof detail === 'string' && ID_PATTERN.test(detail) ? `/${detail}` : '';
  window.location.hash = `#${tab}${suffix}`;
}

/**
 * The detail segment for one tab, or null. Re-reads on every hash change, so pressing "show on
 * map" twice for two different spots moves the map twice.
 */
export function useRouteDetail(tab: string): string | null {
  const read = (): string | null => {
    const route = parseHashRoute(window.location.hash);
    return route.tab === tab ? route.detail : null;
  };

  const [detail, setDetail] = useState<string | null>(read);

  useEffect(() => {
    const sync = (): void => setDetail(read());
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
    // `read` closes over `tab` only, and the effect re-runs when that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return detail;
}
