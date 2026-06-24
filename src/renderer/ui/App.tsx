import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  TASK_STORE_SCHEMA_VERSION,
  type CreateTaskRequest,
  type AgentInteractionDecision,
  type AgentProviderState,
  type AgentRetryStrategy,
  type InteractionRequestRecord,
  type TaskSnapshot,
  type WorkflowPhase
} from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import {
  selectActiveRun,
  selectCurrentWorktree,
  selectLatestGitSnapshot,
  selectLatestGitHubRepository,
  selectLatestBranchPublication,
  selectLatestPullRequest,
  selectLatestCiRollup,
  selectLatestReviewRollup,
  selectLatestMergeSnapshot,
  selectLatestTestRun,
  selectTaskEvents,
  selectTaskRuns
} from '../model/selectors';
import { MainColumn } from './MainColumn';
import { computeNavCounts, type NavView } from './taskView';
import { NewTaskPanel } from './NewTaskPanel';
import { TaskDetail } from './TaskDetail';

const emptySnapshot: TaskSnapshot = {
  schemaVersion: TASK_STORE_SCHEMA_VERSION,
  tasks: [],
  iterations: [],
  worktrees: [],
  gitSnapshots: [],
  testRuns: [],
  githubRepositories: [],
  branchPublications: [],
  pullRequests: [],
  ciRollups: [],
  reviewRollups: [],
  mergeSnapshots: [],
  runs: [],
  agentServers: [],
  agentSessions: [],
  agentItems: [],
  agentGoalSnapshots: [],
  agentPlanRevisions: [],
  agentUsageSnapshots: [],
  agentSettingsObservations: [],
  agentSubagentObservations: [],
  interactionRequests: [],
  events: [],
  artifacts: []
};

type ThemePreference = 'light' | 'dark';

