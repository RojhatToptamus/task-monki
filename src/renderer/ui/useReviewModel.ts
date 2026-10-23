import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type {
  AgentReviewGateStatus,
  AgentReviewResolvedFinding,
  ArtifactRecord,
  OpenTargetRef,
  ReviewComment,
  ReviewFindingDismissReason,
  ReviewRequestItem,
  TaskReviewDraft,
  WorktreeRecord
} from '../../shared/contracts';
import type { DiffBlock, DiffEvidenceScope, DiffFile } from '../model/diffEvidence';
import type { DiscussionView, ReplyDraft } from '../model/pullRequestFeedback';
import type { ReviewRequestPlan } from '../model/reviewFollowUp';
import { feedbackOrder } from '../model/reviewNavigation';
import { orderReviewFiles, type OrderedReviewFile, type ReviewFileOrder } from '../model/reviewOrder';
import { readBriefFolded, readReviewFileOrder, readViewedFiles, writeBriefFolded, writeReviewFileOrder, writeViewedFiles } from '../model/reviewPreferences';
import {
  anchorReviewComments,
  anchorReviewDiscussions,
  anchorReviewFindings,
  buildReviewIndex,
  diffFileSignature,
  diffLineId,
  filesChangedSinceReview,
  lineAnchorKey,
  normalizeReviewPath,
  reviewGutterWidth,
  selectionRange,
  type AnchoredComments,
  type AnchoredDiscussions,
  type AnchoredFindings,
  type ReviewFindingView
} from '../model/reviewWorkspace';
import type { ReviewBriefContent } from './ReviewBrief';
import type { ReviewFinishAction, ReviewRequestAction } from './ReviewRequest';
import { changeWithMotion, type ExpandMotion } from './expandMotion';
import { useNotify } from './NotifyContext';
import { scrollTopFor, stopTravel, travel } from './travel';
import { useDiffArtifact } from './useDiffArtifact';
import { useReviewChanges } from './useReviewChanges';
import { useReviewContext } from './useReviewContext';
import { useScrollSpy } from './useScrollSpy';

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

/** Where each kind of feedback sits in the files. */
export interface ReviewAnchors {
  findings: AnchoredFindings;
  discussions: AnchoredDiscussions<DiscussionView>;
  comments: AnchoredComments;
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
  replyTexts?: ReadonlyMap<string, string>;
  replyDrafts?: ReadonlyMap<string, ReplyDraft>;
  canDismiss: boolean;
  canRestore: boolean;
  canAskAboutFinding: boolean;
  canAskAboutLines: boolean;
  canReply: boolean;
  canResolve: boolean;
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

