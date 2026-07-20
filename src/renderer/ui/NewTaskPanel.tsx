import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type RefObject
} from 'react';
import type {
  AgentExecutionSettings,
  AgentModel,
  AgentRuntimeState,
  CreateTaskRequest,
  RefinePromptResponse,
  Repository
} from '../../shared/contracts';
import {
  ATTACHMENT_FILE_INPUT_ACCEPT,
  type AttachmentDraftSnapshot,
  type ClipboardAttachmentImage,
  type DiscardTaskAttachmentDraftRequest,
  type StageTaskAttachmentBatchRequest
} from '../../shared/attachments';
import {
  settingsForExecutionPolicyPreset
} from '../model/agentPermissions';
import {
  formatAttachmentBytes
} from '../model/taskAttachmentDraft';
import {
  getOrCreateTaskCreationToken,
  taskCreationNeedsUnchangedRetry,
  type AttachmentComposerItem
} from '../model/taskAttachmentComposer';
import {
  formatReasoningEffort,
  resolveReasoningEffort,
  selectModel
} from '../model/agentExecutionSettings';
import { runtimeReadinessView } from '../model/runtimeReadiness';
import {
  clampNewTaskPanelWidth,
  DEFAULT_NEW_TASK_PANEL_WIDTH,
  getNewTaskPanelWidthBounds,
  MAX_NEW_TASK_PANEL_WIDTH,
  resizeNewTaskPanelFromPointer
} from '../model/newTaskPanel';
import {
  buildRepositoryOptions,
  resolveSelectedRepositoryId
} from '../model/repositories';
import { RepositorySelect } from './RepositoryPicker';
import { useDialogFocusBoundary } from './dialogFocus';
import {
  AgentModelSelector,
  type ModelDiscoveryStatus
} from './AgentModelSelector';
import { useTaskAttachments } from './useTaskAttachments';

export interface NewTaskTextDraft {
  title: string;
  prompt: string;
}

interface NewTaskPanelProps {
  repositoryId: string;
  repositories: Repository[];
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  defaultAgentSettings?: AgentExecutionSettings;
  disabled?: boolean;
  refineDisabledReason?: string;
  attachmentsEnabled?: boolean;
  onCreate(input: CreateTaskRequest): Promise<void>;
  onRefinePrompt(repositoryId: string, input: string): Promise<RefinePromptResponse>;
  onStageAttachmentBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscardAttachmentDraft(input: DiscardTaskAttachmentDraftRequest): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  onDiscoverAgentRuntimeModels?(runtimeId: string): Promise<void>;
  initialTextDraft?: NewTaskTextDraft;
  onTextDraftChange?(draft: NewTaskTextDraft): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  onResize?(): void;
  onClose(): void;
}

