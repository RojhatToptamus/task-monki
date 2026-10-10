import { Columns3, Inbox, Monitor, PanelsTopLeft } from 'lucide-react';
import { SettingsPane, SettingsRow } from './SettingsPane';
import { PreviewSecretsSettings } from './preview/PreviewSecretsSettings';
import { AgentProfilesSettings, type AgentProfilesSettingsActions } from './AgentProfilesSettings';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode
} from 'react';
import {
  type AgentModel,
  type AgentRuntimeState,
  type ExternalToolId,
  type ExternalToolProbeResult,
  type ExternalToolStatusReport,
  type TaskManagerAppSettings,
  type TestExternalToolRequest,
  type UpdateAppSettingsRequest
} from '../../shared/contracts';
import {
  projectAgentExecutionSupport,
  type AgentExecutionOperation
} from '../../shared/agentExecutionSupport';
import { resolveReasoningEffort, selectModel } from '../model/agentExecutionSettings';
import {
  buildExecutableTestRequest,
  selectExecutableDisplayStatus
} from '../model/executableSettings';
import {
  runtimeExecutionUnavailableReason,
  runtimeReadinessView
} from '../model/runtimeReadiness';
import { RepositorySettings, type RepositorySettingsActions } from './RepositorySettings';
import type { RepositoryOption } from '../model/repositories';
import { AgentModelSetting } from './AgentModelSelector';
import type { ThemePreference } from './theme';
import {
  resolveTheme,
  resolveThemePreset,
  THEME_PRESETS,
  themePresetDefinition,
  themeTokens,
  type ThemePreset
} from './theme';
import { StatusGlyph } from './StatusBadge';
import { DisclosureChevron } from './DisclosureChevron';
import { UiCheckIcon, UiChevronDownIcon } from './UiIcons';
import type { SoftwareUpdateState } from '../../shared/softwareUpdate';

export type SettingsSection = 'repositories' | 'agents' | 'models' | 'profiles' | 'secrets' | 'tools' | 'appearance' | 'updates';

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'repositories', label: 'Repositories' },
  { id: 'agents', label: 'Agents' },
  { id: 'models', label: 'Models' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'tools', label: 'Tools' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'updates', label: 'Updates' }
];

export interface SettingsViewProps extends AgentProfilesSettingsActions, RepositorySettingsActions {
  repositories: RepositoryOption[];
  /** The section shown first, for links that open Settings at a specific place. */
  initialSection?: SettingsSection;
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  onPreviewThemePreset?(themePreset: ThemePreset | null): void;
  appSettings: TaskManagerAppSettings;
  onSetAppSettings(settings: UpdateAppSettingsRequest): void | Promise<unknown>;
  softwareUpdateState: SoftwareUpdateState;
  onCheckForSoftwareUpdates(): Promise<void>;
  onDownloadSoftwareUpdate(): Promise<void>;
  onInstallSoftwareUpdate(): Promise<void>;
  externalToolStatus?: ExternalToolStatusReport;
  agentRuntimesLoading: boolean;
  onRefreshExternalTools(): Promise<void>;
  onRefreshAgentRuntimes(): Promise<void>;
  onDiscoverAgentRuntimeModels(runtimeId: string): Promise<void>;
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
}

