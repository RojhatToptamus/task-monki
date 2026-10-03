import type { ReactNode } from 'react';

/** One prose surface for Agent, Design, and Discourse. Lifecycle stays with each owner. */
export function MessageContent({ user = false, children, className = '' }: {
  user?: boolean; children: ReactNode; className?: string;
}) {
  return <div className={`tm-message-content ${user ? 'tm-message-content--user' : ''} ${className}`.trim()}>{children}</div>;
}
