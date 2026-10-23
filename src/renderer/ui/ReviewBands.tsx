import { useId, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { ReviewComment } from '../../shared/contracts';
import type { DiffFile } from '../model/diffEvidence';
import { formatDiscussionLocation, type DiscussionView } from '../model/pullRequestFeedback';
import { sideLines, type ReviewFindingView } from '../model/reviewWorkspace';
import { Avatar } from './Avatar';
import { ReviewDiscussionThread } from './ReviewDiscussionThread';
import { ReviewFindingThread } from './ReviewFindingThread';
import { SUBMIT_SHORTCUT, Tooltip } from './Tooltip';
import { AgentMark } from './UiIcons';
import { useReviewActions, useReviewBands, type CommentDraft } from './useReviewModel';

/**
 * What is said about the code at one place: under a line, at a file's top, or
 * above the files. The reviewer's findings, then people's discussions, then the
 * person's own comments, then the composer when it opens here (`at`). A
 * discussion on its line says nothing more of its place; at its file's top or
 * above the files, it says where it points.
 */
export function ReviewBands({ place, at, file, findings, discussions, comments }: {
  place: 'line' | 'file' | 'general';
  /** The place's key (`lineAnchorKey`, or `file:<id>`): the composer opens here when it is this one. */
  at?: string;
  /** Under a line, its file: what a suggested change replaces is read from it. */
  file?: DiffFile;
  findings?: readonly ReviewFindingView[];
  discussions?: readonly DiscussionView[];
  comments?: readonly ReviewComment[];
}) {
  const actions = useReviewActions();
  const state = useReviewBands();
  const draft = state.commentDraft;
  return (
    <>
      {findings?.map((finding) => (
        <ReviewFindingThread
          key={finding.id}
          finding={finding}
          round={finding.previousFindingId ? 'STILL_OPEN' : state.reReview ? 'NEW' : undefined}
          focused={state.focusedFindingId === finding.id}
          actionable={state.findingsActionable}
          inRequest={state.included.has(finding.id)}
          dismissing={state.dismissingId === finding.id}
          onDismissingChange={(open) => actions.setDismissing(open ? finding.id : undefined)}
          onFocus={() => actions.focusFinding(finding.id)}
          onDismiss={state.canDismiss ? actions.dismissFinding : undefined}
          onRestore={state.canRestore ? actions.restoreFinding : undefined}
          onAsk={state.canAskAboutFinding ? actions.askAboutFinding : undefined}
          onToggleInclude={state.findingsSendable ? actions.toggleIncluded : undefined}
        />
      ))}
      {discussions?.map((discussion) => {
        const lines = { side: discussion.side ?? 'NEW', line: discussion.line, endLine: discussion.endLine };
        return (
          <ReviewDiscussionThread
            key={discussion.id}
            discussion={discussion}
            location={place === 'general' ? formatDiscussionLocation(discussion) : undefined}
            about={place === 'file' ? (discussion.line ? commentAbout(lines) : undefined)
              : place === 'line' && commentNeedsAbout(lines) ? commentAbout(lines) : undefined}
            folded={discussion.resolved || (!discussion.open && !discussion.path)}
            focused={state.focusedDiscussionId === discussion.id}
            inRequest={state.includedDiscussions.has(discussion.id)}
            onFocus={() => actions.focusDiscussion(discussion.id)}
            onToggleInclude={state.canComment ? actions.toggleDiscussion : undefined}
            reply={state.canReply ? {
              text: state.replyTexts?.get(discussion.id),
              draft: state.replyDrafts?.get(discussion.id),
              viewer: state.viewer,
              onTextChange: (text) => actions.setReplyText(discussion.id, text),
              onPost: (body, resolve) => actions.replyToDiscussion(discussion.id, body, resolve)
            } : undefined}
            onResolve={state.canResolve && discussion.resolvable ? (resolved) => actions.resolveDiscussion(discussion.id, resolved) : undefined}
            // Only on its own lines is the diff shown the code the comment was written on.
            codeLines={place === 'line' && file ? (start, end) => sideLines(file, lines.side, start, end) : undefined}
          />
        );
      })}
      {/* A comment being edited gives its place to the composer. */}
      {comments?.map((comment) => (draft?.editingId === comment.id
        ? <CommentComposer key={comment.id} draft={draft} />
        : <ReviewCommentBand key={comment.id} comment={comment} />))}
      {draft && !draft.editingId && draft.key === at ? <CommentComposer key="composer" draft={draft} /> : null}
    </>
  );
}

/** The person's own comment reads as theirs: their mark and You, with Edit and Delete on its head. */
function ReviewCommentBand({ comment }: { comment: ReviewComment }) {
  const actions = useReviewActions();
  const { viewer, canComment } = useReviewBands();
  return (
    <div className="tm-review-comment" data-comment-id={comment.id} tabIndex={-1}>
      <div className="tm-review-thread__comment">
        <Avatar name={viewer} className="tm-review-thread__avatar" />
        <header className="tm-review-thread__head">
          <span className="tm-review-thread__author">You</span>
          {commentNeedsAbout(comment) ? <span className="tm-review-comment__about">{commentAbout(comment)}</span> : null}
          <span className="tm-review-thread__spacer" />
          {canComment ? (
            <span className="tm-review-thread__actions tm-review-comment__actions">
              <Tooltip label="Edit">
                <button type="button" className="tm-iconbtn tm-review__mini" aria-label="Edit comment" onClick={() => actions.editComment(comment)}>
                  <Pencil size={13} aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip label="Delete">
                <button type="button" className="tm-iconbtn tm-review__mini" aria-label="Delete comment" onClick={() => actions.deleteComment(comment.id)}>
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </Tooltip>
            </span>
          ) : null}
        </header>
        <div className="tm-review-comment__body">
          <p>{comment.text}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * A comment is written as a reply is: a field on the code column under the line
 * or range it is about, its choices under it. What is typed stays its own, so a
 * keystroke renders the composer alone; it is kept while the file folds.
 */
function CommentComposer({ draft }: { draft: CommentDraft }) {
  const actions = useReviewActions();
  const { viewer, canAskAboutLines } = useReviewBands();
  const [text, setText] = useState(actions.commentText);
  // Opened again in the same place, it starts from what the new draft holds.
  const [opened, setOpened] = useState(draft);
  if (opened !== draft) {
    setOpened(draft);
    setText(actions.commentText());
  }
  const id = useId();
  return (
    <form className="tm-review-comment-composer" onSubmit={(event) => { event.preventDefault(); actions.saveComment(); }}>
      <div className="tm-review-thread__reply-row tm-review-thread__reply-row--open">
        <Avatar name={viewer} className="tm-review-thread__avatar" />
        {commentNeedsAbout(draft) ? <span className="tm-review-comment__about">{commentAbout(draft)}</span> : null}
        <label className="tm-visually-hidden" htmlFor={id}>Comment</label>
        <textarea
          id={id}
          className="tm-review-thread__reply-input"
          autoFocus
          rows={2}
          value={text}
          placeholder="Add a comment"
          onChange={(event) => { setText(event.target.value); actions.setCommentText(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); actions.closeComposer(); }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); actions.saveComment(); }
          }}
        />
        <div className="tm-review-thread__reply-tools">
          {/* A question about the lines goes to Ask; a comment goes in the request. */}
          {canAskAboutLines && !draft.editingId && draft.line ? (
            <button type="button" className="ghost-button button--sm" onClick={actions.askAboutLines}>
              <AgentMark />
              Ask
            </button>
          ) : null}
          <span className="tm-review-comment-composer__spacer" />
          <button type="button" className="ghost-button button--sm" onClick={actions.closeComposer}>Cancel</button>
          <Tooltip label={draft.editingId ? 'Save' : 'Comment'} shortcut={SUBMIT_SHORTCUT}>
            <button type="submit" className="primary-button button--sm" disabled={!text.trim()}>
              {draft.editingId ? 'Save' : 'Comment'}
            </button>
          </Tooltip>
        </div>
      </div>
    </form>
  );
}

/** A range, a removed line or the whole file needs saying; a single line is the row above. */
function commentNeedsAbout(comment: Pick<ReviewComment, 'side' | 'line' | 'endLine'>): boolean {
  return !comment.line || Boolean(comment.endLine) || comment.side === 'OLD';
}

/** What a comment is about, when its row does not already say it. */
function commentAbout(comment: Pick<ReviewComment, 'side' | 'line' | 'endLine'>): string {
  if (!comment.line) return 'Whole file';
  const lines = comment.endLine ? `Lines ${comment.line}–${comment.endLine}` : `Line ${comment.line}`;
  return comment.side === 'OLD' ? `Removed ${lines.toLowerCase()}` : lines;
}
