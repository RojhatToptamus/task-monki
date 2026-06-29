import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  TASK_STORE_SCHEMA_VERSION,
  type CreateTaskRequest,
  type AgentInteractionDecision,
  type AgentProviderState,
  type AgentRetryStrategy,
  DEFAULT_PROMPT_REFINEMENT_MODEL,
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  type CodexExternalToolSettings,
  type DeleteTaskResult,
  type GitSnapshotRecord,
  type InteractionRequestRecord,
  type Task,
  type TaskManagerAppSettings,
  type TaskSnapshot,
  type WorkflowPhase,
  type WorktreeRecord
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
  selectTaskRuns,
  formatShortId
} from '../model/selectors';
import { resolveModelExecutionSettings, selectModel } from '../model/agentExecutionSettings';
import { createUpdateRefreshScheduler } from '../model/updateRefreshScheduler';
import {
  buildRepositoryOptions,
  isSameRepositoryPath,
  mergeRepositoryPath,
  normalizeRepositoryPath,
  repositoryDisplayPath,
  resolveSelectedRepositoryPath,
  tasksForRepository
} from '../model/repositories';
import { MainColumn, type AppSettings } from './MainColumn';
import { resolveTheme, type ThemePreference } from './theme';
import { computeNavCounts, type NavView } from './taskView';
import { NewTaskPanel } from './NewTaskPanel';
import { RepositorySwitcher } from './RepositorySwitcher';
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

type NotificationTone = 'info' | 'success' | 'error';

