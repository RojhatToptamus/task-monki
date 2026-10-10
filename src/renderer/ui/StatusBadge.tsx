import { CircleCheck, CircleChevronRight, CircleX } from 'lucide-react';
import { formatStatusValue } from './display';

interface StatusBadgeProps {
  label: string;
  value: string;
  tone?: 'neutral' | 'info' | 'action' | 'success' | 'warning' | 'error';
  muted?: boolean;
}

const RUNNING_VALUES = new Set([
  'RUNNING',
  'STARTING',
  'QUEUED',
  'CREATING',
  'IN_PROGRESS',
  'PUSHING',
  'COMPUTING',
  'INTERRUPTING'
]);

export function StatusChip({ label, value, tone = 'neutral', muted = false }: StatusBadgeProps) {
  const resolvedTone = tone === 'neutral' ? toneForValue(value) : tone;
  const classes = [
    'status-pill',
    'status-pill--with-value',
    `status-pill--${resolvedTone}`,
    muted ? 'status-pill--muted' : ''
  ].filter(Boolean);
  return (
    <span className={classes.join(' ')}>
      <span className="status-pill__label">{label}</span>
      <strong className="status-pill__value">{formatStatusValue(value)}</strong>
    </span>
  );
}

export type StatusPillTone = 'neutral' | 'info' | 'action' | 'success' | 'error';

/** A badge: the state word on a tint of its tone. Nothing in it moves (DESIGN.md 7). */
export function Chip({ tone, label }: { tone: StatusPillTone; label: string }) {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <span className="status-pill__label">{label}</span>
    </span>
  );
}

/**
 * The glyph beside a task's status word. A state that needs the user or has
 * failed takes a still mark, and it outranks motion: a task that needs an
 * approval never spins. Only work in flight moves. Anything else is a word alone.
 */
export function taskStatusGlyph(tone: StatusPillTone, inFlight: boolean): StatusGlyphKind | undefined {
  if (tone === 'action') return 'waiting';
  if (tone === 'error') return 'blocked';
  return inFlight ? 'working' : undefined;
}

/**
 * A task's status as plain words: ink only when it needs the user or failed,
 * never a tinted fill. The same anatomy on board cards, Inbox rows and the
 * lifecycle track, so one state reads the same everywhere.
 */
export function TaskStatusWord({
  label,
  tone,
  inFlight,
  className = ''
}: {
  label: string;
  tone: StatusPillTone;
  inFlight: boolean;
  className?: string;
}) {
  const glyph = taskStatusGlyph(tone, inFlight);
  const ink = tone === 'action' || tone === 'error' ? tone : 'plain';
  return (
    <span className={`tm-status-word tm-status-word--${ink}${className ? ` ${className}` : ''}`}>
      {glyph ? <StatusGlyph kind={glyph} /> : null}
      <span className="tm-status-word__label">{label}</span>
    </span>
  );
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
    // to the one line of live text on a surface (DESIGN.md 7).
    return (
      <svg className={classes} viewBox="0 0 24 24" width={14} height={14} aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" />
        <path d="M12 6a6 6 0 0 1 0 12z" fill="currentColor" />
      </svg>
    );
  }
  const Component = kind === 'waiting' ? CircleChevronRight : kind === 'blocked' ? CircleX : CircleCheck;
  return <Component aria-hidden="true" className={classes} size={14} />;
}

export function statusKindForTone(
  tone: StatusPillTone | 'warning',
  running: boolean
): StatusGlyphKind {
  if (running) return 'working';
  if (tone === 'action' || tone === 'warning') return 'waiting';
  if (tone === 'error') return 'blocked';
  if (tone === 'success') return 'verified';
  return 'idle';
}

export function statusKindForAvailabilityTone(tone: string): StatusGlyphKind {
  if (tone === 'ok' || tone === 'success' || tone === 'ready') return 'verified';
  if (tone === 'error' || tone === 'blocked') return 'blocked';
  if (tone === 'warning' || tone === 'action' || tone === 'pending') return 'waiting';
  if (tone === 'working' || tone === 'info') return 'working';
  return 'idle';
}

function toneForValue(value: string): NonNullable<StatusBadgeProps['tone']> {
  if (
    ['COMPLETED', 'PASSED', 'PRESENT', 'VALID', 'HEALTHY', 'CLEAN', 'PUSHED', 'READY', 'OPEN_READY', 'MERGED', 'PASSING', 'APPROVED', 'SATISFIED'].includes(value)
  ) {
    return 'success';
  }
  if (
    [
      'FAILED',
      'ERROR',
      'INVALID',
      'CONFLICTED',
      'DIVERGED',
      'UNAVAILABLE',
      'MISSING',
      'BLOCKED',
      'AUTH_REQUIRED',
      'GH_MISSING',
      'MISSING_REMOTE',
      'CLOSED_UNMERGED',
      'FAILING',
      'RECOVERY_REQUIRED',
      'LOST'
    ].includes(value)
  ) {
    return 'error';
  }
  if (
    [
      'WARNING',
      'STALE',
      'DIRTY',
      'COMMITTED_UNPUSHED',
      'LOCKED',
      'PRUNABLE',
      'OPEN_DRAFT',
      'PENDING',
      'REQUESTED',
      'CHANGES_REQUESTED',
      'AMBIGUOUS',
      'AWAITING_APPROVAL',
      'AWAITING_USER_INPUT',
      'RESPONDING',
      'INTERRUPTED'
    ].includes(value)
  ) {
    return 'warning';
  }
  if (isRunningValue(value)) {
    return 'info';
  }
  return 'neutral';
}

function isRunningValue(value: string): boolean {
  return RUNNING_VALUES.has(value);
}
