import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react';
import { FolderGit2, GitBranch, RefreshCw } from 'lucide-react';
import {
  getImplementationRetryReason,
  normalizePullRequestTitle,
  type DecideReviewFindingRequest
} from '../../shared/contracts';
import { effectiveReviewFindings } from '../../shared/agentReviewFindings';
import type {
  ArtifactRecord,
  BranchPublicationRecord,
  CiRollupRecord,
  ClientTextExcerpt,
  DomainEvent,
  ExistingWorktree,
  Finding,
  GitSnapshotRecord,
  AgentInteractionDecision,
  AgentGoalSnapshotRecord,
  AgentItemRecord,
  AgentPlanRevisionRecord,
  AgentSessionRecord,
  AgentSettingsObservationRecord,
  AgentSubagentObservationRecord,
  AgentUsageSnapshotRecord,
  AgentExecutionSettings,
  AgentModel,
  AgentRuntimeState,
  AgentServerInstance,
  UpdateAgentNativeSessionRequest,
  InteractionRequestRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  Repository,
  ReviewRollupRecord,
  RunRecord,
  Task,
  WorkflowPhase,
  WorktreeRecord
} from '../../shared/contracts';
import type { TaskAttachmentRecord } from '../../shared/attachments';
import { projectAgentExecutionSupport } from '../../shared/agentExecutionSupport';
import {
  canCreateDeliveryCommit,
  canStartRun
} from '../model/selectors';
import { describeHealthFinding } from '../model/debugDiagnostics';
import { AgentSession, type AgentSessionProps } from './AgentSession';
import { PreRunSetup } from './PreRunSetup';
import { ReviewWorkspace } from './ReviewWorkspace';
import { AgentMark } from './UiIcons';
import { ReviewerPanel, type ReviewerConversation } from './ReviewerPanel';
import { SideQuestionPanel, type SideConversation } from './SideQuestionPanel';
import { appendToDraft } from '../model/sideQuestions';
import { persistPreviewAgentOpen, previewAgentOpen as storedPreviewAgentOpen } from '../model/workspaceLayout';
import { runHoldsTaskWorktree } from '../../shared/sideQuestions';
import { DockedSidePanel, FloatingSidePanel, useTaskSidePanelLayout } from './TaskSidePanel';
import { InteractionAuditPanel } from './InteractionAuditPanel';
import { ProviderActivityPanel } from './ProviderActivityPanel';
import { ProviderOverviewPanel } from './ProviderOverviewPanel';
import { SubagentHierarchyPanel } from './SubagentHierarchyPanel';
import { TaskActionsMenu } from './TaskActionsMenu';
import { TaskLifecycleTrack } from './TaskLifecycleTrack';
import { FindingRow } from './Findings';
import { DisclosureChevron } from './DisclosureChevron';
import { buildReviewRequestInstruction } from '../model/reviewFollowUp';
import type { ReviewFindingView, ReviewLineComment } from '../model/reviewWorkspace';
import {
  findCompletedCurrentImplementationRun,
  isActiveNonReviewRun,
  isImplementationRetryRequired,
  selectNextAction,
  type NextActionId,
  type NextActionModel
} from '../model/nextAction';
import { selectOverviewDecisionOwner, selectPullRequestPlacement } from '../model/overviewDecision';
import { describeTaskLifecycle } from '../model/taskLifecycle';
import { describeTaskAttention } from '../model/taskAttention';
import { getPostRunActionState } from '../model/postRunActions';
import {
  canRequestReviewChanges,
  describeReviewGateWord,
  describeRunFailureBanner,
  describeTaskClosure,
  describeTaskStatus,
  stateRestatesColumn
} from '../model/taskView';
import {
  effectiveReviewStatus,
  finishRequirementsForTask,
  getFinishEvidenceState,
  taskReviewGate
} from '../model/taskFinish';
import type { FinishRequirement } from '../model/taskFinish';
import type { Tone } from '../model/viewTypes';
import { humanizeEnum } from './display';
import {
  buildFailingChecksInvestigationPrompt,
  buildPrStatusActionState,
  buildPrStatusCreateOrPushTitle,
  buildPrStatusViewModel,
  shouldShowPrStatusOnOverview,
  type PrCheckGroup,
  type PrStatusViewModel
} from '../model/prStatus';
import {
  buildTaskActivityLedger,
  projectDebugTaskActivity,
  projectOverviewTaskActivity
} from '../model/taskActivity';
import { selectProgressRun } from '../model/runProgress';
import { buildReviewActivityViewModel } from '../model/reviewActivity';
import {
  isAgentNetworkAccessEnabled,
  formatAgentPermissionMode
} from '../model/agentPermissions';
import { ActionButtonTitle } from './ActionButtonTitle';
import { AccessibleTab } from './AccessibleTabs';
import {
  ReviewPanel,
  type ReviewActionPauseReason
} from './ReviewPanel';
import { TaskActivityPanel, formatTaskActivityTimestamp } from './TaskActivityPanel';
import {
  DecisionSlot,
  InteractionDecision,
  OverviewRequest,
  OverviewSection,
  SlotActions,
  SlotContent,
  type SlotAction
} from './TaskOverview';
import { CompletedChangeSummaryPanel } from './CompletedChangeSummaryCard';
import { conversationAnswer, conversationPreview, isActiveRunStatus, sessionTurn } from '../model/agentSession';
import { conversationCaptureRunIds } from '../model/completedChangeSummary';
import { ApplicationPreviewOverview, ApplicationPreviewPanel } from './preview/ApplicationPreviewPanel';
import type { NotificationTone } from './AppOverlays';
import type { PreviewAgentConversation, PreviewProposalActions } from './preview/PreviewAgentProps';
import {
  isReviewPhase,
  shouldShowMoveToReviewHeaderAction,
  canReviewExistingWork
} from '../model/taskReviewActions';
import {
  CreateDraftPrModal,
  ExistingWorkModal,
  MarkDoneModal
} from './TaskDetailModals';

interface TaskDetailProps {
  attachmentOptions: AgentSessionProps['attachmentOptions'];
  agentInstructions: AgentSessionProps['instructions'];
  agentDraft: string;
  onPrepareTaskAgent(text: string): Promise<void>;
  /** The app's shared toast, for completed actions nothing else on screen confirms. */
  onNotify?(message: string, tone?: NotificationTone): void;
  onSavePrompt: import('react').ComponentProps<typeof PreRunSetup>['onSavePrompt'];
  onReadAttachment: import('react').ComponentProps<typeof PreRunSetup>['onReadAttachment'];
  agentDraftError?: string;
  onAgentDraftChange: AgentSessionProps['onDraftChange'];
  onFlushAgentDraft: AgentSessionProps['onFlushDraft'];
  onQueueInstruction: AgentSessionProps['onQueue'];
  onEditInstruction: AgentSessionProps['onEditQueue'];
  onSendInstruction: AgentSessionProps['onSendQueue'];
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /**
   * The task's title while the page's own title area is out of view, for the window's top bar.
   * `animate` is false when the change came with a tab or page opening, which shows it still.
   */
  onCompactTitleChange?(title: string | undefined, animate: boolean): void;
  error?: string;
  task?: Task;
  repository?: Repository;
  run?: RunRecord;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  gitSnapshots: GitSnapshotRecord[];
  postRunEvidencePendingRunIds?: string[];
  branchPublication?: BranchPublicationRecord;
  pullRequest?: PullRequestSnapshotRecord;
  ciRollup?: CiRollupRecord;
  reviewRollup?: ReviewRollupRecord;
  mergeSnapshot?: MergeSnapshotRecord;
  events: DomainEvent[];
  runs: RunRecord[];
  sessions: AgentSessionRecord[];
  items: AgentItemRecord[];
  goalSnapshots: AgentGoalSnapshotRecord[];
  planRevisions: AgentPlanRevisionRecord[];
  usageSnapshots: AgentUsageSnapshotRecord[];
  settingsObservations: AgentSettingsObservationRecord[];
  subagentObservations: AgentSubagentObservationRecord[];
  runtimeState?: AgentRuntimeState;
  models?: AgentModel[];
  runtimes?: AgentRuntimeState[];
  onDiscoverAgentRuntimeModels?(runtimeId: string): Promise<void>;
  server?: AgentServerInstance;
  artifacts: ArtifactRecord[];
  textExcerpts?: ClientTextExcerpt[];
  attachments: TaskAttachmentRecord[];
  interactions: InteractionRequestRecord[];
  reviewDisabledReason?: string;
  /** The task's Preview conversation; absent for tasks that cannot converse. */
  previewAgent?: PreviewAgentConversation;
  /** Questions about the current review and the reviewer's answers. */
  reviewer?: ReviewerConversation;
  /** Side questions to the task's agent, kept out of the main conversation. */
  sideQuestion?: SideConversation;
  previewProposals?: PreviewProposalActions;
  onPrepareWorktree(taskId: string): Promise<void>;
  /** Restores a missing managed worktree at its recorded commit without a confirmation dialog; the Preview block carries the consent. */
  onRestoreWorktree(taskId: string): Promise<void>;
  worktreePreparationPending?: boolean;
  onStart(taskId: string, instruction?: string, settings?: AgentExecutionSettings): Promise<void>;
  onListExistingWorktrees?(repositoryId: string): Promise<ExistingWorktree[]>;
  onReconnectWorktree?(taskId: string, worktreePath: string): Promise<void>;
  onUpdateWorktreeComparison?(taskId: string, baseRef: string): Promise<void>;
  onRefreshEvidence?(taskId: string): Promise<void>;
  onCancel(runId: string): Promise<void>;
  onSteer(runId: string, instruction: string, id?: string): Promise<void>;
  onContinue: AgentSessionProps['onContinue'];
  onRetry: AgentSessionProps['onRetry'];
  onReview(runId?: string): Promise<void>;
  onDecideReviewFinding?(input: DecideReviewFindingRequest): Promise<void>;
  onSyncAgentGoal(taskId: string, sessionId: string): Promise<void>;
  onUpdateAgentNativeSession(input: UpdateAgentNativeSessionRequest): Promise<void>;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
  onCreateDeliveryCommit(taskId: string): Promise<void>;
  onCreatePullRequest(taskId: string, title?: string, baseBranch?: string): Promise<void>;
  onRefreshGitHub(taskId: string): Promise<void>;
  onReadArtifact?(artifactId: string): Promise<string>;
  onTransition(taskId: string, toPhase: WorkflowPhase): Promise<void>;
  onArchive(taskId: string): void;
  onRequestDelete(taskId: string): void;
  onModalOpenChange(open: boolean): void;
  initialTab?: DetailTab;
}

interface HeadAction {
  label: string;
  disabled?: boolean;
  title?: string;
  onClick(): void;
}

type DetailTab = 'agent' | 'overview' | 'review' | 'preview' | 'debug';

export function focusRequestedActivityHistory(
  tab: DetailTab,
  requested: { current: boolean },
  target: Pick<HTMLElement, 'focus'> | null
): boolean {
  if (tab !== 'debug' || !requested.current) {
    return false;
  }
  requested.current = false;
  if (!target) {
    return false;
  }
  target.focus();
  return true;
}

const REVIEW_START_PENDING_TIMEOUT_MS = 5000;

