import { describe, expect, it } from 'vitest';
import type { WorktreeRecord } from '../../shared/contracts';
import { parseMergeRequest } from './GitLabService';

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
  it('never reads a pipeline as no checks: without its jobs, the pipeline status is the evidence', () => {
    const failed = { ...mergeRequest, head_pipeline: { id: 3, sha: head, status: 'failed', web_url: 'https://gitlab.com/group/app/-/pipelines/3' } };
    // The jobs read failed, so there are none to list.
    expect(parseMergeRequest(failed, worktree, undefined, undefined).ci).toMatchObject({ status: 'FAILING', headSha: head });
    // A pipeline of trigger jobs only lists no jobs either.
    expect(parseMergeRequest(failed, worktree, undefined, []).ci.status).toBe('FAILING');
    // Only a merge request with no pipeline at all has no checks.
    expect(parseMergeRequest(mergeRequest, worktree, undefined, []).ci.status).toBe('NO_CHECKS');
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
