import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactRecord, WorktreeRecord } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import type { DiffBlock, DiffFile } from '../model/diffEvidence';
import {
  contextCandidates,
  fillableLines,
  fillFileGaps,
  revealLines,
  wholeFileState,
  type CheckoutRead,
  type FilledFile,
  type WholeFileState
} from '../model/reviewContext';

export interface ReviewContextView {
  /**
   * The files, with the checkout's unchanged lines in the gaps of every block it
   * still matches. A file keeps its identity until its own lines change.
   */
  files: DiffFile[];
  /** Whether the checkout can add lines to any file: some may run past the change, to the file's end. */
  fillable: boolean;
  /** Shows a block's unchanged lines from..to, by new-side number. */
  reveal(blockId: string, from: number, to: number): void;
  /** What the file menu offers for reading the file whole. */
  wholeFile(fileId: string): WholeFileState;
  /** Shows every unchanged line of the file, or its changes only. */
  setWholeFile(fileId: string, whole: boolean): void;
}

const NO_READS: ReadonlyMap<string, CheckoutRead> = new Map();
const NO_REVEALS: Readonly<Record<string, ReadonlySet<number>>> = {};
const NO_WHOLE_FILE: WholeFileState = { kind: 'none' };
/**
 * Each filled file as last shown, with the reveals it was shown with: a reveal
 * changes only its own block, so every other file keeps its identity and its
 * rows do not render again.
 */
const shownFiles = new WeakMap<DiffFile, { reveals: ReadonlyArray<ReadonlySet<number> | undefined>; file: DiffFile }>();

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
      const blockReveals = entry.file.blocks.map((block) => currentReveals[block.id]);
      const cached = shownFiles.get(entry.file);
      if (cached && cached.reveals.every((revealed, index) => revealed === blockReveals[index])) return cached.file;
      const shownFile = { ...entry.file, blocks: entry.file.blocks.map((block, index) => revealLines(block, blockReveals[index])) };
      shownFiles.set(entry.file, { reveals: blockReveals, file: shownFile });
      return shownFile;
    });
  }, [currentReveals, files, filled, key]);
  const wholeFiles = useMemo(
    () => new Map(shown.map((file) => [file.id, wholeFileState(file, filled.get(file.id)?.offer ?? 'none')])),
    [filled, shown]
  );

  const reveal = useCallback((blockId: string, from: number, to: number) => {
    setReveals((current) => {
      const byBlock = current.key === key ? current.byBlock : NO_REVEALS;
      const lines = new Set(byBlock[blockId]);
      for (let line = from; line <= to; line += 1) lines.add(line);
      return { key, byBlock: { ...byBlock, [blockId]: lines } };
    });
  }, [key]);

  const wholeFile = (fileId: string): WholeFileState => wholeFiles.get(fileId) ?? NO_WHOLE_FILE;

  const setWholeFile = useCallback((fileId: string, whole: boolean) => {
    const blocks: readonly DiffBlock[] = filled.get(fileId)?.file.blocks ?? [];
    setReveals((current) => {
      const byBlock = { ...(current.key === key ? current.byBlock : NO_REVEALS) };
      for (const block of blocks) {
        if (!block.lines.some((line) => line.expansion)) continue;
        if (whole) byBlock[block.id] = new Set(fillableLines(block));
        else delete byBlock[block.id];
      }
      return { key, byBlock };
    });
  }, [filled, key]);

  return { files: shown, fillable: candidates.length > 0, reveal, wholeFile, setWholeFile };
}
