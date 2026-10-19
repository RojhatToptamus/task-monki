import { describe, expect, it } from 'vitest';
import type { BugExpectationEdit } from '../../shared/bugReplay';
import type { BugRecordingLogV1 } from '../../shared/bugRecording';
import { checkoutRecording, TOTAL_PICK, totalDraft } from '../../testSupport/bugReplay/bugReplayFixtures';
import { compileBugCase, describeCapture } from './BugCaseCompiler';
import { describeRevision, EXPECTATIONS_MOVED, expectationViews, followedTitle, reviseBugCase, type RevisableVersion } from './BugCaseRevision';

/** The checkout recording with the total reading "Total $40.00" where the person expects "Total $45.00". */
function recording(): BugRecordingLogV1 {
  return checkoutRecording({ picks: [{ ...TOTAL_PICK, target: { ...TOTAL_PICK.target, text: 'Total $40.00' }, text: 'Total $40.00' }] });
}

function postKey(log: BugRecordingLogV1): string {
  return describeCapture(log).requests.find((row) => row.method === 'POST')!.key;
}

/** A saved version as the save stores it: the compiled document and what the recording showed. */
function saved(log: BugRecordingLogV1, draft = totalDraft({}, 'Total $45.00')): RevisableVersion {
  const compiled = compileBugCase(log, draft);
  if (!compiled.document) throw new Error(`The case did not compile: ${compiled.reason}`);
  return { document: compiled.document, recorded: compiled.recorded };
}

function idOf(version: RevisableVersion, kind: string, match: (assertion: Record<string, unknown>) => boolean = () => true): string {
  return version.document.assertions.find((assertion) => assertion.kind === kind && match(assertion as unknown as Record<string, unknown>))!.id;
}

const keep = (...ids: string[]): BugExpectationEdit[] => ids.map((id) => ({ kind: 'keep', id }));

