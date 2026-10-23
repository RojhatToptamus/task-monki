import type { DiffFile } from './diffEvidence';
import type { DiscussionView } from './pullRequestFeedback';
import { feedbackOrder, type FeedbackRef } from './reviewNavigation';
import type { OrderedReviewFile } from './reviewOrder';
import {
  buildReviewIndex,
  lineAnchorKey,
  type AnchoredComments,
  type AnchoredDiscussions,
  type AnchoredFindings,
  type ReviewFindingView
} from './reviewWorkspace';

/**
 * What one mode of the Review tab reads: its files, where its feedback sits, and
 * the order its keys go. The Diff reads its captured files; the Guide, the
 * walkthrough's (the code the review read).
 */

/** Where each kind of feedback sits in the files. */
export interface ReviewAnchors {
  findings: AnchoredFindings;
  discussions: AnchoredDiscussions<DiscussionView>;
  comments: AnchoredComments;
}

export interface ReviewReading {
  files: DiffFile[];
  filesById: ReadonlyMap<string, DiffFile>;
  /** Every file, in the mode's reading order. */
  ordered: OrderedReviewFile[];
  /** The files J and K step through. */
  fileIds: string[];
  anchors: ReviewAnchors;
  findingsByFile: ReadonlyMap<string, ReviewFindingView[]>;
  discussionsByFile: ReadonlyMap<string, DiscussionView[]>;
  openFindingsByFile: ReadonlyMap<string, ReviewFindingView[]>;
  openDiscussionsByFile: ReadonlyMap<string, DiscussionView[]>;
  /** N and P. */
  feedback: FeedbackRef[];
  /** Each file's change as this mode reads it (`diffFileSignature`). */
  signatures: ReadonlyMap<string, string>;
  /** Folded until the person opens it, besides a viewed file. */
  foldedByDefault(entry: OrderedReviewFile): boolean;
  gutterWidth: number;
}

/** What each file holds of the feedback anchored in the files, and what of it still asks for something. */
export function feedbackByFile(files: readonly DiffFile[], anchors: ReviewAnchors) {
  const findingsByFile = new Map(buildReviewIndex(files, anchors.findings).map((entry) => [entry.file.id, entry.findings]));
  const discussionsByFile = new Map(files.map((file) => [file.id, [
    ...(anchors.discussions.byFile.get(file.id) ?? []),
    ...file.blocks.flatMap((block) => block.lines.flatMap((line, index) => anchors.discussions.byLine.get(lineAnchorKey(file.id, block.id, line, index)) ?? []))
  ]]));
  return {
    findingsByFile,
    discussionsByFile,
    // A file's head says what still asks for something, and a folded file keeps a row for each.
    openFindingsByFile: new Map([...findingsByFile].map(([fileId, list]) => [fileId, list.filter((finding) => finding.state === 'OPEN')])),
    openDiscussionsByFile: new Map([...discussionsByFile].map(([fileId, list]) => [fileId, list.filter((discussion) => discussion.open)]))
  };
}

export function readingOf({ files, ordered, fileIds, anchors, feedback, signatures, gutterWidth, foldedByDefault }: {
  files: DiffFile[];
  ordered: OrderedReviewFile[];
  fileIds?: string[];
  anchors: ReviewAnchors;
  feedback: ReturnType<typeof feedbackByFile>;
  signatures: ReadonlyMap<string, string>;
  gutterWidth: number;
  foldedByDefault(entry: OrderedReviewFile): boolean;
}): ReviewReading {
  const order = ordered.map((entry) => entry.file.id);
  return {
    files,
    filesById: new Map(files.map((file) => [file.id, file])),
    ordered,
    fileIds: fileIds ?? order,
    anchors,
    ...feedback,
    // N and P step through what still asks for something, in reading order.
    feedback: feedbackOrder({
      general: { findings: anchors.findings.general, discussions: anchors.discussions.general },
      files: order,
      findingsByFile: feedback.findingsByFile,
      discussionsByFile: feedback.discussionsByFile
    }),
    signatures,
    foldedByDefault,
    gutterWidth
  };
}

/** What the person opened in one walkthrough: stages' other files, and files' other changes. */
export interface GuideOpen { key?: string; groups: ReadonlySet<number>; more: ReadonlySet<string> }

export const NO_GUIDE_OPEN: GuideOpen = { groups: new Set(), more: new Set() };

/** Opens a stage's other files, or a file's other changes, in the state kept for one walkthrough (`key`). */
export function openInGuide(state: GuideOpen, key: string, open: { group?: number; more?: string }): GuideOpen {
  const current = state.key === key ? state : { ...NO_GUIDE_OPEN, key };
  const groups = open.group === undefined || current.groups.has(open.group) ? current.groups : new Set([...current.groups, open.group]);
  const more = open.more === undefined || current.more.has(open.more) ? current.more : new Set([...current.more, open.more]);
  return groups === current.groups && more === current.more && state.key === key ? state : { key, groups, more };
}
