import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type {
  AgentReviewGateStatus,
  AgentReviewResolvedFinding,
  ArtifactRecord,
  OpenTargetRef,
  ReviewComment,
  ReviewFindingDismissReason,
  ReviewRequestItem,
  ReviewRequestItemDecisionKind,
  ReviewWalkthroughState,
  TaskReviewDraft,
  WorktreeRecord
} from '../../shared/contracts';
import type { DiffBlock, DiffEvidenceScope, DiffFile } from '../model/diffEvidence';
import type { DiscussionView, ReplyDraft } from '../model/pullRequestFeedback';
import type { WholeFileState } from '../model/reviewContext';
import type { ReviewRequestPlan } from '../model/reviewFollowUp';
import { requestItemQuote, reviewBandAnswers, type ReviewBandAnswers, type ReviewRoundView } from '../model/reviewRounds';
import type { ReviewMode } from '../model/reviewNavigation';
import { orderReviewFiles, reviewFileRole, type OrderedReviewFile, type ReviewFileOrder } from '../model/reviewOrder';
import {
  readBriefFolded,
  readReviewFileOrder,
  readReviewMode,
  readViewedFiles,
  writeBriefFolded,
  writeReviewFileOrder,
  writeReviewMode,
  writeViewedFiles
} from '../model/reviewPreferences';
import { NO_GUIDE_OPEN, feedbackByFile, openInGuide, readingOf, type GuideOpen, type ReviewAnchors, type ReviewReading } from '../model/reviewReading';
import { buildGuide, filesByFolder, guideReadingOrder, guideReveal, walkthroughUnavailableWords, type GuideModel } from '../model/reviewWalkthrough';
import {
  anchorReviewComments,
  anchorReviewDiscussions,
  anchorReviewFindings,
  diffFileSignature,
  diffLineId,
  filesChangedSinceReview,
  lineAnchor,
  lineAnchorKey,
  normalizeReviewPath,
  reviewGutterWidth,
  selectionRange,
  type ReviewFindingView
} from '../model/reviewWorkspace';
import type { ReviewBriefContent } from './ReviewBrief';
import type { ReviewFinishAction, ReviewRequestAction } from './ReviewRequest';
import { changeWithMotion, type ExpandMotion } from './expandMotion';
import { useNotify } from './NotifyContext';
import { BAND, landing, linesOf, quoted, readPlace } from './reviewPlace';
import { keepInView, stopTravel, travel } from './travel';
import { useDiffArtifact } from './useDiffArtifact';
import { useReviewChanges } from './useReviewChanges';
import { useReviewContext } from './useReviewContext';
import { useScrollSpy } from './useScrollSpy';
import type { WalkthroughView } from './useWalkthrough';

/**
 * The Review tab's state and data, held once for the bar, the navigator, the
 * code and the foot. What the parts can do is `ReviewActions`: stable for the
 * tab's life, so a row given one renders again only when its own inputs change.
 */

export type ReviewScope = DiffEvidenceScope | 'since-review';

export interface ReviewWorkspaceProps {
  taskId: string;
  review?: {
    status: AgentReviewGateStatus;
    reviewedAt?: string;
    runId?: string;
    /** The exact code the review reads, kept as a Git tree once it starts. */
    reviewedTreeSha?: string;
    /** The implementation agent is taking a turn after the review, such as fixing a request. */
    working?: boolean;
  };
  findings: ReviewFindingView[];
  currentDiffArtifactId?: string;
  reviewedDiffArtifactId?: string;
  /**
   * The review to measure changes from: the current one once it is out of date,
   * or the previous round's once a re-review is current. Its code was kept, so the
   * scope shows exactly what changed since, read again when the capture changes.
   */
  changesSince?: { reviewRunId: string; label: string; refreshKey?: string };
  /** Set while showing an earlier capture instead of the current checkout. */
  historical?: { capturedAt?: string; headSha?: string; onBack(): void };
  artifacts: ArtifactRecord[];
  worktree?: WorktreeRecord;
  /** Imported work compares against a chosen base; the menu can change it. */
  comparison?: { label: string; onChange(): void; disabledReason?: string };
  /** What was asked, what the agent reported, and the reviewer's summary; its round, keyed by the request it answers, takes its links from the workspace. */
  brief?: Omit<ReviewBriefContent, 'round'> & { round?: Omit<NonNullable<ReviewBriefContent['round']>, 'onShowItem'> & { key: string } };
  /** The person's unsent review, saved with the task as it changes. */
  draft: TaskReviewDraft;
  onDraftChange(draft: TaskReviewDraft): void;
  /** What happens to each finding when the person requests changes. */
  plan: ReviewRequestPlan;
  /** False for an out-of-date review: its findings stay context and only comments are sent. */
  findingsSendable: boolean;
  /** Present while a request can be made: sends the findings to fix and the person's comments. */
  requestChanges?: ReviewRequestAction;
  /** With nothing to send, the step that finishes the task. */
  finish?: ReviewFinishAction;
  /** Present when a review can run: none yet, the code changed since it, or a finished one to run again. */
  runReview?: { label: string; disabledReason?: string; busy: boolean; onRun(): void };
  onDismissFinding?(findingId: string, reason: ReviewFindingDismissReason, note?: string): Promise<void>;
  onRestoreFinding?(findingId: string): Promise<void>;
  onAskAboutFinding?(findingId: string): void;
  /** A re-review's earlier findings that the code now resolves. */
  resolvedFindings?: readonly AgentReviewResolvedFinding[];
  /** Hands the selected lines, and what was typed about them, to Ask instead of the request. */
  onAskAboutLines?(lines: { path: string; side: 'NEW' | 'OLD'; line: number; endLine?: number }, text: string): void;
  /** Asks about a stage of the walkthrough (its section), a file of the change, or a discussion. */
  onAskAboutStage?(section: number): void;
  onAskAboutFile?(path: string): void;
  onAskAboutDiscussion?(discussionId: string): void;
  /**
   * The review's walkthrough, as the gate records it, read with the code it
   * describes; and the agent that wrote it.
   */
  walkthrough?: { state: ReviewWalkthroughState; view: WalkthroughView; author: string };
  /** A file shown full screen takes the whole page; the page hides its own chrome meanwhile. */
  onFullScreenChange?(fullScreen: boolean): void;
  /** Another surface asked to see the request, such as the Overview's Request changes; cleared once it opens. */
  requestSheetPending?: boolean;
  onRequestSheetOpened?(): void;
  /** Another surface asked to see a discussion, such as a comment the Overview lists; cleared once shown. */
  revealDiscussionId?: string;
  onDiscussionRevealed?(): void;
  /** The agent's answers no one posted yet, drafted as replies, by discussion. */
  replyDrafts?: ReadonlyMap<string, ReplyDraft>;
  /**
   * Posts a reply where the discussion lives, resolving its thread when asked;
   * absent once the pull request closed. Returns what failed after a reply that landed.
   */
  onReplyToDiscussion?(discussionId: string, body: string, resolve: boolean): Promise<string | undefined>;
  /** Resolves a thread, or reopens one. */
  onResolveDiscussion?(discussionId: string, resolved: boolean): Promise<void>;
  /** What the person typed in each reply and has not posted, kept while the task is open. */
  replyTexts?: ReadonlyMap<string, string>;
  onReplyTextChange?(discussionId: string, text: string | undefined): void;
  /** The person's account on the pull request's platform: their mark on what they write. */
  viewer?: string;
  /** The implementation agent's answers to the person's requests, on the items' bands. */
  answers?: {
    /** Who answers: its name heads each quoted answer. */
    agent: string;
    /** The latest request after the review, once answered: its items take the person's decisions. */
    round?: ReviewRoundView;
    /** Accepts the answer to an item of `round`, or reopens it; absent when the task takes no decisions. */
    onDecide?(item: number, kind: ReviewRequestItemDecisionKind): Promise<void>;
  };
  /** The implementation agent is waiting on the person: a question while it fixes a request, or a turn that stopped and needs continuing. */
  agentRequest?: { label: string; action: string; onOpen(): void };
  /** What people said on the pull request, with what the person did about each. */
  discussions?: DiscussionView[];
  /** The diff shown is the head the platform read the discussions on, so they sit on their lines. */
  discussionsOnLines?: boolean;
  /** The platform holds more discussions than were read: where to see them all. */
  moreDiscussionsUrl?: string;
}

/**
 * Rows of one block chosen in the gutter, by identity (`diffLineId`) so the
 * choice holds while unchanged lines open around it; the anchor is where the drag began.
 */
export interface LineSelection { fileId: string; blockId: string; start: string; end: string; anchor: string }

/** The comment being written, and where its composer opens. */
export interface CommentDraft {
  /** The row (`lineAnchorKey`), or `file:<id>`, a new comment's composer opens under; the comment's id while it is edited. */
  key: string;
  /** The file a new comment's composer opens in. */
  fileId?: string;
  path: string;
  side: ReviewComment['side'];
  line?: number;
  endLine?: number;
  editingId?: string;
}

