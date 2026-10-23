import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenLine } from '../model/syntaxHighlight';
import type { SyntaxAnswer, SyntaxRequest } from './syntaxWorker';

/** The syntax worker as the hook sees it: what it was asked, and answers on demand. */
class FakeWorker {
  static started: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<SyntaxAnswer>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly requests: SyntaxRequest[] = [];
  terminated = false;

  constructor() {
    FakeWorker.started.push(this);
  }

  postMessage(request: SyntaxRequest): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  answer(request: SyntaxRequest, lines: TokenLine[]): void {
    this.onmessage?.({ data: { id: request.id, lines } } as MessageEvent<SyntaxAnswer>);
  }
}

/** A fresh copy of the hook's module, so its worker and memo start empty. */
async function freshHook() {
  vi.resetModules();
  FakeWorker.started = [];
  vi.stubGlobal('Worker', FakeWorker);
  return (await import('./useSyntaxLines')).useSyntaxLines;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const side = ['const a = 1;', 'a;'];
const runs: TokenLine[] = [[{ from: 0, to: 5, kind: 'keyword' }], []];

describe('syntax lines', () => {
  it('tokenizes equal sides once, colours each when the worker answers, and colours a remount without asking again', async () => {
    const useSyntaxLines = await freshHook();
    const first = renderHook(() => useSyntaxLines('src/a.ts', side));
    const second = renderHook(() => useSyntaxLines('src/b.ts', [...side]));
    expect(first.result.current).toBeUndefined();
    const [worker] = FakeWorker.started;
    expect(FakeWorker.started).toHaveLength(1);
    expect(worker.requests).toEqual([expect.objectContaining({ language: 'typescript', text: 'const a = 1;\na;' })]);

    await act(async () => worker.answer(worker.requests[0], runs));
    expect(first.result.current).toEqual(runs);
    expect(second.result.current).toEqual(runs);

    first.unmount();
    const remount = renderHook(() => useSyntaxLines('src/a.ts', side));
    expect(remount.result.current).toEqual(runs);
    expect(worker.requests).toHaveLength(1);
  });

  it('leaves code plain when the worker fails to load, and starts no other', async () => {
    const useSyntaxLines = await freshHook();
    const before = renderHook(() => useSyntaxLines('src/a.ts', side));
    const [worker] = FakeWorker.started;
    await act(async () => worker.onerror?.(new Event('error')));
    expect(worker.terminated).toBe(true);
    expect(before.result.current).toBeUndefined();

    const other = ['let b = 2;'];
    const after = renderHook(() => useSyntaxLines('src/b.ts', other));
    expect(after.result.current).toBeUndefined();
    expect(FakeWorker.started).toHaveLength(1);
  });
});
