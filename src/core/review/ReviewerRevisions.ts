import {
  AGENT_REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_TEXT_MAX_LENGTH,
  REVIEW_REVISIONS_FENCE_TAG,
  REVIEW_REVISIONS_MAX_ENTRIES,
  splitReviewerReply,
  type AgentReviewFinding,
  type AgentReviewFindingSeverity,
  type EffectiveReviewFinding,
  type ReviewFindingDecision
} from '../../shared/contracts';

/** A reviewer's answer may revise findings only through this exact contract. */
export type ReviewerRevision =
  | { action: 'withdraw'; findingId: string; reason: string }
  | { action: 'severity'; findingId: string; severity: AgentReviewFindingSeverity; reason: string }
  | { action: 'add'; finding: Omit<AgentReviewFinding, 'id'>; reason: string };

export type ReviewerRevisionParse =
  | { status: 'NONE' }
  | { status: 'VALID'; revisions: ReviewerRevision[] }
  | { status: 'REJECTED'; reason: string };

export interface ReviewerRevisionContext {
  /** The review's effective findings when the answer is applied. */
  findings: readonly EffectiveReviewFinding[];
  /** File paths of the reviewed diff; an added finding must name one. */
  diffPaths: ReadonlySet<string>;
}

const TITLE_MAX_LENGTH = 200;
const BODY_MAX_LENGTH = 2_000;

class RevisionRejected extends Error {}

/**
 * Validates the revision block that ends a reviewer's answer. Any defect rejects
 * the whole block; prose alone never revises a finding.
 */
export function reviewerRevisionsFromReply(
  text: string,
  context: ReviewerRevisionContext
): ReviewerRevisionParse {
  const { prose, revisionsJson } = splitReviewerReply(text);
  if (revisionsJson === undefined) {
    return prose.includes('```' + REVIEW_REVISIONS_FENCE_TAG)
      ? { status: 'REJECTED', reason: 'The revision block must end the answer.' }
      : { status: 'NONE' };
  }
  if (prose.includes('```' + REVIEW_REVISIONS_FENCE_TAG)) {
    return { status: 'REJECTED', reason: 'The answer contains more than one revision block.' };
  }
  try {
    return { status: 'VALID', revisions: parseRevisions(revisionsJson, context) };
  } catch (error) {
    if (error instanceof RevisionRejected) return { status: 'REJECTED', reason: error.message };
    throw error;
  }
}

/** Decisions for validated revisions. Added findings receive ids unique within the review. */
export function reviewerRevisionDecisions(
  revisions: readonly ReviewerRevision[],
  input: {
    reviewRunId: string;
    questionRunId: string;
    findings: readonly EffectiveReviewFinding[];
    createdAt: string;
    createId: () => string;
  }
): ReviewFindingDecision[] {
  const usedIds = new Set(input.findings.map((finding) => finding.id));
  let next = input.findings.filter((finding) => finding.addedByReviewer).length + 1;
  const base = {
    reviewRunId: input.reviewRunId,
    actor: 'REVIEWER' as const,
    questionRunId: input.questionRunId,
    createdAt: input.createdAt
  };
  return revisions.map((revision) => {
    if (revision.action === 'withdraw') {
      return { ...base, id: input.createId(), findingId: revision.findingId, kind: 'WITHDRAW', reason: revision.reason };
    }
    if (revision.action === 'severity') {
      return {
        ...base,
        id: input.createId(),
        findingId: revision.findingId,
        kind: 'CHANGE_SEVERITY',
        severity: revision.severity,
        reason: revision.reason
      };
    }
    while (usedIds.has(`added-${next}`)) next += 1;
    const id = `added-${next}`;
    usedIds.add(id);
    return {
      ...base,
      id: input.createId(),
      findingId: id,
      kind: 'ADD',
      finding: { id, ...revision.finding },
      reason: revision.reason
    };
  });
}

