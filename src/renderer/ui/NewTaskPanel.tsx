import type { CustomAgentProfile } from '../../shared/agentProfiles';
import { AgentProfileSelect } from './AgentProfileSelect';
import { AccessMenu } from './AccessMenu';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject
} from 'react';
import { X } from 'lucide-react';
import { AgentMark } from './UiIcons';
import type {
  AgentExecutionSettings,
  AgentModel,
  AgentRuntimeState,
  CreateTaskRequest,
  ExistingWorktree,
  ImportTaskRequest,
  ImportPreview,
  PreviewImportRequest,
  RefinePromptRequest,
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
  creationRequiresUnchangedRetry,
  getOrCreateTaskCreationToken,
} from '../model/taskAttachmentComposer';
import {
  resolveReasoningEffort,
  selectModel
} from '../model/agentExecutionSettings';
import { runtimeReadinessView } from '../model/runtimeReadiness';
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
import { ImportWorkFields, branchTaskTitle } from './ImportWorkFields';

export interface NewTaskTextDraft {
  agentProfileId?: string;
  title: string;
  prompt: string;
}

interface NewTaskPanelProps {
  agentProfiles?: readonly CustomAgentProfile[];
  repositoryId: string;
  repositories: Repository[];
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  defaultAgentSettings?: AgentExecutionSettings;
  disabled?: boolean;
  refineDisabledReason?: string;
  attachmentsEnabled?: boolean;
  onCreate(input: CreateTaskRequest): Promise<void>;
  onImport?(input: ImportTaskRequest): Promise<void>;
  onListExistingWorktrees?(repositoryId: string): Promise<ExistingWorktree[]>;
  onPreviewImport?(input: PreviewImportRequest): Promise<ImportPreview>;
  onOpenExistingTask?(taskId: string): Promise<void>;
  onRefinePrompt(
    input: Pick<
      RefinePromptRequest,
      | 'requestId'
      | 'repositoryId'
      | 'input'
      | 'title'
      | 'attachmentDraftId'
      | 'targetRuntimeId'
      | 'targetModel'
      | 'targetModelProvider'
    >
  ): Promise<RefinePromptResponse>;
  onCancelPromptRefinement(requestId: string): Promise<void>;
  onStageAttachmentBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscardAttachmentDraft(input: DiscardTaskAttachmentDraftRequest): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  onDiscoverAgentRuntimeModels?(runtimeId: string): Promise<void>;
  initialTextDraft?: NewTaskTextDraft;
  onTextDraftChange?(draft: NewTaskTextDraft): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  onClose(): void;
}


