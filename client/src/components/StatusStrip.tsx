import type { ReactElement } from 'react';
import { useSnapshot } from '../api/useSnapshot.ts';
import { formatClock } from '../lib/format.ts';
import { Icon } from './ui/Icon.tsx';
import { Skeleton } from './ui/Skeleton.tsx';
import { Stat } from './ui/Stat.tsx';
import './StatusStrip.css';

interface LightState {
  value: string;
  sub: string;
}

function describeLight(sun: {
  goldenHour: boolean;
  goldenUntil: number | null;
  isDaylight: boolean;
  sunriseAt: number | null;
  sunsetAt: number | null;
}): LightState {
  if (sun.goldenHour) {
    // The server computes the elevation crossing that ends this golden hour. Reaching for sunset
    // instead put "until 20:26" on a 05:45 golden hour every summer morning — thirteen hours out
    // on the one number a photographer acts on.
    return {
      value: 'Golden hour',
      sub: sun.goldenUntil === null ? 'Best light now' : `until ${formatClock(sun.goldenUntil)}`,
    };
  }
  if (sun.isDaylight) {
    return {
      value: 'Daylight',
      sub: sun.sunsetAt === null ? 'Sunset unavailable' : `sunset ${formatClock(sun.sunsetAt)}`,
    };
  }
  return {
    value: 'Dark',
    sub: sun.sunriseAt === null ? 'Sunrise unavailable' : `sunrise ${formatClock(sun.sunriseAt)}`,
  };
}

/** The "what is happening right now" row. Four numbers that tick in place, never reflow. */
export function StatusStrip(): ReactElement {
  const { snapshot, loading } = useSnapshot();

  if (!snapshot) {
    return (
      <div className="strip" role="group" aria-label="Right now">
        <div className="strip-inner">
          {['Inbound', 'At LHR', 'Airborne', 'Light'].map((label) => (
            <div className="strip-cell" key={label}>
              <Stat
                label={label}
                value={<Skeleton width={38} height={18} />}
                sub={<Skeleton width={54} height={11} />}
              />
            </div>
          ))}
        </div>
        <span className="app-visually-hidden" role="status">
          {loading ? 'Loading live Heathrow status' : 'Live status unavailable'}
        </span>
      </div>
    );
  }

  const inbound = snapshot.arrivals.filter(
    (movement) => movement.phase === 'inbound' || movement.phase === 'approach',
  ).length;
  const onGround = snapshot.ground.length;
  const airborne = snapshot.stats.airborneWorldwide;
  const light = describeLight(snapshot.sun);

  // Soonest predicted touchdown, not merely the first row — arrivals are not sorted for us.
  let soonestAt: number | null = null;
  for (const movement of snapshot.arrivals) {
    if (movement.phase !== 'inbound' && movement.phase !== 'approach') continue;
    const at = movement.eta.at;
    if (at === null || !Number.isFinite(at)) continue;
    if (soonestAt === null || at < soonestAt) soonestAt = at;
  }

  return (
    <div className="strip" role="group" aria-label="Right now">
      <div className="strip-inner" aria-live="polite" aria-atomic="false">
        <div className="strip-cell strip-cell--arrival">
          <Stat
            label="Inbound"
            value={inbound}
            sub={
              soonestAt !== null
                ? `next ${formatClock(soonestAt)}`
                : inbound > 0
                  ? 'ETA unavailable'
                  : 'none tracked'
            }
          />
        </div>
        <div className="strip-cell">
          <Stat label="At LHR" value={onGround} sub="on the ground" />
        </div>
        <div className="strip-cell">
          <Stat label="Airborne" value={airborne} sub="worldwide" />
        </div>
        <div className="strip-cell strip-cell--light">
          <Stat
            label="Light"
            value={
              <span className="strip-light">
                <Icon name="sun" size={14} />
                {light.value}
              </span>
            }
            sub={light.sub}
          />
        </div>
      </div>
    </div>
  );
}
