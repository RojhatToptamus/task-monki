import type { RunRecord } from '../../shared/contracts';

const TERMINAL_OR_RECOVERY = new Set<RunRecord['status']>([
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
  'LOST'
]);

const UNSUCCESSFUL_STATUSES = new Set<RunRecord['status']>([
  'FAILED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
  'LOST'
]);

export interface PostRunActionState {
  canFollowUp: boolean;
  canContinue: boolean;
  canRetry: boolean;
  canForkAlternative: boolean;
  primaryRecoveryAction: 'continue' | 'retry' | 'none';
  continuationLabel: 'Follow up' | 'Continue work';
  continuationKind: 'follow-up' | 'recovery' | 'none';
}

export type AgentComposerMode = 'STEER' | 'CONTINUE' | 'RETRY_SAME' | 'RETRY_FORK';

export interface AgentComposerCopy {
  title: string;
  fieldLabel: string;
  helperText?: string;
  placeholder: string;
  submitLabel: string;
}

export function getPostRunActionState(
  run: Pick<RunRecord, 'status'>,
  requiresRecovery = false
): PostRunActionState {
  const canFollowUp = run.status === 'COMPLETED' && !requiresRecovery;
  const canContinue = requiresRecovery || UNSUCCESSFUL_STATUSES.has(run.status);
  const canRetry = requiresRecovery || UNSUCCESSFUL_STATUSES.has(run.status);
  const primaryRecoveryAction = !canContinue
    ? 'none'
    : run.status === 'FAILED' || requiresRecovery
      ? 'retry'
      : 'continue';
  return {
    canFollowUp,
    canContinue,
    canRetry,
    canForkAlternative: TERMINAL_OR_RECOVERY.has(run.status),
    primaryRecoveryAction,
    continuationLabel: canFollowUp ? 'Follow up' : 'Continue work',
    continuationKind: canFollowUp ? 'follow-up' : canContinue ? 'recovery' : 'none'
  };
}

export function getAgentComposerCopy(
  mode: AgentComposerMode,
  continuationKind: PostRunActionState['continuationKind']
): AgentComposerCopy {
  switch (mode) {
    case 'STEER':
      return {
        title: 'Add instruction',
        fieldLabel: 'Instruction for the active turn',
        placeholder: 'Example: Focus on the failing tests before changing more files.',
        submitLabel: 'Send instruction'
      };
    case 'CONTINUE':
      if (continuationKind === 'follow-up') {
        return {
          title: 'Follow up',
          fieldLabel: 'Follow-up instruction',
          placeholder: 'Add context or constraints for the next turn.',
          submitLabel: 'Start follow-up'
        };
      }
      return {
        title: 'Continue work',
        fieldLabel: 'Optional continuation guidance',
        helperText: 'Resumes unfinished work from the current worktree and provider context.',
        placeholder: 'Add context or guidance for continuing the unfinished work.',
        submitLabel: 'Continue work'
      };
    case 'RETRY_SAME':
      return {
        title: 'Retry implementation',
        fieldLabel: 'Optional retry guidance',
        helperText:
          'Reattempts the original goal from the current verified state; it does not reset the worktree.',
        placeholder: 'Add guidance for this attempt at the original implementation goal.',
        submitLabel: 'Retry implementation'
      };
    case 'RETRY_FORK':
      return {
        title: 'Fork alternative',
        fieldLabel: 'Alternative instruction',
        helperText: 'Creates a new task and isolated worktree.',
        placeholder: 'Describe the independent alternative approach.',
        submitLabel: 'Start alternative'
      };
  }
}
