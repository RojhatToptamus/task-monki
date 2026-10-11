/**
 * The agent review gate contract and the decisions recorded on its findings.
 *
 * A review's findings never change after it completes. The person dismisses or
 * restores a finding; every view of a finding is derived from the review result
 * plus these decisions, in order.
 */

export type AgentReviewGateStatus =
  | 'NOT_RUN'
  | 'RUNNING'
  | 'PASSED'
  | 'NEEDS_CHANGES'
  | 'INCONCLUSIVE'
  | 'FAILED'
  | 'CANCELED'
  | 'STALE';

export type AgentReviewFindingSeverity = 'BLOCKER' | 'MAJOR' | 'MINOR' | 'NIT';

export const AGENT_REVIEW_FINDING_SEVERITIES: readonly AgentReviewFindingSeverity[] = [
  'BLOCKER',
  'MAJOR',
  'MINOR',
  'NIT'
];

export interface AgentReviewFinding {
  id: string;
  severity: AgentReviewFindingSeverity;
  title: string;
  explanation: string;
  path?: string;
  line?: number;
  endLine?: number;
  recommendation?: string;
  /** A re-review only: the earlier review's finding this one is, still open. Absent for a new finding. */
  previousFindingId?: string;
}

/** A re-review only: an earlier review's finding the code now resolves. */
export interface AgentReviewResolvedFinding {
  previousFindingId: string;
  title: string;
  note?: string;
}

export interface AgentReviewResult {
  /** Durable schema-13 wire value for provider-neutral review artifacts. */
  schemaVersion: 'agent-review/v1';
  verdict: 'PASSED' | 'NEEDS_CHANGES' | 'INCONCLUSIVE';
  summary: string;
  findings: AgentReviewFinding[];
  /** A re-review only: the earlier findings it found resolved. */
  resolvedFindings?: AgentReviewResolvedFinding[];
}

export interface AgentReviewGateProjection {
  status: AgentReviewGateStatus;
  runId?: string;
  sourceRunId?: string;
  reviewedGitSnapshotId?: string;
  reviewedHeadSha?: string;
  reviewedDirtyFingerprint?: string;
  /**
   * The exact content the review read, as a Git tree in the profile's review
   * snapshot store; changes since the review are measured from it.
   */
  reviewedTreeSha?: string;
  finalArtifactId?: string;
  summary?: string;
  result?: AgentReviewResult;
  /** Decisions on this review's findings, in the order they were made; absent before the first. */
  findingDecisions?: ReviewFindingDecision[];
  /**
   * The implementation agent finished its reply to the person's request after this
   * review, and whether an item waits on the person's decision. Cleared when the next
   * turn starts.
   */
  requestAnswer?: { awaitingDecision: boolean };
  updatedAt?: string;
}

/** A dismissal's note is one short line. */
export const REVIEW_FINDING_TEXT_MAX_LENGTH = 500;
/** Decisions kept per review; a review that reaches it must be run again. */
export const REVIEW_FINDING_DECISION_LIMIT = 200;
/**
 * Why the person left a finding out, which decides what the next review may raise:
 * the reviewer was wrong (NOT_A_PROBLEM, shown as Incorrect: never raised again), the
 * code is intentional (ACCEPTED, shown as Intentional: raised again only if the code
 * around it changes), or it is real and deferred (DEFERRED, shown as Won't fix now:
 * not raised again in this task, and listed when the task finishes).
 */
export const REVIEW_FINDING_DISMISS_REASONS = ['NOT_A_PROBLEM', 'ACCEPTED', 'DEFERRED'] as const;
export type ReviewFindingDismissReason = (typeof REVIEW_FINDING_DISMISS_REASONS)[number];

interface ReviewFindingDecisionBase {
  id: string;
  reviewRunId: string;
  findingId: string;
  createdAt: string;
}

export type ReviewFindingDecision =
  | (ReviewFindingDecisionBase & {
    kind: 'DISMISS';
    dismissReason: ReviewFindingDismissReason;
    /** Trimmed, at most 500 characters. */
    note?: string;
  })
  | (ReviewFindingDecisionBase & { kind: 'RESTORE' });

export type ReviewFindingState = 'OPEN' | 'DISMISSED';

export interface EffectiveReviewFinding extends AgentReviewFinding {
  state: ReviewFindingState;
  dismissal?: { reason: ReviewFindingDismissReason; note?: string; decidedAt: string };
}

/**
 * Applies decisions in order to the review result. Pure; used by core and renderer.
 * Decisions that do not apply (an unknown finding, a dismissal of a finding that
 * is not open, a restore of one that is not dismissed) leave the findings
 * unchanged; the service rejects them first. A decision applies to every finding
 * that carries its id.
 */
export function effectiveReviewFindings(
  result: AgentReviewResult | undefined,
  decisions: readonly ReviewFindingDecision[]
): EffectiveReviewFinding[] {
  const findings: EffectiveReviewFinding[] = (result?.findings ?? []).map((finding) => ({ ...finding, state: 'OPEN' }));
  for (const decision of decisions) {
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index]!;
      if (finding.id !== decision.findingId) continue;
      findings[index] = applyDecision(finding, decision) ?? finding;
    }
  }
  return findings;
}

