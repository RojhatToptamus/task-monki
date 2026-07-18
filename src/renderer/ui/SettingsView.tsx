import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_PROMPT_REFINEMENT_MODEL,
  type AgentModel,
  type AgentRuntimeState,
  type ExternalToolId,
  type ExternalToolProbeResult,
  type ExternalToolStatusReport,
  type TaskManagerAppSettings,
  type TestExternalToolRequest,
  type UpdateAppSettingsRequest
} from '../../shared/contracts';
import { resolveReasoningEffort, selectModel } from '../model/agentExecutionSettings';
import {
  buildExecutableTestRequest,
  selectExecutableDisplayStatus
} from '../model/executableSettings';
import { runtimeReadinessView } from '../model/runtimeReadiness';
import type { ThemePreference } from './theme';

type SettingsSection = 'agents' | 'models' | 'tools' | 'appearance';

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'models', label: 'Models' },
  { id: 'tools', label: 'Tools' },
  { id: 'appearance', label: 'Appearance' }
];

export interface SettingsViewProps {
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  appSettings: TaskManagerAppSettings;
  onSetAppSettings(
    settings: UpdateAppSettingsRequest,
    successMessage?: string
  ): void | Promise<unknown>;
  externalToolStatus?: ExternalToolStatusReport;
  agentRuntimesLoading: boolean;
  onRefreshExternalTools(): Promise<void>;
  onRefreshAgentRuntimes(): Promise<void>;
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
}

export function SettingsView(props: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>('agents');

  return (
    <div className="tm-settings">
      <div className="tm-settings__inner">
        <nav className="tm-settings__nav tm-tabs" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`tm-tab ${section === item.id ? 'tm-tab--active' : ''}`}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {section === 'agents' ? <AgentSettings {...props} /> : null}
        {section === 'models' ? <ModelSettings {...props} /> : null}
        {section === 'tools' ? <ToolSettings {...props} /> : null}
        {section === 'appearance' ? <AppearanceSettings {...props} /> : null}
      </div>
    </div>
  );
}

function AgentSettings({
  appSettings,
  onSetAppSettings,
  externalToolStatus,
  onRefreshAgentRuntimes,
  onTestExternalTool,
  runtimes,
  agentRuntimesLoading
}: SettingsViewProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [updatingRuntime, setUpdatingRuntime] = useState(false);
  const catalogLoading = agentRuntimesLoading || refreshing;
  const disabledRuntimeIds = useMemo(
    () => new Set(appSettings.disabledRuntimeIds),
    [appSettings.disabledRuntimeIds]
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshAgentRuntimes();
    } finally {
      setRefreshing(false);
    }
  };

  const setRuntimeEnabled = async (runtimeId: string, enabled: boolean) => {
    const nextDisabledRuntimeIds = enabled
      ? appSettings.disabledRuntimeIds.filter((candidate) => candidate !== runtimeId)
      : [...new Set([...appSettings.disabledRuntimeIds, runtimeId])];
    setUpdatingRuntime(true);
    try {
      await onSetAppSettings({ disabledRuntimeIds: nextDisabledRuntimeIds });
    } finally {
      setUpdatingRuntime(false);
    }
  };

  return (
    <SettingsPane
      title="Agents"
      detail="Choose which coding agents Task Monki can use."
      action={
        <button
          type="button"
          className="tm-settings__button"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? 'Checking…' : 'Recheck'}
        </button>
      }
    >
      <div className="tm-settings__list">
        {runtimes.map((runtime) => {
          const runtimeId = runtime.preflight.runtime.id;
          const isDisabled = disabledRuntimeIds.has(runtimeId);
          const disableReason = isDisabled
            ? undefined
            : runtimeDisableReason(appSettings, runtimeId);
          const isCodex = runtimeId === 'codex';
          const executablePath = isCodex
            ? appSettings.externalExecutables.codexExecutablePath
            : (appSettings.runtimeExecutablePaths[runtimeId] ?? null);

          return (
            <AgentRuntimeSetting
              key={runtimeId}
              runtime={runtime}
              enabled={!isDisabled}
              executablePath={executablePath}
              toggleDisabled={updatingRuntime || Boolean(disableReason)}
              toggleDisabledReason={disableReason}
              onSetEnabled={(enabled) => setRuntimeEnabled(runtimeId, enabled)}
              onSetExecutablePath={(path) =>
                isCodex
                  ? onSetAppSettings({
                      externalExecutables: { codexExecutablePath: path }
                    })
                  : onSetAppSettings({
                      runtimeExecutablePaths: { [runtimeId]: path }
                    })
              }
              tool={isCodex ? 'codex' : undefined}
              toolStatus={isCodex ? externalToolStatus?.tools.codex : undefined}
              onTestExternalTool={onTestExternalTool}
            />
          );
        })}
        {runtimes.length === 0 ? (
          <div
            className="tm-settings__empty"
            role={catalogLoading ? 'status' : undefined}
            aria-live={catalogLoading ? 'polite' : undefined}
          >
            {catalogLoading ? 'Checking agents…' : 'No agent runtimes found.'}
          </div>
        ) : null}
      </div>
    </SettingsPane>
  );
}

