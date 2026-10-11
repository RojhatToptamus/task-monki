import { AGENT_REVIEW_FINDING_SEVERITIES, type AgentReviewFindingSeverity } from './agentReviewFindings';

/**
 * A review round: the person's request after a review, numbered item by item,
 * and the implementation agent's answer to each item. The request travels with
 * the follow-up message that sent it; the answers close the agent's reply in a
 * `task-monki-review-response` block. The next review reads both.
 */

/** One numbered item of a request: a finding of the review, or the person's comment on lines of the diff. */
export type ReviewRequestItem =
  | {
      number: number;
      kind: 'FINDING';
      findingId: string;
      severity: AgentReviewFindingSeverity;
      title: string;
      path?: string;
      line?: number;
      endLine?: number;
    }
  | {
      number: number;
      kind: 'COMMENT';
      path: string;
      side: 'NEW' | 'OLD';
      line?: number;
      endLine?: number;
      text: string;
    };

export interface ReviewRequestRecord {
  /** The review the request answers; absent when the person sent only comments on an out-of-date review. */
  reviewRunId?: string;
  /** Numbered from 1 in the order the agent reads them. */
  items: ReviewRequestItem[];
  /** The person's note to the agent. */
  note?: string;
}

export const REVIEW_RESPONSE_OUTCOMES = ['FIXED', 'NOT_CHANGED', 'NEEDS_DECISION'] as const;
export type ReviewResponseOutcome = (typeof REVIEW_RESPONSE_OUTCOMES)[number];

/** The agent's answer to one item: what it did, and why or what it needs. */
export interface ReviewResponseAnswer {
  item: number;
  outcome: ReviewResponseOutcome;
  note?: string;
}

export const REVIEW_RESPONSE_BLOCK = 'task-monki-review-response';

/** What changed since a review: an exact diff from the code it read to the worktree now. */
export interface ReadReviewChangesRequest {
  taskId: string;
  reviewRunId: string;
}

export type ReviewChangesResult =
  | { status: 'READY'; reviewRunId: string; /** The tree the review read. */ tree: string; diff: string }
  /** No tree was recorded for the review, the diff is too large to show, or the tree can no longer be read. */
  | { status: 'UNAVAILABLE'; reason: 'NOT_RECORDED' | 'TOO_LARGE' | 'UNREADABLE' };
export const REVIEW_REQUEST_ITEM_LIMIT = 100;
const REVIEW_REQUEST_TEXT_LIMIT = 4_000;
const REVIEW_RESPONSE_NOTE_LIMIT = 1_000;
const PATH_LIMIT = 1_000;
const LINE_LIMIT = 10_000_000;

const BLOCK_PATTERN = new RegExp('```' + REVIEW_RESPONSE_BLOCK + '[^\\n]*\\n([\\s\\S]*?)```', 'u');

/**
 * Splits the agent's reply into its prose and its answers. The block is removed
 * from the prose whether or not it parses; an answer that names no requested item,
 * repeats one, or has no known outcome is left out.
 */
export function parseReviewResponse(text: string, request: Pick<ReviewRequestRecord, 'items'>): { prose: string; answers: ReviewResponseAnswer[] } {
  const match = BLOCK_PATTERN.exec(text);
  if (!match) {
    // A block still streaming has no closing fence yet; its JSON is not prose either.
    const open = text.indexOf('```' + REVIEW_RESPONSE_BLOCK);
    return { prose: open === -1 ? text : text.slice(0, open).trim(), answers: [] };
  }
  const prose = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim();
  let value: unknown;
  try {
    value = JSON.parse(match[1]!);
  } catch {
    return { prose, answers: [] };
  }
  if (!Array.isArray(value)) return { prose, answers: [] };
  const numbers = new Set(request.items.map((item) => item.number));
  const answers = new Map<number, ReviewResponseAnswer>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const item = record.item;
    const outcome = typeof record.outcome === 'string' ? record.outcome.trim().toUpperCase() : '';
    if (typeof item !== 'number' || !numbers.has(item) || answers.has(item)) continue;
    if (!(REVIEW_RESPONSE_OUTCOMES as readonly string[]).includes(outcome)) continue;
    const note = typeof record.note === 'string' && record.note.trim() ? record.note.trim().slice(0, REVIEW_RESPONSE_NOTE_LIMIT) : undefined;
    answers.set(item, { item, outcome: outcome as ReviewResponseOutcome, ...(note ? { note } : {}) });
  }
  return { prose, answers: [...answers.values()].sort((a, b) => a.item - b.item) };
}

/** Checks a request as the renderer sends it and as storage keeps it; throws on anything else. */
export function assertReviewRequestRecord(value: unknown): asserts value is ReviewRequestRecord {
  const fail = (): never => {
    throw new Error('The review request is not valid.');
  };
  if (!isRecord(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['reviewRunId', 'items', 'note'].includes(key))) fail();
  if (record.reviewRunId !== undefined && !boundedString(record.reviewRunId, 200)) fail();
  if (record.note !== undefined && !boundedString(record.note, REVIEW_REQUEST_TEXT_LIMIT)) fail();
  if (!Array.isArray(record.items) || record.items.length === 0 || record.items.length > REVIEW_REQUEST_ITEM_LIMIT) fail();
  (record.items as unknown[]).forEach((item, index) => {
    if (!isRecord(item) || item.number !== index + 1) fail();
    const entry = item as Record<string, unknown>;
    if (entry.line !== undefined && !lineNumber(entry.line)) fail();
    if (entry.endLine !== undefined && (!lineNumber(entry.endLine) || typeof entry.line !== 'number' || (entry.endLine as number) < entry.line)) fail();
    if (entry.kind === 'FINDING') {
      if (Object.keys(entry).some((key) => !['number', 'kind', 'findingId', 'severity', 'title', 'path', 'line', 'endLine'].includes(key))) fail();
      if (!boundedString(entry.findingId, 200) || !boundedString(entry.title, REVIEW_REQUEST_TEXT_LIMIT)) fail();
      if (!(AGENT_REVIEW_FINDING_SEVERITIES as readonly unknown[]).includes(entry.severity)) fail();
      if (entry.path !== undefined && !boundedString(entry.path, PATH_LIMIT)) fail();
    } else if (entry.kind === 'COMMENT') {
      if (Object.keys(entry).some((key) => !['number', 'kind', 'path', 'side', 'line', 'endLine', 'text'].includes(key))) fail();
      if (!boundedString(entry.path, PATH_LIMIT) || !boundedString(entry.text, REVIEW_REQUEST_TEXT_LIMIT)) fail();
      if (entry.side !== 'NEW' && entry.side !== 'OLD') fail();
    } else {
      fail();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, limit: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

function lineNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= LINE_LIMIT;
}
