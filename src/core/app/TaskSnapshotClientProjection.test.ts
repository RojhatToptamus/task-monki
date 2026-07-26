import { describe, expect, it } from 'vitest';
import type {
  AgentItemRecord,
  RunRecord,
  TaskSnapshot
} from '../../shared/contracts';
import {
  CLIENT_SNAPSHOT_TEXT_BYTES,
  projectTaskSnapshotForClient
} from './TaskSnapshotClientProjection';

describe('projectTaskSnapshotForClient', () => {
  it('bounds large provider text without mutating durable snapshot records', () => {
    const largeText = `start-${'🙂'.repeat(CLIENT_SNAPSHOT_TEXT_BYTES)}-end`;
    const run = {
      id: 'run-1',
      finalMessage: largeText
    } as RunRecord;
    const item = {
      id: 'item-1',
      payload: {
        text: largeText,
        nested: ['unchanged', largeText]
      }
    } as AgentItemRecord;
    const snapshot = {
      runs: [run],
      agentItems: [item]
    } as TaskSnapshot;

    const projected = projectTaskSnapshotForClient(snapshot);
    const projectedMessage = projected.runs[0]?.finalMessage ?? '';
    const payload = projected.agentItems[0]?.payload as {
      text: string;
      nested: string[];
    };

    expect(Buffer.byteLength(projectedMessage, 'utf8')).toBeLessThanOrEqual(
      CLIENT_SNAPSHOT_TEXT_BYTES
    );
    expect(projectedMessage).toContain('Task Monki bounded');
    expect(projectedMessage).toMatch(/^start-/u);
    expect(projectedMessage).toMatch(/-end$/u);
    expect(payload.text).toContain('Task Monki bounded');
    expect(payload.nested[0]).toBe('unchanged');
    expect(run.finalMessage).toBe(largeText);
    expect(item.payload).toEqual({
      text: largeText,
      nested: ['unchanged', largeText]
    });
  });

  it('preserves already-bounded client content', () => {
    const run = { id: 'run-1', finalMessage: 'done' } as RunRecord;
    const item = {
      id: 'item-1',
      payload: { text: 'progress', count: 2 }
    } as AgentItemRecord;
    const snapshot = {
      runs: [run],
      agentItems: [item]
    } as TaskSnapshot;

    const projected = projectTaskSnapshotForClient(snapshot);

    expect(projected.runs[0]).toEqual(run);
    expect(projected.agentItems[0]).not.toBe(item);
    expect(projected.agentItems[0]?.payload).toEqual(item.payload);
  });
});
