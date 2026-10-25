import { describe, expect, it } from 'vitest';
import type { BugCaseV1 } from '../../shared/bugCase';
import { checkoutCase, runFrames } from '../../testSupport/bugReplay/bugReplayFixtures';
import type { BugReplayElementMark, BugReplayFrame, BugReplayFrameEnvelope } from './runner/protocol';
import { validateFrames } from './BugReplayRunner';

const PLAN = 'a'.repeat(64);

/**
 * A finished replay whose final screenshot outlines `marks`, as the runner reports it. `change`
 * edits the frames before the runner counts them, so a report stays consistent unless the edit
 * breaks the one rule it is about.
 */
function report(document: BugCaseV1, marks: BugReplayElementMark[] = [], change: (frames: BugReplayFrame[]) => BugReplayFrame[] = (frames) => frames) {
  const frames = runFrames(document, '$40.00');
  frames.pop();
  frames.push({ type: 'screenshot', name: 'final.png', sha256: 'b'.repeat(64), bytes: 10, purpose: 'final', marks });
  const body = change(frames);
  const count = (type: BugReplayFrame['type']) => body.filter((frame) => frame.type === type).length;
  const all: BugReplayFrame[] = [...body, { type: 'run-finished', steps: count('step'), assertions: count('assertion'), frames: body.length + 1 }];
  return all.map((frame, seq): BugReplayFrameEnvelope => ({ ...frame, nonce: 'run-nonce', seq }));
}

const document = checkoutCase();
const expected = { nonce: 'run-nonce', planSha256: PLAN, document };

describe('A replay report', () => {
  it('keeps the replay’s result when an outline cannot be placed, and refuses one on a check the case does not have', () => {
    const checkId = document.assertions[0].id;

    // A checked element taller than any page: its outline goes, the verdict's evidence stays.
    const tall = validateFrames(report(document, [{ assertionId: checkId, box: { x: 10, y: 20, width: 300, height: 5_000_000 } }]), expected);
    expect(tall.kind).toBe('valid');
    if (tall.kind !== 'valid') return;
    expect(tall.frames.find((frame) => frame.type === 'screenshot')).toMatchObject({ marks: [] });
    expect(tall.frames.filter((frame) => frame.type === 'assertion')).toHaveLength(document.assertions.length);

    expect(validateFrames(report(document, [{ assertionId: 'not-a-check', box: { x: 10, y: 20, width: 30, height: 18 } }]), expected)).toMatchObject({ kind: 'invalid' });
  });

  const steps = (frames: BugReplayFrame[]) => frames.filter((frame): frame is Extract<BugReplayFrame, { type: 'step' }> => frame.type === 'step');
  const check = (frames: BugReplayFrame[]) => frames.find((frame): frame is Extract<BugReplayFrame, { type: 'assertion' }> => frame.type === 'assertion')!;
  const fail = (frames: BugReplayFrame[], stepIndex: number) =>
    frames.map((frame) => (frame.type === 'step' && frame.index === stepIndex ? { ...frame, status: 'failed' as const, failure: 'not-found' as const } : frame));
  const edit = (change: (frames: BugReplayFrame[]) => BugReplayFrame[]) => () => report(document, [], change);
  const envelope = (change: (envelopes: BugReplayFrameEnvelope[]) => BugReplayFrameEnvelope[]) => () => change(report(document));

  it('is read only when it is consistent', () => {
    expect(validateFrames(report(document), expected)).toMatchObject({ kind: 'valid' });
  });

  it.each<[string, () => BugReplayFrameEnvelope[]]>([
    ['nothing at all', () => []],
    ['a frame from another run', envelope((all) => all.map((frame, seq) => (seq === 2 ? { ...frame, nonce: 'other-run' } : frame)))],
    ['a gap in its sequence', envelope((all) => all.map((frame, seq) => (seq >= 3 ? { ...frame, seq: seq + 1 } : frame)))],
    ['another plan than the one written', envelope((all) => all.map((frame) => (frame.type === 'run-started' ? { ...frame, planSha256: 'c'.repeat(64) } : frame)))],
    ['no end', envelope((all) => all.slice(0, -1).map((frame, seq) => ({ ...frame, seq })))],
    ['a step count that is not its steps', envelope((all) => all.map((frame) => (frame.type === 'run-finished' ? { ...frame, steps: frame.steps + 1 } : frame)))],
    ['a check count that is not its checks', envelope((all) => all.map((frame) => (frame.type === 'run-finished' ? { ...frame, assertions: frame.assertions + 1 } : frame)))],
    ['a frame count that is not its frames', envelope((all) => all.map((frame) => (frame.type === 'run-finished' ? { ...frame, frames: frame.frames + 1 } : frame)))],
    ['the runner’s own failure', edit((frames) => [...frames.slice(0, -1), { type: 'fatal', detail: 'The browser crashed.' }, frames.at(-1)!])],
    ['a skipped step', edit((frames) => frames.filter((frame) => !(frame.type === 'step' && frame.index === 1)))],
    ['steps after a failed one', edit((frames) => fail(frames, 1))],
    ['checks after a failed step', edit((frames) => fail(frames, steps(frames).length - 1))],
    ['a repeated check', edit((frames) => [...frames.slice(0, -1), check(frames), frames.at(-1)!])],
    ['a skipped check', edit((frames) => frames.filter((frame) => frame.type !== 'assertion'))],
    ['a check the case does not have', edit((frames) => [...frames.slice(0, -1), { ...check(frames), assertionId: 'not-a-check' }, frames.at(-1)!])]
  ])('counts nothing from a report with %s', (_case, build) => {
    expect(validateFrames(build(), expected)).toMatchObject({ kind: 'invalid' });
  });
});
