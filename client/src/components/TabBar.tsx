import { useRef } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { Icon } from './ui/Icon.tsx';
import type { IconName } from './ui/Icon.tsx';
import './TabBar.css';

export type TabId = 'board' | 'map' | 'spots' | 'fleet';

export interface TabDefinition {
  id: TabId;
  label: string;
  icon: IconName;
  /** Spoken name — the visible label is short by design. */
  description: string;
}

export const TABS: readonly TabDefinition[] = [
  { id: 'board', label: 'Board', icon: 'arrival', description: 'Arrivals and departures board' },
  { id: 'map', label: 'Map', icon: 'map', description: 'Live map around Heathrow' },
  { id: 'spots', label: 'Spots', icon: 'binoculars', description: 'Spotting locations for now' },
  { id: 'fleet', label: 'Fleet', icon: 'fleet', description: 'Movement log and world fleet' },
];

export function tabPanelId(id: TabId): string {
  return `tab-panel-${id}`;
}

export function tabButtonId(id: TabId): string {
  return `tab-button-${id}`;
}

/** Bottom bar on phones, left rail from 900px. Roving tabindex, arrow keys, Home/End. */
export function TabBar(p: { active: TabId; onChange: (id: TabId) => void }): ReactElement {
  const listRef = useRef<HTMLDivElement | null>(null);

  const focusTab = (index: number): void => {
    const wrapped = ((index % TABS.length) + TABS.length) % TABS.length;
    const tab = TABS[wrapped];
    if (!tab) return;
    p.onChange(tab.id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('.tab-item')[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = TABS.findIndex((tab) => tab.id === p.active);
    if (index < 0) return;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusTab(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusTab(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(TABS.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <nav className="tab-bar" aria-label="Main views">
      <div className="tab-list" role="tablist" aria-label="Main views" ref={listRef} onKeyDown={onKeyDown}>
        {TABS.map((tab) => {
          const selected = tab.id === p.active;
          return (
            <button
              key={tab.id}
              id={tabButtonId(tab.id)}
              type="button"
              role="tab"
              className={selected ? 'tab-item tab-item--on' : 'tab-item'}
              aria-selected={selected}
              /* Only the selected panel is mounted, so only its tab may point at one. */
              aria-controls={selected ? tabPanelId(tab.id) : undefined}
              tabIndex={selected ? 0 : -1}
              title={tab.description}
              onClick={() => p.onChange(tab.id)}
            >
              <span className="tab-icon">
                <Icon name={tab.icon} size={22} />
              </span>
              <span className="tab-label">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
