import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent
} from 'react';
import type {
  AgentInteractionDecision,
  AgentExecutionSettings,
  AgentModel,
  AgentRuntimeState,
  CreateBlankDesignRequest,
  DesignDraftRecord,
  InteractionRequestRecord
} from '../../shared/contracts';
import {
  type AttachmentDraftSnapshot,
  type AttachmentContent,
  type ClipboardAttachmentImage,
  type DiscardTaskAttachmentDraftRequest,
  type StageTaskAttachmentBatchRequest
} from '../../shared/attachments';
import {
  designProjectStatus,
  designStatusView,
  designWorkspaceIsCompact,
  formatDesignUpdatedAt,
  sortedDesignProjects,
  type DesignProjectDetail,
  type DesignProjectSummary,
  type DesignProjectStatus
} from '../model/designs';
import { AccessibleTab } from './AccessibleTabs';
import {
  DesignCanvas,
  type DesignCanvasHideRequest,
  type DesignCanvasRefreshRequest,
  type DesignCanvasShowRequest
} from './DesignCanvas';
import { DesignConversation } from './DesignConversation';
import { DesignFilesDrawer } from './DesignFilesDrawer';
import { AttachmentComposerShell } from './AttachmentComposerShell';
import { useDialogFocusBoundary } from './dialogFocus';
import { AgentModelSelector } from './AgentModelSelector';
import { resolveReasoningEffort, selectModel } from '../model/agentExecutionSettings';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { creationRequiresUnchangedRetry } from '../model/taskAttachmentComposer';
import { useTaskAttachments } from './useTaskAttachments';

export type CreateBlankDesignInput = Pick<
  CreateBlankDesignRequest,
  'brief' | 'creationToken' | 'model' | 'reasoningEffort' | 'attachmentDraftId'
>;

export interface DesignsWorkspaceProps {
  designs: readonly DesignProjectSummary[];
  selectedDesignId?: string;
  project?: DesignProjectDetail;
  draft?: DesignDraftRecord | null;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  defaultAgentSettings?: AgentExecutionSettings;
  loading?: boolean;
  error?: string;
  desktopCanvasAvailable: boolean;
  canvasOccluded?: boolean;
  onSelectDesign(designId: string): void;
  onCreateBlankDesign(input: CreateBlankDesignInput): Promise<void>;
  onSubmitRefinement(
    designId: string,
    message: string,
    referenceIds: string[],
    attachmentDraftId?: string
  ): Promise<void>;
  onStageAttachmentBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscardAttachmentDraft(input: DiscardTaskAttachmentDraftRequest): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  onReadDesignDraftAttachment(
    designId: string,
    attachmentId: string
  ): Promise<AttachmentContent>;
  onAddReferences(designId: string, attachmentDraftId: string): Promise<string[]>;
  onRemoveReference(designId: string, referenceId: string): Promise<void>;
  onImportReferenceAsset(designId: string, referenceId: string): Promise<void>;
  onStopTurn(designId: string, turnId: string): Promise<void>;
  onLoadEarlier(designId: string): Promise<void>;
  onSaveDraft(
    designId: string,
    body: string,
    referenceIds: string[],
    attachmentDraftId: string | undefined,
    expectedRevision: number
  ): Promise<DesignDraftRecord>;
  onDeleteDraft(designId: string, expectedRevision: number): Promise<void>;
  onDiscoverAgentRuntimeModels?(runtimeId: string): Promise<void>;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
  onRefreshCanvas(request: DesignCanvasRefreshRequest): Promise<void>;
  onRestartCanvas(designId: string): Promise<void>;
  onDeleteDesign(designId: string): Promise<void>;
  onShowCanvas?(request: DesignCanvasShowRequest): void;
  onHideCanvas?(request: DesignCanvasHideRequest): void;
  onRetryLoad?(): void;
}

type CompactPane = 'conversation' | 'canvas';

