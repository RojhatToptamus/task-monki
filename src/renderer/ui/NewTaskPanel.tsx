import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject
} from 'react';
import { Check, ChevronDown, Sparkles, X } from 'lucide-react';
import type {
  AgentExecutionSettings,
  AgentExecutionPolicyPreset,
  AgentModel,
  AgentRuntimeState,
  CreateTaskRequest,
  RefinePromptResponse,
  Repository
} from '../../shared/contracts';
import {
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
  creationRequiresUnchangedRetry,
  getOrCreateTaskCreationToken,
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
  MAX_NEW_TASK_PANEL_WIDTH
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
import { AttachmentComposerShell } from './AttachmentComposerShell';
import { useTaskAttachments } from './useTaskAttachments';
import { PanelResizeHandle } from './PanelResizeHandle';
import { StatusGlyph } from './StatusBadge';
import { DisclosureChevron } from './DisclosureChevron';

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

export function ExecutionPolicySelect({
  presets,
  selectedPreset,
  attachmentsIncluded,
  disabled,
  onChange
}: {
  presets: readonly AgentExecutionPolicyPreset[];
  selectedPreset?: AgentExecutionPolicyPreset;
  attachmentsIncluded: boolean;
  disabled: boolean;
  onChange(presetId: string): void;
}) {
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    if (disabled) {
      setOpen(false);
      return undefined;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [disabled, open]);

  const close = () => setOpen(false);

  return (
    <div
      className={`tm-access-select ${open ? 'is-open' : ''}`}
      ref={rootRef}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (open && !(nextTarget instanceof Node && event.currentTarget.contains(nextTarget))) {
          close();
        }
      }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="tm-access-select__trigger"
        aria-label={`Execution policy: ${selectedPreset?.label ?? 'Unavailable'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        disabled={disabled || presets.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="tm-access-select__summary">
          <strong>{selectedPreset?.label ?? 'No execution policy'}</strong>
          <small>{selectedPreset?.detail ?? 'The selected agent does not expose an execution policy.'}</small>
        </span>
        <SelectChevronIcon open={open} />
      </button>

      {open ? (
        <div className="tm-access-select__menu" id={popupId} role="menu" aria-label="Execution policy">
          {presets.map((preset) => {
            const selected = preset.id === selectedPreset?.id;
            const blockedByAttachments =
              preset.sandbox === 'DANGER_FULL_ACCESS' && attachmentsIncluded;
            return (
              <button
                type="button"
                role="menuitemradio"
                className={`tm-access-select__option ${selected ? 'is-selected' : ''}`}
                aria-checked={selected}
                disabled={disabled || blockedByAttachments}
                key={preset.id}
                title={blockedByAttachments ? 'Remove attachments to use full access.' : undefined}
                onClick={() => {
                  onChange(preset.id);
                  close();
                  triggerRef.current?.focus();
                }}
              >
                <span>
                  <strong>{preset.label}</strong>
                  <small>{preset.detail}</small>
                </span>
                <span className="tm-access-select__check" aria-hidden="true">
                  {selected ? <SelectCheckIcon /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
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
  const slideoverRef = useRef<HTMLDivElement>(null);
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
    activeItems: activeAttachmentItems,
    byteCount: attachmentByteCount,
    busy: attachmentsBusy,
    hasErrors: attachmentsHaveErrors,
    isReadingClipboardImage,
    overflowError: attachmentOverflowError,
    modelError: attachmentModelError,
    closedRef: panelClosedRef,
    paste: pasteAttachments,
    dragEnter: enterAttachmentDrag,
    dragOver: continueAttachmentDrag,
    dragLeave: leaveAttachmentDrag,
    drop: dropAttachments,
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

  useLayoutEffect(() => {
    slideoverRef.current?.style.setProperty('--slideover-width', `${panelWidth}px`);
  }, [panelWidth]);

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
        creationNeedsUnchangedRetry = creationRequiresUnchangedRetry(caught);
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
  return (
    <div
      ref={slideoverRef}
      className={`slideover ${isClosing ? 'slideover--closing' : ''}`}
      onDragEnter={enterAttachmentDrag}
      onDragOver={continueAttachmentDrag}
      onDragLeave={leaveAttachmentDrag}
      onDrop={dropAttachments}
    >
      <form
        id="new-task-panel-content"
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
        <PanelResizeHandle
          className="slideover__resize"
          label="Resize new task panel"
          value={panelWidth}
          min={panelWidthBounds.min}
          max={panelWidthBounds.max}
          defaultValue={DEFAULT_NEW_TASK_PANEL_WIDTH}
          direction={-1}
          controls="new-task-panel-content"
          onChange={resizePanel}
        />
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
                    {isRefining ? <StatusGlyph kind="working" /> : <SparkleIcon />}
                    <span className="field__refine-label">
                      {isRefining ? 'Refining' : 'Refine'}
                    </span>
                  </button>
                </span>
              </span>
              <AttachmentComposerShell
                attachments={attachments}
                attachmentLabel="Task attachments"
                className={isRefining ? 'field__prompt-shell--running' : ''}
                bindDropTarget={false}
                removeDisabled={composerLocked}
                addButtonTitle={
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
                hint={
                  fullAccessSelected
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
                          : 'Paste or drop files'
                }
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
              </AttachmentComposerShell>
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
              <DisclosureChevron />
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
                      <ExecutionPolicySelect
                        presets={permissionPresets}
                        selectedPreset={permissionPreset}
                        attachmentsIncluded={activeAttachmentItems.length > 0}
                        disabled={composerLocked}
                        onChange={setPermissionPresetId}
                      />
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

function SelectChevronIcon({ open }: { open: boolean }) {
  return (
    <ChevronDown
      absoluteStrokeWidth
      className={`tm-access-select__chevron ${open ? 'tm-access-select__chevron--open' : ''}`}
      aria-hidden="true"
      size={12}
      strokeWidth={1.5}
    />
  );
}

function SelectCheckIcon() {
  return <Check aria-hidden="true" absoluteStrokeWidth size={13} strokeWidth={1.5} />;
}

function SparkleIcon() {
  return <Sparkles aria-hidden="true" absoluteStrokeWidth size={13} strokeWidth={1.5} />;
}

function CloseIcon() {
  return <X aria-hidden="true" absoluteStrokeWidth size={15} strokeWidth={1.5} />;
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
