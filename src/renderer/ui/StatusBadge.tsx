interface StatusBadgeProps {
  label: string;
  value: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
}

export function StatusBadge({ label, value, tone = 'neutral' }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}
