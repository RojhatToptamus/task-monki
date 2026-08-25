export type FocusedWorkspace = 'designs' | 'discourse';
export type FocusedPanel =
  | 'app-navigation'
  | 'design-history'
  | 'design-conversation'
  | 'discourse-history'
  | 'discourse-inspector';
export type SavedDesignLayout = 'chat' | 'split' | 'canvas';

interface WorkspaceLayoutPreferences {
  version: 1;
  historyCollapsed: Partial<Record<FocusedWorkspace, boolean>>;
  panelWidths: Partial<Record<FocusedPanel, number>>;
  designLayout?: SavedDesignLayout;
}

interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAYOUT_PREFERENCES_KEY = 'task-monki.workspace-layout.v1';
export const FOCUSED_WORKSPACE_COMPACT_VIEWPORT_WIDTH = 928;

function browserStorage(): LayoutStorage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

function readPreferences(storage: LayoutStorage | undefined): WorkspaceLayoutPreferences {
  if (!storage) return { version: 1, historyCollapsed: {}, panelWidths: {} };
  try {
    const parsed = JSON.parse(storage.getItem(LAYOUT_PREFERENCES_KEY) ?? '') as Partial<WorkspaceLayoutPreferences>;
    if (parsed.version !== 1 || !parsed.historyCollapsed) {
      return { version: 1, historyCollapsed: {}, panelWidths: {} };
    }
    return {
      version: 1,
      historyCollapsed: {
        ...(typeof parsed.historyCollapsed.designs === 'boolean'
          ? { designs: parsed.historyCollapsed.designs }
          : {}),
        ...(typeof parsed.historyCollapsed.discourse === 'boolean'
          ? { discourse: parsed.historyCollapsed.discourse }
          : {})
      },
      panelWidths: Object.fromEntries(
        Object.entries(parsed.panelWidths ?? {}).filter(
          (entry): entry is [FocusedPanel, number] =>
            ['app-navigation', 'design-history', 'design-conversation', 'discourse-history', 'discourse-inspector']
              .includes(entry[0]) &&
            typeof entry[1] === 'number' &&
            Number.isFinite(entry[1])
        )
      ),
      ...(['chat', 'split', 'canvas'].includes(parsed.designLayout ?? '')
        ? { designLayout: parsed.designLayout as SavedDesignLayout }
        : {})
    };
  } catch {
    return { version: 1, historyCollapsed: {}, panelWidths: {} };
  }
}

export function focusedWorkspaceHistoryCollapsed(
  workspace: FocusedWorkspace,
  storage: LayoutStorage | undefined = browserStorage()
): boolean {
  return readPreferences(storage).historyCollapsed[workspace] ?? false;
}

export function focusedWorkspaceUsesCompactHistory(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) &&
    viewportWidth < FOCUSED_WORKSPACE_COMPACT_VIEWPORT_WIDTH;
}

export function persistFocusedWorkspaceHistoryCollapsed(
  workspace: FocusedWorkspace,
  collapsed: boolean,
  storage: LayoutStorage | undefined = browserStorage()
): void {
  if (!storage) return;
  const current = readPreferences(storage);
  storage.setItem(LAYOUT_PREFERENCES_KEY, JSON.stringify({
    version: 1,
    historyCollapsed: {
      ...current.historyCollapsed,
      [workspace]: collapsed
    },
    panelWidths: current.panelWidths,
    ...(current.designLayout ? { designLayout: current.designLayout } : {})
  } satisfies WorkspaceLayoutPreferences));
}

export function focusedPanelWidth(
  panel: FocusedPanel,
  fallback: number,
  min: number,
  max: number,
  storage: LayoutStorage | undefined = browserStorage()
): number {
  const width = readPreferences(storage).panelWidths[panel] ?? fallback;
  return Math.min(max, Math.max(min, width));
}

export function persistFocusedPanelWidth(
  panel: FocusedPanel,
  width: number,
  storage: LayoutStorage | undefined = browserStorage()
): void {
  if (!storage || !Number.isFinite(width)) return;
  const current = readPreferences(storage);
  storage.setItem(LAYOUT_PREFERENCES_KEY, JSON.stringify({
    ...current,
    panelWidths: { ...current.panelWidths, [panel]: width }
  } satisfies WorkspaceLayoutPreferences));
}

export function savedDesignLayout(
  storage: LayoutStorage | undefined = browserStorage()
): SavedDesignLayout {
  return readPreferences(storage).designLayout ?? 'split';
}

export function persistDesignLayout(
  layout: SavedDesignLayout,
  storage: LayoutStorage | undefined = browserStorage()
): void {
  if (!storage) return;
  const current = readPreferences(storage);
  storage.setItem(LAYOUT_PREFERENCES_KEY, JSON.stringify({
    ...current,
    designLayout: layout
  } satisfies WorkspaceLayoutPreferences));
}
