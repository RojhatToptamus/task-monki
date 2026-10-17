import type { PullRequestMergeMethod, PullRequestMergeOptions } from '../../shared/pullRequestActions';

/** What the repository allows when this pull request merges, readable by anyone who can read it. */
export const GITHUB_MERGE_OPTIONS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod
    defaultBranchRef { name }
    pullRequest(number: $number) { headRefName baseRefName isCrossRepository }
  }
}`;

export const GITHUB_THREAD_REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } }
}`;

export const GITHUB_RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

interface GitHubMergeOptionsData {
  repository?: {
    mergeCommitAllowed?: boolean;
    squashMergeAllowed?: boolean;
    rebaseMergeAllowed?: boolean;
    deleteBranchOnMerge?: boolean;
    viewerDefaultMergeMethod?: string;
    defaultBranchRef?: { name?: string } | null;
    pullRequest?: { headRefName?: string; baseRefName?: string; isCrossRepository?: boolean } | null;
  } | null;
}

// GitHub's own order in its merge button.
const GITHUB_METHODS: Array<[PullRequestMergeMethod, keyof NonNullable<GitHubMergeOptionsData['repository']>]> = [
  ['MERGE', 'mergeCommitAllowed'],
  ['SQUASH', 'squashMergeAllowed'],
  ['REBASE', 'rebaseMergeAllowed']
];

export function parseGitHubMergeOptions(data: GitHubMergeOptionsData | undefined): PullRequestMergeOptions {
  const repository = data?.repository;
  const pullRequest = repository?.pullRequest;
  if (!repository || !pullRequest) throw new Error('GitHub did not report how this pull request can merge.');
  const methods = GITHUB_METHODS.filter(([, field]) => repository[field] === true).map(([method]) => method);
  if (methods.length === 0) throw new Error('This repository allows no merge method.');
  const preferred = repository.viewerDefaultMergeMethod as PullRequestMergeMethod | undefined;
  const head = pullRequest.headRefName || undefined;
  return {
    methods,
    defaultMethod: preferred && methods.includes(preferred) ? preferred : methods[0]!,
    deletesBranchOnMerge: repository.deleteBranchOnMerge === true,
    canDeleteBranch: pullRequest.isCrossRepository === false && Boolean(head) && head !== repository.defaultBranchRef?.name,
    ...(head ? { head } : {}),
    ...(pullRequest.baseRefName ? { base: pullRequest.baseRefName } : {})
  };
}

/** A job of GitHub Actions named by a check's link, the only check log GitHub serves. */
export function gitHubActionsJob(link: string | undefined): { owner: string; name: string; job: number } | undefined {
  const match = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#].*)?$/u.exec(link ?? '');
  return match ? { owner: match[1]!, name: match[2]!, job: Number(match[3]) } : undefined;
}

/** A merge GitHub refused, in words that say what to do about it. */
export function gitHubMergeFailure(text: string): string {
  if (/\b409\b|head branch was modified|sha does not match/iu.test(text)) {
    return 'The pull request changed since Task Monki read it. Refresh, then merge.';
  }
  if (/\b405\b|not mergeable|required status|review.*required|protected branch/iu.test(text)) {
    const reason = /"message"\s*:\s*"([^"]{1,200})"/u.exec(text)?.[1] ?? /HTTP 405:\s*([^\n(]{1,200})/u.exec(text)?.[1];
    return reason ? `GitHub refused the merge: ${reason.trim().replace(/\.$/u, '')}.` : 'GitHub refused the merge.';
  }
  if (/\b403\b|must have (?:write|push)|not authorized|permission/iu.test(text)) {
    return 'The signed-in GitHub account cannot merge this pull request.';
  }
  return 'GitHub could not merge the pull request.';
}
