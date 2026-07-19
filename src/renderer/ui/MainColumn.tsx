import { useState, type ReactNode } from 'react';
import type {
  AgentInteractionDecision,
  Board,
  InteractionRequestRecord,
  Repository,
  Task
} from '../../shared/contracts';
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
import { resolveReasoningEffort, selectModel } from '../model/agentExecutionSettings';
import { shouldShowTaskRepository } from '../model/boards';
import { inboxInteractionDecisions } from '../model/inboxDecisions';
import { shouldShowExecutablePathControls } from '../model/executableSettings';
import type { RepositorySetupState } from '../model/repositories';
import { runtimeReadinessView } from '../model/runtimeReadiness';
import { describeTaskAttention } from './BoardView';
import { humanizeEnum } from './display';
import { Chip, dotStyle } from './StatusBadge';
import { TaskActionsMenu } from './TaskActionsMenu';
import {
  ExecutablePathEditor,
  ModelSettingRow,
  SettingsView,
  describeExternalToolAvailability,
  selectSettingsModels
} from './SettingsView';
import type { ThemePreference } from './theme';
import {
  BOARD_COLUMNS,
  buildTaskCardVM,
  columnTasks,
  tasksForView,
  tasksSpanMultipleRepositories,
  type NavView,
  type TaskCardVM
} from './taskView';

interface MainColumnProps {
  view: NavView;
  board?: Board;
  tasks: Task[];
  repositories: Repository[];
  interactionRequests: InteractionRequestRecord[];
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
  onDiscoverAgentRuntimeModels(runtimeId: string): Promise<void>;
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  error?: string;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  activeRepository?: Repository;
  repositorySetupState: RepositorySetupState;
  addingRepository: boolean;
  onAddRepository(): Promise<boolean>;
  onFinishSetup(): Promise<void>;
  onSelect(taskId: string): void;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
  onArchive(taskId: string): void;
  onRequestDelete(taskId: string): void;
  onEditBoard(board: Board): void;
}

const VIEW_TITLES: Record<NavView, { title: string; subtitle(tasks: Task[]): string }> = {
  inbox: {
    title: 'Inbox',
    subtitle: () => 'Decisions and runs waiting on you'
  },
  board: {
    title: 'All tasks',
    subtitle: (tasks) =>
      `${tasks.length} task${tasks.length === 1 ? '' : 's'} across the pipeline`
  },
  active: {
    title: 'Active runs',
    subtitle: (tasks) => `${tasksForView(tasks, 'active').length} tasks currently in flight`
  },
  review: {
    title: 'Review queue',
    subtitle: (tasks) =>
      `${tasksForView(tasks, 'review').length} tasks ready to verify and ship`
  },
  done: {
    title: 'Done & Archive',
    subtitle: (tasks) => `${tasksForView(tasks, 'done').length} completed tasks`
  },
  settings: {
    title: 'Settings',
    subtitle: () => 'Agents, models, tools, and appearance'
  }
};

const SETUP_VIEW_TITLES: Record<
  Exclude<RepositorySetupState, 'complete'>,
  { title: string; subtitle: string }
> = {
  loading: {
    title: 'Loading workspace',
    subtitle: 'Checking saved repositories and tool status'
  },
  needsRepository: {
    title: 'Set up Task Monki',
    subtitle: 'Add a Git repository before creating tasks'
  },
  needsReview: {
    title: 'Set up Task Monki',
    subtitle: 'Review tools and defaults before entering the board'
  }
};

