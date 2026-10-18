import {
  PULL_REQUEST_FEEDBACK_LIMITS,
  boundPullRequestFeedback,
  type PullRequestFeedback,
  type PullRequestReviewer,
  type PullRequestReviewerState,
  type RawPullRequestDiscussion
} from '../../shared/pullRequestFeedback';

/** How many conversation comments are read, most recent first. */
const CONVERSATION_COMMENTS = 30;
const COMMENT_FIELDS = 'id body createdAt url isMinimized author { login }';
const REVIEW_FIELDS = 'id state body submittedAt url author { __typename login }';

/**
 * One read of everything people said on a pull request. A thread keeps its
 * first comment and its most recent replies, so a long thread still shows
 * what it is about and where it ended.
 */
const THREAD_FIELDS = `id isResolved isOutdated path line startLine originalLine originalStartLine diffSide startDiffSide subjectType
          first: comments(first: 1) { totalCount nodes { ${COMMENT_FIELDS} } }
          recent: comments(last: ${PULL_REQUEST_FEEDBACK_LIMITS.comments - 1}) { nodes { ${COMMENT_FIELDS} } }`;

/** Review threads are read a page at a time, up to this many pages. */
export const GITHUB_THREAD_PAGES = 5;

export const GITHUB_FEEDBACK_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_FIELDS} }
      }
      latestReviews(first: ${PULL_REQUEST_FEEDBACK_LIMITS.reviewers}) { nodes { ${REVIEW_FIELDS} } }
      latestOpinionatedReviews(first: ${PULL_REQUEST_FEEDBACK_LIMITS.reviewers}) { nodes { ${REVIEW_FIELDS} } }
      reviewRequests(first: ${PULL_REQUEST_FEEDBACK_LIMITS.reviewers}) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } }
      }
      comments(last: ${CONVERSATION_COMMENTS}) { totalCount nodes { id body createdAt url isMinimized author { __typename login } } }
    }
  }
}`;

/** The next page of a pull request's review threads. */
export const GITHUB_THREADS_PAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_FIELDS} }
      }
    }
  }
}`;

interface GitHubFeedbackComment {
  id?: string;
  body?: string;
  createdAt?: string;
  url?: string;
  isMinimized?: boolean;
  author?: { __typename?: string; login?: string } | null;
}

interface GitHubFeedbackReview {
  id?: string;
  state?: string;
  body?: string;
  submittedAt?: string | null;
  url?: string;
  author?: { __typename?: string; login?: string } | null;
}

interface GitHubReviewThread {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string;
  line?: number | null;
  startLine?: number | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
  diffSide?: string;
  startDiffSide?: string | null;
  subjectType?: string;
  first?: { totalCount?: number; nodes?: Array<GitHubFeedbackComment | null> } | null;
  recent?: { nodes?: Array<GitHubFeedbackComment | null> } | null;
}

export interface GitHubThreadConnection {
  totalCount?: number;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: Array<GitHubReviewThread | null>;
}

export interface GitHubFeedbackData {
  viewer?: { login?: string } | null;
  repository?: {
    pullRequest?: {
      headRefOid?: string;
      reviewThreads?: GitHubThreadConnection | null;
      latestReviews?: { nodes?: Array<GitHubFeedbackReview | null> } | null;
      latestOpinionatedReviews?: { nodes?: Array<GitHubFeedbackReview | null> } | null;
      reviewRequests?: {
        nodes?: Array<{ requestedReviewer?: { __typename?: string; login?: string; name?: string } | null } | null>;
      } | null;
      comments?: { totalCount?: number; nodes?: Array<GitHubFeedbackComment | null> } | null;
    } | null;
  } | null;
}

/** The repository and number a pull request URL names, as GitHub writes it. */
export function gitHubPullRequestLocation(url: string | undefined): { host: string; owner: string; name: string; number: number } | undefined {
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/u.exec(url ?? '');
  return match ? { host: match[1]!, owner: match[2]!, name: match[3]!, number: Number(match[4]) } : undefined;
}

const REVIEW_STATES = new Set(['CHANGES_REQUESTED', 'APPROVED', 'COMMENTED']);

/**
 * Review threads, review summaries and conversation comments, bounded. A
 * comment a maintainer minimized (spam, off-topic, outdated) is left out, and
 * so is a bot's comment on the conversation, such as a deployment or coverage
 * report; a bot's review threads are kept, since those are reviews.
 */
