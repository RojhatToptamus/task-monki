import { useId } from 'react';
import type {
  AgentExecutionSettings,
  AgentModel,
  AgentRuntimeState,
  WorktreeRecord
} from '../../shared/contracts';
import type { TaskAttachmentRecord } from '../../shared/attachments';
import {
  matchingExecutionPolicyPreset,
  settingsForExecutionPolicyPreset
} from '../model/agentPermissions';
import {
  resolveReasoningEffort,
  selectModel
} from '../model/agentExecutionSettings';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { AgentModelSelector } from './AgentModelSelector';
import { ExecutionPolicySelect } from './NewTaskPanel';
import { Message, MessageContent } from './Message';

export function PreRunSetup({
  prompt,
  attachments,
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
  attachments: TaskAttachmentRecord[];
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
  const availableRuntimes = runtimes.filter((runtime) => runtime.preflight.runtime.id === runtimeId);
  const selected = availableRuntimes[0];
  const presets = selected?.preflight.capabilities.executionPolicy.presets ?? [];
  const preset = matchingExecutionPolicyPreset(presets, settings);
  const networkLocked = preset?.networkAccess === 'DISABLED' || preset?.networkAccess === 'REQUIRED';
  const networkOn = preset?.networkAccess === 'REQUIRED' || (preset?.networkAccess !== 'DISABLED' && settings.networkAccess === true);
  const networkLabelId = useId();
  const selectedModel = selectModel(models, settings.model, runtimeId, settings.modelProvider);

  return <section className="tm-prerun" aria-label="Start this task">
    <Message from="user" label="Your request">
      <MessageContent user><p>{prompt}</p></MessageContent>
    </Message>
    {attachments.length ? <ul className="tm-prerun__files" aria-label="Task attachments">
      {attachments.map((attachment) => <li key={attachment.id}>
        <span title={attachment.displayName}>{attachment.displayName}</span>
        <span>{attachment.kind === 'image' ? 'Image' : 'Text'} · {formatAttachmentBytes(attachment.byteCount)}</span>
      </li>)}
    </ul> : null}
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
      <button type="button" className="primary-button" disabled={action.disabled} title={action.title} onClick={action.onClick}>
        {action.label}
      </button>
    </div> : null}
  </section>;
}
