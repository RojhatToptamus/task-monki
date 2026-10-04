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
