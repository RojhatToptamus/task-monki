/**
 * What a person can do to a pull or merge request from Task Monki beyond
 * creating it and pushing to it: mark it ready, merge it, answer its reviewers,
 * and read why its checks failed. Every write is the person's explicit step;
 * nothing here runs on its own or on an agent's behalf.
 */

/** How a pull or merge request lands on its base. */
export const PULL_REQUEST_MERGE_METHODS = ['SQUASH', 'MERGE', 'REBASE'] as const;
export type PullRequestMergeMethod = (typeof PULL_REQUEST_MERGE_METHODS)[number];

/** What the platform lets this pull request do when it merges. */
export interface PullRequestMergeOptions {
  /** The methods the repository allows, in the platform's order; never empty. */
  methods: PullRequestMergeMethod[];
  /** The method the platform offers first. */
  defaultMethod: PullRequestMergeMethod;
  /** The platform deletes the branch itself after a merge. */
  deletesBranchOnMerge: boolean;
  /** The branch lives in the same repository and is not its default, so it can be deleted with the merge. */
  canDeleteBranch: boolean;
  /** The branch that merges, and the base it merges into. */
  head?: string;
  base?: string;
}

export interface ReadPullRequestMergeOptionsRequest {
  taskId: string;
}

export interface MergePullRequestRequest {
  taskId: string;
  method: PullRequestMergeMethod;
  /** The head the person saw; the platform refuses the merge when the pull request moved since. */
  expectedHeadSha: string;
  /** Delete the branch after the merge, when it can be deleted. */
  deleteBranch: boolean;
}

export interface MarkPullRequestReadyRequest {
  taskId: string;
}

export const PULL_REQUEST_REPLY_BODY_LIMIT = 4_000;
export const PULL_REQUEST_REPLIES_LIMIT = 50;

/** One answer to a discussion, posted as the signed-in person. */
export interface PullRequestReply {
  discussionId: string;
  body: string;
  /** Resolve the thread after the reply lands; only a resolvable, open thread can be resolved. */
  resolve: boolean;
}

export interface ReplyToPullRequestRequest {
  taskId: string;
  replies: PullRequestReply[];
  /** Reviewers to ask for another review, by the names the feedback reading gave. */
  requestReviewFrom: string[];
}

export interface ReplyToPullRequestResult {
  posted: number;
  resolved: number;
  /** Reviewers the platform was asked to review again. */
  requested: string[];
  /** What the platform refused, by discussion or reviewer, with its reason. */
  failed: Array<{
    discussionId?: string;
    reviewer?: string;
    error: string;
    /** The reply itself landed; only resolving its thread failed. */
    replied?: boolean;
  }>;
}

/**
 * Commits the worktree lacks, fetched for the agent to merge: the pull
 * request's own newer commits, or its base that moved ahead. The agent runs
 * without network, so Task Monki fetches them first.
 */
export interface FetchPullRequestUpdateRequest {
  taskId: string;
  from: 'PULL_REQUEST' | 'BASE';
}

export interface PullRequestUpdate {
  /** The commit to merge, present in the checkout's objects. */
  sha: string;
  /** What it is, as the request names it: the base branch, or the pull request's branch. */
  ref: string;
  /** Commits it has that the worktree does not. */
  commits: number;
}

export interface ReadPullRequestCheckLogsRequest {
  taskId: string;
}

/** The end of a failing check's log, as plain text. */
export interface PullRequestCheckLog {
  name: string;
  link?: string;
  text: string;
  /** Earlier lines were left out. */
  truncated: boolean;
}

/**
 * Git states in which a worktree holds work its pull request does not:
 * uncommitted, committed but not pushed, diverged, or mid-conflict. A merge
 * would leave that work behind, so it neither merges nor completes a task.
 */
export const UNSHIPPED_GIT_STATUSES: ReadonlySet<string> = new Set(['DIRTY', 'COMMITTED_UNPUSHED', 'DIVERGED', 'CONFLICTED']);

export const CHECK_LOG_LIMITS = {
  /** Failing checks read per request. */
  checks: 3,
  lines: 150,
  chars: 10_000
} as const;

/**
 * Why a platform holds a pull request back on its base, from the merge state
 * it reported: GitHub's `mergeStateStatus` and `mergeable`, or GitLab's
 * `detailed_merge_status`. Anything else is not a base that moved.
 */
export function baseMovedReason(raw: unknown): 'BEHIND' | 'CONFLICTS' | undefined {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const state = typeof record.mergeStateStatus === 'string' ? record.mergeStateStatus.toUpperCase() : '';
  const gitLab = typeof record.detailed_merge_status === 'string' ? record.detailed_merge_status : '';
  const conflicting = typeof record.mergeable === 'string' && record.mergeable.toUpperCase() === 'CONFLICTING';
  if (state === 'BEHIND' || gitLab === 'need_rebase') return 'BEHIND';
  if (state === 'DIRTY' || conflicting || gitLab === 'conflict') return 'CONFLICTS';
  return undefined;
}

// Terminal colour and cursor sequences, GitLab's collapsible section markers,
// and the timestamp GitHub Actions puts before every line.
const ANSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu;
const GITLAB_SECTION = /section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?\r?/gu;
const ACTIONS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u;
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‍⁠-⁤﻿‪-‮⁦-⁩\u{E0000}-\u{E007F}]/gu;

