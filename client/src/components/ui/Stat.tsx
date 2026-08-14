import type { ReactElement, ReactNode } from 'react';
import './Stat.css';

/**
 * Label above, value below. The value box reserves its line height so a number changing
 * from 9 to 10 — or to a dash — never nudges the layout.
 *
 * `wrap` gives the caption a reserved two-line box instead of an ellipsis, for the wide fact
 * grids where a caption like "predicted · high confidence" deserves to be read in full.
 */
export function Stat(p: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  wrap?: boolean;
}): ReactElement {
  return (
    <div className={p.wrap ? 'ui-stat ui-stat--wrap' : 'ui-stat'}>
      <span className="ui-stat-label">{p.label}</span>
      <span className="ui-stat-value app-numeric">{p.value}</span>
      {p.sub ? <span className="ui-stat-sub">{p.sub}</span> : null}
    </div>
  );
}
