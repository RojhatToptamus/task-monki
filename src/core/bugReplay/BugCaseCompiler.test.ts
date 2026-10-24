import { describe, expect, it } from 'vitest';
import { parseBugCase } from '../../shared/bugCase';
import { checkoutRecording, TOTAL_PICK, totalDraft } from '../../testSupport/bugReplay/bugReplayFixtures';
import { compileBugCase, describeCapture, requestKey, suggestValue } from './BugCaseCompiler';

describe('Bug case compiler', () => {
  it('turns the check the recording violated into the failure signature, named as the page shows it', () => {
    const compiled = compileBugCase(checkoutRecording(), totalDraft());

    expect(compiled.reproducible).toBe(true);
    const document = compiled.document!;
    expect(document.assertions).toEqual([
      expect.objectContaining({ kind: 'dom.text', op: 'equals', value: '$45.00', alsoAfterReload: false })
    ]);
    // Found by its test id; read by people as the label beside it.
    expect(document.assertions[0]).toMatchObject({
      target: { label: 'Cart total', candidates: expect.arrayContaining([{ kind: 'testId', attribute: 'data-testid', value: 'cart-total' }]) }
    });
    expect(document.failureSignature).toEqual([{ assertionId: document.assertions[0].id, mode: 'CAPTURED', captured: { kind: 'text', token: '$40.00' } }]);
    expect(compiled.checks).toEqual([
      { id: document.assertions[0].id, statement: 'Cart total should read "$45.00"', inSignature: true, recorded: 'Showed "$40.00"' }
    ]);
    // What is saved parses as the strict document the runner accepts.
    expect(parseBugCase(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });

  it('refuses a case the runner would refuse, so a saved bug can always be replayed', () => {
    // A long session before the bug: more steps than a replay holds.
    const long = checkoutRecording();
    const [open, ...rest] = long.actions;
    const browsing = Array.from({ length: 130 }, (_, index) => ({
      index: 0,
      t: 200 + index,
      kind: 'click' as const,
      target: { tag: 'button', testIds: [], role: 'button', name: `Product ${index}`, text: `Product ${index}`, css: `#product-${index}` }
    }));
    long.actions = [open, ...browsing, ...rest].map((action, index) => ({ ...action, index }));
    long.mark!.actionIndex = long.actions.length - 1;

    expect(compileBugCase(long, totalDraft())).toMatchObject({ reproducible: false, reason: 'A replay holds at most 120 steps; this recording has 133' });

    // One action that sent many writes, each kept with its default rules: more checks than a case holds.
    const busy = checkoutRecording();
    busy.requests.push(...Array.from({ length: 11 }, (_, index) => ({
      ...busy.requests[2],
      id: `w${index}`,
      path: `/api/cart/line${index}`
    })));
    const requestRules = busy.requests.slice(3).map((request) => ({ requestKey: requestKey(request), check: 'success' as const, sentOnce: true }));

    expect(compileBugCase(busy, totalDraft({ requestRules }))).toMatchObject({ reproducible: false, reason: 'Keep at most 20 expectations' });
  });

  it('says what to write when the expectation already matches the page', () => {
    const compiled = compileBugCase(checkoutRecording(), totalDraft({}, '$40.00'));

    expect(compiled.reproducible).toBe(false);
    expect(compiled.reason).toBe('Write what Cart total should read; it shows "$40.00" now');
  });

  it('states a reload guard on the check itself', () => {
    const compiled = compileBugCase(checkoutRecording(), totalDraft({}, '$45.00', true));

    expect(compiled.checks[0].statement).toBe('Cart total should read "$45.00", also after reload');
  });

  it('does not name an element by text that holds the value being checked', () => {
    const pick = {
      ...TOTAL_PICK,
      target: { tag: 'button', testIds: [], role: 'button', name: 'Pay $40.00', text: 'Pay $40.00', css: '#pay' },
      text: 'Pay $40.00'
    };
    const compiled = compileBugCase(checkoutRecording({ picks: [pick] }), totalDraft({}, 'Pay $45.00'));

    // A name built from the wrong value would stop matching once the fix changes it.
    const target = compiled.document!.assertions[0];
    expect(target).toMatchObject({ kind: 'dom.text' });
    expect(JSON.stringify(target)).not.toContain('Pay $40.00');
    expect(compiled.document!.failureSignature[0]).toMatchObject({ captured: { kind: 'text', token: '$40.00' } });
  });

  it('records a request that never got a response as the failure', () => {
    const log = checkoutRecording();
    log.requests[2] = { ...log.requests[2], outcome: 'pending', status: undefined, responseJson: undefined };
    const key = describeCapture(log).requests.find((row) => row.method === 'POST')!.key;

    const compiled = compileBugCase(log, totalDraft({ checks: [], requestRules: [{ requestKey: key, check: 'answered', sentOnce: false }] }));

    expect(compiled.reproducible).toBe(true);
    expect(compiled.document!.failureSignature).toEqual([
      expect.objectContaining({ mode: 'CAPTURED', captured: { kind: 'status', value: 'no-response' } })
    ]);
    expect(compiled.checks[0].statement).toBe('POST /api/coupons/apply should get no server error');
  });

  it('keeps an incomplete recording as evidence only', () => {
    const log = checkoutRecording();
    log.actions.splice(2, 0, { index: 2, t: 1200, kind: 'unsupported', unsupported: 'file chooser' });
    log.actions[3] = { ...log.actions[3], index: 3 };
    log.mark = { ...log.mark!, actionIndex: 3 };

    const compiled = compileBugCase(log, totalDraft());

    expect(compiled).toMatchObject({ reproducible: false, reason: "Step 3 can't be replayed (file chooser)" });
    expect(compiled.document).toBeUndefined();
  });

  it('describes steps by what a person reads and never repeats a typed password', () => {
    const log = checkoutRecording();
    log.actions[1] = { ...log.actions[1], value: undefined, sensitive: true, target: { tag: 'input', inputType: 'password', testIds: [], label: 'Password', css: '#password' } };

    const capture = describeCapture(log);

    expect(capture.stepSummaries).toEqual(['Open /', 'Type a password into "Password"', 'Click "Apply coupon"']);
    // The suggested title states what was observed, under the same name the pick and the checks use.
    expect(capture.suggestedTitle).toBe('Cart total shows "$40.00"');
    expect(capture.picks[0].label).toBe('Cart total');
  });

  it('prefers a test id to the words near an element, since a person chose it', () => {
    const log = checkoutRecording({
      picks: [{ target: { tag: 'p', testIds: [{ attribute: 'data-testid', value: 'order-status' }], text: 'Your cart is empty.', context: 'Cart total: $0.00 Checkout', css: '#order-status' }, text: 'Your cart is empty.', visible: true, count: 1 }]
    });

    expect(describeCapture(log).picks[0].label).toBe('Order status');
  });

  it('names an element by its test id in words when nothing on the page names it', () => {
    const log = checkoutRecording({
      picks: [{ target: { tag: 'span', testIds: [{ attribute: 'data-testid', value: 'noteCount' }], text: '0', css: '#count' }, text: '0', visible: true, count: 1 }]
    });

    const capture = describeCapture(log);
    const compiled = compileBugCase(log, { title: 'Notes', checks: [{ pickIndex: 0, template: 'equals', expected: '1', alsoAfterReload: false }], requestRules: [], valueChecks: [] });

    expect(capture.picks[0].label).toBe('Note count');
    expect(compiled.checks[0].statement).toBe('Note count should read "1"');
  });

  it('writes a suggested value in the representation the request used', () => {
    expect(suggestValue('40', 40, '$45.00')).toBe('45');
    expect(suggestValue('"40.00"', 40, '$45.00')).toBe('"45.00"');
    expect(suggestValue('4000', 40, '$45.00')).toBe('4500');
    expect(suggestValue('true', 40, '$45.00')).toBeUndefined();
  });

  it('expects a write that failed with a 4xx only to get an answer, so the app’s own refusal is never the bug by default', () => {
    const log = checkoutRecording();
    log.requests[2] = { ...log.requests[2], status: 400 };
    const row = describeCapture(log).requests.find((candidate) => candidate.method === 'POST')!;

    expect(row).toMatchObject({ succeeded: false, defaultCheck: 'answered', defaultSentOnce: true });
    // With only the default request expectations, a 400 is not a failure the replay can reproduce.
    const compiled = compileBugCase(log, totalDraft({ checks: [], requestRules: [{ requestKey: row.key, check: row.defaultCheck, sentOnce: false }] }));
    expect(compiled.reproducible).toBe(false);
  });

  it('makes a page error part of the failure only when the marked action raised it', () => {
    const raised = checkoutRecording();
    raised.console = [{ t: 1600, level: 'exception', text: 'TypeError: total is not a function' }];
    const before = checkoutRecording();
    before.console = [{ t: 400, level: 'exception', text: 'TypeError: a page load error' }];

    const fromAction = compileBugCase(raised, totalDraft({ noPageError: true }));
    const unrelated = compileBugCase(before, totalDraft({ noPageError: true }));

    const consoleCheck = (document: NonNullable<typeof fromAction.document>) => document.assertions.find((assertion) => assertion.kind === 'console.noUncaughtError')!;
    expect(fromAction.document!.failureSignature.some((entry) => entry.assertionId === consoleCheck(fromAction.document!).id)).toBe(true);
    // An error before the marked action guards the fix but is not what the bug looks like.
    expect(unrelated.document!.failureSignature.some((entry) => entry.assertionId === consoleCheck(unrelated.document!).id)).toBe(false);
    expect(describeCapture(raised).uncaughtError).toBe(true);
    expect(describeCapture(before).uncaughtError).toBe(false);
  });

  it('suggests a name from what the element showed, and keeps each step’s kind beside its words', () => {
    const described = describeCapture(checkoutRecording());

    expect(described.suggestedTitle).toBe('Cart total shows "$40.00"');
    expect(described.stepKinds).toEqual(['navigate', 'fill', 'click']);
    expect(describeCapture(checkoutRecording({ picks: [] })).suggestedTitle).toBe('');
  });
});
