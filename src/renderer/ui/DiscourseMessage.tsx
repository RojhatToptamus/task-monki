import { useEffect, useRef, useState } from 'react';
import type {
  ConversationContextReferenceSnapshot,
  DiscourseConversationAggregateRecord,
  DiscourseMessageRecord
} from '../../shared/discourse';
import { messageAuthorLabel } from '../model/discourse';
import { DiscourseActionMenu } from './DiscourseActionMenu';
import {
  DiscoursePinIcon,
  DiscourseRepositoryIcon,
  DiscourseTaskIcon
} from './DiscourseIcons';
import { DiscourseMarkdown } from './DiscourseMarkdown';

export function DiscourseMessage({
  message,
  replyTarget,
  context,
  job,
  onNavigate,
  onReply,
  onCorrect,
  onDelete,
  onAskAuthor,
  onAskOthers,
  selectedAsSource,
  onToggleSource
}: {
  message: DiscourseMessageRecord;
  replyTarget?: DiscourseMessageRecord;
  context: ConversationContextReferenceSnapshot[];
  job?: DiscourseConversationAggregateRecord['jobs'][number];
  onNavigate(messageId: string): void;
  onReply(): void;
  onCorrect(): void;
  onDelete(): void;
  onAskAuthor(): void;
  onAskOthers(): void;
  selectedAsSource: boolean;
  onToggleSource(): void;
}) {
  const user = message.author.kind === 'USER';
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
  }, []);
  const copyMessage = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(message.body);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1_200);
  };
  return (
    <li
      tabIndex={-1}
      id={`discourse-message-${message.id}`}
      className={`tm-discourse-message tm-discourse-message--${
        message.author.kind.toLowerCase()
      } ${
        message.status !== 'VISIBLE'
          ? `tm-discourse-message--${message.status.toLowerCase()}`
          : ''
      }`}
    >
      <div className="tm-discourse-message__rail">
        <span>
          {user
            ? 'Y'
            : message.author.kind === 'AGENT'
              ? message.author.displayNameSnapshot.slice(0, 1)
              : 'M'}
        </span>
      </div>
      <article>
        <header>
          <strong>{messageAuthorLabel(message)}</strong>
          <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
          {message.status === 'SUPERSEDED' ? (
            <span className="tm-discourse-message__state">Corrected</span>
          ) : null}
          {job ? (
            <span className="tm-discourse-message__state">
              {job.assignment.model} ·{' '}
              {job.freshnessAtCompletion === 'FRESH'
                ? 'context fresh'
                : job.freshnessAtCompletion === 'CHANGED_DURING_JOB'
                  ? 'context changed'
                  : 'freshness unknown'}
            </span>
          ) : null}
        </header>
        {replyTarget ? (
          <button
            type="button"
            className="tm-discourse-reply-reference"
            onClick={() => onNavigate(replyTarget.id)}
          >
            <span>↳ {messageAuthorLabel(replyTarget)}</span>
            {replyTarget.status === 'TOMBSTONE'
              ? 'Deleted message'
              : compactText(replyTarget.body, 90)}
          </button>
        ) : null}
        {job?.freshnessAtCompletion === 'CHANGED_DURING_JOB' ? (
          <p className="tm-discourse-message__stale-note">
            Context changed while this response was running. It is preserved for history, not accepted as current evidence.
          </p>
        ) : null}
        {message.status === 'TOMBSTONE' ? (
          <p className="tm-discourse-message__tombstone">Message deleted</p>
        ) : message.author.kind === 'AGENT' ? (
          <DiscourseMarkdown text={message.body} />
        ) : (
          <p className="tm-discourse-message__body">{message.body}</p>
        )}
        {context.length > 0 ? (
          <div className="tm-discourse-message__context" aria-label="Message context">
            {context.map((reference) => (
              <span key={`${reference.scope}:${reference.contextLinkId}`}>
                {reference.scope === 'PINNED'
                  ? <DiscoursePinIcon />
                  : reference.entityKind === 'TASK'
                    ? <DiscourseTaskIcon />
                    : <DiscourseRepositoryIcon />}
                {reference.labelSnapshot}
              </span>
            ))}
          </div>
        ) : null}
        {message.status !== 'TOMBSTONE' ? (
          <footer>
            <button type="button" onClick={onReply}>Reply</button>
            <button type="button" onClick={() => void copyMessage()}>
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            </button>
            <DiscourseActionMenu
              className="tm-discourse-message-menu"
              label={`More actions for ${messageAuthorLabel(message)}`}
              trigger="More"
              items={[
                ...(!user && message.author.kind === 'AGENT'
                  ? [
                      { label: 'Ask this agent', onSelect: onAskAuthor },
                      { label: 'Ask other agents', onSelect: onAskOthers }
                    ]
                  : []),
                {
                  label: selectedAsSource ? 'Remove from selection' : 'Select for synthesis',
                  pressed: selectedAsSource,
                  onSelect: onToggleSource
                },
                ...(user && message.status === 'VISIBLE'
                  ? [{ label: 'Correct message', onSelect: onCorrect }]
                  : []),
                ...(user
                  ? [{ label: 'Delete message', danger: true, onSelect: onDelete }]
                  : [])
              ]}
            />
          </footer>
        ) : null}
      </article>
    </li>
  );
}

function compactText(value: string, limit: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}
