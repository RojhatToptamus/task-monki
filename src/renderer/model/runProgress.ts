import type {
  AgentItemRecord,
  AgentPlanRevisionRecord,
  AgentPlanStep,
  CiChecksStatus,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';

export type RunProgressState =
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'RECOVERY_REQUIRED';

export type RunProgressTone = 'neutral' | 'success' | 'action' | 'error';

export interface RunProgressStep {
  step: string;
  status: AgentPlanStep['status'];
}

export interface RunProgressActivityDetail {
  label: string;
  tone: RunProgressTone;
  at: string;
}

export interface RunProgressWorkingNow {
  label: string;
  tone: RunProgressTone;
  at: string;
}

export interface RunProgressFooter {
  title: string;
  detail?: string;
  tone: RunProgressTone;
}

export interface RunProgressViewModel {
  runId: string;
  runStatus: RunRecord['status'];
  state: RunProgressState;
  headerLabel: string;
  steps: RunProgressStep[];
  workingNow?: RunProgressWorkingNow;
  activityDetails: RunProgressActivityDetail[];
  footer?: RunProgressFooter;
}

interface ActivityCandidate extends RunProgressActivityDetail {
  dedupeKey: string;
}

const ACTIVITY_DETAILS_LIMIT = 6;
const PLAN_STEP_LIMIT = 6;
const WORKING_TEXT_LIMIT = 180;
const DETAIL_TEXT_LIMIT = 120;
const FOOTER_TEXT_LIMIT = 120;

const PROGRESS_RUN_MODES = new Set<RunRecord['mode']>([
  'ANALYSIS',
  'IMPLEMENTATION',
  'FOLLOW_UP',
  'RETRY'
]);

const ACTIVE_RUN_STATUSES = new Set<RunRecord['status']>([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
]);

export function buildRunProgressViewModel(input: {
  preferredRun?: RunRecord;
  runs: RunRecord[];
  planRevisions: AgentPlanRevisionRecord[];
  items: AgentItemRecord[];
  gitSnapshot?: GitSnapshotRecord;
  ciStatus?: CiChecksStatus;
}): RunProgressViewModel | undefined {
  const progressRun = selectProgressRun(input.preferredRun, input.runs);
  if (!progressRun) {
    return undefined;
  }

  const state = stateForRun(progressRun);
  const latestPlan = latestPlanForRun(progressRun.id, input.planRevisions);
  const steps =
    latestPlan && latestPlan.steps.length > 0
      ? normalizePlanSteps(latestPlan.steps)
      : fallbackStepsForRun(progressRun, state);
  const activities = state === 'RUNNING' ? activitiesForRun(progressRun.id, input.items) : [];
  const workingNow = state === 'RUNNING' ? activities[0] : undefined;
  const activityDetails =
    state === 'RUNNING' ? activities.slice(workingNow ? 1 : 0) : [];
  const footer =
    state === 'RUNNING'
      ? undefined
      : footerForRun(progressRun, state, input.gitSnapshot, input.ciStatus);

  return {
    runId: progressRun.id,
    runStatus: progressRun.status,
    state,
    headerLabel: headerLabelForState(state),
    steps,
    workingNow,
    activityDetails,
    footer
  };
}

function selectProgressRun(
  preferredRun: RunRecord | undefined,
  runs: RunRecord[]
): RunRecord | undefined {
  if (preferredRun && PROGRESS_RUN_MODES.has(preferredRun.mode)) {
    return preferredRun;
  }
  return [...runs]
    .filter((run) => PROGRESS_RUN_MODES.has(run.mode))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function stateForRun(run: RunRecord): RunProgressState {
  if (ACTIVE_RUN_STATUSES.has(run.status)) {
    return 'RUNNING';
  }
  if (run.status === 'COMPLETED') {
    return 'COMPLETED';
  }
  if (run.status === 'FAILED') {
    return 'FAILED';
  }
  if (run.status === 'INTERRUPTED') {
    return 'INTERRUPTED';
  }
  return 'RECOVERY_REQUIRED';
}

function headerLabelForState(state: RunProgressState): string {
  if (state === 'RUNNING') {
    return 'Current run';
  }
  if (state === 'COMPLETED') {
    return 'Final plan';
  }
  return 'Last known plan';
}

function latestPlanForRun(
  runId: string,
  planRevisions: AgentPlanRevisionRecord[]
): AgentPlanRevisionRecord | undefined {
  return planRevisions
    .filter((plan) => plan.runId === runId && plan.steps.length > 0)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

function normalizePlanSteps(steps: AgentPlanStep[]): RunProgressStep[] {
  const seen = new Set<string>();
  const normalized: RunProgressStep[] = [];
  for (const step of steps) {
    const label = normalizeLabel(step.step);
    if (!label) {
      continue;
    }
    const key = normalizeKey(label);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ step: label, status: step.status });
  }
  if (normalized.length <= PLAN_STEP_LIMIT) {
    return normalized;
  }
  const activeIndex = normalized.findIndex((step) => step.status === 'IN_PROGRESS');
  if (activeIndex === -1) {
    return normalized.slice(0, PLAN_STEP_LIMIT);
  }
  const start = Math.max(
    0,
    Math.min(activeIndex - 2, normalized.length - PLAN_STEP_LIMIT)
  );
  return normalized.slice(start, start + PLAN_STEP_LIMIT);
}

function fallbackStepsForRun(
  run: RunRecord,
  state: RunProgressState
): RunProgressStep[] {
  if (state === 'RUNNING') {
    return [{ step: waitingStepLabel(run.status), status: 'IN_PROGRESS' }];
  }
  return [
    {
      step: terminalStepLabel(state),
      status: state === 'COMPLETED' ? 'COMPLETED' : 'PENDING'
    }
  ];
}

function activitiesForRun(
  runId: string,
  items: AgentItemRecord[]
): RunProgressActivityDetail[] {
  const seen = new Set<string>();
  const activities: RunProgressActivityDetail[] = [];
  const candidates = items
    .filter((item) => item.runId === runId)
    .map(activityFromItem)
    .filter((item): item is ActivityCandidate => item !== undefined)
    .sort((a, b) => b.at.localeCompare(a.at));

  for (const candidate of candidates) {
    if (seen.has(candidate.dedupeKey)) {
      continue;
    }
    seen.add(candidate.dedupeKey);
    activities.push({
      label: candidate.label,
      tone: candidate.tone,
      at: candidate.at
    });
    if (activities.length >= ACTIVITY_DETAILS_LIMIT + 1) {
      break;
    }
  }

  return activities;
}

function activityFromItem(item: AgentItemRecord): ActivityCandidate | undefined {
  const payload = objectPayload(item.payload);
  const at = item.providerCompletedAt ?? item.providerStartedAt ?? item.updatedAt ?? item.createdAt;
  switch (item.type) {
    case 'AGENT_MESSAGE': {
      const text = stringValue(payload.text);
      const label = text ? curateAgentMessage(text, item.status) : undefined;
      return label
        ? {
            label,
            tone: activityToneForLabel(label, item.status),
            at,
            dedupeKey: `message:${normalizeKey(label)}`
          }
        : undefined;
    }
    case 'COMMAND_EXECUTION': {
      const command = stringValue(payload.command);
      const label = commandActivityLabel(command, item.status);
      return label
        ? {
            label,
            tone: commandActivityTone(command, item.status),
            at,
            dedupeKey: `command:${normalizeKey(label)}:${normalizeKey(command ?? '')}`
          }
        : undefined;
    }
    case 'FILE_CHANGE':
      return item.status === 'STARTED' || item.status === 'IN_PROGRESS'
        ? {
            label: 'Editing files.',
            tone: 'neutral',
            at,
            dedupeKey: 'file-change'
          }
        : undefined;
    case 'MCP_TOOL_CALL':
    case 'DYNAMIC_TOOL_CALL':
      return item.status === 'STARTED' || item.status === 'IN_PROGRESS'
        ? {
            label: 'Using tool.',
            tone: 'neutral',
            at,
            dedupeKey: `tool:${normalizeKey(stringValue(payload.tool) ?? stringValue(payload.name) ?? '')}`
          }
        : undefined;
    case 'WEB_SEARCH':
      return item.status === 'STARTED' || item.status === 'IN_PROGRESS'
        ? {
            label: 'Searching documentation.',
            tone: 'neutral',
            at,
            dedupeKey: `web-search:${normalizeKey(stringValue(payload.query) ?? '')}`
          }
        : undefined;
    case 'SUBAGENT':
      return item.status === 'STARTED' || item.status === 'IN_PROGRESS'
        ? {
            label: 'Waiting for delegated work.',
            tone: 'neutral',
            at,
            dedupeKey: `subagent:${normalizeKey(stringValue(payload.tool) ?? stringValue(payload.agentThreadId) ?? '')}`
          }
        : undefined;
    default:
      return undefined;
  }
}

function itemTone(status: AgentItemRecord['status']): RunProgressTone {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'FAILED':
    case 'DECLINED':
    case 'INTERRUPTED':
      return 'error';
    case 'STARTED':
    case 'IN_PROGRESS':
      return 'action';
    default:
      return 'neutral';
  }
}

