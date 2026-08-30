import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  TASK_STORE_SCHEMA_VERSION,
  getImplementationRetryReason,
  type CreateTaskRequest,
  type CreateBoardRequest,
  type Board,
  type BoardSnapshot,
  type AgentInteractionDecision,
  type AgentRuntimeCatalog,
  type AgentRetryStrategy,
  type CreateBlankDesignRequest,
  type DeleteTaskResult,
  type DesignDetailSnapshot,
  type DesignDraftRecord,
  type DesignListItem,
  type ExternalToolStatusReport,
  type InteractionRequestRecord,
  type Repository,
  type RepositoryImpact,
  type PreviewRecipeGenerationSnapshot,
  type PreviewRecipeValidation,
  type PreviewResolvedAttachmentTarget,
  type RefinePromptRequest,
  type ResolvePreviewResult,
  type Task,
  type TaskDetailSnapshot,
  type TaskManagerAppSettings,
  type UpdateAgentNativeSessionRequest,
  type UpdateAppSettingsRequest,
  type WorkflowPhase
} from '../../shared/contracts';
import type {
  HideDesignCanvasRequest,
  RefreshDesignCanvasRequest,
  ShowDesignCanvasRequest
} from '../../shared/designCanvas';
import type { PreviewExecutionReadiness } from '../../shared/preview';
import type { SoftwareUpdateState } from '../../shared/softwareUpdate';
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
import {
  createUpdateRefreshScheduler,
  taskDataRefreshPlan
} from '../model/updateRefreshScheduler';
import {
  createTaskDataReadCoordinator,
  type TaskDataReadCoordinator
} from '../model/taskDataReadCoordinator';
import { selectBoardTasks } from '../model/boards';
import {
  designCanvasClientEvent,
  eligibleDesignRuntimeCatalog,
  mergeDesignConversationPage,
  mergeDesignDetailHistory,
  qualifiedDesignModels,
  type DesignCanvasExternalLinkRequest
} from '../model/designs';
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
import { appendUniqueNotification } from '../model/notifications';
import { selectConfiguredRuntimeForOperation } from '../model/runtimeReadiness';
import {
  focusedPanelWidth,
  focusedWorkspaceHistoryCollapsed,
  focusedWorkspaceUsesCompactHistory,
  persistFocusedPanelWidth,
  persistFocusedWorkspaceHistoryCollapsed
} from '../model/workspaceLayout';
import { creationRequiresUnchangedRetry } from '../model/taskAttachmentComposer';
import { MainColumn } from './MainColumn';
import {
  applyThemeToRoot,
  resolveTheme,
  resolveThemePreset,
  type ThemePreference,
  type ThemePreset
} from './theme';
import { computeNavCounts, type NavView } from '../model/taskView';
import { NewTaskPanel, type NewTaskTextDraft } from './NewTaskPanel';
import { RepositorySwitcher } from './RepositorySwitcher';
import { TaskDetail } from './TaskDetail';
import { DiscourseWorkspace } from './DiscourseWorkspace';
import { DesignsWorkspace } from './DesignsWorkspace';
import { PanelResizeHandle } from './PanelResizeHandle';
import { taskNavigationReturnTarget } from './taskNavigationFocus';
import { SoftwareUpdateNotice } from './SoftwareUpdateNotice';
import {
  BoardEditorModal,
  DeleteTaskModal,
  DesignExternalLinkModal,
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
  DesignIcon,
  DiscourseIcon,
  DoneIcon,
  InboxIcon,
  NavItem,
  PanelIcon,
  PlusIcon,
  ReviewIcon,
  SavedViewsFolderIcon,
  SettingsIcon
} from './AppNavigation';

const AUTHORITATIVE_REFRESH_DELAY_MS = 50;
const SELECTED_ACTIVITY_REFRESH_DELAY_MS = 1_000;
const DESIGN_CANVAS_LOAD_FAILED_NOTICE =
  'The Design preview could not load. Select the Design again to retry.';
const unavailableSoftwareUpdateState: SoftwareUpdateState = {
  status: 'unavailable',
  currentVersion: '',
  availableVersion: null,
  lastCheckedAt: null,
  progress: null,
  errorMessage: null
};

const emptyBoardSnapshot: BoardSnapshot = {
  schemaVersion: TASK_STORE_SCHEMA_VERSION,
  repositories: [],
  boards: [],
  tasks: [],
  interactionRequests: []
};

