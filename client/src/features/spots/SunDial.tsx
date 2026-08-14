/**
 * SunDial — a plan-view sun instrument for one spotting position.
 *
 * The dial is drawn from the spotter's point of view. Straight up is the direction you look
 * from this spot; the outer ring is the horizon and the centre is the zenith, so how far the
 * sun sits from the rim reads directly as how high it is. The shaded wedge is roughly what a
 * long lens frames from here — a sun inside that wedge is a sun you are shooting into.
 *
 * Everything drawn comes from snapshot.sun and the spot's own view bearing. The verdict wording
 * follows the server's light classification so the dial can never contradict the ranking, and
 * when the feed has not reported a sun position we draw the empty instrument and say so.
 */

import { useId } from 'react';
import type { ReactElement } from 'react';
import type { SpotEvaluation, SunInfo } from '../../../../shared/types.ts';
import { compassPoint, formatClock } from '../../lib/format.ts';
import './SunDial.css';

type Light = SpotEvaluation['light'];

/* Geometry, in viewBox units. The whole instrument lives in a 120 × 120 box. */
const CENTRE = 60;
const HORIZON_R = 42;
const BELOW_HORIZON_R = HORIZON_R + 8;
const CONE_HALF_ANGLE = 30;
const OFFSET_ARC_R = HORIZON_R + 8;

/** Altitude rings, drawn where 30° and 60° above the horizon fall. */
const RINGS = [
  { elevation: 30, r: HORIZON_R * (2 / 3) },
  { elevation: 60, r: HORIZON_R / 3 },
];

const LIGHT_LABELS: Record<Light, string> = {
  ideal: 'Ideal light',
  workable: 'Workable light',
  backlit: 'Backlit',
  dark: 'Dark',
};

const LIGHT_MEANINGS: Record<Light, string> = {
  ideal: 'Sun behind you — colour and detail on the fuselage',
  workable: 'Sun off to one side — usable, watch your exposure',
  backlit: 'Sun in front of you — silhouettes unless you expose for the shadow side',
  dark: 'Sun below the horizon — floodlit and long-exposure shots only',
};

/** Short badge text for the light quality. */
export function lightLabel(light: Light): string {
  return LIGHT_LABELS[light] ?? 'Light unknown';
}

/** What that light quality actually means with a camera in your hands. */
export function lightMeaning(light: Light): string {
  return LIGHT_MEANINGS[light] ?? 'The light at this spot could not be worked out.';
}

/** Signed difference in degrees, folded into (-180, 180]. Positive means clockwise / to the right. */
function signedDelta(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** Screen coordinates for a bearing relative to the view axis (0 = straight ahead, up). */
function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CENTRE + radius * Math.sin(rad), y: CENTRE - radius * Math.cos(rad) };
}

