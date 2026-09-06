import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react';
import { RefreshCw } from 'lucide-react';
import { createUpdateRefreshScheduler } from '../model/updateRefreshScheduler';
import {
  completionPolicyRequiresMerge,
  getImplementationRetryReason,
  isImplementationRunMode,
  localGitMatchesPullRequest,
  normalizePullRequestTitle
} from '../../shared/contracts';
import type {
  ArtifactRecord,
  BranchPublicationRecord,
  CiRollupRecord,
  ClientTextExcerpt,
  DomainEvent,
  Finding,
  GitSnapshotRecord,
  GitHubRepositoryRecord,
  AgentInteractionDecision,
  AgentGoalSnapshotRecord,
  AgentItemRecord,
  AgentPlanRevisionRecord,
  AgentRetryStrategy,
  AgentSessionRecord,
  AgentSettingsObservationRecord,
  AgentSubagentObservationRecord,
  AgentUsageSnapshotRecord,
  AgentRuntimeState,
  AgentServerInstance,
  UpdateAgentNativeSessionRequest,
  InteractionRequestRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  Repository,
  PreviewApprovalRecord,
  PreviewComposeProjectRecord,
  PreviewGenerationRecord,
  PreviewGenerationAttachmentRecord,
  PreviewLocalAttachmentBindingRecord,
  PreviewManagedResourceRecord,
  PreviewNodeAttemptRecord,
  PreviewPlanRecord,
  PreviewRecipeGenerationSnapshot,
  PreviewRecipeValidation,
  PreviewResolvedAttachmentTarget,
  ResolvePreviewResult,
  PreviewResourceRecord,
  ReviewRollupRecord,
  RunRecord,
  Task,
  WorkflowPhase,
  WorktreeComparison,
  WorktreeRecord
} from '../../shared/contracts';
import type { TaskAttachmentRecord } from '../../shared/attachments';
import {
  canCreateDeliveryCommit,
  canPrepareWorktree,
  canStartRun,
  getAttachedWorktreeActionBlocker
} from '../model/selectors';
import { describeHealthFinding } from '../model/debugDiagnostics';
import { AgentControlPanel } from './AgentControlPanel';
import { EvidencePanel } from './EvidencePanel';
import { InteractionPanel } from './InteractionPanel';
import { InteractionAuditPanel } from './InteractionAuditPanel';
import { ProviderActivityPanel } from './ProviderActivityPanel';
import { ProviderOverviewPanel } from './ProviderOverviewPanel';
import { SubagentHierarchyPanel } from './SubagentHierarchyPanel';
import { TaskActionsMenu } from './TaskActionsMenu';
import { Chip, StatusGlyph, type StatusGlyphKind } from './StatusBadge';
import { FindingRow } from './Findings';
import { DisclosureChevron } from './DisclosureChevron';
import {
  buildReviewFollowUpInstruction,
  defaultSelectedFindingIds
} from '../model/reviewFollowUp';
import {
  findCompletedCurrentImplementationRun,
  isActiveNonReviewRun,
  isImplementationRetryRequired,
  selectNextAction,
  shouldShowOverviewNextAction,
  type NextActionId,
  type NextActionModel
} from '../model/nextAction';
import {
  canRequestReviewChanges,
  describeRunFailureBanner,
  describeTaskHeaderState
} from '../model/taskView';
import {
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
  MASCOT_VIDEO_SOURCES,
  getMascotStateForTask
} from '../model/mascotState';
import {
  buildTaskActivityLedger,
  projectDebugTaskActivity,
  projectOverviewTaskActivity
} from '../model/taskActivity';
import { buildRunProgressViewModel } from '../model/runProgress';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { buildReviewActivityViewModel } from '../model/reviewActivity';
import {
  formatAgentNetworkAccess,
  formatAgentPermissionMode
} from '../model/agentPermissions';
import { ActionButtonTitle } from './ActionButtonTitle';
import { AccessibleTab } from './AccessibleTabs';
import {
  ReviewPanel,
  type ReviewActionPauseReason
} from './ReviewPanel';
import { TaskActivityPanel } from './TaskActivityPanel';
import { CompletedChangeSummaryPanel } from './CompletedChangeSummaryCard';
import { RunProgressCard } from './RunProgressCard';
import { describeGitSnapshot } from './gitSnapshotCopy';
import { PreviewOverviewCard, PreviewWorkspace } from './PreviewPanel';
import type { PreviewExecutionReadiness } from '../../shared/preview';
import type { PreviewTaskRouteOption } from '../../shared/preview';
import {
  hasCurrentReviewEvidence,
  isRunFreeAttachedTask,
  isReviewPhase,
  shouldShowMoveToReviewHeaderAction
} from '../model/taskReviewActions';
import {
  TaskMascotVideo,
  usePrefersReducedMotion
} from './TaskMascotVideo';
import {
  CreateDraftPrModal,
  MarkDoneModal,
  ReviewRequestDrawer
} from './TaskDetailModals';

