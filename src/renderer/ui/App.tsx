import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  TASK_STORE_SCHEMA_VERSION,
  type CreateTaskRequest,
  type CreateBoardRequest,
  type Board,
  type AgentInteractionDecision,
  type AgentRuntimeCatalog,
  type AgentRetryStrategy,
  type DeleteTaskResult,
  type ExternalToolStatusReport,
  type InteractionRequestRecord,
  type Repository,
  type RepositoryImpact,
  type PreviewRecipeGenerationSnapshot,
  type PreviewRecipeValidation,
  type PreviewResolvedAttachmentTarget,
  type ResolvePreviewResult,
  type Task,
  type TaskManagerAppSettings,
  type TaskSnapshot,
  type UpdateAgentNativeSessionRequest,
  type UpdateAppSettingsRequest,
  type WorkflowPhase
} from '../../shared/contracts';
import type { PreviewExecutionReadiness } from '../../shared/preview';
import { taskManagerApi } from '../api/taskManagerClient';
import { listDiscourseConversationSnapshot } from '../api/discoursePaging';
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
  selectTaskEvents,
  selectTaskRuns
} from '../model/selectors';
import { resolveModelExecutionSettings, selectModel } from '../model/agentExecutionSettings';
import { createUpdateRefreshScheduler } from '../model/updateRefreshScheduler';
import { selectBoardTasks } from '../model/boards';
import {
  dragNewTaskCanvas,
  NEW_TASK_CANVAS_PAN_DURATION_MS,
  newTaskCanvasPanPosition,
  shouldInterruptNewTaskCanvasPanForWheel
} from '../model/newTaskPanel';
import {
  buildRepositoryOptions,
  resolveRepositorySetupState,
  resolveSelectedRepositoryId
} from '../model/repositories';
import { selectPreviewTaskRouteOptions } from '../model/previewBindings';
import { MainColumn } from './MainColumn';
import { resolveTheme, type ThemePreference } from './theme';
import { computeNavCounts, type NavView } from '../model/taskView';
import { NewTaskPanel, type NewTaskTextDraft } from './NewTaskPanel';
import { RepositorySwitcher } from './RepositorySwitcher';
import { TaskDetail } from './TaskDetail';
import { DiscourseWorkspace } from './DiscourseWorkspace';
import { DiscourseNavIcon } from './DiscourseIcons';
import { taskNavigationReturnTarget } from './taskNavigationFocus';
import {
  BoardEditorModal,
  DeleteTaskModal,
  GlobalNotifier,
  RepositoryDisconnectModal,
  type AppNotification,
  type NotificationTone
} from './AppOverlays';
import {
  ActiveIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BoardIcon,
  DoneIcon,
  InboxIcon,
  NavItem,
  PanelIcon,
  ReviewIcon,
  SavedViewsFolderIcon,
  SettingsIcon
} from './AppNavigation';

const emptySnapshot: TaskSnapshot = {
  schemaVersion: TASK_STORE_SCHEMA_VERSION,
  repositories: [],
  boards: [],
  tasks: [],
  iterations: [],
  worktrees: [],
  gitSnapshots: [],
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
  previewPlans: [],
  previewLocalBindings: [],
  previewApprovals: [],
  previewComposeProjects: [],
  previewGenerations: [],
  previewManagedEnvironments: [],
  previewManagedResources: [],
  previewGenerationAttachments: [],
  previewNodeAttempts: [],
  previewResources: [],
  events: [],
  artifacts: [],
  attachments: []
};

function prefersDarkScheme(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function retainTaskEntries<T>(
  current: Record<string, T>,
  tasks: Array<Pick<Task, 'id'>>
): Record<string, T> {
  const liveTaskIds = new Set(tasks.map((task) => task.id));
  const retainedEntries = Object.entries(current).filter(([taskId]) => liveTaskIds.has(taskId));
  return retainedEntries.length === Object.keys(current).length
    ? current
    : Object.fromEntries(retainedEntries);
}

function isPreviewRecipeGenerationSnapshot(
  value: unknown
): value is PreviewRecipeGenerationSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { taskId?: unknown; status?: unknown };
  return (
    typeof candidate.taskId === 'string' &&
    ['EMPTY', 'GENERATING', 'READY', 'NEEDS_INPUT', 'FAILED'].includes(
      String(candidate.status)
    )
  );
}

const REVIEW_STARTED_NOTICE = 'Review started';
type AppView = NavView | 'discourse';

function resolveWindowChromePlatform() {
  return window.taskManagerShell?.windowChromePlatform ?? 'other';
}

function isHorizontalCanvasControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        '.tm-titlebar, button, input, textarea, select, a, summary, [role="button"], [role="separator"]'
      )
    )
  );
}