function prefersDarkScheme(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

interface AppNotification {
  id: string;
  tone: NotificationTone;
  message: string;
}

const REVIEW_STARTED_NOTICE = 'Codex review started — task stays in Review';
const APP_SETTINGS_STORAGE_KEY = 'task-monki-app-settings';
const REPOSITORIES_STORAGE_KEY = 'task-monki-repositories';
const SELECTED_REPOSITORY_STORAGE_KEY = 'task-monki-selected-repository';
const APP_UPDATE_REFRESH_DELAY_MS = 100;
const CODEX_EXTERNAL_TOOLS_SAVE_DELAY_MS = 350;

export function App() {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(emptySnapshot);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [defaultRepositoryPath, setDefaultRepositoryPath] = useState('');
  const [selectedRepositoryPath, setSelectedRepositoryPath] = useState(() =>
    getInitialSelectedRepositoryPath()
  );
  const [knownRepositoryPaths, setKnownRepositoryPaths] = useState<string[]>(() =>
    getInitialRepositoryPaths()
  );
  const [isAddingRepository, setIsAddingRepository] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<NavView>('board');
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [lastTaskId, setLastTaskId] = useState<string | undefined>();
  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | undefined>();
  const [theme, setTheme] = useState<ThemePreference>(() => getInitialTheme());
  const [prefersDark, setPrefersDark] = useState<boolean>(() => prefersDarkScheme());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => getInitialCollapsed());
  const [appSettings, setAppSettings] = useState<AppSettings>(() => getInitialAppSettings());
  const [coreAppSettings, setCoreAppSettings] = useState<TaskManagerAppSettings>(
    DEFAULT_TASK_MANAGER_APP_SETTINGS
  );
  const [providerState, setProviderState] = useState<AgentProviderState>();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const snapshotRefreshRequestRef = useRef(0);
  const providerStateRequestRef = useRef(0);
  const coreAppSettingsRef = useRef<TaskManagerAppSettings>(DEFAULT_TASK_MANAGER_APP_SETTINGS);
  const codexExternalToolsSaveTimerRef = useRef<number | undefined>(undefined);
  const codexExternalToolsSaveRequestRef = useRef(0);

  const openNewTask = useCallback(() => setIsNewTaskOpen(true), []);
  const closeNewTask = useCallback(() => setIsNewTaskOpen(false), []);
  const toggleSidebar = useCallback(() => setIsSidebarCollapsed((current) => !current), []);
  const notify = useCallback((message: string, tone: NotificationTone = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setNotifications((current) => [...current.slice(-2), { id, tone, message }]);
    window.setTimeout(() => {
      setNotifications((current) => current.filter((notification) => notification.id !== id));
    }, 4200);
  }, []);

  const reportActionError = useCallback(
    (caught: unknown, fallback: string) => {
      const message = caught instanceof Error ? caught.message : fallback;
      setError(message);
      notify(message, 'error');
      return message;
    },
    [notify]
  );
  const updateTheme = useCallback(
    (nextTheme: ThemePreference) => {
      setTheme(nextTheme);
      notify('Theme updated.', 'success');
    },
    [notify]
  );
  const updateAppSettings = useCallback(
    (nextSettings: AppSettings) => {
      setAppSettings(nextSettings);
      notify('Settings updated.', 'success');
    },
    [notify]
  );

  const refresh = useCallback(async () => {
    const requestId = ++snapshotRefreshRequestRef.current;
    const next = await taskManagerApi.listTasks();
    if (requestId === snapshotRefreshRequestRef.current) {
      setSnapshot(next);
    }
  }, []);
  const refreshProviderState = useCallback(async () => {
    const requestId = ++providerStateRequestRef.current;
    const next = await taskManagerApi.getAgentProviderState();
    if (requestId === providerStateRequestRef.current) {
      setProviderState(next);
    }
  }, []);
  const updateCodexExternalTools = useCallback(
    (patch: Partial<CodexExternalToolSettings>) => {
      const nextSettings: TaskManagerAppSettings = {
        ...coreAppSettingsRef.current,
        codexExternalTools: {
          ...coreAppSettingsRef.current.codexExternalTools,
          ...patch
        }
      };
      coreAppSettingsRef.current = nextSettings;
      setCoreAppSettings(nextSettings);
      if (codexExternalToolsSaveTimerRef.current !== undefined) {
        window.clearTimeout(codexExternalToolsSaveTimerRef.current);
      }
      codexExternalToolsSaveTimerRef.current = window.setTimeout(() => {
        const requestId = ++codexExternalToolsSaveRequestRef.current;
        const codexExternalTools = coreAppSettingsRef.current.codexExternalTools;
        void taskManagerApi
          .updateAppSettings({ codexExternalTools })
          .then((stored) => {
            if (requestId !== codexExternalToolsSaveRequestRef.current) {
              return;
            }
            coreAppSettingsRef.current = stored;
            setCoreAppSettings(stored);
            notify('Settings updated.', 'success');
            void refreshProviderState();
          })
          .catch((caught: unknown) => {
            reportActionError(caught, 'Could not update settings.');
          });
      }, CODEX_EXTERNAL_TOOLS_SAVE_DELAY_MS);
    },
    [notify, refreshProviderState, reportActionError]
  );
  const updateRefreshScheduler = useMemo(
    () =>
      createUpdateRefreshScheduler({
        delayMs: APP_UPDATE_REFRESH_DELAY_MS,
        refresh,
        setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimer: (handle) => window.clearTimeout(handle as number)
      }),
    [refresh]
  );

  useEffect(() => {
    window.localStorage.setItem('task-monki-theme', theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    window.localStorage.setItem('task-monki-sidebar-collapsed', isSidebarCollapsed ? '1' : '0');
  }, [isSidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(appSettings));
  }, [appSettings]);

  useEffect(() => {
    window.localStorage.setItem(REPOSITORIES_STORAGE_KEY, JSON.stringify(knownRepositoryPaths));
  }, [knownRepositoryPaths]);

  useEffect(() => {
    if (selectedRepositoryPath) {
      window.localStorage.setItem(SELECTED_REPOSITORY_STORAGE_KEY, selectedRepositoryPath);
    }
  }, [selectedRepositoryPath]);

  useEffect(() => {
    let canceled = false;

    async function load() {
      try {
        const [repoPath, provider, storedAppSettings] = await Promise.all([
          taskManagerApi.getDefaultRepositoryPath(),
          taskManagerApi.getAgentProviderState(),
          taskManagerApi.getAppSettings(),
          refresh()
        ]);
        if (!canceled) {
          setDefaultRepositoryPath(repoPath);
          setProviderState(provider);
          coreAppSettingsRef.current = storedAppSettings;
          setCoreAppSettings(storedAppSettings);
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
        void refreshProviderState();
      }
      updateRefreshScheduler.request();
    });
  }, [refreshProviderState, updateRefreshScheduler]);

  useEffect(() => () => updateRefreshScheduler.dispose(), [updateRefreshScheduler]);

  useEffect(
    () => () => {
      if (codexExternalToolsSaveTimerRef.current !== undefined) {
        window.clearTimeout(codexExternalToolsSaveTimerRef.current);
      }
    },
    []
  );

  const repositoryOptions = useMemo(
    () =>
      buildRepositoryOptions({
        defaultRepositoryPath,
        storedRepositoryPaths: knownRepositoryPaths,
        tasks: snapshot.tasks
      }),
    [defaultRepositoryPath, knownRepositoryPaths, snapshot.tasks]
  );
  const activeRepositoryPath = resolveSelectedRepositoryPath(
    repositoryOptions,
    selectedRepositoryPath
  );
  const visibleTasks = useMemo(
    () => tasksForRepository(snapshot.tasks, activeRepositoryPath),
    [activeRepositoryPath, snapshot.tasks]
  );

  useEffect(() => {
    if (activeRepositoryPath && activeRepositoryPath !== selectedRepositoryPath) {
      setSelectedRepositoryPath(activeRepositoryPath);
    }
  }, [activeRepositoryPath, selectedRepositoryPath]);

  const selectedTaskCandidate = snapshot.tasks.find((task) => task.id === selectedTaskId);
  const selectedTask =
    selectedTaskCandidate &&
    isSameRepositoryPath(selectedTaskCandidate.repositoryPath, activeRepositoryPath)
      ? selectedTaskCandidate
      : undefined;
  const deleteCandidate = snapshot.tasks.find((task) => task.id === deleteCandidateId);

  useEffect(() => {
    if (!selectedTaskId || isLoading) {
      return;
    }
    if (snapshot.tasks.some((task) => task.id === selectedTaskId)) {
      return;
    }
    setSelectedTaskId(undefined);
    setLastTaskId((current) => (current === selectedTaskId ? undefined : current));
    setIsDetailOpen(false);
  }, [isLoading, selectedTaskId, snapshot.tasks]);
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
  const deleteCandidateWorktree = deleteCandidate
    ? selectCurrentWorktree(snapshot, deleteCandidate)
    : undefined;
  const deleteCandidateGitSnapshot = deleteCandidate
    ? selectLatestGitSnapshot(snapshot, deleteCandidate)
    : undefined;
  const providerModels = providerState?.models ?? [];
  const defaultTaskSettings = useMemo(
    () =>
      resolveModelExecutionSettings(
        providerModels,
        appSettings.defaultModel,
        appSettings.defaultReasoningEffort
      ),
    [appSettings.defaultModel, appSettings.defaultReasoningEffort, providerModels]
  );
  const reviewExecutionSettings = useMemo(
    () =>
      resolveModelExecutionSettings(
        providerModels,
        appSettings.reviewModel ?? appSettings.defaultModel,
        appSettings.reviewReasoningEffort
      ),
    [
      appSettings.defaultModel,
      appSettings.reviewModel,
      appSettings.reviewReasoningEffort,
      providerModels
    ]
  );

  const createTask = async (input: CreateTaskRequest) => {
    try {
      const created = await taskManagerApi.createTask(input);
      setSelectedTaskId(created.id);
      setIsDetailOpen(true);
      setIsNewTaskOpen(false);
      notify('Task created.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Could not create task.');
      throw caught;
    }
  };

  const refinePrompt = async (repositoryPath: string, input: string) => {
    try {
      const refinementModel = selectModel(
        providerModels,
        appSettings.promptRefinementModel ?? DEFAULT_PROMPT_REFINEMENT_MODEL
      );
      const refined = await taskManagerApi.refinePrompt({
        repositoryPath,
        input,
        model: refinementModel?.model
      });
      notify('Prompt refined.', 'success');
      return refined;
    } catch (caught) {
      reportActionError(caught, 'Could not refine prompt.');
      throw caught;
    }
  };

  const startRun = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.startRun({ taskId, mode: 'IMPLEMENTATION' });
      notify('Agent run started.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to start run.');
    }
  };

  const prepareWorktree = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.prepareWorktree({ taskId });
      notify('Worktree prepared.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to prepare worktree.');
    }
  };

  const refreshEvidence = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.refreshEvidence({ taskId });
      notify('Evidence refreshed.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to refresh evidence.');
    }
  };

  const runTests = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.runTests({ taskId });
      notify('Test run started.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to run tests.');
    }
  };

  const createDeliveryCommit = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.createDeliveryCommit({ taskId });
      notify('Delivery commit created.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to create delivery commit.');
    }
  };

  const preflightGitHub = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.preflightGitHub({ taskId });
      notify('GitHub capability checked.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to check GitHub capability.');
    }
  };

  const createPullRequest = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.createPullRequest({ taskId });
      notify('Draft pull request created.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to create pull request.');
    }
  };

  const refreshGitHub = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.refreshGitHub({ taskId });
      notify('GitHub state refreshed.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to refresh GitHub.');
    }
  };

  const transitionTask = async (taskId: string, toPhase: WorkflowPhase) => {
    setError(undefined);
    try {
      await taskManagerApi.transitionTask({ taskId, toPhase });
      notify(`Task moved to ${toPhase.toLowerCase().replace(/_/g, ' ')}.`, 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Transition blocked.');
    }
  };

  const archiveTask = (taskId: string) => {
    void transitionTask(taskId, 'ARCHIVED');
  };

  const requestDeleteTask = (taskId: string) => {
    setDeleteCandidateId(taskId);
  };

  const deleteTask = async (
    taskId: string,
    removeWorktree: boolean
  ): Promise<DeleteTaskResult> => {
    setError(undefined);
    try {
      const deleted = await taskManagerApi.deleteTask({ taskId, removeWorktree });
      setDeleteCandidateId(undefined);
      if (selectedTaskId === taskId) {
        setSelectedTaskId(undefined);
        setIsDetailOpen(false);
      }
      setLastTaskId((current) => (current === taskId ? undefined : current));
      notify(
        deleted.removedWorktree ? 'Task and local worktree deleted.' : 'Task deleted.',
        'success'
      );
      await refresh();
      return deleted;
    } catch (caught) {
      reportActionError(caught, 'Could not delete task.');
      throw caught;
    }
  };

  const cancelRun = async (runId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.cancelRun({ runId });
      notify('Run cancellation requested.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to cancel run.');
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
      notify('Instruction sent.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to steer run.');
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
      notify('Follow-up run started.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to continue run.');
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
      const retry = await taskManagerApi.retryRun({
        taskId: run.taskId,
        runId,
        strategy,
        instruction
      });
      if (strategy === 'FORK') {
        setSelectedTaskId(retry.taskId);
        setIsDetailOpen(true);
      }
      notify(strategy === 'FORK' ? 'Alternative task started.' : 'Retry started.', 'success');
      await refresh();
    } catch (caught) {
      if (strategy === 'FORK') {
        try {
          await refresh();
        } catch {
          // Keep the original retry failure as the user-facing error.
        }
      }
      reportActionError(caught, 'Failed to retry run.');
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
      notify(REVIEW_STARTED_NOTICE, 'info');
      await taskManagerApi.startReview({
        taskId: run.taskId,
        runId,
        target: { type: 'UNCOMMITTED_CHANGES' },
        settings: reviewExecutionSettings
      });
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to start review.');
      throw caught;
    }
  };

  const syncAgentGoal = async (taskId: string, sessionId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.syncAgentGoal({ taskId, sessionId });
      notify('Provider goal synced.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to sync provider goal.');
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
      notify('Provider request answered.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to submit approval decision.');
      throw caught;
    }
  };

  const selectRepository = useCallback(
    (repositoryPath: string) => {
      const normalized = normalizeRepositoryPath(repositoryPath);
      if (!normalized || normalized === activeRepositoryPath) {
        return;
      }
      setKnownRepositoryPaths((current) => mergeRepositoryPath(current, normalized));
      setSelectedRepositoryPath(normalized);
      setSelectedTaskId(undefined);
      setLastTaskId(undefined);
      setIsDetailOpen(false);
      setIsNewTaskOpen(false);
      setError(undefined);
      notify(`Switched to ${repositoryDisplayPath(normalized)}.`, 'success');
    },
    [activeRepositoryPath, notify]
  );

  const addRepository = useCallback(async () => {
    setError(undefined);
    setIsAddingRepository(true);
    try {
      const selectedPath = await taskManagerApi.chooseRepositoryFolder();
      const normalized = normalizeRepositoryPath(selectedPath ?? '');
      if (!normalized) {
        return false;
      }

      const preflight = await taskManagerApi.validateRepository(normalized);
      if (preflight.status !== 'VALID') {
        throw new Error(preflight.error ?? 'Selected folder is not a valid Git repository.');
      }

      const repositoryRoot = normalizeRepositoryPath(preflight.root ?? normalized);
      setKnownRepositoryPaths((current) => mergeRepositoryPath(current, repositoryRoot));
      setSelectedRepositoryPath(repositoryRoot);
      setSelectedTaskId(undefined);
      setLastTaskId(undefined);
      setIsDetailOpen(false);
      setIsNewTaskOpen(false);
      notify(`Added ${repositoryDisplayPath(repositoryRoot)}.`, 'success');
      return true;
    } catch (caught) {
      reportActionError(caught, 'Could not add repository.');
      return false;
    } finally {
      setIsAddingRepository(false);
    }
  }, [notify, reportActionError]);

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

  const navCounts = computeNavCounts(visibleTasks);

  const showDetail = isDetailOpen && Boolean(selectedTask);

  const resolvedTheme = resolveTheme(theme, prefersDark);

  return (
    <div className="tm-app app-shell" data-theme={resolvedTheme}>
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
          disabled={isLoading || !activeRepositoryPath}
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
                resolvedTheme === 'dark'
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

          <RepositorySwitcher
            activeRepositoryPath={activeRepositoryPath}
            options={repositoryOptions}
            collapsed={isSidebarCollapsed}
            adding={isAddingRepository}
            onSelect={selectRepository}
            onAddRepository={addRepository}
          />
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
            onArchive={archiveTask}
            onRequestDelete={requestDeleteTask}
          />
        ) : (
          <MainColumn
            view={view}
            tasks={visibleTasks}
            theme={theme}
            onSetTheme={updateTheme}
            appSettings={appSettings}
            onSetAppSettings={updateAppSettings}
            codexExternalTools={coreAppSettings.codexExternalTools}
            onSetCodexExternalTools={updateCodexExternalTools}
            error={error}
            models={providerModels}
            activeRepositoryPath={activeRepositoryPath}
            onSelect={selectTask}
            onArchive={archiveTask}
            onRequestDelete={requestDeleteTask}
          />
        )}
      </div>

      {isNewTaskOpen ? (
        <NewTaskPanel
          defaultRepositoryPath={activeRepositoryPath}
          models={providerModels}
          preflight={providerState?.preflight}
          defaultAgentSettings={defaultTaskSettings}
          disabled={isLoading || !activeRepositoryPath}
          onCreate={createTask}
          onRefinePrompt={refinePrompt}
          onClose={closeNewTask}
        />
      ) : null}

      {deleteCandidate ? (
        <DeleteTaskModal
          task={deleteCandidate}
          worktree={deleteCandidateWorktree}
          gitSnapshot={deleteCandidateGitSnapshot}
          onCancel={() => setDeleteCandidateId(undefined)}
          onConfirm={(removeWorktree) => deleteTask(deleteCandidate.id, removeWorktree)}
        />
      ) : null}

      <GlobalNotifier notifications={notifications} />
    </div>
  );
}

