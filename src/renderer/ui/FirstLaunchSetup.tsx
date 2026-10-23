import { useState, type ReactNode } from 'react';
import { Folder, RefreshCw } from 'lucide-react';
import type {
  AgentModel,
  AgentRuntimeState,
  ExternalToolProbeResult,
  ExternalToolStatusReport,
  TaskManagerAppSettings,
  UpdateAppSettingsRequest
} from '../../shared/contracts';
import {
  resolveReasoningEffort,
  selectModel
} from '../model/agentExecutionSettings';
import { abbreviateHomePath, type RepositorySetupState } from '../model/repositories';
import { runtimeReadinessView } from '../model/runtimeReadiness';
import { AgentModelSetting } from './AgentModelSelector';
import { Tooltip } from './Tooltip';
import {
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
  onGoToDesigns(): void;
  onRefreshExternalTools(): Promise<void>;
  onDiscoverAgentRuntimeModels(runtimeId: string): Promise<void>;
  onSetAppSettings(settings: UpdateAppSettingsRequest): void | Promise<unknown>;
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
  onGoToDesigns,
  onRefreshExternalTools,
  onDiscoverAgentRuntimeModels,
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
    ? activeRepositoryPath.split(/[\\/]/).filter(Boolean).at(-1) ?? activeRepositoryPath
    : 'No repository yet';
  const repositoryStepTone = isLoading
    ? 'pending'
    : hasRepository
      ? 'complete'
      : 'active';
  const repositoryActionLabel = hasRepository
    ? 'Change repository'
    : 'Choose folder';
  const runtimeName = selectedRuntime?.preflight.runtime.displayName ?? 'the selected agent';
  const missingRequirements = [
    !hasRepository ? 'a repository' : undefined,
    !gitReady ? 'Git' : undefined,
    !selectedRuntimeReadiness.canStart ? runtimeName : undefined
  ].filter((value): value is string => Boolean(value));
  const statusSentence = missingRequirements.length > 0
    ? `Waiting on ${formatList(missingRequirements)}.`
    : `Repository, Git and ${runtimeName} are ready.`;

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
          <SetupSection title="Repository">
            <SetupStep
              title={isLoading ? 'Checking repositories' : repositoryLabel}
              detail={
                hasRepository
                  ? abbreviateHomePath(activeRepositoryPath)
                  : 'Coding tasks branch and commit here. Blank Designs use storage that Task Monki manages, so they do not need a repository.'
              }
              tone={repositoryStepTone}
              actions={
                <button
                  type="button"
                  className="outline-button"
                  disabled={addRepositoryDisabled}
                  aria-busy={addingRepository}
                  onClick={() => void onAddRepository()}
                >
                  <FolderIcon />
                  {repositoryActionLabel}
                </button>
              }
            />
          </SetupSection>

          <SetupSection title="Agent">
            <div className="tm-setup__card">
              <div className="tm-setup__model">
                <AgentModelSetting
                  label="Default model"
                  hint="The model selects its provider. The checks below update to match."
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
              <div className="tm-setup-tools__head">
                <span>Needs on this machine</span>
                <span className="tm-setup-tools__checked">
                  {externalToolStatus
                    ? `Checked ${formatSettingsTime(externalToolStatus.refreshedAt)}`
                    : 'Not checked'}
                </span>
                <Tooltip label="Re-check tools"><button
                  type="button"
                  className="tm-iconbtn"
                  disabled={isRefreshingTools}
                  aria-busy={isRefreshingTools}
                  aria-label="Re-check tools"
                  onClick={() => void refreshTools()}
                >
                  <RefreshIcon />
                </button></Tooltip>
              </div>
              <SetupToolList
                externalToolStatus={externalToolStatus}
                selectedRuntime={selectedRuntime}
              />
            </div>
          </SetupSection>

          <div className="tm-setup-finish">
            <div className="tm-setup-finish__status" role="status">
              <strong>{statusSentence}</strong>
              {!hasRepository ? <span>Blank Designs do not need one.</span> : null}
            </div>
            <div className="tm-setup-finish__actions">
              <button
                type="button"
                className="outline-button"
                onClick={onGoToDesigns}
              >
                Go to Designs
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!canFinishSetup}
                aria-busy={isFinishingSetup}
                title={canFinishSetup ? undefined : statusSentence}
                onClick={() => void finishSetup()}
              >
                Finish setup
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function SetupSection({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="tm-setup-section">
      <h2 className="tm-setup-section__head">{title}</h2>
      {children}
    </section>
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
      <div className="tm-setup-step__body">
        <div className="tm-setup-step__head">
          <div className="tm-setup-step__copy">
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
  externalToolStatus,
  selectedRuntime
}: {
  externalToolStatus?: ExternalToolStatusReport;
  selectedRuntime?: AgentRuntimeState;
}) {
  const runtimeReadiness = runtimeReadinessView(selectedRuntime);
  const rows: Array<{
    key: string;
    label: string;
    hint: string;
    state: string;
    detail: string;
    /** A version or path, set in mono; anything else is a sentence. */
    detailIsValue: boolean;
    detailTitle?: string;
  }> = [
    {
      key: selectedRuntime?.preflight.runtime.id ?? 'runtime',
      label: selectedRuntime?.preflight.runtime.displayName ?? 'Agent runtime',
      hint: 'Runs the default model',
      state: runtimeReadiness.label,
      detail:
        selectedRuntime?.preflight.runtimeVersion &&
        selectedRuntime.preflight.readiness.status === 'READY'
          ? selectedRuntime.preflight.runtimeVersion
          : runtimeReadiness.detail,
      detailIsValue: Boolean(selectedRuntime?.preflight.runtimeVersion && selectedRuntime.preflight.readiness.status === 'READY'),
      detailTitle: selectedRuntime?.preflight.runtimeVersion ?? runtimeReadiness.detail
    },
    {
      key: 'git',
      label: 'Git',
      hint: 'Required for coding tasks',
      state: describeExternalToolAvailability(externalToolStatus?.tools.git).label,
      detail: describeToolStatusDetail(externalToolStatus?.tools.git),
      detailIsValue: externalToolStatus?.tools.git.status === 'ok',
      detailTitle: externalToolStatus?.tools.git.version ?? undefined
    },
    {
      key: 'gh',
      label: 'GitHub CLI',
      hint: 'Optional for PR delivery',
      state: describeExternalToolAvailability(externalToolStatus?.tools.gh).label,
      detail: describeToolStatusDetail(externalToolStatus?.tools.gh),
      detailIsValue: externalToolStatus?.tools.gh.status === 'ok',
      detailTitle: externalToolStatus?.tools.gh.version ?? undefined
    },
    {
      key: 'glab',
      label: 'GitLab CLI',
      hint: 'Optional for MR delivery',
      state: describeExternalToolAvailability(externalToolStatus?.tools.glab).label,
      detail: describeToolStatusDetail(externalToolStatus?.tools.glab),
      detailIsValue: externalToolStatus?.tools.glab.status === 'ok',
      detailTitle: externalToolStatus?.tools.glab.version ?? undefined
    }
  ];

  return (
    <div className="tm-setup-tools" aria-label="Needs on this machine">
      {rows.map((row) => <ToolStatusRow row={row} key={row.key} />)}
    </div>
  );
}

function ToolStatusRow({
  row
}: {
  row: {
    label: string;
    hint: string;
    state: string;
    detail: string;
    detailIsValue: boolean;
    detailTitle?: string;
  };
}) {
  return (
    <div className="tm-setup-tools__row">
      <div className="tm-setup-tools__copy">
        <strong>{row.label}</strong>
        <span>{row.hint}</span>
      </div>
      <div className="tm-setup-tools__meta">
        <span className={row.detailIsValue ? 'tm-setup-tools__value' : undefined} title={row.detailTitle}>{row.detail}</span>
        <strong>{row.state}</strong>
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
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

function formatSettingsTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatList(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? 'setup';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function FolderIcon() {
  return <Folder aria-hidden="true" size={13} />;
}

function RefreshIcon() {
  return <RefreshCw aria-hidden="true" size={13} />;
}
