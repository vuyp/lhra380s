/** Geographic helpers and the browser geolocation hook. No network, no library. */

import { useCallback, useEffect, useRef, useState } from 'react';

const EARTH_RADIUS_KM = 6371.0088;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in kilometres between two WGS-84 points. */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type GeolocationState = 'idle' | 'asking' | 'ok' | 'denied' | 'unavailable';

export interface GeolocationResult {
  position: { lat: number; lon: number } | null;
  state: GeolocationState;
  request: () => void;
}

/**
 * Location is opt-in and only ever requested from a user gesture. Once granted we watch,
 * so distances stay right while the spotter walks the perimeter road.
 */
export function useGeolocation(): GeolocationResult {
  const supported =
    typeof navigator !== 'undefined' && typeof navigator.geolocation !== 'undefined';

  const [position, setPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [state, setState] = useState<GeolocationState>(supported ? 'idle' : 'unavailable');
  const watchIdRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (watchIdRef.current !== null && typeof navigator !== 'undefined') {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, []);

  const request = useCallback(() => {
    if (!supported) {
      setState('unavailable');
      return;
    }
    if (watchIdRef.current !== null) return;

    setState('asking');
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (!aliveRef.current) return;
        setPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setState('ok');
      },
      (err) => {
        if (!aliveRef.current) return;
        if (watchIdRef.current !== null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
        }
        setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
  }, [supported]);

  return { position, state, request };
}
