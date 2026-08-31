import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git/gitCli';
import { parsePrView } from '../github/GitHubService';
import { WorktreeService } from '../worktree/WorktreeService';
import { FileTaskStore } from '../storage/FileTaskStore';
import {
  createScriptedAgentRuntimeFixture,
  TaskMonkiScenarioRegistry,
  type TaskMonkiScenario
} from '../../testSupport/taskMonkiScenario';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import { TaskManagerService } from './TaskManagerService';

const scenarios = new TaskMonkiScenarioRegistry();
const createTaskMonkiScenario = scenarios.create.bind(scenarios);

afterEach(async () => {
  await scenarios.dispose();
});

describe('TaskManagerService crash recovery', () => {
  it('does not publish duplicate worktree or Git evidence when startup observes no change', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-unchanged-restart'
    });
    const task = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const before = await scenario.store.snapshot();

    const restarted = await restartScenario(scenario);
    try {
      const after = await restarted.store.snapshot();
      expect(
        after.gitSnapshots.filter(
          (candidate) => candidate.worktreeId === worktree.id
        )
      ).toHaveLength(
        before.gitSnapshots.filter(
          (candidate) => candidate.worktreeId === worktree.id
        ).length
      );
      expect(
        after.events.filter(
          (event) =>
            event.worktreeId === worktree.id &&
            ['WORKTREE_VERIFIED', 'GIT_SNAPSHOT_CAPTURED'].includes(event.type)
        )
      ).toHaveLength(
        before.events.filter(
          (event) =>
            event.worktreeId === worktree.id &&
            ['WORKTREE_VERIFIED', 'GIT_SNAPSHOT_CAPTURED'].includes(event.type)
        ).length
      );
    } finally {
      await restarted.service.shutdown();
    }
  }, 20_000);

  it('adopts a created worktree and commit whose completion was not persisted', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-recover-worktree-commit'
    });
    const task = await scenario.createTask();
    const baseSha = (await git(scenario.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    const created = await scenario.store.createIterationAndWorktree({
      task,
      branchName: 'task-monki/recover-created-worktree',
      worktreePath: path.join(scenario.worktreeRoot, task.id),
      baseRef: 'main',
      baseSha
    });
    const actual = await new WorktreeService(scenario.worktreeRoot).create(
      created.worktree,
      scenario.repositoryPath
    );
    await fs.writeFile(path.join(actual.worktreePath, 'recovered.txt'), 'recovered\n');
    await git(actual.worktreePath, ['add', 'recovered.txt']);
    await git(actual.worktreePath, ['commit', '-m', 'Commit before crash']);
    const committedHead = (await git(actual.worktreePath, ['rev-parse', 'HEAD'])).trim();

    const restarted = await restartScenario(scenario);
    try {
      const snapshot = await restarted.store.snapshot();
      expect(
        snapshot.worktrees.find((worktree) => worktree.id === created.worktree.id)
      ).toMatchObject({
        id: created.worktree.id,
        status: 'PRESENT',
        headSha: committedHead
      });
      expect(
        snapshot.gitSnapshots.find(
          (candidate) => candidate.worktreeId === created.worktree.id
        )
      ).toMatchObject({
        headSha: committedHead,
        status: 'COMMITTED_UNPUSHED'
      });
    } finally {
      await restarted.service.shutdown();
    }
  }, 20_000);

  it('marks an absent interrupted worktree missing and retries the same owned record explicitly', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-retry-worktree'
    });
    const task = await scenario.createTask();
    const baseSha = (await git(scenario.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    const created = await scenario.store.createIterationAndWorktree({
      task,
      branchName: 'task-monki/retry-missing-worktree',
      worktreePath: path.join(scenario.worktreeRoot, task.id),
      baseRef: 'main',
      baseSha
    });

    const restarted = await restartScenario(scenario);
    try {
      await expect(restarted.store.getCurrentWorktree(task.id)).resolves.toMatchObject({
        id: created.worktree.id,
        status: 'MISSING'
      });
      const retried = await restarted.service.prepareWorktree({ taskId: task.id });
      expect(retried).toMatchObject({
        id: created.worktree.id,
        iterationId: created.iteration.id,
        status: 'PRESENT'
      });
      expect((await restarted.store.snapshot()).iterations).toHaveLength(1);
    } finally {
      await restarted.service.shutdown();
    }
  }, 20_000);

  it('marks repository and worktree evidence unavailable when the checkout moved while stopped', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-recover-moved-repository'
    });
    const task = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.rename(
      scenario.repositoryPath,
      path.join(scenario.rootDir, 'repository-moved')
    );

    const restarted = await restartScenario(scenario);
    try {
      await expect(
        restarted.store.getRepository(scenario.repositoryId)
      ).resolves.toMatchObject({ status: 'MISSING' });
      await expect(
        restarted.store.getCurrentWorktree(task.id)
      ).resolves.toMatchObject({
        id: worktree.id,
        status: 'ERROR',
        error: expect.stringContaining('could not verify this worktree after restart')
      });
    } finally {
      await restarted.service.shutdown();
    }
  }, 20_000);

  it('adopts a remotely completed push and does not repeat it after restart', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-recover-push'
    });
    const task = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'push.txt'), 'push\n');
    await git(worktree.worktreePath, ['add', 'push.txt']);
    await git(worktree.worktreePath, ['commit', '-m', 'Push before crash']);
    const headSha = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    const remotePath = path.join(scenario.rootDir, 'remote.git');
    await git(scenario.rootDir, ['init', '--bare', remotePath]);
    await git(worktree.worktreePath, ['remote', 'add', 'origin', remotePath]);
    await scenario.store.recordBranchPublishRequested(
      task,
      worktree,
      'origin',
      headSha
    );
    await git(worktree.worktreePath, ['push', '--set-upstream', 'origin', 'HEAD']);

    const restarted = await restartScenario(scenario);
    try {
      const publications = (await restarted.store.snapshot()).branchPublications
        .filter((publication) => publication.iterationId === worktree.iterationId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      expect(publications[0]).toMatchObject({
        status: 'PUSHED',
        headSha
      });
      expect(
        (await git(worktree.worktreePath, [
          'ls-remote',
          '--heads',
          'origin',
          `refs/heads/${worktree.branchName}`
        ])).trim()
      ).toContain(headSha);
      expect(publications.filter((publication) => publication.status === 'PUSHING')).toHaveLength(1);
      expect(publications.filter((publication) => publication.status === 'PUSHED')).toHaveLength(1);
    } finally {
      await restarted.service.shutdown();
    }
  }, 20_000);

  it('turns an unstarted persisted push into a proven retryable failure', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-recover-unstarted-push'
    });
    const task = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'not-pushed.txt'), 'pending\n');
    await git(worktree.worktreePath, ['add', 'not-pushed.txt']);
    await git(worktree.worktreePath, ['commit', '-m', 'Pending push']);
    const headSha = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    const remotePath = path.join(scenario.rootDir, 'empty-remote.git');
    await git(scenario.rootDir, ['init', '--bare', remotePath]);
    await git(worktree.worktreePath, ['remote', 'add', 'origin', remotePath]);
    await scenario.store.recordBranchPublishRequested(
      task,
      worktree,
      'origin',
      headSha
    );

    const restarted = await restartScenario(scenario);
    try {
      const latest = (await restarted.store.snapshot()).branchPublications
        .filter((publication) => publication.iterationId === worktree.iterationId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      expect(latest).toMatchObject({ status: 'FAILED', headSha });
      expect(latest.error).toMatch(/retry is safe/iu);
    } finally {
      await restarted.service.shutdown();
    }
  }, 20_000);

  it('rechecks an ambiguous push before creating a local delivery commit', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-recheck-before-commit'
    });
    const task = await scenario.createTask();
    const run = await scenario.service.startRun({ taskId: task.id });
    const worktree = await scenario.store.getCurrentWorktree(task.id);
    if (!worktree) throw new Error('Scenario worktree was not created.');
    await fs.writeFile(path.join(worktree.worktreePath, 'implemented.txt'), 'implemented\n');
    await git(worktree.worktreePath, ['add', 'implemented.txt']);
    await git(worktree.worktreePath, ['commit', '-m', 'Implementation']);
    const attemptedHead = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await scenario.completeRun(run.id, 'Implementation finished.');

    const remotePath = path.join(scenario.rootDir, 'mismatched-remote.git');
    await git(scenario.rootDir, ['init', '--bare', remotePath]);
    await git(worktree.worktreePath, ['remote', 'add', 'origin', remotePath]);
    await git(worktree.worktreePath, [
      'push',
      'origin',
      `${worktree.baseSha}:refs/heads/${worktree.branchName}`
    ]);
    await scenario.store.recordBranchPublishRequested(
      task,
      worktree,
      'origin',
      attemptedHead
    );
    await fs.writeFile(path.join(worktree.worktreePath, 'after-push.txt'), 'still dirty\n');

    await expect(
      scenario.service.publishBranch({ taskId: task.id })
    ).rejects.toThrow(/Remote branch is at/);
    expect(
      (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim()
    ).toBe(attemptedHead);
    expect(await git(worktree.worktreePath, ['status', '--porcelain'])).toContain(
      'after-push.txt'
    );
    await scenario.service.shutdown();
  }, 30_000);

  it('rechecks an ambiguous push before a pull request action auto-commits', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-recheck-pr-before-commit'
    });
    const task = await scenario.createTask();
    const run = await scenario.service.startRun({ taskId: task.id });
    const worktree = await scenario.store.getCurrentWorktree(task.id);
    if (!worktree) throw new Error('Scenario worktree was not created.');
    await fs.writeFile(path.join(worktree.worktreePath, 'implemented.txt'), 'implemented\n');
    await git(worktree.worktreePath, ['add', 'implemented.txt']);
    await git(worktree.worktreePath, ['commit', '-m', 'Implementation']);
    const attemptedHead = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await scenario.completeRun(run.id, 'Implementation finished.');

    const remotePath = path.join(scenario.rootDir, 'mismatched-pr-remote.git');
    await git(scenario.rootDir, ['init', '--bare', remotePath]);
    await git(worktree.worktreePath, ['remote', 'add', 'origin', remotePath]);
    await git(worktree.worktreePath, [
      'push',
      'origin',
      `${worktree.baseSha}:refs/heads/${worktree.branchName}`
    ]);
    await scenario.store.recordBranchPublishRequested(
      task,
      worktree,
      'origin',
      attemptedHead
    );
    await fs.writeFile(path.join(worktree.worktreePath, 'after-push.txt'), 'still dirty\n');

    await expect(
      scenario.service.createPullRequest({ taskId: task.id })
    ).rejects.toThrow(/Remote branch is at/);
    expect(
      (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim()
    ).toBe(attemptedHead);
    expect(await git(worktree.worktreePath, ['status', '--porcelain'])).toContain(
      'after-push.txt'
    );
    await scenario.service.shutdown();
  }, 30_000);

  it('rechecks an ambiguous push and adopts a later externally completed result', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-recheck-ambiguous-push'
    });
    const task = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'ambiguous.txt'), 'local\n');
    await git(worktree.worktreePath, ['add', 'ambiguous.txt']);
    await git(worktree.worktreePath, ['commit', '-m', 'Attempted push']);
    const headSha = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    const remotePath = path.join(scenario.rootDir, 'ambiguous-remote.git');
    await git(scenario.rootDir, ['init', '--bare', remotePath]);
    await git(worktree.worktreePath, ['remote', 'add', 'origin', remotePath]);
    await git(worktree.worktreePath, [
      'push',
      'origin',
      `${worktree.baseSha}:refs/heads/${worktree.branchName}`
    ]);
    await scenario.store.recordBranchPublishRequested(
      task,
      worktree,
      'origin',
      headSha
    );

    const firstRestart = await restartScenario(scenario);
    const ambiguous = (await firstRestart.store.snapshot()).branchPublications
      .filter((publication) => publication.iterationId === worktree.iterationId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    expect(ambiguous).toMatchObject({ status: 'AMBIGUOUS', headSha });
    await firstRestart.service.shutdown();

    const unchangedRestart = await openRestartedScenario(scenario);
    const unchangedPublications = (await unchangedRestart.store.snapshot()).branchPublications
      .filter((publication) => publication.iterationId === worktree.iterationId);
    expect(
      unchangedPublications.filter(
        (publication) => publication.status === 'AMBIGUOUS'
      )
    ).toHaveLength(1);

    await git(worktree.worktreePath, [
      'push',
      '--force',
      'origin',
      `HEAD:refs/heads/${worktree.branchName}`
    ]);
    await unchangedRestart.service.shutdown();

    const completedRestart = await openRestartedScenario(scenario);
    try {
      const publications = (await completedRestart.store.snapshot()).branchPublications
        .filter((publication) => publication.iterationId === worktree.iterationId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      expect(publications[0]).toMatchObject({ status: 'PUSHED', headSha });
      expect(
        publications.filter((publication) => publication.status === 'AMBIGUOUS')
      ).toHaveLength(1);
      expect(
        publications.filter((publication) => publication.status === 'PUSHING')
      ).toHaveLength(1);
    } finally {
      await completedRestart.service.shutdown();
    }
  }, 30_000);

  it('adopts a PR created before the local create result was persisted', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-recover-pr'
    });
    const task = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const headSha = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    const ghPath = await writeRecoveryGh(
      scenario.rootDir,
      worktree.branchName,
      headSha
    );
    await scenario.store.recordPullRequestCreateRequested(task, worktree);

    const restarted = await restartScenario(scenario, ghPath);
    try {
      const snapshot = await restarted.store.snapshot();
      expect(snapshot.pullRequests[0]).toMatchObject({
        number: 42,
        status: 'OPEN_DRAFT',
        headRefOid: headSha
      });
      expect(
        snapshot.tasks.find((candidate) => candidate.id === task.id)
      ).toMatchObject({
        workflowPhase: 'IN_REVIEW'
      });
    } finally {
      await restarted.service.shutdown();
    }
  }, 20_000);

  it('records an honest failure when interrupted PR recovery cannot inspect GitHub', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-failed-pr-recovery'
    });
    const task = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const invocationPath = path.join(scenario.rootDir, 'gh-recovery-failures.log');
    const ghPath = await writeFailingRecoveryGh(
      scenario.rootDir,
      invocationPath
    );
    await scenario.store.recordPullRequestCreateRequested(task, worktree);

    const restarted = await restartScenario(scenario, ghPath);
    try {
      const snapshot = await restarted.store.snapshot();
      expect(snapshot.pullRequests).toHaveLength(0);
      expect(snapshot.events).toContainEqual(
        expect.objectContaining({
          type: 'GITHUB_SYNC_FAILED',
          taskId: task.id,
          payload: expect.objectContaining({
            operation: 'pull-request-recovery'
          })
        })
      );
      const invocations = await fs.readFile(invocationPath, 'utf8');
      expect(invocations).toContain('pr list');
      expect(invocations).not.toContain('pr create');
    } finally {
      await restarted.service.shutdown();
    }
  }, 20_000);

  it('keeps the last complete GitHub snapshot without repeating an interrupted refresh', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-recover-github-refresh'
    });
    const task = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const headSha = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await scenario.store.recordPullRequestSync(
      parsePrView(
        {
          number: 43,
          url: 'https://github.com/example/repo/pull/43',
          state: 'OPEN',
          isDraft: true,
          headRefOid: headSha,
          headRefName: worktree.branchName,
          baseRefName: 'main',
          title: 'Last complete snapshot',
          statusCheckRollup: []
        },
        worktree
      )
    );
    const invocationPath = path.join(scenario.rootDir, 'gh-invocations.log');
    const ghPath = await writeRefreshGh(
      scenario.rootDir,
      invocationPath,
      worktree.branchName,
      headSha
    );

    const restarted = await restartScenario(scenario, ghPath);
    try {
      expect(await fs.readFile(invocationPath, 'utf8')).toBe('--version\n');
      expect((await restarted.store.getLatestPullRequest(task.id))?.title).toBe(
        'Last complete snapshot'
      );

      const refreshed = await restarted.service.refreshGitHub({ taskId: task.id });
      expect(refreshed?.title).toBe('Explicitly refreshed snapshot');
      const invocations = await fs.readFile(invocationPath, 'utf8');
      expect(invocations).toContain('pr view 43');
      expect(invocations).toContain('pr checks 43');
    } finally {
      await restarted.service.shutdown();
    }
  }, 20_000);
});