export function TaskDetail(props: TaskDetailProps) {
  const {
    task,
    error,
    run,
    worktree,
    gitSnapshot,
    gitSnapshots,
    pullRequest,
    interactions,
    sessions,
    planRevisions,
    branchPublication,
    ciRollup,
    reviewRollup,
    mergeSnapshot
  } = props;
  const captureRunIds = useMemo(() => conversationCaptureRunIds(props.runs, gitSnapshots), [props.runs, gitSnapshots]);
  const [tab, setTab] = useState<DetailTab>(props.initialTab ?? 'overview');
  const [agentAttentionRequest, setAgentAttentionRequest] = useState(0);
  const [existingWorkModal, setExistingWorkModal] = useState<'instruction' | 'comparison' | 'reconnect'>();
  // The review request in progress: the user's note and line comments, kept
  // while they move between tabs and cleared when the request is sent.
  const [reviewNote, setReviewNote] = useState('');
  const [reviewComments, setReviewComments] = useState<ReviewLineComment[]>([]);
  // The reviewer panel: open state, the finding the next question is about, and the unsent question.
  const [reviewerOpen, setReviewerOpen] = useState(false);
  const [reviewerFocusId, setReviewerFocusId] = useState<string>();
  const [reviewerDraft, setReviewerDraft] = useState('');
  const reviewerToggleRef = useRef<HTMLButtonElement>(null);
  // The side question thread: one per open panel. Closing the panel or leaving
  // the task ends it, which removes its snapshot; the end call is kept from the
  // task that opened it.
  const [sideThread, setSideThread] = useState<{ id: string; end(threadId: string): Promise<void> }>();
  const [sideDraft, setSideDraft] = useState('');
  const sideToggleRef = useRef<HTMLButtonElement>(null);
  const sideThreadRef = useRef(sideThread);
  sideThreadRef.current = sideThread;
  const endSideThread = useCallback(() => {
    const thread = sideThreadRef.current;
    if (!thread) return;
    sideThreadRef.current = undefined;
    setSideThread(undefined);
    void thread.end(thread.id).catch(() => undefined);
  }, []);
  useEffect(() => endSideThread, [endSideThread]);
  // The Preview agent's sheet: whether it is open persists across tasks; the
  // Preview renders the conversation into the sheet's slot.
  const [previewAgentOpen, setPreviewAgentOpen] = useState(() => {
    try { return storedPreviewAgentOpen(); } catch { return false; }
  });
  const [previewAgentFocus, setPreviewAgentFocus] = useState(false);
  const [previewAgentSlot, setPreviewAgentSlot] = useState<HTMLDivElement | null>(null);
  const previewAgentToggleRef = useRef<HTMLButtonElement>(null);
  const changePreviewAgentOpen = useCallback((open: boolean, focus = false) => {
    setPreviewAgentOpen(open);
    setPreviewAgentFocus(open && focus);
    try { persistPreviewAgentOpen(open); } catch { /* the preference is lost; the panel still works */ }
  }, []);
  // The page keeps at least 560px beside a docked panel; below that the panel floats over it.
  const sidePanelLayout = useTaskSidePanelLayout(560);
  const [agentHeaderVisible, setAgentHeaderVisible] = useState(true);
  const [markDoneModal, setMarkDoneModal] = useState<'clean' | 'issues'>();
  const [draftPrModalOpen, setDraftPrModalOpen] = useState(false);
  const [draftSettings, setDraftSettings] = useState<{ taskId: string; settings: AgentExecutionSettings }>();
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [draftPrTitle, setDraftPrTitle] = useState('');
  const [loadedReviewOutput, setLoadedReviewOutput] = useState<string>();
  const [reviewOutputLoading, setReviewOutputLoading] = useState(false);
  const [reviewOutputError, setReviewOutputError] = useState<string>();
  const [evidenceGitSnapshotId, setEvidenceGitSnapshotId] = useState<string | undefined>();
  const [reviewActionBusy, setReviewActionBusy] = useState(false);
  const [deliveryActionBusy, setDeliveryActionBusy] = useState(false);
  const [reviewStartPending, setReviewStartPending] = useState(false);
  const reviewActionInFlightRef = useRef(false);
  const deliveryActionInFlightRef = useRef(false);
  const detailRootRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const debugActivityRef = useRef<HTMLElement>(null);
  const focusActivityHistoryRef = useRef(false);
  const repositoryContextId = useId();
  const taskDetailModalOpen = Boolean(
    markDoneModal || draftPrModalOpen || previewModalOpen || existingWorkModal
  );
  const reviewGate = task ? taskReviewGate(task) : undefined;
  const reviewRun = reviewGate
    ? props.runs.find((candidate) => candidate.id === reviewGate.runId) ??
      props.runs.find(
        (candidate) =>
          candidate.mode === 'REVIEW' &&
          candidate.iterationId === task?.currentIterationId
      )
    : undefined;
  const reviewTextExcerpt = reviewRun
    ? (props.textExcerpts ?? []).find(
        (excerpt) =>
          excerpt.collection === 'runs' &&
          excerpt.recordId === reviewRun.id &&
          excerpt.fieldPath === 'finalMessage'
      )
    : undefined;
  const reviewIsRunning = reviewGate?.status === 'RUNNING';
  // Findings as they stand after the person's dismissals and the reviewer's revisions.
  const reviewFindingViews = useMemo<ReviewFindingView[]>(
    () => effectiveReviewFindings(reviewGate?.result, reviewGate?.findingDecisions ?? []),
    [reviewGate?.result, reviewGate?.findingDecisions]
  );
  const reviewPending = reviewStartPending && !reviewIsRunning;
  const headerState = task ? describeTaskStatus(task) : undefined;
  const prStatus = task
    ? buildPrStatusViewModel({
        task,
        worktree,
        gitSnapshot,
        branchPublication,
        pullRequest,
        ciRollup,
        reviewRollup,
        mergeSnapshot
      })
    : undefined;
  useLayoutEffect(() => {
    props.onModalOpenChange(taskDetailModalOpen);
  }, [props.onModalOpenChange, taskDetailModalOpen]);

  useLayoutEffect(
    () => () => {
      props.onModalOpenChange(false);
    },
    [props.onModalOpenChange]
  );

  useLayoutEffect(() => {
    focusRequestedActivityHistory(
      tab,
      focusActivityHistoryRef,
      debugActivityRef.current
    );
  }, [tab]);

  useEffect(() => {
    setExistingWorkModal(undefined);
    setReviewStartPending(false);
    setReviewNote('');
    setReviewComments([]);
    setReviewerOpen(false);
    setReviewerFocusId(undefined);
    setReviewerDraft('');
    endSideThread();
    setSideDraft('');
    setDraftPrModalOpen(false);
    setEvidenceGitSnapshotId(undefined);
  }, [task?.id]);

  // A renamed task offers its new title for a draft pull request; nothing else resets.
  useEffect(() => {
    setDraftPrTitle(task ? normalizePullRequestTitle(undefined, task.title) : '');
  }, [task?.id, task?.title]);

  useEffect(() => {
    setLoadedReviewOutput(undefined);
    setReviewOutputLoading(false);
    setReviewOutputError(undefined);
  }, [reviewRun?.id, reviewTextExcerpt?.originalByteCount]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [tab, task?.id]);

  // The Agent tab renders the task header inside its conversation, so changing
  // to or from it remounts the tablist. If the control that had focus went away
  // with it, keep the user oriented on the tab they just selected.
  const previousTabRef = useRef(tab);
  const renderedTabRef = useRef(tab);
  useEffect(() => { renderedTabRef.current = tab; }, [tab]);
  useLayoutEffect(() => {
    if (previousTabRef.current === tab) return;
    previousTabRef.current = tab;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      document.getElementById(`task-detail-tab-${tab}`)?.focus({ preventScroll: true });
    }
  }, [tab]);

  useEffect(() => {
    if (reviewIsRunning) {
      setReviewStartPending(false);
    }
  }, [reviewIsRunning]);

  useEffect(() => {
    if (!reviewStartPending) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setReviewStartPending(false);
    }, REVIEW_START_PENDING_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [reviewStartPending, task?.id]);

  // Every hook runs before the empty state below returns, so a task that
  // disappears while open never changes the hook order.
  const taskActivityLedger = useMemo(
    () => task
      ? buildTaskActivityLedger({
        task,
        events: props.events,
        runs: [...props.runs, ...(props.previewAgent?.runs ?? []), ...(props.reviewer?.records.runs ?? [])]
      })
      : undefined,
    [task, props.events, props.runs, props.previewAgent?.runs, props.reviewer?.records.runs]
  );
  const overviewActivity = useMemo(
    () => taskActivityLedger && projectOverviewTaskActivity(taskActivityLedger),
    [taskActivityLedger]
  );
  const debugActivity = useMemo(
    () => taskActivityLedger && projectDebugTaskActivity(taskActivityLedger),
    [taskActivityLedger]
  );
  const progressRun = selectProgressRun(run, props.runs);
  const progressTurn = useMemo(() => progressRun
    ? sessionTurn(progressRun, props.items, props.agentInstructions, { plans: planRevisions })
    : undefined, [progressRun, props.items, props.agentInstructions, planRevisions]);

  if (!task || !reviewGate || !headerState || !prStatus || !overviewActivity || !debugActivity) {
    return (
      <main className="tm-detail">
        <div className="tm-detail__body">
          <div className="tm-grid__empty">Select a task to inspect isolated evidence.</div>
        </div>
      </main>
    );
  }

  const executionSettings = draftSettings?.taskId === task.id ? draftSettings.settings : task.agentSettings;
  const startWithSettings = (taskId: string, instruction?: string) => props.onStart(taskId, instruction, executionSettings);
  const session = sessions.find((candidate) => candidate.id === run?.sessionId);
  const activeTurnSteeringSupported = Boolean(
    props.runtimeState &&
    projectAgentExecutionSupport(
      props.runtimeState.preflight.capabilities,
      'ACTIVE_TURN_STEERING'
    ).supported
  );
  const reviewActivity = buildReviewActivityViewModel({
    reviewRun,
    reviewRunning: reviewPending || reviewGate.status === 'RUNNING',
    useRunActivity: reviewGate.status === 'RUNNING',
    items: props.items
  });
  // The review run and projection remain historical display context. Starting
  // another review or review-derived follow-up always targets the exact current
  // completed implementation run, never the source of an older review. Imported
  // work in Review can also be reviewed before its first coding run.
  const actionableReviewSourceRun = findCompletedCurrentImplementationRun(
    task,
    props.runs
  );
  const externalWork = worktree?.ownership === 'EXTERNAL';
  const importedBeforeFirstRun = externalWork && !task.currentRunId;
  const externalReviewReady = canReviewExistingWork(task, worktree) && !gitSnapshot?.operationInProgress;
  const hasActionableReviewSource = Boolean(actionableReviewSourceRun) ||
    (externalReviewReady && ['IN_PROGRESS', 'REVIEW'].includes(task.workflowPhase));
  const hasHistoricalReviewContext =
    reviewRun?.mode === 'REVIEW' || reviewGate.status !== 'NOT_RUN';
  const activeImplementationRun = run && isActiveNonReviewRun(run) ? run : undefined;
  const reviewPauseReason: ReviewActionPauseReason | undefined = reviewIsRunning
    ? 'review-running'
    : reviewPending
      ? 'review-starting'
      : activeImplementationRun
        ? 'implementation-running'
        : undefined;
  const reviewActionsPausedReason: ReviewActionPauseReason | undefined =
    deliveryActionBusy ? 'delivery-running' : reviewPauseReason;
  const reviewActionsPaused = Boolean(reviewActionsPausedReason);
  const reviewHasOutput =
    Boolean(reviewGate.result) ||
    Boolean(
      reviewTextExcerpt?.availableContent.kind === 'BOUNDED_ARTIFACT' ||
      (!reviewTextExcerpt && reviewRun?.finalMessage?.trim())
    );
  const reviewHasActionableFindings =
    hasActionableReviewSource &&
    canRequestReviewChanges(reviewGate, reviewGate.status, reviewHasOutput);
  const deliverySourceRun =
    (task.currentRunId
      ? props.runs.find((candidate) => candidate.id === task.currentRunId && candidate.mode !== 'REVIEW')
      : undefined) ??
    props.runs.find(
      (candidate) =>
        candidate.mode !== 'REVIEW' &&
        candidate.iterationId === task.currentIterationId &&
        ['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
          candidate.status
        )
    );
  const prActionState = buildPrStatusActionState({
    view: prStatus,
    deliveryBusy: deliveryActionBusy,
    pauseReason: reviewPauseReason,
    implementationRetryReason: getImplementationRetryReason(task),
    hasInvestigationSource: Boolean(deliverySourceRun) || importedBeforeFirstRun
  });
  const overviewPreview = progressTurn ? conversationPreview(progressTurn) : undefined;
  const resultReport = progressTurn ? conversationAnswer(progressTurn) : undefined;
  const evidenceGitSnapshot = evidenceGitSnapshotId
    ? gitSnapshots.find((candidate) => candidate.id === evidenceGitSnapshotId)
    : gitSnapshot;
  const evidenceGitSnapshotIsHistorical = Boolean(
    evidenceGitSnapshotId && evidenceGitSnapshotId !== gitSnapshot?.id
  );

  const runReviewAction = async (action: () => Promise<void>) => {
    if (reviewActionInFlightRef.current) {
      return;
    }
    reviewActionInFlightRef.current = true;
    setReviewActionBusy(true);
    try {
      await action();
    } finally {
      reviewActionInFlightRef.current = false;
      setReviewActionBusy(false);
    }
  };

  const runDeliveryAction = async (action: () => Promise<void>) => {
    if (deliveryActionInFlightRef.current) {
      return;
    }
    deliveryActionInFlightRef.current = true;
    setDeliveryActionBusy(true);
    try {
      await action();
    } finally {
      deliveryActionInFlightRef.current = false;
      setDeliveryActionBusy(false);
    }
  };

  const runReview = async (sourceRunId?: string) => {
    if (reviewActionInFlightRef.current) {
      return;
    }
    setReviewStartPending(true);
    await runReviewAction(async () => {
      try {
        await props.onReview(sourceRunId);
      } catch {
        setReviewStartPending(false);
      }
    });
  };

  const loadAvailableReviewOutput = async (): Promise<string | undefined> => {
    if (loadedReviewOutput !== undefined) return loadedReviewOutput;
    if (reviewTextExcerpt?.availableContent.kind !== 'BOUNDED_ARTIFACT') {
      return reviewTextExcerpt ? undefined : reviewRun?.finalMessage;
    }
    if (!props.onReadArtifact) return undefined;
    setReviewOutputLoading(true);
    setReviewOutputError(undefined);
    try {
      const output = await props.onReadArtifact(
        reviewTextExcerpt.availableContent.artifactId
      );
      setLoadedReviewOutput(output);
      return output;
    } catch (caught) {
      setReviewOutputError(
        caught instanceof Error ? caught.message : 'Could not load review output.'
      );
      throw caught;
    } finally {
      setReviewOutputLoading(false);
    }
  };

  // Request changes lives in the Review tab, beside the findings it sends.
  const openRequestChanges = () => {
    setTab('review');
    window.requestAnimationFrame(() => {
      bodyRef.current?.querySelector<HTMLInputElement>('.tm-review__note input')?.focus();
    });
  };

  const submitRequestChanges = async () => {
    if (reviewActionsPaused || !hasActionableReviewSource) {
      return;
    }
    const open = reviewFindingViews.filter((finding) => finding.state === 'OPEN');
    if (open.length === 0 && reviewComments.length === 0 && !reviewHasActionableFindings) {
      return;
    }
    const dismissed = reviewFindingViews
      .filter((finding) => finding.state === 'DISMISSED')
      .map((finding) => ({ finding, note: finding.dismissal?.note }));
    let reviewOutput: string | undefined;
    if (open.length === 0 && reviewComments.length === 0) {
      try {
        reviewOutput = await loadAvailableReviewOutput();
      } catch {
        return;
      }
    }
    const instruction = buildReviewRequestInstruction({
      taskTitle: task.title,
      summary: reviewGate.result?.summary ?? reviewGate.summary,
      findings: open,
      dismissed,
      comments: reviewComments,
      note: reviewNote,
      reviewOutput
    });
    await runReviewAction(async () => {
      try {
        if (actionableReviewSourceRun) {
          await props.onContinue(actionableReviewSourceRun.id, instruction);
        } else {
          await startWithSettings(task.id, instruction);
        }
        setReviewNote('');
        setReviewComments([]);
      } catch {
        // The app shell reports the error; the note and comments stay for a retry.
      }
    });
  };

  const markDone = async () => {
    if (reviewActionsPaused) {
      return;
    }
    await runReviewAction(async () => {
      try {
        await props.onTransition(task.id, 'DONE');
        setMarkDoneModal(undefined);
      } catch {
        // The app shell reports the error. Keep the modal open so the user can retry.
      }
    });
  };

  const investigateFailingChecks = async () => {
    if ((!deliverySourceRun && !importedBeforeFirstRun) || !prStatus.canInvestigateFailure || prActionState.investigateDisabled) {
      return;
    }
    await runDeliveryAction(async () => {
      const instruction = buildFailingChecksInvestigationPrompt(prStatus);
      if (deliverySourceRun) await props.onContinue(deliverySourceRun.id, instruction);
      else await startWithSettings(task.id, instruction);
    });
  };

  const openDraftPrModal = () => {
    setDraftPrTitle(normalizePullRequestTitle(undefined, task.title));
    setDraftPrModalOpen(true);
  };

  const submitDraftPr = async (baseBranch?: string) => {
    const title = draftPrTitle.replace(/\s+/g, ' ').trim();
    if (!title || prActionState.createOrPushDisabled) {
      return;
    }
    await runDeliveryAction(async () => {
      await props.onCreatePullRequest(task.id, normalizePullRequestTitle(title, task.title), baseBranch);
      setDraftPrModalOpen(false);
    });
  };

  const stopReview = async (reviewRunId: string) => {
    await runReviewAction(async () => {
      await props.onCancel(reviewRunId);
    });
  };

  // Dispatch the rail's single recommended action to the existing handler for
  // its id, so the Next-action panel drives the same code paths the scattered
  // card/rail buttons used to.
  const onNextAction = (id: NextActionId) => {
    switch (id) {
      case 'run-review':
      case 'run-review-again':
        if (hasActionableReviewSource) {
          void runReview(actionableReviewSourceRun?.id);
        }
        return;
      case 'request-changes':
        openRequestChanges();
        return;
      case 'commit':
        void runDeliveryAction(async () => {
          await props.onCreateDeliveryCommit(task.id);
        });
        return;
      case 'mark-done':
        setMarkDoneModal('clean');
        return;
      case 'mark-done-anyway':
        setMarkDoneModal('issues');
        return;
      case 'move-to-review':
        void props.onTransition(task.id, 'REVIEW');
        return;
    }
  };

  const reviewActionPauseTitle = reviewActionsPausedReason
    ? {
        'review-starting': 'Review is starting.',
        'review-running': 'Review is running.',
        'implementation-running': 'Implementation is running.',
        'delivery-running': 'A delivery action is in progress.'
      }[reviewActionsPausedReason]
    : undefined;
  const taskActionBusyTitle = 'Another task action is in progress.';

  const nextActionState = (id: NextActionId): { disabled?: boolean; title?: string } => {
    const busy = reviewActionBusy || deliveryActionBusy;
    if (
      props.repository?.status !== 'AVAILABLE' &&
      ['run-review', 'run-review-again', 'request-changes', 'commit'].includes(id)
    ) {
      return {
        disabled: true,
        title: 'Reconnect this repository before running repository actions.'
      };
    }
    switch (id) {
      case 'run-review':
      case 'run-review-again': {
        const title = props.reviewDisabledReason ??
          (!hasActionableReviewSource
            ? importedBeforeFirstRun
              ? gitSnapshot?.operationInProgress
                ? 'Finish the current Git operation before starting review.'
                : 'Refresh or reconnect the checkout before starting review.'
              : 'Complete an implementation run before starting review.'
            : reviewActionPauseTitle ?? (busy ? taskActionBusyTitle : undefined));
        return {
          disabled: Boolean(title),
          title
        };
      }
      case 'request-changes': {
        const title = reviewActionPauseTitle ?? (
          reviewActionBusy ? 'A review action is in progress.' : undefined
        );
        return { disabled: Boolean(title), title };
      }
      case 'commit': {
        const title = !canCreateDeliveryCommit(task, worktree)
          ? 'A delivery commit is not available for the current tree.'
          : reviewActionPauseTitle ?? (busy ? taskActionBusyTitle : undefined);
        return { disabled: Boolean(title), title };
      }
      case 'mark-done':
      case 'mark-done-anyway': {
        const title = finishEvidence.mode === 'blocked'
          ? 'Finish requirements are still blocked.'
          : reviewActionPauseTitle ?? (busy ? taskActionBusyTitle : undefined);
        return { disabled: Boolean(title), title };
      }
      case 'move-to-review': {
        const title = busy ? taskActionBusyTitle : undefined;
        return { disabled: Boolean(title), title };
      }
      default:
        return {};
    }
  };

  const primaryAction = getPrimaryAction({
    task,
    worktreePreparationPending: props.worktreePreparationPending,
    worktree,
    onPrepareWorktree: props.onPrepareWorktree,
    onStart: externalWork ? async () => setExistingWorkModal('instruction') : async (taskId) => {
      setTab('agent'); await startWithSettings(taskId);
    }
  });
  const implementationRetryRequired = isImplementationRetryRequired(task, run);

  const headActions: HeadAction[] = [];
  const awaitingMoveToReview = shouldShowMoveToReviewHeaderAction(task, run);
  const directImportReview = importedBeforeFirstRun && task.workflowPhase === 'IN_PROGRESS';
  if (directImportReview) {
    headActions.push({
      label: reviewPending ? 'Starting review…' : 'Run agent review',
      ...nextActionState('run-review'),
      onClick: () => void runReview()
    });
  }

  const model =
    run?.observedSettings?.model ?? run?.requestedSettings.model ?? task.agentSettings.model ?? 'unknown';
  const effort =
    run?.observedSettings?.reasoningEffort ??
    run?.requestedSettings.reasoningEffort ??
    task.agentSettings.reasoningEffort ??
    'default';
  const displayedAgentSettings = run?.requestedSettings ?? task.agentSettings;

  const dirtyFileCount =
    (gitSnapshot?.stagedCount ?? 0) +
    (gitSnapshot?.unstagedCount ?? 0) +
    (gitSnapshot?.untrackedCount ?? 0);
  const finishMergeStatus = props.mergeSnapshot?.status ?? task.projection.merge;
  const finishCiStatus = props.ciRollup?.status ?? task.projection.ciChecks;
  const finishVerifiedChecksEvidence = {
    ciStatus: finishCiStatus,
    ciHeadSha: props.ciRollup?.headSha,
    ciPullRequestNumber: props.ciRollup?.pullRequestNumber,
    mergeHeadSha: props.mergeSnapshot?.headSha,
    mergePullRequestNumber: props.mergeSnapshot?.pullRequestNumber
  };
  const hasPullRequest = Boolean(
    props.pullRequest?.number ||
      props.pullRequest?.url ||
      task.projection.githubPullRequestNumber ||
      task.projection.githubPullRequestUrl
  );
  const finishEvidence = getFinishEvidenceState(
    task,
    effectiveReviewStatus(reviewGate),
    dirtyFileCount,
    finishMergeStatus,
    finishCiStatus,
    finishVerifiedChecksEvidence
  );
  const finishRequirements = finishRequirementsForTask(
    task,
    reviewPending ? 'RUNNING' : effectiveReviewStatus(reviewGate),
    dirtyFileCount,
    finishMergeStatus,
    finishCiStatus,
    finishVerifiedChecksEvidence
  );
  const runFailure = describeRunFailureBanner(task, run);

  // The single "what next" model for the rail. Kept in one place so the header,
  // run surface, and rail all agree instead of each inventing an action.
  const nextAction = selectNextAction({
    task,
    reviewStatus: reviewPending ? 'RUNNING' : effectiveReviewStatus(reviewGate),
    finishEvidence,
    hasReviewSource: hasActionableReviewSource,
    reviewHasActionableFindings,
    canCommit: canCreateDeliveryCommit(task, worktree),
    awaitingMoveToReview,
    runInFlight: Boolean(activeImplementationRun) || reviewPending,
    implementationRunStatus: run?.mode === 'REVIEW' ? undefined : run?.status,
    implementationRetryRequired
  });

  const detailHeadClassName = 'tm-detail__masthead';

  // The Overview's decision slot: one owner, chosen in PRODUCT_WORKFLOW's UI
  // priority, holds the step the task needs now (overviewDecision.ts).
  const pendingInteraction =
    interactions.find((item) => item.status === 'PENDING') ??
    interactions.find((item) => item.status === 'RESPONDING');
  const implementationRun = run && run.mode !== 'REVIEW' ? run : undefined;
  // The board card's word leads the page too. When it is the agent review
  // asking for action, finishing holds the Now panel even while a pull request
  // is open: the next step is the review's.
  const reviewWord = describeReviewGateWord(task);
  const reviewLeads =
    hasActionableReviewSource &&
    headerState.label === reviewWord.label &&
    (reviewWord.tone === 'action' || reviewWord.tone === 'error');
  const lifecycle = describeTaskLifecycle(task);
  // A status word that only restates the task's lane ("In review" in Review)
  // says nothing the lifecycle track does not; the step's own words lead then.
  const statusIsStage = stateRestatesColumn(
    headerState.label,
    lifecycle.find((step) => step.state === 'current')?.key
  );
  const recoveryRun =
    implementationRun &&
    (implementationRetryRequired ||
      ['FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(implementationRun.status))
      ? implementationRun
      : undefined;
  const decisionOwner = selectOverviewDecisionOwner({
    workflowPhase: task.workflowPhase,
    interactionPending: Boolean(pendingInteraction),
    recoveryRequired: Boolean(recoveryRun),
    runInFlight: Boolean(activeImplementationRun) || reviewIsRunning || reviewPending,
    checkoutUnavailable: Boolean(worktree && ['MISSING', 'PRUNABLE', 'ERROR'].includes(worktree.status)),
    deliveryOpen: prStatus.hasPullRequest && prStatus.kind !== 'MERGED' && !reviewLeads,
    finishRelevant:
      Boolean(nextAction.primary) ||
      nextAction.secondaries.length > 0 ||
      isReviewPhase(task.workflowPhase) ||
      awaitingMoveToReview,
    setupAvailable: Boolean(primaryAction)
  });
  const reviewInSlot = decisionOwner === 'running' && (reviewIsRunning || reviewPending);
  // Recovery and closed tasks have nothing to deliver; an unpublished PR card
  // there would offer to ship unfinished work.
  const prPlacement = selectPullRequestPlacement({
    owner: decisionOwner,
    prKind: prStatus.kind,
    overviewRelevant: shouldShowPrStatusOnOverview(prStatus),
    canCreateDraftPr: prStatus.canCreateDraftPr,
    workflowPhase: task.workflowPhase
  });
  const prSectionVisible = prPlacement.section;
  const finishSectionVisible =
    decisionOwner !== 'finish' &&
    decisionOwner !== 'closed' &&
    (Boolean(nextAction.primary) || nextAction.secondaries.length > 0);
  const runtimeName = props.runtimeState?.preflight.runtime.displayName ?? task.runtimeId;
  const repositoryBlockedReason =
    props.repository?.status !== 'AVAILABLE'
      ? 'Reconnect this repository before running repository actions.'
      : undefined;
  const runtimeBlockedReason =
    props.runtimeState && !props.runtimeState.preflight.readiness.canStart
      ? props.runtimeState.preflight.readiness.detail ?? props.runtimeState.preflight.readiness.summary
      : undefined;
  const conversationAction: SlotAction = { label: 'Open conversation', onClick: () => setTab('agent') };
  const startTaskAction = (action: () => Promise<void>) => () =>
    void runReviewAction(async () => {
      try {
        await action();
      } catch {
        // The app shell reports the error; the slot keeps the action available.
      }
    });

  const recoveryDecision = (recovery: RunRecord) => {
    const state = getPostRunActionState(recovery, implementationRetryRequired);
    const blocked =
      repositoryBlockedReason ?? runtimeBlockedReason ?? (reviewActionBusy ? taskActionBusyTitle : undefined);
    const retry: SlotAction | undefined = state.canRetry
      ? {
          label: 'Retry implementation',
          disabled: Boolean(blocked),
          reason: blocked,
          onClick: startTaskAction(() => props.onRetry(recovery.id, 'SAME_SESSION'))
        }
      : undefined;
    const resume: SlotAction | undefined = state.canContinue
      ? {
          label: 'Continue work',
          disabled: Boolean(blocked),
          reason: blocked,
          onClick: startTaskAction(() => props.onContinue(recovery.id))
        }
      : undefined;
    const [primary, other] = state.primaryRecoveryAction === 'retry' ? [retry, resume] : [resume, retry];
    return (
      <DecisionSlot>
        <SlotContent
          headline={runFailure?.title ?? 'Interrupted'}
          detail={runFailure?.detail}
          reported={runFailure?.reportedReason ? { source: runtimeName, text: runFailure.reportedReason } : undefined}
          primary={primary}
          secondary={[...(other ? [other] : []), conversationAction]}
        />
      </DecisionSlot>
    );
  };

  const runningDecision = () => {
    if (reviewIsRunning || reviewPending) {
      const reviewer =
        props.runtimes?.find((candidate) => candidate.preflight.runtime.id === reviewRun?.runtimeId)
          ?.preflight.runtime.displayName ?? runtimeName;
      const canStop = Boolean(reviewRun && reviewIsRunning);
      return (
        <DecisionSlot>
          <SlotContent
            headline={reviewPending ? 'Starting the agent review' : `${reviewer} is reviewing`}
            reported={!reviewPending && reviewActivity?.label ? { text: reviewActivity.label } : undefined}
            secondary={canStop ? [{
              label: 'Stop review',
              disabled: reviewActionBusy,
              reason: reviewActionBusy ? 'A review action is in progress.' : undefined,
              onClick: () => reviewRun && void stopReview(reviewRun.id)
            }] : []}
          />
        </DecisionSlot>
      );
    }
    const status = activeImplementationRun?.status;
    if (status === 'AWAITING_APPROVAL' || status === 'AWAITING_USER_INPUT') {
      // The run still waits, but its request was withdrawn or expired.
      return (
        <DecisionSlot>
          <SlotContent headline="Request no longer open" secondary={[conversationAction]} />
        </DecisionSlot>
      );
    }
    const headline =
      status === 'QUEUED' ? 'Queued'
        : status === 'STARTING' ? `${runtimeName} is starting`
          : status === 'INTERRUPTING' ? `Stopping ${runtimeName}`
            : `${runtimeName} is working`;
    return (
      <DecisionSlot>
        <SlotContent
          headline={headline}
          reported={overviewPreview ? { text: overviewPreview } : undefined}
          secondary={[conversationAction]}
        />
      </DecisionSlot>
    );
  };

  const checkoutDecision = (checkout: WorktreeRecord) => {
    const failed = checkout.status === 'ERROR';
    if (checkout.ownership === 'EXTERNAL') {
      const paused = reviewActionsPaused || reviewActionBusy;
      const reason = reviewActionPauseTitle ?? (reviewActionBusy ? taskActionBusyTitle : undefined);
      return (
        <DecisionSlot>
          <SlotContent
            headline={failed ? 'Checkout unavailable' : 'Checkout missing'}
            detail={checkout.error}
            primary={{
              label: 'Reconnect checkout',
              disabled: paused,
              reason,
              onClick: () => setExistingWorkModal('reconnect')
            }}
            secondary={[{
              label: 'Check again',
              disabled: paused,
              reason,
              onClick: () => void runReviewAction(async () => { await props.onRefreshEvidence?.(task.id); })
            }]}
          />
        </DecisionSlot>
      );
    }
    // Task Monki restores a missing or prunable task worktree in any open phase.
    const blocked = repositoryBlockedReason ?? reviewActionPauseTitle;
    return (
      <DecisionSlot>
        <SlotContent
          headline={failed ? 'Worktree setup failed' : 'Checkout missing'}
          detail={checkout.error}
          primary={{
            label: props.worktreePreparationPending ? 'Inspecting base…' : failed ? 'Retry worktree setup' : 'Restore worktree',
            disabled: props.worktreePreparationPending || Boolean(blocked),
            reason: blocked,
            onClick: () => void props.onPrepareWorktree(task.id)
          }}
        />
      </DecisionSlot>
    );
  };

  const setupDecision = (setup: NonNullable<typeof primaryAction>) => {
    const ready = worktree?.status === 'PRESENT';
    // A Git or delivery problem is the task's state: the slot names it in the
    // board card's word and says what it means here.
    const attention = describeTaskAttention(task);
    // Starting a run needs the runtime; preparing a worktree does not.
    const blocked = repositoryBlockedReason ?? (ready ? runtimeBlockedReason : undefined) ?? reviewActionPauseTitle;
    // A delivery problem PR Status states beside its own action is not repeated here.
    const prStatesProblem =
      prSectionVisible && (prActionState.createOrPushDisabled || Boolean(prStatus.leadLine || prStatus.freshnessLine));
    const attentionDetail = prStatesProblem ? undefined : attention?.detail;
    return (
      <DecisionSlot>
        <SlotContent
          headline={attention ? headerState.label : ready ? 'Worktree ready' : 'No worktree yet'}
          detail={attentionDetail}
          primary={{
            label: setup.label,
            disabled: setup.disabled || Boolean(blocked),
            reason: blocked,
            onClick: setup.onClick
          }}
          secondary={ready && !externalWork ? [{ label: 'Edit setup', onClick: () => setTab('agent') }] : []}
        />
      </DecisionSlot>
    );
  };

  const closedDecision = () => {
    const closure = describeTaskClosure(task, props.events);
    // The track already reads Canceled or Archived; the recorded reason is the news here.
    const closedHeadline = task.workflowPhase !== 'DONE' && closure?.detail ? closure.detail : closure?.label ?? 'Done';
    return (
      <DecisionSlot>
        <SlotContent
          headline={closedHeadline}
          detail={task.workflowPhase === 'DONE' ? closure?.detail : undefined}
          meta={closure?.at ? formatTaskActivityTimestamp(closure.at).label : undefined}
        />
      </DecisionSlot>
    );
  };

  const prStatusCard = (prominent: boolean, title?: string) => (
    <PrStatusCard
      view={prStatus}
      actionState={prActionState}
      prominent={prominent}
      title={title}
      onCreateDraftPr={() => openDraftPrModal()}
      onPushUpdate={() =>
        void runDeliveryAction(async () => {
          await props.onCreatePullRequest(task.id);
        })
      }
      onRefresh={() =>
        void runDeliveryAction(async () => {
          await props.onRefreshGitHub(task.id);
        })
      }
      onInvestigate={() => void investigateFailingChecks()}
    />
  );

  const reviewerName = reviewRun?.runtimeId
    ? props.runtimes?.find((candidate) => candidate.preflight.runtime.id === reviewRun.runtimeId)?.preflight.runtime.displayName ?? runtimeName
    : runtimeName;
  const reviewPanel = (
    <ReviewPanel
      reviewGate={reviewGate}
      reviewRun={reviewRun}
      gitSnapshot={gitSnapshot}
      reviewActivity={reviewActivity}
      actionBusy={reviewActionBusy}
      reviewPending={reviewPending}
      textExcerpt={reviewTextExcerpt}
      loadedReviewOutput={loadedReviewOutput}
      reviewOutputLoading={reviewOutputLoading}
      reviewOutputError={reviewOutputError}
      onLoadReviewOutput={() => void loadAvailableReviewOutput()}
      onStopReview={(reviewRunId) => void stopReview(reviewRunId)}
      showVerdict={!(decisionOwner === 'finish' && headerState.label === reviewWord.label)}
      onOpenReview={() => setTab('review')}
      reviewerName={reviewerName}
    />
  );

  const importStartAction: SlotAction | undefined =
    importedBeforeFirstRun && primaryAction
      ? {
          label: primaryAction.label,
          disabled: primaryAction.disabled || Boolean(runtimeBlockedReason),
          reason: runtimeBlockedReason,
          onClick: primaryAction.onClick
        }
      : undefined;
  // Before a pull request exists, opening one is a way to finish, so it sits
  // with the other finishing actions instead of in a PR section of its own.
  // What PR Status would have said, such as a failed push, comes with it.
  const createPrReason = prActionState.createOrPushDisabled ? prActionState.createOrPushReason : undefined;
  const createPrAction: SlotAction | undefined = prPlacement.createInNowPanel
    ? { label: 'Create draft PR', disabled: prActionState.createOrPushDisabled, reason: createPrReason, onClick: openDraftPrModal }
    : undefined;
  const createPrFacts = prPlacement.createInNowPanel
    ? [prStatus.freshnessLine, prStatus.leadLine, prStatus.guidanceLine].filter(
        (line): line is string => Boolean(line) && line !== createPrReason
      )
    : [];

  // Finishing is titled with the board card's word, unless that would only
  // repeat the lifecycle stage. With no review section on the page, the
  // review's absence is stated among its facts: it is why done is an override.
  const finishTitle = statusIsStage ? nextAction.title : headerState.label;
  const nowOffersConversation =
    decisionOwner === 'interaction' || decisionOwner === 'recovery' || (decisionOwner === 'running' && !reviewInSlot);
  // PR Status, when shown, already states merge and check evidence.
  const finishFacts = prSectionVisible
    ? finishRequirements.filter((requirement) => requirement.label !== 'Merge' && requirement.label !== 'Checks')
    : finishRequirements;
  const offersMarkDoneAnyway = [nextAction.primary, ...nextAction.secondaries].some(
    (choice) => choice?.id === 'mark-done-anyway'
  );

  const decision = (() => {
    switch (decisionOwner) {
      case 'closed':
        return closedDecision();
      case 'interaction':
        return pendingInteraction ? (
          <InteractionDecision
            interaction={pendingInteraction}
            worktreePath={worktree?.worktreePath}
            agentName={runtimeName}
            onRespond={props.onRespondToInteraction}
            onOpenConversation={() => {
              setTab('agent');
              setAgentAttentionRequest((value) => value + 1);
            }}
          />
        ) : null;
      case 'recovery':
        return recoveryRun ? recoveryDecision(recoveryRun) : null;
      case 'running':
        return runningDecision();
      case 'checkout':
        return worktree ? checkoutDecision(worktree) : null;
      case 'delivery':
        return <DecisionSlot>{prStatusCard(true, statusIsStage ? prStatus.headline : headerState.label)}</DecisionSlot>;
      case 'finish':
        return (
          <DecisionSlot>
            <NextActionPanel
              placement="slot"
              model={nextAction}
              title={finishTitle}
              requirements={finishFacts}
              showReviewFact={!hasHistoricalReviewContext && offersMarkDoneAnyway}
              extraFacts={createPrFacts}
              onAction={onNextAction}
              actionState={nextActionState}
              extraActions={[importStartAction, createPrAction].filter((action): action is SlotAction => Boolean(action))}
            />
          </DecisionSlot>
        );
      case 'setup':
        return primaryAction ? setupDecision(primaryAction) : null;
      default:
        return null;
    }
  })();

  const detailsRows = (
    <dl className="tm-props">
      <PropRow label="Agent" value={runtimeName} />
      {/* A setting's companion (effort, network) follows it in muted ink. */}
      <PropRow label="Model" value={<>{model === 'unknown' ? 'Default' : model}
        <span className="tm-props__sub">{humanizeEnum(effort)} effort</span></>} />
      <PropRow label="Access" value={<>{formatAgentPermissionMode(displayedAgentSettings)}
        <span className="tm-props__sub">Network {isAgentNetworkAccessEnabled(displayedAgentSettings) ? 'on' : 'off'}</span></>} />
      {worktree ? (
        <PropRow
          label={externalWork ? 'Compared to' : 'Base'}
          value={<>{worktree.baseRef ?? 'Detached HEAD'} <code title={worktree.baseSha}>{worktree.baseSha.slice(0, 7)}</code></>}
        />
      ) : null}
      {/* The branch is in the page header. */}
      {externalWork && worktree ? (
        <PropRow label="Checkout" value={<code title={worktree.worktreePath}>{worktree.worktreePath}</code>} />
      ) : null}
    </dl>
  );
  const repositoryUnavailable = props.repository && props.repository.status !== 'AVAILABLE';
  const taskMasthead = (
      <div
        className={detailHeadClassName}
        inert={taskDetailModalOpen ? true : undefined}
        aria-hidden={taskDetailModalOpen ? true : undefined}
      >
        <div className="tm-detail__row">
          <h1 ref={props.headingRef} className="tm-detail__title" tabIndex={-1}>
            {task.title}
          </h1>
          <div className="tm-detail__titleactions">
            {/* Header actions reach the same steps from every other tab. */}
            {tab !== 'overview'
              ? headActions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className="outline-button"
                    disabled={action.disabled}
                    title={action.title}
                    aria-describedby={repositoryUnavailable ? repositoryContextId : undefined}
                    onClick={action.onClick}
                  >
                    {action.label}
                  </button>
                ))
              : null}
            <TaskActionsMenu
              taskId={task.id}
              title={task.title}
              archived={task.workflowPhase === 'ARCHIVED'}
              openTarget={
                worktree
                  ? { type: 'worktree', worktreeId: worktree.id, taskId: task.id }
                  : { type: 'repository', repositoryId: task.repositoryId }
              }
              onArchive={props.onArchive}
              onRequestDelete={props.onRequestDelete}
              onOpenDebug={() => setTab('debug')}
              className="tm-detail__taskmenu"
              align="end"
            />
          </div>
        </div>
        <div className="tm-detail__context">
          <TaskLifecycleTrack steps={lifecycle} />
          <div id={repositoryContextId} className="tm-detail__meta">
            <span className="tm-detail__repo">
              <FolderGit2 size={13} aria-hidden="true" />
              <span>{props.repository?.name ?? 'Unknown repository'}</span>
              {repositoryUnavailable ? (
                <span className="tm-detail__repostate">{humanizeEnum(props.repository!.status)}</span>
              ) : null}
            </span>
            {worktree?.branchName ? (
              <span className="tm-detail__branch" title={worktree.branchName}>
                <GitBranch size={13} aria-label="Branch" />
                <code>{worktree.branchName}</code>
              </span>
            ) : null}
          </div>
          {/* The Overview's Now panel and the Agent tab hold the request itself. */}
          {pendingInteraction && tab !== 'overview' && tab !== 'agent' ? (
            <button type="button" className="tm-detail__attention" onClick={() => {
              setTab('agent'); setAgentAttentionRequest((value) => value + 1);
            }}>Go to request</button>
          ) : null}
        </div>
        {awaitingMoveToReview && tab !== 'overview' ? (
          <NextActionPanel
            model={nextAction}
            requirements={[]}
            onAction={onNextAction}
            actionState={nextActionState}
            placement="task"
          />
        ) : null}
      </div>
  );
  const reviewerAvailable = Boolean(
    props.reviewer && reviewGate.runId && reviewGate.status !== 'RUNNING' && reviewGate.status !== 'NOT_RUN'
  );
  const reviewerPanel = tab === 'review' && reviewerOpen && reviewerAvailable && props.reviewer && reviewGate.runId ? (
    <ReviewerPanel
      conversation={props.reviewer}
      reviewerName={reviewerName}
      reviewRunId={reviewGate.runId}
      stale={reviewGate.status === 'STALE'}
      findings={reviewFindingViews}
      decisions={reviewGate.findingDecisions ?? []}
      focusFinding={reviewFindingViews.find((finding) => finding.id === reviewerFocusId)}
      onClearFocus={() => setReviewerFocusId(undefined)}
      draft={reviewerDraft}
      onDraftChange={setReviewerDraft}
      onRunReviewAgain={hasActionableReviewSource ? () => void runReview(actionableReviewSourceRun?.id) : undefined}
      onClose={() => setReviewerOpen(false)}
      returnFocusRef={reviewerToggleRef}
      docked={sidePanelLayout.docked}
      autoFocus
    />
  ) : null;
  const runtimeUnavailable = props.runtimeState && !props.runtimeState.preflight.readiness.canStart
    ? props.runtimeState.preflight.readiness.detail ?? props.runtimeState.preflight.readiness.summary
    : undefined;
  // A side question that reads the live worktree, because nothing was writing
  // it when asked, holds other agent work until it finishes.
  const sideQuestionHoldsWorktree = Boolean(props.sideQuestion?.records.runs.some((sideRun) =>
    isActiveRunStatus(sideRun.status) && runHoldsTaskWorktree(sideRun, props.sideQuestion!.records.instructions)));
  // A side question is about work in progress: it needs the worktree and a run.
  const sideQuestionAvailable = Boolean(props.sideQuestion && worktree && run);
  const sideQuestionPanel = tab === 'agent' && sideThread && sideQuestionAvailable && props.sideQuestion ? (
    <SideQuestionPanel
      conversation={props.sideQuestion}
      defaultModel={props.sideQuestion.defaultModel ?? {
        runtimeId: task.runtimeId,
        model: task.agentSettings?.model,
        modelProvider: task.agentSettings?.modelProvider,
        reasoningEffort: task.agentSettings?.reasoningEffort
      }}
      models={props.models ?? props.runtimeState?.models ?? []}
      runtimes={props.runtimes ?? (props.runtimeState ? [props.runtimeState] : [])}
      onDiscoverModels={props.onDiscoverAgentRuntimeModels}
      threadId={sideThread.id}
      implementationActive={Boolean(activeImplementationRun)}
      draft={sideDraft}
      onDraftChange={setSideDraft}
      onUseInFollowUp={(text) => {
        props.onAgentDraftChange(appendToDraft(props.agentDraft, text));
        document.getElementById(`agent-draft-${task.id}`)?.focus({ preventScroll: true });
      }}
      onClose={endSideThread}
      returnFocusRef={sideToggleRef}
      docked={sidePanelLayout.docked}
      autoFocus
    />
  ) : null;
  // One assistant panel per tab: the reviewer on Review, side questions on
  // Agent, the Preview agent on Preview (rendered into this slot by the Preview).
  const previewAgentSheet = tab === 'preview' && previewAgentOpen && props.previewAgent
    ? <div ref={setPreviewAgentSlot} className="tm-side-sheet__slot" />
    : null;
  const sidePanel = reviewerPanel
    ? { label: 'Reviewer', element: reviewerPanel }
    : sideQuestionPanel ? { label: 'Side question', element: sideQuestionPanel }
    : previewAgentSheet ? { label: 'Preview agent', element: previewAgentSheet } : undefined;
  // With a side panel docked, the page keeps only its tab bar, which then shares
  // the panel head's 48px line; the title moves to the window's top bar.
  const headCollapsed = Boolean(sidePanel) && sidePanelLayout.docked;
  const titleOutOfView = headCollapsed || (tab === 'agent' && !agentHeaderVisible);
  // The title moves between the page and the top bar only when a panel opens or
  // closes, or the conversation scrolls; a tab opening shows its head as it is.
  const tabJustOpened = renderedTabRef.current !== tab;

  const taskNav = (
        <div className="tm-detail__nav" inert={taskDetailModalOpen ? true : undefined} aria-hidden={taskDetailModalOpen ? true : undefined}>
        <div className="tm-tabs" role="tablist" aria-label="Task sections">
          <AccessibleTab
            id="task-detail-tab-overview"
            panelId="task-detail-panel"
            label="Overview"
            selected={tab === 'overview'}
            onSelect={() => setTab('overview')}
          />
          <AccessibleTab id="task-detail-tab-agent" panelId="task-detail-panel" label="Agent"
            selected={tab === 'agent'} onSelect={() => setTab('agent')} />
          <AccessibleTab
            id="task-detail-tab-review"
            panelId="task-detail-panel"
            label="Review"
            selected={tab === 'review'}
            onSelect={() => {
              setEvidenceGitSnapshotId(undefined);
              setTab('review');
            }}
          />
          <AccessibleTab
            id="task-detail-tab-preview"
            panelId="task-detail-panel"
            label="Preview"
            selected={tab === 'preview'}
            onSelect={() => setTab('preview')}
          />
          {/* Debug opens from the task menu and from History; it joins the bar only while open. */}
          {tab === 'debug' ? (
            <AccessibleTab
              id="task-detail-tab-debug"
              panelId="task-detail-panel"
              label="Debug"
              selected
              onSelect={() => setTab('debug')}
            />
          ) : null}
        </div>
        {tab === 'review' && reviewerAvailable ? (
          <button
            ref={reviewerToggleRef}
            type="button"
            className="tm-detail__assistant"
            aria-pressed={reviewerOpen}
            onClick={() => setReviewerOpen((open) => !open)}
          >
            <AgentMark />
            Ask reviewer
          </button>
        ) : null}
        {tab === 'agent' && sideQuestionAvailable ? (
          <button
            ref={sideToggleRef}
            type="button"
            className="tm-detail__assistant"
            aria-pressed={Boolean(sideThread)}
            onClick={() => (sideThread || !props.sideQuestion
              ? endSideThread()
              : setSideThread({ id: crypto.randomUUID(), end: props.sideQuestion.end }))}
          >
            <AgentMark />
            Side question
          </button>
        ) : null}
        {tab === 'preview' && props.previewAgent ? (
          <button
            ref={previewAgentToggleRef}
            type="button"
            className="tm-detail__assistant"
            aria-pressed={previewAgentOpen}
            onClick={() => changePreviewAgentOpen(!previewAgentOpen, true)}
          >
            <AgentMark />
            Preview agent
            {!previewAgentOpen && props.previewAgent.runs.some((agentRun) => isActiveRunStatus(agentRun.status))
              ? <span className="tm-detail__assistant-dot" role="img" aria-label="Working" />
              : null}
          </button>
        ) : null}
      </div>
  );

  // With a side panel docked the masthead folds away rather than vanishing, while
  // the title rises into the window's top bar; closing the panel reverses both.
  const collapsibleMasthead = (
    <div className="tm-detail__fold" data-collapsed={headCollapsed ? '' : undefined}
      data-instant={tabJustOpened ? '' : undefined} inert={headCollapsed ? true : undefined}
      data-conversation-collapse={headCollapsed ? undefined : ''}>
      <div className="tm-detail__fold-inner">{taskMasthead}</div>
    </div>
  );

  return (
    <>
    <CompactTitle title={titleOutOfView ? task.title : undefined} animate={!tabJustOpened} onChange={props.onCompactTitleChange} />
    <main ref={detailRootRef} className={`tm-detail tm-detail--${tab}`} tabIndex={-1}>
      {tab !== 'agent' ? <div className="tm-detail__chrome">{collapsibleMasthead}{taskNav}</div> : null}

      <div
        id="task-detail-panel"
        className={`tm-detail__body${tab === 'agent' || tab === 'preview' || tab === 'review' ? ` tm-detail__body--${tab}` : ''}`}
        ref={bodyRef}
        role="tabpanel"
        aria-labelledby={`task-detail-tab-${tab}`}
        inert={taskDetailModalOpen ? true : undefined}
        aria-hidden={taskDetailModalOpen ? true : undefined}
      >
        {error ? <div className="tm-error">{error}</div> : null}

        {tab === 'overview' ? (
          <div className="tm-overview">
            {/* The story: the step the task needs now, what was asked, what came of it. */}
            <div className="tm-overview__main">
              <TaskWorkPanels>
                {decision}
                {requestRepeatsTitle(task) && props.attachments.length === 0 ? null : (
                  <OverviewRequest prompt={task.prompt} attachments={props.attachments} />
                )}
                {/* A run's result is what a completed run left behind; a running one has none yet. */}
                {progressRun?.status === 'COMPLETED' ? (
                  <OverviewSection
                    title="Result"
                    aside={
                      // The Now panel already offers the conversation while it holds a run's step.
                      nowOffersConversation ? undefined : (
                        <button type="button" className="tm-osection__link" onClick={() => setTab('agent')}>
                          Open conversation
                        </button>
                      )
                    }
                  >
                    {resultReport ? (
                      <figure className="tm-oresult__report">
                        <figcaption>{runtimeName}</figcaption>
                        <blockquote>{resultReport}</blockquote>
                      </figure>
                    ) : null}
                    <CompletedChangeSummaryPanel compact run={progressRun}
                      capturePending={props.postRunEvidencePendingRunIds?.includes(progressRun.id)} gitSnapshots={gitSnapshots} artifacts={props.artifacts}
                      onViewDiff={(snapshotId) => { setEvidenceGitSnapshotId(snapshotId); setTab('review'); }} />
                  </OverviewSection>
                ) : null}
                {/* The Now panel offers a first review; a section appears once one exists. */}
                {hasHistoricalReviewContext && !reviewInSlot ? reviewPanel : null}
                {prSectionVisible ? prStatusCard(false) : null}
                {finishSectionVisible ? (
                  <NextActionPanel
                    placement="section"
                    model={nextAction}
                    requirements={finishRequirements}
                    onAction={onNextAction}
                    actionState={nextActionState}
                  />
                ) : null}
              </TaskWorkPanels>
            </div>

            {/* The record: how the task runs, its preview, and what happened. */}
            <div className="tm-overview__side">
              <h2 className="tm-visually-hidden">Details and history</h2>
              <OverviewSection
                title="Details"
                inset
                aside={externalWork && worktree?.status === 'PRESENT' ? (
                  <button type="button" className="tm-osection__link"
                    disabled={reviewActionsPaused || reviewActionBusy}
                    title={reviewActionPauseTitle ?? (reviewActionBusy ? taskActionBusyTitle : undefined)}
                    onClick={() => void runReviewAction(async () => { await props.onRefreshEvidence?.(task.id); })}>
                    Refresh checkout
                  </button>
                ) : undefined}
              >
                {detailsRows}
              </OverviewSection>
              {worktree?.status === 'PRESENT' ? (
                <ApplicationPreviewOverview key={task.id} taskId={task.id} onOpen={() => setTab('preview')} onNotify={props.onNotify} />
              ) : null}
              <TaskActivityPanel
                view={overviewActivity}
                variant="overview"
                onViewAll={() => {
                  focusActivityHistoryRef.current = true;
                  setTab('debug');
                }}
              />
            </div>
          </div>
        ) : null}

        {tab === 'agent' ? <AgentSession key={task.id} task={task} run={run} runs={props.runs} worktreePath={worktree?.worktreePath}
          attachmentOptions={props.attachmentOptions} attachments={props.attachments} onReadAttachment={props.onReadAttachment}
          runtimeName={props.runtimeState?.preflight.runtime.displayName}
          sessions={sessions} items={props.items} plans={planRevisions} interactions={interactions}
          instructions={props.agentInstructions} requiresRecovery={implementationRetryRequired} failure={runFailure}
          runtimeUnavailable={runtimeUnavailable}
          steeringSupported={activeTurnSteeringSupported} draft={props.agentDraft} draftError={props.agentDraftError}
          worktreeHeld={sideQuestionHoldsWorktree ? 'Wait for the side question to finish, or stop it.' : undefined}
          onDraftChange={props.onAgentDraftChange} onFlushDraft={props.onFlushAgentDraft}
          onQueue={props.onQueueInstruction} onEditQueue={props.onEditInstruction} onSendQueue={props.onSendInstruction}
          onSteer={props.onSteer} onContinue={props.onContinue} onRetry={props.onRetry} onStop={props.onCancel}
          onRespond={props.onRespondToInteraction} onReadArtifact={props.onReadArtifact}
          onShowDebug={() => setTab('debug')} onShowReview={() => setTab('review')}
          attentionRequested={agentAttentionRequest} header={<div className="tm-detail__chrome">{collapsibleMasthead}{taskNav}</div>}
          onHeaderVisibleChange={setAgentHeaderVisible}
          preRun={!run ? <PreRunSetup
            prompt={task.prompt}
            promptDraft={task.promptDraft}
            onSavePrompt={props.onSavePrompt}
            attachmentOptions={props.attachmentOptions}
            onReadAttachment={props.onReadAttachment}
            attachments={props.attachments.filter((file) => task.initialAttachmentIds?.includes(file.id))}
            runtimeId={task.runtimeId}
            settings={executionSettings}
            models={props.models ?? props.runtimeState?.models ?? []}
            runtimes={props.runtimes ?? (props.runtimeState ? [props.runtimeState] : [])}
            disabled={Boolean(primaryAction?.disabled)}
            action={primaryAction ? {
              label: primaryAction.label,
              disabled: primaryAction.disabled || reviewActionsPaused || props.repository?.status !== 'AVAILABLE',
              title: props.repository?.status !== 'AVAILABLE'
                ? 'Reconnect this repository before running repository actions.'
                : undefined,
              onClick: primaryAction.onClick
            } : undefined}
            onSettingsChange={(settings) => setDraftSettings({ taskId: task.id, settings })}
            onDiscoverModels={props.onDiscoverAgentRuntimeModels}
          /> : null}
          capture={(capturedRun) => captureRunIds.has(capturedRun.id) ? <CompletedChangeSummaryPanel compact run={capturedRun}
            capturePending={props.postRunEvidencePendingRunIds?.includes(capturedRun.id)} gitSnapshots={gitSnapshots} artifacts={props.artifacts}
            onViewDiff={(snapshotId) => { setEvidenceGitSnapshotId(snapshotId); setTab('review'); }} /> : null}
        /> : null}

        {tab === 'preview' ? <ApplicationPreviewPanel key={task.id} taskId={task.id} projectName={props.repository?.name} onNotify={props.onNotify}
          worktree={worktree} worktreePending={props.worktreePreparationPending} onModalOpenChange={setPreviewModalOpen}
          onRestoreWorktree={() => props.onRestoreWorktree(task.id)}
          onPrepareWorktree={() => props.onPrepareWorktree(task.id)}
          onReconnectCheckout={() => setExistingWorkModal('reconnect')}
          onTaskAgent={async text => {
            await props.onPrepareTaskAgent(text);
            setTab('agent');
            setAgentAttentionRequest(value => value + 1);
          }}
          agent={props.previewAgent} proposals={props.previewProposals}
          agentHost={{
            open: previewAgentOpen,
            onOpenChange: changePreviewAgentOpen,
            slot: previewAgentSlot,
            docked: sidePanelLayout.docked,
            autoFocus: previewAgentFocus,
            toggleRef: previewAgentToggleRef
          }} /> : null}

        {tab === 'review' ? (
          <ReviewWorkspace
            key={task.id}
            taskId={task.id}
            review={reviewGate.status === 'NOT_RUN' ? undefined : { status: reviewGate.status, reviewedAt: reviewGate.updatedAt }}
            findings={reviewFindingViews}
            currentDiffArtifactId={evidenceGitSnapshot?.diffArtifactId}
            reviewedDiffArtifactId={reviewGate.status === 'STALE'
              ? gitSnapshots.find((candidate) => candidate.id === reviewGate.reviewedGitSnapshotId)?.diffArtifactId
              : undefined}
            historical={evidenceGitSnapshotIsHistorical ? {
              capturedAt: evidenceGitSnapshot?.capturedAt,
              headSha: evidenceGitSnapshot?.headSha,
              onBack: () => setEvidenceGitSnapshotId(undefined)
            } : undefined}
            artifacts={props.artifacts}
            worktree={worktree}
            comparison={externalWork && worktree ? {
              label: `${worktree.baseRef} · ${worktree.baseSha.slice(0, 8)}`,
              onChange: () => setExistingWorkModal('comparison'),
              disabledReason: reviewActionPauseTitle ?? (reviewActionBusy ? taskActionBusyTitle : undefined)
            } : undefined}
            comments={reviewComments}
            onCommentsChange={setReviewComments}
            note={reviewNote}
            onNoteChange={setReviewNote}
            requestChanges={hasActionableReviewSource && reviewGate.status !== 'STALE' && !reviewIsRunning && !reviewPending ? {
              disabledReason: reviewActionsPaused ? reviewActionPauseTitle : undefined,
              busy: reviewActionBusy,
              reviewNotes: reviewHasActionableFindings && reviewFindingViews.length === 0,
              onSubmit: () => void submitRequestChanges()
            } : undefined}
            onDismissFinding={props.onDecideReviewFinding && reviewGate.runId ? (findingId, note) => props.onDecideReviewFinding!({
              taskId: task.id, reviewRunId: reviewGate.runId!, findingId, kind: 'DISMISS', note
            }) : undefined}
            onRestoreFinding={props.onDecideReviewFinding && reviewGate.runId ? (findingId) => props.onDecideReviewFinding!({
              taskId: task.id, reviewRunId: reviewGate.runId!, findingId, kind: 'RESTORE'
            }) : undefined}
            onAskAboutFinding={reviewerAvailable ? (findingId) => {
              setReviewerFocusId(findingId);
              setReviewerOpen(true);
            } : undefined}
            runReview={hasActionableReviewSource && (reviewGate.status === 'NOT_RUN' || reviewGate.status === 'STALE' || reviewGate.status === 'FAILED' || reviewGate.status === 'CANCELED') ? {
              label: reviewGate.status === 'NOT_RUN' ? 'Run review' : 'Run review again',
              disabledReason: reviewActionsPaused ? reviewActionPauseTitle : undefined,
              busy: reviewActionBusy || reviewPending,
              onRun: () => void runReview(actionableReviewSourceRun?.id)
            } : undefined}
          />
        ) : null}

        {tab === 'debug' ? (
          <div className="tm-debug">
            <TaskActivityPanel
              view={debugActivity}
              variant="debug"
              rawEvents={props.events}
              rootRef={debugActivityRef}
            />
            <TaskHealthFindings findings={task.projection.findings} />
            <div className="tm-debug__notice">
              Provider diagnostics are for troubleshooting. Verified evidence remains the source of truth.
            </div>
            <SubagentHierarchyPanel
              sessions={sessions}
              runs={props.runs}
              items={props.items}
              interactions={interactions}
              observations={props.subagentObservations}
            />
            <ProviderActivityPanel
              runs={props.runs}
              sessions={sessions}
              items={props.items}
              planRevisions={planRevisions}
              interactions={interactions}
              events={props.events}
            />
            <ProviderOverviewPanel
              task={task}
              run={run}
              session={session}
              goalSnapshots={props.goalSnapshots}
              usageSnapshots={props.usageSnapshots}
              settingsObservations={props.settingsObservations}
              runtimeState={props.runtimeState}
              server={props.server}
              onSyncGoal={props.onSyncAgentGoal}
              onUpdateNativeSession={props.onUpdateAgentNativeSession}
            />
            <InteractionAuditPanel interactions={interactions} sessions={sessions} />
          </div>
        ) : null}
      </div>


      {existingWorkModal && worktree && props.onListExistingWorktrees ? (
        <ExistingWorkModal key={`${task.id}:${existingWorkModal}`} mode={existingWorkModal} worktree={worktree}
          onListCheckouts={props.onListExistingWorktrees}
          onCancel={() => setExistingWorkModal(undefined)} fallbackReturnFocusRef={detailRootRef}
          onSubmit={async (value) => {
            if (existingWorkModal === 'instruction') await startWithSettings(task.id, value);
            else if (existingWorkModal === 'comparison') await props.onUpdateWorktreeComparison?.(task.id, value);
            else await props.onReconnectWorktree?.(task.id, value);
          }} />
      ) : null}

      {markDoneModal ? (
        <MarkDoneModal
          withIssues={markDoneModal === 'issues'}
          warnings={markDoneModal === 'issues' ? finishEvidence.warnings : []}
          hasPullRequest={hasPullRequest}
          requirements={
            markDoneModal === 'issues'
              ? finishRequirements.filter((requirement) => requirement.unresolved)
              : []
          }
          busy={reviewActionBusy}
          onCancel={() => setMarkDoneModal(undefined)}
          onConfirm={() => void markDone()}
          fallbackReturnFocusRef={detailRootRef}
        />
      ) : null}

      {draftPrModalOpen ? (
        <CreateDraftPrModal
          title={draftPrTitle}
          worktree={worktree}
          busy={deliveryActionBusy}
          disabled={prActionState.createOrPushDisabled}
          disabledReason={prActionState.createOrPushReason}
          onTitleChange={setDraftPrTitle}
          onCancel={() => setDraftPrModalOpen(false)}
          onSubmit={submitDraftPr}
          fallbackReturnFocusRef={detailRootRef}
        />
      ) : null}

      {sidePanel && !sidePanelLayout.docked ? <FloatingSidePanel>{sidePanel.element}</FloatingSidePanel> : null}
    </main>
    {sidePanel && sidePanelLayout.docked ? (
      <DockedSidePanel width={sidePanelLayout.width} maxWidth={sidePanelLayout.maxWidth} onWidthChange={sidePanelLayout.setWidth} label={sidePanel.label}>{sidePanel.element}</DockedSidePanel>
    ) : null}
    </>
  );
}

