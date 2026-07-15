import { useEffect, useState, type ReactNode } from 'react';
import type {
  AgentInteractionDecision,
  InteractionRequestRecord,
  Task
} from '../../shared/contracts';
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
import { inboxInteractionDecisions } from '../model/inboxDecisions';
import {
  buildExecutableTestRequest,
  selectExecutableDisplayStatus,
  shouldShowExecutablePathControls
} from '../model/executableSettings';
import type { RepositorySetupState } from '../model/repositories';
import { runtimeReadinessView } from '../model/runtimeReadiness';
import { describeTaskAttention } from './BoardView';
import { humanizeEnum } from './display';
import { Chip, dotStyle } from './StatusBadge';
import { TaskActionsMenu } from './TaskActionsMenu';
import type { ThemePreference } from './theme';
import {
  BOARD_COLUMNS,
  buildTaskCardVM,
  columnTasks,
  repositoryName,
  tasksForView,
  tasksSpanMultipleRepositories,
  type NavView,
  type TaskCardVM,
  type Tone
} from './taskView';

interface MainColumnProps {
  view: NavView;
  tasks: Task[];
  interactionRequests: InteractionRequestRecord[];
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  appSettings: TaskManagerAppSettings;
  onSetAppSettings(settings: UpdateAppSettingsRequest, successMessage?: string): void;
  externalToolStatus?: ExternalToolStatusReport;
  onRefreshExternalTools(): Promise<ExternalToolStatusReport>;
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  error?: string;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  activeRepositoryPath: string;
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
}

