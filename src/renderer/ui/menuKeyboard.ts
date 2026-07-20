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

const PAGE_TAB_STOP_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
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

export function menuTabTarget(
  trigger: HTMLElement | null | undefined,
  shiftKey: boolean,
  tabStops: readonly HTMLElement[] = pageTabStops()
): HTMLElement | undefined {
  if (!trigger) return undefined;
  const index = tabStops.indexOf(trigger);
  if (index < 0) return undefined;
  return tabStops[index + (shiftKey ? -1 : 1)];
}

export function isMenuPageTabStop(element: HTMLElement): boolean {
  return (
    element.tabIndex >= 0 &&
    !element.closest('[role="menu"], [aria-hidden="true"], [inert]') &&
    element.getClientRects().length > 0
  );
}

export function focusMenuItem(
  menu: HTMLElement | null,
  target: MenuFocusTarget = 'first'
): void {
  const items = navigableMenuItems(menu);
  if (items.length === 0) {
    menu?.focus({ preventScroll: true });
    return;
  }
  const item =
    target === 'last'
      ? items.at(-1)
      : target === 'selected'
        ? items.find((candidate) => candidate.getAttribute('aria-checked') === 'true') ?? items[0]
        : items[0];
  item?.focus({ preventScroll: true });
}

export function focusOwningMenu(item: Element | null): HTMLElement | null {
  const menu = item?.closest<HTMLElement>('[role="menu"]') ?? null;
  menu?.focus({ preventScroll: true });
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
    options.returnFocus?.focus({ preventScroll: true });
    return;
  }

  if (event.key === 'Tab') {
    const target = menuTabTarget(options.returnFocus, event.shiftKey);
    options.onClose();
    if (target) {
      event.preventDefault();
      target.focus({ preventScroll: true });
    }
    return;
  }

  const items = navigableMenuItems(event.currentTarget);
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex = menuNavigationIndex(event.key, currentIndex, items.length);
  if (nextIndex === undefined) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  items[nextIndex]?.focus({ preventScroll: true });
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

function navigableMenuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) {
    return [];
  }
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter((item) => {
    return !item.matches(':disabled');
  });
}

function pageTabStops(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(PAGE_TAB_STOP_SELECTOR)
  ).filter(isMenuPageTabStop);
}
