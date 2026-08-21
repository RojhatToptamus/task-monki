import { useRef, useState, type KeyboardEvent } from 'react';
import type {
  AgentInteractionDecision,
  DesignConversationEntry,
  InteractionRequestRecord
} from '../../shared/contracts';
import {
  designActivityRows,
  designTurnView,
  formatDesignUpdatedAt,
  type DesignProjectDetail
} from '../model/designs';
import { DiscourseMarkdown } from './DiscourseMarkdown';
import { InteractionPanel } from './InteractionPanel';
import { RunActivityTimeline } from './RunActivityTimeline';

export interface DesignConversationProps {
  project: DesignProjectDetail;
  onSubmit(message: string): Promise<void>;
  onRespond(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
}

export function DesignConversation({
  project,
  onSubmit,
  onRespond
}: DesignConversationProps) {
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submittingRef = useRef(false);
  const activityRows = designActivityRows(project);
  const canSubmit = project.actions.canRefine && message.trim().length > 0 && !submitting;
  const disabledReason = project.actions.canRefine
    ? undefined
    : (project.actions.refineDisabledReason ?? 'Wait for the current update to finish.');

  const submit = async () => {
    const nextMessage = message.trim();
    if (!nextMessage || !project.actions.canRefine || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(nextMessage);
      setMessage('');
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not send the refinement.'
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  };

  return (
    <section className="tm-design-conversation" aria-labelledby="design-conversation-title">
      <header className="tm-design-conversation__head">
        <div>
          <h2 id="design-conversation-title">Conversation</h2>
          <span>Codex · Restricted workspace</span>
        </div>
      </header>

      <div className="tm-design-conversation__transcript" aria-live="polite">
        {project.conversation.length === 0 ? (
          <div className="tm-design-conversation__empty">
            <ConversationGlyph />
            <strong>Your brief will start the conversation</strong>
            <span>Describe what you want to see. Codex will build the first preview.</span>
          </div>
        ) : (
          project.conversation.map((entry) => (
            <DesignTurnMessages key={entry.turn.id} entry={entry} />
          ))
        )}

        {activityRows.length > 0 ? (
          <RunActivityTimeline rows={activityRows} />
        ) : null}

        <InteractionPanel
          interactions={[...project.interactions]}
          sessions={[...project.sessions]}
          onRespond={onRespond}
        />
      </div>

      <form
        className="tm-design-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="tm-visually-hidden" htmlFor="design-refinement-message">
          Refine this Design
        </label>
        <textarea
          id="design-refinement-message"
          value={message}
          rows={3}
          placeholder="Describe the next change…"
          disabled={!project.actions.canRefine || submitting}
          aria-describedby={disabledReason ? 'design-refinement-help' : undefined}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onComposerKeyDown}
        />
        <div className="tm-design-composer__footer">
          <span id="design-refinement-help">
            {disabledReason ?? 'Press ⌘ Enter to send'}
          </span>
          <button type="submit" className="primary-button" disabled={!canSubmit}>
            {submitting ? 'Sending…' : 'Send'}
          </button>
        </div>
        {error ? <p className="tm-design-composer__error" role="alert">{error}</p> : null}
      </form>
    </section>
  );
}

function DesignTurnMessages({ entry }: { entry: DesignConversationEntry }) {
  const view = designTurnView(entry);
  return (
    <article className="tm-design-turn">
      <div className="tm-design-message tm-design-message--user">
        <header>
          <strong>You</strong>
          <time dateTime={entry.turn.createdAt}>
            {formatDesignUpdatedAt(entry.turn.createdAt)}
          </time>
        </header>
        <p>{entry.userMessage}</p>
      </div>

      <div className={`tm-design-message tm-design-message--agent tm-design-message--${view.status.toLowerCase()}`}>
        <header>
          <strong>Codex</strong>
          <span className="tm-design-message__turn-status">
            <i aria-hidden="true" />
            {view.statusLabel}
          </span>
        </header>
        {entry.assistantMessage ? (
          <DiscourseMarkdown text={entry.assistantMessage} />
        ) : (
          <p className="tm-design-message__pending">
            {view.detail ?? view.statusLabel}
          </p>
        )}
        {view.detail && entry.assistantMessage ? (
          <p className="tm-design-message__detail">{view.detail}</p>
        ) : null}
      </div>
    </article>
  );
}

function ConversationGlyph() {
  return (
    <span className="tm-design-conversation__glyph" aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <path d="M5 6.5h18v12H12l-5 4v-4H5z" />
        <path d="M9 11h10M9 14h7" />
      </svg>
    </span>
  );
}