const VIEW_TITLES: Record<NavView, { title: string; subtitle(tasks: Task[]): string }> = {
  inbox: {
    title: 'Inbox',
    subtitle: () => 'Decisions and runs waiting on you'
  },
  board: {
    title: 'Board',
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
    subtitle: () => 'Workspace defaults and runtime configuration'
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
  tasks,
  interactionRequests,
  theme,
  onSetTheme,
  appSettings,
  onSetAppSettings,
  externalToolStatus,
  onRefreshExternalTools,
  onTestExternalTool,
  error,
  models,
  runtimes,
  activeRepositoryPath,
  repositorySetupState,
  addingRepository,
  onAddRepository,
  onFinishSetup,
  onSelect,
  onRespondToInteraction,
  onArchive,
  onRequestDelete
}: MainColumnProps) {
  const head = VIEW_TITLES[view];
  const showRepositorySetup = repositorySetupState !== 'complete' && view !== 'settings';
  const setupHead =
    repositorySetupState === 'complete'
      ? SETUP_VIEW_TITLES.needsReview
      : SETUP_VIEW_TITLES[repositorySetupState];

  return (
    <main className="tm-main">
      <div className="tm-main__head">
        <div style={{ minWidth: 0 }}>
          <h1 className="tm-main__title">{showRepositorySetup ? setupHead.title : head.title}</h1>
          <span className="tm-main__subtitle">
            {showRepositorySetup ? setupHead.subtitle : head.subtitle(tasks)}
          </span>
        </div>
      </div>

      {error ? <div className="tm-error">{error}</div> : null}

      {showRepositorySetup ? (
        <FirstLaunchSetup
          state={repositorySetupState}
          addingRepository={addingRepository}
          appSettings={appSettings}
          externalToolStatus={externalToolStatus}
          models={models}
          runtimes={runtimes}
          activeRepositoryPath={activeRepositoryPath}
          onAddRepository={onAddRepository}
          onFinishSetup={onFinishSetup}
          onRefreshExternalTools={onRefreshExternalTools}
          onTestExternalTool={onTestExternalTool}
          onSetAppSettings={onSetAppSettings}
        />
      ) : null}
      {!showRepositorySetup && view === 'board' ? (
        <BoardKanban
          tasks={tasks}
          onSelect={onSelect}
          onArchive={onArchive}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
      {!showRepositorySetup && (view === 'active' || view === 'review' || view === 'done') ? (
        <CardGrid
          tasks={tasksForView(tasks, view)}
          view={view}
          onSelect={onSelect}
          onArchive={onArchive}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
      {!showRepositorySetup && view === 'inbox' ? (
        <Inbox
          tasks={tasks}
          interactionRequests={interactionRequests}
          onSelect={onSelect}
          onRespondToInteraction={onRespondToInteraction}
        />
      ) : null}
      {!showRepositorySetup && view === 'settings' ? (
        <Settings
          theme={theme}
          onSetTheme={onSetTheme}
          appSettings={appSettings}
          onSetAppSettings={onSetAppSettings}
          externalToolStatus={externalToolStatus}
          onRefreshExternalTools={onRefreshExternalTools}
          onTestExternalTool={onTestExternalTool}
          models={models}
          runtimes={runtimes}
          activeRepositoryPath={activeRepositoryPath}
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
  onRefreshExternalTools(): Promise<ExternalToolStatusReport>;
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  onSetAppSettings(settings: UpdateAppSettingsRequest, successMessage?: string): void;
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
  onSetAppSettings(settings: UpdateAppSettingsRequest, successMessage?: string): void;
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
        const badge = describeToolStatus(row.status);
        const shouldConfigure = shouldShowExecutablePathControls(row.status, row.value);
        if (shouldConfigure) {
          return (
            <ExecutableSettingRow
              key={row.key}
              tool={row.key}
              label={row.label === 'GitHub CLI' ? 'GitHub CLI' : `${row.label} executable`}
              hint={row.hint}
              value={row.value}
              status={row.status}
              onSetPath={row.onSetPath}
              onTest={onTestExternalTool}
            />
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
  onSelect,
  onArchive,
  onRequestDelete
}: {
  tasks: Task[];
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  const showRepo = tasksSpanMultipleRepositories(tasks);
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
                  vm={buildTaskCardVM(task, { showRepo, columnKey: column.key })}
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
  view,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  tasks: Task[];
  view: NavView;
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  const showRepo = tasksSpanMultipleRepositories(tasks);
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
              vm={buildTaskCardVM(task, { showRepo, showReviewCount })}
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
            openTarget={{ type: 'repository', repositoryPath: vm.repositoryPath }}
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
  interactionRequests,
  onSelect,
  onRespondToInteraction
}: {
  tasks: Task[];
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
  interaction,
  onSelect,
  onRespondToInteraction
}: {
  task: Task;
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
        {repositoryName(task.repositoryPath)} · {humanizeEnum(task.workflowPhase)}
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

function selectSettingsModels(
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
          runtime.preflight.capabilities.promptRefinement.maturity !==
          'unsupported'
      )
      .map((runtime) => runtime.preflight.runtime.id)
  );
  const reviewRuntimeIds = new Set(
    runtimes
      .filter(
        (runtime) =>
          runtime.preflight.readiness.canStart &&
          (runtime.preflight.capabilities.review.maturity !== 'unsupported' ||
            runtime.preflight.capabilities.extensions.genericDetachedReview?.maturity ===
              'stable')
      )
      .map((runtime) => runtime.preflight.runtime.id)
  );
  const firstPromptRefinementRuntimeId =
    [...promptRefinementRuntimeIds][0] ?? defaultRuntimeId;
  const firstReviewRuntimeId = [...reviewRuntimeIds][0] ?? defaultRuntimeId;
  const promptRefinementRuntimeId =
    appSettings.promptRefinementRuntimeId &&
    promptRefinementRuntimeIds.has(appSettings.promptRefinementRuntimeId)
      ? appSettings.promptRefinementRuntimeId
      : promptRefinementRuntimeIds.has(defaultRuntimeId)
        ? defaultRuntimeId
        : firstPromptRefinementRuntimeId;
  const reviewRuntimeId =
    appSettings.reviewRuntimeId && reviewRuntimeIds.has(appSettings.reviewRuntimeId)
      ? appSettings.reviewRuntimeId
      : reviewRuntimeIds.has(defaultRuntimeId)
        ? defaultRuntimeId
        : firstReviewRuntimeId;
  const selectedDefaultModel = selectModel(
    models,
    appSettings.defaultModel,
    defaultRuntimeId,
    appSettings.defaultModelProvider
  );
  const selectedReviewModel = selectModel(
    models,
    appSettings.reviewModel,
    reviewRuntimeId,
    appSettings.reviewModelProvider
  );
  const selectedPromptRefinementModel = selectModel(
    models,
    appSettings.promptRefinementModel ?? DEFAULT_PROMPT_REFINEMENT_MODEL,
    promptRefinementRuntimeId,
    appSettings.promptRefinementModelProvider
  );
  const selectedDefaultEffort =
    resolveReasoningEffort(selectedDefaultModel, appSettings.defaultReasoningEffort) ?? '';
  const selectedReviewEffort =
    resolveReasoningEffort(selectedReviewModel, appSettings.reviewReasoningEffort) ?? '';

  return {
    defaultRuntimeId,
    promptRefinementRuntimeId,
    reviewRuntimeId,
    selectedDefaultModel,
    selectedPromptRefinementModel,
    selectedReviewModel,
    selectedDefaultEffort,
    selectedReviewEffort
  };
}

function Settings({
  theme,
  onSetTheme,
  appSettings,
  onSetAppSettings,
  externalToolStatus,
  onRefreshExternalTools,
  onTestExternalTool,
  models,
  runtimes,
  activeRepositoryPath
}: {
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  appSettings: TaskManagerAppSettings;
  onSetAppSettings(settings: UpdateAppSettingsRequest, successMessage?: string): void;
  externalToolStatus?: ExternalToolStatusReport;
  onRefreshExternalTools(): Promise<ExternalToolStatusReport>;
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  activeRepositoryPath: string;
}) {
  const selectedModels = selectSettingsModels(models, runtimes, appSettings);
  const promptRefinementRuntimes = runtimes.filter(
    (runtime) =>
      runtime.preflight.readiness.canStart &&
      runtime.preflight.capabilities.promptRefinement.maturity !== 'unsupported'
  );
  const reviewRuntimes = runtimes.filter(
    (runtime) =>
      runtime.preflight.readiness.canStart &&
      (runtime.preflight.capabilities.review.maturity !== 'unsupported' ||
        runtime.preflight.capabilities.extensions.genericDetachedReview?.maturity ===
          'stable')
  );
  const rows: Array<{ k: string; hint: string; v: string }> = [
    {
      k: 'Repository',
      hint: 'Active task context',
      v: activeRepositoryPath ? repositoryName(activeRepositoryPath) : 'Not set'
    }
  ];

  return (
    <div className="tm-settings">
      <SettingsGroup title="Appearance">
        <div className="tm-settings__row">
          <div style={{ minWidth: 0 }}>
            <div className="tm-settings__k">Theme</div>
          </div>
          <div className="tm-segtoggle" role="group" aria-label="Theme">
            <button
              type="button"
              className={`tm-segtoggle__btn ${theme === 'light' ? 'tm-segtoggle__btn--active' : ''}`}
              onClick={() => onSetTheme('light')}
            >
              Light
            </button>
            <button
              type="button"
              className={`tm-segtoggle__btn ${theme === 'dark' ? 'tm-segtoggle__btn--active' : ''}`}
              onClick={() => onSetTheme('dark')}
            >
              Dark
            </button>
            <button
              type="button"
              className={`tm-segtoggle__btn ${theme === 'device' ? 'tm-segtoggle__btn--active' : ''}`}
              onClick={() => onSetTheme('device')}
            >
              Device
            </button>
          </div>
        </div>
        <SettingsSwitchRow
          label="Mascot animation"
          hint="Show the task detail mascot"
          checked={appSettings.showMascot}
          onChange={(showMascot) => onSetAppSettings({ showMascot })}
        />
      </SettingsGroup>

      <SettingsGroup title="Models">
        <ModelSettingRow
          label="Default task model"
          hint="Used for new implementation tasks"
          runtimeId={selectedModels.defaultRuntimeId}
          value={selectedModels.selectedDefaultModel?.id ?? ''}
          effortValue={selectedModels.selectedDefaultEffort}
          models={models}
          runtimes={runtimes}
          onRuntimeChange={(runtimeId) => {
            const nextModel = selectModel(models, undefined, runtimeId);
            onSetAppSettings({
              defaultRuntimeId: runtimeId,
              defaultModel: nextModel?.model ?? null,
              defaultModelProvider: nextModel?.modelProvider ?? null,
              defaultReasoningEffort: resolveReasoningEffort(nextModel, undefined) ?? null
            });
          }}
          onModelChange={(modelId) => {
            const nextModel = models.find((candidate) => candidate.id === modelId);
            onSetAppSettings({
              defaultModel: nextModel?.model ?? null,
              defaultModelProvider: nextModel?.modelProvider ?? null,
              defaultReasoningEffort: resolveReasoningEffort(
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
        <ModelSettingRow
          label="Prompt refinement model"
          hint="Used when improving task descriptions"
          runtimeId={selectedModels.promptRefinementRuntimeId}
          value={selectedModels.selectedPromptRefinementModel?.id ?? ''}
          models={models}
          runtimes={promptRefinementRuntimes}
          onRuntimeChange={(runtimeId) => {
            const nextModel = selectModel(models, undefined, runtimeId);
            onSetAppSettings({
              promptRefinementRuntimeId: runtimeId,
              promptRefinementModel: nextModel?.model ?? null,
              promptRefinementModelProvider: nextModel?.modelProvider ?? null
            });
          }}
          onModelChange={(modelId) => {
            const nextModel = models.find((candidate) => candidate.id === modelId);
            onSetAppSettings({
              promptRefinementModel: nextModel?.model ?? null,
              promptRefinementModelProvider: nextModel?.modelProvider ?? null
            });
          }}
        />
        <ModelSettingRow
          label="Review model"
          hint="Used for AI quality-gate reviews"
          runtimeId={selectedModels.reviewRuntimeId}
          value={selectedModels.selectedReviewModel?.id ?? ''}
          effortValue={selectedModels.selectedReviewEffort}
          models={models}
          runtimes={reviewRuntimes}
          onRuntimeChange={(runtimeId) => {
            const nextModel = selectModel(models, undefined, runtimeId);
            onSetAppSettings({
              reviewRuntimeId: runtimeId,
              reviewModel: nextModel?.model ?? null,
              reviewModelProvider: nextModel?.modelProvider ?? null,
              reviewReasoningEffort: resolveReasoningEffort(nextModel, undefined) ?? null
            });
          }}
          onModelChange={(modelId) => {
            const nextModel = models.find((candidate) => candidate.id === modelId);
            onSetAppSettings({
              reviewModel: nextModel?.model ?? null,
              reviewModelProvider: nextModel?.modelProvider ?? null,
              reviewReasoningEffort: resolveReasoningEffort(
                nextModel,
                appSettings.reviewReasoningEffort
              ) ?? null
            });
          }}
          onEffortChange={(reasoningEffort) =>
            onSetAppSettings({
              reviewReasoningEffort: reasoningEffort || null
            })
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Agent runtimes">
        {runtimes
          .filter((runtime) => runtime.preflight.runtime.id !== 'codex')
          .map((runtime) => (
            <RuntimeExecutableSettingRow
              key={runtime.preflight.runtime.id}
              runtime={runtime}
              value={
                appSettings.runtimeExecutablePaths[
                  runtime.preflight.runtime.id
                ] ?? null
              }
              onSetPath={(executablePath) =>
                onSetAppSettings({
                  runtimeExecutablePaths: {
                    [runtime.preflight.runtime.id]: executablePath
                  }
                })
              }
            />
          ))}
      </SettingsGroup>

      <SettingsGroup title="Codex tools">
        <ExternalToolSettingRow
          label="Web search"
          hint="Codex search tool"
          value={appSettings.codexExternalTools.webSearchMode}
          options={[
            { value: 'disabled', label: 'Disabled' },
            { value: 'cached', label: 'Cached' },
            { value: 'live', label: 'Live' }
          ]}
          onChange={(webSearchMode) =>
            onSetAppSettings({
              codexExternalTools: { webSearchMode }
            })
          }
        />
        <ExternalToolSettingRow
          label="MCP servers"
          hint="Configured Codex servers"
          value={appSettings.codexExternalTools.mcpServers}
          options={[
            { value: 'disabled', label: 'Disabled' },
            { value: 'all', label: 'All enabled' }
          ]}
          onChange={(mcpServers) =>
            onSetAppSettings({
              codexExternalTools: { mcpServers }
            })
          }
        />
        <ExternalToolSettingRow
          label="Apps"
          hint="Codex apps and connectors"
          value={appSettings.codexExternalTools.apps}
          options={[
            { value: 'disabled', label: 'Disabled' },
            { value: 'enabled', label: 'Enabled' }
          ]}
          onChange={(apps) =>
            onSetAppSettings({
              codexExternalTools: { apps }
            })
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Executables">
        <ExecutableSettingRow
          tool="git"
          label="Git executable"
          hint="Required for repository evidence"
          value={appSettings.externalExecutables.gitExecutablePath}
          status={externalToolStatus?.tools.git}
          onSetPath={(gitExecutablePath) =>
            onSetAppSettings({
              externalExecutables: { gitExecutablePath }
            })
          }
          onTest={onTestExternalTool}
        />
        <ExecutableSettingRow
          tool="codex"
          label="Codex executable"
          hint="Required for agent runs"
          value={appSettings.externalExecutables.codexExecutablePath}
          status={externalToolStatus?.tools.codex}
          onSetPath={(codexExecutablePath) =>
            onSetAppSettings({
              externalExecutables: { codexExecutablePath }
            })
          }
          onTest={onTestExternalTool}
        />
        <ExecutableSettingRow
          tool="gh"
          label="GitHub CLI"
          hint="Optional for PR delivery"
          value={appSettings.externalExecutables.ghExecutablePath}
          status={externalToolStatus?.tools.gh}
          onSetPath={(ghExecutablePath) =>
            onSetAppSettings({
              externalExecutables: { ghExecutablePath }
            })
          }
          onTest={onTestExternalTool}
        />
        <div className="tm-settings__row">
          <div style={{ minWidth: 0 }}>
            <div className="tm-settings__k">Tool status</div>
            <div className="tm-settings__hint">
              {externalToolStatus
                ? `Checked ${formatSettingsTime(externalToolStatus.refreshedAt)}`
                : 'Not checked'}
            </div>
          </div>
          <button
            type="button"
            className="tm-settings__button"
            onClick={() => void onRefreshExternalTools()}
          >
            Refresh
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Workspace">
        {rows.map((row) => (
          <div className="tm-settings__row" key={row.k}>
            <div style={{ minWidth: 0 }}>
              <div className="tm-settings__k">{row.k}</div>
              <div className="tm-settings__hint">{row.hint}</div>
            </div>
            <span className="tm-settings__v">{row.v}</span>
          </div>
        ))}
      </SettingsGroup>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tm-settings__group" aria-label={title}>
      <h2 className="tm-settings__group-title">{title}</h2>
      <div className="tm-settings__card">{children}</div>
    </section>
  );
}

function SettingsSwitchRow({
  label,
  hint,
  checked,
  onChange
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div className="tm-settings__row">
      <div style={{ minWidth: 0 }}>
        <div className="tm-settings__k">{label}</div>
        <div className="tm-settings__hint">{hint}</div>
      </div>
      <button
        type="button"
        className={`network-toggle__switch ${checked ? 'network-toggle__switch--on' : ''}`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

function ExternalToolSettingRow<Value extends string>({
  label,
  hint,
  value,
  options,
  onChange
}: {
  label: string;
  hint: string;
  value: Value;
  options: Array<{ value: Value; label: string }>;
  onChange(value: Value): void;
}) {
  return (
    <div className="tm-settings__row">
      <div style={{ minWidth: 0 }}>
        <div className="tm-settings__k">{label}</div>
        <div className="tm-settings__hint">{hint}</div>
      </div>
      <div className="tm-settings__controls">
        <select
          className="tm-settings__select tm-settings__select--effort"
          value={value}
          onChange={(event) => onChange(event.target.value as Value)}
          aria-label={label}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function RuntimeExecutableSettingRow({
  runtime,
  value,
  onSetPath
}: {
  runtime: AgentRuntimeState;
  value: string | null;
  onSetPath(path: string | null): void;
}) {
  const savedPath = value ?? '';
  const [mode, setMode] = useState<'auto' | 'custom'>(
    savedPath ? 'custom' : 'auto'
  );
  const [draftPath, setDraftPath] = useState(savedPath);

  useEffect(() => {
    setMode(savedPath ? 'custom' : 'auto');
    setDraftPath(savedPath);
  }, [savedPath]);

  const normalizedDraft = draftPath.trim();
  const canSave =
    mode === 'auto'
      ? value !== null
      : Boolean(normalizedDraft) && normalizedDraft !== savedPath;
  const readiness = runtimeReadinessView(runtime);
  const statusDetail = readiness.nextAction ??
    (readiness.canStart && runtime.preflight.runtimeVersion
      ? `Version ${runtime.preflight.runtimeVersion}`
      : readiness.detail);

  return (
    <div className="tm-settings__row">
      <div style={{ minWidth: 0 }}>
        <div className="tm-settings__k">
          {runtime.preflight.runtime.displayName}
        </div>
        <div className="tm-settings__hint">
          {readiness.label} · {statusDetail}
        </div>
      </div>
      <div className="tm-settings__controls">
        <select
          className="tm-settings__select tm-settings__select--effort"
          value={mode}
          aria-label={`${runtime.preflight.runtime.displayName} executable mode`}
          onChange={(event) => {
            const nextMode = event.target.value as 'auto' | 'custom';
            setMode(nextMode);
            if (nextMode === 'auto') {
              setDraftPath('');
            }
          }}
        >
          <option value="auto">Auto-detect</option>
          <option value="custom">Custom path</option>
        </select>
        {mode === 'custom' ? (
          <input
            className="tm-settings__input"
            value={draftPath}
            placeholder="/path/to/executable"
            aria-label={`${runtime.preflight.runtime.displayName} executable path`}
            onChange={(event) => setDraftPath(event.target.value)}
          />
        ) : null}
        <button
          type="button"
          className="outline-button"
          disabled={!canSave}
          onClick={() =>
            onSetPath(mode === 'auto' ? null : normalizedDraft)
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

function ExecutableSettingRow({
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
  const savedPath = value ?? '';
  const [mode, setMode] = useState<'auto' | 'custom'>(savedPath ? 'custom' : 'auto');
  const [draftPath, setDraftPath] = useState(savedPath);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ExternalToolProbeResult>();
  // Feedback shown below the controls after the user clicks Test. Kept separate
  // from `testResult` (which feeds the passive badge) so the outcome message is
  // only tied to an explicit test action.
  const [testFeedback, setTestFeedback] = useState<ExecutableTestFeedback>();

  const resetTestFeedback = () => {
    setTestResult(undefined);
    setTestFeedback(undefined);
  };

  useEffect(() => {
    setMode(savedPath ? 'custom' : 'auto');
    setDraftPath(savedPath);
    resetTestFeedback();
  }, [savedPath]);

  const isCustom = mode === 'custom';
  const normalizedDraft = draftPath.trim();
  const hasPendingCustomPath = isCustom && normalizedDraft !== savedPath;
  const displayStatus = selectExecutableDisplayStatus(status, testResult);
  const badge = describeToolStatus(displayStatus);
  const resolvedMeta = displayStatus
    ? compactSettingsText(displayStatus.resolvedPath ?? displayStatus.executable)
    : null;
  const versionMeta =
    displayStatus?.status === 'ok' && displayStatus.version ? displayStatus.version : null;

  const runTest = async () => {
    setIsTesting(true);
    setTestResult(undefined);
    setTestFeedback({ state: 'running' });
    try {
      const result = await onTest(buildExecutableTestRequest(tool, mode, draftPath));
      setTestResult(result);
      setTestFeedback(
        result.status === 'ok'
          ? {
              state: 'passed',
              path: result.resolvedPath ?? result.executable,
              version: result.version
            }
          : { state: 'failed', message: result.error ?? 'The tool could not be verified.' }
      );
    } catch (caught) {
      setTestFeedback({
        state: 'failed',
        message: caught instanceof Error ? caught.message : 'The test could not be run.'
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="tm-exec">
      <div className="tm-exec__head">
        <div className="tm-exec__title" style={{ minWidth: 0 }}>
          <div className="tm-settings__k">{label}</div>
          <div className="tm-settings__hint">{hint}</div>
        </div>
        <span className={`tm-exec__badge tm-exec__badge--${badge.tone}`}>
          <span className="tm-exec__dot" aria-hidden="true" />
          {badge.label}
        </span>
      </div>

      {resolvedMeta ? (
        <div className="tm-exec__meta">
          <span className="tm-exec__source">{humanizeEnum(displayStatus!.source)}</span>
          <span className="tm-exec__path">{resolvedMeta}</span>
          {versionMeta ? <span className="tm-exec__version">{versionMeta}</span> : null}
        </div>
      ) : null}

      <div className="tm-exec__controls">
        <select
          className="tm-settings__select tm-settings__select--mode"
          value={mode}
          onChange={(event) => {
            const nextMode = event.target.value === 'custom' ? 'custom' : 'auto';
            setMode(nextMode);
            resetTestFeedback();
            if (nextMode === 'auto') {
              setDraftPath('');
              onSetPath(null);
            }
          }}
          aria-label={`${label} mode`}
        >
          <option value="auto">Auto</option>
          <option value="custom">Custom</option>
        </select>
        <input
          className="tm-settings__input"
          value={draftPath}
          onChange={(event) => {
            setDraftPath(event.target.value);
            resetTestFeedback();
          }}
          disabled={!isCustom}
          placeholder={displayStatus?.resolvedPath ?? displayStatus?.executable ?? 'Auto-detect'}
          aria-label={`${label} path`}
        />
        <div className="tm-exec__actions">
          {hasPendingCustomPath ? (
            <button
              type="button"
              className="tm-settings__button tm-settings__button--primary"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                resetTestFeedback();
                onSetPath(normalizedDraft || null);
              }}
            >
              Save
            </button>
          ) : null}
          <button
            type="button"
            className="tm-settings__button"
            disabled={isTesting}
            aria-busy={isTesting}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runTest()}
          >
            Test
          </button>
          <button
            type="button"
            className="tm-settings__button"
            disabled={!savedPath && !draftPath}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setMode('auto');
              setDraftPath('');
              resetTestFeedback();
              onSetPath(null);
            }}
          >
            Reset
          </button>
        </div>
      </div>

      {testFeedback ? <ExecutableTestFeedbackStrip feedback={testFeedback} /> : null}
    </div>
  );
}

type ExecutableTestFeedback =
  | { state: 'running' }
  | { state: 'passed'; path: string; version: string | null }
  | { state: 'failed'; message: string };

function ExecutableTestFeedbackStrip({ feedback }: { feedback: ExecutableTestFeedback }) {
  if (feedback.state === 'running') {
    return (
      <div className="tm-exec__test tm-exec__test--running" role="status" aria-live="polite">
        <span className="tm-exec__spinner" aria-hidden="true" />
        <span>Testing…</span>
      </div>
    );
  }

  if (feedback.state === 'passed') {
    return (
      <div className="tm-exec__test tm-exec__test--passed" role="status" aria-live="polite">
        <span className="tm-exec__test-icon" aria-hidden="true">
          ✓
        </span>
        <span className="tm-exec__test-text">
          <strong>Test passed</strong>
        </span>
      </div>
    );
  }

  return (
    <div className="tm-exec__test tm-exec__test--failed" role="alert" aria-live="assertive">
      <span className="tm-exec__test-icon" aria-hidden="true">
        ✕
      </span>
      <span className="tm-exec__test-text">
        <strong>Test failed</strong>
        <span className="tm-exec__test-message">{feedback.message}</span>
      </span>
    </div>
  );
}

function describeToolStatus(
  status: ExternalToolProbeResult | undefined
): { tone: 'ok' | 'error' | 'muted'; label: string } {
  if (!status) {
    return { tone: 'muted', label: 'Not checked' };
  }
  if (status.status === 'ok') {
    return { tone: 'ok', label: 'Available' };
  }
  return {
    tone: status.required ? 'error' : 'muted',
    label: status.required ? 'Unavailable' : 'Optional'
  };
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

function ModelSettingRow({
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
  hint: string;
  runtimeId: string;
  value: string;
  effortValue?: string;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  onRuntimeChange(value: string): void;
  onModelChange(value: string): void;
  onEffortChange?(value: string): void;
}) {
  const runtimeModels = models.filter((model) => model.runtimeId === runtimeId);
  const selected = runtimeModels.find((model) => model.id === value);
  const efforts = [
    ...new Set(
      [
        ...(selected?.supportedReasoningEfforts ?? []),
        selected?.defaultReasoningEffort,
        effortValue
      ].filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
    )
  ];
  return (
    <div className="tm-settings__row tm-settings__row--models">
      <div style={{ minWidth: 0 }}>
        <div className="tm-settings__k">{label}</div>
        <div className="tm-settings__hint">
          {hint}
          {onEffortChange && effortValue ? ` · ${effortValue}` : ''}
        </div>
      </div>
      <div className="tm-settings__controls">
        <select
          className="tm-settings__select tm-settings__select--model"
          value={runtimeId}
          onChange={(event) => onRuntimeChange(event.target.value)}
          disabled={runtimes.length === 0}
          aria-label={`${label} runtime`}
        >
          {runtimes.map((runtime) => (
            <option
              key={runtime.preflight.runtime.id}
              value={runtime.preflight.runtime.id}
            >
              {runtime.preflight.runtime.displayName}
              {runtimeReadinessView(runtime).optionSuffix}
            </option>
          ))}
        </select>
        <select
          className="tm-settings__select tm-settings__select--model"
          value={value}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={runtimeModels.length === 0}
          aria-label={`${label} model`}
        >
          {runtimeModels
            .filter((model) => !model.hidden || model.id === value)
            .map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
        </select>
        {onEffortChange ? (
          <select
            className="tm-settings__select tm-settings__select--effort"
            value={effortValue}
            onChange={(event) => onEffortChange(event.target.value)}
            disabled={efforts.length === 0}
            aria-label={`${label} reasoning effort`}
          >
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}
