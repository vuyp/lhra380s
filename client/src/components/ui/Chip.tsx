import type { ReactElement, ReactNode } from 'react';
import './Chip.css';

export type Tone = 'arrival' | 'departure' | 'neutral' | 'live' | 'warn';

export function Chip(p: {
  children: ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md';
  title?: string;
}): ReactElement {
  const tone = p.tone ?? 'neutral';
  const size = p.size ?? 'md';
  return (
    <span className={`ui-chip ui-chip--${tone} ui-chip--${size}`} title={p.title}>
      {tone === 'live' ? <span className="ui-chip-pulse" aria-hidden="true" /> : null}
      <span className="ui-chip-label">{p.children}</span>
    </span>
  );
}
