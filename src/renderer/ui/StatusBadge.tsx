import { CircleCheck, CircleChevronRight, CircleX } from 'lucide-react';
import type { Tone } from '../model/viewTypes';

/** A badge: the state word on a tint of its tone. Nothing in it moves (DESIGN.md 6.6). */
export function Chip({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <span className="status-pill__label">{label}</span>
    </span>
  );
}

/**
 * The glyph beside a status word. A state that needs the user or has failed
 * takes its mark, and it outranks work in flight: a task that needs an approval
 * never shows the working circle. Anything else is a word alone.
 */
export function statusGlyphFor(tone: Tone, inFlight: boolean): StatusGlyphKind | undefined {
  if (tone === 'action') return 'waiting';
  if (tone === 'error') return 'blocked';
  return inFlight ? 'working' : undefined;
}

export type StatusGlyphKind = 'working' | 'waiting' | 'blocked' | 'verified' | 'idle';

export function StatusGlyph({
  kind,
  className = ''
}: {
  kind: StatusGlyphKind;
  className?: string;
}) {
  if (kind === 'idle') return null;
  const classes = ['lucide', 'tm-status-glyph', `tm-status-glyph--${kind}`, className].filter(Boolean).join(' ');
  if (kind === 'working') {
    // Work in flight is a half-filled circle that holds still; motion belongs
    // to the one line of live text on a surface (DESIGN.md 6.6).
    return (
      <svg className={classes} viewBox="0 0 24 24" width={13} height={13} aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" />
        <path d="M12 6a6 6 0 0 1 0 12z" fill="currentColor" />
      </svg>
    );
  }
  const Component = kind === 'waiting' ? CircleChevronRight : kind === 'blocked' ? CircleX : CircleCheck;
  return <Component aria-hidden="true" className={classes} size={13} />;
}
