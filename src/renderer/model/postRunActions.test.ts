import { describe, expect, it } from 'vitest';
import { getPostRunActionState } from './postRunActions';

describe('getPostRunActionState', () => {
  it('uses Follow up as the normal completed-run action', () => {
    expect(getPostRunActionState({ status: 'COMPLETED' })).toEqual({
      canFollowUp: true,
      canContinue: false,
      canRetry: false,
      canForkAlternative: true,
      primaryRecoveryAction: 'none',
      continuationLabel: 'Follow up',
      continuationKind: 'follow-up'
    });
  });

  it('reserves Continue for recovery or unfinished terminal states', () => {
    expect(getPostRunActionState({ status: 'FAILED' })).toEqual({
      canFollowUp: false,
      canContinue: true,
      canRetry: true,
      canForkAlternative: true,
      primaryRecoveryAction: 'retry',
      continuationLabel: 'Continue work',
      continuationKind: 'recovery'
    });
  });

  it('makes Continue work primary for interrupted and uncertain outcomes', () => {
    for (const status of ['INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'] as const) {
      expect(getPostRunActionState({ status })).toMatchObject({
        canContinue: true,
        canRetry: true,
        canForkAlternative: true,
        primaryRecoveryAction: 'continue',
        continuationLabel: 'Continue work'
      });
    }
  });

  it('treats a provider-completed but locally blocked implementation as recovery', () => {
    expect(getPostRunActionState({ status: 'COMPLETED' }, true)).toEqual({
      canFollowUp: false,
      canContinue: true,
      canRetry: true,
      canForkAlternative: true,
      primaryRecoveryAction: 'retry',
      continuationLabel: 'Continue work',
      continuationKind: 'recovery'
    });
  });

  it('does not offer post-run actions while a run is active', () => {
    expect(getPostRunActionState({ status: 'RUNNING' })).toEqual({
      canFollowUp: false,
      canContinue: false,
      canRetry: false,
      canForkAlternative: false,
      primaryRecoveryAction: 'none',
      continuationLabel: 'Continue work',
      continuationKind: 'none'
    });
  });
});
