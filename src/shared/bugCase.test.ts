import { describe, expect, it } from 'vitest';
import { checkoutCase } from '../testSupport/bugReplay/bugReplayFixtures';
import { describeBugCaseAssertion, describeTarget, parseBugCase } from './bugCase';

/** A stored case document round-tripped through JSON, as the runner receives it. */
function stored(mutate: (document: ReturnType<typeof checkoutCase>) => void = () => undefined): unknown {
  const document = JSON.parse(JSON.stringify(checkoutCase())) as ReturnType<typeof checkoutCase>;
  mutate(document);
  return document;
}

describe('bug-case/v1 documents', () => {
  it('parses what the compiler produces, including the display name of a target', () => {
    const document = checkoutCase();

    expect(parseBugCase(stored())).toEqual(document);
    expect(describeTarget(document.assertions[0].kind === 'dom.text' ? document.assertions[0].target : { candidates: [] })).toBe('"Cart total"');
  });

  it('refuses anything the runner would have to interpret as code', () => {
    const scripted = stored((document) => {
      const assertion = document.assertions[0];
      if (assertion.kind === 'dom.text') assertion.target.candidates = [{ kind: 'css', value: 'a[href^="javascript:alert(1)"]' }];
    });
    expect(() => parseBugCase(scripted)).toThrow('A CSS path holds unsupported syntax.');

    const engine = stored((document) => {
      const assertion = document.assertions[0];
      if (assertion.kind === 'dom.text') assertion.target.candidates = [{ kind: 'css', value: 'xpath=//button' }];
    });
    expect(() => parseBugCase(engine)).toThrow('A CSS path holds unsupported syntax.');

    const unknownKind = stored((document) => {
      (document.assertions as unknown[]).push({ id: 'e1', kind: 'evaluate', script: 'return true' });
    });
    expect(() => parseBugCase(unknownKind)).toThrow('A check has an unsupported kind.');
  });

  it('refuses fields it does not define and steps that would leave the clean start', () => {
    expect(() => parseBugCase(stored((document) => Object.assign(document, { waitMs: 5_000 })))).toThrow();
    expect(() => parseBugCase(stored((document) => document.steps.push({ id: 's9', kind: 'navigate', origin: 'primary', path: '/admin', query: [] }))))
      .toThrow('Only the first step may open a page.');
    expect(() => parseBugCase(stored((document) => {
      const assertion = document.assertions[0];
      if (assertion.kind === 'dom.text') assertion.target.label = 'x'.repeat(81);
    }))).toThrow();
  });

  it('states each check as one sentence a person can verify', () => {
    const document = checkoutCase(true);

    expect(document.assertions.map((assertion) => describeBugCaseAssertion(assertion, document))).toEqual([
      '"Cart total" should read "$45.00", also after reload'
    ]);
  });
});
