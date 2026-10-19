import type {
  AgentReviewGateStatus,
  MergeStatus,
  Task,
  VerifiedChecksEvidence
} from '../../shared/contracts';
import { effectiveReviewGateStatus } from '../../shared/agentReviewFindings';
import {
  completionPolicyRequiresMerge,
  completionPolicyRequiresPassingChecks,
  verifiedChecksMatchMergeHead
} from '../../shared/contracts';
import { humanizeEnum, pluralize } from './formatting';
import type { BugReplayGateProjection } from '../../shared/bugReplay';
import { bugReason } from '../../shared/bugReplayClaims';
import { describeBugStatus } from './bugReplay';
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
  /** The requirement as a plain fact, e.g. "Committed, not pushed". */
  fact: string;
  tone: Tone;
  unresolved: boolean;
}

export interface MarkDoneModalCopy {
  title: string;
  body: string;
  fallbackWarningTitle: string;
  fallbackWarningDetail: string;
  confirmLabel: string;
  /** The confirm button's label while marking runs. */
  pendingLabel: string;
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
  reviewStatus: AgentReviewGateStatus = effectiveReviewGateStatus(taskReviewGate(task)),
  dirtyFileCount?: number,
  mergeStatus: MergeStatus = task.projection.merge,
  ciStatus: Task['projection']['ciChecks'] = task.projection.ciChecks,
  verifiedChecksEvidence?: VerifiedChecksEvidence
): FinishEvidenceState {
  const warnings = [
    reviewFinishWarning(reviewStatus),
    gitFinishWarning(task, dirtyFileCount),
    // A recorded bug never blocks finishing; an unverified one makes done an override.
    bugFinishWarning(task.projection.bugReplay)
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
  reviewStatus: AgentReviewGateStatus = effectiveReviewGateStatus(taskReviewGate(task)),
  dirtyFileCount?: number,
  mergeStatus: MergeStatus = task.projection.merge,
  ciStatus: Task['projection']['ciChecks'] = task.projection.ciChecks,
  verifiedChecksEvidence?: VerifiedChecksEvidence,
  bugCurrencyPending = false
): FinishRequirement[] {
  const behaviour = bugFinishRequirement(task.projection.bugReplay, bugCurrencyPending);
  const requirements = [
    reviewRequirement(reviewStatus),
    ...(behaviour ? [behaviour] : []),
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
  context: MarkDoneModalContext = {}
): MarkDoneModalCopy {
  const hasPullRequest = Boolean(context.hasPullRequest);
  return {
    title: withIssues ? 'Mark done anyway' : 'Mark done',
    body: markDoneModalBody(withIssues, hasPullRequest),
    fallbackWarningTitle: 'Evidence is not fully passing.',
    fallbackWarningDetail: 'You are explicitly marking the current local result done.',
    confirmLabel: withIssues ? 'Mark done anyway' : 'Mark done',
    pendingLabel: 'Marking done…'
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
            ? `${pluralize(dirtyFileCount, 'uncommitted file')} remain. Commit or open a PR to share the work.`
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
      return { label: 'Review', fact: 'Agent review passed', tone: 'success', unresolved: false };
    case 'NEEDS_CHANGES':
      return { label: 'Review', fact: 'Agent review requested changes', tone: 'error', unresolved: true };
    case 'RUNNING':
      return { label: 'Review', fact: 'Agent review running', tone: 'info', unresolved: true };
    case 'STALE':
      return { label: 'Review', fact: 'Agent review out of date', tone: 'action', unresolved: true };
    case 'INCONCLUSIVE':
      return { label: 'Review', fact: 'Agent review inconclusive', tone: 'action', unresolved: true };
    case 'FAILED':
      return { label: 'Review', fact: 'Agent review failed', tone: 'error', unresolved: true };
    case 'CANCELED':
      return { label: 'Review', fact: 'Agent review stopped', tone: 'action', unresolved: true };
    case 'NOT_RUN':
      return { label: 'Review', fact: 'No agent review', tone: 'action', unresolved: true };
  }
}

function treeRequirement(
  status: Task['projection']['git'],
  dirtyFileCount?: number
): FinishRequirement {
  switch (status) {
    case 'CLEAN':
      return { label: 'Tree', fact: 'No uncommitted changes', tone: 'success', unresolved: false };
    case 'PUSHED':
      return { label: 'Tree', fact: 'Pushed', tone: 'success', unresolved: false };
    case 'COMMITTED_UNPUSHED':
      return { label: 'Tree', fact: 'Committed, not pushed', tone: 'info', unresolved: false };
    case 'DIRTY':
      return {
        label: 'Tree',
        fact: dirtyFileCount && dirtyFileCount > 0
          ? `${dirtyFileCount} uncommitted ${dirtyFileCount === 1 ? 'file' : 'files'}`
          : 'Uncommitted changes',
        tone: 'action',
        unresolved: true
      };
    case 'CONFLICTED':
    case 'DIVERGED':
    case 'UNAVAILABLE':
      return {
        label: 'Tree',
        fact: status === 'CONFLICTED' ? 'Git conflicts' : status === 'DIVERGED' ? 'Branch diverged' : 'Git unavailable',
        tone: 'error',
        unresolved: true
      };
    case 'NOT_INSPECTED':
    case 'UNKNOWN':
      return {
        label: 'Tree',
        fact: status === 'NOT_INSPECTED' ? 'Git not checked yet' : 'Git state unknown',
        tone: 'action',
        unresolved: true
      };
  }
}

function mergeRequirement(status: MergeStatus): FinishRequirement {
  switch (status) {
    case 'MERGED':
      return { label: 'Merge', fact: 'Merged', tone: 'success', unresolved: false };
    case 'MERGEABLE':
      return { label: 'Merge', fact: 'Ready to merge', tone: 'action', unresolved: true };
    case 'COMPUTING':
      return { label: 'Merge', fact: 'Checking mergeability', tone: 'info', unresolved: true };
    case 'QUEUED':
      return { label: 'Merge', fact: 'In the merge queue', tone: 'info', unresolved: true };
    case 'BLOCKED':
      return { label: 'Merge', fact: 'Merge blocked', tone: 'error', unresolved: true };
    case 'CLOSED_UNMERGED':
      return { label: 'Merge', fact: 'PR closed without merge', tone: 'error', unresolved: true };
    case 'NOT_APPLICABLE':
    case 'NOT_MERGED':
    case 'UNKNOWN':
      return {
        label: 'Merge',
        fact: 'Not merged',
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
    return { label: 'Checks', fact: 'Checks passed', tone: 'success', unresolved: false };
  }
  if (status === 'PASSING') {
    return { label: 'Checks', fact: 'Checks passed on an older head', tone: 'action', unresolved: true };
  }
  if (status === 'FAILING' || status === 'BLOCKED') {
    return {
      label: 'Checks',
      fact: status === 'FAILING' ? 'Checks failed' : 'Checks blocked',
      tone: 'error',
      unresolved: true
    };
  }
  if (status === 'PENDING') {
    return { label: 'Checks', fact: 'Checks running', tone: 'info', unresolved: true };
  }
  return {
    label: 'Checks',
    fact: 'Checks not verified',
    tone: 'action',
    unresolved: true
  };
}

/** Facts that bear on finishing, as the finish checklist's Behaviour row states them. */
function bugFinishRequirement(
  gate: BugReplayGateProjection | undefined,
  currencyPending: boolean
): FinishRequirement | undefined {
  if (!gate?.versionId) return undefined;
  if (currencyPending && gate.state === 'FIX_VERIFIED') {
    return { label: 'Bug', fact: 'Checking current files', tone: 'info', unresolved: true };
  }
  const status = describeBugStatus(gate);
  if (gate.state === 'FIX_VERIFIED') return { label: 'Bug', fact: status.word, tone: 'success', unresolved: false };
  return { label: 'Bug', fact: status.word, tone: status.tone === 'neutral' ? 'action' : status.tone, unresolved: true };
}

/** What Mark done anyway lists for a bug that is not verified fixed. */
function bugFinishWarning(gate: BugReplayGateProjection | undefined): FinishEvidenceWarning | undefined {
  if (!gate?.versionId || gate.state === 'FIX_VERIFIED') return undefined;
  const word = describeBugStatus(gate).word;
  switch (gate.state) {
    case 'STILL_FAILING':
      return { title: 'The recorded bug still fails.', detail: bugReason(gate) ?? `${gate.title} failed on the current code.` };
    case 'STALE':
      return { title: 'The fix verification is out of date.', detail: 'The code changed after the bug was checked.' };
    case 'VERIFYING':
    case 'REPRODUCING':
      return { title: `${word}.`, detail: 'The clean runs have not finished.' };
    default:
      return { title: 'The fix is not verified.', detail: bugReason(gate) ?? `${gate.title}: ${word.toLowerCase()}.` };
  }
}
