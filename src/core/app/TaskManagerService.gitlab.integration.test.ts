import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePullRequestFeedback, type RemoteWorkRef } from '../../shared/contracts';
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
    // A required pipeline that failed is the checks' to state; the merge itself is not yet mergeable, not blocked.
    expect(detail.mergeSnapshots[0]).toMatchObject({ status: 'NOT_MERGED', headSha: head });
    expect((await scenario.service.openPullRequest({ repositoryId: scenario.repositoryId, pullRequest: ref })).id).toBe(task.id);
    await expect(scenario.service.createPullRequest({ taskId: task.id })).rejects.toThrow('comes from a fork');
  }, 60_000);

  it('reads merge request discussions and a reviewer\'s request for changes that GitLab reports behind the draft', async () => {
    const { scenario, gitlab, root } = await gitlabScenario('task-monki-gitlab-feedback');
    const teammate = path.join(root, 'teammate');
    await git(root, ['clone', '--quiet', gitlab.barePath('group/sub/widgets'), teammate]);
    await git(teammate, ['checkout', '--quiet', '-b', 'fix-save']);
    const head = await commit(teammate, 'save.js', 'export function save(layout) {\n  if (!layout) return null;\n  return JSON.stringify(layout);\n}\n', 'Guard');
    await git(teammate, ['push', '--quiet', gitlab.barePath('group/sub/widgets'), 'HEAD:refs/heads/fix-save']);
    await gitlab.setItem({
      project: 'group/sub/widgets', iid: 6, kind: 'MERGE_REQUEST', title: 'Guard an empty layout', draft: true,
      sourceBranch: 'fix-save', targetBranch: 'main',
      reviewers: [{ username: 'alice', state: 'requested_changes' }, { username: 'bob', state: 'unreviewed' }],
      discussions: [
        // System notes fill the first page; what people wrote comes after them.
        ...Array.from({ length: 100 }, (_, index) => ({
          id: index.toString(16).padStart(40, '0'), individualNote: true,
          notes: [{ id: 1000 + index, author: 'alice', body: 'changed this line', created_at: '2026-10-08T10:00:00Z', system: true }]
        })),
        { id: 'a'.repeat(40), path: 'save.js', newLine: 2, notes: [
          { id: 11, author: 'alice', body: 'Return undefined instead.', created_at: '2026-10-10T10:00:00Z' },
          { id: 12, author: 'lab-tester', body: 'Why?', created_at: '2026-10-10T11:00:00Z' }
        ] },
        { id: 'b'.repeat(40), path: 'save.js', newLine: 1, headSha: 'c'.repeat(40), notes: [
          { id: 13, author: 'alice', body: 'Rename this.', created_at: '2026-10-09T10:00:00Z' }
        ] },
        { id: 'd'.repeat(40), individualNote: true, notes: [{ id: 14, author: 'bob', body: 'Looks close.', created_at: '2026-10-10T12:00:00Z' }] },
        { id: 'e'.repeat(40), individualNote: true, notes: [{ id: 15, author: 'alice', body: 'requested changes', created_at: '2026-10-10T12:01:00Z', system: true }] }
      ]
    });
    const task = await scenario.service.openPullRequest({
      repositoryId: scenario.repositoryId, pullRequest: { repository: project, kind: 'PULL_REQUEST', number: 6 }
    });
    const detail = await scenario.service.getTaskDetail(task.id);
    // GitLab names the draft first; the reviewer's own state still says changes were requested.
    expect(detail.pullRequests[0]).toMatchObject({ number: 6, status: 'OPEN_DRAFT', headRefOid: head });
    expect(detail.reviewRollups[0]).toMatchObject({
      status: 'CHANGES_REQUESTED', reviewDecision: 'draft_status',
      feedback: { unresolvedCount: 2, discussionCount: 3, reviewers: [{ name: 'alice', state: 'CHANGES_REQUESTED' }, { name: 'bob', state: 'REQUESTED' }] }
    });
    // A draft is not mergeable yet, which is no block of its own.
    expect(detail.mergeSnapshots[0]).toMatchObject({ status: 'NOT_MERGED' });
    const feedback = parsePullRequestFeedback(await scenario.service.readArtifact({ artifactId: detail.reviewRollups[0]!.feedback!.artifactId }), 6)!;
    expect(feedback).toMatchObject({ provider: 'GITLAB', headSha: head, viewer: 'lab-tester' });
    expect(feedback.discussions).toEqual([
      expect.objectContaining({
        id: 'a'.repeat(40), kind: 'THREAD', path: 'save.js', side: 'NEW', line: 2, resolvable: true, resolved: false, outdated: false,
        url: 'https://gitlab.com/group/sub/widgets/-/merge_requests/6#note_11',
        comments: [expect.objectContaining({ author: 'alice' }), expect.objectContaining({ author: 'lab-tester', body: 'Why?' })]
      }),
      // Written on an earlier head: its lines changed since.
      expect.objectContaining({ id: 'b'.repeat(40), outdated: true, line: 1 }),
      expect.objectContaining({ id: 'd'.repeat(40), kind: 'COMMENT', resolvable: false })
    ]);
  }, 60_000);

  it('marks a merge request ready, answers its threads, reads a failed job, and merges the head it saw', async () => {
    const { scenario, gitlab, root } = await gitlabScenario('task-monki-gitlab-mr-loop');
    const teammate = path.join(root, 'teammate');
    await git(root, ['clone', '--quiet', gitlab.barePath('group/sub/widgets'), teammate]);
    await git(teammate, ['checkout', '--quiet', '-b', 'fix-save']);
    const head = await commit(teammate, 'save.js', 'export const save = (layout) => layout ?? undefined;\n', 'Guard');
    await git(teammate, ['push', '--quiet', gitlab.barePath('group/sub/widgets'), 'HEAD:refs/heads/fix-save']);
    await gitlab.setProjectSettings('group/sub/widgets', { squash_option: 'default_on' });
    const thread = 'f'.repeat(40);
    await gitlab.setItem({
      project: 'group/sub/widgets', iid: 8, kind: 'MERGE_REQUEST', title: 'Draft: Guard an empty layout', draft: true,
      sourceBranch: 'fix-save', targetBranch: 'main', forceRemoveSourceBranch: true, reviewers: [{ username: 'alice', state: 'requested_changes' }],
      jobs: [{ id: 41, name: 'unit', stage: 'test', status: 'failed' }],
      jobTraces: { '41': 'section_start:1700000000:step_script\r\u001b[0KRunning tests\n\u001b[31m1 failed\u001b[0m\nsection_end:1700000001:step_script\r\u001b[0K\n' },
      discussions: [{ id: thread, path: 'save.js', newLine: 1, notes: [{ id: 21, author: 'alice', body: 'Return undefined.', created_at: '2026-10-10T10:00:00Z' }] }]
    });
    const task = await scenario.service.openPullRequest({
      repositoryId: scenario.repositoryId, pullRequest: { repository: project, kind: 'PULL_REQUEST', number: 8 }
    });
    const mergeRequest = async () => (await gitlab.items()).find((item) => item.kind === 'MERGE_REQUEST' && item.iid === 8)!;

    // The job's trace without GitLab's section markers and colour codes.
    expect(await scenario.service.readPullRequestCheckLogs({ taskId: task.id })).toEqual([{
      name: 'test: unit', link: 'https://gitlab.com/group/sub/widgets/-/jobs/41', text: 'Running tests\n1 failed', truncated: false
    }]);

    // A failed job is retried where it ran.
    expect(await scenario.service.rerunPullRequestChecks({ taskId: task.id })).toEqual({ started: 1 });
    expect((await gitlab.calls()).some((call) => call.args.some((arg) => arg.endsWith('/jobs/41/retry')))).toBe(true);

    // GitLab marks a draft by its title, so ready is the title without the marker.
    await scenario.service.markPullRequestReady({ taskId: task.id });
    expect(await mergeRequest()).toMatchObject({ title: 'Guard an empty layout', draft: false });
    expect(await scenario.service.readPullRequestMergeOptions({ taskId: task.id })).toEqual({
      methods: ['SQUASH', 'MERGE'], defaultMethod: 'SQUASH', deletesBranchOnMerge: true, canDeleteBranch: true, head: 'fix-save', base: 'main'
    });

    expect(await scenario.service.replyToPullRequest({ taskId: task.id, replies: [{ discussionId: thread, body: 'Done.', resolve: true }], requestReviewFrom: [] }))
      .toEqual({ posted: 1, resolved: 1, requested: [], failed: [] });
    const answered = (await mergeRequest()).discussions![0]!;
    expect(answered.resolved).toBe(true);
    expect(answered.notes.at(-1)).toMatchObject({ author: 'lab-tester', body: 'Done.' });
    // A reply already notifies a GitLab reviewer; asking again is GitLab's own step.
    await expect(scenario.service.replyToPullRequest({ taskId: task.id, replies: [], requestReviewFrom: ['alice'] }))
      .rejects.toThrow('asked again on the platform');

    // The merge request deletes its branch itself, so the dialog offers no box and sends no choice.
    await scenario.service.mergePullRequest({ taskId: task.id, method: 'SQUASH', expectedHeadSha: head, deleteBranch: false });
    expect(await mergeRequest()).toMatchObject({ state: 'merged', mergedWith: { squash: true, removedBranch: true } });
    expect(await gitlab.refSha('group/sub/widgets', 'refs/heads/fix-save')).toBeUndefined();
    expect((await scenario.service.getTaskDetail(task.id)).task.workflowPhase).toBe('DONE');
  }, 90_000);

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
