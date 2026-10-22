import { useId, useRef, useState, type FormEvent } from 'react';
import { Check, CircleCheck, ExternalLink } from 'lucide-react';
import { remoteProviderName, type RemoteWorkComment } from '../../shared/contracts';
import { commentParts, discussionAuthor, discussionCommentText, discussionSummary, reviewVerdictWords, type DiscussionView, type ReplyDraft } from '../model/pullRequestFeedback';
import { discussionStateWord } from '../model/reviewRounds';
import { formatShortAge } from '../model/timeAgo';
import { Avatar } from './Avatar';
import { DisclosureChevron } from './DisclosureChevron';
import { MessageMarkdown } from './MessageMarkdown';
import { SUBMIT_SHORTCUT, Tooltip } from './Tooltip';
import { useClampOverflow } from './useClampOverflow';

/** Replies shown before the rest fold behind a count. */
const REPLIES_SHOWN = 3;

/** Answering a discussion where it is read: the reply row under it. */
interface DiscussionReply {
  /** What the person typed and did not post. */
  text?: string;
  /** The agent's answer to it, drafted as a reply. */
  draft?: ReplyDraft;
  /** Who replies: the person's account on the platform. */
  viewer?: string;
  onTextChange(text: string | undefined): void;
  /**
   * Posts the reply, resolving the thread when asked; rejects with the
   * platform's reason. A reply that landed while resolving failed says so in
   * what it returns.
   */
  onPost(body: string, resolve: boolean): Promise<string | undefined>;
}

/**
 * A discussion from the pull request where it belongs in the diff: a band of
 * the file under the line it is about, each comment under its author with their
 * mark in the gutter, its state on the platform, and a reply row under the
 * conversation. Add to request puts it in what the agent receives; nothing goes
 * unless added. A resolved thread, or a remark that asks for nothing, folds to
 * one line that opens it.
 */
