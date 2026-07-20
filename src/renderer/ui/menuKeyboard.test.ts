import { describe, expect, it, vi } from 'vitest';
import {
  focusMenuItem,
  focusOwningMenu,
  handleMenuBlur,
  handleMenuKeyDown,
  isMenuPageTabStop,
  menuNavigationIndex,
  menuTabTarget,
  menuTriggerFocusTarget
} from './menuKeyboard';

describe('menu keyboard navigation', () => {
  it('opens from the trigger at the edge implied by the arrow key', () => {
    expect(menuTriggerFocusTarget('ArrowDown')).toBe('first');
    expect(menuTriggerFocusTarget('ArrowUp')).toBe('last');
    expect(menuTriggerFocusTarget('Enter')).toBeUndefined();
  });

  it('wraps arrows and supports Home and End across enabled items', () => {
    expect(menuNavigationIndex('ArrowDown', -1, 3)).toBe(0);
    expect(menuNavigationIndex('ArrowDown', 2, 3)).toBe(0);
    expect(menuNavigationIndex('ArrowUp', -1, 3)).toBe(2);
    expect(menuNavigationIndex('ArrowUp', 0, 3)).toBe(2);
    expect(menuNavigationIndex('Home', 2, 3)).toBe(0);
    expect(menuNavigationIndex('End', 0, 3)).toBe(2);
  });

  it('does not invent a target for empty menus or unrelated keys', () => {
    expect(menuNavigationIndex('ArrowDown', -1, 0)).toBeUndefined();
    expect(menuNavigationIndex('Enter', 0, 3)).toBeUndefined();
  });

  it('finds the adjacent page tab stop in either direction', () => {
    const before = {} as HTMLElement;
    const trigger = {} as HTMLElement;
    const after = {} as HTMLElement;
    const tabStops = [before, trigger, after];

    expect(menuTabTarget(trigger, false, tabStops)).toBe(after);
    expect(menuTabTarget(trigger, true, tabStops)).toBe(before);
    expect(menuTabTarget({} as HTMLElement, false, tabStops)).toBeUndefined();
  });

  it('excludes open-menu descendants from page tab traversal', () => {
    const pageButton = fakePageTabStop(false);
    const menuButton = fakePageTabStop(true);

    expect(isMenuPageTabStop(pageButton)).toBe(true);
    expect(isMenuPageTabStop(menuButton)).toBe(false);
  });

  it('skips native disabled items while keeping aria-disabled reasons navigable', () => {
    const nativeDisabled = fakeMenuItem({ disabled: true, checked: true });
    const ariaDisabled = fakeMenuItem({ ariaDisabled: true });
    const selected = fakeMenuItem({ checked: true });
    const first = fakeMenuItem();
    const menu = fakeMenu([nativeDisabled.item, ariaDisabled.item, selected.item, first.item]);

    focusMenuItem(menu.item, 'selected');
    expect(selected.focus).toHaveBeenCalledOnce();
    expect(selected.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(nativeDisabled.focus).not.toHaveBeenCalled();
    expect(ariaDisabled.focus).not.toHaveBeenCalled();

    const disabledOnlyMenu = fakeMenu([nativeDisabled.item, ariaDisabled.item]);
    focusMenuItem(disabledOnlyMenu.item);
    expect(ariaDisabled.focus).toHaveBeenCalledOnce();
    expect(disabledOnlyMenu.focus).not.toHaveBeenCalled();
  });

  it('restores the trigger for Escape', () => {
    const order: string[] = [];
    const returnFocus = {
      focus: vi.fn(() => order.push('focus'))
    } as unknown as HTMLElement;
    const onClose = vi.fn(() => order.push('close'));
    const escape = fakeKeyboardEvent('Escape');

    handleMenuKeyDown(escape.event, { onClose, returnFocus });
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(order).toEqual(['close', 'focus']);
    expect(returnFocus.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('moves action focus to the owning menu before items become disabled', () => {
    const menu = { focus: vi.fn() } as unknown as HTMLElement;
    const item = {
      closest(selector: string) {
        return selector === '[role="menu"]' ? menu : null;
      }
    } as unknown as Element;

    expect(focusOwningMenu(item)).toBe(menu);
    expect(menu.focus).toHaveBeenCalledOnce();
    expect(focusOwningMenu(null)).toBeNull();
  });

  it('closes only when focus leaves the menu', () => {
    const inside = {} as EventTarget;
    const outside = {} as EventTarget;
    const onClose = vi.fn();
    const currentTarget = {
      contains(candidate: EventTarget) {
        return candidate === inside;
      }
    };

    handleMenuBlur({ currentTarget, relatedTarget: inside } as never, onClose);
    expect(onClose).not.toHaveBeenCalled();
    handleMenuBlur({ currentTarget, relatedTarget: outside } as never, onClose);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function fakeMenuItem({
  disabled = false,
  ariaDisabled = false,
  checked = false
}: {
  disabled?: boolean;
  ariaDisabled?: boolean;
  checked?: boolean;
} = {}) {
  const focus = vi.fn();
  const item = {
    focus,
    getAttribute(name: string) {
      if (name === 'aria-disabled') return ariaDisabled ? 'true' : null;
      if (name === 'aria-checked') return checked ? 'true' : null;
      return null;
    },
    matches(selector: string) {
      return selector === ':disabled' && disabled;
    }
  } as unknown as HTMLElement;
  return { item, focus };
}

function fakeMenu(items: HTMLElement[]) {
  const focus = vi.fn();
  const item = {
    focus,
    querySelectorAll() {
      return items;
    }
  } as unknown as HTMLElement;
  return { item, focus };
}

function fakeKeyboardEvent(key: string) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = {
    key,
    currentTarget: fakeMenu([]).item,
    preventDefault,
    stopPropagation
  } as unknown as Parameters<typeof handleMenuKeyDown>[0];
  return { event, preventDefault, stopPropagation };
}

function fakePageTabStop(inMenu: boolean): HTMLElement {
  return {
    tabIndex: 0,
    closest(selector: string) {
      return inMenu && selector.includes('[role="menu"]') ? {} : null;
    },
    getClientRects() {
      return [{}];
    }
  } as unknown as HTMLElement;
}