export function App() {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(emptySnapshot);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [defaultRepositoryPath, setDefaultRepositoryPath] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<NavView>('board');
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [lastTaskId, setLastTaskId] = useState<string | undefined>();
  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() => getInitialTheme());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => getInitialCollapsed());
  const [providerState, setProviderState] = useState<AgentProviderState>();

  const openNewTask = useCallback(() => setIsNewTaskOpen(true), []);
  const closeNewTask = useCallback(() => setIsNewTaskOpen(false), []);
  const toggleSidebar = useCallback(() => setIsSidebarCollapsed((current) => !current), []);

  const refresh = useCallback(async () => {
    const next = await taskManagerApi.listTasks();
    setSnapshot(next);
    setSelectedTaskId((current) => current ?? next.tasks[0]?.id);
  }, []);

  useEffect(() => {
    window.localStorage.setItem('task-monki-theme', theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('task-monki-sidebar-collapsed', isSidebarCollapsed ? '1' : '0');
  }, [isSidebarCollapsed]);

  useEffect(() => {
    let canceled = false;

    async function load() {
      try {
        const [repoPath, provider] = await Promise.all([
          taskManagerApi.getDefaultRepositoryPath(),
          taskManagerApi.getAgentProviderState(),
          refresh()
        ]);
        if (!canceled) {
          setDefaultRepositoryPath(repoPath);
          setProviderState(provider);
        }
      } catch (caught) {
        if (!canceled) {
          setError(caught instanceof Error ? caught.message : 'Failed to load application state.');
        }
      } finally {
        if (!canceled) {
          setIsLoading(false);
        }
      }
    }

    void load();
    return () => {
      canceled = true;
    };
  }, [refresh]);

  useEffect(() => {
    return taskManagerApi.onUpdate((event) => {
      if (event.type === 'provider.updated') {
        void taskManagerApi.getAgentProviderState().then(setProviderState);
      }
      void refresh();
    });
  }, [refresh]);

  const selectedTask = snapshot.tasks.find((task) => task.id === selectedTaskId);
  const selectedRuns = useMemo(
    () => (selectedTask ? selectTaskRuns(snapshot, selectedTask.id) : []),
    [selectedTask, snapshot]
  );
  const selectedRun = selectedTask ? selectActiveRun(selectedTask, selectedRuns) : undefined;
  const selectedEvents = useMemo(
    () => (selectedTask ? selectTaskEvents(snapshot, selectedTask.id) : []),
    [selectedTask, snapshot]
  );
  const selectedInteractions = useMemo(
    () =>
      selectedTask
        ? snapshot.interactionRequests.filter(
            (interaction) => interaction.taskId === selectedTask.id
          )
        : [],
    [selectedTask, snapshot.interactionRequests]
  );
  const selectedSessions = useMemo(
    () =>
      selectedTask
        ? snapshot.agentSessions.filter((session) => session.taskId === selectedTask.id)
        : [],
    [selectedTask, snapshot.agentSessions]
  );
  const selectedItems = useMemo(
    () =>
      selectedTask
        ? snapshot.agentItems.filter((item) => item.taskId === selectedTask.id)
        : [],
    [selectedTask, snapshot.agentItems]
  );
  const selectedGoals = useMemo(
    () =>
      selectedTask
        ? snapshot.agentGoalSnapshots.filter((goal) => goal.taskId === selectedTask.id)
        : [],
    [selectedTask, snapshot.agentGoalSnapshots]
  );
  const selectedPlans = useMemo(
    () =>
      selectedTask
        ? snapshot.agentPlanRevisions.filter((plan) => plan.taskId === selectedTask.id)
        : [],
    [selectedTask, snapshot.agentPlanRevisions]
  );
  const selectedUsage = useMemo(
    () =>
      selectedTask
        ? snapshot.agentUsageSnapshots.filter((usage) => usage.taskId === selectedTask.id)
        : [],
    [selectedTask, snapshot.agentUsageSnapshots]
  );
  const selectedSettings = useMemo(
    () =>
      selectedTask
        ? snapshot.agentSettingsObservations.filter(
            (observation) => observation.taskId === selectedTask.id
          )
        : [],
    [selectedTask, snapshot.agentSettingsObservations]
  );
  const selectedSubagentObservations = useMemo(
    () =>
      selectedTask
        ? snapshot.agentSubagentObservations.filter(
            (observation) => observation.taskId === selectedTask.id
          )
        : [],
    [selectedTask, snapshot.agentSubagentObservations]
  );
  const selectedWorktree = selectedTask ? selectCurrentWorktree(snapshot, selectedTask) : undefined;
  const selectedGitSnapshot = selectedTask
    ? selectLatestGitSnapshot(snapshot, selectedTask)
    : undefined;
  const selectedTestRun = selectedTask ? selectLatestTestRun(snapshot, selectedTask) : undefined;
  const selectedGitHubRepository = selectedTask
    ? selectLatestGitHubRepository(snapshot, selectedTask)
    : undefined;
  const selectedBranchPublication = selectedTask
    ? selectLatestBranchPublication(snapshot, selectedTask)
    : undefined;
  const selectedPullRequest = selectedTask ? selectLatestPullRequest(snapshot, selectedTask) : undefined;
  const selectedCiRollup = selectedTask ? selectLatestCiRollup(snapshot, selectedTask) : undefined;
  const selectedReviewRollup = selectedTask ? selectLatestReviewRollup(snapshot, selectedTask) : undefined;
  const selectedMergeSnapshot = selectedTask ? selectLatestMergeSnapshot(snapshot, selectedTask) : undefined;

  const createTask = async (input: CreateTaskRequest) => {
    const created = await taskManagerApi.createTask(input);
    setSelectedTaskId(created.id);
    setIsDetailOpen(true);
    setIsNewTaskOpen(false);
    await refresh();
  };

  const refinePrompt = async (repositoryPath: string, input: string) => {
    return taskManagerApi.refinePrompt({ repositoryPath, input });
  };

  const startRun = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.startRun({ taskId, mode: 'IMPLEMENTATION' });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to start run.');
    }
  };

  const prepareWorktree = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.prepareWorktree({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to prepare worktree.');
    }
  };

  const refreshEvidence = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.refreshEvidence({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to refresh evidence.');
    }
  };

  const runTests = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.runTests({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to run tests.');
    }
  };

  const createDeliveryCommit = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.createDeliveryCommit({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create delivery commit.');
    }
  };

  const preflightGitHub = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.preflightGitHub({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to check GitHub capability.');
    }
  };

  const createPullRequest = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.createPullRequest({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create pull request.');
    }
  };

  const refreshGitHub = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.refreshGitHub({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to refresh GitHub.');
    }
  };

  const transitionTask = async (taskId: string, toPhase: WorkflowPhase) => {
    setError(undefined);
    try {
      await taskManagerApi.transitionTask({ taskId, toPhase });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Transition blocked.');
    }
  };

  const cancelRun = async (runId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.cancelRun({ runId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to cancel run.');
    }
  };

  const steerRun = async (runId: string, instruction: string) => {
    setError(undefined);
    try {
      const run = snapshot.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        throw new Error('Run not found.');
      }
      await taskManagerApi.steerRun({ taskId: run.taskId, runId, instruction });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to steer run.');
      throw caught;
    }
  };

  const continueRun = async (runId: string, instruction?: string) => {
    setError(undefined);
    try {
      const run = snapshot.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        throw new Error('Run not found.');
      }
      await taskManagerApi.continueRun({ taskId: run.taskId, runId, instruction });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to continue run.');
      throw caught;
    }
  };

  const retryRun = async (
    runId: string,
    strategy: AgentRetryStrategy,
    instruction?: string
  ) => {
    setError(undefined);
    try {
      const run = snapshot.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        throw new Error('Run not found.');
      }
      await taskManagerApi.retryRun({
        taskId: run.taskId,
        runId,
        strategy,
        instruction
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to retry run.');
      throw caught;
    }
  };

  const startReview = async (runId: string) => {
    setError(undefined);
    try {
      const run = snapshot.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        throw new Error('Run not found.');
      }
      await taskManagerApi.startReview({
        taskId: run.taskId,
        runId,
        target: { type: 'UNCOMMITTED_CHANGES' }
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to start review.');
    }
  };

  const syncAgentGoal = async (taskId: string, sessionId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.syncAgentGoal({ taskId, sessionId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to sync provider goal.');
      throw caught;
    }
  };

  const respondToInteraction = async (
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ) => {
    setError(undefined);
    try {
      await taskManagerApi.respondToInteraction({
        taskId: interaction.taskId,
        runId: interaction.runId,
        interactionRequestId: interaction.id,
        decision
      });
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Failed to submit approval decision.'
      );
      throw caught;
    }
  };

  const selectTask = (taskId: string) => {
    setSelectedTaskId(taskId);
    setLastTaskId(taskId);
    setIsDetailOpen(true);
  };

  // Back: from an open task to the view it was opened from.
  const goBack = () => {
    setIsDetailOpen(false);
  };

  // Forward: re-open the last task that was viewed.
  const goForward = () => {
    if (lastTaskId) {
      setSelectedTaskId(lastTaskId);
      setIsDetailOpen(true);
    }
  };

  const showView = (next: NavView) => {
    setView(next);
    setIsDetailOpen(false);
  };

  const canGoBack = isDetailOpen;
  const canGoForward = !isDetailOpen && Boolean(lastTaskId);

  const navCounts = computeNavCounts(snapshot.tasks);

  const showDetail = isDetailOpen && Boolean(selectedTask);

  return (
    <div className="tm-app app-shell" data-theme={theme}>
      <header className="tm-titlebar">
        <button
          type="button"
          className="tm-iconbtn"
          onClick={toggleSidebar}
          aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <PanelIcon />
        </button>
        <div className="tm-titlebar__nav">
          <button
            type="button"
            className="tm-iconbtn"
            onClick={goBack}
            disabled={!canGoBack}
            aria-label="Back"
            title="Back"
          >
            <ArrowLeftIcon />
          </button>
          <button
            type="button"
            className="tm-iconbtn"
            onClick={goForward}
            disabled={!canGoForward}
            aria-label="Forward"
            title="Forward"
          >
            <ArrowRightIcon />
          </button>
        </div>
        <div className="tm-titlebar__spacer" />
        <button
          type="button"
          className="tm-newtask"
          onClick={openNewTask}
          disabled={isLoading || !defaultRepositoryPath}
        >
          + New task
        </button>
      </header>

      <div className="tm-body">
        <aside className={`tm-nav ${isSidebarCollapsed ? 'tm-nav--collapsed' : ''}`}>
          <div className="tm-nav__brand">
            <img
              className="tm-nav__brand-mark"
              src={
                theme === 'dark'
                  ? '/assets/brand/monkey_icon_cream.svg'
                  : '/assets/brand/monkey_icon_charcoal.svg'
              }
              alt=""
              aria-hidden="true"
            />
            <span className="tm-nav__brand-name">Task Monki</span>
          </div>
          <div className="tm-nav__divider" />
          <div className="tm-nav__group">
            <NavItem
              label="Inbox"
              icon={<InboxIcon />}
              count={navCounts.inbox}
              urgent={navCounts.inbox > 0}
              active={!showDetail && view === 'inbox'}
              collapsed={isSidebarCollapsed}
              onClick={() => showView('inbox')}
            />
            <NavItem
              label="Board"
              icon={<BoardIcon />}
              active={!showDetail && view === 'board'}
              collapsed={isSidebarCollapsed}
              onClick={() => showView('board')}
            />
            <NavItem
              label="Active runs"
              icon={<ActiveIcon />}
              count={navCounts.active}
              active={!showDetail && view === 'active'}
              collapsed={isSidebarCollapsed}
              onClick={() => showView('active')}
            />
            <NavItem
              label="Review queue"
              icon={<ReviewIcon />}
              count={navCounts.review}
              active={!showDetail && view === 'review'}
              collapsed={isSidebarCollapsed}
              onClick={() => showView('review')}
            />
            <NavItem
              label="Done & Archive"
              icon={<DoneIcon />}
              count={navCounts.done}
              active={!showDetail && view === 'done'}
              collapsed={isSidebarCollapsed}
              onClick={() => showView('done')}
            />
          </div>
          <div className="tm-nav__divider" />
          <NavItem
            label="Settings"
            icon={<SettingsIcon />}
            active={!showDetail && view === 'settings'}
            collapsed={isSidebarCollapsed}
            onClick={() => showView('settings')}
          />
          <div className="tm-nav__spacer" />

          {defaultRepositoryPath ? (
            <div
              className="tm-nav__repo"
              data-tip={isSidebarCollapsed ? repositoryDisplay(defaultRepositoryPath) : undefined}
            >
              <span className="tm-nav__repo-dot" />
              <span className="tm-nav__repo-text">
                <span className="tm-nav__repo-label">Repository</span>
                <span className="tm-nav__repo-name">{repositoryDisplay(defaultRepositoryPath)}</span>
              </span>
            </div>
          ) : null}
        </aside>

        {showDetail ? (
          <TaskDetail
            error={error}
            task={selectedTask}
          run={selectedRun}
          worktree={selectedWorktree}
          gitSnapshot={selectedGitSnapshot}
          testRun={selectedTestRun}
          githubRepository={selectedGitHubRepository}
          branchPublication={selectedBranchPublication}
          pullRequest={selectedPullRequest}
          ciRollup={selectedCiRollup}
          reviewRollup={selectedReviewRollup}
          mergeSnapshot={selectedMergeSnapshot}
          events={selectedEvents}
          runs={selectedRuns}
          sessions={selectedSessions}
          items={selectedItems}
          goalSnapshots={selectedGoals}
          planRevisions={selectedPlans}
          usageSnapshots={selectedUsage}
          settingsObservations={selectedSettings}
          subagentObservations={selectedSubagentObservations}
          providerState={providerState}
          server={snapshot.agentServers.find(
            (candidate) => candidate.id === selectedRun?.serverInstanceId
          )}
          artifacts={snapshot.artifacts}
          interactions={selectedInteractions}
          onPrepareWorktree={prepareWorktree}
          onStart={startRun}
          onCancel={cancelRun}
          onSteer={steerRun}
          onContinue={continueRun}
          onRetry={retryRun}
          onReview={startReview}
          onSyncAgentGoal={syncAgentGoal}
          onRespondToInteraction={respondToInteraction}
          onRefreshEvidence={refreshEvidence}
          onRunTests={runTests}
          onCreateDeliveryCommit={createDeliveryCommit}
          onPreflightGitHub={preflightGitHub}
          onCreatePullRequest={createPullRequest}
          onRefreshGitHub={refreshGitHub}
          onTransition={transitionTask}
          />
        ) : (
          <MainColumn
            view={view}
            tasks={snapshot.tasks}
            theme={theme}
            onSetTheme={setTheme}
            error={error}
            models={providerState?.models ?? []}
            defaultRepositoryPath={defaultRepositoryPath}
            onSelect={selectTask}
          />
        )}
      </div>

      {isNewTaskOpen ? (
        <NewTaskPanel
          defaultRepositoryPath={defaultRepositoryPath}
          models={providerState?.models ?? []}
          preflight={providerState?.preflight}
          disabled={isLoading || !defaultRepositoryPath}
          onCreate={createTask}
          onRefinePrompt={refinePrompt}
          onClose={closeNewTask}
        />
      ) : null}
    </div>
  );
}

function getInitialTheme(): ThemePreference {
  const stored = window.localStorage.getItem('task-monki-theme');
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getInitialCollapsed(): boolean {
  return window.localStorage.getItem('task-monki-sidebar-collapsed') === '1';
}

function repositoryDisplay(repositoryPath: string): string {
  const parts = repositoryPath.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || repositoryPath;
}

function NavItem({
  label,
  icon,
  count,
  urgent,
  active,
  collapsed,
  onClick
}: {
  label: string;
  icon: ReactNode;
  count?: number;
  urgent?: boolean;
  active: boolean;
  collapsed?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`tm-nav__item ${active ? 'tm-nav__item--active' : ''}`}
      onClick={onClick}
      data-tip={collapsed ? label : undefined}
      aria-label={label}
    >
      {icon}
      <span className="tm-nav__label">{label}</span>
      {count != null && count > 0 ? (
        <span className={`tm-nav__count ${urgent ? 'tm-nav__count--urgent' : ''}`}>{count}</span>
      ) : null}
    </button>
  );
}

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
};

function PanelIcon() {
  return (
    <svg {...ICON_PROPS} width={17} height={17}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg {...ICON_PROPS} width={17} height={17}>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg {...ICON_PROPS} width={17} height={17}>
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="14" y="3" width="7" height="11" rx="1" />
    </svg>
  );
}

function ActiveIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function ReviewIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function DoneIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="2" y="4" width="20" height="5" rx="1" />
      <path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9" />
      <path d="M10 13h4" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
