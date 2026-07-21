import { useState, type ReactNode } from 'react';
import type {
  AgentModel,
  AgentRuntimeState,
  ExternalToolId,
  ExternalToolProbeResult,
  ExternalToolStatusReport,
  TaskManagerAppSettings,
  TestExternalToolRequest,
  UpdateAppSettingsRequest
} from '../../shared/contracts';
import {
  resolveReasoningEffort,
  selectModel
} from '../model/agentExecutionSettings';
import { shouldShowExecutablePathControls } from '../model/executableSettings';
import type { RepositorySetupState } from '../model/repositories';
import { runtimeReadinessView } from '../model/runtimeReadiness';
import { AgentModelSetting } from './AgentModelSelector';
import {
  ExecutablePathEditor,
  describeExternalToolAvailability,
  selectSettingsModels
} from './SettingsView';

interface FirstLaunchSetupProps {
  state: RepositorySetupState;
  addingRepository: boolean;
  appSettings: TaskManagerAppSettings;
  externalToolStatus?: ExternalToolStatusReport;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  activeRepositoryPath: string;
  onAddRepository(): Promise<boolean>;
  onFinishSetup(): Promise<void>;
  onRefreshExternalTools(): Promise<void>;
  onDiscoverAgentRuntimeModels(runtimeId: string): Promise<void>;
  onTestExternalTool(
    input: TestExternalToolRequest
  ): Promise<ExternalToolProbeResult>;
  onSetAppSettings(
    settings: UpdateAppSettingsRequest,
    successMessage?: string
  ): void | Promise<unknown>;
}

