import { getImplementationRetryReason, type Task } from '../../shared/contracts';
import { isImplementationOutcomeBlocked } from './nextAction';

export type TaskAttentionTone = 'warning' | 'error' | 'info';

export interface TaskAttentionDescriptor {
  label: string;
  detail: string;
  tone: TaskAttentionTone;
}

const IN_FLIGHT_RUNS = new Set<Task['projection']['agentRun']>([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
]);

/**
 * The most urgent child state for a task, used to drive the "Needs you" inbox,
 * decision banners, and card chips. Returns undefined when nothing is blocked.
 */
export function describeTaskAttention(
  task: Task
): TaskAttentionDescriptor | undefined {
  if (isImplementationOutcomeBlocked(task)) {
    return {
      label: 'Needs retry',
      detail:
        getImplementationRetryReason(task) ??
        'Retry or continue the implementation before review.',
      tone: 'warning'
    };
  }
  switch (task.projection.agentRun) {
    case 'AWAITING_APPROVAL':
      return {
        label: 'Needs approval',
        detail: 'Provider is blocked on a permission decision.',
        tone: 'warning'
      };
    case 'AWAITING_USER_INPUT':
      return {
        label: 'Needs input',
        detail: 'Provider is waiting for answers from you.',
        tone: 'warning'
      };
    case 'RECOVERY_REQUIRED':
      return {
        label: 'Recovery required',
        detail: 'Runtime state is ambiguous; inspect recovery details.',
        tone: 'error'
      };
    case 'LOST':
      return {
        label: 'Runtime lost',
        detail: 'Task Monki cannot prove the final provider state.',
        tone: 'error'
      };
    case 'FAILED':
      return {
        label: 'Run failed',
        detail: 'Retry or continue the implementation before review.',
        tone: 'error'
      };
  }

  if (task.workflowPhase === 'BLOCKED' || task.projection.health === 'BLOCKED') {
    return {
      label: 'Blocked',
      detail: task.projection.summary,
      tone: 'error'
    };
  }

  const deliveryAttention = describeDeliveryAttention(task);
  if (deliveryAttention) {
    return deliveryAttention;
  }

  if (task.projection.health === 'ERROR') {
    return {
      label: 'Error',
      detail: task.projection.summary,
      tone: 'error'
    };
  }

  return undefined;
}

function describeDeliveryAttention(task: Task): TaskAttentionDescriptor | undefined {
  const projection = task.projection;
  if (
    task.completionPolicy === 'MANUAL' &&
    projection.merge === 'MERGED' &&
    task.workflowPhase !== 'DONE'
  ) {
    return {
      label: 'Waiting for Mark done',
      detail: 'The pull request is merged; this task requires manual completion.',
      tone: 'info'
    };
  }
  if (
    projection.githubPullRequest === 'CLOSED_UNMERGED' ||
    projection.merge === 'CLOSED_UNMERGED'
  ) {
    return {
      label: 'PR closed without merge',
      detail: 'The pull request was closed without merging.',
      tone: 'error'
    };
  }
  if (projection.ciChecks === 'FAILING' || projection.ciChecks === 'BLOCKED') {
    return {
      label: 'Checks failed',
      detail: 'GitHub checks need attention.',
      tone: 'error'
    };
  }
  if (projection.reviews === 'CHANGES_REQUESTED') {
    return {
      label: 'Changes requested',
      detail: 'GitHub review requested changes.',
      tone: 'warning'
    };
  }
  if (projection.merge === 'BLOCKED') {
    return {
      label: 'Merge blocked',
      detail: 'The pull request is not currently mergeable.',
      tone: 'error'
    };
  }
  const hasDeliveryEvidence =
    projection.githubPullRequest !== 'NOT_CREATED' ||
    projection.ciChecks !== 'NOT_APPLICABLE' ||
    projection.reviews !== 'NOT_APPLICABLE' ||
    projection.merge !== 'NOT_APPLICABLE';
  if (projection.health === 'ERROR' && hasDeliveryEvidence) {
    return {
      label: 'Delivery needs attention',
      detail: 'Open the task to review the current GitHub evidence.',
      tone: 'error'
    };
  }
  return undefined;
}

export function isAttentionTask(task: Task): boolean {
  return Boolean(describeTaskAttention(task));
}

export function isInFlightTask(task: Task): boolean {
  return IN_FLIGHT_RUNS.has(task.projection.agentRun);
}
