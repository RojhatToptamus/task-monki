import { describe, expect, it } from 'vitest';
import { createInitialProjection, type Task } from '../../shared/contracts';
import { buildPreviewViewModel } from './preview';

const task: Task = {
  id: 'task-1',
  title: 'Task',
  prompt: 'Prompt',
  repositoryPath: '/repo',
  workflowPhase: 'REVIEW',
  resolution: 'NONE',
  completionPolicy: 'LOCAL_ACCEPTANCE',
  phaseVersion: 1,
  currentIterationId: 'iteration-1',
  currentWorktreeId: 'worktree-1',
  forkedAlternativeTaskIds: [],
  agentSettings: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  projection: createInitialProjection('2026-01-01T00:00:00.000Z')
};

describe('preview view model', () => {
  it('keeps resolve and approval distinct from execution', () => {
    const unchecked = buildPreviewViewModel({
      task,
      worktree: { id: 'worktree-1', taskId: task.id, iterationId: 'iteration-1', repositoryPath: '/repo', worktreePath: '/worktree', branchName: 'codex/task', baseSha: 'base', status: 'PRESENT', createdAt: task.createdAt, updatedAt: task.updatedAt },
      plans: [], approvals: [], generations: [], attempts: [], resources: []
    });
    expect(unchecked.actions[0]?.id).toBe('RESOLVE');

    const plan = {
      id: 'plan-1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1',
      recipePath: '.taskmonki/preview.yaml' as const, recipeVersion: 1 as const,
      recipeDigest: 'recipe', executionDigest: 'execution',
      executionPlan: { version: 1 as const, jobs: [], services: [], routes: [] },
      warnings: [], createdAt: task.createdAt
    };
    const approvalRequired = buildPreviewViewModel({
      task, worktree: uncheckedWorktree(), plans: [plan], approvals: [], generations: [], attempts: [], resources: []
    });
    expect(approvalRequired.actions[0]?.id).toBe('APPROVE');
  });

  it('shows stale running source honestly while preserving open and stop actions', () => {
    const plan = testPlan();
    const view = buildPreviewViewModel({
      task,
      worktree: uncheckedWorktree(),
      plans: [plan],
      approvals: [{ id: 'approval', taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest, scope: 'TASK', approvedAt: task.createdAt }],
      generations: [{ id: 'generation', previewKey: 'task-task1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1', planId: plan.id, approvalId: 'approval', executionDigest: plan.executionDigest, sourceGitSnapshotId: 'git', sourceHeadSha: 'head', sourceDirtyFingerprint: 'dirty', workspacePath: '/preview', state: 'READY', freshness: 'STALE', routes: [], createdAt: task.createdAt, updatedAt: task.updatedAt }],
      attempts: [], resources: []
    });
    expect(view.status).toContain('stale');
    expect(view.actions.map((action) => action.id)).toEqual(['OPEN', 'STOP']);
  });
});

function uncheckedWorktree() {
  return { id: 'worktree-1', taskId: task.id, iterationId: 'iteration-1', repositoryPath: '/repo', worktreePath: '/worktree', branchName: 'codex/task', baseSha: 'base', status: 'PRESENT' as const, createdAt: task.createdAt, updatedAt: task.updatedAt };
}

function testPlan() {
  return { id: 'plan-1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1', recipePath: '.taskmonki/preview.yaml' as const, recipeVersion: 1 as const, recipeDigest: 'recipe', executionDigest: 'execution', executionPlan: { version: 1 as const, jobs: [], services: [], routes: [] }, warnings: [], createdAt: task.createdAt };
}
