import { useId, useState, type ReactNode } from 'react';
import { Pencil, Trash2, Undo2 } from 'lucide-react';
import type { ReviewComment } from '../../shared/contracts';
import type { DiffFile } from '../model/diffEvidence';
import { formatFindingLocation } from '../model/findings';
import { discussionSummary, formatDiscussionLocation, type DiscussionView } from '../model/pullRequestFeedback';
import type { BandAnswer } from '../model/reviewRounds';
import { sideLines, type ReviewFindingView } from '../model/reviewWorkspace';
import { Avatar } from './Avatar';
import { CommentText, ReviewDiscussionThread } from './ReviewDiscussionThread';
import { ReviewFindingThread } from './ReviewFindingThread';
import { AnswerState, ReopenAnswer, RequestItemAnswer, type ItemAnswer } from './ReviewRound';
import { SUBMIT_SHORTCUT, Tooltip } from './Tooltip';
import { AgentMark } from './UiIcons';
import { useReviewActions, useReviewBands, type CommentDraft } from './useReviewModel';

/** Where a band sits: under the last line it is about, at its file's top, or above the files. */
type BandPlace = 'line' | 'file' | 'general';

/**
 * What is said about the code at one place: under a line, at a file's top, or
 * above the files. The reviewer's findings, then people's discussions, then the
 * person's own comments, then the composer when it opens here (`at`). A band
 * says the lines it is about only where its place does not: under a range, or
 * at its file's top; above the files, it says where it points. Whatever the
 * agent answered in the person's latest request says the answer, and takes the
 * person's decision on it.
 */
export function ReviewBands({ place, at, file, row, findings, discussions, comments }: {
  place: BandPlace;
  /** The place's key (`lineAnchorKey`, or `file:<id>`): the composer opens here when it is this one. */
  at?: string;
  /** Its file, under a line or at its top: what a suggested change replaces is read from it. */
  file?: DiffFile;
  /** Under a line, that row of the diff shown, and whether it takes comments. */
  row?: { blockId: string; index: number; commentable: boolean };
  findings?: readonly ReviewFindingView[];
  discussions?: readonly DiscussionView[];
  comments?: readonly ReviewComment[];
}) {
  const actions = useReviewActions();
  const state = useReviewBands();
  const draft = state.commentDraft;
  // Sent again, an item is a comment on the row its band sits under, read from the diff shown, when that row
  // takes comments; otherwise on its file; one with no file is quoted in the note.
  const again = file ? (row?.commentable ? { fileId: file.id, blockId: row.blockId, index: row.index } : { fileId: file.id }) : undefined;
  // An answer of the latest request takes the person's decision, and goes in the request again from here.
  const itemAnswer = (band: BandAnswer | undefined): ItemAnswer | undefined => band && {
    outcome: band.outcome,
    note: band.note,
    agent: state.agent,
    at: state.answers?.answeredAt,
    accepted: band.accepted,
    ...(state.canDecideAnswers ? { onDecide: (kind) => actions.decideAnswer(band.item.number, kind) } : {}),
    ...(state.canComment ? { onRequestAgain: () => actions.requestAgain(band.item, again) } : {})
  };
  // One sent in an earlier request still says what the agent answered, for the person alone.
  const discussionAnswer = (discussion: DiscussionView): ItemAnswer | undefined => {
    const sent = discussion.sent;
    if (!sent?.outcome) return undefined;
    return itemAnswer(state.answers?.discussions.get(discussion.id)) ??
      { outcome: sent.outcome, note: sent.note, agent: state.agent, at: sent.answeredAt, accepted: false };
  };
  return (
    <>
      {findings?.map((finding) => (
        <ReviewFindingThread
          key={finding.id}
          finding={finding}
          location={place === 'general' && finding.path ? formatFindingLocation(finding) : undefined}
          about={linesWords(finding, place)}
          round={finding.previousFindingId ? 'STILL_OPEN' : state.reReview ? 'NEW' : undefined}
          answer={itemAnswer(state.answers?.findings.get(finding.id))}
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
            answer={discussionAnswer(discussion)}
            location={place === 'general' ? formatDiscussionLocation(discussion) : undefined}
            // A platform's old side is the base file, unchanged lines included, not only removed ones.
            about={linesWords(lines, place, 'Old')}
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
            onAsk={state.canAskAboutDiscussion ? () => actions.askAboutDiscussion(discussion.id) : undefined}
            // Only on its own lines is the diff shown the code the comment was written on.
            codeLines={place === 'line' && file ? (start, end) => sideLines(file, lines.side, start, end) : undefined}
          />
        );
      })}
      {/* A comment being edited gives its place to the composer. */}
      {comments?.map((comment) => (draft?.editingId === comment.id
        ? <CommentComposer key={comment.id} draft={draft} about={linesWords(comment, place)} />
        : <ReviewCommentBand key={comment.id} comment={comment} about={linesWords(comment, place)}
          answer={itemAnswer(state.answers?.comments.get(comment.id))} />))}
      {draft && !draft.editingId && draft.key === at ? <CommentComposer key="composer" draft={draft} about={linesWords(draft, place)} /> : null}
    </>
  );
}

/**
 * The person's own comment reads as everyone's does: their mark and You, the
 * lines when its place does not say them, its words as markdown, and Edit and
 * Delete on its head. Deleted, it folds to a line with Restore until the
 * request goes. One they sent that the agent answered says the answer instead,
 * quotes it, and folds to a line once they accept it.
 */
