import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type {
  AgentModel,
  AgentInteractionDecision,
  AttachmentContent,
  AttachmentDescriptor,
  AttachmentDraftSnapshot,
  ClipboardAttachmentImage,
  DesignConversationEntry,
  DesignDraftRecord,
  InteractionRequestRecord,
  StageTaskAttachmentBatchRequest
} from '../../shared/contracts';
import {
  designActivityRows,
  designDetailedActivityRows,
  designTurnView,
  type DesignProjectDetail
} from '../model/designs';
import { ActivityRows, ActivitySteps } from './ActivitySteps';
import { Conversation, useConversationScroll } from './Conversation';
import { Message, MessageContent, MessageMeta, MessageTime } from './Message';
import { MessageMarkdown } from './MessageMarkdown';
import { MessageQueue } from './MessageQueue';
import { InteractionPanel } from './InteractionPanel';
import { AttachmentComposerShell } from './AttachmentComposerShell';
import { StoredAttachmentChip } from './AttachmentChip';
import { useTaskAttachments } from './useTaskAttachments';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { creationRequiresUnchangedRetry } from '../model/taskAttachmentComposer';
import { DesignReadyMenu } from './DesignActionsMenu';
import { DisclosureChevron } from './DisclosureChevron';
import { ArrowUp, CornerDownRight, RotateCcw, Square } from 'lucide-react';
import { StatusGlyph } from './StatusBadge';

