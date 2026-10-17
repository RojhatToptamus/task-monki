import { useId, useRef, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { remoteProviderName, type PullRequestComment } from '../../shared/contracts';
import { discussionAuthor, discussionCommentText, discussionSummary, reviewVerdictWords, type DiscussionView } from '../model/pullRequestFeedback';
import { REVIEW_OUTCOME_LABELS } from '../model/reviewRounds';
import { formatShortAge } from '../model/timeAgo';
import { DisclosureChevron } from './DisclosureChevron';
import { MessageMarkdown } from './MessageMarkdown';
import { Tooltip } from './Tooltip';
import { useClampOverflow } from './useClampOverflow';

/** Replies shown before the rest fold behind a count. */
const REPLIES_SHOWN = 3;

/** A discussion's state in one word, or none: what happened on the platform or to the request. */
export function discussionStateWord(discussion: Pick<DiscussionView, 'resolved' | 'sent' | 'outdated'>): string | undefined {
  if (discussion.resolved) return 'Resolved';
  if (discussion.sent) return discussion.sent.outcome ? REVIEW_OUTCOME_LABELS[discussion.sent.outcome] : 'Sent';
  return discussion.outdated ? 'Outdated' : undefined;
}

/**
 * A discussion from the pull request where it belongs in the diff: what people
 * wrote, each comment under its author, and its state on the platform. Add to
 * request puts it in what the agent receives; nothing goes unless added. A
 * resolved thread, or a remark that asks for nothing, folds to one line that
 * opens it.
 */
export function ReviewDiscussionThread({ discussion, location, about, folded: foldedByDefault, focused, inRequest, onFocus, onToggleInclude }: {
  discussion: DiscussionView;
  /** Its file and lines, above the files where no row says it. */
  location?: string;
  /** Its lines in words, at its file's top or under a range: "Line 12", "Lines 4–9". */
  about?: string;
  /** It starts as one line. */
  folded: boolean;
  focused: boolean;
  inRequest: boolean;
  onFocus(): void;
  onToggleInclude?(discussionId: string): void;
}) {
  const [opened, setOpened] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const platform = remoteProviderName(discussion.provider);
  const author = discussionAuthor(discussion) ?? 'Unknown';
  const state = discussionStateWord(discussion);
  const verdict = discussion.kind === 'REVIEW' ? reviewVerdictWords(discussion.reviewState) : undefined;
  const openLink = discussion.url ? (
    <Tooltip label={`Open on ${platform}`}>
      <a className="tm-iconbtn tm-review__mini" href={discussion.url} target="_blank" rel="noreferrer" aria-label={`Open on ${platform}`}>
        <ExternalLink size={13} aria-hidden="true" />
      </a>
    </Tooltip>
  ) : null;

  if (foldedByDefault && !opened && !inRequest) {
    return (
      <div className="tm-review-thread tm-review-thread--folded tm-review-thread--discussion" data-discussion-id={discussion.id} tabIndex={-1} onFocus={onFocus}>
        <button type="button" className="tm-review-thread__fold" aria-expanded={false} onClick={() => setOpened(true)}>
          <span className="tm-review-thread__author">{author}</span>
          <span className="tm-review-thread__summary">{discussionSummary(discussion)}</span>
        </button>
        {state ?? verdict ? <span>{state ?? verdict}</span> : null}
        {openLink}
      </div>
    );
  }

  const [first, ...replies] = discussion.comments;
  const hiddenReplies = repliesOpen || replies.length <= REPLIES_SHOWN ? 0 : replies.length - 1;
  const shownReplies = hiddenReplies ? replies.slice(-1) : replies;
  // The platform keeps more replies than were read: the first and the latest are here.
  const elsewhere = discussion.commentCount - discussion.comments.length;
  return (
    <article
      className={`tm-review-thread tm-review-thread--discussion${focused ? ' tm-review-thread--focused' : ''}`}
      data-discussion-id={discussion.id}
      tabIndex={-1}
      onFocus={onFocus}
      aria-label={`${platform} comment by ${author}`}
    >
      <header className="tm-review-thread__head">
        <span className="tm-review-thread__author">{author}</span>
        {verdict ? <span className="tm-review-thread__round">{verdict}</span> : null}
        <CommentAge comment={first} />
        <span className="tm-review-thread__spacer" />
        {state ? <span className="tm-review-thread__round">{state}</span> : null}
        <span className="tm-review-thread__actions">
          {onToggleInclude && !discussion.resolved ? (
            <Tooltip label={inRequest ? 'Take out of the request' : 'Add to the request'} shortcut="F">
              <button type="button" className="ghost-button tm-review-thread__include" aria-pressed={inRequest} onClick={() => onToggleInclude(discussion.id)}>
                {inRequest ? <><Check size={13} aria-hidden="true" />In request</> : 'Add to request'}
              </button>
            </Tooltip>
          ) : null}
          {openLink}
          {foldedByDefault && !inRequest ? (
            <Tooltip label="Fold">
              <button type="button" className="tm-iconbtn tm-review__mini tm-review-thread__fold-toggle" aria-expanded={true} aria-label="Fold" onClick={() => setOpened(false)}>
                <DisclosureChevron />
              </button>
            </Tooltip>
          ) : null}
        </span>
      </header>
      {location ? <span className="tm-review-thread__location">{location}</span> : null}
      {about ? <span className="tm-review-comment__about">{about}</span> : null}
      {first ? <CommentBody comment={first} platform={platform} /> : null}
      {replies.length ? (
        <div className="tm-review-thread__replies">
          {/* The replies between the first comment and the latest ones stay on the platform. */}
          {elsewhere > 0 ? <p className="tm-review-thread__earlier">{elsewhere} more {elsewhere === 1 ? 'reply' : 'replies'} on {platform}</p> : null}
          {hiddenReplies ? (
            <button type="button" className="tm-review-thread__more" aria-expanded={false} onClick={() => setRepliesOpen(true)}>
              <DisclosureChevron />{hiddenReplies} more {hiddenReplies === 1 ? 'reply' : 'replies'}
            </button>
          ) : null}
          {shownReplies.map((comment, index) => (
            <div key={`${comment.createdAt ?? ''}:${index}`} className="tm-review-thread__reply">
              <span className="tm-review-thread__reply-head">
                <span className="tm-review-thread__author">{comment.author ?? 'Unknown'}</span>
                <CommentAge comment={comment} />
              </span>
              <CommentBody comment={comment} platform={platform} />
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** A comment's text, clamped when long until asked for in full, as the Overview's request is. */
function CommentBody({ comment, platform }: { comment: PullRequestComment; platform: string }) {
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const textId = useId();
  const text = discussionCommentText(comment.body);
  const overflowing = useClampOverflow(textRef, expanded, text);
  return (
    <div className="tm-review-thread__body">
      <div ref={textRef} id={textId} className={`tm-review-thread__text${expanded ? '' : ' tm-review-thread__text--clamped'}`}>
        <MessageMarkdown text={text} />
      </div>
      {overflowing || expanded ? (
        <button type="button" className="tm-review-thread__more" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show full comment'}
        </button>
      ) : null}
      {comment.truncated ? <p className="tm-review-thread__earlier">Continues on {platform}</p> : null}
    </div>
  );
}

function CommentAge({ comment }: { comment: PullRequestComment | undefined }) {
  const age = comment?.createdAt ? formatShortAge(comment.createdAt) : undefined;
  if (!age || !comment?.createdAt) return null;
  return <time className="tm-review-thread__time" dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>{age}</time>;
}