export function ReviewDiscussionThread({ discussion, location, about, folded: foldedByDefault, focused, inRequest, onFocus, onToggleInclude, reply, onResolve, codeLines }: {
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
  /** Answering it on the platform, while the pull request is open. */
  reply?: DiscussionReply;
  /** Resolves the thread, or reopens it; rejects with the platform's reason. */
  onResolve?(resolved: boolean): Promise<void>;
  /** The code on the thread's side between two lines, when the diff shows them: what a suggestion replaces. */
  codeLines?(start: number, end: number): string[] | undefined;
}) {
  const [opened, setOpened] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  // Folded or open, the thread is one element, so keyboard focus survives it folding when resolved.
  const rootRef = useRef<HTMLElement>(null);
  // A control that goes away when pressed hands the keys to the thread, where N and R work.
  const keepKeys = () => rootRef.current?.focus({ preventScroll: true });
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string>();
  const resolve = async (resolved: boolean) => {
    if (!onResolve || resolving) return;
    setResolving(true);
    setResolveError(undefined);
    try {
      await onResolve(resolved);
      // The check folds away with the thread.
      keepKeys();
    } catch (caught) {
      setResolveError(caught instanceof Error ? caught.message : `Could not ${resolved ? 'resolve' : 'reopen'} the thread.`);
    } finally {
      setResolving(false);
    }
  };
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
      <article ref={rootRef} className="tm-review-thread tm-review-thread--folded tm-review-thread--discussion" data-discussion-id={discussion.id}
        tabIndex={-1} onFocus={onFocus} aria-label={`${platform} comment by ${author}`}>
        <button type="button" className="tm-review-thread__fold" aria-expanded={false} onClick={() => { setOpened(true); keepKeys(); }}>
          <span className="tm-review-thread__author">{author}</span>
          <span className="tm-review-thread__summary">{discussionSummary(discussion)}</span>
        </button>
        {state ?? verdict ? <span>{state ?? verdict}</span> : null}
        {openLink}
      </article>
    );
  }

  const [first, ...replies] = discussion.comments;
  const hiddenReplies = repliesOpen || replies.length <= REPLIES_SHOWN ? 0 : replies.length - 1;
  const shownReplies = hiddenReplies ? replies.slice(-1) : replies;
  // The platform keeps more replies than were read: the first and the latest are here.
  const elsewhere = discussion.commentCount - discussion.comments.length;
  const replaced = suggestionTarget(discussion, codeLines);
  return (
    <article
      ref={rootRef}
      className={`tm-review-thread tm-review-thread--discussion${focused ? ' tm-review-thread--focused' : ''}`}
      data-discussion-id={discussion.id}
      tabIndex={-1}
      onFocus={onFocus}
      aria-label={`${platform} comment by ${author}`}
    >
      <div className="tm-review-thread__comment">
        <Avatar name={first?.author} className="tm-review-thread__avatar" />
        <header className="tm-review-thread__head">
          <span className="tm-review-thread__author">{author}</span>
          {verdict ? <span className="tm-review-thread__round">{verdict}</span> : null}
          <CommentAge comment={first} />
          <span className="tm-review-thread__spacer" />
          {state ? <span className="tm-review-thread__round">{state}</span> : null}
          <span className="tm-review-thread__actions">
            {onToggleInclude && !discussion.resolved ? (
              <Tooltip label={inRequest ? 'Take out of the request' : 'Add to the request'} shortcut="F">
                <button type="button" className="ghost-button tm-review-thread__include" aria-pressed={inRequest} onClick={() => {
                  onToggleInclude(discussion.id);
                  // Out of the request, a thread that starts as one line folds again.
                  if (inRequest && foldedByDefault && !opened) keepKeys();
                }}>
                  {inRequest ? <><Check size={13} aria-hidden="true" />In request</> : 'Add to request'}
                </button>
              </Tooltip>
            ) : null}
            {/* Settling the thread is on its head, as a check: pressed, it is resolved. */}
            {onResolve && discussion.resolvable ? (
              <Tooltip label={discussion.resolved ? 'Reopen thread' : 'Resolve thread'}>
                <button
                  type="button"
                  className="tm-iconbtn tm-review__mini tm-review-thread__resolve-toggle"
                  aria-label="Resolve thread"
                  aria-pressed={discussion.resolved}
                  disabled={resolving}
                  onClick={() => void resolve(!discussion.resolved)}
                >
                  <CircleCheck size={13} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
            {openLink}
            {foldedByDefault && !inRequest ? (
              <Tooltip label="Fold">
                <button type="button" className="tm-iconbtn tm-review__mini tm-review-thread__fold-toggle" aria-expanded={true} aria-label="Fold"
                  onClick={() => { setOpened(false); keepKeys(); }}>
                  <DisclosureChevron />
                </button>
              </Tooltip>
            ) : null}
          </span>
        </header>
        {location ? <span className="tm-review-thread__location">{location}</span> : null}
        {about ? <span className="tm-review-comment__about">{about}</span> : null}
        {first ? <CommentBody comment={first} platform={platform} replaced={replaced} /> : null}
      </div>
      {replies.length ? (
        <div className="tm-review-thread__replies">
          {/* The replies between the first comment and the latest ones stay on the platform. */}
          {elsewhere > 0 ? <p className="tm-review-thread__earlier">{elsewhere} more {elsewhere === 1 ? 'reply' : 'replies'} on {platform}</p> : null}
          {hiddenReplies ? (
            <button type="button" className="tm-review-thread__more" aria-expanded={false} onClick={() => { setRepliesOpen(true); keepKeys(); }}>
              <DisclosureChevron />{hiddenReplies} more {hiddenReplies === 1 ? 'reply' : 'replies'}
            </button>
          ) : null}
          {shownReplies.map((comment, index) => (
            <div key={`${comment.createdAt ?? ''}:${index}`} className="tm-review-thread__comment tm-review-thread__reply">
              <Avatar name={comment.author} className="tm-review-thread__avatar" />
              <span className="tm-review-thread__reply-head">
                <span className="tm-review-thread__author">{comment.author ?? 'Unknown'}</span>
                <CommentAge comment={comment} />
              </span>
              <CommentBody comment={comment} platform={platform} replaced={replaced} />
            </div>
          ))}
        </div>
      ) : null}
      {resolveError ? <p className="form-error tm-review-thread__error" role="alert">{resolveError}</p> : null}
      {/* Answering is the conversation's last row, as on the platform. */}
      {reply && !discussion.resolved ? (
        <ReplyComposer reply={reply} author={author} platform={platform} resolvable={discussion.resolvable && !discussion.resolved}
          onWarning={setResolveError} />
      ) : null}
    </article>
  );
}

/**
 * The reply row under a discussion: the person's mark and a field that grows
 * into the composer when they write. The agent's answer, when it has one, is
 * where the reply starts; resolving is the person's choice beside Reply.
 * Nothing posts until they post it.
 */
function ReplyComposer({ reply, author, platform, resolvable, onWarning }: {
  reply: DiscussionReply;
  author: string;
  platform: string;
  resolvable: boolean;
  /** The reply landed but something after it did not, such as resolving. */
  onWarning(message: string): void;
}) {
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [text, setText] = useState(reply.text ?? '');
  const [resolve, setResolve] = useState(false);
  const [focused, setFocused] = useState(false);
  // The agent's answer starts the reply once, the first time the person opens it.
  const [started, setStarted] = useState(Boolean(reply.text));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const open = focused || busy || Boolean(text);
  const write = (value: string) => {
    setText(value);
    reply.onTextChange(value || undefined);
  };
  // Leaving the row hands the keys back to the thread, where R returns to it.
  const leave = () => formRef.current?.closest<HTMLElement>('[data-discussion-id]')?.focus({ preventScroll: true });
  const cancel = () => {
    write('');
    setResolve(false);
    setError(undefined);
    leave();
  };
  const post = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const warning = await reply.onPost(text.trim(), resolvable && resolve);
      write('');
      setResolve(false);
      leave();
      if (warning) onWarning(warning);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not post the reply on ${platform}.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      ref={formRef}
      className={`tm-review-thread__reply-row${open ? ' tm-review-thread__reply-row--open' : ''}`}
      onSubmit={(event) => void post(event)}
      onFocus={() => {
        setFocused(true);
        if (started) return;
        setStarted(true);
        if (!text && reply.draft) {
          // The agent's answer is only in the field: what is kept for the task is what the person typed.
          setText(reply.draft.body);
          setResolve(resolvable && reply.draft.outcome === 'FIXED');
        }
      }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    >
      <Avatar name={reply.viewer} className="tm-review-thread__avatar" />
      <label className="tm-visually-hidden" htmlFor={inputId}>Reply to {author}</label>
      <textarea
        id={inputId}
        className="tm-review-thread__reply-input"
        rows={1}
        value={text}
        disabled={busy}
        placeholder="Reply"
        onChange={(event) => write(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); if (text) leave(); else cancel(); }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void post(); }
        }}
      />
      {open ? (
        <div className="tm-review-thread__reply-tools">
          {resolvable ? (
            <label className="tm-resolve-check">
              {/* The row is a form, where Enter on the check would post the reply; only ⌘↵ posts, as in the field. */}
              <input type="checkbox" checked={resolve} disabled={busy} onChange={(event) => setResolve(event.target.checked)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  if (event.metaKey || event.ctrlKey) void post();
                }} />
              <span>Resolve thread</span>
            </label>
          ) : null}
          <span className="tm-review-comment-composer__spacer" />
          <button type="button" className="ghost-button button--sm" disabled={busy} onClick={cancel}>Cancel</button>
          <Tooltip label={`Reply on ${platform}`} shortcut={SUBMIT_SHORTCUT}>
            <button type="submit" className="primary-button button--sm" disabled={busy || !text.trim()}>{busy ? 'Posting…' : 'Reply'}</button>
          </Tooltip>
        </div>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </form>
  );
}

