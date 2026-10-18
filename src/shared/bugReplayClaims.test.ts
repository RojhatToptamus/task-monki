import { describe, expect, it } from 'vitest';
import { bugCountsLine, bugReason, bugScopeLine, bugStateWord, serviceStoppedSentence, suggestBugTitle } from './bugReplayClaims';

describe('What Task Monki says about a bug', () => {
  it('counts only runs that reached a result', () => {
    const baseline = { matched: 2, total: 2 };
    expect(bugCountsLine({ state: 'FIX_VERIFIED', baseline, candidate: { passed: 2, total: 2 } })).toBe('Replays: reproduced 2 of 2 before the fix, passed 2 of 2 after');
    // A verification in flight is not a result yet.
    expect(bugCountsLine({ state: 'VERIFYING', baseline, candidate: { passed: 0, total: 2 } })).toBe('Replays: reproduced 2 of 2 before the fix');
    // Runs that could not run checked nothing: "passed 0 of 2" would read as a failure.
    expect(bugCountsLine({ state: 'COULDNT_VERIFY', baseline, candidate: { passed: 0, total: 2 } })).toBe('Replays: reproduced 2 of 2 before the fix');
    expect(bugCountsLine({ state: 'COULDNT_VERIFY', baseline, candidate: { passed: 1, total: 2 } })).toBe('Replays: reproduced 2 of 2 before the fix, passed 1 of 2 after');
  });

  it('states the reason beside the state word without repeating it', () => {
    expect(bugReason({ state: 'COULDNT_VERIFY', fact: "Couldn't verify: .env changed since the bug was recorded" })).toBe('.env changed since the bug was recorded');
    expect(bugReason({ state: 'NOT_REPRODUCED', fact: 'Not reproduced: the checked text changes between runs (1, then 2)' })).toBe('The checked text changes between runs (1, then 2)');
    expect(bugReason({ state: 'FLAKY', fact: 'Flaky. Before: failed 1 of 2' })).toBe('Before: failed 1 of 2');
    expect(bugReason({ state: 'STALE', fact: 'The code changed after this result' })).toBe('The code changed after this result');
    expect(bugReason({ state: 'REPRODUCED' })).toBeUndefined();
  });

  it('puts the decision the person owes ahead of the state', () => {
    expect(bugStateWord({ state: 'VERIFYING', activeRun: { waitingFor: 'APPROVAL' } })).toMatchObject({ word: 'Replays need approval', owed: true });
    expect(bugStateWord({ state: 'REPRODUCED', handoff: { status: 'RUNNING' } })).toMatchObject({ word: 'Fixing the bug', owed: false });
    expect(bugStateWord({ state: 'STILL_FAILING' })).toMatchObject({ word: 'Bug still failing', tone: 'error', owed: true });
  });

  it('names the service that stopped, or the app when none is named', () => {
    expect(serviceStoppedSentence('web')).toBe('The web service stopped');
    expect(serviceStoppedSentence('the app')).toBe('The app stopped');
    expect(serviceStoppedSentence(undefined)).toBe('The app stopped');
  });

  it('always says what the check did not read', () => {
    expect(bugScopeLine(false, false)).toBe('Checked on the page. Database contents were not read.');
    expect(bugScopeLine(true, true)).toBe("Checked in the app's pages after reload, browser storage kept. Database contents were not read.");
  });
  it('names a bug by what should be true once the person says so, and by what it showed until then', () => {
    // Until the expectation differs from what the element showed, the name states the observation.
    expect(suggestBugTitle({ label: 'Cart total', template: 'equals', expected: '$40.00', shown: '$40.00' })).toBe('Cart total shows "$40.00"');
    // Once it does, the name still reads right after the fix is verified.
    expect(suggestBugTitle({ label: 'Cart total', template: 'equals', expected: ' $45.00\n', shown: '$40.00' })).toBe('Cart total should read "$45.00"');
    expect(suggestBugTitle({ label: 'Banner', template: 'contains', expected: 'Saved', shown: '' })).toBe('Banner should contain "Saved"');
    expect(suggestBugTitle({ label: 'Banner', template: 'equals', shown: '' })).toBe('Banner is empty');
    expect(suggestBugTitle({ label: 'Toast', template: 'count', count: 1 })).toBe('Toast should appear once');
    expect(suggestBugTitle({ label: 'Note', template: 'equals', expected: 'x'.repeat(60), shown: '' })).toBe(`Note should read "${'x'.repeat(39)}…"`);
    expect(suggestBugTitle(undefined)).toBe('');
  });
});
