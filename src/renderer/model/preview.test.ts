import { describe, expect, it } from 'vitest';
import { createInitialProjection, type PreviewPlanRecord, type Task } from '../../shared/contracts';
import {
  buildPreviewPlanSummary,
  buildPreviewViewModel,
  selectPreviewActionGeneration,
  selectPreviewDiagnosticAttempts
} from './preview';

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
      plans: [], approvals: [], generations: [], attempts: []
    });
    expect(unchecked.actions[0]?.id).toBe('RESOLVE');

    const plan = {
      id: 'plan-1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1',
      recipePath: '.taskmonki/preview.yaml' as const, recipeVersion: 1 as const,
      recipeDigest: 'recipe', executionDigest: 'execution',
      executionPlan: { version: 1 as const, jobs: [], services: [], workers: [], routes: [] },
      warnings: [], createdAt: task.createdAt
    };
    const approvalRequired = buildPreviewViewModel({
      task, worktree: uncheckedWorktree(), plans: [plan], approvals: [], generations: [], attempts: []
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
      generations: [{ id: 'generation', previewKey: 'task-task1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1', planId: plan.id, approvalId: 'approval', executionDigest: plan.executionDigest, sourceGitSnapshotId: 'git', sourceHeadSha: 'head', sourceDirtyFingerprint: 'dirty', workspacePath: '/preview', state: 'READY', routingState: 'ACTIVE', freshness: 'STALE', routes: [], createdAt: task.createdAt, updatedAt: task.updatedAt }],
      attempts: []
    });
    expect(view.status).toContain('stale');
    expect(view.actions.map((action) => action.id)).toEqual(['OPEN', 'START', 'STOP']);
  });

  it('keeps the active preview actionable while a candidate is replacing it or has failed', () => {
    const plan = testPlan();
    const approval = { id: 'approval', taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest, scope: 'TASK' as const, approvedAt: task.createdAt };
    const active = { id: 'active', previewKey: 'task-task1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1', planId: plan.id, approvalId: approval.id, executionDigest: plan.executionDigest, sourceGitSnapshotId: 'git', sourceHeadSha: 'head', sourceDirtyFingerprint: 'dirty', workspacePath: '/active', state: 'READY' as const, routingState: 'ACTIVE' as const, freshness: 'CURRENT' as const, routes: [], createdAt: task.createdAt, updatedAt: task.updatedAt };
    const candidate = { ...active, id: 'candidate', workspacePath: '/candidate', state: 'WAITING_READY' as const, routingState: 'CANDIDATE' as const, replacesGenerationId: active.id, updatedAt: new Date(Date.parse(task.updatedAt) + 1).toISOString() };
    const replacing = buildPreviewViewModel({
      task, worktree: uncheckedWorktree(), plans: [plan], approvals: [approval],
      generations: [candidate, active], attempts: []
    });
    expect(replacing.status).toBe('Replacing');
    expect(replacing.activeGeneration?.id).toBe(active.id);
    expect(replacing.actions.map((action) => action.label)).toEqual(['Open current', 'Cancel replacement']);

    const failed = { ...candidate, state: 'FAILED' as const, failureReason: 'candidate failed' };
    const failedAttempt = {
      id: 'failed-attempt', taskId: task.id, generationId: failed.id, nodeId: 'web', kind: 'SERVICE' as const,
      attempt: 1, commandDigest: 'command', state: 'FAILED' as const,
      stdoutArtifactId: 'stdout', stderrArtifactId: 'stderr', endedAt: failed.updatedAt
    };
    const activeAttempt = {
      ...failedAttempt,
      id: 'active-attempt',
      generationId: active.id,
      state: 'SUCCEEDED' as const
    };
    const earlierFailedAttempt = {
      ...failedAttempt,
      id: 'earlier-failed-attempt',
      nodeId: 'api',
      endedAt: task.updatedAt
    };
    const preserved = buildPreviewViewModel({
      task, worktree: uncheckedWorktree(), plans: [plan], approvals: [approval],
      generations: [failed, active], attempts: [activeAttempt, earlierFailedAttempt, failedAttempt]
    });
    expect(preserved.status).toBe('Running');
    expect(preserved.generation?.id).toBe(active.id);
    expect(preserved.summary).toContain('candidate failed');
    expect(preserved.latestAttempt?.id).toBe(failedAttempt.id);
    expect(preserved.actions.map((action) => action.id)).toEqual(['OPEN', 'START', 'STOP']);
    expect(selectPreviewActionGeneration(preserved, 'OPEN')?.id).toBe(active.id);
    expect(selectPreviewActionGeneration(preserved, 'STOP')?.id).toBe(active.id);
    expect(
      selectPreviewDiagnosticAttempts(
        [activeAttempt, earlierFailedAttempt, failedAttempt],
        preserved
      )
    ).toEqual([earlierFailedAttempt, failedAttempt]);
  });

  it('keeps current preview controls visible while a changed plan awaits approval or replacement', () => {
    const oldPlan = testPlan();
    const active = {
      id: 'active', previewKey: 'task-task1', taskId: task.id, iterationId: 'iteration-1',
      worktreeId: 'worktree-1', planId: oldPlan.id, approvalId: 'old-approval',
      executionDigest: oldPlan.executionDigest, sourceGitSnapshotId: 'git', sourceHeadSha: 'head',
      sourceDirtyFingerprint: 'dirty', workspacePath: '/active', state: 'READY' as const,
      routingState: 'ACTIVE' as const, freshness: 'CURRENT' as const, routes: [],
      createdAt: task.createdAt, updatedAt: task.updatedAt
    };
    const changedPlan = {
      ...oldPlan,
      id: 'plan-2',
      executionDigest: 'changed-execution',
      createdAt: '2026-01-02T00:00:00.000Z'
    };
    const approvalRequired = buildPreviewViewModel({
      task, worktree: uncheckedWorktree(), plans: [changedPlan, oldPlan], approvals: [],
      generations: [active], attempts: []
    });
    expect(approvalRequired.actions.map((action) => action.id)).toEqual(['OPEN', 'APPROVE', 'STOP']);

    const approved = buildPreviewViewModel({
      task, worktree: uncheckedWorktree(), plans: [changedPlan, oldPlan],
      approvals: [{
        id: 'new-approval', taskId: task.id, planId: changedPlan.id,
        executionDigest: changedPlan.executionDigest, scope: 'TASK', approvedAt: changedPlan.createdAt
      }],
      generations: [active], attempts: []
    });
    expect(approved.actions.map((action) => action.id)).toEqual(['OPEN', 'START', 'STOP']);
    expect(approved.actions.find((action) => action.id === 'START')?.label).toBe('Replace');
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
      ready: { type: 'http', port: 'http', path: '/health', timeoutSeconds: 17 },
      critical: true,
      restart: { mode: 'never', maxRestarts: 0, backoffMs: 250 }
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
  return { id: 'plan-1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1', recipePath: '.taskmonki/preview.yaml' as const, recipeVersion: 1 as const, recipeDigest: 'recipe', executionDigest: 'execution', executionPlan: { version: 1 as const, jobs: [], services: [], workers: [], routes: [] }, warnings: [], createdAt: task.createdAt };
}