describe('Changing a saved bug’s expectations', () => {
  it('judges a changed value against the whole text the recording showed, not only the part it kept', () => {
    const base = saved(recording());
    const total = idOf(base, 'dom.text');
    expect(base.document.failureSignature[0]).toMatchObject({ captured: { kind: 'text', token: '$40.00' } });

    const revised = reviseBugCase(base, [{ kind: 'element', id: total, template: 'equals', expected: '$45.00', alsoAfterReload: false }]);

    expect(revised).toMatchObject({ changed: true, reproducible: true });
    // The check keeps its id, so earlier results stay tied to the same element.
    expect(revised.document.assertions).toEqual([expect.objectContaining({ id: total, kind: 'dom.text', op: 'equals', value: '$45.00' })]);
    expect(revised.document.failureSignature).toEqual([{ assertionId: total, mode: 'CAPTURED', captured: { kind: 'text', token: 'Total $40.00' } }]);
    expect(revised.checks).toEqual([expect.objectContaining({ statement: 'Cart total should read "$45.00"', recorded: 'Showed "Total $40.00"' })]);
  });

  it('refuses a change that leaves nothing the recording got wrong, naming what now matches it', () => {
    const base = saved(recording());
    const total = idOf(base, 'dom.text');

    expect(reviseBugCase(base, [{ kind: 'element', id: total, template: 'equals', expected: 'Total $40.00', alsoAfterReload: false }])).toMatchObject({
      changed: true,
      reproducible: false,
      reason: 'Cart total matches the recording'
    });
    expect(reviseBugCase(base, [{ kind: 'element', id: total, template: 'contains', expected: '$40', alsoAfterReload: false }])).toMatchObject({
      reproducible: false,
      reason: 'Cart total matches the recording'
    });
  });

  it('keeps the recorded failure when a guard goes, and refuses removing the failure itself', () => {
    const log = recording();
    const base = saved(log, totalDraft({ requestRules: [{ requestKey: postKey(log), check: 'answered', sentOnce: true }] }, 'Total $45.00'));
    const total = idOf(base, 'dom.text');
    const guards = base.document.assertions.filter((assertion) => assertion.kind === 'request').map((assertion) => assertion.id);
    expect(guards).toHaveLength(2);

    const withoutGuards = reviseBugCase(base, keep(total));
    expect(withoutGuards).toMatchObject({ changed: true, reproducible: true });
    expect(withoutGuards.document.failureSignature).toEqual(base.document.failureSignature);
    expect(Object.keys(withoutGuards.recorded)).toEqual([total]);

    expect(reviseBugCase(base, keep(...guards))).toMatchObject({ reproducible: false, reason: 'No expectation failed in the recording' });
    expect(reviseBugCase(base, [])).toMatchObject({ reproducible: false, reason: 'Keep at least one expectation' });
  });

  it('makes a guard part of the failure when its changed rule refuses what the recording got', () => {
    const log = recording();
    log.requests[2] = { ...log.requests[2], status: 400 };
    const base = saved(log, totalDraft({ requestRules: [{ requestKey: postKey(log), check: 'answered', sentOnce: false }] }, 'Total $45.00'));
    const total = idOf(base, 'dom.text');
    const status = idOf(base, 'request');
    // A 400 is an answer: the app's own refusal is not the bug until the person says so.
    expect(base.document.failureSignature.map((entry) => entry.assertionId)).toEqual([total]);

    const revised = reviseBugCase(base, [...keep(total), { kind: 'status', id: status, check: 'success' }]);

    expect(revised).toMatchObject({ changed: true, reproducible: true });
    expect(revised.document.failureSignature).toContainEqual({ assertionId: status, mode: 'CAPTURED', captured: { kind: 'status', value: 400 } });
  });

  it('judges a changed JSON value against what the recording sent, and keeps it tied to its request', () => {
    const log = recording();
    const base = saved(log, totalDraft({ valueChecks: [{ requestKey: postKey(log), side: 'response', pointer: '/discount', expected: '5' }] }, 'Total $45.00'));
    const total = idOf(base, 'dom.text');
    const anchor = idOf(base, 'request');
    const value = idOf(base, 'request.json');
    expect(base.document.failureSignature).toContainEqual({ assertionId: value, mode: 'CAPTURED', captured: { kind: 'json', value: '10' } });

    // The app answered 10 all along: that value now holds, and the total stays the failure.
    const holds = reviseBugCase(base, [...keep(total, anchor), { kind: 'value', id: value, expected: '10' }]);
    expect(holds.document.failureSignature.map((entry) => entry.assertionId)).toEqual([total]);
    expect(holds.document.assertions.find((assertion) => assertion.id === value)).toMatchObject({ equals: '10' });

    expect(reviseBugCase(base, [...keep(total), { kind: 'value', id: value, expected: '5' }])).toMatchObject({
      reproducible: false,
      reason: 'The value expectations on POST /api/coupons/apply need its status'
    });
    expect(reviseBugCase(base, [...keep(total, anchor), { kind: 'value', id: value, expected: '{' }])).toMatchObject({
      reproducible: false,
      reason: 'The expected value for POST /api/coupons/apply is not valid'
    });
  });

  it('refuses what it cannot judge: edits made for other expectations, or a value without its recording', () => {
    const base = saved(recording());
    const total = idOf(base, 'dom.text');

    expect(reviseBugCase(base, keep('a9'))).toMatchObject({ changed: false, reproducible: false, reason: EXPECTATIONS_MOVED });
    expect(reviseBugCase(base, [{ kind: 'status', id: total, check: 'success' }])).toMatchObject({ reproducible: false, reason: EXPECTATIONS_MOVED });
    // A bug saved before the recording's observations were kept can drop expectations, not judge new values.
    expect(reviseBugCase({ document: base.document }, [{ kind: 'element', id: total, template: 'equals', expected: '$46.00', alsoAfterReload: false }])).toMatchObject({
      reproducible: false,
      reason: 'Record the bug again to change the expectation on Cart total'
    });
  });

  it('sees no change in an untouched draft, and keeps the failure when only after reload changes', () => {
    const base = saved(recording());
    const total = idOf(base, 'dom.text');

    expect(reviseBugCase(base, keep(total))).toMatchObject({ changed: false, reproducible: true });
    expect(reviseBugCase(base, [{ kind: 'element', id: total, template: 'equals', expected: ' Total  $45.00 ', alsoAfterReload: false }]).changed).toBe(false);
    const reload = reviseBugCase(base, [{ kind: 'element', id: total, template: 'equals', expected: 'Total $45.00', alsoAfterReload: true }]);
    expect(reload).toMatchObject({ changed: true, reproducible: true });
    expect(reload.document.failureSignature).toEqual(base.document.failureSignature);
  });

  it('names what changed, and keeps a suggested name stating the expectation as it is now', () => {
    const base = saved(recording());
    const total = idOf(base, 'dom.text');
    const revised = reviseBugCase(base, [{ kind: 'element', id: total, template: 'equals', expected: '$45.00', alsoAfterReload: false }]);
    const after = { document: revised.document, recorded: revised.recorded };

    expect(describeRevision(base.document, revised.document)).toBe('Cart total should read "$45.00"');
    expect(followedTitle('Cart total should read "Total $45.00"', base, after)).toBe('Cart total should read "$45.00"');
    // A name the person wrote is theirs.
    expect(followedTitle('Coupon total is wrong', base, after)).toBeUndefined();
  });

  it('lists every expectation once, with a request’s status and Sent once on one row', () => {
    const log = recording();
    const base = saved(log, totalDraft({
      requestRules: [{ requestKey: postKey(log), check: 'answered', sentOnce: true }],
      valueChecks: [{ requestKey: postKey(log), side: 'response', pointer: '/discount', expected: '5' }],
      noPageError: true
    }, 'Total $45.00'));

    const rows = expectationViews(base.document, base.recorded, (text) => text);

    expect(rows.map((row) => row.kind)).toEqual(['element', 'pageError', 'request', 'value']);
    const listed = rows.flatMap((row) => (row.kind === 'request' ? [row.status?.id, row.sentOnceId] : [row.id])).filter(Boolean).sort();
    expect(listed).toEqual(base.document.assertions.map((assertion) => assertion.id).sort());
    expect(rows[0]).toMatchObject({ name: 'Cart total', recorded: 'Showed "Total $40.00"', template: 'equals', expected: 'Total $45.00' });
    expect(rows[2]).toMatchObject({ name: 'POST /api/coupons/apply', recorded: 'Returned 200', failed: false, valueIds: [idOf(base, 'request.json')] });
    expect(rows[3]).toMatchObject({ name: 'POST /api/coupons/apply returns discount', recorded: 'Was 10', expected: '5' });
  });
});
