import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from 'react';
import './Card.css';

interface CardProps {
  children: ReactNode;
  /** Airline brand colour for the left accent bar. Comes from the wire, never invented. */
  accent?: string;
  onClick?: () => void;
  className?: string;
  as?: 'div' | 'article' | 'li';
  /** DOM id, when something outside needs to scroll to or link at this card. */
  id?: string;
}

function accentStyle(accent: string | undefined): CSSProperties | undefined {
  if (!accent) return undefined;
  return { '--ui-card-accent': accent } as CSSProperties;
}

export function Card(p: CardProps): ReactElement {
  const { children, accent, onClick, className, as = 'div', id } = p;

  const classes = ['ui-card'];
  if (accent) classes.push('ui-card--accented');
  if (onClick) classes.push('ui-card--interactive');
  if (className) classes.push(className);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!onClick) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onClick();
  };

  const interactiveProps = onClick
    ? { role: 'button', tabIndex: 0, onClick, onKeyDown }
    : undefined;

  // A clickable list item keeps its list semantics: the button role goes on an inner box.
  if (as === 'li') {
    if (!onClick) {
      return (
        <li className={classes.join(' ')} style={accentStyle(accent)} id={id}>
          {children}
        </li>
      );
    }
    return (
      <li className="ui-card-item" id={id}>
        <div className={classes.join(' ')} style={accentStyle(accent)} {...interactiveProps}>
          {children}
        </div>
      </li>
    );
  }

  const Element = as;
  return (
    <Element className={classes.join(' ')} style={accentStyle(accent)} id={id} {...interactiveProps}>
      {children}
    </Element>
  );
}
