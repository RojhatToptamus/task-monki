import { useEffect, useMemo, useState } from 'react';
import type { DiffLine } from '../model/diffEvidence';
import { diffSides, syntaxJob, type SyntaxJob, type TokenLine } from '../model/syntaxHighlight';
import type { SyntaxAnswer, SyntaxRequest } from './syntaxWorker';

/*
 * Syntax colour off the main thread. Tokenizing a long file takes tens of
 * milliseconds and more, so one worker, started on the first request, does it
 * for the whole renderer. A side is tokenized once per content: equal sides
 * share one request, and remembered results colour a remount at once.
 */

/** Remembered sides are dropped oldest first beyond this many lines. */
const MEMO_LINES = 100_000;
const memo = new Map<string, readonly TokenLine[]>();
let memoLines = 0;

const pending = new Map<string, Promise<readonly TokenLine[] | undefined>>();
const waiting = new Map<number, (lines: TokenLine[] | undefined) => void>();
let nextId = 0;
let worker: Worker | undefined;
/** No worker can run here: a test document has none, and one that failed to load is not retried. */
let unavailable = typeof Worker === 'undefined';

function syntaxWorker(): Worker | undefined {
  if (worker || unavailable) return worker;
  worker = new Worker(new URL('./syntaxWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<SyntaxAnswer>) => {
    waiting.get(data.id)?.(data.lines);
    waiting.delete(data.id);
  };
  worker.onerror = () => {
    unavailable = true;
    worker?.terminate();
    worker = undefined;
    for (const settle of waiting.values()) settle(undefined);
    waiting.clear();
  };
  return worker;
}

function remember(key: string, lines: readonly TokenLine[]): void {
  memo.set(key, lines);
  memoLines += lines.length;
  for (const [oldest, dropped] of memo) {
    if (memoLines <= MEMO_LINES) break;
    memo.delete(oldest);
    memoLines -= dropped.length;
  }
}

/** The side's runs once the worker answers; nothing to wait for when no worker can run. */
function highlight(job: SyntaxJob): Promise<readonly TokenLine[] | undefined> | undefined {
  const known = pending.get(job.key);
  if (known) return known;
  const target = syntaxWorker();
  if (!target) return undefined;
  const id = (nextId += 1);
  const answer = new Promise<TokenLine[] | undefined>((settle) => waiting.set(id, settle)).then((lines) => {
    pending.delete(job.key);
    if (lines) remember(job.key, lines);
    return lines;
  });
  pending.set(job.key, answer);
  target.postMessage({ id, language: job.language, text: job.text } satisfies SyntaxRequest);
  return answer;
}

/**
 * A file side's runs per line, from its lines in order: the whole side, or the
 * lines a diff holds of it. None until the worker answers, and none for a type
 * with no grammar or a side too long to colour; the code then reads plain.
 * Pass the same array while the side is unchanged, since a new one is hashed again.
 */
export function useSyntaxLines(path: string, lines: readonly string[]): readonly TokenLine[] | undefined {
  const job = useMemo(() => syntaxJob(path, lines), [path, lines]);
  const [answer, setAnswer] = useState<{ key: string; lines?: readonly TokenLine[] }>();
  const settled = job !== undefined && answer?.key === job.key;

  useEffect(() => {
    if (!job || settled) return;
    // A remembered side is held in state, so dropping it from the memo later never clears a mounted file.
    const known = memo.get(job.key);
    if (known) {
      setAnswer({ key: job.key, lines: known });
      return;
    }
    let canceled = false;
    void highlight(job)?.then((lines) => { if (!canceled) setAnswer({ key: job.key, lines }); });
    return () => { canceled = true; };
  }, [job, settled]);

  if (!job) return undefined;
  return settled ? answer.lines : memo.get(job.key);
}

/**
 * Each line of a diff block's runs, by the line's index in the block: a removed
 * line reads the old side, any other line the new side. A renamed file's old
 * side is read as its old path.
 */
export function useDiffSyntax(path: string, lines: readonly DiffLine[], oldPath = path): readonly (TokenLine | undefined)[] {
  const sides = useMemo(() => diffSides(lines), [lines]);
  const before = useSyntaxLines(oldPath, sides.oldLines);
  const after = useSyntaxLines(path, sides.newLines);
  return useMemo(
    () => lines.map((line, index) => (line.kind === 'deletion' ? before : after)?.[sides.index[index]]),
    [lines, sides, before, after]
  );
}
