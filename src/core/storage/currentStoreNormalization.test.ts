import { describe, expect, it } from 'vitest';
import type { AgentRunMode, AgentRunStatus, WorktreeRecord } from '../../shared/contracts';
import { makeGitSnapshotRecord, makeRunRecord, makeTaskRecord, TEST_NOW } from '../../testSupport/rendererRecords';
import { createEmptyState } from '../projection/reducer';
import { normalizeLoadedState } from './currentStoreNormalization';

function reviewedAttachment() {
  const worktree: WorktreeRecord = {
    id: 'worktree-1', taskId: 'task-1', iterationId: 'iteration-1', repositoryId: 'repository-1',
    ownership: 'EXTERNAL', worktreePath: '/tmp/shared-checkout', branchName: 'feature',
    baseRef: 'main', baseSha: 'base', status: 'PRESENT', createdAt: TEST_NOW, updatedAt: TEST_NOW
  };
  const result = { schemaVersion: 'agent-review/v1' as const, verdict: 'PASSED' as const, summary: 'No findings.', findings: [] };
  const review = makeRunRecord({
    id: 'review', mode: 'REVIEW', status: 'COMPLETED', beforeGitSnapshotId: 'before',
    afterGitSnapshotId: 'after', finalMessage: JSON.stringify(result)
  });
  const task = makeTaskRecord({
    workflowPhase: 'IN_PROGRESS', currentIterationId: worktree.iterationId, currentWorktreeId: worktree.id,
    projection: { git: 'CLEAN', agentReview: { status: 'PASSED', runId: review.id, result } }
  });
  const before = makeGitSnapshotRecord({ id: 'before', headSha: 'head', branch: 'feature', baseRef: 'main', baseSha: 'base' });
  const after = { ...before, id: 'after', capturedAt: '2026-07-19T12:01:00.000Z' };
  return { ...createEmptyState(), tasks: [task], worktrees: [worktree], runs: [review], gitSnapshots: [after, before] };
}

describe('review restart normalization', () => {
  it('preserves explicit run-free In Progress after a historical review and never selects its review as primary', () => {
    const state = reviewedAttachment();
    const normal = normalizeLoadedState(state);
    expect(normal.state.tasks[0]).toMatchObject({ workflowPhase: 'IN_PROGRESS', projection: { agentRun: 'IDLE' } });
    expect(normal.state.tasks[0].currentRunId).toBeUndefined();
    expect(normal.state.tasks[0].currentAgentSessionId).toBeUndefined();
    expect(normalizeLoadedState(normal.state).changed).toBe(false);

    state.tasks[0].currentRunId = state.runs[0].id;
    state.tasks[0].currentAgentSessionId = state.runs[0].sessionId;
    const repaired = normalizeLoadedState(state).state.tasks[0];
    expect(repaired.workflowPhase).toBe('IN_PROGRESS');
    expect(repaired.currentRunId).toBeUndefined();
    expect(repaired.currentAgentSessionId).toBeUndefined();
  });

  it('does not resurrect a provider verdict when the post-review snapshot was never recorded', () => {
    const state = reviewedAttachment();
    state.runs[0].afterGitSnapshotId = undefined;
    const normalized = normalizeLoadedState(state);
    expect(normalized.state.tasks[0].projection.agentReview?.status).toBe('INCONCLUSIVE');
    expect(normalized.state.tasks[0].projection.agentReview?.result?.verdict).toBe('PASSED');
    expect(normalizeLoadedState(normalized.state).changed).toBe(false);
  });

  it.each([
    ['IMPLEMENTATION', 'FAILED'], ['IMPLEMENTATION', 'INTERRUPTED'],
    ['IMPLEMENTATION', 'RECOVERY_REQUIRED'], ['IMPLEMENTATION', 'LOST'],
    ['ANALYSIS', 'COMPLETED'], ['COMPACTION', 'COMPLETED']
  ] as Array<[AgentRunMode, AgentRunStatus]>)('preserves current %s/%s recovery guards on attached work', (mode, status) => {
    const state = reviewedAttachment();
    const current = makeRunRecord({ id: 'current', mode, status });
    state.runs.push(current);
    state.tasks[0].currentRunId = current.id;
    state.tasks[0].workflowPhase = mode === 'IMPLEMENTATION' ? 'REVIEW' : 'IN_PROGRESS';
    const normalized = normalizeLoadedState(state).state.tasks[0];
    expect(normalized.workflowPhase).toBe('IN_PROGRESS');
    expect(normalized.currentRunId).toBe(current.id);
  });
});