function GlobalNotifier({ notifications }: { notifications: AppNotification[] }) {
  return (
    <div className="tm-notifier" aria-live="polite" aria-atomic="false">
      {notifications.map((notification) => (
        <div
          className={`tm-notifier__item tm-notifier__item--${notification.tone}`}
          key={notification.id}
        >
          <span className="tm-notifier__dot" />
          <strong>{notification.message}</strong>
        </div>
      ))}
    </div>
  );
}

function DeleteTaskModal({
  task,
  worktree,
  gitSnapshot,
  onCancel,
  onConfirm
}: {
  task: Task;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  onCancel(): void;
  onConfirm(removeWorktree: boolean): Promise<DeleteTaskResult>;
}) {
  const [removeWorktree, setRemoveWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const worktreeRemoval = describeWorktreeRemoval(worktree, gitSnapshot);
  const canRemoveWorktree = worktreeRemoval.status === 'available';

  useEffect(() => {
    setRemoveWorktree(false);
    setBusy(false);
  }, [task.id]);

  useEffect(() => {
    if (!canRemoveWorktree) {
      setRemoveWorktree(false);
    }
  }, [canRemoveWorktree]);

  const submit = () => {
    setBusy(true);
    void onConfirm(removeWorktree).catch(() => {
      setBusy(false);
    });
  };

  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-task-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <div className="tm-modal__panel tm-delete-modal">
        <div className="tm-delete-modal__head">
          <span className="tm-delete-modal__mark" aria-hidden="true">
            <TrashIcon />
          </span>
          <div>
            <h3 id="delete-task-title">Delete task #{formatShortId(task.id)}</h3>
            <p>
              This permanently removes only the selected task. Fork alternatives and source
              tasks stay in place.
            </p>
          </div>
        </div>

        <div className="tm-delete-modal__grid">
          <section className="tm-delete-modal__col tm-delete-modal__col--remove">
            <h4>
              Will be deleted
            </h4>
            <ul>
              <li>Task record and workflow state</li>
              <li>Runs, events, artifacts, and provider session records</li>
              <li>Stored Git, test, GitHub, PR, review, and merge evidence</li>
              <li>Source and alternative links that point at this task</li>
            </ul>
          </section>
          <section className="tm-delete-modal__col tm-delete-modal__col--keep">
            <h4>
              Stays untouched
            </h4>
            <ul>
              <li>Fork alternatives or source tasks</li>
              <li>Original repository or Git history</li>
              <li>Remote branch, pull request, commits, or merge history</li>
              <li>Provider remote thread data</li>
            </ul>
          </section>
        </div>

        <label
          className={`tm-delete-modal__worktree ${
            canRemoveWorktree ? '' : 'tm-delete-modal__worktree--disabled'
          } ${worktreeRemoval.status === 'dirty' ? 'tm-delete-modal__worktree--blocked' : ''}`}
        >
          <input
            type="checkbox"
            checked={removeWorktree}
            disabled={!canRemoveWorktree || busy}
            onChange={(event) => setRemoveWorktree(event.target.checked)}
          />
          <span>
            <strong>Also remove local worktree</strong>
            <small>{worktreeRemoval.detail}</small>
          </span>
        </label>

        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger-button" disabled={busy} onClick={submit}>
            {busy ? 'Deleting…' : 'Delete task'}
          </button>
        </div>
      </div>
    </div>
  );
}

