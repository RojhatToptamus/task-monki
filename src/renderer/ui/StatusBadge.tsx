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
      <span className="status-pill__dot" aria-hidden="true" />
      <span className="status-pill__label">{label}</span>
      <strong className="status-pill__value">{formatStatusValue(value)}</strong>
    </span>
  );
}

function toneForValue(value: string): StatusBadgeProps['tone'] {
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