/** The lines a thread's suggestion replaces, by how far it reaches above and below the thread's own. */
function suggestionTarget(
  discussion: Pick<DiscussionView, 'line' | 'endLine' | 'outdated'>,
  codeLines: ((start: number, end: number) => string[] | undefined) | undefined
): ((above: number, below: number) => string[] | undefined) | undefined {
  if (!codeLines || !discussion.line || discussion.outdated) return undefined;
  const start = discussion.line;
  const end = discussion.endLine && discussion.endLine > start ? discussion.endLine : start;
  return (above, below) => codeLines(start - above, end + below);
}

/** A comment's text, clamped when long until asked for in full, as the Overview's request is. */
function CommentBody({ comment, platform, replaced }: {
  comment: RemoteWorkComment;
  platform: string;
  /** The lines a suggestion in it replaces, when the diff shows them. */
  replaced?(above: number, below: number): string[] | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const textId = useId();
  const text = discussionCommentText(comment.body);
  const overflowing = useClampOverflow(textRef, expanded, text);
  return (
    <div className="tm-review-thread__body">
      <div ref={textRef} id={textId} className={`tm-review-thread__text${expanded ? '' : ' tm-review-thread__text--clamped'}`}>
        {commentParts(text).map((part, index) => part.kind === 'text'
          ? <MessageMarkdown key={index} text={part.text} />
          : <SuggestedChange key={index} lines={part.lines} replaced={replaced?.(part.above, part.below)} />)}
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

/**
 * A suggested change as a diff: the lines it replaces, when the diff shows
 * them, then the lines it suggests. An empty suggestion removes the lines.
 */
function SuggestedChange({ lines, replaced }: { lines: readonly string[]; replaced?: readonly string[] }) {
  return (
    <figure className="tm-suggestion">
      <figcaption className="tm-suggestion__label">Suggested change</figcaption>
      <div className="tm-suggestion__lines">
        {replaced?.map((line, index) => (
          <div key={`removed:${index}`} className="tm-suggestion__line tm-suggestion__line--removed">
            <span aria-hidden="true">−</span>
            <code><span className="tm-visually-hidden">Removed: </span>{line || ' '}</code>
          </div>
        ))}
        {lines.map((line, index) => (
          <div key={`added:${index}`} className="tm-suggestion__line tm-suggestion__line--added">
            <span aria-hidden="true">+</span>
            <code><span className="tm-visually-hidden">Added: </span>{line || ' '}</code>
          </div>
        ))}
      </div>
    </figure>
  );
}

function CommentAge({ comment }: { comment: RemoteWorkComment | undefined }) {
  const age = comment?.createdAt ? formatShortAge(comment.createdAt) : undefined;
  if (!age || !comment?.createdAt) return null;
  return <time className="tm-review-thread__time" dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>{age}</time>;
}
