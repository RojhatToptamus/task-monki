import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type {
  AgentModel,
  AgentInteractionDecision,
  AttachmentContent,
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
  formatDesignUpdatedAt,
  type DesignProjectDetail
} from '../model/designs';
import { DiscourseMarkdown } from './DiscourseMarkdown';
import { InteractionPanel } from './InteractionPanel';
import { RunActivityTimeline } from './RunActivityTimeline';
import { AttachmentComposerShell } from './AttachmentComposerShell';
import { StoredAttachmentChip } from './AttachmentChip';
import { useTaskAttachments } from './useTaskAttachments';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { creationRequiresUnchangedRetry } from '../model/taskAttachmentComposer';
import { DesignReadyMenu } from './DesignActionsMenu';
import { DisclosureChevron } from './DisclosureChevron';
import { UiArrowRightIcon } from './UiIcons';

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
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();
  const submittingRef = useRef(false);
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
      setSubmitting(false);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  };

  return (
    <section className="tm-design-conversation" aria-label="Design conversation">
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
          project.conversation.map((entry) => (
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
              references={entry.turn.referenceIds.map((referenceId) => {
                const reference = project.references.find(
                  (candidate) => candidate.id === referenceId
                );
                const attachment = reference
                  ? project.attachments.find(
                      (candidate) => candidate.id === reference.attachmentId
                    )
                  : undefined;
                return attachment?.displayName ?? 'Unavailable reference';
              })}
            />
          ))
        )}

        {activityRows.length > 0 ? (
          <RunActivityTimeline rows={activityRows} />
        ) : null}

        {detailedActivityRows.length > 0 ? (
          <details className="tm-design-technical-details">
            <summary><DisclosureChevron /><span>Technical details</span></summary>
            <RunActivityTimeline rows={detailedActivityRows} live={false} />
          </details>
        ) : null}

        <InteractionPanel
          interactions={[...project.interactions]}
          sessions={[...project.sessions]}
          offerAgentDecision
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
        <AttachmentComposerShell
          attachments={attachments}
          attachmentLabel="Files for this Design message"
          className="tm-design-composer__shell"
          removeDisabled={submitting || submissionOutcomeUnknown}
          addButtonTitle="Add read-only references to this Design message."
          addButtonLabel="Reference"
          onAddButtonClick={onOpenReferences}
          hint={
            attachments.isRestoringDraft
              ? 'Loading draft files…'
              : attachments.isReadingClipboardImage
                ? 'Reading clipboard image…'
                : attachments.activeItems.length > 0
                  ? `${attachments.activeItems.length} ${
                      attachments.activeItems.length === 1 ? 'new file' : 'new files'
                    } · ${formatAttachmentBytes(attachments.byteCount)}`
                  : 'Paste or drop files'
          }
        >
          <label className="tm-visually-hidden" htmlFor="design-refinement-message">
            Refine this Design
          </label>
          <textarea
            id="design-refinement-message"
            value={message}
            rows={3}
            placeholder="Describe the next change…"
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
            {submitting
              ? 'Sending…'
              : submissionOutcomeUnknown
                ? 'Retry'
                : activeWork
                  ? 'Queue'
                  : 'Send'}
            <UiArrowRightIcon />
          </button>
        </div>
        {error ? <p className="tm-design-composer__error" role="alert">{error}</p> : null}
      </form>
    </section>
  );
}

function DesignTurnMessages({
  entry,
  references,
  latestRevisionId,
  canRestore,
  canDuplicate,
  onRestore,
  onDuplicate
}: {
  entry: DesignConversationEntry;
  references: string[];
  latestRevisionId?: string;
  canRestore: boolean;
  canDuplicate: boolean;
  onRestore(revisionId: string): void;
  onDuplicate(revisionId: string): void;
}) {
  const view = designTurnView(entry);
  return (
    <article className="tm-design-turn">
      <div className="tm-design-message tm-design-message--user">
        <p>{entry.userMessage}</p>
        <footer>
          {references.length > 0 ? (
            <small className="tm-design-message__references">
              {references.join(', ')}
            </small>
          ) : null}
          <time dateTime={entry.turn.createdAt}>
            {formatDesignUpdatedAt(entry.turn.createdAt)}
          </time>
        </footer>
      </div>

      <div className={`tm-design-message tm-design-message--agent tm-design-message--${view.status.toLowerCase()}`}>
        <header>
          <strong>Design agent</strong>
          <div className="tm-design-message__ready-actions">
            <span className="tm-design-message__turn-status" data-tone={view.tone}>
              {entry.readyRevision
                ? `Ready state ${entry.readyRevision.ordinal}`
                : view.statusLabel}
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
          </div>
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

function draftSignature(
  body: string,
  referenceIds: readonly string[],
  attachmentDraftId: string | undefined
): string {
  return JSON.stringify([body, referenceIds, attachmentDraftId ?? null]);
}
