import { describe, expect, it } from 'vitest';
import { createInitialProjection, type PreviewPlanRecord, type Task } from '../../shared/contracts';
import { buildPreviewPlanSummary, buildPreviewViewModel } from './preview';

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

  it('renders every approval authority without ambiguous argv or hidden literal values', () => {
    const plan = testPlan();
    plan.executionPlan.jobs = [
      { id: 'prepare', cwd: 'apps/web app', command: ['node', 'script with spaces.mjs', 'line\nbreak'], needs: {} }
    ];
    plan.executionPlan.services = [{
      id: 'web', cwd: '.', command: ['npm', 'run', 'dev server'], needs: {},
      env: { PUBLIC_LABEL: 'hello world', MULTILINE: 'first\nsecond' },
      ports: { http: { env: 'PORT' } },
      ready: { type: 'http', port: 'http', path: '/health', timeoutSeconds: 17 }
    }];
    plan.executionPlan.routes = [{ id: 'app', service: 'web', port: 'http', primary: true }];
    const summary = buildPreviewPlanSummary(plan);
    const text = summary.map((line) => `${line.label}: ${line.value}`).join('\n');
    expect(text).toContain('"script with spaces.mjs" "line\\nbreak"');
    expect(text).toContain('PUBLIC_LABEL="hello world"');
    expect(text).toContain('MULTILINE="first\\nsecond"');
    expect(text).toContain('PORT=<allocated high TCP port>');
    expect(text).toContain('TASK_MONKI_PREVIEW="1"');
    expect(text).toContain('HTTP 127.0.0.1:<web.http via PORT>/health · absolute deadline 17s');
    expect(text).toContain('Route · app: app → web.http · primary');
  });
});

function uncheckedWorktree() {
  return { id: 'worktree-1', taskId: task.id, iterationId: 'iteration-1', repositoryPath: '/repo', worktreePath: '/worktree', branchName: 'codex/task', baseSha: 'base', status: 'PRESENT' as const, createdAt: task.createdAt, updatedAt: task.updatedAt };
}

function testPlan(): PreviewPlanRecord {
  return { id: 'plan-1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1', recipePath: '.taskmonki/preview.yaml' as const, recipeVersion: 1 as const, recipeDigest: 'recipe', executionDigest: 'execution', executionPlan: { version: 1 as const, jobs: [], services: [], routes: [] }, warnings: [], createdAt: task.createdAt };
}
