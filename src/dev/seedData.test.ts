import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeAdapter } from '../core/agent/AgentRuntimeAdapter';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../core/agent/codex/codexCapabilities';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { posixModeMatches } from '../core/filesystem/secureFilesystem';
import { AppSettingsStore } from '../core/settings/AppSettingsStore';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import { FileAgentRuntimeStore } from '../core/storage/FileAgentRuntimeStore';
import { FileDiscourseStore } from '../core/storage/FileDiscourseStore';
import type { Task, TaskSnapshot } from '../shared/contracts';
import { TASK_STORE_SCHEMA_VERSION } from '../shared/contracts';
import {
  selectLatestBranchPublication,
  selectLatestCiRollup,
  selectLatestGitSnapshot,
  selectLatestMergeSnapshot,
  selectLatestPullRequest,
  selectLatestReviewRollup
} from '../renderer/model/selectors';
import { buildPrStatusViewModel } from '../renderer/model/prStatus';
import { buildRunProgressViewModel } from '../renderer/model/runProgress';
import { buildReviewActivityViewModel } from '../renderer/model/reviewActivity';
import { selectBoardTasks } from '../renderer/model/boards';
import { buildPreviewViewModel } from '../renderer/model/preview';
import {
  TASK_MONKI_DEV_SEED_VERSION,
  seedTaskMonkiDevelopmentData,
  type DevSeedManifest
} from './seedData';
import { DEV_SEED_SCENARIOS } from './seedScenarios';
import {
  DETERMINISTIC_DEV_SEED_PROVIDER_DISABLED_REASON,
  deterministicDevSeedProviderDisabledReason
} from './devSeedEnvironment';

