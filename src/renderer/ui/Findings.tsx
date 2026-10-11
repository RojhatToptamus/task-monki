import type { ReactNode } from 'react';
import type { Tone } from '../model/viewTypes';
import { DisclosureChevron } from './DisclosureChevron';

export interface FindingRowProps {
  tone: Tone;
  /** Severity word (e.g. "Blocker"), in its tone beside the title. */
  severityLabel: string;
  title: string;
  /** Mono file:line (or other value) reference. */
  reference: string;
  /** Expanded body — explanation, recommendation, etc. */
  detail?: ReactNode;
  /** Whether the disclosure starts open. */
  open?: boolean;
}

/**
 * One finding, rendered identically everywhere: a severity label, the title and
 * a mono reference, and a disclosure for the detail.
 */
export function FindingRow({
  tone,
  severityLabel,
  title,
  reference,
  detail,
  open = false
}: FindingRowProps) {
  return (
    <details className={`tm-finding tm-finding--${tone}`} open={open}>
      <summary>
        <span className="tm-finding__severity">
          <span>{severityLabel}</span>
        </span>
        <span className="tm-finding__main">
          <span className="tm-finding__title">{title}</span>
          <span className="tm-finding__ref">{reference}</span>
        </span>
        <DisclosureChevron className="tm-finding__chevron" />
      </summary>
      {detail ? <div className="tm-finding__detail">{detail}</div> : null}
    </details>
  );
}
