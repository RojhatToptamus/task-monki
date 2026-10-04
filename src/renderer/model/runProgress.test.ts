import { describe, expect, it } from 'vitest';
import { makeRunRecord as runFixture } from '../../testSupport/rendererRecords';
import { canStopTaskRun, selectProgressRun } from './runProgress';

describe('implementation run controls', () => {
  it('offers Stop only before submission or after provider acknowledgement', () => {
    expect(canStopTaskRun(runFixture({ status: 'QUEUED', providerTurnId: undefined }))).toBe(
      true
    );
    expect(canStopTaskRun(runFixture({ status: 'STARTING', providerTurnId: undefined }))).toBe(
      false
    );
    expect(canStopTaskRun(runFixture({ status: 'STARTING', providerTurnId: 'turn-sending' }))).toBe(
      false
    );
    expect(canStopTaskRun(runFixture({ status: 'RUNNING', providerTurnId: 'turn-1' }))).toBe(
      true
    );
    expect(canStopTaskRun(runFixture({ status: 'INTERRUPTING', providerTurnId: 'turn-1' }))).toBe(
      false
    );
  });

  it('keeps detached review separate from the implementation summary', () => {
    const run = runFixture({ mode: 'FOLLOW_UP' });
    const review = runFixture({ id: 'review', mode: 'REVIEW', startedAt: '2099-01-01T00:00:00Z' });
    expect(selectProgressRun(review, [run, review])).toBe(run);
    expect(selectProgressRun(undefined, [])).toBeUndefined();
  });
});
