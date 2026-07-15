import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent
} from 'react';
import type {
  AgentExecutionSettings,
  AgentModel,
  AgentPreflight,
  CreateTaskRequest,
  RefinePromptResponse
} from '../../shared/contracts';
import {
  ATTACHMENT_FILE_INPUT_ACCEPT,
  type AttachmentDraftSnapshot,
  type ClipboardAttachmentImage,
  type DiscardTaskAttachmentDraftRequest,
  type StageTaskAttachmentBatchRequest
} from '../../shared/attachments';
import {
  AGENT_PERMISSION_MODE_OPTIONS,
  settingsForPermissionMode,
  type SelectableAgentPermissionMode
} from '../model/agentPermissions';
import {
  formatAttachmentBytes
} from '../model/taskAttachmentDraft';
import {
  getOrCreateTaskCreationToken,
  taskCreationNeedsUnchangedRetry,
  type AttachmentComposerItem
} from '../model/taskAttachmentComposer';
import { useTaskAttachments } from './useTaskAttachments';

interface NewTaskPanelProps {
  repositoryId: string;
  models: AgentModel[];
  preflight?: AgentPreflight;
  defaultAgentSettings?: AgentExecutionSettings;
  disabled?: boolean;
  attachmentsEnabled?: boolean;
  onCreate(input: CreateTaskRequest): Promise<void>;
  onRefinePrompt(repositoryId: string, input: string): Promise<RefinePromptResponse>;
  onStageAttachmentBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscardAttachmentDraft(input: DiscardTaskAttachmentDraftRequest): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  onClose(): void;
}

