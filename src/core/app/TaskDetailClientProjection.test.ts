import { describe, expect, it } from 'vitest';
import type {
  AgentItemRecord,
  DomainEvent,
  RunRecord,
  TaskDetailSnapshot
} from '../../shared/contracts';
import {
  CLIENT_DETAIL_TEXT_BYTES,
  projectTaskDetailForClient
} from './TaskDetailClientProjection';

describe('projectTaskDetailForClient', () => {
  it('bounds large provider text without mutating durable snapshot records', () => {
    const largeText = `start-${'🙂'.repeat(CLIENT_DETAIL_TEXT_BYTES)}-end`;
    const run = {
      id: 'run-1',
      finalArtifactId: 'artifact-1',
      finalMessage: largeText
    } as RunRecord;
    const item = {
      id: 'item-1',
      payload: {
        text: largeText,
        nested: ['unchanged', largeText]
      }
    } as AgentItemRecord;
    const event = {
      id: 'event-1',
      payload: {
        eventType: 'message/completed',
        messageText: largeText
      }
    } as DomainEvent;
    const detail = {
      runs: [run],
      agentItems: [item],
      events: [event],
      textExcerpts: []
    } as unknown as TaskDetailSnapshot;

    const projected = projectTaskDetailForClient(detail);
    const projectedMessage = projected.runs[0]?.finalMessage ?? '';
    const payload = projected.agentItems[0]?.payload as {
      text: string;
      nested: string[];
    };

    expect(Buffer.byteLength(projectedMessage, 'utf8')).toBeLessThanOrEqual(
      CLIENT_DETAIL_TEXT_BYTES
    );
    expect(projectedMessage).toContain('Task Monki omitted');
    expect(projectedMessage).not.toContain('\uFFFD');
    expect(projectedMessage).toMatch(/^start-/u);
    expect(projectedMessage).toMatch(/-end$/u);
    const omitted = Number(
      projectedMessage.match(/Task Monki omitted (\d+) bytes/u)?.[1]
    );
    const marker = `\n\n[Task Monki omitted ${omitted} bytes from this display excerpt.]\n\n`;
    expect(omitted).toBe(
      Buffer.byteLength(largeText, 'utf8') -
        (Buffer.byteLength(projectedMessage, 'utf8') -
          Buffer.byteLength(marker, 'utf8'))
    );
    expect(payload.text).toContain('Task Monki omitted');
    expect(
      (projected.events[0]?.payload as { messageText: string }).messageText
    ).toContain('Task Monki omitted');
    expect(payload.nested[0]).toBe('unchanged');
    expect(run.finalMessage).toBe(largeText);
    expect(item.payload).toEqual({
      text: largeText,
      nested: ['unchanged', largeText]
    });
    expect(projected.textExcerpts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: 'runs',
          recordId: 'run-1',
          fieldPath: 'finalMessage',
          availableContent: {
            kind: 'BOUNDED_ARTIFACT',
            artifactId: 'artifact-1'
          }
        }),
        expect.objectContaining({
          collection: 'agentItems',
          recordId: 'item-1',
          fieldPath: 'payload.text',
          availableContent: { kind: 'NOT_AVAILABLE' }
        }),
        expect.objectContaining({
          collection: 'events',
          recordId: 'event-1',
          fieldPath: 'payload.messageText',
          availableContent: { kind: 'NOT_AVAILABLE' }
        })
      ])
    );
  });

  it('preserves already-bounded client content', () => {
    const run = { id: 'run-1', finalMessage: 'done' } as RunRecord;
    const item = {
      id: 'item-1',
      payload: { text: 'progress', count: 2 }
    } as AgentItemRecord;
    const detail = {
      runs: [run],
      agentItems: [item],
      events: [],
      textExcerpts: []
    } as unknown as TaskDetailSnapshot;

    const projected = projectTaskDetailForClient(detail);

    expect(projected.runs[0]).toEqual(run);
    expect(projected.agentItems[0]).not.toBe(item);
    expect(projected.agentItems[0]?.payload).toEqual(item.payload);
    expect(projected.textExcerpts).toEqual([]);
  });
});
