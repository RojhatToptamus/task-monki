import { describe, expect, it } from 'vitest';
import type { BugReplayRunRecord } from '../../shared/bugReplay';
import { checkoutCase, runFrames } from '../../testSupport/bugReplay/bugReplayFixtures';
import { attemptOutcome, evaluateRun, qualificationOutcome, volatileComparisonIds } from './BugReplayVerdict';

type Settled = Pick<BugReplayRunRecord, 'outcome' | 'counted' | 'failure' | 'state'>;

function settled(outcome: NonNullable<BugReplayRunRecord['outcome']>, detail?: string): Settled {
  const counted = ['REPRODUCED', 'NOT_REPRODUCED', 'PASSED', 'FAILED'].includes(outcome);
  return { state: 'SETTLED', outcome, counted, ...(detail ? { failure: { reason: 'CHECK_FAILED', detail } } : {}) };
}

const open: Settled = { state: 'QUEUED', counted: false };

describe('Run verdicts', () => {
  it('reproduces only when the clean copy fails the way the recording did', () => {
    const document = checkoutCase();

    expect(evaluateRun('BASELINE', document, runFrames(document, '$40.00'))).toMatchObject({
      outcome: 'REPRODUCED',
      signatureObserved: { [document.assertions[0].id]: expect.stringContaining('$40.00') }
    });
    expect(evaluateRun('BASELINE', document, runFrames(document, '$45.00'))).toMatchObject({
      outcome: 'NOT_REPRODUCED',
      failure: { reason: 'NOT_REPRODUCED', detail: expect.stringContaining('The clean copy showed the expected result') }
    });
    // A different wrong value is not the bug that was recorded.
    expect(evaluateRun('BASELINE', document, runFrames(document, '$47.00'))).toMatchObject({
      outcome: 'NOT_REPRODUCED',
      failure: { reason: 'SIGNATURE_MISMATCH' }
    });
  });

  it('passes a fix only when every check holds', () => {
    const document = checkoutCase();

    expect(evaluateRun('CANDIDATE', document, runFrames(document, '$45.00'))).toMatchObject({ outcome: 'PASSED' });
    expect(evaluateRun('CANDIDATE', document, runFrames(document, '$40.00'))).toMatchObject({
      outcome: 'FAILED',
      failure: { reason: 'CHECK_FAILED', detail: 'After: Cart total showed "$40.00"' }
    });
  });

  it('counts no check that found its element a weaker way than on the recorded code', () => {
    const document = checkoutCase();
    const id = document.assertions[0].id;
    const position = document.assertions[0].kind === 'dom.text' ? document.assertions[0].target.candidates.length - 1 : 0;
    // A change added a second element with the test id, so only the element's position found one.
    const frames = runFrames(document, '$45.00').map((frame) =>
      frame.type === 'assertion' && frame.observation.kind === 'dom' ? { ...frame, observation: { ...frame.observation, candidateIndex: position } } : frame
    );

    expect(evaluateRun('CANDIDATE', document, frames, { baselineLocators: { [id]: 0 } })).toMatchObject({
      outcome: 'BLOCKED',
      failure: { reason: 'TARGET_CHANGED', detail: "Couldn't verify: Cart total was found by its position on the page, not by its test id as on the recorded code" }
    });
    // The same way as on the recorded code still decides; either way the run says how it was found.
    expect(evaluateRun('CANDIDATE', document, frames, { baselineLocators: { [id]: position } })).toMatchObject({
      outcome: 'PASSED',
      facts: expect.arrayContaining(['Cart total found by its position on the page'])
    });
  });

  it('holds a fix to the reload guard', () => {
    const document = checkoutCase(true);

    expect(evaluateRun('CANDIDATE', document, runFrames(document, '$45.00', '$45.00'))).toMatchObject({ outcome: 'PASSED' });
    // Right until the page reloads: a client-side patch, not a fix.
    expect(evaluateRun('CANDIDATE', document, runFrames(document, '$45.00', '$40.00'))).toMatchObject({
      outcome: 'FAILED',
      failure: { detail: 'After: Cart total showed "$40.00" after reload' }
    });
  });

  it('refuses a reload guard the recorded bug itself does not survive', () => {
    const document = checkoutCase(true);

    expect(evaluateRun('BASELINE', document, runFrames(document, '$40.00', '$40.00'))).toMatchObject({ outcome: 'REPRODUCED' });
    expect(evaluateRun('BASELINE', document, runFrames(document, '$40.00', '$0.00'))).toMatchObject({
      outcome: 'NOT_REPRODUCED',
      failure: {
        reason: 'RELOAD_VALUE_CHANGED',
        detail: 'After reload it shows "$0.00", not "$40.00". Turn off Also after reload, or keep browser storage on reload.'
      }
    });
  });

  it('does not count a run whose steps could not be completed as a reproduction', () => {
    const document = checkoutCase();
    const frames = runFrames(document, '$40.00').map((frame) =>
      frame.type === 'step' && frame.index === 2 ? { ...frame, status: 'failed' as const, failure: 'not-found' as const, detail: 'Could not find "Apply coupon"' } : frame
    );

    expect(evaluateRun('BASELINE', document, frames)).toMatchObject({ outcome: 'NOT_REPRODUCED', failure: { detail: 'Could not find "Apply coupon"' } });
  });
});

