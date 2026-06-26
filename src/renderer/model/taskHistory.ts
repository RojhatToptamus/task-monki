import type { DomainEvent, RunRecord } from '../../shared/contracts';

export interface TaskHistoryItem {
  id: string;
  at: string;
  title: string;
  detail: string;
  tone: 'success' | 'error' | 'info' | 'action' | 'neutral';
  category: 'request' | 'run' | 'review' | 'evidence' | 'test' | 'delivery' | 'state' | 'risk';
}

export function buildTaskHistory(events: DomainEvent[], runs: RunRecord[] = []): TaskHistoryItem[] {
  const runById = new Map(runs.map((run) => [run.id, run]));
  return events
    .map((event) => historyItemFor(event, runById))
    .filter((item): item is TaskHistoryItem => Boolean(item));
}

function historyItemFor(
  event: DomainEvent,
  runById: Map<string, RunRecord>
): TaskHistoryItem | undefined {
  const payload = objectPayload(event.payload);
  const run = event.runId ? runById.get(event.runId) : undefined;
  const mode = stringField(payload, 'mode') ?? run?.mode;

  switch (event.type) {
    case 'TASK_CREATED':
      return item(event, 'request', 'User request created', stringField(payload, 'title') ?? '', 'info');
    case 'TASK_ITERATION_CREATED':
      return item(
        event,
        'state',
        'Iteration prepared',
        stringField(payload, 'branchName') ?? 'Branch prepared.',
        'neutral'
      );
    case 'WORKTREE_CREATED':
    case 'WORKTREE_VERIFIED':
      return item(
        event,
        'state',
        event.type === 'WORKTREE_CREATED' ? 'Worktree ready' : 'Worktree checked',
        stringField(payload, 'worktreePath') ?? stringField(payload, 'status') ?? '',
        'success'
      );
    case 'AGENT_RUN_STARTED':
      return item(event, runCategory(mode), runStartedTitle(mode), runStartedDetail(mode, payload), runTone(mode));
    case 'AGENT_RUN_COMPLETED':
      return item(event, runCategory(run?.mode), runCompletedTitle(run?.mode), runCompletedDetail(run?.mode, payload), 'success');
    case 'AGENT_RUN_FAILED':
      return item(event, runCategory(run?.mode), runFailedTitle(run?.mode), stringField(payload, 'error') ?? 'Run failed.', 'error');
    case 'AGENT_RUN_INTERRUPTED':
      return item(event, runCategory(run?.mode), runInterruptedTitle(run?.mode), stringField(payload, 'terminalReason') ?? 'Stopped by request.', 'action');
    case 'CANCEL_REQUESTED':
      return item(event, runCategory(run?.mode), run?.mode === 'REVIEW' ? 'Stop review requested' : 'Stop run requested', '', 'action');
    case 'AGENT_INTERACTION_REQUESTED':
      return item(event, 'run', 'Agent needs input', humanizeEnum(stringField(payload, 'type') ?? 'REQUEST'), 'action');
    case 'AGENT_INTERACTION_RESOLVED':
      return item(event, 'run', 'Agent request answered', stringField(payload, 'status') ?? '', 'success');
    case 'GIT_SNAPSHOT_CAPTURED':
      return item(
        event,
        'evidence',
        'Git evidence refreshed',
        `Status ${stringField(payload, 'status') ?? 'unknown'} · ${changedFileCount(payload)} changed files`,
        'success'
      );
    case 'TEST_RUN_STARTED':
      return item(event, 'test', 'Tests started', stringField(payload, 'command') ?? 'Local test command.', 'info');
    case 'TEST_RUN_COMPLETED':
      return item(
        event,
        'test',
        'Tests finished',
        `Exit ${nullableNumberField(payload, 'exitCode') ?? 'unknown'}`,
        nullableNumberField(payload, 'exitCode') === 0 ? 'success' : 'error'
      );
    case 'TEST_RESULT_STALE':
      return item(event, 'test', 'Tests stale', stringField(payload, 'reason') ?? 'Diff changed.', 'action');
    case 'TRANSITION_COMPLETED':
      return item(event, 'state', 'Workflow moved', `Moved to ${humanizeEnum(stringField(payload, 'toPhase') ?? 'next phase')}.`, 'info');
    case 'TRANSITION_BLOCKED':
      return item(event, 'state', 'Workflow blocked', stringField(payload, 'reason') ?? '', 'error');
    case 'BRANCH_PUBLISH_REQUESTED':
      return item(event, 'delivery', 'Branch push requested', stringField(payload, 'branchName') ?? '', 'info');
    case 'BRANCH_PUBLISHED':
      return item(event, 'delivery', 'Branch pushed', stringField(payload, 'remoteRef') ?? '', 'success');
    case 'BRANCH_PUBLISH_FAILED':
      return item(event, 'delivery', 'Branch push failed', stringField(payload, 'error') ?? '', 'error');
    case 'PR_CREATE_REQUESTED':
      return item(event, 'delivery', 'Draft PR requested', stringField(payload, 'branchName') ?? '', 'info');
    case 'PR_SNAPSHOT_CAPTURED':
      return item(event, 'delivery', 'Pull request synced', prDetail(payload), 'success');
    case 'CI_ROLLUP_CAPTURED':
      return item(event, 'delivery', 'Checks synced', stringField(payload, 'status') ?? '', deliveryTone(stringField(payload, 'status')));
    case 'REVIEW_ROLLUP_CAPTURED':
      return item(event, 'delivery', 'GitHub reviews synced', stringField(payload, 'status') ?? '', deliveryTone(stringField(payload, 'status')));
    case 'MERGE_SNAPSHOT_CAPTURED':
      return item(event, 'delivery', 'Merge state synced', stringField(payload, 'status') ?? '', deliveryTone(stringField(payload, 'status')));
    case 'GITHUB_SYNC_FAILED':
      return item(event, 'delivery', 'GitHub sync failed', stringField(payload, 'error') ?? '', 'error');
    case 'AGENT_MUTATION_AMBIGUOUS':
      return item(event, 'risk', 'Provider delivery ambiguous', stringField(payload, 'reason') ?? '', 'error');
    case 'AGENT_REVIEW_POLICY_VIOLATION':
      return item(event, 'risk', 'Review changed Git state', 'Review should be read-only.', 'error');
    case 'AGENT_RUNTIME_LOST':
      return item(event, 'risk', 'Agent runtime lost', stringField(payload, 'reason') ?? '', 'error');
    case 'AGENT_RUNTIME_RECONCILED':
      return item(event, 'risk', 'Agent runtime reconciled', `${stringField(payload, 'status') ?? 'unknown'} · ${stringField(payload, 'recoveryState') ?? 'unknown'}`, 'action');
    default:
      return undefined;
  }
}