function point(angleDeg: number, radius: number): string {
  const p = polar(angleDeg, radius);
  return `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
}

function conePath(): string {
  return (
    `M ${CENTRE} ${CENTRE} L ${point(-CONE_HALF_ANGLE, HORIZON_R)} ` +
    `A ${HORIZON_R} ${HORIZON_R} 0 0 1 ${point(CONE_HALF_ANGLE, HORIZON_R)} Z`
  );
}

/** The arc along the rim from your view line round to the sun — the off-axis angle, drawn. */
function offsetArcPath(relative: number): string | null {
  if (Math.abs(relative) < 3) return null;
  const sweep = relative > 0 ? 1 : 0;
  return (
    `M ${point(0, OFFSET_ARC_R)} ` +
    `A ${OFFSET_ARC_R} ${OFFSET_ARC_R} 0 0 ${sweep} ${point(relative, OFFSET_ARC_R)}`
  );
}

interface Verdict {
  headline: string;
  detail: string;
}

function verdictFor(light: Light, sun: SunInfo, relative: number): Verdict {
  const offset = Math.round(Math.abs(relative));
  const height = Math.round(sun.elevation);
  const side = relative > 0 ? 'right' : 'left';
  const golden = sun.goldenHour ? ' Golden hour — the light is low and warm right now.' : '';

  if (light === 'dark') {
    const sunrise = sun.sunriseAt === null ? null : formatClock(sun.sunriseAt);
    return {
      headline: 'Dark — floodlit shots only',
      detail: sunrise
        ? `The sun is ${Math.abs(height)}° below the horizon. Work with the approach lights and the apron floods; first light is at ${sunrise}.`
        : `The sun is ${Math.abs(height)}° below the horizon. Work with the approach lights and the apron floods.`,
    };
  }

  if (light === 'backlit') {
    return {
      headline: 'Into the sun — backlit',
      detail: `The sun is only ${offset}° off your view line and ${height}° up, so it sits in or near the frame. Silhouettes and heavy flare unless you expose for the shadow side.${golden}`,
    };
  }

  if (light === 'ideal') {
    return {
      headline: 'Sun behind you — ideal',
      detail: `${offset}° off your view line and ${height}° up, so it lands on the side of the aircraft you can see.${golden}`,
    };
  }

  return {
    headline: `Sun to your ${side} — workable`,
    detail: `${offset}° off your view line and ${height}° up. Side light: fine for shape and detail, but watch for a blown-out wing.${golden}`,
  };
}

export function SunDial(p: {
  sun: SunInfo | null;
  viewBearing: number;
  light: Light;
  size?: number;
}): ReactElement {
  const { sun, viewBearing, light } = p;
  const size = p.size ?? 128;
  // React ids carry colons; strip them so the value is safe inside a url(#…) reference.
  const uid = useId().replace(/:/g, '');
  const glowId = `${uid}-glow`;
  const coneId = `${uid}-cone`;

  const relative = sun ? signedDelta(sun.azimuth - viewBearing) : null;
  const belowHorizon = sun ? sun.elevation < 0 : false;
  const sunRadius =
    sun === null
      ? 0
      : belowHorizon
        ? BELOW_HORIZON_R
        : HORIZON_R * (1 - Math.min(90, sun.elevation) / 90);
  const sunPoint = relative === null ? null : polar(relative, sunRadius);
  const offsetArc = relative === null ? null : offsetArcPath(relative);
  const northPoint = polar(-viewBearing, HORIZON_R + 12);

  const verdict: Verdict = sun
    ? verdictFor(light, sun, relative ?? 0)
    : {
        headline: 'Sun position unavailable',
        detail:
          'The live feed has not reported a sun position yet, so we cannot tell you which way the light is falling here.',
      };

  const dialClasses = ['sun-dial'];
  if (belowHorizon) dialClasses.push('sun-dial--night');
  if (!sun) dialClasses.push('sun-dial--empty');

  return (
    <figure className="sun">
      <div className="sun-top">
        <svg
          className={dialClasses.join(' ')}
          viewBox="0 0 120 120"
          width={size}
          height={size}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <radialGradient id={coneId} gradientUnits="userSpaceOnUse" cx={CENTRE} cy={CENTRE} r={HORIZON_R}>
              <stop offset="0%" className="sun-cone-stop-in" />
              <stop offset="100%" className="sun-cone-stop-out" />
            </radialGradient>
            <radialGradient id={glowId} gradientUnits="objectBoundingBox" cx="50%" cy="50%" r="50%">
              <stop offset="0%" className="sun-glow-stop-in" />
              <stop offset="100%" className="sun-glow-stop-out" />
            </radialGradient>
          </defs>

          {/* What the lens sees from here. */}
          <path className="sun-cone" d={conePath()} fill={`url(#${coneId})`} />
          <path
            className="sun-cone-edge"
            d={`M ${CENTRE} ${CENTRE} L ${point(-CONE_HALF_ANGLE, HORIZON_R)} M ${CENTRE} ${CENTRE} L ${point(CONE_HALF_ANGLE, HORIZON_R)}`}
          />

          {/* The sky: horizon at the rim, zenith at the centre. */}
          {RINGS.map((ring) => (
            <circle
              key={ring.elevation}
              className="sun-ring sun-ring--minor"
              cx={CENTRE}
              cy={CENTRE}
              r={ring.r}
            />
          ))}
          <circle className="sun-ring sun-ring--horizon" cx={CENTRE} cy={CENTRE} r={HORIZON_R} />
          <circle className="sun-zenith" cx={CENTRE} cy={CENTRE} r={1.6} />

          {/* Your view line, and true north so the dial can be held up against the real world. */}
          <path className="sun-axis" d={`M ${CENTRE} ${CENTRE} L ${point(0, HORIZON_R)}`} />
          <path
            className="sun-axis-head"
            d={`M ${point(0, HORIZON_R + 5)} L ${point(-7, HORIZON_R - 3)} M ${point(0, HORIZON_R + 5)} L ${point(7, HORIZON_R - 3)}`}
          />
          <text
            className="sun-north"
            x={northPoint.x}
            y={northPoint.y}
            textAnchor="middle"
            dominantBaseline="central"
          >
            N
          </text>

          {offsetArc ? <path className="sun-offset-arc" d={offsetArc} /> : null}

          {sunPoint && sun ? (
            belowHorizon ? (
              <circle className="sun-disc sun-disc--below" cx={sunPoint.x} cy={sunPoint.y} r={5} />
            ) : (
              <g>
                <circle
                  className="sun-glow"
                  cx={sunPoint.x}
                  cy={sunPoint.y}
                  r={13}
                  fill={`url(#${glowId})`}
                />
                {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
                  const rad = (angle * Math.PI) / 180;
                  return (
                    <path
                      key={angle}
                      className="sun-ray"
                      d={`M ${(sunPoint.x + Math.cos(rad) * 8).toFixed(2)} ${(sunPoint.y + Math.sin(rad) * 8).toFixed(2)} L ${(sunPoint.x + Math.cos(rad) * 10.5).toFixed(2)} ${(sunPoint.y + Math.sin(rad) * 10.5).toFixed(2)}`}
                    />
                  );
                })}
                <circle className="sun-disc" cx={sunPoint.x} cy={sunPoint.y} r={6} />
              </g>
            )
          ) : null}
        </svg>

        <figcaption className="sun-caption">
          <p className="sun-headline">{verdict.headline}</p>
          <p className="sun-detail">{verdict.detail}</p>
        </figcaption>
      </div>

      <dl className="sun-facts">
        <div className="sun-fact">
          <dt>Sun</dt>
          <dd className="app-numeric">
            {sun ? `${compassPoint(sun.azimuth)} ${Math.round(sun.azimuth)}°` : '—'}
          </dd>
        </div>
        <div className="sun-fact">
          <dt>Height</dt>
          <dd className="app-numeric">{sun ? `${Math.round(sun.elevation)}°` : '—'}</dd>
        </div>
        <div className="sun-fact">
          <dt>Off your view</dt>
          <dd className="app-numeric">
            {relative === null ? '—' : `${Math.round(Math.abs(relative))}°`}
          </dd>
        </div>
        <div className="sun-fact">
          <dt>{sun && sun.isDaylight ? 'Sunset' : 'Sunrise'}</dt>
          <dd className="app-numeric">
            {sun ? formatClock(sun.isDaylight ? sun.sunsetAt : sun.sunriseAt) : '—'}
          </dd>
        </div>
      </dl>
    </figure>
  );
}
