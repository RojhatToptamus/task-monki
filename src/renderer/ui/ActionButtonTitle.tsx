import type { ReactNode } from 'react';

export function ActionButtonTitle({
  title,
  disabled,
  children
}: {
  title?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`tm-actiontitle${disabled ? ' tm-actiontitle--disabled' : ''}`}
      title={title}
    >
      {children}
    </span>
  );
}
