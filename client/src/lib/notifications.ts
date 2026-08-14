/**
 * Arrival alerts.
 *
 * Fires one browser Notification per flight per approach, at the moment its ETA *crosses*
 * the user's lead time. Deliberately conservative:
 *  - a flight already inside the lead window when the app opens is seeded, not announced
 *  - a flight that has landed, is on the ground, or has no ETA is never announced
 *  - dedupe is module-level, so mounting the hook in more than one place cannot double-fire
 *
 * Where the Notification API does not exist (iOS Safari outside standalone mode) every entry
 * point is a silent no-op and `supported` is false, so the UI can explain instead of offering
 * a switch that would do nothing.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Movement, Snapshot } from '../../../shared/types.ts';
import { useSnapshot } from '../api/useSnapshot.ts';
import { useSettings } from '../state/settings.tsx';
import { formatCountdown, routeLabel } from './format.ts';

function detectSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    typeof window.Notification === 'function' &&
    typeof window.Notification.requestPermission === 'function'
  );
}

const SUPPORTED = detectSupport();

/* ---- Permission, shared across every hook instance -------------------------- */

let permission: NotificationPermission = SUPPORTED ? Notification.permission : 'denied';
const permissionListeners = new Set<() => void>();

function setPermission(next: NotificationPermission): void {
  if (next === permission) return;
  permission = next;
  for (const listener of permissionListeners) listener();
}

function subscribePermission(listener: () => void): () => void {
  permissionListeners.add(listener);
  return () => permissionListeners.delete(listener);
}

function readPermission(): NotificationPermission {
  return permission;
}

/* ---- Dedupe ----------------------------------------------------------------- */

/** hex → epoch ms we announced it. Cleared once the flight is no longer inbound. */
const announced = new Map<string, number>();

/**
 * Whether the first frame has been absorbed. Module-level rather than per-hook so that
 * mounting a second consumer (the settings panel) mid-session cannot swallow an alert.
 */
let seeded = false;

function alertTitle(movement: Movement): string {
  const who = movement.flightNumber ?? movement.callsign ?? 'A380';
  return `${who} — ${formatCountdown(movement.eta.minutes)} to Heathrow`;
}

function alertBody(movement: Movement): string {
  const parts = [routeLabel(movement.route, 'arrival')];
  parts.push(
    movement.runway.runway
      ? `Predicted runway ${movement.runway.runway}`
      : 'Runway not yet predicted',
  );
  if (movement.airframe.registration) parts.push(movement.airframe.registration);
  return parts.join(' · ');
}

function fire(movement: Movement): void {
  try {
    new Notification(alertTitle(movement), {
      body: alertBody(movement),
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: `whalewatch-arrival-${movement.id}`,
      requireInteraction: false,
    });
  } catch {
    // Some engines only permit Notifications from a service worker. Failing quietly is
    // correct here: the on-screen countdown is still the source of truth.
  }
}

/**
 * @returns the hexes that qualified on this frame, so a first run can seed without announcing.
 */
function scanAndAnnounce(snapshot: Snapshot, leadMinutes: number, announceMode: boolean): void {
  const stillInbound = new Set<string>();
  const due: Movement[] = [];

  for (const movement of snapshot.arrivals) {
    if (movement.telemetry.onGround) continue;
    if (movement.phase !== 'inbound' && movement.phase !== 'approach') continue;
    stillInbound.add(movement.id);

    const minutes = movement.eta.minutes;
    if (minutes === null || !Number.isFinite(minutes)) continue;
    if (minutes < 0 || minutes > leadMinutes) continue;
    due.push(movement);
  }

  // Forget anything that has landed or left the arrivals list, so a later approach can alert.
  for (const hex of Array.from(announced.keys())) {
    if (!stillInbound.has(hex)) announced.delete(hex);
  }

  for (const movement of due) {
    if (announced.has(movement.id)) continue;
    announced.set(movement.id, Date.now());
    if (announceMode) fire(movement);
  }
}

/* ---- Hook -------------------------------------------------------------------- */

export interface ArrivalAlerts {
  supported: boolean;
  permission: NotificationPermission;
  enable: () => Promise<boolean>;
}

export function useArrivalAlerts(): ArrivalAlerts {
  const current = useSyncExternalStore(subscribePermission, readPermission, readPermission);
  const { snapshot } = useSnapshot();
  const { settings } = useSettings();

  const enable = useCallback(async (): Promise<boolean> => {
    if (!SUPPORTED) return false;
    if (Notification.permission === 'granted') {
      setPermission('granted');
      return true;
    }
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result === 'granted';
    } catch {
      setPermission(Notification.permission);
      return false;
    }
  }, []);

  const active = SUPPORTED && current === 'granted' && settings.alertsEnabled;

  useEffect(() => {
    if (!active) {
      // Turning alerts off resets the seed, so switching back on never fires a backlog.
      seeded = false;
      return;
    }
    if (!snapshot) return;
    const seeding = !seeded;
    seeded = true;
    scanAndAnnounce(snapshot, settings.alertLeadMinutes, !seeding);
  }, [active, snapshot, settings.alertLeadMinutes]);

  return { supported: SUPPORTED, permission: current, enable };
}