  /** The gutter: pressing a number, dragging across several, Shift extending the last choice. */
  beginSelect(fileId: string, blockId: string, index: number, event: ReactPointerEvent): void;
  extendSelect(fileId: string, blockId: string, index: number): void;
  clearSelection(): void;
  commentOnLine(fileId: string, blockId: string, index: number): void;
  commentOnSelection(): void;
  commentOnFile(fileId: string): void;
  editComment(comment: ReviewComment): void;
  deleteComment(commentId: string): void;
  /** What the open composer holds, kept while its file folds and opens again. */
  commentText(): string;
  setCommentText(text: string): void;
  saveComment(): void;
  closeComposer(): void;
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

const NO_FINDINGS: ReviewFindingView[] = [];
const NO_DISCUSSIONS: DiscussionView[] = [];
/** A file shown alone moves to the top of the column, and back to its place. */
const FILE_MOTION: ExpandMotion = { duration: '--motion-move', easing: '--ease-in-out' };
/** The file being read is the topmost one in the scroller's top 30%. */
const READING_BAND = (scroller: HTMLElement) => scroller.clientHeight * 0.3;
/** About six lines of the code a band is about stay above it when it is moved to. */
const BAND_CONTEXT = 120;

export const SCOPE_LABELS: Record<ReviewScope, string> = {
  all: 'All changes',
  committed: 'Committed',
  uncommitted: 'Uncommitted',
  'since-review': 'Since the review'
};

/** Where travel to an element leaves it: a file's head at the sticky line; a band under its file's stuck head, with code above it. */
function landing(scroller: HTMLElement, element: HTMLElement): number {
  const file = element.closest<HTMLElement>('[data-file-id]');
  if (file === element) return scrollTopFor(scroller, element);
  if (!file) return scrollTopFor(scroller, element, BAND_CONTEXT);
  const head = file.querySelector('.tm-review-file__head')?.getBoundingClientRect().height ?? 0;
  return Math.max(scrollTopFor(scroller, file), scrollTopFor(scroller, element, head + BAND_CONTEXT));
}

/** An attribute value inside a selector's quotes. */
function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

interface PendingTravel {
  attribute: 'data-file-id' | 'data-finding-id' | 'data-discussion-id' | 'data-comment-id';
  value: string;
  instant: boolean;
  focus: boolean;
}

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
  const anchoredComments = useMemo(() => anchorReviewComments(files, draft.comments), [files, draft.comments]);
  // Discussions wait for the diff as findings do, and belong to the current head, not an earlier capture.
  const discussions = props.historical || loading ? NO_DISCUSSIONS : props.discussions ?? NO_DISCUSSIONS;
  const discussionsOnLines = Boolean(props.discussionsOnLines) && effectiveScope !== 'since-review';
  const anchoredDiscussions = useMemo(() => anchorReviewDiscussions(files, discussions, discussionsOnLines), [files, discussions, discussionsOnLines]);
  const anchors = useMemo<ReviewAnchors>(
    () => ({ findings: anchoredFindings, discussions: anchoredDiscussions, comments: anchoredComments }),
    [anchoredComments, anchoredDiscussions, anchoredFindings]
  );
  const findingsByFile = useMemo(() => new Map(buildReviewIndex(files, anchoredFindings).map((entry) => [entry.file.id, entry.findings])), [files, anchoredFindings]);
  const discussionsByFile = useMemo(() => new Map(files.map((file) => [file.id, [
    ...(anchoredDiscussions.byFile.get(file.id) ?? []),
    ...file.blocks.flatMap((block) => block.lines.flatMap((line, index) => anchoredDiscussions.byLine.get(lineAnchorKey(file.id, block.id, line, index)) ?? []))
  ]])), [files, anchoredDiscussions]);
  // What still asks for something in each file: its head says it, and a folded file keeps a row for each.
  const openFindingsByFile = useMemo(() => new Map([...findingsByFile].map(([fileId, list]) => [fileId, list.filter((finding) => finding.state === 'OPEN')])), [findingsByFile]);
  const openDiscussionsByFile = useMemo(() => new Map([...discussionsByFile].map(([fileId, list]) => [fileId, list.filter((discussion) => discussion.open)])), [discussionsByFile]);

  const [order, setOrder] = useState<ReviewFileOrder>(readReviewFileOrder);
  const ordered = useMemo(() => orderReviewFiles(files, findingsByFile, order), [files, findingsByFile, order]);
  const fileIds = useMemo(() => ordered.map((entry) => entry.file.id), [ordered]);
  // N and P step through what still asks for something, in reading order.
  const feedback = useMemo(() => feedbackOrder({
    general: { findings: anchoredFindings.general, discussions: anchoredDiscussions.general },
    files: fileIds,
    findingsByFile,
    discussionsByFile
  }), [anchoredDiscussions.general, anchoredFindings.general, discussionsByFile, fileIds, findingsByFile]);
  const filesById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
  const openFindings = useMemo(() => findings.filter((finding) => finding.state === 'OPEN'), [findings]);
  const findingsActionable = props.findingsSendable && !props.historical;
  const canComment = !props.historical;
  const included = useMemo(() => new Set(plan.send.map((finding) => finding.id)), [plan.send]);
  const includedDiscussions = useMemo(() => new Set(plan.discussions.map((discussion) => discussion.id)), [plan.discussions]);
  const reReview = Boolean(props.resolvedFindings?.length || findings.some((finding) => finding.previousFindingId));

