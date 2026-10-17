import { useRef, useState } from 'react';
import type {
  AgentExecutionSettings,
  AgentModel,
  AgentRuntimeState,
  InstructionAttachments
} from '../../shared/contracts';
import type { AttachmentContent, TaskAttachmentRecord } from '../../shared/attachments';
import {
  resolveReasoningEffort,
  selectModel
} from '../model/agentExecutionSettings';
import { matchingExecutionPolicyPreset, presetNetworkAccess, settingsForExecutionPolicyPreset } from '../model/agentPermissions';
import { AgentModelSelector } from './AgentModelSelector';
import { AccessMenu } from './AccessMenu';
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
  runtimeId: string;
  settings: AgentExecutionSettings;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  disabled?: boolean;
  /** Starting receives the request just saved. */
  action?: { label: string; disabled?: boolean; title?: string; onClick(request: string): void };
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
    void writes.current.catch(() => setSaveError('The draft could not be saved. Keep this page open and try again.'));
  };
  const savePrompt = async (): Promise<boolean> => {
    if (saving || files.busy || files.hasErrors || files.modelError || !text.trim()) return false;
    setSaving(true);
    try {
      await writes.current.catch(() => undefined);
      const attachmentDraftId = await files.flushDraft();
      await onSavePrompt(text, false, attachmentDraftId ? { attachmentDraftId } : undefined);
      await files.finishAdoption();
      setSaved(text.trim());
      setText(text.trim());
      setSaveError(undefined);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    } finally { setSaving(false); }
  };
  // Starting saves the prompt first, so there is no separate save step.
  const submit = async () => {
    if (dirty && !(await savePrompt())) return;
    if (action && !action.disabled) action.onClick(text.trim());
  };
  const availableRuntimes = runtimes.filter((runtime) => runtime.preflight.runtime.id === runtimeId);
  const readiness = availableRuntimes[0]?.preflight.readiness;
  const runtimeReason = readiness && !readiness.canStart ? readiness.detail ?? readiness.summary : undefined;
  const presets = availableRuntimes[0]?.preflight.capabilities.executionPolicy.presets ?? [];
  const preset = matchingExecutionPolicyPreset(presets, settings);
  const fileError = files.draftError ?? files.modelError ?? files.overflowError;
  const canSubmit = !saving && !files.busy && !files.hasErrors && !files.modelError && text.trim().length > 0
    && (action ? !action.disabled : dirty);

  return <section className="tm-prerun" aria-label="Start this task">
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <AttachmentComposerShell
        className="tm-prerun__composer"
        attachments={files}
        attachmentLabel="Prompt attachments"
        // A disabled action says why where everyone can read it, not only in a hover title.
        hint={saveError ?? fileError ?? runtimeReason ?? (action?.disabled ? action.title : undefined)}
        toolbarStart={<>
          <AgentModelSelector
            label="Model"
            presentation="compact"
            runtimeId={runtimeId}
            modelId={selectedModel?.id ?? settings.model ?? ''}
            reasoningEffort={settings.reasoningEffort}
            models={models}
            runtimes={availableRuntimes}
            disabled={disabled}
            fallbackSummary={settings.model}
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
          />
          {presets.length ? <AccessMenu
            presets={presets}
            selected={preset}
            networkOn={presetNetworkAccess(preset, settings.networkAccess)}
            disabled={disabled}
            onPresetChange={(next) => onSettingsChange({ ...settings, ...settingsForExecutionPolicyPreset(next, { networkAccess: settings.networkAccess }) })}
            onNetworkChange={(networkAccess) => onSettingsChange({ ...settings, networkAccess })}
          /> : null}
        </>}
        toolbarAction={action
          ? <button type="submit" className="primary-button button--sm" disabled={!canSubmit} title={action.title}>{action.label}</button>
          : <button type="submit" className="outline-button button--sm" disabled={!canSubmit}>{saving ? 'Saving…' : 'Save'}</button>}
      >
        <label className="tm-visually-hidden" htmlFor="initial-task-prompt">Task prompt</label>
        <textarea className="tm-composer__input" id="initial-task-prompt" rows={8} value={text} readOnly={saving} maxLength={65_536}
          placeholder="Describe the task"
          onPaste={files.paste}
          onChange={(event) => changePrompt(event.target.value)}
          onKeyDown={(event) => {
            if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault(); void submit();
            }
          }} />
        {attachments.length ? <ul className="task-attachments" aria-label="Saved prompt attachments">
          {attachments.map((attachment) => <StoredAttachmentChip key={attachment.id} attachment={attachment} onRead={() => onReadAttachment(attachment.id)} />)}
        </ul> : null}
      </AttachmentComposerShell>
    </form>
  </section>;
}
