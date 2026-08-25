import { CircleCheck, CircleChevronRight, CircleX, LoaderCircle } from 'lucide-react';
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
    isRunningValue(value) ? 'status-pill--running' : '',
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

export function Chip({
  tone,
  label,
  compact = false,
  showDot = true
}: {
  tone: StatusPillTone;
  label: string;
  compact?: boolean;
  showDot?: boolean;
}) {
  const classes = [
    'status-pill',
    `status-pill--${tone}`,
    !showDot ? 'status-pill--word-only' : '',
    compact ? 'status-pill--compact' : ''
  ].filter(Boolean);

  return (
    <span className={classes.join(' ')}>
      {showDot ? <StatusGlyph kind={statusKindForTone(tone, false)} /> : null}
      <span className="status-pill__label">{label}</span>
    </span>
  );
}

export type StatusGlyphKind = 'working' | 'waiting' | 'blocked' | 'verified' | 'idle';

export function StatusGlyph({
  kind,
  className = '',
  animate = kind === 'working'
}: {
  kind: StatusGlyphKind;
  className?: string;
  animate?: boolean;
}) {
  if (kind === 'idle') return null;
  const classes = [
    'tm-status-glyph',
    `tm-status-glyph--${kind}`,
    !animate ? 'tm-status-glyph--static' : '',
    className
  ]
    .filter(Boolean)
    .join(' ');
  const Component = kind === 'working'
    ? LoaderCircle
    : kind === 'waiting'
      ? CircleChevronRight
      : kind === 'blocked'
        ? CircleX
        : CircleCheck;
  return (
    <Component
      absoluteStrokeWidth
      aria-hidden="true"
      className={classes}
      size={14}
      strokeWidth={1.5}
    />
  );
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
