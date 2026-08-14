import { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactElement, ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import './Sheet.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The elements inside `root` that Tab will actually stop on, in order.
 *
 * The `tabIndex >= 0` test is what makes this a focus trap rather than a decoration. A roving
 * tabindex — which the segmented controls inside the settings sheet use — leaves every unselected
 * option as a `<button tabindex="-1">`, and those still match the selector above. Counting them
 * meant `last` was an element Tab could never reach, the wrap at the end never fired, and Tab
 * walked straight out of an `aria-modal` dialog into the page behind the scrim.
 */
export function collectTabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      (element.offsetParent !== null || element === document.activeElement),
  );
}

/**
 * A modal bottom sheet on phones, a centred dialog from 720px up.
 * Traps focus, closes on Escape and on backdrop press, restores focus on the way out.
 */
export function Sheet(p: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}): ReactElement | null {
  const { open, onClose, title, children } = p;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Callers almost always pass an inline arrow for onClose. Routing it through a ref keeps the
  // scroll-lock / focus effect below dependent on `open` alone, so it never re-runs mid-edit
  // and steals focus back from a control inside the sheet.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;
    const items = collectTabbable(panel);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    document.addEventListener('keydown', handleKeyDown, true);

    // Focus the panel itself so a screen reader announces the dialog title first.
    const raf = window.requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown, true);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
      returnFocusRef.current?.focus();
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return createPortal(
    <div className="ui-sheet-root">
      <button
        type="button"
        className="ui-sheet-scrim"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className="ui-sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : 'Details'}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="ui-sheet-grabber" aria-hidden="true" />
        <div className="ui-sheet-head">
          <h2 className="ui-sheet-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="ui-sheet-close" onClick={onClose}>
            <Icon name="close" size={20} />
            <span className="app-visually-hidden">Close</span>
          </button>
        </div>
        <div className="ui-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
