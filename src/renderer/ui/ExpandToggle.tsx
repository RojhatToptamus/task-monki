import type { KeyboardEvent } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Tooltip } from './Tooltip';

/** The expand shortcut as the platform writes it: the same chord enters and leaves. */
export const EXPAND_SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.userAgent) ? '⌘⇧F' : 'Ctrl+Shift+F';

/** ⌘⇧F (Ctrl+Shift+F): expand or collapse the surface that holds focus. */
export function isExpandShortcut(event: KeyboardEvent | globalThis.KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f';
}

/**
 * The control that gives a surface the room around it and takes it back: an
 * icon button at the end of the surface's head, before Close when there is
 * one. `onToggle` is told whether to animate: a keyboard press is instant.
 */
export function ExpandToggle({ expanded, onToggle, subject, labels, ariaLabel, compact = false, className }: {
  expanded: boolean;
  onToggle(animate: boolean): void;
  /** What expands, for the accessible name beside the verb ("Expand Side question"). */
  subject?: string;
  /** Tooltip names where Expand and Collapse already name another control in the head. */
  labels?: { expand: string; collapse: string };
  /** The accessible name, when it says more than the tooltip. */
  ariaLabel?: string;
  /** In a 36px head: the 24px button and the 13px glyph. */
  compact?: boolean;
  className?: string;
}) {
  const label = expanded ? labels?.collapse ?? 'Collapse' : labels?.expand ?? 'Expand';
  const Glyph = expanded ? Minimize2 : Maximize2;
  return (
    <Tooltip label={label} shortcut={EXPAND_SHORTCUT}>
      <button
        type="button"
        className={className ? `tm-iconbtn ${className}` : 'tm-iconbtn'}
        aria-label={ariaLabel ?? (subject ? `${label} ${subject}` : label)}
        aria-keyshortcuts="Meta+Shift+F Control+Shift+F"
        // A pointer press animates; Enter or Space (detail 0) is a keyboard action and is instant.
        onClick={(event) => onToggle(event.detail !== 0)}
      >
        <Glyph size={compact ? 13 : 16} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
