import type { AgentRunStatus, CodexReviewGateStatus, WorkflowPhase } from '../../shared/contracts';
import type { PrStatusKind } from './prStatus';

export type MascotState =
  | 'idle'
  | 'working'
  | 'watching-checks'
  | 'reviewing'
  | 'needs-you'
  | 'ready-for-review'
  | 'waiting'
  | 'done'
  | 'failed';

export const MASCOT_VIDEO_SOURCES: Record<MascotState, string> = {
  idle: 'assets/brand/videos/mascot-idle.webm',
  working: 'assets/brand/videos/mascot-working.webm',
  'watching-checks': 'assets/brand/videos/mascot-watching-checks.webm',
  reviewing: 'assets/brand/videos/mascot-reviewing.webm',
  'needs-you': 'assets/brand/videos/mascot-needs-you.webm',
  'ready-for-review': 'assets/brand/videos/mascot-ready-for-review.webm',
  waiting: 'assets/brand/videos/mascot-waiting.webm',
  done: 'assets/brand/videos/mascot-done.webm',
  failed: 'assets/brand/videos/mascot-failed.webm'
};

export interface MascotTaskStateInput {
  workflowPhase: WorkflowPhase;
  agentRun: AgentRunStatus | 'IDLE';
  reviewStatus: CodexReviewGateStatus;
  prStatusKind?: PrStatusKind;
  reviewActive?: boolean;
}

export function getMascotStateForTask(input: MascotTaskStateInput): MascotState {
  if (input.reviewActive || input.reviewStatus === 'RUNNING') {
    return 'reviewing';
  }

  if (input.workflowPhase === 'DONE') {
    return 'done';
  }

  if (input.agentRun === 'AWAITING_APPROVAL' || input.agentRun === 'AWAITING_USER_INPUT') {
    return 'needs-you';
  }

  if (
    input.workflowPhase === 'BLOCKED' ||
    input.workflowPhase === 'CANCELED' ||
    input.agentRun === 'FAILED' ||
    input.agentRun === 'RECOVERY_REQUIRED' ||
    input.agentRun === 'LOST'
  ) {
    return 'failed';
  }

  if (input.agentRun === 'INTERRUPTING' || input.agentRun === 'INTERRUPTED') {
    return 'waiting';
  }

  if (
    input.agentRun === 'QUEUED' ||
    input.agentRun === 'STARTING' ||
    input.agentRun === 'RUNNING' ||
    input.workflowPhase === 'IN_PROGRESS'
  ) {
    return 'working';
  }

  if (input.workflowPhase === 'REVIEW' || input.workflowPhase === 'IN_REVIEW') {
    return mascotStateFromReview(input.reviewStatus, input.prStatusKind);
  }

  return 'idle';
}

function mascotStateFromReview(
  status: CodexReviewGateStatus,
  prStatusKind: PrStatusKind | undefined
): MascotState {
  switch (status) {
    case 'NEEDS_CHANGES':
      return 'needs-you';
    case 'INCONCLUSIVE':
    case 'CANCELED':
    case 'STALE':
      return 'waiting';
    case 'FAILED':
      return 'failed';
    case 'PASSED':
    case 'NOT_RUN':
      return mascotStateFromPrStatusKind(prStatusKind) ?? 'ready-for-review';
    case 'RUNNING':
      return 'reviewing';
  }
}

function mascotStateFromPrStatusKind(kind: PrStatusKind | undefined): MascotState | undefined {
  switch (kind) {
    case 'CHECKS_FAILED':
    case 'BRANCH_DIVERGED':
    case 'CLOSED_UNMERGED':
      return 'failed';
    case 'GITHUB_CHANGES_REQUESTED':
      return 'needs-you';
    case 'CHECKS_PENDING':
      return 'watching-checks';
    case 'GITHUB_REVIEW_WAITING':
      return 'reviewing';
    case 'CHECKS_CANCELED':
    case 'STALE':
    case 'LOCAL_NOT_PUSHED':
    case 'PR_NEWER_COMMITS':
    case 'NO_REQUIRED_CHECKS':
    case 'READY_TO_MERGE':
    case 'MERGED':
      return 'waiting';
    default:
      return undefined;
  }
}
