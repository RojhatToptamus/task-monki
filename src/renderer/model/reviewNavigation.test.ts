import { describe, expect, it } from 'vitest';
import { feedbackOrder, nextUnviewed, stepFeedback, stepThrough } from './reviewNavigation';
import type { ReviewFindingView } from './reviewWorkspace';

const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

function finding(id: string, state: ReviewFindingView['state'] = 'OPEN'): ReviewFindingView {
  return { id, severity: 'MAJOR', title: id, explanation: 'Why.', state };
}

describe('the Review keys', () => {
  it('steps J and K through the files, and [ and ] through the stages, from the first when none is current, stopping at the ends', () => {
    // Reading the brief above the files, J goes to the first file, never past it.
    expect(stepThrough(files, undefined, 1)).toBe('src/a.ts');
    expect(stepThrough(files, 'src/a.ts', 1)).toBe('src/b.ts');
    expect(stepThrough(files, 'src/b.ts', -1)).toBe('src/a.ts');
    expect(stepThrough(files, 'src/c.ts', 1)).toBe('src/c.ts');
    expect(stepThrough(files, 'src/a.ts', -1)).toBe('src/a.ts');
    // A file the scope no longer holds starts the order again.
    expect(stepThrough(files, 'src/gone.ts', 1)).toBe('src/a.ts');
    expect(stepThrough([], undefined, 1)).toBeUndefined();
  });

  it('steps N and P through what still asks for something: what has no place first, then file by file in reading order', () => {
    const order = feedbackOrder({
      general: { findings: [finding('general'), finding('dismissed', 'DISMISSED')], discussions: [{ id: 'about-the-change', open: true }] },
      files: ['src/b.ts', 'src/a.ts'],
      findingsByFile: new Map([['src/a.ts', [finding('a')]], ['src/b.ts', [finding('b')]]]),
      discussionsByFile: new Map([
        ['src/a.ts', [{ id: 'a-thread', open: true }, { id: 'a-remark', open: false }]],
        ['src/b.ts', [{ id: 'b-thread', open: true }]]
      ])
    });
    expect(order.map((item) => item.id)).toEqual(['general', 'about-the-change', 'b', 'b-thread', 'a', 'a-thread']);

    expect(stepFeedback(order, { kind: 'finding', id: 'b' }, 1)).toEqual({ kind: 'discussion', id: 'b-thread' });
    expect(stepFeedback(order, { kind: 'discussion', id: 'b-thread' }, -1)).toEqual({ kind: 'finding', id: 'b' });
    expect(stepFeedback(order, { kind: 'discussion', id: 'a-thread' }, 1)?.id).toBe('a-thread');
    // From what no longer asks for anything, such as a thread just resolved, N starts at the first.
    expect(stepFeedback(order, { kind: 'discussion', id: 'a-remark' }, 1)?.id).toBe('general');
    // A finding and a discussion may share an id; the kind tells them apart.
    expect(stepFeedback([{ kind: 'finding', id: 'x' }, { kind: 'discussion', id: 'x' }], { kind: 'discussion', id: 'x' }, -1)).toEqual({ kind: 'finding', id: 'x' });
  });

  it('moves on with V to the next file not yet viewed after the one just marked, never back', () => {
    expect(nextUnviewed(files, 'src/a.ts', new Set(['src/a.ts', 'src/b.ts']))).toBe('src/c.ts');
    expect(nextUnviewed(files, 'src/b.ts', new Set(['src/b.ts']))).toBe('src/c.ts');
    expect(nextUnviewed(files, 'src/c.ts', new Set(['src/c.ts']))).toBeUndefined();
  });
});
