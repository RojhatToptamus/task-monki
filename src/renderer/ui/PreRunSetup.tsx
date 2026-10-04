import { useId, useRef, useState } from 'react';
import type {
  AgentExecutionSettings,
  AgentModel,
  AgentRuntimeState,
  InstructionAttachments,
  WorktreeRecord
} from '../../shared/contracts';
import type { AttachmentContent, TaskAttachmentRecord } from '../../shared/attachments';
import {
  matchingExecutionPolicyPreset,
  settingsForExecutionPolicyPreset
} from '../model/agentPermissions';
import {
  resolveReasoningEffort,
  selectModel
} from '../model/agentExecutionSettings';
import { AgentModelSelector } from './AgentModelSelector';
import { ExecutionPolicySelect } from './NewTaskPanel';
import { AttachmentComposerShell } from './AttachmentComposerShell';
import { StoredAttachmentChip } from './AttachmentChip';
import { useTaskAttachments, type UseTaskAttachmentsOptions } from './useTaskAttachments';

export function PreRunSetup({
  prompt,
  promptDraft,
  onSavePrompt,
  attachments,
  attachmentOptions,
  onReadAttachment,
  worktree,
  runtimeId,
  settings,
  models,
  runtimes,
  disabled,
  action,
  onSettingsChange,
  onDiscoverModels
}: {
  prompt: string;
  promptDraft?: string;
  onSavePrompt(prompt: string, draftOnly?: boolean, files?: InstructionAttachments): Promise<void>;
  attachments: TaskAttachmentRecord[];
  attachmentOptions: Omit<UseTaskAttachmentsOptions, 'blocked' | 'preserveDraftOnClose'>;
  onReadAttachment(id: string): Promise<AttachmentContent>;
  worktree?: WorktreeRecord;
  runtimeId: string;
  settings: AgentExecutionSettings;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  disabled?: boolean;
  action?: { label: string; disabled?: boolean; title?: string; onClick(): void };
  onSettingsChange(settings: AgentExecutionSettings): void;
  onDiscoverModels?(runtimeId: string): Promise<void>;
}) {
  const [text, setText] = useState(promptDraft ?? prompt);
  const [saved, setSaved] = useState(prompt);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const writes = useRef<Promise<void>>(Promise.resolve());
  const pendingText = useRef<string | undefined>(undefined);
  const selectedModel = selectModel(models, settings.model, runtimeId, settings.modelProvider);
  const files = useTaskAttachments({ ...attachmentOptions, model: selectedModel, blocked: saving, preserveDraftOnClose: true });
  const dirty = text.trim() !== saved || !text.trim() || files.items.length > 0;
  const changePrompt = (value: string) => {
    setText(value);
    pendingText.current = value;
    writes.current = writes.current.catch(() => undefined).then(async () => {
      if (pendingText.current === undefined) return;
      const draft = pendingText.current;
      pendingText.current = undefined;
      await onSavePrompt(draft, true);
      setSaveError(undefined);
    });
    void writes.current.catch(() => setSaveError('Draft could not be saved. Keep this page open and try Save again.'));
  };
  const savePrompt = async () => {
    if (saving || files.busy || files.hasErrors || files.modelError || !text.trim()) return;
    setSaving(true);
    try {
      await writes.current.catch(() => undefined);
      const attachmentDraftId = await files.flushDraft();
      await onSavePrompt(text, false, attachmentDraftId ? { attachmentDraftId } : undefined);
      await files.finishAdoption();
      setSaved(text.trim());
      setText(text.trim());
      setSaveError(undefined);
    } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  const availableRuntimes = runtimes.filter((runtime) => runtime.preflight.runtime.id === runtimeId);
  const selected = availableRuntimes[0];
  const presets = selected?.preflight.capabilities.executionPolicy.presets ?? [];
  const preset = matchingExecutionPolicyPreset(presets, settings);
  const networkLocked = preset?.networkAccess === 'DISABLED' || preset?.networkAccess === 'REQUIRED';
  const networkOn = preset?.networkAccess === 'REQUIRED' || (preset?.networkAccess !== 'DISABLED' && settings.networkAccess === true);
  const networkLabelId = useId();

  return <section className="tm-prerun" aria-label="Start this task">
    <form onSubmit={(event) => { event.preventDefault(); void savePrompt(); }}>
      <AttachmentComposerShell attachments={files} attachmentLabel="Prompt attachments" addButtonTitle="Attach images or text files"
        hint={dirty ? 'Unsaved prompt' : 'Task prompt'} toolbarAction={
          <button type="submit" className="outline-button" disabled={saving || files.busy || files.hasErrors || Boolean(files.modelError) || !dirty || !text.trim()}>{saving ? 'Saving…' : 'Save prompt'}</button>
        }>
      <label className="tm-visually-hidden" htmlFor="initial-task-prompt">Task prompt</label>
      <textarea className="tm-composer__input" id="initial-task-prompt" rows={4} value={text} readOnly={saving} maxLength={65_536}
        onPaste={files.paste}
        onChange={(event) => changePrompt(event.target.value)}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault(); void savePrompt();
          }
        }} />
      {attachments.length ? <ul className="task-attachments" aria-label="Saved prompt attachments">
        {attachments.map((attachment) => <StoredAttachmentChip key={attachment.id} attachment={attachment} onRead={() => onReadAttachment(attachment.id)} />)}
      </ul> : null}
      </AttachmentComposerShell>
    </form>
    {saveError ? <p className="tm-error" role="alert">{saveError}</p> : null}
    {files.draftError || files.modelError || files.overflowError ? <p className="tm-error" role="alert">{files.draftError ?? files.modelError ?? files.overflowError}</p> : null}
    <div className="tm-prerun__settings">
      <AgentModelSelector
        label="Model"
        presentation="full"
        runtimeId={runtimeId}
        modelId={selectedModel?.id ?? settings.model ?? ''}
        reasoningEffort={settings.reasoningEffort}
        models={models}
        runtimes={availableRuntimes}
        disabled={disabled}
        fallbackSummary={settings.model}
        runtimeUnavailableReason={(runtime) => runtime.preflight.readiness.canStart ? undefined : (runtime.preflight.readiness.detail ?? runtime.preflight.readiness.summary)}
        onDiscoverModels={onDiscoverModels}
        onSelectionChange={(nextRuntimeId, nextModelId) => {
          const model = selectModel(models, nextModelId, nextRuntimeId);
          onSettingsChange({
            ...settings,
            runtimeId: nextRuntimeId,
            model: model?.model ?? nextModelId,
            modelProvider: model?.modelProvider,
            reasoningEffort: resolveReasoningEffort(model, settings.reasoningEffort)
          });
        }}
        onReasoningEffortChange={(value) => onSettingsChange({ ...settings, reasoningEffort: value })}
        access={presets.length ? <div className="tm-agent-console__row">
          <span className="tm-agent-console__label">Access</span>
          <div className="tm-agent-console__access">
            <ExecutionPolicySelect
              presets={presets}
              selectedPreset={preset}
              unmatchedSummary={{ label: 'Custom settings', detail: 'Saved execution settings do not match a preset.' }}
              disabled={Boolean(disabled)}
              onChange={(presetId) => {
                const next = presets.find((candidate) => candidate.id === presetId);
                if (!next) return;
                onSettingsChange({
                  ...settings,
                  ...settingsForExecutionPolicyPreset(next, { networkAccess: settings.networkAccess })
                });
              }}
            />
          </div>
        </div> : undefined}
      />
      {preset ? <div className="network-toggle">
        <div className="network-toggle__copy">
          <span className="network-toggle__title" id={networkLabelId}>Network</span>
          <span className="network-toggle__state">
            {preset.networkAccess === 'DISABLED' ? `Off · ${preset.label}`
              : preset.networkAccess === 'REQUIRED' ? `On · ${preset.label}`
              : networkOn ? 'On' : 'Off'}
          </span>
        </div>
        <button type="button" className={`network-toggle__switch${networkOn ? ' network-toggle__switch--on' : ''}`}
          role="switch" aria-labelledby={networkLabelId} aria-checked={networkOn}
          disabled={disabled || networkLocked}
          onClick={() => onSettingsChange({ ...settings, networkAccess: !networkOn })}>
          <span />
        </button>
      </div> : null}
      {worktree?.status === 'PRESENT' ? <p className="tm-prerun__worktree">
        {worktree.branchName ?? 'Detached'}{worktree.baseRef ? ` · ${worktree.baseRef}` : ''}
      </p> : null}
    </div>
    {action ? <div className="tm-prerun__action">
      <button type="button" className="primary-button" disabled={action.disabled || saving || dirty || files.busy} title={dirty ? 'Save the prompt before continuing' : action.title} onClick={action.onClick}>
        {action.label}
      </button>
    </div> : null}
  </section>;
}
