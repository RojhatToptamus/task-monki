import type {
  AgentReviewGateStatus,
  MergeStatus,
  Task,
  VerifiedChecksEvidence
} from '../../shared/contracts';
import {
  completionPolicyRequiresMerge,
  completionPolicyRequiresPassingChecks,
  verifiedChecksMatchMergeHead
} from '../../shared/contracts';
import { humanizeEnum } from './formatting';
import type { Tone } from './viewTypes';

export interface FinishEvidenceWarning {
  title: string;
  detail: string;
}

export interface FinishEvidenceState {
  mode: 'clean' | 'override' | 'blocked';
  warnings: FinishEvidenceWarning[];
}

export interface FinishRequirement {
  label: string;
  detail: string;
  tone: Tone;
  unresolved: boolean;
}

export interface MarkDoneModalCopy {
  title: string;
  body: string;
  fallbackWarningTitle: string;
  fallbackWarningDetail: string;
  confirmLabel: string;
}

export interface MarkDoneModalContext {
  hasPullRequest?: boolean;
}

export function taskReviewGate(
  task: Task
): NonNullable<Task['projection']['agentReview']> {
  return task.projection.agentReview ?? { status: 'NOT_RUN' };
}

export function getFinishEvidenceState(
  task: Task,
  reviewStatus: AgentReviewGateStatus = taskReviewGate(task).status,
  dirtyFileCount?: number,
  mergeStatus: MergeStatus = task.projection.merge,
  ciStatus: Task['projection']['ciChecks'] = task.projection.ciChecks,
  verifiedChecksEvidence?: VerifiedChecksEvidence
): FinishEvidenceState {
  const warnings = [
    reviewFinishWarning(reviewStatus),
    gitFinishWarning(task, dirtyFileCount)
  ].filter((warning): warning is FinishEvidenceWarning => Boolean(warning));
  const blockers = [
    mergeFinishBlocker(task, mergeStatus),
    verificationFinishBlocker(task, ciStatus, verifiedChecksEvidence)
  ].filter((warning): warning is FinishEvidenceWarning => Boolean(warning));

  if (blockers.length > 0) {
    return { mode: 'blocked', warnings: [...warnings, ...blockers] };
  }
  return { mode: warnings.length === 0 ? 'clean' : 'override', warnings };
}

export function finishRequirementsForTask(
  task: Task,
  reviewStatus: AgentReviewGateStatus = taskReviewGate(task).status,
  dirtyFileCount?: number,
  mergeStatus: MergeStatus = task.projection.merge,
  ciStatus: Task['projection']['ciChecks'] = task.projection.ciChecks,
  verifiedChecksEvidence?: VerifiedChecksEvidence
): FinishRequirement[] {
  const requirements = [
    reviewRequirement(reviewStatus),
    treeRequirement(task.projection.git, dirtyFileCount)
  ];
  if (completionPolicyRequiresMerge(task.completionPolicy)) {
    requirements.push(mergeRequirement(mergeStatus));
  }
  if (completionPolicyRequiresPassingChecks(task.completionPolicy)) {
    requirements.push(checksRequirement(ciStatus, verifiedChecksEvidence));
  }
  return requirements;
}

export function markDoneModalCopy(
  withIssues: boolean,
  busy: boolean,
  context: MarkDoneModalContext = {}
): MarkDoneModalCopy {
  const hasPullRequest = Boolean(context.hasPullRequest);
  return {
    title: withIssues ? 'Mark done anyway' : 'Mark done',
    body: markDoneModalBody(withIssues, hasPullRequest),
    fallbackWarningTitle: 'Evidence is not fully passing.',
    fallbackWarningDetail: 'You are explicitly marking the current local result done.',
    confirmLabel: busy ? 'Marking done...' : withIssues ? 'Mark done anyway' : 'Mark done'
  };
}

