import { describe, expect, it } from 'vitest';
import {
  createInitialProjection,
  type PreviewManagedResourceRecord,
  type PreviewPlanRecord,
  type Task
} from '../../shared/contracts';
import {
  buildPreviewPlanGroups,
  buildPreviewPlanSummary,
  buildPreviewViewModel,
  selectPreviewActionGeneration,
  selectPreviewDiagnosticAttempts,
  selectPreviewOverviewProjection,
  selectPreviewResetResources
} from './preview';

const task: Task = {
  id: 'task-1',
  title: 'Task',
  prompt: 'Prompt',
  repositoryId: 'repository-1',
  runtimeId: 'codex',
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
      worktree: { id: 'worktree-1', taskId: task.id, iterationId: 'iteration-1', repositoryId: 'repository-1', worktreePath: '/worktree', branchName: 'codex/task', baseSha: 'base', status: 'PRESENT', createdAt: task.createdAt, updatedAt: task.updatedAt },
      plans: [], approvals: [], generations: [], attempts: []
    });
    expect(unchecked.actions[0]?.id).toBe('RESOLVE');

    const missing = buildPreviewViewModel({
      task,
      worktree: uncheckedWorktree(),
      plans: [],
      approvals: [],
      generations: [],
      attempts: [],
      resolution: {
        status: 'UNAVAILABLE',
        reasonCode: 'RECIPE_MISSING',
        reason: 'No Preview recipe exists.'
      }
    });
    expect(missing).toMatchObject({
      status: 'Setup required',
      tone: 'action',
      actions: []
    });

    const configurationRequired = buildPreviewViewModel({
      task,
      worktree: uncheckedWorktree(),
      plans: [],
      approvals: [],
      generations: [],
      attempts: [],
      resolution: {
        status: 'CONFIGURATION_REQUIRED',
        reason: 'A backend target is required.',
        selectedScenarioId: 'frontend',
        requirements: []
      }
    });
    expect(configurationRequired).toMatchObject({
      status: 'Configuration required',
      tone: 'action',
      summary: 'A backend target is required.',
      actions: []
    });

    const plan = {
      id: 'plan-1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1',
      recipePath: '.taskmonki/preview.yaml' as const, recipeVersion: 1 as const,
      recipeDigest: 'recipe', executionDigest: 'execution',
      executionPlan: {
        version: 1 as const, jobs: [], resources: [], services: [], workers: [], routes: [],
        scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default'
      },
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
    expect(selectPreviewOverviewProjection(view)).toMatchObject({
      recommendedAction: { id: 'OPEN', label: 'Open preview' },
      secondaryAction: { id: 'START', label: 'Replace' },
      summary: 'Source changed after generati · still serving captured code'
    });
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
    expect(preserved.summary).toBe(
      'The current preview is still serving captured source. Its latest replacement did not reach readiness.'
    );
    expect(preserved.summary).not.toContain('candidate failed');
    expect(preserved.latestAttempt?.id).toBe(failedAttempt.id);
    expect(preserved.failedReplacementGeneration?.id).toBe(failed.id);
    expect(preserved.actions.map((action) => action.id)).toEqual(['OPEN', 'START', 'STOP']);
    expect(selectPreviewOverviewProjection(preserved)).toMatchObject({
      recommendedAction: { id: 'OPEN' },
      secondaryAction: { id: 'START' },
      summary: 'Replacement candidat failed · active is still serving'
    });
    expect(selectPreviewActionGeneration(preserved, 'OPEN')?.id).toBe(active.id);
    expect(selectPreviewActionGeneration(preserved, 'STOP')?.id).toBe(active.id);
    expect(
      selectPreviewDiagnosticAttempts(
        [activeAttempt, earlierFailedAttempt, failedAttempt],
        preserved
      )
    ).toEqual([earlierFailedAttempt, failedAttempt]);

    const cleanupCandidate = {
      ...candidate,
      state: 'CLEANUP_INCOMPLETE' as const,
      cleanupReason: 'Candidate cleanup needs another exact attempt.'
    };
    const cleanup = buildPreviewViewModel({
      task, worktree: uncheckedWorktree(), plans: [plan], approvals: [approval],
      generations: [cleanupCandidate, active], attempts: []
    });
    expect(cleanup.status).toBe('Cleanup incomplete');
    expect(cleanup.actions.map((action) => action.label)).toEqual(['Open current', 'Retry cleanup']);
    expect(selectPreviewActionGeneration(cleanup, 'OPEN')?.id).toBe(active.id);
    expect(selectPreviewActionGeneration(cleanup, 'STOP')?.id).toBe(cleanupCandidate.id);
  });

  it('does not surface a failed replacement after a later generation succeeds', () => {
    const plan = testPlan();
    const approval = {
      id: 'approval', taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
      scope: 'TASK' as const, approvedAt: task.createdAt
    };
    const previousActive = {
      id: 'previous-active', previewKey: 'task-task1', taskId: task.id,
      iterationId: 'iteration-1', worktreeId: 'worktree-1', planId: plan.id,
      approvalId: approval.id, executionDigest: plan.executionDigest,
      sourceGitSnapshotId: 'git-old', sourceHeadSha: 'old', sourceDirtyFingerprint: 'dirty-old',
      workspacePath: '/previous', state: 'STOPPED' as const, routingState: 'RETIRED' as const,
      freshness: 'STALE' as const, routes: [], createdAt: task.createdAt, updatedAt: task.updatedAt
    };
    const failedReplacement = {
      ...previousActive,
      id: 'failed-replacement',
      workspacePath: '/failed',
      state: 'FAILED' as const,
      routingState: 'CANDIDATE' as const,
      replacesGenerationId: previousActive.id,
      failureReason: 'obsolete failure',
      updatedAt: '2026-01-01T00:01:00.000Z'
    };
    const currentActive = {
      ...previousActive,
      id: 'current-active',
      sourceGitSnapshotId: 'git-current',
      sourceHeadSha: 'current',
      sourceDirtyFingerprint: 'clean',
      workspacePath: '/current',
      state: 'READY' as const,
      routingState: 'ACTIVE' as const,
      freshness: 'CURRENT' as const,
      createdAt: '2026-01-01T00:02:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
      readyAt: '2026-01-01T00:02:00.000Z'
    };
    const failedAttempt = {
      id: 'failed-attempt', taskId: task.id, generationId: failedReplacement.id,
      nodeId: 'web', kind: 'SERVICE' as const, attempt: 1, commandDigest: 'old-command',
      state: 'FAILED' as const, stdoutArtifactId: 'old-stdout', stderrArtifactId: 'old-stderr',
      endedAt: failedReplacement.updatedAt
    };
    const currentAttempt = {
      ...failedAttempt,
      id: 'current-attempt',
      generationId: currentActive.id,
      commandDigest: 'current-command',
      state: 'SUCCEEDED' as const,
      endedAt: currentActive.updatedAt
    };

    const view = buildPreviewViewModel({
      task, worktree: uncheckedWorktree(), plans: [plan], approvals: [approval],
      generations: [currentActive, failedReplacement, previousActive],
      attempts: [failedAttempt, currentAttempt]
    });

    expect(view.status).toBe('Running');
    expect(view.summary).not.toContain('obsolete failure');
    expect(view.failedReplacementGeneration).toBeUndefined();
    expect(view.latestAttempt?.id).toBe(currentAttempt.id);
    expect(selectPreviewDiagnosticAttempts([failedAttempt, currentAttempt], view))
      .toEqual([currentAttempt]);
    expect(selectPreviewOverviewProjection(view)).toMatchObject({
      recommendedAction: { id: 'OPEN' }
    });
  });

  it('projects the remaining start, failure, recovery, cleanup, and stopped states', () => {
    const plan = testPlan();
    const approval = {
      id: 'approval', taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
      scope: 'TASK' as const, approvedAt: task.createdAt
    };
    const baseGeneration = {
      id: 'generation', previewKey: 'task-task1', taskId: task.id,
      iterationId: 'iteration-1', worktreeId: 'worktree-1', planId: plan.id,
      approvalId: approval.id, executionDigest: plan.executionDigest,
      sourceGitSnapshotId: 'git', sourceHeadSha: 'head', sourceDirtyFingerprint: 'clean',
      workspacePath: '/preview', routingState: 'RETIRED' as const,
      freshness: 'CURRENT' as const, routes: [], createdAt: task.createdAt, updatedAt: task.updatedAt
    };
    const input = {
      task, worktree: uncheckedWorktree(), plans: [plan], approvals: [approval], attempts: []
    };

    expect(buildPreviewViewModel({ ...input, generations: [] }).status).toBe('Ready to start');
    for (const [state, expected] of [
      ['RUNNING_GRAPH', 'Starting'],
      ['FAILED', 'Failed'],
      ['RECOVERY_REQUIRED', 'Recovery required'],
      ['CLEANUP_INCOMPLETE', 'Cleanup incomplete'],
      ['STOPPED', 'Stopped']
    ] as const) {
      expect(buildPreviewViewModel({
        ...input,
        generations: [{ ...baseGeneration, state }]
      }).status).toBe(expected);
    }
    const stopped = buildPreviewViewModel({
      ...input,
      generations: [{ ...baseGeneration, state: 'STOPPED' }]
    });
    expect(stopped.summary).toContain('This plan had no managed data');
    expect(selectPreviewOverviewProjection(stopped).summary)
      .toBe('Nothing is running · no managed data existed');
    expect(buildPreviewViewModel({
      ...input,
      generations: [{
        ...baseGeneration,
        state: 'READY',
        routingState: 'ACTIVE',
        freshness: 'STALE'
      }]
    }).status).toBe('Running · stale');
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

  it('offers setup retry only when failed managed setup jobs explicitly declare retry safety', () => {
    const plan = testPlan();
    plan.executionPlan.jobs = [{
      id: 'migrate', cwd: '.', command: ['npm', 'run', 'migrate'], needs: {}, env: {},
      role: 'migration', retrySafe: true
    }];
    plan.executionPlan.scenarios[0].jobs = ['migrate'];
    plan.executionPlan.resources = [{
      id: 'database', type: 'postgres', image: 'postgres:17-alpine', database: 'app', limits: {}
    }];
    plan.executionPlan.scenarios[0].resources = ['database'];
    const approval = {
      id: 'approval', taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
      scope: 'TASK' as const, approvedAt: task.createdAt
    };
    const failed = {
      id: 'failed', previewKey: 'task-task1', taskId: task.id, iterationId: 'iteration-1',
      worktreeId: 'worktree-1', planId: plan.id, approvalId: approval.id,
      executionDigest: plan.executionDigest, sourceGitSnapshotId: 'git', sourceHeadSha: 'head',
      sourceDirtyFingerprint: 'dirty', workspacePath: '/failed', state: 'FAILED' as const,
      routingState: 'RETIRED' as const, freshness: 'CURRENT' as const, routes: [],
      failureReason: 'migration failed', createdAt: task.createdAt, updatedAt: task.updatedAt
    };
    const input = {
      task, worktree: uncheckedWorktree(), plans: [plan], approvals: [approval],
      generations: [failed], attempts: [{
        id: 'attempt-1', taskId: task.id, generationId: failed.id, nodeId: 'migrate',
        kind: 'JOB' as const, attempt: 1, commandDigest: 'command', state: 'FAILED' as const,
        stdoutArtifactId: 'stdout', stderrArtifactId: 'stderr', endedAt: task.updatedAt
      }], managedResources: [setupFailedResource()],
      generationAttachments: [{
        id: 'attachment-1', taskId: task.id, generationId: failed.id,
        managedResourceId: 'resource-1', logicalResourceId: 'database',
        bindingId: 'binding-1', attachedAt: task.createdAt
      }]
    };

    const view = buildPreviewViewModel(input);
    expect(view.actions).toEqual([
      { id: 'RETRY_SETUP', label: 'Retry setup', kind: 'primary' }
    ]);
    expect(selectPreviewResetResources(input, view).map((resource) => resource.id)).toEqual(['database']);
    const active = {
      ...failed, id: 'active', state: 'READY' as const, routingState: 'ACTIVE' as const,
      planId: 'previous-plan', approvalId: 'previous-approval', executionDigest: 'previous-execution',
      freshness: 'STALE' as const, failureReason: undefined
    };
    const failedCandidate = {
      ...failed, id: 'failed-candidate', routingState: 'CANDIDATE' as const,
      replacesGenerationId: active.id
    };
    const replacementInput = {
      ...input,
      generations: [failedCandidate, active],
      attempts: input.attempts.map((attempt) => ({ ...attempt, generationId: failedCandidate.id })),
      generationAttachments: input.generationAttachments.map((attachment) => ({
        ...attachment, generationId: failedCandidate.id
      }))
    };
    const replacementView = buildPreviewViewModel(replacementInput);
    expect(replacementView.actions.map((action) => action.id)).toEqual(['OPEN', 'RETRY_SETUP', 'STOP']);
    expect(replacementView.recoveryGeneration?.id).toBe(failedCandidate.id);
    expect(selectPreviewActionGeneration(replacementView, 'STOP')?.id).toBe(failedCandidate.id);
    expect(replacementView.summary).not.toContain('migration failed');
    expect(replacementView.summary).toContain('latest replacement did not reach readiness');
    expect(selectPreviewResetResources(replacementInput, replacementView).map((resource) => resource.id))
      .toEqual(['database']);

    const recoveryInput = {
      ...replacementInput,
      generations: [{ ...failedCandidate, state: 'RECOVERY_REQUIRED' as const }, active],
      managedResources: input.managedResources.map((resource) => ({
        ...resource, state: 'RECOVERY_REQUIRED' as const
      }))
    };
    const recoveryView = buildPreviewViewModel(recoveryInput);
    expect(recoveryView.status).toBe('Running · stale');
    expect(recoveryView.actions.map((action) => action.id)).toEqual(['OPEN', 'STOP']);
    expect(recoveryView.recoveryGeneration?.id).toBe(failedCandidate.id);
    expect(selectPreviewActionGeneration(recoveryView, 'STOP')?.id).toBe(failedCandidate.id);
    expect(selectPreviewResetResources(recoveryInput, recoveryView).map((resource) => resource.id))
      .toEqual(['database']);

    const unattachedFailureInput = {
      ...input,
      generationAttachments: []
    };
    const unattachedFailureView = buildPreviewViewModel(unattachedFailureInput);
    expect(unattachedFailureView.actions.map((action) => action.id)).toEqual(['STOP']);
    expect(selectPreviewResetResources(unattachedFailureInput, unattachedFailureView)).toEqual([]);
    plan.executionPlan.jobs[0].retrySafe = false;
    expect(buildPreviewViewModel(input).actions[0]?.id).toBe('STOP');
  });

  it('renders every approval authority without ambiguous argv or hidden literal values', () => {
    const plan = testPlan();
    plan.executionPlan.jobs = [
      {
        id: 'prepare', cwd: 'apps/web app',
        command: ['node', 'script with spaces.mjs', 'line\nbreak'], needs: {}, env: {},
        role: 'generic', retrySafe: false
      }
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

    const groups = buildPreviewPlanGroups(plan);
    expect(groups.map((group) => group.label)).toEqual([
      'Application',
      'Setup jobs',
      'Routes',
      'Runtime authority'
    ]);
    const groupedLines = groups.flatMap((group) => group.lines);
    expect(groupedLines).toHaveLength(summary.length);
    expect(groupedLines).toEqual(expect.arrayContaining(summary));
  });

  it('renders only sanitized Compose authority and uses structured reset-required evidence', () => {
    const plan = testPlan();
    plan.executionPlan = {
      version: 1,
      adapter: 'COMPOSE',
      compose: {
        files: ['compose.yaml'], projectDirectory: '.', profiles: ['preview'], rootServices: ['web'],
        services: [{
          id: 'web', ports: { http: { target: 3000, protocol: 'tcp' } },
          ready: { type: 'tcp', port: 'http', timeoutSeconds: 30 }
        }],
        inspection: {
          composeVersion: '2.40.0', supportsNoEnvResolution: true,
          trustDigest: 'trust', configDigest: 'config',
          hostInputs: [{ kind: 'ENV_FILE', path: 'preview.env', format: 'COMPOSE' }],
          services: [{
            id: 'web', image: 'app:latest', dependsOn: [],
            exposedPorts: [3000], environmentKeys: ['DATABASE_URL'], secretSources: ['database-password'],
            namedVolumes: [{ source: 'data', target: '/data', readOnly: false }],
            networks: ['default']
          }],
          volumes: [{ name: 'data', external: false }],
          networks: [{ name: 'default', external: false }]
        }
      },
      jobs: [], resources: [], services: [], workers: [],
      routes: [{ id: 'app', service: 'web', port: 'http', primary: true }],
      scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default'
    };
    plan.ociCapability = {
      status: 'READY', contextName: 'desktop-linux', supportsMemoryLimit: true,
      supportsCpuLimit: true, supportsPidsLimit: true,
      identity: {
        contextName: 'desktop-linux', endpointDigest: 'endpoint', engineId: 'engine',
        serverVersion: '29.6.1', apiVersion: '1.55', operatingSystem: 'linux', architecture: 'arm64'
      }
    };
    const summary = buildPreviewPlanSummary(plan).map((line) => `${line.label}: ${line.value}`).join('\n');
    expect(summary).toContain('context="desktop-linux" · engine=engine · linux/arm64');
    expect(summary).toContain('env keys=DATABASE_URL');
    expect(summary).toContain('file secrets=database-password');
    expect(summary).not.toContain('plaintext-canary');

    const approval = {
      id: 'approval', taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
      scope: 'TASK' as const, approvedAt: task.createdAt
    };
    const active = {
      id: 'active', previewKey: 'task-task1', taskId: task.id, iterationId: 'iteration-1',
      worktreeId: 'worktree-1', planId: plan.id, approvalId: approval.id,
      executionDigest: plan.executionDigest, adapter: 'COMPOSE' as const,
      sourceGitSnapshotId: 'git', sourceHeadSha: 'head', sourceDirtyFingerprint: 'dirty',
      workspacePath: '/active', state: 'READY' as const, routingState: 'ACTIVE' as const,
      freshness: 'CURRENT' as const, routes: [], createdAt: task.createdAt, updatedAt: task.updatedAt
    };
    const resetCandidate = {
      ...active, id: 'candidate', workspacePath: '/candidate',
      state: 'RECOVERY_REQUIRED' as const, routingState: 'CANDIDATE' as const,
      composeChange: 'DESTRUCTIVE_RESET_REQUIRED' as const, replacesGenerationId: active.id,
      failureReason: 'public wording may change',
      updatedAt: new Date(Date.parse(task.updatedAt) + 1).toISOString()
    };
    const view = buildPreviewViewModel({
      task, worktree: uncheckedWorktree(), plans: [plan], approvals: [approval],
      generations: [resetCandidate, active], attempts: []
    });
    expect(view.recoveryGeneration?.id).toBe(resetCandidate.id);
    expect(view.actions.map((action) => action.id)).toEqual(['OPEN', 'STOP']);
    expect(selectPreviewActionGeneration(view, 'STOP')?.id).toBe(resetCandidate.id);
  });
});

function uncheckedWorktree() {
  return { id: 'worktree-1', taskId: task.id, iterationId: 'iteration-1', repositoryId: 'repository-1', worktreePath: '/worktree', branchName: 'codex/task', baseSha: 'base', status: 'PRESENT' as const, createdAt: task.createdAt, updatedAt: task.updatedAt };
}

function testPlan(): PreviewPlanRecord {
  return { id: 'plan-1', taskId: task.id, iterationId: 'iteration-1', worktreeId: 'worktree-1', recipePath: '.taskmonki/preview.yaml' as const, recipeVersion: 1 as const, recipeDigest: 'recipe', executionDigest: 'execution', executionPlan: { version: 1 as const, jobs: [], resources: [], services: [], workers: [], routes: [], scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default' }, warnings: [], createdAt: task.createdAt };
}

function setupFailedResource(): PreviewManagedResourceRecord {
  const engine = {
    contextName: 'desktop-linux', endpointDigest: 'endpoint', engineId: 'engine',
    serverVersion: '28', apiVersion: '1.48', operatingSystem: 'linux', architecture: 'arm64'
  };
  return {
    id: 'resource-1', taskId: task.id, environmentId: 'environment-1', logicalResourceId: 'database',
    type: 'postgres', state: 'SETUP_FAILED', planDigest: 'plan', ownershipMarkerDigest: 'marker',
    container: { engine, objectId: 'container-1', objectName: 'container', labelsDigest: 'labels' },
    volume: { engine, objectId: 'volume-1', objectName: 'volume', labelsDigest: 'labels' },
    createdAt: task.createdAt, updatedAt: task.updatedAt
  };
}