  // Each file's change has one signature per capture; viewed holds while unchanged lines open.
  const signatures = useMemo(() => new Map(capturedFiles.map((file) => [file.id, diffFileSignature(file)])), [capturedFiles]);
  const [viewed, setViewed] = useState<Record<string, string>>(() => readViewedFiles(props.taskId));
  const viewedIds = useMemo(
    () => new Set(files.filter((file) => viewed[file.path] === signatures.get(file.id)).map((file) => file.id)),
    [files, signatures, viewed]
  );
  // Collapsing is the person's choice per file; a viewed or generated file starts collapsed.
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({});
  const isCollapsed = (entry: OrderedReviewFile) => collapsedOverride[entry.file.id] ?? (viewedIds.has(entry.file.id) || entry.role === 'generated');

  const [focusedFindingId, setFocusedFindingId] = useState<string>();
  const [focusedDiscussionId, setFocusedDiscussionId] = useState<string>();
  const [dismissingId, setDismissingId] = useState<string>();
  // The navigator follows the reading position; a navigation sets it where it lands.
  const [activeFileId, setActiveFileId] = useScrollSpy(scrollerRef, 'data-file-id', READING_BAND, fileIds.join('\u0000'));
  // Show only this file: the file alone at the top of the column, the navigator
  // beside it. Moving to another file moves the focus; leaving returns the list
  // to where it was read.
  const [focusedFileId, setFocusedFileId] = useState<string>();
  const focusedFile = focusedFileId && fileIds.includes(focusedFileId) ? focusedFileId : undefined;
  const listScroll = useRef<{ fileId: string; top: number }>(undefined);
  const [selection, setSelection] = useState<LineSelection>();
  const selectionRef = useRef<LineSelection | undefined>(undefined);
  const dragging = useRef(false);
  const [commentDraft, setCommentDraft] = useState<CommentDraft>();
  const commentText = useRef('');
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
    props, ordered, filesById, findingsByFile, discussionsByFile, discussions, isCollapsed, focusedFile, selection, commentDraft,
    signatures, included, includedDiscussions, briefRound, notify, reveal: context.reveal, setWholeFile: context.setWholeFile
  };
  const live = useRef(latest);
  useLayoutEffect(() => { live.current = latest; });

  const actions = useMemo<ReviewActions>(() => {
    const now = () => live.current;
    const fileElement = (fileId: string | undefined) => (fileId === undefined ? null
      : scrollerRef.current?.querySelector<HTMLElement>(`[data-file-id=${quoted(fileId)}]`) ?? null);
    const entryOf = (fileId: string | undefined) => now().ordered.find((entry) => entry.file.id === fileId);
    const entryOfPath = (path: string) => now().ordered.find((entry) => normalizeReviewPath(entry.file.path) === normalizeReviewPath(path));
    const expand = (fileId: string) => setCollapsedOverride((current) => ({ ...current, [fileId]: false }));
    const openIfCollapsed = (entry: OrderedReviewFile | undefined) => { if (entry && now().isCollapsed(entry)) expand(entry.file.id); };
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
      openIfCollapsed(entry);
      if (entry) setActiveFileId(entry.file.id);
      go({ attribute: 'data-finding-id', value: findingId, instant, focus: true });
    };
    const showDiscussion = (discussionId: string, { instant = false } = {}) => {
      setFocusedDiscussionId(discussionId);
      setFocusedFindingId(undefined);
      const entry = now().ordered.find((candidate) => (now().discussionsByFile.get(candidate.file.id) ?? []).some((discussion) => discussion.id === discussionId));
      followFullScreen(entry?.file.id);
      openIfCollapsed(entry);
      if (entry) setActiveFileId(entry.file.id);
      go({ attribute: 'data-discussion-id', value: discussionId, instant, focus: true });
    };
    const showFile = (fileId: string, { open = false, instant = false } = {}) => {
      const { focusedFile: current } = now();
      if (current && fileId !== current) { showFullScreen(fileId, false); return; }
      if (open) openIfCollapsed(entryOf(fileId));
      setActiveFileId(fileId);
      go({ attribute: 'data-file-id', value: fileId, instant, focus: false });
    };

    const applySelection = (next?: LineSelection) => { selectionRef.current = next; setSelection(next); };
    const blockOf = (fileId: string, blockId: string) => {
      const file = now().filesById.get(fileId);
      const block = file?.blocks.find((candidate) => candidate.id === blockId);
      return file && block ? { file, block } : undefined;
    };
    const openComposer = (file: DiffFile, block: DiffBlock, chosen: Pick<LineSelection, 'start' | 'end' | 'anchor'>) => {
      const range = selectionRange(block, chosen);
      if (!range) return;
      const anchorLine = block.lines[range.anchor]!;
      const side: ReviewComment['side'] = anchorLine.kind === 'deletion' ? 'OLD' : 'NEW';
      const numbers = block.lines.slice(range.start, range.end + 1)
        .map((line) => (side === 'OLD' ? (line.kind === 'deletion' ? line.oldLine : undefined) : line.newLine))
        .filter((value): value is number => value !== undefined);
      if (!numbers.length) return;
      const line = Math.min(...numbers);
      const last = Math.max(...numbers);
      commentText.current = '';
      setCommentDraft({ key: lineAnchorKey(file.id, block.id, block.lines[range.end]!, range.end), fileId: file.id, path: file.path, side, line, endLine: last > line ? last : undefined });
    };
    const closeComposer = () => { commentText.current = ''; setCommentDraft(undefined); applySelection(undefined); };
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
        openIfCollapsed(entry);
        if (entry) setActiveFileId(entry.file.id);
        go({ attribute: 'data-comment-id', value: commentId, instant: false, focus: false });
      },
      showRequestItem: (item) => {
        if (item.kind === 'FINDING' && now().props.findings.some((finding) => finding.id === item.findingId)) { showFinding(item.findingId); return; }
        if (item.kind === 'DISCUSSION' && now().discussions.some((discussion) => discussion.id === item.discussionId)) { showDiscussion(item.discussionId); return; }
        const entry = item.path ? entryOfPath(item.path) : undefined;
        if (entry) showFile(entry.file.id, { open: true });
      },
      showFullScreen,
      setFileViewed: (fileId, next) => {
        const file = now().filesById.get(fileId);
        const signature = now().signatures.get(fileId);
        if (!file || !signature) return;
        const taskId = now().props.taskId;
        setViewed((current) => {
          const updated = { ...current };
          if (next) updated[file.path] = signature;
          else delete updated[file.path];
          writeViewedFiles(taskId, updated);
          return updated;
        });
      },
      toggleCollapsed: (fileId, all) => {
        const entry = entryOf(fileId);
        if (!entry) return;
        const next = !now().isCollapsed(entry);
        setCollapsedOverride((current) => (all ? Object.fromEntries(now().ordered.map((candidate) => [candidate.file.id, next])) : { ...current, [fileId]: next }));
      },
      setAllCollapsed: (collapsed) => setCollapsedOverride(Object.fromEntries(now().ordered.map((entry) => [entry.file.id, collapsed]))),
      revealLines: (blockId, from, to) => now().reveal(blockId, from, to),
      setWholeFile: (fileId, whole) => {
        const entry = entryOf(fileId);
        if (whole) openIfCollapsed(entry);
        now().setWholeFile(fileId, whole);
      },
      setScope,
      setOrder: (next) => { setOrder(next); writeReviewFileOrder(next); },
      foldBrief: (folded) => {
        const { briefRound: round, props: current } = now();
        setBriefFold({ round, folded });
        writeBriefFolded(current.taskId, round, folded);
      },

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
      commentOnSelection: () => {
        const current = now().selection;
        const found = current ? blockOf(current.fileId, current.blockId) : undefined;
        if (current && found) openComposer(found.file, found.block, current);
      },
      commentOnFile: (fileId) => {
        const entry = entryOf(fileId);
        if (!entry) return;
        openIfCollapsed(entry);
        commentText.current = '';
        setCommentDraft({ key: `file:${fileId}`, fileId, path: entry.file.path, side: 'NEW' });
      },
      editComment: (comment) => {
        commentText.current = comment.text;
        setCommentDraft({ key: comment.id, path: comment.path, side: comment.side, line: comment.line, endLine: comment.endLine, editingId: comment.id });
      },
      deleteComment: (commentId) => updateDraft({ comments: now().props.draft.comments.filter((comment) => comment.id !== commentId) }),
      commentText: () => commentText.current,
      setCommentText: (text) => { commentText.current = text; },
      saveComment: () => {
        const { commentDraft: open, props: current } = now();
        const text = commentText.current.trim();
        if (!open || !text) { closeComposer(); return; }
        updateDraft({
          comments: open.editingId
            ? current.draft.comments.map((comment) => (comment.id === open.editingId ? { ...comment, text } : comment))
            : [...current.draft.comments, {
              id: crypto.randomUUID(),
              path: open.path,
              side: open.side,
              ...(open.line ? { line: open.line } : {}),
              ...(open.endLine ? { endLine: open.endLine } : {}),
              text
            }]
        });
        closeComposer();
      },
      closeComposer,
      askAboutLines: () => {
        const { commentDraft: open, props: current } = now();
        if (!open?.line || open.editingId || !current.onAskAboutLines) return;
        current.onAskAboutLines({
          path: open.path,
          side: open.side,
          line: open.line,
          ...(open.endLine && open.endLine > open.line ? { endLine: open.endLine } : {})
        }, commentText.current);
        closeComposer();
      },

      setSheetOpen,
      // Sending answers the sheet, so it closes; a send that fails keeps the draft, and the summary opens it again.
      submitRequest: () => { setSheetOpen(false); now().props.requestChanges?.onSubmit(); },
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
  }, [scrollerRef, setActiveFileId]);

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
    replyTexts: props.replyTexts,
    replyDrafts: props.replyDrafts,
    canDismiss: Boolean(props.onDismissFinding),
    canRestore: Boolean(props.onRestoreFinding),
    canAskAboutFinding: Boolean(props.onAskAboutFinding),
    canAskAboutLines: Boolean(props.onAskAboutLines),
    canReply: Boolean(props.onReplyToDiscussion),
    canResolve: Boolean(props.onResolveDiscussion)
  }), [
    canComment, commentDraft, dismissingId, findingsActionable, focusedDiscussionId, focusedFindingId, included, includedDiscussions,
    props.findingsSendable, props.onAskAboutFinding, props.onAskAboutLines, props.onDismissFinding, props.onReplyToDiscussion,
    props.onResolveDiscussion, props.onRestoreFinding, props.replyDrafts, props.replyTexts, props.viewer, reReview
  ]);

  // Another surface asked to see the request; it opens once, so coming back to the tab does not reopen it.
  useEffect(() => {
    if (!props.requestSheetPending) return;
    setSheetOpen(true);
    props.onRequestSheetOpened?.();
  }, [props.requestSheetPending]);

  // The move starts in the frame its target first renders.
  useLayoutEffect(() => {
    if (!pendingTravel) return;
    setPendingTravel(undefined);
    const scroller = scrollerRef.current;
    const element = scroller?.querySelector<HTMLElement>(`[${pendingTravel.attribute}=${quoted(pendingTravel.value)}]`);
    if (!scroller || !element) return;
    travel(scroller, landing(scroller, element), { instant: pendingTravel.instant });
    if (pendingTravel.focus) element.focus({ preventScroll: true });
  }, [pendingTravel, scrollerRef]);

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
  }, [props.revealDiscussionId, ordered, discussions]);

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

  return {
    props,
    actions,
    bands,
    anchors,
    loading,
    incomplete: diff.inspection.completeness === 'INCOMPLETE' && !diff.loading,
    /** Why there is no code to show: loading, unreadable, or an empty scope. */
    emptyText: unavailable ?? emptyScope,
    brief,
    briefFolded,
    files,
    ordered,
    fileIds,
    gutterWidth,
    wholeFile: context.wholeFile,
    effectiveScope,
    sinceReviewAvailable,
    sinceReviewLabel,
    exactChanges,
    stale,
    order,
    findingsByFile,
    discussionsByFile,
    openFindingsByFile,
    openDiscussionsByFile,
    openFindings,
    discussions,
    feedback,
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
