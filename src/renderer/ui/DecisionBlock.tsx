import type { ReactNode } from 'react';
import { DisclosureChevron } from './DisclosureChevron';

/** The shared decision anatomy: one reason for attention and one next action. */
export function DecisionBlock({
  kind,
  tone = 'info',
  title,
  summary,
  children,
  actions,
  details
}: {
  kind: string;
  tone?: 'error' | 'action' | 'info';
  title?: string;
  summary?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
}) {
  return (
    <section className="tm-decision tm-decision--expanded" aria-label={kind}>
      <div className="tm-decision__body">
        <div className="tm-decision__head">
          <span className={`tm-decision__kind tm-decision__kind--${tone}`}>
            {kind}
          </span>
        </div>
        {title ? <h3 className="tm-decision__title">{title}</h3> : null}
        {summary ? <p className="tm-decision__summary">{summary}</p> : null}
        {children}
        {actions || details ? (
          <div className="tm-decision__actions">
            {actions}
            {details ? (
              <details className="tm-preview-disclosure">
                <summary>
                  <DisclosureChevron />
                  Details
                </summary>
                {details}
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