export function FirstLaunchSetup({
  state,
  addingRepository,
  appSettings,
  externalToolStatus,
  models,
  runtimes,
  activeRepositoryPath,
  onAddRepository,
  onFinishSetup,
  onRefreshExternalTools,
  onDiscoverAgentRuntimeModels,
  onTestExternalTool,
  onSetAppSettings
}: FirstLaunchSetupProps) {
  const [isRefreshingTools, setIsRefreshingTools] = useState(false);
  const [isFinishingSetup, setIsFinishingSetup] = useState(false);
  const selectedModels = selectSettingsModels(models, runtimes, appSettings);
  const selectedRuntime = runtimes.find(
    (runtime) => runtime.preflight.runtime.id === selectedModels.defaultRuntimeId
  );
  const selectedRuntimeReadiness = runtimeReadinessView(selectedRuntime);
  const gitReady = externalToolStatus?.tools.git.status === 'ok';
  const requiredToolsReady = Boolean(gitReady && selectedRuntimeReadiness.canStart);
  const isLoading = state === 'loading';
  const hasRepository = Boolean(activeRepositoryPath);
  const addRepositoryDisabled = isLoading || addingRepository;
  const canFinishSetup =
    hasRepository &&
    requiredToolsReady &&
    !isRefreshingTools &&
    !isFinishingSetup;
  const repositoryLabel = hasRepository
    ? compactSettingsText(activeRepositoryPath, 72)
    : 'Choose the Git repository for new tasks.';
  const repositoryStepTone = isLoading
    ? 'pending'
    : hasRepository
      ? 'complete'
      : 'active';
  const repositoryActionLabel = hasRepository
    ? 'Change repository'
    : 'Add repository';
  const toolsDetail = externalToolStatus
    ? `Checked ${formatSettingsTime(externalToolStatus.refreshedAt)}. Git and ${
        selectedRuntime?.preflight.runtime.displayName ?? 'an agent runtime'
      } are required.`
    : `Git and ${
        selectedRuntime?.preflight.runtime.displayName ?? 'an agent runtime'
      } are required before task runs can start.`;

  const refreshTools = async () => {
    setIsRefreshingTools(true);
    try {
      await onRefreshExternalTools();
    } finally {
      setIsRefreshingTools(false);
    }
  };
  const finishSetup = async () => {
    if (!canFinishSetup) return;
    setIsFinishingSetup(true);
    try {
      await onFinishSetup();
    } catch {
      setIsFinishingSetup(false);
    }
  };

  return (
    <div className="tm-setup">
      <div className="tm-setup__inner">
        <section className="tm-setup__panel" aria-label="First launch setup">
          <SetupStep
            title="Repository"
            detail={
              isLoading
                ? 'Checking saved workspace state.'
                : hasRepository
                  ? `Repository ready: ${repositoryLabel}`
                  : repositoryLabel
            }
            tone={repositoryStepTone}
            actions={
              <button
                type="button"
                className="tm-settings__button tm-settings__button--primary tm-setup__primary"
                disabled={addRepositoryDisabled}
                aria-busy={addingRepository}
                onClick={() => void onAddRepository()}
              >
                <FolderIcon />
                {repositoryActionLabel}
              </button>
            }
          />

          <SetupStep
            title="Tools"
            detail={toolsDetail}
            tone={requiredToolsReady ? 'complete' : 'pending'}
            actions={
              <button
                type="button"
                className="tm-iconbtn"
                disabled={isRefreshingTools}
                aria-busy={isRefreshingTools}
                aria-label="Re-check tools"
                title="Re-check tools"
                onClick={() => void refreshTools()}
              >
                <RefreshIcon />
              </button>
            }
          >
            <SetupToolList
              appSettings={appSettings}
              externalToolStatus={externalToolStatus}
              selectedRuntime={selectedRuntime}
              onSetAppSettings={onSetAppSettings}
              onTestExternalTool={onTestExternalTool}
            />
          </SetupStep>

          <SetupStep
            title="Defaults"
            detail="Default runtime and model for new implementation tasks."
            tone={selectedModels.selectedDefaultModel ? 'complete' : 'pending'}
          >
            <div className="tm-setup__model">
              <AgentModelSetting
                label="Default task model"
                hint="Used for new implementation tasks"
                runtimeId={selectedModels.defaultRuntimeId}
                modelId={selectedModels.selectedDefaultModel?.id ?? ''}
                reasoningEffort={selectedModels.selectedDefaultEffort}
                models={models}
                runtimes={runtimes}
                onDiscoverModels={onDiscoverAgentRuntimeModels}
                onSelectionChange={(runtimeId, modelId) => {
                  const nextModel =
                    models.find(
                      (candidate) =>
                        candidate.runtimeId === runtimeId &&
                        candidate.id === modelId
                    ) ?? selectModel(models, undefined, runtimeId);
                  onSetAppSettings({
                    defaultRuntimeId: runtimeId,
                    defaultModel: nextModel?.model ?? null,
                    defaultModelProvider: nextModel?.modelProvider ?? null,
                    defaultReasoningEffort:
                      resolveReasoningEffort(nextModel, undefined) ?? null
                  });
                }}
                onReasoningEffortChange={(reasoningEffort) =>
                  onSetAppSettings({
                    defaultReasoningEffort: reasoningEffort || null
                  })
                }
              />
            </div>
          </SetupStep>

          <div className="tm-setup-finish">
            <button
              type="button"
              className="tm-settings__button tm-settings__button--primary"
              disabled={!canFinishSetup}
              aria-busy={isFinishingSetup}
              onClick={() => void finishSetup()}
            >
              Finish setup
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function SetupStep({
  title,
  detail,
  tone,
  actions,
  children
}: {
  title: string;
  detail: string;
  tone: 'active' | 'complete' | 'pending';
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`tm-setup-step tm-setup-step--${tone}`}>
      <span className="tm-setup-step__dot" aria-hidden="true" />
      <div className="tm-setup-step__body">
        <div className="tm-setup-step__head">
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            <p>{detail}</p>
          </div>
          {actions ? (
            <div className="tm-setup-step__actions">{actions}</div>
          ) : null}
        </div>
        {children ? (
          <div className="tm-setup-step__content">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

function SetupToolList({
  appSettings,
  externalToolStatus,
  selectedRuntime,
  onSetAppSettings,
  onTestExternalTool
}: {
  appSettings: TaskManagerAppSettings;
  externalToolStatus?: ExternalToolStatusReport;
  selectedRuntime?: AgentRuntimeState;
  onSetAppSettings(
    settings: UpdateAppSettingsRequest,
    successMessage?: string
  ): void | Promise<unknown>;
  onTestExternalTool(
    input: TestExternalToolRequest
  ): Promise<ExternalToolProbeResult>;
}) {
  const runtimeReadiness = runtimeReadinessView(selectedRuntime);
  const rows: Array<{
    key: ExternalToolId;
    label: string;
    hint: string;
    value: string | null;
    status?: ExternalToolProbeResult;
    onSetPath(path: string | null): void;
  }> = [
    {
      key: 'git',
      label: 'Git',
      hint: 'Required for repository evidence',
      value: appSettings.externalExecutables.gitExecutablePath,
      status: externalToolStatus?.tools.git,
      onSetPath: (gitExecutablePath) =>
        onSetAppSettings({ externalExecutables: { gitExecutablePath } })
    },
    ...(selectedRuntime?.preflight.runtime.id === 'codex'
      ? [
          {
            key: 'codex' as const,
            label: 'Codex',
            hint: 'Required by the selected agent runtime',
            value: appSettings.externalExecutables.codexExecutablePath,
            status: externalToolStatus?.tools.codex,
            onSetPath: (codexExecutablePath: string | null) =>
              onSetAppSettings({
                externalExecutables: { codexExecutablePath }
              })
          }
        ]
      : []),
    {
      key: 'gh',
      label: 'GitHub CLI',
      hint: 'Optional for PR delivery',
      value: appSettings.externalExecutables.ghExecutablePath,
      status: externalToolStatus?.tools.gh,
      onSetPath: (ghExecutablePath) =>
        onSetAppSettings({ externalExecutables: { ghExecutablePath } })
    }
  ];

  return (
    <div className="tm-setup-tools">
      <div className="tm-setup-tools__row">
        <span
          className={`tm-setup-tools__dot tm-setup-tools__dot--${runtimeReadiness.tone}`}
        />
        <div className="tm-setup-tools__copy">
          <strong>
            {selectedRuntime?.preflight.runtime.displayName ?? 'Agent runtime'}
          </strong>
          <span>Required for agent runs</span>
        </div>
        <div className="tm-setup-tools__meta">
          <strong>{runtimeReadiness.label}</strong>
          <span>
            {selectedRuntime?.preflight.runtimeVersion &&
            selectedRuntime.preflight.readiness.status === 'READY'
              ? `Version ${selectedRuntime.preflight.runtimeVersion}`
              : runtimeReadiness.detail}
          </span>
        </div>
      </div>
      {rows.map((row) => {
        const badge = describeExternalToolAvailability(row.status);
        const shouldConfigure = shouldShowExecutablePathControls(
          row.status,
          row.value
        );
        if (shouldConfigure) {
          return (
            <div className="tm-setup-tools__configuration" key={row.key}>
              <ToolStatusRow row={row} badge={badge} />
              <ExecutablePathEditor
                label={`${row.label} executable`}
                value={row.value}
                tool={row.key}
                status={row.status}
                onSetPath={row.onSetPath}
                onTest={onTestExternalTool}
              />
            </div>
          );
        }
        return <ToolStatusRow row={row} badge={badge} key={row.key} />;
      })}
    </div>
  );
}

function ToolStatusRow({
  row,
  badge
}: {
  row: {
    label: string;
    hint: string;
    status?: ExternalToolProbeResult;
  };
  badge: { tone: string; label: string };
}) {
  return (
    <div className="tm-setup-tools__row">
      <span
        className={`tm-setup-tools__dot tm-setup-tools__dot--${badge.tone}`}
      />
      <div className="tm-setup-tools__copy">
        <strong>{row.label}</strong>
        <span>{row.hint}</span>
      </div>
      <div className="tm-setup-tools__meta">
        <strong>{badge.label}</strong>
        <span>{describeToolStatusDetail(row.status)}</span>
      </div>
    </div>
  );
}

function describeToolStatusDetail(
  status: ExternalToolProbeResult | undefined
): string {
  if (!status) return 'Not checked';
  if (status.status === 'ok') {
    return (
      status.version ??
      compactSettingsText(status.resolvedPath ?? status.executable, 42)
    );
  }
  return compactSettingsText(status.error ?? 'Not available', 48);
}

function compactSettingsText(value: string, maxLength = 72): string {
  if (value.length <= maxLength) return value;
  const headLength = 24;
  const tailLength = Math.max(12, maxLength - headLength - 3);
  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}

function formatSettingsTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 1-15.1 6.6" />
      <path d="M3 12A9 9 0 0 1 18.1 5.4" />
      <path d="M7 18.5H4.5V21" />
      <path d="M17 5.5h2.5V3" />
    </svg>
  );
}
