import type { AgentItemRecord, RunRecord } from '../../shared/contracts';
import {
  buildRunActivityProjection,
  type RunActivityRow
} from './runActivity';

export interface ReviewActivityViewModel {
  label: string;
}

const REVIEW_ACTIVITY_FALLBACK = 'Preparing review context.';
const REVIEW_ACTIVITY_TEXT_LIMIT = 120;

export function buildReviewActivityViewModel(input: {
  reviewRun?: RunRecord;
  reviewRunning: boolean;
  useRunActivity: boolean;
  items: AgentItemRecord[];
}): ReviewActivityViewModel | undefined {
  if (!input.reviewRunning) {
    return undefined;
  }

  if (
    !input.reviewRun ||
    input.reviewRun.mode !== 'REVIEW' ||
    !input.useRunActivity
  ) {
    return { label: REVIEW_ACTIVITY_FALLBACK };
  }

  const reviewRunId = input.reviewRun.id;
  const proseActivities = input.items
    .filter((item) => item.runId === reviewRunId && item.type === 'AGENT_MESSAGE')
    .map(reviewActivityFromItem)
    .filter((activity): activity is { label: string; at: string } => Boolean(activity));
  const telemetryActivities = buildRunActivityProjection({
    run: input.reviewRun,
    items: input.items.filter((item) => item.type !== 'AGENT_MESSAGE')
  }).rows
    .map(reviewActivityFromRow)
    .filter((activity): activity is { label: string; at: string } => Boolean(activity));
  const latest = [...proseActivities, ...telemetryActivities]
    .sort((a, b) => b.at.localeCompare(a.at))[0];

  return { label: latest?.label ?? REVIEW_ACTIVITY_FALLBACK };
}

function reviewActivityFromRow(
  row: RunActivityRow
): { label: string; at: string } | undefined {
  if (row.status === 'failed') {
    if (row.category === 'error') {
      return { label: 'Review command failed.', at: row.at };
    }
    return undefined;
  }

  const label = reviewActivityLabelForRow(row);
  return label ? { label, at: row.at } : undefined;
}

function reviewActivityLabelForRow(row: RunActivityRow): string | undefined {
  const detail = row.detail;
  switch (row.category) {
    case 'read':
      return `Reading ${detail ?? 'review context'}.`;
    case 'search':
      return `Searching ${detail ?? 'review context'}.`;
    case 'list':
      return `Listing ${detail ?? 'review directories'}.`;
    case 'edit':
    case 'write':
    case 'patch':
      return `Inspecting file changes${detail ? ` in ${detail}` : ''}.`;
    case 'verify':
      return row.status === 'active'
        ? 'Running verification.'
        : `Checked ${detail ?? 'verification'}.`;
    case 'git':
      return `Inspecting Git ${detail ?? 'state'}.`;
    case 'bash':
      return row.status === 'active'
        ? 'Running review command.'
        : 'Review command completed.';
    case 'web':
      return `Checking web context${detail ? ` for ${detail}` : ''}.`;
    case 'mcp':
      return `Using ${detail ?? 'tool'} for review.`;
    case 'subagent':
      return `Waiting on ${detail ?? 'review subagent'}.`;
    case 'permission':
      return 'Waiting for review approval.';
    case 'question':
      return 'Waiting for review input.';
    case 'compaction':
      return 'Compacting review context.';
    case 'other':
      return detail ? ensureSentence(truncateAtWord(detail, REVIEW_ACTIVITY_TEXT_LIMIT)) : undefined;
    case 'error':
      return 'Review command failed.';
    default:
      return undefined;
  }
}

function reviewActivityFromItem(
  item: AgentItemRecord
): { label: string; at: string } | undefined {
  if (item.status === 'FAILED' || item.status === 'DECLINED' || item.status === 'INTERRUPTED') {
    return undefined;
  }

  const text = stringValue(objectPayload(item.payload).text);
  const label = text ? curateReviewActivity(text) : undefined;
  if (!label) {
    return undefined;
  }

  return {
    label,
    at: item.providerCompletedAt ?? item.providerStartedAt ?? item.updatedAt ?? item.createdAt
  };
}

function curateReviewActivity(text: string): string | undefined {
  const cleaned = cleanActivityText(text).replace(/^progress:\s*/i, '');
  if (!cleaned) {
    return undefined;
  }

  if (looksLikeFinalReviewOutput(cleaned)) {
    return 'Preparing review findings.';
  }

  if (looksLikeRawProviderNoise(cleaned)) {
    return undefined;
  }

  const sentence = firstSentence(cleaned);
  if (sentence && isUsefulReviewSentence(sentence)) {
    return ensureSentence(truncateAtWord(sentence, REVIEW_ACTIVITY_TEXT_LIMIT));
  }

  const lower = cleaned.toLowerCase();
  if (/\b(finding|findings|report|result|summar|prepar)\b/.test(lower)) {
    return 'Preparing review findings.';
  }
  if (/\b(regression|regressions|diff|changed files?|patch|review|inspect|audit|analyz|scan)\b/.test(lower)) {
    return 'Inspecting changed files for regressions.';
  }

  return undefined;
}

function isUsefulReviewSentence(text: string): boolean {
  if (looksLikeRawProviderNoise(text)) {
    return false;
  }
  return /\b(progress|review|inspect|diff|regression|finding|prepare|summar|check|scan|audit|analyz|changed files?|patch)\b/i.test(
    text
  );
}

function looksLikeFinalReviewOutput(text: string): boolean {
  return /```|schemaVersion|agent-review\/v1|"verdict"|"findings"|\bverdict:\s*(passed|needs_changes|inconclusive)\b/i.test(
    text
  );
}

function looksLikeRawProviderNoise(text: string): boolean {
  return /\/bin\/(?:ba)?sh|\bcommand (completed|failed|started|running)\b|\bexit code\b|\bturn\/[a-z]|\bitem\/[a-z]|\breview\/start\b|\bprotocol\b|\bprovider\b|\btool call\b/i.test(
    text
  );
}

function cleanActivityText(text: string): string {
  return text
    .replace(/\[[^\]]+\]\((?:\/[^)]+|[A-Za-z]:\\[^)]+)\)/g, (match) => {
      const label = /^\[([^\]]+)\]/.exec(match)?.[1];
      return label ?? 'changed file';
    })
    .replace(/`{1,3}/g, '')
    .replace(/(?:\/Users|\/private|\/tmp|\/var)\/[^\s)]+/g, 'changed files')
    .replace(/[A-Za-z]:\\[^\s)]+/g, 'changed files')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(text: string): string | undefined {
  const match = /^[^.!?]+[.!?]/.exec(text);
  return (match?.[0] ?? text).trim() || undefined;
}

function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const truncated = text.slice(0, limit - 1);
  const wordBoundary = truncated.lastIndexOf(' ');
  return `${truncated.slice(0, wordBoundary > 40 ? wordBoundary : limit - 1).trim()}...`;
}

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
