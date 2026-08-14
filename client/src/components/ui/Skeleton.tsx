import type { CSSProperties, ReactElement } from 'react';
import './Skeleton.css';

function size(value: number | string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return typeof value === 'number' ? `${value}px` : value;
}

/** A placeholder block sized exactly like the content it stands in for, so nothing jumps. */
export function Skeleton(p: {
  height?: number | string;
  width?: number | string;
  radius?: string;
}): ReactElement {
  const style: CSSProperties = {
    height: size(p.height, '1rem'),
    width: size(p.width, '100%'),
    borderRadius: p.radius ?? 'var(--radius-sm)',
  };
  return <span className="ui-skeleton" style={style} aria-hidden="true" />;
}