function ReviewCommentBand({ comment, about, answer }: { comment: ReviewComment; about?: string; answer?: ItemAnswer }) {
  const actions = useReviewActions();
  const { canComment, deletedCommentIds } = useReviewBands();
  if (deletedCommentIds.has(comment.id)) {
    return (
      <div className="tm-review-thread tm-review-thread--folded" data-comment-id={comment.id} tabIndex={-1}>
        <span className="tm-review-thread__author">You</span>
        <span className="tm-review-thread__struck" title={comment.text}>{commentLine(comment)}</span>
        <span>Deleted</span>
        <button type="button" className="ghost-button tm-review-thread__undo" onClick={() => actions.restoreComment(comment.id)}>
          <Undo2 size={13} aria-hidden="true" />Restore
        </button>
      </div>
    );
  }
  if (answer?.accepted) {
    return (
      <div className="tm-review-thread tm-review-thread--folded" data-comment-id={comment.id} tabIndex={-1}>
        <span className="tm-review-thread__author">You</span>
        <span className="tm-review-answer__settled" title={comment.text}>{commentLine(comment)}</span>
        <span>Accepted</span>
        <ReopenAnswer answer={answer} />
      </div>
    );
  }
  return (
    <div className="tm-review-comment" data-comment-id={comment.id} tabIndex={-1}>
      <div className="tm-review-thread__comment">
        <OwnHead about={about} answer={answer}>
          {!answer && canComment ? (
            <span className="tm-review-thread__actions tm-review-comment__actions">
              <Tooltip label="Edit">
                <button type="button" className="tm-iconbtn tm-review__mini" aria-label="Edit comment" onClick={() => actions.editComment(comment)}>
                  <Pencil size={13} aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip label="Delete">
                <button type="button" className="tm-iconbtn tm-review__mini" aria-label="Delete comment" onClick={() => actions.deleteComment(comment.id, { focus: true })}>
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </Tooltip>
            </span>
          ) : null}
        </OwnHead>
        <CommentText text={comment.text} />
      </div>
      {answer ? <RequestItemAnswer answer={answer} /> : null}
    </div>
  );
}

/**
 * The comment being written is the comment it becomes: the same head, its words
 * as a field on the code column, and its choices under it. What is typed stays
 * its own, so a keystroke renders the composer alone; it is kept while the file
 * folds and while the person chooses other lines for it. ⌘↵ saves; Escape
 * closes it when nothing typed would be lost, and otherwise leaves it with its
 * words, where C returns.
 */
function CommentComposer({ draft, about }: { draft: CommentDraft; about?: string }) {
  const actions = useReviewActions();
  const { canAskAboutLines } = useReviewBands();
  const [text, setText] = useState(actions.commentText);
  // Opened again in the same place, it starts from what the new draft holds.
  const [opened, setOpened] = useState(draft);
  if (opened !== draft) {
    setOpened(draft);
    setText(actions.commentText());
  }
  const id = useId();
  return (
    <form className="tm-review-comment-composer" tabIndex={-1} onSubmit={(event) => { event.preventDefault(); actions.saveComment(); }}>
      <div className="tm-review-thread__comment">
        <OwnHead about={about} />
        <label className="tm-visually-hidden" htmlFor={id}>Comment</label>
        <textarea
          id={id}
          className="tm-review-thread__reply-input"
          rows={2}
          value={text}
          placeholder="Add a comment"
          onChange={(event) => { setText(event.target.value); actions.setCommentText(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); actions.leaveComposer(); }
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

/**
 * The person's head on what they write: their mark, then its facts (You, the
 * lines when its place does not say them, the agent's answer), then its controls.
 */
function OwnHead({ about, answer, children }: { about?: string; answer?: ItemAnswer; children?: ReactNode }) {
  const { viewer } = useReviewBands();
  return (
    <>
      <Avatar name={viewer} className="tm-review-thread__avatar" />
      <header className="tm-review-thread__head">
        <span className="tm-review-thread__author">You</span>
        {about ? <span className="tm-review-thread__about">{about}</span> : null}
        {answer ? <AnswerState answer={answer} /> : null}
        <span className="tm-review-thread__spacer" />
        {children}
      </header>
    </>
  );
}

/** A comment as one line, as its request lists it. */
function commentLine(comment: Pick<ReviewComment, 'text'>): string {
  return discussionSummary({ comments: [{ body: comment.text, truncated: false }] });
}

/**
 * The lines a band is about, in words, where its place does not say them:
 * under its row only a range needs saying, at its file's top any line does, and
 * a band about the whole file needs nothing. On the old side, the person's
 * comments are on removed lines; a platform's threads may be on any line of the
 * base file (`Old`).
 */
function linesWords(
  lines: { side?: 'NEW' | 'OLD'; line?: number; endLine?: number },
  place: BandPlace,
  oldSide: 'Removed' | 'Old' = 'Removed'
): string | undefined {
  if (place === 'general' || !lines.line) return undefined;
  const range = Boolean(lines.endLine && lines.endLine > lines.line);
  if (place === 'line' && !range) return undefined;
  const numbers = range ? `${lines.line}–${lines.endLine}` : `${lines.line}`;
  return lines.side === 'OLD' ? `${oldSide} ${range ? 'lines' : 'line'} ${numbers}` : `${range ? 'Lines' : 'Line'} ${numbers}`;
}
