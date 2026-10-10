import { useEffect, useState, type ReactNode } from 'react';
import { focusedPanelWidth, persistFocusedPanelWidth } from '../model/workspaceLayout';
import { PanelResizeHandle } from './PanelResizeHandle';

const PANEL_DEFAULT_WIDTH = 380;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 560;
/** The rail, the gap between sheets, and the window margin around them. */
const SHELL_CHROME_WIDTH = 56 + 8 + 8;

/**
 * Where a task's assistant panel sits (DESIGN.md 5, side panels): docked as its
 * own sheet while the page keeps `minContentWidth`, floating over the page
 * below that. The width is the person's and persists.
 */
export function useTaskSidePanelLayout(minContentWidth: number): {
  docked: boolean;
  width: number;
  setWidth(width: number): void;
} {
  const [width, setWidthState] = useState(() => focusedPanelWidth('task-side-panel', PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH));
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return {
    docked: viewport - SHELL_CHROME_WIDTH - width >= minContentWidth,
    width,
    setWidth: (next) => {
      setWidthState(next);
      persistFocusedPanelWidth('task-side-panel', next);
    }
  };
}

/** The docked sheet beside the page, with its resize handle on the shared edge. */
export function DockedSidePanel({ width, onWidthChange, label, children }: {
  width: number;
  onWidthChange(width: number): void;
  label: string;
  children: ReactNode;
}) {
  return (
    <aside className="tm-side-sheet" style={{ flexBasis: width }} aria-label={label}>
      <PanelResizeHandle
        className="tm-side-sheet__resize"
        label={`Resize ${label}`}
        value={width}
        min={PANEL_MIN_WIDTH}
        max={PANEL_MAX_WIDTH}
        defaultValue={PANEL_DEFAULT_WIDTH}
        direction={-1}
        onChange={onWidthChange}
      />
      {children}
    </aside>
  );
}

/** The same panel over the page when the window is too narrow to dock it. */
export function FloatingSidePanel({ label, children }: { label: string; children: ReactNode }) {
  return <aside className="tm-side-sheet tm-side-sheet--floating" aria-label={label}>{children}</aside>;
}