/** Settings is one sheet with its own section list (DESIGN.md 7.1, settings archetype). */
export function SettingsView(props: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>(props.initialSection ?? 'repositories');

  return (
    <div className="tm-settings">
      <nav className="tm-settings__nav" aria-label="Settings">
        <h1 className="tm-settings__title">Settings</h1>
        {SETTINGS_SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`tm-settings__nav-item${section === item.id ? ' tm-settings__nav-item--active' : ''}`}
            aria-current={section === item.id ? 'page' : undefined}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="tm-settings__inner">
        {section === 'repositories' ? (
          <RepositorySettings
            repositories={props.repositories}
            addingRepository={props.addingRepository}
            revealLabel={props.revealLabel}
            onAddRepository={props.onAddRepository}
            onRefreshRepository={props.onRefreshRepository}
            onReconnectRepository={props.onReconnectRepository}
            onDisconnectRepository={props.onDisconnectRepository}
            onRevealRepository={props.onRevealRepository}
          />
        ) : null}
        {section === 'profiles' ? (
          <AgentProfilesSettings
            profiles={props.appSettings.agentProfiles}
            onSaveAgentProfile={props.onSaveAgentProfile}
            onDeleteAgentProfile={props.onDeleteAgentProfile}
          />
        ) : null}
        {section === 'agents' ? <AgentSettings {...props} /> : null}
        {section === 'models' ? <ModelSettings {...props} /> : null}
        {section === 'tools' ? <ToolSettings {...props} /> : null}
        {section === 'updates' ? <UpdateSettings {...props} /> : null}
        {section === 'appearance' ? <AppearanceSettings {...props} /> : null}
        {section === 'secrets' ? <PreviewSecretsSettings /> : null}
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
      id="agents"
      title="Agents"
      detail="Choose which coding agents Task Monki can use."
      action={
        <button
          type="button"
          className="outline-button button--sm"
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
          <span className="tm-disclosure__label"><DisclosureChevron /><span>Executable</span></span>
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

function ModelSettings({
  appSettings,
  onSetAppSettings,
  onDiscoverAgentRuntimeModels,
  models,
  runtimes
}: SettingsViewProps) {
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
  const selectedPreviewRuntime = enabledRuntimes.find(
    (runtime) =>
      runtime.preflight.runtime.id === selected.previewRecipeGenerationRuntimeId
  );
  const previewUnavailableReason = selectedPreviewRuntime
      ? runtimeExecutionUnavailableReason(
          selectedPreviewRuntime,
          'PREVIEW_AGENT',
          { model: selected.selectedPreviewRecipeGenerationModel }
        )
      : undefined;
  return (
    <SettingsPane
      id="models"
      title="Models"
      detail="Defaults for implementation, prompt refinement, the Preview agent, and review."
    >
      <div className="tm-settings__list tm-model-defaults">
        <AgentModelSetting
          label="Implementation"
          runtimeId={selected.defaultRuntimeId}
          modelId={selected.selectedDefaultModel?.id ?? ''}
          reasoningEffort={selected.selectedDefaultEffort}
          models={enabledModels}
          runtimes={enabledRuntimes}
          onDiscoverModels={onDiscoverAgentRuntimeModels}
          onSelectionChange={(runtimeId, modelId) => {
            const nextModel =
              enabledModels.find(
                (candidate) => candidate.runtimeId === runtimeId && candidate.id === modelId
              ) ?? selectModel(enabledModels, undefined, runtimeId);
            onSetAppSettings({
              defaultRuntimeId: runtimeId,
              defaultModel: nextModel?.model ?? null,
              defaultModelProvider: nextModel?.modelProvider ?? null,
              defaultReasoningEffort: resolveReasoningEffort(nextModel, undefined) ?? null
            });
          }}
          onReasoningEffortChange={(reasoningEffort) =>
            onSetAppSettings({ defaultReasoningEffort: reasoningEffort || null })
          }
        />
        <AgentModelSetting
          label="Prompt refinement"
          runtimeId={selected.promptRefinementRuntimeId}
          modelId={selected.selectedPromptRefinementModel?.id ?? ''}
          models={enabledModels}
          runtimes={enabledRuntimes}
          runtimeUnavailableReason={(runtime) =>
            runtimeExecutionUnavailableReason(runtime, 'PROMPT_REFINEMENT')
          }
          onDiscoverModels={onDiscoverAgentRuntimeModels}
          onSelectionChange={(runtimeId, modelId) => {
            const nextModel =
              enabledModels.find(
                (candidate) => candidate.runtimeId === runtimeId && candidate.id === modelId
              ) ?? selectModel(enabledModels, undefined, runtimeId);
            onSetAppSettings({
              promptRefinementRuntimeId: runtimeId,
              promptRefinementModel: nextModel?.model ?? null,
              promptRefinementModelProvider: nextModel?.modelProvider ?? null
            });
          }}
        />
        <AgentModelSetting
          label="Preview agent"
          runtimeId={selected.previewRecipeGenerationRuntimeId}
          modelId={selected.selectedPreviewRecipeGenerationModel?.id ?? ''}
          fallbackSummary={
            selected.selectedPreviewRecipeGenerationModel
              ? undefined
              : enabledRuntimes.some(
                    (runtime) =>
                      runtime.preflight.runtime.id ===
                      selected.previewRecipeGenerationRuntimeId
                  )
                ? (appSettings.previewRecipeGenerationModel ?? undefined)
                : (appSettings.previewRecipeGenerationModel ?? 'Choose a model')
          }
          selectionUnavailable={Boolean(
            !enabledRuntimes.some(
              (runtime) =>
                runtime.preflight.runtime.id ===
                selected.previewRecipeGenerationRuntimeId
            ) ||
              ((appSettings.previewRecipeGenerationModel ||
                appSettings.previewRecipeGenerationModelProvider) &&
                !selected.selectedPreviewRecipeGenerationModel &&
                selectedPreviewRuntime?.preflight.readiness.checks.modelCatalog !== 'UNKNOWN') ||
              previewUnavailableReason
          )}
          selectionUnavailableMessage={
            previewUnavailableReason ??
            'The selected Preview agent or model is no longer available. Choose another selection.'
          }
          models={enabledModels}
          runtimes={enabledRuntimes}
          runtimeUnavailableReason={(runtime) =>
            runtimeExecutionUnavailableReason(runtime, 'PREVIEW_AGENT')
          }
          modelUnavailableReason={(model, runtime) =>
            runtimeExecutionUnavailableReason(
              runtime,
              'PREVIEW_AGENT',
              { model }
            )
          }
          onDiscoverModels={onDiscoverAgentRuntimeModels}
          onSelectionChange={(runtimeId, modelId) => {
            const nextModel =
              enabledModels.find(
                (candidate) => candidate.runtimeId === runtimeId && candidate.id === modelId
              ) ?? selectModel(enabledModels, undefined, runtimeId);
            onSetAppSettings({
              previewRecipeGenerationRuntimeId: runtimeId,
              previewRecipeGenerationModel: nextModel?.model ?? null,
              previewRecipeGenerationModelProvider: nextModel?.modelProvider ?? null
            });
          }}
        />
        <AgentModelSetting
          label="Review"
          runtimeId={selected.reviewRuntimeId}
          modelId={selected.selectedReviewModel?.id ?? ''}
          reasoningEffort={selected.selectedReviewEffort}
          models={enabledModels}
          runtimes={enabledRuntimes}
          runtimeUnavailableReason={(runtime) =>
            runtimeExecutionUnavailableReason(runtime, 'REVIEW')
          }
          onDiscoverModels={onDiscoverAgentRuntimeModels}
          onSelectionChange={(runtimeId, modelId) => {
            const nextModel =
              enabledModels.find(
                (candidate) => candidate.runtimeId === runtimeId && candidate.id === modelId
              ) ?? selectModel(enabledModels, undefined, runtimeId);
            onSetAppSettings({
              reviewRuntimeId: runtimeId,
              reviewModel: nextModel?.model ?? null,
              reviewModelProvider: nextModel?.modelProvider ?? null,
              reviewReasoningEffort: resolveReasoningEffort(nextModel, undefined) ?? null
            });
          }}
          onReasoningEffortChange={(reasoningEffort) =>
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
  previewRecipeGenerationRuntimeId: string;
  reviewRuntimeId: string;
  selectedDefaultModel?: AgentModel;
  selectedPromptRefinementModel?: AgentModel;
  selectedPreviewRecipeGenerationModel?: AgentModel;
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
  const supportedRuntimeIds = (operation: AgentExecutionOperation) =>
    new Set(
      runtimes
        .filter(
          (runtime) =>
            runtime.preflight.readiness.canStart &&
            projectAgentExecutionSupport(
              runtime.preflight.capabilities,
              operation
            ).supported
        )
        .map((runtime) => runtime.preflight.runtime.id)
    );
  const promptRefinementRuntimeIds = supportedRuntimeIds('PROMPT_REFINEMENT');
  const reviewRuntimeIds = supportedRuntimeIds('REVIEW');
  const promptRefinementRuntimeId =
    appSettings.promptRefinementRuntimeId &&
    availableRuntimeIds.has(appSettings.promptRefinementRuntimeId)
      ? appSettings.promptRefinementRuntimeId
      : promptRefinementRuntimeIds.has(defaultRuntimeId)
        ? defaultRuntimeId
        : ([...promptRefinementRuntimeIds][0] ?? defaultRuntimeId);
  const previewRecipeGenerationRuntimeId =
    appSettings.previewRecipeGenerationRuntimeId ?? defaultRuntimeId;
  const reviewRuntimeId =
    appSettings.reviewRuntimeId && availableRuntimeIds.has(appSettings.reviewRuntimeId)
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
    appSettings.promptRefinementModel,
    promptRefinementRuntimeId,
    appSettings.promptRefinementModelProvider
  );
  const selectedPreviewRecipeGenerationModel = appSettings.previewRecipeGenerationModel
    ? models.find(
        (model) =>
          model.runtimeId === previewRecipeGenerationRuntimeId &&
          (model.id === appSettings.previewRecipeGenerationModel ||
            model.model === appSettings.previewRecipeGenerationModel) &&
          (!appSettings.previewRecipeGenerationModelProvider ||
            model.modelProvider === appSettings.previewRecipeGenerationModelProvider)
      )
    : selectModel(
        models,
        undefined,
        previewRecipeGenerationRuntimeId,
        appSettings.previewRecipeGenerationModelProvider
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
    previewRecipeGenerationRuntimeId,
    reviewRuntimeId,
    selectedDefaultModel,
    selectedPromptRefinementModel,
    selectedPreviewRecipeGenerationModel,
    selectedReviewModel,
    selectedDefaultEffort:
      resolveReasoningEffort(selectedDefaultModel, appSettings.defaultReasoningEffort) ?? '',
    selectedReviewEffort:
      resolveReasoningEffort(selectedReviewModel, appSettings.reviewReasoningEffort) ?? ''
  };
}

function ToolSettings({
  appSettings,
  onSetAppSettings,
  externalToolStatus,
  onRefreshExternalTools,
  onTestExternalTool,
  runtimes
}: SettingsViewProps) {
  const [refreshing, setRefreshing] = useState(false);
  const pendingSettings = runtimeReadinessView(
    runtimes.find((runtime) => runtime.preflight.runtime.id === 'codex')
  ).warnings.find((warning) => warning.code === 'RUNTIME_RESTART_REQUIRED');

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
      id="tools"
      title="Tools"
      detail="Repository delivery and Codex integrations."
      action={
        <button
          type="button"
          className="outline-button button--sm"
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
        {pendingSettings ? (
          <p className="form-warning" role="status">{pendingSettings.message}</p>
        ) : null}
        <div className="tm-settings__list">
          <ChoiceSettingRow
            label="Internet access"
            description="Live enables web search and internet access for Design commands. Cached search keeps Design commands offline."
            value={appSettings.codexExternalTools.webSearchMode}
            options={[
              { value: 'disabled', label: 'Off' },
              { value: 'cached', label: 'Cached search' },
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

function UpdateSettings({
  appSettings,
  onSetAppSettings,
  softwareUpdateState,
  onCheckForSoftwareUpdates,
  onDownloadSoftwareUpdate,
  onInstallSoftwareUpdate
}: SettingsViewProps) {
  const busy = ['checking', 'downloading'].includes(softwareUpdateState.status);
  const version = softwareUpdateState.availableVersion;
  const canCheck = !version && softwareUpdateState.status !== 'unavailable';
  const updateAction =
    softwareUpdateState.status === 'available' ||
    (softwareUpdateState.status === 'error' && version)
      ? {
          label: softwareUpdateState.status === 'error' ? 'Try again' : 'Download',
          run: onDownloadSoftwareUpdate
        }
      : softwareUpdateState.status === 'downloaded'
        ? { label: 'Restart to update', run: onInstallSoftwareUpdate }
        : undefined;

  return (
    <SettingsPane
      id="updates"
      title="Updates"
      detail="Keep Task Monki current on this device."
      action={canCheck ? (
        <button
          type="button"
          className="outline-button button--sm"
          disabled={busy}
          aria-busy={softwareUpdateState.status === 'checking'}
          onClick={() => void onCheckForSoftwareUpdates()}
        >
          {softwareUpdateState.status === 'checking' ? 'Checking…' : 'Check now'}
        </button>
      ) : undefined}
    >
      <div className="tm-settings__list" aria-live="polite">
        <SettingsRow label="Installed version" description={updateStatusText(softwareUpdateState)}>
          <div className="tm-update-settings__value">
            {softwareUpdateState.currentVersion || 'Development build'}
          </div>
        </SettingsRow>
        {version && softwareUpdateState.status !== 'up-to-date' ? (
          <SettingsRow label={`Version ${version}`} description={updateAvailableDetail(softwareUpdateState)}>
            {updateAction ? (
              <button
                type="button"
                className="primary-button"
                onClick={() => void updateAction.run()}
              >
                {updateAction.label}
              </button>
            ) : softwareUpdateState.status === 'downloading' ? (
              <span className="tm-update-settings__value">
                {Math.round(softwareUpdateState.progress?.percent ?? 0)}%
              </span>
            ) : null}
          </SettingsRow>
        ) : null}
        <SettingsRow label="Install on quit" description="Install a downloaded update when Task Monki closes normally.">
          <SettingsSwitch
            label="Automatically install downloaded updates when Task Monki quits"
            checked={appSettings.autoInstallUpdatesOnQuit}
            onChange={(autoInstallUpdatesOnQuit) =>
              void onSetAppSettings({ autoInstallUpdatesOnQuit })
            }
          />
        </SettingsRow>
      </div>
    </SettingsPane>
  );
}

function updateStatusText(state: SoftwareUpdateState): string {
  if (state.status === 'unavailable') {
    return 'Update checks are available in the installed desktop app.';
  }
  if (state.status === 'checking') return 'Checking for a newer release…';
  if (state.status === 'up-to-date') return checkedAtText(state.lastCheckedAt);
  if (state.status === 'error' && !state.availableVersion) {
    return state.errorMessage ?? 'Could not check for updates.';
  }
  return checkedAtText(state.lastCheckedAt);
}

function checkedAtText(value: string | null): string {
  if (!value) return 'Not checked yet.';
  const checkedAt = new Date(value);
  if (!Number.isFinite(checkedAt.getTime())) return 'Last check time is unavailable.';
  if (Date.now() - checkedAt.getTime() < 60_000) return 'Last checked just now.';
  return `Last checked ${new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(checkedAt)}.`;
}

function updateAvailableDetail(state: SoftwareUpdateState): string {
  if (state.status === 'downloading') return 'The update is downloading.';
  if (state.status === 'downloaded') return 'The update is ready to install.';
  if (state.status === 'error') return state.errorMessage ?? 'The download failed.';
  return 'A newer Task Monki release is ready to download.';
}

function AppearanceSettings({
  theme,
  onSetTheme,
  onPreviewThemePreset,
  appSettings,
  onSetAppSettings
}: SettingsViewProps) {
  const [previewThemePreset, setPreviewThemePreset] = useState<ThemePreset | null>(null);
  const prefersDark =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const resolvedPreviewMode = resolveTheme(theme, prefersDark);
  const persistedThemePreset = resolveThemePreset(appSettings.themePreset);
  const activeThemePreset = previewThemePreset ?? persistedThemePreset;
  const previewTheme = useCallback((themePreset: ThemePreset | null) => {
    setPreviewThemePreset(themePreset);
    onPreviewThemePreset?.(themePreset);
  }, [onPreviewThemePreset]);
  return (
    <SettingsPane id="appearance" title="Appearance">
      <>
        <div className="tm-settings__list tm-appearance">
          <SettingsRow label="Theme">
            <ThemePresetPicker
              value={persistedThemePreset}
              mode={resolvedPreviewMode}
              onPreview={previewTheme}
              onChange={(themePreset) => onSetAppSettings({ themePreset })}
            />
          </SettingsRow>
          <SettingsRow label="Mode" description={theme === 'device' ? `Follows the system, now ${resolvedPreviewMode}` : undefined}>
            <div className="segmented" role="group" aria-label="Theme mode">
              {(['light', 'dark', 'device'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="segmented__btn"
                  aria-pressed={theme === option}
                  onClick={() => onSetTheme(option)}
                >
                  {option === 'device' ? 'Device' : option === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </SettingsRow>
          <ThemePreview preset={themePresetDefinition(activeThemePreset).label} mode={resolvedPreviewMode} />
        </div>
      </>
    </SettingsPane>
  );
}

function ThemePresetPicker({
  value,
  mode,
  onPreview,
  onChange
}: {
  value: ThemePreset;
  mode: 'light' | 'dark';
  onPreview(value: ThemePreset | null): void;
  onChange(value: ThemePreset): void | Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ThemePreset>(value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<ThemePreset, HTMLButtonElement>());
  const selected = themePresetDefinition(value);
  const groups = ['Authored', 'Catalog'] as const;
  const orderedPresets = THEME_PRESETS.map((preset) => preset.id);

  const focusOption = (themePreset: ThemePreset) => {
    queueMicrotask(() => optionRefs.current.get(themePreset)?.focus());
  };

  const previewOption = (themePreset: ThemePreset) => {
    setActive(themePreset);
    onPreview(themePreset);
  };

  const openPicker = (themePreset = value) => {
    setOpen(true);
    setActive(themePreset);
    focusOption(themePreset);
  };

  const cancelPreview = (restoreFocus = false) => {
    setOpen(false);
    setActive(value);
    onPreview(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const moveActiveOption = (offset: number) => {
    const currentIndex = Math.max(0, orderedPresets.indexOf(active));
    const nextIndex = (currentIndex + offset + orderedPresets.length) % orderedPresets.length;
    const next = orderedPresets[nextIndex]!;
    previewOption(next);
    focusOption(next);
  };

  const commit = async (themePreset: ThemePreset) => {
    setOpen(false);
    try {
      await onChange(themePreset);
    } finally {
      onPreview(null);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  useEffect(() => () => onPreview(null), [onPreview]);

  const closeWhenFocusLeaves = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) cancelPreview();
  };

  return (
    <div
      className="tm-theme-picker"
      onBlur={closeWhenFocusLeaves}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          cancelPreview(true);
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) {
            openPicker();
            return;
          }
          moveActiveOption(event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (open && (event.key === 'Home' || event.key === 'End')) {
          event.preventDefault();
          const next = event.key === 'Home' ? orderedPresets[0]! : orderedPresets.at(-1)!;
          previewOption(next);
          focusOption(next);
          return;
        }
        if (open && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          void commit(active);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="tm-theme-picker__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) cancelPreview();
          else openPicker();
        }}
      >
        <span
          className="tm-theme-picker__dot"
          style={{ '--theme-option-accent': themeTokens(value, mode)['--accent'] } as CSSProperties}
        />
        <span>{selected.label}</span>
        <UiChevronDownIcon open={open} size={13} />
      </button>
      {open ? (
        <div className="tm-theme-picker__menu" role="listbox" aria-label="Theme preset">
          {groups.map((group) => (
            <div key={group} className="tm-theme-picker__group" role="group" aria-label={group}>
              <div className="tm-theme-picker__group-label">{group}</div>
              {THEME_PRESETS.filter((preset) => preset.group === group).map((preset) => (
                <button
                  key={preset.id}
                  ref={(element) => {
                    if (element) optionRefs.current.set(preset.id, element);
                    else optionRefs.current.delete(preset.id);
                  }}
                  type="button"
                  role="option"
                  aria-selected={preset.id === value}
                  data-previewed={preset.id === active || undefined}
                  className="tm-theme-picker__option"
                  onFocus={() => previewOption(preset.id)}
                  onClick={() => void commit(preset.id)}
                >
                  <span
                    className="tm-theme-picker__dot"
                    style={{ '--theme-option-accent': themeTokens(preset.id, mode)['--accent'] } as CSSProperties}
                  />
                  <span>{preset.label}</span>
                  {preset.id === value ? <UiCheckIcon size={12} /> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A miniature of the app in the chosen theme: the frame, the rail, a sheet with cards and a composer. */
function ThemePreview({ preset, mode }: { preset: string; mode: 'light' | 'dark' }) {
  return (
    <section className="tm-theme-preview" aria-label={`Preview of ${preset}, ${mode}`}>
      <div className="tm-theme-preview__window" aria-hidden="true">
        <div className="tm-theme-preview__titlebar"><span className="tm-theme-preview__new">New task</span></div>
        <div className="tm-theme-preview__body">
          <div className="tm-theme-preview__rail">
            <span className="tm-theme-preview__rail-item"><Inbox size={12} /><i /></span>
            <span className="tm-theme-preview__rail-item tm-theme-preview__rail-item--active"><Columns3 size={12} /></span>
            <span className="tm-theme-preview__rail-item"><PanelsTopLeft size={12} /></span>
            <span className="tm-theme-preview__rail-item"><Monitor size={12} /></span>
          </div>
          <div className="tm-theme-preview__sheet">
            <strong className="tm-theme-preview__title">Tasks</strong>
            <div className="tm-theme-preview__tabs"><span className="tm-theme-preview__tab--active">All</span><span>Running</span><span>In review</span></div>
            <div className="tm-theme-preview__cards">
              <div className="tm-theme-preview__card">
                <span className="tm-theme-preview__card-top"><span>acme-api</span><span className="status-pill status-pill--action">Needs approval</span></span>
                <strong>Rate-limit the public API</strong>
              </div>
              <div className="tm-theme-preview__card">
                <span className="tm-theme-preview__card-top"><span>cedar-notes</span><span className="status-pill status-pill--info">Running</span></span>
                <strong>Add Focus Mode for long notes</strong>
              </div>
            </div>
            <div className="tm-theme-preview__composer"><span>Ask for follow-up changes</span><span className="tm-theme-preview__send" /></div>
          </div>
        </div>
      </div>
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
    <SettingsRow label={label}>
      <SettingsSwitch label={label} checked={checked} onChange={onChange} />
    </SettingsRow>
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
  description,
  value,
  options,
  onChange
}: {
  label: string;
  description?: string;
  value: Value;
  options: Array<{ value: Value; label: string }>;
  onChange(value: Value): void;
}) {
  return (
    <label className="tm-settings__row">
      <span className="tm-settings__label">
        <span className="tm-settings__k">{label}</span>
        {description ? <span className="tm-settings__description">{description}</span> : null}
      </span>
      <select
        className="tm-settings__select tm-settings__select--compact"
        value={value}
        aria-label={label}
        aria-description={description}
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
              className="primary-button"
              onClick={() => onSetPath(pendingPath)}
            >
              Save
            </button>
          ) : null}
          {tool ? (
            <button
              type="button"
              className="outline-button"
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
          <StatusGlyph
            kind={
              feedback.state === 'running'
                ? 'working'
                : feedback.state === 'passed'
                  ? 'verified'
                  : 'blocked'
            }
          />
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
    appSettings.previewRecipeGenerationRuntimeId === runtimeId
      ? 'Preview agent'
      : undefined,
    appSettings.reviewRuntimeId === runtimeId ? 'Review' : undefined
  ].filter((purpose): purpose is string => Boolean(purpose));

  return purposes.length > 0 ? `Used by ${purposes.join(', ')}.` : undefined;
}
