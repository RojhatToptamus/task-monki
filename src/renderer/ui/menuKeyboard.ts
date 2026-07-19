import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent
} from 'react';

export type MenuFocusTarget = 'first' | 'last' | 'selected';

const MENU_ITEM_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]'
].join(',');

export function menuTriggerFocusTarget(key: string): MenuFocusTarget | undefined {
  if (key === 'ArrowDown') {
    return 'first';
  }
  if (key === 'ArrowUp') {
    return 'last';
  }
  return undefined;
}

export function menuNavigationIndex(
  key: string,
  currentIndex: number,
  itemCount: number
): number | undefined {
  if (itemCount <= 0) {
    return undefined;
  }
  switch (key) {
    case 'ArrowDown':
      return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
    case 'ArrowUp':
      return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
    case 'Home':
      return 0;
    case 'End':
      return itemCount - 1;
    default:
      return undefined;
  }
}

export function focusMenuItem(
  menu: HTMLElement | null,
  target: MenuFocusTarget = 'first'
): void {
  const items = enabledMenuItems(menu);
  if (items.length === 0) {
    menu?.focus();
    return;
  }
  const item =
    target === 'last'
      ? items.at(-1)
      : target === 'selected'
        ? items.find((candidate) => candidate.getAttribute('aria-checked') === 'true') ?? items[0]
        : items[0];
  item?.focus();
}

export function focusOwningMenu(item: Element | null): HTMLElement | null {
  const menu = item?.closest<HTMLElement>('[role="menu"]') ?? null;
  menu?.focus();
  return menu;
}

export function handleMenuKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  options: {
    onClose(): void;
    returnFocus?: HTMLElement | null;
  }
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    options.onClose();
    options.returnFocus?.focus();
    return;
  }

  if (event.key === 'Tab') {
    event.preventDefault();
    options.onClose();
    options.returnFocus?.focus();
    return;
  }

  const items = enabledMenuItems(event.currentTarget);
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex = menuNavigationIndex(event.key, currentIndex, items.length);
  if (nextIndex === undefined) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  items[nextIndex]?.focus();
}

export function handleMenuBlur(
  event: ReactFocusEvent<HTMLElement>,
  onClose: () => void
): void {
  const next = event.relatedTarget;
  if (!next || !event.currentTarget.contains(next as Node)) {
    onClose();
  }
}

function enabledMenuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) {
    return [];
  }
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter((item) => {
    if (item.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    return !item.matches(':disabled');
  });
}