/**
 * Bounds a failing check's log to its end, as the text a terminal would show.
 * A log that marks its error (GitHub's `##[error]`) ends just after the last
 * one, so the cleanup steps that follow a failure do not crowd it out.
 */
export function boundCheckLog(raw: string): { text: string; truncated: boolean } {
  // Only the end is shown, so only the end is cleaned: a job's full log can run to megabytes.
  let truncated = raw.length > RAW_TAIL_CHARS;
  const start = raw.length - RAW_TAIL_CHARS;
  const tail = truncated ? raw.slice(raw.indexOf('\n', start) >= 0 ? raw.indexOf('\n', start) + 1 : start) : raw;
  const marked = tail
    .replace(ANSI_SEQUENCE, '')
    .replace(GITLAB_SECTION, '')
    .split('\n')
    // A carriage return redraws the line; what a terminal shows is the last draw.
    .map((line) => line.slice(line.lastIndexOf('\r', line.length - 2) + 1).replace(/\r$/u, ''))
    .map((line) => line.replace(ACTIONS_TIMESTAMP, '').replace(INVISIBLE, '').trimEnd())
    .flatMap((line) => actionsLine(line));
  let lines = marked.map((line) => line.text);
  let lastError = -1;
  marked.forEach((line, index) => { if (line.error) lastError = index; });
  // What follows the last error is the job cleaning up; leaving it out drops no earlier line.
  if (lastError >= 0) lines = lines.slice(0, lastError + 1 + ERROR_CONTEXT_AFTER);
  while (lines.length > 0 && !lines.at(-1)) lines.pop();
  truncated = truncated || lines.length > CHECK_LOG_LIMITS.lines;
  let text = lines.slice(-CHECK_LOG_LIMITS.lines).join('\n');
  if (text.length > CHECK_LOG_LIMITS.chars) {
    const cut = text.slice(-CHECK_LOG_LIMITS.chars);
    text = cut.slice(cut.indexOf('\n') + 1);
    truncated = true;
  }
  return { text, truncated };
}

// The last marked error ends the step that failed; what follows is the job cleaning up.
const ERROR_CONTEXT_AFTER = 0;
// Far more than the lines kept, so a cut here never reaches what is shown.
const RAW_TAIL_CHARS = 1_000_000;

/** GitHub Actions' workflow commands, in the words its log viewer shows; only its own error marks are errors. */
function actionsLine(line: string): Array<{ text: string; error?: boolean }> {
  const command = /^##\[(group|endgroup|error|warning|notice|debug|command)\](.*)$/u.exec(line);
  if (!command) return [{ text: line }];
  switch (command[1]) {
    case 'endgroup':
    case 'debug':
      return [];
    case 'error':
      return [{ text: `Error: ${command[2]}`, error: true }];
    case 'warning':
      return [{ text: `Warning: ${command[2]}` }];
    case 'notice':
      return [{ text: `Notice: ${command[2]}` }];
    default:
      return [{ text: command[2]! }];
  }
}

/** Checks a merge request as the renderer sends it; throws on anything else. */
export function assertMergePullRequestRequest(value: unknown): asserts value is MergePullRequestRequest {
  const record = isRecord(value) ? value : fail('The merge request is not valid.');
  if (!(PULL_REQUEST_MERGE_METHODS as readonly unknown[]).includes(record.method)) fail('Choose how to merge.');
  if (typeof record.expectedHeadSha !== 'string' || !/^[0-9a-f]{7,64}$/u.test(record.expectedHeadSha)) {
    fail('The merge request is not valid.');
  }
  if (typeof record.deleteBranch !== 'boolean' || typeof record.taskId !== 'string') fail('The merge request is not valid.');
}

/** Checks replies as the renderer sends them; throws on anything else. */
export function assertReplyToPullRequestRequest(value: unknown): asserts value is ReplyToPullRequestRequest {
  const record = isRecord(value) ? value : fail('The replies are not valid.');
  if (typeof record.taskId !== 'string') fail('The replies are not valid.');
  if (!Array.isArray(record.replies) || record.replies.length > PULL_REQUEST_REPLIES_LIMIT) fail('The replies are not valid.');
  if (!Array.isArray(record.requestReviewFrom) || record.requestReviewFrom.some((name) => typeof name !== 'string' || !name.trim())) {
    fail('The reviewers are not valid.');
  }
  if (record.replies.length === 0 && record.requestReviewFrom.length === 0) fail('Nothing to post.');
  const seen = new Set<string>();
  for (const reply of record.replies as unknown[]) {
    if (!isRecord(reply) || typeof reply.discussionId !== 'string' || !reply.discussionId || seen.has(reply.discussionId)) {
      fail('The replies are not valid.');
    }
    seen.add(reply.discussionId as string);
    if (typeof reply.body !== 'string' || !reply.body.trim()) fail('Write each reply first.');
    if ((reply.body as string).length > PULL_REQUEST_REPLY_BODY_LIMIT) fail(`A reply is longer than ${PULL_REQUEST_REPLY_BODY_LIMIT} characters.`);
    if (typeof reply.resolve !== 'boolean') fail('The replies are not valid.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}
