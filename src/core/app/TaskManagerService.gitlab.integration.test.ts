import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteWorkRef } from '../../shared/contracts';
import { git } from '../git/gitCli';
import { createFakeGitLab, type FakeGitLab } from '../../testSupport/fakeGitLab';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { TaskMonkiScenarioRegistry, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

const scenarios = new TaskMonkiScenarioRegistry();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await scenarios.dispose();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const project = { provider: 'GITLAB' as const, host: 'gitlab.com', path: 'group/sub/widgets' };

describe('TaskManagerService GitLab work', () => {
  it('opens a fork merge request at its exact head, maps its pipeline, and refuses to push to the fork', async () => {
    const { scenario, gitlab, root } = await gitlabScenario('task-monki-gitlab-fork-mr');
    await gitlab.fork('group/sub/widgets', 'contributor/widgets');
    const contributor = path.join(root, 'contributor');
    await git(root, ['clone', '--quiet', gitlab.barePath('contributor/widgets'), contributor]);
    const head = await commit(contributor, 'feature.txt', 'fork change\n', 'Add a fork change');
    await git(contributor, ['push', '--quiet', gitlab.barePath('contributor/widgets'), 'HEAD:refs/heads/feature']);
    await gitlab.setItem({
      project: 'group/sub/widgets', iid: 5, kind: 'MERGE_REQUEST', title: 'Add a fork change', description: 'From a fork.',
      sourceProject: 'contributor/widgets', sourceBranch: 'feature', targetBranch: 'main',
      jobs: [
        { name: 'unit', stage: 'test', status: 'failed' },
        { name: 'lint', stage: 'test', status: 'success' },
        { name: 'flaky', stage: 'test', status: 'failed', allow_failure: true }
      ],
      detailedMergeStatus: 'ci_must_pass'
    });
    const main = (await git(scenario.repositoryPath, ['rev-parse', 'main'])).trim();
    const ref: RemoteWorkRef = { repository: project, kind: 'PULL_REQUEST', number: 5 };

    const listing = await scenario.service.listRemoteWork({ repositoryId: scenario.repositoryId, kind: 'PULL_REQUEST' });
    expect(listing.items.map((item) => [item.ref.number, item.crossRepository])).toEqual([[5, true]]);
    const task = await scenario.service.openPullRequest({ repositoryId: scenario.repositoryId, pullRequest: ref });

    expect(task.remoteSource).toMatchObject({
      provider: 'GITLAB', kind: 'PULL_REQUEST', number: 5, url: 'https://gitlab.com/group/sub/widgets/-/merge_requests/5',
      pullRequest: { headSha: head, mergeBaseSha: main, crossRepository: true, headRepositoryPath: 'contributor/widgets', headRefName: 'feature' }
    });
    const worktree = (await scenario.store.getCurrentWorktree(task.id))!;
    expect((await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    const detail = await scenario.service.getTaskDetail(task.id);
    expect(detail.pullRequests[0]).toMatchObject({ number: 5, headRefOid: head, status: 'OPEN_READY' });
    expect(detail.ciRollups[0]).toMatchObject({ status: 'FAILING', failingCount: 1, passingCount: 1, skippedCount: 1, headSha: head });
    expect(detail.mergeSnapshots[0]).toMatchObject({ status: 'BLOCKED', headSha: head });
    expect((await scenario.service.openPullRequest({ repositoryId: scenario.repositoryId, pullRequest: ref })).id).toBe(task.id);
    await expect(scenario.service.createPullRequest({ taskId: task.id })).rejects.toThrow('comes from a fork');
  }, 60_000);

  it('creates one task per GitLab issue and opens a linked draft merge request', async () => {
    const { scenario, gitlab } = await gitlabScenario('task-monki-gitlab-issue');
    await gitlab.setItem({
      project: 'group/sub/widgets', iid: 3, kind: 'ISSUE', title: 'Crash on save', description: 'Saving twice crashes.',
      notes: [
        { author: 'reporter', body: 'Still happens.', created_at: '2026-10-02T10:00:00Z' },
        { author: 'bot', body: 'changed the description', created_at: '2026-10-02T11:00:00Z', system: true }
      ]
    });
    const issue: RemoteWorkRef = { repository: project, kind: 'ISSUE', number: 3 };
    const task = await scenario.service.createTask({
      title: '', prompt: '', repositoryId: scenario.repositoryId, issue,
      creationToken: 'gitlab-issue-token-0001', agentSettings: { model: 'scenario-model', reasoningEffort: 'low' }
    });
    expect(task.remoteSource).toMatchObject({ provider: 'GITLAB', kind: 'ISSUE', number: 3 });
    expect((await scenario.service.listRemoteWork({ repositoryId: scenario.repositoryId, kind: 'ISSUE', query: '#3' })).items[0])
      .toMatchObject({ existingTaskId: task.id });
    // A path without a host means the checkout's project of that path, even one that could be GitHub's.
    await gitlab.publish('team/app', scenario.repositoryPath);
    await git(scenario.repositoryPath, ['remote', 'add', 'team', gitlab.remoteUrl('team/app')]);
    await gitlab.setItem({ project: 'team/app', iid: 1, kind: 'ISSUE', title: 'Two segments' });
    expect((await scenario.service.listRemoteWork({ repositoryId: scenario.repositoryId, kind: 'ISSUE', query: 'team/app#1' })).items[0])
      .toMatchObject({ ref: { repository: { provider: 'GITLAB', path: 'team/app' }, number: 1 } });
    // On GitLab `#` names an issue, never a merge request.
    expect((await scenario.service.listRemoteWork({ repositoryId: scenario.repositoryId, kind: 'PULL_REQUEST', query: '#3' })).unavailable)
      .toMatchObject({ code: 'WRONG_KIND' });

    const worktree = await prepareTestWorktree(scenario.service, task.id);
    const run = await scenario.service.startRun({ taskId: task.id });
    const prompt = scenario.agent.startedTurns.at(-1)!.prompt;
    expect(prompt).toContain('Resolve GitLab issue group/sub/widgets#3. The issue is quoted in the linked context.');
    expect(prompt).toContain('@reporter at 2026-10-02T10:00:00Z:\nStill happens.');
    expect(prompt).not.toContain('changed the description');
    await fs.writeFile(path.join(worktree.worktreePath, 'fix.txt'), 'fixed\n');
    await scenario.completeRun(run.id, 'Fixed the crash.');

    const created = await scenario.service.createPullRequest({ taskId: task.id, title: 'Fix crash on save', closeIssue: true });
    expect(created).toMatchObject({ number: 1, status: 'OPEN_DRAFT', url: 'https://gitlab.com/group/sub/widgets/-/merge_requests/1' });
    const call = (await gitlab.calls()).find((candidate) => candidate.args.includes('POST'))!;
    expect(call.args).toEqual(expect.arrayContaining(['--raw-field', 'title=Draft: Fix crash on save', '--raw-field', `source_branch=${worktree.branchName}`]));
    expect(call.stdin).toMatch(/^## Summary\n\nCloses #3\n\n## Local evidence\n/u);
    expect(call.stdin).toContain('Created by Task Monki as a draft MR. Merge remains a human/GitLab decision.');
    expect(await gitlab.refSha('group/sub/widgets', `refs/heads/${worktree.branchName}`))
      .toBe((await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim());
  }, 60_000);
});

async function gitlabScenario(name: string): Promise<{ scenario: TaskMonkiScenario; gitlab: FakeGitLab; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-fake-gitlab-'));
  const gitlab = await createFakeGitLab(root);
  const previous = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = gitlab.sshCommand;
  cleanups.push(async () => {
    if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const scenario = await scenarios.create({ name, glabPath: gitlab.glabPath });
  await gitlab.publish('group/sub/widgets', scenario.repositoryPath);
  await git(scenario.repositoryPath, ['remote', 'add', 'origin', gitlab.remoteUrl('group/sub/widgets')]);
  return { scenario, gitlab, root };
}

async function commit(repositoryPath: string, file: string, content: string, message: string): Promise<string> {
  await fs.writeFile(path.join(repositoryPath, file), content);
  await git(repositoryPath, ['add', '-A']);
  await git(repositoryPath, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '--no-verify', '-m', message]);
  return (await git(repositoryPath, ['rev-parse', 'HEAD'])).trim();
}