/** Gives the window's top bar the task title while the page's own title is out of view. */
/** Reports the top bar's title, and whether its change should be animated. */
function CompactTitle({ title, animate, onChange }: { title?: string; animate: boolean; onChange?(title: string | undefined, animate: boolean): void }) {
  useEffect(() => {
    onChange?.(title, animate);
  }, [onChange, title, animate]);
  useEffect(() => () => onChange?.(undefined, false), [onChange]);
  return null;
}

export function TaskWorkPanels({ children }: { children: ReactNode }) {
  return (
    <section className="tm-workpanels" aria-labelledby="task-work-panels-title">
      <h2 id="task-work-panels-title" className="tm-visually-hidden">
        Current work
      </h2>
      {children}
    </section>
  );
}

function PropRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="tm-props__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** A request that only restates the title adds nothing beneath it. */
function requestRepeatsTitle(task: Task): boolean {
  const normalize = (value: string) =>
    value.replace(/\s+/gu, ' ').trim().replace(/[.!]+$/u, '').toLocaleLowerCase();
  const prompt = normalize(task.prompt);
  return !prompt || prompt === normalize(task.title);
}

/**
 * The one place a task answers "what should I do next?": a factual title, the
 * Git and GitHub facts that bear on finishing, then the actions. In the Now
 * panel its primary leads the page; as a section beside PR Status its actions
 * stay quiet; above the tabs it carries task-level transitions to other tabs.
 */
