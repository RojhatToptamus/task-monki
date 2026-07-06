import { describe, expect, it } from 'vitest';
import { shouldCreateWindowOnActivate } from './windowLifecycle';

describe('shouldCreateWindowOnActivate', () => {
  it('blocks macOS activation windows before IPC handlers are installed', () => {
    expect(
      shouldCreateWindowOnActivate({
        ipcHandlersInstalled: false,
        openWindowCount: 0
      })
    ).toBe(false);
  });

  it('creates an activation window only after startup is ready and no windows exist', () => {
    expect(
      shouldCreateWindowOnActivate({
        ipcHandlersInstalled: true,
        openWindowCount: 0
      })
    ).toBe(true);
  });

  it('does not create duplicate activation windows', () => {
    expect(
      shouldCreateWindowOnActivate({
        ipcHandlersInstalled: true,
        openWindowCount: 1
      })
    ).toBe(false);
  });
});
