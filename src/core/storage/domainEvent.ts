import { randomUUID } from 'node:crypto';
import type { DomainEvent, DomainEventType } from '../../shared/contracts';

export interface CreateDomainEventInput {
  type: DomainEventType;
  taskId: string;
  runId?: string;
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
    runId: input.runId,
    source: input.source,
    sourceEventId: input.sourceEventId ?? randomUUID(),
    occurredAt: input.occurredAt ?? now,
    receivedAt: now,
    payload: input.payload ?? {}
  };
}
