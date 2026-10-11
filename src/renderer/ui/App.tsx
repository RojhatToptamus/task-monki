import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  EMPTY_REVIEW_DRAFT,
  TASK_STORE_SCHEMA_VERSION,
  getImplementationRetryReason,
  type CreateTaskRequest,
  type DecideReviewFindingRequest,
  type ImportTaskRequest,
  type CreateBoardRequest,
  type Board,
  type BoardSnapshot,
  type AgentExecutionSettings,
  type RunRecord,
  type AgentInteractionDecision,
  type AgentRuntimeCatalog,
  type AgentRetryStrategy,
  type CreateDesignRequest,
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
  type RefinePromptRequest,
  type TaskDetailSnapshot,
  type TaskManagerAppSettings,
  type SideQuestionModelChoice,
  type ReviewRequestRecord,
  type TaskReviewDraft,
  type UpdateAgentNativeSessionRequest,
  type UpdateAppSettingsRequest,
  type WorktreePreparationInspection,
  type WorkflowPhase
} from '../../shared/contracts';
import type {
  HideDesignCanvasRequest,
  RefreshDesignCanvasRequest,
  ShowDesignCanvasRequest
} from '../../shared/designCanvas';
import type { SoftwareUpdateState } from '../../shared/softwareUpdate';
import { taskManagerApi } from '../api/taskManagerClient';
import { partitionAgentRecords, type AgentConversationRecords } from '../model/agentRecords';
import { listDiscourseConversationSnapshot } from '../api/discoursePaging';
import {
  selectActiveRun,
  selectCurrentWorktree,
  selectLatestGitSnapshot,
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
  supportedDesignModels,
  type DesignCanvasExternalLinkRequest
} from '../model/designs';
import {
  buildRepositoryOptions,
  resolveRepositorySetupState,
  resolveSelectedRepositoryId
} from '../model/repositories';
import { appendUniqueNotification } from '../model/notifications';
import { selectConfiguredRuntimeForOperation } from '../model/runtimeReadiness';
import {
  focusedWorkspaceHistoryCollapsed,
  focusedWorkspaceUsesCompactHistory,
  persistFocusedWorkspaceHistoryCollapsed
} from '../model/workspaceLayout';
import { creationRequiresUnchangedRetry } from '../model/taskAttachmentComposer';
import { MainColumn } from './MainColumn';
import {
  applyThemeToRoot,
  resolveThemePreset,
  type ThemePreference,
  type ThemePreset
} from './theme';
import { computeNavCounts, isTasksView, type NavView, type TasksView } from '../model/taskView';
import { NewTaskPanel, type NewTaskTextDraft } from './NewTaskPanel';
import { useExternalCheckoutObservation } from './useExternalCheckoutObservation';
import { TaskDetail } from './TaskDetail';
import { useTaskDraftStore } from './useTaskDraftStore';
import { DiscourseWorkspace } from './DiscourseWorkspace';
import { DesignsWorkspace } from './DesignsWorkspace';
import type { PreviewAgentConversation, PreviewProposalActions } from './preview/PreviewAgentProps';
import { PreviewsPage, type PreviewsPageState } from './PreviewsPage';
import { taskNavigationReturnTarget } from './taskNavigationFocus';
import { SoftwareUpdateNotice } from './SoftwareUpdateNotice';
import {
  BoardEditorModal,
  DeleteTaskModal,
  DesignExternalLinkModal,
  GlobalNotifier,
  PrepareWorktreeModal,
  RecoverWorktreeModal,
  RepositoryDisconnectModal,
  type AppNotification,
  type NotificationTone
} from './AppOverlays';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BoardIcon,
  DesignIcon,
  DiscourseIcon,
  InboxIcon,
  PlusIcon,
  PreviewIcon,
  RailItem,
  SettingsIcon
} from './AppNavigation';
import { Tooltip, TooltipProvider } from './Tooltip';
import { NotifyProvider } from './NotifyContext';

const AUTHORITATIVE_REFRESH_DELAY_MS = 50;
const SELECTED_ACTIVITY_REFRESH_DELAY_MS = 1_000;
const DESIGN_CANVAS_LOAD_FAILED_NOTICE =
  'The Design preview could not load. Reload the preview to retry.';
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

const EMPTY_RUNS: RunRecord[] = [];
const EMPTY_PREVIEW_AGENT_RECORDS: AgentConversationRecords = { runs: [], items: [], instructions: [], interactions: [], sessions: [], plans: [] };

function isPreviewRecipeGenerationSnapshot(
  value: unknown
): value is PreviewRecipeGenerationSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { taskId?: unknown; status?: unknown };
  return (
    typeof candidate.taskId === 'string' &&
    ['EMPTY', 'READY'].includes(
      String(candidate.status)
    )
  );
}

const REVIEW_STARTED_NOTICE = 'Review started';

// Stable writers, so each draft store keeps one in-flight save per task.
const saveAgentDraftText = (taskId: string, text: string) => taskManagerApi.saveTaskAgentDraft({ taskId, text });
const saveReviewDraft = (taskId: string, draft: TaskReviewDraft) => taskManagerApi.saveTaskReviewDraft({ taskId, draft });

type AppView = NavView | 'discourse' | 'designs' | 'previews';

function resolveWindowChromePlatform() {
  return window.taskManagerShell?.windowChromePlatform ?? 'other';
}

