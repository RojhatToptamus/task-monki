import type { Task } from '../../shared/contracts';

type AttentionTone = 'warning' | 'error' | 'info';

interface AttentionDescriptor {
  label: string;
  detail: string;
  tone: AttentionTone;
}

const IN_FLIGHT_RUNS = new Set([
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
export function describeTaskAttention(task: Task): AttentionDescriptor | undefined {
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

  if (task.projection.health === 'ERROR') {
    return {
      label: 'Error',
      detail: task.projection.summary,
      tone: 'error'
    };
  }

  if (task.projection.ciChecks === 'FAILING' || task.projection.reviews === 'CHANGES_REQUESTED') {
    return {
      label: 'Delivery blocked',
      detail:
        task.projection.ciChecks === 'FAILING'
          ? 'Remote checks are failing.'
          : 'Review changes were requested.',
      tone: 'warning'
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