export interface DesignConversationProps {
  project: DesignProjectDetail;
  draft: DesignDraftRecord | null;
  model?: AgentModel;
  refineUnavailableReason?: string;
  selectedReferenceIds: string[];
  onSelectionChange(referenceIds: string[]): void;
  onSubmit(
    message: string,
    referenceIds: string[],
    attachmentDraftId?: string
  ): Promise<void>;
  onStageAttachmentBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscardAttachmentDraft(draftId: string): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  onReadDraftAttachment(attachmentId: string): Promise<AttachmentContent>;
  onReadAttachment?(attachmentId: string): Promise<AttachmentContent>;
  onPreviewOpenChange?(open: boolean): void;
  onStop(turnId: string): Promise<void>;
  onLoadEarlier(): Promise<void>;
  onSaveDraft(
    body: string,
    referenceIds: string[],
    attachmentDraftId: string | undefined,
    expectedRevision: number
  ): Promise<DesignDraftRecord>;
  onDeleteDraft(expectedRevision: number): Promise<void>;
  onRespond(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
  onRestore(revisionId: string): Promise<void>;
  onDuplicate(revisionId: string): Promise<void>;
  onOpenReferences(): void;
}

export function DesignConversation({
  project,
  draft,
  model,
  refineUnavailableReason,
  selectedReferenceIds,
  onSelectionChange,
  onSubmit,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onReadDraftAttachment,
  onReadAttachment,
  onPreviewOpenChange,
  onStop,
  onLoadEarlier,
  onSaveDraft,
  onDeleteDraft,
  onRespond,
  onRestore,
  onDuplicate,
  onOpenReferences
}: DesignConversationProps) {
  const [message, setMessage] = useState(draft?.body ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [submissionOutcomeUnknown, setSubmissionOutcomeUnknown] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [removingQueuedTurn, setRemovingQueuedTurn] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();
  const submittingRef = useRef(false);
  const focusAfterSubmit = useRef(false);
  const draftRevisionRef = useRef(draft?.recordRevision ?? 0);
  const savedDraftSignatureRef = useRef(
    draftSignature(
      draft?.body ?? '',
      draft?.referenceIds ?? [],
      draft?.attachmentDraftId
    )
  );
  const messageRef = useRef(message);
  const referenceIdsRef = useRef(selectedReferenceIds);
  referenceIdsRef.current = selectedReferenceIds;
  const draftTimerRef = useRef<number | undefined>(undefined);
  const draftTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const mountedRef = useRef(true);
  const suppressDraftSaveRef = useRef(false);
  const saveDraftRef = useRef(onSaveDraft);
  saveDraftRef.current = onSaveDraft;
  const canRefine = project.actions.canRefine && !refineUnavailableReason;
  const attachments = useTaskAttachments({
    enabled: true,
    blocked: submitting || submissionOutcomeUnknown || !canRefine,
    model,
    onStageBatch: onStageAttachmentBatch,
    onDiscard: onDiscardAttachmentDraft,
    onReadClipboardImage,
    initialDraft: draft?.attachmentDraft,
    onReadDraftAttachment,
    preserveDraftOnClose: true
  });
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const activityRows = designActivityRows(project);
  const detailedActivityRows = designDetailedActivityRows(project);
  const scroller = useConversationScroll({ startAtBottom: true });
  const prepend = useRef<{ height: number; top: number } | undefined>(undefined);
  const pending = project.conversation.filter((entry) => !entry.turn.runId && entry.turn.outcome === undefined);
  const conversation = project.conversation.filter((entry) => entry.turn.runId || (entry.turn.outcome !== undefined && entry.turn.outcome !== 'CANCELED'));
  const referenceNames = (ids: string[]) => ids.map((id) => {
    const reference = project.references.find((candidate) => candidate.id === id);
    return project.attachments.find((attachment) => attachment.id === reference?.attachmentId)?.displayName ?? 'Unavailable reference';
  });
  const canSubmit =
    canRefine &&
    message.trim().length > 0 &&
    !submitting &&
    !attachments.busy &&
    !attachments.hasErrors &&
    !attachments.modelError;
  const disabledReason = refineUnavailableReason ??
    (project.actions.canRefine ? undefined : project.actions.refineDisabledReason);
  const activeWork = Boolean(
    project.currentRun &&
      ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING', 'RECOVERY_REQUIRED'].includes(
        project.currentRun.status
      )
  );
  const selectedReferences = selectedReferenceIds.flatMap((referenceId) => {
    const reference = project.references.find((candidate) => candidate.id === referenceId);
    const attachment = reference
      ? project.attachments.find(
          (candidate) => candidate.id === reference.attachmentId
        )
      : undefined;
    return reference && attachment ? [{ referenceId, attachment }] : [];
  });

  const persistDraft = useCallback(
    (body: string, referenceIds: readonly string[]) => {
      const operation = draftTailRef.current
        .catch(() => undefined)
        .then(async () => {
          const attachmentDraftId = await attachmentsRef.current.prepareForCreate();
          const signature = draftSignature(body, referenceIds, attachmentDraftId);
          if (signature === savedDraftSignatureRef.current) return;
          if (mountedRef.current) setDraftStatus('saving');
          const saved = await saveDraftRef.current(
            body,
            [...referenceIds],
            attachmentDraftId,
            draftRevisionRef.current
          );
          draftRevisionRef.current = saved.recordRevision;
          savedDraftSignatureRef.current = draftSignature(
            saved.body,
            saved.referenceIds,
            saved.attachmentDraftId
          );
          await attachmentsRef.current.acknowledgeDraftSave(saved.attachmentDraftId);
          if (
            mountedRef.current &&
            draftSignature(
              messageRef.current,
              referenceIdsRef.current,
              saved.attachmentDraftId
            ) === savedDraftSignatureRef.current
          ) {
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

  const scheduleDraftSave = (body: string, referenceIds = referenceIdsRef.current) => {
    if (draftTimerRef.current !== undefined) {
      window.clearTimeout(draftTimerRef.current);
    }
    setDraftStatus('idle');
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = undefined;
      void persistDraft(body, referenceIds).catch(() => undefined);
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
      void persistDraft(messageRef.current, referenceIdsRef.current).catch(() => undefined);
    };
  }, [persistDraft]);

  useEffect(() => {
    if (suppressDraftSaveRef.current) return;
    scheduleDraftSave(messageRef.current, selectedReferenceIds);
  }, [attachments.contentRevision, selectedReferenceIds.join('\u0000')]);

  const submit = async () => {
    const nextMessage = message.trim();
    if (!nextMessage || !canRefine || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      if (draftTimerRef.current !== undefined) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
      }
      await persistDraft(nextMessage, selectedReferenceIds);
      const attachmentDraftId = await attachments.prepareForCreate();
      await onSubmit(nextMessage, selectedReferenceIds, attachmentDraftId);
      suppressDraftSaveRef.current = true;
      await attachments.finishAdoption();
      setMessage('');
      messageRef.current = '';
      onSelectionChange([]);
      savedDraftSignatureRef.current = draftSignature('', [], undefined);
      setSubmissionOutcomeUnknown(false);
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
      suppressDraftSaveRef.current = false;
    } catch (caught) {
      suppressDraftSaveRef.current = false;
      const unchangedRetry = creationRequiresUnchangedRetry(caught);
      await attachments.markCreateFailed(unchangedRetry);
      if (unchangedRetry) setSubmissionOutcomeUnknown(true);
      setError(
        unchangedRetry
          ? `Message delivery could not be confirmed. Retry unchanged to recover safely. ${
              caught instanceof Error ? caught.message : 'Could not send the refinement.'
            }`
          : caught instanceof Error
            ? caught.message
            : 'Could not send the refinement.'
      );
    } finally {
      submittingRef.current = false;
      focusAfterSubmit.current = true;
      setSubmitting(false);
    }
  };

  useLayoutEffect(() => {
    if (!submitting && focusAfterSubmit.current) {
      focusAfterSubmit.current = false;
      composerRef.current?.focus();
    }
  }, [submitting]);

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  };

  useLayoutEffect(() => {
    const viewport = scroller.scrollRef.current;
    if (prepend.current && viewport) {
      viewport.scrollTop = prepend.current.top + viewport.scrollHeight - prepend.current.height;
      prepend.current = undefined;
    }
  }, [project.conversation.length]);

  return (
    <section className="tm-design-conversation" aria-label="Design conversation">
      <Conversation instance={scroller} label="Design conversation" className="tm-design-conversation__log">
      <div className="tm-design-conversation__transcript" aria-live="polite">
        {project.origin && project.conversation.length === 0 ? (
          <p className="tm-design-conversation__origin">
            Copied from {project.origin.designTitle ?? 'an earlier Design'}
            {project.origin.revisionOrdinal
              ? ` · Ready state ${project.origin.revisionOrdinal}`
              : ''}
          </p>
        ) : null}
        {project.previousConversationCursor ? (
          <button
            type="button"
            className="tm-design-conversation__earlier"
            disabled={loadingEarlier}
            onClick={() => {
              const viewport = scroller.scrollRef.current;
              if (viewport) prepend.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
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
        {conversation.length === 0 && pending.length === 0 ? (
          <div className="tm-design-conversation__empty">
            <strong>
              {project.origin && project.revisions.length === 0 && project.design.status === 'NEEDS_ATTENTION'
                ? 'This copy could not start'
                : project.origin
                  ? 'Continue from this ready copy'
                  : 'Your brief will start the conversation'}
            </strong>
            <span>
              {project.origin && project.revisions.length === 0 && project.design.status === 'NEEDS_ATTENTION'
                ? 'Delete this copy and duplicate the earlier Ready state again.'
                : project.origin
                  ? 'Describe the next change. This Design has its own conversation and files.'
                  : 'Describe what you want to see. The Design agent will build the first preview.'}
            </span>
          </div>
        ) : (
          conversation.map((entry) => (
            <DesignTurnMessages
              key={entry.turn.id}
              entry={entry}
              latestRevisionId={project.revisions.at(-1)?.id}
              canRestore={project.actions.canRestore}
              canDuplicate={project.actions.canDuplicate}
              onRestore={(revisionId) =>
                void onRestore(revisionId).catch((caught) =>
                  setError(caught instanceof Error ? caught.message : 'Could not restore this version.')
                )
              }
              onDuplicate={(revisionId) =>
                void onDuplicate(revisionId).catch((caught) =>
                  setError(caught instanceof Error ? caught.message : 'Could not duplicate this version.')
                )
              }
              references={entry.turn.referenceIds.map((id) => {
                const reference = project.references.find((candidate) => candidate.id === id);
                return project.attachments.find((attachment) => attachment.id === reference?.attachmentId);
              })}
              onReadAttachment={onReadAttachment}
              onPreviewOpenChange={onPreviewOpenChange}
            />
          ))
        )}

        {activityRows.length > 0 ? (
          <ActivitySteps steps={activityRows.map((row) => ({ key: row.key, at: row.at, kind: 'tool' as const, row }))} />
        ) : null}

        {detailedActivityRows.length > 0 ? (
          <details className="tm-design-technical-details">
            <summary><DisclosureChevron /><span>Technical details</span></summary>
            <ActivityRows rows={detailedActivityRows} />
          </details>
        ) : null}

        <InteractionPanel
          interactions={[...project.interactions]}
          sessions={[...project.sessions]}
          offerAgentDecision
          onRespond={onRespond}
        />
      </div>
      </Conversation>

      <form
        className="tm-design-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <AttachmentComposerShell
          attachments={attachments}
          onPreviewOpenChange={onPreviewOpenChange}
          attachmentLabel="Files for this Design message"
          className="tm-design-composer__shell"
          removeDisabled={submitting || submissionOutcomeUnknown}
          addButtonTitle="Add read-only references to this Design message."
          addButtonLabel="Reference"
          onAddButtonClick={onOpenReferences}
          toolbarAction={
            <>
              {project.actions.canStop && project.actions.stopTurnId ? (
                <button
                  type="button"
                  className="ghost-button tm-composer-action"
                  aria-label={stopping ? 'Stopping' : 'Stop'} title="Stop response"
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
                  {stopping ? <StatusGlyph kind="working" /> : <Square size={14} strokeWidth={1.5} aria-hidden="true" />}
                </button>
              ) : null}
              <button type="submit" className="primary-button tm-composer-action" disabled={!canSubmit}
                aria-label={submitting ? 'Sending…' : submissionOutcomeUnknown ? 'Retry' : activeWork ? 'Queue' : 'Send'}
                title={submissionOutcomeUnknown ? 'Retry sending' : activeWork ? 'Queue after response · ⌘/Ctrl Enter' : 'Send · ⌘/Ctrl Enter'}>
                {submitting ? <StatusGlyph kind="working" /> : submissionOutcomeUnknown ? <RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />
                  : activeWork ? <CornerDownRight size={16} strokeWidth={1.5} aria-hidden="true" /> : <ArrowUp size={16} strokeWidth={1.5} aria-hidden="true" />}
              </button>
            </>
          }
          hint={<span id="design-refinement-help">{
            attachments.isRestoringDraft
              ? 'Loading draft files…'
              : attachments.isReadingClipboardImage
                ? 'Reading clipboard image…'
                : attachments.activeItems.length > 0
                  ? `${attachments.activeItems.length} ${
                      attachments.activeItems.length === 1 ? 'new file' : 'new files'
                    } · ${formatAttachmentBytes(attachments.byteCount)}`
                  : disabledReason ?? (draftStatus === 'saving' ? 'Saving draft…' : draftStatus === 'error' ? 'Draft not saved' : '⌘ Enter')
          }</span>}
        >
          <MessageQueue items={pending.map((entry) => ({ id: entry.turn.id, text: entry.userMessage,
            detail: referenceNames(entry.turn.referenceIds).join(', ') || undefined }))}
            disabled={removingQueuedTurn || submitting || submissionOutcomeUnknown || stopping}
            onRemove={(id) => {
              setRemovingQueuedTurn(true); setError(undefined);
              void onStop(id)
                .then(() => composerRef.current?.focus())
                .catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not remove the queued message.'))
                .finally(() => setRemovingQueuedTurn(false));
            }} />
          <label className="tm-visually-hidden" htmlFor="design-refinement-message">
            Refine this Design
          </label>
          <textarea
            ref={composerRef}
            id="design-refinement-message"
            value={message}
            rows={3}
            placeholder={activeWork ? 'Queue a message for after this response' : 'Describe the next change…'}
            disabled={
              !canRefine ||
              submitting ||
              submissionOutcomeUnknown ||
              attachments.isRestoringDraft
            }
            aria-describedby={disabledReason ? 'design-refinement-help' : undefined}
            onChange={(event) => {
              const body = event.target.value;
              setMessage(body);
              messageRef.current = body;
              scheduleDraftSave(body);
            }}
            onPaste={attachments.paste}
            onKeyDown={onComposerKeyDown}
          />
          {selectedReferences.length > 0 ? (
            <ul className="task-attachments" aria-label="Selected existing references">
              {selectedReferences.map(({ referenceId, attachment }) => (
                <StoredAttachmentChip
                  key={referenceId}
                  attachment={attachment}
                  label="Reference"
                  onPreviewOpenChange={onPreviewOpenChange}
                  onRead={onReadAttachment ? () => onReadAttachment(attachment.id) : undefined}
                  disabled={submitting || submissionOutcomeUnknown}
                  onRemove={() =>
                    onSelectionChange(
                      selectedReferenceIds.filter((candidate) => candidate !== referenceId)
                    )
                  }
                />
              ))}
            </ul>
          ) : null}
        </AttachmentComposerShell>
        {attachments.overflowError || attachments.modelError ? (
          <p className="task-attachment-message task-attachment-message--error" role="alert">
            {attachments.overflowError ?? attachments.modelError}
          </p>
        ) : null}
        {error ? <p className="tm-design-composer__error" role="alert">{error}</p> : null}
      </form>
    </section>
  );
}

function DesignTurnMessages({
  entry,
  references,
  onReadAttachment,
  onPreviewOpenChange,
  latestRevisionId,
  canRestore,
  canDuplicate,
  onRestore,
  onDuplicate
}: {
  entry: DesignConversationEntry;
  references: (AttachmentDescriptor | undefined)[];
  onReadAttachment?(attachmentId: string): Promise<AttachmentContent>;
  onPreviewOpenChange?(open: boolean): void;
  latestRevisionId?: string;
  canRestore: boolean;
  canDuplicate: boolean;
  onRestore(revisionId: string): void;
  onDuplicate(revisionId: string): void;
}) {
  const view = designTurnView(entry);
  return (
    <article className="tm-design-turn">
      <Message from="user" label="Your message">
        <MessageContent><p>{entry.userMessage}</p></MessageContent>
        {references.length > 0 ? <ul className="task-attachments" aria-label="Message references">
          {references.map((attachment, index) => attachment ? <StoredAttachmentChip
            key={attachment.id} attachment={attachment}
            onRead={onReadAttachment ? () => onReadAttachment(attachment.id) : undefined}
            onPreviewOpenChange={onPreviewOpenChange}
          /> : <li key={index}>Unavailable reference</li>)}
        </ul> : null}
        <MessageMeta>
          <MessageTime value={entry.turn.createdAt} />
        </MessageMeta>
      </Message>

      <Message from="agent" label="Design agent" className={`tm-design-message--${view.status.toLowerCase()}`}>
        {entry.assistantMessage ? (
          <MessageContent><MessageMarkdown text={entry.assistantMessage} /></MessageContent>
        ) : null}
        {view.detail ? (
          <p className="tm-design-message__detail">{view.detail}</p>
        ) : null}
        <MessageMeta className="tm-design-message__ready-actions">
          <span className="tm-design-message__turn-status" data-tone={view.tone}>
            {entry.readyRevision ? `Ready state ${entry.readyRevision.ordinal}` : view.statusLabel}
          </span>
          {entry.readyRevision ? (
            <DesignReadyMenu
              ordinal={entry.readyRevision.ordinal}
              isCurrent={entry.readyRevision.id === latestRevisionId}
              canRestore={canRestore}
              canDuplicate={canDuplicate}
              onRestore={() => onRestore(entry.readyRevision!.id)}
              onDuplicate={() => onDuplicate(entry.readyRevision!.id)}
            />
          ) : null}
        </MessageMeta>
      </Message>
    </article>
  );
}

function draftSignature(
  body: string,
  referenceIds: readonly string[],
  attachmentDraftId: string | undefined
): string {
  return JSON.stringify([body, referenceIds, attachmentDraftId ?? null]);
}
