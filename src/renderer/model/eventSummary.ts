import type { DomainEvent } from '../../shared/contracts';

export interface EventSummary {
  label: string;
  detail: string;
}

export function summarizeEvent(event: DomainEvent): EventSummary {
  const payload = objectPayload(event.payload);

  switch (event.type) {
    case 'TASK_CREATED':
      return { label: 'Task created', detail: stringField(payload, 'title') ?? 'Task was added.' };
    case 'TASK_ITERATION_CREATED':
      return {
        label: 'Iteration created',
        detail: `Branch ${stringField(payload, 'branchName') ?? 'unknown'} prepared.`
      };
    case 'WORKTREE_CREATED':
    case 'WORKTREE_VERIFIED':
      return {
        label: event.type === 'WORKTREE_CREATED' ? 'Worktree ready' : 'Worktree checked',
        detail: stringField(payload, 'worktreePath') ?? stringField(payload, 'status') ?? ''
      };
    case 'GIT_SNAPSHOT_CAPTURED':
      return {
        label: 'Git evidence refreshed',
        detail: `Status ${stringField(payload, 'status') ?? 'unknown'}, changed files ${numberField(payload, 'workingDiffFileCount') ?? 0}.`
      };
    case 'TEST_RUN_STARTED':
      return { label: 'Tests queued', detail: stringField(payload, 'command') ?? 'Local test command queued.' };
    case 'TEST_RUN_COMPLETED':
      return {
        label: 'Tests finished',
        detail: `Exit ${nullableNumberField(payload, 'exitCode') ?? 'unknown'}.`
      };
    case 'TEST_RESULT_STALE':
      return { label: 'Tests stale', detail: stringField(payload, 'reason') ?? 'Git generation changed.' };
    case 'CODEX_EVENT_PARSED':
      return {
        label: 'Codex update',
        detail: summarizeCodexEvent(stringField(payload, 'eventType'), stringField(payload, 'messageText'))
      };
    case 'CODEX_RUN_COMPLETED':
      return { label: 'Codex completed', detail: 'Final response and evidence were captured.' };
    case 'CODEX_RUN_FAILED':
      return { label: 'Codex failed', detail: stringField(payload, 'error') ?? 'Inspect run evidence.' };
    case 'PROCESS_STARTED':
      return { label: 'Process started', detail: `PID ${numberField(payload, 'pid') ?? 'unknown'}.` };
    case 'PROCESS_EXITED':
      return { label: 'Process exited', detail: `Exit ${nullableNumberField(payload, 'exitCode') ?? 'unknown'}.` };
    case 'GITHUB_PREFLIGHT_COMPLETED':
      return {
        label: 'GitHub checked',
        detail: `${stringField(payload, 'owner') ?? 'unknown'}/${stringField(payload, 'repo') ?? 'unknown'}: ${stringField(payload, 'status') ?? 'unknown'}`
      };
    case 'BRANCH_PUBLISHED':
      return { label: 'Branch pushed', detail: stringField(payload, 'remoteRef') ?? 'Remote branch updated.' };
    case 'BRANCH_PUBLISH_FAILED':
      return { label: 'Branch push failed', detail: stringField(payload, 'error') ?? 'Remote push failed.' };
    case 'PR_SNAPSHOT_CAPTURED':
      return {
        label: 'Pull request synced',
        detail: `PR #${numberField(payload, 'number') ?? 'unknown'} ${stringField(payload, 'status') ?? 'unknown'}.`
      };
    case 'CI_ROLLUP_CAPTURED':
      return { label: 'Checks synced', detail: stringField(payload, 'status') ?? 'Check status updated.' };
    case 'REVIEW_ROLLUP_CAPTURED':
      return { label: 'Reviews synced', detail: stringField(payload, 'status') ?? 'Review status updated.' };
    case 'MERGE_SNAPSHOT_CAPTURED':
      return { label: 'Merge state synced', detail: stringField(payload, 'status') ?? 'Merge status updated.' };
    case 'GITHUB_SYNC_FAILED':
      return { label: 'GitHub sync failed', detail: stringField(payload, 'error') ?? 'Inspect GitHub evidence.' };
    case 'PROMPT_REFINED':
      return { label: 'Prompt refined', detail: 'Structured prompt generated from short input.' };
    case 'TRANSITION_COMPLETED':
      return { label: 'Workflow moved', detail: transitionCompletedDetail(payload) };
    case 'TRANSITION_BLOCKED':
      return { label: 'Transition blocked', detail: stringField(payload, 'reason') ?? 'Missing evidence.' };
    default:
      return { label: humanizeEventType(event.type), detail: summarizePayload(payload) };
  }
}

function summarizeCodexEvent(eventType: string | undefined, messageText: string | undefined): string {
  if (messageText) {
    return messageText.trim().slice(0, 140);
  }
  if (eventType === 'turn.completed') {
    return 'Codex turn completed.';
  }
  if (eventType === 'turn.failed') {
    return 'Codex turn failed.';
  }
  if (eventType === 'thread.started') {
    return 'Codex thread started.';
  }
  return eventType ?? 'Codex event received.';
}

function humanizeEventType(type: string): string {
  return type
    .toLowerCase()
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function transitionCompletedDetail(payload: Record<string, unknown>): string {
  const toPhase = stringField(payload, 'toPhase');
  return `Moved to ${toPhase ?? 'next phase'}.`;
}

function summarizePayload(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string') {
    return payload.text.trim().slice(0, 140);
  }
  if (typeof payload.error === 'string') {
    return payload.error;
  }
  if (typeof payload.status === 'string') {
    return payload.status;
  }
  return '';
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