export function App() {
  const [inputModality, setInputModality] = useState<'keyboard' | 'pointer'>('pointer');
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(emptySnapshot);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [isAddingRepository, setIsAddingRepository] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<AppView>('board');
  const [discourseAttentionCount, setDiscourseAttentionCount] = useState(0);
  const [selectedBoardId, setSelectedBoardId] = useState<string | undefined>();
  const [boardEditor, setBoardEditor] = useState<Board | 'new' | undefined>();
  const [areSavedViewsExpanded, setAreSavedViewsExpanded] = useState(true);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isTaskDetailModalOpen, setIsTaskDetailModalOpen] = useState(false);
  const [lastTaskId, setLastTaskId] = useState<string | undefined>();
  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
  const [isNewTaskClosing, setIsNewTaskClosing] = useState(false);
  const [newTaskTextDraft, setNewTaskTextDraft] = useState<NewTaskTextDraft>({
    title: '',
    prompt: ''
  });
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | undefined>();
  const [repositoryDisconnect, setRepositoryDisconnect] = useState<{
    repository: Repository;
    impact: RepositoryImpact;
  }>();
  const [prefersDark, setPrefersDark] = useState<boolean>(() => prefersDarkScheme());
  const [appSettings, setAppSettings] = useState<TaskManagerAppSettings>(
    DEFAULT_TASK_MANAGER_APP_SETTINGS
  );
  const [externalToolStatus, setExternalToolStatus] = useState<ExternalToolStatusReport>();
  const [runtimeCatalog, setRuntimeCatalog] = useState<AgentRuntimeCatalog>();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [isCanvasDragging, setIsCanvasDragging] = useState(false);
  const newTaskButtonRef = useRef<HTMLButtonElement>(null);
  const appRootRef = useRef<HTMLDivElement>(null);
  const taskDetailHeadingRef = useRef<HTMLHeadingElement>(null);
  const taskNavigationReturnFocusRef = useRef<HTMLElement | null>(null);
  const taskNavigationReturnIdRef = useRef<string | undefined>(undefined);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const canvasPanFrameRef = useRef<number | undefined>(undefined);
  const canvasResizeFrameRef = useRef<number | undefined>(undefined);
  const canvasDragRef = useRef<
    { pointerId: number; startX: number; startScrollLeft: number } | undefined
  >(undefined);
  const [previewExecutionReadiness, setPreviewExecutionReadiness] = useState<
    Record<string, PreviewExecutionReadiness>
  >({});
  const [previewResolutions, setPreviewResolutions] = useState<
    Record<string, ResolvePreviewResult>
  >({});
  const [previewRecipeGenerations, setPreviewRecipeGenerations] = useState<
    Record<string, PreviewRecipeGenerationSnapshot>
  >({});
  const windowChromePlatform = resolveWindowChromePlatform();

  const cancelCanvasPan = useCallback(() => {
    if (canvasPanFrameRef.current !== undefined) {
      window.cancelAnimationFrame(canvasPanFrameRef.current);
      canvasPanFrameRef.current = undefined;
    }
  }, []);

  const panCanvasTo = useCallback(
    (requestedTarget: number, onComplete?: () => void) => {
      const viewport = canvasViewportRef.current;
      if (!viewport) {
        onComplete?.();
        return;
      }
      cancelCanvasPan();
      const target = Math.min(
        Math.max(0, viewport.scrollWidth - viewport.clientWidth),
        Math.max(0, requestedTarget)
      );
      const start = viewport.scrollLeft;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reduceMotion || Math.abs(target - start) < 0.5) {
        viewport.scrollLeft = target;
        onComplete?.();
        return;
      }
      const startedAt = window.performance.now();
      const step = (now: number) => {
        const elapsed = now - startedAt;
        viewport.scrollLeft = newTaskCanvasPanPosition(start, target, elapsed);
        if (elapsed < NEW_TASK_CANVAS_PAN_DURATION_MS) {
          canvasPanFrameRef.current = window.requestAnimationFrame(step);
          return;
        }
        viewport.scrollLeft = target;
        canvasPanFrameRef.current = undefined;
        onComplete?.();
      };
      canvasPanFrameRef.current = window.requestAnimationFrame(step);
    },
    [cancelCanvasPan]
  );

  const revealNewTaskPanel = useCallback(() => {
    const viewport = canvasViewportRef.current;
    if (!viewport) {
      return;
    }
    panCanvasTo(viewport.scrollWidth - viewport.clientWidth);
  }, [panCanvasTo]);

  const openNewTask = useCallback(() => {
    if (isNewTaskClosing) {
      return;
    }
    if (isNewTaskOpen) {
      revealNewTaskPanel();
      return;
    }
    setIsNewTaskOpen(true);
  }, [isNewTaskClosing, isNewTaskOpen, revealNewTaskPanel]);

  const closeNewTask = useCallback(() => {
    if (isNewTaskClosing) {
      return;
    }
    setIsNewTaskClosing(true);
    panCanvasTo(0, () => {
      setIsNewTaskOpen(false);
      setIsNewTaskClosing(false);
    });
  }, [isNewTaskClosing, panCanvasTo]);

  const keepNewTaskPanelInView = useCallback(() => {
    if (isNewTaskClosing) {
      return;
    }
    cancelCanvasPan();
    if (canvasResizeFrameRef.current !== undefined) {
      window.cancelAnimationFrame(canvasResizeFrameRef.current);
    }
    canvasResizeFrameRef.current = window.requestAnimationFrame(() => {
      const viewport = canvasViewportRef.current;
      if (viewport) {
        viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      }
      canvasResizeFrameRef.current = undefined;
    });
  }, [cancelCanvasPan, isNewTaskClosing]);

  useEffect(() => {
    if (!isNewTaskOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(revealNewTaskPanel);
    return () => window.cancelAnimationFrame(frame);
  }, [isNewTaskOpen, revealNewTaskPanel]);

  useEffect(
    () => () => {
      cancelCanvasPan();
      if (canvasResizeFrameRef.current !== undefined) {
        window.cancelAnimationFrame(canvasResizeFrameRef.current);
      }
    },
    [cancelCanvasPan]
  );

  const startCanvasDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        isNewTaskClosing ||
        event.pointerType !== 'mouse' ||
        event.button !== 0 ||
        isHorizontalCanvasControl(event.target)
      ) {
        return;
      }
      cancelCanvasPan();
      canvasDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startScrollLeft: event.currentTarget.scrollLeft
      };
      setIsCanvasDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [cancelCanvasPan, isNewTaskClosing]
  );

  const moveCanvasDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = canvasDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (Math.abs(event.clientX - drag.startX) > 3) {
      event.preventDefault();
    }
    event.currentTarget.scrollLeft = dragNewTaskCanvas(
      drag.startScrollLeft,
      drag.startX,
      event.clientX,
      event.currentTarget.scrollWidth - event.currentTarget.clientWidth
    );
  }, []);

  const stopCanvasDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = canvasDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    canvasDragRef.current = undefined;
    setIsCanvasDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);
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
  const updateAppSettings = useCallback(
    async (patch: UpdateAppSettingsRequest, successMessage = 'Settings updated.') => {
      try {
        const nextSettings = await taskManagerApi.updateAppSettings(patch);
        setAppSettings(nextSettings);
        if (patch.externalExecutables || patch.codexExternalTools) {
          setExternalToolStatus(await taskManagerApi.getExternalToolStatus());
        }
        if (successMessage) {
          notify(successMessage, 'success');
        }
        return nextSettings;
      } catch (caught) {
        reportActionError(caught, 'Failed to update settings.');
        return undefined;
      }
    },
    [notify, reportActionError]
  );
  const updateTheme = useCallback(
    (nextTheme: ThemePreference) => {
      void updateAppSettings({ theme: nextTheme }, 'Theme updated.');
    },
    [updateAppSettings]
  );
  const toggleSidebar = useCallback(() => {
    void updateAppSettings({ sidebarCollapsed: !appSettings.sidebarCollapsed }, '');
  }, [appSettings.sidebarCollapsed, updateAppSettings]);

  const refresh = useCallback(async () => {
    const next = await taskManagerApi.listTasks();
    setSnapshot(next);
    setPreviewExecutionReadiness((current) => {
      const liveTaskIds = new Set(next.tasks.map((task) => task.id));
      const retainedEntries = Object.entries(current).filter(([taskId]) => liveTaskIds.has(taskId));
      return retainedEntries.length === Object.keys(current).length
        ? current
        : Object.fromEntries(retainedEntries);
    });
    setPreviewResolutions((current) => retainTaskEntries(current, next.tasks));
    setPreviewRecipeGenerations((current) => retainTaskEntries(current, next.tasks));
  }, []);
  const refreshExternalToolStatus = useCallback(async () => {
    setError(undefined);
    try {
      const next = await taskManagerApi.getExternalToolStatus();
      setExternalToolStatus(next);
    } catch (caught) {
      reportActionError(caught, 'Failed to refresh tool status.');
    }
  }, [reportActionError]);
  const refreshAgentRuntimes = useCallback(async () => {
    setError(undefined);
    try {
      setRuntimeCatalog(await taskManagerApi.getAgentRuntimeCatalog());
    } catch (caught) {
      reportActionError(caught, 'Failed to refresh agent runtimes.');
    }
  }, [reportActionError]);
  const refreshDiscourseAttention = useCallback(async () => {
    const conversations = await listDiscourseConversationSnapshot(taskManagerApi);
    setDiscourseAttentionCount(
      conversations.filter(
        (conversation) => conversation.needsAttention || conversation.unreadCount > 0
      ).length
    );
  }, []);
  const discoverAgentRuntimeModels = useCallback(async (runtimeId: string) => {
    const runtime = await taskManagerApi.discoverAgentRuntimeModels(runtimeId);
    setRuntimeCatalog((current) => {
      if (!current) return current;
      const runtimeIndex = current.runtimes.findIndex(
        (candidate) => candidate.preflight.runtime.id === runtimeId
      );
      if (runtimeIndex < 0) return current;
      const runtimes = [...current.runtimes];
      runtimes[runtimeIndex] = runtime;
      return {
        ...current,
        runtimes,
        models: runtimes.flatMap((candidate) => candidate.models),
        refreshedAt: runtime.refreshedAt
      };
    });
  }, []);
  const testExternalTool = useCallback(
    async (input: Parameters<typeof taskManagerApi.testExternalTool>[0]) => {
      const result = await taskManagerApi.testExternalTool(input);
      await refreshExternalToolStatus();
      return result;
    },
    [refreshExternalToolStatus]
  );

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
    if (windowChromePlatform !== 'macos') {
      return;
    }

    let pendingFrame: number | undefined;
    const syncWindowChrome = () => {
      if (pendingFrame !== undefined) {
        window.cancelAnimationFrame(pendingFrame);
      }
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = undefined;
        window.taskManagerShell?.syncWindowChrome();
      });
    };

    syncWindowChrome();
    window.addEventListener('resize', syncWindowChrome);
    window.visualViewport?.addEventListener('resize', syncWindowChrome);

    return () => {
      window.removeEventListener('resize', syncWindowChrome);
      window.visualViewport?.removeEventListener('resize', syncWindowChrome);
      if (pendingFrame !== undefined) {
        window.cancelAnimationFrame(pendingFrame);
      }
    };
  }, [windowChromePlatform]);

  useEffect(() => {
    let canceled = false;

    async function load() {
      try {
        const [catalog, settings, tools] = await Promise.all([
          taskManagerApi.getAgentRuntimeCatalog(),
          taskManagerApi.getAppSettings(),
          taskManagerApi.getExternalToolStatus(),
          refresh(),
          refreshDiscourseAttention()
        ]);
        if (!canceled) {
          setRuntimeCatalog(catalog);
          setAppSettings(settings);
          setExternalToolStatus(tools);
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
  }, [refresh, refreshDiscourseAttention]);

  useEffect(() => {
    const snapshotRefresh = createUpdateRefreshScheduler({
      delayMs: 50,
      refresh,
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number)
    });
    const runtimeCatalogRefresh = createUpdateRefreshScheduler({
      delayMs: 100,
      refresh: async () => {
        setRuntimeCatalog(await taskManagerApi.getAgentRuntimeCatalog());
      },
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number)
    });
    const discourseAttentionRefresh = createUpdateRefreshScheduler({
      delayMs: 100,
      refresh: refreshDiscourseAttention,
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number)
    });
    const unsubscribe = taskManagerApi.onUpdate((event) => {
      if (event.scope.kind === 'DISCOURSE') {
        discourseAttentionRefresh.request();
        return;
      }
      if (event.type === 'runtime.updated') {
        runtimeCatalogRefresh.request();
      }
      if (
        event.type === 'preview.recipe-generation.updated' &&
        isPreviewRecipeGenerationSnapshot(event.payload)
      ) {
        const recipeGeneration = event.payload;
        setPreviewRecipeGenerations((current) => ({
          ...current,
          [event.taskId]: recipeGeneration
        }));
      }
      snapshotRefresh.request();
    });
    return () => {
      unsubscribe();
      snapshotRefresh.dispose();
      runtimeCatalogRefresh.dispose();
      discourseAttentionRefresh.dispose();
    };
  }, [refresh, refreshDiscourseAttention]);

  const theme = appSettings.theme;
  const isSidebarCollapsed = appSettings.sidebarCollapsed;
  const selectedRepositoryId = appSettings.selectedRepositoryId ?? '';

  const repositoryOptions = useMemo(
    () =>
      buildRepositoryOptions({
        repositories: snapshot.repositories,
        tasks: snapshot.tasks
      }),
    [snapshot.repositories, snapshot.tasks]
  );
  const activeRepositoryId = resolveSelectedRepositoryId(
    repositoryOptions,
    selectedRepositoryId
  );
  const activeRepository = snapshot.repositories.find(
    (repository) => repository.id === activeRepositoryId
  );
  const repositorySetupState = resolveRepositorySetupState({
    loading: isLoading,
    options: repositoryOptions,
    activeRepositoryId,
    firstLaunchSetupCompleted: appSettings.firstLaunchSetupCompleted
  });
  const canCreateTask =
    !isLoading &&
    snapshot.repositories.some((repository) => repository.status === 'AVAILABLE') &&
    repositorySetupState === 'complete';
  const selectedBoard = snapshot.boards.find((board) => board.id === selectedBoardId);
  const visibleTasks = useMemo(
    () => selectBoardTasks(snapshot.tasks, view === 'board' ? selectedBoard : undefined),
    [selectedBoard, snapshot.tasks, view]
  );

  useEffect(() => {
    if (selectedBoardId && !snapshot.boards.some((board) => board.id === selectedBoardId)) {
      setSelectedBoardId(undefined);
    }
  }, [selectedBoardId, snapshot.boards]);

  useEffect(() => {
    if (activeRepositoryId && activeRepositoryId !== selectedRepositoryId) {
      void updateAppSettings(
        { selectedRepositoryId: activeRepositoryId },
        ''
      );
    }
  }, [activeRepositoryId, selectedRepositoryId, updateAppSettings]);

  const selectedTaskCandidate = snapshot.tasks.find((task) => task.id === selectedTaskId);
  const selectedTask = selectedTaskCandidate;
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
  const selectedPreviewPlans = selectedTask
    ? snapshot.previewPlans.filter((record) => record.taskId === selectedTask.id)
    : [];
  const selectedPreviewApprovals = selectedTask
    ? snapshot.previewApprovals.filter((record) => record.taskId === selectedTask.id)
    : [];
  const selectedPreviewGenerations = selectedTask
    ? snapshot.previewGenerations.filter((record) => record.taskId === selectedTask.id)
    : [];
  const selectedPreviewGenerationAttachments = selectedTask
    ? snapshot.previewGenerationAttachments.filter((record) => record.taskId === selectedTask.id)
    : [];
  const selectedPreviewManagedResources = selectedTask
    ? snapshot.previewManagedResources.filter((record) => record.taskId === selectedTask.id)
    : [];
  const selectedPreviewComposeProjects = selectedTask
    ? snapshot.previewComposeProjects.filter((record) => record.taskId === selectedTask.id)
    : [];
  const selectedPreviewLocalBindings = selectedTask
    ? snapshot.previewLocalBindings.filter((record) => record.taskId === selectedTask.id)
    : [];
  const selectedPreviewRuntimeResources = selectedTask
    ? snapshot.previewResources.filter((record) => record.taskId === selectedTask.id)
    : [];
  const selectedPreviewNodeAttempts = selectedTask
    ? snapshot.previewNodeAttempts.filter((record) => record.taskId === selectedTask.id)
    : [];
  const selectedPreviewTaskRoutes = useMemo(
    () => selectedTask
      ? selectPreviewTaskRouteOptions(
          snapshot.tasks,
          snapshot.previewPlans,
          snapshot.previewGenerations,
          selectedTask.id
        )
      : [],
    [selectedTask, snapshot.previewGenerations, snapshot.previewPlans, snapshot.tasks]
  );
  const selectedGitSnapshots = useMemo(
    () =>
      selectedTask
        ? snapshot.gitSnapshots.filter(
            (gitSnapshot) => gitSnapshot.taskId === selectedTask.id
          )
        : [],
    [selectedTask, snapshot.gitSnapshots]
  );
  const selectedTaskAttachments = useMemo(
    () =>
      selectedTask
        ? snapshot.attachments
            .filter((attachment) => attachment.taskId === selectedTask.id)
            .sort((left, right) => left.ordinal - right.ordinal)
        : [],
    [selectedTask, snapshot.attachments]
  );
  const selectedWorktree = selectedTask ? selectCurrentWorktree(snapshot, selectedTask) : undefined;
  const selectedGitSnapshot = selectedTask
    ? selectLatestGitSnapshot(snapshot, selectedTask)
    : undefined;
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
  const disabledRuntimeIds = useMemo(
    () => new Set(appSettings.disabledRuntimeIds),
    [appSettings.disabledRuntimeIds]
  );
  const enabledRuntimes = useMemo(
    () =>
      runtimeCatalog?.runtimes.filter(
        (runtime) => !disabledRuntimeIds.has(runtime.preflight.runtime.id)
      ) ?? [],
    [disabledRuntimeIds, runtimeCatalog?.runtimes]
  );
  const enabledRuntimeIds = useMemo(
    () => new Set(enabledRuntimes.map((runtime) => runtime.preflight.runtime.id)),
    [enabledRuntimes]
  );
  const runtimeModels = runtimeCatalog?.models ?? [];
  const enabledRuntimeModels = useMemo(
    () => runtimeModels.filter((model) => enabledRuntimeIds.has(model.runtimeId)),
    [enabledRuntimeIds, runtimeModels]
  );
  const readyPromptRefinementRuntimes = enabledRuntimes.filter(
    (runtime) =>
      runtime.preflight.readiness.canStart &&
      runtime.preflight.capabilities.promptRefinement.maturity !== 'unsupported'
  );
  const configuredPromptRefinementRuntimeId =
    appSettings.promptRefinementRuntimeId ?? appSettings.defaultRuntimeId;
  const promptRefinementRuntime =
    readyPromptRefinementRuntimes.find(
      (runtime) =>
        runtime.preflight.runtime.id === configuredPromptRefinementRuntimeId
    ) ?? readyPromptRefinementRuntimes[0];
  const readyReviewRuntimes = enabledRuntimes.filter(
    (runtime) =>
      runtime.preflight.readiness.canStart &&
      (runtime.preflight.capabilities.review.maturity !== 'unsupported' ||
        runtime.preflight.capabilities.detachedReview.maturity === 'stable')
  );
  const configuredReviewRuntimeId =
    appSettings.reviewRuntimeId ?? selectedTask?.runtimeId;
  const reviewRuntime =
    readyReviewRuntimes.find(
      (runtime) => runtime.preflight.runtime.id === configuredReviewRuntimeId
    ) ??
    readyReviewRuntimes.find(
      (runtime) => runtime.preflight.runtime.id === selectedTask?.runtimeId
    ) ??
    readyReviewRuntimes[0];
  const refineDisabledReason = promptRefinementRuntime
    ? undefined
    : 'No ready agent runtime supports isolated prompt refinement.';
  const selectedTaskRuntimeState = selectedTask
    ? runtimeCatalog?.runtimes.find(
        (runtime) => runtime.preflight.runtime.id === selectedTask.runtimeId
      )
    : undefined;
  const defaultTaskSettings = useMemo(
    () =>
      resolveModelExecutionSettings(
        enabledRuntimeModels,
        appSettings.defaultModel,
        appSettings.defaultReasoningEffort,
        appSettings.defaultRuntimeId,
        appSettings.defaultModelProvider
      ),
    [
      appSettings.defaultModel,
      appSettings.defaultModelProvider,
      appSettings.defaultReasoningEffort,
      appSettings.defaultRuntimeId,
      enabledRuntimeModels
    ]
  );
  const reviewExecutionSettings = useMemo(
    () =>
      resolveModelExecutionSettings(
        enabledRuntimeModels,
        appSettings.reviewModel ?? appSettings.defaultModel,
        appSettings.reviewReasoningEffort,
        reviewRuntime?.preflight.runtime.id ??
          appSettings.reviewRuntimeId ??
          selectedTask?.runtimeId ??
          appSettings.defaultRuntimeId,
        appSettings.reviewModelProvider
      ),
    [
      appSettings.defaultModel,
      appSettings.defaultRuntimeId,
      appSettings.reviewModel,
      appSettings.reviewModelProvider,
      appSettings.reviewReasoningEffort,
      appSettings.reviewRuntimeId,
      reviewRuntime?.preflight.runtime.id,
      selectedTask?.runtimeId,
      enabledRuntimeModels
    ]
  );

  const createTask = async (input: CreateTaskRequest) => {
    try {
      const created = await taskManagerApi.createTask(input);
      taskNavigationReturnFocusRef.current = newTaskButtonRef.current;
      taskNavigationReturnIdRef.current = created.id;
      setSelectedTaskId(created.id);
      setIsDetailOpen(true);
      setNewTaskTextDraft({ title: '', prompt: '' });
      notify('Task created.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Could not create task.');
      throw caught;
    }
  };

  const refinePrompt = async (repositoryId: string, input: string) => {
    try {
      const refinementModel = selectModel(
        enabledRuntimeModels,
        appSettings.promptRefinementModel,
        promptRefinementRuntime?.preflight.runtime.id,
        appSettings.promptRefinementModelProvider
      );
      const refined = await taskManagerApi.refinePrompt({
        repositoryId,
        input,
        runtimeId:
          refinementModel?.runtimeId ??
          promptRefinementRuntime?.preflight.runtime.id,
        model: refinementModel?.model,
        modelProvider:
          refinementModel?.modelProvider ?? appSettings.promptRefinementModelProvider
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

  const createPullRequest = async (taskId: string, title?: string) => {
    setError(undefined);
    try {
      await taskManagerApi.createPullRequest({ taskId, title });
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
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to refresh GitHub.');
    }
  };

  const resolvePreview = async (taskId: string, scenarioId?: string) => {
    setError(undefined);
    try {
      const result = await taskManagerApi.resolvePreview({ taskId, scenarioId });
      setPreviewResolutions((current) => ({ ...current, [taskId]: result }));
      if (result.status === 'UNAVAILABLE') return;
      if (result.status === 'CONFIGURATION_REQUIRED') {
        await refresh();
        return;
      }
      setPreviewExecutionReadiness((current) => ({
        ...current,
        [taskId]: result.executionReadiness
      }));
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Could not resolve preview configuration.');
      throw caught;
    }
  };

  const setPreviewLocalBinding = async (
    taskId: string,
    attachmentId: string,
    target: PreviewResolvedAttachmentTarget,
    scenarioId: string
  ) => {
    setError(undefined);
    try {
      await taskManagerApi.setPreviewLocalAttachmentBinding({ taskId, attachmentId, target });
    } catch (caught) {
      reportActionError(caught, 'Could not configure the Preview target.');
      throw caught;
    }
    notify('Preview target configured.', 'success');
    try {
      await resolvePreview(taskId, scenarioId);
    } catch {
      // Resolution reports its own failure. The public binding was still saved successfully.
      await refresh().catch(() => undefined);
    }
  };

  const getPreviewRecipeGeneration = async (taskId: string) => {
    const state = await taskManagerApi.getPreviewRecipeGeneration({ taskId });
    setPreviewRecipeGenerations((current) => ({ ...current, [taskId]: state }));
    return state;
  };

  const generatePreviewRecipe = async (taskId: string) => {
    try {
      const refinementModel = selectModel(enabledRuntimeModels, appSettings.promptRefinementModel);
      const state = await taskManagerApi.generatePreviewRecipe({
        taskId,
        model: refinementModel?.model
      });
      setPreviewRecipeGenerations((current) => ({ ...current, [taskId]: state }));
      return state;
    } catch (caught) {
      reportActionError(caught, 'Could not generate a Preview recipe.');
      throw caught;
    }
  };

  const validatePreviewRecipeDraft = (
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<PreviewRecipeValidation> =>
    taskManagerApi.validatePreviewRecipeDraft({ taskId, draftId, yaml });

  const acceptPreviewRecipeDraft = async (
    taskId: string,
    draftId: string,
    yaml: string
  ) => {
    try {
      const result = await taskManagerApi.acceptPreviewRecipeDraft({ taskId, draftId, yaml });
      setPreviewRecipeGenerations((current) => ({
        ...current,
        [taskId]: { taskId, status: 'EMPTY' }
      }));
      if (result.resolution) {
        const resolution = result.resolution;
        setPreviewResolutions((current) => ({ ...current, [taskId]: resolution }));
        if (resolution.status === 'PLAN') {
          setPreviewExecutionReadiness((current) => ({
            ...current,
            [taskId]: resolution.executionReadiness
          }));
        }
      }
      await refresh();
      notify(
        result.checkError ?? 'Preview recipe saved. Review the resolved plan before approving it.',
        result.checkError ? 'info' : 'success'
      );
      return result;
    } catch (caught) {
      reportActionError(caught, 'Could not accept the Preview recipe.');
      throw caught;
    }
  };

  const discardPreviewRecipeDraft = async (taskId: string) => {
    const state = await taskManagerApi.discardPreviewRecipeDraft({ taskId });
    setPreviewRecipeGenerations((current) => ({ ...current, [taskId]: state }));
    return state;
  };

  const writePreviewRecipeManually = async (taskId: string, worktreeId: string) => {
    try {
      const result = await taskManagerApi.executeOpenTargetAction({
        target: { type: 'worktree', worktreeId, taskId },
        action: 'open'
      });
      if (!result.ok) throw new Error(result.message ?? 'Could not open the task worktree.');
      notify('Worktree opened. Create .taskmonki/preview.yaml, then check Preview.', 'info');
    } catch (caught) {
      reportActionError(caught, 'Could not open the task worktree.');
      throw caught;
    }
  };

  const approvePreview = async (taskId: string, planId: string, executionDigest: string) => {
    setError(undefined);
    try {
      await taskManagerApi.approvePreviewPlan({ taskId, planId, executionDigest });
      notify('Preview plan approved.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Could not approve preview plan.');
      throw caught;
    }
  };

  const startPreview = async (taskId: string, scenarioId?: string) => {
    setError(undefined);
    try {
      await taskManagerApi.startPreview({ taskId, scenarioId });
      notify('Preview is ready.', 'success');
      await refresh();
    } catch (caught) {
      await refresh();
      notify('Preview start did not complete. Review its status and logs.', 'error');
      throw caught;
    }
  };

  const stopPreview = async (taskId: string, generationId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.stopPreview({ taskId, generationId });
      notify('Preview stopped.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Could not stop preview safely.');
      await refresh();
      throw caught;
    }
  };

  const resetPreviewData = async (
    taskId: string,
    generationId: string,
    resourceId: string,
    scenarioId: string
  ) => {
    setError(undefined);
    try {
      await taskManagerApi.resetPreviewData({ taskId, generationId, resourceId, scenarioId });
      notify('Preview data reset and scenario completed.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Could not reset preview data safely.');
      await refresh();
      throw caught;
    }
  };

  const retryPreviewSetup = async (
    taskId: string,
    generationId: string,
    scenarioId: string
  ) => {
    setError(undefined);
    try {
      await taskManagerApi.retryPreviewSetup({ taskId, generationId, scenarioId });
      notify('Preview setup completed.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Could not retry preview setup safely.');
      await refresh();
      throw caught;
    }
  };

  const openPreview = async (taskId: string, generationId: string, routeId: string) => {
    setError(undefined);
    try {
      const result = await taskManagerApi.openPreview({ taskId, generationId, routeId });
      if (!result.opened) window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      reportActionError(caught, 'Could not open preview.');
      throw caught;
    }
  };

  const readPreviewLog = async (taskId: string, artifactId: string, offset: number, maxBytes: number) => {
    try {
      return await taskManagerApi.readPreviewLog({ taskId, artifactId, offset, maxBytes });
    } catch (caught) {
      reportActionError(caught, 'Could not read preview logs.');
      throw caught;
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

  const updateAgentNativeSession = async (
    input: UpdateAgentNativeSessionRequest
  ) => {
    setError(undefined);
    try {
      await taskManagerApi.updateAgentNativeSession(input);
      const [catalog] = await Promise.all([
        taskManagerApi.getAgentRuntimeCatalog(),
        refresh()
      ]);
      setRuntimeCatalog(catalog);
      notify('Provider session updated.', 'success');
    } catch (caught) {
      reportActionError(caught, 'Failed to update provider session.');
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
    async (repositoryId: string) => {
      if (!repositoryId || repositoryId === activeRepositoryId) {
        return;
      }
      const nextSettings = await updateAppSettings(
        { selectedRepositoryId: repositoryId },
        ''
      );
      if (!nextSettings) {
        return;
      }
      setSelectedTaskId(undefined);
      setLastTaskId(undefined);
      setIsDetailOpen(false);
      setError(undefined);
      const repository = snapshot.repositories.find((candidate) => candidate.id === repositoryId);
      notify(`New tasks will use ${repository?.name ?? 'this repository'}.`, 'success');
    },
    [activeRepositoryId, notify, snapshot.repositories, updateAppSettings]
  );

  const addRepository = useCallback(async () => {
    setError(undefined);
    setIsAddingRepository(true);
    try {
      const selectedPath = await taskManagerApi.chooseRepositoryFolder();
      if (!selectedPath) {
        return false;
      }
      const repository = await taskManagerApi.addRepository(selectedPath);
      const nextSettings = await updateAppSettings(
        { selectedRepositoryId: repository.id },
        ''
      );
      if (!nextSettings) {
        return false;
      }
      setSelectedTaskId(undefined);
      setLastTaskId(undefined);
      setIsDetailOpen(false);
      setIsNewTaskOpen(false);
      await refresh();
      notify(`Added ${repository.name}.`, 'success');
      return true;
    } catch (caught) {
      reportActionError(caught, 'Could not add repository.');
      return false;
    } finally {
      setIsAddingRepository(false);
    }
  }, [notify, refresh, reportActionError, updateAppSettings]);

  const refreshRepository = useCallback(
    async (repositoryId: string) => {
      setError(undefined);
      try {
        const repository = await taskManagerApi.refreshRepository(repositoryId);
        await refresh();
        notify(`${repository.name} refreshed.`, 'success');
      } catch (caught) {
        reportActionError(caught, 'Could not refresh repository.');
      }
    },
    [notify, refresh, reportActionError]
  );

  const reconnectRepository = useCallback(
    async (repositoryId: string) => {
      setError(undefined);
      try {
        const selectedPath = await taskManagerApi.chooseRepositoryFolder();
        if (!selectedPath) return;
        const repository = await taskManagerApi.reconnectRepository({
          repositoryId,
          path: selectedPath
        });
        await refresh();
        notify(`${repository.name} reconnected.`, 'success');
      } catch (caught) {
        reportActionError(caught, 'Could not reconnect repository.');
      }
    },
    [notify, refresh, reportActionError]
  );

  const requestRepositoryDisconnect = useCallback(
    async (repositoryId: string) => {
      setError(undefined);
      try {
        const [impact, repository] = await Promise.all([
          taskManagerApi.getRepositoryImpact(repositoryId),
          Promise.resolve(snapshot.repositories.find((candidate) => candidate.id === repositoryId))
        ]);
        if (!repository) throw new Error('Repository not found.');
        setRepositoryDisconnect({ repository, impact });
      } catch (caught) {
        reportActionError(caught, 'Could not inspect repository impact.');
      }
    },
    [reportActionError, snapshot.repositories]
  );

  const confirmRepositoryDisconnect = useCallback(async () => {
    if (!repositoryDisconnect || repositoryDisconnect.impact.blockingReason) return;
    try {
      await taskManagerApi.disconnectRepository({
        repositoryId: repositoryDisconnect.repository.id,
        confirmed: true
      });
      setRepositoryDisconnect(undefined);
      await refresh();
      notify(`${repositoryDisconnect.repository.name} disconnected.`, 'success');
    } catch (caught) {
      reportActionError(caught, 'Could not disconnect repository.');
      throw caught;
    }
  }, [notify, refresh, repositoryDisconnect, reportActionError]);

  const saveBoard = useCallback(
    async (input: CreateBoardRequest) => {
      try {
        const board =
          boardEditor && boardEditor !== 'new'
            ? await taskManagerApi.updateBoard({ ...input, boardId: boardEditor.id })
            : await taskManagerApi.createBoard(input);
        await refresh();
        setBoardEditor(undefined);
        setSelectedBoardId(board.id);
        setView('board');
        setIsDetailOpen(false);
        notify(`${board.name} saved.`, 'success');
      } catch (caught) {
        reportActionError(caught, 'Could not save board.');
        throw caught;
      }
    },
    [boardEditor, notify, refresh, reportActionError]
  );

  const deleteBoard = useCallback(
    async (boardId: string) => {
      try {
        await taskManagerApi.deleteBoard(boardId);
        setBoardEditor(undefined);
        setSelectedBoardId(undefined);
        await refresh();
        notify('Saved view deleted.', 'success');
      } catch (caught) {
        reportActionError(caught, 'Could not delete board.');
        throw caught;
      }
    },
    [notify, refresh, reportActionError]
  );

  const finishFirstLaunchSetup = useCallback(async () => {
    if (!activeRepositoryId) {
      const message = 'Add a repository before finishing setup.';
      reportActionError(new Error(message), message);
      throw new Error(message);
    }
    try {
      const [latestToolStatus, latestRuntimeCatalog] = await Promise.all([
        taskManagerApi.getExternalToolStatus(),
        taskManagerApi.getAgentRuntimeCatalog()
      ]);
      setExternalToolStatus(latestToolStatus);
      setRuntimeCatalog(latestRuntimeCatalog);
      const selectedRuntime = latestRuntimeCatalog.runtimes.find(
        (runtime) => runtime.preflight.runtime.id === appSettings.defaultRuntimeId
      );
      if (
        latestToolStatus.tools.git.status !== 'ok' ||
        !selectedRuntime?.preflight.readiness.canStart
      ) {
        throw new Error(
          `Git and ${selectedRuntime?.preflight.runtime.displayName ?? 'the selected agent runtime'} must be available before setup can finish.`
        );
      }
      const nextSettings = await taskManagerApi.updateAppSettings({
        firstLaunchSetupCompleted: true
      });
      setAppSettings(nextSettings);
      setView('board');
      setSelectedTaskId(undefined);
      setLastTaskId(undefined);
      setIsDetailOpen(false);
      setIsNewTaskOpen(false);
      setError(undefined);
      notify('Setup complete.', 'success');
    } catch (caught) {
      reportActionError(caught, 'Could not finish setup.');
      throw caught;
    }
  }, [activeRepositoryId, appSettings.defaultRuntimeId, notify, reportActionError]);

  const selectTask = (taskId: string, trigger?: HTMLElement) => {
    taskNavigationReturnFocusRef.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    taskNavigationReturnIdRef.current = taskId;
    setSelectedTaskId(taskId);
    setLastTaskId(taskId);
    setIsDetailOpen(true);
  };

  // Back: from an open task to the view it was opened from.
  const goBack = () => {
    setIsDetailOpen(false);
    window.requestAnimationFrame(() => {
      taskNavigationReturnTarget(
        taskNavigationReturnFocusRef.current,
        taskNavigationReturnIdRef.current,
        document.querySelectorAll<HTMLElement>('[data-task-id]'),
        appRootRef.current
      )?.focus({ preventScroll: true });
    });
  };

  // Forward: re-open the last task that was viewed.
  const goForward = () => {
    if (lastTaskId) {
      setSelectedTaskId(lastTaskId);
      setIsDetailOpen(true);
    }
  };

  const showView = (next: AppView) => {
    setView(next);
    setSelectedBoardId(undefined);
    setIsDetailOpen(false);
  };

  const showBoard = (boardId: string) => {
    setSelectedBoardId(boardId);
    setView('board');
    setIsDetailOpen(false);
  };

  const canGoBack = isDetailOpen;
  const canGoForward = !isDetailOpen && Boolean(lastTaskId);

  const navCounts = computeNavCounts(snapshot.tasks);

  const showDetail = isDetailOpen && Boolean(selectedTask);

  useEffect(() => {
    if (!showDetail) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      taskDetailHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedTask?.id, showDetail]);

  const resolvedTheme = resolveTheme(theme, prefersDark);
  const appOwnedModalOpen = Boolean(deleteCandidate || repositoryDisconnect || boardEditor);
  const appBackgroundModalOpen = appOwnedModalOpen || isTaskDetailModalOpen;

  return (
    <div
      ref={appRootRef}
      className="tm-app app-shell"
      tabIndex={-1}
      data-input-modality={inputModality}
      data-theme={resolvedTheme}
      data-window-platform={windowChromePlatform}
      onKeyDownCapture={() => setInputModality('keyboard')}
      onPointerDownCapture={() => setInputModality('pointer')}
    >
      <div
        ref={canvasViewportRef}
        className={`tm-body ${isCanvasDragging ? 'tm-body--dragging' : ''}`}
        inert={appOwnedModalOpen ? true : undefined}
        aria-hidden={appOwnedModalOpen ? true : undefined}
        onWheel={(event) => {
          if (
            !isNewTaskClosing &&
            shouldInterruptNewTaskCanvasPanForWheel(
              event.deltaX,
              event.deltaY,
              event.shiftKey
            )
          ) {
            cancelCanvasPan();
          }
        }}
        onPointerDown={startCanvasDrag}
        onPointerMove={moveCanvasDrag}
        onPointerUp={stopCanvasDrag}
        onPointerCancel={stopCanvasDrag}
      >
        <div className="tm-canvas">
          <div className="tm-canvas__workspace">
            <header
              className="tm-titlebar"
              data-window-platform={windowChromePlatform}
              inert={appBackgroundModalOpen ? true : undefined}
              aria-hidden={appBackgroundModalOpen ? true : undefined}
            >
              {windowChromePlatform === 'macos' ? (
                <div className="tm-titlebar__traffic-spacer" aria-hidden="true" />
              ) : null}
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
                ref={newTaskButtonRef}
                type="button"
                className="tm-newtask"
                onClick={openNewTask}
                disabled={!canCreateTask}
                title={canCreateTask ? 'New task' : 'Finish setup before creating tasks'}
              >
                + New task
              </button>
            </header>

            <div className="tm-canvas__content">
            <aside
              className={`tm-nav ${isSidebarCollapsed ? 'tm-nav--collapsed' : ''}`}
              inert={isTaskDetailModalOpen ? true : undefined}
              aria-hidden={isTaskDetailModalOpen ? true : undefined}
            >
          <div className="tm-nav__brand">
            <img
              className="tm-nav__brand-mark"
              src={
                resolvedTheme === 'dark'
                  ? './assets/brand/monkey_icon_cream.svg'
                  : './assets/brand/monkey_icon_charcoal.svg'
              }
              alt=""
              aria-hidden="true"
            />
            <span className="tm-nav__brand-name">Task Monki</span>
          </div>
          <div className="tm-nav__divider" />
          <div className="tm-nav__group">
            <div className="tm-nav__section">
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
                label="All tasks"
                icon={<BoardIcon />}
                active={!showDetail && view === 'board' && !selectedBoardId}
                collapsed={isSidebarCollapsed}
                onClick={() => showView('board')}
              />
              <NavItem
                label="Discourse"
                icon={<DiscourseNavIcon />}
                count={discourseAttentionCount}
                countNoun="conversation"
                urgent={discourseAttentionCount > 0}
                active={!showDetail && view === 'discourse'}
                collapsed={isSidebarCollapsed}
                onClick={() => showView('discourse')}
              />
            </div>
            <div className="tm-nav__section">
              <div className="tm-nav__saved-head">
                <button
                  type="button"
                  className="tm-nav__saved-toggle"
                  aria-expanded={areSavedViewsExpanded}
                  aria-controls="tm-saved-view-list"
                  onClick={() => setAreSavedViewsExpanded((expanded) => !expanded)}
                >
                  <SavedViewsFolderIcon open={areSavedViewsExpanded} />
                  <span className="tm-nav__saved-title">Saved views</span>
                </button>
                <button
                  type="button"
                  className="tm-nav__saved-add"
                  aria-label="New saved view"
                  title="New saved view"
                  data-tip="New saved view"
                  onClick={() => setBoardEditor('new')}
                >
                  <span aria-hidden="true">+</span>
                </button>
              </div>
              <div
                id="tm-saved-view-list"
                className="tm-nav__saved-list"
                hidden={!areSavedViewsExpanded}
              >
                {snapshot.boards.map((board) => (
                  <NavItem
                    key={board.id}
                    label={board.name}
                    icon={
                      <span
                        className="tm-nav__saved-color tm-board-color"
                        data-board-color={board.color.toLowerCase()}
                        aria-hidden="true"
                      />
                    }
                    count={selectBoardTasks(snapshot.tasks, board).length}
                    active={!showDetail && view === 'board' && selectedBoardId === board.id}
                    collapsed={isSidebarCollapsed}
                    onClick={() => showBoard(board.id)}
                  />
                ))}
              </div>
            </div>
            <div className="tm-nav__section">
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
            <div className="tm-nav__section">
              <NavItem
                label="Settings"
                icon={<SettingsIcon />}
                active={!showDetail && view === 'settings'}
                collapsed={isSidebarCollapsed}
                onClick={() => showView('settings')}
              />
            </div>
          </div>
          <div className="tm-nav__spacer" />
          <div className="tm-nav__divider" />

          <RepositorySwitcher
            activeRepositoryId={activeRepositoryId}
            options={repositoryOptions}
            collapsed={isSidebarCollapsed}
            adding={isAddingRepository}
            onSelect={selectRepository}
            onAddRepository={addRepository}
            onRefreshRepository={refreshRepository}
            onReconnectRepository={reconnectRepository}
            onDisconnectRepository={requestRepositoryDisconnect}
          />
        </aside>

        {showDetail ? (
          <TaskDetail
            headingRef={taskDetailHeadingRef}
            error={error}
            task={selectedTask}
            repository={snapshot.repositories.find(
              (repository) => repository.id === selectedTask?.repositoryId
            )}
            run={selectedRun}
            worktree={selectedWorktree}
            gitSnapshot={selectedGitSnapshot}
            gitSnapshots={selectedGitSnapshots}
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
            runtimeState={selectedTaskRuntimeState}
            server={snapshot.agentServers.find(
              (candidate) => candidate.id === selectedRun?.serverInstanceId
            )}
            artifacts={snapshot.artifacts}
            attachments={selectedTaskAttachments}
            interactions={selectedInteractions}
            previewPlans={selectedPreviewPlans}
            previewApprovals={selectedPreviewApprovals}
            previewGenerations={selectedPreviewGenerations}
            previewGenerationAttachments={selectedPreviewGenerationAttachments}
            previewManagedResources={selectedPreviewManagedResources}
            previewComposeProjects={selectedPreviewComposeProjects}
            previewLocalBindings={selectedPreviewLocalBindings}
            previewTaskRoutes={selectedPreviewTaskRoutes}
            previewRuntimeResources={selectedPreviewRuntimeResources}
            previewNodeAttempts={selectedPreviewNodeAttempts}
            previewExecutionReadiness={selectedTask
              ? previewExecutionReadiness[selectedTask.id]
              : undefined}
            previewResolution={selectedTask ? previewResolutions[selectedTask.id] : undefined}
            previewRecipeGeneration={selectedTask
              ? previewRecipeGenerations[selectedTask.id]
              : undefined}
            showMascot={appSettings.showMascot}
            onPrepareWorktree={prepareWorktree}
            onStart={startRun}
            onCancel={cancelRun}
            onSteer={steerRun}
            onContinue={continueRun}
            onRetry={retryRun}
            onReview={startReview}
            onSyncAgentGoal={syncAgentGoal}
            onUpdateAgentNativeSession={updateAgentNativeSession}
            onRespondToInteraction={respondToInteraction}
            onCreateDeliveryCommit={createDeliveryCommit}
            onCreatePullRequest={createPullRequest}
            onRefreshGitHub={refreshGitHub}
            onResolvePreview={resolvePreview}
            onSetPreviewLocalBinding={setPreviewLocalBinding}
            onGetPreviewRecipeGeneration={getPreviewRecipeGeneration}
            onGeneratePreviewRecipe={generatePreviewRecipe}
            onValidatePreviewRecipeDraft={validatePreviewRecipeDraft}
            onAcceptPreviewRecipeDraft={acceptPreviewRecipeDraft}
            onDiscardPreviewRecipeDraft={discardPreviewRecipeDraft}
            onWritePreviewRecipeManually={writePreviewRecipeManually}
            onApprovePreview={approvePreview}
            onStartPreview={startPreview}
            onOpenPreview={openPreview}
            onStopPreview={stopPreview}
            onResetPreviewData={resetPreviewData}
            onRetryPreviewSetup={retryPreviewSetup}
            onReadPreviewLog={readPreviewLog}
            onTransition={transitionTask}
            onArchive={archiveTask}
            onRequestDelete={requestDeleteTask}
            onModalOpenChange={setIsTaskDetailModalOpen}
          />
        ) : view === 'discourse' ? (
          <DiscourseWorkspace onNotify={notify} onError={reportActionError} />
        ) : (
          <MainColumn
            view={view}
            board={selectedBoard}
            tasks={visibleTasks}
            repositories={snapshot.repositories}
            interactionRequests={snapshot.interactionRequests}
            theme={theme}
            onSetTheme={updateTheme}
            appSettings={appSettings}
            onSetAppSettings={updateAppSettings}
            externalToolStatus={externalToolStatus}
            agentRuntimesLoading={isLoading && runtimeCatalog === undefined}
            onRefreshExternalTools={refreshExternalToolStatus}
            onRefreshAgentRuntimes={refreshAgentRuntimes}
            onDiscoverAgentRuntimeModels={discoverAgentRuntimeModels}
            onTestExternalTool={testExternalTool}
            error={error}
            models={runtimeModels}
            runtimes={runtimeCatalog?.runtimes ?? []}
            activeRepository={activeRepository}
            repositorySetupState={repositorySetupState}
            addingRepository={isAddingRepository}
            onAddRepository={addRepository}
            onFinishSetup={finishFirstLaunchSetup}
            onSelect={selectTask}
            onRespondToInteraction={respondToInteraction}
            onArchive={archiveTask}
            onRequestDelete={requestDeleteTask}
            onEditBoard={setBoardEditor}
          />
            )}
            </div>
          </div>

          {isNewTaskOpen ? (
            <NewTaskPanel
              repositoryId={activeRepositoryId}
              repositories={snapshot.repositories}
              models={enabledRuntimeModels}
              runtimes={enabledRuntimes}
              defaultAgentSettings={defaultTaskSettings}
              disabled={!canCreateTask}
              refineDisabledReason={refineDisabledReason}
              onCreate={createTask}
              onRefinePrompt={refinePrompt}
              onStageAttachmentBatch={taskManagerApi.stageTaskAttachmentBatch}
              onDiscardAttachmentDraft={taskManagerApi.discardTaskAttachmentDraft}
              onReadClipboardImage={taskManagerApi.readClipboardImage}
              onDiscoverAgentRuntimeModels={discoverAgentRuntimeModels}
              initialTextDraft={newTaskTextDraft}
              onTextDraftChange={setNewTaskTextDraft}
              returnFocusRef={newTaskButtonRef}
              fallbackReturnFocusRef={appRootRef}
              onResize={keepNewTaskPanelInView}
              onClose={closeNewTask}
            />
          ) : null}
        </div>
      </div>

      {deleteCandidate ? (
        <DeleteTaskModal
          task={deleteCandidate}
          worktree={deleteCandidateWorktree}
          gitSnapshot={deleteCandidateGitSnapshot}
          onCancel={() => setDeleteCandidateId(undefined)}
          onConfirm={(removeWorktree) => deleteTask(deleteCandidate.id, removeWorktree)}
          fallbackReturnFocusRef={appRootRef}
        />
      ) : null}

      {repositoryDisconnect ? (
        <RepositoryDisconnectModal
          repository={repositoryDisconnect.repository}
          impact={repositoryDisconnect.impact}
          onCancel={() => setRepositoryDisconnect(undefined)}
          onConfirm={confirmRepositoryDisconnect}
          fallbackReturnFocusRef={appRootRef}
        />
      ) : null}

      {boardEditor ? (
        <BoardEditorModal
          key={boardEditor === 'new' ? 'new' : boardEditor.id}
          board={boardEditor === 'new' ? undefined : boardEditor}
          repositories={repositoryOptions}
          onCancel={() => setBoardEditor(undefined)}
          onSave={saveBoard}
          onDelete={deleteBoard}
          fallbackReturnFocusRef={appRootRef}
        />
      ) : null}

      <GlobalNotifier notifications={notifications} />
    </div>
  );
}