describe('Task Monki development seed data', () => {
  let rootDir: string;
  let manifest: DevSeedManifest;
  let snapshot: TaskSnapshot;

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-dev-seed-test-'));
    manifest = await seedTaskMonkiDevelopmentData({ rootDir, reset: true });
    snapshot = await readStoreSnapshot(manifest.storeDir);
  }, 180_000);

  afterAll(async () => {
    if (rootDir) {
      await fs.rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 10 : 0,
        retryDelay: 100
      });
    }
  }, 30_000);

  it('creates a current-schema deterministic scenario catalog', async () => {
    const settings = await new AppSettingsStore(manifest.appSettingsPath).get();
    expect(manifest.catalogVersion).toBe(TASK_MONKI_DEV_SEED_VERSION);
    expect(snapshot.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(settings.firstLaunchSetupCompleted).toBe(true);
    expect(snapshot.repositories).toHaveLength(2);
    const primaryRepository = snapshot.repositories.find(
      (repository) => repository.name === path.basename(manifest.repositoryPath)
    );
    const secondaryRepository = snapshot.repositories.find(
      (repository) => repository.name === path.basename(manifest.secondaryRepositoryPath)
    );
    expect(settings.selectedRepositoryId).toBe(primaryRepository?.id);
    expect(primaryRepository?.path).toBe(await fs.realpath(manifest.repositoryPath));
    expect(secondaryRepository?.path).toBe(await fs.realpath(manifest.secondaryRepositoryPath));
    expect(secondaryRepository).toMatchObject({ status: 'AVAILABLE' });
    expect(await pathExists(manifest.manifestPath)).toBe(true);
    expect(await pathExists(manifest.envFilePath)).toBe(true);
    expect(manifest.env).toMatchObject({
      TASK_MANAGER_STORE_DIR: manifest.storeDir,
      TASK_MANAGER_APP_SETTINGS_PATH: manifest.appSettingsPath,
      TASK_MANAGER_REPO_PATH: manifest.repositoryPath,
      TASK_MANAGER_WORKTREE_ROOT: manifest.worktreeRoot,
      TASK_MANAGER_PREVIEW_ROOT: manifest.previewRoot,
      TASK_MANAGER_DISCOURSE_DIR: manifest.discourseDir,
      TASK_MANAGER_AGENT_RUNTIME_DIR: manifest.agentRuntimeDir,
      TASK_MANAGER_DISCOURSE_WORKSPACE_ROOT: manifest.discourseWorkspaceRoot,
      TASK_MANAGER_PREVIEW_RECONCILE: '0',
      TASK_MANAGER_DETERMINISTIC_SEED: '1',
      TASK_MANAGER_DEV_SEED_MODE: '1'
    });
    expect(deterministicDevSeedProviderDisabledReason(manifest.env)).toBe(
      DETERMINISTIC_DEV_SEED_PROVIDER_DISABLED_REASON
    );
    expect(posixModeMatches(await fs.stat(manifest.envFilePath), 0o600)).toBe(true);

    expect(manifest.scenarios.map((scenario) => scenario.slug)).toEqual(
      DEV_SEED_SCENARIOS.map((scenario) => scenario.slug)
    );
    expect(new Set(manifest.scenarios.map((scenario) => scenario.slug)).size).toBe(
      manifest.scenarios.length
    );

    for (const scenario of manifest.scenarios) {
      if (scenario.group === 'discourse') {
        expect(scenario.conversationId).toBeTruthy();
        const aggregate = await new FileDiscourseStore(manifest.discourseDir)
          .getConversation(scenario.conversationId!);
        expect(aggregate.conversation.title).toContain(`[seed:${scenario.slug}]`);
        continue;
      }
      const task = taskForScenario(manifest, snapshot, scenario.slug);
      expect(task.title).toContain(`[seed:${scenario.slug}]`);
    }

    expect(taskForScenario(manifest, snapshot, 'board-backlog').repositoryId).toBe(
      secondaryRepository?.id
    );
    expect(snapshot.boards.map((board) => board.name)).toEqual([
      'Review across repositories',
      'Secondary repository'
    ]);
    expect(snapshot.boards.map((board) => board.color)).toEqual(['BLUE', 'VIOLET']);
    const secondaryBoard = snapshot.boards.find(
      (board) => board.name === 'Secondary repository'
    );
    expect(secondaryBoard?.repositoryIds).toEqual([secondaryRepository?.id]);
    expect(selectBoardTasks(snapshot.tasks, secondaryBoard).map((task) => task.id)).toEqual([
      taskForScenario(manifest, snapshot, 'board-backlog').id
    ]);
  });

  it('materializes discourse running, partial, review, correction, queue, stale, and recovery states', async () => {
    const store = new FileDiscourseStore(manifest.discourseDir);
    const discourse = async (slug: string) => {
      const scenario = manifest.scenarios.find((candidate) => candidate.slug === slug)!;
      return store.getConversation(scenario.conversationId!);
    };

    await expect(discourse('discourse-team-running')).resolves.toMatchObject({
      waves: [{ policy: 'TEAM', status: 'RUNNING' }],
      jobs: [{ role: 'ANSWER', status: 'RUNNING' }]
    });
    await expect(discourse('discourse-panel-partial')).resolves.toMatchObject({
      waves: [{ policy: 'PANEL', status: 'SETTLED', outcome: 'PARTIAL' }]
    });
    const silent = await discourse('discourse-review-silent');
    expect(silent.jobs.filter((job) => job.role === 'CRITIQUE')).toMatchObject([
      { result: { outcome: 'NO_CONCERN_FOUND' } },
      { result: { outcome: 'NO_CONCERN_FOUND' } }
    ]);
    const corrected = await discourse('discourse-author-correction');
    expect(corrected.concerns).toMatchObject([{
      resolution: { outcome: 'REVISED', correctionMessageId: expect.any(String) }
    }]);
    await expect(discourse('discourse-followup-queued')).resolves.toMatchObject({
      waves: [{ status: 'RUNNING' }, { status: 'PLANNED' }]
    });
    await expect(discourse('discourse-context-stale')).resolves.toMatchObject({
      waves: [{
        status: 'PLANNED',
        dispatchGate: { status: 'RECONFIRMATION_REQUIRED' }
      }],
      jobs: [{ status: 'QUEUED', delivery: 'NOT_SENT' }]
    });
    await expect(discourse('discourse-recovery-required')).resolves.toMatchObject({
      waves: [{ status: 'RECOVERY_REQUIRED' }],
      jobs: [{ status: 'RECOVERY_REQUIRED', delivery: 'AMBIGUOUS' }]
    });
  });

  it('seeds every native preview UI state without embedding runtime logs in the snapshot', () => {
    const view = (slug: string) => {
      const task = taskForScenario(manifest, snapshot, slug);
      return buildPreviewViewModel({
        task,
        worktree: snapshot.worktrees.find((record) => record.id === task.currentWorktreeId),
        plans: snapshot.previewPlans.filter((record) => record.taskId === task.id),
        approvals: snapshot.previewApprovals.filter((record) => record.taskId === task.id),
        generations: snapshot.previewGenerations.filter((record) => record.taskId === task.id),
        attempts: snapshot.previewNodeAttempts.filter((record) => record.taskId === task.id)
      });
    };
    expect(view('preview-missing-recipe').status).toBe('Not checked');
    expect(view('preview-approval-required').status).toBe('Approval required');
    expect(view('preview-active-approval-required').actions.map((action) => action.id)).toEqual([
      'OPEN', 'APPROVE', 'STOP'
    ]);
    expect(view('preview-preparing').status).toBe('Starting');
    expect(view('preview-ready').status).toBe('Running');
    expect(view('preview-compose-ready')).toMatchObject({ status: 'Running', tone: 'success' });
    expect(view('preview-compose-recovery').summary).toContain('verified data volumes are preserved');
    expect(view('preview-replacing').status).toBe('Replacing');
    expect(view('preview-replacement-failed')).toMatchObject({ status: 'Running', tone: 'success' });
    expect(view('preview-replacement-failed').summary).toContain('latest replacement did not reach readiness');
    expect(view('preview-replacement-failed').summary).not.toContain('Candidate web service exited');
    expect(view('preview-failed').status).toBe('Failed');
    expect(view('preview-stale').status).toContain('stale');
    expect(view('preview-stopped').status).toBe('Stopped');
    expect(view('preview-recovery-required').status).toBe('Recovery required');
    expect(view('preview-cleanup-incomplete').status).toBe('Cleanup incomplete');
    expect(JSON.stringify(snapshot)).not.toContain('intentional seeded preview failure');
  });

  it('drives review, interaction, PR, and completion states from records and events', () => {
    const approvalTask = taskForScenario(manifest, snapshot, 'agent-awaiting-approval');
    expect(approvalTask.projection.agentRun).toBe('AWAITING_APPROVAL');
    expect(
      snapshot.interactionRequests.find(
        (request) => request.taskId === approvalTask.id && request.status === 'PENDING'
      )
    ).toMatchObject({ type: 'COMMAND_APPROVAL' });
    expect(
      snapshot.events.some(
        (event) => event.taskId === approvalTask.id && event.type === 'AGENT_INTERACTION_REQUESTED'
      )
    ).toBe(true);
    const approvalRun = snapshot.runs.find((run) => run.id === approvalTask.currentRunId);
    const approvalProgress = buildRunProgressViewModel({
      preferredRun: approvalRun,
      runs: snapshot.runs.filter((run) => run.taskId === approvalTask.id),
      planRevisions: snapshot.agentPlanRevisions.filter((plan) => plan.taskId === approvalTask.id),
      items: snapshot.agentItems.filter((item) => item.taskId === approvalTask.id)
    });
    expect(approvalProgress).toMatchObject({
      state: 'RUNNING',
      headerLabel: 'Current run'
    });
    expect(approvalProgress?.steps.map((step) => step.step)).toEqual([
      'Prepare interaction request',
      'Wait for user response',
      'Continue implementation'
    ]);
    expect(approvalProgress?.activityTail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'read', label: 'Read' }),
        expect.objectContaining({ category: 'edit', label: 'Edited' }),
        expect.objectContaining({ category: 'verify', label: 'Ran', detail: 'npm run typecheck' })
      ])
    );
    expect(approvalProgress?.activityTail).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'permission', label: 'Waiting' })
      ])
    );

    const runningReviewTask = taskForScenario(manifest, snapshot, 'review-running');
    const runningReviewRun = snapshot.runs.find(
      (run) => run.taskId === runningReviewTask.id && run.mode === 'REVIEW'
    );
    const runningReviewActivity = buildReviewActivityViewModel({
      reviewRun: runningReviewRun,
      reviewRunning: runningReviewTask.projection.agentReview?.status === 'RUNNING',
      useRunActivity: runningReviewTask.projection.agentReview?.status === 'RUNNING',
      items: snapshot.agentItems
    });
    expect(runningReviewActivity).toEqual({
      label: 'Searching review · src/renderer.'
    });

    const runningTask = taskForScenario(manifest, snapshot, 'agent-running');
    const runningRun = snapshot.runs.find((run) => run.id === runningTask.currentRunId);
    expect(runningRun).toMatchObject({ status: 'RUNNING' });
    const runningProgress = buildRunProgressViewModel({
      preferredRun: runningRun,
      runs: snapshot.runs.filter((run) => run.taskId === runningTask.id),
      planRevisions: snapshot.agentPlanRevisions.filter((plan) => plan.taskId === runningTask.id),
      items: snapshot.agentItems.filter((item) => item.taskId === runningTask.id)
    });
    expect(runningProgress).toMatchObject({
      state: 'RUNNING',
      headerLabel: 'Current run'
    });
    expect(runningProgress?.steps.map((step) => step.step)).toEqual([
      'Read task context',
      'Update overview progress panel',
      'Verify seeded UI state'
    ]);
    expect(runningProgress?.activityTail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'read',
          label: 'Read',
          detail: 'src/renderer/ui/TaskDetail.tsx',
          metric: '12 lines'
        }),
        expect.objectContaining({
          category: 'edit',
          label: 'Edited',
          detail: 'src/renderer/model/runProgress.ts',
          metric: '+2 -1'
        }),
        expect.objectContaining({
          category: 'verify',
          label: 'Running',
          detail: 'npm run typecheck',
          status: 'active'
        })
      ])
    );
    expect(runningProgress?.activityOutputSummary).toBe('show full output · 12 lines');

    const completedTask = taskForScenario(manifest, snapshot, 'review-not-run');
    const completedRun = snapshot.runs.find((run) => run.id === completedTask.currentRunId);
    const completedCi = selectLatestCiRollup(snapshot, completedTask);
    const completedProgress = buildRunProgressViewModel({
      preferredRun: completedRun,
      runs: snapshot.runs.filter((run) => run.taskId === completedTask.id),
      planRevisions: snapshot.agentPlanRevisions.filter((plan) => plan.taskId === completedTask.id),
      items: snapshot.agentItems.filter((item) => item.taskId === completedTask.id),
      gitSnapshot: selectLatestGitSnapshot(snapshot, completedTask),
      ciStatus: completedCi?.status ?? completedTask.projection.ciChecks
    });
    expect(completedProgress).toMatchObject({
      state: 'COMPLETED',
      headerLabel: 'Final plan',
      activityTail: [],
      footer: {
        title: 'Completed',
        detail: '1 file changed · not verified',
        tone: 'success'
      }
    });
    expect(completedProgress?.steps.map((step) => step.step)).toEqual([
      'Read task context',
      'Implement seeded change',
      'Verify local state'
    ]);

    const reviewTask = taskForScenario(manifest, snapshot, 'review-needs-changes');
    expect(reviewTask.projection.agentReview).toMatchObject({ status: 'NEEDS_CHANGES' });
    expect(
      snapshot.runs.find((run) => run.taskId === reviewTask.id && run.mode === 'REVIEW')
    ).toMatchObject({ status: 'COMPLETED' });
    expect(
      snapshot.events.some(
        (event) => event.taskId === reviewTask.id && event.type === 'AGENT_RUN_COMPLETED'
      )
    ).toBe(true);

    const staleReview = taskForScenario(manifest, snapshot, 'review-stale-after-follow-up');
    expect(staleReview.workflowPhase).toBe('REVIEW');
    expect(staleReview.projection.agentReview).toMatchObject({ status: 'STALE' });
    expect(
      snapshot.runs.find((run) => run.taskId === staleReview.id && run.mode === 'FOLLOW_UP')
    ).toMatchObject({ status: 'COMPLETED' });

    const activeFollowUp = taskForScenario(manifest, snapshot, 'review-follow-up-active');
    expect(activeFollowUp.workflowPhase).toBe('IN_PROGRESS');
    expect(activeFollowUp.projection.agentRun).toBe('RUNNING');
    expect(activeFollowUp.projection.agentReview).toMatchObject({ status: 'STALE' });

    const failedChecks = prView(snapshot, taskForScenario(manifest, snapshot, 'delivery-checks-failed'));
    expect(failedChecks).toMatchObject({
      kind: 'CHECKS_FAILED',
      canInvestigateFailure: true
    });
    expect(failedChecks.checkGroups[0]).toMatchObject({ status: 'failed' });
    const failedChecksTask = taskForScenario(manifest, snapshot, 'delivery-checks-failed');
    expect(snapshot.ciRollups.find((rollup) => rollup.taskId === failedChecksTask.id)).toMatchObject({
      status: 'FAILING'
    });
    expect(
      snapshot.events.some(
        (event) => event.taskId === failedChecksTask.id && event.type === 'CI_ROLLUP_CAPTURED'
      )
    ).toBe(true);

    expect(
      prView(snapshot, taskForScenario(manifest, snapshot, 'delivery-ready-to-merge')).kind
    ).toBe('READY_TO_MERGE');
    expect(
      prView(snapshot, taskForScenario(manifest, snapshot, 'delivery-local-not-pushed')).kind
    ).toBe('LOCAL_NOT_PUSHED');
    expect(
      prView(snapshot, taskForScenario(manifest, snapshot, 'delivery-pr-newer-commits')).kind
    ).toBe('PR_NEWER_COMMITS');
    expect(
      prView(snapshot, taskForScenario(manifest, snapshot, 'delivery-branch-diverged')).kind
    ).toBe('BRANCH_DIVERGED');
    expect(prView(snapshot, taskForScenario(manifest, snapshot, 'no-pr-conflicted'))).toMatchObject({
      kind: 'NO_PR',
      createDraftPrDisabledReason: 'Resolve Git conflicts before opening a PR.'
    });
    expect(
      prView(snapshot, taskForScenario(manifest, snapshot, 'no-pr-publish-in-progress'))
    ).toMatchObject({
      kind: 'NO_PR',
      createDraftPrDisabledReason: 'Branch publication is already in progress.'
    });

    const pendingChecksTask = taskForScenario(manifest, snapshot, 'delivery-checks-pending');
    expect(snapshot.ciRollups.find((rollup) => rollup.taskId === pendingChecksTask.id)).toMatchObject({
      totalCount: 3,
      pendingCount: 2,
      passingCount: 1
    });
    expect(snapshot.ciRollups.find((rollup) => rollup.taskId === failedChecksTask.id)).toMatchObject({
      totalCount: 3,
      failingCount: 1,
      passingCount: 2
    });

    const verifiedFailing = taskForScenario(
      manifest,
      snapshot,
      'completion-merged-and-verified-failing'
    );
    expect(verifiedFailing.completionPolicy).toBe('MERGED_AND_VERIFIED');
    expect(verifiedFailing.workflowPhase).not.toBe('DONE');
    expect(verifiedFailing.projection).toMatchObject({ merge: 'MERGED', ciChecks: 'FAILING' });

    const verifiedPassing = taskForScenario(
      manifest,
      snapshot,
      'completion-merged-and-verified-passing'
    );
    expect(verifiedPassing.completionPolicy).toBe('MERGED_AND_VERIFIED');
    expect(verifiedPassing.workflowPhase).toBe('DONE');

    const manualMerged = taskForScenario(manifest, snapshot, 'completion-manual-merged');
    expect(manualMerged.completionPolicy).toBe('MANUAL');
    expect(manualMerged.workflowPhase).not.toBe('DONE');
  });

  it('preserves every seeded scenario during provider-inert restricted initialization', async () => {
    const store = new FileTaskStore(manifest.storeDir);
    const before = await store.snapshot();
    const initialize = vi.fn(async () => undefined);
    const adapter = {
      descriptor: CODEX_RUNTIME_DESCRIPTOR,
      initialize,
      capabilities: vi.fn(async () => codexCapabilities()),
      shutdown: vi.fn(async () => undefined)
    } as unknown as AgentRuntimeAdapter;
    const disabledReason =
      'Codex is disabled while deterministic development seed scenarios are loaded.';
    const service = new TaskManagerService(store, manifest.repositoryPath, undefined, {
      appSettingsStore: new AppSettingsStore(manifest.appSettingsPath),
      agentRuntimeAdapters: [adapter],
      agentRuntimeStore: new FileAgentRuntimeStore(manifest.agentRuntimeDir),
      discourseStore: new FileDiscourseStore(manifest.discourseDir),
      discourseWorkspaceRoot: manifest.discourseWorkspaceRoot,
      allowAgentNetworkAccess: false,
      agentProviderStartupDisabledReason: disabledReason,
      codexPath: path.join(rootDir, 'missing-codex')
    });

    await service.init();
    try {
      const after = await store.snapshot();
      expect(initialize).not.toHaveBeenCalled();
      await expect(service.getAgentRuntimeCatalog()).resolves.toMatchObject({
        runtimes: [
          {
            preflight: {
              readiness: {
                status: 'DISABLED',
                canStart: false,
                detail: disabledReason
              }
            },
            models: []
          }
        ],
        models: []
      });
      expect(seedLifecycleSnapshot(after)).toEqual(seedLifecycleSnapshot(before));
      expect({
        tasks: after.tasks.length,
        runs: after.runs.length,
        worktrees: after.worktrees.length,
        events: after.events.length
      }).toEqual({
        tasks: manifest.counts.tasks,
        runs: manifest.counts.runs,
        worktrees: manifest.counts.worktrees,
        events: manifest.counts.events
      });
      for (const run of after.runs) {
        expect(run.requestedSettings).toMatchObject({
          sandbox: 'WORKSPACE_WRITE',
          networkAccess: false,
          approvalPolicy: 'never',
          approvalsReviewer: 'user'
        });
      }

      const readyTask = taskForScenario(manifest, after, 'board-ready');
      await expect(service.startRun({ taskId: readyTask.id })).rejects.toThrow(
        disabledReason
      );
      const runningTask = taskForScenario(manifest, after, 'agent-running');
      await expect(
        service.cancelRun({ runId: runningTask.currentRunId! })
      ).rejects.toThrow(disabledReason);
      await expect(
        service.refinePrompt({
          repositoryId: before.repositories[0]!.id,
          input: 'Do not start Codex from fixture mode.'
        })
      ).rejects.toThrow(disabledReason);
      expect(seedLifecycleSnapshot(await store.snapshot())).toEqual(
        seedLifecycleSnapshot(before)
      );
    } finally {
      await service.shutdown();
    }
  });

  it('refuses to reset non-seed-owned non-empty directories', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-dev-seed-safety-'));
    try {
      await fs.writeFile(path.join(rootDir, 'user-file.txt'), 'not seed data', 'utf8');

      await expect(seedTaskMonkiDevelopmentData({ rootDir, reset: true })).rejects.toThrow(
        'not marked as Task Monki seed-owned data'
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

function seedLifecycleSnapshot(snapshot: TaskSnapshot) {
  return {
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      currentRunId: task.currentRunId,
      projection: task.projection
    })),
    runs: snapshot.runs.map((run) => ({
      id: run.id,
      status: run.status,
      recoveryState: run.recoveryState,
      terminalReason: run.terminalReason
    })),
    sessions: snapshot.agentSessions.map((session) => ({
      id: session.id,
      status: session.status,
      requestedSettings: session.requestedSettings,
      observedSettings: session.observedSettings
    })),
    interactions: snapshot.interactionRequests.map((interaction) => ({
      id: interaction.id,
      status: interaction.status,
      resolution: interaction.resolution
    })),
    counts: {
      tasks: snapshot.tasks.length,
      runs: snapshot.runs.length,
      worktrees: snapshot.worktrees.length,
      events: snapshot.events.length,
      sessions: snapshot.agentSessions.length,
      interactions: snapshot.interactionRequests.length,
      servers: snapshot.agentServers.length
    }
  };
}

function taskForScenario(manifest: DevSeedManifest, snapshot: TaskSnapshot, slug: string): Task {
  const scenario = manifest.scenarios.find((candidate) => candidate.slug === slug);
  if (!scenario) {
    throw new Error(`Scenario not found: ${slug}`);
  }
  const task = snapshot.tasks.find((candidate) => candidate.id === scenario.taskId);
  if (!task) {
    throw new Error(`Task not found for scenario: ${slug}`);
  }
  return task;
}

function prView(snapshot: TaskSnapshot, task: Task) {
  return buildPrStatusViewModel({
    task,
    gitSnapshot: selectLatestGitSnapshot(snapshot, task),
    branchPublication: selectLatestBranchPublication(snapshot, task),
    pullRequest: selectLatestPullRequest(snapshot, task),
    ciRollup: selectLatestCiRollup(snapshot, task),
    reviewRollup: selectLatestReviewRollup(snapshot, task),
    mergeSnapshot: selectLatestMergeSnapshot(snapshot, task)
  });
}

async function readStoreSnapshot(storeDir: string): Promise<TaskSnapshot> {
  const store = new FileTaskStore(storeDir);
  try {
    return await store.snapshot();
  } finally {
    await store.close();
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
