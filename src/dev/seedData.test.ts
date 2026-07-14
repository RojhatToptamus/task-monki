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
import { AppSettingsStore } from '../core/settings/AppSettingsStore';
import { FileTaskStore } from '../core/storage/FileTaskStore';
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
import {
  DEV_SEED_SCENARIOS,
  TASK_MONKI_DEV_SEED_VERSION,
  seedTaskMonkiDevelopmentData,
  type DevSeedManifest
} from './seedData';

describe('Task Monki development seed data', () => {
  let rootDir: string;
  let manifest: DevSeedManifest;
  let snapshot: TaskSnapshot;

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-dev-seed-test-'));
    manifest = await seedTaskMonkiDevelopmentData({ rootDir, reset: true });
    snapshot = await new FileTaskStore(manifest.storeDir).snapshot();
  }, 90_000);

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
    expect(settings.repositories.selectedPath).toBe(manifest.repositoryPath);
    expect(settings.repositories.knownPaths).toContain(manifest.repositoryPath);
    expect(await pathExists(manifest.manifestPath)).toBe(true);
    expect(await pathExists(manifest.envFilePath)).toBe(true);
    expect(manifest.env).toMatchObject({
      TASK_MANAGER_STORE_DIR: manifest.storeDir,
      TASK_MANAGER_APP_SETTINGS_PATH: manifest.appSettingsPath,
      TASK_MANAGER_REPO_PATH: manifest.repositoryPath,
      TASK_MANAGER_WORKTREE_ROOT: manifest.worktreeRoot,
      TASK_MANAGER_DEV_SEED_MODE: '1'
    });

    expect(manifest.scenarios.map((scenario) => scenario.slug)).toEqual(
      DEV_SEED_SCENARIOS.map((scenario) => scenario.slug)
    );
    expect(new Set(manifest.scenarios.map((scenario) => scenario.slug)).size).toBe(
      manifest.scenarios.length
    );

    for (const scenario of manifest.scenarios) {
      const task = taskForScenario(manifest, snapshot, scenario.slug);
      expect(task.title).toContain(`[seed:${scenario.slug}]`);
    }
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
        expect.objectContaining({ category: 'verify', label: 'Ran', detail: 'npm run typecheck' }),
        expect.objectContaining({ category: 'permission', label: 'Waiting', detail: 'for approval' })
      ])
    );

    const runningReviewTask = taskForScenario(manifest, snapshot, 'review-running');
    const runningReviewRun = snapshot.runs.find(
      (run) => run.taskId === runningReviewTask.id && run.mode === 'REVIEW'
    );
    const runningReviewActivity = buildReviewActivityViewModel({
      reviewRun: runningReviewRun,
      reviewRunning: runningReviewTask.projection.codexReview?.status === 'RUNNING',
      useRunActivity: runningReviewTask.projection.codexReview?.status === 'RUNNING',
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
    expect(reviewTask.projection.codexReview).toMatchObject({ status: 'NEEDS_CHANGES' });
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
    expect(staleReview.projection.codexReview).toMatchObject({ status: 'STALE' });
    expect(
      snapshot.runs.find((run) => run.taskId === staleReview.id && run.mode === 'FOLLOW_UP')
    ).toMatchObject({ status: 'COMPLETED' });

    const activeFollowUp = taskForScenario(manifest, snapshot, 'review-follow-up-active');
    expect(activeFollowUp.workflowPhase).toBe('IN_PROGRESS');
    expect(activeFollowUp.projection.agentRun).toBe('RUNNING');
    expect(activeFollowUp.projection.codexReview).toMatchObject({ status: 'STALE' });

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
      agentProviderAdapter: adapter,
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
            preflight: { ready: false, problems: [disabledReason] },
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
          repositoryPath: manifest.repositoryPath,
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
