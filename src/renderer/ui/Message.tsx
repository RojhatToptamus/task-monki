import type { ReactNode } from 'react';

/**
 * One message anatomy for every conversation: the user's words sit in a
 * right-aligned filled bubble, agent prose stays on the sheet.
 */
export function Message({ from, label, className = '', children }: {
  from: 'user' | 'agent';
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return <article className={`tm-message tm-message--${from} ${className}`.trim()} aria-label={label}>{children}</article>;
}

export function MessageContent({ user = false, children, className = '' }: {
  user?: boolean; children: ReactNode; className?: string;
}) {
  return <div className={`tm-message-content ${user ? 'tm-message-content--user' : ''} ${className}`.trim()}>{children}</div>;
}

export function MessageMeta({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`tm-message__meta ${className}`.trim()}>{children}</div>;
}

export function MessageTime({ value }: { value: string }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return <time dateTime={value} title={date.toLocaleString()}>
    {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)}
  </time>;
}