function prefersDarkScheme(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function retainTaskEntries<T>(
  current: Record<string, T>,
  tasks: Array<{ id: string }>
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
type AppView = NavView | 'discourse' | 'designs';

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
  const [snapshot, setSnapshot] = useState<BoardSnapshot>(emptyBoardSnapshot);
  const [taskDetail, setTaskDetail] = useState<TaskDetailSnapshot>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [isAddingRepository, setIsAddingRepository] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<AppView>('board');
  const [designHistoryCollapsed, setDesignHistoryCollapsed] = useState(() =>
    focusedWorkspaceHistoryCollapsed('designs') ||
    focusedWorkspaceUsesCompactHistory(window.innerWidth)
  );
  const [discourseHistoryCollapsed, setDiscourseHistoryCollapsed] = useState(() =>
    focusedWorkspaceHistoryCollapsed('discourse') ||
    focusedWorkspaceUsesCompactHistory(window.innerWidth)
  );
  const [discourseAttentionCount, setDiscourseAttentionCount] = useState(0);
  const [designs, setDesigns] = useState<DesignListItem[]>([]);
  const [selectedDesignId, setSelectedDesignId] = useState<string | undefined>();
  const [designDetail, setDesignDetail] = useState<DesignDetailSnapshot>();
  const [designDraft, setDesignDraft] = useState<DesignDraftRecord | null>(null);
  const [designsLoading, setDesignsLoading] = useState(false);
  const [designsError, setDesignsError] = useState<string | undefined>();
  const [designExternalLinkRequest, setDesignExternalLinkRequest] =
    useState<DesignCanvasExternalLinkRequest>();
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
  const [deleteCandidateDetail, setDeleteCandidateDetail] =
    useState<TaskDetailSnapshot>();
  const [repositoryDisconnect, setRepositoryDisconnect] = useState<{
    repository: Repository;
    impact: RepositoryImpact;
  }>();
  const [prefersDark, setPrefersDark] = useState<boolean>(() => prefersDarkScheme());
  const [appSettings, setAppSettings] = useState<TaskManagerAppSettings>(
    DEFAULT_TASK_MANAGER_APP_SETTINGS
  );
  const [softwareUpdateState, setSoftwareUpdateState] = useState<SoftwareUpdateState>(
    unavailableSoftwareUpdateState
  );
  const [previewThemePreset, setPreviewThemePreset] = useState<ThemePreset | null>(null);
  const [appSidebarWidth, setAppSidebarWidth] = useState(() =>
    focusedPanelWidth('app-navigation', 176, 176, 240)
  );
  const [externalToolStatus, setExternalToolStatus] = useState<ExternalToolStatusReport>();
  const [runtimeCatalog, setRuntimeCatalog] = useState<AgentRuntimeCatalog>();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [isCanvasDragging, setIsCanvasDragging] = useState(false);
  const newTaskButtonRef = useRef<HTMLButtonElement>(null);
  const appRootRef = useRef<HTMLDivElement>(null);
  const focusedHistoryCompactRef = useRef(
    focusedWorkspaceUsesCompactHistory(window.innerWidth)
  );
  const taskDetailHeadingRef = useRef<HTMLHeadingElement>(null);
  const taskNavigationReturnFocusRef = useRef<HTMLElement | null>(null);
  const taskNavigationReturnIdRef = useRef<string | undefined>(undefined);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const canvasContentRef = useRef<HTMLDivElement>(null);
  const canvasPanFrameRef = useRef<number | undefined>(undefined);
  const canvasResizeFrameRef = useRef<number | undefined>(undefined);
  const canvasDragRef = useRef<
    { pointerId: number; startX: number; startScrollLeft: number } | undefined
  >(undefined);
  const deleteCandidateGenerationRef = useRef(0);
  const selectedDesignIdRef = useRef<string | undefined>(undefined);
  const designListReadGenerationRef = useRef(0);
  const designReadGenerationRef = useRef(0);
  const pendingDesignTurnRef = useRef<{
    designId: string;
    message: string;
    referenceIds: string[];
    attachmentDraftId?: string;
    clientMessageId: string;
  } | undefined>(undefined);
  const pendingDesignActionIdsRef = useRef(new Map<string, string>());
  const designCanvasErrorRef = useRef<string | undefined>(undefined);
  const viewRef = useRef<AppView>(view);
  viewRef.current = view;
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
    setNotifications((current) => appendUniqueNotification(current, { id, tone, message }));
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
  const taskDataCoordinatorRef = useRef<TaskDataReadCoordinator | undefined>(
    undefined
  );
  if (!taskDataCoordinatorRef.current) {
    taskDataCoordinatorRef.current = createTaskDataReadCoordinator({
      readBoard: () => taskManagerApi.getBoardSnapshot(),
      readTaskDetail: (taskId) => taskManagerApi.getTaskDetail(taskId),
      applyBoard: (next) => {
        setSnapshot(next);
        setPreviewExecutionReadiness((current) =>
          retainTaskEntries(current, next.tasks)
        );
        setPreviewResolutions((current) => retainTaskEntries(current, next.tasks));
        setPreviewRecipeGenerations((current) =>
          retainTaskEntries(current, next.tasks)
        );
      },
      applyTaskDetail: (detail) => {
        setTaskDetail(detail);
        setError(undefined);
      },
      reportBoardError: (caught) => {
        reportActionError(caught, 'Failed to refresh the task board.');
      },
      reportTaskDetailError: (_taskId, caught) => {
        reportActionError(caught, 'Failed to refresh task detail.');
      }
    });
  }
  const taskDataCoordinator = taskDataCoordinatorRef.current;
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
  const checkForSoftwareUpdates = useCallback(async () => {
    try {
      const shell = window.taskManagerShell;
      if (!shell) throw new Error('Software updates are available in the installed desktop app.');
      setSoftwareUpdateState(await shell.checkForSoftwareUpdates());
    } catch (caught) {
      reportActionError(caught, 'Could not check for updates.');
    }
  }, [reportActionError]);
  const downloadSoftwareUpdate = useCallback(async () => {
    try {
      const shell = window.taskManagerShell;
      if (!shell) throw new Error('Software updates are available in the installed desktop app.');
      setSoftwareUpdateState(await shell.downloadSoftwareUpdate());
    } catch (caught) {
      reportActionError(caught, 'Could not download the update.');
    }
  }, [reportActionError]);
  const installSoftwareUpdate = useCallback(async () => {
    try {
      const shell = window.taskManagerShell;
      if (!shell) throw new Error('Software updates are available in the installed desktop app.');
      await shell.installSoftwareUpdate();
    } catch (caught) {
      reportActionError(caught, 'Could not install the update.');
    }
  }, [reportActionError]);
  useEffect(() => {
    const handleFocusedHistoryResize = () => {
      const compact = focusedWorkspaceUsesCompactHistory(window.innerWidth);
      if (compact === focusedHistoryCompactRef.current) return;
      focusedHistoryCompactRef.current = compact;
      if (compact) {
        setDesignHistoryCollapsed(true);
        setDiscourseHistoryCollapsed(true);
        return;
      }
      setDesignHistoryCollapsed(focusedWorkspaceHistoryCollapsed('designs'));
      setDiscourseHistoryCollapsed(focusedWorkspaceHistoryCollapsed('discourse'));
    };
    window.addEventListener('resize', handleFocusedHistoryResize);
    return () => window.removeEventListener('resize', handleFocusedHistoryResize);
  }, []);
  const toggleSidebar = useCallback(() => {
    void updateAppSettings({ sidebarCollapsed: !appSettings.sidebarCollapsed }, '');
  }, [appSettings.sidebarCollapsed, updateAppSettings]);

  useLayoutEffect(() => {
    canvasContentRef.current?.style.setProperty('--app-sidebar-width', `${appSidebarWidth}px`);
  }, [appSidebarWidth]);

  const refresh = useCallback(async () => {
    await Promise.all([
      taskDataCoordinator.refreshBoard(),
      taskDataCoordinator.refreshSelectedTask()
    ]);
  }, [taskDataCoordinator]);
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
  const upsertDesignSummary = useCallback((next: DesignListItem) => {
    setDesigns((current) => [
      next,
      ...current.filter((candidate) => candidate.id !== next.id)
    ]);
  }, []);
  const refreshDesignList = useCallback(async () => {
    const generation = ++designListReadGenerationRef.current;
    try {
      const next = await taskManagerApi.listDesigns();
      if (generation !== designListReadGenerationRef.current) {
        return undefined;
      }
      setDesigns(next);
      const currentDesignId = selectedDesignIdRef.current;
      if (
        currentDesignId &&
        !next.some((candidate) => candidate.id === currentDesignId)
      ) {
        designReadGenerationRef.current += 1;
        selectedDesignIdRef.current = undefined;
        setSelectedDesignId(undefined);
        setDesignDetail(undefined);
        setDesignDraft(null);
        setDesignExternalLinkRequest((current) =>
          current?.designId === currentDesignId ? undefined : current
        );
        setDesignsLoading(false);
        setDesignsError(undefined);
      } else if (!currentDesignId) {
        setDesignsError(undefined);
      }
      return next;
    } catch (caught) {
      if (generation === designListReadGenerationRef.current) {
        const message =
          caught instanceof Error ? caught.message : 'Could not load Designs.';
        setDesignsError(message);
      }
      return undefined;
    }
  }, []);
  const loadDesign = useCallback(
    async (
      designId: string,
      options: { select?: boolean; showLoading?: boolean } = {}
    ) => {
      const select = options.select ?? false;
      const showLoading = options.showLoading ?? false;
      const loadDraft = select || showLoading;
      if (select) {
        selectedDesignIdRef.current = designId;
        setSelectedDesignId(designId);
        setDesignDetail((current) =>
          current?.design.id === designId ? current : undefined
        );
        setDesignDraft(null);
      } else if (selectedDesignIdRef.current !== designId) {
        return;
      }

      const generation = ++designReadGenerationRef.current;
      if (showLoading) {
        setDesignsLoading(true);
        setDesignsError(undefined);
      }
      try {
        const [detail, draft] = await Promise.all([
          taskManagerApi.getDesign(designId),
          loadDraft
            ? taskManagerApi.getDesignDraft(designId)
            : Promise.resolve(undefined)
        ]);
        if (
          generation !== designReadGenerationRef.current ||
          selectedDesignIdRef.current !== designId
        ) {
          return;
        }
        setDesignDetail((current) => mergeDesignDetailHistory(current, detail));
        if (draft !== undefined) setDesignDraft(draft);
        upsertDesignSummary(detail.design);
        setDesignsError(undefined);
      } catch (caught) {
        if (
          generation === designReadGenerationRef.current &&
          selectedDesignIdRef.current === designId
        ) {
          const message =
            caught instanceof Error ? caught.message : 'Could not load this Design.';
          setDesignsError(message);
          if (showLoading) {
            notify(message, 'error');
          }
        }
      } finally {
        if (generation === designReadGenerationRef.current) {
          setDesignsLoading(false);
        }
      }
    },
    [notify, upsertDesignSummary]
  );
  const applyDesignActionDetail = useCallback(
    (detail: DesignDetailSnapshot, select: boolean) => {
      designListReadGenerationRef.current += 1;
      upsertDesignSummary(detail.design);
      if (select || selectedDesignIdRef.current === detail.design.id) {
        designReadGenerationRef.current += 1;
        selectedDesignIdRef.current = detail.design.id;
        setSelectedDesignId(detail.design.id);
        setDesignDetail((current) => mergeDesignDetailHistory(current, detail));
        if (select) setDesignDraft(null);
        setDesignsLoading(false);
        setDesignsError(undefined);
      }
    },
    [upsertDesignSummary]
  );
  const openDesignWorkspace = useCallback(async () => {
    setDesignsLoading(true);
    setDesignsError(undefined);
    const listed = await refreshDesignList();
    const availableDesigns = listed ?? designs;
    const currentDesignId = selectedDesignIdRef.current;
    const nextDesignId =
      currentDesignId &&
      (listed === undefined ||
        availableDesigns.some((candidate) => candidate.id === currentDesignId))
        ? currentDesignId
        : availableDesigns[0]?.id;
    if (!nextDesignId) {
      designReadGenerationRef.current += 1;
      selectedDesignIdRef.current = undefined;
      setSelectedDesignId(undefined);
      setDesignDetail(undefined);
      setDesignDraft(null);
      setDesignsLoading(false);
      return;
    }
    await loadDesign(nextDesignId, {
      select: nextDesignId !== currentDesignId,
      showLoading: false
    });
  }, [designs, loadDesign, refreshDesignList]);
  const createBlankDesign = useCallback(
    async (
      input: Pick<
        CreateBlankDesignRequest,
        | 'brief'
        | 'creationToken'
        | 'runtimeId'
        | 'model'
        | 'modelProvider'
        | 'reasoningEffort'
        | 'attachmentDraftId'
      >
    ) => {
      const brief = input.brief.trim();
      try {
        const detail = await taskManagerApi.createBlankDesign({
          brief,
          creationToken: input.creationToken,
          runtimeId: input.runtimeId,
          model: input.model,
          modelProvider: input.modelProvider,
          reasoningEffort: input.reasoningEffort,
          ...(input.attachmentDraftId
            ? { attachmentDraftId: input.attachmentDraftId }
            : {})
        });
        applyDesignActionDetail(detail, true);
        notify('Design created.', 'success');
        void refreshDesignList();
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : 'Could not create the Design.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const submitDesignRefinement = useCallback(
    async (
      designId: string,
      message: string,
      referenceIds: string[],
      attachmentDraftId?: string
    ) => {
      const pending =
        pendingDesignTurnRef.current?.designId === designId &&
        pendingDesignTurnRef.current.message === message &&
        pendingDesignTurnRef.current.referenceIds.length === referenceIds.length &&
        pendingDesignTurnRef.current.referenceIds.every(
          (referenceId, index) => referenceId === referenceIds[index]
        ) &&
        pendingDesignTurnRef.current.attachmentDraftId === attachmentDraftId
          ? pendingDesignTurnRef.current
          : {
              designId,
              message,
              referenceIds: [...referenceIds],
              attachmentDraftId,
              clientMessageId: crypto.randomUUID()
            };
      pendingDesignTurnRef.current = pending;
      try {
        const detail = await taskManagerApi.submitDesignTurn({
          designId,
          clientMessageId: pending.clientMessageId,
          message,
          referenceIds: pending.referenceIds,
          ...(pending.attachmentDraftId
            ? { attachmentDraftId: pending.attachmentDraftId }
            : {})
        });
        if (pendingDesignTurnRef.current === pending) {
          pendingDesignTurnRef.current = undefined;
        }
        applyDesignActionDetail(detail, false);
        const accepted = detail.conversation.find(
          (entry) => entry.turn.clientMessageId === pending.clientMessageId
        );
        notify(accepted?.turn.runId ? 'Design update started.' : 'Message queued.', 'success');
        void refreshDesignList();
      } catch (caught) {
        if (!creationRequiresUnchangedRetry(caught) && pendingDesignTurnRef.current === pending) {
          pendingDesignTurnRef.current = undefined;
        }
        const errorMessage =
          caught instanceof Error ? caught.message : 'Could not send the refinement.';
        notify(errorMessage, 'error');
        throw caught instanceof Error ? caught : new Error(errorMessage);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const addDesignReferences = useCallback(
    async (designId: string, attachmentDraftId: string) => {
      try {
        const detail = await taskManagerApi.addDesignReferences({
          designId,
          attachmentDraftId
        });
        applyDesignActionDetail(detail, false);
        notify('References added.', 'success');
        void refreshDesignList();
        return detail.references
          .filter((reference) => reference.sourceDraftId === attachmentDraftId)
          .map((reference) => reference.id);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not add references.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const removeDesignReference = useCallback(
    async (designId: string, referenceId: string) => {
      try {
        const detail = await taskManagerApi.removeDesignReference({
          designId,
          referenceId
        });
        applyDesignActionDetail(detail, false);
        notify('Reference removed from future messages.', 'success');
        void refreshDesignList();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not remove the reference.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const importDesignReferenceAsset = useCallback(
    async (designId: string, referenceId: string) => {
      try {
        const detail = await taskManagerApi.importDesignReferenceAsset({
          designId,
          referenceId
        });
        applyDesignActionDetail(detail, false);
        notify('Project asset imported.', 'success');
        void refreshDesignList();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not import the asset.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const stopDesignTurn = useCallback(
    async (designId: string, turnId: string) => {
      try {
        const detail = await taskManagerApi.cancelDesignTurn({ designId, turnId });
        applyDesignActionDetail(detail, false);
        notify('Stopping Design work.', 'info');
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not stop work.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify]
  );
  const loadEarlierDesignConversation = useCallback(
    async (designId: string) => {
      const cursor =
        designDetail?.design.id === designId
          ? designDetail.previousConversationCursor
          : undefined;
      if (!cursor) return;
      try {
        const page = await taskManagerApi.listDesignConversation({
          designId,
          beforeCursor: cursor
        });
        setDesignDetail((current) =>
          current?.design.id === designId
            ? mergeDesignConversationPage(current, page)
            : current
        );
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : 'Could not load earlier messages.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [designDetail, notify]
  );
  const saveDesignDraft = useCallback(
    async (
      designId: string,
      body: string,
      referenceIds: string[],
      attachmentDraftId: string | undefined,
      expectedRevision: number
    ) => {
      const saved = await taskManagerApi.saveDesignDraft({
        designId,
        body,
        referenceIds,
        ...(attachmentDraftId ? { attachmentDraftId } : {}),
        expectedRevision
      });
      if (selectedDesignIdRef.current === designId) setDesignDraft(saved);
      return saved;
    },
    []
  );
  const deleteDesignDraft = useCallback(
    async (designId: string, expectedRevision: number) => {
      await taskManagerApi.deleteDesignDraft({ designId, expectedRevision });
      if (selectedDesignIdRef.current === designId) setDesignDraft(null);
    },
    []
  );
  const respondToDesignInteraction = useCallback(
    async (
      interaction: InteractionRequestRecord,
      decision: AgentInteractionDecision
    ) => {
      try {
        await taskManagerApi.respondToInteraction({
          taskId: interaction.taskId,
          runId: interaction.runId,
          interactionRequestId: interaction.id,
          decision
        });
        notify('Provider request answered.', 'success');
        await loadDesign(interaction.taskId, { showLoading: false });
        void refreshDesignList();
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : 'Could not submit the response.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [loadDesign, notify, refreshDesignList]
  );
  const restartDesignCanvas = useCallback(
    async (designId: string) => {
      try {
        const detail = await taskManagerApi.restartDesignPreview({ designId });
        applyDesignActionDetail(detail, false);
        notify('Preview restarted.', 'success');
        void refreshDesignList();
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : 'Could not restart the preview.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const showDesignRevision = useCallback(
    async (designId: string, revisionId: string) => {
      try {
        const detail = await taskManagerApi.restartDesignPreview({
          designId,
          revisionId
        });
        applyDesignActionDetail(detail, false);
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : 'Could not show this version.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify]
  );
  const openDesignLocation = useCallback(
    async (designId: string, worktreeId: string) => {
      try {
        const result = await taskManagerApi.executeOpenTargetAction({
          target: { type: 'worktree', worktreeId, taskId: designId },
          action: 'open'
        });
        if (!result.ok) {
          throw new Error(result.message ?? 'Could not open the Design folder.');
        }
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : 'Could not open the Design folder.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [notify]
  );
  const restoreDesignRevision = useCallback(
    async (designId: string, revisionId: string) => {
      const key = `restore:${designId}:${revisionId}`;
      const clientActionId =
        pendingDesignActionIdsRef.current.get(key) ?? crypto.randomUUID();
      pendingDesignActionIdsRef.current.set(key, clientActionId);
      try {
        const detail = await taskManagerApi.restoreDesignRevision({
          designId,
          revisionId,
          clientActionId
        });
        pendingDesignActionIdsRef.current.delete(key);
        applyDesignActionDetail(detail, false);
        notify('Earlier version restored.', 'success');
        void refreshDesignList();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not restore this version.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const duplicateDesign = useCallback(
    async (designId: string, revisionId: string) => {
      const key = `duplicate:${designId}:${revisionId}`;
      const clientActionId =
        pendingDesignActionIdsRef.current.get(key) ?? crypto.randomUUID();
      pendingDesignActionIdsRef.current.set(key, clientActionId);
      try {
        const detail = await taskManagerApi.duplicateDesign({
          designId,
          revisionId,
          clientActionId
        });
        pendingDesignActionIdsRef.current.delete(key);
        applyDesignActionDetail(detail, true);
        notify('Design duplicated.', 'success');
        void refreshDesignList();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not duplicate the Design.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const renameDesign = useCallback(
    async (designId: string, title: string) => {
      try {
        const detail = await taskManagerApi.renameDesign({ designId, title });
        applyDesignActionDetail(detail, false);
        notify('Design renamed.', 'success');
        void refreshDesignList();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not rename the Design.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const archiveDesign = useCallback(
    async (designId: string) => {
      try {
        const detail = await taskManagerApi.archiveDesign({ designId });
        applyDesignActionDetail(detail, false);
        notify('Design archived.', 'success');
        void refreshDesignList();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not archive the Design.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [applyDesignActionDetail, notify, refreshDesignList]
  );
  const deleteDesign = useCallback(
    async (designId: string) => {
      try {
        await taskManagerApi.deleteTask({ taskId: designId, removeWorktree: true });
        designListReadGenerationRef.current += 1;
        designReadGenerationRef.current += 1;
        const remainingDesigns = designs.filter(
          (candidate) => candidate.id !== designId
        );
        setDesigns(remainingDesigns);
        if (pendingDesignTurnRef.current?.designId === designId) {
          pendingDesignTurnRef.current = undefined;
        }
        if (selectedDesignIdRef.current === designId) {
          selectedDesignIdRef.current = undefined;
          setSelectedDesignId(undefined);
          setDesignDetail(undefined);
          setDesignDraft(null);
          setDesignExternalLinkRequest((current) =>
            current?.designId === designId ? undefined : current
          );
          const nextDesign = remainingDesigns[0];
          if (nextDesign) {
            await loadDesign(nextDesign.id, { select: true, showLoading: true });
          } else {
            setDesignsLoading(false);
            setDesignsError(undefined);
          }
        }
        notify('Design deleted.', 'success');
        void refreshDesignList();
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : 'Could not delete the Design.';
        notify(message, 'error');
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [designs, loadDesign, notify, refreshDesignList]
  );
  const reportDesignCanvasError = useCallback(
    (caught: unknown, fallback: string) => {
      const message = caught instanceof Error ? caught.message : fallback;
      if (designCanvasErrorRef.current !== message) {
        designCanvasErrorRef.current = message;
        notify(message, 'error');
      }
      return message;
    },
    [notify]
  );
  const showDesignCanvas = useCallback(
    (input: ShowDesignCanvasRequest) => {
      const canvas = window.designCanvas;
      if (!canvas) return;
      void canvas
        .show(input)
        .then(() => {
          designCanvasErrorRef.current = undefined;
        })
        .catch(() => {
          reportDesignCanvasError(undefined, DESIGN_CANVAS_LOAD_FAILED_NOTICE);
        });
    },
    [reportDesignCanvasError]
  );
  const hideDesignCanvas = useCallback(
    (input: HideDesignCanvasRequest) => {
      const canvas = window.designCanvas;
      if (!canvas) return;
      void canvas
        .hide(input)
        .then(() => {
          designCanvasErrorRef.current = undefined;
        })
        .catch((caught) => {
          reportDesignCanvasError(caught, 'Could not hide the Design canvas.');
        });
    },
    [reportDesignCanvasError]
  );
  const refreshDesignCanvas = useCallback(
    async (input: RefreshDesignCanvasRequest) => {
      const canvas = window.designCanvas;
      if (!canvas) {
        const error = new Error('The Design canvas is available in the desktop app.');
        reportDesignCanvasError(error, error.message);
        throw error;
      }
      try {
        await canvas.refresh(input);
        designCanvasErrorRef.current = undefined;
      } catch (caught) {
        const message = reportDesignCanvasError(
          caught,
          'Could not refresh the Design canvas.'
        );
        throw caught instanceof Error ? caught : new Error(message);
      }
    },
    [reportDesignCanvasError]
  );
  const approveDesignExternalLink = useCallback(
    async (request: DesignCanvasExternalLinkRequest) => {
      const canvas = window.designCanvas;
      if (!canvas) {
        throw new Error('External Design links are available in the desktop app.');
      }
      return canvas.approveExternal({
        designId: request.designId,
        pendingId: request.pendingId
      });
    },
    []
  );
  const dismissDesignExternalLink = useCallback(
    (request: DesignCanvasExternalLinkRequest) => {
      setDesignExternalLinkRequest((current) =>
        current?.designId === request.designId &&
        current.pendingId === request.pendingId
          ? undefined
          : current
      );
    },
    []
  );
  const refreshSelectedDesign = useCallback(async () => {
    const designId = selectedDesignIdRef.current;
    if (!designId) return;
    await loadDesign(designId, { showLoading: false });
  }, [loadDesign]);
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
    const shell = window.taskManagerShell;
    if (!shell) return;
    let canceled = false;
    const unsubscribe = shell.onSoftwareUpdateState((state) => {
      if (!canceled) setSoftwareUpdateState(state);
    });
    void shell
      .getSoftwareUpdateState()
      .then((state) => {
        if (!canceled) setSoftwareUpdateState(state);
      })
      .catch((caught: unknown) => {
        if (!canceled) reportActionError(caught, 'Could not read the update status.');
      });
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [reportActionError]);

  useEffect(() => {
    let canceled = false;

    async function load() {
      try {
        const [catalog, settings, tools] = await Promise.all([
          taskManagerApi.getAgentRuntimeCatalog(),
          taskManagerApi.getAppSettings(),
          taskManagerApi.getExternalToolStatus(),
          refresh(),
          refreshDiscourseAttention(),
          refreshDesignList()
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
  }, [refresh, refreshDesignList, refreshDiscourseAttention]);

  useEffect(() => {
    const boardRefresh = createUpdateRefreshScheduler({
      delayMs: AUTHORITATIVE_REFRESH_DELAY_MS,
      refresh: taskDataCoordinator.refreshBoard,
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number)
    });
    const detailRefresh = createUpdateRefreshScheduler({
      delayMs: AUTHORITATIVE_REFRESH_DELAY_MS,
      refresh: taskDataCoordinator.refreshSelectedTask,
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number)
    });
    const selectedActivityRefresh = createUpdateRefreshScheduler({
      delayMs: SELECTED_ACTIVITY_REFRESH_DELAY_MS,
      refresh: taskDataCoordinator.refreshSelectedTask,
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
    const designListRefresh = createUpdateRefreshScheduler({
      delayMs: AUTHORITATIVE_REFRESH_DELAY_MS,
      refresh: async () => {
        await refreshDesignList();
      },
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number)
    });
    const designDetailRefresh = createUpdateRefreshScheduler({
      delayMs: AUTHORITATIVE_REFRESH_DELAY_MS,
      refresh: refreshSelectedDesign,
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number)
    });
    const designActivityRefresh = createUpdateRefreshScheduler({
      delayMs: SELECTED_ACTIVITY_REFRESH_DELAY_MS,
      refresh: refreshSelectedDesign,
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number)
    });
    const unsubscribe = taskManagerApi.onUpdate((event) => {
      if (event.scope.kind === 'DISCOURSE') {
        discourseAttentionRefresh.request();
        return;
      }
      const selectedDesignId = selectedDesignIdRef.current;
      const canvasEvent = designCanvasClientEvent(event);
      if (
        canvasEvent?.kind === 'EXTERNAL_LINK_REQUESTED' &&
        window.designCanvas &&
        viewRef.current === 'designs' &&
        canvasEvent.request.designId === selectedDesignId
      ) {
        setDesignExternalLinkRequest((current) =>
          current?.designId === canvasEvent.request.designId &&
          current.pendingId === canvasEvent.request.pendingId
            ? current
            : canvasEvent.request
        );
      } else if (canvasEvent?.kind === 'LOAD_FAILED') {
        reportDesignCanvasError(undefined, DESIGN_CANVAS_LOAD_FAILED_NOTICE);
      }
      if (event.scope.kind === 'APP' && event.type === 'projection.updated') {
        designListRefresh.request();
        if (selectedDesignId) {
          designDetailRefresh.request();
        }
      }
      const designEventId =
        event.scope.kind === 'DESIGN'
          ? event.scope.designId
          : event.scope.kind === 'TASK' && event.taskId === selectedDesignId
            ? event.taskId
            : undefined;
      if (designEventId) {
        if (event.type === 'run.output' || event.type === 'preview.log.updated') {
          return;
        }
        if (event.type === 'run.activity') {
          designActivityRefresh.request();
          return;
        }
        designListRefresh.request();
        if (designEventId === selectedDesignId && event.type !== 'task.deleted') {
          designActivityRefresh.cancelPending();
          designDetailRefresh.request();
        }
        return;
      }
      if (event.type === 'task.deleted') {
        designListRefresh.request();
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
      const refreshPlan = taskDataRefreshPlan(event, {
        open: Boolean(taskDataCoordinator.selectedTaskId()),
        taskId: taskDataCoordinator.selectedTaskId()
      });
      if (refreshPlan.board) {
        boardRefresh.request();
      }
      if (refreshPlan.detail === 'SELECTED_ACTIVITY') {
        selectedActivityRefresh.request();
        return;
      }
      if (refreshPlan.detail === 'IMMEDIATE') {
        selectedActivityRefresh.cancelPending();
        detailRefresh.request();
      }
    });
    return () => {
      unsubscribe();
      boardRefresh.dispose();
      detailRefresh.dispose();
      selectedActivityRefresh.dispose();
      runtimeCatalogRefresh.dispose();
      discourseAttentionRefresh.dispose();
      designListRefresh.dispose();
      designDetailRefresh.dispose();
      designActivityRefresh.dispose();
    };
  }, [
    refreshDesignList,
    refreshDiscourseAttention,
    refreshSelectedDesign,
    reportDesignCanvasError,
    taskDataCoordinator
  ]);

  const theme = appSettings.theme;
  const themePreset = resolveThemePreset(appSettings.themePreset);
  const activeThemePreset = previewThemePreset ?? themePreset;
  useLayoutEffect(() => {
    applyThemeToRoot(document.documentElement, activeThemePreset, theme);
  }, [activeThemePreset, theme]);
  const isSidebarCollapsed = appSettings.sidebarCollapsed;
  const panelToggleLabel = `${isSidebarCollapsed ? 'Expand' : 'Collapse'} navigation sidebar`;
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
  const selectedTask =
    taskDetail && taskDetail.task.id === selectedTaskId
      ? taskDetail.task
      : undefined;
  const deleteCandidate =
    deleteCandidateDetail &&
    deleteCandidateDetail.task.id === deleteCandidateId
      ? deleteCandidateDetail.task
      : undefined;

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
    setTaskDetail(undefined);
    taskDataCoordinator.closeTask();
  }, [isLoading, selectedTaskId, snapshot.tasks, taskDataCoordinator]);
  const selectedRuns = useMemo(
    () =>
      selectedTask && taskDetail
        ? selectTaskRuns(taskDetail, selectedTask.id)
        : [],
    [selectedTask, taskDetail]
  );
  const selectedRun = selectedTask ? selectActiveRun(selectedTask, selectedRuns) : undefined;
  const selectedEvents = useMemo(
    () =>
      selectedTask && taskDetail
        ? selectTaskEvents(taskDetail, selectedTask.id)
        : [],
    [selectedTask, taskDetail]
  );
  const selectedInteractions = selectedTask ? taskDetail?.interactionRequests ?? [] : [];
  const selectedSessions = selectedTask ? taskDetail?.agentSessions ?? [] : [];
  const selectedItems = selectedTask ? taskDetail?.agentItems ?? [] : [];
  const selectedGoals = selectedTask ? taskDetail?.agentGoalSnapshots ?? [] : [];
  const selectedPlans = selectedTask ? taskDetail?.agentPlanRevisions ?? [] : [];
  const selectedUsage = selectedTask ? taskDetail?.agentUsageSnapshots ?? [] : [];
  const selectedSettings = selectedTask
    ? taskDetail?.agentSettingsObservations ?? []
    : [];
  const selectedSubagentObservations = selectedTask
    ? taskDetail?.agentSubagentObservations ?? []
    : [];
  const selectedPreviewPlans = selectedTask ? taskDetail?.previewPlans ?? [] : [];
  const selectedPreviewApprovals = selectedTask ? taskDetail?.previewApprovals ?? [] : [];
  const selectedPreviewGenerations = selectedTask
    ? taskDetail?.previewGenerations ?? []
    : [];
  const selectedPreviewGenerationAttachments = selectedTask
    ? taskDetail?.previewGenerationAttachments ?? []
    : [];
  const selectedPreviewManagedResources = selectedTask
    ? taskDetail?.previewManagedResources ?? []
    : [];
  const selectedPreviewComposeProjects = selectedTask
    ? taskDetail?.previewComposeProjects ?? []
    : [];
  const selectedPreviewLocalBindings = selectedTask
    ? taskDetail?.previewLocalBindings ?? []
    : [];
  const selectedPreviewRuntimeResources = selectedTask
    ? taskDetail?.previewResources ?? []
    : [];
  const selectedPreviewNodeAttempts = selectedTask
    ? taskDetail?.previewNodeAttempts ?? []
    : [];
  const selectedPreviewTaskRoutes = selectedTask
    ? taskDetail?.previewTaskRoutes ?? []
    : [];
  const selectedGitSnapshots = selectedTask ? taskDetail?.gitSnapshots ?? [] : [];
  const selectedTaskAttachments = useMemo(
    () =>
      selectedTask && taskDetail
        ? [...taskDetail.attachments].sort((left, right) => left.ordinal - right.ordinal)
        : [],
    [selectedTask, taskDetail]
  );
  const selectedWorktree = selectedTask && taskDetail
    ? selectCurrentWorktree(taskDetail, selectedTask)
    : undefined;
  const selectedGitSnapshot = selectedTask && taskDetail
    ? selectLatestGitSnapshot(taskDetail, selectedTask)
    : undefined;
  const selectedGitHubRepository = selectedTask && taskDetail
    ? selectLatestGitHubRepository(taskDetail, selectedTask)
    : undefined;
  const selectedBranchPublication = selectedTask && taskDetail
    ? selectLatestBranchPublication(taskDetail, selectedTask)
    : undefined;
  const selectedPullRequest = selectedTask && taskDetail
    ? selectLatestPullRequest(taskDetail, selectedTask)
    : undefined;
  const selectedCiRollup = selectedTask && taskDetail
    ? selectLatestCiRollup(taskDetail, selectedTask)
    : undefined;
  const selectedReviewRollup = selectedTask && taskDetail
    ? selectLatestReviewRollup(taskDetail, selectedTask)
    : undefined;
  const selectedMergeSnapshot = selectedTask && taskDetail
    ? selectLatestMergeSnapshot(taskDetail, selectedTask)
    : undefined;
  const deleteCandidateWorktree = deleteCandidate && deleteCandidateDetail
    ? selectCurrentWorktree(deleteCandidateDetail, deleteCandidate)
    : undefined;
  const deleteCandidateGitSnapshot = deleteCandidate && deleteCandidateDetail
    ? selectLatestGitSnapshot(deleteCandidateDetail, deleteCandidate)
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
  const designRuntimeCatalog = useMemo(
    () =>
      runtimeCatalog
        ? eligibleDesignRuntimeCatalog({
            ...runtimeCatalog,
            runtimes: enabledRuntimes,
            models: enabledRuntimeModels
          })
        : undefined,
    [enabledRuntimeModels, enabledRuntimes, runtimeCatalog]
  );
  const defaultDesignSettings = useMemo(
    () =>
      designRuntimeCatalog
        ? resolveModelExecutionSettings(
            qualifiedDesignModels(
              designRuntimeCatalog.runtimes,
              designRuntimeCatalog.models
            ),
            appSettings.defaultModel,
            appSettings.defaultReasoningEffort,
            designRuntimeCatalog.defaultRuntimeId,
            appSettings.defaultModelProvider
          )
        : undefined,
    [
      appSettings.defaultModel,
      appSettings.defaultModelProvider,
      appSettings.defaultReasoningEffort,
      designRuntimeCatalog
    ]
  );
  const configuredPromptRefinementRuntimeId =
    appSettings.promptRefinementRuntimeId ?? appSettings.defaultRuntimeId;
  const promptRefinementSelection = selectConfiguredRuntimeForOperation(
    enabledRuntimes,
    configuredPromptRefinementRuntimeId,
    'PROMPT_REFINEMENT'
  );
  const promptRefinementRuntime = promptRefinementSelection.runtime;
  const configuredPreviewRecipeGenerationRuntimeId =
    appSettings.previewRecipeGenerationRuntimeId ?? appSettings.defaultRuntimeId;
  const previewRecipeGenerationSelection = selectConfiguredRuntimeForOperation(
    enabledRuntimes,
    configuredPreviewRecipeGenerationRuntimeId,
    'PREVIEW_RECIPE_GENERATION'
  );
  const configuredReviewRuntimeId =
    appSettings.reviewRuntimeId ?? selectedTask?.runtimeId;
  const reviewSelection = selectConfiguredRuntimeForOperation(
    enabledRuntimes,
    configuredReviewRuntimeId,
    'REVIEW'
  );
  const reviewRuntime = reviewSelection.runtime;
  const refineDisabledReason = promptRefinementSelection.unavailableReason;
  const reviewDisabledReason = selectedTask && !reviewRuntime
    ? reviewSelection.unavailableReason
    : undefined;
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

  const openTaskDetail = useCallback(
    (taskId: string, trigger?: HTMLElement) => {
      if (trigger) {
        taskNavigationReturnFocusRef.current = trigger;
      }
      taskNavigationReturnIdRef.current = taskId;
      setSelectedTaskId(taskId);
      setLastTaskId(taskId);
      setTaskDetail(undefined);
      setError(undefined);
      setIsDetailOpen(true);
      return taskDataCoordinator.openTask(taskId);
    },
    [taskDataCoordinator]
  );

  const closeTaskDetail = useCallback(() => {
    taskDataCoordinator.closeTask();
    setIsDetailOpen(false);
    setTaskDetail(undefined);
  }, [taskDataCoordinator]);

  const createTask = async (input: CreateTaskRequest) => {
    try {
      const created = await taskManagerApi.createTask(input);
      taskNavigationReturnFocusRef.current = newTaskButtonRef.current;
      setNewTaskTextDraft({ title: '', prompt: '' });
      notify('Task created.', 'success');
      await taskDataCoordinator.refreshBoard();
      await openTaskDetail(created.id);
    } catch (caught) {
      reportActionError(caught, 'Could not create task.');
      throw caught;
    }
  };

  const refinePrompt = async (input: RefinePromptRequest) => {
    try {
      const refinementModel = selectModel(
        enabledRuntimeModels,
        appSettings.promptRefinementModel,
        promptRefinementRuntime?.preflight.runtime.id,
        appSettings.promptRefinementModelProvider
      );
      const refined = await taskManagerApi.refinePrompt({
        ...input,
        runtimeId:
          refinementModel?.runtimeId ??
          promptRefinementRuntime?.preflight.runtime.id,
        model: refinementModel?.model,
        modelProvider:
          refinementModel?.modelProvider ?? appSettings.promptRefinementModelProvider
      });
      notify(
        refined.warning ??
          (refined.source === 'model'
            ? 'Prompt refined.'
            : 'The original prompt was kept unchanged.'),
        refined.source === 'model' && !refined.warning ? 'success' : 'info'
      );
      return refined;
    } catch (caught) {
      reportActionError(caught, 'Could not refine prompt.');
      throw caught;
    }
  };

  const cancelPromptRefinement = async (requestId: string) => {
    const refinementModel = selectModel(
      enabledRuntimeModels,
      appSettings.promptRefinementModel,
      promptRefinementRuntime?.preflight.runtime.id,
      appSettings.promptRefinementModelProvider
    );
    await taskManagerApi.cancelPromptRefinement({
      requestId,
      runtimeId:
        refinementModel?.runtimeId ?? promptRefinementRuntime?.preflight.runtime.id
    });
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
      const state = await taskManagerApi.generatePreviewRecipe({ taskId });
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

  const readArtifact = async (artifactId: string) => {
    try {
      return await taskManagerApi.readArtifact({ artifactId });
    } catch (caught) {
      reportActionError(caught, 'Could not read the retained artifact.');
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

  const requestDeleteTask = async (taskId: string) => {
    const generation = ++deleteCandidateGenerationRef.current;
    setDeleteCandidateId(taskId);
    setDeleteCandidateDetail(undefined);
    try {
      const detail = await taskManagerApi.getTaskDetail(taskId);
      if (generation === deleteCandidateGenerationRef.current) {
        setDeleteCandidateDetail(detail);
      }
    } catch (caught) {
      if (generation !== deleteCandidateGenerationRef.current) return;
      setDeleteCandidateId(undefined);
      reportActionError(caught, 'Could not load deletion evidence.');
    }
  };

  const deleteTask = async (
    taskId: string,
    removeWorktree: boolean
  ): Promise<DeleteTaskResult> => {
    setError(undefined);
    try {
      const deleted = await taskManagerApi.deleteTask({ taskId, removeWorktree });
      setDeleteCandidateId(undefined);
      setDeleteCandidateDetail(undefined);
      if (selectedTaskId === taskId) {
        setSelectedTaskId(undefined);
        closeTaskDetail();
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
      const run = selectedRuns.find((candidate) => candidate.id === runId);
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
      const run = selectedRuns.find((candidate) => candidate.id === runId);
      if (!run) {
        throw new Error('Run not found.');
      }
      const recoveryContinuation =
        run.status !== 'COMPLETED' ||
        Boolean(selectedTask && getImplementationRetryReason(selectedTask));
      await taskManagerApi.continueRun({ taskId: run.taskId, runId, instruction });
      notify(
        recoveryContinuation ? 'Continuing unfinished work.' : 'Follow-up run started.',
        'success'
      );
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
      const run = selectedRuns.find((candidate) => candidate.id === runId);
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
        await taskDataCoordinator.refreshBoard();
        await openTaskDetail(retry.taskId);
      } else {
        await refresh();
      }
      notify(
        strategy === 'FORK' ? 'Alternative task started.' : 'Implementation retry started.',
        'success'
      );
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
      const run = selectedRuns.find((candidate) => candidate.id === runId);
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
      closeTaskDetail();
      setError(undefined);
      const repository = snapshot.repositories.find((candidate) => candidate.id === repositoryId);
      notify(`New tasks will use ${repository?.name ?? 'this repository'}.`, 'success');
    },
    [
      activeRepositoryId,
      closeTaskDetail,
      notify,
      snapshot.repositories,
      updateAppSettings
    ]
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
      closeTaskDetail();
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
  }, [closeTaskDetail, notify, refresh, reportActionError, updateAppSettings]);

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
        closeTaskDetail();
        notify(`${board.name} saved.`, 'success');
      } catch (caught) {
        reportActionError(caught, 'Could not save board.');
        throw caught;
      }
    },
    [boardEditor, closeTaskDetail, notify, refresh, reportActionError]
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
      closeTaskDetail();
      setIsNewTaskOpen(false);
      setError(undefined);
      notify('Setup complete.', 'success');
    } catch (caught) {
      reportActionError(caught, 'Could not finish setup.');
      throw caught;
    }
  }, [
    activeRepositoryId,
    appSettings.defaultRuntimeId,
    closeTaskDetail,
    notify,
    reportActionError
  ]);

  const selectTask = (taskId: string, trigger?: HTMLElement) => {
    taskNavigationReturnFocusRef.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    void openTaskDetail(taskId, trigger);
  };

  // Back: from an open task to the view it was opened from.
  const goBack = () => {
    closeTaskDetail();
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
      void openTaskDetail(lastTaskId);
    }
  };

  const showView = (next: AppView) => {
    setView(next);
    if (next !== 'settings') setPreviewThemePreset(null);
    setSelectedBoardId(undefined);
    closeTaskDetail();
    if (next !== 'designs') {
      setDesignExternalLinkRequest(undefined);
    }
    if (next === 'designs') {
      void openDesignWorkspace();
    }
  };

  const showBoard = (boardId: string) => {
    setSelectedBoardId(boardId);
    setView('board');
    closeTaskDetail();
  };

  const canGoBack = isDetailOpen;
  const canGoForward = !isDetailOpen && Boolean(lastTaskId);

  const navCounts = computeNavCounts(snapshot.tasks);

  const showDetail = isDetailOpen && Boolean(selectedTaskCandidate);

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
  const appOwnedModalOpen = Boolean(
    deleteCandidate ||
      repositoryDisconnect ||
      boardEditor ||
      designExternalLinkRequest
  );
  const appBackgroundModalOpen = appOwnedModalOpen || isTaskDetailModalOpen;

  return (
    <div
      ref={appRootRef}
      className="tm-app app-shell"
      tabIndex={-1}
      data-input-modality={inputModality}
      data-window-platform={windowChromePlatform}
      onKeyDownCapture={(event) => {
        if (event.key === 'Tab') setInputModality('keyboard');
      }}
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
                aria-label={panelToggleLabel}
                title={panelToggleLabel}
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
                <PlusIcon />
                <span>New task</span>
              </button>
            </header>

            <div ref={canvasContentRef} className="tm-canvas__content">
            <aside
              id="app-navigation-sidebar"
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
                overlapCount
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
                label="Designs"
                icon={<DesignIcon />}
                active={!showDetail && view === 'designs'}
                collapsed={isSidebarCollapsed}
                onClick={() => showView('designs')}
              />
              <NavItem
                label="Discourse"
                icon={<DiscourseIcon />}
                count={discourseAttentionCount}
                countNoun="conversation"
                pillCount
                active={!showDetail && view === 'discourse'}
                collapsed={isSidebarCollapsed}
                onClick={() => showView('discourse')}
              />
            </div>
            <div className="tm-nav__divider" />
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
                  <PlusIcon />
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
            <div className="tm-nav__divider" />
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
                urgent={navCounts.review > 0}
                pillCount
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
          <SoftwareUpdateNotice
            state={softwareUpdateState}
            collapsed={isSidebarCollapsed}
            onDownload={() => void downloadSoftwareUpdate()}
            onInstall={() => void installSoftwareUpdate()}
          />
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

        {!isSidebarCollapsed ? (
          <PanelResizeHandle
            className="tm-nav__resize"
            label="Resize navigation sidebar"
            value={appSidebarWidth}
            min={176}
            max={240}
            defaultValue={176}
            controls="app-navigation-sidebar"
            onChange={(width) => {
              setAppSidebarWidth(width);
              persistFocusedPanelWidth('app-navigation', width);
            }}
          />
        ) : null}

        {showDetail && selectedTask && taskDetail ? (
          <TaskDetail
            headingRef={taskDetailHeadingRef}
            error={error}
            task={selectedTask}
            repository={taskDetail.repository}
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
            reviewDisabledReason={reviewDisabledReason}
            previewRecipeGenerationDisabledReason={
              previewRecipeGenerationSelection.unavailableReason
            }
            server={taskDetail.agentServers.find(
              (candidate) => candidate.id === selectedRun?.serverInstanceId
            )}
            artifacts={taskDetail.artifacts}
            textExcerpts={taskDetail.textExcerpts}
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
            onReadArtifact={readArtifact}
            onTransition={transitionTask}
            onArchive={archiveTask}
            onRequestDelete={requestDeleteTask}
            onModalOpenChange={setIsTaskDetailModalOpen}
          />
        ) : showDetail ? (
          <main className="tm-main" aria-live="polite">
            <div className="tm-main__head">
              <div>
                <h1 className="tm-main__title">
                  {selectedTaskCandidate?.title ?? 'Task'}
                </h1>
                <span className="tm-main__subtitle">
                  {error
                    ? 'Task detail could not be loaded.'
                    : 'Loading current task detail…'}
                </span>
              </div>
            </div>
            {error ? <div className="tm-error">{error}</div> : null}
          </main>
        ) : view === 'designs' ? (
          <DesignsWorkspace
            historyCollapsed={designHistoryCollapsed}
            onHistoryCollapsedChange={(collapsed) => {
              setDesignHistoryCollapsed(collapsed);
              persistFocusedWorkspaceHistoryCollapsed('designs', collapsed);
            }}
            designs={designs}
            selectedDesignId={selectedDesignId}
            project={
              designDetail?.design.id === selectedDesignId
                ? designDetail
                : undefined
            }
            draft={designDraft}
            models={designRuntimeCatalog?.models ?? []}
            runtimes={designRuntimeCatalog?.runtimes ?? []}
            defaultAgentSettings={defaultDesignSettings}
            loading={designsLoading}
            error={designsError}
            desktopCanvasAvailable={Boolean(window.designCanvas)}
            canvasOccluded={appBackgroundModalOpen || isNewTaskOpen}
            onSelectDesign={(designId) => {
              void loadDesign(designId, { select: true, showLoading: true });
            }}
            onCreateBlankDesign={createBlankDesign}
            onSubmitRefinement={submitDesignRefinement}
            onStageAttachmentBatch={taskManagerApi.stageTaskAttachmentBatch}
            onDiscardAttachmentDraft={taskManagerApi.discardTaskAttachmentDraft}
            onReadClipboardImage={taskManagerApi.readClipboardImage}
            onReadDesignDraftAttachment={(designId, attachmentId) =>
              taskManagerApi.readDesignDraftAttachment({ designId, attachmentId })
            }
            onAddReferences={addDesignReferences}
            onRemoveReference={removeDesignReference}
            onImportReferenceAsset={importDesignReferenceAsset}
            onStopTurn={stopDesignTurn}
            onLoadEarlier={loadEarlierDesignConversation}
            onSaveDraft={saveDesignDraft}
            onDeleteDraft={deleteDesignDraft}
            onDiscoverAgentRuntimeModels={discoverAgentRuntimeModels}
            onRespondToInteraction={respondToDesignInteraction}
            onRefreshCanvas={refreshDesignCanvas}
            onRestartCanvas={restartDesignCanvas}
            onSelectRevision={showDesignRevision}
            onOpenCanvas={openPreview}
            onOpenDesignLocation={openDesignLocation}
            onRestoreRevision={restoreDesignRevision}
            onDuplicateDesign={duplicateDesign}
            onRenameDesign={renameDesign}
            onArchiveDesign={archiveDesign}
            onDeleteDesign={deleteDesign}
            onShowCanvas={window.designCanvas ? showDesignCanvas : undefined}
            onHideCanvas={window.designCanvas ? hideDesignCanvas : undefined}
            onRetryLoad={() => {
              const designId = selectedDesignIdRef.current;
              if (designId) {
                void loadDesign(designId, { showLoading: true });
              } else {
                void openDesignWorkspace();
              }
            }}
          />
        ) : view === 'discourse' ? (
          <DiscourseWorkspace
            historyCollapsed={discourseHistoryCollapsed}
            onHistoryCollapsedChange={(collapsed) => {
              setDiscourseHistoryCollapsed(collapsed);
              persistFocusedWorkspaceHistoryCollapsed('discourse', collapsed);
            }}
            onNotify={notify}
            onError={reportActionError}
          />
        ) : (
          <MainColumn
            view={view}
            board={selectedBoard}
            tasks={visibleTasks}
            repositories={snapshot.repositories}
            interactionRequests={snapshot.interactionRequests}
            theme={theme}
            onSetTheme={updateTheme}
            onPreviewThemePreset={setPreviewThemePreset}
            appSettings={appSettings}
            onSetAppSettings={updateAppSettings}
            softwareUpdateState={softwareUpdateState}
            onCheckForSoftwareUpdates={checkForSoftwareUpdates}
            onDownloadSoftwareUpdate={downloadSoftwareUpdate}
            onInstallSoftwareUpdate={installSoftwareUpdate}
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
              onCancelPromptRefinement={cancelPromptRefinement}
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
          onCancel={() => {
            deleteCandidateGenerationRef.current += 1;
            setDeleteCandidateId(undefined);
            setDeleteCandidateDetail(undefined);
          }}
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

      {designExternalLinkRequest ? (
        <DesignExternalLinkModal
          key={designExternalLinkRequest.pendingId}
          destinationHost={designExternalLinkRequest.destinationHost}
          onCancel={() => dismissDesignExternalLink(designExternalLinkRequest)}
          onConfirm={() => approveDesignExternalLink(designExternalLinkRequest)}
          fallbackReturnFocusRef={appRootRef}
        />
      ) : null}

      <GlobalNotifier notifications={notifications} />
    </div>
  );
}