export function parseGitHubPullRequestFeedback(data: GitHubFeedbackData, number: number, capturedAt: string): PullRequestFeedback | undefined {
  const pullRequest = data.repository?.pullRequest;
  if (!pullRequest) return undefined;
  const threadConnection = pullRequest.reviewThreads;
  const threads = (threadConnection?.nodes ?? []).flatMap((thread): RawPullRequestDiscussion[] => {
    if (!thread?.id) return [];
    const seen = new Set<string>();
    const comments = [...(thread.first?.nodes ?? []), ...(thread.recent?.nodes ?? [])]
      .filter((comment): comment is GitHubFeedbackComment => Boolean(comment) && !comment!.isMinimized)
      .filter((comment) => !comment.id || (!seen.has(comment.id) && Boolean(seen.add(comment.id))));
    const fileLevel = thread.subjectType === 'FILE';
    const outdated = thread.isOutdated === true;
    // An outdated thread has no line in the current diff; it keeps the one it was written on.
    const end = fileLevel ? undefined : positive(outdated ? thread.originalLine : thread.line ?? thread.originalLine);
    const start = fileLevel ? undefined : positive(outdated ? thread.originalStartLine : thread.startLine);
    const range = start !== undefined && end !== undefined && start < end &&
      (!thread.startDiffSide || thread.startDiffSide === thread.diffSide);
    return [{
      id: thread.id,
      kind: 'THREAD',
      ...(thread.path ? { path: thread.path } : {}),
      ...(end !== undefined ? { side: thread.diffSide === 'LEFT' ? 'OLD' as const : 'NEW' as const, line: range ? start! : end, ...(range ? { endLine: end } : {}) } : {}),
      resolvable: true,
      resolved: thread.isResolved === true,
      outdated,
      ...(httpsUrl(comments[0]?.url) ? { url: comments[0]!.url } : {}),
      comments: comments.map(feedbackComment),
      commentCount: thread.first?.totalCount ?? comments.length
    }];
  });

  // A reviewer's verdict outlives their later comments; a fresh request supersedes both.
  const reviewers = new Map<string, PullRequestReviewerState>();
  // Apps review too, such as Copilot or a CI bot; GitHub never takes a review request for one.
  const bots = new Set<string>();
  const reviewDiscussions = new Map<string, RawPullRequestDiscussion>();
  for (const review of [...(pullRequest.latestReviews?.nodes ?? []), ...(pullRequest.latestOpinionatedReviews?.nodes ?? [])]) {
    const login = review?.author?.login;
    if (!review || !REVIEW_STATES.has(review.state ?? '')) continue;
    const state = review.state as 'CHANGES_REQUESTED' | 'APPROVED' | 'COMMENTED';
    if (login && (state !== 'COMMENTED' || !reviewers.has(login))) reviewers.set(login, state);
    if (login && review.author?.__typename === 'Bot') bots.add(login);
    if (review.id && review.body?.trim() && !reviewDiscussions.has(review.id)) {
      reviewDiscussions.set(review.id, {
        id: review.id,
        kind: 'REVIEW',
        resolvable: false,
        resolved: false,
        outdated: false,
        reviewState: state,
        ...(httpsUrl(review.url) ? { url: review.url } : {}),
        comments: [{ ...(login ? { author: login } : {}), ...(review.submittedAt ? { createdAt: review.submittedAt } : {}), body: review.body }]
      });
    }
  }
  for (const request of pullRequest.reviewRequests?.nodes ?? []) {
    const reviewer = request?.requestedReviewer;
    const name = reviewer?.__typename === 'Team' ? reviewer.name : reviewer?.login;
    if (name) reviewers.set(name, 'REQUESTED');
    if (name && reviewer?.__typename === 'Bot') bots.add(name);
  }

  const conversation = pullRequest.comments;
  const comments = (conversation?.nodes ?? []).flatMap((comment): RawPullRequestDiscussion[] =>
    comment?.id && !comment.isMinimized && comment.author?.__typename !== 'Bot' ? [{
      id: comment.id,
      kind: 'COMMENT',
      resolvable: false,
      resolved: false,
      outdated: false,
      ...(httpsUrl(comment.url) ? { url: comment.url } : {}),
      comments: [feedbackComment(comment)]
    }] : []);

  return boundPullRequestFeedback({
    provider: 'GITHUB',
    number,
    ...(pullRequest.headRefOid ? { headSha: pullRequest.headRefOid } : {}),
    capturedAt,
    ...(data.viewer?.login ? { viewer: data.viewer.login } : {}),
    reviewers: [...reviewers].map(([name, state]): PullRequestReviewer => ({ name, state, ...(bots.has(name) ? { bot: true } : {}) })),
    discussions: [...threads, ...reviewDiscussions.values(), ...comments],
    truncated: (threadConnection?.totalCount ?? 0) > threads.length ||
      (conversation?.totalCount ?? 0) > (conversation?.nodes?.length ?? 0)
  });
}

function feedbackComment(comment: GitHubFeedbackComment): RawPullRequestDiscussion['comments'][number] {
  return {
    ...(comment.author?.login ? { author: comment.author.login } : {}),
    ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
    body: comment.body ?? ''
  };
}

function positive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function httpsUrl(value: string | undefined): value is string {
  return typeof value === 'string' && /^https:\/\//u.test(value);
}
