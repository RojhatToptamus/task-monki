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

describe('TaskManagerService review and PR action coordination', () => {
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

    await expect(second).rejects.toThrow(/Codex review .*running|Wait for the Codex review/);
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
    ).rejects.toThrow('Wait for the Codex review to finish before starting a review.');
    await expect(
      scenario.service.startRun({ taskId: scenario.taskId })
    ).rejects.toThrow('Wait for the Codex review to finish before starting agent work.');
    await expect(
      scenario.service.continueRun({
        taskId: scenario.taskId,
        runId: scenario.run.id,
        instruction: 'Fix the failing checks.'
      })
    ).rejects.toThrow('Wait for the Codex review to finish before starting follow-up work.');
    await expect(
      scenario.service.createDeliveryCommit({ taskId: scenario.taskId })
    ).rejects.toThrow('Wait for the Codex review to finish before creating a delivery commit.');
    await expect(
      scenario.service.publishBranch({ taskId: scenario.taskId })
    ).rejects.toThrow('Wait for the Codex review to finish before publishing the branch.');
    await expect(
      scenario.service.createPullRequest({ taskId: scenario.taskId })
    ).rejects.toThrow('Wait for the Codex review to finish before opening a pull request.');
    await expect(
      scenario.service.transitionTask({ taskId: scenario.taskId, toPhase: 'DONE' })
    ).rejects.toThrow('Wait for the Codex review to finish before changing this task.');

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
  });
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
