import { randomUUID } from 'node:crypto';
import type { DomainEvent, DomainEventType } from '../../shared/contracts';

export interface CreateDomainEventInput {
  type: DomainEventType;
  taskId: string;
  iterationId?: string;
  runId?: string;
  agentSessionId?: string;
  serverInstanceId?: string;
  agentItemId?: string;
  interactionRequestId?: string;
  worktreeId?: string;
  source: DomainEvent['source'];
  payload?: unknown;
  sourceEventId?: string;
  occurredAt?: string;
}

export function createDomainEvent(input: CreateDomainEventInput): DomainEvent {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    type: input.type,
    taskId: input.taskId,
    iterationId: input.iterationId,
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    serverInstanceId: input.serverInstanceId,
    agentItemId: input.agentItemId,
    interactionRequestId: input.interactionRequestId,
    worktreeId: input.worktreeId,
    source: input.source,
    sourceEventId: input.sourceEventId ?? randomUUID(),
    occurredAt: input.occurredAt ?? now,
    receivedAt: now,
    payload: input.payload ?? {}
  };
}
