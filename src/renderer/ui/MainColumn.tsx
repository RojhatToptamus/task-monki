import type { AgentProfilesSettingsActions } from './AgentProfilesSettings';
import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  CircleCheck,
  CircleQuestionMark,
  CircleX,
  FolderX,
  GitBranch,
  GitFork,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  ListChecks,
  RotateCcw,
  ShieldQuestionMark,
  type LucideIcon
} from 'lucide-react';
import type {
  AgentInteractionDecision,
  Board,
  InteractionRequestRecord,
  Repository
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
import type { RepositoryOption, RepositorySetupState } from '../model/repositories';
import type { RepositorySettingsActions } from './RepositorySettings';
import { describeTaskAttention, type TaskAttentionKind, type TaskAttentionTone } from '../model/taskAttention';
import { formatShortAge } from '../model/timeAgo';
import { AccessibleTab } from './AccessibleTabs';
import { PlusIcon } from './AppNavigation';
import { Chip } from './StatusBadge';
import { Tooltip } from './Tooltip';
import { TaskActionsMenu } from './TaskActionsMenu';
import {
  SettingsView
} from './SettingsView';
import { FirstLaunchSetup } from './FirstLaunchSetup';
import type { ThemePreference, ThemePreset } from './theme';
import type { SoftwareUpdateState } from '../../shared/softwareUpdate';
import {
  BOARD_COLUMNS,
  buildTaskCardVM,
  columnTasks,
  selectTaskCardRepositoryIdentity,
  tasksForView,
  tasksSpanMultipleRepositories,
  shouldShowInboxRepository,
  isTasksView,
  type NavView,
  type TasksView,
  type TaskCardPullRequest,
  type TaskCardSource,
  type TaskCardVM
} from '../model/taskView';

interface MainColumnProps extends AgentProfilesSettingsActions, RepositorySettingsActions {
  repositoryOptions: RepositoryOption[];
  view: NavView;
  board?: Board;
  boards: Board[];
  onShowTasksView(view: TasksView): void;
  onShowBoard(boardId: string): void;
  onNewBoard(): void;
  tasks: TaskCardSource[];
  repositories: Repository[];
  interactionRequests: InteractionRequestRecord[];
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  onPreviewThemePreset(themePreset: ThemePreset | null): void;
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
  error?: string;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  activeRepository?: Repository;
  repositorySetupState: RepositorySetupState;
  onFinishSetup(): Promise<void>;
  onGoToDesigns(): void;
  onSelect(taskId: string, trigger?: HTMLElement): void;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
  onArchive(taskId: string): void;
  onRequestDelete(taskId: string): void;
  onEditBoard(board: Board): void;
}

function inboxSubtitle(tasks: TaskCardSource[]): string | undefined {
  const waiting = tasks.filter((task) => describeTaskAttention(task)).length;
  return waiting > 0 ? `${waiting} waiting on you` : undefined;
}

/** The Tasks page's built-in views, in tab order. Saved views follow them. */
const TASKS_VIEWS: Array<{ view: TasksView; label: string }> = [
  { view: 'board', label: 'All' },
  { view: 'active', label: 'Running' },
  { view: 'review', label: 'In review' },
  { view: 'done', label: 'Done' }
];

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
    subtitle: 'Choose a repository and default model. Both stay editable in Settings.'
  },
  needsReview: {
    title: 'Set up Task Monki',
    subtitle: 'Choose a repository and default model. Both stay editable in Settings.'
  }
};

