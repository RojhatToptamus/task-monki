import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorktreeRecord } from '../../shared/contracts';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import { GitLabCli } from './GitLabCli';
import { GitLabService, parseMergeRequest } from './GitLabService';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const worktree: WorktreeRecord = {
  id: 'worktree-1', taskId: 'task-1', iterationId: 'iteration-1', repositoryId: 'repository-1', ownership: 'MANAGED',
  worktreePath: '/tmp/worktree', branchName: 'task/save', baseSha: 'b'.repeat(40), status: 'PRESENT',
  createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z'
};
const head = 'a'.repeat(40);
const mergeRequest = {
  iid: 7, web_url: 'https://gitlab.com/group/app/-/merge_requests/7', title: 'Save layouts', state: 'opened', draft: false,
  source_branch: 'task/save', target_branch: 'main', sha: head, detailed_merge_status: 'mergeable'
};

describe('parseMergeRequest', () => {
  it('reads the pipeline status that its listed jobs do not account for: never no checks, never passing while it failed or runs', () => {
    const pipeline = (status: string) => ({
      ...mergeRequest, head_pipeline: { id: 3, sha: head, status, web_url: 'https://gitlab.com/group/app/-/pipelines/3' }
    });
    // The jobs read failed, so there are none to list.
    expect(parseMergeRequest(pipeline('failed'), worktree, undefined, undefined).ci).toMatchObject({ status: 'FAILING', headSha: head });
    // A pipeline of trigger jobs only lists no jobs either.
    expect(parseMergeRequest(pipeline('failed'), worktree, undefined, []).ci.status).toBe('FAILING');
    // A trigger job, or a job past the first page, failed the pipeline while every listed job passed.
    const passed = [{ name: 'unit', stage: 'test', status: 'success' }, { name: 'lint', stage: 'test', status: 'success' }];
    const failed = parseMergeRequest(pipeline('failed'), worktree, undefined, passed).ci;
    expect(failed).toMatchObject({ status: 'FAILING', failingCount: 1, passingCount: 2 });
    expect(failed.checkDetails.find((check) => check.status === 'failed'))
      .toMatchObject({ name: 'Pipeline', link: 'https://gitlab.com/group/app/-/pipelines/3' });
    expect(parseMergeRequest(pipeline('running'), worktree, undefined, passed).ci).toMatchObject({ status: 'PENDING', pendingCount: 1, passingCount: 2 });
    // A listed job that reads as the pipeline does accounts for it: one failure counts once.
    expect(parseMergeRequest(pipeline('failed'), worktree, undefined, [...passed, { name: 'e2e', stage: 'test', status: 'failed' }]).ci)
      .toMatchObject({ status: 'FAILING', totalCount: 3, failingCount: 1 });
    // Only a merge request with no pipeline at all has no checks.
    expect(parseMergeRequest(mergeRequest, worktree, undefined, []).ci.status).toBe('NO_CHECKS');
  });

  it('reads the review from people, not from the merge state: approved once someone approves, and steady while GitLab\'s reason moves', () => {
    // A project without approval rules reports itself approved before anyone approved.
    const noRules = { approved: true, approvals_left: 0, approved_by: [] };
    expect(parseMergeRequest(mergeRequest, worktree, noRules, []).reviews.status).toBe('NOT_REQUESTED');
    expect(parseMergeRequest(mergeRequest, worktree, { ...noRules, approved_by: [{ user: { username: 'alice' } }] }, []).reviews.status)
      .toBe('APPROVED');
    // Waiting on an approval while GitLab's first reason moves on is one review reading, not one per reason.
    const waiting = { approved: false, approvals_left: 1, approved_by: [] };
    const [first, ...later] = ['checking', 'ci_still_running', 'not_approved'].map((reason) =>
      parseMergeRequest({ ...mergeRequest, detailed_merge_status: reason }, worktree, waiting, []).reviews);
    expect(first).toMatchObject({ status: 'REQUESTED' });
    for (const reading of later) expect(reading).toEqual(first);
  });

  it('keeps a merge request that is merging open, and its merged-results pipeline as evidence for its head', () => {
    const merging = parseMergeRequest({
      ...mergeRequest, state: 'locked',
      head_pipeline: { id: 4, sha: 'c'.repeat(40), ref: 'refs/merge-requests/7/merge', status: 'success' }
    }, worktree, undefined, [{ name: 'test', stage: 'test', status: 'success' }]);
    expect(merging.pullRequest.status).toBe('OPEN_READY');
    expect(merging.merge.status).not.toBe('CLOSED_UNMERGED');
    expect(merging.ci).toMatchObject({ status: 'PASSING', headSha: head });
  });
});

describe('GitLabService merge', () => {
  it('tells an account GitLab does not let merge from a sign-in it no longer accepts, though GitLab answers 401 to both', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-glab-merge-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const merge = async (signedIn: boolean) => new GitLabService(new GitLabCli(await fakeGlab(directory, signedIn)))
      .mergePullRequest({ ...worktree, worktreePath: directory }, { number: 7, url: mergeRequest.web_url }, { method: 'MERGE', expectedHeadSha: head });
    await expect(merge(true)).rejects.toThrow('The signed-in GitLab account cannot merge this merge request.');
    await expect(merge(false)).rejects.toThrow('GitLab CLI is not signed in to gitlab.com.');
  });
});

/** A glab that GitLab answers 401 for every request but the signed-in account's own. */
function fakeGlab(directory: string, signedIn: boolean): Promise<string> {
  return writeNodeExecutable(path.join(directory, signedIn ? 'signed-in' : 'signed-out'), 'glab', `
if (${JSON.stringify(signedIn)} && process.argv[3] === 'user') { process.stdout.write('{"username":"lab-tester"}'); process.exit(0); }
process.stdout.write('{"message":"401 Unauthorized"}');
process.stderr.write('glab: 401 Unauthorized (HTTP 401)\\n');
process.exit(1);
`);
}
