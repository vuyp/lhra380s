import type { ReactElement, ReactNode } from 'react';
import './EmptyState.css';

/**
 * Empty is a designed state, not a failure. Always says what is true and what to do next.
 */
export function EmptyState(p: {
  title: string;
  message: string;
  icon?: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="ui-empty">
      {p.icon ? (
        <div className="ui-empty-icon" aria-hidden="true">
          {p.icon}
        </div>
      ) : null}
      <p className="ui-empty-title">{p.title}</p>
      <p className="ui-empty-message">{p.message}</p>
      {p.action ? <div className="ui-empty-action">{p.action}</div> : null}
    </div>
  );
}
