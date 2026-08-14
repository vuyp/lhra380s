import { useRef } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import './Segmented.css';

/**
 * A radio group that looks like a segmented control. Roving tabindex, arrow-key selection,
 * Home/End — the pattern screen-reader users expect from a set of radios.
 */
export function Segmented<T extends string>(p: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}): ReactElement {
  const { options, value, onChange, ariaLabel } = p;
  const groupRef = useRef<HTMLDivElement | null>(null);

  const moveTo = (index: number): void => {
    const count = options.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    const option = options[wrapped];
    if (!option) return;
    onChange(option.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('.ui-seg-option');
    buttons?.[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = options.findIndex((option) => option.value === value);
    if (current < 0) return;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        moveTo(current + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        moveTo(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        break;
      case 'End':
        event.preventDefault();
        moveTo(options.length - 1);
        break;
      default:
        break;
    }
  };

  const activeIndex = options.findIndex((option) => option.value === value);

  return (
    <div
      className="ui-seg"
      role="radiogroup"
      aria-label={ariaLabel}
      ref={groupRef}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={selected ? 'ui-seg-option ui-seg-option--on' : 'ui-seg-option'}
            tabIndex={selected || (activeIndex < 0 && index === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