function markDoneModalBody(withIssues: boolean, hasPullRequest: boolean): string {
  if (withIssues) {
    return hasPullRequest
      ? 'Records this task as done in Task Monki. The existing PR is left unchanged, and these checks stay unresolved:'
      : 'Records the current local result as done. No commit or PR is created, and these checks stay unresolved:';
  }
  return hasPullRequest
    ? 'Records this task as done in Task Monki. The existing PR is left unchanged; no new commit or PR is created.'
    : 'Records the current local result as done without creating a commit or PR.';
}

function reviewFinishWarning(
  status: AgentReviewGateStatus
): FinishEvidenceWarning | undefined {
  if (status === 'PASSED') return undefined;
  if (status === 'STALE') {
    return {
      title: 'Review is stale.',
      detail: 'Run review again before marking done cleanly, or mark done anyway.'
    };
  }
  if (status === 'NEEDS_CHANGES') {
    return {
      title: 'Review requested changes.',
      detail: 'Request changes or mark the current result done as an owner override.'
    };
  }
  if (status === 'RUNNING') {
    return {
      title: 'Review is running.',
      detail: 'Wait for the review to finish before marking done cleanly.'
    };
  }
  if (status === 'FAILED' || status === 'INCONCLUSIVE' || status === 'CANCELED') {
    return {
      title: `Review is ${humanizeEnum(status).toLowerCase()}.`,
      detail: 'Run review again before marking done cleanly, or mark done anyway.'
    };
  }
  return {
    title: 'No passing review is recorded.',
    detail: 'Run review before marking done cleanly, or mark done anyway.'
  };
}

function gitFinishWarning(
  task: Task,
  dirtyFileCount?: number
): FinishEvidenceWarning | undefined {
  switch (task.projection.git) {
    case 'CLEAN':
    case 'COMMITTED_UNPUSHED':
    case 'PUSHED':
      return undefined;
    case 'DIRTY':
      return {
        title: 'Working tree is dirty.',
        detail:
          dirtyFileCount && dirtyFileCount > 0
            ? `${dirtyFileCount} uncommitted file${dirtyFileCount === 1 ? '' : 's'} remain. Commit or open a PR to share the work.`
            : 'Uncommitted changes remain. Commit or open a PR to share the work.'
      };
    case 'NOT_INSPECTED':
      return {
        title: 'Git evidence has not been inspected.',
        detail: 'Refresh evidence before marking done cleanly, or mark done anyway.'
      };
    case 'CONFLICTED':
    case 'DIVERGED':
    case 'UNAVAILABLE':
    case 'UNKNOWN':
      return {
        title: `Git state is ${humanizeEnum(task.projection.git).toLowerCase()}.`,
        detail: 'Resolve or refresh Git evidence before marking done cleanly, or mark done anyway.'
      };
  }
}

function mergeFinishBlocker(
  task: Task,
  mergeStatus: MergeStatus
): FinishEvidenceWarning | undefined {
  if (!completionPolicyRequiresMerge(task.completionPolicy) || mergeStatus === 'MERGED') {
    return undefined;
  }
  return {
    title: 'Pull request is not merged.',
    detail: 'This task requires a merged PR before it can be marked done.'
  };
}

function verificationFinishBlocker(
  task: Task,
  ciStatus: Task['projection']['ciChecks'],
  evidence?: VerifiedChecksEvidence
): FinishEvidenceWarning | undefined {
  if (!completionPolicyRequiresPassingChecks(task.completionPolicy)) return undefined;
  if (verifiedChecksMatchMergeHead({ ...evidence, ciStatus })) return undefined;
  return ciStatus === 'PASSING'
    ? {
        title: 'GitHub checks are not current.',
        detail:
          'This task requires passing GitHub checks for the merged PR head before it can be marked done.'
      }
    : {
        title: 'GitHub checks are not passing.',
        detail:
          'This task requires passing GitHub checks for the merged PR head before it can be marked done.'
      };
}