function describeWorktreeRemoval(
  worktree: WorktreeRecord | undefined,
  gitSnapshot: GitSnapshotRecord | undefined
): { status: 'available' | 'none' | 'unverified' | 'dirty' | 'unavailable'; detail: string } {
  if (!worktree) {
    return {
      status: 'none',
      detail: 'No local worktree is recorded for this task.'
    };
  }
  if (isSameRepositoryPath(worktree.repositoryPath, worktree.worktreePath)) {
    return {
      status: 'unavailable',
      detail: 'Task Monki never removes the original repository checkout.'
    };
  }
  if (worktree.status === 'MISSING' || worktree.status === 'REMOVED') {
    return {
      status: 'none',
      detail: 'No removable local worktree exists for this task.'
    };
  }
  if (worktree.status !== 'PRESENT') {
    return {
      status: 'unavailable',
      detail:
        `The local worktree is ${worktree.status.toLowerCase().replace(/_/g, ' ')}. ` +
        'Repair or refresh it before removal.'
    };
  }
  if (!gitSnapshot) {
    return {
      status: 'unverified',
      detail: 'Refresh Git evidence before removing the local worktree.'
    };
  }

  const dirtyCount =
    gitSnapshot.stagedCount +
    gitSnapshot.unstagedCount +
    gitSnapshot.untrackedCount +
    gitSnapshot.conflictedCount;
  if (dirtyCount > 0 || gitSnapshot.status === 'DIRTY' || gitSnapshot.status === 'CONFLICTED') {
    return {
      status: 'dirty',
      detail:
        'The worktree has uncommitted, untracked, or conflicted files. Commit, stash, or clean it before removal.'
    };
  }

  return {
    status: 'available',
    detail: `${worktree.worktreePath} will be removed from disk.`
  };
}