export function NewTaskPanel({
  repositoryId,
  models,
  preflight,
  defaultAgentSettings,
  disabled,
  attachmentsEnabled = true,
  onCreate,
  onRefinePrompt,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onClose
}: NewTaskPanelProps) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [permissionMode, setPermissionMode] =
    useState<SelectableAgentPermissionMode>('SANDBOXED');
  const [networkAccess, setNetworkAccess] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [isRefining, setIsRefining] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [creationOutcomeUnknown, setCreationOutcomeUnknown] = useState(false);
  const panelRef = useRef<HTMLFormElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );
  const submittingRef = useRef(false);
  const taskCreationTokenRef = useRef<string | undefined>(undefined);
  // Refinement remains a reversible proposal instead of overwriting user input.
  const [proposal, setProposal] = useState<{ prompt: string; titleSuggestion: string }>();
  const [restorable, setRestorable] = useState<string>();

  useEffect(() => {
    if (model) {
      return;
    }
    const defaultModel =
      models.find((candidate) => candidate.model === defaultAgentSettings?.model) ??
      models.find((candidate) => candidate.isDefault) ??
      models[0];
    if (defaultModel) {
      setModel(defaultModel.model);
      setReasoningEffort(
        defaultAgentSettings?.reasoningEffort ?? defaultModel.defaultReasoningEffort ?? ''
      );
    }
  }, [defaultAgentSettings?.model, defaultAgentSettings?.reasoningEffort, model, models]);

  const selectedModel = models.find((candidate) => candidate.model === model);
  const selectedRepositoryId = repositoryId.trim();
  const sandboxedSelected = permissionMode === 'SANDBOXED';
  const fullAccessSelected = permissionMode === 'FULL_ACCESS';
  const reasoningEfforts = [
    ...new Set(
      [
        ...(selectedModel?.supportedReasoningEfforts ?? []),
        selectedModel?.defaultReasoningEffort,
        reasoningEffort
      ].filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
    )
  ];

  const composerLocked = Boolean(disabled) || isSubmitting || creationOutcomeUnknown;
  const attachments = useTaskAttachments({
    enabled: attachmentsEnabled,
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
    (fullAccessSelected || (!sandboxedSelected && networkAccess));
  const selectedModelRejectsImages = Boolean(attachmentModelError);

  useEffect(
    () => () => {
      const previouslyFocusedElement = previouslyFocusedElementRef.current;
      queueMicrotask(() => {
        if (panelClosedRef.current && previouslyFocusedElement?.isConnected) {
          previouslyFocusedElement.focus();
        }
      });
    },
    [panelClosedRef]
  );

  const closePanel = useCallback(() => {
    if (panelClosedRef.current || submittingRef.current) return;
    closeAttachments();
    onClose();
  }, [closeAttachments, onClose, panelClosedRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePanel();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, input, textarea, select, summary, [tabindex]'
        )
      ).filter(
        (element) =>
          !element.hasAttribute('disabled') &&
          element.tabIndex >= 0 &&
          element.getAttribute('aria-hidden') !== 'true' &&
          element.offsetParent !== null
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closePanel]);

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
    try {
      const attachmentDraftId = await attachments.prepareForCreate();
      const permissionSettings = settingsForPermissionMode(permissionMode, {
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
            model: model || undefined,
            modelProvider: defaultAgentSettings?.modelProvider ?? 'openai',
            reasoningEffort: reasoningEffort || undefined,
            ...permissionSettings
          }
        });
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
    }
  };

  const refine = async () => {
    setError(undefined);
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
    setPrompt(proposal.prompt);
    setTitle((current) => current || proposal.titleSuggestion);
    setProposal(undefined);
  };

  const revertProposal = () => setProposal(undefined);

  const restoreOriginal = () => {
    if (restorable === undefined) {
      return;
    }
    setPrompt(restorable);
    setRestorable(undefined);
  };

  const createDisabled =
    Boolean(disabled) ||
    isSubmitting ||
    isRefining ||
    !title.trim() ||
    !prompt.trim() ||
    !selectedRepositoryId ||
    attachmentsBusy ||
    attachmentsHaveErrors ||
    selectedModelRejectsImages;

  return (
    <div
      className="slideover"
      onClick={closePanel}
      onDragEnter={enterAttachmentDrag}
      onDragOver={continueAttachmentDrag}
      onDragLeave={leaveAttachmentDrag}
      onDrop={dropAttachments}
    >
      <form
        ref={panelRef}
        className="slideover__panel"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="New task"
      >
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
            <label className="field">
              <span>Title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Short imperative summary"
                disabled={composerLocked}
                autoFocus
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
                      !prompt.trim() ||
                      !selectedRepositoryId ||
                      Boolean(proposal)
                    }
                    aria-busy={isRefining}
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
                  onChange={(event) => setPrompt(event.target.value)}
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
                        ? 'Choose a managed permission mode to attach files.'
                        : attachmentsEnabled
                          ? 'Stored locally and shared read-only with Codex for this task.'
                          : 'Attachments require file-read isolation between tasks.'
                    }
                    onClick={() => attachmentInputRef.current?.click()}
                  >
                    <PaperclipIcon />
                    <span>Add files</span>
                  </button>
                  <span className="task-attachment-hint">
                    {fullAccessSelected
                      ? 'Unavailable with Full access'
                      : !attachmentsEnabled
                      ? 'Unavailable in this build'
                      : isReadingClipboardImage
                      ? 'Reading clipboard image…'
                      : activeAttachmentItems.length > 0
                      ? `${activeAttachmentItems.length} ${
                          activeAttachmentItems.length === 1 ? 'file' : 'files'
                        } · ${formatAttachmentBytes(attachmentByteCount)}`
                      : 'Paste or drop files'}
                  </span>
                </div>
                {attachmentsEnabled && isDraggingFiles ? (
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
                {selectedModel?.displayName ?? 'Default model'}
                {reasoningEffort ? ` · ${formatEffortLabel(reasoningEffort)}` : ''}
              </span>
              <ChevronIcon />
            </summary>

            <div className="newtask-settings__content">
              <div className="field-grid field-grid--two">
                <label className="field">
                  <span className="field__label">Codex model</span>
                  <select
                    value={model}
                    onChange={(event) => {
                      const nextModel = models.find(
                        (candidate) => candidate.model === event.target.value
                      );
                      setModel(event.target.value);
                      setReasoningEffort(nextModel?.defaultReasoningEffort ?? '');
                    }}
                    disabled={composerLocked || models.length === 0}
                  >
                    {models
                      .filter((candidate) => !candidate.hidden || candidate.model === model)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.model}>
                          {candidate.displayName}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="field">
                  <span className="field__label">Reasoning effort</span>
                  <div className="segmented-effort" role="group" aria-label="Reasoning effort">
                    {reasoningEfforts.map((effort) => (
                      <button
                        key={effort}
                        type="button"
                        className={`segmented-effort__button ${
                          effort === reasoningEffort ? 'segmented-effort__button--active' : ''
                        }`}
                        disabled={composerLocked || !selectedModel}
                        aria-pressed={effort === reasoningEffort}
                        onClick={() => setReasoningEffort(effort)}
                      >
                        {formatEffortLabel(effort)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="field-grid">
                <label className="field">
                  <span className="field__label">
                    Permission mode
                    <HelpTooltip>Applies to this task's implementation runs.</HelpTooltip>
                  </span>
                  <select
                    value={permissionMode}
                    onChange={(event) =>
                      setPermissionMode(event.target.value as SelectableAgentPermissionMode)
                    }
                    disabled={composerLocked}
                  >
                    {AGENT_PERMISSION_MODE_OPTIONS.map((option) => (
                      <option
                        key={option.value}
                        value={option.value}
                        disabled={
                          option.value === 'FULL_ACCESS' && activeAttachmentItems.length > 0
                        }
                      >
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="network-toggle">
                <div className="network-toggle__copy">
                  <span className="network-toggle__title" id="task-network-access-label">
                    Network access
                  </span>
                  <span className="network-toggle__state">
                    {attachmentsRestrictNetwork
                      ? 'Disabled while attachments are included.'
                      : sandboxedSelected
                        ? 'Disabled by Sandboxed mode.'
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
                    sandboxedSelected ||
                    fullAccessSelected ||
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
          {!preflight?.ready ? (
            <p className="form-error">
              {preflight?.problems.join(' ') ||
                'Codex App Server is unavailable. You can create the task now and start it after Codex is ready.'}
            </p>
          ) : null}
          {preflight?.warnings.map((warning) => (
            <p className="form-warning" key={warning}>
              {warning}
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

function HelpTooltip({ children }: { children: string }) {
  return (
    <span className="info-tip" onClick={(event) => event.preventDefault()}>
      <button type="button" className="info-tip__button" aria-label="More info">
        <InfoIcon />
      </button>
      <span className="info-tip__bubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}

function InfoIcon() {
  return (
    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none">
      <path d="M12 11v6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="12" cy="6.5" r="1.6" fill="currentColor" />
    </svg>
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

function formatEffortLabel(effort: string): string {
  if (effort.toLowerCase() === 'xhigh') {
    return 'X-high';
  }
  return effort.charAt(0).toUpperCase() + effort.slice(1);
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