/** What a band reflects: what has focus, what is in the request, what is being written. */
export interface ReviewBandsState {
  focusedFindingId?: string;
  focusedDiscussionId?: string;
  dismissingId?: string;
  included: ReadonlySet<string>;
  includedDiscussions: ReadonlySet<string>;
  /** False for an earlier capture or an out-of-date review: findings are context. */
  findingsActionable: boolean;
  findingsSendable: boolean;
  canComment: boolean;
  /** A re-review says which findings are earlier ones still open and which are new. */
  reReview: boolean;
  viewer?: string;
  commentDraft?: CommentDraft;
  /** The person's comments deleted since the tab opened: each folds to a line with Restore until the request goes. */
  deletedCommentIds: ReadonlySet<string>;
  replyTexts?: ReadonlyMap<string, string>;
  replyDrafts?: ReadonlyMap<string, ReplyDraft>;
  canDismiss: boolean;
  canRestore: boolean;
  canAskAboutFinding: boolean;
  canAskAboutLines: boolean;
  canAskAboutDiscussion: boolean;
  canReply: boolean;
  canResolve: boolean;
  /** Who answers the person's requests. */
  agent?: string;
  /** The latest request's answered items; absent while its reply runs, and for an earlier capture. */
  answers?: ReviewBandAnswers;
  canDecideAnswers: boolean;
}

/** Everything the Review tab's parts can do. Each one keeps its identity for the tab's life. */
export interface ReviewActions {
  /** The scroller both modes move, for a part that keeps its own place in it. */
  scroller(): HTMLElement | null;
  /** Moves to a file, opening it when asked; `instant` for a held key. */
  showFile(fileId: string, options?: { open?: boolean; instant?: boolean }): void;
  showFinding(findingId: string, options?: { instant?: boolean }): void;
  showDiscussion(discussionId: string, options?: { instant?: boolean }): void;
  showComment(commentId: string): void;
  /** An answered request item: its finding or discussion when the review still has it, else its file. */
  showRequestItem(item: ReviewRequestItem): void;
  /** Shows a file alone, or every file again when undefined. */
  showFullScreen(fileId: string | undefined, animate: boolean): void;
  setFileViewed(fileId: string, viewed: boolean): void;
  /** Folds or opens a file; `all` does the same to every file. */
  toggleCollapsed(fileId: string, all: boolean): void;
  setAllCollapsed(collapsed: boolean): void;
  revealLines(blockId: string, from: number, to: number): void;
  setWholeFile(fileId: string, whole: boolean): void;
  setScope(scope: ReviewScope): void;
  setOrder(order: ReviewFileOrder): void;
  foldBrief(folded: boolean): void;

  /** Reads the review the other way, keeping the place: the file and line being read, and in the Guide, its stage. */
  setMode(mode: ReviewMode): void;
  /** The Diff of one stage's files, from the place being read when it is one of them. */
  openInDiff(section: number): void;
  /** Moves to the overview or a stage of the walkthrough. */
  showStage(stage: GuideStageId, options?: { instant?: boolean }): void;
  /** Opens or folds a stage's other files ("N more files"). */
  toggleStageFiles(section: number): void;
  /** Opens a file's other changes ("3 more changes"). */
  openMoreChanges(fileId: string): void;
  /** Moves to lines of a file, opening what hides them; `mark` keeps them chosen until the next move. */
  showLines(fileId: string, anchors: readonly string[], options?: { mark?: boolean }): void;
  /** Lights lines while something that points at them is under the pointer or the keys; none clears them. */
  lightLines(fileId?: string, anchors?: readonly string[]): void;
  /** Clears the lines a move chose; false when none were. */
  clearMarks(): boolean;
  askAboutStage(section: number): void;
  askAboutFile(fileId: string): void;
  askAboutDiscussion(discussionId: string): void;

  focusFinding(findingId: string): void;
  focusDiscussion(discussionId: string): void;
  setDismissing(findingId: string | undefined): void;
  /** Opens a finding's reason and note, from the request sheet. */
  openDismiss(findingId: string): void;
  dismissFinding(findingId: string, reason: ReviewFindingDismissReason, note?: string): Promise<void>;
  restoreFinding(findingId: string): Promise<void>;
  askAboutFinding(findingId: string): void;
  setIncluded(findingId: string, include: boolean): void;
  toggleIncluded(findingId: string): void;
  setDiscussionIncluded(discussionId: string, include: boolean): void;
  toggleDiscussion(discussionId: string): void;
  setReplyText(discussionId: string, text: string | undefined): void;
  replyToDiscussion(discussionId: string, body: string, resolve: boolean): Promise<string | undefined>;
  resolveDiscussion(discussionId: string, resolved: boolean): Promise<void>;
  /** Puts the caret in a discussion's reply row; false when it has none. */
  focusReply(discussionId: string): boolean;
  /** Accepts the agent's answer to an item of the latest request, or reopens it. */
  decideAnswer(item: number, kind: ReviewRequestItemDecisionKind): Promise<void>;
  /**
   * Sends an answered item again in the person's words: a comment that starts
   * from a quote of it, on the row of the diff shown that its band sits under
   * (`where`), so its side and number are that row's; on its file when the row
   * takes no comments or the band is at the file's top; one with no place in the
   * files is quoted in the note.
   */
  requestAgain(item: ReviewRequestItem, where?: { fileId: string; blockId?: string; index?: number }): void;

  /**
   * The gutter: pressing a number, dragging across several, Shift extending the
   * last choice. The comment being written follows the lines chosen, its words kept.
   */
  beginSelect(fileId: string, blockId: string, index: number, event: ReactPointerEvent): void;
  extendSelect(fileId: string, blockId: string, index: number): void;
  clearSelection(): void;
  commentOnLine(fileId: string, blockId: string, index: number): void;
  /** C: the caret back in the comment being written, its file opened if folded. */
  writeComment(): void;
  commentOnFile(fileId: string): void;
  editComment(comment: ReviewComment): void;
  /** Takes a comment out of the draft; it folds to a line with Restore. `focus` hands the keys to that Restore. */
  deleteComment(commentId: string, options?: { focus?: boolean }): void;
  restoreComment(commentId: string): void;
  /** What the open composer holds, kept while its file folds and opens again. */
  commentText(): string;
  setCommentText(text: string): void;
  /** Saves what the composer holds, when it holds anything; the comment takes the keys where it now reads. */
  saveComment(): void;
  /** Cancel: the composer closes, and the keys go back to where the comment was being written. */
  closeComposer(): void;
  /** Escape: the composer closes when nothing typed would be lost, and otherwise keeps its words and hands back the keys. */
  leaveComposer(): void;
  askAboutLines(): void;

  setSheetOpen(open: boolean): void;
  submitRequest(): void;
  setNote(note: string): void;
  openPathMenu(path: string, event: ReactMouseEvent, line?: number): void;
  closePathMenu(): void;
  notifyError(message: string): void;
}

const ReviewActionsContext = createContext<ReviewActions | null>(null);
const ReviewBandsContext = createContext<ReviewBandsState | null>(null);
export const ReviewActionsProvider = ReviewActionsContext.Provider;
export const ReviewBandsProvider = ReviewBandsContext.Provider;

export function useReviewActions(): ReviewActions {
  const actions = useContext(ReviewActionsContext);
  if (!actions) throw new Error('A Review part rendered outside the Review tab.');
  return actions;
}

export function useReviewBands(): ReviewBandsState {
  const state = useContext(ReviewBandsContext);
  if (!state) throw new Error('A Review band rendered outside the Review tab.');
  return state;
}

export type ReviewModel = ReturnType<typeof useReviewModel>;

/** The overview, or a stage by its section's index. */
export type GuideStageId = 'overview' | number;

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
  /** Feedback with no place in the change. */
  outside: { findings: readonly ReviewFindingView[]; discussions: readonly DiscussionView[] };
}

/** A filter the Diff takes from a stage: its files only. */
interface DiffFilter { title: string; fileIds: ReadonlySet<string> }

const NO_FINDINGS: ReviewFindingView[] = [];
const NO_DISCUSSIONS: DiscussionView[] = [];
const NO_COMMENTS: ReviewComment[] = [];
const NO_FILES: DiffFile[] = [];
/** A file shown alone moves to the top of the column, and back to its place. */
const FILE_MOTION: ExpandMotion = { duration: '--motion-move', easing: '--ease-in-out' };
/** The file being read is the topmost one in the scroller's top 30%. */
const READING_BAND = (scroller: HTMLElement) => scroller.clientHeight * 0.3;
/** The stage being read is the one at the scroller's top. */
const STAGE_BAND = () => 40;
/** A file viewed keeps the signatures of its last few changes. */
const VIEWED_SIGNATURES = 4;

export const SCOPE_LABELS: Record<ReviewScope, string> = {
  all: 'All changes',
  committed: 'Committed',
  uncommitted: 'Uncommitted',
  'since-review': 'Since the review'
};