function getInitialTheme(): ThemePreference {
  const stored = window.localStorage.getItem('task-monki-theme');
  if (stored === 'light' || stored === 'dark' || stored === 'device') {
    return stored;
  }
  return 'device';
}

function getInitialCollapsed(): boolean {
  return window.localStorage.getItem('task-monki-sidebar-collapsed') === '1';
}

function getInitialAppSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      defaultModel: typeof parsed.defaultModel === 'string' ? parsed.defaultModel : undefined,
      defaultReasoningEffort:
        typeof parsed.defaultReasoningEffort === 'string'
          ? parsed.defaultReasoningEffort
          : undefined,
      reviewModel: typeof parsed.reviewModel === 'string' ? parsed.reviewModel : undefined,
      promptRefinementModel:
        typeof parsed.promptRefinementModel === 'string'
          ? parsed.promptRefinementModel
          : undefined,
      reviewReasoningEffort:
        typeof parsed.reviewReasoningEffort === 'string'
          ? parsed.reviewReasoningEffort
          : undefined
    };
  } catch {
    return {};
  }
}

function getInitialRepositoryPaths(): string[] {
  try {
    const raw = window.localStorage.getItem(REPOSITORIES_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.reduce<string[]>((paths, value) => {
      return typeof value === 'string' ? mergeRepositoryPath(paths, value) : paths;
    }, []);
  } catch {
    return [];
  }
}

function getInitialSelectedRepositoryPath(): string {
  return normalizeRepositoryPath(
    window.localStorage.getItem(SELECTED_REPOSITORY_STORAGE_KEY) ?? ''
  );
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

function TrashIcon() {
  return (
    <svg {...ICON_PROPS} width={18} height={18}>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
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
