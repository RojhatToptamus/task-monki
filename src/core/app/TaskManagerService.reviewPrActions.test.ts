import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../shared/contracts';
import {
  createTaskMonkiScenario,
  type TaskMonkiScenario
} from '../../testSupport/taskMonkiScenario';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import { createDomainEvent } from '../storage/domainEvent';

describe('TaskManagerService review and PR action coordination', () => {
  it('rejects review for a failed implementation and keeps retry recovery in progress', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-failed-run-review-guard'
    });
    const task = await scenario.createTask({
      title: 'Failed implementation',
      prompt: 'Fail before implementation completes.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });

    await scenario.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_FAILED',
        taskId: task.id,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        source: 'provider',
        payload: { error: 'Provider rejected the turn.' }
      })
    );

    await expect(
      scenario.service.startReview({ taskId: task.id, runId: run.id })
    ).rejects.toThrow(
      'A review requires a successfully completed implementation run. Retry or continue this run first.'
    );
    expect((await scenario.store.getTask(task.id))?.workflowPhase).toBe('IN_PROGRESS');
    expect(scenario.agent.startedReviews).toHaveLength(0);
  });

  it('rejects a completed analysis run as a review source', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-analysis-review-guard'
    });
    const task = await scenario.createTask({
      title: 'Read-only analysis',
      prompt: 'Inspect without changing the worktree.'
    });
    const run = await scenario.service.startRun({ taskId: task.id, mode: 'ANALYSIS' });

    await scenario.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: task.id,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        source: 'provider',
        payload: { terminalStatus: 'completed' }
      })
    );

    await expect(
      scenario.service.startReview({ taskId: task.id, runId: run.id })
    ).rejects.toThrow(
      'A review requires a successfully completed implementation run. Retry or continue this run first.'
    );
    expect((await scenario.store.getTask(task.id))?.workflowPhase).toBe('IN_PROGRESS');
    expect(scenario.agent.startedReviews).toHaveLength(0);
  });

  it.each(['ANALYSIS', 'COMPACTION'] as const)(
    'keeps a historical review contextual after a completed %s run',
    async (mode) => {
      const scenario = await createTaskMonkiScenario({
        name: `task-monki-historical-review-${mode.toLowerCase()}`
      });
      const task = await scenario.createTask({
        title: 'Historical review context',
        prompt: 'Implement, review, then perform newer non-implementation work.'
      });
      const implementation = await scenario.service.startRun({ taskId: task.id });
      await scenario.completeRun(implementation.id, 'Implementation finished.');

      const historicalReview = await scenario.service.startReview({
        taskId: task.id,
        runId: implementation.id
      });
      await scenario.completeRun(historicalReview.id, 'The historical review passed.');

      const current = await scenario.service.startRun({ taskId: task.id, mode });
      await scenario.completeRun(current.id, `${mode} finished.`);

      const currentTask = await scenario.store.getTask(task.id);
      expect(currentTask).toMatchObject({
        currentRunId: current.id,
        workflowPhase: 'IN_PROGRESS',
        projection: {
          codexReview: {
            runId: historicalReview.id,
            sourceRunId: implementation.id,
            status: 'STALE'
          }
        }
      });

      await expect(
        scenario.service.startReview({ taskId: task.id, runId: implementation.id })
      ).rejects.toThrow(
        'A review requires a successfully completed implementation run. Retry or continue this run first.'
      );
      await expect(
        scenario.service.startReview({ taskId: task.id, runId: current.id })
      ).rejects.toThrow(
        'A review requires a successfully completed implementation run. Retry or continue this run first.'
      );
      expect(scenario.agent.startedReviews).toHaveLength(1);
    }
  );

  it('makes review and PR actions deterministic around a running review', async () => {
    const ghPath = await writeFakeGh();
    const scenario = await createScenarioWithCompletedRun(
      'task-monki-review-pr-actions',
      ghPath
    );
    await recordPullRequestForRun(scenario.serviceHarness, scenario.taskId, scenario.run);

    const refreshBeforeReview = scenario.service.refreshGitHub({ taskId: scenario.taskId });
    await expect(
      scenario.service.startReview({ taskId: scenario.taskId, runId: scenario.run.id })
    ).rejects.toThrow('GitHub refresh is already running for this task.');
    await expect(refreshBeforeReview).resolves.toMatchObject({
      number: 82,
      headRefOid: 'fresh-head',
      status: 'OPEN_READY'
    });

    const first = scenario.service.startReview({
      taskId: scenario.taskId,
      runId: scenario.run.id
    });
    const second = scenario.service.startReview({
      taskId: scenario.taskId,
      runId: scenario.run.id
    });

    await expect(second).rejects.toThrow(/Agent review .*running|Wait for the agent review/);
    await expect(first).resolves.toMatchObject({
      taskId: scenario.taskId,
      mode: 'REVIEW',
      status: 'RUNNING'
    });
    const snapshotAfterStart = await scenario.serviceHarness.store.snapshot();
    const review = snapshotAfterStart.runs.find(
      (candidate) => candidate.taskId === scenario.taskId && candidate.mode === 'REVIEW'
    );
    expect(review).toBeDefined();

    await expect(
      scenario.service.startReview({ taskId: scenario.taskId, runId: scenario.run.id })
    ).rejects.toThrow('Wait for the agent review to finish before starting a review.');
    await expect(
      scenario.service.startRun({ taskId: scenario.taskId })
    ).rejects.toThrow('Wait for the agent review to finish before starting agent work.');
    await expect(
      scenario.service.continueRun({
        taskId: scenario.taskId,
        runId: scenario.run.id,
        instruction: 'Fix the failing checks.'
      })
    ).rejects.toThrow('Wait for the agent review to finish before starting follow-up work.');
    await expect(
      scenario.service.createDeliveryCommit({ taskId: scenario.taskId })
    ).rejects.toThrow('Wait for the agent review to finish before creating a delivery commit.');
    await expect(
      scenario.service.publishBranch({ taskId: scenario.taskId })
    ).rejects.toThrow('Wait for the agent review to finish before publishing the branch.');
    await expect(
      scenario.service.createPullRequest({ taskId: scenario.taskId })
    ).rejects.toThrow('Wait for the agent review to finish before opening a pull request.');
    await expect(
      scenario.service.transitionTask({ taskId: scenario.taskId, toPhase: 'DONE' })
    ).rejects.toThrow('Wait for the agent review to finish before changing this task.');

    const refreshed = await scenario.service.refreshGitHub({ taskId: scenario.taskId });
    expect(refreshed).toMatchObject({
      number: 82,
      headRefOid: 'fresh-head',
      status: 'OPEN_READY'
    });

    const snapshot = await scenario.serviceHarness.store.snapshot();
    const currentReview = snapshot.runs.find((candidate) => candidate.id === review?.id);
    expect(currentReview).toMatchObject({ mode: 'REVIEW', status: 'RUNNING' });
    expect(scenario.serviceHarness.agent.startedTurns).toHaveLength(1);
    expect(scenario.serviceHarness.agent.startedReviews).toHaveLength(1);
  }, 15_000);
});