export function NewTaskPanel({
  repositoryId,
  repositories,
  models,
  runtimes,
  defaultAgentSettings,
  disabled,
  refineDisabledReason,
  attachmentsEnabled = true,
  onCreate,
  onRefinePrompt,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onDiscoverAgentRuntimeModels,
  initialTextDraft,
  onTextDraftChange,
  returnFocusRef,
  fallbackReturnFocusRef,
  onResize,
  onClose
}: NewTaskPanelProps) {
  const [title, setTitle] = useState(initialTextDraft?.title ?? '');
  const [prompt, setPrompt] = useState(initialTextDraft?.prompt ?? '');
  const [runtimeId, setRuntimeId] = useState(
    defaultAgentSettings?.runtimeId ??
      runtimes.find((runtime) => runtime.preflight.readiness.canStart)?.preflight.runtime.id ??
      runtimes[0]?.preflight.runtime.id ??
      ''
  );
  const [modelId, setModelId] = useState('');
  const [requestedRepositoryId, setRequestedRepositoryId] = useState(
    () =>
      repositories.find(
        (repository) => repository.id === repositoryId && repository.status === 'AVAILABLE'
      )?.id ?? repositories.find((repository) => repository.status === 'AVAILABLE')?.id ?? ''
  );
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [permissionPresetId, setPermissionPresetId] = useState('');
  const [networkAccess, setNetworkAccess] = useState(false);
  const permissionRuntimeRef = useRef('');
  const [error, setError] = useState<string | undefined>();
  const [isRefining, setIsRefining] = useState(false);
  const [modelDiscoveryStatus, setModelDiscoveryStatus] =
    useState<ModelDiscoveryStatus>('idle');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [creationOutcomeUnknown, setCreationOutcomeUnknown] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() =>
    clampNewTaskPanelWidth(
      DEFAULT_NEW_TASK_PANEL_WIDTH,
      typeof window === 'undefined' ? MAX_NEW_TASK_PANEL_WIDTH : window.innerWidth
    )
  );
  const [panelWidthBounds, setPanelWidthBounds] = useState(() =>
    getNewTaskPanelWidthBounds(
      typeof window === 'undefined' ? MAX_NEW_TASK_PANEL_WIDTH : window.innerWidth
    )
  );
  const panelRef = useRef<HTMLFormElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | undefined>(
    undefined
  );
  const taskCreationTokenRef = useRef<string | undefined>(undefined);
  const returnFocusAfterCloseRef = useRef(true);
  // Refinement remains a reversible proposal instead of overwriting user input.
  const [proposal, setProposal] = useState<{ prompt: string; titleSuggestion: string }>();
  const [restorable, setRestorable] = useState<string>();

  useEffect(() => {
    const availableRuntimeIds = new Set(
      runtimes.map((runtime) => runtime.preflight.runtime.id)
    );
    const nextRuntimeId = availableRuntimeIds.has(runtimeId)
      ? runtimeId
      : defaultAgentSettings?.runtimeId && availableRuntimeIds.has(defaultAgentSettings.runtimeId)
        ? defaultAgentSettings.runtimeId
        : runtimes.find((runtime) => runtime.preflight.readiness.canStart)?.preflight.runtime.id ??
          runtimes[0]?.preflight.runtime.id ??
          '';
    if (nextRuntimeId !== runtimeId) {
      setRuntimeId(nextRuntimeId);
      return;
    }
    const scopedModels = models.filter((candidate) => candidate.runtimeId === nextRuntimeId);
    if (scopedModels.some((candidate) => candidate.id === modelId)) {
      return;
    }
    const defaultModel = selectModel(
      scopedModels,
      defaultAgentSettings?.model,
      nextRuntimeId,
      defaultAgentSettings?.modelProvider
    );
    if (defaultModel) {
      setModelId(defaultModel.id);
      setReasoningEffort(
        defaultAgentSettings?.reasoningEffort ?? defaultModel.defaultReasoningEffort ?? ''
      );
    } else {
      setModelId('');
      setReasoningEffort('');
    }
  }, [defaultAgentSettings, modelId, models, runtimeId, runtimes]);

  const selectedRuntime = runtimes.find(
    (runtime) => runtime.preflight.runtime.id === runtimeId
  );
  const selectedRuntimeReadiness = runtimeReadinessView(selectedRuntime);
  const modelCatalogFailed =
    selectedRuntime?.preflight.readiness.checks.modelCatalog === 'FAILED';
  const executionPolicy = selectedRuntime?.preflight.capabilities.executionPolicy;
  const permissionPresets = executionPolicy?.presets ?? [];
  const permissionPreset =
    permissionPresets.find((preset) => preset.id === permissionPresetId) ??
    permissionPresets.find(
      (preset) => preset.id === executionPolicy?.defaultPresetId
    ) ??
    permissionPresets[0];

  useEffect(() => {
    const defaultPresetId =
      executionPolicy?.defaultPresetId ?? permissionPresets[0]?.id ?? '';
    if (
      permissionRuntimeRef.current !== runtimeId ||
      !permissionPresets.some((preset) => preset.id === permissionPresetId)
    ) {
      permissionRuntimeRef.current = runtimeId;
      setPermissionPresetId(defaultPresetId);
      setNetworkAccess(false);
    }
  }, [executionPolicy?.defaultPresetId, permissionPresetId, permissionPresets, runtimeId]);

  const runtimeSupportsAttachments = Boolean(
    selectedRuntime &&
      selectedRuntime.preflight.capabilities.attachmentDelivery.maturity !== 'unsupported'
  );
  const effectiveAttachmentsEnabled = attachmentsEnabled && runtimeSupportsAttachments;
  const runtimeModels = models.filter((candidate) => candidate.runtimeId === runtimeId);
  const selectedModel = runtimeModels.find((candidate) => candidate.id === modelId);
  const effectiveReasoningEffort =
    resolveReasoningEffort(selectedModel, reasoningEffort) ?? '';
  const networkDisabledByPreset = permissionPreset?.networkAccess === 'DISABLED';
  const networkRequiredByPreset = permissionPreset?.networkAccess === 'REQUIRED';
  const fullAccessSelected = permissionPreset?.sandbox === 'DANGER_FULL_ACCESS';
  const availableRepositories = repositories.filter(
    (repository) => repository.status === 'AVAILABLE'
  );
  const repositoryOptions = buildRepositoryOptions({
    repositories: availableRepositories,
    tasks: []
  });
  const selectedRepositoryId = resolveSelectedRepositoryId(
    repositoryOptions,
    requestedRepositoryId
  );
  const selectedRepository = availableRepositories.find(
    (repository) => repository.id === selectedRepositoryId
  );
  const composerLocked = Boolean(disabled) || isSubmitting || creationOutcomeUnknown;

  const updateTitle = (value: string) => {
    setTitle(value);
    onTextDraftChange?.({ title: value, prompt });
  };

  const updatePrompt = (value: string) => {
    setPrompt(value);
    onTextDraftChange?.({ title, prompt: value });
  };
  const attachments = useTaskAttachments({
    enabled: effectiveAttachmentsEnabled,
    blocked: composerLocked || fullAccessSelected,
    model: selectedModel,
    onStageBatch: onStageAttachmentBatch,
    onDiscard: (draftId) => onDiscardAttachmentDraft({ draftId }),
    onReadClipboardImage
  });
  const {
    items: attachmentItems,
    activeItems: activeAttachmentItems,
    byteCount: attachmentByteCount,
    busy: attachmentsBusy,
    hasErrors: attachmentsHaveErrors,
    isDragging: isDraggingFiles,
    isReadingClipboardImage,
    overflowError: attachmentOverflowError,
    modelError: attachmentModelError,
    interactionBlocked: attachmentInteractionBlocked,
    inputRef: attachmentInputRef,
    closedRef: panelClosedRef,
    selectFiles: selectAttachmentFiles,
    paste: pasteAttachments,
    dragEnter: enterAttachmentDrag,
    dragOver: continueAttachmentDrag,
    dragLeave: leaveAttachmentDrag,
    drop: dropAttachments,
    remove: removeAttachment,
    close: closeAttachments
  } = attachments;
  const attachmentsRestrictNetwork = activeAttachmentItems.length > 0;
  const effectiveNetworkAccess =
    !attachmentsRestrictNetwork &&
    (networkRequiredByPreset ||
      (permissionPreset?.networkAccess === 'OPTIONAL' && networkAccess));
  const selectedModelRejectsImages = Boolean(attachmentModelError);
  const selectedRuntimeRejectsAttachments =
    activeAttachmentItems.length > 0 && !effectiveAttachmentsEnabled;
  const canDeferModelSelection = Boolean(
    selectedRuntime &&
      !selectedRuntime.preflight.readiness.canStart &&
      activeAttachmentItems.length === 0
  );

  useEffect(() => {
    const resizePanelForViewport = () => {
      const nextBounds = getNewTaskPanelWidthBounds(window.innerWidth);
      setPanelWidthBounds(nextBounds);
      setPanelWidth((current) =>
        Math.min(nextBounds.max, Math.max(nextBounds.min, current))
      );
      onResize?.();
    };
    window.addEventListener('resize', resizePanelForViewport);
    return () => window.removeEventListener('resize', resizePanelForViewport);
  }, [onResize]);

  const closePanel = useCallback(() => {
    if (panelClosedRef.current || submittingRef.current) return;
    closeAttachments();
    setIsClosing(true);
    onClose();
  }, [closeAttachments, onClose, panelClosedRef]);

  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: titleInputRef,
    fallbackReturnFocusRef,
    busy: isSubmitting,
    trapFocus: false,
    onClose: closePanel,
    returnFocus: returnFocusRef?.current,
    shouldReturnFocus: () => returnFocusAfterCloseRef.current
  });

  const resizePanel = useCallback(
    (nextWidth: number) => {
      setPanelWidth(Math.min(panelWidthBounds.max, Math.max(panelWidthBounds.min, nextWidth)));
      onResize?.();
    },
    [onResize, panelWidthBounds.max, panelWidthBounds.min]
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) {
      return;
    }
    setError(undefined);
    if (!selectedRepositoryId) {
      setError('Select a repository before creating a task.');
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    let creationNeedsUnchangedRetry = false;
    let created = false;
    try {
      const attachmentDraftId = await attachments.prepareForCreate();
      if (!permissionPreset) {
        throw new Error('The selected runtime does not expose an execution policy.');
      }
      const permissionSettings = settingsForExecutionPolicyPreset(permissionPreset, {
        networkAccess: effectiveNetworkAccess
      });
      try {
        await onCreate({
          title,
          prompt,
          repositoryId: selectedRepositoryId,
          creationToken: getOrCreateTaskCreationToken(taskCreationTokenRef),
          attachmentDraftId,
          agentSettings: {
            runtimeId: runtimeId || undefined,
            model: selectedModel?.model,
            modelProvider: selectedModel?.modelProvider,
            reasoningEffort: effectiveReasoningEffort || undefined,
            ...permissionSettings
          },
          runtimeId: runtimeId || undefined
        });
        created = true;
      } catch (caught) {
        creationNeedsUnchangedRetry = taskCreationNeedsUnchangedRetry(caught);
        await attachments.markCreateFailed(creationNeedsUnchangedRetry);
        if (creationNeedsUnchangedRetry) {
          setCreationOutcomeUnknown(true);
        }
        throw caught;
      }
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'Could not create task.';
      setError(
        creationNeedsUnchangedRetry
          ? `Task creation could not be confirmed. Retry unchanged to recover safely, or close and check the task list before starting over. ${detail}`
          : detail
      );
    } finally {
      submittingRef.current = false;
      if (!panelClosedRef.current) {
        setIsSubmitting(false);
      }
      if (created) {
        returnFocusAfterCloseRef.current = false;
        closePanel();
      }
    }
  };

  const refine = async () => {
    setError(undefined);
    if (refineDisabledReason) {
      setError(refineDisabledReason);
      return;
    }
    if (!selectedRepositoryId) {
      setError('Select a repository before refining the description.');
      return;
    }
    setProposal(undefined);
    setRestorable(undefined);
    setIsRefining(true);
    try {
      const refined = await onRefinePrompt(selectedRepositoryId, prompt);
      // Present as a proposal instead of overwriting the user's input.
      setProposal({ prompt: refined.prompt, titleSuggestion: refined.titleSuggestion });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not refine prompt.');
    } finally {
      setIsRefining(false);
    }
  };

  const acceptProposal = () => {
    if (!proposal) {
      return;
    }
    setRestorable(prompt); // keep the pre-refine prompt retrievable
    const nextTitle = title || proposal.titleSuggestion;
    setPrompt(proposal.prompt);
    setTitle(nextTitle);
    onTextDraftChange?.({ title: nextTitle, prompt: proposal.prompt });
    setProposal(undefined);
  };

  const revertProposal = () => setProposal(undefined);

  const restoreOriginal = () => {
    if (restorable === undefined) {
      return;
    }
    updatePrompt(restorable);
    setRestorable(undefined);
  };

  const createDisabled =
    Boolean(disabled) ||
    isSubmitting ||
    isRefining ||
    modelDiscoveryStatus !== 'idle' ||
    modelCatalogFailed ||
    !title.trim() ||
    !prompt.trim() ||
    !selectedRepositoryId ||
    !runtimeId ||
    (!selectedModel && !canDeferModelSelection) ||
    attachmentsBusy ||
    attachmentsHaveErrors ||
    selectedRuntimeRejectsAttachments ||
    selectedModelRejectsImages;
  const slideoverStyle = {
    '--slideover-width': `${panelWidth}px`
  } as CSSProperties;

  return (
    <div
      className={`slideover ${isClosing ? 'slideover--closing' : ''} ${
        isResizing ? 'slideover--resizing' : ''
      }`}
      style={slideoverStyle}
      onDragEnter={enterAttachmentDrag}
      onDragOver={continueAttachmentDrag}
      onDragLeave={leaveAttachmentDrag}
      onDrop={dropAttachments}
    >
      <form
        ref={panelRef}
        className="slideover__panel"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (
            event.key !== 'Enter' ||
            (!event.metaKey && !event.ctrlKey) ||
            event.nativeEvent.isComposing
          ) {
            return;
          }
          event.preventDefault();
          if (!createDisabled) {
            event.currentTarget.requestSubmit();
          }
        }}
        aria-label="New task"
        tabIndex={-1}
      >
        <div
          className="slideover__resize"
          role="separator"
          aria-label="Resize new task panel"
          aria-orientation="vertical"
          aria-valuemin={panelWidthBounds.min}
          aria-valuemax={panelWidthBounds.max}
          aria-valuenow={panelWidth}
          tabIndex={0}
          title="Resize new task panel"
          onPointerDown={(event) => {
            resizeStateRef.current = {
              startX: event.clientX,
              startWidth: panelWidth
            };
            setIsResizing(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const resizeState = resizeStateRef.current;
            if (!resizeState) {
              return;
            }
            event.preventDefault();
            setPanelWidth(
              resizeNewTaskPanelFromPointer(
                resizeState.startWidth,
                resizeState.startX,
                event.clientX,
                window.innerWidth
              )
            );
            onResize?.();
          }}
          onPointerUp={(event) => {
            resizeStateRef.current = undefined;
            setIsResizing(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            resizeStateRef.current = undefined;
            setIsResizing(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              resizePanel(panelWidth + 32);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              resizePanel(panelWidth - 32);
            } else if (event.key === 'Home') {
              event.preventDefault();
              resizePanel(panelWidthBounds.min);
            } else if (event.key === 'End') {
              event.preventDefault();
              resizePanel(panelWidthBounds.max);
            }
          }}
        >
          <span aria-hidden="true" />
        </div>
        <header className="slideover__header">
          <div className="slideover__heading">
            <strong>New task</strong>
          </div>
          <button
            type="button"
            className="slideover__close"
            aria-label="Close"
            disabled={isSubmitting}
            onClick={closePanel}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="slideover__body">
          <section className="newtask-section" aria-label="Task essentials">
            <fieldset className="field tm-newtask-repository">
              <legend>Repository</legend>
              <RepositorySelect
                options={repositoryOptions}
                selectedId={selectedRepositoryId}
                disabled={composerLocked || repositoryOptions.length === 0}
                ariaLabel="Task repository"
                onChange={setRequestedRepositoryId}
              />
            </fieldset>
            <label className="field">
              <span>Title</span>
              <input
                ref={titleInputRef}
                value={title}
                onChange={(event) => updateTitle(event.target.value)}
                placeholder="Short imperative summary"
                disabled={composerLocked}
              />
            </label>

            <div className="field field--prompt">
              <span className="field__header">
                <span className="field__label">
                  <label htmlFor="task-description">Description</label>
                </span>
                <span className="field__header-actions">
                  {restorable !== undefined && !proposal ? (
                    <button
                      className="field__restore"
                      type="button"
                      disabled={composerLocked || isRefining}
                      onClick={restoreOriginal}
                    >
                      Restore original
                    </button>
                  ) : null}
                  <button
                    className="field__refine"
                    type="button"
                    disabled={
                      composerLocked ||
                      isRefining ||
                      Boolean(refineDisabledReason) ||
                      !prompt.trim() ||
                      !selectedRepositoryId ||
                      Boolean(proposal)
                    }
                    aria-busy={isRefining}
                    title={refineDisabledReason}
                    onClick={() => void refine()}
                  >
                    <SparkleIcon />
                    <span
                      className={
                        isRefining
                          ? 'field__refine-label tm-shimmer-text'
                          : 'field__refine-label'
                      }
                    >
                      {isRefining ? 'Refining' : 'Refine'}
                    </span>
                  </button>
                </span>
              </span>
              <div
                className={`field__prompt-shell ${
                  isRefining ? 'field__prompt-shell--running' : ''
                } ${isDraggingFiles ? 'field__prompt-shell--dragging' : ''}`}
              >
                <textarea
                  id="task-description"
                  value={prompt}
                  onChange={(event) => updatePrompt(event.target.value)}
                  onPaste={pasteAttachments}
                  placeholder={
                    'Describe the implementation request, constraints, and expected verification.'
                  }
                  disabled={composerLocked || isRefining}
                />
                {attachmentItems.length > 0 ? (
                  <ul className="task-attachments" aria-label="Task attachments">
                    {attachmentItems.map((item) => (
                      <AttachmentChip
                        key={item.clientId}
                        item={item}
                        disabled={composerLocked}
                        onRemove={() => void removeAttachment(item.clientId)}
                      />
                    ))}
                  </ul>
                ) : null}
                <div className="field__prompt-toolbar">
                  <input
                    ref={attachmentInputRef}
                    className="task-attachment-input"
                    type="file"
                    multiple
                    accept={ATTACHMENT_FILE_INPUT_ACCEPT}
                    disabled={attachmentInteractionBlocked}
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={selectAttachmentFiles}
                  />
                  <button
                    type="button"
                    className="task-attachment-add"
                    disabled={attachmentInteractionBlocked}
                    title={
                      fullAccessSelected
                        ? 'Choose a runtime policy with managed attachment isolation.'
                        : effectiveAttachmentsEnabled
                        ? `Stored locally and shared read-only with ${
                            selectedRuntime?.preflight.runtime.displayName ?? 'the selected agent'
                          } for this task.`
                          : !runtimeSupportsAttachments
                            ? `${
                                selectedRuntime?.preflight.runtime.displayName ??
                                'The selected agent runtime'
                              } does not support task attachments.`
                          : 'Attachments require file-read isolation between tasks.'
                    }
                    onClick={() => attachmentInputRef.current?.click()}
                  >
                    <PaperclipIcon />
                    <span>Add files</span>
                  </button>
                  <span className="task-attachment-hint">
                    {fullAccessSelected
                      ? `Unavailable with ${permissionPreset?.label ?? 'this policy'}`
                      : !effectiveAttachmentsEnabled
                      ? runtimeSupportsAttachments
                        ? 'Unavailable in this build'
                        : 'Unavailable for this runtime'
                      : isReadingClipboardImage
                      ? 'Reading clipboard image…'
                      : activeAttachmentItems.length > 0
                      ? `${activeAttachmentItems.length} ${
                          activeAttachmentItems.length === 1 ? 'file' : 'files'
                        } · ${formatAttachmentBytes(attachmentByteCount)}`
                      : 'Paste or drop files'}
                  </span>
                </div>
                {effectiveAttachmentsEnabled && isDraggingFiles ? (
                  <div className="task-attachment-drop" aria-hidden="true">
                    <PaperclipIcon />
                    <span>Drop to attach</span>
                  </div>
                ) : null}
              </div>
              {attachmentOverflowError ? (
                <p
                  className="task-attachment-message task-attachment-message--error"
                  role="alert"
                >
                  {attachmentOverflowError}
                </p>
              ) : null}
              {selectedModelRejectsImages ? (
                <p
                  className="task-attachment-message task-attachment-message--error"
                  role="alert"
                >
                  <span aria-hidden="true" />
                  {attachmentModelError}
                </p>
              ) : null}
              {selectedRuntimeRejectsAttachments ? (
                <p
                  className="task-attachment-message task-attachment-message--error"
                  role="alert"
                >
                  Remove the attachments or choose a runtime that supports them.
                </p>
              ) : null}
              {proposal ? (
                <RefinementProposal
                  refined={proposal.prompt}
                  onAccept={acceptProposal}
                  onRevert={revertProposal}
                />
              ) : null}
            </div>
          </section>

          <details className="newtask-settings">
            <summary>
              <span className="newtask-settings__title">Run configuration</span>
              <span className="newtask-settings__summary">
                {selectedRuntime?.preflight.runtime.displayName ?? 'Default runtime'}
                {selectedModel ? ` · ${selectedModel.displayName}` : ''}
                {effectiveReasoningEffort
                  ? ` · ${formatReasoningEffort(effectiveReasoningEffort)}`
                  : ''}
              </span>
              <ChevronIcon />
            </summary>

            <div className="newtask-settings__content">
              <AgentModelSelector
                label="Run configuration"
                runtimeId={runtimeId}
                modelId={modelId}
                reasoningEffort={effectiveReasoningEffort}
                models={models}
                runtimes={runtimes}
                disabled={composerLocked}
                onDiscoverModels={onDiscoverAgentRuntimeModels}
                onDiscoveryStatusChange={setModelDiscoveryStatus}
                onSelectionChange={(nextRuntimeId, nextModelId) => {
                  const nextModel = models.find(
                    (candidate) =>
                      candidate.runtimeId === nextRuntimeId && candidate.id === nextModelId
                  );
                  setRuntimeId(nextRuntimeId);
                  setModelId(nextModel?.id ?? '');
                  setReasoningEffort(nextModel?.defaultReasoningEffort ?? '');
                }}
                onReasoningEffortChange={setReasoningEffort}
                access={
                  <div className="tm-agent-console__row">
                    <span className="tm-agent-console__label">Access</span>
                    <div className="tm-agent-console__access">
                      <div
                        className="tm-agent-console__access-options"
                        role="group"
                        aria-label="Execution policy"
                      >
                        {permissionPresets.map((preset) => {
                          const presetDisabled =
                            preset.sandbox === 'DANGER_FULL_ACCESS' &&
                            activeAttachmentItems.length > 0;
                          return (
                            <button
                              type="button"
                              className={preset.id === permissionPreset?.id ? 'is-selected' : ''}
                              aria-pressed={preset.id === permissionPreset?.id}
                              disabled={composerLocked || presetDisabled}
                              key={preset.id}
                              title={presetDisabled ? 'Remove attachments to use full access.' : undefined}
                              onClick={() => setPermissionPresetId(preset.id)}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                      <small>
                        {permissionPreset?.detail ??
                          'The selected agent does not expose an execution policy.'}
                      </small>
                    </div>
                  </div>
                }
              />

              <div className="network-toggle">
                <div className="network-toggle__copy">
                  <span className="network-toggle__title" id="task-network-access-label">
                    Network access
                  </span>
                  <span className="network-toggle__state">
                    {attachmentsRestrictNetwork
                      ? 'Disabled while attachments are included.'
                      : networkDisabledByPreset
                        ? `Disabled by ${permissionPreset?.label ?? 'this mode'}.`
                        : networkRequiredByPreset
                          ? 'Required by this execution policy.'
                          : effectiveNetworkAccess
                            ? 'Enabled - commands may use the network during this task.'
                            : 'Disabled - network use stays outside the task boundary.'}
                  </span>
                </div>
                <button
                  type="button"
                  className={`network-toggle__switch ${
                    effectiveNetworkAccess ? 'network-toggle__switch--on' : ''
                  }`}
                  role="switch"
                  aria-labelledby="task-network-access-label"
                  aria-checked={effectiveNetworkAccess}
                  disabled={
                    composerLocked ||
                    networkDisabledByPreset ||
                    networkRequiredByPreset ||
                    attachmentsRestrictNetwork
                  }
                  onClick={() => setNetworkAccess((current) => !current)}
                >
                  <span />
                </button>
              </div>
            </div>
          </details>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {selectedRuntime && !selectedRuntimeReadiness.canStart ? (
            <p className="form-error">
              {selectedRuntimeReadiness.detail}
              {selectedRuntimeReadiness.nextAction
                ? ` ${selectedRuntimeReadiness.nextAction}.`
                : ''}{' '}
              You can create the task now and start it after the runtime is available.
            </p>
          ) : null}
          {selectedRuntime?.preflight.readiness.status === 'DEGRADED' ? (
            <p className="form-warning">{selectedRuntimeReadiness.detail}</p>
          ) : null}
          {selectedRuntimeReadiness.warnings.map((warning) => (
            <p className="form-warning" key={`${warning.code}:${warning.message}`}>
              {warning.message}
            </p>
          ))}
        </div>

        <footer className="slideover__footer">
          <div className="slideover__footer-actions">
            <button
              type="button"
              className="outline-button"
              disabled={isSubmitting}
              onClick={closePanel}
            >
              {creationOutcomeUnknown ? 'Close' : 'Cancel'}
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={createDisabled}
              aria-busy={isSubmitting}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              aria-label={
                selectedRepository
                  ? `Create task in ${selectedRepository.name}`
                  : 'Create task'
              }
            >
              {isSubmitting
                ? 'Creating…'
                : creationOutcomeUnknown
                  ? 'Retry creation'
                  : 'Create task'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3l1.9 4.8L19 9.5l-4 3.4L16 18l-4-2.7L8 18l1-5.1-4-3.4 5.1-.7z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="m9.5 12.5 5.7-5.7a3.2 3.2 0 0 1 4.5 4.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.1-8.1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="m7 7 10 10M17 7 7 17"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="m8 10 4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AttachmentChip({
  item,
  disabled,
  onRemove
}: {
  item: AttachmentComposerItem;
  disabled: boolean;
  onRemove(): void;
}) {
  return (
    <li
      className={`task-attachment ${
        item.status === 'error' || item.error ? 'task-attachment--error' : ''
      }`}
    >
      <span className="task-attachment__preview" aria-hidden="true">
        {item.previewUrl ? (
          <img src={item.previewUrl} alt="" loading="lazy" decoding="async" />
        ) : item.kind === 'image' ? (
          <ImageFileIcon />
        ) : (
          <TextFileIcon />
        )}
      </span>
      <span className="task-attachment__body">
        <span className="task-attachment__name" title={item.file.name}>
          {item.file.name}
        </span>
        <span
          className="task-attachment__meta"
          role={item.error ? 'alert' : undefined}
          aria-live={item.error ? 'assertive' : undefined}
          aria-atomic={item.error ? 'true' : undefined}
        >
          {item.status === 'error'
            ? item.error
            : formatAttachmentBytes(item.file.size)}
        </span>
      </span>
      <button
        type="button"
        className="task-attachment__remove"
        aria-label={`Remove ${item.file.name}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <CloseIcon />
      </button>
    </li>
  );
}

function ImageFileIcon() {
  return (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="10" r="1.4" fill="currentColor" />
      <path
        d="m6.5 17 4-4 2.5 2 2-2 2.5 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TextFileIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 3.8h6l4 4V20H7zM13 4v4h4M9.5 12h5M9.5 15h5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefinementProposal({
  refined,
  onAccept,
  onRevert
}: {
  refined: string;
  onAccept(): void;
  onRevert(): void;
}) {
  return (
    <div className="field__proposal" role="group" aria-label="Refined description proposal">
      <div className="field__proposal-head">
        <span className="field__proposal-title">Refined description</span>
      </div>
      <pre className="field__proposal-body">{refined}</pre>
      <div className="field__proposal-actions">
        <button type="button" className="outline-button" onClick={onRevert}>
          Revert
        </button>
        <button type="button" className="primary-button" onClick={onAccept}>
          Accept
        </button>
      </div>
    </div>
  );
}