interface PendingTravel {
  /** What to move to; none moves to the top. */
  attribute?: 'data-file-id' | 'data-finding-id' | 'data-discussion-id' | 'data-comment-id' | 'data-stage' | 'data-line-anchor';
  value?: string;
  /** The file the element is in, for lines; when they do not show, its head is moved to. */
  within?: string;
  /** Puts the element this far from the scroller's top, instead of where `landing` would. */
  offset?: number;
  /** Lines chosen until the next move. */
  mark?: readonly string[];
  instant: boolean;
  focus: boolean;
}

/**
 * Where the keys go once a change to the person's comments has rendered, so
 * they never fall out of the tab: the composer's field, a comment (or its
 * Restore once deleted), or a control kept from before, such as the "+" of the
 * line a cancelled comment was under.
 */
type PendingFocus =
  | { to: 'composer' }
  | { to: 'comment'; id: string; restore?: boolean }
  | { to: 'control'; element: Element | null | undefined };

/** A comment taken out of the draft, and where it was, while it can be restored. */
interface DeletedComment { comment: ReviewComment; index: number }

export function useReviewModel(props: ReviewWorkspaceProps, scrollerRef: RefObject<HTMLElement | null>) {
  const { review, findings, draft, plan } = props;
  const diff = useDiffArtifact(props.currentDiffArtifactId, props.artifacts);
  const reviewed = useDiffArtifact(props.reviewedDiffArtifactId, props.artifacts);
  const stale = review?.status === 'STALE';
  const canCompareSinceReview = stale && !props.historical && !reviewed.missing && !reviewed.error;
  // Exactly what changed since the review, from the code it read; without that code, the files whose diff changed.
  const changes = useReviewChanges(props.taskId, props.historical ? undefined : props.changesSince?.reviewRunId, props.changesSince?.refreshKey);
  const changedSinceReview = useMemo(
    () => (canCompareSinceReview && !reviewed.loading && !diff.loading ? filesChangedSinceReview(reviewed.filesByScope.all, diff.filesByScope.all) : undefined),
    [canCompareSinceReview, diff.filesByScope.all, diff.loading, reviewed.filesByScope.all, reviewed.loading]
  );
  // The scope is offered only when something changed since the review, and leads while the review is out of date; never an empty scope.
  const sinceReviewAvailable = changes.files ? changes.files.length > 0 : Boolean(changedSinceReview?.size);
  const sinceReviewLabel = props.changesSince?.label ?? SCOPE_LABELS['since-review'];
  const [chosenScope, setScope] = useState<ReviewScope>();
  const scope = chosenScope ?? (stale && sinceReviewAvailable ? 'since-review' : 'all');
  const effectiveScope: ReviewScope = scope === 'since-review' && !sinceReviewAvailable ? 'all' : scope;
  // The exact changes' removed lines are the reviewed code's, not the base's, so they take no comments.
  const exactChanges = effectiveScope === 'since-review' && Boolean(changes.files);
  const capturedFiles: DiffFile[] = useMemo(() => (effectiveScope === 'since-review'
    ? changes.files ?? diff.filesByScope.all.filter((file) => changedSinceReview?.has(normalizeReviewPath(file.path)))
    : diff.filesByScope[effectiveScope]), [changedSinceReview, changes.files, diff.filesByScope, effectiveScope]);
  // The checkout's unchanged lines fill each file's gaps, hidden until revealed; never for an earlier capture.
  const context = useReviewContext({
    worktree: props.historical ? undefined : props.worktree,
    captureId: props.historical ? undefined : props.currentDiffArtifactId,
    artifacts: props.artifacts,
    files: capturedFiles
  });
  const files = context.files;
  const gutterWidth = useMemo(() => reviewGutterWidth(files, context.fillable), [files, context.fillable]);
  // Until the reviewed diff is read, the default scope is unknown, so the tab is loading, not showing one and then the other.
  const loading = diff.loading || (canCompareSinceReview && !chosenScope && (reviewed.loading || changes.loading));

  // Findings wait for the diff, so they never appear under General and then jump to their lines.
  const visibleFindings = props.historical || loading ? NO_FINDINGS : findings;
  // Measured from this review's own code, the findings' lines are on the old side.
  const findingSide = exactChanges && props.changesSince?.reviewRunId === review?.runId ? 'REVIEWED' : 'NEW';
  const anchoredFindings = useMemo(() => anchorReviewFindings(files, visibleFindings, findingSide), [files, visibleFindings, findingSide]);
  // The agent's answers wait for the diff as findings do. The answered request's own comments left the
  // draft when it went, so they sit where they were written again, before any written since.
  const bandAnswers = useMemo(
    () => (props.answers?.round && !props.historical && !loading ? reviewBandAnswers(props.answers.round) : undefined),
    [loading, props.answers?.round, props.historical]
  );
  // A comment the person deleted keeps its place, folded with Restore, until the request goes.
  const [deletedComments, setDeletedComments] = useState<readonly DeletedComment[]>([]);
  const writtenComments = useMemo(() => withDeleted(draft.comments, deletedComments), [deletedComments, draft.comments]);
  const shownComments = useMemo(() => (bandAnswers?.comments.size
    ? [...[...bandAnswers.comments.values()].map((sent) => sent.comment), ...writtenComments]
    : writtenComments), [bandAnswers, writtenComments]);
  // The latest request's comments were written on the code the review read: measured from that code, their lines are on the old side, as its findings' are.
  const anchoredComments = useMemo(() => anchorReviewComments(files, shownComments, (comment) =>
    (findingSide === 'REVIEWED' && comment.side === 'NEW' && bandAnswers?.comments.has(comment.id) ? 'REVIEWED' : comment.side)), [bandAnswers, files, findingSide, shownComments]);
  // Discussions wait for the diff as findings do, and belong to the current head, not an earlier capture.
  const discussions = props.historical || loading ? NO_DISCUSSIONS : props.discussions ?? NO_DISCUSSIONS;
  const discussionsOnLines = Boolean(props.discussionsOnLines) && effectiveScope !== 'since-review';
  const anchoredDiscussions = useMemo(() => anchorReviewDiscussions(files, discussions, discussionsOnLines), [files, discussions, discussionsOnLines]);
  const anchors = useMemo<ReviewAnchors>(
    () => ({ findings: anchoredFindings, discussions: anchoredDiscussions, comments: anchoredComments }),
    [anchoredComments, anchoredDiscussions, anchoredFindings]
  );
  const diffFeedback = useMemo(() => feedbackByFile(files, anchors), [anchors, files]);

  const [order, setOrder] = useState<ReviewFileOrder>(readReviewFileOrder);
  const ordered = useMemo(() => orderReviewFiles(files, diffFeedback.findingsByFile, order), [diffFeedback.findingsByFile, files, order]);
  // A stage opened in the Diff narrows it to the stage's files, while any of them is in it: never an empty scope.
  const [diffFilter, setDiffFilter] = useState<DiffFilter>();
  const diffOrdered = useMemo(() => {
    const kept = diffFilter ? ordered.filter((entry) => diffFilter.fileIds.has(entry.file.id)) : ordered;
    return kept.length ? kept : ordered;
  }, [diffFilter, ordered]);
  // Each file's change has one signature per capture; viewed holds while unchanged lines open.
  const signatures = useMemo(() => new Map(capturedFiles.map((file) => [file.id, diffFileSignature(file)])), [capturedFiles]);
  const diffReading = useMemo(
    () => readingOf({ files, ordered: diffOrdered, anchors, feedback: diffFeedback, signatures, gutterWidth, foldedByDefault: (entry) => entry.role === 'generated' }),
    [anchors, diffFeedback, diffOrdered, files, gutterWidth, signatures]
  );

  // The walkthrough, over the code the review read: this review's findings, the discussions where they sit
  // (on their lines while that code is the head the platform read them on), and the person's comments while
  // that code is what the Diff shows. An earlier walkthrough is context, written on code since changed.
  const walkthrough = props.walkthrough;
  const stored = walkthrough?.state.status === 'STORED' ? walkthrough.state : undefined;
  // It is the code shown while the diff has not moved since the review: the review's own walkthrough, or an
  // earlier one written on the very tree the review reads (a review run again on unchanged code).
  const writtenOn = walkthrough?.view.walkthrough?.tree;
  const guideCurrent = Boolean(stored && review && review.status !== 'STALE' &&
    (writtenOn && review.reviewedTreeSha ? writtenOn === review.reviewedTreeSha : stored.reviewRunId === review.runId));
  const ownWalkthrough = Boolean(stored && stored.reviewRunId === review?.runId);
  // Once the code moved on, the comments the latest request carried still sit in the review's own
  // walkthrough with their answers: a request names its review only when it was sent while that review
  // was current, so they were written on the code the walkthrough shows. Comments written since were not.
  const guideComments = useMemo(
    () => (guideCurrent ? shownComments : ownWalkthrough && bandAnswers ? [...bandAnswers.comments.values()].map((sent) => sent.comment) : NO_COMMENTS),
    [bandAnswers, guideCurrent, ownWalkthrough, shownComments]
  );
  const guideFiles = walkthrough?.view.files ?? NO_FILES;
  const guideDiscussions = props.historical ? NO_DISCUSSIONS : props.discussions ?? NO_DISCUSSIONS;
  const guideAnchors = useMemo<ReviewAnchors>(() => ({
    findings: anchorReviewFindings(guideFiles, ownWalkthrough ? findings : NO_FINDINGS),
    discussions: anchorReviewDiscussions(guideFiles, guideDiscussions, Boolean(props.discussionsOnLines) && guideCurrent),
    comments: anchorReviewComments(guideFiles, guideComments)
  }), [findings, guideComments, guideCurrent, guideDiscussions, guideFiles, ownWalkthrough, props.discussionsOnLines]);
  const guideModel = useMemo(
    () => (walkthrough?.view.walkthrough && walkthrough.view.files ? buildGuide(walkthrough.view.walkthrough, walkthrough.view.files, guideAnchors) : undefined),
    [guideAnchors, walkthrough?.view.files, walkthrough?.view.walkthrough]
  );
  const folders = useMemo(() => filesByFolder(files), [files]);
  const [guideOpenState, setGuideOpen] = useState<GuideOpen>(NO_GUIDE_OPEN);
  const guideOpen = guideModel && guideOpenState.key === guideModel.reviewRunId ? guideOpenState : NO_GUIDE_OPEN;
  const guideFeedback = useMemo(() => feedbackByFile(guideFiles, guideAnchors), [guideAnchors, guideFiles]);
  const guideSignatures = useMemo(() => new Map(guideFiles.map((file) => [file.id, diffFileSignature(file)])), [guideFiles]);
  const guideReading = useMemo(() => {
    if (!guideModel) {
      // Before a walkthrough, the Guide reads the Diff's files by folder, each folded to its head.
      const byId = new Map(ordered.map((entry) => [entry.file.id, entry]));
      const byFolder = folders.flatMap((group) => group.fileIds.flatMap((id) => byId.get(id) ?? []));
      return readingOf({ files, ordered: byFolder, anchors, feedback: diffFeedback, signatures, gutterWidth, foldedByDefault: () => true });
    }
    const stageOrder = guideModel.stages.flatMap((stage) => [...stage.shown, ...stage.folded]);
    return readingOf({
      files: guideFiles,
      ordered: stageOrder.map((id) => {
        const file = guideModel.files.get(id)!.file.file;
        return { file, role: reviewFileRole(file.path) };
      }),
      fileIds: guideReadingOrder(guideModel, guideOpen.groups),
      anchors: guideAnchors,
      feedback: guideFeedback,
      signatures: guideSignatures,
      gutterWidth: reviewGutterWidth(guideFiles, false),
      foldedByDefault: (entry) => !guideModel.files.get(entry.file.id)?.file.shown
    });
  }, [anchors, diffFeedback, files, folders, guideAnchors, guideFeedback, guideFiles, guideModel, guideOpen.groups, guideSignatures, gutterWidth, ordered, signatures]);

  // The mode the person last read this task in, else the Guide when its walkthrough is the code shown.
  const [chosenMode, setChosenMode] = useState<ReviewMode>(() => readReviewMode(props.taskId) ?? (guideCurrent ? 'guide' : 'diff'));
  const mode: ReviewMode = props.historical ? 'diff' : chosenMode;
  const reading = mode === 'guide' ? guideReading : diffReading;
  const { filesById, ordered: readingOrdered, fileIds, findingsByFile, discussionsByFile } = reading;
  const openFindings = useMemo(() => findings.filter((finding) => finding.state === 'OPEN'), [findings]);
  const findingsActionable = props.findingsSendable && !props.historical;
  // Comments are written on the code shown now: never on an earlier capture or an earlier walkthrough.
  const canComment = !props.historical && (mode === 'diff' || !guideModel || guideCurrent);
  const included = useMemo(() => new Set(plan.send.map((finding) => finding.id)), [plan.send]);
  const includedDiscussions = useMemo(() => new Set(plan.discussions.map((discussion) => discussion.id)), [plan.discussions]);
  const reReview = Boolean(props.resolvedFindings?.length || findings.some((finding) => finding.previousFindingId));

  // Viewed is one system for both modes, by path: a file is viewed in a mode while its change there is one
  // the person marked, in that mode or, while the walkthrough is the code shown, in the other.
  const [viewed, setViewed] = useState<Record<string, string[]>>(() => readViewedFiles(props.taskId));
  const viewedIn = (target: ReviewReading, fileId: string) => {
    const file = target.filesById.get(fileId);
    const signature = target.signatures.get(fileId);
    return Boolean(file && signature && viewed[file.path]?.includes(signature));
  };
  const viewedIds = useMemo(
    () => new Set(reading.files.filter((file) => viewed[file.path]?.includes(reading.signatures.get(file.id) ?? '')).map((file) => file.id)),
    [reading, viewed]
  );
  // Collapsing is the person's choice per file and mode; a viewed file starts collapsed, and so does a generated
  // file in the Diff and a file among a stage's others in the Guide.
  const [collapsedOverride, setCollapsedOverride] = useState<Record<ReviewMode, Record<string, boolean>>>({ guide: {}, diff: {} });
  const collapsedIn = (target: ReviewMode, entry: OrderedReviewFile) => collapsedOverride[target][entry.file.id] ??
    (viewedIn(target === 'guide' ? guideReading : diffReading, entry.file.id) || (target === 'guide' ? guideReading : diffReading).foldedByDefault(entry));
  const isCollapsed = (entry: OrderedReviewFile) => collapsedIn(mode, entry);

  const [focusedFindingId, setFocusedFindingId] = useState<string>();
  const [focusedDiscussionId, setFocusedDiscussionId] = useState<string>();
  const [dismissingId, setDismissingId] = useState<string>();
  // The navigator and a stage's file list follow the reading position; a navigation sets it where it lands.
  const [activeFileId, setActiveFileId] = useScrollSpy(scrollerRef, 'data-file-id', READING_BAND, `${mode}\u0000${fileIds.join('\u0000')}`);
  const [activeStageKey, setActiveStage] = useScrollSpy(scrollerRef, 'data-stage', STAGE_BAND, mode === 'guide' && guideModel ? `${guideModel.reviewRunId}:${guideModel.stages.length}` : '');
  const activeStage: GuideStageId | undefined = activeStageKey === undefined ? undefined : activeStageKey === 'overview' ? 'overview' : Number(activeStageKey);
  // Show only this file: the file alone at the top of the column, the navigator
  // beside it. Moving to another file moves the focus; leaving returns the list
  // to where it was read. The Diff's alone.
  const [focusedFileId, setFocusedFileId] = useState<string>();
  const focusedFile = mode === 'diff' && focusedFileId && fileIds.includes(focusedFileId) ? focusedFileId : undefined;
  const listScroll = useRef<{ fileId: string; top: number }>(undefined);
  const [selection, setSelection] = useState<LineSelection>();
  const selectionRef = useRef<LineSelection | undefined>(undefined);
  const dragging = useRef(false);
  const [commentDraft, setCommentDraft] = useState<CommentDraft>();
  const commentText = useRef('');
  // What the composer held when it opened: Escape closes it while it still holds just that.
  const commentStart = useRef('');
  const [pendingFocus, setPendingFocus] = useState<PendingFocus>();
  const [sheetOpen, setSheetOpen] = useState(false);
  // The brief's fold is kept per review, and opens again when new answers arrive.
  const briefRound = `${review?.runId ?? 'none'}${props.brief?.round ? `:${props.brief.round.key}` : ''}`;
  const [briefFold, setBriefFold] = useState(() => ({ round: briefRound, folded: readBriefFolded(props.taskId, briefRound) }));
  const briefFolded = briefFold.round === briefRound ? briefFold.folded : readBriefFolded(props.taskId, briefRound);
  const [pathMenu, setPathMenu] = useState<{ target: OpenTargetRef; position: { x: number; y: number } }>();
  // A move into a file that has to open first waits for it to render.
  const [pendingTravel, setPendingTravel] = useState<PendingTravel>();
  const notify = useNotify();

  // An emptied request has nothing to show and loses the summary the sheet rises from, so the sheet closes with it.
  if (sheetOpen && !plan.queued) setSheetOpen(false);

  // The actions read what is current when they run, never what was current when the tab first rendered.
  const latest = {
    props, mode, ordered: readingOrdered, filesById, findingsByFile, discussionsByFile, discussions, isCollapsed, collapsedIn, focusedFile,
    selection, commentDraft, deletedComments, readings: { guide: guideReading, diff: diffReading }, guide: guideModel, guideCurrent, activeFileId, activeStage,
    included, includedDiscussions, briefRound, notify, reveal: context.reveal, setWholeFile: context.setWholeFile
  };
  const live = useRef(latest);
  useLayoutEffect(() => { live.current = latest; });

  const actions = useMemo<ReviewActions>(() => {
    const now = () => live.current;
    const fileElement = (fileId: string | undefined) => (fileId === undefined ? null
      : scrollerRef.current?.querySelector<HTMLElement>(`[data-file-id=${quoted(fileId)}]`) ?? null);
    const entryOf = (fileId: string | undefined) => now().ordered.find((entry) => entry.file.id === fileId);
    const entryOfPath = (path: string) => now().ordered.find((entry) => normalizeReviewPath(entry.file.path) === normalizeReviewPath(path));
    const expandIn = (target: ReviewMode, fileId: string) => setCollapsedOverride((current) => ({ ...current, [target]: { ...current[target], [fileId]: false } }));
    const expand = (fileId: string) => expandIn(now().mode, fileId);
    const openIfCollapsed = (entry: OrderedReviewFile | undefined) => { if (entry && now().isCollapsed(entry)) expand(entry.file.id); };
    // In the Guide, a place may wait behind its stage's other files or its file's other changes.
    const revealIn = (target: ReviewMode, fileId: string, anchor?: string) => {
      const { guide } = now();
      const need = target === 'guide' && guide ? guideReveal(guide, fileId, anchor) : undefined;
      if (guide && need && (need.group !== undefined || need.more !== undefined)) setGuideOpen((current) => openInGuide(current, guide.reviewRunId, need));
    };
    // The file read is where a move lands; in the Guide, so is its stage.
    const follow = (fileId: string) => {
      setActiveFileId(fileId);
      const stage = now().mode === 'guide' ? now().guide?.files.get(fileId)?.stage : undefined;
      if (stage !== undefined) setActiveStage(String(stage));
    };
    // The line a band sits under: the last of its range, on its side.
    const bandPlace = (path: string, place: { side?: 'NEW' | 'OLD'; line?: number; endLine?: number }) =>
      (place.line ? lineAnchor(path, place.side ?? 'NEW', place.endLine && place.endLine > place.line ? place.endLine : place.line) : undefined);
    const updateDraft = (patch: Partial<TaskReviewDraft>) => now().props.onDraftChange({ ...now().props.draft, ...patch });
    const go = (target: PendingTravel) => setPendingTravel(target);

    const showFullScreen = (fileId: string | undefined, animate: boolean) => {
      const { focusedFile: current } = now();
      const scroller = scrollerRef.current;
      const leaving = fileId ? undefined : current;
      if (fileId && !current) listScroll.current = { fileId, top: scroller?.scrollTop ?? 0 };
      changeWithMotion(animate ? fileElement(fileId ?? leaving) : undefined, () => {
        if (fileId) { expand(fileId); setActiveFileId(fileId); }
        setFocusedFileId(fileId);
      }, FILE_MOTION, () => {
        if (!scroller) return;
        stopTravel(scroller);
        // Focus inside a file that stepped aside stays in the column, so J and K keep working.
        if (document.activeElement?.closest('[hidden]')) scroller.focus({ preventScroll: true });
        if (fileId) scroller.scrollTop = 0;
        else if (leaving && listScroll.current?.fileId === leaving) scroller.scrollTop = listScroll.current.top;
        else {
          const left = fileElement(leaving);
          if (left) travel(scroller, left, { instant: true });
        }
      });
    };
    // While one file is shown alone, going to another file's place takes the focus there.
    const followFullScreen = (fileId: string | undefined) => {
      const { focusedFile: current } = now();
      if (current && fileId !== current) showFullScreen(fileId, false);
    };
    const showFinding = (findingId: string, { instant = false } = {}) => {
      setFocusedFindingId(findingId);
      setFocusedDiscussionId(undefined);
      const entry = now().ordered.find((candidate) => (now().findingsByFile.get(candidate.file.id) ?? []).some((finding) => finding.id === findingId));
      followFullScreen(entry?.file.id);
      if (entry) {
        const finding = now().findingsByFile.get(entry.file.id)?.find((candidate) => candidate.id === findingId);
        revealIn(now().mode, entry.file.id, finding ? bandPlace(entry.file.path, finding) : undefined);
        follow(entry.file.id);
      }
      openIfCollapsed(entry);
      go({ attribute: 'data-finding-id', value: findingId, instant, focus: true });
    };
    const showDiscussion = (discussionId: string, { instant = false } = {}) => {
      setFocusedDiscussionId(discussionId);
      setFocusedFindingId(undefined);
      const entry = now().ordered.find((candidate) => (now().discussionsByFile.get(candidate.file.id) ?? []).some((discussion) => discussion.id === discussionId));
      followFullScreen(entry?.file.id);
      if (entry) {
        const discussion = now().discussionsByFile.get(entry.file.id)?.find((candidate) => candidate.id === discussionId);
        revealIn(now().mode, entry.file.id, discussion ? bandPlace(entry.file.path, discussion) : undefined);
        follow(entry.file.id);
      }
      openIfCollapsed(entry);
      go({ attribute: 'data-discussion-id', value: discussionId, instant, focus: true });
    };
    const showFile = (fileId: string, { open = false, instant = false } = {}) => {
      const { focusedFile: current } = now();
      if (current && fileId !== current) { showFullScreen(fileId, false); return; }
      if (open) {
        revealIn(now().mode, fileId);
        openIfCollapsed(entryOf(fileId));
      }
      follow(fileId);
      go({ attribute: 'data-file-id', value: fileId, instant, focus: false });
    };
    // Switching modes keeps the place: the same line at the same height, opening whatever hides it. Lines
    // match only while both modes read one code, the Diff's own or a walkthrough of it; on an earlier
    // walkthrough, the file is kept.
    const switchMode = (next: ReviewMode, filter?: DiffFilter) => {
      const current = now();
      if (current.props.historical || current.mode === next) return;
      const scroller = scrollerRef.current;
      const read = scroller ? readPlace(scroller, current.activeFileId) : undefined;
      // A stage's Diff holds its files alone: a place outside them is not kept.
      const kept = read && (!filter || filter.fileIds.has(read.fileId)) ? read : undefined;
      const place: { fileId: string; lineAnchor?: string; offset?: number } | undefined = kept && current.guide && !current.guideCurrent ? { fileId: kept.fileId } : kept;
      setDiffFilter(next === 'diff' ? filter : undefined);
      setFocusedFileId(undefined);
      const entry = place ? current.readings[next].ordered.find((candidate) => candidate.file.id === place.fileId) : undefined;
      if (place && entry) {
        revealIn(next, place.fileId, place.lineAnchor);
        if (place.lineAnchor && current.collapsedIn(next, entry)) expandIn(next, place.fileId);
        setActiveFileId(place.fileId);
      }
      setChosenMode(next);
      writeReviewMode(current.props.taskId, next);
      go(place && entry
        ? { attribute: place.lineAnchor ? 'data-line-anchor' : 'data-file-id', value: place.lineAnchor ?? place.fileId, within: place.fileId, ...(place.offset !== undefined ? { offset: place.offset } : {}), instant: true, focus: false }
        : { instant: true, focus: false });
    };
    // A stage in the Diff: its files of the change the review read, all of it and never a Git layer of it. Once
    // the code moved on from the walkthrough, the Diff leads as it does for the review, with what changed since
    // it. The one stage of a one-intent change is the whole change, so its Diff is not narrowed.
    const openStageInDiff = (section: number) => {
      const { guide, guideCurrent } = now();
      const stages = guide?.stages ?? [];
      const stage = stages[section];
      if (!stage) return;
      setScope(guideCurrent ? 'all' : undefined);
      switchMode('diff', stages.length > 1 ? { title: stage.title, fileIds: new Set(stage.files.map((file) => file.file.id)) } : undefined);
    };

    const applySelection = (next?: LineSelection) => { selectionRef.current = next; setSelection(next); };
    const blockOf = (fileId: string, blockId: string) => {
      const file = now().filesById.get(fileId);
      const block = file?.blocks.find((candidate) => candidate.id === blockId);
      return file && block ? { file, block } : undefined;
    };
    // One comment is written at a time. It opens, or moves, where the person chose and takes the caret; a new
    // one keeps its words as it moves, so choosing other lines never costs them, and an edit ends unsaved.
    const showComposer = (next: CommentDraft, start = '') => {
      const open = now().commentDraft;
      if (!open || open.editingId || next.editingId) {
        commentText.current = start;
        commentStart.current = start;
      }
      setCommentDraft(next);
      setPendingFocus({ to: 'composer' });
    };
    const openComposer = (file: DiffFile, block: DiffBlock, chosen: Pick<LineSelection, 'start' | 'end' | 'anchor'>, start = '') => {
      const range = selectionRange(block, chosen);
      if (!range) return;
      const side: ReviewComment['side'] = block.lines[range.anchor]!.kind === 'deletion' ? 'OLD' : 'NEW';
      // A block's rows run in file order, so the first and the last numbered row on the side are its lines,
      // however many there are.
      let line: number | undefined;
      let last: number | undefined;
      for (let index = range.start; index <= range.end; index += 1) {
        const row = block.lines[index]!;
        const number = side === 'OLD' ? (row.kind === 'deletion' ? row.oldLine : undefined) : row.newLine;
        if (number === undefined) continue;
        line ??= number;
        last = number;
      }
      if (line === undefined || last === undefined) return;
      // The lines it is about stay chosen in the gutter while it is written, however it opened.
      applySelection({ fileId: file.id, blockId: block.id, start: chosen.start, end: chosen.end, anchor: chosen.anchor });
      showComposer({ key: lineAnchorKey(file.id, block.id, block.lines[range.end]!, range.end), fileId: file.id, path: file.path, side, line, endLine: last > line ? last : undefined }, start);
    };
    // A comment on a whole file opens at its top.
    const openFileComposer = (file: DiffFile, start = '') => {
      openIfCollapsed(entryOf(file.id));
      applySelection(undefined);
      showComposer({ key: `file:${file.id}`, fileId: file.id, path: file.path, side: 'NEW' }, start);
    };
    const endComposer = () => { commentText.current = ''; commentStart.current = ''; setCommentDraft(undefined); applySelection(undefined); };
    // Cancelled, the keys go back to where the comment was written: the comment an edit was of; else what sits just
    // above the composer, read before it goes: its line's "+", the band before it at a file's top, or the file's menu.
    const closeComposer = () => {
      const open = now().commentDraft;
      const form = scrollerRef.current?.querySelector('.tm-review-comment-composer');
      const before = form?.previousElementSibling;
      setPendingFocus(open?.editingId ? { to: 'comment', id: open.editingId } : {
        to: 'control',
        element: form?.closest('.tm-review-line-group')?.querySelector('.tm-review-line__comment')
          ?? (before?.matches(BAND) ? before : form?.closest('[data-file-id]')?.querySelector('.tm-review-file__menu__trigger'))
      });
      endComposer();
    };
    const setIncluded = (findingId: string, include: boolean) => {
      const { props: current } = now();
      const runId = current.review?.runId;
      const ids = current.draft.reviewRunId === runId ? current.draft.includedFindingIds : [];
      updateDraft({ reviewRunId: runId, includedFindingIds: include ? [...new Set([...ids, findingId])] : ids.filter((id) => id !== findingId) });
    };
    const setDiscussionIncluded = (discussionId: string, include: boolean) => {
      const ids = now().props.draft.includedDiscussionIds;
      updateDraft({ includedDiscussionIds: include ? [...new Set([...ids, discussionId])] : ids.filter((id) => id !== discussionId) });
    };

    return {
      scroller: () => scrollerRef.current,
      showFile,
      showFinding,
      showDiscussion,
      showComment: (commentId) => {
        const comment = now().props.draft.comments.find((candidate) => candidate.id === commentId);
        const entry = comment ? entryOfPath(comment.path) : undefined;
        followFullScreen(entry?.file.id);
        if (entry && comment) {
          revealIn(now().mode, entry.file.id, bandPlace(entry.file.path, comment));
          follow(entry.file.id);
        }
        openIfCollapsed(entry);
        // Landed on, the comment takes the keys and its mark, as a finding or a discussion does.
        go({ attribute: 'data-comment-id', value: commentId, instant: false, focus: true });
      },
      showRequestItem: (item) => {
        if (item.kind === 'FINDING' && now().props.findings.some((finding) => finding.id === item.findingId)) { showFinding(item.findingId); return; }
        if (item.kind === 'DISCUSSION' && now().discussions.some((discussion) => discussion.id === item.discussionId)) { showDiscussion(item.discussionId); return; }
        const entry = item.path ? entryOfPath(item.path) : undefined;
        if (entry) showFile(entry.file.id, { open: true });
      },
      showFullScreen,
      setFileViewed: (fileId, next) => {
        const { mode: current, readings, guideCurrent, props: { taskId } } = now();
        const file = readings[current].filesById.get(fileId);
        const signature = readings[current].signatures.get(fileId);
        if (!file || !signature) return;
        // While the walkthrough is the code the Diff shows, the file's change is one in both modes, so one mark serves both.
        const twin = guideCurrent ? readings[current === 'guide' ? 'diff' : 'guide'].signatures.get(fileId) : undefined;
        setViewed((stored) => {
          const updated = { ...stored };
          if (next) updated[file.path] = [...new Set([signature, ...(twin ? [twin] : []), ...(stored[file.path] ?? [])])].slice(0, VIEWED_SIGNATURES);
          else delete updated[file.path];
          writeViewedFiles(taskId, updated);
          return updated;
        });
      },
      toggleCollapsed: (fileId, all) => {
        const entry = entryOf(fileId);
        if (!entry) return;
        const { mode: target, ordered: entries } = now();
        const next = !now().isCollapsed(entry);
        setCollapsedOverride((current) => ({
          ...current,
          [target]: all ? Object.fromEntries(entries.map((candidate) => [candidate.file.id, next])) : { ...current[target], [fileId]: next }
        }));
      },
      setAllCollapsed: (collapsed) => {
        const { mode: target, ordered: entries } = now();
        setCollapsedOverride((current) => ({ ...current, [target]: Object.fromEntries(entries.map((entry) => [entry.file.id, collapsed])) }));
      },
      revealLines: (blockId, from, to) => now().reveal(blockId, from, to),
      setWholeFile: (fileId, whole) => {
        const entry = entryOf(fileId);
        if (whole) openIfCollapsed(entry);
        now().setWholeFile(fileId, whole);
      },
      setScope: (next) => { setScope(next); setDiffFilter(undefined); },
      setOrder: (next) => { setOrder(next); writeReviewFileOrder(next); },
      foldBrief: (folded) => {
        const { briefRound: round, props: current } = now();
        setBriefFold({ round, folded });
        writeBriefFolded(current.taskId, round, folded);
      },

      // From a stage, the Diff opens narrowed to its files, as the stage's Open in Diff does; elsewhere it is the mode alone.
      setMode: (next) => {
        const current = now();
        const scroller = scrollerRef.current;
        if (next === 'diff' && current.mode === 'guide' && current.guide && scroller) {
          const read = readPlace(scroller, current.activeFileId);
          const section = read ? current.guide.files.get(read.fileId)?.stage : current.activeStage === 'overview' ? undefined : current.activeStage;
          if (section !== undefined) { openStageInDiff(section); return; }
        }
        switchMode(next);
      },
      openInDiff: openStageInDiff,
      showStage: (stage, { instant = false } = {}) => {
        const { guide } = now();
        if (!guide) return;
        setActiveStage(String(stage));
        // The stage's first file is where its code starts; on the overview no file is under way.
        setActiveFileId(stage === 'overview' ? undefined : guide.stages[stage]?.shown[0]);
        go({ attribute: 'data-stage', value: String(stage), instant, focus: false });
      },
      toggleStageFiles: (section) => {
        const { guide } = now();
        if (!guide) return;
        setGuideOpen((current) => {
          const base = current.key === guide.reviewRunId ? current : { ...NO_GUIDE_OPEN, key: guide.reviewRunId };
          const groups = new Set(base.groups);
          if (!groups.delete(section)) groups.add(section);
          return { ...base, groups };
        });
      },
      openMoreChanges: (fileId) => {
        const { guide } = now();
        if (guide) setGuideOpen((current) => openInGuide(current, guide.reviewRunId, { more: fileId }));
      },
      showLines: (fileId, anchors, { mark = false } = {}) => {
        const entry = entryOf(fileId);
        if (!entry || !anchors.length) return;
        revealIn(now().mode, fileId, anchors[0]);
        openIfCollapsed(entry);
        follow(fileId);
        go({ attribute: 'data-line-anchor', value: anchors[0], within: fileId, instant: false, focus: false, ...(mark ? { mark: anchors } : {}) });
      },
      // Lit by setting an attribute on the rows themselves, so the pointer never renders a row.
      lightLines: (fileId, anchors) => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        scroller.querySelectorAll('[data-lit]').forEach((row) => row.removeAttribute('data-lit'));
        const file = fileElement(fileId);
        if (file && anchors) for (const row of linesOf(file, anchors)) row.setAttribute('data-lit', '');
      },
      clearMarks: () => {
        const marked = scrollerRef.current?.querySelectorAll('[data-marked]') ?? [];
        marked.forEach((row) => row.removeAttribute('data-marked'));
        return marked.length > 0;
      },
      askAboutStage: (section) => now().props.onAskAboutStage?.(section),
      askAboutFile: (fileId) => {
        const file = now().filesById.get(fileId);
        if (file) now().props.onAskAboutFile?.(file.path);
      },
      askAboutDiscussion: (discussionId) => now().props.onAskAboutDiscussion?.(discussionId),

      focusFinding: (findingId) => { setFocusedFindingId(findingId); setFocusedDiscussionId(undefined); },
      focusDiscussion: (discussionId) => { setFocusedDiscussionId(discussionId); setFocusedFindingId(undefined); },
      setDismissing: setDismissingId,
      openDismiss: (findingId) => { setSheetOpen(false); setDismissingId(findingId); showFinding(findingId); },
      dismissFinding: (...args) => now().props.onDismissFinding?.(...args) ?? Promise.resolve(),
      restoreFinding: (findingId) => now().props.onRestoreFinding?.(findingId) ?? Promise.resolve(),
      askAboutFinding: (findingId) => now().props.onAskAboutFinding?.(findingId),
      setIncluded,
      toggleIncluded: (findingId) => setIncluded(findingId, !now().included.has(findingId)),
      setDiscussionIncluded,
      toggleDiscussion: (discussionId) => setDiscussionIncluded(discussionId, !now().includedDiscussions.has(discussionId)),
      setReplyText: (discussionId, text) => now().props.onReplyTextChange?.(discussionId, text),
      replyToDiscussion: (discussionId, body, resolve) => now().props.onReplyToDiscussion?.(discussionId, body, resolve) ?? Promise.resolve(undefined),
      resolveDiscussion: (discussionId, resolved) => now().props.onResolveDiscussion?.(discussionId, resolved) ?? Promise.resolve(),
      focusReply: (discussionId) => {
        const field = scrollerRef.current?.querySelector<HTMLTextAreaElement>(`[data-discussion-id=${quoted(discussionId)}] .tm-review-thread__reply-input`);
        field?.focus();
        return Boolean(field);
      },
      decideAnswer: (item, kind) => now().props.answers?.onDecide?.(item, kind) ?? Promise.resolve(),
      requestAgain: (item, where) => {
        const quote = requestItemQuote(item);
        const file = where ? now().filesById.get(where.fileId) : undefined;
        if (!where || !file) {
          const note = now().props.draft.note.trimEnd();
          updateDraft({ note: note ? `${note}\n\n${quote}\n` : `${quote}\n` });
          return;
        }
        // The item's own numbers are on the code the review read; the row its band sits under is in the diff shown.
        const found = where.blockId !== undefined && where.index !== undefined ? blockOf(file.id, where.blockId) : undefined;
        const row = found && where.index !== undefined ? found.block.lines[where.index] : undefined;
        const key = found && row && where.index !== undefined ? lineAnchorKey(file.id, found.block.id, row, where.index) : `file:${file.id}`;
        // Already being written there, it takes the caret; words being written elsewhere come along after the quote.
        const open = now().commentDraft;
        if (open && !open.editingId && open.key === key) { setPendingFocus({ to: 'composer' }); return; }
        const kept = open && !open.editingId ? commentText.current.trim() : '';
        if (found && row && where.index !== undefined) {
          const id = diffLineId(row, where.index);
          openComposer(file, found.block, { start: id, end: id, anchor: id }, `${quote}\n\n`);
        } else {
          openFileComposer(file, `${quote}\n\n`);
        }
        if (kept) commentText.current = `${quote}\n\n${kept}`;
      },

      beginSelect: (fileId, blockId, index, event) => {
        const found = blockOf(fileId, blockId);
        if (!found || event.button > 0) return;
        event.preventDefault();
        const current = selectionRef.current;
        const id = diffLineId(found.block.lines[index]!, index);
        const range = current?.fileId === fileId && current.blockId === blockId ? selectionRange(found.block, current) : undefined;
        applySelection(event.shiftKey && current && range
          ? { ...current, ...(index < range.start ? { start: id } : index > range.end ? { end: id } : {}) }
          : { fileId, blockId, start: id, end: id, anchor: id });
        dragging.current = true;
        const finish = () => {
          window.removeEventListener('pointerup', finish);
          dragging.current = false;
          const done = selectionRef.current;
          const block = blockOf(fileId, blockId);
          if (done?.fileId === fileId && done.blockId === blockId && block) openComposer(block.file, block.block, done);
        };
        window.addEventListener('pointerup', finish);
      },
      extendSelect: (fileId, blockId, index) => {
        const current = selectionRef.current;
        const found = blockOf(fileId, blockId);
        if (!dragging.current || !found || current?.fileId !== fileId || current.blockId !== blockId) return;
        // The drag runs from where it started to the line under the pointer, either way.
        applySelection({ ...current, start: current.anchor, end: diffLineId(found.block.lines[index]!, index) });
      },
      clearSelection: () => applySelection(undefined),
      commentOnLine: (fileId, blockId, index) => {
        const found = blockOf(fileId, blockId);
        if (!found) return;
        const id = diffLineId(found.block.lines[index]!, index);
        openComposer(found.file, found.block, { start: id, end: id, anchor: id });
      },
      writeComment: () => {
        const open = now().commentDraft;
        if (!open) return;
        // The caret goes back where the person left it, as R does in a reply.
        const field = scrollerRef.current?.querySelector<HTMLTextAreaElement>('.tm-review-comment-composer textarea');
        if (field) { field.focus(); return; }
        openIfCollapsed(open.fileId ? entryOf(open.fileId) : entryOfPath(open.path));
        setPendingFocus({ to: 'composer' });
      },
      commentOnFile: (fileId) => {
        const file = now().filesById.get(fileId);
        if (file) openFileComposer(file);
      },
      editComment: (comment) => {
        applySelection(undefined);
        showComposer({ key: comment.id, path: comment.path, side: comment.side, line: comment.line, endLine: comment.endLine, editingId: comment.id }, comment.text);
      },
      deleteComment: (commentId, { focus = false } = {}) => {
        const { props: current, commentDraft: open } = now();
        const index = current.draft.comments.findIndex((comment) => comment.id === commentId);
        if (index < 0) return;
        if (open?.editingId === commentId) endComposer();
        setDeletedComments((deleted) => [...deleted, { comment: current.draft.comments[index]!, index }]);
        updateDraft({ comments: current.draft.comments.filter((comment) => comment.id !== commentId) });
        if (focus) setPendingFocus({ to: 'comment', id: commentId, restore: true });
      },
      restoreComment: (commentId) => {
        const { props: current, deletedComments: deleted } = now();
        const entry = deleted.find((candidate) => candidate.comment.id === commentId);
        if (!entry) return;
        const comments = current.draft.comments;
        updateDraft({ comments: [...comments.slice(0, entry.index), entry.comment, ...comments.slice(entry.index)] });
        setDeletedComments((list) => list.filter((candidate) => candidate.comment.id !== commentId));
        setPendingFocus({ to: 'comment', id: commentId });
      },
      commentText: () => commentText.current,
      setCommentText: (text) => { commentText.current = text; },
      saveComment: () => {
        const { commentDraft: open, props: current } = now();
        const text = commentText.current.trim();
        if (!open || !text) return;
        const id = open.editingId ?? crypto.randomUUID();
        updateDraft({
          comments: open.editingId
            ? current.draft.comments.map((comment) => (comment.id === open.editingId ? { ...comment, text } : comment))
            : [...current.draft.comments, {
              id,
              path: open.path,
              side: open.side,
              ...(open.line ? { line: open.line } : {}),
              ...(open.endLine ? { endLine: open.endLine } : {}),
              text
            }]
        });
        setPendingFocus({ to: 'comment', id });
        endComposer();
      },
      closeComposer,
      leaveComposer: () => {
        const text = commentText.current;
        if (!text.trim() || text === commentStart.current) { closeComposer(); return; }
        scrollerRef.current?.querySelector<HTMLElement>('.tm-review-comment-composer')?.focus({ preventScroll: true });
      },
      askAboutLines: () => {
        const { commentDraft: open, props: current } = now();
        if (!open?.line || open.editingId || !current.onAskAboutLines) return;
        current.onAskAboutLines({
          path: open.path,
          side: open.side,
          line: open.line,
          ...(open.endLine && open.endLine > open.line ? { endLine: open.endLine } : {})
        }, commentText.current);
        // Ask takes the caret.
        endComposer();
      },

      setSheetOpen,
      // Sending answers the sheet, so it closes; a send that fails keeps the draft, and the summary opens it again.
      // What was deleted can no longer come back once the request goes.
      submitRequest: () => { setSheetOpen(false); setDeletedComments([]); now().props.requestChanges?.onSubmit(); },
      setNote: (note) => updateDraft({ note }),
      openPathMenu: (path, event, line) => {
        const { worktree, historical } = now().props;
        if (!worktree || historical) return;
        event.preventDefault();
        setPathMenu({
          target: { type: 'worktreeFile', taskId: worktree.taskId, worktreeId: worktree.id, relativePath: path, line },
          position: { x: event.clientX, y: event.clientY }
        });
      },
      closePathMenu: () => setPathMenu(undefined),
      notifyError: (message) => now().notify(message, 'error')
    };
    // Every value the actions read comes through `live`, and the setters never change.
  }, [scrollerRef, setActiveFileId, setActiveStage]);

  const canDecideAnswers = Boolean(props.answers?.onDecide);
  const deletedCommentIds = useMemo(() => new Set(deletedComments.map((deleted) => deleted.comment.id)), [deletedComments]);
  const bands = useMemo<ReviewBandsState>(() => ({
    focusedFindingId,
    focusedDiscussionId,
    dismissingId,
    included,
    includedDiscussions,
    findingsActionable,
    findingsSendable: props.findingsSendable,
    canComment,
    reReview,
    viewer: props.viewer,
    commentDraft,
    deletedCommentIds,
    replyTexts: props.replyTexts,
    replyDrafts: props.replyDrafts,
    canDismiss: Boolean(props.onDismissFinding),
    canRestore: Boolean(props.onRestoreFinding),
    canAskAboutFinding: Boolean(props.onAskAboutFinding),
    canAskAboutLines: Boolean(props.onAskAboutLines),
    canAskAboutDiscussion: Boolean(props.onAskAboutDiscussion),
    canReply: Boolean(props.onReplyToDiscussion),
    canResolve: Boolean(props.onResolveDiscussion),
    agent: props.answers?.agent,
    answers: bandAnswers,
    canDecideAnswers
  }), [
    bandAnswers, canComment, canDecideAnswers, commentDraft, deletedCommentIds, dismissingId, findingsActionable, focusedDiscussionId, focusedFindingId,
    included, includedDiscussions, props.answers?.agent, props.findingsSendable, props.onAskAboutDiscussion, props.onAskAboutFinding, props.onAskAboutLines,
    props.onDismissFinding, props.onReplyToDiscussion, props.onResolveDiscussion, props.onRestoreFinding, props.replyDrafts, props.replyTexts,
    props.viewer, reReview
  ]);

  // Another surface asked to see the request; it opens once, so coming back to the tab does not reopen it.
  useEffect(() => {
    if (!props.requestSheetPending) return;
    setSheetOpen(true);
    props.onRequestSheetOpened?.();
  }, [props.requestSheetPending]);

  // The move starts in the frame its target first renders. Lines a move chose stay chosen until the next one.
  useLayoutEffect(() => {
    if (!pendingTravel) return;
    setPendingTravel(undefined);
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.querySelectorAll('[data-marked]').forEach((row) => row.removeAttribute('data-marked'));
    const { attribute, value, within, offset, mark, instant, focus } = pendingTravel;
    if (!attribute || value === undefined) {
      travel(scroller, 0, { instant });
      return;
    }
    const file = within ? scroller.querySelector<HTMLElement>(`[data-file-id=${quoted(within)}]`) : null;
    const scope = file ?? scroller;
    // Lines take the latest block that shows them; lines that do not show leave the file's head.
    const element = (attribute === 'data-line-anchor' ? linesOf(scope, [value]).at(-1) : scope.querySelector<HTMLElement>(`[${attribute}=${quoted(value)}]`)) ?? file;
    if (!element) return;
    const top = scroller.getBoundingClientRect().top + scroller.clientTop;
    travel(scroller, offset === undefined ? landing(scroller, element) : scroller.scrollTop + element.getBoundingClientRect().top - top - offset, { instant });
    if (mark && file) for (const row of linesOf(file, mark)) row.setAttribute('data-marked', '');
    if (focus) element.focus({ preventScroll: true });
  }, [pendingTravel, scrollerRef]);

  // The keys go where a change to the comments left them, once it has rendered. The composer's field takes
  // the caret at the end of what it holds, with all of it shown; anything gone falls back to the scroller.
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    setPendingFocus(undefined);
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (pendingFocus.to === 'composer') {
      const form = scroller.querySelector<HTMLElement>('.tm-review-comment-composer');
      const field = form?.querySelector('textarea');
      if (!form || !field) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
      keepInView(scroller, form);
      return;
    }
    const target = pendingFocus.to === 'control' ? pendingFocus.element
      : scroller.querySelector(`[data-comment-id=${quoted(pendingFocus.id)}]${pendingFocus.restore ? ' .tm-review-thread__undo' : ''}`);
    (target instanceof HTMLElement && target.isConnected ? target : scroller).focus({ preventScroll: true });
  }, [pendingFocus, scrollerRef]);

  // The page hides its tab bar while a file is full screen, and gets it back when the tab closes.
  const onFullScreenChange = props.onFullScreenChange;
  useEffect(() => {
    onFullScreenChange?.(Boolean(focusedFile));
  }, [focusedFile, onFullScreenChange]);
  useEffect(() => () => onFullScreenChange?.(false), [onFullScreenChange]);

  // A discussion another surface asked to see is shown once the diff is read, on its line or above the files, as a click in the navigator would.
  useEffect(() => {
    const discussionId = props.revealDiscussionId;
    if (!discussionId || !discussions.some((discussion) => discussion.id === discussionId)) return;
    actions.showDiscussion(discussionId);
    props.onDiscussionRevealed?.();
  }, [props.revealDiscussionId, readingOrdered, discussions]);

  const brief: ReviewBriefContent | undefined = props.brief && (props.brief.asked || props.brief.report || props.brief.reviewer || props.brief.round) && !props.historical
    ? { ...props.brief, ...(props.brief.round ? { round: { ...props.brief.round, onShowItem: actions.showRequestItem } } : {}) }
    : undefined;
  const unavailable = loading ? 'Loading changes…'
    : diff.error ? 'The captured diff could not be read.'
      : diff.missing ? (props.historical ? 'This capture has no diff.' : 'No changes captured yet.')
        : diff.inspection.completeness === 'UNINTERPRETABLE' ? 'The captured paths could not be read.'
          : undefined;
  // An incomplete capture never reads as empty: missing paths are unknown, not absent.
  const emptyScope = !unavailable && files.length === 0
    ? diff.inspection.completeness === 'INCOMPLETE' ? 'No paths could be confirmed from the incomplete capture.'
      : effectiveScope === 'since-review' ? 'Nothing changed since the review.' : 'No changes in this scope.'
    : undefined;

  // The Guide shows the walkthrough the gate keeps, the earlier one included, while it is read; or why there is none.
  const guideStatus: GuideView['status'] = stored
    ? walkthrough?.view.loading ? 'loading' : guideModel ? 'ready' : 'unavailable'
    : review?.status === 'RUNNING' ? 'running'
      : walkthrough?.state.status === 'UNAVAILABLE' ? 'unavailable' : 'none';
  const guide: GuideView = {
    status: guideStatus,
    model: guideModel,
    ...(guideStatus === 'unavailable' ? {
      reason: walkthroughUnavailableWords(walkthrough?.state.status === 'UNAVAILABLE' ? walkthrough.state.reason : walkthrough?.view.diffUnavailable ?? 'UNPARSED')
    } : {}),
    author: walkthrough?.author,
    folders,
    openGroups: guideOpen.groups,
    openMore: guideOpen.more,
    outside: { findings: guideAnchors.findings.general, discussions: guideAnchors.discussions.general }
  };

  return {
    props,
    actions,
    bands,
    mode,
    guide,
    activeStage,
    /** The stage the Diff is narrowed to. */
    diffFilter: mode === 'diff' && diffOrdered !== ordered ? diffFilter : undefined,
    anchors: reading.anchors,
    loading,
    incomplete: diff.inspection.completeness === 'INCOMPLETE' && !diff.loading,
    /** Why there is no code to show: loading, unreadable, or an empty scope. */
    emptyText: unavailable ?? emptyScope,
    brief,
    briefFolded,
    files: reading.files,
    ordered: readingOrdered,
    fileIds,
    gutterWidth: reading.gutterWidth,
    // The checkout fills the Diff's files, which the Guide reads too before a walkthrough; a walkthrough's
    // files are the code the review read, from the base, never the exact changes since a review.
    wholeFile: mode === 'diff' || !guideModel ? context.wholeFile : noWholeFile,
    effectiveScope,
    sinceReviewAvailable,
    sinceReviewLabel,
    exactChanges: (mode === 'diff' || !guideModel) && exactChanges,
    stale,
    order,
    findingsByFile,
    discussionsByFile,
    openFindingsByFile: reading.openFindingsByFile,
    openDiscussionsByFile: reading.openDiscussionsByFile,
    openFindings,
    discussions,
    feedback: reading.feedback,
    findingsActionable,
    canComment,
    viewedIds,
    isCollapsed,
    activeFileId,
    focusedFile,
    focusedFindingId,
    focusedDiscussionId,
    selection,
    commentDraft,
    sheetOpen,
    pathMenu
  };
}

/** The draft's comments with the deleted ones back where they were: the latest deleted goes in first, so each lands where it left. */
function withDeleted(comments: ReviewComment[], deleted: readonly DeletedComment[]): ReviewComment[] {
  if (!deleted.length) return comments;
  const all = [...comments];
  for (const { comment, index } of [...deleted].reverse()) all.splice(Math.min(index, all.length), 0, comment);
  return all;
}

const NO_WHOLE_FILE: WholeFileState = { kind: 'none' };

function noWholeFile(): WholeFileState {
  return NO_WHOLE_FILE;
}
