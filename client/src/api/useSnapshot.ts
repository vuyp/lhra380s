/**
 * The data layer: one SSE connection for the whole app, with a polling fallback.
 *
 * Rules this file exists to guarantee:
 *  - first paint is fast (an immediate /api/snapshot fetch runs alongside the stream opening)
 *  - the screen never goes empty: the last good snapshot is kept across reconnects and the UI
 *    is told `connected: false` so it can mark the data stale instead of blanking
 *  - reconnects back off (1s → 30s, jittered) and recover to SSE automatically
 *  - nothing leaks: every timer, listener and EventSource is torn down on unmount
 *
 * No JSX here on purpose — this is a .ts module, so the provider is built with createElement.
 */

import { createContext, createElement, useContext, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { Snapshot } from '../../../shared/types.ts';
import { SSE_EVENT_SNAPSHOT } from '../../../shared/types.ts';

export type SnapshotState = {
  snapshot: Snapshot | null;
  connected: boolean;
  error: string | null;
  /**
   * When this device last received a genuinely new snapshot. A service-worker cache replay does
   * not move it — an offline app must not claim its frozen data is "from just now".
   */
  lastUpdate: number | null;
  /** True while the newest response we hold came out of the service-worker cache, not the server. */
  fromCache: boolean;
  loading: boolean;
};

const INITIAL: SnapshotState = {
  snapshot: null,
  connected: false,
  error: null,
  lastUpdate: null,
  fromCache: false,
  loading: true,
};

/** Set by client/public/sw.js on a response it served from its own cache. */
const FROM_CACHE_HEADER = 'x-ww-from-cache';

/** How often we poll while the stream is down. */
const POLL_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function backoffDelay(attempt: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  // ±25% jitter so a server restart does not bring every client back at the same instant.
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Could not reach the Whale Watch server';
}

/** Cheap shape check — we never render a payload we cannot recognise. */
function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Snapshot>;
  return (
    typeof candidate.ts === 'number' &&
    Array.isArray(candidate.arrivals) &&
    Array.isArray(candidate.departures) &&
    typeof candidate.runwayConfig === 'object' &&
    candidate.runwayConfig !== null
  );
}

const SnapshotContext = createContext<SnapshotState | null>(null);

export function SnapshotProvider(props: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<SnapshotState>(INITIAL);

  useEffect(() => {
    let alive = true;
    let source: EventSource | null = null;
    let pollTimer: number | undefined;
    let retryTimer: number | undefined;
    let attempt = 0;

    const apply = (value: unknown, fromCache = false): void => {
      if (!alive || !isSnapshot(value)) return;
      setState((prev) => {
        if (!fromCache) {
          return {
            ...prev,
            snapshot: value,
            error: null,
            lastUpdate: Date.now(),
            fromCache: false,
            loading: false,
          };
        }
        // The service worker answered from its own cache: the server was not reached, so nothing
        // about the world is newer than it was. Keep what we hold, leave `lastUpdate` where it
        // is so the banner and the per-card staleness chips age honestly, and — on a cold start
        // with nothing else — date the cached body by the moment the server built it.
        if (prev.snapshot !== null) return { ...prev, fromCache: true, loading: false };
        return {
          ...prev,
          snapshot: value,
          error: null,
          lastUpdate: Number.isFinite(value.ts) ? value.ts : null,
          fromCache: true,
          loading: false,
        };
      });
    };

    const fetchSnapshot = async (): Promise<void> => {
      try {
        const response = await fetch('/api/snapshot', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Server responded ${response.status}`);
        const cached = response.headers.get(FROM_CACHE_HEADER) !== null;
        apply((await response.json()) as unknown, cached);
      } catch (error) {
        if (!alive) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          // Keep showing the last good data; only surface an error when we have nothing.
          error: prev.snapshot ? prev.error : errorMessage(error),
        }));
      }
    };

    const stopPolling = (): void => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    const startPolling = (): void => {
      if (pollTimer !== undefined || !alive) return;
      pollTimer = window.setInterval(() => {
        void fetchSnapshot();
      }, POLL_MS);
    };

    const closeSource = (): void => {
      if (!source) return;
      source.onopen = null;
      source.onerror = null;
      source.close();
      source = null;
    };

    const scheduleReconnect = (): void => {
      if (retryTimer !== undefined || !alive) return;
      const delay = backoffDelay(attempt);
      attempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, delay);
    };

    const connect = (): void => {
      if (!alive) return;
      if (typeof EventSource === 'undefined') {
        startPolling();
        return;
      }
      closeSource();

      let stream: EventSource;
      try {
        stream = new EventSource('/api/stream');
      } catch {
        startPolling();
        scheduleReconnect();
        return;
      }
      source = stream;

      stream.onopen = () => {
        if (!alive || source !== stream) return;
        attempt = 0;
        stopPolling();
        setState((prev) => (prev.connected ? prev : { ...prev, connected: true, error: null }));
      };

      stream.addEventListener(SSE_EVENT_SNAPSHOT, (event) => {
        if (!alive || source !== stream) return;
        const data = (event as MessageEvent<string>).data;
        try {
          apply(JSON.parse(data) as unknown);
        } catch {
          // A truncated frame is not worth tearing the connection down for.
        }
      });

      stream.onerror = () => {
        if (!alive || source !== stream) return;
        closeSource();
        setState((prev) => (prev.connected ? { ...prev, connected: false } : prev));
        startPolling();
        scheduleReconnect();
      };
    };

    // Coming back to a backgrounded tab: retry immediately rather than waiting out the backoff.
    const onVisible = (): void => {
      if (!alive || document.visibilityState !== 'visible') return;
      void fetchSnapshot();
      if (source) return;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      attempt = 0;
      connect();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);

    void fetchSnapshot();
    connect();

    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      stopPolling();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      closeSource();
    };
  }, []);

  return createElement(SnapshotContext.Provider, { value: state }, props.children);
}

export function useSnapshot(): SnapshotState {
  const value = useContext(SnapshotContext);
  if (!value) throw new Error('useSnapshot must be used inside <SnapshotProvider>');
  return value;
}

/* ---- Shared clock ---------------------------------------------------------- */

interface Clock {
  subscribers: Set<(now: number) => void>;
  timer: number | undefined;
}

/** One interval per distinct period for the entire app, however many components subscribe. */
const clocks = new Map<number, Clock>();

function getClock(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = { subscribers: new Set(), timer: undefined };
    clocks.set(intervalMs, clock);
  }
  return clock;
}

/** Ticking wall clock for countdowns and "x min ago" labels. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const clock = getClock(intervalMs);
    const tick = (value: number) => setNow(value);
    clock.subscribers.add(tick);

    // Catch up immediately: the shared interval may have last fired a moment ago.
    tick(Date.now());

    if (clock.timer === undefined) {
      clock.timer = window.setInterval(() => {
        const value = Date.now();
        for (const subscriber of clock.subscribers) subscriber(value);
      }, intervalMs);
    }

    return () => {
      clock.subscribers.delete(tick);
      if (clock.subscribers.size === 0) {
        if (clock.timer !== undefined) window.clearInterval(clock.timer);
        clocks.delete(intervalMs);
      }
    };
  }, [intervalMs]);

  return now;
}
