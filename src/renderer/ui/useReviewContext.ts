import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactRecord, WorktreeRecord } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import type { DiffFile } from '../model/diffEvidence';
import {
  contextCandidates,
  fillableLines,
  fillFileGaps,
  revealLines,
  wholeFileState,
  type CheckoutRead,
  type FilledFile
} from '../model/reviewContext';
import type { ActionMenuItem } from './ActionMenu';

export interface ReviewContextView {
  /** The files, with the checkout's unchanged lines in the gaps of every block it still matches. */
  files: DiffFile[];
  /** Shows a block's unchanged lines from..to, by new-side number. */
  reveal(blockId: string, from: number, to: number): void;
  /** The file menu's item for reading the file whole, when it offers one; `before` runs first (to open a collapsed file). */
  wholeFileItem(fileId: string, before?: () => void): ActionMenuItem | undefined;
}

const NO_READS: ReadonlyMap<string, CheckoutRead> = new Map();
const NO_REVEALS: Readonly<Record<string, ReadonlySet<number>>> = {};

/**
 * The unchanged lines around the current capture's changes. Each changed file is
 * read once per capture from the task's worktree; a block whose new side the file
 * still is gets its gaps filled, and the person's reveals are kept per block until
 * the capture changes. An earlier capture, or a review without a worktree, reads
 * nothing and shows the captured hunks alone.
 */
export function useReviewContext({ worktree, captureId, artifacts, files }: {
  worktree?: Pick<WorktreeRecord, 'id' | 'taskId'>;
  captureId?: string;
  artifacts: readonly ArtifactRecord[];
  files: DiffFile[];
}): ReviewContextView {
  const capture = captureId ? artifacts.find((artifact) => artifact.id === captureId) : undefined;
  // A capture rewritten in place is another capture.
  const key = worktree && capture ? [worktree.taskId, worktree.id, capture.id, capture.updatedAt, capture.byteCount].join('\u0000') : undefined;
  const [reads, setReads] = useState<{ key?: string; byPath: ReadonlyMap<string, CheckoutRead> }>({ byPath: NO_READS });
  const [reveals, setReveals] = useState<{ key?: string; byBlock: Readonly<Record<string, ReadonlySet<number>>> }>({ byBlock: NO_REVEALS });
  const requested = useRef<{ key?: string; paths: Set<string> }>({ paths: new Set() });
  const candidates = useMemo(() => (key ? contextCandidates(files) : []), [files, key]);
  const candidatesKey = candidates.join('\u0000');
  const taskId = worktree?.taskId;
  const worktreeId = worktree?.id;

  useEffect(() => {
    if (!key || !taskId || !worktreeId) return;
    if (requested.current.key !== key) requested.current = { key, paths: new Set() };
    const missing = candidates.filter((path) => !requested.current.paths.has(path));
    if (!missing.length) return;
    for (const path of missing) requested.current.paths.add(path);
    // One update for the whole batch, so a review of many files renders once.
    void Promise.all(missing.map((relativePath) => taskManagerApi.readWorktreeFile({ taskId, worktreeId, relativePath })
      .then((read): CheckoutRead => read, (): CheckoutRead => ({ status: 'FAILED' }))
      .then((read) => [relativePath, read] as const)))
      .then((entries) => setReads((current) => {
        if (requested.current.key !== key) return current;
        const byPath = new Map(current.key === key ? current.byPath : NO_READS);
        for (const [path, read] of entries) byPath.set(path, read);
        return { key, byPath };
      }));
    // `candidates` is tracked by its key, so a new array with the same paths reads nothing again.
  }, [key, taskId, worktreeId, candidatesKey]);

  const currentReads = reads.key === key ? reads.byPath : NO_READS;
  const currentReveals = reveals.key === key ? reveals.byBlock : NO_REVEALS;
  const filled = useMemo(
    () => new Map<string, FilledFile>(files.map((file) => [file.id, fillFileGaps(file, currentReads.get(file.path))])),
    [files, currentReads]
  );
  const shown = useMemo(() => {
    if (!key) return files;
    return files.map((file) => {
      const entry = filled.get(file.id)!;
      if (entry.offer !== 'lines') return entry.file;
      return { ...entry.file, blocks: entry.file.blocks.map((block) => revealLines(block, currentReveals[block.id])) };
    });
  }, [currentReveals, files, filled, key]);
  const shownById = useMemo(() => new Map(shown.map((file) => [file.id, file])), [shown]);

  const reveal = useCallback((blockId: string, from: number, to: number) => {
    setReveals((current) => {
      const byBlock = current.key === key ? current.byBlock : NO_REVEALS;
      const lines = new Set(byBlock[blockId]);
      for (let line = from; line <= to; line += 1) lines.add(line);
      return { key, byBlock: { ...byBlock, [blockId]: lines } };
    });
  }, [key]);

  const setWhole = (entry: FilledFile, whole: boolean) => setReveals((current) => {
    const byBlock = { ...(current.key === key ? current.byBlock : NO_REVEALS) };
    for (const block of entry.file.blocks) {
      if (!block.lines.some((line) => line.expansion)) continue;
      if (whole) byBlock[block.id] = new Set(fillableLines(block));
      else delete byBlock[block.id];
    }
    return { key, byBlock };
  });

  const wholeFileItem = (fileId: string, before?: () => void): ActionMenuItem | undefined => {
    const entry = filled.get(fileId);
    const file = shownById.get(fileId);
    if (!entry || !file) return undefined;
    const state = wholeFileState(file, entry.offer);
    switch (state.kind) {
      case 'none': return undefined;
      case 'unavailable': return { id: 'whole-file', label: 'Show whole file', disabled: true, disabledReason: state.reason };
      case 'partial': return { id: 'whole-file', label: 'Show whole file', onSelect: () => { before?.(); setWhole(entry, true); } };
      case 'whole': return { id: 'whole-file', label: 'Show changes only', onSelect: () => setWhole(entry, false) };
    }
  };

  return { files: shown, reveal, wholeFileItem };
}