export function NewTaskPanel({
  agentProfiles = [],
  repositoryId,
  repositories,
  models,
  runtimes,
  defaultAgentSettings,
  disabled,
  refineDisabledReason,
  attachmentsEnabled = true,
  onCreate,
  onImport,
  onListExistingWorktrees,
  onPreviewImport,
  onOpenExistingTask,
  onRefinePrompt,
  onCancelPromptRefinement,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onDiscoverAgentRuntimeModels,
  initialTextDraft,
  onTextDraftChange,
  returnFocusRef,
  fallbackReturnFocusRef,
  onClose
}: NewTaskPanelProps) {
  const [agentProfileId, setAgentProfileId] = useState(initialTextDraft?.agentProfileId);
  const [title, setTitle] = useState(initialTextDraft?.title ?? '');
  const [prompt, setPrompt] = useState(initialTextDraft?.prompt ?? '');
  const [importing, setImporting] = useState(false);
  const [checkoutPath, setCheckoutPath] = useState('');
  const [checkoutQuery, setCheckoutQuery] = useState('');
  const [checkoutRefresh, setCheckoutRefresh] = useState(0);
  const [comparison, setComparison] = useState<'local' | 'head' | 'commit'>('local');
  const [commitRef, setCommitRef] = useState('');
  const [importTitle, setImportTitle] = useState<string>();
  const [previewResult, setPreviewResult] = useState<{
    repositoryId: string;
    worktreePath: string;
    branchName: string;
    baseRef?: string;
    data?: ImportPreview;
    error?: string;
  }>();
  const [checkouts, setCheckouts] = useState<{
    repositoryId: string;
    items: ExistingWorktree[];
    error?: string;
  }>();
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
  const panelRef = useRef<HTMLFormElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const activeRefinementRef = useRef<
    { requestId: string; inputFingerprint: string } | undefined
  >(undefined);
  const taskCreationTokenRef = useRef<string | undefined>(undefined);
  const returnFocusAfterCloseRef = useRef(true);
  // Refinement remains a reversible proposal instead of overwriting user input.
  const [proposal, setProposal] = useState<{
    prompt: string;
    titleSuggestion: string;
    inputFingerprint: string;
  }>();
  const [refinementWarning, setRefinementWarning] = useState<{
    message: string;
    inputFingerprint: string;
  }>();
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
  const effectiveAttachmentsEnabled = !importing && attachmentsEnabled && runtimeSupportsAttachments;
  const runtimeModels = models.filter((candidate) => candidate.runtimeId === runtimeId);
  const selectedModel = runtimeModels.find((candidate) => candidate.id === modelId);
  const effectiveReasoningEffort =
    resolveReasoningEffort(selectedModel, reasoningEffort) ?? '';
  const networkRequiredByPreset = permissionPreset?.networkAccess === 'REQUIRED';
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
  const checkoutOptions = checkouts?.repositoryId === selectedRepositoryId ? checkouts : undefined;
  const selectedCheckout = checkoutOptions?.items.find((item) => item.worktreePath === checkoutPath);
  const effectiveImportTitle = importTitle ?? branchTaskTitle(selectedCheckout?.branchName);
  const requestedBaseRef = comparison === 'head' ? 'HEAD' : comparison === 'commit' ? commitRef.trim() : undefined;
  const currentPreview = importing && previewResult?.repositoryId === selectedRepositoryId &&
    previewResult.worktreePath === selectedCheckout?.worktreePath && previewResult.branchName === selectedCheckout?.branchName && previewResult.baseRef === requestedBaseRef
      ? previewResult : undefined;
  const importDisabledReason = !selectedCheckout ? 'Select a checkout.'
    : selectedCheckout.unavailableReason
    ?? (selectedCheckout.existingTaskId ? undefined
      : comparison === 'commit' && !commitRef.trim() ? 'Enter a branch or commit.'
      : currentPreview?.error ?? currentPreview?.data?.unavailableReason
      ?? (!currentPreview?.data ? 'Checking changes…' : !effectiveImportTitle.trim() ? 'Enter a title.' : undefined));
  useEffect(() => {
    if (!importing || !selectedCheckout?.branchName || selectedCheckout.unavailableReason ||
        selectedCheckout.existingTaskId || !onPreviewImport || (comparison === 'commit' && !requestedBaseRef)) return;
    let canceled = false;
    const request = { repositoryId: selectedRepositoryId, worktreePath: selectedCheckout.worktreePath,
      branchName: selectedCheckout.branchName, baseRef: requestedBaseRef };
    const timer = window.setTimeout(() => {
      void onPreviewImport(request).then(
        (data) => { if (!canceled) setPreviewResult({ ...request, data }); },
        (caught: unknown) => { if (!canceled) setPreviewResult({ ...request,
          error: caught instanceof Error ? caught.message : 'Could not inspect this checkout.' }); }
      );
    }, comparison === 'commit' ? 250 : 0);
    return () => { canceled = true; window.clearTimeout(timer); };
  }, [importing, selectedRepositoryId, selectedCheckout, comparison, requestedBaseRef, onPreviewImport]);
  useEffect(() => {
    if (!importing || !selectedRepositoryId || !onListExistingWorktrees) return;
    let canceled = false;
    setCheckouts(undefined);
    void onListExistingWorktrees(selectedRepositoryId).then(
      (items) => {
        if (!canceled) {
          setCheckouts({ repositoryId: selectedRepositoryId, items });
          const available = items.filter((item) => !item.unavailableReason);
          if (available.length === 1) setCheckoutPath(available[0]!.worktreePath);
        }
      },
      (caught: unknown) => {
        if (!canceled) setCheckouts({
          repositoryId: selectedRepositoryId,
          items: [],
          error: caught instanceof Error ? caught.message : 'Could not list checkouts.'
        });
      }
    );
    return () => { canceled = true; };
  }, [importing, selectedRepositoryId, onListExistingWorktrees, checkoutRefresh]);
  const composerLocked =
    Boolean(disabled) || isSubmitting || isRefining || creationOutcomeUnknown;

  const updateTitle = (value: string) => {
    setTitle(value);
    onTextDraftChange?.({ agentProfileId, title: value, prompt });
  };

  const updatePrompt = (value: string) => {
    setPrompt(value);
    onTextDraftChange?.({ agentProfileId, title, prompt: value });
  };
  const attachments = useTaskAttachments({
    enabled: effectiveAttachmentsEnabled,
    blocked: composerLocked,
    model: selectedModel,
    onStageBatch: onStageAttachmentBatch,
    onDiscard: (draftId) => onDiscardAttachmentDraft({ draftId }),
    onReadClipboardImage
  });
  const {
    activeItems: activeAttachmentItems,
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
  const effectiveNetworkAccess =
    networkRequiredByPreset ||
    (permissionPreset?.networkAccess === 'OPTIONAL' && networkAccess);
  const selectedModelRejectsImages = Boolean(attachmentModelError);
  const selectedRuntimeRejectsAttachments =
    activeAttachmentItems.length > 0 && !effectiveAttachmentsEnabled;
  const canDeferModelSelection = Boolean(
    selectedRuntime &&
      !selectedRuntime.preflight.readiness.canStart &&
      activeAttachmentItems.length === 0
  );

  const closePanel = useCallback(() => {
    if (panelClosedRef.current || submittingRef.current) return;
    setIsClosing(true);
    const activeRefinement = activeRefinementRef.current;
    activeRefinementRef.current = undefined;
    if (activeRefinement) {
      setIsRefining(false);
      void onCancelPromptRefinement(activeRefinement.requestId)
        .catch(() => undefined)
        .finally(() => {
          closeAttachments();
          onClose();
        });
      return;
    }
    closeAttachments();
    onClose();
  }, [closeAttachments, onCancelPromptRefinement, onClose, panelClosedRef]);

  // Creating a task is a short, focused form: a modal keeps focus inside it.
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: titleInputRef,
    fallbackReturnFocusRef,
    busy: isSubmitting,
    onClose: closePanel,
    returnFocus: returnFocusRef?.current,
    shouldReturnFocus: () => returnFocusAfterCloseRef.current
  });

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
      if (importing) {
        if (!selectedCheckout || selectedCheckout.unavailableReason || !onImport) {
          throw new Error('Select an available checkout.');
        }
        if (selectedCheckout.existingTaskId && onOpenExistingTask) {
          await onOpenExistingTask(selectedCheckout.existingTaskId);
        } else {
          if (importDisabledReason || !currentPreview?.data) throw new Error(importDisabledReason ?? 'Check the comparison before importing.');
          await onImport({
            repositoryId: selectedRepositoryId,
            worktreePath: selectedCheckout.worktreePath,
            branchName: selectedCheckout.branchName!,
            baseRef: currentPreview.data.baseRef,
            title: effectiveImportTitle,
            prompt: '',
            runtimeId: runtimeId || undefined,
            agentSettings: {
              ...defaultAgentSettings,
              runtimeId: runtimeId || undefined,
              model: selectedModel?.model,
              modelProvider: selectedModel?.modelProvider,
              reasoningEffort: effectiveReasoningEffort || undefined,
              ...(permissionPreset ? settingsForExecutionPolicyPreset(permissionPreset, {
                networkAccess: effectiveNetworkAccess
              }) : {})
            }
          });
        }
        created = true;
        return;
      }
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
          agentProfileId,
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
    setRefinementWarning(undefined);
    const inputFingerprint = refinementInputFingerprint({
      repositoryId: selectedRepositoryId,
      title,
      prompt,
      runtimeId,
      modelId,
      attachmentRevision: attachments.contentRevision
    });
    const requestId = createPromptRefinementRequestId();
    activeRefinementRef.current = { requestId, inputFingerprint };
    setIsRefining(true);
    try {
      const attachmentDraftId = await attachments.prepareForCreate();
      if (
        activeRefinementRef.current?.requestId !== requestId ||
        panelClosedRef.current
      ) {
        await attachments.markCreateFailed(false);
        return;
      }
      const refined = await onRefinePrompt({
        requestId,
        repositoryId: selectedRepositoryId,
        input: prompt,
        title,
        attachmentDraftId,
        targetRuntimeId: runtimeId || undefined,
        targetModel: selectedModel?.model,
        targetModelProvider: selectedModel?.modelProvider
      });
      if (
        activeRefinementRef.current?.requestId !== requestId ||
        panelClosedRef.current
      ) {
        return;
      }
      if (refined.warning) {
        setRefinementWarning({ message: refined.warning, inputFingerprint });
      }
      if (refined.source === 'unchanged-fallback') {
        return;
      }
      // Present as a proposal instead of overwriting the user's input.
      setProposal({
        prompt: refined.prompt,
        titleSuggestion: refined.titleSuggestion,
        inputFingerprint
      });
    } catch (caught) {
      if (activeRefinementRef.current?.requestId === requestId) {
        setError(caught instanceof Error ? caught.message : 'Could not refine prompt.');
      }
    } finally {
      if (activeRefinementRef.current?.requestId === requestId) {
        activeRefinementRef.current = undefined;
        setIsRefining(false);
      }
    }
  };

  const currentRefinementFingerprint = refinementInputFingerprint({
    repositoryId: selectedRepositoryId,
    title,
    prompt,
    runtimeId,
    modelId,
    attachmentRevision: attachments.contentRevision
  });
  const currentProposal =
    proposal?.inputFingerprint === currentRefinementFingerprint ? proposal : undefined;
  const currentRefinementWarning =
    refinementWarning?.inputFingerprint === currentRefinementFingerprint
      ? refinementWarning.message
      : undefined;

  const acceptProposal = () => {
    if (!currentProposal) {
      return;
    }
    setRestorable(prompt); // keep the pre-refine prompt retrievable
    const nextTitle = title || currentProposal.titleSuggestion;
    setPrompt(currentProposal.prompt);
    setTitle(nextTitle);
    onTextDraftChange?.({ agentProfileId, title: nextTitle, prompt: currentProposal.prompt });
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

  const createDisabled = importing
    ? Boolean(disabled) || isSubmitting || Boolean(importDisabledReason)
    :
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
  // The model and access chips: in the description's toolbar for new work, in
  // their own row for imported work, which has no description.
  const runChips = <>
    <AgentModelSelector
      label="Model"
      presentation="compact"
      runtimeId={runtimeId}
      modelId={modelId}
      reasoningEffort={effectiveReasoningEffort}
      models={models}
      runtimes={runtimes}
      disabled={composerLocked}
      onDiscoverModels={onDiscoverAgentRuntimeModels}
      onDiscoveryStatusChange={setModelDiscoveryStatus}
      onSelectionChange={(nextRuntimeId, nextModelId) => {
        const nextModel = models.find((candidate) => candidate.runtimeId === nextRuntimeId && candidate.id === nextModelId);
        setRuntimeId(nextRuntimeId);
        setModelId(nextModel?.id ?? '');
        setReasoningEffort(nextModel?.defaultReasoningEffort ?? '');
      }}
      onReasoningEffortChange={setReasoningEffort}
    />
    {permissionPresets.length ? <AccessMenu
      presets={permissionPresets}
      selected={permissionPreset}
      networkOn={effectiveNetworkAccess}
      disabled={composerLocked}
      onPresetChange={(preset) => setPermissionPresetId(preset.id)}
      onNetworkChange={setNetworkAccess}
    /> : null}
  </>;
  return (
    <div className={`tm-modal tm-modal--top newtask-modal${isClosing ? ' newtask-modal--closing' : ''}`} role="presentation">
      <button
        type="button"
        className="tm-modal__scrim"
        aria-label="Close new task"
        tabIndex={-1}
        disabled={isSubmitting}
        onClick={closePanel}
      />
      <form
        id="new-task-panel-content"
        ref={panelRef}
        className="newtask-modal__panel"
        role="dialog"
        aria-modal="true"
        onDragEnter={enterAttachmentDrag}
        onDragOver={continueAttachmentDrag}
        onDragLeave={leaveAttachmentDrag}
        onDrop={dropAttachments}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && importing && checkoutQuery) {
            event.preventDefault();
            event.stopPropagation();
            setCheckoutQuery('');
            event.currentTarget.querySelector<HTMLInputElement>('input[aria-label="Filter checkouts"]')?.focus();
            return;
          }
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
        <header className="newtask-modal__header">
          {onImport ? (
            <div className="segmented" role="group" aria-label="Task source" onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const next = event.currentTarget.querySelector<HTMLButtonElement>('button[aria-pressed="false"]:not(:disabled)');
              next?.focus(); next?.click();
            }}>
              {[false, true].map((value) => (
                <button key={String(value)} type="button" className="segmented__btn"
                  aria-pressed={importing === value}
                  disabled={composerLocked || attachmentsBusy || activeAttachmentItems.length > 0}
                  title={activeAttachmentItems.length > 0 ? 'Remove attachments before changing the task source.' : undefined}
                  onClick={() => {
                    if (value === importing) return;
                    setImporting(value); setPreviewResult(undefined); setError(undefined);
                  }}>
                  {value ? 'Import existing work' : 'New work'}
                </button>
              ))}
            </div>
          ) : <div className="newtask-modal__heading">
            <strong>New task</strong>
          </div>}
          <button
            type="button"
            className="newtask-modal__close"
            aria-label="Close"
            disabled={isSubmitting}
            onClick={closePanel}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="newtask-modal__body">
          <section className="newtask-section" aria-label="Task essentials">
            {!(importing && selectedCheckout?.existingTaskId) ? <fieldset className="field tm-newtask-repository">
              <legend>Repository</legend>
              <RepositorySelect
                options={repositoryOptions}
                selectedId={selectedRepositoryId}
                disabled={composerLocked || repositoryOptions.length === 0}
                ariaLabel="Task repository"
                onChange={(id) => {
                  if (id === selectedRepositoryId) return;
                  setRequestedRepositoryId(id);
                  setCheckoutPath('');
                  setCheckoutQuery('');
                  setComparison('local');
                  setCommitRef('');
                  setPreviewResult(undefined);
                }}
              />
            </fieldset> : null}
            {importing ? (
              <ImportWorkFields key={selectedRepositoryId} checkouts={checkoutOptions} selected={selectedCheckout} locked={composerLocked}
                query={checkoutQuery} onQuery={setCheckoutQuery}
                onSelect={(value) => {
                  if (value === checkoutPath) return;
                  setCheckoutPath(value); setPreviewResult(undefined); setError(undefined);
                }}
                comparison={comparison} onComparison={(value) => {
                  if (value === comparison) return;
                  setComparison(value); setPreviewResult(undefined); setError(undefined);
                }}
                commitRef={commitRef} onCommitRef={(value) => {
                  if (value === commitRef) return;
                  setCommitRef(value); setPreviewResult(undefined); setError(undefined);
                }}
                preview={currentPreview?.data} previewError={currentPreview?.error}
                title={effectiveImportTitle} onTitle={setImportTitle} repositoryName={selectedRepository?.name}
                onRetry={() => { setCheckouts(undefined); setPreviewResult(undefined); setCheckoutRefresh((value) => value + 1); }}
              />
            ) : null}
            {!importing ? <>
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
                {!importing ? <span className="field__header-actions">
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
                      Boolean(currentProposal)
                    }
                    aria-busy={isRefining}
                    title={refineDisabledReason}
                    onClick={() => void refine()}
                  >
                    <AgentMark size={13} />
                    <span className={`field__refine-label${isRefining ? ' tm-shimmer' : ''}`}>
                      {isRefining ? 'Refining' : 'Refine'}
                    </span>
                  </button>
                </span> : null}
              </span>
              <AttachmentComposerShell
                attachments={attachments}
                toolbarStart={runChips}
                attachmentLabel="Task attachments"
                toolbarAction={
                  <AgentProfileSelect
                    profiles={agentProfiles}
                    value={agentProfileId}
                    disabled={composerLocked}
                    onChange={(profileId) => {
                      setAgentProfileId(profileId);
                      onTextDraftChange?.({ title, prompt, agentProfileId: profileId });
                    }}
                  />
                }
                className={isRefining ? 'field__prompt-shell--running' : ''}
                bindDropTarget={false}
                removeDisabled={composerLocked}
                hint={
                  !effectiveAttachmentsEnabled
                    ? runtimeSupportsAttachments
                      ? 'Files are unavailable in this build'
                      : 'Files are unavailable for this runtime'
                    : isReadingClipboardImage ? 'Reading clipboard image…' : undefined
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
              {currentProposal ? (
                <RefinementProposal
                  refined={currentProposal.prompt}
                  onAccept={acceptProposal}
                  onRevert={revertProposal}
                />
              ) : null}
            </div>
            </> : null}
          </section>

          {importing && !selectedCheckout?.existingTaskId ? (
            <div className="tm-chip-row newtask-run">
              <span className="newtask-run__label">Agent</span>
              {runChips}
            </div>
          ) : null}

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {currentRefinementWarning ? (
            <p className="form-warning">{currentRefinementWarning}</p>
          ) : null}
          {/* Creating still works; only starting waits for the runtime, so this is a warning. */}
          {!importing && selectedRuntime && !selectedRuntimeReadiness.canStart ? (
            <p className="form-warning">
              {selectedRuntimeReadiness.detail}
              {selectedRuntimeReadiness.nextAction ? ` ${selectedRuntimeReadiness.nextAction}.` : ''}
            </p>
          ) : null}
          {!importing && selectedRuntime?.preflight.readiness.status === 'DEGRADED' ? (
            <p className="form-warning">{selectedRuntimeReadiness.detail}</p>
          ) : null}
        </div>

        <footer className="newtask-modal__footer">
          {importing ? <p className="import-work__footer-note" role="status">
            {importDisabledReason ?? (selectedCheckout?.existingTaskId ? 'This checkout is already tracked.' : 'Imports as In progress. No files move and no agent starts.')}
          </p> : (
            <span className="newtask-modal__hint" aria-hidden="true"><kbd>{CREATE_SHORTCUT}</kbd> to create</span>
          )}
          <div className="newtask-modal__footer-actions">
            <button
              type="button"
              className="outline-button"
              disabled={isSubmitting}
              onClick={closePanel}
            >
              {creationOutcomeUnknown ? 'Close' : 'Cancel'}
            </button>
            {!(importing && selectedCheckout?.existingTaskId) ? <button
              className="primary-button"
              type="submit"
              disabled={createDisabled}
              aria-busy={isSubmitting}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              aria-label={
                importing ? 'Import' : selectedRepository
                  ? `Create task in ${selectedRepository.name}`
                  : 'Create task'
              }
            >
              {importing ? (isSubmitting ? 'Importing…' : 'Import') : isSubmitting
                ? 'Creating…'
                : creationOutcomeUnknown
                  ? 'Retry creation'
                  : 'Create task'}
            </button> : null}
          </div>
        </footer>
      </form>
    </div>
  );
}

const CREATE_SHORTCUT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.userAgent) ? '⌘↵' : 'Ctrl+Enter';

export function refinementInputFingerprint(input: {
  repositoryId: string;
  title: string;
  prompt: string;
  runtimeId: string;
  modelId: string;
  attachmentRevision: number;
}): string {
  return JSON.stringify(input);
}

function createPromptRefinementRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `prompt-refine-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function CloseIcon() {
  return <X aria-hidden="true" size={15} />;
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
