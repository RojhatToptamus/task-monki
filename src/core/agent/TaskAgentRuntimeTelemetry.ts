import { createHash } from 'node:crypto';
import type {
  AgentRuntimeTelemetryKind,
  AgentRuntimeTelemetryRecord
} from '../../shared/agentRuntime';
import type { AgentRuntimeStore } from './AgentRuntimeStore';

export interface TaskRuntimeTelemetrySource {
  id: string;
  taskId: string;
  sessionId: string;
  runId?: string;
}

/**
 * Copies a task-owned provider observation into the owner-neutral runtime.
 * The task projection remains path-free: scope identifiers live in the
 * telemetry envelope and are removed from the provider payload.
 */
export async function recordTaskRuntimeTelemetry(
  runtime: AgentRuntimeStore | undefined,
  kind: AgentRuntimeTelemetryKind,
  source: TaskRuntimeTelemetrySource,
  observedAt: string
): Promise<AgentRuntimeTelemetryRecord | undefined> {
  if (!runtime) return undefined;
  const session = await runtime.getSession(source.sessionId);
  if (
    !session ||
    session.owner.kind !== 'TASK' ||
    session.owner.taskId !== source.taskId
  ) {
    return undefined;
  }
  const run = source.runId ? await runtime.getRun(source.runId) : undefined;
  if (
    source.runId &&
    (!run ||
      run.sessionId !== session.id ||
      run.owner.kind !== 'TASK' ||
      run.owner.taskId !== source.taskId)
  ) {
    return undefined;
  }
  const payload = stripTaskScope(source);
  const digest = createHash('sha256')
    .update(JSON.stringify({ kind, id: source.id, observedAt, payload }))
    .digest('hex');
  return runtime.recordTelemetry({
    id: `telemetry-${digest}`,
    kind,
    owner: session.owner,
    sessionId: session.id,
    ...(run ? { runId: run.id } : {}),
    clientOperationId: `task-telemetry:${digest}`,
    payload,
    observedAt
  });
}

function stripTaskScope(source: TaskRuntimeTelemetrySource): unknown {
  const {
    taskId: _taskId,
    runId: _runId,
    sessionId: _sessionId,
    ...payload
  } = source as TaskRuntimeTelemetrySource & Record<string, unknown>;
  const { iterationId: _iterationId, ...withoutIteration } = payload;
  return withoutIteration;
}