export function App() {
  const [inputModality, setInputModality] = useState<'keyboard' | 'pointer'>('pointer');
  // Keyboard modality is a property of the whole document: menus and popovers
  // portal outside the shell, and the first Tab after launch targets <body>.
  // Focus that moves because of a key is keyboard traversal — Tab, arrows in a
  // tab list, list or menu, Escape back to a trigger — while typing that moves
  // no focus leaves the modality alone.
  useEffect(() => {
    let keyed = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      keyed = true;
      if (event.key === 'Tab') setInputModality('keyboard');
    };
    const onFocusIn = () => {
      if (keyed) setInputModality('keyboard');
    };
    const onPointerDown = () => {
      keyed = false;
      setInputModality('pointer');
    };
    // In a menu or list the highlight follows the pointer once it moves there.
    const onPointerMove = (event: PointerEvent) => {
      if (!event.movementX && !event.movementY) return;
      if ((event.target as Element | null)?.closest?.('[role="menu"], [role="listbox"]')) {
        keyed = false;
        setInputModality('pointer');
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.inputModality = inputModality;
  }, [inputModality]);
  const [snapshot, setSnapshot] = useState<BoardSnapshot>(emptyBoardSnapshot);
  const [taskDetail, setTaskDetail] = useState<TaskDetailSnapshot>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [isAddingRepository, setIsAddingRepository] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<AppView>('board');
  const [previewsPageState, setPreviewsPageState] = useState<PreviewsPageState>({ query: '', filter: 'all' });
  const previewsScrollPosition = useRef(0);
  const [previewDetailTab, setPreviewDetailTab] = useState<'preview' | 'overview'>('preview');
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
  // The open task's title while its page shows only the tab bar.
  const [compactTitle, setCompactTitle] = useState<{ title?: string; animate: boolean }>({ animate: false });
  const compactTaskTitle = compactTitle.title;
  const onCompactTitleChange = useCallback((title: string | undefined, animate: boolean) => setCompactTitle({ title, animate }), []);
  const [designsError, setDesignsError] = useState<string | undefined>();
  const [designExternalLinkRequest, setDesignExternalLinkRequest] =
    useState<DesignCanvasExternalLinkRequest>();
  const [selectedBoardId, setSelectedBoardId] = useState<string | undefined>();
  const [boardEditor, setBoardEditor] = useState<Board | 'new' | undefined>();
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isTaskDetailModalOpen, setIsTaskDetailModalOpen] = useState(false);
  const pendingAppActions = useRef(0);
  const agentDrafts = useTaskDraftStore(saveAgentDraftText);
  const reviewDrafts = useTaskDraftStore(saveReviewDraft);

  const withAppAction = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    pendingAppActions.current += 1;
    try { return await action(); }
    finally { pendingAppActions.current -= 1; }
  }, []);
  const [lastTaskId, setLastTaskId] = useState<string | undefined>();
  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
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
  const [worktreePreparation, setWorktreePreparation] = useState<{
    inspection: WorktreePreparationInspection;
    returnFocus: HTMLElement | null;
    selectedBaseRef?: string;
    busy: boolean;
    error?: string;
  }>();
  const [worktreePreparationActionTaskId, setWorktreePreparationActionTaskId] =
    useState<string>();
  const [appSettings, setAppSettings] = useState<TaskManagerAppSettings>(
    DEFAULT_TASK_MANAGER_APP_SETTINGS
  );
  const [softwareUpdateState, setSoftwareUpdateState] = useState<SoftwareUpdateState>(
    unavailableSoftwareUpdateState
  );
  const [previewThemePreset, setPreviewThemePreset] = useState<ThemePreset | null>(null);
  const [externalToolStatus, setExternalToolStatus] = useState<ExternalToolStatusReport>();
  const [runtimeCatalog, setRuntimeCatalog] = useState<AgentRuntimeCatalog>();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const newTaskButtonRef = useRef<HTMLButtonElement>(null);
  const appRootRef = useRef<HTMLDivElement>(null);
  const focusedHistoryCompactRef = useRef(
    focusedWorkspaceUsesCompactHistory(window.innerWidth)
  );
  const taskDetailHeadingRef = useRef<HTMLHeadingElement>(null);
  const taskNavigationReturnFocusRef = useRef<HTMLElement | null>(null);
  const taskNavigationReturnIdRef = useRef<string | undefined>(undefined);
  const lastTasksViewRef = useRef<{ view: TasksView; boardId?: string }>({ view: 'board' });
  const deleteCandidateGenerationRef = useRef(0);
  const worktreePreparationSubmissionRef = useRef(false);
  const worktreePreparationGenerationRef = useRef(0);
  const worktreePreparationActionRef = useRef<
    { taskId: string; generation: number } | undefined
  >(undefined);
  const selectedDesignIdRef = useRef<string | undefined>(undefined);
  const designListReadGenerationRef = useRef(0);
  const designReadGenerationRef = useRef(0);
  const designDraftReadRef = useRef<{
    designId: string;
    promise: Promise<DesignDraftRecord | null>;
  } | undefined>(undefined);
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
  const [previewRecipeGenerations, setPreviewRecipeGenerations] = useState<
    Record<string, PreviewRecipeGenerationSnapshot>
  >({});
  const windowChromePlatform = resolveWindowChromePlatform();

  // New Task is a modal over the app; opening it again while open is a no-op.
  const openNewTask = useCallback(() => {
    setIsNewTaskOpen(true);
  }, []);

  const closeNewTask = useCallback(() => {
    setIsNewTaskOpen(false);
  }, []);
  const notify = useCallback((message: string, tone: NotificationTone = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // A copy already fading out does not swallow the same notice raised again.
    setNotifications((current) => appendUniqueNotification(
      current.filter((notification) => !notification.leaving || notification.tone !== tone || notification.message !== message),
      { id, tone, message }
    ));
    window.setTimeout(() => {
      // The toast fades out over --motion-fast before it leaves the stack.
      setNotifications((current) => current.map((notification) =>
        notification.id === id ? { ...notification, leaving: true } : notification));
      window.setTimeout(() => {
        setNotifications((current) => current.filter((notification) => notification.id !== id));
      }, 120);
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
        // The board lists tasks only; the selected Design keeps its proposal under review.
        const designId = selectedDesignIdRef.current;
        setPreviewRecipeGenerations((current) =>
          retainTaskEntries(current, designId ? [...next.tasks, { id: designId }] : next.tasks)
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
    // A setting applies on change and shows its own effect; only a failure is announced.
    async (patch: UpdateAppSettingsRequest) => {
      try {
        const nextSettings = await taskManagerApi.updateAppSettings(patch);
        setAppSettings(nextSettings);
        if (patch.externalExecutables || patch.codexExternalTools) {
          setExternalToolStatus(await taskManagerApi.getExternalToolStatus());
        }
        return nextSettings;
      } catch (caught) {
        reportActionError(caught, 'Failed to update settings.');
        return undefined;
      }
    },
    [reportActionError]
  );
  const updateTheme = useCallback(
    (nextTheme: ThemePreference) => {
      void updateAppSettings({ theme: nextTheme });
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
      if (select || showLoading) {
        designDraftReadRef.current = {
          designId,
          promise: taskManagerApi.getDesignDraft(designId)
        };
      }
      // Background detail updates must finish the selection's draft read before
      // mounting the composer with its saved text, attachments, and revision.
      const draftRead = designDraftReadRef.current?.designId === designId
        ? designDraftReadRef.current
        : undefined;
      if (showLoading) {
        setDesignsLoading(true);
        setDesignsError(undefined);
      }
      try {
        const [detail, draft] = await Promise.all([
          taskManagerApi.getDesign(designId),
          draftRead?.promise
        ]);
        if (
          generation !== designReadGenerationRef.current ||
          selectedDesignIdRef.current !== designId
        ) {
          return;
        }
        setDesignDetail((current) => mergeDesignDetailHistory(current, detail));
        if (draft !== undefined) {
          setDesignDraft(draft);
          if (designDraftReadRef.current === draftRead) {
            designDraftReadRef.current = undefined;
          }
        }
        upsertDesignSummary(detail.design);
        setDesignsError(undefined);
      } catch (caught) {
        if (
          generation === designReadGenerationRef.current &&
          selectedDesignIdRef.current === designId
        ) {
          const message =
            caught instanceof Error ? caught.message : 'Could not load this Design.';
          if (draftRead) setDesignDetail(undefined);
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
      showLoading: true
    });
  }, [designs, loadDesign, refreshDesignList]);
  const createDesign = useCallback(
    async (
      input: Pick<
        CreateDesignRequest,
        | 'source'
        | 'agentProfileId'
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
        const detail = await taskManagerApi.createDesign({
          ...input,
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
        const turn = detail.turns.find((candidate) => candidate.id === turnId);
        notify(turn?.outcome === 'CANCELED' && !turn.runId ? 'Queued message removed.' : 'Stopping Design work.', 'info');
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
        await loadDesign(interaction.taskId, { showLoading: false });
        void refreshDesignList();
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : 'Could not submit the response.';
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
    async (designId: string, removeWorktree = false) => {
      try {
        const result = await taskManagerApi.deleteTask({ taskId: designId, removeWorktree });
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
        notify(result.retainedWorktrees?.length ? `Design deleted. Workspace retained at ${result.retainedWorktrees.map((item) => item.path).join(', ')}.` : 'Design deleted.', 'success');
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
      return canvas
        .show(input)
        .then(() => {
          designCanvasErrorRef.current = undefined;
        })
        .catch(() => {
          reportDesignCanvasError(undefined, DESIGN_CANVAS_LOAD_FAILED_NOTICE);
          throw new Error(DESIGN_CANVAS_LOAD_FAILED_NOTICE);
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
      void updateAppSettings({ selectedRepositoryId: activeRepositoryId });
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
  // The Preview conversation's runs and records render in the Preview tab, never as the task's run.
  const selectedRecords = useMemo(
    () =>
      selectedTask && taskDetail
        ? partitionAgentRecords({
            runs: selectTaskRuns(taskDetail, selectedTask.id),
            items: taskDetail.agentItems,
            instructions: taskDetail.taskInstructions,
            interactions: taskDetail.interactionRequests,
            sessions: taskDetail.agentSessions,
            plans: taskDetail.agentPlanRevisions
          })
        : undefined,
    [selectedTask, taskDetail]
  );
  const selectedRuns = selectedRecords?.task.runs ?? EMPTY_RUNS;
  const selectedRun = selectedTask ? selectActiveRun(selectedTask, selectedRuns) : undefined;
  const selectedEvents = useMemo(
    () =>
      selectedTask && taskDetail
        ? selectTaskEvents(taskDetail, selectedTask.id)
        : [],
    [selectedTask, taskDetail]
  );
  const selectedInteractions = selectedRecords?.task.interactions ?? [];
  const selectedSessions = selectedRecords?.task.sessions ?? [];
  const selectedItems = selectedRecords?.task.items ?? [];
  const selectedGoals = selectedTask ? taskDetail?.agentGoalSnapshots ?? [] : [];
  const selectedPlans = selectedRecords?.task.plans ?? [];
  const selectedUsage = selectedTask ? taskDetail?.agentUsageSnapshots ?? [] : [];
  const selectedSettings = selectedTask
    ? taskDetail?.agentSettingsObservations ?? []
    : [];
  const selectedSubagentObservations = selectedTask
    ? taskDetail?.agentSubagentObservations ?? []
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
  // Ask starts on its own default from Settings, else the implementation default.
  const sideQuestionDefault = useMemo((): SideQuestionModelChoice => appSettings.sideQuestionRuntimeId
    ? {
        runtimeId: appSettings.sideQuestionRuntimeId,
        model: appSettings.sideQuestionModel,
        modelProvider: appSettings.sideQuestionModelProvider,
        reasoningEffort: appSettings.sideQuestionReasoningEffort
      }
    : {
        runtimeId: appSettings.defaultRuntimeId,
        model: appSettings.defaultModel,
        modelProvider: appSettings.defaultModelProvider,
        reasoningEffort: appSettings.defaultReasoningEffort
      }, [
    appSettings.sideQuestionRuntimeId, appSettings.sideQuestionModel, appSettings.sideQuestionModelProvider, appSettings.sideQuestionReasoningEffort,
    appSettings.defaultRuntimeId, appSettings.defaultModel, appSettings.defaultModelProvider, appSettings.defaultReasoningEffort
  ]);
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
            supportedDesignModels(
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
  // The review runs on the model chosen in Settings › Review, else on the task's own
  // model when it reviews on the task's runtime.
  const reviewExecutionSettings = useMemo(() => {
    const runtimeId = reviewRuntime?.preflight.runtime.id ??
      appSettings.reviewRuntimeId ??
      selectedTask?.runtimeId ??
      appSettings.defaultRuntimeId;
    const taskModel = !appSettings.reviewModel && selectedTask?.runtimeId === runtimeId ? selectedTask.agentSettings : undefined;
    return resolveModelExecutionSettings(
      enabledRuntimeModels,
      appSettings.reviewModel ?? taskModel?.model ?? appSettings.defaultModel,
      appSettings.reviewReasoningEffort ?? taskModel?.reasoningEffort,
      runtimeId,
      appSettings.reviewModelProvider ?? taskModel?.modelProvider
    );
  }, [
    appSettings.defaultModel,
    appSettings.defaultRuntimeId,
    appSettings.reviewModel,
    appSettings.reviewModelProvider,
    appSettings.reviewReasoningEffort,
    appSettings.reviewRuntimeId,
    reviewRuntime?.preflight.runtime.id,
    selectedTask?.runtimeId,
    selectedTask?.agentSettings,
    enabledRuntimeModels
  ]);

  const openTaskDetail = useCallback(
    (taskId: string, trigger?: HTMLElement) => {
      worktreePreparationGenerationRef.current += 1;
      worktreePreparationActionRef.current = undefined;
      worktreePreparationSubmissionRef.current = false;
      setWorktreePreparationActionTaskId(undefined);
      setWorktreePreparation(undefined);
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
    worktreePreparationGenerationRef.current += 1;
    worktreePreparationActionRef.current = undefined;
    worktreePreparationSubmissionRef.current = false;
    setWorktreePreparationActionTaskId(undefined);
    taskDataCoordinator.closeTask();
    setIsDetailOpen(false);
    setTaskDetail(undefined);
    setWorktreePreparation(undefined);
  }, [taskDataCoordinator]);

  // New task opens on the repository used last (DESIGN.md: repositories live in Settings).
  const rememberRepository = (repositoryId: string) => {
    if (repositoryId && repositoryId !== activeRepositoryId) {
      void updateAppSettings({ selectedRepositoryId: repositoryId });
    }
  };

  const createTask = async (input: CreateTaskRequest) => {
    try {
      const created = await taskManagerApi.createTask(input);
      rememberRepository(input.repositoryId);
      taskNavigationReturnFocusRef.current = newTaskButtonRef.current;
      setNewTaskTextDraft({ title: '', prompt: '' });
      await taskDataCoordinator.refreshBoard();
      await openTaskDetail(created.id);
    } catch (caught) {
      reportActionError(caught, 'Could not create task.');
      throw caught;
    }
  };

  const importTask = async (input: ImportTaskRequest) => {
    try {
      const imported = await taskManagerApi.importTask(input);
      rememberRepository(input.repositoryId);
      taskNavigationReturnFocusRef.current = newTaskButtonRef.current;
      setNewTaskTextDraft({ title: '', prompt: '' });
      await taskDataCoordinator.refreshBoard();
      await openTaskDetail(imported.id);
    } catch (caught) {
      reportActionError(caught, 'Could not import existing work.');
      throw caught;
    }
  };

  const refinePrompt = async (input: RefinePromptRequest) => {
    const refinementModel = selectModel(
      enabledRuntimeModels,
      appSettings.promptRefinementModel,
      promptRefinementRuntime?.preflight.runtime.id,
      appSettings.promptRefinementModelProvider
    );
    // The composer owns feedback and ignores results after its request closes.
    return taskManagerApi.refinePrompt({
      ...input,
      runtimeId:
        refinementModel?.runtimeId ?? promptRefinementRuntime?.preflight.runtime.id,
      model: refinementModel?.model,
      modelProvider:
        refinementModel?.modelProvider ?? appSettings.promptRefinementModelProvider
    });
  };

  const cancelPromptRefinement = async (requestId: string) => {
    const refinementModel = selectModel(
      enabledRuntimeModels,
      appSettings.promptRefinementModel,
      promptRefinementRuntime?.preflight.runtime.id,
      appSettings.promptRefinementModelProvider
    );
    try {
      await taskManagerApi.cancelPromptRefinement({
        requestId,
        runtimeId:
          refinementModel?.runtimeId ?? promptRefinementRuntime?.preflight.runtime.id
      });
    } catch (caught) {
      // A failed stop still needs attention after the composer has closed.
      reportActionError(caught, 'Could not stop prompt refinement.');
      throw caught;
    }
  };

  const startRun = async (taskId: string, instruction?: string, settings?: AgentExecutionSettings) => {
    setError(undefined);
    try {
      await withAppAction(() => taskManagerApi.startRun({ taskId, instruction, mode: 'IMPLEMENTATION', settings }));
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to start run.');
      await refresh();
      if (instruction) throw caught;
    }
  };

  const refreshEvidence = async (taskId: string) => {
    try {
      await withAppAction(() => taskManagerApi.refreshEvidence({ taskId }));
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Could not refresh the checkout.');
    }
  };

  const reconnectWorktree = async (taskId: string, worktreePath: string) => {
    await withAppAction(() => taskManagerApi.reconnectWorktree({ taskId, worktreePath }));
    await refresh();
  };

  const updateWorktreeComparison = async (taskId: string, baseRef: string) => {
    await withAppAction(() => taskManagerApi.updateWorktreeComparison({ taskId, baseRef }));
    await refresh();
  };

  const prepareWorktree = async (taskId: string) => {
    if (worktreePreparationActionRef.current) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const generation = ++worktreePreparationGenerationRef.current;
    worktreePreparationActionRef.current = { taskId, generation };
    setWorktreePreparationActionTaskId(taskId);
    setError(undefined);
    const isCurrentRequest = () =>
      worktreePreparationActionRef.current?.taskId === taskId &&
      worktreePreparationActionRef.current.generation === generation;
    try {
      const inspection = await taskManagerApi.inspectWorktreePreparation({ taskId });
      if (!isCurrentRequest()) return;
      const selectedBase = inspection.mode === 'CREATE'
        ? inspection.bases.find((candidate) => candidate.current) ?? inspection.bases[0]
        : undefined;
      setWorktreePreparation({
        inspection,
        returnFocus,
        selectedBaseRef: selectedBase?.refName,
        busy: false
      });
    } catch (caught) {
      if (isCurrentRequest()) {
        reportActionError(caught, 'Failed to prepare worktree.');
      }
    } finally {
      if (isCurrentRequest()) {
        worktreePreparationActionRef.current = undefined;
        setWorktreePreparationActionTaskId(undefined);
      }
    }
  };

  /** Restores a missing managed worktree at its recorded commit. The Preview block states the consent the dialog used to ask for. */
  const restoreWorktree = async (taskId: string) => {
    if (worktreePreparationActionRef.current) return;
    const generation = ++worktreePreparationGenerationRef.current;
    worktreePreparationActionRef.current = { taskId, generation };
    setWorktreePreparationActionTaskId(taskId);
    setError(undefined);
    try {
      const result = await withAppAction(() => taskManagerApi.prepareWorktree({ taskId, intent: 'RECOVER' }));
      if (result.outcome === 'PREPARED') {
        notify('Worktree restored.', 'success');
        await refresh();
      } else if (result.outcome === 'BASE_ALREADY_BOUND') {
        notify('The worktree base was already set.', 'info');
        await refresh();
      } else {
        reportActionError(new Error('The recorded base moved. Prepare the worktree from the Overview to choose a base.'), 'Failed to restore the worktree.');
      }
    } catch (caught) {
      reportActionError(caught, 'Failed to restore the worktree.');
    } finally {
      if (worktreePreparationActionRef.current?.taskId === taskId && worktreePreparationActionRef.current.generation === generation) {
        worktreePreparationActionRef.current = undefined;
        setWorktreePreparationActionTaskId(undefined);
      }
    }
  };

  const confirmWorktreePreparation = async () => {
    const pending = worktreePreparation;
    if (!pending || pending.busy || worktreePreparationSubmissionRef.current) return;
    const selectedBase = pending.inspection.mode === 'CREATE'
      ? pending.inspection.bases.find((candidate) => candidate.refName === pending.selectedBaseRef)
      : undefined;
    if (pending.inspection.mode === 'CREATE' && !selectedBase) return;
    const generation = worktreePreparationGenerationRef.current;
    worktreePreparationSubmissionRef.current = true;
    setWorktreePreparation({ ...pending, busy: true, error: undefined });
    try {
      const result = await withAppAction(() => taskManagerApi.prepareWorktree(selectedBase
        ? {
            taskId: pending.inspection.taskId,
            intent: 'CREATE',
            baseRef: selectedBase.refName,
            expectedBaseSha: selectedBase.sha
          }
        : { taskId: pending.inspection.taskId, intent: 'RECOVER' }
      ));
      if (generation !== worktreePreparationGenerationRef.current) return;
      if (result.outcome === 'PREPARED') {
        setWorktreePreparation(undefined);
        notify(pending.inspection.mode === 'CREATE' ? 'Worktree prepared.' : 'Worktree restored.', 'success');
        await refresh();
        return;
      }
      if (result.outcome === 'BASE_ALREADY_BOUND') {
        setWorktreePreparation(undefined);
        notify('The worktree base was already set.', 'info');
        await refresh();
        return;
      }

      if (!selectedBase) throw new Error('Task Monki could not restore the worktree.');
      const refreshed = result.inspection;
      const retainedSelection = refreshed.bases.find(
        (candidate) => candidate.refName === selectedBase.refName
      );
      const nextSelection =
        retainedSelection ??
        refreshed.bases.find((candidate) => candidate.current) ??
        refreshed.bases[0];
      setWorktreePreparation({
        inspection: refreshed,
        returnFocus: pending.returnFocus,
        selectedBaseRef: nextSelection?.refName,
        busy: false,
        error:
          retainedSelection
            ? `${selectedBase.displayName} moved from ${selectedBase.sha.slice(0, 12)} to ${retainedSelection.sha.slice(0, 12)}. Review the new commit before preparing.`
            : `${selectedBase.displayName} at ${selectedBase.sha.slice(0, 12)} is no longer available. Choose another base.`
      });
    } catch (caught) {
      if (generation === worktreePreparationGenerationRef.current) {
        setWorktreePreparation({
          ...pending,
          busy: false,
          error: caught instanceof Error ? caught.message : 'Could not prepare the worktree.'
        });
      }
    } finally {
      if (generation === worktreePreparationGenerationRef.current) {
        worktreePreparationSubmissionRef.current = false;
      }
    }
  };

  const createDeliveryCommit = async (taskId: string) => {
    setError(undefined);
    try {
      await withAppAction(() => taskManagerApi.createDeliveryCommit({ taskId }));
      notify('Delivery commit created.', 'success');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to create delivery commit.');
    }
  };

  const createPullRequest = async (taskId: string, title?: string, baseBranch?: string) => {
    setError(undefined);
    try {
      await withAppAction(() => taskManagerApi.createPullRequest({ taskId, title, baseBranch }));
      notify('Draft pull request created.', 'success');
      await refresh();
    } catch (caught) {
      // The creation dialog keeps its inputs and displays the failure for retry.
      if (title !== undefined) throw caught;
      reportActionError(caught, 'Failed to create pull request.');
    }
  };

  const refreshGitHub = async (taskId: string) => {
    setError(undefined);
    try {
      await withAppAction(() => taskManagerApi.refreshGitHub({ taskId }));
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to refresh GitHub.');
    }
  };

  const getPreviewRecipeGeneration = async (taskId: string) => {
    const state = await taskManagerApi.getPreviewRecipeGeneration({ taskId });
    setPreviewRecipeGenerations((current) => ({ ...current, [taskId]: state }));
    return state;
  };

  const sendPreviewAgentMessage = async (taskId: string, text: string, id: string, settings?: AgentExecutionSettings) => {
    await withAppAction(() => taskManagerApi.sendPreviewAgentMessage({ taskId, id, text, settings }));
  };

  const stopPreviewAgent = async (taskId: string) => {
    await withAppAction(() => taskManagerApi.stopPreviewAgent({ taskId }));
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
    const result = await withAppAction(() => taskManagerApi.acceptPreviewRecipeDraft({ taskId, draftId, yaml }));
    setPreviewRecipeGenerations((current) => ({
      ...current,
      [taskId]: { taskId, status: 'EMPTY' }
    }));
    await refresh();
    // The Preview panel confirms the save once, the same way for proposals and manual edits.
    return result;
  };

  const discardPreviewRecipeDraft = async (taskId: string) => {
    const state = await withAppAction(() => taskManagerApi.discardPreviewRecipeDraft({ taskId }));
    setPreviewRecipeGenerations((current) => ({ ...current, [taskId]: state }));
    return state;
  };

  const readArtifact = async (artifactId: string) => {
    try {
      return await taskManagerApi.readArtifact({ artifactId });
    } catch (caught) {
      reportActionError(caught, 'Could not read the retained artifact.');
      throw caught;
    }
  };

  /** One task's Preview conversation, for a task's Preview tab or a repository Design's setup. */
  const previewAgentConversation = (
    taskId: string,
    records: AgentConversationRecords,
    respond: PreviewAgentConversation['respond']
  ): PreviewAgentConversation => ({
    ...records,
    models: runtimeModels,
    runtimes: runtimeCatalog?.runtimes ?? [],
    defaults: {
      runtimeId: configuredPreviewRecipeGenerationRuntimeId,
      model: appSettings.previewRecipeGenerationModel,
      modelProvider: appSettings.previewRecipeGenerationModelProvider
    },
    onDiscoverModels: discoverAgentRuntimeModels,
    send: (text, id, settings) => sendPreviewAgentMessage(taskId, text, id, settings),
    stop: () => stopPreviewAgent(taskId),
    editQueued: async (id, instruction) => {
      await withAppAction(() => taskManagerApi.editTaskInstruction({ taskId, id, instruction }));
    },
    respond,
    readArtifact
  });

  const previewProposalActions = (taskId: string): PreviewProposalActions => ({
    state: previewRecipeGenerations[taskId],
    get: getPreviewRecipeGeneration,
    validate: validatePreviewRecipeDraft,
    accept: acceptPreviewRecipeDraft,
    discard: discardPreviewRecipeDraft
  });

  const transitionTask = async (taskId: string, toPhase: WorkflowPhase) => {
    setError(undefined);
    try {
      await withAppAction(() => taskManagerApi.transitionTask({ taskId, toPhase }));
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
      const deleted = await withAppAction(() => taskManagerApi.deleteTask({ taskId, removeWorktree }));
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
      await withAppAction(() => taskManagerApi.cancelRun({ runId }));
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to cancel run.');
    }
  };

  const steerRun = async (runId: string, instruction: string, clientMessageId?: string) => {
    setError(undefined);
    try {
      const run = selectedRuns.find((candidate) => candidate.id === runId);
      if (!run) {
        throw new Error('Run not found.');
      }
      await withAppAction(() => taskManagerApi.steerRun({ taskId: run.taskId, runId, instruction, clientMessageId }));
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to steer run.');
      throw caught;
    }
  };

  const continueRun = async (runId: string, instruction?: string, clientMessageId?: string, files?: import('../../shared/contracts').InstructionAttachments, reviewRequest?: ReviewRequestRecord) => {
    setError(undefined);
    try {
      const run = selectedRuns.find((candidate) => candidate.id === runId);
      if (!run) {
        throw new Error('Run not found.');
      }
      const recoveryContinuation =
        run.status !== 'COMPLETED' ||
        Boolean(selectedTask && getImplementationRetryReason(selectedTask));
      await withAppAction(() => taskManagerApi.continueRun({ taskId: run.taskId, runId, instruction, clientMessageId, ...files, ...(reviewRequest ? { reviewRequest } : {}) }));
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
    instruction?: string,
    clientMessageId?: string,
    files?: import('../../shared/contracts').InstructionAttachments
  ) => {
    setError(undefined);
    try {
      const run = selectedRuns.find((candidate) => candidate.id === runId);
      if (!run) {
        throw new Error('Run not found.');
      }
      const retry = await withAppAction(() => taskManagerApi.retryRun({
        taskId: run.taskId,
        runId,
        strategy,
        instruction,
        clientMessageId,
        ...files
      }));
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

  // Dismissing or restoring a finding records a decision on the current review.
  const decideReviewFinding = async (input: DecideReviewFindingRequest) => {
    if (!selectedTask) return;
    try {
      await taskManagerApi.decideReviewFinding(input);
      await refresh();
    } catch (caught) {
      reportActionError(caught, input.kind === 'DISMISS' ? 'Could not dismiss the finding.' : 'Could not restore the finding.');
      throw caught;
    }
  };

  const startReview = async (runId?: string) => {
    setError(undefined);
    try {
      const run = selectedRuns.find((candidate) => candidate.id === runId);
      if ((!run && runId) || !selectedTask) {
        throw new Error('Run not found.');
      }
      await withAppAction(() => taskManagerApi.startReview({
        taskId: run?.taskId ?? selectedTask.id,
        runId,
        settings: reviewExecutionSettings
      }));
      // Confirm only what happened: a start that fails reports its error instead.
      notify(REVIEW_STARTED_NOTICE, 'info');
      await refresh();
    } catch (caught) {
      reportActionError(caught, 'Failed to start review.');
      throw caught;
    }
  };

  const syncAgentGoal = async (taskId: string, sessionId: string) => {
    setError(undefined);
    try {
      await withAppAction(() => taskManagerApi.syncAgentGoal({ taskId, sessionId }));
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
      await withAppAction(() => taskManagerApi.updateAgentNativeSession(input));
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
    await taskManagerApi.respondToInteraction({
      taskId: interaction.taskId,
      runId: interaction.runId,
      interactionRequestId: interaction.id,
      decision
    });
    await refresh();
  };

  const revealLabel =
    windowChromePlatform === 'macos' ? 'Reveal in Finder'
      : windowChromePlatform === 'windows' ? 'Reveal in File Explorer'
        : 'Reveal in file manager';

  const revealRepository = useCallback(
    async (repositoryId: string) => {
      try {
        const result = await taskManagerApi.executeOpenTargetAction({
          target: { type: 'repository', repositoryId },
          action: 'reveal'
        });
        if (!result.ok) notify(result.message ?? 'Could not reveal the repository.', 'error');
      } catch (caught) {
        reportActionError(caught, 'Could not reveal the repository.');
      }
    },
    [notify, reportActionError]
  );

  const addRepository = useCallback(async () => {
    setError(undefined);
    setIsAddingRepository(true);
    try {
      const selectedPath = await withAppAction(() => taskManagerApi.chooseRepositoryFolder());
      if (!selectedPath) {
        return false;
      }
      const repository = await taskManagerApi.addRepository(selectedPath);
      const nextSettings = await updateAppSettings({ selectedRepositoryId: repository.id });
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
        const selectedPath = await withAppAction(() => taskManagerApi.chooseRepositoryFolder());
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
    if (view === 'previews') {
      // The preview list restores its row after the inventory request completes.
      appRootRef.current?.focus({ preventScroll: true });
      return;
    }
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
    if (isTasksView(next)) lastTasksViewRef.current = { view: next };
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
    lastTasksViewRef.current = { view: 'board', boardId };
    setSelectedBoardId(boardId);
    setView('board');
    closeTaskDetail();
  };

  // The rail's Tasks item returns to the view the user last chose there.
  const showTasks = () => {
    const last = lastTasksViewRef.current;
    if (last.boardId && snapshot.boards.some((board) => board.id === last.boardId)) {
      showBoard(last.boardId);
    } else {
      showView(last.view);
    }
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

  const appOwnedModalOpen = Boolean(
    deleteCandidate ||
      repositoryDisconnect ||
      boardEditor ||
      worktreePreparation ||
      designExternalLinkRequest
  );
  const appBackgroundModalOpen = appOwnedModalOpen || isTaskDetailModalOpen;

  useExternalCheckoutObservation({
    taskId: isDetailOpen && selectedWorktree?.ownership === 'EXTERNAL' ? selectedTask?.id : undefined,
    paused: appBackgroundModalOpen || isNewTaskOpen || isAddingRepository || selectedRuns.some((run) =>
      ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING'].includes(run.status)),
    isActionPending: () => pendingAppActions.current > 0,
    observe: (taskId) => taskManagerApi.refreshEvidence({ taskId }),
    refresh,
    onError: (caught) => {
      // Observing a checkout that is already known to be missing only checks
      // whether it came back; the task page states that it is missing.
      if (selectedWorktree && selectedWorktree.status !== 'PRESENT') return;
      reportActionError(caught, 'Could not refresh the external checkout.');
    }
  });

  return (
    <TooltipProvider>
    <NotifyProvider value={notify}>
    <div
      ref={appRootRef}
      className="tm-app app-shell"
      tabIndex={-1}
      data-input-modality={inputModality}
      data-window-platform={windowChromePlatform}
    >
      <div
        className="tm-body"
        inert={appOwnedModalOpen || isNewTaskOpen ? true : undefined}
        aria-hidden={appOwnedModalOpen || isNewTaskOpen ? true : undefined}
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
              <div className="tm-titlebar__nav">
                <Tooltip label="Back">
                  <button type="button" className="tm-iconbtn" onClick={goBack} disabled={!canGoBack} aria-label="Back">
                    <ArrowLeftIcon />
                  </button>
                </Tooltip>
                <Tooltip label="Forward">
                  <button type="button" className="tm-iconbtn" onClick={goForward} disabled={!canGoForward} aria-label="Forward">
                    <ArrowRightIcon />
                  </button>
                </Tooltip>
              </div>
              {/* Always mounted on a task page, so the title can rise in and settle out with the page's head. */}
              {showDetail && selectedTask ? (
                <span className="tm-titlebar__title" data-visible={compactTaskTitle ? '' : undefined}
                  data-instant={compactTitle.animate ? undefined : ''} aria-hidden={compactTaskTitle ? undefined : true} title={compactTaskTitle}>
                  {compactTaskTitle ?? selectedTask.title}
                </span>
              ) : null}
              <div className="tm-titlebar__spacer" />
              <button
                ref={newTaskButtonRef}
                type="button"
                className="primary-button button--sm tm-newtask"
                onClick={openNewTask}
                disabled={!canCreateTask}
                title={canCreateTask ? undefined : 'Finish setup before creating tasks'}
              >
                <PlusIcon />
                <span>New task</span>
              </button>
            </header>

            <div className="tm-canvas__content">
            <nav
              id="app-navigation"
              aria-label="Primary"
              className="tm-rail"
              inert={isTaskDetailModalOpen ? true : undefined}
              aria-hidden={isTaskDetailModalOpen ? true : undefined}
            >
              <RailItem
                label="Inbox"
                icon={<InboxIcon />}
                count={navCounts.inbox}
                active={!showDetail && view === 'inbox'}
                onClick={() => showView('inbox')}
              />
              <RailItem
                label="Tasks"
                icon={<BoardIcon />}
                active={showDetail || isTasksView(view)}
                onClick={showTasks}
              />
              <RailItem
                label="Designs"
                icon={<DesignIcon />}
                active={!showDetail && view === 'designs'}
                onClick={() => showView('designs')}
              />
              <RailItem
                label="Previews"
                icon={<PreviewIcon />}
                active={!showDetail && view === 'previews'}
                onClick={() => showView('previews')}
              />
              <RailItem
                label="Discourse"
                icon={<DiscourseIcon />}
                count={discourseAttentionCount}
                countNoun="conversation"
                active={!showDetail && view === 'discourse'}
                onClick={() => showView('discourse')}
              />
              <div className="tm-rail__spacer" />
              <SoftwareUpdateNotice
                state={softwareUpdateState}
                onDownload={() => void downloadSoftwareUpdate()}
                onInstall={() => void installSoftwareUpdate()}
              />
              <RailItem
                label="Settings"
                icon={<SettingsIcon />}
                active={!showDetail && view === 'settings'}
                onClick={() => showView('settings')}
              />
            </nav>

        {showDetail && selectedTask && taskDetail ? (
          <TaskDetail
            attachmentOptions={{
              enabled: true,
              model: selectModel(runtimeModels, selectedRun?.requestedSettings.model ?? selectedTask.agentSettings.model, selectedTask.runtimeId, selectedTask.agentSettings.modelProvider),
              initialDraft: taskDetail.agentAttachmentDraft,
              onStageBatch: taskManagerApi.stageTaskAttachmentBatch,
              onDiscard: (draftId) => taskManagerApi.discardTaskAttachmentDraft({ draftId }),
              onReadClipboardImage: taskManagerApi.readClipboardImage,
              onReadDraftAttachment: (attachmentId) => taskManagerApi.readTaskAttachment({ attachmentId, draftId: taskDetail.agentAttachmentDraft?.id }),
              onPersistDraft: async (attachmentDraftId) => {
                await taskManagerApi.saveTaskAgentDraft({ taskId: selectedTask.id, attachmentDraftId: attachmentDraftId ?? null });
                await refresh();
              }
            }}
            onReadAttachment={(attachmentId) => taskManagerApi.readTaskAttachment({ attachmentId })}
            onNotify={notify}
            onPrepareTaskAgent={async (text) => {
              if (taskDetail.runs.length) {
                const draft = agentDrafts.values[selectedTask.id] ?? selectedTask.agentDraft ?? '';
                agentDrafts.save(selectedTask.id, draft ? `${draft}\n\n${text}` : text);
                await agentDrafts.flush(selectedTask.id);
              } else {
                const prompt = selectedTask.promptDraft ?? selectedTask.prompt;
                await taskManagerApi.saveTaskPrompt({ taskId: selectedTask.id, prompt: `${prompt}\n\n${text}`, draftOnly: true });
                await refresh();
              }
            }}
            onSavePrompt={async (prompt, draftOnly, files) => {
              await taskManagerApi.saveTaskPrompt({ taskId: selectedTask.id, prompt, draftOnly, ...files });
              if (!draftOnly) await refresh();
            }}
            agentInstructions={selectedRecords?.task.instructions ?? []}
            agentDraft={agentDrafts.values[selectedTask.id] ?? selectedTask.agentDraft ?? ''}
            agentDraftError={agentDrafts.errors[selectedTask.id]}
            onAgentDraftChange={(text) => agentDrafts.save(selectedTask.id, text)}
            onFlushAgentDraft={() => agentDrafts.flush(selectedTask.id)}
            reviewDraft={reviewDrafts.values[selectedTask.id] ?? selectedTask.reviewDraft ?? EMPTY_REVIEW_DRAFT}
            reviewDraftError={reviewDrafts.errors[selectedTask.id]}
            onReviewDraftChange={(draft) => reviewDrafts.save(selectedTask.id, draft)}
            onQueueInstruction={async (runId, instruction, id, files) => {
              await withAppAction(() => taskManagerApi.queueTaskInstruction({ taskId: selectedTask.id, runId, instruction, id, ...files }));
              await refresh();
            }}
            onEditInstruction={async (id, instruction, files) => {
              await withAppAction(() => taskManagerApi.editTaskInstruction({ taskId: selectedTask.id, id, instruction, ...files }));
              await refresh();
            }}
            onSendInstruction={async (id, runId) => {
              await withAppAction(() => taskManagerApi.sendTaskInstruction({ taskId: selectedTask.id, id, runId }));
              await refresh();
            }}
            initialTab={view === 'previews' ? previewDetailTab : undefined}
            headingRef={taskDetailHeadingRef}
            onCompactTitleChange={onCompactTitleChange}
            error={error}
            task={selectedTask}
            repository={taskDetail.repository}
            run={selectedRun}
            worktree={selectedWorktree}
            gitSnapshot={selectedGitSnapshot}
            gitSnapshots={selectedGitSnapshots}
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
            models={runtimeModels}
            runtimes={runtimeCatalog?.runtimes ?? []}
            onDiscoverAgentRuntimeModels={discoverAgentRuntimeModels}
            reviewDisabledReason={reviewDisabledReason}
            server={taskDetail.agentServers.find(
              (candidate) => candidate.id === selectedRun?.serverInstanceId
            )}
            artifacts={taskDetail.artifacts}
            textExcerpts={taskDetail.textExcerpts}
            postRunEvidencePendingRunIds={taskDetail.postRunEvidencePendingRunIds}
            attachments={selectedTaskAttachments}
            interactions={selectedInteractions}
            previewAgent={selectedTask && selectedRecords
              ? previewAgentConversation(selectedTask.id, selectedRecords.preview, respondToInteraction)
              : undefined}
            previewProposals={selectedTask ? previewProposalActions(selectedTask.id) : undefined}
            ask={selectedTask && selectedRecords ? {
              records: selectedRecords.side,
              defaultModel: sideQuestionDefault,
              ask: async (input) => {
                await withAppAction(() => taskManagerApi.askSideQuestion({ taskId: selectedTask.id, ...input }));
              },
              stop: async (runId) => {
                await withAppAction(() => taskManagerApi.stopSideQuestion({ taskId: selectedTask.id, runId }));
              },
              // Bound to this task, so a thread ended after leaving it still reaches its snapshot.
              end: async (threadId) => {
                await taskManagerApi.endSideThread({ taskId: selectedTask.id, threadId });
              },
              readArtifact
            } : undefined}
            worktreePreparationPending={worktreePreparationActionTaskId === selectedTask?.id}
            onPrepareWorktree={prepareWorktree}
            onRestoreWorktree={restoreWorktree}
            onStart={startRun}
            onCancel={cancelRun}
            onSteer={steerRun}
            onContinue={continueRun}
            onSendReviewRequest={(runId, instruction, request) => continueRun(runId, instruction, undefined, undefined, request)}
            onListExistingWorktrees={taskManagerApi.listExistingWorktrees}
            onReconnectWorktree={reconnectWorktree}
            onUpdateWorktreeComparison={updateWorktreeComparison}
            onRefreshEvidence={refreshEvidence}
            onRetry={retryRun}
            onReview={startReview}
            onDecideReviewFinding={decideReviewFinding}
            onSyncAgentGoal={syncAgentGoal}
            onUpdateAgentNativeSession={updateAgentNativeSession}
            onRespondToInteraction={respondToInteraction}
            onCreateDeliveryCommit={createDeliveryCommit}
            onCreatePullRequest={createPullRequest}
            onRefreshGitHub={refreshGitHub}
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
            {error ? <div className="tm-error tm-error--page">{error}</div> : null}
          </main>
        ) : view === 'previews' ? (
          <PreviewsPage
            state={previewsPageState}
            onStateChange={setPreviewsPageState}
            scrollPosition={previewsScrollPosition}
            onBrowseTasks={() => showView('board')}
            onOpen={(instance, trigger) => {
              if (instance.kind === 'design') {
                setView('designs');
                void refreshDesignList();
                void loadDesign(instance.taskId, { select: true, showLoading: true });
              } else {
                setPreviewDetailTab(instance.isCurrentWorktree ? 'preview' : 'overview');
                selectTask(instance.taskId, trigger);
              }
            }}
          />
        ) : view === 'designs' ? (
          <DesignsWorkspace
            onUpdateProject={(detail) => applyDesignActionDetail(detail, false)}
            repositories={snapshot.repositories}
            onInspectRepository={(repositoryId) => taskManagerApi.inspectDesignRepository({ repositoryId })}
            agentProfiles={appSettings.agentProfiles}
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
            previewAgent={designDetail?.design.id === selectedDesignId && designDetail
              ? previewAgentConversation(designDetail.design.id, designDetail.previewAgent ?? EMPTY_PREVIEW_AGENT_RECORDS, respondToDesignInteraction)
              : undefined}
            previewProposals={selectedDesignId ? previewProposalActions(selectedDesignId) : undefined}
            onNotify={notify}
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
            onCreateDesign={createDesign}
            onSubmitRefinement={submitDesignRefinement}
            onStageAttachmentBatch={taskManagerApi.stageTaskAttachmentBatch}
            onDiscardAttachmentDraft={taskManagerApi.discardTaskAttachmentDraft}
            onReadClipboardImage={taskManagerApi.readClipboardImage}
            onReadDesignDraftAttachment={(designId, attachmentId) =>
              taskManagerApi.readDesignDraftAttachment({ designId, attachmentId })
            }
            onReadAttachment={(attachmentId) => taskManagerApi.readTaskAttachment({ attachmentId })}
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
            onOpenCanvas={async (taskId, generationId, routeId) => {
                    const result = await taskManagerApi.openDesignPreview({ taskId, generationId, routeId });
                    if (!result.opened) window.open(result.url, '_blank', 'noopener,noreferrer');
                  }}
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
            defaults={appSettings.discourseDefaults}
            onDefaultsChange={async (discourseDefaults) => { await updateAppSettings({ discourseDefaults }); }}
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
            boards={snapshot.boards}
            onShowTasksView={showView}
            onShowBoard={showBoard}
            onNewBoard={() => setBoardEditor('new')}
            tasks={visibleTasks}
            repositories={snapshot.repositories}
            interactionRequests={snapshot.interactionRequests}
            theme={theme}
            onSetTheme={updateTheme}
            onPreviewThemePreset={setPreviewThemePreset}
            appSettings={appSettings}
            onSetAppSettings={updateAppSettings}
            onSaveAgentProfile={async (input) => {
              setAppSettings(await taskManagerApi.saveAgentProfile(input));
            }}
            onDeleteAgentProfile={async (profileId) => {
              setAppSettings(await taskManagerApi.deleteAgentProfile(profileId));
            }}
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
            repositoryOptions={repositoryOptions}
            revealLabel={revealLabel}
            onRefreshRepository={refreshRepository}
            onReconnectRepository={reconnectRepository}
            onDisconnectRepository={requestRepositoryDisconnect}
            onRevealRepository={revealRepository}
            onFinishSetup={finishFirstLaunchSetup}
            onGoToDesigns={() => showView('designs')}
            onSelect={selectTask}
            onRespondToInteraction={respondToInteraction}
            onArchive={archiveTask}
            onRequestDelete={requestDeleteTask}
            onEditBoard={setBoardEditor}
          />
            )}
            </div>
          </div>

        </div>
      </div>

      {isNewTaskOpen ? (
        <NewTaskPanel
          agentProfiles={appSettings.agentProfiles}
          repositoryId={activeRepositoryId}
          repositories={snapshot.repositories}
          models={enabledRuntimeModels}
          runtimes={enabledRuntimes}
          defaultAgentSettings={defaultTaskSettings}
          disabled={!canCreateTask}
          refineDisabledReason={refineDisabledReason}
          onCreate={createTask}
          onImport={importTask}
          onPreviewImport={taskManagerApi.previewImport}
          onListExistingWorktrees={taskManagerApi.listExistingWorktrees}
          onOpenExistingTask={async (taskId) => { await openTaskDetail(taskId); }}
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
          onClose={closeNewTask}
        />
      ) : null}

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

      {worktreePreparation?.inspection.mode === 'CREATE' ? (
        <PrepareWorktreeModal
          inspection={worktreePreparation.inspection}
          returnFocus={worktreePreparation.returnFocus}
          taskTitle={
            snapshot.tasks.find(
              (task) => task.id === worktreePreparation.inspection.taskId
            )?.title ?? 'Selected task'
          }
          selectedBaseRef={worktreePreparation.selectedBaseRef}
          busy={worktreePreparation.busy}
          error={worktreePreparation.error}
          onSelectBase={(selectedBaseRef) =>
            setWorktreePreparation((current) =>
              current
                ? { ...current, selectedBaseRef, error: undefined }
                : current
            )
          }
          onCancel={() => {
            worktreePreparationGenerationRef.current += 1;
            setWorktreePreparation(undefined);
          }}
          onConfirm={() => void confirmWorktreePreparation()}
          fallbackReturnFocusRef={appRootRef}
        />
      ) : null}

      {worktreePreparation?.inspection.mode === 'RECOVER' ? (
        <RecoverWorktreeModal
          inspection={worktreePreparation.inspection}
          returnFocus={worktreePreparation.returnFocus}
          taskTitle={
            snapshot.tasks.find((task) => task.id === worktreePreparation.inspection.taskId)
              ?.title ?? 'Selected task'
          }
          busy={worktreePreparation.busy}
          error={worktreePreparation.error}
          onCancel={() => {
            worktreePreparationGenerationRef.current += 1;
            setWorktreePreparation(undefined);
          }}
          onConfirm={() => void confirmWorktreePreparation()}
          fallbackReturnFocusRef={appRootRef}
        />
      ) : null}

      <GlobalNotifier notifications={notifications} />
    </div>
    </NotifyProvider>
    </TooltipProvider>
  );
}
