import type { ReactNode } from 'react';

/**
 * Provider text quoted under the name of the agent that wrote it, so it never
 * reads as Task Monki's own account (DESIGN.md §10, quoting provider text).
 * An inline notice passes its own class so the quote takes the notice's ink.
 */
export function ReportedQuote({ source, className = 'tm-oresult__report', children }: { source: string; className?: string; children: ReactNode }) {
  return (
    <figure className={className}>
      <figcaption>{source}</figcaption>
      <blockquote>{children}</blockquote>
    </figure>
  );
}
