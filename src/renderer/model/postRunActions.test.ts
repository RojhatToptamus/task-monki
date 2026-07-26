import { describe, expect, it } from 'vitest';
import { getAgentComposerCopy, getPostRunActionState } from './postRunActions';

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

describe('getAgentComposerCopy', () => {
  it('matches the follow-up composer title and submit label to the selected action', () => {
    expect(getAgentComposerCopy('CONTINUE', 'follow-up')).toMatchObject({
      title: 'Follow up',
      fieldLabel: 'Follow-up instruction',
      submitLabel: 'Start follow-up'
    });
  });

  it('matches recovery continue copy to unfinished work', () => {
    expect(getAgentComposerCopy('CONTINUE', 'recovery')).toMatchObject({
      title: 'Continue work',
      fieldLabel: 'Optional continuation guidance',
      helperText: 'Resumes unfinished work from the current worktree and provider context.',
      submitLabel: 'Continue work'
    });
  });

  it('explains Retry implementation as another attempt without implying a reset', () => {
    expect(getAgentComposerCopy('RETRY_SAME', 'follow-up')).toMatchObject({
      title: 'Retry implementation',
      fieldLabel: 'Optional retry guidance',
      helperText:
        'Reattempts the original goal from the current verified state; it does not reset the worktree.',
      submitLabel: 'Retry implementation'
    });
  });

  it('explains fork alternative as a new isolated task', () => {
    expect(getAgentComposerCopy('RETRY_FORK', 'follow-up')).toMatchObject({
      title: 'Fork alternative',
      helperText: 'Creates a new task and isolated worktree.',
      submitLabel: 'Start alternative'
    });
  });
});