export function MainColumn({
  view,
  board,
  boards,
  onShowTasksView,
  onShowBoard,
  onNewBoard,
  tasks,
  repositories,
  interactionRequests,
  theme,
  onSetTheme,
  onPreviewThemePreset,
  appSettings,
  onSetAppSettings,
  onSaveAgentProfile,
  onDeleteAgentProfile,
  softwareUpdateState,
  onCheckForSoftwareUpdates,
  onDownloadSoftwareUpdate,
  onInstallSoftwareUpdate,
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
  repositoryOptions,
  revealLabel,
  onRefreshRepository,
  onReconnectRepository,
  onDisconnectRepository,
  onRevealRepository,
  onFinishSetup,
  onGoToDesigns,
  onSelect,
  onRespondToInteraction,
  onArchive,
  onRequestDelete,
  onEditBoard
}: MainColumnProps) {
  const tasksPage = isTasksView(view);
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));
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
      {showRepositorySetup ? (
        <PageHead title={setupHead.title} subtitle={setupHead.subtitle} />
      ) : tasksPage ? (
        <TasksHead
          view={view}
          board={board}
          boards={boards}
          onShowTasksView={onShowTasksView}
          onShowBoard={onShowBoard}
          onNewBoard={onNewBoard}
          onEditBoard={onEditBoard}
        />
      ) : view === 'inbox' ? (
        <PageHead title="Inbox" subtitle={inboxSubtitle(tasks)} />
      ) : null}

      {error ? <div className="tm-error tm-error--page">{error}</div> : null}

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
          onGoToDesigns={onGoToDesigns}
          onRefreshExternalTools={onRefreshExternalTools}
          onDiscoverAgentRuntimeModels={onDiscoverAgentRuntimeModels}
          onSetAppSettings={onSetAppSettings}
        />
      ) : null}
      {!showRepositorySetup && tasksPage ? (
        <div className="tm-main__panel" id="tasks-view-panel" role="tabpanel" aria-labelledby={tasksTabId(view, board)}>
      {view === 'board' ? (
        <BoardKanban
          tasks={tasks}
          taskTitles={taskTitles}
          repositories={repositories}
          showRepository={shouldShowTaskRepository(board)}
          onSelect={onSelect}
          onArchive={onArchive}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
      {view === 'active' || view === 'review' || view === 'done' ? (
        <CardGrid
          tasks={tasksForView(tasks, view)}
          taskTitles={taskTitles}
          repositories={repositories}
          view={view}
          onSelect={onSelect}
          onArchive={onArchive}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
        </div>
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
          repositories={repositoryOptions}
          addingRepository={addingRepository}
          revealLabel={revealLabel}
          onAddRepository={onAddRepository}
          onRefreshRepository={onRefreshRepository}
          onReconnectRepository={onReconnectRepository}
          onDisconnectRepository={onDisconnectRepository}
          onRevealRepository={onRevealRepository}
          onSaveAgentProfile={onSaveAgentProfile}
          onDeleteAgentProfile={onDeleteAgentProfile}
          theme={theme}
          onSetTheme={onSetTheme}
          onPreviewThemePreset={onPreviewThemePreset}
          appSettings={appSettings}
          onSetAppSettings={onSetAppSettings}
          softwareUpdateState={softwareUpdateState}
          onCheckForSoftwareUpdates={onCheckForSoftwareUpdates}
          onDownloadSoftwareUpdate={onDownloadSoftwareUpdate}
          onInstallSoftwareUpdate={onInstallSoftwareUpdate}
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
function PageHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="tm-main__head">
      <div className="tm-main__head-copy">
        <h1 className="tm-main__title">{title}</h1>
        {subtitle ? <span className="tm-main__subtitle">{subtitle}</span> : null}
      </div>
    </div>
  );
}

function tasksTabId(view: TasksView, board?: Board): string {
  return board ? `tasks-view-board-${board.id}` : `tasks-view-${view}`;
}

/**
 * The Tasks page: one title, then the views as tabs. The built-in views come
 * first; saved views follow with their marker, and the last control adds one.
 */
function TasksHead({
  view,
  board,
  boards,
  onShowTasksView,
  onShowBoard,
  onNewBoard,
  onEditBoard
}: {
  view: TasksView;
  board?: Board;
  boards: Board[];
  onShowTasksView(view: TasksView): void;
  onShowBoard(boardId: string): void;
  onNewBoard(): void;
  onEditBoard(board: Board): void;
}) {
  return (
    <>
      <div className="tm-main__head">
        <div className="tm-main__head-copy">
          <h1 className="tm-main__title">Tasks</h1>
        </div>
        {board ? (
          <button type="button" className="ghost-button tm-main__head-action" onClick={() => onEditBoard(board)}>
            Edit view
          </button>
        ) : null}
      </div>
      <div className="tm-main__tabbar">
        <div className="tm-tabs" role="tablist" aria-label="Task views">
          {TASKS_VIEWS.map((item) => (
            <AccessibleTab
              key={item.view}
              id={tasksTabId(item.view)}
              panelId="tasks-view-panel"
              label={item.label}
              selected={!board && view === item.view}
              onSelect={() => onShowTasksView(item.view)}
            />
          ))}
          {boards.map((saved) => (
            <AccessibleTab
              key={saved.id}
              id={tasksTabId('board', saved)}
              panelId="tasks-view-panel"
              label={saved.name}
              marker={<span className="tm-board-color" data-board-color={saved.color.toLowerCase()} aria-hidden="true" />}
              selected={board?.id === saved.id}
              onSelect={() => onShowBoard(saved.id)}
            />
          ))}
        </div>
        <Tooltip label="New view">
          <button type="button" className="tm-iconbtn tm-main__tab-add" aria-label="New view" onClick={onNewBoard}>
            <PlusIcon />
          </button>
        </Tooltip>
      </div>
    </>
  );
}

function BoardKanban({
  tasks,
  taskTitles,
  repositories,
  showRepository,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  tasks: TaskCardSource[];
  taskTitles: ReadonlyMap<string, string>;
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
              <h2 className="tm-col__label">{column.label}</h2>
              <span className="tm-col__count">{cards.length}</span>
            </div>
            <div className="tm-col__cards">
              {cards.map((task, taskIndex) => (
                <TaskCard
                  key={task.id}
                  vm={buildTaskCardVM(task, {
                    columnKey: column.key,
                    taskTitles,
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
  taskTitles,
  repositories,
  view,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  tasks: TaskCardSource[];
  taskTitles: ReadonlyMap<string, string>;
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
                taskTitles,
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
              <Chip
                tone={vm.stateInFlight && vm.stateTone === 'neutral' ? 'info' : vm.stateTone}
                label={vm.stateLabel}
              />
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
          <div className="tm-card__fact">
            <GitFork aria-hidden="true" size={13} />
            <span>{vm.lineage}</span>
          </div>
        ) : null}
        {vm.findings ? <div className="tm-card__fact">{vm.findings}</div> : null}
        {vm.pullRequest ? (
          <div className="tm-card__foot">
            <CardPullRequest pullRequest={vm.pullRequest} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

const PULL_REQUEST_ICONS = {
  draft: GitPullRequestDraft,
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed
} as const;

/** GitHub's convention: the icon carries the state, the number names the PR. */
function CardPullRequest({ pullRequest }: { pullRequest: TaskCardPullRequest }) {
  const Icon = PULL_REQUEST_ICONS[pullRequest.state];
  const name = pullRequest.number ? `#${pullRequest.number}` : 'Pull request';
  return (
    <span className="tm-card__pr">
      <Icon aria-hidden="true" size={13} />
      <span className="tm-card__pr-name">{name}</span>
      <span className="tm-visually-hidden">, {pullRequest.state}</span>
      {pullRequest.note ? <span className="tm-card__pr-note">{pullRequest.note}</span> : null}
    </span>
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
  tasks: TaskCardSource[];
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
            <span className="tm-inbox__empty-mark">
              <CircleCheck aria-hidden="true" size={18} />
            </span>
            <span>Approvals, questions and failed runs appear here.</span>
          </div>
        ) : (
          <ul className="tm-inbox__list" aria-label="Waiting on you">
            {decisions.map((task) => (
              <InboxRow
                key={task.id}
                task={task}
                repositoryName={repositoryNames.get(task.repositoryId) ?? 'Missing repository'}
                showRepository={showRepository}
                interaction={activeInteractionForTask(interactionRequests, task.id)}
                onSelect={onSelect}
                onRespondToInteraction={onRespondToInteraction}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const ATTENTION_ICONS: Record<TaskAttentionKind, LucideIcon> = {
  approval: ShieldQuestionMark,
  question: CircleQuestionMark,
  retry: RotateCcw,
  failure: CircleX,
  checkout: FolderX,
  git: GitBranch,
  review: ListChecks,
  delivery: GitPullRequest,
  finish: CircleCheck
};

/** The kind of decision as one glyph on a tint of its tone. */
function AttentionTile({ kind, tone }: { kind: TaskAttentionKind; tone: TaskAttentionTone }) {
  const Icon = ATTENTION_ICONS[kind];
  return (
    <span className="tm-attention-tile" data-tone={tone} aria-hidden="true">
      <Icon size={16} />
    </span>
  );
}

/**
 * One task waiting on the user: what it needs, then the task.
 * The whole row opens it; a plain command approval is answerable in place.
 */
export function InboxRow({
  task,
  repositoryName,
  showRepository,
  interaction,
  onSelect,
  onRespondToInteraction
}: {
  task: TaskCardSource;
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
  const subjectId = useId();
  const attention = describeTaskAttention(task);
  // Inline decisions come straight from the interaction's allowed actions, so
  // answering here drives the same handler the detail page uses (no new IPC).
  const inline = interaction ? inboxInteractionDecisions(interaction) : {};
  if (!attention) {
    return null;
  }
  const age = formatShortAge(task.updatedAt);
  const respond = async (decision: AgentInteractionDecision) => {
    if (!interaction || busy) {
      return;
    }
    setBusy(true);
    try {
      await onRespondToInteraction(interaction, decision);
    } catch {
      // The app shell surfaces the error and keeps the row so the user retries.
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="tm-inbox-row">
      <button
        type="button"
        className="tm-inbox-row__hit"
        aria-label={`Open ${task.title}`}
        data-task-id={task.id}
        onClick={(event) => onSelect(task.id, event.currentTarget)}
      />
      <AttentionTile kind={attention.kind} tone={attention.tone} />
      <div className="tm-inbox-row__main">
        <h2 className="tm-inbox-row__title">{task.title}</h2>
        <p className="tm-inbox-row__why">
          <span className="tm-inbox-row__status" data-tone={attention.tone}>{attention.label}</span>
          {inline.subject ? (
            <code id={subjectId} className="tm-inbox-row__subject">{inline.subject}</code>
          ) : inline.question ? (
            <span className="tm-inbox-row__detail">
              {inline.question.text}
              {inline.question.more > 0 ? (
                <span className="tm-inbox-row__more">
                  {inline.question.more} more question{inline.question.more === 1 ? '' : 's'}
                </span>
              ) : null}
            </span>
          ) : attention.detail ? (
            <span className="tm-inbox-row__detail">{attention.detail}</span>
          ) : null}
        </p>
      </div>
      {inline.approve || inline.deny ? (
        <div className="tm-inbox-row__actions">
          {/* Same order as the Agent tab: refusal first, the default beside it. */}
          {inline.deny ? (
            <button
              type="button"
              className="outline-button button--sm"
              disabled={busy}
              aria-describedby={subjectId}
              onClick={() => void respond(inline.deny!.decision)}
            >
              {inline.deny.label}
            </button>
          ) : null}
          {inline.approve ? (
            <button
              type="button"
              className="primary-button button--sm"
              disabled={busy}
              aria-describedby={subjectId}
              onClick={() => void respond(inline.approve!.decision)}
            >
              {inline.approve.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {showRepository ? <span className="tm-inbox-row__repo">{repositoryName}</span> : null}
      {age ? (
        <time className="tm-inbox-row__age" dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString()}>{age}</time>
      ) : null}
    </li>
  );
}