function AgentRuntimeSetting({
  runtime,
  enabled,
  executablePath,
  toggleDisabled,
  toggleDisabledReason,
  onSetEnabled,
  onSetExecutablePath,
  tool,
  toolStatus,
  onTestExternalTool
}: {
  runtime: AgentRuntimeState;
  enabled: boolean;
  executablePath: string | null;
  toggleDisabled: boolean;
  toggleDisabledReason?: string;
  onSetEnabled(enabled: boolean): void;
  onSetExecutablePath(path: string | null): void;
  tool?: ExternalToolId;
  toolStatus?: ExternalToolProbeResult;
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
}) {
  const readiness = runtimeReadinessView(runtime);
  const statusId = `agent-runtime-${runtime.preflight.runtime.id}-status`;
  const readinessTone = enabled ? readiness.tone : 'muted';
  const statusDetail = enabled
    ? [
        readiness.label,
        runtime.preflight.runtimeVersion,
        !readiness.canStart ? readiness.nextAction : undefined,
        toggleDisabledReason
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Disabled';

  return (
    <article className="tm-agent-setting">
      <div className="tm-agent-setting__summary">
        <div className="tm-agent-setting__identity">
          <span
            className={`tm-settings-status-dot tm-settings-status-dot--${readinessTone}`}
            aria-hidden="true"
          />
          <div>
            <h3>{runtime.preflight.runtime.displayName}</h3>
            <p id={statusId}>{statusDetail}</p>
          </div>
        </div>
        <SettingsSwitch
          label={`${runtime.preflight.runtime.displayName} enabled`}
          checked={enabled}
          disabled={toggleDisabled}
          describedBy={toggleDisabledReason ? statusId : undefined}
          onChange={onSetEnabled}
        />
      </div>

      <details className="tm-agent-setting__details">
        <summary>
          <span>Executable</span>
          <span>{executablePath ? 'Custom path' : 'Auto-detect'}</span>
        </summary>
        <div className="tm-agent-setting__editor">
          <ExecutablePathEditor
            label={`${runtime.preflight.runtime.displayName} executable`}
            value={executablePath}
            tool={tool}
            status={toolStatus}
            onSetPath={onSetExecutablePath}
            onTest={onTestExternalTool}
          />
        </div>
      </details>
    </article>
  );
}

function ModelSettings({ appSettings, onSetAppSettings, models, runtimes }: SettingsViewProps) {
  const disabledRuntimeIds = useMemo(
    () => new Set(appSettings.disabledRuntimeIds),
    [appSettings.disabledRuntimeIds]
  );
  const enabledRuntimes = runtimes.filter(
    (runtime) => !disabledRuntimeIds.has(runtime.preflight.runtime.id)
  );
  const enabledRuntimeIds = new Set(
    enabledRuntimes.map((runtime) => runtime.preflight.runtime.id)
  );
  const enabledModels = models.filter((model) => enabledRuntimeIds.has(model.runtimeId));
  const selected = selectSettingsModels(enabledModels, enabledRuntimes, appSettings);
  const promptRefinementRuntimes = enabledRuntimes.filter(
    (runtime) =>
      runtime.preflight.readiness.canStart &&
      runtime.preflight.capabilities.promptRefinement.maturity !== 'unsupported'
  );
  const reviewRuntimes = enabledRuntimes.filter(
    (runtime) =>
      runtime.preflight.readiness.canStart &&
      (runtime.preflight.capabilities.review.maturity !== 'unsupported' ||
        runtime.preflight.capabilities.extensions.genericDetachedReview?.maturity === 'stable')
  );

  return (
    <SettingsPane
      title="Models"
      detail="Defaults for implementation, prompt refinement, and review."
    >
      <div className="tm-model-defaults">
        <ModelSettingRow
          label="Implementation"
          runtimeId={selected.defaultRuntimeId}
          value={selected.selectedDefaultModel?.id ?? ''}
          effortValue={selected.selectedDefaultEffort}
          models={enabledModels}
          runtimes={enabledRuntimes}
          onRuntimeChange={(runtimeId) => {
            const nextModel = selectModel(enabledModels, undefined, runtimeId);
            onSetAppSettings({
              defaultRuntimeId: runtimeId,
              defaultModel: nextModel?.model ?? null,
              defaultModelProvider: nextModel?.modelProvider ?? null,
              defaultReasoningEffort: resolveReasoningEffort(nextModel, undefined) ?? null
            });
          }}
          onModelChange={(modelId) => {
            const nextModel = enabledModels.find((candidate) => candidate.id === modelId);
            onSetAppSettings({
              defaultModel: nextModel?.model ?? null,
              defaultModelProvider: nextModel?.modelProvider ?? null,
              defaultReasoningEffort:
                resolveReasoningEffort(nextModel, appSettings.defaultReasoningEffort) ?? null
            });
          }}
          onEffortChange={(reasoningEffort) =>
            onSetAppSettings({ defaultReasoningEffort: reasoningEffort || null })
          }
        />
        <ModelSettingRow
          label="Prompt refinement"
          runtimeId={selected.promptRefinementRuntimeId}
          value={selected.selectedPromptRefinementModel?.id ?? ''}
          models={enabledModels}
          runtimes={promptRefinementRuntimes}
          onRuntimeChange={(runtimeId) => {
            const nextModel = selectModel(enabledModels, undefined, runtimeId);
            onSetAppSettings({
              promptRefinementRuntimeId: runtimeId,
              promptRefinementModel: nextModel?.model ?? null,
              promptRefinementModelProvider: nextModel?.modelProvider ?? null
            });
          }}
          onModelChange={(modelId) => {
            const nextModel = enabledModels.find((candidate) => candidate.id === modelId);
            onSetAppSettings({
              promptRefinementModel: nextModel?.model ?? null,
              promptRefinementModelProvider: nextModel?.modelProvider ?? null
            });
          }}
        />
        <ModelSettingRow
          label="Review"
          runtimeId={selected.reviewRuntimeId}
          value={selected.selectedReviewModel?.id ?? ''}
          effortValue={selected.selectedReviewEffort}
          models={enabledModels}
          runtimes={reviewRuntimes}
          onRuntimeChange={(runtimeId) => {
            const nextModel = selectModel(enabledModels, undefined, runtimeId);
            onSetAppSettings({
              reviewRuntimeId: runtimeId,
              reviewModel: nextModel?.model ?? null,
              reviewModelProvider: nextModel?.modelProvider ?? null,
              reviewReasoningEffort: resolveReasoningEffort(nextModel, undefined) ?? null
            });
          }}
          onModelChange={(modelId) => {
            const nextModel = enabledModels.find((candidate) => candidate.id === modelId);
            onSetAppSettings({
              reviewModel: nextModel?.model ?? null,
              reviewModelProvider: nextModel?.modelProvider ?? null,
              reviewReasoningEffort:
                resolveReasoningEffort(nextModel, appSettings.reviewReasoningEffort) ?? null
            });
          }}
          onEffortChange={(reasoningEffort) =>
            onSetAppSettings({ reviewReasoningEffort: reasoningEffort || null })
          }
        />
      </div>
    </SettingsPane>
  );
}

interface SelectedSettingsModels {
  defaultRuntimeId: string;
  promptRefinementRuntimeId: string;
  reviewRuntimeId: string;
  selectedDefaultModel?: AgentModel;
  selectedPromptRefinementModel?: AgentModel;
  selectedReviewModel?: AgentModel;
  selectedDefaultEffort: string;
  selectedReviewEffort: string;
}

export function selectSettingsModels(
  models: AgentModel[],
  runtimes: AgentRuntimeState[],
  appSettings: TaskManagerAppSettings
): SelectedSettingsModels {
  const availableRuntimeIds = new Set([
    ...runtimes.map((runtime) => runtime.preflight.runtime.id),
    ...models.map((model) => model.runtimeId)
  ]);
  const firstRuntimeId =
    runtimes.find((runtime) => runtime.preflight.readiness.canStart)?.preflight.runtime.id ??
    runtimes[0]?.preflight.runtime.id ??
    models[0]?.runtimeId ??
    appSettings.defaultRuntimeId;
  const defaultRuntimeId = availableRuntimeIds.has(appSettings.defaultRuntimeId)
    ? appSettings.defaultRuntimeId
    : firstRuntimeId;
  const promptRefinementRuntimeIds = new Set(
    runtimes
      .filter(
        (runtime) =>
          runtime.preflight.readiness.canStart &&
          runtime.preflight.capabilities.promptRefinement.maturity !== 'unsupported'
      )
      .map((runtime) => runtime.preflight.runtime.id)
  );
  const reviewRuntimeIds = new Set(
    runtimes
      .filter(
        (runtime) =>
          runtime.preflight.readiness.canStart &&
          (runtime.preflight.capabilities.review.maturity !== 'unsupported' ||
            runtime.preflight.capabilities.extensions.genericDetachedReview?.maturity === 'stable')
      )
      .map((runtime) => runtime.preflight.runtime.id)
  );
  const promptRefinementRuntimeId =
    appSettings.promptRefinementRuntimeId &&
    promptRefinementRuntimeIds.has(appSettings.promptRefinementRuntimeId)
      ? appSettings.promptRefinementRuntimeId
      : promptRefinementRuntimeIds.has(defaultRuntimeId)
        ? defaultRuntimeId
        : ([...promptRefinementRuntimeIds][0] ?? defaultRuntimeId);
  const reviewRuntimeId =
    appSettings.reviewRuntimeId && reviewRuntimeIds.has(appSettings.reviewRuntimeId)
      ? appSettings.reviewRuntimeId
      : reviewRuntimeIds.has(defaultRuntimeId)
        ? defaultRuntimeId
        : ([...reviewRuntimeIds][0] ?? defaultRuntimeId);
  const selectedDefaultModel = selectModel(
    models,
    appSettings.defaultModel,
    defaultRuntimeId,
    appSettings.defaultModelProvider
  );
  const selectedPromptRefinementModel = selectModel(
    models,
    appSettings.promptRefinementModel ?? DEFAULT_PROMPT_REFINEMENT_MODEL,
    promptRefinementRuntimeId,
    appSettings.promptRefinementModelProvider
  );
  const selectedReviewModel = selectModel(
    models,
    appSettings.reviewModel,
    reviewRuntimeId,
    appSettings.reviewModelProvider
  );

  return {
    defaultRuntimeId,
    promptRefinementRuntimeId,
    reviewRuntimeId,
    selectedDefaultModel,
    selectedPromptRefinementModel,
    selectedReviewModel,
    selectedDefaultEffort:
      resolveReasoningEffort(selectedDefaultModel, appSettings.defaultReasoningEffort) ?? '',
    selectedReviewEffort:
      resolveReasoningEffort(selectedReviewModel, appSettings.reviewReasoningEffort) ?? ''
  };
}

export function ModelSettingRow({
  label,
  hint,
  runtimeId,
  value,
  effortValue = '',
  models,
  runtimes,
  onRuntimeChange,
  onModelChange,
  onEffortChange
}: {
  label: string;
  hint?: string;
  runtimeId: string;
  value: string;
  effortValue?: string;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  onRuntimeChange(value: string): void;
  onModelChange(value: string): void;
  onEffortChange?(value: string): void;
}) {
  const runtimeAvailable = runtimes.some(
    (runtime) => runtime.preflight.runtime.id === runtimeId
  );
  const runtimeModels = runtimeAvailable
    ? models.filter((model) => model.runtimeId === runtimeId)
    : [];
  const selected = runtimeModels.find((model) => model.id === value);
  const efforts = selected
    ? [
        ...new Set(
          [
            ...selected.supportedReasoningEfforts,
            selected.defaultReasoningEffort,
            effortValue
          ].filter((effort): effort is string => Boolean(effort))
        )
      ]
    : [];

  return (
    <div className="tm-model-default">
      <div className="tm-model-default__title">
        <strong>{label}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      <div className="tm-model-default__fields">
        <label>
          <span>Agent</span>
          <select
            className="tm-settings__select"
            value={runtimes.length > 0 ? runtimeId : ''}
            onChange={(event) => onRuntimeChange(event.target.value)}
            disabled={runtimes.length === 0}
          >
            {runtimes.length === 0 ? <option value="">Not available</option> : null}
            {runtimes.map((runtime) => (
              <option key={runtime.preflight.runtime.id} value={runtime.preflight.runtime.id}>
                {runtime.preflight.runtime.displayName}
                {runtimeReadinessView(runtime).optionSuffix}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Model</span>
          <select
            className="tm-settings__select"
            value={selected ? value : ''}
            onChange={(event) => onModelChange(event.target.value)}
            disabled={runtimeModels.length === 0}
          >
            {runtimeModels.length === 0 ? (
              <option value="">
                {runtimeAvailable ? 'Resolved when available' : 'Not available'}
              </option>
            ) : null}
            {runtimeModels
              .filter((model) => !model.hidden || model.id === value)
              .map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
          </select>
        </label>
        {onEffortChange && efforts.length > 0 ? (
          <label className="tm-model-default__effort">
            <span>Effort</span>
            <select
              className="tm-settings__select"
              value={effortValue}
              onChange={(event) => onEffortChange(event.target.value)}
            >
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {formatEffortLabel(effort)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </div>
  );
}

function ToolSettings({
  appSettings,
  onSetAppSettings,
  externalToolStatus,
  onRefreshExternalTools,
  onTestExternalTool
}: SettingsViewProps) {
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshExternalTools();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <SettingsPane
      title="Tools"
      detail="Repository delivery and Codex integrations."
      action={
        <button
          type="button"
          className="tm-settings__button"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? 'Checking…' : 'Recheck'}
        </button>
      }
    >
      <SettingsSubsection title="Executables">
        <div className="tm-settings__list">
          <ExecutableToolSetting
            tool="git"
            label="Git"
            hint="Required for repository evidence"
            value={appSettings.externalExecutables.gitExecutablePath}
            status={externalToolStatus?.tools.git}
            onSetPath={(gitExecutablePath) =>
              onSetAppSettings({ externalExecutables: { gitExecutablePath } })
            }
            onTest={onTestExternalTool}
          />
          <ExecutableToolSetting
            tool="gh"
            label="GitHub CLI"
            hint="Used for pull requests and delivery evidence"
            value={appSettings.externalExecutables.ghExecutablePath}
            status={externalToolStatus?.tools.gh}
            onSetPath={(ghExecutablePath) =>
              onSetAppSettings({ externalExecutables: { ghExecutablePath } })
            }
            onTest={onTestExternalTool}
          />
        </div>
      </SettingsSubsection>

      <SettingsSubsection title="Codex integrations">
        <div className="tm-settings__list">
          <ChoiceSettingRow
            label="Web search"
            value={appSettings.codexExternalTools.webSearchMode}
            options={[
              { value: 'disabled', label: 'Off' },
              { value: 'cached', label: 'Cached' },
              { value: 'live', label: 'Live' }
            ]}
            onChange={(webSearchMode) =>
              onSetAppSettings({ codexExternalTools: { webSearchMode } })
            }
          />
          <SettingsSwitchRow
            label="MCP servers"
            checked={appSettings.codexExternalTools.mcpServers === 'all'}
            onChange={(checked) =>
              onSetAppSettings({
                codexExternalTools: { mcpServers: checked ? 'all' : 'disabled' }
              })
            }
          />
          <SettingsSwitchRow
            label="Apps and connectors"
            checked={appSettings.codexExternalTools.apps === 'enabled'}
            onChange={(checked) =>
              onSetAppSettings({
                codexExternalTools: { apps: checked ? 'enabled' : 'disabled' }
              })
            }
          />
        </div>
      </SettingsSubsection>
    </SettingsPane>
  );
}

function AppearanceSettings({ theme, onSetTheme, appSettings, onSetAppSettings }: SettingsViewProps) {
  return (
    <SettingsPane title="Appearance" detail="Visual preferences for this device.">
      <div className="tm-settings__list">
        <div className="tm-settings__row">
          <span className="tm-settings__k">Theme</span>
          <div className="tm-segtoggle" role="group" aria-label="Theme">
            {(['light', 'dark', 'device'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`tm-segtoggle__btn ${theme === option ? 'tm-segtoggle__btn--active' : ''}`}
                aria-pressed={theme === option}
                onClick={() => onSetTheme(option)}
              >
                {option === 'device' ? 'Device' : option === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
        <SettingsSwitchRow
          label="Mascot animation"
          checked={appSettings.showMascot}
          onChange={(showMascot) => onSetAppSettings({ showMascot })}
        />
      </div>
    </SettingsPane>
  );
}

function SettingsPane({
  title,
  detail,
  action,
  children
}: {
  title: string;
  detail: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="tm-settings__pane" aria-labelledby={`settings-${title.toLowerCase()}`}>
      <header className="tm-settings__pane-head">
        <div>
          <h2 id={`settings-${title.toLowerCase()}`}>{title}</h2>
          <p>{detail}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function SettingsSubsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tm-settings__subsection">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function SettingsSwitchRow({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div className="tm-settings__row">
      <span className="tm-settings__k">{label}</span>
      <SettingsSwitch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

function SettingsSwitch({
  label,
  checked,
  disabled = false,
  describedBy,
  onChange
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  describedBy?: string;
  onChange(checked: boolean): void;
}) {
  return (
    <button
      type="button"
      className={`network-toggle__switch ${checked ? 'network-toggle__switch--on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function ChoiceSettingRow<Value extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: Value;
  options: Array<{ value: Value; label: string }>;
  onChange(value: Value): void;
}) {
  return (
    <label className="tm-settings__row">
      <span className="tm-settings__k">{label}</span>
      <select
        className="tm-settings__select tm-settings__select--compact"
        value={value}
        onChange={(event) => onChange(event.target.value as Value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ExecutableToolSetting({
  tool,
  label,
  hint,
  value,
  status,
  onSetPath,
  onTest
}: {
  tool: ExternalToolId;
  label: string;
  hint: string;
  value: string | null;
  status?: ExternalToolProbeResult;
  onSetPath(path: string | null): void;
  onTest(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
}) {
  const availability = describeExternalToolAvailability(status);

  return (
    <div className="tm-executable-setting">
      <div className="tm-executable-setting__head">
        <div>
          <h4>{label}</h4>
          <p>{hint}</p>
        </div>
        <span className="tm-settings-status">
          <span
            className={`tm-settings-status-dot tm-settings-status-dot--${availability.tone}`}
            aria-hidden="true"
          />
          {availability.label}
        </span>
      </div>
      <ExecutablePathEditor
        label={`${label} executable`}
        value={value}
        tool={tool}
        status={status}
        onSetPath={onSetPath}
        onTest={onTest}
      />
    </div>
  );
}

export function ExecutablePathEditor({
  label,
  value,
  tool,
  status,
  onSetPath,
  onTest
}: {
  label: string;
  value: string | null;
  tool?: ExternalToolId;
  status?: ExternalToolProbeResult;
  onSetPath(path: string | null): void;
  onTest(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
}) {
  const savedPath = value ?? '';
  const [mode, setMode] = useState<'auto' | 'custom'>(savedPath ? 'custom' : 'auto');
  const [draftPath, setDraftPath] = useState(savedPath);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ExternalToolProbeResult>();
  const [feedback, setFeedback] = useState<ExecutableTestFeedback>();

  useEffect(() => {
    setMode(savedPath ? 'custom' : 'auto');
    setDraftPath(savedPath);
    setTestResult(undefined);
    setFeedback(undefined);
  }, [savedPath]);

  const normalizedDraft = draftPath.trim();
  const pendingPath = mode === 'auto' ? null : normalizedDraft;
  const canSave =
    (mode === 'auto' && value !== null) ||
    (mode === 'custom' && Boolean(normalizedDraft) && normalizedDraft !== savedPath);
  const displayStatus = selectExecutableDisplayStatus(status, testResult);
  const metadata = [displayStatus?.resolvedPath, displayStatus?.version].filter(Boolean).join(' · ');

  const runTest = async () => {
    if (!tool) return;
    setTesting(true);
    setFeedback({ state: 'running' });
    try {
      const result = await onTest(buildExecutableTestRequest(tool, mode, draftPath));
      setTestResult(result);
      setFeedback(
        result.status === 'ok'
          ? { state: 'passed' }
          : {
              state: 'failed',
              message: result.error ?? 'The executable could not be verified.'
            }
      );
    } catch (caught) {
      setTestResult(undefined);
      setFeedback({
        state: 'failed',
        message: caught instanceof Error ? caught.message : 'The executable test could not run.'
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="tm-executable-editor">
      {metadata ? <div className="tm-executable-editor__meta">{metadata}</div> : null}
      <div className="tm-executable-editor__controls">
        <select
          className="tm-settings__select tm-settings__select--compact"
          value={mode}
          aria-label={`${label} mode`}
          onChange={(event) => {
            const nextMode = event.target.value === 'custom' ? 'custom' : 'auto';
            setMode(nextMode);
            setTestResult(undefined);
            setFeedback(undefined);
            if (nextMode === 'auto') setDraftPath('');
          }}
        >
          <option value="auto">Auto</option>
          <option value="custom">Custom</option>
        </select>
        {mode === 'custom' ? (
          <input
            className="tm-settings__input"
            value={draftPath}
            placeholder="/path/to/executable"
            aria-label={`${label} path`}
            onChange={(event) => {
              setDraftPath(event.target.value);
              setTestResult(undefined);
              setFeedback(undefined);
            }}
          />
        ) : null}
        <div className="tm-executable-editor__actions">
          {canSave ? (
            <button
              type="button"
              className="tm-settings__button tm-settings__button--primary"
              onClick={() => onSetPath(pendingPath)}
            >
              Save
            </button>
          ) : null}
          {tool ? (
            <button
              type="button"
              className="tm-settings__button"
              disabled={testing}
              aria-busy={testing}
              onClick={() => void runTest()}
            >
              Test
            </button>
          ) : null}
        </div>
      </div>
      {feedback ? (
        <div
          className={`tm-executable-editor__feedback tm-executable-editor__feedback--${feedback.state}`}
          role={feedback.state === 'failed' ? 'alert' : 'status'}
          aria-live={feedback.state === 'failed' ? 'assertive' : 'polite'}
        >
          <span aria-hidden="true" />
          {feedback.state === 'running'
            ? 'Testing…'
            : feedback.state === 'passed'
              ? 'Test passed'
              : `Test failed · ${feedback.message}`}
        </div>
      ) : null}
    </div>
  );
}

function formatEffortLabel(value: string): string {
  if (value.toLowerCase() === 'xhigh') {
    return 'X-high';
  }
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

type ExecutableTestFeedback =
  | { state: 'running' }
  | { state: 'passed' }
  | { state: 'failed'; message: string };

export function describeExternalToolAvailability(
  status: ExternalToolProbeResult | undefined
): { tone: 'ok' | 'error' | 'muted'; label: string } {
  if (!status) {
    return { tone: 'muted', label: 'Not checked' };
  }
  if (status.status === 'ok') {
    return { tone: 'ok', label: 'Available' };
  }
  return status.required
    ? { tone: 'error', label: 'Unavailable' }
    : { tone: 'muted', label: 'Optional' };
}

function runtimeDisableReason(
  appSettings: TaskManagerAppSettings,
  runtimeId: string
): string | undefined {
  const purposes = [
    appSettings.defaultRuntimeId === runtimeId ? 'Implementation' : undefined,
    appSettings.promptRefinementRuntimeId === runtimeId ? 'Prompt refinement' : undefined,
    appSettings.reviewRuntimeId === runtimeId ? 'Review' : undefined
  ].filter((purpose): purpose is string => Boolean(purpose));

  return purposes.length > 0 ? `Used by ${purposes.join(', ')}.` : undefined;
}
