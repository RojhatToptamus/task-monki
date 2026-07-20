import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject
} from 'react';
import {
  getImplementationRetryReason,
  PULL_REQUEST_TITLE_MAX_LENGTH,
  normalizePullRequestTitle
} from '../../shared/contracts';
import type {
  ArtifactRecord,
  BranchPublicationRecord,
  CiRollupRecord,
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
  AgentReviewFinding,
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
  WorktreeRecord
} from '../../shared/contracts';
import type { TaskAttachmentRecord } from '../../shared/attachments';
import {
  canCreateDeliveryCommit,
  canPrepareWorktree,
  canStartRun,
  formatShortId
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
import { Chip } from './StatusBadge';
import { useDialogFocusBoundary } from './dialogFocus';
import {
  FindingRow,
  findingLevel,
  formatFindingLocation,
  shortFindingRef
} from './Findings';
import {
  findCompletedCurrentImplementationRun,
  isActiveNonReviewRun,
  isCompletedCurrentImplementationRun,
  isImplementationRetryRequired,
  selectNextAction,
  shouldShowOverviewNextAction,
  type NextActionId,
  type NextActionModel
} from '../model/nextAction';
import {
  canRequestReviewChanges,
  describeRunFailureBanner,
  describeTaskHeaderState,
  finishRequirementsForTask,
  getFinishEvidenceState,
  markDoneModalCopy,
  taskReviewGate,
  type FinishEvidenceState,
  type FinishRequirement,
  type Tone
} from './taskView';
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
  getMascotStateForTask,
  type MascotState
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
import type { PreviewTaskRouteOption } from '../model/previewBindings';

interface TaskDetailProps {
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
  onStart(taskId: string): Promise<void>;
  onCancel(runId: string): Promise<void>;
  onSteer(runId: string, instruction: string): Promise<void>;
  onContinue(runId: string, instruction?: string): Promise<void>;
  onRetry(runId: string, strategy: AgentRetryStrategy, instruction?: string): Promise<void>;
  onReview(runId: string): Promise<void>;
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
  const [requestDrawerOpen, setRequestDrawerOpen] = useState(false);
  const [selectedReviewFindingIds, setSelectedReviewFindingIds] = useState<string[]>([]);
  const [markDoneModal, setMarkDoneModal] = useState<'clean' | 'issues'>();
  const [draftPrModalOpen, setDraftPrModalOpen] = useState(false);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [draftPrTitle, setDraftPrTitle] = useState('');
  const [requestNote, setRequestNote] = useState('');
  const [requestInstruction, setRequestInstruction] = useState('');
  const [evidenceGitSnapshotId, setEvidenceGitSnapshotId] = useState<string | undefined>();
  const [reviewActionBusy, setReviewActionBusy] = useState(false);
  const [deliveryActionBusy, setDeliveryActionBusy] = useState(false);
  const [reviewStartPending, setReviewStartPending] = useState(false);
  const [reviewMascotHoldGeneration, setReviewMascotHoldGeneration] = useState(0);
  const reviewActionInFlightRef = useRef(false);
  const deliveryActionInFlightRef = useRef(false);
  const detailRootRef = useRef<HTMLElement>(null);
  const previewModalRootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const debugActivityRef = useRef<HTMLElement>(null);
  const focusActivityHistoryRef = useRef(false);
  const repositoryContextId = useId();
  const taskDetailModalOpen = Boolean(
    markDoneModal || draftPrModalOpen || requestDrawerOpen || previewModalOpen
  );
  const prefersReducedMotion = usePrefersReducedMotion();
  const reviewGate = task ? taskReviewGate(task) : undefined;
  const reviewIsRunning = reviewGate?.status === 'RUNNING';
  const reviewPending = reviewStartPending && !reviewIsRunning;
  const reviewMascotHoldActive = reviewMascotHoldGeneration > 0;
  const reviewActiveForMascot = reviewMascotHoldActive || reviewIsRunning;
  const headerState = task ? describeTaskHeaderState(task) : undefined;
  const prStatus = task
    ? buildPrStatusViewModel({
        task,
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
    setRequestDrawerOpen(false);
    setSelectedReviewFindingIds([]);
    setRequestNote('');
    setDraftPrModalOpen(false);
    setDraftPrTitle(task ? normalizePullRequestTitle(undefined, task.title) : '');
    setEvidenceGitSnapshotId(undefined);
  }, [task?.id, task?.title]);

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
  const promptLineCount = task.prompt.split(/\r?\n/).length;
  const reviewFindings = reviewGate.result?.findings ?? [];
  const reviewRun =
    props.runs.find((candidate) => candidate.id === reviewGate.runId) ??
    props.runs.find(
      (candidate) =>
        candidate.mode === 'REVIEW' && candidate.iterationId === task.currentIterationId
    );
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
    (isReviewPhase(task.workflowPhase) && Boolean(actionableReviewSourceRun));
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
    hasInvestigationSource: Boolean(deliverySourceRun)
  });
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

  const runReview = async (sourceRunId: string) => {
    if (reviewActionInFlightRef.current) {
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

  const openRequestChanges = (findingIds?: string[]) => {
    const hasReviewOutput = Boolean(reviewGate.result) || Boolean(reviewRun?.finalMessage?.trim());
    if (
      !actionableReviewSourceRun ||
      reviewActionsPaused ||
      !canRequestReviewChanges(reviewGate, reviewGate.status, hasReviewOutput)
    ) {
      return;
    }
    const selectedIds = findingIds?.length
      ? findingIds
      : defaultSelectedFindingIds(reviewFindings);
    setSelectedReviewFindingIds(selectedIds);
    setRequestNote('');
    setRequestInstruction(
      buildReviewFollowUpInstruction(task, reviewGate, reviewRun, selectedIds)
    );
    setRequestDrawerOpen(true);
  };

  const submitRequestChanges = async () => {
    if (!actionableReviewSourceRun || !requestInstruction.trim() || reviewActionsPaused) {
      return;
    }
    await runReviewAction(async () => {
      try {
        await props.onContinue(actionableReviewSourceRun.id, requestInstruction.trim());
        setRequestDrawerOpen(false);
      } catch {
        // The app shell reports the error. Keep the drawer open so the user can retry.
      }
    });
  };

  const toggleSelectedReviewFinding = (findingId: string) => {
    const next = selectedReviewFindingIds.includes(findingId)
      ? selectedReviewFindingIds.filter((id) => id !== findingId)
      : [...selectedReviewFindingIds, findingId];
    setSelectedReviewFindingIds(next);
    setRequestInstruction(
      buildReviewFollowUpInstruction(task, reviewGate, reviewRun, next, requestNote)
    );
  };

  const updateRequestNote = (note: string) => {
    setRequestNote(note);
    setRequestInstruction(
      buildReviewFollowUpInstruction(
        task,
        reviewGate,
        reviewRun,
        selectedReviewFindingIds,
        note
      )
    );
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
    if (!deliverySourceRun || !prStatus.canInvestigateFailure || prActionState.investigateDisabled) {
      return;
    }
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
        if (actionableReviewSourceRun) {
          void runReview(actionableReviewSourceRun.id);
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
          (!actionableReviewSourceRun
            ? 'Complete an implementation run before starting review.'
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
        const title = !canCreateDeliveryCommit(task)
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
    onPrepareWorktree: props.onPrepareWorktree,
    onStart: props.onStart
  });
  const implementationRetryRequired = isImplementationRetryRequired(task, run);

  const headActions: HeadAction[] = [];
  if (shouldShowMoveToReviewHeaderAction(task, run)) {
    headActions.push({
      label: 'Move to review',
      kind: 'soft',
      onClick: () => void props.onTransition(task.id, 'REVIEW')
    });
  }
  if (primaryAction) {
    headActions.push({
      label: primaryAction.label,
      kind: 'primary',
      disabled:
        primaryAction.disabled ||
        reviewActionsPaused ||
        props.repository?.status !== 'AVAILABLE',
      title:
        props.repository?.status !== 'AVAILABLE'
          ? 'Reconnect this repository before running repository actions.'
          : undefined,
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
  const finishRequirements = finishRequirementsForTask(
    task,
    reviewPending ? 'RUNNING' : reviewGate.status,
    dirtyFileCount,
    finishMergeStatus,
    finishCiStatus,
    finishVerifiedChecksEvidence
  );
  const runFailure = describeRunFailureBanner(task);

  // The single "what next" model for the rail. Kept in one place so the header,
  // run surface, and rail all agree instead of each inventing an action.
  const awaitingMoveToReview = shouldShowMoveToReviewHeaderAction(task, run);
  const reviewHasOutput = Boolean(reviewGate.result) || Boolean(reviewRun?.finalMessage?.trim());
  const reviewHasActionableFindings =
    Boolean(actionableReviewSourceRun) &&
    canRequestReviewChanges(reviewGate, reviewGate.status, reviewHasOutput);
  const nextAction = selectNextAction({
    task,
    reviewStatus: reviewPending ? 'RUNNING' : reviewGate.status,
    finishEvidence,
    requirements: finishRequirements,
    hasReviewSource: Boolean(actionableReviewSourceRun),
    reviewHasActionableFindings,
    canCommit: canCreateDeliveryCommit(task),
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
              <h1 className="tm-detail__title">{task.title}</h1>
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
        <div className="tm-tabs">
          <TabButton label="Overview" active={tab === 'overview'} onClick={() => setTab('overview')} />
          <TabButton label="Preview" active={tab === 'preview'} onClick={() => setTab('preview')} />
          <TabButton
            label="Evidence"
            active={tab === 'evidence'}
            onClick={() => {
              setEvidenceGitSnapshotId(undefined);
              setTab('evidence');
            }}
          />
          <TabButton
            label="Debug"
            active={tab === 'debug'}
            onClick={() => setTab('debug')}
            badge={props.runs.length ? String(props.runs.length) : undefined}
          />
        </div>
      </div>

      <div
        className="tm-detail__body"
        ref={bodyRef}
        inert={taskDetailModalOpen ? true : undefined}
        aria-hidden={taskDetailModalOpen ? true : undefined}
      >
        {error ? <div className="tm-error">{error}</div> : null}

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
                    <span className="tm-failure__dot" />
                    <span className="tm-failure__eyebrow">
                      {humanizeEnum(runFailure.status)}
                    </span>
                  </div>
                  <h3 className="tm-panel__title" style={{ margin: '0 0 7px' }}>
                    {runFailure.title}
                  </h3>
                  <p className="tm-panel__lead" style={{ margin: 0 }}>
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
                          onReviewChanges={(snapshotId) => {
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
                    onStopReview={(reviewRunId) => void stopReview(reviewRunId)}
                  />
                ) : null}

                <AgentControlPanel
                  run={run}
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
              {shouldShowOverviewNextAction(reviewPhaseVisible, awaitingMoveToReview) ? (
                <NextActionPanel
                  model={nextAction}
                  requirements={finishRequirements}
                  onAction={onNextAction}
                  actionState={nextActionState}
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

      {requestDrawerOpen ? (
        <ReviewRequestDrawer
          task={task}
          findings={reviewFindings}
          selectedFindingIds={selectedReviewFindingIds}
          note={requestNote}
          instruction={requestInstruction}
          busy={reviewActionBusy}
          onToggleFinding={toggleSelectedReviewFinding}
          onNoteChange={updateRequestNote}
          onInstructionChange={setRequestInstruction}
          onCancel={() => setRequestDrawerOpen(false)}
          onSubmit={() => void submitRequestChanges()}
          fallbackReturnFocusRef={detailRootRef}
        />
      ) : null}
    </main>
  );
}

function CreateDraftPrModal({
  title,
  worktree,
  busy,
  disabled,
  disabledReason,
  onTitleChange,
  onCancel,
  onSubmit,
  fallbackReturnFocusRef
}: {
  title: string;
  worktree?: WorktreeRecord;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onTitleChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const confirmDisabled = busy || disabled || !cleanTitle;
  const panelRef = useRef<HTMLFormElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: titleInputRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmDisabled) {
      onSubmit();
    }
  };

  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="draft-pr-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <form
        ref={panelRef}
        className="tm-modal__panel tm-draftpr-modal"
        tabIndex={-1}
        onSubmit={submit}
      >
        <h3 id="draft-pr-title">Create draft PR</h3>
        <p>Review the title before Task Monki opens the draft pull request.</p>

        <label className="field tm-draftpr-modal__field">
          <span className="field__label">PR title</span>
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            maxLength={PULL_REQUEST_TITLE_MAX_LENGTH}
            disabled={busy}
            onChange={(event) => onTitleChange(event.target.value)}
          />
          <small>{cleanTitle.length} / {PULL_REQUEST_TITLE_MAX_LENGTH}</small>
        </label>

        {worktree ? (
          <div className="tm-draftpr-modal__context">
            <div>
              <span>Head</span>
              <strong>{worktree.branchName}</strong>
            </div>
            <div>
              <span>Base</span>
              <strong>{worktree.baseRef ?? 'main'}</strong>
            </div>
          </div>
        ) : null}

        {disabled && disabledReason ? <p className="form-warning">{disabledReason}</p> : null}

        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={confirmDisabled}>
            {busy ? 'Creating...' : 'Create draft PR'}
          </button>
        </div>
      </form>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
  badge
}: {
  label: string;
  active: boolean;
  onClick(): void;
  badge?: string;
}) {
  return (
    <button type="button" className={`tm-tab ${active ? 'tm-tab--active' : ''}`} onClick={onClick}>
      {label}
      {badge ? <span className="tm-tab__badge">{badge}</span> : null}
    </button>
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
        <span className="tm-requestcard__caret" aria-hidden="true">
          ›
        </span>
        <h3 className="tm-panel__title" style={{ margin: 0 }}>
          Request
        </h3>
        <span className="tm-requestcard__line">{summaryLine}</span>
      </summary>
      <details className="tm-raw tm-requestcard__prompt">
        <summary>Prompt · {promptLineCount} lines</summary>
        <pre>{prompt}</pre>
      </details>
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
      <div className="tm-config" style={{ marginTop: 14 }}>
        {config}
      </div>
    </details>
  );
}

/**
 * The one place a task answers "what should I do next?" It normally lives at
 * the top of the Overview rail; task-level transitions use the same surface
 * above the tabs so they remain available from every task tab.
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
  placement?: 'rail' | 'task';
}) {
  const { primary, secondaries } = model;
  const hasActions = Boolean(primary) || secondaries.length > 0;
  const reasonIdPrefix = useId();
  // Drop the Review requirement — its verdict already lives in the run surface's
  // review card, so restating it here would say the same fact twice (DESIGN.md §6).
  const gatingRequirements = requirements.filter(
    (requirement) => requirement.label !== 'Review'
  );
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
      <p className="tm-nextaction__sentence">{model.sentence}</p>
      {hasActions ? (
        <div className="tm-nextaction__actions">
          {primary ? renderAction(primary, 'primary') : null}
          {secondaries.map((secondary) => renderAction(secondary, 'quiet'))}
        </div>
      ) : null}
      {gatingRequirements.length > 0 ? (
        <div className="tm-nextaction__requirements" aria-label="Finish requirements">
          {gatingRequirements.map((requirement) => (
            <span
              key={requirement.label}
              className={`tm-finishpanel__requirement tm-finishpanel__requirement--${requirement.tone}`}
            >
              <span className="tm-finishpanel__requirement-dot" aria-hidden="true" />
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

  return (
    <section className={`tm-panel tm-prstatus tm-prstatus--${view.tone}`} aria-label="PR Status">
      <div className="tm-prstatus__head">
        <span className="tm-prstatus__titleline">
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
        {view.refreshedLine ? <span className="tm-prstatus__refreshed">{view.refreshedLine}</span> : null}
      </div>

      <div className="tm-prstatus__headline-row">
        <span
          className={`tm-prstatus__dot tm-prstatus__dot--${view.tone} ${
            view.kind === 'CHECKS_PENDING' ? 'tm-prstatus__dot--pulse' : ''
          }`}
          aria-hidden="true"
        />
        <p className="tm-prstatus__headline">{view.headline}</p>
      </div>

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

          {view.freshnessLine ? <p className="tm-prstatus__reason">{view.freshnessLine}</p> : null}
          {view.guidanceLine ? <p className="tm-prstatus__reason">{view.guidanceLine}</p> : null}

          {view.evidenceLine ? <div className="tm-prstatus__evidence">{view.evidenceLine}</div> : null}
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
    <div className="tm-prchecks" aria-label="GitHub check details">
      <div className="tm-prchecks__head">
        <span>Checks</span>
        <span>{checks.length}</span>
      </div>
      <div className="tm-prchecks__rows">
        {checks.map((check) => (
          <details
            key={`${check.name}-${check.workflow ?? ''}-${check.link ?? ''}`}
            className={`tm-prcheck tm-prcheck--${check.status}`}
          >
            <summary>
              <span className="tm-prcheck__name">
                <span className="tm-prcheck__chevron" aria-hidden="true">
                  <ChevronRightIcon />
                </span>
                <span className={`tm-prcheck__dot tm-prcheck__dot--${check.status}`} aria-hidden="true" />
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
    </div>
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
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReviewRequestDrawer({
  task,
  findings,
  selectedFindingIds,
  note,
  instruction,
  busy,
  onToggleFinding,
  onNoteChange,
  onInstructionChange,
  onCancel,
  onSubmit,
  fallbackReturnFocusRef
}: {
  task: Task;
  findings: AgentReviewFinding[];
  selectedFindingIds: string[];
  note: string;
  instruction: string;
  busy: boolean;
  onToggleFinding(findingId: string): void;
  onNoteChange(value: string): void;
  onInstructionChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const selectedCount = selectedFindingIds.length;
  const panelRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: noteRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });
  return (
    <div className="tm-reviewdrawer" role="dialog" aria-modal="true" aria-label="Request changes">
      <div className="tm-reviewdrawer__scrim" onClick={busy ? undefined : onCancel} />
      <aside ref={panelRef} className="tm-reviewdrawer__panel" tabIndex={-1}>
        <header className="tm-reviewdrawer__header">
          <div>
            <h3>Request changes</h3>
            <p>Start a follow-up run with the selected findings for #{formatShortId(task.id)}.</p>
          </div>
          <button
            type="button"
            className="tm-reviewdrawer__close"
            disabled={busy}
            aria-label="Close request changes"
            onClick={onCancel}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="tm-reviewdrawer__body" inert={busy ? true : undefined}>
          <section className="tm-reviewdrawer__section">
            <h4>Findings to attach · {selectedCount} selected</h4>
            {findings.length > 0 ? (
              <div className="tm-reviewdrawer__findings tm-reviewfindings__list">
                {findings.map((finding) => {
                  const level = findingLevel(finding.severity);
                  return (
                    <FindingRow
                      key={finding.id}
                      tone={level.tone}
                      severityLabel={level.label}
                      title={finding.title}
                      reference={shortFindingRef(finding)}
                      selection={{
                        checked: selectedFindingIds.includes(finding.id),
                        onToggle: () => onToggleFinding(finding.id)
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              <p className="tm-reviewdrawer__empty">
                No structured findings were returned. The instruction includes the review summary.
              </p>
            )}
          </section>

          <label className="tm-reviewdrawer__section">
            <h4>Optional note</h4>
            <textarea
              ref={noteRef}
              className="tm-reviewdrawer__note"
              value={note}
              disabled={busy}
              placeholder="Add context for the follow-up"
              onChange={(event) => onNoteChange(event.target.value)}
              rows={3}
            />
          </label>

          <details className="tm-reviewdrawer__instruction">
            <summary>Full instruction</summary>
            <label>
              <span>Instruction to agent</span>
              <textarea
                value={instruction}
                disabled={busy}
                onChange={(event) => onInstructionChange(event.target.value)}
                rows={11}
              />
              <small>Generated from the selected findings and optional note. Editable.</small>
            </label>
          </details>
        </div>

        <footer className="tm-reviewdrawer__footer">
          <span>Returns to Review when the follow-up finishes.</span>
          <div>
            <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy || !instruction.trim()}
              onClick={onSubmit}
            >
              {busy ? 'Sending...' : 'Send to agent'}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function isReviewPhase(phase: WorkflowPhase): boolean {
  return phase === 'REVIEW' || phase === 'IN_REVIEW';
}

export function shouldShowMoveToReviewHeaderAction(
  task: Pick<Task, 'currentRunId' | 'workflowPhase' | 'projection'>,
  run: Pick<RunRecord, 'id' | 'mode' | 'status'> | undefined
): boolean {
  return (
    isCompletedCurrentImplementationRun(task, run) &&
    !isImplementationRetryRequired(task, run) &&
    !['REVIEW', 'IN_REVIEW', 'DONE', 'CANCELED', 'ARCHIVED'].includes(task.workflowPhase)
  );
}

function MarkDoneModal({
  withIssues,
  warnings,
  hasPullRequest,
  requirements,
  busy,
  onCancel,
  onConfirm,
  fallbackReturnFocusRef
}: {
  withIssues: boolean;
  warnings: FinishEvidenceState['warnings'];
  hasPullRequest: boolean;
  requirements: FinishRequirement[];
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const copy = markDoneModalCopy(withIssues, busy, { hasPullRequest });
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: cancelRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });
  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="mark-done-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <div ref={panelRef} className="tm-modal__panel" tabIndex={-1}>
        <h3 id="mark-done-title">{copy.title}</h3>
        <p>{copy.body}</p>
        {withIssues && requirements.length > 0 ? (
          <div className="tm-modal__requirements">
            <div className="tm-modal__requirements-title">Unresolved</div>
            {requirements.map((requirement) => (
              <div
                className={`tm-modal__requirement tm-modal__requirement--${requirement.tone}`}
                key={requirement.label}
              >
                <span className="tm-modal__requirement-dot" aria-hidden="true" />
                <span>
                  <strong>{requirement.label}</strong> — {requirement.detail}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {withIssues && requirements.length === 0 ? (
          <div className="tm-modal__warning">
            <strong>{copy.fallbackWarningTitle}</strong>
            <span>{warnings[0]?.detail ?? copy.fallbackWarningDetail}</span>
          </div>
        ) : null}
        <div className="tm-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="outline-button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>
            {copy.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
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

export function buildReviewFollowUpInstruction(
  task: Task,
  reviewGate: NonNullable<Task['projection']['agentReview']>,
  reviewRun: RunRecord | undefined,
  selectedFindingIds: string[],
  note = ''
): string {
  const selectedFindings = (reviewGate.result?.findings ?? []).filter((finding) =>
    selectedFindingIds.includes(finding.id)
  );
  const lines = [
    `Address the review result for "${task.title}".`,
    '',
    `Review status: ${humanizeEnum(reviewGate.status)}.`
  ];
  if (reviewGate.result?.summary) {
    lines.push('', `Review summary: ${reviewGate.result.summary}`);
  } else if (reviewGate.summary) {
    lines.push('', `Review summary: ${reviewGate.summary}`);
  }

  if (selectedFindings.length > 0) {
    lines.push('', 'Selected findings to fix:');
    for (const [index, finding] of selectedFindings.entries()) {
      lines.push(
        '',
        `${index + 1}. [${humanizeEnum(finding.severity)}] ${finding.title}`,
        `   Location: ${formatFindingLocation(finding)}`,
        `   Explanation: ${finding.explanation}`
      );
      if (finding.recommendation) {
        lines.push(`   Recommendation: ${finding.recommendation}`);
      }
    }
  } else if (reviewRun?.finalMessage) {
    lines.push('', 'Review output:', reviewRun.finalMessage.trim());
  }
  if (note.trim()) {
    lines.push('', 'Additional note:', note.trim());
  }
  lines.push(
    '',
    [
      'Fix only the selected findings or review output above unless the root cause requires a scoped adjacent change.',
      'Preserve the existing task intent and stop when the follow-up is ready for review again.'
    ].join(' ')
  );
  return lines.join('\n');
}

function defaultSelectedFindingIds(findings: AgentReviewFinding[]): string[] {
  const blocking = findings.filter(
    (finding) => finding.severity === 'BLOCKER' || finding.severity === 'MAJOR'
  );
  return (blocking.length > 0 ? blocking : findings).map((finding) => finding.id);
}
type MascotVideoLayerPhase = 'entering' | 'active' | 'exiting';

const MASCOT_EXIT_FALLBACK_MS = 620;
const MASCOT_PLAYBACK_RATE = 0.85;

interface MascotVideoLayer {
  id: number;
  source: string;
  state: MascotState;
  phase: MascotVideoLayerPhase;
}

function TaskMascotVideo({
  source,
  state,
  prefersReducedMotion
}: {
  source: string;
  state: MascotState;
  prefersReducedMotion: boolean;
}) {
  const nextLayerIdRef = useRef(1);
  const videoRefs = useRef(new Map<number, HTMLVideoElement>());
  const [layers, setLayers] = useState<MascotVideoLayer[]>([
    { id: 0, source, state, phase: 'active' }
  ]);

  useEffect(() => {
    setLayers((current) => {
      const active =
        current.find((layer) => layer.phase === 'active') ?? current[current.length - 1];
      if (prefersReducedMotion) {
        if (active?.source === source) {
          return [{ ...active, state, phase: 'active' }];
        }

        const nextLayer: MascotVideoLayer = {
          id: nextLayerIdRef.current,
          source,
          state,
          phase: 'active'
        };
        nextLayerIdRef.current += 1;
        return [nextLayer];
      }

      if (active?.source === source) {
        return current.map((layer) =>
          layer.source === source
            ? { ...layer, state, phase: 'active' }
            : { ...layer, phase: 'exiting' }
        );
      }

      const nextLayer: MascotVideoLayer = {
        id: nextLayerIdRef.current,
        source,
        state,
        phase: 'entering'
      };
      nextLayerIdRef.current += 1;

      return [
        ...current.map((layer) => ({ ...layer, phase: 'exiting' as const })).slice(-1),
        nextLayer
      ];
    });
  }, [source, state, prefersReducedMotion]);

  useEffect(() => {
    if (prefersReducedMotion || !layers.some((layer) => layer.phase === 'entering')) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      setLayers((current) =>
        current.map((layer) =>
          layer.phase === 'entering' ? { ...layer, phase: 'active' } : layer
        )
      );
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [layers, prefersReducedMotion]);

  useEffect(() => {
    if (prefersReducedMotion || !layers.some((layer) => layer.phase === 'exiting')) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setLayers((current) => current.filter((layer) => layer.phase !== 'exiting'));
    }, MASCOT_EXIT_FALLBACK_MS);

    return () => window.clearTimeout(timeout);
  }, [layers, prefersReducedMotion]);

  useEffect(() => {
    for (const video of videoRefs.current.values()) {
      video.playbackRate = MASCOT_PLAYBACK_RATE;
      if (prefersReducedMotion) {
        video.pause();
        if (video.currentTime > 0.05) {
          video.currentTime = 0;
        }
      } else {
        void video.play().catch(() => undefined);
      }
    }
  }, [layers, prefersReducedMotion]);

  return (
    <div className="tm-detail__mascot" data-mascot-state={state} aria-hidden="true">
      {layers.map((layer) => (
        <video
          key={layer.id}
          ref={(video) => {
            if (video) {
              videoRefs.current.set(layer.id, video);
            } else {
              videoRefs.current.delete(layer.id);
            }
          }}
          className={`tm-detail__mascot-video tm-detail__mascot-video--${layer.phase}`}
          src={layer.source}
          data-mascot-state={layer.state}
          autoPlay={!prefersReducedMotion}
          loop={!prefersReducedMotion}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          onTransitionEnd={(event) => {
            if (layer.phase !== 'exiting' || event.propertyName !== 'opacity') {
              return;
            }
            setLayers((current) =>
              current.filter((candidate) => candidate.id !== layer.id)
            );
          }}
        />
      ))}
    </div>
  );
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setPrefersReducedMotion(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return prefersReducedMotion;
}

function getPrimaryAction(input: {
  task: Task;
  onPrepareWorktree(taskId: string): Promise<void>;
  onStart(taskId: string): Promise<void>;
}): { label: string; disabled?: boolean; onClick(): void } | undefined {
  if (['IN_REVIEW', 'DONE', 'CANCELED', 'ARCHIVED'].includes(input.task.workflowPhase)) {
    return undefined;
  }

  if (canPrepareWorktree(input.task)) {
    return {
      label: 'Prepare worktree',
      onClick: () => void input.onPrepareWorktree(input.task.id)
    };
  }

  if (canStartRun(input.task)) {
    return {
      label: 'Start implementation',
      onClick: () => void input.onStart(input.task.id)
    };
  }

  return undefined;
}
