import { describe, expect, it } from 'vitest';
import { createInitialProjection, type Task } from '../../shared/contracts';
import { createEmptyState } from '../projection/reducer';
import { selectRepositoryImpact } from './repositoryImpact';

describe('selectRepositoryImpact', () => {
  it('counts durable repository relationships and only the latest open PR state', () => {
    const task = taskFixture();
    const snapshot = {
      ...createEmptyState(),
      tasks: [task],
      worktrees: [
        {
          id: 'worktree-1',
          taskId: task.id,
          iterationId: 'iteration-1',
          repositoryId: task.repositoryId,
          worktreePath: '/tmp/worktree',
          branchName: 'codex/task',
          baseSha: 'base',
          status: 'PRESENT' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      pullRequests: [
        {
          id: 'pr-open',
          taskId: task.id,
          iterationId: 'iteration-1',
          worktreeId: 'worktree-1',
          status: 'OPEN_READY' as const,
          observedAt: '2026-01-01T00:00:00.000Z'
        },
        {
          id: 'pr-merged',
          taskId: task.id,
          iterationId: 'iteration-1',
          worktreeId: 'worktree-1',
          status: 'MERGED' as const,
          observedAt: '2026-01-02T00:00:00.000Z'
        }
      ]
    };

    expect(selectRepositoryImpact(snapshot, task.repositoryId)).toEqual({
      repositoryId: task.repositoryId,
      taskCount: 1,
      activeRunCount: 0,
      worktreeCount: 1,
      openPullRequestCount: 0,
      blockingReason: undefined
    });
  });
});

function taskFixture(): Task {
  return {
    id: 'task-1',
    title: 'Task',
    prompt: 'Do it.',
    repositoryId: 'repository-1',
    runtimeId: 'codex',
    workflowPhase: 'REVIEW',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    projection: createInitialProjection('2026-01-01T00:00:00.000Z')
  };
}
