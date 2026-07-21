import type { AgentReviewFinding } from '../../shared/contracts';
import type { Tone } from './viewTypes';

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

export function shortFindingRef(finding: AgentReviewFinding): string {
  if (!finding.path) return formatFindingLocation(finding);
  const filename = finding.path.split('/').filter(Boolean).at(-1) ?? finding.path;
  return finding.line ? `${filename}:${finding.line}` : filename;
}

export function formatFindingLocation(finding: AgentReviewFinding): string {
  if (!finding.path) return 'location not specified';
  return finding.line ? `${finding.path}:${finding.line}` : finding.path;
}
