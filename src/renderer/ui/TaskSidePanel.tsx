import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { focusedPanelWidth, persistFocusedPanelWidth } from '../model/workspaceLayout';
import { changeWithMotion, type ExpandMotion } from './expandMotion';
import { PanelResizeHandle } from './PanelResizeHandle';

const PANEL_DEFAULT_WIDTH = 380;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 560;
/** The rail, the gap between sheets, and the window margin around them. */
const SHELL_CHROME_WIDTH = 56 + 8 + 8;

/**
 * Where a task's assistant panel sits (DESIGN.md Appendix B, side panels): its own sheet
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

/** The sheet grows over the page like a drawer pulled further out, and folds back the same way. */
const SHEET_MOTION: ExpandMotion = { duration: '--motion-slow', easing: '--ease-drawer', scale: true };

/**
 * Whether the side sheet is expanded over the page. There is one side sheet on
 * screen at a time, and the conversation inside it can be portalled from
 * elsewhere in the tree (the Preview agent), so the state lives beside the
 * sheet rather than in a context. Closing the panel ends the expansion.
 */
let sheetElement: HTMLElement | null = null;
let sheetState: { expanded: boolean; available: boolean } = { expanded: false, available: false };
const sheetListeners = new Set<() => void>();

function setSheetState(next: typeof sheetState): void {
  if (next.expanded === sheetState.expanded && next.available === sheetState.available) return;
  sheetState = next;
  sheetListeners.forEach((listener) => listener());
}

function subscribeSheet(listener: () => void): () => void {
  sheetListeners.add(listener);
  return () => sheetListeners.delete(listener);
}

const readSheet = () => sheetState;

function attachSheet(element: HTMLElement | null): void {
  if (element) {
    sheetElement = element;
    setSheetState({ ...sheetState, available: true });
  } else {
    sheetElement = null;
    setSheetState({ expanded: false, available: false });
  }
}

function useSideSheetState() {
  return useSyncExternalStore(subscribeSheet, readSheet, readSheet);
}

/** For the panel's own head: whether it can expand, whether it is, and the change. */
export function useSideSheetExpansion(): {
  available: boolean;
  expanded: boolean;
  /** `animate` is false for a keyboard action, which is instant. */
  setExpanded(expanded: boolean, animate: boolean): void;
} {
  const { available, expanded } = useSideSheetState();
  return {
    available,
    expanded,
    setExpanded: (next, animate) => {
      if (next === sheetState.expanded || !sheetElement) return;
      changeWithMotion(animate ? sheetElement : undefined, () => setSheetState({ ...sheetState, expanded: next }), SHEET_MOTION);
    }
  };
}

/**
 * The docked sheet beside the page, with its resize handle on the shared edge.
 * The panel inside is the landmark, so the sheet itself is a plain box.
 * Expanded, it covers the page as well as its own place; a stand-in keeps the
 * page's width, so nothing under it reflows and collapsing finds it as it was.
 */
export function DockedSidePanel({ width, maxWidth, onWidthChange, label, children }: {
  width: number;
  maxWidth: number;
  onWidthChange(width: number): void;
  label: string;
  children: ReactNode;
}) {
  const { expanded } = useSideSheetState();
  return (
    <>
      {expanded ? <div className="tm-side-sheet__room" style={{ flexBasis: width }} aria-hidden="true" /> : null}
      <div ref={attachSheet} className="tm-side-sheet" data-expanded={expanded ? '' : undefined} style={{ flexBasis: width }}>
        {expanded ? null : (
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
        )}
        {children}
      </div>
    </>
  );
}

/** The same panel over the page when the window is too narrow to dock it; expanded, it covers the page. */
export function FloatingSidePanel({ children }: { children: ReactNode }) {
  const { expanded } = useSideSheetState();
  return (
    <div ref={attachSheet} className="tm-side-sheet tm-side-sheet--floating" data-expanded={expanded ? '' : undefined}>
      {children}
    </div>
  );
}