export function NextActionPanel({
  model,
  title = model.title,
  requirements,
  showReviewFact = false,
  extraFacts = [],
  onAction,
  actionState,
  placement = 'slot',
  extraActions = []
}: {
  model: NextActionModel;
  /** The step's title; the Overview passes the board card's word for the task. */
  title?: string;
  requirements: FinishRequirement[];
  /** State the review requirement too, when no review section on the page does. */
  showReviewFact?: boolean;
  /** Facts owned elsewhere that bear on these actions, such as a failed push. */
  extraFacts?: string[];
  onAction(id: NextActionId): void;
  actionState(id: NextActionId): { disabled?: boolean; title?: string };
  placement?: 'task' | 'slot' | 'section';
  /** Steps owned elsewhere that belong beside these, such as starting imported work. */
  extraActions?: SlotAction[];
}) {
  const toAction = (choice: NonNullable<NextActionModel['primary']>): SlotAction => {
    const state = actionState(choice.id);
    return {
      label: choice.label,
      disabled: state.disabled,
      reason: state.disabled ? state.title : undefined,
      onClick: () => onAction(choice.id)
    };
  };
  // The agent review states its own verdict in its section; these facts are
  // what Git and GitHub say. None repeats the title, and as a section beside
  // PR Status, which already states Git and GitHub, there are none.
  const facts = placement === 'section' ? [] : [
    ...requirements
      .filter((requirement) => showReviewFact || requirement.label !== 'Review')
      .map((requirement) => ({
        key: requirement.label,
        text: requirement.fact,
        tone: requirement.unresolved ? requirement.tone : undefined
      })),
    ...extraFacts.map((text) => ({ key: text, text, tone: 'action' as const }))
  ].filter((fact) => fact.text !== title);
  const body = (
    <>
      {/* As a section the label already names it; the title would restate the Now panel. */}
      {placement === 'slot' ? (
        <h3 className="tm-slot__headline">{title}</h3>
      ) : placement === 'task' ? (
        <p className="tm-nextaction__title">{title}</p>
      ) : null}
      {placement !== 'task' && facts.length > 0 ? (
        <ul className="tm-facts" aria-label="Finish requirements">
          {facts.map((fact) => (
            <li key={fact.key} className={`tm-facts__item${fact.tone ? ` tm-facts__item--${fact.tone}` : ''}`}>
              {fact.text}
            </li>
          ))}
        </ul>
      ) : null}
      {/* Ways forward first; marking done despite open evidence is the override, so it comes last. */}
      <SlotActions
        primary={model.primary ? toAction(model.primary) : undefined}
        secondary={[
          ...model.secondaries.filter((choice) => !isMarkDone(choice.id)).map(toAction),
          ...extraActions,
          ...model.secondaries.filter((choice) => isMarkDone(choice.id)).map(toAction)
        ]}
        quiet={placement === 'section'}
      />
    </>
  );
  if (placement === 'section') {
    return <OverviewSection title="Finishing" className="tm-nextaction">{body}</OverviewSection>;
  }
  return (
    <section className={`tm-nextaction tm-nextaction--${placement}`} aria-label="Next action">
      {body}
    </section>
  );
}

