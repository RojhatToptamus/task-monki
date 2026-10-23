import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentReviewGateStatus, ReviewComment, ReviewWalkthroughState } from '../../shared/contracts';
import type { DiffFile } from '../model/diffEvidence';
import type { DiscussionView } from '../model/pullRequestFeedback';
import { reviewFileRole } from '../model/reviewOrder';
import { NO_GUIDE_OPEN, feedbackByFile, readingOf, type GuideOpen, type ReviewAnchors, type ReviewReading } from '../model/reviewReading';
import { buildGuide, filesByFolder, guideReadingOrder, walkthroughUnavailableWords, type GuideModel } from '../model/reviewWalkthrough';
import {
  anchorReviewComments,
  anchorReviewDiscussions,
  anchorReviewFindings,
  diffFileSignature,
  reviewGutterWidth,
  type ReviewFindingView
} from '../model/reviewWorkspace';
import type { WalkthroughView } from './useWalkthrough';

/**
 * What the Guide shows: the walkthrough (`ready`), the earlier one while the
 * next is read (`loading`), or why there is none: none yet, one being written
 * with a running review, or one the review could not give (`reason`).
 */
export interface GuideView {
  status: 'loading' | 'ready' | 'none' | 'running' | 'unavailable';
  model?: GuideModel;
  reason?: string;
  author?: string;
  /** Before a walkthrough, the change's files by folder. */
  folders: ReadonlyArray<{ folder: string; fileIds: string[] }>;
  /** The stages whose other files are open, and the files whose other changes are. */
  openGroups: ReadonlySet<number>;
  openMore: ReadonlySet<string>;
  /** Feedback with no place in the code the Guide reads. */
  outside: { findings: readonly ReviewFindingView[]; discussions: readonly DiscussionView[] };
}

export interface GuideSources {
  walkthrough?: { state: ReviewWalkthroughState; view: WalkthroughView; author: string };
  review?: { status: AgentReviewGateStatus; runId?: string; reviewedTreeSha?: string };
  /** An earlier capture is shown: no discussion is the head's. */
  historical: boolean;
  /** The review's findings. */
  findings: readonly ReviewFindingView[];
  discussions: readonly DiscussionView[];
  /** The discussions' lines are the head the platform read, which the walkthrough's code is while it is current. */
  discussionsOnLines: boolean;
  /** The person's comments shown, the answered ones of the latest request among them; those alone; and the draft's. */
  comments: readonly ReviewComment[];
  roundComments: readonly ReviewComment[];
  draftComments: readonly ReviewComment[];
  /**
   * The whole change, which the Guide reads before a walkthrough, with each
   * file's signature and what the Diff places in it, never a commit's or a
   * scope's.
   */
  change: {
    files: DiffFile[];
    signatures: ReadonlyMap<string, string>;
    findings: readonly ReviewFindingView[];
    discussions: readonly DiscussionView[];
    comments: readonly ReviewComment[];
  };
}

export interface GuideReading {
  view: GuideView;
  reading: ReviewReading;
  /** The walkthrough is the code the Diff shows: comments are written on it, and Viewed is one mark in both modes. */
  current: boolean;
  setOpen: Dispatch<SetStateAction<GuideOpen>>;
}

const NO_FINDINGS: ReviewFindingView[] = [];
const NO_DISCUSSIONS: DiscussionView[] = [];
const NO_COMMENTS: ReviewComment[] = [];
const NO_FILES: DiffFile[] = [];
const NO_CHANGE: GuideSources['change'] = { files: NO_FILES, signatures: new Map(), findings: NO_FINDINGS, discussions: NO_DISCUSSIONS, comments: NO_COMMENTS };

/**
 * The Guide's reading: the walkthrough over the code the review read, with this
 * review's findings, the discussions where they sit (on their lines while that
 * code is the head the platform read them on), and the person's comments while
 * that code is what the Diff shows. An earlier walkthrough is context, written
 * on code since changed. Before a walkthrough, the whole change by folder.
 */
