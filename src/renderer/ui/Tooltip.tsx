import * as RadixTooltip from '@radix-ui/react-tooltip';
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

const TOOLTIP_DELAY_MS = 500;

/** The submit shortcut as the platform writes it, for tooltips and composer hints. */
export const SUBMIT_SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.userAgent) ? '⌘↵' : 'Ctrl+Enter';
const TOOLTIP_SKIP_DELAY_MS = 300;
const SharedProvider = createContext(false);

/**
 * Tooltips name icon-only controls and show shortcuts (DESIGN.md 6.5). The
 * first one waits half a second; moving to a neighbour shows the next at once.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <SharedProvider.Provider value>
    <RadixTooltip.Provider delayDuration={TOOLTIP_DELAY_MS} skipDelayDuration={TOOLTIP_SKIP_DELAY_MS}>{children}</RadixTooltip.Provider>
  </SharedProvider.Provider>;
}

/** The app records how the person last moved on the document; without it, focus counts as the keyboard's. */
function focusFromKeyboard(): boolean {
  return typeof document === 'undefined' || document.documentElement.dataset.inputModality !== 'pointer';
}

export function Tooltip({ label, shortcut, side = 'bottom', children }: {
  label: string;
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactElement;
}) {
  const shared = useContext(SharedProvider);
  const root = <RadixTooltip.Root>
    {/* Focus names a control only for someone moving by keyboard: a dialog that places focus
        on its close button as it opens never shows that button's tooltip under the pointer. */}
    <RadixTooltip.Trigger asChild onFocus={(event) => {
      if (!focusFromKeyboard()) event.preventDefault();
    }}>{children}</RadixTooltip.Trigger>
    <RadixTooltip.Portal>
      <RadixTooltip.Content className="tm-tooltip" side={side} sideOffset={6} collisionPadding={8}>
        {label}
        {shortcut ? <kbd className="tm-tooltip__shortcut">{shortcut}</kbd> : null}
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  </RadixTooltip.Root>;
  // A tooltip rendered outside the app shell (an isolated component) still works.
  return shared ? root : <RadixTooltip.Provider delayDuration={TOOLTIP_DELAY_MS}>{root}</RadixTooltip.Provider>;
}
