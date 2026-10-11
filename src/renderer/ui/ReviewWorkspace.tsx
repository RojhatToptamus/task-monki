import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { Check, ChevronDown, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import type {
  AgentReviewGateStatus,
  ArtifactRecord,
  OpenTargetRef,
  ReviewComment,
  ReviewFindingDismissReason,
  TaskReviewDraft,
  WorktreeRecord
} from '../../shared/contracts';
import type { DiffBlock, DiffEvidenceScope, DiffFile } from '../model/diffEvidence';
import { formatFindingLocation } from '../model/findings';
import { formatCommentLocation, isBlockingFinding, type ReviewRequestPlan } from '../model/reviewFollowUp';
import { orderReviewFiles, type OrderedReviewFile, type ReviewFileOrder } from '../model/reviewOrder';
import { readBriefFolded, readReviewFileOrder, writeBriefFolded, writeReviewFileOrder } from '../model/reviewPreferences';
import { readViewedFiles, writeViewedFiles } from '../model/reviewViewed';
import {
  anchorReviewComments,
  anchorReviewFindings,
  buildReviewDiffRows,
  buildReviewIndex,
  diffFileSignature,
  filesChangedSinceReview,
  lineAnchorKey,
  normalizeReviewPath,
  type ReviewFindingView
} from '../model/reviewWorkspace';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { MessageTime } from './Message';
import { useNotify } from './NotifyContext';
import { OpenTargetContextMenu, useOpenTargetMenuItems } from './OpenTargetMenu';
import { ReviewBrief, type ReviewBriefContent } from './ReviewBrief';
import { ReviewFindingThread, settledLabel, severityLabel } from './ReviewFindingThread';
import { ReviewOutcome, type ReviewFinishAction, type ReviewRequestAction } from './ReviewRequest';
import { SUBMIT_SHORTCUT, Tooltip } from './Tooltip';
import { useDiffArtifact } from './useDiffArtifact';

export type ReviewScope = DiffEvidenceScope | 'since-review';

export interface ReviewWorkspaceProps {
  taskId: string;
  review?: {
    status: AgentReviewGateStatus;
    reviewedAt?: string;
    runId?: string;
  };
  findings: ReviewFindingView[];
  currentDiffArtifactId?: string;
  reviewedDiffArtifactId?: string;
  /** Set while showing an earlier capture instead of the current checkout. */
  historical?: { capturedAt?: string; headSha?: string; onBack(): void };
  artifacts: ArtifactRecord[];
  worktree?: WorktreeRecord;
  /** Imported work compares against a chosen base; the menu can change it. */
  comparison?: { label: string; onChange(): void; disabledReason?: string };
  /** What was asked, what the agent reported, and the reviewer's summary. */
  brief?: Omit<ReviewBriefContent, 'scope'>;
  /** The person's unsent review, saved with the task as it changes. */
  draft: TaskReviewDraft;
  onDraftChange(draft: TaskReviewDraft): void;
  /** What happens to each finding when the person requests changes. */
  plan: ReviewRequestPlan;
  /** False for an out-of-date review: its findings stay context and only comments are sent. */
  findingsSendable: boolean;
  /** Present while a request can be made: sends the findings to fix and the person's comments. */
  requestChanges?: ReviewRequestAction & { reviewNotes: boolean };
  /** With nothing to send, the step that finishes the task. */
  finish?: ReviewFinishAction;
  /** Present when a review can run: none yet, or the code changed since it. */
  runReview?: { label: string; disabledReason?: string; busy: boolean; onRun(): void };
  onDismissFinding?(findingId: string, reason: ReviewFindingDismissReason, note?: string): Promise<void>;
  onRestoreFinding?(findingId: string): Promise<void>;
  onAskAboutFinding?(findingId: string): void;
  /** Changes when another surface asks to see the request, such as the Overview's Request changes. */
  requestSheetToken?: number;
  /** Whether the person is reading down the diff, so the page head can fold away. */
  onReadingChange?(reading: boolean): void;
}

const NO_FINDINGS: ReviewFindingView[] = [];

const SCOPE_LABELS: Record<ReviewScope, string> = {
  all: 'All changes',
  committed: 'Committed',
  uncommitted: 'Uncommitted',
  'since-review': 'Since the review'
};

function reviewHeadline(status: AgentReviewGateStatus | undefined, openCount: number): { label: string; tone?: 'blocked' | 'waiting' | 'verified' } {
  switch (status) {
    case 'RUNNING': return { label: 'Reviewing' };
    // A run after the review makes it out of date, whether or not files changed.
    case 'STALE': return { label: 'Review out of date', tone: 'waiting' };
    case 'PASSED': return { label: 'Review passed', tone: 'verified' };
    case 'NEEDS_CHANGES': return openCount > 0 ? { label: 'Needs changes', tone: 'blocked' } : { label: 'No open findings', tone: 'verified' };
    case 'INCONCLUSIVE': return { label: 'Review inconclusive', tone: 'waiting' };
    case 'FAILED': return { label: 'Review failed', tone: 'waiting' };
    case 'CANCELED': return { label: 'Review stopped', tone: 'waiting' };
    default: return { label: 'Not reviewed' };
  }
}

/** Open findings in words, most severe first: "1 major, 2 minor". */
function findingWords(findings: readonly ReviewFindingView[]): string {
  const open = findings.filter((finding) => finding.state === 'OPEN');
  const counts = new Map<string, number>();
  for (const finding of open) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  return (['BLOCKER', 'MAJOR', 'MINOR', 'NIT'] as const)
    .filter((severity) => counts.has(severity))
    .map((severity) => `${counts.get(severity)} ${severityLabel({ severity }).toLowerCase()}`)
    .join(', ');
}

interface LineSelection { fileId: string; blockId: string; start: number; end: number }
interface CommentDraft {
  /** The row (or `file:<id>`) the composer opens under. */
  key: string;
  path: string;
  side: ReviewComment['side'];
  line?: number;
  endLine?: number;
  text: string;
  editingId?: string;
}

/**
 * The Review tab: what changed, read in the order that matters, with the
 * reviewer's findings and the person's own comments on the code they are about.
 * A brief states the facts first; the navigator lists files or feedback; the
 * foot holds the request and the tab's one decision.
 */
export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const { review, findings, draft, plan } = props;
  const current = useDiffArtifact(props.historical ? undefined : props.currentDiffArtifactId, props.artifacts);
  const historical = useDiffArtifact(props.historical ? props.currentDiffArtifactId : undefined, props.artifacts);
  const reviewed = useDiffArtifact(props.reviewedDiffArtifactId, props.artifacts);
  const diff = props.historical ? historical : current;
  const stale = review?.status === 'STALE';
  const canCompareSinceReview = stale && !props.historical && !reviewed.missing && !reviewed.error;
  const [scope, setScope] = useState<ReviewScope>(canCompareSinceReview ? 'since-review' : 'all');
  const effectiveScope: ReviewScope = scope === 'since-review' && !canCompareSinceReview ? 'all' : scope;
  const changedSinceReview = useMemo(
    () => (canCompareSinceReview && !reviewed.loading ? filesChangedSinceReview(reviewed.filesByScope.all, current.filesByScope.all) : undefined),
    [canCompareSinceReview, current.filesByScope.all, reviewed.filesByScope.all, reviewed.loading]
  );
  const files: DiffFile[] = useMemo(() => (effectiveScope === 'since-review'
    ? diff.filesByScope.all.filter((file) => changedSinceReview?.has(normalizeReviewPath(file.path)))
    : diff.filesByScope[effectiveScope]), [changedSinceReview, diff.filesByScope, effectiveScope]);

  // "Since the review" also needs the reviewed diff; until both are read, the scope is loading, not empty.
  const loading = diff.loading || (effectiveScope === 'since-review' && reviewed.loading);
  // Findings wait for the diff, so they never appear under General and then jump to their lines.
  const visibleFindings = props.historical || loading ? NO_FINDINGS : findings;
  const anchored = useMemo(() => anchorReviewFindings(files, visibleFindings), [files, visibleFindings]);
  const anchoredComments = useMemo(() => anchorReviewComments(files, draft.comments), [files, draft.comments]);
  const findingsByFile = useMemo(() => new Map(buildReviewIndex(files, anchored).map((entry) => [entry.file.id, entry.findings])), [files, anchored]);
  const [order, setOrder] = useState<ReviewFileOrder>(readReviewFileOrder);
  const ordered = useMemo(() => orderReviewFiles(files, findingsByFile, order), [files, findingsByFile, order]);
  const openFindings = findings.filter((finding) => finding.state === 'OPEN');
  const findingsActionable = !stale && review?.status !== 'RUNNING' && !props.historical;
  const canComment = !props.historical;
  const included = useMemo(() => new Set(plan.send.map((finding) => finding.id)), [plan.send]);

  const [viewed, setViewed] = useState<Record<string, string>>(() => readViewedFiles(props.taskId));
  const isViewed = (file: DiffFile) => viewed[file.path] === diffFileSignature(file);
  const setFileViewed = (file: DiffFile, next: boolean) => {
    setViewed((currentViewed) => {
      const updated = { ...currentViewed };
      if (next) updated[file.path] = diffFileSignature(file);
      else delete updated[file.path];
      writeViewedFiles(props.taskId, updated);
      return updated;
    });
  };
  const viewedCount = files.filter(isViewed).length;
  // Collapsing is the person's choice per file; a viewed or generated file starts collapsed.
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({});
  const isCollapsed = (entry: OrderedReviewFile) =>
    collapsedOverride[entry.file.id] ?? (isViewed(entry.file) || entry.role === 'generated');

  const [rail, setRail] = useState<'files' | 'feedback'>('files');
  const [focusedFindingId, setFocusedFindingId] = useState<string>();
  const [dismissingId, setDismissingId] = useState<string>();
  const [activeFileId, setActiveFileId] = useState<string>();
  const [selection, setSelection] = useState<LineSelection>();
  const [commentDraft, setCommentDraft] = useState<CommentDraft>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const briefRound = review?.runId ?? 'none';
  const [briefFolded, setBriefFolded] = useState(() => readBriefFolded(props.taskId, briefRound));
  const [pathMenu, setPathMenu] = useState<{ target: OpenTargetRef; position: { x: number; y: number } }>();
  const closePathMenu = useCallback(() => setPathMenu(undefined), []);
  const notify = useNotify();
  const diffRef = useRef<HTMLDivElement>(null);
  const reading = useRef(false);
  // Reading starts past the first lines and ends back at the top. Only a diff with
  // room to spare counts, so the head folding away never leaves nothing to scroll.
  const onDiffScroll = (pane: HTMLElement) => {
    const next = reading.current ? pane.scrollTop > 8 : pane.scrollTop > 48 && pane.scrollHeight - pane.clientHeight > 240;
    if (next === reading.current) return;
    reading.current = next;
    props.onReadingChange?.(next);
  };
  const composerId = useId();
  // A jump into a collapsed file expands it first, then scrolls once it renders.
  const [pendingScroll, setPendingScroll] = useState<{ attribute: string; value: string; focus?: boolean }>();
  const elementBy = (attribute: string, value: string) => [...(diffRef.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? [])]
    .find((element) => element.getAttribute(attribute) === value);

  useEffect(() => {
    if (props.requestSheetToken) setSheetOpen(true);
  }, [props.requestSheetToken]);

  useEffect(() => {
    if (!pendingScroll) return;
    const element = elementBy(pendingScroll.attribute, pendingScroll.value);
    element?.scrollIntoView?.({ block: 'center' });
    if (pendingScroll.focus) element?.focus({ preventScroll: true });
    setPendingScroll(undefined);
  }, [pendingScroll]);

  // The navigator follows the reading position.
  useEffect(() => {
    const root = diffRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    // Entries carry only the sections whose visibility changed, so the set of
    // sections in the reading band is kept here and the topmost one wins.
    const inBand = new Set<Element>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) inBand.add(entry.target);
        else inBand.delete(entry.target);
      }
      const topmost = [...inBand].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      const id = topmost?.getAttribute('data-file-id');
      if (id) setActiveFileId(id);
    }, { root, rootMargin: '0px 0px -70% 0px' });
    root.querySelectorAll('[data-file-id]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [ordered]);

  const fileOfFinding = (findingId: string) =>
    ordered.find((entry) => (findingsByFile.get(entry.file.id) ?? []).some((finding) => finding.id === findingId));
  const expand = (fileId: string) => setCollapsedOverride((currentOverride) => ({ ...currentOverride, [fileId]: false }));
  const scrollToFile = (fileId: string) => {
    elementBy('data-file-id', fileId)?.scrollIntoView?.({ block: 'start' });
    setActiveFileId(fileId);
  };
  const scrollToFinding = (findingId: string) => {
    setFocusedFindingId(findingId);
    const entry = fileOfFinding(findingId);
    if (entry && isCollapsed(entry)) expand(entry.file.id);
    setPendingScroll({ attribute: 'data-finding-id', value: findingId, focus: true });
  };
  const scrollToComment = (commentId: string) => {
    const comment = draft.comments.find((candidate) => candidate.id === commentId);
    const entry = comment ? ordered.find((candidate) => normalizeReviewPath(candidate.file.path) === normalizeReviewPath(comment.path)) : undefined;
    if (entry && isCollapsed(entry)) expand(entry.file.id);
    setPendingScroll({ attribute: 'data-comment-id', value: commentId });
  };

  const updateDraft = (patch: Partial<TaskReviewDraft>) => props.onDraftChange({ ...draft, ...patch });
  const setIncluded = (findingId: string, include: boolean) => {
    const runId = review?.runId;
    const ids = draft.reviewRunId === runId ? draft.includedFindingIds : [];
    updateDraft({
      reviewRunId: runId,
      includedFindingIds: include ? [...new Set([...ids, findingId])] : ids.filter((id) => id !== findingId)
    });
  };
  const toggleIncluded = (findingId: string) => setIncluded(findingId, !included.has(findingId));
  const openDismiss = (findingId: string) => {
    setSheetOpen(false);
    setDismissingId(findingId);
    scrollToFinding(findingId);
  };

  const openComposer = (file: DiffFile, block: DiffBlock, rowIndex: number) => {
    const inSelection = selection && selection.fileId === file.id && selection.blockId === block.id &&
      rowIndex >= selection.start && rowIndex <= selection.end;
    const start = inSelection ? selection.start : rowIndex;
    const end = inSelection ? selection.end : rowIndex;
    const clicked = block.lines[rowIndex]!;
    const side: ReviewComment['side'] = clicked.kind === 'deletion' ? 'OLD' : 'NEW';
    const numbers = block.lines.slice(start, end + 1)
      .map((line) => (side === 'OLD' ? (line.kind === 'deletion' ? line.oldLine : undefined) : line.newLine))
      .filter((value): value is number => value !== undefined);
    const line = Math.min(...numbers);
    const last = Math.max(...numbers);
    setCommentDraft({ key: lineAnchorKey(file.id, block.id, end), path: file.path, side, line, endLine: last > line ? last : undefined, text: '' });
  };
  const selectRow = (file: DiffFile, block: DiffBlock, rowIndex: number, extend: boolean) => {
    setSelection((currentSelection) => {
      if (extend && currentSelection && currentSelection.fileId === file.id && currentSelection.blockId === block.id) {
        const anchor = currentSelection.start;
        return { fileId: file.id, blockId: block.id, start: Math.min(anchor, rowIndex), end: Math.max(anchor, rowIndex) };
      }
      if (currentSelection?.fileId === file.id && currentSelection.blockId === block.id && currentSelection.start === rowIndex && currentSelection.end === rowIndex) return undefined;
      return { fileId: file.id, blockId: block.id, start: rowIndex, end: rowIndex };
    });
  };
  const saveComment = () => {
    if (!commentDraft?.text.trim()) { setCommentDraft(undefined); return; }
    const text = commentDraft.text.trim();
    updateDraft({
      comments: commentDraft.editingId
        ? draft.comments.map((comment) => (comment.id === commentDraft.editingId ? { ...comment, text } : comment))
        : [...draft.comments, {
          id: crypto.randomUUID(),
          path: commentDraft.path,
          side: commentDraft.side,
          ...(commentDraft.line ? { line: commentDraft.line } : {}),
          ...(commentDraft.endLine ? { endLine: commentDraft.endLine } : {}),
          text
        }]
    });
    setCommentDraft(undefined);
    setSelection(undefined);
  };
  const deleteComment = (commentId: string) => updateDraft({ comments: draft.comments.filter((comment) => comment.id !== commentId) });

  const readingOrderFindings = [
    ...anchored.general,
    ...ordered.flatMap((entry) => findingsByFile.get(entry.file.id) ?? [])
  ].filter((finding) => finding.state === 'OPEN');
  const focusedFinding = findings.find((finding) => finding.id === focusedFindingId);
  const canSubmit = Boolean(props.requestChanges && !props.requestChanges.disabledReason && !props.requestChanges.busy &&
    ((props.findingsSendable && plan.send.length) || draft.comments.length || props.requestChanges.reviewNotes));

  // J/K files, N/P open findings, V viewed and on, D/A/F the focused finding, C the selected lines.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"], [role="menu"]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (sheetOpen && canSubmit) props.requestChanges?.onSubmit();
      else setSheetOpen(true);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const fileIds = ordered.map((entry) => entry.file.id);
    const step = (list: string[], currentId: string | undefined, delta: number) => {
      if (list.length === 0) return undefined;
      const position = currentId ? list.indexOf(currentId) : -1;
      return list[Math.min(list.length - 1, Math.max(0, position + delta))];
    };
    if (key === 'j' || key === 'k') {
      const next = step(fileIds, activeFileId ?? fileIds[0], key === 'j' ? 1 : -1);
      if (next) { event.preventDefault(); scrollToFile(next); }
    } else if (key === 'n' || key === 'p') {
      const next = step(readingOrderFindings.map((finding) => finding.id), focusedFindingId, key === 'n' ? 1 : -1);
      if (next) { event.preventDefault(); scrollToFinding(next); }
    } else if (key === 'v') {
      const entry = ordered.find((candidate) => candidate.file.id === (activeFileId ?? fileIds[0]));
      if (!entry) return;
      event.preventDefault();
      const nowViewed = !isViewed(entry.file);
      setFileViewed(entry.file, nowViewed);
      const next = nowViewed ? ordered.slice(ordered.indexOf(entry) + 1).find((candidate) => !isViewed(candidate.file)) : undefined;
      if (next) window.requestAnimationFrame(() => scrollToFile(next.file.id));
    } else if (key === 'd' && focusedFinding?.state === 'OPEN' && findingsActionable && props.onDismissFinding) {
      event.preventDefault();
      setDismissingId(focusedFinding.id);
    } else if (key === 'a' && focusedFinding && findingsActionable && props.onAskAboutFinding) {
      event.preventDefault();
      props.onAskAboutFinding(focusedFinding.id);
    } else if (key === 'f' && focusedFinding?.state === 'OPEN' && !isBlockingFinding(focusedFinding) && findingsActionable) {
      event.preventDefault();
      toggleIncluded(focusedFinding.id);
    } else if (key === 'c' && selection && canComment) {
      const entry = ordered.find((candidate) => candidate.file.id === selection.fileId);
      const block = entry?.file.blocks.find((candidate) => candidate.id === selection.blockId);
      if (entry && block) { event.preventDefault(); openComposer(entry.file, block, selection.end); }
    } else if (key === 'escape' && selection) {
      setSelection(undefined);
    }
  };

  const openPathMenu = (path: string, event: ReactMouseEvent, line?: number) => {
    if (!props.worktree || props.historical) return;
    event.preventDefault();
    setPathMenu({
      target: { type: 'worktreeFile', taskId: props.worktree.taskId, worktreeId: props.worktree.id, relativePath: path, line },
      position: { x: event.clientX, y: event.clientY }
    });
  };

  const scopeItems: ActionMenuItem[] = [
    ...(['all', 'committed', 'uncommitted'] as const).map((value) => ({
      id: value, label: SCOPE_LABELS[value], pressed: effectiveScope === value, onSelect: () => setScope(value)
    })),
    ...(canCompareSinceReview ? [{ id: 'since-review', label: SCOPE_LABELS['since-review'], pressed: effectiveScope === 'since-review', onSelect: () => setScope('since-review') }] : []),
    ...(props.comparison ? [{
      id: 'comparison', label: 'Change comparison…', meta: props.comparison.label, separated: true,
      disabled: Boolean(props.comparison.disabledReason), disabledReason: props.comparison.disabledReason, onSelect: props.comparison.onChange
    }] : [])
  ];
  const changeOrder = (next: ReviewFileOrder) => { setOrder(next); writeReviewFileOrder(next); };
  const viewItems: ActionMenuItem[] = [
    { id: 'importance', label: 'By importance', description: 'Findings first, then code with its tests', pressed: order === 'importance', onSelect: () => changeOrder('importance') },
    { id: 'path', label: 'By path', pressed: order === 'path', onSelect: () => changeOrder('path') },
    { id: 'expand', label: 'Expand all files', separated: true, onSelect: () => setCollapsedOverride(Object.fromEntries(ordered.map((entry) => [entry.file.id, false]))) },
    { id: 'collapse', label: 'Collapse all files', onSelect: () => setCollapsedOverride(Object.fromEntries(ordered.map((entry) => [entry.file.id, true]))) }
  ];
  const toggleCollapsed = (entry: OrderedReviewFile, all: boolean) => {
    const next = !isCollapsed(entry);
    setCollapsedOverride((currentOverride) => (all
      ? Object.fromEntries(ordered.map((candidate) => [candidate.file.id, next]))
      : { ...currentOverride, [entry.file.id]: next }));
  };

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

  const headline = reviewHeadline(review?.status, openFindings.length);
  const settledCount = findings.length - openFindings.length;
  const briefContent: ReviewBriefContent | undefined = props.brief && (props.brief.asked || props.brief.report || props.brief.reviewer) && !props.historical
    ? {
      ...props.brief,
      reviewer: props.brief.reviewer ? {
        ...props.brief.reviewer,
        status: headline.label,
        counts: [findingWords(findings), settledCount ? `${settledCount} settled` : ''].filter(Boolean).join(' · ') || undefined
      } : undefined,
      scope: files.length && effectiveScope === 'all' ? {
        files: files.length,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0)
      } : undefined
    }
    : undefined;

  const renderThreads = (items: ReviewFindingView[] | undefined) => items?.map((finding) => (
    <ReviewFindingThread
      key={finding.id}
      finding={finding}
      focused={focusedFindingId === finding.id}
      actionable={findingsActionable}
      inRequest={included.has(finding.id)}
      dismissing={dismissingId === finding.id}
      onDismissingChange={(open) => setDismissingId(open ? finding.id : undefined)}
      onFocus={() => setFocusedFindingId(finding.id)}
      onDismiss={props.onDismissFinding}
      onRestore={props.onRestoreFinding}
      onAsk={props.onAskAboutFinding}
      onToggleInclude={props.findingsSendable ? toggleIncluded : undefined}
    />
  ));

  // A comment is written in the app's composer: what it is about, the field, then the actions.
  const composerForm = (draftComment: CommentDraft) => (
    <form key="composer" className="tm-composer tm-review-comment-composer" onSubmit={(event) => { event.preventDefault(); saveComment(); }}>
      <span className="tm-review-comment-composer__about">{commentAbout(draftComment)}</span>
      <label className="tm-visually-hidden" htmlFor={`${composerId}-comment`}>Comment</label>
      <textarea
        id={`${composerId}-comment`}
        className="tm-composer__input"
        autoFocus
        rows={2}
        value={draftComment.text}
        placeholder="Add a comment"
        onChange={(event) => setCommentDraft({ ...draftComment, text: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); setCommentDraft(undefined); }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveComment(); }
        }}
      />
      <div className="tm-composer__toolbar">
        <span className="tm-composer__hint">Saved to your review; sent with Request changes</span>
        <button type="button" className="ghost-button" onClick={() => setCommentDraft(undefined)}>Cancel</button>
        <Tooltip label={draftComment.editingId ? 'Save' : 'Add comment'} shortcut={SUBMIT_SHORTCUT}>
          <button type="submit" className="primary-button button--sm" disabled={!draftComment.text.trim()}>
            {draftComment.editingId ? 'Save' : 'Add comment'}
          </button>
        </Tooltip>
      </div>
    </form>
  );
  const renderComposer = (key: string) =>
    commentDraft && !commentDraft.editingId && commentDraft.key === key ? composerForm(commentDraft) : null;

  // A comment being edited gives its place to the composer.
  const renderComments = (items: ReviewComment[] | undefined) => items?.map((comment) => (
    commentDraft?.editingId === comment.id ? <Fragment key={comment.id}>{composerForm(commentDraft)}</Fragment> : (
      <div key={comment.id} className="tm-review-comment" data-comment-id={comment.id} tabIndex={-1}>
        <div className="tm-review-comment__body">
          {comment.endLine || comment.side === 'OLD' || !comment.line ? (
            <span className="tm-review-comment__about">{commentAbout(comment)}</span>
          ) : null}
          <p>{comment.text}</p>
        </div>
        {canComment ? (
          <div className="tm-review-comment__actions">
            <button type="button" className="ghost-button" onClick={() => setCommentDraft({
              key: comment.id, path: comment.path, side: comment.side, line: comment.line, endLine: comment.endLine, text: comment.text, editingId: comment.id
            })}>Edit</button>
            <button type="button" className="ghost-button" onClick={() => deleteComment(comment.id)}>Delete</button>
          </div>
        ) : null}
      </div>
    )
  ));

  const compareMeta = effectiveScope === 'all' && props.worktree
    ? `${props.worktree.baseRef ?? 'base'}@${props.worktree.baseSha.slice(0, 7)} → working tree`
    : undefined;
  const feedbackCount = (props.findingsSendable ? plan.send.length + plan.suggestions.length : openFindings.length) + draft.comments.length;

  return (
    <section className="tm-review" aria-label="Review" onKeyDown={onKeyDown}>
      <div className="tm-review__bar">
        {props.historical ? (
          <>
            <span className="tm-review__headline">{props.historical.capturedAt ? 'Earlier capture' : 'Earlier capture unavailable'}</span>
            {props.historical.capturedAt ? (
              <span className="tm-review__meta">
                {props.historical.headSha ? <code>{props.historical.headSha.slice(0, 8)}</code> : null}
                <MessageTime value={props.historical.capturedAt} />
              </span>
            ) : null}
            <button type="button" className="ghost-button tm-review__bar-end" onClick={props.historical.onBack}>Back to current changes</button>
          </>
        ) : (
          <>
            <span className={`tm-review__headline${review?.status === 'RUNNING' ? ' tm-shimmer' : ''}`} data-tone={headline.tone}>
              {headline.label}
            </span>
            {review?.reviewedAt && review.status !== 'RUNNING' && review.status !== 'NOT_RUN' ? (
              <span className="tm-review__meta">Reviewed <MessageTime value={review.reviewedAt} /></span>
            ) : null}
            <ActionMenu
              className="tm-review__scope tm-review__bar-end"
              label="Changes to show"
              selection="single"
              side="bottom"
              trigger={<>{SCOPE_LABELS[effectiveScope]}{compareMeta ? <span className="tm-review__compare">{compareMeta}</span> : null}<ChevronDown size={13} aria-hidden="true" /></>}
              items={scopeItems}
            />
            <ActionMenu
              className="tm-review__view"
              label="View options"
              side="bottom"
              trigger={<>View<ChevronDown size={13} aria-hidden="true" /></>}
              items={viewItems}
            />
            {props.runReview ? (
              <span className="tm-actiontitle" title={props.runReview.disabledReason}>
                <button
                  type="button"
                  className={stale ? 'primary-button button--sm' : 'outline-button button--sm'}
                  disabled={Boolean(props.runReview.disabledReason) || props.runReview.busy}
                  onClick={props.runReview.onRun}
                >
                  {props.runReview.label}
                </button>
              </span>
            ) : null}
          </>
        )}
      </div>

      {diff.inspection.completeness === 'INCOMPLETE' && !diff.loading ? (
        <p className="tm-review__notice" role="status">The captured diff is incomplete. Listed files are real; missing ones are not established.</p>
      ) : null}

      <div className="tm-review__work">
        <nav className="tm-review__index" aria-label="Files and feedback">
          <div className="segmented segmented--fill tm-review__rail-switch" role="group" aria-label="Show">
            <button type="button" className="segmented__btn" aria-pressed={rail === 'files'} onClick={() => setRail('files')}>
              Files<span className="tm-review__rail-count">{files.length}</span>
            </button>
            <button type="button" className="segmented__btn" aria-pressed={rail === 'feedback'} onClick={() => setRail('feedback')}>
              Feedback<span className="tm-review__rail-count">{feedbackCount}</span>
            </button>
          </div>
          <div className="tm-review__index-list">
            {rail === 'files' ? ordered.map((entry) => {
              const fileFindings = findingsByFile.get(entry.file.id) ?? [];
              const words = findingWords(fileFindings);
              const comments = draft.comments.filter((comment) => normalizeReviewPath(comment.path) === normalizeReviewPath(entry.file.path)).length;
              const sub = [words, comments ? `${comments} comment${comments === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')
                || roleWord(entry);
              return (
                <button
                  key={entry.file.id}
                  type="button"
                  className={`tm-review__index-file${activeFileId === entry.file.id ? ' tm-review__index-file--active' : ''}${isViewed(entry.file) ? ' tm-review__index-file--viewed' : ''}`}
                  onClick={() => { if (isCollapsed(entry)) expand(entry.file.id); scrollToFile(entry.file.id); }}
                >
                  <span className="tm-review__index-path">{indexLabel(entry.file, files)}</span>
                  {isViewed(entry.file) ? <Check size={13} aria-label="Viewed" /> : <DiffStat file={entry.file} />}
                  {sub ? <span className="tm-review__index-sub" data-tone={fileFindings.some((finding) => finding.state === 'OPEN' && isBlockingFinding(finding)) ? 'blocked' : undefined}>{sub}</span> : null}
                </button>
              );
            }) : (
              <FeedbackList
                plan={plan}
                findingsSendable={props.findingsSendable}
                findings={findings}
                comments={draft.comments}
                focusedFindingId={focusedFindingId}
                onShowFinding={scrollToFinding}
                onShowComment={scrollToComment}
              />
            )}
          </div>
          {files.length > 0 ? (
            <div className="tm-review__progress">
              <span>{viewedCount} of {files.length} viewed</span>
              <span className="tm-review__meter" aria-hidden="true"><span style={{ width: `${(viewedCount / files.length) * 100}%` }} /></span>
            </div>
          ) : null}
        </nav>

        <div ref={diffRef} className="tm-review__diff" tabIndex={-1} onScroll={(event) => onDiffScroll(event.currentTarget)}>
          {briefContent ? (
            <ReviewBrief
              content={briefContent}
              folded={briefFolded}
              onFoldedChange={(folded) => { setBriefFolded(folded); writeBriefFolded(props.taskId, briefRound, folded); }}
            />
          ) : null}
          {unavailable || emptyScope ? <p className="tm-review__empty">{unavailable ?? emptyScope}</p> : null}
          {anchored.general.length > 0 ? (
            <section className="tm-review-general" aria-label="Findings without a location">
              {renderThreads(anchored.general)}
            </section>
          ) : null}
          {ordered.map((entry) => {
            const { file } = entry;
            const fileViewed = isViewed(file);
            const collapsed = isCollapsed(entry);
            const fileFindings = findingsByFile.get(file.id) ?? [];
            const blocking = fileFindings.some((finding) => finding.state === 'OPEN' && isBlockingFinding(finding));
            const parts = file.path.split('/');
            const name = parts.pop() ?? file.path;
            const fileKey = `file:${file.id}`;
            return (
              <section key={file.id} className={`tm-review-file${collapsed ? ' tm-review-file--collapsed' : ''}`} data-file-id={file.id} aria-label={file.path}>
                <header className="tm-review-file__head" onContextMenu={(event) => openPathMenu(file.path, event)}>
                  <Tooltip label={collapsed ? 'Expand' : 'Collapse'} shortcut="⌥-click: all files">
                    <button
                      type="button"
                      className="tm-iconbtn tm-review-file__toggle"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${file.path}`}
                      onClick={(event) => toggleCollapsed(entry, event.altKey)}
                    >
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <span className="tm-review-file__path">
                    {parts.length ? <span className="tm-review-file__dir">{parts.join('/')}/</span> : null}
                    <span className="tm-review-file__name">{name}</span>
                  </span>
                  {file.oldPath ? <span className="tm-review-file__word">Renamed from <code>{file.oldPath}</code></span>
                    : file.status === 'added' || file.status === 'deleted' ? <span className="tm-review-file__word">{file.status === 'added' ? 'Added' : 'Deleted'}</span> : null}
                  {roleWord(entry) ? <span className="tm-review-file__word">{roleWord(entry)}</span> : null}
                  <span className="tm-review-file__spacer" />
                  {findingWords(fileFindings) ? <span className="tm-review-file__count" data-tone={blocking ? 'blocked' : undefined}>{findingWords(fileFindings)}</span> : null}
                  <DiffStat file={file} />
                  <label className="tm-review-file__viewed">
                    <input type="checkbox" checked={fileViewed} onChange={() => setFileViewed(file, !fileViewed)} />
                    Viewed
                  </label>
                  <FileMenu
                    path={file.path}
                    target={props.worktree && !props.historical ? { type: 'worktreeFile', taskId: props.worktree.taskId, worktreeId: props.worktree.id, relativePath: file.path } : undefined}
                    onComment={canComment ? () => {
                      if (collapsed) expand(file.id);
                      setCommentDraft({ key: fileKey, path: file.path, side: 'NEW', text: '' });
                    } : undefined}
                    onError={(message) => notify(message, 'error')}
                  />
                </header>
                {collapsed ? (
                  // A collapsed file still states its open findings: Viewed never hides one.
                  fileFindings.filter((finding) => finding.state === 'OPEN').map((finding) => (
                    <div key={finding.id} className="tm-review-checkpoint">
                      <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
                      <span className="tm-review-checkpoint__title">{finding.title}</span>
                      <span className="tm-review-checkpoint__state">{included.has(finding.id) ? 'In the request' : 'Suggestion'}</span>
                      <button type="button" className="tm-osection__link" onClick={() => scrollToFinding(finding.id)}>Show</button>
                    </div>
                  ))
                ) : (
                  <>
                    {renderThreads(anchored.byFile.get(file.id))}
                    {renderComments(anchoredComments.byFile.get(file.id))}
                    {renderComposer(fileKey)}
                    {file.blocks.map((block) => (
                      <div key={block.id} className="tm-review-block">
                        {file.blocks.length > 1 ? <div className="tm-review-block__label">{block.label}</div> : null}
                        {buildReviewDiffRows(block.lines).map((row, rowIndex) => {
                          if (row.kind === 'gap') {
                            if (row.hidden === 0 && !row.heading) return null;
                            return (
                              <div key={`gap-${rowIndex}`} className="tm-review-gap">
                                {row.hidden > 0 ? <span>{row.hidden} unchanged line{row.hidden === 1 ? '' : 's'}</span> : null}
                                {row.heading ? <code>{row.heading}</code> : null}
                              </div>
                            );
                          }
                          const anchor = lineAnchorKey(file.id, block.id, row.index);
                          const line = row.line;
                          const number = line.kind === 'deletion' ? line.oldLine : line.newLine;
                          const selected = selection?.fileId === file.id && selection.blockId === block.id &&
                            row.index >= selection.start && row.index <= selection.end;
                          return (
                            <div key={anchor} className="tm-review-line-group">
                              <div
                                className={`tm-diffline tm-diffline--${line.kind} tm-diffline--annotated${selected ? ' tm-diffline--selected' : ''}`}
                                onContextMenu={(event) => openPathMenu(file.path, event, line.newLine ?? line.oldLine)}
                              >
                                {/* The number selects the line; shift-click extends the range a comment covers. */}
                                <span className="tm-diffline__num" onClick={(event) => selectRow(file, block, row.index, event.shiftKey)}>{number ?? ''}</span>
                                {/* The note column is reserved on every row, so the "+" never covers a number. */}
                                <span className="tm-diffline__note">
                                  {canComment && number !== undefined ? (
                                    <button
                                      type="button"
                                      className="tm-review-line__comment"
                                      aria-label={`Comment on ${line.kind === 'deletion' ? 'removed ' : ''}line ${number}`}
                                      onClick={() => openComposer(file, block, row.index)}
                                    >
                                      <Plus size={12} aria-hidden="true" />
                                    </button>
                                  ) : null}
                                </span>
                                <span className="tm-diffline__marker" aria-hidden="true">
                                  {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ''}
                                </span>
                                <code>
                                  {line.kind === 'addition' || line.kind === 'deletion' ? (
                                    <span className="tm-visually-hidden">{line.kind === 'addition' ? 'Added: ' : 'Removed: '}</span>
                                  ) : null}
                                  {lineCode(line.content, line.kind) || ' '}
                                </code>
                              </div>
                              {renderThreads(anchored.byLine.get(anchor))}
                              {renderComments(anchoredComments.byLine.get(anchor))}
                              {renderComposer(anchor)}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {props.historical ? null : (
        <ReviewOutcome
          plan={plan}
          findingsSendable={props.findingsSendable}
          comments={draft.comments}
          note={draft.note}
          onNoteChange={(note) => updateDraft({ note })}
          reviewNotes={Boolean(props.requestChanges?.reviewNotes)}
          request={props.requestChanges}
          finish={props.finish}
          sheetOpen={sheetOpen}
          onSheetOpenChange={setSheetOpen}
          onIncludeFinding={setIncluded}
          onDismissFinding={openDismiss}
          onDeleteComment={deleteComment}
          onShowFinding={(findingId) => { setSheetOpen(false); scrollToFinding(findingId); }}
          onShowComment={(commentId) => { setSheetOpen(false); scrollToComment(commentId); }}
        />
      )}

      {pathMenu ? <OpenTargetContextMenu target={pathMenu.target} position={pathMenu.position} onClose={closePathMenu} onError={(message) => notify(message, 'error')} /> : null}
    </section>
  );
}

/** What a comment is about, when its row does not already say it. */
function commentAbout(comment: Pick<ReviewComment, 'side' | 'line' | 'endLine'>): string {
  if (!comment.line) return 'Whole file';
  const lines = comment.endLine ? `Lines ${comment.line}–${comment.endLine}` : `Line ${comment.line}`;
  return comment.side === 'OLD' ? `Removed ${lines.toLowerCase()}` : lines;
}

/** A file's part in the change, when it is worth saying: the code a test covers, or generated output. */
function roleWord(entry: OrderedReviewFile): string {
  if (entry.subject) return `Test for ${entry.subject.path.split('/').at(-1)}`;
  if (entry.role === 'generated') return 'Generated';
  return '';
}

function lineCode(content: string, kind: string): string {
  if ((kind === 'addition' && content.startsWith('+')) || (kind === 'deletion' && content.startsWith('-')) || (kind === 'context' && content.startsWith(' '))) {
    return content.slice(1);
  }
  return content;
}

function DiffStat({ file }: { file: DiffFile }) {
  return (
    <span className="tm-review-stat">
      {file.additions ? <span className="tm-review-stat__add">+{file.additions}</span> : null}
      {file.deletions ? <span className="tm-review-stat__del">−{file.deletions}</span> : null}
    </span>
  );
}

/** A file's name in the navigator, with its folder only when another file shares the name. */
function indexLabel(file: DiffFile, files: readonly DiffFile[]): string {
  const parts = file.path.split('/');
  const name = parts.at(-1) ?? file.path;
  const shared = files.some((other) => other !== file && other.path.split('/').at(-1) === name);
  return shared && parts.length > 1 ? `${parts.at(-2)}/${name}` : name;
}

/** A file's "…" menu: comment on the whole file, then where it opens. */
function FileMenu({ path, target, onComment, onError }: {
  path: string;
  target?: OpenTargetRef;
  onComment?(): void;
  onError(message: string): void;
}) {
  const [open, setOpen] = useState(false);
  const openTargetItems = useOpenTargetMenuItems(target, open, onError);
  const items: ActionMenuItem[] = [
    ...(onComment ? [{ id: 'comment', label: 'Comment on file', onSelect: onComment }] : []),
    ...openTargetItems.map((item, index) => (index === 0 && onComment ? { ...item, separated: true } : item))
  ];
  if (!items.length) return null;
  return (
    <ActionMenu
      className="tm-review-file__menu"
      label={`Options for ${path}`}
      tooltip="File options"
      side="bottom"
      open={open}
      onOpenChange={setOpen}
      trigger={<MoreHorizontal size={16} aria-hidden="true" />}
      items={items}
    />
  );
}

/**
 * Every finding and comment, grouped by what happens to it: sent with the
 * request, offered as a suggestion, or settled. A finding of an out-of-date
 * review is only context, so those are listed apart.
 */
function FeedbackList({ plan, findingsSendable, findings, comments, focusedFindingId, onShowFinding, onShowComment }: {
  plan: ReviewRequestPlan;
  findingsSendable: boolean;
  findings: readonly ReviewFindingView[];
  comments: readonly ReviewComment[];
  focusedFindingId?: string;
  onShowFinding(findingId: string): void;
  onShowComment(commentId: string): void;
}) {
  const findingRow = (finding: ReviewFindingView, state?: string) => (
    <button
      key={finding.id}
      type="button"
      className={`tm-review__index-finding${focusedFindingId === finding.id ? ' tm-review__index-finding--active' : ''}`}
      data-state={finding.state}
      onClick={() => onShowFinding(finding.id)}
    >
      <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
      <span className="tm-review__index-title">{finding.title}</span>
      <span className="tm-review__index-loc">{state ?? formatFindingLocation(finding)}</span>
    </button>
  );
  const commentRow = (comment: ReviewComment) => (
    <button key={comment.id} type="button" className="tm-review__index-finding" onClick={() => onShowComment(comment.id)}>
      <span className="tm-review__severity">You</span>
      <span className="tm-review__index-title">{comment.text}</span>
      <span className="tm-review__index-loc">{formatCommentLocation(comment)}</span>
    </button>
  );
  const groups: Array<{ label: string; rows: ReactElement[] }> = findingsSendable
    ? [
      { label: 'To send', rows: [...plan.send.map((finding) => findingRow(finding)), ...comments.map(commentRow)] },
      { label: 'Suggestions', rows: plan.suggestions.map((finding) => findingRow(finding)) },
      { label: 'Settled', rows: plan.settled.map((finding) => findingRow(finding, settledLabel(finding))) }
    ]
    : [
      { label: 'Your comments', rows: comments.map(commentRow) },
      { label: 'From the earlier review', rows: findings.map((finding) => findingRow(finding)) }
    ];
  const shown = groups.filter((group) => group.rows.length > 0);
  if (!shown.length) return <p className="tm-review__index-empty">No findings or comments yet.</p>;
  return (
    <>
      {shown.map((group) => (
        <div key={group.label} className="tm-review__index-group">
          <h3 className="tm-review__index-label">{group.label}</h3>
          {group.rows}
        </div>
      ))}
    </>
  );
}