async function restartScenario(
  scenario: TaskMonkiScenario,
  ghPath?: string
): Promise<{ store: FileTaskStore; service: TaskManagerService }> {
  await scenario.store.close();
  return openRestartedScenario(scenario, ghPath);
}

async function openRestartedScenario(
  scenario: TaskMonkiScenario,
  ghPath?: string
): Promise<{ store: FileTaskStore; service: TaskManagerService }> {
  const store = new FileTaskStore(path.join(scenario.rootDir, 'store'));
  const scriptedRuntime = createScriptedAgentRuntimeFixture(store);
  const service = new TaskManagerService(store, scenario.repositoryPath, undefined, {
    worktreeRoot: scenario.worktreeRoot,
    ghPath,
    ...scriptedRuntime.serviceOptions
  });
  await service.init();
  return { store, service };
}

async function writeRecoveryGh(
  root: string,
  branchName: string,
  headSha: string
): Promise<string> {
  return writeNodeExecutable(
    root,
    'gh-recovery',
    `
const args = process.argv.slice(2);
const row = {
  number: 42,
  url: 'https://github.com/example/repo/pull/42',
  state: 'OPEN',
  isDraft: true,
  mergedAt: null,
  reviewDecision: '',
  statusCheckRollup: [],
  headRefOid: ${JSON.stringify(headSha)},
  headRefName: ${JSON.stringify(branchName)},
  baseRefName: 'main',
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'UNKNOWN',
  title: 'Recovered PR'
};
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify([row]));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify(row));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  console.log('[]');
  process.exit(0);
}
console.error('Unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`
  );
}

