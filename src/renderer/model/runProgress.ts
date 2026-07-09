import type {
  AgentItemRecord,
  AgentPlanRevisionRecord,
  AgentPlanStep,
  CiChecksStatus,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import {
  buildRunActivityProjection,
  type RunActivityCategory,
  type RunActivityTone
} from './runActivity';
import {
  buildOverviewRunActivityRows,
  type OverviewActivityRow
} from './overviewRunActivity';

export type RunProgressState =
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'RECOVERY_REQUIRED';

export type RunProgressTone = RunActivityTone;

export interface RunProgressStep {
  step: string;
  status: AgentPlanStep['status'];
  /**
   * A placeholder step standing in for a plan the provider hasn't sent yet
   * ("Waiting for provider plan…"). The card shimmers it so the wait reads as
   * live, distinct from a real active step that just carries weight.
   */
  pending?: boolean;
}

export type { RunActivityCategory };
export type RunActivityEntry = OverviewActivityRow;

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
  activityTail: RunActivityEntry[];
  activityOutputSummary?: string;
  footer?: RunProgressFooter;
}

interface ActivityProjection {
  tail: RunActivityEntry[];
  outputSummary?: string;
}

const ACTIVITY_TAIL_LIMIT = 5;
const PLAN_STEP_LIMIT = 6;
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
  const activityProjection =
    state === 'RUNNING'
      ? activityProjectionForRun(progressRun, input.items)
      : { tail: [] };
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
    activityTail: activityProjection.tail,
    activityOutputSummary: activityProjection.outputSummary,
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
    return [{ step: waitingStepLabel(run.status), status: 'IN_PROGRESS', pending: true }];
  }
  return [
    {
      step: terminalStepLabel(state),
      status: state === 'COMPLETED' ? 'COMPLETED' : 'PENDING'
    }
  ];
}

function activityProjectionForRun(
  run: RunRecord,
  items: AgentItemRecord[]
): ActivityProjection {
  const projection = buildRunActivityProjection({ run, items });
  const overviewRows = buildOverviewRunActivityRows(projection.rows);
  return {
    tail: overviewRows.slice(-ACTIVITY_TAIL_LIMIT),
    outputSummary: projection.outputSummary
  };
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
      return 'not verified';
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

function shortPath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  const cleaned = path.replace(/^[`'"]+|[`'".,;:]+$/g, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }
  const anchor = ['src', 'tests', 'test', 'docs', 'scripts'].find((candidate) =>
    segments.includes(candidate)
  );
  if (anchor) {
    const index = segments.indexOf(anchor);
    const anchored = segments.slice(index);
    return anchored.length <= 5 ? anchored.join('/') : anchored.slice(-5).join('/');
  }
  const repoIndex = segments.lastIndexOf('repo');
  if (repoIndex >= 0 && repoIndex < segments.length - 1) {
    const repoRelative = segments.slice(repoIndex + 1);
    return repoRelative.length <= 5 ? repoRelative.join('/') : repoRelative.slice(-5).join('/');
  }
  if (!cleaned.startsWith('/') && segments.length <= 5) {
    return segments.join('/');
  }
  return segments.slice(-3).join('/');
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}