export function useGuideReading(sources: GuideSources): GuideReading {
  const { walkthrough, review } = sources;
  const stored = walkthrough?.state.status === 'STORED' ? walkthrough.state : undefined;
  // It is the code shown while the diff has not moved since the review: the review's own walkthrough, or an
  // earlier one written on the very tree the review reads (a review run again on unchanged code).
  const writtenOn = walkthrough?.view.walkthrough?.tree;
  const current = Boolean(stored && review && review.status !== 'STALE' &&
    (writtenOn && review.reviewedTreeSha ? writtenOn === review.reviewedTreeSha : stored.reviewRunId === review.runId));
  const own = Boolean(stored && stored.reviewRunId === review?.runId);
  // Once the code moved on, the comments the latest request carried still sit in the review's own
  // walkthrough with their answers: a request names its review only when it was sent while that review
  // was current, so they were written on the code the walkthrough shows. Comments written since were not.
  const comments = useMemo(
    () => (current ? sources.comments : own ? sources.roundComments : NO_COMMENTS),
    [current, own, sources.comments, sources.roundComments]
  );
  const files = walkthrough?.view.files ?? NO_FILES;
  const findings = own ? sources.findings : NO_FINDINGS;
  const discussions = sources.historical ? NO_DISCUSSIONS : sources.discussions;
  const discussionsOnLines = sources.discussionsOnLines && current;
  const anchors = useAnchors(files, findings, discussions, discussionsOnLines, comments);

  // The Guide lays its code out by what was said when the person arrived at its walkthrough: settling a
  // finding, resolving a discussion or writing a comment while reading moves nothing they read, and what
  // comes in later takes its place as it comes. The next visit lays it all out anew.
  const arrivalKey = walkthrough?.view.walkthrough?.reviewRunId;
  const [arrival, setArrival] = useState(() => arrivalOf(arrivalKey, findings, discussions, sources.draftComments));
  if (arrival.key !== arrivalKey) setArrival(arrivalOf(arrivalKey, findings, discussions, sources.draftComments));
  const layoutFindings = useMemo(
    () => asArrived(findings, (finding) => {
      const state = arrival.findings.get(finding.id);
      return state && state !== finding.state ? { ...finding, state } : finding;
    }),
    [arrival, findings]
  );
  const layoutDiscussions = useMemo(
    () => asArrived(discussions, (discussion) => {
      const open = arrival.discussions.get(discussion.id);
      return open !== undefined && open !== discussion.open ? { ...discussion, open } : discussion;
    }),
    [arrival, discussions]
  );
  const layoutComments = useMemo(
    () => (current ? (sources.roundComments.length ? [...sources.roundComments, ...arrival.comments] : arrival.comments) : own ? sources.roundComments : NO_COMMENTS),
    [arrival, current, own, sources.roundComments]
  );
  const layout = useAnchors(files, layoutFindings, layoutDiscussions, discussionsOnLines, layoutComments);
  const model = useMemo(
    () => (walkthrough?.view.walkthrough && walkthrough.view.files ? buildGuide(walkthrough.view.walkthrough, walkthrough.view.files, layout) : undefined),
    [layout, walkthrough?.view.files, walkthrough?.view.walkthrough]
  );
  const [openState, setOpen] = useState<GuideOpen>(NO_GUIDE_OPEN);
  const open = model && openState.key === model.reviewRunId ? openState : NO_GUIDE_OPEN;
  const signatures = useMemo(() => new Map(files.map((file) => [file.id, diffFileSignature(file)])), [files]);
  // Opening a stage's other files changes the order J and K step through, not what is said where.
  const feedback = useMemo(() => feedbackByFile(files, anchors), [anchors, files]);
  const gutterWidth = useMemo(() => reviewGutterWidth(files, false), [files]);
  const walkthroughReading = useMemo(() => {
    if (!model) return undefined;
    const stageOrder = model.stages.flatMap((stage) => [...stage.shown, ...stage.folded]);
    return readingOf({
      files,
      ordered: stageOrder.map((id) => {
        const file = model.files.get(id)!.file.file;
        return { file, role: reviewFileRole(file.path) };
      }),
      fileIds: guideReadingOrder(model, open.groups),
      anchors,
      feedback,
      signatures,
      gutterWidth,
      foldedByDefault: (entry) => !model.files.get(entry.file.id)?.file.shown
    });
  }, [anchors, feedback, files, gutterWidth, model, open.groups, signatures]);

  // Before a walkthrough, the whole change by folder, each file folded to its head.
  const change = model ? NO_CHANGE : sources.change;
  const changeAnchors = useAnchors(change.files, change.findings, change.discussions, sources.discussionsOnLines, change.comments);
  const folders = useMemo(() => filesByFolder(change.files), [change.files]);
  const changeReading = useMemo(() => {
    const byId = new Map(change.files.map((file) => [file.id, file]));
    return readingOf({
      files: change.files,
      ordered: folders.flatMap((group) => group.fileIds.flatMap((id) => {
        const file = byId.get(id);
        return file ? [{ file, role: reviewFileRole(file.path) }] : [];
      })),
      anchors: changeAnchors,
      feedback: feedbackByFile(change.files, changeAnchors),
      signatures: change.signatures,
      gutterWidth: reviewGutterWidth(change.files, false),
      foldedByDefault: () => true
    });
  }, [change.files, change.signatures, changeAnchors, folders]);

  const read = walkthroughReading ? anchors : changeAnchors;
  const status: GuideView['status'] = stored
    ? walkthrough?.view.loading ? 'loading' : model ? 'ready' : 'unavailable'
    : review?.status === 'RUNNING' ? 'running'
      : walkthrough?.state.status === 'UNAVAILABLE' ? 'unavailable' : 'none';
  return {
    view: {
      status,
      model,
      ...(status === 'unavailable' ? {
        reason: walkthroughUnavailableWords(walkthrough?.state.status === 'UNAVAILABLE' ? walkthrough.state.reason : walkthrough?.view.diffUnavailable ?? 'UNPARSED')
      } : {}),
      author: walkthrough?.author,
      folders,
      openGroups: open.groups,
      openMore: open.more,
      outside: { findings: read.findings.general, discussions: read.discussions.general }
    },
    reading: walkthroughReading ?? changeReading,
    current,
    setOpen
  };
}

