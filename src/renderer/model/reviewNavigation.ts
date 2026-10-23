import { lineAnchor, type ReviewFindingView } from './reviewWorkspace';

/**
 * Where the Review keys lead, in the order a review is read: J and K step
 * through the files, N and P through what still asks for something, V marks a
 * file viewed and moves on to the next unviewed one, [ and ] step through the
 * stages of a walkthrough, and a place is what G keeps across the modes. Each
 * answer is a target; moving the code there is the caller's.
 */

/** The next or previous file, stopping at the ends; with none current, the first. */
export function stepFile(files: readonly string[], current: string | undefined, delta: 1 | -1): string | undefined {
  const position = current === undefined ? -1 : files.indexOf(current);
  if (position < 0) return files[0];
  return files[Math.min(files.length - 1, Math.max(0, position + delta))];
}

/** Something that still asks for the person: an open finding or an open discussion. */
export interface FeedbackRef { kind: 'finding' | 'discussion'; id: string }

interface OpenDiscussion { id: string; open: boolean }

/**
 * Open feedback in reading order: what has no place in the files first, then
 * file by file in the order read, each file's findings before its discussions.
 */
export function feedbackOrder({ general, files, findingsByFile, discussionsByFile }: {
  general: { findings: readonly ReviewFindingView[]; discussions: readonly OpenDiscussion[] };
  files: readonly string[];
  findingsByFile: ReadonlyMap<string, readonly ReviewFindingView[]>;
  discussionsByFile: ReadonlyMap<string, readonly OpenDiscussion[]>;
}): FeedbackRef[] {
  const open = (findings: readonly ReviewFindingView[], discussions: readonly OpenDiscussion[]): FeedbackRef[] => [
    ...findings.filter((finding) => finding.state === 'OPEN').map((finding) => ({ kind: 'finding' as const, id: finding.id })),
    ...discussions.filter((discussion) => discussion.open).map((discussion) => ({ kind: 'discussion' as const, id: discussion.id }))
  ];
  return [
    ...open(general.findings, general.discussions),
    ...files.flatMap((fileId) => open(findingsByFile.get(fileId) ?? [], discussionsByFile.get(fileId) ?? []))
  ];
}

/**
 * The next or previous open item, stopping at the ends. From an item that no
 * longer asks for anything, or from none, the order starts again at its first.
 */
export function stepFeedback(order: readonly FeedbackRef[], current: FeedbackRef | undefined, delta: 1 | -1): FeedbackRef | undefined {
  const position = current ? order.findIndex((item) => item.kind === current.kind && item.id === current.id) : -1;
  return order[Math.min(order.length - 1, Math.max(0, position + delta))];
}

/** After `fileId` is marked viewed, the first file after it, in reading order, not yet viewed. */
export function nextUnviewed(files: readonly string[], fileId: string, viewed: ReadonlySet<string>): string | undefined {
  return files.slice(files.indexOf(fileId) + 1).find((candidate) => !viewed.has(candidate));
}

/** A stage of a walkthrough, with its files in reading order. */
export interface ReviewStageRef { id: string; fileIds: readonly string[] }

/**
 * The next or previous stage from the one holding the current file, stopping at
 * the ends; with no current file, the first stage. A review without stages has none.
 */
export function stepStage(stages: readonly ReviewStageRef[], currentFileId: string | undefined, delta: 1 | -1): ReviewStageRef | undefined {
  const position = currentFileId === undefined ? -1 : stages.findIndex((stage) => stage.fileIds.includes(currentFileId));
  if (position < 0) return stages[0];
  return stages[Math.min(stages.length - 1, Math.max(0, position + delta))];
}

/** A place both modes can open: a file, and the line in it when one is known (`lineAnchor`). */
export interface ReviewPlace { fileId: string; lineAnchor?: string }

/** The place to keep for a file and, when the person is on one, a line of it. */
export function reviewPlace(file: { id: string; path: string }, line?: { side: 'NEW' | 'OLD'; line: number }): ReviewPlace {
  return line ? { fileId: file.id, lineAnchor: lineAnchor(file.path, line.side, line.line) } : { fileId: file.id };
}
