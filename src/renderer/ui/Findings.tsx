import type { ReactNode } from 'react';
import type { Tone } from '../model/viewTypes';
export {
  FINDING_LEVELS,
  findingLevel,
  formatFindingLocation,
  shortFindingRef
} from '../model/findings';

export interface FindingRowProps {
  tone: Tone;
  /** Severity word (e.g. "Blocker"). Rendered uppercase in the severity chip. */
  severityLabel: string;
  title: string;
  /** Mono file:line (or other value) reference. */
  reference: string;
  /** Expanded body — explanation, recommendation, etc. */
  detail?: ReactNode;
  /** Whether the disclosure starts open. */
  open?: boolean;
  /** When present, renders a leading checkbox and makes the row selectable. */
  selection?: { checked: boolean; onToggle(): void };
}

/**
 * One finding, rendered identically everywhere: a severity dot + label, the
 * title and a mono reference, an optional selection checkbox, and a disclosure
 * for the detail. The checkbox slot lets the request-changes drawer mirror the
 * review card exactly instead of maintaining a second layout (audit §06).
 */
export function FindingRow({
  tone,
  severityLabel,
  title,
  reference,
  detail,
  open = false,
  selection
}: FindingRowProps) {
  const head = (
    <>
      <span className="tm-finding__severity">
        <span className="tm-finding__severity-dot" />
        <span>{severityLabel.toUpperCase()}</span>
      </span>
      <span className="tm-finding__main">
        <span className="tm-finding__title">{title}</span>
        <span className="tm-finding__ref">{reference}</span>
      </span>
    </>
  );

  if (selection) {
    // Selectable variant: a label wrapping a checkbox. Detail (if any) still
    // discloses below, keeping the same visual DNA as the read-only card row.
    return (
      <div className={`tm-finding tm-finding--select tm-finding--${tone}`}>
        <label className="tm-finding__summary">
          <input
            type="checkbox"
            className="tm-finding__check"
            checked={selection.checked}
            onChange={selection.onToggle}
          />
          {head}
        </label>
        {detail ? <div className="tm-finding__detail">{detail}</div> : null}
      </div>
    );
  }

  return (
    <details className={`tm-finding tm-finding--${tone}`} open={open}>
      <summary>
        {head}
        <span className="tm-finding__chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      {detail ? <div className="tm-finding__detail">{detail}</div> : null}
    </details>
  );
}
