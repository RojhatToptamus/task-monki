/**
 * The agent review gate contract and the decisions recorded on its findings.
 *
 * A review's findings never change after it completes. The person dismisses or
 * restores a finding, and the reviewer revises findings only through a validated
 * revision block in an answer to a person's question. Every view of a finding
 * is derived from the review result plus these decisions, in order.
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
}

export interface AgentReviewResult {
  /** Durable schema-13 wire value for provider-neutral review artifacts. */
  schemaVersion: 'agent-review/v1';
  verdict: 'PASSED' | 'NEEDS_CHANGES' | 'INCONCLUSIVE';
  summary: string;
  findings: AgentReviewFinding[];
}

export interface AgentReviewGateProjection {
  status: AgentReviewGateStatus;
  runId?: string;
  sourceRunId?: string;
  reviewedGitSnapshotId?: string;
  reviewedHeadSha?: string;
  reviewedDirtyFingerprint?: string;
  finalArtifactId?: string;
  summary?: string;
  result?: AgentReviewResult;
  /**
   * Decisions on this review's findings, in the order they were made. Task Monki
   * starts every review with an empty list; projections stored before decisions
   * existed omit it, which means no decisions.
   */
  findingDecisions?: ReviewFindingDecision[];
  updatedAt?: string;
}

/** Notes and reasons are one short line each. */
export const REVIEW_FINDING_TEXT_MAX_LENGTH = 500;
/** Decisions kept per review; a review that reaches it must be run again. */
export const REVIEW_FINDING_DECISION_LIMIT = 200;
/** The fence tag of the block a reviewer uses to revise findings. */
export const REVIEW_REVISIONS_FENCE_TAG = 'task-monki-revisions';
/** Revisions accepted in one answer. */
export const REVIEW_REVISIONS_MAX_ENTRIES = 8;

export type ReviewFindingDecisionKind = 'DISMISS' | 'RESTORE' | 'WITHDRAW' | 'CHANGE_SEVERITY' | 'ADD';
/**
 * Why the person left a finding out: the reviewer was wrong (NOT_A_PROBLEM), or
 * the finding is real but acceptable as it is (ACCEPTED). The next review is told
 * which, so only a false positive asks it not to raise the finding again.
 */
export const REVIEW_FINDING_DISMISS_REASONS = ['NOT_A_PROBLEM', 'ACCEPTED'] as const;
export type ReviewFindingDismissReason = (typeof REVIEW_FINDING_DISMISS_REASONS)[number];
export type ReviewFindingDecisionActor = 'USER' | 'REVIEWER';

export interface ReviewFindingDecision {
  id: string;
  reviewRunId: string;
  findingId: string;
  kind: ReviewFindingDecisionKind;
  actor: ReviewFindingDecisionActor;
  /** USER DISMISS only; trimmed, at most 500 characters. */
  note?: string;
  /** USER DISMISS only. Dismissals recorded before reasons existed omit it. */
  dismissReason?: ReviewFindingDismissReason;
  /** Required for every REVIEWER decision; trimmed, at most 500 characters. */
  reason?: string;
  /** CHANGE_SEVERITY target. */
  severity?: AgentReviewFindingSeverity;
  /** ADD only: the new finding (id assigned by Task Monki). */
  finding?: AgentReviewFinding;
  /** REVIEWER decisions: the REVIEW_QUESTION run whose answer carried them. */
  questionRunId?: string;
  createdAt: string;
}

/**
 * What Task Monki did with the revision block of a reviewer's answer. It is the
 * `reviewerRevisions` field of a completed REVIEW_QUESTION run's AGENT_RUN_COMPLETED
 * event payload: NONE when the answer had no block, APPLIED with the recorded
 * decision ids, or REJECTED with the reason nothing was applied.
 */
export type ReviewerRevisionsOutcome =
  | { status: 'NONE' }
  | { status: 'APPLIED'; decisionIds: string[] }
  | { status: 'REJECTED'; reason: string };

export type ReviewFindingState = 'OPEN' | 'DISMISSED' | 'WITHDRAWN';

export interface EffectiveReviewFinding extends AgentReviewFinding {
  state: ReviewFindingState;
  addedByReviewer: boolean;
  /** Set when the reviewer changed the severity. */
  originalSeverity?: AgentReviewFindingSeverity;
  dismissal?: { reason?: ReviewFindingDismissReason; note?: string; decidedAt: string };
  revision?: { kind: 'WITHDRAW' | 'CHANGE_SEVERITY' | 'ADD'; reason: string; decidedAt: string };
}

/**
 * Applies decisions in order to the review result. Pure; used by core and renderer.
 * Decisions that do not apply (an unknown finding, a decision on a withdrawn
 * finding, a dismissal of a finding that is not open, a restore of one that is
 * not dismissed) leave the findings unchanged; the service rejects them first.
 * A decision applies to every finding that carries its id.
 */
export function effectiveReviewFindings(
  result: AgentReviewResult | undefined,
  decisions: readonly ReviewFindingDecision[]
): EffectiveReviewFinding[] {
  const findings: EffectiveReviewFinding[] = (result?.findings ?? []).map((finding) => ({
    ...finding,
    state: 'OPEN',
    addedByReviewer: false
  }));
  for (const decision of decisions) {
    if (decision.kind === 'ADD') {
      const added = decision.finding;
      if (!added || added.id !== decision.findingId || findings.some((finding) => finding.id === added.id)) continue;
      findings.push({
        ...added,
        state: 'OPEN',
        addedByReviewer: true,
        revision: { kind: 'ADD', reason: decision.reason ?? '', decidedAt: decision.createdAt }
      });
      continue;
    }
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index]!;
      if (finding.id !== decision.findingId) continue;
      findings[index] = applyDecision(finding, decision) ?? finding;
    }
  }
  return findings;
}

