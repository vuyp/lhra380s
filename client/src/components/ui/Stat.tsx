import type { ReactElement, ReactNode } from 'react';
import './Stat.css';

/**
 * Label above, value below. The value box reserves its line height so a number changing
 * from 9 to 10 — or to a dash — never nudges the layout.
 */
export function Stat(p: { label: string; value: ReactNode; sub?: ReactNode }): ReactElement {
  return (
    <div className="ui-stat">
      <span className="ui-stat-label">{p.label}</span>
      <span className="ui-stat-value app-numeric">{p.value}</span>
      {p.sub ? <span className="ui-stat-sub">{p.sub}</span> : null}
    </div>
  );
}
