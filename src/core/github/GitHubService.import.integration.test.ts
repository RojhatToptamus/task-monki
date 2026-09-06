import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import { ScriptedAgentRuntimeAdapter, TaskMonkiScenarioRegistry } from '../../testSupport/taskMonkiScenario';
import { TaskManagerService } from '../app/TaskManagerService';
import * as gitCli from '../git/gitCli';
import * as ownedProcess from '../process/ownedProcess';
import { FileTaskStore } from '../storage/FileTaskStore';
import { GitHubService } from './GitHubService';

const exec = promisify(execFile);
const scenarios = new TaskMonkiScenarioRegistry();
const roots: string[] = [];
const remoteUrl = 'https://github.com/example/repo.git';
const otherRemoteUrl = 'https://github.com/another/repo.git';

beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await scenarios.dispose();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe('external checkout GitHub delivery', { timeout: 30_000 }, () => {
  it('links an exact existing PR at the attached comparison commit without a push, commit, upstream change, or primary run', async () => {
    const fixture = await createFixture({ comparisonAtHead: true });
    const config = await fs.readFile(path.join(fixture.scenario.repositoryPath, '.git/config'));
    const gitDir = await externalGit(fixture.worktree.worktreePath, ['rev-parse', '--absolute-git-dir']);
    const index = await fs.readFile(path.join(gitDir, 'index'));

    await expect(fixture.scenario.service.createPullRequest({ taskId: fixture.task.id })).resolves.toMatchObject({ number: 7, headRefOid: fixture.head });

    expect(fixture.pushes).toEqual([]);
    expect(await fixture.created()).toBe(false);
    expect(await fs.readFile(path.join(fixture.scenario.repositoryPath, '.git/config'))).toEqual(config);
    expect(await fs.readFile(path.join(gitDir, 'index'))).toEqual(index);
    expect(await fixture.scenario.store.getTask(fixture.task.id)).toMatchObject({ workflowPhase: 'IN_REVIEW' });
    expect((await fixture.scenario.store.snapshot()).runs).toEqual([]);
    const invocations = await fixture.invocations();
    expect(invocations.filter((args) => args[0] === 'pr').every((args) => args.includes('--repo') && args.includes('github.com/example/repo'))).toBe(true);
  });

  it('rejects dirty shared work for commit, push, and Create PR without staging it', async () => {
    const fixture = await createFixture();
    const filename = path.join(fixture.worktree.worktreePath, 'change.txt');
    await fs.writeFile(filename, 'external edits\n');
    await expect(fixture.scenario.service.createDeliveryCommit({ taskId: fixture.task.id })).rejects.toThrow(/existing application/);
    await expect(fixture.scenario.service.publishBranch({ taskId: fixture.task.id })).rejects.toThrow(/Commit shared-checkout/);
    await expect(fixture.scenario.service.createPullRequest({ taskId: fixture.task.id })).rejects.toThrow(/Commit shared-checkout/);
    expect(await externalGit(fixture.worktree.worktreePath, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await externalGit(fixture.worktree.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(await fs.readFile(filename, 'utf8')).toBe('external edits\n');
    expect(fixture.pushes).toEqual([]);
    expect(await fixture.created()).toBe(false);
  });

  it.each(['multiple', 'fork', 'wrong branch', 'wrong repository', 'truncated', 'invalid JSON'])(
    'rejects %s PR discovery instead of selecting a convenient match', async (kind) => {
      const fixture = await createFixture();
      const matching = fixture.pr();
      const mismatch = kind === 'fork' ? { ...matching, isCrossRepository: true }
        : kind === 'wrong branch' ? { ...matching, headRefName: 'someone-else' }
        : { ...matching, headRepositoryOwner: { login: 'someone-else' } };
      const rows = kind === 'multiple' ? [matching, { ...matching, number: 8, url: 'https://github.com/example/repo/pull/8' }]
        : kind === 'truncated' ? Array.from({ length: 10 }, () => matching)
        : kind === 'invalid JSON' ? '{incomplete' : [matching, mismatch];
      await fixture.respond(rows);
      await expect(fixture.scenario.service.createPullRequest({ taskId: fixture.task.id })).rejects.toThrow();
      expect((await fixture.scenario.store.snapshot()).pullRequests).toEqual([]);
      expect(fixture.pushes).toEqual([]);
      expect(await fixture.created()).toBe(false);
    }
  );

  it.each(['fork remote', 'push destination', 'multiple push destinations'])(
    'rejects an ambiguous %s before delivery', async (kind) => {
      const fixture = await createFixture();
      if (kind === 'fork remote') await externalGit(fixture.worktree.worktreePath, ['remote', 'add', 'fork', otherRemoteUrl]);
      else if (kind === 'push destination') await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', '--push', 'origin', otherRemoteUrl]);
      else {
        await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', '--add', '--push', 'origin', remoteUrl]);
        await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', '--add', '--push', 'origin', otherRemoteUrl]);
      }
      await expect(fixture.scenario.service.createPullRequest({ taskId: fixture.task.id })).rejects.toThrow();
      expect(fixture.pushes).toEqual([]);
      expect(await fixture.created()).toBe(false);
    }
  );

  it('pushes the verified commit to the explicit branch without writing upstream configuration', async () => {
    const fixture = await createFixture();
    const config = await fs.readFile(path.join(fixture.scenario.repositoryPath, '.git/config'));
    await expect(fixture.scenario.service.publishBranch({ taskId: fixture.task.id })).resolves.toMatchObject({ status: 'PUSHED', headSha: fixture.head, remoteUrl });
    expect(fixture.pushes).toEqual([['push', remoteUrl, `${fixture.head}:refs/heads/external-work`]]);
    expect(await externalGit(fixture.bare, ['rev-parse', 'refs/heads/external-work'])).toBe(fixture.head);
    expect(await fs.readFile(path.join(fixture.scenario.repositoryPath, '.git/config'))).toEqual(config);
  });

  it.each(['HEAD', 'branch', 'repository', 'dirty files'])(
    'revalidates %s at the push boundary', async (change) => {
      const fixture = await createFixture();
      if (change === 'HEAD') await fixture.commit('later external commit');
      else if (change === 'branch') await externalGit(fixture.worktree.worktreePath, ['switch', '-c', 'different-branch']);
      else if (change === 'repository') await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', 'origin', otherRemoteUrl]);
      else await fs.writeFile(path.join(fixture.worktree.worktreePath, 'change.txt'), 'dirty\n');
      await expect(fixture.github.publishBranch({ task: fixture.task, worktree: fixture.worktree, remoteName: 'origin', expectedHeadSha: fixture.head, expectedRemoteUrl: remoteUrl })).rejects.toThrow();
      expect(fixture.pushes).toEqual([]);
    }
  );

  it('reconciles an interrupted push against its actual destination even if origin changes', async () => {
    const fixture = await createFixture();
    fixture.afterPush = async () => {
      await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', 'origin', otherRemoteUrl]);
      throw new Error('connection closed after the remote accepted the push');
    };
    const result = await fixture.github.publishBranch({ task: fixture.task, worktree: fixture.worktree, remoteName: 'origin', expectedHeadSha: fixture.head, expectedRemoteUrl: remoteUrl });
    expect(await externalGit(fixture.bare, ['rev-parse', 'refs/heads/external-work'])).toBe(fixture.head);
    expect(result).toMatchObject({ status: 'PUSHED', remoteUrl });
  });

  it('recovers the persisted push destination after restart and leaves URL-less historical attempts ambiguous', async () => {
    const fixture = await createFixture();
    const record = fixture.scenario.store.recordBranchPublication.bind(fixture.scenario.store);
    const crash = vi.spyOn(fixture.scenario.store, 'recordBranchPublication').mockImplementation(async (publication) => {
      if (publication.status === 'PUSHED') throw new Error('simulated crash before persisting push result');
      return record(publication);
    });
    await expect(fixture.scenario.service.publishBranch({ taskId: fixture.task.id })).rejects.toThrow('simulated crash');
    crash.mockRestore();
    expect((await fixture.scenario.store.snapshot()).branchPublications[0]).toMatchObject({ status: 'PUSHING', remoteUrl });
    expect(await externalGit(fixture.bare, ['rev-parse', 'refs/heads/external-work'])).toBe(fixture.head);
    await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', 'origin', otherRemoteUrl]);
    await expect(fixture.github.reconcileBranchPublication({ task: fixture.task, worktree: fixture.worktree, remoteName: 'origin', expectedHeadSha: fixture.head })).resolves.toMatchObject({ status: 'AMBIGUOUS' });
    await fixture.scenario.service.shutdown();
    const store = new FileTaskStore(path.join(fixture.scenario.rootDir, 'store'));
    const restarted = new TaskManagerService(store, fixture.scenario.repositoryPath, undefined, {
      ghPath: fixture.ghPath,
      worktreeRoot: fixture.scenario.worktreeRoot,
      agentRuntimeAdapters: [new ScriptedAgentRuntimeAdapter(store)]
    });
    try {
      await restarted.init();
      expect((await store.snapshot()).branchPublications[0]).toMatchObject({ status: 'PUSHED', headSha: fixture.head, remoteUrl });
    } finally {
      await restarted.shutdown();
    }
    expect(fixture.pushes).toHaveLength(1);
  });

  it.each([
    { name: 'unfinished work', ready: false, merged: false, change: 'none', expectedPhase: 'IN_PROGRESS' },
    { name: 'a different HEAD during lookup', ready: true, merged: false, change: 'commit', expectedPhase: 'REVIEW' },
    { name: 'a checkout disappearing during lookup of a merged PR', ready: true, merged: true, change: 'missing', expectedPhase: 'REVIEW' }
  ])('uses current local readiness in pending PR restart recovery for $name', async (condition) => {
    const fixture = await createFixture({ ready: condition.ready });
    await fixture.respond([]);
    const crash = vi.spyOn(fixture.scenario.store, 'recordPullRequestSync')
      .mockRejectedValueOnce(new Error('simulated crash before persisting PR result'));
    try {
      await expect(fixture.scenario.service.createPullRequest({ taskId: fixture.task.id }))
        .rejects.toThrow('simulated crash before persisting PR result');
    } finally {
      crash.mockRestore();
    }
    const pending = await fixture.scenario.store.snapshot();
    expect(pending.events.some((event) => event.type === 'PR_CREATE_REQUESTED' && event.taskId === fixture.task.id)).toBe(true);
    expect(pending.pullRequests).toEqual([]);
    expect(await fixture.created()).toBe(true);
    expect((await fixture.scenario.store.getTask(fixture.task.id))?.workflowPhase)
      .toBe(condition.ready ? 'REVIEW' : 'IN_PROGRESS');
    await fixture.scenario.service.shutdown();

    await fixture.respond([fixture.pr()], fixture.pr(condition.merged
      ? { state: 'MERGED', mergedAt: '2026-09-06T12:00:00Z' }
      : {}));
    let observedLookup = false;
    fixture.afterGh = async (args) => {
      if (args[0] !== 'pr' || args[1] !== 'view') return;
      fixture.afterGh = undefined;
      observedLookup = true;
      if (condition.change === 'commit') {
        await fixture.commit('external progress during recovery');
      }
    };
    if (condition.change === 'missing') {
      const lookup = GitHubService.prototype.findOpenPullRequest;
      vi.spyOn(GitHubService.prototype, 'findOpenPullRequest').mockImplementation(async function (this: GitHubService, worktree) {
        const result = await lookup.call(this, worktree);
        await externalGit(fixture.scenario.repositoryPath, [
          'worktree', 'move', fixture.worktree.worktreePath,
          path.join(fixture.scenario.rootDir, 'moved-during-recovery')
        ]);
        return result;
      });
    }
    const store = new FileTaskStore(path.join(fixture.scenario.rootDir, 'store'));
    const restarted = new TaskManagerService(store, fixture.scenario.repositoryPath, undefined, {
      ghPath: fixture.ghPath,
      worktreeRoot: fixture.scenario.worktreeRoot,
      agentRuntimeAdapters: [new ScriptedAgentRuntimeAdapter(store)]
    });
    try {
      await restarted.init();
      expect(observedLookup).toBe(true);
      expect((await store.getTask(fixture.task.id))?.workflowPhase).toBe(condition.expectedPhase);
      if (condition.change === 'missing') {
        expect((await store.getTask(fixture.task.id))?.projection.git).toBe('UNAVAILABLE');
      }
      expect((await store.snapshot()).pullRequests[0]).toMatchObject({
        number: 7,
        status: condition.merged ? 'MERGED' : 'OPEN_DRAFT',
        headRefOid: fixture.head
      });
      expect(fixture.pushes).toHaveLength(1);
      expect((await fixture.invocations()).filter((args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(1);
    } finally {
      await restarted.shutdown();
    }
  });

  it('does not run a configured filesystem monitor during shared-checkout delivery checks', async () => {
    const fixture = await createFixture();
    const marker = path.join(fixture.scenario.rootDir, 'fsmonitor-ran');
    const monitor = await writeNodeExecutable(fixture.scenario.rootDir, 'fsmonitor', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    await externalGit(fixture.worktree.worktreePath, ['config', 'core.fsmonitor', monitor]);
    await fixture.github.publishBranch({ task: fixture.task, worktree: fixture.worktree, expectedHeadSha: fixture.head, expectedRemoteUrl: remoteUrl });
    await fixture.respond([]);
    await expect(fixture.github.createOrFindDraftPullRequest({ worktree: fixture.worktree, title: 'New draft', body: 'Summary', expectedHeadSha: fixture.head, expectedRemoteUrl: remoteUrl })).resolves.toMatchObject({ pullRequest: { headRefOid: fixture.head, status: 'OPEN_DRAFT' } });
    expect(await fixture.created()).toBe(true);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('creates a new draft for the verified external head and repository', async () => {
    const fixture = await createFixture();
    await fixture.respond([]);
    await fixture.scenario.service.createPullRequest({ taskId: fixture.task.id });
    expect(await fixture.created()).toBe(true);
    expect(fixture.pushes).toHaveLength(1);
    expect((await fixture.scenario.store.getTask(fixture.task.id))?.workflowPhase).toBe('IN_REVIEW');
  });

  it('blocks Create PR on the attached base branch before any push', async () => {
    const fixture = await createFixture({ primary: true });
    await fixture.respond([]);
    await expect(fixture.scenario.service.createPullRequest({ taskId: fixture.task.id })).rejects.toThrow();
    expect(fixture.pushes).toEqual([]);
    expect(await fixture.created()).toBe(false);
  });

  it('uses the same base guard before publication and PR creation while permitting a real different branch', async () => {
    const fixture = await createFixture();
    await fixture.respond([]);
    for (const baseRef of [fixture.worktree.branchName, fixture.head, 'HEAD', 'invalid base']) {
      await expect(fixture.github.validatePullRequestBase(fixture.worktree, baseRef)).rejects.toThrow();
      await expect(fixture.github.createOrFindDraftPullRequest({ worktree: fixture.worktree, baseRef, title: 'Draft', body: 'Summary', expectedHeadSha: fixture.head, expectedRemoteUrl: remoteUrl })).rejects.toThrow();
    }
    await expect(fixture.github.validatePullRequestBase(fixture.worktree, 'main')).resolves.toBeUndefined();
    expect(await fixture.created()).toBe(false);
    expect(fixture.pushes).toEqual([]);
  });

  it('can link an existing default-branch PR without applying the new-PR base restriction', async () => {
    const fixture = await createFixture({ primary: true });
    const existing = fixture.pr({ baseRefName: 'release' });
    await fixture.respond([existing], existing);
    await expect(fixture.github.createOrFindDraftPullRequest({ worktree: fixture.worktree, title: 'Unused', body: 'Unused', expectedHeadSha: fixture.head, expectedRemoteUrl: remoteUrl })).resolves.toMatchObject({ pullRequest: { number: 7, baseRefName: 'release' } });
    expect(fixture.pushes).toEqual([]);
    expect(await fixture.created()).toBe(false);
  });

  it.each(['dirty files', 'HEAD'])(
    'does not mark a matching PR ready using stale local evidence after %s change during lookup', async (change) => {
      const fixture = await createFixture();
      fixture.afterGh = async (args) => {
        if (args[0] !== 'pr' || args[1] !== 'view') return;
        fixture.afterGh = undefined;
        if (change === 'HEAD') await fixture.commit('external progress during lookup');
        else await fs.writeFile(path.join(fixture.worktree.worktreePath, 'change.txt'), 'new external edits\n');
      };
      await fixture.scenario.service.createPullRequest({ taskId: fixture.task.id }).catch(() => undefined);
      expect((await fixture.scenario.store.getTask(fixture.task.id))?.workflowPhase).toBe('REVIEW');
      expect(fixture.pushes).toEqual([]);
      expect(await fixture.created()).toBe(false);
    }
  );

  it.each(['HEAD', 'repository'])(
    'does not create a PR after %s changes during post-push discovery', async (change) => {
      const fixture = await createFixture();
      await fixture.respond([]);
      let changed = false;
      fixture.afterGh = async (args) => {
        if (args[0] !== 'pr' || args[1] !== 'list' || !fixture.pushes.length) return;
        fixture.afterGh = undefined;
        changed = true;
        if (change === 'HEAD') await fixture.commit('external progress after publication');
        else await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', 'origin', otherRemoteUrl]);
      };
      await expect(fixture.scenario.service.createPullRequest({ taskId: fixture.task.id })).rejects.toThrow();
      expect(changed).toBe(true);
      expect(await fixture.created()).toBe(false);
      expect((await fixture.scenario.store.getTask(fixture.task.id))?.workflowPhase).toBe('REVIEW');
    }
  );

  it('does not replace the published destination with a fresh preflight after origin changes', async () => {
    const fixture = await createFixture();
    await fixture.respond([]);
    fixture.afterPush = async () => {
      await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', 'origin', otherRemoteUrl]);
    };
    await expect(fixture.scenario.service.createPullRequest({ taskId: fixture.task.id })).rejects.toThrow();
    expect(await externalGit(fixture.bare, ['rev-parse', 'refs/heads/external-work'])).toBe(fixture.head);
    expect(await fixture.created()).toBe(false);
  });

  it('publishes to the newly selected repository before creating its PR instead of reusing another repository publication', async () => {
    const fixture = await createFixture();
    await fixture.scenario.service.publishBranch({ taskId: fixture.task.id });
    await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', 'origin', otherRemoteUrl]);
    await fixture.respond([], fixture.pr({
      url: 'https://github.com/another/repo/pull/7',
      headRepositoryOwner: { login: 'another' }
    }));
    await fixture.scenario.service.createPullRequest({ taskId: fixture.task.id });
    expect(fixture.pushes).toEqual([
      ['push', remoteUrl, `${fixture.head}:refs/heads/external-work`],
      ['push', otherRemoteUrl, `${fixture.head}:refs/heads/external-work`]
    ]);
    expect(await externalGit(fixture.otherBare, ['rev-parse', 'refs/heads/external-work'])).toBe(fixture.head);
    expect(await fixture.created()).toBe(true);
  });

  it.each(['HEAD', 'repository', 'branch', 'dirty files'])(
    'revalidates %s after discovery at the PR creation boundary', async (change) => {
      const fixture = await createFixture();
      await fixture.respond([]);
      fixture.afterGh = async (args) => {
        if (args[0] !== 'pr' || args[1] !== 'list') return;
        fixture.afterGh = undefined;
        if (change === 'HEAD') await fixture.commit('new external commit');
        else if (change === 'repository') await externalGit(fixture.worktree.worktreePath, ['remote', 'set-url', 'origin', otherRemoteUrl]);
        else if (change === 'branch') await externalGit(fixture.worktree.worktreePath, ['switch', '-c', 'unrelated-work']);
        else await fs.writeFile(path.join(fixture.worktree.worktreePath, 'change.txt'), 'new uncommitted edit\n');
      };
      await expect(fixture.github.createOrFindDraftPullRequest({ worktree: fixture.worktree, title: 'New draft', body: 'Summary', expectedHeadSha: fixture.head, expectedRemoteUrl: remoteUrl })).rejects.toThrow();
      expect(await fixture.created()).toBe(false);
    }
  );

  it.each(['existing', 'created'])(
    'does not accept the %s PR when its remote head differs from the delivered commit', async (kind) => {
      const fixture = await createFixture();
      const stale = fixture.pr({ headRefOid: fixture.base });
      await fixture.respond(kind === 'existing' ? [stale] : [], stale);
      await expect(fixture.github.createOrFindDraftPullRequest({ worktree: fixture.worktree, title: 'Draft', body: 'Summary', expectedHeadSha: fixture.head, expectedRemoteUrl: remoteUrl })).rejects.toThrow(/head/i);
      expect(await fixture.created()).toBe(kind === 'created');
    }
  );

  it('rejects a fork returned by PR view even when discovery initially matched', async () => {
    const fixture = await createFixture();
    await fixture.respond([fixture.pr()], fixture.pr({ isCrossRepository: true, headRepositoryOwner: { login: 'fork-owner' } }));
    await expect(fixture.scenario.service.refreshGitHub({ taskId: fixture.task.id })).rejects.toThrow(/does not match/);
    expect((await fixture.scenario.store.snapshot()).pullRequests).toEqual([]);
  });

  it('does not reopen a task when its discovered PR merges before the view response', async () => {
    const fixture = await createFixture();
    await fixture.respond([fixture.pr()], fixture.pr({ state: 'MERGED', mergedAt: '2026-09-06T12:00:00Z' }));
    await fixture.scenario.service.createPullRequest({ taskId: fixture.task.id });
    expect((await fixture.scenario.store.getTask(fixture.task.id))?.workflowPhase).toBe('DONE');
    expect(fixture.pushes).toEqual([]);
  });

  it('refreshes local evidence after GitHub and completes only clean matching ready work', async () => {
    const fixture = await createFixture();
    await fixture.scenario.service.refreshGitHub({ taskId: fixture.task.id });
    await fixture.respond([fixture.pr()], fixture.pr({ state: 'MERGED', mergedAt: '2026-09-06T12:00:00Z' }));
    fixture.afterGh = async (args) => {
      if (args[0] !== 'pr' || args[1] !== 'view') return;
      fixture.afterGh = undefined;
      await fs.writeFile(path.join(fixture.worktree.worktreePath, 'change.txt'), 'work continued while GitHub was loading\n');
    };
    await fixture.scenario.service.refreshGitHub({ taskId: fixture.task.id });
    expect((await fixture.scenario.store.getTask(fixture.task.id))?.workflowPhase).toBe('REVIEW');
    await expect(fixture.scenario.service.transitionTask({ taskId: fixture.task.id, toPhase: 'DONE' })).rejects.toThrow(/clean local work/);
    await fs.writeFile(path.join(fixture.worktree.worktreePath, 'change.txt'), 'initial external change\n');
    await fixture.scenario.service.refreshGitHub({ taskId: fixture.task.id });
    expect((await fixture.scenario.store.getTask(fixture.task.id))?.workflowPhase).toBe('DONE');
  });

  it.each(['not ready', 'different HEAD'])(
    'keeps merged GitHub evidence from completing %s local work', async (condition) => {
      const fixture = await createFixture({ ready: condition !== 'not ready' });
      await fixture.scenario.service.refreshGitHub({ taskId: fixture.task.id });
      await fixture.respond([fixture.pr()], fixture.pr({ state: 'MERGED', mergedAt: '2026-09-06T12:00:00Z', ...(condition === 'different HEAD' ? { headRefOid: fixture.base } : {}) }));
      await fixture.scenario.service.refreshGitHub({ taskId: fixture.task.id });
      expect((await fixture.scenario.store.getTask(fixture.task.id))?.workflowPhase).toBe(condition === 'not ready' ? 'IN_PROGRESS' : 'REVIEW');
      await expect(fixture.scenario.service.transitionTask({ taskId: fixture.task.id, toPhase: 'DONE' })).rejects.toThrow();
    }
  );
});

async function createFixture(options: { primary?: boolean; ready?: boolean; comparisonAtHead?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-external-github-'));
  roots.push(root);
  const statePath = path.join(root, 'gh-state.json');
  const logPath = path.join(root, 'gh-log.jsonl');
  const ghPath = await writeNodeExecutable(root, 'gh', `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') process.stdout.write('gh version test\\n');
else if (args[0] === 'auth') process.stdout.write('authenticated\\n');
else {
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
  if (args[1] === 'list') process.stdout.write(typeof state.list === 'string' ? state.list : JSON.stringify(state.list));
  else if (args[1] === 'view') process.stdout.write(JSON.stringify(state.view));
  else if (args[1] === 'checks') process.stdout.write(JSON.stringify([{ name: 'tests', bucket: 'pass', state: 'SUCCESS' }]));
  else if (args[1] === 'create') process.stdout.write(state.view.url + '\\n');
  else process.exit(1);
}
`);
  const scenario = await scenarios.create({ ghPath });
  await externalGit(scenario.repositoryPath, ['branch', '-M', 'main']);
  const branchName = options.primary ? 'main' : 'external-work';
  const worktreePath = options.primary ? scenario.repositoryPath : path.join(scenario.rootDir, 'external-checkout');
  const base = await externalGit(scenario.repositoryPath, ['rev-parse', 'HEAD']);
  if (!options.primary) await externalGit(scenario.repositoryPath, ['worktree', 'add', '-b', branchName, worktreePath]);
  await externalGit(worktreePath, ['remote', 'add', 'origin', remoteUrl]);
  await fs.writeFile(path.join(worktreePath, 'change.txt'), 'initial external change\n');
  await externalGit(worktreePath, ['add', 'change.txt']);
  await externalGit(worktreePath, ['commit', '-m', 'External implementation']);
  const head = await externalGit(worktreePath, ['rev-parse', 'HEAD']);
  const { task } = await scenario.service.importTask({
    repositoryId: scenario.repositoryId, worktreePath, branchName,
    comparison: options.comparisonAtHead ? { type: 'COMMIT', ref: head }
      : options.primary ? { type: 'COMMIT', ref: base } : { type: 'MERGE_BASE', ref: 'main' },
    title: 'Deliver externally maintained work', readyForReview: options.ready ?? true,
    creationToken: randomUUID()
  });
  const worktree = (await scenario.store.getCurrentWorktree(task.id))!;
  const bare = path.join(root, 'destination.git');
  const otherBare = path.join(root, 'other-destination.git');
  await externalGit(root, ['init', '--bare', bare]);
  await externalGit(root, ['init', '--bare', otherBare]);
  const destinations = new Map([[remoteUrl, bare], [otherRemoteUrl, otherBare]]);
  const pr = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    number: 7, url: 'https://github.com/example/repo/pull/7', state: 'OPEN', isDraft: true,
    headRefName: branchName, headRefOid: head, headRepository: { name: 'repo' },
    headRepositoryOwner: { login: 'example' }, isCrossRepository: false, baseRefName: 'main',
    title: 'Existing work', reviewDecision: '', statusCheckRollup: [], ...overrides
  });
  const invocations = async (): Promise<string[][]> =>
    (await fs.readFile(logPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const fixture = {
    scenario, task, worktree, head, base, bare, otherBare, ghPath, github: new GitHubService(ghPath),
    pushes: [] as string[][],
    afterPush: undefined as (() => Promise<void>) | undefined,
    afterGh: undefined as ((args: readonly string[]) => Promise<void>) | undefined,
    pr,
    async respond(list: unknown, view = pr()) {
      await fs.writeFile(statePath, JSON.stringify({ list, view }));
    },
    invocations,
    async created() { return (await invocations()).some((args) => args[0] === 'pr' && args[1] === 'create'); },
    async commit(content: string) {
      await fs.writeFile(path.join(worktreePath, 'change.txt'), `${content}\n`);
      await externalGit(worktreePath, ['add', 'change.txt']);
      await externalGit(worktreePath, ['commit', '-m', content]);
    }
  };
  await fixture.respond([fixture.pr()]);
  const realGit = gitCli.git;
  // Keep production destination resolution intact, then execute pushes and
  // reconciliation only against these disposable bare repositories.
  vi.spyOn(gitCli, 'git').mockImplementation(async (cwd, args, options) => {
    if (args[0] !== 'push' && args[0] !== 'ls-remote') return realGit(cwd, args, options);
    const destinationIndex = args.findIndex((arg, index) => index > 0 && !arg.startsWith('-'));
    const destination = args[destinationIndex];
    const url = destinations.has(destination) ? destination : await externalGit(cwd, ['remote', 'get-url', ...(args[0] === 'push' ? ['--push'] : []), destination]);
    const local = destinations.get(url);
    if (!local) throw new Error(`Test refuses a network Git destination: ${destination}`);
    if (args[0] === 'push') fixture.pushes.push([...args]);
    const localArgs = [...args];
    localArgs[destinationIndex] = local;
    const result = await realGit(cwd, localArgs, options);
    if (args[0] === 'push') await fixture.afterPush?.();
    return result;
  });
  const realExec = ownedProcess.execFileOwnedPortable;
  vi.spyOn(ownedProcess, 'execFileOwnedPortable').mockImplementation(async (...args) => {
    const result = await realExec(...args);
    if (args[0] === ghPath) await fixture.afterGh?.(args[1]);
    return result;
  });
  return fixture;
}

async function externalGit(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}
