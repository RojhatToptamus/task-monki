import { describe, expect, it } from 'vitest';
import { getAgentComposerCopy, getPostRunActionState } from './postRunActions';

describe('getPostRunActionState', () => {
  it('uses Follow up as the normal completed-run action', () => {
    expect(getPostRunActionState({ status: 'COMPLETED' })).toEqual({
      canFollowUp: true,
      canContinue: false,
      canRetry: true,
      continuationLabel: 'Follow up',
      continuationKind: 'follow-up'
    });
  });

  it('reserves Continue for recovery or unfinished terminal states', () => {
    expect(getPostRunActionState({ status: 'FAILED' })).toEqual({
      canFollowUp: false,
      canContinue: true,
      canRetry: true,
      continuationLabel: 'Continue',
      continuationKind: 'recovery'
    });
  });

  it('treats a provider-completed but locally blocked implementation as recovery', () => {
    expect(getPostRunActionState({ status: 'COMPLETED' }, true)).toEqual({
      canFollowUp: false,
      canContinue: true,
      canRetry: true,
      continuationLabel: 'Continue',
      continuationKind: 'recovery'
    });
  });

  it('does not offer post-run actions while a run is active', () => {
    expect(getPostRunActionState({ status: 'RUNNING' })).toEqual({
      canFollowUp: false,
      canContinue: false,
      canRetry: false,
      continuationLabel: 'Continue',
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
      title: 'Continue unfinished work',
      fieldLabel: 'Continuation instruction',
      helperText: 'Continues from the current worktree state.',
      submitLabel: 'Continue run'
    });
  });

  it('explains retry-in-session without implying a reset', () => {
    expect(getAgentComposerCopy('RETRY_SAME', 'follow-up')).toMatchObject({
      title: 'Retry in session',
      helperText: 'Uses current files and the same AI session; does not reset the worktree.',
      submitLabel: 'Retry in session'
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