/** OPEN findings only, in review order. */
export function openReviewFindings(
  result: AgentReviewResult | undefined,
  decisions: readonly ReviewFindingDecision[]
): EffectiveReviewFinding[] {
  return effectiveReviewFindings(result, decisions).filter((finding) => finding.state === 'OPEN');
}

/**
 * True when the review finished and is still current, so its findings can be
 * dismissed or restored. A stale, running, or missing
 * review, or another run than `reviewRunId` when given, accepts no decisions.
 */
export function reviewAcceptsDecisions(
  gate: AgentReviewGateProjection | undefined,
  reviewRunId?: string
): boolean {
  return Boolean(
    gate?.runId &&
      (reviewRunId === undefined || gate.runId === reviewRunId) &&
      ['PASSED', 'NEEDS_CHANGES', 'INCONCLUSIVE', 'FAILED', 'CANCELED'].includes(gate.status)
  );
}

/** Blocker and Major findings must change: they go in a request by default and keep a review asking for changes. */
export function isBlockingFinding(finding: Pick<AgentReviewFinding, 'severity'>): boolean {
  return finding.severity === 'BLOCKER' || finding.severity === 'MAJOR';
}

/**
 * The review gate rule: a review asks for changes when its verdict does or any of
 * the findings is BLOCKER or MAJOR. Otherwise it passed when its verdict did, and
 * is inconclusive when the reviewer gave no verdict.
 */
export function reviewGateStatusFor(
  verdict: AgentReviewResult['verdict'],
  findings: readonly Pick<AgentReviewFinding, 'severity'>[]
): Extract<AgentReviewGateStatus, 'PASSED' | 'NEEDS_CHANGES' | 'INCONCLUSIVE'> {
  if (
    verdict === 'NEEDS_CHANGES' ||
    findings.some(isBlockingFinding)
  ) {
    return 'NEEDS_CHANGES';
  }
  return verdict === 'PASSED' ? 'PASSED' : 'INCONCLUSIVE';
}

/** The gate status a completed review records, before any finding decision. */
export function reviewGateStatusFromResult(
  result: AgentReviewResult | undefined
): Extract<AgentReviewGateStatus, 'PASSED' | 'NEEDS_CHANGES' | 'INCONCLUSIVE'> | undefined {
  return result ? reviewGateStatusFor(result.verdict, result.findings) : undefined;
}

/**
 * The status the workflow acts on. For a current, finished review it is the gate
 * rule applied to the findings still OPEN once every decision applies, so
 * dismissing a BLOCKER or MAJOR finding returns the review to its verdict and
 * restoring it asks for changes again. A
 * NEEDS_CHANGES verdict with findings asks for changes only while a request
 * would carry one by default, an open BLOCKER or MAJOR finding; open MINOR and
 * NIT findings are suggestions, so it otherwise reads as passed. It keeps asking
 * when the review recorded no findings at all (raw-output reviews). An
 * inconclusive verdict never reads as passed. Every other status, stale
 * included, is returned unchanged.
 */
export function effectiveReviewGateStatus(gate: AgentReviewGateProjection | undefined): AgentReviewGateStatus {
  if (!gate) return 'NOT_RUN';
  if (gate.status !== 'PASSED' && gate.status !== 'NEEDS_CHANGES' && gate.status !== 'INCONCLUSIVE') {
    return gate.status;
  }
  const findings = effectiveReviewFindings(gate.result, gate.findingDecisions ?? []);
  const open = findings.filter((finding) => finding.state === 'OPEN');
  const verdict = gate.result?.verdict ?? gate.status;
  if (verdict === 'NEEDS_CHANGES' && findings.length > 0) {
    return open.some(isBlockingFinding) ? 'NEEDS_CHANGES' : 'PASSED';
  }
  return reviewGateStatusFor(verdict, open);
}

export interface DecideReviewFindingRequest {
  taskId: string;
  reviewRunId: string;
  findingId: string;
  kind: 'DISMISS' | 'RESTORE';
  /** DISMISS only; trimmed, at most 500 characters. */
  note?: string;
  /** DISMISS only, and required for it. */
  dismissReason?: ReviewFindingDismissReason;
}

function applyDecision(
  finding: EffectiveReviewFinding,
  decision: ReviewFindingDecision
): EffectiveReviewFinding | undefined {
  if (decision.kind === 'DISMISS') {
    if (finding.state !== 'OPEN') return undefined;
    return {
      ...finding,
      state: 'DISMISSED',
      dismissal: { reason: decision.dismissReason, ...(decision.note ? { note: decision.note } : {}), decidedAt: decision.createdAt }
    };
  }
  if (finding.state !== 'DISMISSED') return undefined;
  const { dismissal: _dismissal, ...restored } = finding;
  return { ...restored, state: 'OPEN' };
}
