import { useEffect, useState, type ReactNode } from 'react';
import { focusedPanelWidth, persistFocusedPanelWidth } from '../model/workspaceLayout';
import { PanelResizeHandle } from './PanelResizeHandle';

const PANEL_DEFAULT_WIDTH = 380;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 560;
/** The rail, the gap between sheets, and the window margin around them. */
const SHELL_CHROME_WIDTH = 56 + 8 + 8;

/**
 * Where a task's assistant panel sits (DESIGN.md 5, side panels): its own sheet
 * beside the page, narrowing toward its minimum before the page drops below
 * `minContentWidth`, and floating over the page only when even that does not
 * fit. The chosen width is the person's and persists; a narrow window lends
 * the panel less without changing it.
 */
export function useTaskSidePanelLayout(minContentWidth: number): {
  docked: boolean;
  width: number;
  /** The widest the panel can be in this window, never beyond its own maximum. */
  maxWidth: number;
  setWidth(width: number): void;
} {
  const [width, setWidthState] = useState(() => focusedPanelWidth('task-side-panel', PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH));
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const room = viewport - SHELL_CHROME_WIDTH - minContentWidth;
  const maxWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, room));
  return {
    docked: room >= PANEL_MIN_WIDTH,
    width: Math.min(Math.max(PANEL_MIN_WIDTH, width), maxWidth),
    maxWidth,
    setWidth: (next) => {
      setWidthState(next);
      persistFocusedPanelWidth('task-side-panel', next);
    }
  };
}

/**
 * The docked sheet beside the page, with its resize handle on the shared edge.
 * The panel inside is the landmark, so the sheet itself is a plain box.
 */
export function DockedSidePanel({ width, maxWidth, onWidthChange, label, children }: {
  width: number;
  maxWidth: number;
  onWidthChange(width: number): void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="tm-side-sheet" style={{ flexBasis: width }}>
      <PanelResizeHandle
        className="tm-side-sheet__resize"
        label={`Resize ${label}`}
        value={width}
        min={PANEL_MIN_WIDTH}
        max={maxWidth}
        defaultValue={PANEL_DEFAULT_WIDTH}
        direction={-1}
        onChange={onWidthChange}
      />
      {children}
    </div>
  );
}

/** The same panel over the page when the window is too narrow to dock it. */
export function FloatingSidePanel({ children }: { children: ReactNode }) {
  return <div className="tm-side-sheet tm-side-sheet--floating">{children}</div>;
}
