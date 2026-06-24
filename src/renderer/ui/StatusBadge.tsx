import { formatStatusValue } from './display';

interface StatusBadgeProps {
  label: string;
  value: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  muted?: boolean;
}

export function StatusBadge({ label, value, tone = 'neutral', muted = false }: StatusBadgeProps) {
  const resolvedTone = tone === 'neutral' ? toneForValue(value) : tone;
  return (
    <span
      className={`status-badge status-badge--${resolvedTone} ${muted ? 'status-badge--muted' : ''}`}
    >
      <span className="status-badge__dot" aria-hidden="true" />
      <span>{label}</span>
      <strong>{formatStatusValue(value)}</strong>
    </span>
  );
}

export function StatusChip({ label, value, tone = 'neutral', muted = false }: StatusBadgeProps) {
  const resolvedTone = tone === 'neutral' ? toneForValue(value) : tone;
  return (
    <span className={`status-chip status-chip--${resolvedTone} ${muted ? 'status-chip--muted' : ''}`}>
      <span className="status-chip__dot" aria-hidden="true" />
      <span className="status-chip__label">{label}</span>
      <strong className="status-chip__value">{formatStatusValue(value)}</strong>
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
  if (
    [
      'RUNNING',
      'STARTING',
      'QUEUED',
      'CREATING',
      'IN_PROGRESS',
      'PUSHING',
      'COMPUTING',
      'INTERRUPTING'
    ].includes(value)
  ) {
    return 'info';
  }
  return 'neutral';
}
