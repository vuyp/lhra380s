/** Which airframe the detail sheet is showing, shared across board, map and fleet. */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

export interface SelectionContextValue {
  selectedHex: string | null;
  select: (hex: string | null) => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider(props: { children: ReactNode }): ReactElement {
  const [selectedHex, setSelectedHex] = useState<string | null>(null);

  const select = useCallback((hex: string | null) => {
    setSelectedHex(hex ? hex.toLowerCase() : null);
  }, []);

  const value = useMemo<SelectionContextValue>(
    () => ({ selectedHex, select }),
    [selectedHex, select],
  );

  return <SelectionContext.Provider value={value}>{props.children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionContextValue {
  const value = useContext(SelectionContext);
  if (!value) throw new Error('useSelection must be used inside <SelectionProvider>');
  return value;
}