/** "Changes not pushed" and "Local changes not pushed" name one state. */
function sameStateWords(a: string, b: string): boolean {
  const words = (value: string) => value.toLocaleLowerCase().replace(/^(pr|local|github)\s+/u, '').trim();
  return words(a) === words(b);
}

function isMarkDone(id: NextActionId): boolean {
  return id === 'mark-done' || id === 'mark-done-anyway';
}

function TaskHealthFindings({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return null;
  }

  const sorted = [...findings].sort(
    (a, b) => healthFindingRank(a.severity) - healthFindingRank(b.severity)
  );

  return (
    <section className="card tm-healthfindings">
      <div className="card__header">
        <div>
          <h3>Task health</h3>
          <p className="tm-panel__lead">
            Current projection and runtime findings.
          </p>
        </div>
        <span className="tm-healthfindings__count">{findings.length}</span>
      </div>
      <div className="tm-reviewfindings__list tm-healthfindings__list">
        {sorted.map((finding, index) => {
          const tone = healthFindingTone(finding.severity);
          const view = describeHealthFinding(finding);
          return (
            <FindingRow
              key={finding.id}
              tone={tone}
              severityLabel={humanizeEnum(finding.severity)}
              title={view.title}
              reference={view.meta}
              open={index === 0}
              detail={<p>{view.detail}</p>}
            />
          );
        })}
      </div>
    </section>
  );
}