function activityToneForLabel(
  label: string,
  status: AgentItemRecord['status']
): RunProgressTone {
  if (status === 'FAILED' || status === 'DECLINED' || status === 'INTERRUPTED') {
    return 'error';
  }
  if (/^Verification (finished|failed)\./.test(label)) {
    return itemTone(status);
  }
  if (label === 'Running verification.') {
    return 'action';
  }
  return 'neutral';
}

function commandActivityLabel(
  command: string | undefined,
  status: AgentItemRecord['status']
): string | undefined {
  const lower = (command ?? '').toLowerCase();
  const failed = status === 'FAILED' || status === 'DECLINED' || status === 'INTERRUPTED';
  const completed = status === 'COMPLETED';
  if (looksLikeVerificationCommand(lower)) {
    if (failed) {
      return 'Verification failed.';
    }
    return completed ? 'Verification finished.' : 'Running verification.';
  }
  if (looksLikeGitCommand(lower)) {
    if (failed) {
      return 'Git check failed.';
    }
    return completed ? 'Checked local Git state.' : 'Checking local Git state.';
  }
  if (looksLikeReadCommand(lower)) {
    if (failed) {
      return 'Context read failed.';
    }
    return completed ? undefined : 'Reading project context.';
  }
  if (failed) {
    return 'Command failed.';
  }
  return undefined;
}

