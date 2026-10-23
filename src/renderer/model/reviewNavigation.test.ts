import { describe, expect, it } from 'vitest';
import { feedbackOrder, nextUnviewed, reviewPlace, stepFeedback, stepFile, stepStage } from './reviewNavigation';
import { lineAnchor, type ReviewFindingView } from './reviewWorkspace';

const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

function finding(id: string, state: ReviewFindingView['state'] = 'OPEN'): ReviewFindingView {
  return { id, severity: 'MAJOR', title: id, explanation: 'Why.', state };
}

describe('the Review keys', () => {
  it('steps J and K through the files in reading order, from the first when none is current, stopping at the ends', () => {
    // Reading the brief above the files, J goes to the first file, never past it.
    expect(stepFile(files, undefined, 1)).toBe('src/a.ts');
    expect(stepFile(files, 'src/a.ts', 1)).toBe('src/b.ts');
    expect(stepFile(files, 'src/b.ts', -1)).toBe('src/a.ts');
    expect(stepFile(files, 'src/c.ts', 1)).toBe('src/c.ts');
    expect(stepFile(files, 'src/a.ts', -1)).toBe('src/a.ts');
    // A file the scope no longer holds starts the order again.
    expect(stepFile(files, 'src/gone.ts', 1)).toBe('src/a.ts');
    expect(stepFile([], undefined, 1)).toBeUndefined();
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

  it('steps [ and ] through stages from the one holding the current file', () => {
    const stages = [{ id: 'model', fileIds: ['src/a.ts'] }, { id: 'ui', fileIds: ['src/b.ts', 'src/c.ts'] }];
    expect(stepStage(stages, 'src/c.ts', -1)?.id).toBe('model');
    expect(stepStage(stages, 'src/a.ts', 1)?.id).toBe('ui');
    expect(stepStage(stages, 'src/b.ts', 1)?.id).toBe('ui');
    expect(stepStage(stages, undefined, 1)?.id).toBe('model');
    expect(stepStage([], 'src/a.ts', 1)).toBeUndefined();
  });

  it('names the place G keeps by the anchor its row carries, whatever form the path comes in', () => {
    expect(reviewPlace({ id: 'file-1', path: './src/a.ts' }, { side: 'NEW', line: 12 })).toEqual({ fileId: 'file-1', lineAnchor: lineAnchor('src/a.ts', 'NEW', 12) });
    // A removed line and an added one with the same number are two places.
    expect(lineAnchor('src/a.ts', 'OLD', 12)).not.toBe(lineAnchor('src/a.ts', 'NEW', 12));
    expect(reviewPlace({ id: 'file-1', path: 'src/a.ts' })).toEqual({ fileId: 'file-1' });
  });
});
