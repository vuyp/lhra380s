import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { SnapshotProvider, useSnapshot } from './api/useSnapshot.ts';
import { useArrivalAlerts } from './lib/notifications.ts';
import { SelectionProvider } from './state/selection.tsx';
import { SettingsProvider } from './state/settings.tsx';
import { AppHeader } from './components/AppHeader.tsx';
import { StatusStrip } from './components/StatusStrip.tsx';
import { TABS, TabBar, tabButtonId, tabPanelId } from './components/TabBar.tsx';
import type { TabId } from './components/TabBar.tsx';
import { EmptyState } from './components/ui/EmptyState.tsx';
import { Icon } from './components/ui/Icon.tsx';
import { Skeleton } from './components/ui/Skeleton.tsx';
import { BoardTab } from './features/board/BoardTab.tsx';
import { SpotsTab } from './features/spots/SpotsTab.tsx';
import { FleetTab } from './features/fleet/FleetTab.tsx';
import { AircraftSheet } from './features/detail/AircraftSheet.tsx';
import './App.css';

/** Leaflet is heavy — keep it out of the first bundle until the map tab is opened. */
const MapTab = lazy(() =>
  import('./features/map/MapTab.tsx').then((module) => ({ default: module.MapTab })),
);

const DEFAULT_TAB: TabId = 'board';

function parseHash(hash: string): TabId | null {
  const value = hash.replace(/^#\/?/, '').trim().toLowerCase();
  const match = TABS.find((tab) => tab.id === value);
  return match ? match.id : null;
}

/** The active view lives in the URL hash, so any screen can be shared and reloaded. */
function useTabRoute(): { active: TabId; setActive: (id: TabId) => void } {
  const [active, setActiveState] = useState<TabId>(
    () => parseHash(window.location.hash) ?? DEFAULT_TAB,
  );

  useEffect(() => {
    if (parseHash(window.location.hash) === null) {
      window.history.replaceState(null, '', `#${DEFAULT_TAB}`);
    }
    const onHashChange = () => setActiveState(parseHash(window.location.hash) ?? DEFAULT_TAB);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const setActive = useCallback((id: TabId) => {
    setActiveState(id);
    if (parseHash(window.location.hash) !== id) window.location.hash = `#${id}`;
  }, []);

  return { active, setActive };
}

/* ---- Error boundary ---------------------------------------------------------- */

interface BoundaryProps {
  children: ReactNode;
  label: string;
}

interface BoundaryState {
  message: string | null;
}

class TabErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return {
      message:
        error instanceof Error && error.message ? error.message : 'An unexpected error occurred',
    };
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <EmptyState
        icon={<Icon name="alert" size={24} />}
        title={`The ${this.props.label} view stopped working`}
        message={`${this.state.message}. The live feed is still running — switch tabs and come back, or reload the page.`}
        action={
          <button type="button" className="app-button" onClick={() => window.location.reload()}>
            Reload Whale Watch
          </button>
        }
      />
    );
  }
}

/* ---- Loading & failure states -------------------------------------------------- */

function TabSkeleton(): ReactElement {
  return (
    <div className="app-skeleton" aria-hidden="true">
      <Skeleton height={132} radius="var(--radius-xl)" />
      <Skeleton height={18} width="38%" />
      <Skeleton height={96} radius="var(--radius-lg)" />
      <Skeleton height={96} radius="var(--radius-lg)" />
      <Skeleton height={96} radius="var(--radius-lg)" />
    </div>
  );
}

function FirstLoad(): ReactElement {
  return (
    <>
      <p className="app-visually-hidden" role="status">
        Loading live Heathrow A380 traffic
      </p>
      <TabSkeleton />
    </>
  );
}

function ConnectionFailure(p: { message: string }): ReactElement {
  return (
    <EmptyState
      icon={<Icon name="alert" size={24} />}
      title="Can't reach the Whale Watch server"
      message={`${p.message}. Nothing is being shown because we have no data yet — we would rather show you nothing than something invented. Reconnection is retrying in the background.`}
      action={
        <button type="button" className="app-button" onClick={() => window.location.reload()}>
          Try again
        </button>
      }
    />
  );
}

/* ---- Shell --------------------------------------------------------------------- */

function TabContent(p: { active: TabId }): ReactElement {
  switch (p.active) {
    case 'board':
      return <BoardTab />;
    case 'map':
      return (
        <Suspense fallback={<TabSkeleton />}>
          <MapTab />
        </Suspense>
      );
    case 'spots':
      return <SpotsTab />;
    case 'fleet':
      return <FleetTab />;
    default:
      return <BoardTab />;
  }
}

function AppShell(): ReactElement {
  const { active, setActive } = useTabRoute();
  const { snapshot, loading, error } = useSnapshot();
  const topbarRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);

  // Runs the arrival-alert engine for the session. Returns UI state used in the settings sheet.
  useArrivalAlerts();

  // The desktop rail sticks directly under the header, whose height depends on its content.
  useLayoutEffect(() => {
    const node = topbarRef.current;
    if (!node) return;
    const apply = () => {
      document.documentElement.style.setProperty(
        '--app-topbar-height',
        `${Math.round(node.getBoundingClientRect().height)}px`,
      );
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--app-topbar-height');
    };
  }, []);

  const activeTab = TABS.find((tab) => tab.id === active) ?? TABS[0];
  const showFirstLoad = loading && !snapshot;
  const showFailure = !snapshot && !loading && error !== null;

  return (
    <div className="app-shell">
      <button
        type="button"
        className="app-skip-link"
        onClick={() => mainRef.current?.focus()}
      >
        Skip to content
      </button>

      <div className="app-topbar" ref={topbarRef}>
        <AppHeader />
        <StatusStrip />
      </div>

      <div className="app-body">
        <TabBar active={active} onChange={setActive} />

        <main className="app-main" ref={mainRef} tabIndex={-1} aria-label="Live Heathrow A380s">
          <div
            className="app-panel"
            id={tabPanelId(active)}
            role="tabpanel"
            aria-labelledby={tabButtonId(active)}
          >
            {showFirstLoad ? (
              <FirstLoad />
            ) : showFailure ? (
              <ConnectionFailure message={error ?? 'Connection failed'} />
            ) : (
              <TabErrorBoundary key={active} label={activeTab?.label.toLowerCase() ?? 'current'}>
                <TabContent active={active} />
              </TabErrorBoundary>
            )}
          </div>
        </main>
      </div>

      <AircraftSheet />
    </div>
  );
}

export default function App(): ReactElement {
  return (
    <SettingsProvider>
      <SnapshotProvider>
        <SelectionProvider>
          <AppShell />
        </SelectionProvider>
      </SnapshotProvider>
    </SettingsProvider>
  );
}
