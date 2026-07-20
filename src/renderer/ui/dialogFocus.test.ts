import { describe, expect, it, vi } from 'vitest';
import {
  dialogFocusableElements,
  dialogReturnFocusTarget,
  dialogTabTarget,
  handleDialogKeyDown
} from './dialogFocus';

describe('dialog focus boundary', () => {
  it('wraps focus at both edges and recovers focus that escaped the dialog', () => {
    const first = {} as HTMLElement;
    const middle = {} as HTMLElement;
    const last = {} as HTMLElement;
    const items = [first, middle, last];

    expect(dialogTabTarget(items, last, false)).toBe(first);
    expect(dialogTabTarget(items, first, true)).toBe(last);
    expect(dialogTabTarget(items, middle, false)).toBeUndefined();
    expect(dialogTabTarget(items, null, false)).toBe(first);
    expect(dialogTabTarget(items, null, true)).toBe(last);
  });

  it('closes on Escape only when the dialog is not busy', () => {
    const onClose = vi.fn();
    const ready = fakeKeyboardEvent('Escape');

    handleDialogKeyDown(ready.event, {
      dialog: fakeDialog(),
      busy: false,
      onClose
    });
    expect(ready.preventDefault).toHaveBeenCalledOnce();
    expect(ready.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    const busy = fakeKeyboardEvent('Escape');
    handleDialogKeyDown(busy.event, {
      dialog: fakeDialog(),
      busy: true,
      onClose
    });
    expect(busy.preventDefault).toHaveBeenCalledOnce();
    expect(busy.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('excludes programmatic-only controls and controls hidden by an ancestor', () => {
    const available = fakeFocusable();
    const programmaticOnly = fakeFocusable({ tabIndex: -1 });
    const ariaHidden = fakeFocusable({ hiddenByAncestor: true });
    const inert = fakeFocusable({ inert: true });

    expect(
      dialogFocusableElements(fakeDialog([available, programmaticOnly, ariaHidden, inert]))
    ).toEqual([available]);
  });

  it('ignores unrelated and already-handled keyboard events', () => {
    const onClose = vi.fn();
    handleDialogKeyDown(fakeKeyboardEvent('Enter').event, {
      dialog: fakeDialog(),
      busy: false,
      onClose
    });
    handleDialogKeyDown(fakeKeyboardEvent('Escape', true).event, {
      dialog: fakeDialog(),
      busy: false,
      onClose
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('restores the invoker when possible and otherwise uses the stable fallback', () => {
    const primary = { isConnected: true } as HTMLElement;
    const disconnectedPrimary = { isConnected: false } as HTMLElement;
    const fallback = { isConnected: true } as HTMLElement;
    const disconnectedFallback = { isConnected: false } as HTMLElement;

    expect(dialogReturnFocusTarget(primary, fallback)).toBe(primary);
    expect(dialogReturnFocusTarget(disconnectedPrimary, fallback)).toBe(fallback);
    expect(dialogReturnFocusTarget(disconnectedPrimary, disconnectedFallback)).toBeUndefined();
  });
});

function fakeDialog(items: HTMLElement[] = []) {
  return {
    querySelectorAll() {
      return items;
    },
    contains() {
      return false;
    },
    focus: vi.fn()
  } as unknown as HTMLElement;
}

function fakeFocusable({
  tabIndex = 0,
  hiddenByAncestor = false,
  inert = false
}: {
  tabIndex?: number;
  hiddenByAncestor?: boolean;
  inert?: boolean;
} = {}) {
  return {
    tabIndex,
    closest(selector: string) {
      if (selector === '[aria-hidden="true"]') return hiddenByAncestor ? {} : null;
      if (selector === '[inert]') return inert ? {} : null;
      return null;
    },
    getClientRects() {
      return [{}];
    }
  } as unknown as HTMLElement;
}

function fakeKeyboardEvent(key: string, defaultPrevented = false) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = {
    key,
    shiftKey: false,
    defaultPrevented,
    preventDefault,
    stopPropagation
  } as unknown as KeyboardEvent;
  return { event, preventDefault, stopPropagation };
}
