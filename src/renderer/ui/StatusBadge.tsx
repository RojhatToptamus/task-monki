interface StatusBadgeProps {
  label: string;
  value: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
}

export function StatusBadge({ label, value, tone = 'neutral' }: StatusBadgeProps) {
  const resolvedTone = tone === 'neutral' ? toneForValue(value) : tone;
  return (
    <span className={`status-badge status-badge--${resolvedTone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function toneForValue(value: string): StatusBadgeProps['tone'] {
  if (['COMPLETED', 'PASSED', 'PRESENT', 'VALID', 'HEALTHY', 'CLEAN', 'PUSHED'].includes(value)) {
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
      'BLOCKED'
    ].includes(value)
  ) {
    return 'error';
  }
  if (['WARNING', 'STALE', 'DIRTY', 'COMMITTED_UNPUSHED', 'LOCKED', 'PRUNABLE'].includes(value)) {
    return 'warning';
  }
  if (['RUNNING', 'STARTING', 'QUEUED', 'CREATING', 'TESTING', 'IN_PROGRESS'].includes(value)) {
    return 'info';
  }
  return 'neutral';
}