interface TaskDetailProps {
  headingRef?: RefObject<HTMLHeadingElement | null>;
  error?: string;
  task?: Task;
  repository?: Repository;
  run?: RunRecord;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  gitSnapshots: GitSnapshotRecord[];
  githubRepository?: GitHubRepositoryRecord;
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
  server?: AgentServerInstance;
  artifacts: ArtifactRecord[];
  textExcerpts?: ClientTextExcerpt[];
  attachments: TaskAttachmentRecord[];
  interactions: InteractionRequestRecord[];
  previewPlans: PreviewPlanRecord[];
  previewApprovals: PreviewApprovalRecord[];
  previewGenerations: PreviewGenerationRecord[];
  previewGenerationAttachments: PreviewGenerationAttachmentRecord[];
  previewManagedResources: PreviewManagedResourceRecord[];
  previewNodeAttempts: PreviewNodeAttemptRecord[];
  previewComposeProjects: PreviewComposeProjectRecord[];
  previewLocalBindings: PreviewLocalAttachmentBindingRecord[];
  previewTaskRoutes: PreviewTaskRouteOption[];
  previewRuntimeResources: PreviewResourceRecord[];
  previewExecutionReadiness?: PreviewExecutionReadiness;
  previewResolution?: ResolvePreviewResult;
  previewRecipeGeneration?: PreviewRecipeGenerationSnapshot;
  showMascot: boolean;
  reviewDisabledReason?: string;
  onPrepareWorktree(taskId: string): Promise<void>;
  onStart(taskId: string, instruction?: string, sourceReviewRunId?: string): Promise<void>;
  onCancel(runId: string): Promise<void>;
  onSteer(runId: string, instruction: string): Promise<void>;
  onContinue(runId: string, instruction?: string, sourceReviewRunId?: string): Promise<void>;
  onRetry(runId: string, strategy: AgentRetryStrategy, instruction?: string): Promise<void>;
  onReview(runId?: string): Promise<void>;
  onRefreshEvidence(taskId: string): Promise<void>;
  onObserveWorktree?(taskId: string): Promise<void>;
  onReconnectWorktree(taskId: string): Promise<void>;
  onUpdateWorktreeComparison(taskId: string, comparison: WorktreeComparison): Promise<void>;
  onSyncAgentGoal(taskId: string, sessionId: string): Promise<void>;
  onUpdateAgentNativeSession(input: UpdateAgentNativeSessionRequest): Promise<void>;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
  onCreateDeliveryCommit(taskId: string): Promise<void>;
  onCreatePullRequest(taskId: string, title?: string): Promise<void>;
  onRefreshGitHub(taskId: string): Promise<void>;
  onResolvePreview(taskId: string, scenarioId?: string): Promise<void>;
  onSetPreviewLocalBinding(
    taskId: string,
    attachmentId: string,
    target: PreviewResolvedAttachmentTarget,
    scenarioId: string
  ): Promise<void>;
  onGetPreviewRecipeGeneration(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  onGeneratePreviewRecipe(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  onValidatePreviewRecipeDraft(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<PreviewRecipeValidation>;
  onAcceptPreviewRecipeDraft(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<import('../../shared/contracts').AcceptPreviewRecipeDraftResult>;
  onDiscardPreviewRecipeDraft(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  onWritePreviewRecipeManually(taskId: string, worktreeId: string): Promise<void>;
  onApprovePreview(taskId: string, planId: string, executionDigest: string): Promise<void>;
  onStartPreview(taskId: string, scenarioId?: string): Promise<void>;
  onOpenPreview(taskId: string, generationId: string, routeId: string): Promise<void>;
  onStopPreview(taskId: string, generationId: string): Promise<void>;
  onResetPreviewData(taskId: string, generationId: string, resourceId: string, scenarioId: string): Promise<void>;
  onRetryPreviewSetup(taskId: string, generationId: string, scenarioId: string): Promise<void>;
  onReadPreviewLog(taskId: string, artifactId: string, offset: number, maxBytes: number): Promise<import('../../shared/contracts').ReadPreviewLogResult>;
  onReadArtifact?(artifactId: string): Promise<string>;
  onTransition(taskId: string, toPhase: WorkflowPhase): Promise<void>;
  onArchive(taskId: string): void;
  onRequestDelete(taskId: string): void;
  onModalOpenChange(open: boolean): void;
}

interface HeadAction {
  label: string;
  kind: 'primary' | 'soft';
  disabled?: boolean;
  title?: string;
  onClick(): void;
}

type DetailTab = 'overview' | 'preview' | 'evidence' | 'debug';

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
const REVIEW_MASCOT_MIN_ACTIVE_MS = 1600;

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
  const [tab, setTab] = useState<DetailTab>('overview');
  const [requestDrawer, setRequestDrawer] = useState<{
    taskId: string;
    sourceReviewRunId?: string;
    checksHeadSha?: string;
  }>();
  const [selectedReviewFindingIds, setSelectedReviewFindingIds] = useState<string[]>([]);
  const [markDoneModal, setMarkDoneModal] = useState<'clean' | 'issues'>();
  const [draftPrModalOpen, setDraftPrModalOpen] = useState(false);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [draftPrTitle, setDraftPrTitle] = useState('');
  const [requestNote, setRequestNote] = useState('');
  const [requestInstruction, setRequestInstruction] = useState('');
  const [requestError, setRequestError] = useState<string>();
  const [requestReviewOutput, setRequestReviewOutput] = useState<string>();
  const [loadedReviewOutput, setLoadedReviewOutput] = useState<string>();
  const [reviewOutputLoading, setReviewOutputLoading] = useState(false);
  const [reviewOutputError, setReviewOutputError] = useState<string>();
  const [evidenceGitSnapshotId, setEvidenceGitSnapshotId] = useState<string | undefined>();
  const [reviewActionBusy, setReviewActionBusy] = useState(false);
  const [deliveryActionBusy, setDeliveryActionBusy] = useState(false);
  const [reviewStartPending, setReviewStartPending] = useState(false);
  const [reviewMascotHoldGeneration, setReviewMascotHoldGeneration] = useState(0);
  const reviewActionInFlightRef = useRef(false);
  const deliveryActionInFlightRef = useRef(false);
  const pendingGitObservationRef = useRef<(() => void) | undefined>(undefined);
  const detailRootRef = useRef<HTMLElement>(null);
  const previewModalRootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const debugActivityRef = useRef<HTMLElement>(null);
  const focusActivityHistoryRef = useRef(false);
  const repositoryContextId = useId();
  const taskDetailModalOpen = Boolean(
    markDoneModal || draftPrModalOpen || requestDrawer || previewModalOpen
  );
  const prefersReducedMotion = usePrefersReducedMotion();
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
  const reviewPending = reviewStartPending && !reviewIsRunning;
  const reviewMascotHoldActive = reviewMascotHoldGeneration > 0;
  const reviewActiveForMascot = reviewMascotHoldActive || reviewIsRunning;
  const headerState = task ? describeTaskHeaderState(task) : undefined;
  const prStatus = task
    ? buildPrStatusViewModel({
        task,
        worktree,
        events: props.events,
        gitSnapshot,
        branchPublication,
        pullRequest,
        ciRollup,
        reviewRollup,
        mergeSnapshot
      })
    : undefined;
  const mascotState = task && headerState
    ? getMascotStateForTask({
        workflowPhase: task.workflowPhase,
        agentRun: task.projection.agentRun,
        reviewStatus: reviewGate?.status ?? 'NOT_RUN',
        prStatusKind: prStatus?.kind,
        reviewActive: reviewActiveForMascot
      })
    : 'idle';
  const mascotVideoSource = MASCOT_VIDEO_SOURCES[mascotState];
  const runDeliveryAction = async (action: () => Promise<void>) => {
    if (deliveryActionInFlightRef.current || reviewActionInFlightRef.current) {
      return;
    }
    deliveryActionInFlightRef.current = true;
    setDeliveryActionBusy(true);
    try {
      await action();
    } finally {
      deliveryActionInFlightRef.current = false;
      setDeliveryActionBusy(false);
      const pending = pendingGitObservationRef.current;
      pendingGitObservationRef.current = undefined;
      pending?.();
    }
  };
  const observeWorktree = useEffectEvent(async (taskId: string) => {
    await runDeliveryAction(async () => { await props.onObserveWorktree?.(taskId); });
  });
  const attachedTaskId = worktree?.ownership === 'EXTERNAL' && props.onObserveWorktree
    ? task?.id : undefined;
  useEffect(() => {
    if (!attachedTaskId || taskDetailModalOpen) return;
    const observer = createUpdateRefreshScheduler({
      delayMs: 50,
      refresh: async () => {
        if (deliveryActionInFlightRef.current || reviewActionInFlightRef.current) {
          pendingGitObservationRef.current = request;
          return;
        }
        await observeWorktree(attachedTaskId);
      },
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number)
    });
    const request = () => {
      if (document.visibilityState !== 'hidden') observer.request();
    };
    request();
    window.addEventListener('focus', request);
    document.addEventListener('visibilitychange', request);
    return () => {
      observer.dispose();
      if (pendingGitObservationRef.current === request) pendingGitObservationRef.current = undefined;
      window.removeEventListener('focus', request);
      document.removeEventListener('visibilitychange', request);
    };
  }, [attachedTaskId, taskDetailModalOpen]);
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
    setReviewStartPending(false);
    setReviewMascotHoldGeneration(0);
    setRequestDrawer(undefined);
    setSelectedReviewFindingIds([]);
    setRequestNote('');
    setRequestReviewOutput(undefined);
    setRequestError(undefined);
    setDraftPrModalOpen(false);
    setDraftPrTitle(task ? normalizePullRequestTitle(undefined, task.title) : '');
    setEvidenceGitSnapshotId(undefined);
  }, [task?.id, task?.title]);

  useEffect(() => {
    setLoadedReviewOutput(undefined);
    setReviewOutputLoading(false);
    setReviewOutputError(undefined);
    setRequestReviewOutput(undefined);
  }, [reviewRun?.id, reviewTextExcerpt?.originalByteCount]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [tab, task?.id]);

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

  useEffect(() => {
    if (reviewMascotHoldGeneration === 0) {
      return;
    }

    const generation = reviewMascotHoldGeneration;
    const timeout = window.setTimeout(() => {
      setReviewMascotHoldGeneration((current) => (current === generation ? 0 : current));
    }, REVIEW_MASCOT_MIN_ACTIVE_MS);

    return () => window.clearTimeout(timeout);
  }, [reviewMascotHoldGeneration, task?.id]);

  if (!task || !reviewGate || !headerState || !prStatus) {
    return (
      <main className="tm-detail">
        <div className="tm-detail__body">
          <div className="tm-grid__empty">Select a task to inspect isolated evidence.</div>
        </div>
      </main>
    );
  }

  const session = sessions.find((candidate) => candidate.id === run?.sessionId);
  const attached = worktree?.ownership === 'EXTERNAL';
  const attachedBlocker = getAttachedWorktreeActionBlocker(task, worktree, gitSnapshot);
  const primarySessionMatches = !attached || Boolean(session && session.worktreePath === worktree.worktreePath);
  const canStartFresh = attached && (!task.currentRunId || Boolean(session && !primarySessionMatches)) &&
    !['DONE', 'CANCELED', 'ARCHIVED'].includes(task.workflowPhase);
  const firstStartBlocker = canStartFresh && props.runtimeState?.preflight.readiness.canStart === false
    ? props.runtimeState.preflight.readiness.summary
    : undefined;
  const runFreeReview = isRunFreeAttachedTask(task, worktree);
  const promptLineCount = task.prompt.split(/\r?\n/).length;
  const reviewFindings = reviewGate.result?.findings ?? [];
  const reviewActivity = buildReviewActivityViewModel({
    reviewRun,
    reviewRunning: reviewPending || reviewGate.status === 'RUNNING',
    useRunActivity: reviewGate.status === 'RUNNING',
    items: props.items
  });
  // The review run and projection remain historical display context. Starting
  // another review or review-derived follow-up always targets the exact current
  // completed implementation run, never the source of an older review.
  const actionableReviewSourceRun = findCompletedCurrentImplementationRun(
    task,
    props.runs
  );
  const hasHistoricalReviewContext =
    reviewRun?.mode === 'REVIEW' || reviewGate.status !== 'NOT_RUN';
  const reviewPhaseVisible =
    hasHistoricalReviewContext ||
    (isReviewPhase(task.workflowPhase) && Boolean(actionableReviewSourceRun || runFreeReview));
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
  const deliverySourceRun = primarySessionMatches && run && isImplementationRunMode(run.mode) ? run : undefined;
  const prActionState = buildPrStatusActionState({
    view: prStatus,
    deliveryBusy: deliveryActionBusy,
    pauseReason: reviewPauseReason,
    implementationRetryReason: getImplementationRetryReason(task),
    hasInvestigationSource: Boolean(deliverySourceRun || canStartFresh)
  });
  const reviewHasOutput = Boolean(reviewGate.result) || Boolean(
    reviewTextExcerpt?.availableContent.kind === 'BOUNDED_ARTIFACT' ||
    (!reviewTextExcerpt && reviewRun?.finalMessage?.trim())
  );
  const reviewChangesEligible = isReviewPhase(task.workflowPhase) &&
    Boolean((actionableReviewSourceRun && primarySessionMatches) || canStartFresh) &&
    hasCurrentReviewEvidence(task, reviewRun, gitSnapshots) &&
    canRequestReviewChanges(reviewGate, reviewGate.status, reviewHasOutput);
  const requestDisabledReason = requestDrawer && (
    requestDrawer.taskId !== task.id ? 'The selected task changed. Reopen the instruction.' :
    attachedBlocker ?? firstStartBlocker ?? (
      props.repository?.status !== 'AVAILABLE' ? 'Reconnect this repository before continuing.' :
      reviewActionsPaused ? 'Wait for the current task action to finish.' :
      requestDrawer.sourceReviewRunId && (
        requestDrawer.sourceReviewRunId !== reviewGate.runId || !reviewChangesEligible
      ) ? 'This review is no longer current. Close this drawer and run review again.' :
      !requestDrawer.sourceReviewRunId && !canStartFresh ? 'A new implementation is no longer available.' :
      requestDrawer.checksHeadSha && (
        requestDrawer.checksHeadSha !== prStatus.prHeadSha || !prStatus.canInvestigateFailure
      ) ? 'The PR evidence changed. Refresh PR status before investigating.' : undefined
    )
  );
  const taskActivityLedger = useMemo(
    () =>
      buildTaskActivityLedger({
        task,
        events: props.events,
        runs: props.runs
      }),
    [task, props.events, props.runs]
  );
  const overviewActivity = useMemo(
    () => projectOverviewTaskActivity(taskActivityLedger),
    [taskActivityLedger]
  );
  const debugActivity = useMemo(
    () => projectDebugTaskActivity(taskActivityLedger),
    [taskActivityLedger]
  );
  const runProgress = useMemo(
    () =>
      buildRunProgressViewModel({
        preferredRun: run,
        runs: props.runs,
        planRevisions,
        items: props.items,
        gitSnapshot,
        ciStatus: ciRollup?.status ?? task.projection.ciChecks
      }),
    [run, props.runs, planRevisions, props.items, gitSnapshot, ciRollup?.status, task.projection.ciChecks]
  );
  // The run the progress card reflects (for its RunHeader's elapsed timer + Stop)
  // and its scope in mono (audit §05 RunHeader row).
  const progressRun = runProgress
    ? props.runs.find((candidate) => candidate.id === runProgress.runId)
    : undefined;
  const runProgressScope = describeGitSnapshot(gitSnapshot);
  const evidenceGitSnapshot = evidenceGitSnapshotId
    ? gitSnapshots.find((candidate) => candidate.id === evidenceGitSnapshotId) ?? gitSnapshot
    : gitSnapshot;

  const runReviewAction = async (action: () => Promise<void>) => {
    if (reviewActionInFlightRef.current || deliveryActionInFlightRef.current) {
      return;
    }
    reviewActionInFlightRef.current = true;
    setReviewActionBusy(true);
    try {
      await action();
    } finally {
      reviewActionInFlightRef.current = false;
      setReviewActionBusy(false);
      const pending = pendingGitObservationRef.current;
      pendingGitObservationRef.current = undefined;
      pending?.();
    }
  };

  const runReview = async (sourceRunId?: string) => {
    if (reviewActionInFlightRef.current || nextActionState('run-review').disabled) {
      return;
    }
    setReviewStartPending(true);
    setReviewMascotHoldGeneration((generation) => generation + 1);
    await runReviewAction(async () => {
      try {
        await props.onReview(sourceRunId);
      } catch {
        setReviewStartPending(false);
        setReviewMascotHoldGeneration(0);
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

  const openRequestChanges = async (findingIds?: string[]) => {
    const hasReviewOutput =
      Boolean(reviewGate.result) ||
      Boolean(
        reviewTextExcerpt?.availableContent.kind === 'BOUNDED_ARTIFACT' ||
        (!reviewTextExcerpt && reviewRun?.finalMessage?.trim())
      );
    if (
      !reviewChangesEligible || attachedBlocker ||
      reviewActionsPaused ||
      !canRequestReviewChanges(reviewGate, reviewGate.status, hasReviewOutput)
    ) {
      return;
    }
    const selectedIds = findingIds?.length
      ? findingIds
      : defaultSelectedFindingIds(reviewFindings);
    let reviewOutput: string | undefined;
    if (selectedIds.length === 0) {
      try {
        reviewOutput = await loadAvailableReviewOutput();
      } catch {
        return;
      }
    }
    setSelectedReviewFindingIds(selectedIds);
    setRequestError(undefined);
    setRequestNote('');
    setRequestReviewOutput(reviewOutput);
    setRequestInstruction(
      buildReviewFollowUpInstruction(task, reviewGate, reviewOutput, selectedIds)
    );
    setRequestDrawer({ taskId: task.id, sourceReviewRunId: reviewRun!.id });
  };

  const openFirstImplementation = (instruction = '', checksHeadSha?: string) => {
    if (!canStartFresh || attachedBlocker || reviewActionsPaused) return;
    setRequestError(undefined);
    setSelectedReviewFindingIds([]);
    setRequestNote('');
    setRequestInstruction(instruction);
    setRequestDrawer({ taskId: task.id, checksHeadSha });
  };

  const submitRequestChanges = async () => {
    if (!requestDrawer || requestDisabledReason || !requestInstruction.trim()) {
      return;
    }
    await runReviewAction(async () => {
      setRequestError(undefined);
      try {
        if (canStartFresh) {
          await props.onStart(task.id, requestInstruction.trim(), requestDrawer.sourceReviewRunId);
        } else if (actionableReviewSourceRun && primarySessionMatches) {
          await props.onContinue(actionableReviewSourceRun.id, requestInstruction.trim(), requestDrawer.sourceReviewRunId);
        } else return;
        setRequestDrawer(undefined);
      } catch (caught) {
        setRequestError(caught instanceof Error ? caught.message : 'The run could not be started.');
      }
    });
  };

  const toggleSelectedReviewFinding = async (findingId: string) => {
    if (requestDisabledReason) return;
    const next = selectedReviewFindingIds.includes(findingId)
      ? selectedReviewFindingIds.filter((id) => id !== findingId)
      : [...selectedReviewFindingIds, findingId];
    let reviewOutput = requestReviewOutput;
    if (next.length === 0 && reviewOutput === undefined) {
      try {
        reviewOutput = await loadAvailableReviewOutput();
      } catch {
        return;
      }
      setRequestReviewOutput(reviewOutput);
    }
    setSelectedReviewFindingIds(next);
    setRequestInstruction(
      buildReviewFollowUpInstruction(task, reviewGate, reviewOutput, next, requestNote)
    );
  };

  const updateRequestNote = (note: string) => {
    if (requestDisabledReason) return;
    setRequestNote(note);
    setRequestInstruction(
      buildReviewFollowUpInstruction(
        task,
        reviewGate,
        requestReviewOutput,
        selectedReviewFindingIds,
        note
      )
    );
  };

  const markDone = async () => {
    if (reviewActionsPaused || finishEvidence.mode === 'blocked') {
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
    if (!prStatus.canInvestigateFailure || prActionState.investigateDisabled || attachedBlocker) {
      return;
    }
    if (canStartFresh) {
      openFirstImplementation(buildFailingChecksInvestigationPrompt(prStatus), prStatus.prHeadSha);
      return;
    }
    if (!deliverySourceRun) return;
    await runDeliveryAction(async () => {
      await props.onContinue(
        deliverySourceRun.id,
        buildFailingChecksInvestigationPrompt(prStatus)
      );
    });
  };

  const openDraftPrModal = () => {
    setDraftPrTitle(normalizePullRequestTitle(undefined, task.title));
    setDraftPrModalOpen(true);
  };

  const submitDraftPr = async () => {
    const title = draftPrTitle.replace(/\s+/g, ' ').trim();
    if (!title || prActionState.createOrPushDisabled) {
      return;
    }
    await runDeliveryAction(async () => {
      await props.onCreatePullRequest(task.id, normalizePullRequestTitle(title, task.title));
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
        if (actionableReviewSourceRun || runFreeReview) {
          void runReview(actionableReviewSourceRun?.id);
        }
        return;
      case 'request-changes':
        void openRequestChanges();
        return;
      case 'commit':
        if (!canCreateDeliveryCommit(task, worktree)) return;
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
        if (nextActionState(id).disabled) return;
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
      ['run-review', 'run-review-again', 'request-changes', 'commit', 'move-to-review'].includes(id)
    ) {
      return {
        disabled: true,
        title: 'Reconnect this repository before running repository actions.'
      };
    }
    switch (id) {
      case 'run-review':
      case 'run-review-again': {
        const title = props.reviewDisabledReason ?? attachedBlocker ??
          (!actionableReviewSourceRun && !runFreeReview
            ? 'Complete an implementation run before starting review.'
            : reviewActionPauseTitle ?? (busy ? taskActionBusyTitle : undefined));
        return {
          disabled: Boolean(title),
          title
        };
      }
      case 'request-changes': {
        const title = attachedBlocker ?? (!reviewChangesEligible ? 'Run a current review before requesting changes.' : undefined) ?? reviewActionPauseTitle ?? (
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
        const title = attachedBlocker ?? reviewActionPauseTitle ?? (busy ? taskActionBusyTitle : undefined);
        return { disabled: Boolean(title), title };
      }
      default:
        return {};
    }
  };

  const primaryAction = getPrimaryAction({
    task,
    worktree,
    canStartFresh,
    onPrepareWorktree: props.onPrepareWorktree,
    onStart: attached ? async () => openFirstImplementation() : props.onStart
  });
  const implementationRetryRequired = isImplementationRetryRequired(task, run);

  const headActions: HeadAction[] = [];
  if (shouldShowMoveToReviewHeaderAction(task, run, worktree)) {
    headActions.push({
      label: 'Move to review',
      kind: 'soft',
      ...nextActionState('move-to-review'),
      onClick: () => onNextAction('move-to-review')
    });
  }
  if (primaryAction) {
    headActions.push({
      label: primaryAction.label,
      kind: 'primary',
      disabled:
        primaryAction.disabled ||
        Boolean(attachedBlocker || firstStartBlocker) ||
        reviewActionsPaused ||
        props.repository?.status !== 'AVAILABLE',
      title:
        props.repository?.status !== 'AVAILABLE'
          ? 'Reconnect this repository before running repository actions.'
          : attachedBlocker ?? firstStartBlocker,
      onClick: primaryAction.onClick
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
    reviewGate.status,
    dirtyFileCount,
    finishMergeStatus,
    finishCiStatus,
    finishVerifiedChecksEvidence
  );
  const localMergeBlocked = attached && completionPolicyRequiresMerge(task.completionPolicy) && (
    Boolean(attachedBlocker) || !localGitMatchesPullRequest({
      gitStatus: gitSnapshot?.status,
      gitHeadSha: gitSnapshot?.headSha,
      gitOperationInProgress: gitSnapshot?.operationInProgress,
      pullRequestHeadSha: mergeSnapshot?.headSha
    }) || dirtyFileCount > 0
  );
  if (localMergeBlocked) {
    finishEvidence.mode = 'blocked';
    finishEvidence.warnings.push({
      title: 'Local work does not match the merged PR.',
      detail: 'Refresh Git and PR status. This task requires a clean checkout at the merged PR head.'
    });
  }
  const finishRequirements = finishRequirementsForTask(
    task,
    reviewPending ? 'RUNNING' : reviewGate.status,
    dirtyFileCount,
    finishMergeStatus,
    finishCiStatus,
    finishVerifiedChecksEvidence
  );
  if (localMergeBlocked) finishRequirements.push({
    label: 'Local work', detail: 'must match the merged PR head', tone: 'action', unresolved: true
  });
  const runFailure = describeRunFailureBanner(task);

  // The single "what next" model for the rail. Kept in one place so the header,
  // run surface, and rail all agree instead of each inventing an action.
  const awaitingMoveToReview = shouldShowMoveToReviewHeaderAction(task, run, worktree);
  const reviewHasActionableFindings = reviewChangesEligible;
  const nextAction = selectNextAction({
    task,
    reviewStatus: reviewPending ? 'RUNNING' : reviewGate.status,
    finishEvidence,
    requirements: finishRequirements,
    hasReviewSource: Boolean(actionableReviewSourceRun || runFreeReview),
    reviewHasActionableFindings,
    canCommit: canCreateDeliveryCommit(task, worktree),
    awaitingMoveToReview,
    runInFlight: Boolean(activeImplementationRun) || reviewPending,
    implementationRunStatus: run?.mode === 'REVIEW' ? undefined : run?.status,
    implementationRetryRequired
  });

  const detailHeadClassName = props.showMascot
    ? 'tm-detail__head tm-detail__head--with-mascot'
    : 'tm-detail__head';
  const showPrStatus = shouldShowPrStatusOnOverview(prStatus);
  const previewPanelProps = {
    task,
    worktree,
    plans: props.previewPlans,
    approvals: props.previewApprovals,
    generations: props.previewGenerations,
    generationAttachments: props.previewGenerationAttachments,
    managedResources: props.previewManagedResources,
    attempts: props.previewNodeAttempts,
    composeProjects: props.previewComposeProjects,
    localBindings: props.previewLocalBindings,
    taskRouteOptions: props.previewTaskRoutes,
    runtimeResources: props.previewRuntimeResources,
    executionReadiness: props.previewExecutionReadiness,
    resolution: props.previewResolution,
    recipeGeneration: props.previewRecipeGeneration,
    onResolve: props.onResolvePreview,
    onSetLocalBinding: props.onSetPreviewLocalBinding,
    onGetRecipeGeneration: props.onGetPreviewRecipeGeneration,
    onGenerateRecipe: props.onGeneratePreviewRecipe,
    onValidateRecipeDraft: props.onValidatePreviewRecipeDraft,
    onAcceptRecipeDraft: props.onAcceptPreviewRecipeDraft,
    onDiscardRecipeDraft: props.onDiscardPreviewRecipeDraft,
    onWriteRecipeManually: props.onWritePreviewRecipeManually,
    onApprove: props.onApprovePreview,
    onStart: props.onStartPreview,
    onOpen: props.onOpenPreview,
    onStop: props.onStopPreview,
    onResetData: props.onResetPreviewData,
    onRetrySetup: props.onRetryPreviewSetup,
    onReadLog: props.onReadPreviewLog,
    fallbackReturnFocusRef: detailRootRef,
    modalRootRef: previewModalRootRef,
    onModalOpenChange: setPreviewModalOpen
  };
  return (
    <main ref={detailRootRef} className="tm-detail" tabIndex={-1}>
      <div
        className={detailHeadClassName}
        inert={taskDetailModalOpen ? true : undefined}
        aria-hidden={taskDetailModalOpen ? true : undefined}
      >
        <div className="tm-detail__row">
          <div className="tm-detail__heading">
            <div className="tm-detail__titlerow">
              <h1 ref={props.headingRef} className="tm-detail__title" tabIndex={-1}>
                {task.title}
              </h1>
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
                className="tm-detail__taskmenu"
              />
            </div>
            <div className="tm-detail__context">
              <Chip tone={headerState.tone} label={headerState.label} />
              <div id={repositoryContextId} className="tm-detail__meta">
                <span>
                  {props.repository?.name ?? 'Unknown repository'}
                  {props.repository && props.repository.status !== 'AVAILABLE'
                    ? ` · ${props.repository.status.toLowerCase()}`
                    : ''}
                </span>
                {worktree?.branchName ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <code>{worktree.branchName}</code>
                  </>
                ) : null}
              </div>
            </div>
          </div>
          {headActions.length > 0 ? (
            <div className="tm-detail__titleactions">
              {headActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={`tm-headbtn${
                    action.kind === 'primary' && tab !== 'preview'
                      ? ' tm-headbtn--primary'
                      : ''
                  }`}
                  disabled={action.disabled}
                  title={action.title}
                  aria-describedby={
                    props.repository?.status !== 'AVAILABLE'
                      ? repositoryContextId
                      : undefined
                  }
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {props.showMascot ? (
          <TaskMascotVideo
            source={mascotVideoSource}
            state={mascotState}
            prefersReducedMotion={prefersReducedMotion}
          />
        ) : null}
        {awaitingMoveToReview ? (
          <NextActionPanel
            model={nextAction}
            requirements={[]}
            onAction={onNextAction}
            actionState={nextActionState}
            placement="task"
          />
        ) : null}
        <div className="tm-tabs" role="tablist" aria-label="Task sections">
          <AccessibleTab
            id="task-detail-tab-overview"
            panelId="task-detail-panel"
            label="Overview"
            selected={tab === 'overview'}
            onSelect={() => setTab('overview')}
          />
          <AccessibleTab
            id="task-detail-tab-preview"
            panelId="task-detail-panel"
            label="Preview"
            selected={tab === 'preview'}
            onSelect={() => setTab('preview')}
          />
          <AccessibleTab
            id="task-detail-tab-evidence"
            panelId="task-detail-panel"
            label="Evidence"
            selected={tab === 'evidence'}
            onSelect={() => {
              setEvidenceGitSnapshotId(undefined);
              setTab('evidence');
            }}
          />
          <AccessibleTab
            id="task-detail-tab-debug"
            panelId="task-detail-panel"
            label="Debug"
            selected={tab === 'debug'}
            onSelect={() => setTab('debug')}
            badge={props.runs.length ? String(props.runs.length) : undefined}
            badgeAccessibleLabel={
              props.runs.length
                ? `${props.runs.length} ${props.runs.length === 1 ? 'run' : 'runs'}`
                : undefined
            }
          />
        </div>
      </div>

      <div
        id="task-detail-panel"
        className="tm-detail__body"
        ref={bodyRef}
        role="tabpanel"
        aria-labelledby={`task-detail-tab-${tab}`}
        inert={taskDetailModalOpen ? true : undefined}
        aria-hidden={taskDetailModalOpen ? true : undefined}
      >
        {error && !requestDrawer ? <div className="tm-error">{error}</div> : null}

        {tab === 'overview' ? (
          <div className="tm-overview">
            {/* WORK STREAM — live run state on top, static request collapsed below. */}
            <div className="tm-overview__col">
              <InteractionPanel
                interactions={interactions}
                sessions={sessions}
                onRespond={props.onRespondToInteraction}
              />

              {runFailure ? (
                <div className="tm-failure">
                  <div className="tm-failure__head">
                    <StatusGlyph kind="blocked" />
                    <span className="tm-failure__eyebrow">
                      {humanizeEnum(runFailure.status)}
                    </span>
                  </div>
                  <h3 className="tm-panel__title tm-panel__title--failure">
                    {runFailure.title}
                  </h3>
                  <p className="tm-panel__lead tm-panel__lead--flush">
                    {runFailure.detail}
                  </p>
                </div>
              ) : null}

              <TaskWorkPanels>
                {runProgress ? (
                  <RunProgressCard
                    progress={runProgress}
                    runStartedAt={progressRun?.startedAt}
                    scope={runProgressScope}
                    animate={!prefersReducedMotion}
                    completedChangeSummary={
                      progressRun ? (
                        <CompletedChangeSummaryPanel
                          run={progressRun}
                          gitSnapshots={gitSnapshots}
                          artifacts={props.artifacts}
                          onViewDiff={(snapshotId) => {
                            setEvidenceGitSnapshotId(snapshotId);
                            setTab('evidence');
                          }}
                        />
                      ) : undefined
                    }
                    onShowDebug={() => setTab('debug')}
                    onStop={
                      runProgress.state === 'RUNNING' && progressRun
                        ? () => void props.onCancel(runProgress.runId)
                        : undefined
                    }
                    stopDisabled={reviewActionBusy || deliveryActionBusy}
                  />
                ) : null}

                {reviewPhaseVisible ? (
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
                    onReviewAgain={() => onNextAction('run-review-again')}
                    reviewAgainDisabled={nextActionState('run-review-again').disabled}
                    reviewAgainTitle={nextActionState('run-review-again').title}
                    action={shouldShowOverviewNextAction(reviewPhaseVisible, awaitingMoveToReview) ? (
                      <NextActionPanel
                        model={nextAction}
                        requirements={[]}
                        onAction={onNextAction}
                        actionState={nextActionState}
                        placement="state"
                      />
                    ) : undefined}
                    onStopReview={(reviewRunId) => void stopReview(reviewRunId)}
                  />
                ) : null}

                <AgentControlPanel
                  run={primarySessionMatches ? run : undefined}
                  requiresRecovery={implementationRetryRequired}
                  interactions={interactions}
                  onSteer={props.onSteer}
                  onInterrupt={props.onCancel}
                  onContinue={props.onContinue}
                  onRetry={props.onRetry}
                />
              </TaskWorkPanels>

              <RequestCard
                prompt={task.prompt}
                promptLineCount={promptLineCount}
                attachments={props.attachments}
                summaryLine={`${model}/${effort} · ${formatAgentPermissionMode(
                  displayedAgentSettings
                )} · ${promptLineCount}-line prompt${
                  props.attachments.length > 0
                    ? ` · ${props.attachments.length} ${
                        props.attachments.length === 1 ? 'attachment' : 'attachments'
                      }`
                    : ''
                }`}
                hasRun={Boolean(run)}
                config={
                  <>
                    <ConfigRow k="Model / effort" v={`${model} / ${effort}`} />
                    <ConfigRow
                      k="Permissions"
                      v={formatAgentPermissionMode(displayedAgentSettings)}
                    />
                    <ConfigRow k="Network" v={formatAgentNetworkAccess(displayedAgentSettings)} />
                    <ConfigRow k="Branch" v={worktree?.branchName ?? 'Not created'} />
                  </>
                }
              />
            </div>

            {/* CONTEXT RAIL — delivery state and history stay secondary to the
                current decision and the work stream. */}
            <div className="tm-overview__col">
              {attached && worktree ? (
                <AttachedWorktreePanel
                  key={`${worktree.id}:${worktree.worktreePath}:${worktree.baseSha}`}
                  task={task}
                  worktree={worktree}
                  gitSnapshot={gitSnapshot}
                  busy={reviewActionsPaused || reviewActionBusy || deliveryActionBusy}
                  onRefresh={() => runDeliveryAction(() => props.onRefreshEvidence(task.id))}
                  onReconnect={() => runDeliveryAction(() => props.onReconnectWorktree(task.id))}
                  onUpdateComparison={(comparison) => runDeliveryAction(() => props.onUpdateWorktreeComparison(task.id, comparison))}
                />
              ) : null}
              {showPrStatus ? (
                <PrStatusCard
                  view={prStatus}
                  actionState={prActionState}
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
              ) : null}

              <PreviewOverviewCard
                key={task.id}
                {...previewPanelProps}
                onShowDetails={() => setTab('preview')}
              />

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

        {tab === 'preview' ? (
          <PreviewWorkspace key={task.id} {...previewPanelProps} />
        ) : null}

        {tab === 'evidence' ? (
          <div className="tm-evtab">
            <EvidencePanel
              run={run}
              worktree={worktree}
              gitSnapshot={evidenceGitSnapshot}
              githubRepository={props.githubRepository}
              branchPublication={props.branchPublication}
              pullRequest={pullRequest}
              ciRollup={props.ciRollup}
              reviewRollup={props.reviewRollup}
              mergeSnapshot={props.mergeSnapshot}
              artifacts={props.artifacts}
            />
          </div>
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

      <div ref={previewModalRootRef} />

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
          disabledReason={finishEvidence.mode === 'blocked' ? 'Finish requirements changed. Refresh the evidence before marking done.' : reviewActionPauseTitle}
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
          onSubmit={() => void submitDraftPr()}
          fallbackReturnFocusRef={detailRootRef}
        />
      ) : null}

      {requestDrawer ? (
        <ReviewRequestDrawer
          task={task}
          firstImplementation={!requestDrawer.sourceReviewRunId}
          sharedCheckout={attached}
          disabledReason={requestDisabledReason || undefined}
          error={requestError}
          findings={reviewFindings}
          selectedFindingIds={selectedReviewFindingIds}
          note={requestNote}
          instruction={requestInstruction}
          busy={reviewActionBusy}
          onToggleFinding={toggleSelectedReviewFinding}
          onNoteChange={updateRequestNote}
          onInstructionChange={setRequestInstruction}
          onCancel={() => setRequestDrawer(undefined)}
          onSubmit={() => void submitRequestChanges()}
          fallbackReturnFocusRef={detailRootRef}
        />
      ) : null}
    </main>
  );
}

export function TaskWorkPanels({ children }: { children: ReactNode }) {
  return (
    <section className="tm-workpanels" aria-labelledby="task-work-panels-title">
      <h2 id="task-work-panels-title" className="tm-visually-hidden">
        Progress, review, and agent controls
      </h2>
      {children}
    </section>
  );
}

function ConfigRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="tm-config__row">
      <span className="tm-config__k">{k}</span>
      <span className="tm-config__v">{v}</span>
    </div>
  );
}

/**
 * The task's static request (prompt + run config). It outranks live state on
 * the current page (audit §04: "static config outranks live state"), so once a
 * run exists it collapses to a one-line summary and expands on demand; before a
 * run it stays open as the primary thing on the page.
 */
export function RequestCard({
  prompt,
  promptLineCount,
  attachments,
  summaryLine,
  config,
  hasRun
}: {
  prompt: string;
  promptLineCount: number;
  attachments: TaskAttachmentRecord[];
  summaryLine: string;
  config: ReactNode;
  hasRun: boolean;
}) {
  return (
    <details className="tm-panel tm-requestcard" open={!hasRun}>
      <summary className="tm-requestcard__summary">
        <span className="tm-disclosure__label">
          <DisclosureChevron />
          <h3 className="tm-panel__title tm-panel__title--flush">
            Request
          </h3>
        </span>
        <span className="tm-requestcard__line">{summaryLine}</span>
      </summary>
      <div className="tm-config tm-config--request">
        {config}
      </div>
      {attachments.length > 0 ? (
        <div className="tm-requestcard__attachments" aria-label="Task attachments">
          <div className="tm-requestcard__attachments-head">
            <span>Attachments</span>
            <span>{attachments.length}</span>
          </div>
          <ul>
            {attachments.map((attachment) => (
              <li key={attachment.id}>
                <span title={attachment.displayName}>{attachment.displayName}</span>
                <span>
                  {attachment.kind === 'image' ? 'Image' : 'Text'} ·{' '}
                  {formatAttachmentBytes(attachment.byteCount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="tm-raw tm-requestcard__prompt">
        <summary>
          <DisclosureChevron />
          <span>Prompt · {promptLineCount} lines</span>
        </summary>
        <pre>{prompt}</pre>
      </details>
    </details>
  );
}

/**
 * The one place a task answers "what should I do next?" Overview actions can
 * be placed inside their owning state block; task-level transitions use the
 * same surface above the tabs so they remain available from every task tab.
 */
export function NextActionPanel({
  model,
  requirements,
  onAction,
  actionState,
  placement = 'rail'
}: {
  model: NextActionModel;
  requirements: FinishRequirement[];
  onAction(id: NextActionId): void;
  actionState(id: NextActionId): { disabled?: boolean; title?: string };
  placement?: 'rail' | 'task' | 'state';
}) {
  const { primary, secondaries } = model;
  const stateBlockPlacement = placement === 'state';
  const visibleSecondaries = stateBlockPlacement ? [] : secondaries;
  const hasActions = Boolean(primary) || visibleSecondaries.length > 0;
  const reasonIdPrefix = useId();
  // Drop the Review requirement — its verdict already lives in the run surface's
  // review card, so restating it here would say the same fact twice (DESIGN.md §6).
  const gatingRequirements = requirements.filter(
    (requirement) => requirement.label !== 'Review'
  );
  if (stateBlockPlacement && !primary) {
    return null;
  }
  const renderAction = (
    choice: NonNullable<NextActionModel['primary']>,
    prominence: 'primary' | 'quiet'
  ) => {
    const state = actionState(choice.id);
    const reasonId = state.disabled && state.title
      ? `${reasonIdPrefix}-${choice.id}-reason`
      : undefined;

    return (
      <div
        key={choice.id}
        className={`tm-nextaction__action tm-nextaction__action--${prominence}`}
      >
        <button
          type="button"
          className={prominence === 'primary' ? 'primary-button' : 'tm-nextaction__quiet'}
          disabled={state.disabled}
          aria-describedby={reasonId}
          onClick={() => onAction(choice.id)}
        >
          {choice.label}
        </button>
        {reasonId ? (
          <span id={reasonId} className="tm-nextaction__reason">
            {state.title}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <section
      className={`tm-nextaction tm-nextaction--${placement}`}
      aria-label="Next action"
    >
      {!stateBlockPlacement ? (
        <p className="tm-nextaction__sentence">{model.sentence}</p>
      ) : null}
      {hasActions ? (
        <div className="tm-nextaction__actions">
          {primary ? renderAction(primary, 'primary') : null}
          {visibleSecondaries.map((secondary) => renderAction(secondary, 'quiet'))}
        </div>
      ) : null}
      {!stateBlockPlacement && gatingRequirements.length > 0 ? (
        <div className="tm-nextaction__requirements" aria-label="Finish requirements">
          {gatingRequirements.map((requirement) => (
            <span
              key={requirement.label}
              className={`tm-finishpanel__requirement tm-finishpanel__requirement--${requirement.tone}`}
            >
              {requirement.label} {requirement.detail}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
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
  onCreateDraftPr,
  onPushUpdate,
  onRefresh,
  onInvestigate
}: {
  view: PrStatusViewModel;
  actionState: ReturnType<typeof buildPrStatusActionState>;
  onCreateDraftPr(): void;
  onPushUpdate(): void;
  onRefresh(): void;
  onInvestigate(): void;
}) {
  const createOrPushTitle = buildPrStatusCreateOrPushTitle(
    view,
    actionState.createOrPushReason
  );
  const freshnessProblem = ['STALE', 'LOCAL_NOT_PUSHED', 'PR_NEWER_COMMITS', 'BRANCH_DIVERGED', 'HEAD_MISMATCH'].includes(view.kind);
  const stateMark = prStatusMark(view);

  return (
    <section className={`tm-panel tm-prstatus tm-prstatus--${view.tone}`} aria-label="PR Status">
      <div className="tm-prstatus__head">
        <span className="tm-prstatus__titleline">
          {stateMark !== 'idle' ? <StatusGlyph kind={stateMark} /> : null}
          <h3 className="tm-panel__title">PR Status</h3>
          {view.canRefresh ? (
            <ActionButtonTitle
              disabled={actionState.refreshDisabled}
              title={actionState.refreshReason ?? 'Refresh PR status'}
            >
              <button
                type="button"
                className="tm-prstatus__refresh"
                disabled={actionState.refreshDisabled}
                onClick={onRefresh}
                aria-label="Refresh"
              >
                <RefreshIcon />
              </button>
            </ActionButtonTitle>
          ) : null}
        </span>
        <span className="tm-prstatus__state">{view.headline}</span>
      </div>

      {freshnessProblem && view.freshnessLine ? (
        <div className="tm-prstatus__freshness">{view.freshnessLine}</div>
      ) : null}

      {view.leadLine ? <p className="tm-prstatus__lead">{view.leadLine}</p> : null}

      {view.hasPullRequest ||
      view.freshnessLine ||
      view.guidanceLine ||
      view.evidenceLine ? (
        <div className="tm-prstatus__meta">
          {view.hasPullRequest ? (
            <div className="tm-prstatus__identity">
              {view.prUrl ? (
                <a href={view.prUrl} target="_blank" rel="noreferrer">
                  {view.prIdentityLine ?? 'PR'}
                </a>
              ) : (
                <span>{view.prIdentityLine ?? 'PR'}</span>
              )}
            </div>
          ) : null}

          {!freshnessProblem && view.freshnessLine ? <p className="tm-prstatus__reason">{view.freshnessLine}</p> : null}
          {view.guidanceLine ? <p className="tm-prstatus__reason">{view.guidanceLine}</p> : null}

          {view.evidenceLine ? <div className="tm-prstatus__evidence">{view.evidenceLine}</div> : null}
          {view.refreshedLine ? <span className="tm-prstatus__refreshed">{view.refreshedLine}</span> : null}
        </div>
      ) : null}

      {view.canCreateDraftPr || view.canPushUpdate || view.canInvestigateFailure ? (
        <div className="tm-prstatus__actions">
          {view.canCreateDraftPr ? (
            <ActionButtonTitle
              disabled={actionState.createOrPushDisabled}
              title={createOrPushTitle}
            >
              {/* Delivery is a parallel path, not the recommended next step —
                  the single filled primary stays with the header / Next action
                  (audit §04 primary-action singleton). */}
              <button
                type="button"
                className="outline-button"
                disabled={actionState.createOrPushDisabled}
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
                className="outline-button"
                disabled={actionState.createOrPushDisabled}
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
                className="outline-button tm-prstatus__investigate"
                disabled={actionState.investigateDisabled}
                onClick={onInvestigate}
              >
                Investigate failure
              </button>
            </ActionButtonTitle>
          ) : null}
        </div>
      ) : null}

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

function prStatusMark(view: PrStatusViewModel): StatusGlyphKind {
  if (view.tone === 'error') return 'blocked';
  if (
    view.tone === 'action' &&
    !['CHECKS_PENDING', 'STALE', 'LOCAL_NOT_PUSHED', 'PR_NEWER_COMMITS', 'BRANCH_DIVERGED', 'HEAD_MISMATCH'].includes(view.kind)
  ) return 'waiting';
  return 'idle';
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
  return <RefreshCw aria-hidden="true" absoluteStrokeWidth size={13} strokeWidth={1.5} />;
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
  canStartFresh?: boolean;
  onPrepareWorktree(taskId: string): Promise<void>;
  onStart(taskId: string): Promise<void>;
}): { label: string; disabled?: boolean; onClick(): void } | undefined {
  if (input.canStartFresh) return {
    label: 'Start implementation',
    onClick: () => { void input.onStart(input.task.id).catch(() => {}); }
  };
  if (['IN_REVIEW', 'DONE', 'CANCELED', 'ARCHIVED'].includes(input.task.workflowPhase)) {
    return undefined;
  }

  if (canPrepareWorktree(input.task, input.worktree)) {
    return {
      label: 'Prepare worktree',
      onClick: () => void input.onPrepareWorktree(input.task.id)
    };
  }

  if (canStartRun(input.task)) {
    return {
      label: 'Start implementation',
      onClick: () => { void input.onStart(input.task.id).catch(() => {}); }
    };
  }

  return undefined;
}

function AttachedWorktreePanel({ task, worktree, gitSnapshot, busy, onRefresh, onReconnect, onUpdateComparison }: {
  task: Task;
  worktree: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  busy: boolean;
  onRefresh(): Promise<void>;
  onReconnect(): Promise<void>;
  onUpdateComparison(comparison: WorktreeComparison): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [comparisonType, setComparisonType] = useState<WorktreeComparison['type']>('MERGE_BASE');
  const [comparisonRef, setComparisonRef] = useState('');
  const unavailable = worktree.status !== 'PRESENT' || task.projection.worktree !== 'PRESENT' || task.projection.git === 'UNAVAILABLE';
  return (
    <section className="tm-panel" aria-label="Attached worktree">
      <h3 className="tm-panel__title">Worktree</h3>
      <div className="tm-config tm-config--worktree">
        <ConfigRow k="Path" v={worktree.worktreePath} />
        <ConfigRow k="Branch" v={worktree.branchName} />
        <ConfigRow k="Compare with" v={worktree.baseRef ?? worktree.baseSha} />
        <ConfigRow k="Last observed" v={gitSnapshot ? new Date(gitSnapshot.capturedAt).toLocaleString() : 'Not inspected'} />
      </div>
      <div className="tm-prstatus__actions">
        <button type="button" className="outline-button" disabled={busy} onClick={() => void onRefresh()}>Refresh Git</button>
        {unavailable ? <button type="button" className="outline-button" disabled={busy} onClick={() => void onReconnect()}>Reconnect worktree</button> : null}
        <button type="button" className="outline-button" disabled={busy} onClick={() => {
          setComparisonType(!worktree.baseRef || worktree.baseRef === worktree.baseSha ? 'COMMIT' : 'MERGE_BASE');
          setComparisonRef(worktree.baseRef ?? worktree.baseSha);
          setEditing(true);
        }}>Edit comparison</button>
      </div>
      {editing ? <form onSubmit={(event) => {
        event.preventDefault();
        if (busy || !comparisonRef.trim()) return;
        void onUpdateComparison({ type: comparisonType, ref: comparisonRef.trim() }).then(() => setEditing(false)).catch(() => {});
      }}>
        <label className="field"><span className="field__label">Comparison</span>
          <select disabled={busy} value={comparisonType} onChange={(event) => setComparisonType(event.target.value as WorktreeComparison['type'])}>
            <option value="MERGE_BASE">Merge base</option><option value="COMMIT">Commit</option>
          </select>
        </label>
        <label className="field"><span className="field__label">Reference</span>
          <input disabled={busy} value={comparisonRef} onChange={(event) => setComparisonRef(event.target.value)} />
        </label>
        <div className="tm-prstatus__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy || !comparisonRef.trim()}>Save comparison</button>
        </div>
      </form> : null}
    </section>
  );
}