export function DesignsWorkspace({
  designs,
  selectedDesignId,
  project,
  draft = null,
  models,
  runtimes,
  defaultAgentSettings,
  loading = false,
  error,
  desktopCanvasAvailable,
  canvasOccluded = false,
  onSelectDesign,
  onCreateBlankDesign,
  onSubmitRefinement,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onReadDesignDraftAttachment,
  onAddReferences,
  onRemoveReference,
  onImportReferenceAsset,
  onStopTurn,
  onLoadEarlier,
  onSaveDraft,
  onDeleteDraft,
  onDiscoverAgentRuntimeModels,
  onRespondToInteraction,
  onRefreshCanvas,
  onRestartCanvas,
  onDeleteDesign,
  onShowCanvas,
  onHideCanvas,
  onRetryLoad
}: DesignsWorkspaceProps) {
  const workspaceRef = useRef<HTMLElement>(null);
  const [creatingBlank, setCreatingBlank] = useState(false);
  const [compact, setCompact] = useState(false);
  const [compactPane, setCompactPane] = useState<CompactPane>('conversation');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const referenceDesignId = useRef<string | undefined>(undefined);
  const restoredDraftRevision = useRef<number | undefined>(undefined);
  const sortedDesigns = sortedDesignProjects(designs);
  const activeDesignId = project?.design.id ?? selectedDesignId;

  useEffect(() => {
    if (!project) {
      setSelectedReferenceIds([]);
      referenceDesignId.current = undefined;
      restoredDraftRevision.current = undefined;
      return;
    }
    const activeSet = new Set(project.references
      .filter((reference) => reference.state === 'ACTIVE')
      .map((reference) => reference.id));
    if (referenceDesignId.current !== project.design.id) {
      referenceDesignId.current = project.design.id;
      restoredDraftRevision.current = draft?.recordRevision;
      setSelectedReferenceIds(
        (draft?.referenceIds ?? []).filter((referenceId) => activeSet.has(referenceId))
      );
      setFilesOpen(false);
      return;
    }
    if (draft && restoredDraftRevision.current !== draft.recordRevision) {
      restoredDraftRevision.current = draft.recordRevision;
      setSelectedReferenceIds(
        draft.referenceIds.filter((referenceId) => activeSet.has(referenceId))
      );
      return;
    }
    setSelectedReferenceIds((current) =>
      current.filter((referenceId) => activeSet.has(referenceId))
    );
  }, [draft, project?.design.id, project?.references]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const update = () => {
      setCompact(designWorkspaceIsCompact(workspace.getBoundingClientRect().width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const showCreate =
    creatingBlank || (!loading && !error && designs.length === 0 && !project);

  return (
    <main
      ref={workspaceRef}
      className={`tm-designs ${compact ? 'tm-designs--compact' : ''}`}
      aria-label="Designs workspace"
    >
      <aside className="tm-designs-rail" aria-label="Designs">
        <header className="tm-designs-rail__head">
          <div>
            <h1>Designs</h1>
            <p>Build and refine working previews.</p>
          </div>
          <button
            type="button"
            className="tm-designs-rail__new"
            onClick={() => setCreatingBlank(true)}
          >
            <PlusIcon />
            <span>New</span>
          </button>
        </header>

        <nav className="tm-designs-rail__list" aria-label="Recent Designs">
          {sortedDesigns.length === 0 ? (
            <p className="tm-designs-rail__empty">No Designs yet</p>
          ) : (
            sortedDesigns.map((design) => {
              const displayStatus: DesignProjectStatus =
                project?.design.id === design.id ? designProjectStatus(project) : design.status;
              const status = designStatusView(displayStatus);
              const selected = !showCreate && activeDesignId === design.id;
              return (
                <button
                  type="button"
                  className={`tm-designs-rail__item ${selected ? 'tm-designs-rail__item--active' : ''}`}
                  aria-current={selected ? 'page' : undefined}
                  key={design.id}
                  onClick={() => {
                    setCreatingBlank(false);
                    onSelectDesign(design.id);
                  }}
                >
                  <span className="tm-designs-rail__item-title">{design.title}</span>
                  <span className="tm-designs-rail__item-meta">
                    <i data-tone={status.tone} aria-hidden="true" />
                    {status.label}
                    <time dateTime={design.updatedAt}>
                      {formatDesignUpdatedAt(design.updatedAt)}
                    </time>
                  </span>
                </button>
              );
            })
          )}
        </nav>
      </aside>

      <section className="tm-designs-main">
        {showCreate ? (
          <BlankDesignForm
            canCancel={designs.length > 0}
            models={models}
            runtimes={runtimes}
            defaultAgentSettings={defaultAgentSettings}
            onDiscoverAgentRuntimeModels={onDiscoverAgentRuntimeModels}
            onStageAttachmentBatch={onStageAttachmentBatch}
            onDiscardAttachmentDraft={onDiscardAttachmentDraft}
            onReadClipboardImage={onReadClipboardImage}
            onCancel={() => setCreatingBlank(false)}
            onCreate={async (input) => {
              await onCreateBlankDesign(input);
              setCreatingBlank(false);
            }}
          />
        ) : error ? (
          <WorkspaceState
            title="Could not load this Design"
            detail={error}
            action={onRetryLoad ? { label: 'Try again', onClick: onRetryLoad } : undefined}
          />
        ) : loading || !project ? (
          <WorkspaceState
            title={loading ? 'Loading Design' : 'Select a Design'}
            detail={
              loading
                ? 'Task Monki is loading the conversation and canvas.'
                : 'Choose a Design from the list or create a blank Design.'
            }
            busy={loading}
          />
        ) : (
          <>
            <DesignHeader
              project={project}
              filesOpen={filesOpen}
              onToggleFiles={() => setFilesOpen((open) => !open)}
              onDelete={() => setDeleteOpen(true)}
            />
            {compact ? (
              <div className="tm-designs-tabs tm-tabs" role="tablist" aria-label="Design view">
                <AccessibleTab
                  id="design-conversation-tab"
                  panelId="design-conversation-panel"
                  label="Conversation"
                  selected={compactPane === 'conversation'}
                  onSelect={() => setCompactPane('conversation')}
                />
                <AccessibleTab
                  id="design-canvas-tab"
                  panelId="design-canvas-panel"
                  label="Canvas"
                  selected={compactPane === 'canvas'}
                  onSelect={() => setCompactPane('canvas')}
                />
              </div>
            ) : null}
            <div className="tm-designs-split">
              {!compact || compactPane === 'conversation' ? (
                <div
                  className="tm-designs-split__conversation"
                  id="design-conversation-panel"
                  role={compact ? 'tabpanel' : undefined}
                  aria-labelledby={compact ? 'design-conversation-tab' : undefined}
                >
                  <DesignConversation
                    key={project.design.id}
                    project={project}
                    draft={draft}
                    model={models.find(
                      (model) =>
                        model.runtimeId === project.task.runtimeId &&
                        model.model === project.task.agentSettings.model
                    )}
                    selectedReferenceIds={selectedReferenceIds}
                    onSelectionChange={setSelectedReferenceIds}
                    onSubmit={(message, referenceIds, attachmentDraftId) =>
                      onSubmitRefinement(
                        project.design.id,
                        message,
                        referenceIds,
                        attachmentDraftId
                      )
                    }
                    onStageAttachmentBatch={onStageAttachmentBatch}
                    onDiscardAttachmentDraft={(draftId) =>
                      onDiscardAttachmentDraft({ draftId })
                    }
                    onReadClipboardImage={onReadClipboardImage}
                    onReadDraftAttachment={(attachmentId) =>
                      onReadDesignDraftAttachment(project.design.id, attachmentId)
                    }
                    onStop={(turnId) => onStopTurn(project.design.id, turnId)}
                    onLoadEarlier={() => onLoadEarlier(project.design.id)}
                    onSaveDraft={(body, referenceIds, attachmentDraftId, expectedRevision) =>
                      onSaveDraft(
                        project.design.id,
                        body,
                        referenceIds,
                        attachmentDraftId,
                        expectedRevision
                      )
                    }
                    onDeleteDraft={(expectedRevision) =>
                      onDeleteDraft(project.design.id, expectedRevision)
                    }
                    onRespond={onRespondToInteraction}
                  />
                </div>
              ) : null}
              {!compact || compactPane === 'canvas' ? (
                <div
                  className="tm-designs-split__canvas"
                  id="design-canvas-panel"
                  role={compact ? 'tabpanel' : undefined}
                  aria-labelledby={compact ? 'design-canvas-tab' : undefined}
                >
                  <DesignCanvas
                    project={project}
                    desktopAvailable={desktopCanvasAvailable}
                    occluded={canvasOccluded || deleteOpen || filesOpen}
                    onShowCanvas={onShowCanvas}
                    onHideCanvas={onHideCanvas}
                    onRefresh={onRefreshCanvas}
                    onRestart={onRestartCanvas}
                  />
                </div>
              ) : null}
            </div>
            {filesOpen ? (
              <DesignFilesDrawer
                project={project}
                models={models}
                selectedReferenceIds={selectedReferenceIds}
                onSelectionChange={setSelectedReferenceIds}
                onClose={() => setFilesOpen(false)}
                onStageAttachmentBatch={onStageAttachmentBatch}
                onDiscardAttachmentDraft={onDiscardAttachmentDraft}
                onReadClipboardImage={onReadClipboardImage}
                onAddReferences={async (draftId) => {
                  const referenceIds = await onAddReferences(project.design.id, draftId);
                  setSelectedReferenceIds((current) => [
                    ...current,
                    ...referenceIds.filter((referenceId) => !current.includes(referenceId))
                  ]);
                }}
                onRemoveReference={(referenceId) =>
                  onRemoveReference(project.design.id, referenceId)
                }
                onImportReferenceAsset={(referenceId) =>
                  onImportReferenceAsset(project.design.id, referenceId)
                }
              />
            ) : null}
          </>
        )}
      </section>

      {deleteOpen && project ? (
        <DeleteDesignDialog
          designTitle={project.design.title}
          onCancel={() => setDeleteOpen(false)}
          onDelete={async () => {
            await onDeleteDesign(project.design.id);
            setDeleteOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

function DesignHeader({
  project,
  filesOpen,
  onToggleFiles,
  onDelete
}: {
  project: DesignProjectDetail;
  filesOpen: boolean;
  onToggleFiles(): void;
  onDelete(): void;
}) {
  const status = designStatusView(designProjectStatus(project));
  return (
    <header className="tm-designs-header">
      <div className="tm-designs-header__identity">
        <h1>{project.design.title}</h1>
        <p>{project.canvas.detail ?? status.detail}</p>
      </div>
      <div className="tm-designs-header__actions">
        <span className="tm-design-status" data-tone={status.tone}>
          <i aria-hidden="true" />
          {status.label}
        </span>
        <button
          type="button"
          className="tm-designs-header__files"
          aria-expanded={filesOpen}
          aria-controls="design-files-drawer"
          onClick={onToggleFiles}
        >
          <FilesIcon />
          Files
          <span>{project.references.filter((reference) => reference.state === 'ACTIVE').length}</span>
        </button>
        <button
          type="button"
          className="tm-designs-header__delete"
          disabled={!project.actions.canDelete}
          title={
            project.actions.canDelete
              ? 'Delete Design'
              : project.actions.deleteDisabledReason
          }
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </header>
  );
}

function BlankDesignForm({
  canCancel,
  models,
  runtimes,
  defaultAgentSettings,
  onDiscoverAgentRuntimeModels,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onCancel,
  onCreate
}: {
  canCancel: boolean;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  defaultAgentSettings?: AgentExecutionSettings;
  onDiscoverAgentRuntimeModels?(runtimeId: string): Promise<void>;
  onStageAttachmentBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscardAttachmentDraft(input: DiscardTaskAttachmentDraftRequest): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  onCancel(): void;
  onCreate(input: CreateBlankDesignInput): Promise<void>;
}) {
  const [brief, setBrief] = useState('');
  const [creationToken] = useState(() => crypto.randomUUID());
  const initialRuntimeId =
    defaultAgentSettings?.runtimeId ?? runtimes[0]?.preflight.runtime.id ?? '';
  const initialModel = selectModel(
    models,
    defaultAgentSettings?.model,
    initialRuntimeId
  );
  const [runtimeId, setRuntimeId] = useState(initialRuntimeId);
  const [modelId, setModelId] = useState(initialModel?.id ?? '');
  const [reasoningEffort, setReasoningEffort] = useState(
    resolveReasoningEffort(initialModel, defaultAgentSettings?.reasoningEffort) ?? ''
  );
  const [submitting, setSubmitting] = useState(false);
  const [creationOutcomeUnknown, setCreationOutcomeUnknown] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submittingRef = useRef(false);
  const availableRuntimeIds = new Set(
    runtimes.map((runtime) => runtime.preflight.runtime.id)
  );
  const selectedRuntimeId = availableRuntimeIds.has(runtimeId)
    ? runtimeId
    : defaultAgentSettings?.runtimeId &&
        availableRuntimeIds.has(defaultAgentSettings.runtimeId)
      ? defaultAgentSettings.runtimeId
      : runtimes[0]?.preflight.runtime.id ?? '';
  const selectedModel =
    models.find(
      (model) => model.id === modelId && model.runtimeId === selectedRuntimeId
    ) ?? selectModel(models, defaultAgentSettings?.model, selectedRuntimeId);
  const selectedModelId = selectedModel?.id ?? '';
  const selectedReasoningEffort =
    resolveReasoningEffort(
      selectedModel,
      reasoningEffort || defaultAgentSettings?.reasoningEffort
    ) ?? '';
  const selectedRuntime = runtimes.find(
    (runtime) => runtime.preflight.runtime.id === selectedRuntimeId
  );
  const attachmentsEnabled = Boolean(
    selectedRuntime &&
      selectedRuntime.preflight.capabilities.attachmentDelivery.maturity !== 'unsupported'
  );
  const composerLocked = submitting || creationOutcomeUnknown;
  const attachments = useTaskAttachments({
    enabled: attachmentsEnabled,
    blocked: composerLocked,
    model: selectedModel,
    onStageBatch: onStageAttachmentBatch,
    onDiscard: (draftId) => onDiscardAttachmentDraft({ draftId }),
    onReadClipboardImage
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextBrief = brief.trim();
    if (!nextBrief || !selectedRuntimeId || !selectedModel || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    let unchangedRetry = false;
    try {
      const attachmentDraftId = await attachments.prepareForCreate();
      try {
        await onCreate({
          brief: nextBrief,
          creationToken,
          model: selectedModel.model,
          reasoningEffort: selectedReasoningEffort || undefined,
          ...(attachmentDraftId ? { attachmentDraftId } : {})
        });
      } catch (caught) {
        unchangedRetry = creationRequiresUnchangedRetry(caught);
        await attachments.markCreateFailed(unchangedRetry);
        if (unchangedRetry) setCreationOutcomeUnknown(true);
        throw caught;
      }
      await attachments.finishAdoption();
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'Could not create the Design.';
      setError(
        unchangedRetry
          ? `Design creation could not be confirmed. Retry unchanged to recover safely${
              canCancel ? ', or close and check the Design list' : ''
            }. ${detail}`
          : detail
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="tm-design-create">
      <form
        className="tm-design-create__form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="tm-design-create__intro">
          <span className="tm-design-create__mark" aria-hidden="true">
            <DesignMark />
          </span>
          <h1>New blank Design</h1>
          <p>Describe the page or interface that you want Codex to build.</p>
        </div>

        <label htmlFor="new-design-brief">Brief</label>
        <AttachmentComposerShell
          attachments={attachments}
          className="tm-design-create__composer"
          attachmentLabel="Design references"
          removeDisabled={composerLocked}
          addButtonTitle={
            attachmentsEnabled
              ? 'Stored locally and shared read-only with the Design agent.'
              : 'The selected agent runtime does not support references.'
          }
          hint={
            !attachmentsEnabled
              ? 'Unavailable for this runtime'
              : attachments.isReadingClipboardImage
                ? 'Reading clipboard image…'
                : attachments.activeItems.length > 0
                  ? `${attachments.activeItems.length} ${
                      attachments.activeItems.length === 1 ? 'file' : 'files'
                    } · ${formatAttachmentBytes(attachments.byteCount)}`
                  : 'Paste or drop files'
          }
        >
          <textarea
            id="new-design-brief"
            value={brief}
            rows={7}
            placeholder="A focused landing page for…"
            disabled={composerLocked}
            autoFocus
            onChange={(event) => setBrief(event.target.value)}
            onPaste={attachments.paste}
          />
        </AttachmentComposerShell>

        {attachments.overflowError || attachments.modelError ? (
          <p className="task-attachment-message task-attachment-message--error" role="alert">
            {attachments.overflowError ?? attachments.modelError}
          </p>
        ) : null}

        <div className="tm-design-create__runtime" aria-label="Design agent settings">
          <AgentModelSelector
            label="Design"
            runtimeId={selectedRuntimeId}
            modelId={selectedModelId}
            reasoningEffort={selectedReasoningEffort}
            models={models}
            runtimes={runtimes}
            disabled={composerLocked}
            compact
            selectionUnavailable={!selectedRuntimeId || !selectedModelId}
            selectionUnavailableMessage="No ready agent supports Design Mode."
            onDiscoverModels={onDiscoverAgentRuntimeModels}
            onSelectionChange={(nextRuntimeId, nextModelId) => {
              setRuntimeId(nextRuntimeId);
              setModelId(nextModelId);
              const nextModel = models.find(
                (model) =>
                  model.runtimeId === nextRuntimeId && model.id === nextModelId
              );
              setReasoningEffort(nextModel?.defaultReasoningEffort ?? '');
            }}
            onReasoningEffortChange={setReasoningEffort}
          />
        </div>

        {error ? <p className="tm-design-create__error" role="alert">{error}</p> : null}
        <div className="tm-design-create__actions">
          {canCancel ? (
            <button type="button" className="outline-button" disabled={submitting} onClick={onCancel}>
              {creationOutcomeUnknown ? 'Close' : 'Cancel'}
            </button>
          ) : null}
          <button
            type="submit"
            className="primary-button"
            disabled={
              submitting ||
              brief.trim().length === 0 ||
              !selectedRuntimeId ||
              !selectedModelId ||
              attachments.busy ||
              attachments.hasErrors ||
              Boolean(attachments.modelError)
            }
          >
            {submitting
              ? 'Creating…'
              : creationOutcomeUnknown
                ? 'Retry creation'
                : 'Create Design'}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteDesignDialog({
  designTitle,
  onCancel,
  onDelete
}: {
  designTitle: string;
  onCancel(): void;
  onDelete(): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useDialogFocusBoundary({
    dialogRef,
    initialFocusRef: cancelRef,
    busy: deleting,
    onClose: onCancel
  });

  const remove = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setError(undefined);
    try {
      await onDelete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the Design.');
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      className="tm-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-design-title"
      tabIndex={-1}
    >
      <button
        type="button"
        className="tm-modal__scrim"
        aria-label="Cancel Design deletion"
        disabled={deleting}
        onClick={onCancel}
      />
      <div className="tm-modal__panel tm-design-delete">
        <h3 id="delete-design-title">Delete “{designTitle}”?</h3>
        <p>Task Monki removes the Design. It removes the managed workspace when that action is safe.</p>
        {error ? <p className="tm-design-delete__error" role="alert">{error}</p> : null}
        <div className="tm-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="outline-button"
            disabled={deleting}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="danger-button" disabled={deleting} onClick={() => void remove()}>
            {deleting ? 'Deleting…' : 'Delete Design'}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceState({
  title,
  detail,
  busy = false,
  action
}: {
  title: string;
  detail: string;
  busy?: boolean;
  action?: { label: string; onClick(): void };
}) {
  return (
    <div className="tm-designs-state" role={busy ? 'status' : undefined}>
      <span className={`tm-designs-state__mark ${busy ? 'tm-designs-state__mark--busy' : ''}`} aria-hidden="true">
        <DesignMark />
      </span>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action ? (
        <button type="button" className="outline-button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4.5h4l1.2 1.4h5.8v6.6h-11z" />
      <path d="M2.5 4.5v-1h4.2l1 1" />
    </svg>
  );
}

function DesignMark() {
  return (
    <svg viewBox="0 0 28 28" fill="none">
      <rect x="4" y="5" width="20" height="18" rx="3" />
      <path d="M4 10h20M9 5v18M13 14h7M13 18h5" />
    </svg>
  );
}