function reviewRequirement(status: AgentReviewGateStatus): FinishRequirement {
  switch (status) {
    case 'PASSED':
      return { label: 'Review', detail: 'passed', tone: 'success', unresolved: false };
    case 'NEEDS_CHANGES':
      return { label: 'Review', detail: 'needs changes', tone: 'error', unresolved: true };
    case 'RUNNING':
      return { label: 'Review', detail: 'running', tone: 'info', unresolved: true };
    case 'STALE':
      return { label: 'Review', detail: 'stale', tone: 'action', unresolved: true };
    case 'INCONCLUSIVE':
      return { label: 'Review', detail: 'inconclusive', tone: 'action', unresolved: true };
    case 'FAILED':
      return { label: 'Review', detail: 'failed', tone: 'error', unresolved: true };
    case 'CANCELED':
      return { label: 'Review', detail: 'stopped', tone: 'action', unresolved: true };
    case 'NOT_RUN':
      return { label: 'Review', detail: 'not run', tone: 'action', unresolved: true };
  }
}

function treeRequirement(
  status: Task['projection']['git'],
  dirtyFileCount?: number
): FinishRequirement {
  switch (status) {
    case 'CLEAN':
      return { label: 'Tree', detail: 'clean', tone: 'success', unresolved: false };
    case 'PUSHED':
      return { label: 'Tree', detail: 'pushed', tone: 'success', unresolved: false };
    case 'COMMITTED_UNPUSHED':
      return { label: 'Tree', detail: 'committed', tone: 'info', unresolved: false };
    case 'DIRTY':
      return {
        label: 'Tree',
        detail: dirtyFileCount && dirtyFileCount > 0 ? `${dirtyFileCount} dirty` : 'dirty',
        tone: 'action',
        unresolved: true
      };
    case 'CONFLICTED':
    case 'DIVERGED':
    case 'UNAVAILABLE':
      return {
        label: 'Tree',
        detail: humanizeEnum(status).toLowerCase(),
        tone: 'error',
        unresolved: true
      };
    case 'NOT_INSPECTED':
    case 'UNKNOWN':
      return {
        label: 'Tree',
        detail: humanizeEnum(status).toLowerCase(),
        tone: 'action',
        unresolved: true
      };
  }
}

function mergeRequirement(status: MergeStatus): FinishRequirement {
  switch (status) {
    case 'MERGED':
      return { label: 'Merge', detail: 'merged', tone: 'success', unresolved: false };
    case 'MERGEABLE':
      return { label: 'Merge', detail: 'ready, not merged', tone: 'action', unresolved: true };
    case 'COMPUTING':
      return { label: 'Merge', detail: 'checking', tone: 'info', unresolved: true };
    case 'QUEUED':
      return { label: 'Merge', detail: 'queued', tone: 'info', unresolved: true };
    case 'BLOCKED':
      return { label: 'Merge', detail: 'blocked', tone: 'error', unresolved: true };
    case 'CLOSED_UNMERGED':
      return { label: 'Merge', detail: 'closed unmerged', tone: 'error', unresolved: true };
    case 'NOT_APPLICABLE':
    case 'NOT_MERGED':
    case 'UNKNOWN':
      return {
        label: 'Merge',
        detail: humanizeEnum(status).toLowerCase(),
        tone: 'action',
        unresolved: true
      };
  }
}

function checksRequirement(
  status: Task['projection']['ciChecks'],
  evidence?: VerifiedChecksEvidence
): FinishRequirement {
  if (verifiedChecksMatchMergeHead({ ...evidence, ciStatus: status })) {
    return { label: 'Checks', detail: 'passing', tone: 'success', unresolved: false };
  }
  if (status === 'PASSING') {
    return { label: 'Checks', detail: 'not current', tone: 'action', unresolved: true };
  }
  if (status === 'FAILING' || status === 'BLOCKED') {
    return {
      label: 'Checks',
      detail: humanizeEnum(status).toLowerCase(),
      tone: 'error',
      unresolved: true
    };
  }
  if (status === 'PENDING') {
    return { label: 'Checks', detail: 'pending', tone: 'info', unresolved: true };
  }
  return {
    label: 'Checks',
    detail: humanizeEnum(status).toLowerCase(),
    tone: 'action',
    unresolved: true
  };
}
