import { describe, expect, it } from 'vitest';
import type { AgentGoalSnapshotRecord, Finding } from '../../shared/contracts';
import {
  describeHealthFinding,
  shouldShowProviderGoalDiagnostics
} from './debugDiagnostics';

const observedAt = '2026-06-24T10:00:00.000Z';

describe('debug diagnostics model', () => {
  it('uses product-facing labels for noisy runtime finding codes', () => {
    const view = describeHealthFinding(finding('AGENT_MUTATION_AMBIGUOUS'));

    expect(view.title).toBe('Delivery status uncertain');
    expect(view.detail).toBe('Codex App Server mutation timed out after submission.');
    expect(view.meta).not.toContain('AGENT_MUTATION_AMBIGUOUS');
  });

  it('handles malformed finding timestamps without leaking invalid dates', () => {
    const view = describeHealthFinding({
      ...finding('PROCESS_NON_ZERO_EXIT'),
      createdAt: 'not-a-date'
    });

    expect(view.title).toBe('Runtime exited unexpectedly');
    expect(view.meta).toBe('unknown time');
  });

  it('has product-facing titles for current task health finding codes', () => {
    const titles = new Map(
      [
        'AGENT_PROTOCOL_INCIDENT',
        'AGENT_MUTATION_AMBIGUOUS',
        'AGENT_REVIEW_CHANGED_GIT',
        'PROCESS_NON_ZERO_EXIT',
        'PROCESS_EXITED_WITHOUT_AGENT_TERMINAL_EVENT',
        'WORKTREE_OPERATION_FAILED',
        'WORKFLOW_TRANSITION_BLOCKED',
        'LOCAL_TESTS_NOT_PASSING',
        'GITHUB_PREFLIGHT_NOT_READY',
        'BRANCH_PUBLISH_FAILED',
        'PR_CLOSED_WITHOUT_MERGE'
      ].map((code) => [code, describeHealthFinding(finding(code)).title])
    );

    expect(titles).toEqual(
      new Map([
        ['AGENT_PROTOCOL_INCIDENT', 'Provider protocol issue'],
        ['AGENT_MUTATION_AMBIGUOUS', 'Delivery status uncertain'],
        ['AGENT_REVIEW_CHANGED_GIT', 'Review changed files'],
        ['PROCESS_NON_ZERO_EXIT', 'Runtime exited unexpectedly'],
        [
          'PROCESS_EXITED_WITHOUT_AGENT_TERMINAL_EVENT',
          'Runtime stopped before the run finished'
        ],
        ['WORKTREE_OPERATION_FAILED', 'Worktree operation failed'],
        ['WORKFLOW_TRANSITION_BLOCKED', 'Workflow transition blocked'],
        ['LOCAL_TESTS_NOT_PASSING', 'Local tests need attention'],
        ['GITHUB_PREFLIGHT_NOT_READY', 'GitHub setup needs attention'],
        ['BRANCH_PUBLISH_FAILED', 'Branch publish failed'],
        ['PR_CLOSED_WITHOUT_MERGE', 'Pull request closed without merge']
      ])
    );
  });

  it('hides provider goal diagnostics when the provider goal is already synced', () => {
    expect(shouldShowProviderGoalDiagnostics(goal({ syncState: 'IN_SYNC' }), true)).toBe(false);
    expect(shouldShowProviderGoalDiagnostics(goal({ syncState: 'DIVERGED' }), true)).toBe(true);
    expect(
      shouldShowProviderGoalDiagnostics(goal({ syncState: 'IN_SYNC', detail: 'Sync lagged.' }), true)
    ).toBe(true);
    expect(shouldShowProviderGoalDiagnostics(undefined, true)).toBe(false);
    expect(shouldShowProviderGoalDiagnostics(goal({ syncState: 'DIVERGED' }), false)).toBe(false);
  });
});

function finding(code: string): Finding {
  return {
    id: `${code}:1`,
    code,
    severity: 'WARNING',
    message: 'Codex App Server mutation timed out after submission.',
    createdAt: observedAt
  };
}

function goal(
  input: Pick<AgentGoalSnapshotRecord, 'syncState'> & Partial<AgentGoalSnapshotRecord>
): AgentGoalSnapshotRecord {
  return {
    ...input,
    id: 'goal-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    sessionId: 'session-1',
    provider: 'codex',
    taskGoalHash: 'hash-1',
    syncState: input.syncState,
    source: input.source ?? 'PROVIDER_NOTIFICATION',
    observedAt: input.observedAt ?? observedAt
  };
}
