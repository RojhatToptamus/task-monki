import type {
  DomainEvent,
  Finding,
  HealthStatus,
  RunRecord,
  StatusProjection,
  Task,
  TaskSnapshot
} from '../../shared/contracts';
import { createInitialProjection } from '../../shared/contracts';

export interface StoreState extends TaskSnapshot {}

export function createEmptyState(): StoreState {
  return {
    tasks: [],
    runs: [],
    events: [],
    artifacts: []
  };
}

export function applyEventToState(state: StoreState, event: DomainEvent): StoreState {
  const next: StoreState = {
    tasks: [...state.tasks],
    runs: [...state.runs],
    events: [...state.events, event],
    artifacts: [...state.artifacts]
  };

  const taskIndex = next.tasks.findIndex((task) => task.id === event.taskId);
  const runIndex = event.runId ? next.runs.findIndex((run) => run.id === event.runId) : -1;

  if (taskIndex === -1 && event.type !== 'TASK_CREATED') {
    return next;
  }

  if (event.type === 'TASK_CREATED') {
    return next;
  }

  if (runIndex >= 0) {
    next.runs[runIndex] = reduceRun(next.runs[runIndex], event);
  }

  if (taskIndex >= 0) {
    const task = next.tasks[taskIndex];
    const currentRun = event.runId
      ? next.runs.find((run) => run.id === event.runId)
      : next.runs.find((run) => run.id === task.currentRunId);

    next.tasks[taskIndex] = {
      ...task,
      workflowPhase: reduceWorkflowPhase(task, event),
      projection: reduceProjection(task.projection, event, currentRun),
      updatedAt: event.receivedAt
    };
  }

  return next;
}

export function reduceRun(run: RunRecord, event: DomainEvent): RunRecord {
  switch (event.type) {
    case 'PROCESS_STARTED':
      return {
        ...run,
        processStatus: 'RUNNING',
        status: 'RUNNING',
        pid: getNumber(event.payload, 'pid'),
        lastEventAt: event.receivedAt
      };
    case 'CODEX_EVENT_PARSED': {
      const terminalStatus = getString(event.payload, 'terminalStatus');
      const eventType = getString(event.payload, 'eventType');
      const messageText = getString(event.payload, 'messageText');

      return {
        ...run,
        eventCount: run.eventCount + 1,
        lastEventAt: event.receivedAt,
        lastEventType: eventType ?? run.lastEventType,
        status:
          terminalStatus === 'completed'
            ? 'COMPLETED'
            : terminalStatus === 'failed'
              ? 'FAILED'
              : terminalStatus === 'interrupted'
                ? 'CANCELED'
                : run.status === 'QUEUED' || run.status === 'STARTING'
                  ? 'RUNNING'
                  : run.status,
        finalMessage: messageText ?? run.finalMessage
      };
    }
    case 'CODEX_RUN_COMPLETED':
      return {
        ...run,
        status: 'COMPLETED',
        endedAt: event.receivedAt,
        finalArtifactId: getString(event.payload, 'finalArtifactId') ?? run.finalArtifactId
      };
    case 'CODEX_RUN_FAILED':
      return {
        ...run,
        status: 'FAILED',
        endedAt: event.receivedAt,
        finalArtifactId: getString(event.payload, 'finalArtifactId') ?? run.finalArtifactId
      };
    case 'PROCESS_EXITED':
      return {
        ...run,
        processStatus: 'EXITED',
        exitCode: getNullableNumber(event.payload, 'exitCode'),
        signal: null,
        endedAt: event.receivedAt
      };
    case 'PROCESS_SIGNALED':
      return {
        ...run,
        processStatus: 'SIGNALED',
        signal: getString(event.payload, 'signal') as NodeJS.Signals | null,
        exitCode: null,
        endedAt: event.receivedAt,
        status: run.status === 'COMPLETED' ? run.status : 'CANCELED'
      };
    case 'CANCEL_REQUESTED':
      return {
        ...run,
        processStatus: 'CANCELING',
        status: run.status === 'COMPLETED' ? run.status : 'CANCELED'
      };
    default:
      return run;
  }
}

function reduceWorkflowPhase(task: Task, event: DomainEvent): Task['workflowPhase'] {
  switch (event.type) {
    case 'TRANSITION_REQUESTED':
    case 'ACTION_ATTEMPT_STARTED':
    case 'PROCESS_STARTED':
      return 'IN_PROGRESS';
    case 'CODEX_RUN_COMPLETED':
    case 'CODEX_RUN_FAILED':
    case 'PROCESS_EXITED':
    case 'PROCESS_SIGNALED':
      return task.workflowPhase === 'IN_PROGRESS' ? 'REVIEW' : task.workflowPhase;
    default:
      return task.workflowPhase;
  }
}

