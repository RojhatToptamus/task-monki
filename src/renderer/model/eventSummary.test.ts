import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../shared/contracts';
import { summarizeEvent } from './eventSummary';

describe('summarizeEvent', () => {
  it('converts raw event names into human-readable activity text', () => {
    expect(
      summarizeEvent(createEvent('CODEX_EVENT_PARSED', { eventType: 'turn.completed' }))
    ).toEqual({
      label: 'Codex update',
      detail: 'Codex turn completed.'
    });

    expect(
      summarizeEvent(createEvent('GITHUB_PREFLIGHT_COMPLETED', {
        owner: 'openai',
        repo: 'task-manager',
        status: 'READY'
      })).detail
    ).toContain('openai/task-manager');
  });

  it('summarizes common Codex command events without exposing raw event names', () => {
    expect(
      summarizeEvent(createEvent('CODEX_EVENT_PARSED', { eventType: 'exec_command.started' }))
    ).toEqual({
      label: 'Codex update',
      detail: 'Codex started a command.'
    });

    expect(
      summarizeEvent(createEvent('CODEX_EVENT_PARSED', { eventType: 'command.failed' }))
    ).toEqual({
      label: 'Codex update',
      detail: 'Codex command failed.'
    });
  });

  it('normalizes multiline Codex message text for the timeline', () => {
    expect(
      summarizeEvent(createEvent('CODEX_EVENT_PARSED', {
        eventType: 'turn.started',
        messageText: 'Inspecting files\n\nRunning tests'
      }))
    ).toEqual({
      label: 'Codex update',
      detail: 'Inspecting files Running tests'
    });
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