function item(
  event: DomainEvent,
  category: TaskHistoryItem['category'],
  title: string,
  detail: string,
  tone: TaskHistoryItem['tone']
): TaskHistoryItem {
  return {
    id: event.id,
    at: event.receivedAt,
    title,
    detail,
    tone,
    category
  };
}

function runCategory(mode: string | undefined): TaskHistoryItem['category'] {
  return mode === 'REVIEW' ? 'review' : 'run';
}

function runTone(mode: string | undefined): TaskHistoryItem['tone'] {
  return mode === 'REVIEW' ? 'info' : 'neutral';
}

function runStartedTitle(mode: string | undefined): string {
  switch (mode) {
    case 'REVIEW':
      return 'AI review started';
    case 'FOLLOW_UP':
      return 'Change request started';
    case 'RETRY':
      return 'Retry started';
    case 'SUBAGENT':
      return 'Subagent run observed';
    default:
      return 'Implementation started';
  }
}

function runStartedDetail(mode: string | undefined, payload: Record<string, unknown>): string {
  const settings = objectPayload(payload.requestedSettings);
  const model = stringField(settings, 'model');
  const effort = stringField(settings, 'reasoningEffort');
  const suffix = [model, effort].filter(Boolean).join(' / ');
  if (mode === 'FOLLOW_UP') {
    return suffix ? `Review feedback follow-up · ${suffix}` : 'Review feedback follow-up.';
  }
  if (mode === 'REVIEW') {
    return suffix ? `Current diff · ${suffix}` : 'Current diff.';
  }
  return suffix;
}

function runCompletedTitle(mode: string | undefined): string {
  switch (mode) {
    case 'REVIEW':
      return 'AI review finished';
    case 'FOLLOW_UP':
      return 'Change request finished';
    case 'RETRY':
      return 'Retry finished';
    case 'SUBAGENT':
      return 'Subagent finished';
    default:
      return 'Implementation finished';
  }
}

function runCompletedDetail(mode: string | undefined, payload: Record<string, unknown>): string {
  if (mode === 'REVIEW') {
    return stringField(payload, 'codexReviewStatus')
      ? humanizeEnum(stringField(payload, 'codexReviewStatus') ?? '')
      : 'Review result captured.';
  }
  return stringField(payload, 'terminalStatus') ?? 'Completed.';
}

function runFailedTitle(mode: string | undefined): string {
  return mode === 'REVIEW' ? 'AI review failed' : 'Run failed';
}

function runInterruptedTitle(mode: string | undefined): string {
  return mode === 'REVIEW' ? 'AI review stopped' : 'Run stopped';
}

function changedFileCount(payload: Record<string, unknown>): number {
  return (
    (numberField(payload, 'workingDiffFileCount') ?? 0) +
    (numberField(payload, 'committedDiffFileCount') ?? 0)
  );
}

function prDetail(payload: Record<string, unknown>): string {
  const number = numberField(payload, 'number');
  const status = stringField(payload, 'status') ?? 'unknown';
  return number ? `PR #${number} · ${status}` : status;
}

function deliveryTone(status: string | undefined): TaskHistoryItem['tone'] {
  if (['PASSING', 'APPROVED', 'SATISFIED', 'MERGEABLE', 'MERGED'].includes(status ?? '')) {
    return 'success';
  }
  if (['FAILING', 'BLOCKED', 'CHANGES_REQUESTED', 'CLOSED_UNMERGED'].includes(status ?? '')) {
    return 'error';
  }
  if (['PENDING', 'REQUESTED', 'COMPUTING', 'QUEUED'].includes(status ?? '')) {
    return 'action';
  }
  return 'neutral';
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

function nullableNumberField(payload: Record<string, unknown>, key: string): number | null | undefined {
  const value = payload[key];
  return typeof value === 'number' || value === null ? value : undefined;
}

function humanizeEnum(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