export function reduceProjection(
  projection: StatusProjection | undefined,
  event: DomainEvent,
  run?: RunRecord
): StatusProjection {
  const base = projection ?? createInitialProjection(event.receivedAt);
  const findings = mergeFindings(base.findings, findingsForEvent(event, run));

  switch (event.type) {
    case 'REPOSITORY_PREFLIGHT_COMPLETED':
      return {
        ...base,
        repositoryPreflight: getString(event.payload, 'status') === 'VALID' ? 'VALID' : 'INVALID',
        health: getString(event.payload, 'status') === 'VALID' ? 'INFO' : 'ERROR',
        summary:
          getString(event.payload, 'status') === 'VALID'
            ? 'Repository preflight passed.'
            : 'Repository preflight failed.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'TRANSITION_REQUESTED':
      return {
        ...base,
        requestedAction: 'REQUESTED',
        summary: 'Read-only Codex run requested.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'ACTION_ATTEMPT_STARTED':
      return {
        ...base,
        requestedAction: 'STARTING',
        codexRun: 'STARTING',
        osProcess: 'SPAWNING',
        summary: 'Starting read-only Codex run.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROCESS_STARTED':
      return {
        ...base,
        requestedAction: 'RUNNING',
        codexRun: 'RUNNING',
        osProcess: 'RUNNING',
        health: 'INFO',
        summary: 'Read-only Codex run is active.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'CODEX_EVENT_PARSED':
      return {
        ...base,
        codexRun: run?.status ?? base.codexRun,
        summary: `Latest Codex event: ${getString(event.payload, 'eventType') ?? 'unknown'}.`,
        findings,
        updatedAt: event.receivedAt
      };
    case 'CODEX_STDERR_CHUNK':
      return {
        ...base,
        health: maxHealth(base.health, 'WARNING'),
        summary: 'Codex wrote diagnostic output to stderr.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'CANCEL_REQUESTED':
      return {
        ...base,
        requestedAction: 'CANCEL_REQUESTED',
        osProcess: 'CANCELING',
        health: 'WARNING',
        summary: 'Cancellation requested; waiting for process termination.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'CODEX_RUN_COMPLETED':
      return {
        ...base,
        requestedAction: 'SUCCEEDED',
        codexRun: 'COMPLETED',
        artifact: 'FINAL_MESSAGE_PRESENT',
        health: findings.some((finding) => finding.severity === 'WARNING') ? 'WARNING' : 'HEALTHY',
        summary: 'Read-only Codex run completed. Review the final artifact.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'CODEX_RUN_FAILED':
      return {
        ...base,
        requestedAction: 'FAILED',
        codexRun: 'FAILED',
        health: 'ERROR',
        summary: 'Codex run failed. Review logs for details.',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROCESS_EXITED':
      return {
        ...base,
        osProcess: 'EXITED',
        health: getNullableNumber(event.payload, 'exitCode') === 0 ? base.health : 'ERROR',
        findings,
        updatedAt: event.receivedAt
      };
    case 'PROCESS_SIGNALED':
      return {
        ...base,
        requestedAction: 'CANCELED',
        osProcess: 'SIGNALED',
        codexRun: base.codexRun === 'COMPLETED' ? base.codexRun : 'CANCELED',
        health: 'WARNING',
        summary: 'Run ended after a cancellation signal.',
        findings,
        updatedAt: event.receivedAt
      };
    default:
      return {
        ...base,
        findings,
        updatedAt: event.receivedAt
      };
  }
}

function findingsForEvent(event: DomainEvent, run?: RunRecord): Finding[] {
  if (event.type === 'CODEX_STDERR_CHUNK') {
    return [
      {
        id: `${event.id}:stderr`,
        code: 'CODEX_STDERR_OUTPUT',
        severity: 'WARNING',
        message: 'Codex produced stderr output; inspect diagnostics.',
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'PROCESS_EXITED' && getNullableNumber(event.payload, 'exitCode') !== 0) {
    return [
      {
        id: `${event.id}:exit`,
        code: 'PROCESS_NON_ZERO_EXIT',
        severity: 'ERROR',
        message: `Process exited with code ${getNullableNumber(event.payload, 'exitCode')}.`,
        createdAt: event.receivedAt
      }
    ];
  }

  if (event.type === 'PROCESS_EXITED' && run?.status === 'UNKNOWN') {
    return [
      {
        id: `${event.id}:unknown-codex-terminal`,
        code: 'PROCESS_EXITED_WITHOUT_CODEX_TERMINAL_EVENT',
        severity: 'WARNING',
        message: 'Process exited before a terminal Codex event was observed.',
        createdAt: event.receivedAt
      }
    ];
  }

  return [];
}

function mergeFindings(existing: Finding[], additions: Finding[]): Finding[] {
  if (additions.length === 0) {
    return existing;
  }

  const byCode = new Map(existing.map((finding) => [finding.code, finding]));
  for (const finding of additions) {
    byCode.set(finding.code, finding);
  }
  return [...byCode.values()];
}

function maxHealth(a: HealthStatus, b: HealthStatus): HealthStatus {
  const order: HealthStatus[] = ['HEALTHY', 'INFO', 'WARNING', 'ERROR', 'BLOCKED'];
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

function getString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumber(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

function getNullableNumber(payload: unknown, key: string): number | null | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' || value === null ? value : undefined;
}
