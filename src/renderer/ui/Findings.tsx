import type { ReactNode } from 'react';
import type { AgentReviewFinding } from '../../shared/contracts';
import type { Tone } from './taskView';

/**
 * Severity ordering + tone/label for a review finding. Shared by every
 * surface that renders findings (review card, request-changes drawer) so
 * severity always looks and sorts the same (audit §06 FindingRow).
 */
export const FINDING_LEVELS: Array<{
  severity: AgentReviewFinding['severity'];
  label: string;
  tone: Tone;
  rank: number;
}> = [
  { severity: 'BLOCKER', label: 'Blocker', tone: 'error', rank: 0 },
  { severity: 'MAJOR', label: 'Major', tone: 'action', rank: 1 },
  { severity: 'MINOR', label: 'Minor', tone: 'info', rank: 2 },
  { severity: 'NIT', label: 'Nit', tone: 'neutral', rank: 3 }
];

export function findingLevel(severity: AgentReviewFinding['severity']) {
  return (
    FINDING_LEVELS.find((candidate) => candidate.severity === severity) ??
    FINDING_LEVELS[FINDING_LEVELS.length - 1]
  );
}

/** A short "file:line" reference for a finding, falling back to its location. */
export function shortFindingRef(finding: AgentReviewFinding): string {
  if (!finding.path) {
    return formatFindingLocation(finding);
  }
  const filename = finding.path.split('/').filter(Boolean).at(-1) ?? finding.path;
  return finding.line ? `${filename}:${finding.line}` : filename;
}

export function formatFindingLocation(finding: AgentReviewFinding): string {
  if (!finding.path) {
    return 'location not specified';
  }
  return finding.line ? `${finding.path}:${finding.line}` : finding.path;
}

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