function PrStatusCard({
  view,
  actionState,
  prominent = false,
  title,
  onCreateDraftPr,
  onPushUpdate,
  onRefresh,
  onInvestigate
}: {
  view: PrStatusViewModel;
  actionState: ReturnType<typeof buildPrStatusActionState>;
  /** PR Status holds the Overview's Now panel, so its lead action is the primary. */
  prominent?: boolean;
  /** In the Now panel, the board card's word for the task; the PR's own headline follows it only when it adds something. */
  title?: string;
  onCreateDraftPr(): void;
  onPushUpdate(): void;
  onRefresh(): void;
  onInvestigate(): void;
}) {
  const createOrPushTitle = buildPrStatusCreateOrPushTitle(
    view,
    actionState.createOrPushReason
  );
  const leadAction = !prominent ? undefined
    : view.canInvestigateFailure ? 'investigate'
      : view.canPushUpdate ? 'push'
        : view.canCreateDraftPr ? 'create'
          : undefined;
  const actionClass = (action: 'investigate' | 'push' | 'create') =>
    leadAction === action ? 'primary-button' : 'outline-button';
  // A disabled action's reason is stated beside it and tied to it, so it is not
  // also listed among the facts.
  const createOrPushReason =
    (view.canCreateDraftPr || view.canPushUpdate) && actionState.createOrPushDisabled
      ? actionState.createOrPushReason ?? createOrPushTitle
      : undefined;
  // A disabled action's reason is stated beside it, not only in a hover title
  // a disabled button can never show to the keyboard.
  const reasonPrefix = useId();
  const slotReasons = view.canCreateDraftPr || view.canPushUpdate || view.canInvestigateFailure
    ? [
        ...new Set(
          [
            createOrPushReason,
            view.canInvestigateFailure && actionState.investigateDisabled
              ? actionState.investigateReason
              : undefined
          ].filter((reason): reason is string => Boolean(reason))
        )
      ]
    : [];
  const reasonId = (reason: string | undefined) =>
    reason && slotReasons.includes(reason) ? `${reasonPrefix}-${slotReasons.indexOf(reason)}` : undefined;
  const freshnessProblem = ['STALE', 'LOCAL_NOT_PUSHED', 'PR_NEWER_COMMITS', 'BRANCH_DIVERGED'].includes(view.kind);
  const refresh = view.canRefresh ? (
    <span className="tm-prstatus__refreshline">
      {view.refreshedLine ? <span>Updated {view.refreshedLine}</span> : null}
      <ActionButtonTitle
        disabled={actionState.refreshDisabled}
        title={actionState.refreshReason ?? 'Refresh pull request'}
      >
        <button
          type="button"
          className="tm-prstatus__refresh"
          disabled={actionState.refreshDisabled}
          onClick={onRefresh}
          aria-label="Refresh pull request"
        >
          <RefreshIcon />
        </button>
      </ActionButtonTitle>
    </span>
  ) : null;
  const identity = view.hasPullRequest ? (
    view.prUrl ? (
      <a href={view.prUrl} target="_blank" rel="noreferrer">{view.prIdentityLine ?? 'Pull request'}</a>
    ) : (
      <span>{view.prIdentityLine ?? 'Pull request'}</span>
    )
  ) : null;
  // The PR's headline is stated once: as the panel's title, or beside its identity.
  const showHeadline = prominent
    ? title !== undefined && !sameStateWords(title, view.headline)
    : view.kind !== 'NO_PR';
  const facts = [
    !freshnessProblem ? view.freshnessLine : undefined,
    view.leadLine,
    view.guidanceLine,
    view.evidenceLine
  ].filter((line): line is string => Boolean(line) && line !== createOrPushReason);

  return (
    <section className={`tm-prstatus${prominent ? ' tm-prstatus--now' : ''}`} aria-label="Pull request">
      <div className="tm-prstatus__head">
        {/* In the Now panel the PR's own state is the step; as a section it is one more fact. */}
        <h3 className={prominent ? 'tm-slot__headline' : 'tm-osection__title'}>
          {prominent ? title ?? view.headline : 'Pull request'}
        </h3>
        {refresh}
      </div>

      {identity || showHeadline ? (
        <p className="tm-prstatus__identity">
          {identity}
          {showHeadline ? <span className="tm-prstatus__state">{view.headline}</span> : null}
        </p>
      ) : null}

      {freshnessProblem && view.freshnessLine ? (
        <p className="tm-prstatus__freshness">{view.freshnessLine}</p>
      ) : null}

      {facts.map((line) => (
        <p key={line} className="tm-prstatus__fact">{line}</p>
      ))}

      {view.canCreateDraftPr || view.canPushUpdate || view.canInvestigateFailure ? (
        <div className="tm-prstatus__actions">
          {view.canCreateDraftPr ? (
            <ActionButtonTitle
              disabled={actionState.createOrPushDisabled}
              title={createOrPushTitle}
            >
              {/* Outside the decision slot delivery is a parallel path, so no
                  action here competes with the slot's primary. */}
              <button
                type="button"
                className={actionClass('create')}
                disabled={actionState.createOrPushDisabled}
                aria-describedby={actionState.createOrPushDisabled ? reasonId(createOrPushTitle) : undefined}
                onClick={onCreateDraftPr}
              >
                Create draft PR
              </button>
            </ActionButtonTitle>
          ) : null}
          {view.canPushUpdate ? (
            <ActionButtonTitle
              disabled={actionState.createOrPushDisabled}
              title={createOrPushTitle}
            >
              <button
                type="button"
                className={actionClass('push')}
                disabled={actionState.createOrPushDisabled}
                aria-describedby={actionState.createOrPushDisabled ? reasonId(createOrPushTitle) : undefined}
                onClick={onPushUpdate}
              >
                Push update
              </button>
            </ActionButtonTitle>
          ) : null}
          {view.canInvestigateFailure ? (
            <ActionButtonTitle
              disabled={actionState.investigateDisabled}
              title={actionState.investigateReason}
            >
              <button
                type="button"
                className={`${actionClass('investigate')} tm-prstatus__investigate`}
                disabled={actionState.investigateDisabled}
                aria-describedby={actionState.investigateDisabled ? reasonId(actionState.investigateReason) : undefined}
                onClick={onInvestigate}
              >
                Investigate failure
              </button>
            </ActionButtonTitle>
          ) : null}
        </div>
      ) : null}

      {slotReasons.map((reason) => (
        <p key={reason} id={reasonId(reason)} className="tm-slot__reason">
          {reason}
        </p>
      ))}

      {view.checkGroups.length > 0 ? <PrCheckDetails groups={view.checkGroups} /> : null}
    </section>
  );
}