function parseRevisions(json: string, context: ReviewerRevisionContext): ReviewerRevision[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    reject('The revision block is not valid JSON.');
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > REVIEW_REVISIONS_MAX_ENTRIES) {
    reject(`The revision block must be a JSON array of 1 to ${REVIEW_REVISIONS_MAX_ENTRIES} revisions.`);
  }
  const revised = new Set<string>();
  return value.map((entry, index) => {
    const label = `Revision ${index + 1}`;
    const record = requireRecord(entry, label);
    const reason = requireText(record.reason, `${label} reason`, REVIEW_FINDING_TEXT_MAX_LENGTH);
    switch (record.action) {
      case 'withdraw': {
        requireKeys(record, ['action', 'finding', 'reason'], label);
        const finding = requireRevisableFinding(record.finding, context, revised, label);
        return { action: 'withdraw', findingId: finding.id, reason };
      }
      case 'severity': {
        requireKeys(record, ['action', 'finding', 'reason', 'severity'], label);
        const finding = requireRevisableFinding(record.finding, context, revised, label);
        const severity = requireSeverity(record.severity, label);
        if (severity === finding.severity) reject(`${label} keeps finding ${finding.id} at ${severity}.`);
        return { action: 'severity', findingId: finding.id, severity, reason };
      }
      case 'add': {
        requireKeys(record, ['action', 'finding', 'reason'], label);
        const finding = requireRecord(record.finding, `${label} finding`);
        allowKeys(finding, ['severity', 'title', 'explanation', 'path', 'line', 'recommendation'], `${label} finding`);
        const path = requireText(finding.path, `${label} path`, BODY_MAX_LENGTH);
        if (!context.diffPaths.has(path)) reject(`${label} names ${path}, which is not part of the reviewed diff.`);
        if (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || (finding.line as number) < 1)) {
          reject(`${label} line must be a positive whole number.`);
        }
        const recommendation = finding.recommendation === undefined
          ? undefined
          : requireText(finding.recommendation, `${label} recommendation`, BODY_MAX_LENGTH);
        return {
          action: 'add',
          finding: {
            severity: requireSeverity(finding.severity, label),
            title: requireText(finding.title, `${label} title`, TITLE_MAX_LENGTH),
            explanation: requireText(finding.explanation, `${label} explanation`, BODY_MAX_LENGTH),
            path,
            ...(finding.line !== undefined ? { line: finding.line as number } : {}),
            ...(recommendation ? { recommendation } : {})
          },
          reason
        };
      }
      default:
        return reject(`${label} action must be withdraw, severity, or add.`);
    }
  });
}

function requireRevisableFinding(
  value: unknown,
  context: ReviewerRevisionContext,
  revised: Set<string>,
  label: string
): EffectiveReviewFinding {
  if (typeof value !== 'string' || !value.trim()) reject(`${label} must name a finding.`);
  const finding = context.findings.find((candidate) => candidate.id === value);
  if (!finding) reject(`${label} names unknown finding ${value}.`);
  if (finding.state === 'WITHDRAWN') reject(`${label} names withdrawn finding ${value}.`);
  if (revised.has(finding.id)) reject(`${label} revises finding ${value} again.`);
  revised.add(finding.id);
  return finding;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) {
    reject(`${label} must contain exactly ${keys.join(', ')}.`);
  }
}

function allowKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(record).find((key) => !keys.includes(key));
  if (unknown) reject(`${label} has unsupported field ${unknown}.`);
}

function requireText(value: unknown, label: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) reject(`${label} is required.`);
  if (text.length > maxLength) reject(`${label} is longer than ${maxLength} characters.`);
  return text;
}

function requireSeverity(value: unknown, label: string): AgentReviewFindingSeverity {
  if (!AGENT_REVIEW_FINDING_SEVERITIES.includes(value as AgentReviewFindingSeverity)) {
    reject(`${label} severity must be BLOCKER, MAJOR, MINOR, or NIT.`);
  }
  return value as AgentReviewFindingSeverity;
}

function reject(reason: string): never {
  throw new RevisionRejected(reason);
}
