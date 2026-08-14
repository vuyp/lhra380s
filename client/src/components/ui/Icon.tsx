import type { ReactElement, ReactNode } from 'react';
import './Icon.css';

export type IconName =
  | 'plane'
  | 'arrival'
  | 'departure'
  | 'map'
  | 'binoculars'
  | 'fleet'
  | 'wind'
  | 'sun'
  | 'clock'
  | 'runway'
  | 'close'
  | 'chevron'
  | 'location'
  | 'bell'
  | 'alert'
  | 'info'
  | 'external';

/**
 * The A380 planform, drawn once in a 64-unit box and reused by the wordmark and the map icon.
 * Long fuselage, deep wing sweep, wide span — recognisable as the whale even at 16px.
 */
export const A380_PLANFORM_PATH =
  'M32 6c2.1 0 3.4 2.6 3.6 6.4l.5 10.2 22.4 15.3c.7.5 1.1 1.3 1.1 2.1v3.3c0 .8-.8 1.4-1.6 1.1L36.4 37' +
  'l-.4 8.6 6.4 4.2c.5.4.8 1 .8 1.6v2.3c0 .7-.7 1.2-1.4 1L32 52.2l-9.8 2.5c-.7.2-1.4-.3-1.4-1v-2.3' +
  'c0-.6.3-1.2.8-1.6l6.4-4.2-.4-8.6-21.6 7.4c-.8.3-1.6-.3-1.6-1.1v-3.3c0-.8.4-1.6 1.1-2.1l22.4-15.3' +
  '.5-10.2C28.6 8.6 29.9 6 32 6z';

const SHAPES: Record<IconName, ReactNode> = {
  plane: <path d={A380_PLANFORM_PATH} fill="currentColor" stroke="none" transform="scale(0.375)" />,
  /* The same planform as the brand mark, banked onto final approach. */
  arrival: (
    <>
      <g transform="translate(12 9.5) rotate(135) scale(0.245) translate(-32 -32)">
        <path d={A380_PLANFORM_PATH} fill="currentColor" stroke="none" />
      </g>
      <path d="M4.5 20.5h15" />
    </>
  ),
  departure: (
    <>
      <g transform="translate(12 9.5) rotate(45) scale(0.245) translate(-32 -32)">
        <path d={A380_PLANFORM_PATH} fill="currentColor" stroke="none" />
      </g>
      <path d="M4.5 20.5h15" />
    </>
  ),
  map: (
    <>
      <path d="M9 3.6 3.7 5.9a1 1 0 0 0-.7.9v12.6c0 .7.7 1.2 1.4.9L9 18.9" />
      <path d="m9 3.6 6 2.4 4.6-2.4c.7-.3 1.4.2 1.4.9v12.6a1 1 0 0 1-.7.9L15 21l-6-2.1" />
      <path d="M9 3.6v15.3M15 6v15" />
    </>
  ),
  binoculars: (
    <>
      <circle cx="6.2" cy="15.6" r="3.9" />
      <circle cx="17.8" cy="15.6" r="3.9" />
      <path d="M10.1 15.6h3.8" />
      <path d="M8.4 12.3 9.1 5a1.4 1.4 0 0 0-1.4-1.5H5.9A1.4 1.4 0 0 0 4.5 5l-.7 7.5" />
      <path d="M15.6 12.3 14.9 5a1.4 1.4 0 0 1 1.4-1.5h1.8A1.4 1.4 0 0 1 19.5 5l.7 7.5" />
    </>
  ),
  fleet: (
    <>
      <path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h11" />
      <circle cx="19" cy="17.5" r="1.6" />
    </>
  ),
  wind: (
    <>
      <path d="M3 8.5h9.5a2.8 2.8 0 1 0-2.8-2.8" />
      <path d="M3 12.5h13a2.8 2.8 0 1 1-2.8 2.8" />
      <path d="M3 16.5h6.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 6.8V12l3.4 2" />
    </>
  ),
  runway: (
    <>
      <path d="M8.2 3.5 5.5 20.5M15.8 3.5l2.7 17" />
      <path d="M12 5.5v2.4M12 11v2.4M12 16.5v2.4" />
    </>
  ),
  close: <path d="M5.8 5.8l12.4 12.4M18.2 5.8 5.8 18.2" />,
  chevron: <path d="m9.5 5.5 6.4 6.5-6.4 6.5" />,
  location: (
    <>
      <path d="M12 21.2s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.6" />
    </>
  ),
  bell: (
    <>
      <path d="M18.2 16.5H5.8l1.3-2.2V10a4.9 4.9 0 0 1 9.8 0v4.3Z" />
      <path d="M10 19.4a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.8 21.2 19H2.8L12 3.8Z" />
      <path d="M12 9.6v4.1" />
      <circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 11.2v5" />
      <circle cx="12" cy="7.9" r="0.95" fill="currentColor" stroke="none" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="m19.5 4.5-7.8 7.8" />
      <path d="M18.4 14v4.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.4V7.2a1.6 1.6 0 0 1 1.6-1.6H10" />
    </>
  ),
};

/**
 * Icons are decorative by default — the surrounding control carries the accessible name —
 * so they are hidden from assistive tech.
 */
export function Icon(p: { name: IconName; size?: number; className?: string }): ReactElement {
  const size = p.size ?? 20;
  return (
    <svg
      className={p.className ? `ui-icon ${p.className}` : 'ui-icon'}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[p.name]}
    </svg>
  );
}
