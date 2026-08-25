import { describe, expect, it } from 'vitest';
import {
  FOCUSED_WORKSPACE_COMPACT_VIEWPORT_WIDTH,
  focusedPanelWidth,
  focusedWorkspaceHistoryCollapsed,
  focusedWorkspaceUsesCompactHistory,
  persistDesignLayout,
  persistFocusedPanelWidth,
  persistFocusedWorkspaceHistoryCollapsed,
  savedDesignLayout
} from './workspaceLayout';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    }
  };
}

describe('focused workspace layout preferences', () => {
  it('accounts for the compact app rail when deciding history behavior', () => {
    expect(focusedWorkspaceUsesCompactHistory(
      FOCUSED_WORKSPACE_COMPACT_VIEWPORT_WIDTH - 1
    )).toBe(true);
    expect(focusedWorkspaceUsesCompactHistory(
      FOCUSED_WORKSPACE_COMPACT_VIEWPORT_WIDTH
    )).toBe(false);
    expect(focusedWorkspaceUsesCompactHistory(Number.NaN)).toBe(false);
  });

  it('keeps Design and Discourse history choices independent', () => {
    const storage = memoryStorage();
    persistFocusedWorkspaceHistoryCollapsed('designs', true, storage);

    expect(focusedWorkspaceHistoryCollapsed('designs', storage)).toBe(true);
    expect(focusedWorkspaceHistoryCollapsed('discourse', storage)).toBe(false);

    persistFocusedWorkspaceHistoryCollapsed('discourse', true, storage);
    expect(focusedWorkspaceHistoryCollapsed('designs', storage)).toBe(true);
    expect(focusedWorkspaceHistoryCollapsed('discourse', storage)).toBe(true);
  });

  it('repairs malformed and unknown preference records to defaults', () => {
    expect(focusedWorkspaceHistoryCollapsed('designs', memoryStorage('{bad'))).toBe(false);
    expect(focusedWorkspaceHistoryCollapsed(
      'discourse',
      memoryStorage(JSON.stringify({ version: 2, historyCollapsed: { discourse: true } }))
    )).toBe(false);
  });

  it('persists panel widths and clamps values at the point of use', () => {
    const storage = memoryStorage();
    persistFocusedPanelWidth('app-navigation', 224, storage);
    persistFocusedPanelWidth('design-history', 410, storage);

    expect(focusedPanelWidth('app-navigation', 176, 176, 240, storage)).toBe(224);
    expect(focusedPanelWidth('design-history', 268, 220, 360, storage)).toBe(360);
    expect(focusedPanelWidth('discourse-history', 268, 220, 360, storage)).toBe(268);
  });

  it('persists the last selected Design layout without affecting other preferences', () => {
    const storage = memoryStorage();
    persistFocusedWorkspaceHistoryCollapsed('designs', true, storage);
    persistDesignLayout('canvas', storage);

    expect(savedDesignLayout(storage)).toBe('canvas');
    expect(focusedWorkspaceHistoryCollapsed('designs', storage)).toBe(true);
  });
});
