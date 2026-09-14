import { useEffect, useRef, useState } from 'react';
import type {
  ConversationContextReferenceSnapshot,
  DiscourseConversationAggregateRecord,
  DiscourseMessageRecord
} from '../../shared/discourse';
import { messageAuthorLabel } from '../model/discourse';
import { DiscourseActionMenu } from './DiscourseActionMenu';
import {
  DiscourseCheckIcon,
  DiscourseCopyIcon,
  DiscourseMoreIcon,
  DiscoursePinIcon,
  DiscourseReplyIcon,
  DiscourseRepositoryIcon,
  DiscourseTaskIcon
} from './DiscourseIcons';
import { MessageMarkdown } from './MessageMarkdown';
import { DiscourseHistoryContent } from './DiscourseHistoryContent';
import { MessageHeader } from './MessageHeader';
import { messageModelName } from '../model/messageIdentity';
import type { AgentModel } from '../../shared/contracts';

export function DiscourseMessage({
  message,
  replyTarget,
  context,
  job,
  relatedJobs = [],
  sourceMessages = [],
  onNavigate,
  onReply,
  onCorrect,
  onDelete,
  onAskAuthor,
  onAskOthers,
  selectedAsSource,
  peerName = 'peer',
  peerRequestName,
  models,
  onToggleSource
}: {
  message: DiscourseMessageRecord;
  replyTarget?: DiscourseMessageRecord;
  context: ConversationContextReferenceSnapshot[];
  job?: DiscourseConversationAggregateRecord['jobs'][number];
  relatedJobs?: DiscourseConversationAggregateRecord['jobs'];
  sourceMessages?: DiscourseMessageRecord[];
  onNavigate(messageId: string): void;
  onReply(): void;
  onCorrect(): void;
  onDelete(): void;
  onAskAuthor(): void;
  onAskOthers(): void;
  selectedAsSource: boolean;
  peerName?: string;
  peerRequestName?: string;
  models?: readonly AgentModel[];
  onToggleSource(): void;
}) {
  const user = message.author.kind === 'USER';
  const authorName = messageModelName(job?.assignment.model, messageAuthorLabel(message), models, job?.assignment.runtimeId);
  const replyJob = relatedJobs.find((candidate) => candidate.id === replyTarget?.jobId);
  const peer = job?.role === 'ANSWER' && job.assignment.assignmentRole === 'REVIEWER';
  const team = job?.result?.kind === 'CONTRIBUTION' ? job.result.team : undefined;
  const comparisonOutdated = team?.kind === 'COMPARISON' && relatedJobs.some((candidate) =>
    candidate.result?.kind === 'CONTRIBUTION' && (candidate.waveId === job!.waveId
      ? candidate.phase > job!.phase : candidate.role === 'COMPARE' && candidate.targetMessageIds.includes(message.id)));
  const sourceComparison = relatedJobs.find((candidate) => candidate.result?.kind === 'CONTRIBUTION' &&
    job?.targetMessageIds.includes(candidate.result.outputMessageId))?.result;
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
  const actions = message.status !== 'TOMBSTONE' ? (
          <footer>
            <button
              type="button"
              className="tm-discourse-message-action"
              aria-label="Reply"
              title="Reply"
              onClick={onReply}
            >
              <DiscourseReplyIcon />
            </button>
            <button
              type="button"
              className="tm-discourse-message-action"
              aria-label={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
              title={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
              onClick={() => void copyMessage()}
            >
              {copyState === 'copied' ? <DiscourseCheckIcon /> : <DiscourseCopyIcon />}
            </button>
            <span className="tm-visually-hidden" role="status" aria-live="polite">
              {copyState === 'copied' ? 'Message copied' : copyState === 'failed' ? 'Message could not be copied' : ''}
            </span>
            {!user && message.author.kind === 'AGENT' && message.status === 'VISIBLE' ? (
              <button type="button" className="tm-discourse-message-action tm-discourse-message-peer" onClick={onAskOthers}>Ask {peerName}</button>
            ) : null}
            <DiscourseActionMenu
              className="tm-discourse-message-menu"
              label={`More actions for ${authorName}`}
              trigger={<DiscourseMoreIcon />}
              items={[
                ...(!user && message.author.kind === 'AGENT'
                  ? [
                      { label: 'Ask this agent', onSelect: onAskAuthor }
                    ]
                  : []),
                {
                  label: selectedAsSource ? 'Remove from selection' : 'Use as context',
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
        ) : null;
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
      } ${peer ? 'tm-discourse-message--peer' : ''}`}
    >
      <article>
        {peerRequestName && message.status !== 'TOMBSTONE' ? <details className="tm-discourse-peer-request">
          <summary><DiscourseReplyIcon /><span>You asked <strong>{peerRequestName}</strong> to check this answer</span><time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time></summary>
          <p>{message.body}</p>
          {replyTarget ? <button type="button" className="ghost-button" onClick={() => onNavigate(replyTarget.id)}>View checked answer</button> : null}
          {actions}
        </details> : <>
        <MessageHeader author={authorName} model={job?.assignment.model} time={message.createdAt}>
          {team ? <span className="tm-discourse-message__state">{team.kind === 'COMPARISON' ? 'Comparison' : 'Response'}</span> : null}
          {message.status === 'SUPERSEDED' ? (
            <span className="tm-discourse-message__state">Corrected</span>
          ) : null}
        </MessageHeader>
        {replyTarget ? (
          <button
            type="button"
            className="tm-discourse-reply-reference"
            onClick={() => onNavigate(replyTarget.id)}
          >
            <span>
              <DiscourseReplyIcon />
              {messageModelName(replyJob?.assignment.model, messageAuthorLabel(replyTarget), models, replyJob?.assignment.runtimeId)}
            </span>
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
        {comparisonOutdated ? <p className="tm-discourse-message__updated-note">Updated below</p> : null}
        <div className="tm-discourse-message__content">{message.status === 'TOMBSTONE' ? (
          <p className="tm-discourse-message__tombstone">Message deleted</p>
        ) : team ? (
          <DiscourseHistoryContent result={team} sources={sourceMessages} onNavigate={onNavigate}
            comparison={sourceComparison?.kind === 'CONTRIBUTION' && sourceComparison.team?.kind === 'COMPARISON' ? sourceComparison.team : undefined} />
        ) : message.author.kind === 'AGENT' ? (
          <MessageMarkdown text={message.body} />
        ) : (
          <p className="tm-discourse-message__body">{message.body}</p>
        )}</div>
        </>}
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
        {!peerRequestName ? actions : null}
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
