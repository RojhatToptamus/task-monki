import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Check, ChevronDown, MessageSquarePlus, Undo2, X } from 'lucide-react';
import type { AgentReviewGateStatus, ArtifactRecord, OpenTargetRef, WorktreeRecord } from '../../shared/contracts';
import type { DiffEvidenceScope, DiffFile } from '../model/diffEvidence';
import { findingLevel, formatFindingLocation } from '../model/findings';
import { openTargetMenuPosition } from '../model/openTargetMenu';
import { readViewedFiles, writeViewedFiles } from '../model/reviewViewed';
import {
  anchorReviewFindings,
  buildReviewDiffRows,
  buildReviewIndex,
  diffFileSignature,
  filesChangedSinceReview,
  lineAnchorKey,
  normalizeReviewPath,
  type ReviewFindingView,
  type ReviewLineComment
} from '../model/reviewWorkspace';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { MessageTime } from './Message';
import { OpenTargetContextMenu } from './OpenTargetMenu';
import { Tooltip } from './Tooltip';
import { AgentMark } from './UiIcons';
import { useDiffArtifact } from './useDiffArtifact';

export type ReviewScope = DiffEvidenceScope | 'since-review';

export interface ReviewWorkspaceProps {
  taskId: string;
  /** The implementation agent's name, for "Add a note for Codex". */
  agentName: string;
  review?: {
    status: AgentReviewGateStatus;
    reviewedAt?: string;
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
  comments: ReviewLineComment[];
  onCommentsChange(comments: ReviewLineComment[]): void;
  note: string;
  onNoteChange(note: string): void;
  /** Present while the review is current: sends open findings and comments to the agent. */
  requestChanges?: {
    disabledReason?: string;
    busy: boolean;
    /** The review left notes but no structured findings; those notes are what gets sent. */
    reviewNotes?: boolean;
    onSubmit(): void;
  };
  /** Present when a review can run: none yet, or the code changed since it. */
  runReview?: { label: string; disabledReason?: string; busy: boolean; onRun(): void };
  onDismissFinding?(findingId: string, note?: string): Promise<void>;
  onRestoreFinding?(findingId: string): Promise<void>;
  onAskAboutFinding?(findingId: string): void;
}

const NO_FINDINGS: ReviewFindingView[] = [];

const SCOPE_LABELS: Record<ReviewScope, string> = {
  all: 'All changes',
  committed: 'Committed',
  uncommitted: 'Uncommitted',
  'since-review': 'Since the review'
};

function reviewHeadline(status: AgentReviewGateStatus | undefined, openCount: number): string {
  switch (status) {
    case 'RUNNING': return 'Reviewing';
    // A run after the review makes it out of date, whether or not files changed.
    case 'STALE': return 'Review out of date';
    case 'PASSED': return 'Review passed';
    case 'NEEDS_CHANGES': return openCount > 0 ? 'Needs changes' : 'No open findings';
    case 'INCONCLUSIVE': return 'Review inconclusive';
    case 'FAILED': return 'Review failed';
    case 'CANCELED': return 'Review stopped';
    default: return 'Not reviewed';
  }
}

/**
 * The Review tab: what changed, with the reviewer's findings on the code they
 * are about. One index lists files with their findings; the diff shows each
 * finding under its line; a bar at the foot sends open findings and the user's
 * own comments to the implementation agent.
 */
export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const { review, findings } = props;
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

  // Findings wait for the diff, so they never appear under General and then jump to their lines.
  const visibleFindings = props.historical || diff.loading ? NO_FINDINGS : findings;
  const anchored = useMemo(() => anchorReviewFindings(files, visibleFindings), [files, visibleFindings]);
  const index = useMemo(() => buildReviewIndex(files, anchored), [files, anchored]);
  const openFindings = findings.filter((finding) => finding.state === 'OPEN');
  const findingsActionable = !stale && review?.status !== 'RUNNING' && !props.historical;

