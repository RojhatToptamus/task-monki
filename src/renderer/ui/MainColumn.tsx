import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  type ExternalToolProbeResult,
  type ExternalToolStatusReport,
  type TaskManagerAppSettings,
  type TestExternalToolRequest,
  type UpdateAppSettingsRequest
} from '../../shared/contracts';
import { resolveBoardNavigationTarget } from '../model/boardKeyboardNavigation';
import { shouldShowTaskRepository } from '../model/boards';
import { inboxInteractionDecisions } from '../model/inboxDecisions';
import type { RepositorySetupState } from '../model/repositories';
import { describeTaskAttention } from '../model/taskAttention';
import { Chip, dotStyle } from './StatusBadge';
import { TaskActionsMenu } from './TaskActionsMenu';
import {
  SettingsView
} from './SettingsView';
import { FirstLaunchSetup } from './FirstLaunchSetup';
import type { ThemePreference } from './theme';
import {
  BOARD_COLUMNS,
  buildTaskCardVM,
  columnTasks,
  selectTaskCardRepositoryIdentity,
  tasksForView,
  tasksSpanMultipleRepositories,
  shouldShowInboxRepository,
  type NavView,
  type TaskCardVM
} from '../model/taskView';

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
  onSelect(taskId: string, trigger?: HTMLElement): void;
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
  onSelect(id: string, trigger?: HTMLElement): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  const [activeTaskByColumn, setActiveTaskByColumn] = useState<Record<string, string>>(
    {}
  );
  const taskButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const repositoriesById = new Map(
    repositories.map((repository) => [repository.id, repository])
  );
  const cardsByColumn = BOARD_COLUMNS.map((column) => columnTasks(tasks, column));

  const moveFocus = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    columnIndex: number,
    taskIndex: number
  ) => {
    const target = resolveBoardNavigationTarget(
      cardsByColumn.map((cards) => cards.map((task) => task.id)),
      columnIndex,
      taskIndex,
      event.key
    );
    if (!target) {
      return;
    }
    event.preventDefault();
    const targetColumn = BOARD_COLUMNS[target.columnIndex];
    const targetTask = cardsByColumn[target.columnIndex]?.[target.taskIndex];
    if (!targetColumn || !targetTask) {
      return;
    }
    setActiveTaskByColumn((current) => ({
      ...current,
      [targetColumn.key]: targetTask.id
    }));
    window.requestAnimationFrame(() => taskButtonRefs.current.get(targetTask.id)?.focus());
  };

  return (
    <div className="tm-board">
      {BOARD_COLUMNS.map((column, columnIndex) => {
        const cards = cardsByColumn[columnIndex] ?? [];
        const activeTaskId = cards.some(
          (task) => task.id === activeTaskByColumn[column.key]
        )
          ? activeTaskByColumn[column.key]
          : cards[0]?.id;
        return (
          <section className="tm-col" key={column.key}>
            <div className="tm-col__head">
              <span className="tm-col__dot" style={dotStyle(column.tone)} />
              <h2 className="tm-col__label">{column.label}</h2>
              <span className="tm-col__count">{cards.length}</span>
            </div>
            <div className="tm-col__cards">
              {cards.map((task, taskIndex) => (
                <TaskCard
                  key={task.id}
                  vm={buildTaskCardVM(task, {
                    columnKey: column.key,
                    ...selectTaskCardRepositoryIdentity(
                      task.repositoryId,
                      repositoriesById,
                      showRepository
                    )
                  })}
                  headingLevel={3}
                  tabIndex={task.id === activeTaskId ? 0 : -1}
                  buttonRef={(button) => {
                    if (button) {
                      taskButtonRefs.current.set(task.id, button);
                    } else {
                      taskButtonRefs.current.delete(task.id);
                    }
                  }}
                  onFocus={() =>
                    setActiveTaskByColumn((current) => ({
                      ...current,
                      [column.key]: task.id
                    }))
                  }
                  onKeyDown={(event) => moveFocus(event, columnIndex, taskIndex)}
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
  onSelect(id: string, trigger?: HTMLElement): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  const showRepo = tasksSpanMultipleRepositories(tasks);
  const repositoriesById = new Map(
    repositories.map((repository) => [repository.id, repository])
  );
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
                showReviewCount,
                columnKey: view === 'active' ? 'progress' : view,
                ...selectTaskCardRepositoryIdentity(
                  task.repositoryId,
                  repositoriesById,
                  showRepo
                )
              })}
              headingLevel={2}
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
  headingLevel = 3,
  tabIndex = 0,
  buttonRef,
  onFocus,
  onKeyDown,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  vm: TaskCardVM;
  headingLevel?: 2 | 3;
  tabIndex?: number;
  buttonRef?(button: HTMLButtonElement | null): void;
  onFocus?(): void;
  onKeyDown?(event: ReactKeyboardEvent<HTMLButtonElement>): void;
  onSelect(id: string, trigger?: HTMLElement): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  const TitleHeading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <article className="tm-card">
      {/* Full-card click target sits behind the content so the kebab can be a
          real sibling next to the title (a button can't nest inside a button). */}
      <button
        ref={buttonRef}
        type="button"
        className="tm-card__hit"
        aria-label={`Open ${vm.title}`}
        data-task-id={vm.id}
        tabIndex={tabIndex}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onClick={(event) => onSelect(vm.id, event.currentTarget)}
      />
      <div className="tm-card__body">
        {vm.meta || vm.showState ? (
          <div className="tm-card__top">
            {vm.meta ? <span className="tm-card__meta">{vm.meta}</span> : null}
            {vm.showState ? (
              <Chip tone={vm.stateTone} label={vm.stateLabel} showDot={false} />
            ) : null}
          </div>
        ) : null}
        <div className="tm-card__titlerow">
          <TitleHeading className="tm-card__title">{vm.title}</TitleHeading>
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
        {vm.evidence.length > 0 ? (
        <div className="tm-card__evidence" aria-label="Task evidence">
          {vm.evidence.map((item, index) => (
            <span
              key={`${item.label}-${index}`}
              className={`tm-card__evidence-item ${
                item.tone ? `tm-card__evidence-item--${item.tone}` : ''
              }`}
            >
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
  onSelect(id: string, trigger?: HTMLElement): void;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
}) {
  const decisions = tasks.filter((task) => describeTaskAttention(task));
  const repositoryNames = new Map(
    repositories.map((repository) => [repository.id, repository.name])
  );
  const showRepository = shouldShowInboxRepository(decisions, repositories);

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
              repositoryName={repositoryNames.get(task.repositoryId) ?? 'Missing repository'}
              showRepository={showRepository}
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

export function InboxDecisionCard({
  task,
  repositoryName,
  showRepository,
  interaction,
  onSelect,
  onRespondToInteraction
}: {
  task: Task;
  repositoryName: string;
  showRepository: boolean;
  interaction?: InteractionRequestRecord;
  onSelect(id: string, trigger?: HTMLElement): void;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const attention = describeTaskAttention(task);
  const attentionTone =
    attention?.tone === 'error' ? 'error' : attention?.tone === 'info' ? 'info' : 'action';
  // Inline decisions come straight from the interaction's allowed actions, so
  // answering here drives the same handler the detail page uses (no new IPC).
  const inline = interaction ? inboxInteractionDecisions(interaction) : {};
  const openIsPrimary = !inline.approve;

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
    <article className="tm-decision">
      <div className="tm-decision__body">
        <div className="tm-decision__head">
          <span className={`tm-decision__kind tm-decision__kind--${attentionTone}`}>
            {attention?.label}
          </span>
          {showRepository ? (
            <span className="tm-decision__repository">{repositoryName}</span>
          ) : null}
        </div>
        <h2 className="tm-decision__title">{task.title}</h2>
        <p className="tm-decision__summary" title={attention?.detail ?? task.projection.summary}>
          {attention?.detail ?? task.projection.summary}
        </p>
      </div>
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
          className={openIsPrimary ? 'tm-decision__open primary-button' : 'tm-decision__open'}
          aria-label={`Open task: ${task.title}`}
          data-task-id={task.id}
          onClick={(event) => onSelect(task.id, event.currentTarget)}
        >
          Open task
        </button>
      </div>
    </article>
  );
}