export function MainColumn({
  view,
  board,
  tasks,
  repositories,
  interactionRequests,
  theme,
  onSetTheme,
  appSettings,
  onSetAppSettings,
  externalToolStatus,
  agentRuntimesLoading,
  onRefreshExternalTools,
  onRefreshAgentRuntimes,
  onDiscoverAgentRuntimeModels,
  onTestExternalTool,
  error,
  models,
  runtimes,
  activeRepository,
  repositorySetupState,
  addingRepository,
  onAddRepository,
  onFinishSetup,
  onSelect,
  onRespondToInteraction,
  onArchive,
  onRequestDelete,
  onEditBoard
}: MainColumnProps) {
  const head = VIEW_TITLES[view];
  const showRepositorySetup = repositorySetupState !== 'complete' && view !== 'settings';
  const setupHead =
    repositorySetupState === 'complete'
      ? SETUP_VIEW_TITLES.needsReview
      : SETUP_VIEW_TITLES[repositorySetupState];
  const disabledRuntimeIds = new Set(appSettings.disabledRuntimeIds);
  const enabledRuntimes = runtimes.filter(
    (runtime) => !disabledRuntimeIds.has(runtime.preflight.runtime.id)
  );
  const enabledRuntimeIds = new Set(
    enabledRuntimes.map((runtime) => runtime.preflight.runtime.id)
  );
  const enabledModels = models.filter((model) => enabledRuntimeIds.has(model.runtimeId));

  return (
    <main className="tm-main">
      <div className="tm-main__head">
        <div style={{ minWidth: 0 }}>
          <h1 className="tm-main__title">
            {showRepositorySetup ? setupHead.title : board?.name ?? head.title}
          </h1>
          <span className="tm-main__subtitle">
            {showRepositorySetup ? setupHead.subtitle : head.subtitle(tasks)}
          </span>
        </div>
        {!showRepositorySetup && board && view === 'board' ? (
          <button
            type="button"
            className="tm-main__head-action"
            onClick={() => onEditBoard(board)}
          >
            Edit view
          </button>
        ) : null}
      </div>

      {error ? <div className="tm-error">{error}</div> : null}

      {showRepositorySetup ? (
        <FirstLaunchSetup
          state={repositorySetupState}
          addingRepository={addingRepository}
          appSettings={appSettings}
          externalToolStatus={externalToolStatus}
          models={enabledModels}
          runtimes={enabledRuntimes}
          activeRepositoryPath={activeRepository?.path ?? ''}
          onAddRepository={onAddRepository}
          onFinishSetup={onFinishSetup}
          onRefreshExternalTools={onRefreshExternalTools}
          onDiscoverAgentRuntimeModels={onDiscoverAgentRuntimeModels}
          onTestExternalTool={onTestExternalTool}
          onSetAppSettings={onSetAppSettings}
        />
      ) : null}
      {!showRepositorySetup && view === 'board' ? (
        <BoardKanban
          tasks={tasks}
          repositories={repositories}
          showRepository={shouldShowTaskRepository(board)}
          onSelect={onSelect}
          onArchive={onArchive}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
      {!showRepositorySetup && (view === 'active' || view === 'review' || view === 'done') ? (
        <CardGrid
          tasks={tasksForView(tasks, view)}
          repositories={repositories}
          view={view}
          onSelect={onSelect}
          onArchive={onArchive}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
      {!showRepositorySetup && view === 'inbox' ? (
        <Inbox
          tasks={tasks}
          repositories={repositories}
          interactionRequests={interactionRequests}
          onSelect={onSelect}
          onRespondToInteraction={onRespondToInteraction}
        />
      ) : null}
      {!showRepositorySetup && view === 'settings' ? (
        <SettingsView
          theme={theme}
          onSetTheme={onSetTheme}
          appSettings={appSettings}
          onSetAppSettings={onSetAppSettings}
          externalToolStatus={externalToolStatus}
          agentRuntimesLoading={agentRuntimesLoading}
          onRefreshExternalTools={onRefreshExternalTools}
          onRefreshAgentRuntimes={onRefreshAgentRuntimes}
          onDiscoverAgentRuntimeModels={onDiscoverAgentRuntimeModels}
          onTestExternalTool={onTestExternalTool}
          models={models}
          runtimes={runtimes}
        />
      ) : null}
    </main>
  );
}

function FirstLaunchSetup({
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
}: {
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
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  onSetAppSettings(
    settings: UpdateAppSettingsRequest,
    successMessage?: string
  ): void | Promise<unknown>;
}) {
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
    hasRepository && requiredToolsReady && !isRefreshingTools && !isFinishingSetup;
  const repositoryLabel = hasRepository
    ? compactSettingsText(activeRepositoryPath, 72)
    : 'Choose the Git repository for new tasks.';
  const repositoryStepTone = isLoading ? 'pending' : hasRepository ? 'complete' : 'active';
  const repositoryActionLabel = hasRepository ? 'Change repository' : 'Add repository';
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
    if (!canFinishSetup) {
      return;
    }
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
              <ModelSettingRow
                label="Default task model"
                hint="Used for new implementation tasks"
                runtimeId={selectedModels.defaultRuntimeId}
                value={selectedModels.selectedDefaultModel?.id ?? ''}
                effortValue={selectedModels.selectedDefaultEffort}
                models={models}
                runtimes={runtimes}
                onDiscoverModels={onDiscoverAgentRuntimeModels}
                onRuntimeChange={(runtimeId) => {
                  const nextModel = selectModel(models, undefined, runtimeId);
                  onSetAppSettings({
                    defaultRuntimeId: runtimeId,
                    defaultModel: nextModel?.model ?? null,
                    defaultModelProvider: nextModel?.modelProvider ?? null,
                    defaultReasoningEffort:
                      resolveReasoningEffort(nextModel, undefined) ?? null
                  });
                }}
                onModelChange={(modelId) => {
                  const nextModel = models.find((candidate) => candidate.id === modelId);
                  onSetAppSettings({
                    defaultModel: nextModel?.model ?? null,
                    defaultModelProvider: nextModel?.modelProvider ?? null,
                    defaultReasoningEffort:
                      resolveReasoningEffort(
                        nextModel,
                        appSettings.defaultReasoningEffort
                      ) ?? null
                  });
                }}
                onEffortChange={(reasoningEffort) =>
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
          {actions ? <div className="tm-setup-step__actions">{actions}</div> : null}
        </div>
        {children ? <div className="tm-setup-step__content">{children}</div> : null}
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
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
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
        onSetAppSettings({
          externalExecutables: { gitExecutablePath }
        })
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
        onSetAppSettings({
          externalExecutables: { ghExecutablePath }
        })
    }
  ];

  return (
    <div className="tm-setup-tools">
      <div className="tm-setup-tools__row">
        <span
          className={`tm-setup-tools__dot tm-setup-tools__dot--${runtimeReadiness.tone}`}
        />
        <div className="tm-setup-tools__copy">
          <strong>{selectedRuntime?.preflight.runtime.displayName ?? 'Agent runtime'}</strong>
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
        const shouldConfigure = shouldShowExecutablePathControls(row.status, row.value);
        if (shouldConfigure) {
          return (
            <div className="tm-setup-tools__configuration" key={row.key}>
              <div className="tm-setup-tools__row">
                <span className={`tm-setup-tools__dot tm-setup-tools__dot--${badge.tone}`} />
                <div className="tm-setup-tools__copy">
                  <strong>{row.label}</strong>
                  <span>{row.hint}</span>
                </div>
                <div className="tm-setup-tools__meta">
                  <strong>{badge.label}</strong>
                  <span>{describeToolStatusDetail(row.status)}</span>
                </div>
              </div>
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
        return (
          <div className="tm-setup-tools__row" key={row.key}>
            <span className={`tm-setup-tools__dot tm-setup-tools__dot--${badge.tone}`} />
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
      })}
    </div>
  );
}

function describeToolStatusDetail(status: ExternalToolProbeResult | undefined): string {
  if (!status) {
    return 'Not checked';
  }
  if (status.status === 'ok') {
    return status.version ?? compactSettingsText(status.resolvedPath ?? status.executable, 42);
  }
  return compactSettingsText(status.error ?? 'Not available', 48);
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

function BoardKanban({
  tasks,
  repositories,
  showRepository,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  tasks: Task[];
  repositories: Repository[];
  showRepository: boolean;
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  const repositoryNames = new Map(repositories.map((repository) => [repository.id, repository.name]));
  return (
    <div className="tm-board">
      {BOARD_COLUMNS.map((column) => {
        const cards = columnTasks(tasks, column);
        return (
          <section className="tm-col" key={column.key}>
            <div className="tm-col__head">
              <span className="tm-col__dot" style={dotStyle(column.tone)} />
              <strong className="tm-col__label">{column.label}</strong>
              <span className="tm-col__count">{cards.length}</span>
            </div>
            <div className="tm-col__cards">
              {cards.map((task) => (
                <TaskCard
                  key={task.id}
                  vm={buildTaskCardVM(task, {
                    showRepo: showRepository,
                    columnKey: column.key,
                    repositoryName: repositoryNames.get(task.repositoryId)
                  })}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  onRequestDelete={onRequestDelete}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CardGrid({
  tasks,
  repositories,
  view,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  tasks: Task[];
  repositories: Repository[];
  view: NavView;
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  const showRepo = tasksSpanMultipleRepositories(tasks);
  const repositoryNames = new Map(repositories.map((repository) => [repository.id, repository.name]));
  const showReviewCount = view === 'review';
  return (
    <div className="tm-grid">
      {tasks.length === 0 ? (
        <div className="tm-grid__empty">Nothing here right now.</div>
      ) : (
        <div className="tm-grid__inner">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              vm={buildTaskCardVM(task, {
                showRepo,
                showReviewCount,
                repositoryName: repositoryNames.get(task.repositoryId)
              })}
              onSelect={onSelect}
              onArchive={onArchive}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskCard({
  vm,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  vm: TaskCardVM;
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  return (
    <article className={`tm-card ${vm.hasDecision ? 'tm-card--decision' : ''}`}>
      {/* Full-card click target sits behind the content so the kebab can be a
          real sibling next to the title (a button can't nest inside a button). */}
      <button
        type="button"
        className="tm-card__hit"
        aria-label={`Open ${vm.title}`}
        onClick={() => onSelect(vm.id)}
      />
      <div className="tm-card__body">
        <div className="tm-card__top">
          <span className="tm-card__num">{vm.num}</span>
          <span style={{ flex: 1 }} />
          {vm.showState ? <Chip tone={vm.stateTone} label={vm.stateLabel} /> : null}
        </div>
        <div className="tm-card__titlerow">
          <strong className="tm-card__title">{vm.title}</strong>
          <TaskActionsMenu
            taskId={vm.id}
            title={vm.title}
            archived={vm.archived}
            openTarget={{ type: 'repository', repositoryId: vm.repositoryId }}
            onArchive={onArchive}
            onRequestDelete={onRequestDelete}
            className="tm-card__actions"
          />
        </div>
        {vm.lineage ? (
          <div className="tm-card__lineage">
            <span aria-hidden="true">↳</span> {vm.lineage}
          </div>
        ) : null}
        {vm.meta ? <div className="tm-card__meta">{vm.meta}</div> : null}
        {vm.evidence.length > 0 ? (
        <div className="tm-card__evidence" aria-label="Task evidence">
          {vm.evidence.map((item, index) => (
            <span
              key={`${item.label}-${index}`}
              className={`tm-card__evidence-item ${
                item.tone ? `tm-card__evidence-item--${item.tone}` : ''
              }`}
            >
              <span className="tm-card__evidence-dot" aria-hidden="true" />
              {item.value ? (
                <span className="tm-card__evidence-value">{item.value}</span>
              ) : null}
              <span className="tm-card__evidence-label">{item.label}</span>
            </span>
          ))}
        </div>
        ) : null}
      </div>
    </article>
  );
}

function activeInteractionForTask(
  interactionRequests: InteractionRequestRecord[],
  taskId: string
): InteractionRequestRecord | undefined {
  return interactionRequests
    .filter(
      (interaction) =>
        interaction.taskId === taskId &&
        ['PENDING', 'RESPONDING'].includes(interaction.status)
    )
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0];
}

function Inbox({
  tasks,
  repositories,
  interactionRequests,
  onSelect,
  onRespondToInteraction
}: {
  tasks: Task[];
  repositories: Repository[];
  interactionRequests: InteractionRequestRecord[];
  onSelect(id: string): void;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
}) {
  const decisions = tasks.filter((task) => describeTaskAttention(task));

  return (
    <div className="tm-inbox">
      <div className="tm-inbox__inner">
        {decisions.length === 0 ? (
          <div className="tm-inbox__empty">
            <span className="tm-inbox__empty-mark">✓</span>
            <strong>All clear</strong>
            <span>Nothing needs your decision. The pipeline is running itself.</span>
          </div>
        ) : (
          decisions.map((task) => (
            <InboxDecisionCard
              key={task.id}
              task={task}
              repositoryName={repositories.find((repository) => repository.id === task.repositoryId)?.name}
              interaction={activeInteractionForTask(interactionRequests, task.id)}
              onSelect={onSelect}
              onRespondToInteraction={onRespondToInteraction}
            />
          ))
        )}
      </div>
    </div>
  );
}

function InboxDecisionCard({
  task,
  repositoryName,
  interaction,
  onSelect,
  onRespondToInteraction
}: {
  task: Task;
  repositoryName?: string;
  interaction?: InteractionRequestRecord;
  onSelect(id: string): void;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const attention = describeTaskAttention(task);
  const dotTone =
    attention?.tone === 'error' ? 'error' : attention?.tone === 'info' ? 'info' : 'action';
  // Inline decisions come straight from the interaction's allowed actions, so
  // answering here drives the same handler the detail page uses (no new IPC).
  const inline = interaction ? inboxInteractionDecisions(interaction) : {};

  const respond = async (decision: AgentInteractionDecision) => {
    if (!interaction || busy) {
      return;
    }
    setBusy(true);
    try {
      await onRespondToInteraction(interaction, decision);
    } catch {
      // The app shell surfaces the error and keeps the card so the user retries.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tm-decision">
      <div className="tm-decision__head">
        <span className={`tm-pulse tm-pulse--${dotTone}`} />
        <span className="tm-decision__kind">{attention?.label}</span>
      </div>
      <strong className="tm-decision__title">{task.title}</strong>
      <div className="tm-decision__task">
        {repositoryName ?? 'Unknown repository'} · {humanizeEnum(task.workflowPhase)}
      </div>
      <p className="tm-decision__summary">{attention?.detail ?? task.projection.summary}</p>
      <div className="tm-decision__actions">
        {inline.approve ? (
          <button
            type="button"
            className="primary-button tm-decision__approve"
            disabled={busy}
            onClick={() => void respond(inline.approve!.decision)}
          >
            {inline.approve.label}
          </button>
        ) : null}
        {inline.deny ? (
          <button
            type="button"
            className="outline-button tm-decision__deny"
            disabled={busy}
            onClick={() => void respond(inline.deny!.decision)}
          >
            {inline.deny.label}
          </button>
        ) : null}
        <button
          type="button"
          className="tm-decision__open"
          onClick={() => onSelect(task.id)}
        >
          Open task →
        </button>
      </div>
    </div>
  );
}

function compactSettingsText(value: string, maxLength = 72): string {
  if (value.length <= maxLength) {
    return value;
  }
  const headLength = 24;
  const tailLength = Math.max(12, maxLength - headLength - 3);
  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}

function formatSettingsTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'recently';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
