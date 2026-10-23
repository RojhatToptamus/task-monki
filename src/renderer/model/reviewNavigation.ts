import type { ReviewFindingView } from './reviewWorkspace';

/**
 * Where the Review keys lead, in the order a review is read: J and K step
 * through the files, [ and ] through a walkthrough's stages, N and P through
 * what still asks for something, and V marks a file viewed and moves on to the
 * next unviewed one. Each answer is a target; moving the code there is the
 * caller's.
 */

/** The two ways to read a review: the walkthrough, stage by stage, or the complete diff. */
export type ReviewMode = 'guide' | 'diff';

/** The next or previous item of an order (files, stages), stopping at the ends; with none current, the first. */
export function stepThrough(order: readonly string[], current: string | undefined, delta: 1 | -1): string | undefined {
  const position = current === undefined ? -1 : order.indexOf(current);
  if (position < 0) return order[0];
  return order[Math.min(order.length - 1, Math.max(0, position + delta))];
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