describe('Qualification', () => {
  const volatile = new Set<string>();

  it('needs two counted runs and agrees on reproduced, flaky and not reproduced', () => {
    expect(qualificationOutcome([settled('REPRODUCED'), open], [], volatile)).toMatchObject({ state: 'PENDING' });
    expect(qualificationOutcome([settled('REPRODUCED'), settled('REPRODUCED')], [], volatile)).toMatchObject({ state: 'REPRODUCED', matched: 2 });
    expect(qualificationOutcome([settled('REPRODUCED'), settled('NOT_REPRODUCED')], [], volatile)).toMatchObject({ state: 'FLAKY', matched: 1 });
    expect(qualificationOutcome([settled('NOT_REPRODUCED', 'The clean copy showed the expected result'), settled('NOT_REPRODUCED')], [], volatile))
      .toMatchObject({ state: 'NOT_REPRODUCED', detail: 'The clean copy showed the expected result' });
  });

  it('gives an environment failure one replacement and stops on changed env files', () => {
    expect(qualificationOutcome([settled('ENVIRONMENT_FAILED'), settled('REPRODUCED'), open], [], volatile)).toMatchObject({ state: 'PENDING' });
    expect(qualificationOutcome([settled('ENVIRONMENT_FAILED', 'web stopped'), settled('ENVIRONMENT_FAILED', 'web stopped')], [], volatile))
      .toMatchObject({ state: 'BLOCKED', detail: 'web stopped' });
    expect(qualificationOutcome([settled('ENV_FILES_CHANGED', '.env changed'), open], [], volatile)).toMatchObject({ state: 'BLOCKED', detail: '.env changed' });
  });

  it('does not reproduce a failure whose text changes from run to run', () => {
    const ids = new Set(['a1']);
    expect(qualificationOutcome([settled('REPRODUCED'), settled('REPRODUCED')], [{ a1: 'Order 1041 failed' }, { a1: 'Order 1042 failed' }], ids))
      .toMatchObject({ state: 'NOT_REPRODUCED', volatile: true });
    expect(volatileComparisonIds(checkoutCase())).toEqual(new Set());
  });
});

describe('Verification attempts', () => {
  it('fails at the first counted failure and verifies after two passes', () => {
    expect(attemptOutcome([settled('FAILED', 'After: total showed "$40.00"'), open], undefined, false))
      .toMatchObject({ state: 'STILL_FAILING', detail: 'After: total showed "$40.00"' });
    expect(attemptOutcome([settled('PASSED'), open], undefined, false)).toMatchObject({ state: 'PENDING', passed: 1 });
    expect(attemptOutcome([settled('PASSED'), settled('PASSED')], undefined, false)).toMatchObject({ state: 'FIX_VERIFIED', passed: 2 });
  });

  it('runs a candidate a restart cut short again instead of calling the fix unverified', () => {
    // The refill is still to run: the attempt is not over.
    expect(attemptOutcome([settled('PASSED'), settled('INTERRUPTED', 'Task Monki closed during this run.'), open], undefined, false))
      .toMatchObject({ state: 'PENDING', passed: 1 });
    expect(attemptOutcome([settled('PASSED'), settled('INTERRUPTED'), settled('PASSED')], undefined, false)).toMatchObject({ state: 'FIX_VERIFIED' });
    // Nothing left to run: say why it ended.
    expect(attemptOutcome([settled('PASSED'), settled('INTERRUPTED', 'Task Monki closed during this run.')], undefined, false))
      .toMatchObject({ state: 'COULDNT_VERIFY', detail: 'Task Monki closed during this run.' });
  });

  it('cannot verify when the conditions of the check changed', () => {
    expect(attemptOutcome([settled('ENV_FILES_CHANGED', "Couldn't verify: .env changed since the bug was recorded"), open], undefined, false))
      .toMatchObject({ state: 'COULDNT_VERIFY', passed: 0 });
  });

  it('checks the bug still shows on the recorded code before an old qualification verifies a fix', () => {
    const passes = [settled('PASSED'), settled('PASSED')];
    expect(attemptOutcome(passes, undefined, true)).toMatchObject({ state: 'PENDING', needsControl: true });
    expect(attemptOutcome(passes, settled('REPRODUCED'), true)).toMatchObject({ state: 'FIX_VERIFIED' });
    expect(attemptOutcome(passes, settled('NOT_REPRODUCED'), true)).toMatchObject({ state: 'COULDNT_VERIFY', requalify: true });
  });
});