/** Where each kind of feedback sits in `files`, each kind placed again only when its own inputs change. */
function useAnchors(
  files: readonly DiffFile[],
  findings: readonly ReviewFindingView[],
  discussions: readonly DiscussionView[],
  discussionsOnLines: boolean,
  comments: readonly ReviewComment[]
): ReviewAnchors {
  const findingAnchors = useMemo(() => anchorReviewFindings(files, findings), [files, findings]);
  const discussionAnchors = useMemo(() => anchorReviewDiscussions(files, discussions, discussionsOnLines), [discussions, discussionsOnLines, files]);
  const commentAnchors = useMemo(() => anchorReviewComments(files, comments), [comments, files]);
  return useMemo(
    () => ({ findings: findingAnchors, discussions: discussionAnchors, comments: commentAnchors }),
    [commentAnchors, discussionAnchors, findingAnchors]
  );
}

/** What was said when the person arrived at a walkthrough: each finding's state, whether each discussion was open, and the comments. */
function arrivalOf(
  key: string | undefined,
  findings: readonly ReviewFindingView[],
  discussions: readonly DiscussionView[],
  comments: readonly ReviewComment[]
) {
  return {
    key,
    findings: new Map(findings.map((finding) => [finding.id, finding.state])),
    discussions: new Map(discussions.map((discussion) => [discussion.id, discussion.open])),
    comments
  };
}

/** Each item as it was on arrival; the very list while none has changed since. */
function asArrived<T>(items: readonly T[], arrived: (item: T) => T): readonly T[] {
  const laid = items.map(arrived);
  return laid.every((item, index) => item === items[index]) ? items : laid;
}