function commandActivityTone(
  command: string | undefined,
  status: AgentItemRecord['status']
): RunProgressTone {
  const lower = (command ?? '').toLowerCase();
  if (looksLikeVerificationCommand(lower)) {
    return itemTone(status);
  }
  if (status === 'FAILED' || status === 'DECLINED' || status === 'INTERRUPTED') {
    return 'error';
  }
  return 'neutral';
}

function looksLikeVerificationCommand(command: string): boolean {
  return /\b(test|vitest|jest|pytest|typecheck|tsc|eslint|lint|build|check:codex-protocol|diff --check|prettier --check|cargo test|scarb test)\b/.test(
    command
  );
}

function looksLikeGitCommand(command: string): boolean {
  return /\bgit\s+(status|diff|show|log|rev-parse|branch)\b/.test(command);
}

function looksLikeReadCommand(command: string): boolean {
  return /\b(rg|grep|sed|cat|ls|find|wc|tree|nl)\b/.test(command);
}

function curateAgentMessage(
  text: string,
  status: AgentItemRecord['status']
): string | undefined {
  const cleaned = cleanOverviewText(text).replace(/^progress:\s*/i, '');
  if (!cleaned) {
    return undefined;
  }
  if (looksLikeOverviewNoise(cleaned)) {
    return undefined;
  }
  const readable = readableOverviewSentence(cleaned, WORKING_TEXT_LIMIT);
  if (readable) {
    return readable;
  }

  const lower = cleaned.toLowerCase();
  const path = shortPath(extractPath(cleaned));
  if (/\b(edit(?:ed|ing)?|updat(?:e|ed|ing)?|wir(?:e|ed|ing)?|implement(?:ed|ing)?|add(?:ed|ing)?|fix(?:ed|ing)?|writ(?:e|ing|ten)?|chang(?:e|ed|ing))\b/.test(lower)) {
    return path ? `Editing ${path}.` : 'Editing files.';
  }
  if (/\b(read(?:ing)?|inspect(?:ed|ing)?|trace(?:d|ing)?|confirm(?:ed|ing)?|check(?:ed|ing)?|discover(?:ed|ing)?|review(?:ed|ing)?)\b/.test(lower)) {
    return path ? `Reading ${path}.` : 'Reading project context.';
  }
  if (/\b(summar|final)\b/.test(lower)) {
    return 'Summarizing changes.';
  }
  if (/\b(verif|test|typecheck|build|check)\b/.test(lower)) {
    return status === 'COMPLETED' ? 'Verification finished.' : 'Running verification.';
  }
  return truncateAtWord(cleaned, DETAIL_TEXT_LIMIT);
}

function footerForRun(
  run: RunRecord,
  state: RunProgressState,
  gitSnapshot: GitSnapshotRecord | undefined,
  ciStatus: CiChecksStatus | undefined
): RunProgressFooter {
  if (state === 'COMPLETED') {
    return {
      title: 'Completed',
      detail: completedFooterDetail(gitSnapshot, ciStatus),
      tone: 'success'
    };
  }
  if (state === 'FAILED') {
    return {
      title: 'Failed',
      detail: terminalFooterDetail(run) ?? 'Run stopped before completion.',
      tone: 'error'
    };
  }
  if (state === 'INTERRUPTED') {
    return {
      title: 'Interrupted',
      detail: terminalFooterDetail(run) ?? 'Run was interrupted.',
      tone: 'neutral'
    };
  }
  return {
    title: 'Recovery required',
    detail: terminalFooterDetail(run) ?? 'Task Monki needs recovery before this run can continue.',
    tone: 'error'
  };
}