/** OPEN findings only, in review order then added order. */
export function openReviewFindings(
  result: AgentReviewResult | undefined,
  decisions: readonly ReviewFindingDecision[]
): EffectiveReviewFinding[] {
  return effectiveReviewFindings(result, decisions).filter((finding) => finding.state === 'OPEN');
}

/**
 * True when the review finished and is still current, so its findings can be
 * dismissed or restored and its reviewer asked. A stale, running, or missing
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
    findings.some((finding) => finding.severity === 'BLOCKER' || finding.severity === 'MAJOR')
  ) {
    return 'NEEDS_CHANGES';
  }
  return verdict === 'PASSED' ? 'PASSED' : 'INCONCLUSIVE';
}

/**
 * The status the workflow acts on. For a current, finished review it is the gate
 * rule applied to the findings still OPEN once every decision applies, so
 * decisions move it both ways: a BLOCKER or MAJOR finding added or raised by the
 * reviewer makes a passed or inconclusive review ask for changes, and dismissing,
 * withdrawing or downgrading those findings returns it to its verdict. A
 * NEEDS_CHANGES verdict reads as passed once every finding is dismissed or
 * withdrawn, and keeps asking when the review recorded no findings at all
 * (raw-output reviews). An inconclusive verdict never reads as passed. Every
 * other status, stale included, is returned unchanged.
 */
export function effectiveReviewGateStatus(gate: AgentReviewGateProjection | undefined): AgentReviewGateStatus {
  if (!gate) return 'NOT_RUN';
  if (gate.status !== 'PASSED' && gate.status !== 'NEEDS_CHANGES' && gate.status !== 'INCONCLUSIVE') {
    return gate.status;
  }
  const findings = effectiveReviewFindings(gate.result, gate.findingDecisions ?? []);
  const open = findings.filter((finding) => finding.state === 'OPEN');
  const verdict = gate.result?.verdict ?? gate.status;
  if (verdict === 'NEEDS_CHANGES' && findings.length > 0 && open.length === 0) return 'PASSED';
  return reviewGateStatusFor(verdict, open);
}

/** True when the current (non-stale) review asks for changes once its decisions apply. */
export function reviewAsksForChanges(gate: AgentReviewGateProjection | undefined): boolean {
  return effectiveReviewGateStatus(gate) === 'NEEDS_CHANGES';
}

/**
 * Splits a reviewer answer into the prose shown to the user and the trailing
 * ```task-monki-revisions``` block, if any. Only a block that ends the reply counts.
 */
export function splitReviewerReply(text: string): { prose: string; revisionsJson?: string } {
  const reply = text.trimEnd();
  const opening = '```' + REVIEW_REVISIONS_FENCE_TAG;
  const start = reply.lastIndexOf(opening);
  if (start < 0 || (start > 0 && reply[start - 1] !== '\n')) return { prose: text.trim() };
  const block = /^[ \t]*\r?\n([\s\S]*?)\r?\n```$/u.exec(reply.slice(start + opening.length));
  if (!block) return { prose: text.trim() };
  return { prose: reply.slice(0, start).trim(), revisionsJson: block[1]!.trim() };
}

export interface DecideReviewFindingRequest {
  taskId: string;
  reviewRunId: string;
  findingId: string;
  kind: 'DISMISS' | 'RESTORE';
  /** DISMISS only; trimmed, at most 500 characters. */
  note?: string;
  /** DISMISS only. */
  dismissReason?: ReviewFindingDismissReason;
}

export interface AskReviewerRequest {
  taskId: string;
  reviewRunId: string;
  /** Client message UUID. Repeating it with the same question returns the recorded question. */
  messageId: string;
  text: string;
  /** The finding the question is about. */
  findingId?: string;
}

export interface StopReviewerQuestionRequest {
  taskId: string;
  runId: string;
}

function applyDecision(
  finding: EffectiveReviewFinding,
  decision: ReviewFindingDecision
): EffectiveReviewFinding | undefined {
  if (finding.state === 'WITHDRAWN') return undefined;
  const revisedAt = decision.createdAt;
  switch (decision.kind) {
    case 'DISMISS':
      if (finding.state !== 'OPEN') return undefined;
      return {
        ...finding,
        state: 'DISMISSED',
        dismissal: {
          ...(decision.dismissReason ? { reason: decision.dismissReason } : {}),
          ...(decision.note ? { note: decision.note } : {}),
          decidedAt: revisedAt
        }
      };
    case 'RESTORE': {
      if (finding.state !== 'DISMISSED') return undefined;
      const { dismissal: _dismissal, ...restored } = finding;
      return { ...restored, state: 'OPEN' };
    }
    case 'WITHDRAW':
      return {
        ...finding,
        state: 'WITHDRAWN',
        revision: { kind: 'WITHDRAW', reason: decision.reason ?? '', decidedAt: revisedAt }
      };
    case 'CHANGE_SEVERITY': {
      if (!decision.severity) return undefined;
      const originalSeverity = finding.originalSeverity ?? finding.severity;
      const { originalSeverity: _previous, ...revised } = finding;
      return {
        ...revised,
        severity: decision.severity,
        ...(originalSeverity !== decision.severity ? { originalSeverity } : {}),
        revision: { kind: 'CHANGE_SEVERITY', reason: decision.reason ?? '', decidedAt: revisedAt }
      };
    }
    default:
      return undefined;
  }
}
