import { useEffect, useRef, type RefObject } from 'react';

const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

export function dialogTabTarget(
  focusable: HTMLElement[],
  activeElement: Element | null,
  shiftKey: boolean
): HTMLElement | undefined {
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    return undefined;
  }
  if (!focusable.includes(activeElement as HTMLElement)) {
    return shiftKey ? last : first;
  }
  if (shiftKey && activeElement === first) {
    return last;
  }
  if (!shiftKey && activeElement === last) {
    return first;
  }
  return undefined;
}

export function handleDialogKeyDown(
  event: KeyboardEvent,
  {
    dialog,
    busy,
    trapFocus = true,
    onClose
  }: {
    dialog: HTMLElement;
    busy: boolean;
    trapFocus?: boolean;
    onClose(): void;
  }
): void {
  if (event.defaultPrevented) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (!busy) {
      onClose();
    }
    return;
  }
  if (event.key !== 'Tab' || !trapFocus) {
    return;
  }
  const focusable = dialogFocusableElements(dialog);
  const target = dialogTabTarget(
    focusable,
    document.activeElement,
    event.shiftKey
  );
  if (target) {
    event.preventDefault();
    target.focus();
  } else if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
  }
}

export function focusInitialDialogTarget(
  dialog: HTMLElement | null,
  preferredTarget?: HTMLElement | null
): void {
  if (!dialog) {
    return;
  }
  const focusable = dialogFocusableElements(dialog);
  const target =
    preferredTarget && focusable.includes(preferredTarget)
      ? preferredTarget
      : (focusable[0] ?? dialog);
  target.focus({ preventScroll: true });
}

export function dialogReturnFocusTarget(
  primaryTarget?: HTMLElement | null,
  fallbackTarget?: HTMLElement | null
): HTMLElement | undefined {
  if (primaryTarget?.isConnected) {
    return primaryTarget;
  }
  if (fallbackTarget?.isConnected) {
    return fallbackTarget;
  }
  return undefined;
}

export function useDialogFocusBoundary({
  dialogRef,
  initialFocusRef,
  fallbackReturnFocusRef,
  busy,
  trapFocus = true,
  onClose,
  returnFocus,
  shouldReturnFocus
}: {
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  fallbackReturnFocusRef?: RefObject<HTMLElement | null>;
  busy: boolean;
  trapFocus?: boolean;
  onClose(): void;
  returnFocus?: HTMLElement | null;
  shouldReturnFocus?(): boolean;
}): void {
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  const shouldReturnFocusRef = useRef(shouldReturnFocus);
  const returnFocusRef = useRef<HTMLElement | null>(
    returnFocus ??
      (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null))
  );
  busyRef.current = busy;
  closeRef.current = onClose;
  shouldReturnFocusRef.current = shouldReturnFocus;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      focusInitialDialogTarget(dialogRef.current, initialFocusRef?.current);
    });
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (dialog) {
        handleDialogKeyDown(event, {
          dialog,
          busy: busyRef.current,
          trapFocus,
          onClose: closeRef.current
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      if (
        shouldReturnFocusRef.current &&
        !shouldReturnFocusRef.current()
      ) {
        return;
      }
      const primaryTarget = returnFocusRef.current;
      queueMicrotask(() => {
        dialogReturnFocusTarget(primaryTarget, fallbackReturnFocusRef?.current)?.focus({
          preventScroll: true
        });
      });
    };
  }, [dialogRef, fallbackReturnFocusRef, initialFocusRef, trapFocus]);

  useEffect(() => {
    if (!busy) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const activeElement = document.activeElement as HTMLElement | null;
      if (
        dialog &&
        (!activeElement ||
          !dialog.contains(activeElement) ||
          activeElement.matches(':disabled') ||
          activeElement.closest('[aria-hidden="true"], [inert]'))
      ) {
        dialog.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [busy, dialogRef]);
}

export function dialogFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.closest('[aria-hidden="true"]') &&
      !element.closest('[inert]') &&
      element.getClientRects().length > 0
  );
}