function completedFooterDetail(
  gitSnapshot: GitSnapshotRecord | undefined,
  ciStatus: CiChecksStatus | undefined
): string {
  const fileCount = changedFileCount(gitSnapshot);
  const parts: string[] = [];
  if (fileCount !== undefined) {
    parts.push(fileCount === 0 ? 'no file changes' : `${fileCount} ${plural(fileCount, 'file')} changed`);
  }
  parts.push(verificationFooterText(ciStatus));
  return parts.join(' · ');
}

function changedFileCount(gitSnapshot: GitSnapshotRecord | undefined): number | undefined {
  if (!gitSnapshot) {
    return undefined;
  }
  const diffCount =
    Math.max(0, gitSnapshot.committedDiffFileCount) +
    Math.max(0, gitSnapshot.workingDiffFileCount);
  if (diffCount > 0) {
    return diffCount;
  }
  return (
    Math.max(0, gitSnapshot.stagedCount) +
    Math.max(0, gitSnapshot.unstagedCount) +
    Math.max(0, gitSnapshot.untrackedCount)
  );
}

function verificationFooterText(status: CiChecksStatus | undefined): string {
  switch (status) {
    case 'PASSING':
      return 'verification passed';
    case 'FAILING':
    case 'BLOCKED':
      return 'verification failed';
    case 'PENDING':
    case 'EXPECTED_NOT_REPORTED':
      return 'verification pending';
    case 'CANCELED':
      return 'verification canceled';
    case 'NOT_APPLICABLE':
    case 'NO_CHECKS':
    case 'STALE':
    case 'UNKNOWN':
    default:
      return 'verification not run';
  }
}

function terminalFooterDetail(run: RunRecord): string | undefined {
  const reason = cleanOverviewText(run.terminalReason);
  return reason ? truncateText(reason, FOOTER_TEXT_LIMIT) : undefined;
}

function waitingStepLabel(status: RunRecord['status']): string {
  if (status === 'AWAITING_APPROVAL') {
    return 'Waiting for approval';
  }
  if (status === 'AWAITING_USER_INPUT') {
    return 'Waiting for user input';
  }
  if (status === 'QUEUED' || status === 'STARTING') {
    return 'Starting agent turn';
  }
  if (status === 'INTERRUPTING') {
    return 'Interrupting agent turn';
  }
  return 'Waiting for provider plan...';
}

function terminalStepLabel(state: RunProgressState): string {
  if (state === 'COMPLETED') {
    return 'Run completed';
  }
  if (state === 'FAILED') {
    return 'Run stopped before a provider plan was reported';
  }
  if (state === 'INTERRUPTED') {
    return 'Run was interrupted before a provider plan was reported';
  }
  return 'Recovery is required before progress can continue';
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeLabel(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

function normalizeKey(text: string): string {
  return normalizeLabel(text).toLowerCase();
}

function cleanOverviewText(text: string | undefined): string {
  return normalizeLabel(text ?? '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)(\/[^\s'")]+(?:\/[^\s'")]+){2,})/g, (_match, prefix: string, value: string) => {
      return `${prefix}${shortPath(value) ?? value}`;
    });
}

function looksLikeOverviewNoise(text: string): boolean {
  return /(?:\/bin\/(?:zsh|bash|sh)|\s-lc\s|turn\/[a-z-]+|item\/[a-z-]+|jsonrpc|protocol message|provideritemid)/i.test(
    text
  );
}

function readableOverviewSentence(text: string, maxLength: number): string | undefined {
  const normalized = normalizeLabel(text);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return ensureSentencePunctuation(normalized);
  }
  const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
  if (sentences.length > 0) {
    const joined: string[] = [];
    for (const sentence of sentences) {
      const next = [...joined, sentence.trim()].join(' ');
      if (next.length > maxLength) {
        break;
      }
      joined.push(sentence.trim());
      if (joined.length >= 2) {
        break;
      }
    }
    const candidate = joined.join(' ').trim();
    if (candidate.length >= 24) {
      return ensureSentencePunctuation(candidate);
    }
  }
  return undefined;
}

function extractPath(text: string): string | undefined {
  return text.match(/(?:^|\s)([./~\w-]+(?:\/[\w.-]+)+)(?=$|\s|[.,;:)])/u)?.[1];
}

function shortPath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  const cleaned = path.replace(/^[`'"]+|[`'".,;:]+$/g, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }
  return segments.slice(-2).join('/');
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function ensureSentencePunctuation(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function truncateAtWord(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return ensureSentencePunctuation(normalized);
  }
  const sliced = normalized.slice(0, Math.max(0, maxLength - 1));
  const boundary = sliced.lastIndexOf(' ');
  const clipped = (boundary > 40 ? sliced.slice(0, boundary) : sliced).trimEnd();
  return `${clipped}...`;
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}