function PrCheckDetails({ groups }: { groups: PrCheckGroup[] }) {
  const checks = groups.flatMap((group) => group.checks);
  return (
    <details className="tm-prchecks" aria-label="GitHub check details">
      <summary className="tm-prchecks__head">
        <span className="tm-disclosure__label"><DisclosureChevron />Checks</span>
        <span>{checks.length}</span>
      </summary>
      <div className="tm-prchecks__rows">
        {checks.map((check) => (
          <details
            key={`${check.name}-${check.workflow ?? ''}-${check.link ?? ''}`}
            className={`tm-prcheck tm-prcheck--${check.status}`}
          >
            <summary>
              <span className="tm-prcheck__name">
                <DisclosureChevron className="tm-prcheck__chevron" />
                <span>{check.name}</span>
              </span>
              <span className="tm-prcheck__status">
                <span className={`tm-prcheck__label tm-prcheck__label--${check.status}`}>
                  {checkStatusLabel(check.status)}
                </span>
                <span>{checkMetaLine(check)}</span>
              </span>
            </summary>
            <pre>{checkEvidenceText(check)}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}

function checkStatusLabel(status: PrCheckGroup['status']): string {
  switch (status) {
    case 'passed':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'canceled':
      return 'Canceled';
    case 'pending':
      return 'Pending';
    case 'skipped':
      return 'Skipped';
  }
}

function checkMetaLine(check: PrCheckGroup['checks'][number]): string {
  const duration = formatCheckDuration(check.startedAt, check.completedAt);
  if (duration) {
    return duration;
  }
  if (check.status === 'pending') {
    return 'running';
  }
  if (check.status === 'skipped') {
    return 'optional';
  }
  return check.event ?? '';
}

function checkEvidenceText(check: PrCheckGroup['checks'][number]): string {
  const lines = [
    check.workflow ? `Workflow: ${check.workflow}` : undefined,
    `Status: ${check.state ?? checkStatusLabel(check.status)}`,
    check.event ? `Event: ${check.event}` : undefined,
    check.description ? `Description: ${check.description}` : undefined,
    check.startedAt ? `Started: ${check.startedAt}` : undefined,
    check.completedAt ? `Completed: ${check.completedAt}` : undefined,
    check.link ? `URL: ${check.link}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join('\n') : 'No additional check detail was reported.';
}

function formatCheckDuration(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return undefined;
  }
  const seconds = Math.round((completed - started) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function RefreshIcon() {
  return <RefreshCw aria-hidden="true" size={13} />;
}

function healthFindingRank(severity: Finding['severity']): number {
  switch (severity) {
    case 'ERROR':
    case 'BLOCKED':
      return 0;
    case 'WARNING':
      return 1;
    case 'INFO':
      return 2;
    case 'HEALTHY':
      return 3;
  }
}

function healthFindingTone(severity: Finding['severity']): Tone {
  switch (severity) {
    case 'ERROR':
    case 'BLOCKED':
      return 'error';
    case 'WARNING':
      return 'action';
    case 'INFO':
      return 'info';
    case 'HEALTHY':
      return 'neutral';
  }
}

function getPrimaryAction(input: {
  task: Task;
  worktree?: WorktreeRecord;
  worktreePreparationPending?: boolean;
  onPrepareWorktree(taskId: string): Promise<void>;
  onStart(taskId: string): Promise<void>;
}): { label: string; disabled?: boolean; onClick(): void } | undefined {
  if (['IN_REVIEW', 'DONE', 'CANCELED', 'ARCHIVED'].includes(input.task.workflowPhase)) {
    return undefined;
  }

  if (!input.worktree || ['REMOVED', 'MISSING', 'ERROR'].includes(input.worktree.status)) {
    if (input.worktree?.ownership === 'EXTERNAL') return undefined;
    return {
      label: input.worktreePreparationPending ? 'Inspecting base…'
        : input.worktree?.status === 'MISSING' ? 'Restore worktree'
        : input.worktree?.status === 'ERROR' ? 'Retry worktree setup'
        : 'Prepare worktree',
      disabled: input.worktreePreparationPending,
      onClick: () => void input.onPrepareWorktree(input.task.id)
    };
  }

  if (input.worktree.status === 'PRESENT' && canStartRun(input.task)) {
    return {
      label: 'Start implementation',
      onClick: () => void input.onStart(input.task.id)
    };
  }

  return undefined;
}
