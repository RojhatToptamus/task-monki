import type { RunRecord } from '../../shared/contracts';

const TERMINAL_OR_RECOVERY = new Set<RunRecord['status']>([
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
  'LOST'
]);

const RECOVERY_STATUSES = new Set<RunRecord['status']>([
  'FAILED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
  'LOST'
]);

export interface PostRunActionState {
  canFollowUp: boolean;
  canContinue: boolean;
  canRetry: boolean;
  continuationLabel: 'Follow up' | 'Continue';
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
  run: Pick<RunRecord, 'status'>
): PostRunActionState {
  const canFollowUp = run.status === 'COMPLETED';
  const canContinue = RECOVERY_STATUSES.has(run.status);
  return {
    canFollowUp,
    canContinue,
    canRetry: TERMINAL_OR_RECOVERY.has(run.status),
    continuationLabel: canFollowUp ? 'Follow up' : 'Continue',
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
        title: 'Continue unfinished work',
        fieldLabel: 'Continuation instruction',
        helperText: 'Continues from the current worktree state.',
        placeholder: 'Add context or constraints for the next turn.',
        submitLabel: 'Continue run'
      };
    case 'RETRY_SAME':
      return {
        title: 'Retry in session',
        fieldLabel: 'Retry instruction',
        helperText: 'Uses current files and the same AI session; does not reset the worktree.',
        placeholder: 'Add context or constraints for the retry.',
        submitLabel: 'Retry in session'
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
