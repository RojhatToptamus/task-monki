interface StatusBadgeProps {
  label: string;
  value: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
}

export function StatusBadge({ label, value, tone = 'neutral' }: StatusBadgeProps) {
  const resolvedTone = tone === 'neutral' ? toneForValue(value) : tone;
  return (
    <span className={`status-badge status-badge--${resolvedTone}`}>
      <span className="status-badge__dot" aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
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
      'FAILING'
    ].includes(value)
  ) {
    return 'error';
  }
  if (
    ['WARNING', 'STALE', 'DIRTY', 'COMMITTED_UNPUSHED', 'LOCKED', 'PRUNABLE', 'OPEN_DRAFT', 'PENDING', 'REQUESTED', 'CHANGES_REQUESTED', 'AMBIGUOUS'].includes(value)
  ) {
    return 'warning';
  }
  if (['RUNNING', 'STARTING', 'QUEUED', 'CREATING', 'IN_PROGRESS', 'PUSHING', 'COMPUTING', 'QUEUED'].includes(value)) {
    return 'info';
  }
  return 'neutral';
}
