import { describe, expect, it } from 'vitest';
import type { BugCaseV1 } from '../../shared/bugCase';
import { checkoutCase, runFrames } from '../../testSupport/bugReplay/bugReplayFixtures';
import type { BugReplayElementMark, BugReplayFrame } from './runner/protocol';
import { validateFrames } from './BugReplayRunner';

const PLAN = 'a'.repeat(64);

/** A finished replay whose final screenshot outlines `marks`, as the runner reports it. */
function report(document: BugCaseV1, marks: BugReplayElementMark[]) {
  const frames = runFrames(document, '$40.00');
  const finished = frames.pop()!;
  frames.push({ type: 'screenshot', name: 'final.png', sha256: 'b'.repeat(64), bytes: 10, purpose: 'final', marks });
  const all: BugReplayFrame[] = [...frames, { ...finished, frames: frames.length + 1 } as BugReplayFrame];
  return all.map((frame, seq) => ({ ...frame, nonce: 'run-nonce', seq }));
}

describe('A replay report', () => {
  it('keeps the replay’s result when an outline cannot be placed, and refuses one on a check the case does not have', () => {
    const document = checkoutCase();
    const checkId = document.assertions[0].id;
    const expected = { nonce: 'run-nonce', planSha256: PLAN, document };

    // A checked element taller than any page: its outline goes, the verdict's evidence stays.
    const tall = validateFrames(report(document, [{ assertionId: checkId, box: { x: 10, y: 20, width: 300, height: 5_000_000 } }]), expected);
    expect(tall.kind).toBe('valid');
    if (tall.kind !== 'valid') return;
    expect(tall.frames.find((frame) => frame.type === 'screenshot')).toMatchObject({ marks: [] });
    expect(tall.frames.filter((frame) => frame.type === 'assertion')).toHaveLength(document.assertions.length);

    expect(validateFrames(report(document, [{ assertionId: 'not-a-check', box: { x: 10, y: 20, width: 30, height: 18 } }]), expected)).toMatchObject({ kind: 'invalid' });
  });
});