async function writeRefreshGh(
  root: string,
  invocationPath: string,
  branchName: string,
  headSha: string
): Promise<string> {
  return writeNodeExecutable(
    root,
    'gh-refresh-recovery',
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(invocationPath)}, args.join(' ') + '\\n');
if (args[0] === '--version') {
  console.log('gh version 2.0.0');
  process.exit(0);
}
const row = {
  number: 43,
  url: 'https://github.com/example/repo/pull/43',
  state: 'OPEN',
  isDraft: true,
  mergedAt: null,
  reviewDecision: '',
  statusCheckRollup: [],
  headRefOid: ${JSON.stringify(headSha)},
  headRefName: ${JSON.stringify(branchName)},
  baseRefName: 'main',
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'UNKNOWN',
  title: 'Explicitly refreshed snapshot'
};
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify(row));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  console.log('[]');
  process.exit(0);
}
console.error('Unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`
  );
}

async function writeFailingRecoveryGh(
  root: string,
  invocationPath: string
): Promise<string> {
  return writeNodeExecutable(
    root,
    'gh-failing-recovery',
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(invocationPath)}, args.join(' ') + '\\n');
if (args[0] === '--version') {
  console.log('gh version 2.0.0');
  process.exit(0);
}
console.error('Injected GitHub recovery failure.');
process.exit(9);
`
  );
}
