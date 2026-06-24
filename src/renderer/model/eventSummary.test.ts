import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../shared/contracts';
import { summarizeEvent } from './eventSummary';

describe('summarizeEvent', () => {
  it('converts raw event names into human-readable activity text', () => {
    expect(
      summarizeEvent(createEvent('AGENT_ACTIVITY_RECEIVED', { eventType: 'turn.completed' }))
    ).toEqual({
      label: 'Agent update',
      detail: 'Agent turn completed.'
    });

    expect(
      summarizeEvent(createEvent('GITHUB_PREFLIGHT_COMPLETED', {
        owner: 'openai',
        repo: 'task-manager',
        status: 'READY'
      })).detail
    ).toContain('openai/task-manager');
  });

  it('summarizes draft PR evidence as the delivery event', () => {
    expect(
      summarizeEvent(createEvent('PR_SNAPSHOT_CAPTURED', {
        number: 12,
        status: 'OPEN_DRAFT'
      }))
    ).toEqual({
      label: 'Pull request synced',
      detail: 'PR #12 OPEN_DRAFT.'
    });
  });

  it('summarizes interactive approval lifecycle events', () => {
    expect(
      summarizeEvent(
        createEvent('AGENT_INTERACTION_REQUESTED', {
          type: 'COMMAND_APPROVAL'
        })
      )
    ).toEqual({
      label: 'Approval requested',
      detail: 'COMMAND_APPROVAL is waiting for review.'
    });
    expect(
      summarizeEvent(
        createEvent('AGENT_INTERACTION_RESOLVED', {
          status: 'DECLINED'
        })
    ).detail
    ).toBe('DECLINED');
  });

  it('labels rich provider observations explicitly', () => {
    expect(
      summarizeEvent(
        createEvent('AGENT_PLAN_REVISED', { revision: 2, stepCount: 3 })
      )
    ).toEqual({
      label: 'Provider plan revised',
      detail: 'Revision 2, 3 steps.'
    });
    expect(
      summarizeEvent(
        createEvent('AGENT_USAGE_UPDATED', { totalTokens: 1234 })
      ).detail
    ).toContain('1,234');
  });

  it('surfaces observed and contradictory subagent relationships', () => {
    expect(
      summarizeEvent(
        createEvent('AGENT_SUBAGENT_DISCOVERED', {
          providerChildSessionId: 'thread-child',
          source: 'COLLAB_RECEIVER'
        })
      )
    ).toEqual({
      label: 'Subagent discovered',
      detail: 'thread-child · COLLAB_RECEIVER'
    });
    expect(
      summarizeEvent(
        createEvent('AGENT_SUBAGENT_RELATIONSHIP_UNRESOLVED', {
          detail: 'Child already has another parent.'
        })
      ).detail
    ).toContain('another parent');
  });
});

function createEvent(type: DomainEvent['type'], payload: unknown): DomainEvent {
  const now = '2026-06-20T10:00:00.000Z';
  return {
    id: `event-${type}`,
    type,
    taskId: 'task-1',
    source: 'github',
    sourceEventId: `source-${type}`,
    occurredAt: now,
    receivedAt: now,
    payload
  };
}