async function createScenarioWithCompletedRun(
  name: string,
  ghPath?: string
): Promise<{
  serviceHarness: TaskMonkiScenario;
  service: TaskMonkiScenario['service'];
  taskId: string;
  run: RunRecord;
}> {
  const serviceHarness = await createTaskMonkiScenario({ name, ghPath });
  const task = await serviceHarness.createTask({
    title: 'Review and PR action task',
    prompt: 'Exercise review and PR action coordination.'
  });
  const run = await serviceHarness.service.startRun({ taskId: task.id });
  await serviceHarness.completeRun(run.id, 'Implementation finished.');
  return {
    serviceHarness,
    service: serviceHarness.service,
    taskId: task.id,
    run
  };
}

async function recordPullRequestForRun(
  scenario: TaskMonkiScenario,
  taskId: string,
  run: RunRecord
): Promise<void> {
  await scenario.store.recordPullRequestSync({
    pullRequest: {
      taskId,
      iterationId: run.iterationId,
      worktreeId: run.worktreeId,
      number: 82,
      url: 'https://github.com/example/repo/pull/82',
      status: 'OPEN_READY',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'codex/review-pr-actions',
      headRefOid: 'old-head',
      baseRefName: 'main',
      title: 'Review and PR action task'
    },
    ci: {
      taskId,
      iterationId: run.iterationId,
      worktreeId: run.worktreeId,
      pullRequestNumber: 82,
      headSha: 'old-head',
      status: 'PASSING',
      requiredStatus: 'UNKNOWN',
      totalCount: 1,
      pendingCount: 0,
      passingCount: 1,
      failingCount: 0,
      skippedCount: 0,
      canceledCount: 0,
      checkDetails: []
    },
    reviews: {
      taskId,
      iterationId: run.iterationId,
      worktreeId: run.worktreeId,
      pullRequestNumber: 82,
      headSha: 'old-head',
      status: 'NOT_REQUESTED'
    },
    merge: {
      taskId,
      iterationId: run.iterationId,
      worktreeId: run.worktreeId,
      pullRequestNumber: 82,
      headSha: 'old-head',
      status: 'NOT_MERGED'
    }
  });
}

async function writeFakeGh(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-fake-gh-'));
  return writeNodeExecutable(
    dir,
    'gh',
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  setTimeout(() => {
    console.log(JSON.stringify({
      number: 82,
      url: 'https://github.com/example/repo/pull/82',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'codex/review-pr-actions',
      headRefOid: 'fresh-head',
      baseRefName: 'main',
      title: 'Review and PR action task',
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: []
    }));
    process.exit(0);
  }, 150);
} else if (args[0] === 'pr' && args[1] === 'checks') {
  console.log('[]');
  process.exit(0);
} else {
  console.error('Unexpected gh invocation: ' + args.join(' '));
  process.exit(1);
}
`
  );
}
