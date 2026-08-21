import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type {
  AgentInteractionDecision,
  DesignConversationEntry,
  DesignDraftRecord,
  InteractionRequestRecord
} from '../../shared/contracts';
import {
  designActivityRows,
  designDetailedActivityRows,
  designTurnView,
  formatDesignUpdatedAt,
  type DesignProjectDetail
} from '../model/designs';
import { DiscourseMarkdown } from './DiscourseMarkdown';
import { InteractionPanel } from './InteractionPanel';
import { RunActivityTimeline } from './RunActivityTimeline';

export interface DesignConversationProps {
  project: DesignProjectDetail;
  draft: DesignDraftRecord | null;
  onSubmit(message: string): Promise<void>;
  onStop(turnId: string): Promise<void>;
  onLoadEarlier(): Promise<void>;
  onSaveDraft(body: string, expectedRevision: number): Promise<DesignDraftRecord>;
  onDeleteDraft(expectedRevision: number): Promise<void>;
  onRespond(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
}

export function DesignConversation({
  project,
  draft,
  onSubmit,
  onStop,
  onLoadEarlier,
  onSaveDraft,
  onDeleteDraft,
  onRespond
}: DesignConversationProps) {
  const [message, setMessage] = useState(draft?.body ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();
  const submittingRef = useRef(false);
  const draftRevisionRef = useRef(draft?.recordRevision ?? 0);
  const savedDraftBodyRef = useRef(draft?.body ?? '');
  const messageRef = useRef(message);
  const draftTimerRef = useRef<number | undefined>(undefined);
  const draftTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const mountedRef = useRef(true);
  const saveDraftRef = useRef(onSaveDraft);
  saveDraftRef.current = onSaveDraft;
  const activityRows = designActivityRows(project);
  const detailedActivityRows = designDetailedActivityRows(project);
  const canSubmit = project.actions.canRefine && message.trim().length > 0 && !submitting;
  const disabledReason = project.actions.canRefine
    ? undefined
    : project.actions.refineDisabledReason;
  const activeWork = Boolean(
    project.currentRun &&
      ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING', 'RECOVERY_REQUIRED'].includes(
        project.currentRun.status
      )
  );

  const persistDraft = useCallback(
    (body: string) => {
      if (body === savedDraftBodyRef.current) return Promise.resolve();
      const operation = draftTailRef.current
        .catch(() => undefined)
        .then(async () => {
          if (body === savedDraftBodyRef.current) return;
          if (mountedRef.current) setDraftStatus('saving');
          const saved = await saveDraftRef.current(body, draftRevisionRef.current);
          draftRevisionRef.current = saved.recordRevision;
          savedDraftBodyRef.current = saved.body;
          if (mountedRef.current && messageRef.current === saved.body) {
            setDraftStatus('saved');
          }
        });
      draftTailRef.current = operation.catch(() => undefined);
      return operation.catch((caught) => {
        if (mountedRef.current) setDraftStatus('error');
        throw caught;
      });
    },
    []
  );

  const scheduleDraftSave = (body: string) => {
    if (draftTimerRef.current !== undefined) {
      window.clearTimeout(draftTimerRef.current);
    }
    setDraftStatus('idle');
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = undefined;
      void persistDraft(body).catch(() => undefined);
    }, 600);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (draftTimerRef.current !== undefined) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
      }
      void persistDraft(messageRef.current).catch(() => undefined);
    };
  }, [persistDraft]);

  const submit = async () => {
    const nextMessage = message.trim();
    if (!nextMessage || !project.actions.canRefine || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      if (draftTimerRef.current !== undefined) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
      }
      await persistDraft(nextMessage).catch(() => undefined);
      await onSubmit(nextMessage);
      setMessage('');
      messageRef.current = '';
      savedDraftBodyRef.current = '';
      const revision = draftRevisionRef.current;
      if (revision > 0) {
        try {
          await onDeleteDraft(revision);
          draftRevisionRef.current = 0;
          if (mountedRef.current) setDraftStatus('idle');
        } catch {
          if (mountedRef.current) {
            setDraftStatus('error');
            setError('The message was sent, but its saved draft could not be cleared.');
          }
        }
      }
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
          <span>
            Codex
            {project.task.agentSettings?.model
              ? ` · ${project.task.agentSettings.model}`
              : ''}
            {project.task.agentSettings?.reasoningEffort
              ? ` · ${project.task.agentSettings.reasoningEffort}`
              : ''}
          </span>
        </div>
      </header>

      <div className="tm-design-conversation__transcript" aria-live="polite">
        {project.previousConversationCursor ? (
          <button
            type="button"
            className="tm-design-conversation__earlier"
            disabled={loadingEarlier}
            onClick={() => {
              setLoadingEarlier(true);
              setError(undefined);
              void onLoadEarlier()
                .catch((caught) => {
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : 'Could not load earlier messages.'
                  );
                })
                .finally(() => setLoadingEarlier(false));
            }}
          >
            {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
          </button>
        ) : null}
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

        {detailedActivityRows.length > 0 ? (
          <details className="tm-design-technical-details">
            <summary>Technical details</summary>
            <RunActivityTimeline rows={detailedActivityRows} live={false} />
          </details>
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
          onChange={(event) => {
            const body = event.target.value;
            setMessage(body);
            messageRef.current = body;
            scheduleDraftSave(body);
          }}
          onKeyDown={onComposerKeyDown}
        />
        <div className="tm-design-composer__footer">
          <span id="design-refinement-help">
            {disabledReason ??
              (draftStatus === 'saving'
                ? 'Saving draft…'
                : draftStatus === 'saved'
                  ? 'Draft saved'
                  : draftStatus === 'error'
                    ? 'Draft not saved'
                    : project.actions.queuedTurnCount > 0
                      ? `${project.actions.queuedTurnCount} queued`
                      : 'Press ⌘ Enter to send')}
          </span>
          {project.actions.canStop && project.actions.stopTurnId ? (
            <button
              type="button"
              className="outline-button"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                setError(undefined);
                void onStop(project.actions.stopTurnId!)
                  .catch((caught) => {
                    setError(caught instanceof Error ? caught.message : 'Could not stop work.');
                  })
                  .finally(() => setStopping(false));
              }}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : null}
          <button type="submit" className="primary-button" disabled={!canSubmit}>
            {submitting ? 'Sending…' : activeWork ? 'Queue' : 'Send'}
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