  const [viewed, setViewed] = useState<Record<string, string>>(() => readViewedFiles(props.taskId));
  const isViewed = (file: DiffFile) => viewed[file.path] === diffFileSignature(file);
  const toggleViewed = (file: DiffFile) => {
    setViewed((currentViewed) => {
      const next = { ...currentViewed };
      if (next[file.path] === diffFileSignature(file)) delete next[file.path];
      else next[file.path] = diffFileSignature(file);
      writeViewedFiles(props.taskId, next);
      return next;
    });
  };
  const viewedCount = files.filter(isViewed).length;

  const [focusedFindingId, setFocusedFindingId] = useState<string>();
  const [activeFileId, setActiveFileId] = useState<string>();
  const [commentDraft, setCommentDraft] = useState<{ anchor: string; path: string; line?: number; text: string; editingId?: string }>();
  const [pathMenu, setPathMenu] = useState<{ target: OpenTargetRef; position: { x: number; y: number } }>();
  const diffRef = useRef<HTMLDivElement>(null);
  const noteId = useId();
  const requestReasonId = useId();

  // The index follows the reading position.
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
  }, [files]);

  const scrollToFile = (fileId: string) => {
    diffRef.current?.querySelector(`[data-file-id="${CSS.escape(fileId)}"]`)?.scrollIntoView({ block: 'start' });
    setActiveFileId(fileId);
  };
  const scrollToFinding = (findingId: string) => {
    setFocusedFindingId(findingId);
    const element = diffRef.current?.querySelector<HTMLElement>(`[data-finding-id="${CSS.escape(findingId)}"]`);
    element?.scrollIntoView({ block: 'center' });
    element?.focus({ preventScroll: true });
  };

  // J/K move between files, N/P between findings, V marks the current file viewed.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey || event.altKey || target.closest('input, textarea, [contenteditable="true"], [role="menu"]')) return;
    const key = event.key.toLowerCase();
    const fileIds = index.map((entry) => entry.file.id);
    const findingIds = index.flatMap((entry) => entry.findings.map((finding) => finding.id));
    const step = (list: string[], currentId: string | undefined, delta: number) => {
      if (list.length === 0) return undefined;
      const position = currentId ? list.indexOf(currentId) : -1;
      return list[Math.min(list.length - 1, Math.max(0, position + delta))];
    };
    if (key === 'j' || key === 'k') {
      const next = step(fileIds, activeFileId ?? fileIds[0], key === 'j' ? 1 : -1);
      if (next) { event.preventDefault(); scrollToFile(next); }
    } else if (key === 'n' || key === 'p') {
      const next = step(findingIds, focusedFindingId, key === 'n' ? 1 : -1);
      if (next) { event.preventDefault(); scrollToFinding(next); }
    } else if (key === 'v') {
      const file = files.find((candidate) => candidate.id === (activeFileId ?? files[0]?.id));
      if (file) { event.preventDefault(); toggleViewed(file); }
    }
  };

  const openPathMenu = (path: string, event: ReactMouseEvent, line?: number) => {
    if (!props.worktree || props.historical) return;
    event.preventDefault();
    setPathMenu({
      target: { type: 'worktreeFile', taskId: props.worktree.taskId, worktreeId: props.worktree.id, relativePath: path, line },
      position: openTargetMenuPosition(event.clientX, event.clientY)
    });
  };

  const saveComment = () => {
    if (!commentDraft?.text.trim()) { setCommentDraft(undefined); return; }
    const text = commentDraft.text.trim();
    props.onCommentsChange(commentDraft.editingId
      ? props.comments.map((comment) => (comment.id === commentDraft.editingId ? { ...comment, text } : comment))
      : [...props.comments, { id: `${Date.now().toString(36)}-${props.comments.length}`, path: commentDraft.path, line: commentDraft.line, text }]);
    setCommentDraft(undefined);
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

  const unavailable = diff.loading ? 'Loading changes…'
    : diff.error ? 'The captured diff could not be read.'
      : diff.missing ? (props.historical ? 'This capture has no diff.' : 'No changes captured yet.')
        : diff.inspection.completeness === 'UNINTERPRETABLE' ? 'The captured paths could not be read.'
          : undefined;
  // An incomplete capture never reads as empty: missing paths are unknown, not absent.
  const emptyScope = !unavailable && files.length === 0
    ? diff.inspection.completeness === 'INCOMPLETE' ? 'No paths could be confirmed from the incomplete capture.'
      : effectiveScope === 'since-review' ? 'Nothing changed since the review.' : 'No changes in this scope.'
    : undefined;
  const commentCount = props.comments.length;
  const requestSummary = [
    openFindings.length ? `${openFindings.length} finding${openFindings.length === 1 ? '' : 's'}` : '',
    commentCount ? `${commentCount} comment${commentCount === 1 ? '' : 's'}` : ''
  ].filter(Boolean).join(' and ') || "The review's notes";
  const showRequestBar = Boolean(props.requestChanges) && (openFindings.length > 0 || commentCount > 0 || Boolean(props.requestChanges?.reviewNotes));

  const renderThreads = (items: ReviewFindingView[] | undefined) => items?.map((finding) => (
    <ReviewFindingThread
      key={finding.id}
      finding={finding}
      focused={focusedFindingId === finding.id}
      actionable={findingsActionable}
      onFocus={() => setFocusedFindingId(finding.id)}
      onDismiss={props.onDismissFinding}
      onRestore={props.onRestoreFinding}
      onAsk={props.onAskAboutFinding}
    />
  ));

  const renderComments = (path: string, line?: number) => props.comments
    .filter((comment) => comment.path === path && comment.line === line && comment.id !== commentDraft?.editingId)
    .map((comment) => (
      <div key={comment.id} className="tm-review-comment">
        <p>{comment.text}</p>
        <div className="tm-review-comment__actions">
          <button type="button" className="ghost-button" onClick={() => setCommentDraft({ anchor: `${path}:${line ?? ''}`, path, line, text: comment.text, editingId: comment.id })}>Edit</button>
          <button type="button" className="ghost-button" onClick={() => props.onCommentsChange(props.comments.filter((candidate) => candidate.id !== comment.id))}>Delete</button>
        </div>
      </div>
    ));

  const renderComposer = (anchor: string) => commentDraft?.anchor === anchor ? (
    <div className="tm-review-comment tm-review-comment--draft">
      <label className="tm-visually-hidden" htmlFor={`${noteId}-comment`}>Comment</label>
      <textarea
        id={`${noteId}-comment`}
        autoFocus
        rows={2}
        value={commentDraft.text}
        placeholder={`Comment for ${props.agentName}`}
        onChange={(event) => setCommentDraft({ ...commentDraft, text: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); setCommentDraft(undefined); }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveComment(); }
        }}
      />
      <div className="tm-review-comment__actions">
        <button type="button" className="ghost-button" onClick={() => setCommentDraft(undefined)}>Cancel</button>
        <button type="button" className="primary-button button--sm" disabled={!commentDraft.text.trim()} onClick={saveComment}>
          {commentDraft.editingId ? 'Save' : 'Comment'}
        </button>
      </div>
    </div>
  ) : null;

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
            <span className={`tm-review__headline${review?.status === 'RUNNING' ? ' tm-shimmer' : ''}`}>
              {reviewHeadline(review?.status, openFindings.length)}
            </span>
            {review?.reviewedAt && review.status !== 'RUNNING' && review.status !== 'NOT_RUN' ? (
              <span className="tm-review__meta">Reviewed <MessageTime value={review.reviewedAt} /></span>
            ) : null}
            <ActionMenu
              className="tm-review__scope tm-review__bar-end"
              label="Changes to show"
              selection="single"
              side="bottom"
              trigger={<>{SCOPE_LABELS[effectiveScope]}<ChevronDown size={13} aria-hidden="true" /></>}
              items={scopeItems}
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
        <nav className="tm-review__index" aria-label="Files and findings">
          {files.length > 0 ? (
            <div className="tm-review__index-head">
              <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
              {viewedCount > 0 ? <span>{viewedCount} viewed</span> : null}
            </div>
          ) : null}
          {anchored.general.length > 0 ? (
            <>
              <div className="tm-review__index-file tm-review__index-file--general">General</div>
              {anchored.general.map((finding) => (
                <IndexFinding key={finding.id} finding={finding} active={focusedFindingId === finding.id} onSelect={() => scrollToFinding(finding.id)} />
              ))}
            </>
          ) : null}
          {index.map(({ file, findings: fileFindings }) => (
            <div key={file.id} className="tm-review__index-group">
              <button
                type="button"
                className={`tm-review__index-file${activeFileId === file.id ? ' tm-review__index-file--active' : ''}${isViewed(file) ? ' tm-review__index-file--viewed' : ''}`}
                title={file.path}
                onClick={() => scrollToFile(file.id)}
              >
                <span className="tm-review__index-path">{indexLabel(file, files)}</span>
                {isViewed(file) ? <Check size={13} aria-label="Viewed" /> : <DiffStat file={file} />}
              </button>
              {fileFindings.map((finding) => (
                <IndexFinding key={finding.id} finding={finding} active={focusedFindingId === finding.id} onSelect={() => scrollToFinding(finding.id)} />
              ))}
            </div>
          ))}
        </nav>

        <div ref={diffRef} className="tm-review__diff" tabIndex={-1}>
          {unavailable || emptyScope ? <p className="tm-review__empty">{unavailable ?? emptyScope}</p> : null}
          {anchored.general.length > 0 ? (
            <section className="tm-review-general" aria-label="Findings without a location">
              {renderThreads(anchored.general)}
            </section>
          ) : null}
          {files.map((file) => {
            const fileViewed = isViewed(file);
            return (
              <section key={file.id} className="tm-review-file" data-file-id={file.id} aria-label={file.path}>
                <header className="tm-review-file__head" onContextMenu={(event) => openPathMenu(file.path, event)}>
                  <span className="tm-review-file__path" title={file.path}>{file.path}</span>
                  {file.oldPath ? <span className="tm-review-file__renamed" title={file.oldPath}>renamed</span> : null}
                  <DiffStat file={file} />
                  <label className="tm-review-file__viewed">
                    <input type="checkbox" checked={fileViewed} onChange={() => toggleViewed(file)} />
                    Viewed
                  </label>
                </header>
                {fileViewed ? null : (
                  <>
                    {renderThreads(anchored.byFile.get(file.id))}
                    {file.blocks.map((block) => (
                      <div key={block.id} className="tm-review-block">
                        {file.blocks.length > 1 ? <div className="tm-review-block__label">{block.label}</div> : null}
                        {buildReviewDiffRows(block.lines).map((row, rowIndex) => {
                          if (row.kind === 'gap') {
                            if (row.hidden === 0 && !row.heading) return null;
                            return (
                              <div key={`gap-${rowIndex}`} className="tm-review-gap" title={row.raw}>
                                {row.hidden > 0 ? <span>{row.hidden} unchanged line{row.hidden === 1 ? '' : 's'}</span> : null}
                                {row.heading ? <code>{row.heading}</code> : null}
                              </div>
                            );
                          }
                          const anchor = lineAnchorKey(file.id, block.id, row.index);
                          const line = row.line;
                          const targetLine = line.newLine ?? line.oldLine;
                          const commentKey = `${file.path}:${line.newLine ?? ''}`;
                          return (
                            <div key={anchor} className="tm-review-line-group">
                              <div
                                className={`tm-diffline tm-diffline--${line.kind}`}
                                onContextMenu={(event) => openPathMenu(file.path, event, targetLine)}
                              >
                                <span className="tm-diffline__num">{line.oldLine ?? ''}</span>
                                <span className="tm-diffline__num">{line.newLine ?? ''}</span>
                                <span className="tm-diffline__marker" aria-hidden="true">
                                  {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ''}
                                </span>
                                <code>
                                  {line.kind === 'addition' || line.kind === 'deletion' ? (
                                    <span className="tm-visually-hidden">{line.kind === 'addition' ? 'Added: ' : 'Removed: '}</span>
                                  ) : null}
                                  {lineCode(line.content, line.kind) || ' '}
                                </code>
                                {line.newLine !== undefined && !props.historical && props.requestChanges ? (
                                  <button
                                    type="button"
                                    className="tm-review-line__comment"
                                    aria-label={`Comment on line ${line.newLine}`}
                                    onClick={() => setCommentDraft({ anchor: commentKey, path: file.path, line: line.newLine, text: '' })}
                                  >
                                    <MessageSquarePlus size={13} aria-hidden="true" />
                                  </button>
                                ) : null}
                              </div>
                              {renderThreads(anchored.byLine.get(anchor))}
                              {line.newLine !== undefined ? renderComments(file.path, line.newLine) : null}
                              {line.newLine !== undefined ? renderComposer(commentKey) : null}
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

      {showRequestBar && props.requestChanges ? (
        <div className="tm-review__request">
          <span className="tm-review__request-summary">{requestSummary}</span>
          <label className="tm-review__note">
            <span className="tm-visually-hidden">Note for {props.agentName}</span>
            <input
              id={noteId}
              type="text"
              value={props.note}
              placeholder={`Add a note for ${props.agentName}`}
              onChange={(event) => props.onNoteChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !props.requestChanges?.disabledReason) {
                  event.preventDefault();
                  props.requestChanges?.onSubmit();
                }
              }}
            />
          </label>
          {props.requestChanges.disabledReason ? (
            <span id={requestReasonId} className="tm-review__request-reason">{props.requestChanges.disabledReason}</span>
          ) : null}
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(props.requestChanges.disabledReason) || props.requestChanges.busy}
            aria-describedby={props.requestChanges.disabledReason ? requestReasonId : undefined}
            onClick={props.requestChanges.onSubmit}
          >
            Request changes
          </button>
        </div>
      ) : null}

      {pathMenu ? <OpenTargetContextMenu target={pathMenu.target} position={pathMenu.position} onClose={() => setPathMenu(undefined)} /> : null}
    </section>
  );
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

/** A file's name in the index, with its folder only when another file shares the name. */
function indexLabel(file: DiffFile, files: readonly DiffFile[]): string {
  const parts = file.path.split('/');
  const name = parts.at(-1) ?? file.path;
  const shared = files.some((other) => other !== file && other.path.split('/').at(-1) === name);
  return shared && parts.length > 1 ? `${parts.at(-2)}/${name}` : name;
}

function severityLabel(finding: ReviewFindingView): string {
  return findingLevel(finding.severity).label;
}

function IndexFinding({ finding, active, onSelect }: { finding: ReviewFindingView; active: boolean; onSelect(): void }) {
  return (
    <button
      type="button"
      className={`tm-review__index-finding${active ? ' tm-review__index-finding--active' : ''}`}
      data-state={finding.state}
      onClick={onSelect}
    >
      <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
      <span className="tm-review__index-title">{finding.title}</span>
    </button>
  );
}

/**
 * One finding under the line it is about. Open findings show the reasoning
 * and offer Ask and Dismiss; a dismissed or withdrawn finding folds to a line
 * that keeps the note or the reason.
 */
function ReviewFindingThread({ finding, focused, actionable, onFocus, onDismiss, onRestore, onAsk }: {
  finding: ReviewFindingView;
  focused: boolean;
  actionable: boolean;
  onFocus(): void;
  onDismiss?(findingId: string, note?: string): Promise<void>;
  onRestore?(findingId: string): Promise<void>;
  onAsk?(findingId: string): void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noteId = useId();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setDismissing(false);
      setNote('');
    } catch {
      // The shell reports the error; the thread keeps its input for a retry.
    } finally {
      setBusy(false);
    }
  };

  if (finding.state === 'WITHDRAWN') {
    return (
      <div className="tm-review-thread tm-review-thread--folded" data-finding-id={finding.id} tabIndex={-1}>
        <span className="tm-review-thread__struck">{finding.title}</span>
        <span>Withdrawn by the reviewer{finding.revision?.reason ? `: ${finding.revision.reason}` : ''}</span>
      </div>
    );
  }
  if (finding.state === 'DISMISSED') {
    return (
      <div className="tm-review-thread tm-review-thread--folded" data-finding-id={finding.id} tabIndex={-1}>
        <span className="tm-review-thread__struck">{finding.title}</span>
        <span>Dismissed{finding.dismissal?.note ? `: ${finding.dismissal.note}` : ''}</span>
        {actionable && onRestore ? (
          <button type="button" className="ghost-button tm-review-thread__undo" disabled={busy} onClick={() => void run(() => onRestore(finding.id))}>
            <Undo2 size={13} aria-hidden="true" />Undo
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <article
      className={`tm-review-thread${focused ? ' tm-review-thread--focused' : ''}${actionable ? '' : ' tm-review-thread--earlier'}`}
      data-finding-id={finding.id}
      tabIndex={-1}
      onFocus={onFocus}
      aria-label={`${severityLabel(finding)} finding: ${finding.title}`}
    >
      <header className="tm-review-thread__head">
        <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
        <strong>{finding.title}</strong>
        {actionable && (onAsk || onDismiss) ? (
          <span className="tm-review-thread__actions">
            {onAsk ? (
              <Tooltip label="Ask the reviewer">
                <button type="button" className="tm-iconbtn" aria-label="Ask the reviewer about this finding" onClick={() => onAsk(finding.id)}>
                  <AgentMark />
                </button>
              </Tooltip>
            ) : null}
            {onDismiss ? (
              <Tooltip label="Dismiss">
                <button type="button" className="tm-iconbtn" aria-label="Dismiss this finding" aria-expanded={dismissing} onClick={() => setDismissing((value) => !value)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
          </span>
        ) : null}
      </header>
      {finding.path && !finding.line ? <span className="tm-review-thread__location">{formatFindingLocation(finding)}</span> : null}
      <p className="tm-review-thread__why">{finding.explanation}</p>
      {finding.recommendation ? <p className="tm-review-thread__fix">{finding.recommendation}</p> : null}
      {finding.revision && finding.revision.kind !== 'WITHDRAW' ? (
        <p className="tm-review-thread__revision">
          {finding.revision.kind === 'ADD' ? 'Added by the reviewer' : `Reviewer changed this from ${findingLevel(finding.originalSeverity ?? finding.severity).label}`}: {finding.revision.reason}
        </p>
      ) : null}
      {!actionable ? <p className="tm-review-thread__earlier">From the earlier review</p> : null}
      {dismissing && onDismiss ? (
        <form className="tm-review-thread__dismiss" onSubmit={(event) => { event.preventDefault(); void run(() => onDismiss(finding.id, note.trim() || undefined)); }}>
          <label className="tm-visually-hidden" htmlFor={noteId}>Why dismiss it (optional)</label>
          <input
            id={noteId}
            autoFocus
            type="text"
            maxLength={500}
            value={note}
            placeholder="Why, optionally"
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setDismissing(false); } }}
          />
          <button type="submit" className="outline-button button--sm" disabled={busy}>Dismiss</button>
        </form>
      ) : null}
    </article>
  );
}
