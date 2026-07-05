import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
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
  AgentProviderState,
  AgentServerInstance,
  CodexReviewFinding,
  CodexReviewGateStatus,
  InteractionRequestRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  RunRecord,
  Task,
  WorkflowPhase,
  WorktreeRecord
} from '../../shared/contracts';
import {
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
import { Chip, dotStyle } from './MainColumn';
import {
  canRequestCodexReviewChanges,
  codexReviewGate,
  describeTaskHeaderState,
  finishRequirementsForTask,
  finishActionsForTask,
  getFinishEvidenceState,
  markDoneModalCopy,
  type FinishEvidenceState,
  type FinishPanelAction,
  type FinishRequirement,
  type Tone
} from './taskView';
import { humanizeEnum } from './display';
import {
  buildFailingChecksInvestigationPrompt,
  buildPrStatusActionState,
  buildPrStatusCreateOrPushTitle,
  buildPrStatusViewModel,
  type PrCheckGroup,
  type PrStatusViewModel
} from '../model/prStatus';
import {
  buildTaskActivityLedger,
  projectDebugTaskActivity,
  projectOverviewTaskActivity
} from '../model/taskActivity';
import { TaskActivityPanel } from './TaskActivityPanel';

interface TaskDetailProps {
  error?: string;
  task?: Task;
  run?: RunRecord;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
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
  providerState?: AgentProviderState;
  server?: AgentServerInstance;
  artifacts: ArtifactRecord[];
  interactions: InteractionRequestRecord[];
  onPrepareWorktree(taskId: string): Promise<void>;
  onStart(taskId: string): Promise<void>;
  onCancel(runId: string): Promise<void>;
  onSteer(runId: string, instruction: string): Promise<void>;
  onContinue(runId: string, instruction?: string): Promise<void>;
  onRetry(runId: string, strategy: AgentRetryStrategy, instruction?: string): Promise<void>;
  onReview(runId: string): Promise<void>;
  onSyncAgentGoal(taskId: string, sessionId: string): Promise<void>;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
  onCreateDeliveryCommit(taskId: string): Promise<void>;
  onCreatePullRequest(taskId: string, title?: string): Promise<void>;
  onRefreshGitHub(taskId: string): Promise<void>;
  onTransition(taskId: string, toPhase: WorkflowPhase): Promise<void>;
  onArchive(taskId: string): void;
  onRequestDelete(taskId: string): void;
}

interface HeadAction {
  label: string;
  kind: 'primary' | 'soft';
  disabled?: boolean;
  onClick(): void;
}

type DetailTab = 'overview' | 'evidence' | 'debug';
type ReviewActionPauseReason =
  | 'review-starting'
  | 'review-running'
  | 'implementation-running'
  | 'delivery-running';

export function TaskDetail(props: TaskDetailProps) {
  const { task, error } = props;
  const [tab, setTab] = useState<DetailTab>('overview');
  const [requestDrawerOpen, setRequestDrawerOpen] = useState(false);
  const [selectedReviewFindingIds, setSelectedReviewFindingIds] = useState<string[]>([]);
  const [markDoneModal, setMarkDoneModal] = useState<'clean' | 'issues'>();
  const [draftPrModalOpen, setDraftPrModalOpen] = useState(false);
  const [draftPrTitle, setDraftPrTitle] = useState('');
  const [requestInstruction, setRequestInstruction] = useState('');
  const [reviewActionBusy, setReviewActionBusy] = useState(false);
  const [deliveryActionBusy, setDeliveryActionBusy] = useState(false);
  const [reviewStartPending, setReviewStartPending] = useState(false);
  const reviewActionInFlightRef = useRef(false);
  const deliveryActionInFlightRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setReviewStartPending(false);
    setRequestDrawerOpen(false);
    setSelectedReviewFindingIds([]);
    setDraftPrModalOpen(false);
    setDraftPrTitle(task ? normalizePullRequestTitle(undefined, task.title) : '');
  }, [task?.id, task?.title]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [tab, task?.id]);

  if (!task) {
    return (
      <main className="tm-detail">
        <div className="tm-detail__body">
          <div className="tm-grid__empty">Select a task to inspect isolated evidence.</div>
        </div>
      </main>
    );
  }

  const {
    run,
    worktree,
    gitSnapshot,
    pullRequest,
    interactions,
    sessions,
    planRevisions
  } = props;

  const headerState = describeTaskHeaderState(task);
  const session = sessions.find((candidate) => candidate.id === run?.sessionId);
  const promptLineCount = task.prompt.split(/\r?\n/).length;
  const reviewGate = codexReviewGate(task);
  const reviewFindings = reviewGate.result?.findings ?? [];
  const reviewRun =
    props.runs.find((candidate) => candidate.id === reviewGate.runId) ??
    props.runs.find(
      (candidate) =>
        candidate.mode === 'REVIEW' && candidate.iterationId === task.currentIterationId
    );
  const reviewSourceRun =
    (reviewGate.sourceRunId
      ? props.runs.find((candidate) => candidate.id === reviewGate.sourceRunId)
      : undefined) ??
    (reviewRun?.continuedFromRunId
      ? props.runs.find((candidate) => candidate.id === reviewRun.continuedFromRunId)
      : undefined) ??
    props.runs.find(
      (candidate) =>
        candidate.mode !== 'REVIEW' &&
        candidate.iterationId === task.currentIterationId &&
        ['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
          candidate.status
        )
    );
  const reviewIsRunning = reviewGate.status === 'RUNNING';
  const reviewPending = reviewStartPending && !reviewIsRunning;
  const reviewPhaseVisible = isReviewPhase(task.workflowPhase) || reviewRun?.mode === 'REVIEW';
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
  const canStartCodexReview =
    Boolean(reviewSourceRun) && !reviewActionsPaused && reviewPhaseVisible;
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
  const prStatus = buildPrStatusViewModel({
    task,
    gitSnapshot,
    branchPublication: props.branchPublication,
    pullRequest,
    ciRollup: props.ciRollup,
    reviewRollup: props.reviewRollup,
    mergeSnapshot: props.mergeSnapshot
  });
  const prActionState = buildPrStatusActionState({
    view: prStatus,
    deliveryBusy: deliveryActionBusy,
    pauseReason: reviewPauseReason,
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

  const runCodexReview = async (sourceRunId: string) => {
    if (reviewActionInFlightRef.current) {
      return;
    }
    setReviewStartPending(true);
    await runReviewAction(async () => {
      try {
        await props.onReview(sourceRunId);
      } catch {
        setReviewStartPending(false);
      } finally {
        setReviewStartPending(false);
      }
    });
  };

  const openRequestChanges = (findingIds?: string[]) => {
    const hasReviewOutput = Boolean(reviewGate.result) || Boolean(reviewRun?.finalMessage?.trim());
    if (
      !reviewSourceRun ||
      reviewActionsPaused ||
      !canRequestCodexReviewChanges(reviewGate, reviewGate.status, hasReviewOutput)
    ) {
      return;
    }
    const selectedIds = findingIds?.length
      ? findingIds
      : defaultSelectedFindingIds(reviewFindings);
    setSelectedReviewFindingIds(selectedIds);
    setRequestInstruction(
      defaultReviewFollowUpInstruction(task, reviewGate, reviewRun, selectedIds)
    );
    setRequestDrawerOpen(true);
  };

  const submitRequestChanges = async () => {
    if (!reviewSourceRun || !requestInstruction.trim() || reviewActionsPaused) {
      return;
    }
    await runReviewAction(async () => {
      try {
        await props.onContinue(reviewSourceRun.id, requestInstruction.trim());
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
    setRequestInstruction(defaultReviewFollowUpInstruction(task, reviewGate, reviewRun, next));
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

  const primaryAction = getPrimaryAction({
    task,
    onPrepareWorktree: props.onPrepareWorktree,
    onStart: props.onStart
  });

  const headActions: HeadAction[] = [];
  if (
    task.projection.agentRun === 'COMPLETED' &&
    !['REVIEW', 'IN_REVIEW', 'DONE', 'CANCELED', 'ARCHIVED'].includes(task.workflowPhase)
  ) {
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
      disabled: primaryAction.disabled || reviewActionsPaused,
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
  const isFailed = ['FAILED', 'LOST', 'RECOVERY_REQUIRED'].includes(task.projection.agentRun);

  return (
    <main className="tm-detail">
      <div className="tm-detail__head">
        <div className="tm-detail__row">
          <div className="tm-detail__heading">
            <div className="tm-detail__ids">
              <span className="tm-detail__num">#{formatShortId(task.id)}</span>
              <Chip tone={headerState.tone} label={headerState.label} />
            </div>
            <div className="tm-detail__titlerow">
              <h1 className="tm-detail__title">{task.title}</h1>
              <TaskActionsMenu
                taskId={task.id}
                title={task.title}
                archived={task.workflowPhase === 'ARCHIVED'}
                onArchive={props.onArchive}
                onRequestDelete={props.onRequestDelete}
                className="tm-detail__taskmenu"
              />
            </div>
            {worktree?.branchName ? (
              <div className="tm-detail__meta">{worktree.branchName}</div>
            ) : null}
          </div>
          <div className="tm-detail__actions">
            {headActions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={`tm-headbtn ${action.kind === 'primary' ? 'tm-headbtn--primary' : ''}`}
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
        <div className="tm-tabs">
          <TabButton label="Overview" active={tab === 'overview'} onClick={() => setTab('overview')} />
          <TabButton label="Evidence" active={tab === 'evidence'} onClick={() => setTab('evidence')} />
          <TabButton
            label="Debug"
            active={tab === 'debug'}
            onClick={() => setTab('debug')}
            badge={props.runs.length ? String(props.runs.length) : undefined}
          />
        </div>
      </div>

      <div className="tm-detail__body" ref={bodyRef}>
        {error ? <div className="tm-error">{error}</div> : null}

        {tab === 'overview' ? (
          <div className="tm-overview">
            <div className="tm-overview__col">
              {reviewPhaseVisible ? (
                <CodexReviewPanel
                  reviewGate={reviewGate}
                  reviewRun={reviewRun}
                  sourceRun={reviewSourceRun}
                  gitSnapshot={gitSnapshot}
                  actionBusy={reviewActionBusy}
                  reviewPending={reviewPending}
                  canStartReview={canStartCodexReview}
                  actionsPaused={reviewActionsPaused}
                  actionsPausedReason={reviewActionsPausedReason}
                  onRunReview={(sourceRunId) => void runCodexReview(sourceRunId)}
                  onStopReview={(reviewRunId) => void stopReview(reviewRunId)}
                  onOpenRequestChanges={openRequestChanges}
                />
              ) : null}

              <InteractionPanel
                interactions={interactions}
                sessions={sessions}
                onRespond={props.onRespondToInteraction}
              />

              {isFailed ? (
                <div className="tm-failure">
                  <div className="tm-failure__head">
                    <span className="tm-failure__dot" />
                    <span className="tm-failure__eyebrow">
                      {humanizeEnum(task.projection.agentRun)}
                    </span>
                  </div>
                  <h3 className="tm-panel__title" style={{ margin: '0 0 7px' }}>
                    Task Monki cannot prove the final provider state
                  </h3>
                  <p className="tm-panel__lead" style={{ margin: 0 }}>
                    {task.projection.summary}
                  </p>
                </div>
              ) : null}

              {planRevisions.length > 0 ? (
                <PlanCard planRevisions={planRevisions} />
              ) : null}

              <div className="tm-panel">
                <h3 className="tm-panel__title">Request</h3>
                <details className="tm-raw">
                  <summary>Prompt · {promptLineCount} lines</summary>
                  <pre>{task.prompt}</pre>
                </details>
                <div className="tm-config" style={{ marginTop: 14 }}>
                  <ConfigRow k="Model / effort" v={`${model} / ${effort}`} />
                  <ConfigRow
                    k="Approval"
                    v={
                      run?.requestedSettings.approvalPolicy ??
                      task.agentSettings.approvalPolicy ??
                      'on-request'
                    }
                  />
                  <ConfigRow k="Branch" v={worktree?.branchName ?? 'Not created'} />
                </div>
              </div>

              <AgentControlPanel
                run={run}
                interactions={interactions}
                onSteer={props.onSteer}
                onInterrupt={props.onCancel}
                onContinue={props.onContinue}
                onRetry={props.onRetry}
              />
            </div>

            <div className="tm-overview__col">
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

              <TaskActivityPanel view={overviewActivity} variant="overview" />

              {reviewPhaseVisible ? (
                <FinishPanel
                  task={task}
                  reviewStatus={reviewPending ? 'RUNNING' : reviewGate.status}
                  finishEvidence={finishEvidence}
                  requirements={finishRequirements}
                  actionBusy={reviewActionBusy}
                  actionsPaused={reviewActionsPaused}
                  actionsPausedReason={reviewActionsPausedReason}
                  onOpenMarkDone={(withIssues) =>
                    setMarkDoneModal(withIssues ? 'issues' : 'clean')
                  }
                  onCreateDeliveryCommit={() =>
                    void runDeliveryAction(async () => {
                      await props.onCreateDeliveryCommit(task.id);
                    })
                  }
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {tab === 'evidence' ? (
          <div className="tm-evtab">
            <EvidencePanel
              run={run}
              worktree={worktree}
              gitSnapshot={gitSnapshot}
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
            <TaskActivityPanel view={debugActivity} variant="debug" rawEvents={props.events} />
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
              events={props.events}
            />
            <ProviderOverviewPanel
              task={task}
              run={run}
              session={session}
              goalSnapshots={props.goalSnapshots}
              usageSnapshots={props.usageSnapshots}
              settingsObservations={props.settingsObservations}
              providerState={props.providerState}
              server={props.server}
              onSyncGoal={props.onSyncAgentGoal}
            />
            <InteractionAuditPanel interactions={interactions} sessions={sessions} />
          </div>
        ) : null}
      </div>

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
        />
      ) : null}

      {requestDrawerOpen ? (
        <ReviewRequestDrawer
          task={task}
          findings={reviewFindings}
          selectedFindingIds={selectedReviewFindingIds}
          instruction={requestInstruction}
          busy={reviewActionBusy}
          onToggleFinding={toggleSelectedReviewFinding}
          onInstructionChange={setRequestInstruction}
          onCancel={() => setRequestDrawerOpen(false)}
          onSubmit={() => void submitRequestChanges()}
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
  onSubmit
}: {
  title: string;
  worktree?: WorktreeRecord;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onTitleChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
}) {
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const confirmDisabled = busy || disabled || !cleanTitle;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmDisabled) {
      onSubmit();
    }
  };

  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="draft-pr-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <form className="tm-modal__panel tm-draftpr-modal" onSubmit={submit}>
        <h3 id="draft-pr-title">Create draft PR</h3>
        <p>Review the title before Task Monki opens the draft pull request.</p>

        <label className="field tm-draftpr-modal__field">
          <span className="field__label">PR title</span>
          <input
            type="text"
            value={title}
            maxLength={PULL_REQUEST_TITLE_MAX_LENGTH}
            autoFocus
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

function ConfigRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="tm-config__row">
      <span className="tm-config__k">{k}</span>
      <span className="tm-config__v">{v}</span>
    </div>
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
            <details
              key={finding.id}
              className={`tm-finding tm-finding--${tone}`}
              open={index === 0}
            >
              <summary>
                <span className="tm-finding__severity">
                  <span className="tm-finding__severity-dot" />
                  <span>{humanizeEnum(finding.severity).toUpperCase()}</span>
                </span>
                <span className="tm-finding__main">
                  <span className="tm-finding__title">{view.title}</span>
                  <span className="tm-finding__ref">{view.meta}</span>
                </span>
                <span className="tm-finding__chevron" aria-hidden="true">
                  ›
                </span>
              </summary>
              <div className="tm-finding__detail">
                <p>{view.detail}</p>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function PlanCard({ planRevisions }: { planRevisions: AgentPlanRevisionRecord[] }) {
  const latest = [...planRevisions].sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  const steps = latest?.steps ?? [];
  if (steps.length === 0) {
    return null;
  }
  return (
    <div className="tm-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
        <h3 className="tm-panel__title" style={{ margin: 0 }}>
          Plan
        </h3>
        {latest?.explanation ? (
          <span className="tm-plan__status">{truncateMiddle(latest.explanation, 48)}</span>
        ) : null}
      </div>
      <div className="tm-plan__steps">
        {steps.map((step, index) => {
          const tone = planStepTone(step.status);
          const active = step.status === 'IN_PROGRESS';
          return (
            <div className="tm-plan__step" key={index}>
              <span className="tm-plan__dot" style={dotStyle(tone)} />
              <span className={`tm-plan__label ${active ? 'tm-plan__label--active' : ''}`}>
                {step.step}
              </span>
              <span className="tm-plan__status">{humanizeEnum(step.status)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CodexReviewPanel({
  reviewGate,
  reviewRun,
  sourceRun,
  gitSnapshot,
  actionBusy,
  reviewPending,
  canStartReview,
  actionsPaused,
  actionsPausedReason,
  onRunReview,
  onStopReview,
  onOpenRequestChanges
}: {
  reviewGate: NonNullable<Task['projection']['codexReview']>;
  reviewRun?: RunRecord;
  sourceRun?: RunRecord;
  gitSnapshot?: GitSnapshotRecord;
  actionBusy: boolean;
  reviewPending: boolean;
  canStartReview: boolean;
  actionsPaused: boolean;
  actionsPausedReason?: ReviewActionPauseReason;
  onRunReview(sourceRunId: string): void;
  onStopReview(reviewRunId: string): void;
  onOpenRequestChanges(findingIds?: string[]): void;
}) {
  const effectiveStatus = reviewPending ? 'RUNNING' : reviewGate.status;
  const ui = reviewGateUi(effectiveStatus);
  const canStopReview = Boolean(reviewRun && effectiveStatus === 'RUNNING' && !reviewPending);
  const hasReviewOutput = Boolean(reviewGate.result) || Boolean(reviewRun?.finalMessage?.trim());
  const canRequestChanges =
    Boolean(sourceRun) &&
    !actionsPaused &&
    canRequestCodexReviewChanges(reviewGate, effectiveStatus, hasReviewOutput);
  const canRunAgain = Boolean(sourceRun) && !actionsPaused;
  const sourceRunId = sourceRun?.id;
  const currentDiff = describeGitSnapshot(gitSnapshot);
  const reviewedDiff = reviewPending ? currentDiff : describeReviewedDiff(reviewGate, gitSnapshot);
  const reviewIsRunning = effectiveStatus === 'RUNNING';
  const reviewActionsBlockedByImplementation = actionsPausedReason === 'implementation-running';
  const reviewActionsBlockedByDelivery = actionsPausedReason === 'delivery-running';
  const suggestedReviewAction = reviewActionsBlockedByImplementation
    ? 'Follow-up work is running. Review actions are paused until the agent finishes, then this task returns for re-review.'
    : reviewActionsBlockedByDelivery
      ? 'GitHub action is in progress. Review actions resume when it finishes.'
      : undefined;
  const staleContextNote =
    effectiveStatus === 'STALE' && hasReviewOutput
      ? 'Previous review output is shown for context only. Re-run the review before acting on the current diff.'
      : undefined;
  const reviewActionPauseTitle = (): string | undefined => {
    switch (actionsPausedReason) {
      case 'delivery-running':
        return 'Review actions pause during GitHub actions.';
      case 'implementation-running':
        return 'Review actions pause while the agent is running.';
      case 'review-starting':
        return 'Review is starting.';
      case 'review-running':
        return 'Review is already running.';
      default:
        return undefined;
    }
  };
  const runReviewDisabledTitle = (canRun: boolean): string | undefined => {
    if (actionsPaused) {
      return reviewActionPauseTitle();
    }
    if (actionBusy) {
      return 'Review action is in progress.';
    }
    if (!sourceRunId) {
      return 'No completed implementation run is available to review.';
    }
    if (!canRun) {
      return 'Review cannot start from the current task state.';
    }
    return undefined;
  };
  const stopReviewDisabledTitle = (): string | undefined => {
    if (actionBusy) {
      return 'Review action is in progress.';
    }
    if (reviewPending) {
      return 'Review is starting.';
    }
    if (!reviewRun) {
      return 'No running review is available.';
    }
    if (!canStopReview) {
      return 'The current review cannot be stopped.';
    }
    return undefined;
  };
  const requestChangesDisabledTitle = (): string | undefined =>
    actionBusy ? 'Review action is in progress.' : undefined;

  return (
    <>
      <section className={`tm-reviewcard tm-reviewcard--${ui.tone}`}>
        <div className="tm-reviewcard__head">
          <span className="tm-reviewcard__dot" style={dotStyle(ui.tone)} />
          <div>
            <h3 className="tm-panel__title" style={{ margin: 0 }}>
              Codex review
            </h3>
          </div>
          <span className="tm-reviewcard__spacer" />
          <Chip tone={ui.tone} label={ui.label} />
        </div>

        <div className="tm-reviewcard__body">
          {reviewIsRunning ? (
            <div className="tm-reviewcard__runningstate">
              <div className="tm-reviewcard__running">
                <span className="tm-reviewcard__spinner" />
                <div>
                  <h4>Reviewing the current diff</h4>
                  <p>{reviewedDiff}</p>
                </div>
              </div>
              <div className="tm-reviewcard__progress" aria-hidden="true">
                <span />
              </div>
              <p>Actions resume when the review finishes.</p>
            </div>
          ) : (
            <div className="tm-reviewcard__summary">
              <p>{reviewBody(reviewGate, reviewRun)}</p>
              {effectiveStatus === 'NOT_RUN' ? (
                <div className="tm-reviewcard__meta tm-reviewcard__meta--box">
                  <span>Will review</span>
                  <strong>{currentDiff}</strong>
                  <span>Last result</span>
                  <strong>none</strong>
                </div>
              ) : (
                <div className="tm-reviewcard__meta">
                  <span>Last reviewed</span>
                  <strong>{formatReviewTime(reviewGate.updatedAt)}</strong>
                  <span>Reviewed diff</span>
                  <strong>{reviewedDiff}</strong>
                </div>
              )}
              {staleContextNote ? (
                <p className="tm-reviewcard__contextnote">{staleContextNote}</p>
              ) : null}
              <ReviewFindingsList findings={reviewGate.result?.findings ?? []} />
              {reviewRun?.finalMessage ? (
                <details className="tm-raw tm-reviewcard__raw">
                  <summary>Raw review output</summary>
                  <pre>{reviewRun.finalMessage}</pre>
                </details>
              ) : null}
            </div>
          )}

        </div>

        <div className="tm-reviewcard__actions">
          {suggestedReviewAction ? (
            <div>
              <span className="tm-reviewcard__eyebrow">Suggested next action</span>
              <p>{suggestedReviewAction}</p>
            </div>
          ) : null}
          <div className="tm-reviewcard__buttons">
            {effectiveStatus === 'NOT_RUN' ? (
              <>
                <ActionButtonTitle
                  disabled={!canStartReview || actionBusy || !sourceRunId || actionsPaused}
                  title={runReviewDisabledTitle(canStartReview)}
                >
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!canStartReview || actionBusy || !sourceRunId || actionsPaused}
                    onClick={() => sourceRunId && onRunReview(sourceRunId)}
                  >
                    Run Codex review
                  </button>
                </ActionButtonTitle>
              </>
            ) : null}

            {reviewIsRunning ? (
              <>
                <ActionButtonTitle
                  disabled={!canStopReview || actionBusy || !reviewRun}
                  title={stopReviewDisabledTitle()}
                >
                  <button
                    type="button"
                    className="outline-button"
                    disabled={!canStopReview || actionBusy || !reviewRun}
                    onClick={() => reviewRun && onStopReview(reviewRun.id)}
                  >
                    Stop review
                  </button>
                </ActionButtonTitle>
              </>
            ) : null}

            {!actionsPaused && effectiveStatus === 'PASSED' ? (
              <>
                <ActionButtonTitle
                  disabled={!canRunAgain || actionBusy || !sourceRunId}
                  title={runReviewDisabledTitle(canRunAgain)}
                >
                  <button
                    type="button"
                    className="outline-button"
                    disabled={!canRunAgain || actionBusy || !sourceRunId}
                    onClick={() => sourceRunId && onRunReview(sourceRunId)}
                  >
                    Run review again
                  </button>
                </ActionButtonTitle>
              </>
            ) : null}

            {!actionsPaused && ['NEEDS_CHANGES', 'INCONCLUSIVE'].includes(effectiveStatus) ? (
              <>
                {canRequestChanges ? (
                  <ActionButtonTitle
                    disabled={actionBusy}
                    title={requestChangesDisabledTitle()}
                  >
                    <button
                      type="button"
                      className="primary-button"
                      disabled={actionBusy}
                      onClick={() => onOpenRequestChanges()}
                    >
                      Request changes
                    </button>
                  </ActionButtonTitle>
                ) : null}
                <ActionButtonTitle
                  disabled={!canRunAgain || actionBusy || !sourceRunId}
                  title={runReviewDisabledTitle(canRunAgain)}
                >
                  <button
                    type="button"
                    className="outline-button"
                    disabled={!canRunAgain || actionBusy || !sourceRunId}
                    onClick={() => sourceRunId && onRunReview(sourceRunId)}
                  >
                    Run review again
                  </button>
                </ActionButtonTitle>
              </>
            ) : null}

            {!actionsPaused && ['FAILED', 'CANCELED', 'STALE'].includes(effectiveStatus) ? (
              <>
                <ActionButtonTitle
                  disabled={!canRunAgain || actionBusy || !sourceRunId}
                  title={runReviewDisabledTitle(canRunAgain)}
                >
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!canRunAgain || actionBusy || !sourceRunId}
                    onClick={() => sourceRunId && onRunReview(sourceRunId)}
                  >
                    Run review again
                  </button>
                </ActionButtonTitle>
                {canRequestChanges ? (
                  <ActionButtonTitle
                    disabled={actionBusy}
                    title={requestChangesDisabledTitle()}
                  >
                    <button
                      type="button"
                      className="outline-button"
                      disabled={actionBusy}
                      onClick={() => onOpenRequestChanges()}
                    >
                      Request changes
                    </button>
                  </ActionButtonTitle>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </section>
    </>
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
              <button
                type="button"
                className="primary-button"
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
                className="primary-button"
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

function ActionButtonTitle({
  title,
  disabled,
  children
}: {
  title?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`tm-actiontitle${disabled ? ' tm-actiontitle--disabled' : ''}`}
      title={title}
    >
      {children}
    </span>
  );
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

function FinishPanel({
  task,
  reviewStatus,
  finishEvidence,
  requirements,
  actionBusy,
  actionsPaused,
  actionsPausedReason,
  onOpenMarkDone,
  onCreateDeliveryCommit
}: {
  task: Task;
  reviewStatus: CodexReviewGateStatus;
  finishEvidence: FinishEvidenceState;
  requirements: FinishRequirement[];
  actionBusy: boolean;
  actionsPaused: boolean;
  actionsPausedReason?: ReviewActionPauseReason;
  onOpenMarkDone(withIssues: boolean): void;
  onCreateDeliveryCommit(): void;
}) {
  if (task.workflowPhase === 'DONE') {
    return null;
  }

  const actions = finishActionsForTask({
    task,
    reviewStatus,
    finishEvidence,
    actionBusy,
    actionsPaused
  });
  const pausedText =
    actionsPausedReason === 'implementation-running'
      ? 'Finish actions pause while the agent is running.'
      : actionsPausedReason === 'delivery-running'
        ? 'Finish actions pause during GitHub actions.'
      : 'Finish actions pause while review runs.';
  const disabledTitle = (action: FinishPanelAction): string | undefined => {
    if (!action.disabled) {
      return undefined;
    }
    if (actionsPaused) {
      return pausedText;
    }
    if (actionBusy || reviewStatus === 'RUNNING') {
      return 'Finish action is in progress.';
    }
    if (action.id === 'commit') {
      return 'No uncommitted task changes are available to commit.';
    }
    if (finishEvidence.mode === 'blocked') {
      return finishEvidence.warnings.map((warning) => warning.detail).join(' ');
    }
    return undefined;
  };

  return (
    <section className="tm-panel tm-finishpanel" aria-label="Finish task">
      <div className="tm-finishpanel__head">
        <h3 className="tm-panel__title">Finish</h3>
        <div className="tm-finishpanel__actions">
          {actions.map((action) => (
            <ActionButtonTitle
              key={action.id}
              disabled={action.disabled}
              title={disabledTitle(action)}
            >
              <button
                type="button"
                className={`${action.kind === 'primary' ? 'primary-button' : 'outline-button'} ${
                  action.id === 'mark-done' && action.withIssues
                    ? 'tm-finishpanel__mark-done-anyway'
                    : ''
                }`}
                disabled={action.disabled}
                onClick={
                  action.id === 'commit'
                      ? onCreateDeliveryCommit
                      : () => onOpenMarkDone(Boolean(action.withIssues))
                }
              >
                {action.label}
              </button>
            </ActionButtonTitle>
          ))}
        </div>
      </div>
      <div className="tm-finishpanel__requirements" aria-label="Finish requirements">
        {requirements.map((requirement) => (
          <span
            key={requirement.label}
            className={`tm-finishpanel__requirement tm-finishpanel__requirement--${requirement.tone}`}
          >
            <span className="tm-finishpanel__requirement-dot" aria-hidden="true" />
            {requirement.label} {requirement.detail}
          </span>
        ))}
      </div>
    </section>
  );
}

const FINDING_LEVELS: Array<{
  severity: CodexReviewFinding['severity'];
  label: string;
  tone: Tone;
  rank: number;
}> = [
  { severity: 'BLOCKER', label: 'Blocker', tone: 'error', rank: 0 },
  { severity: 'MAJOR', label: 'Major', tone: 'action', rank: 1 },
  { severity: 'MINOR', label: 'Minor', tone: 'info', rank: 2 },
  { severity: 'NIT', label: 'Nit', tone: 'neutral', rank: 3 }
];

function ReviewFindingsList({ findings }: { findings: CodexReviewFinding[] }) {
  if (findings.length === 0) {
    return null;
  }
  const sortedFindings = [...findings].sort(
    (a, b) => findingLevel(a.severity).rank - findingLevel(b.severity).rank
  );
  return (
    <div className="tm-reviewfindings">
      <SeverityDistribution findings={findings} />
      <div className="tm-reviewfindings__list">
        {sortedFindings.map((finding, index) => {
          const level = findingLevel(finding.severity);
          return (
            <details
              className={`tm-finding tm-finding--${level.tone}`}
              key={finding.id}
              open={index === 0}
            >
              <summary>
                <span className="tm-finding__severity">
                  <span className="tm-finding__severity-dot" />
                  <span>{level.label.toUpperCase()}</span>
                </span>
                <span className="tm-finding__main">
                  <span className="tm-finding__title">{finding.title}</span>
                  <span className="tm-finding__ref">{shortFindingRef(finding)}</span>
                </span>
                <span className="tm-finding__chevron" aria-hidden="true">
                  ›
                </span>
              </summary>
              <div className="tm-finding__detail">
                <p>{finding.explanation}</p>
                {finding.recommendation ? <p>{finding.recommendation}</p> : null}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function SeverityDistribution({ findings }: { findings: CodexReviewFinding[] }) {
  const counts = FINDING_LEVELS.map((level) => ({
    ...level,
    count: findings.filter((finding) => finding.severity === level.severity).length
  }));
  return (
    <div className="tm-reviewfindings__distribution">
      <div className="tm-reviewfindings__counts" aria-label="Review finding severity counts">
        {counts.map((level) => (
          <span
            key={level.severity}
            className={`tm-reviewfindings__count tm-reviewfindings__count--${level.tone}${
              level.count > 0 ? '' : ' tm-reviewfindings__count--empty'
            }`}
          >
            <span className="tm-reviewfindings__count-dot" />
            <strong>{level.count}</strong>
            {level.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ReviewRequestDrawer({
  task,
  findings,
  selectedFindingIds,
  instruction,
  busy,
  onToggleFinding,
  onInstructionChange,
  onCancel,
  onSubmit
}: {
  task: Task;
  findings: CodexReviewFinding[];
  selectedFindingIds: string[];
  instruction: string;
  busy: boolean;
  onToggleFinding(findingId: string): void;
  onInstructionChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
}) {
  const selectedCount = selectedFindingIds.length;
  return (
    <div className="tm-reviewdrawer" role="dialog" aria-modal="true" aria-label="Request changes">
      <div className="tm-reviewdrawer__scrim" onClick={onCancel} />
      <aside className="tm-reviewdrawer__panel">
        <header className="tm-reviewdrawer__header">
          <div>
            <h3>Request changes</h3>
            <p>Start a follow-up run with the selected findings for #{formatShortId(task.id)}.</p>
          </div>
          <button type="button" className="tm-reviewdrawer__close" onClick={onCancel}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="tm-reviewdrawer__body">
          <section className="tm-reviewdrawer__section">
            <h4>Findings to attach · {selectedCount} selected</h4>
            {findings.length > 0 ? (
              <div className="tm-reviewdrawer__findings">
                {findings.map((finding) => (
                  <label className="tm-reviewdrawer__finding" key={finding.id}>
                    <input
                      type="checkbox"
                      checked={selectedFindingIds.includes(finding.id)}
                      onChange={() => onToggleFinding(finding.id)}
                    />
                    <span>
                      <span>
                        <SeverityPill severity={finding.severity} />
                        <strong>{finding.title}</strong>
                      </span>
                      <code>{formatFindingLocation(finding)}</code>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="tm-reviewdrawer__empty">
                No structured findings were returned. The instruction includes the review summary.
              </p>
            )}
          </section>

          <label className="tm-reviewdrawer__section">
            <h4>Instruction to agent</h4>
            <textarea
              value={instruction}
              onChange={(event) => onInstructionChange(event.target.value)}
              rows={11}
            />
            <small>Editable before sending.</small>
          </label>
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

function SeverityPill({ severity }: { severity: CodexReviewFinding['severity'] }) {
  const level = findingLevel(severity);
  return (
    <span className={`tm-severity tm-severity--${level.tone}`}>
      {level.label}
    </span>
  );
}

function findingLevel(severity: CodexReviewFinding['severity']) {
  return (
    FINDING_LEVELS.find((candidate) => candidate.severity === severity) ??
    FINDING_LEVELS[FINDING_LEVELS.length - 1]
  );
}

function shortFindingRef(finding: CodexReviewFinding): string {
  if (!finding.path) {
    return formatFindingLocation(finding);
  }
  const filename = finding.path.split('/').filter(Boolean).at(-1) ?? finding.path;
  return finding.line ? `${filename}:${finding.line}` : filename;
}

function formatReviewTime(value: string | undefined): string {
  if (!value) {
    return 'unknown';
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return 'unknown';
  }
  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs >= 0 && elapsedMs < 60_000) {
    return 'just now';
  }
  if (elapsedMs >= 0 && elapsedMs < 60 * 60_000) {
    const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
    return `${minutes}m ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function isReviewPhase(phase: WorkflowPhase): boolean {
  return phase === 'REVIEW' || phase === 'IN_REVIEW';
}

function isActiveNonReviewRun(run: RunRecord): boolean {
  return (
    run.mode !== 'REVIEW' &&
    ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(
      run.status
    )
  );
}

function MarkDoneModal({
  withIssues,
  warnings,
  hasPullRequest,
  requirements,
  busy,
  onCancel,
  onConfirm
}: {
  withIssues: boolean;
  warnings: FinishEvidenceState['warnings'];
  hasPullRequest: boolean;
  requirements: FinishRequirement[];
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const copy = markDoneModalCopy(withIssues, busy, { hasPullRequest });
  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="mark-done-title">
      <div className="tm-modal__scrim" onClick={onCancel} />
      <div className="tm-modal__panel">
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
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>
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

function planStepTone(status: string): Tone {
  if (status === 'COMPLETED') {
    return 'success';
  }
  if (status === 'IN_PROGRESS') {
    return 'info';
  }
  return 'neutral';
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

function reviewGateUi(status: NonNullable<Task['projection']['codexReview']>['status']): {
  label: string;
  tone: Tone;
} {
  switch (status) {
    case 'RUNNING':
      return { label: 'Reviewing...', tone: 'info' };
    case 'PASSED':
      return { label: 'Passed', tone: 'success' };
    case 'NEEDS_CHANGES':
      return { label: 'Needs changes', tone: 'error' };
    case 'INCONCLUSIVE':
      return { label: 'Inconclusive', tone: 'action' };
    case 'FAILED':
      return { label: 'Failed', tone: 'error' };
    case 'CANCELED':
      return { label: 'Stopped', tone: 'action' };
    case 'STALE':
      return { label: 'Stale', tone: 'action' };
    case 'NOT_RUN':
      return { label: 'Not run', tone: 'neutral' };
  }
}

function reviewBody(
  reviewGate: NonNullable<Task['projection']['codexReview']>,
  reviewRun?: RunRecord
): string {
  if (reviewRun?.terminalReason) {
    return reviewRun.terminalReason;
  }
  if (reviewGate.summary) {
    return reviewGate.summary;
  }
  switch (reviewGate.status) {
    case 'NOT_RUN':
      return 'Run a review before marking done or shipping this diff.';
    case 'PASSED':
      return 'No blocking issues were reported for the reviewed diff.';
    case 'NEEDS_CHANGES':
      return 'Send the findings back to the agent, then re-review.';
    case 'INCONCLUSIVE':
      return 'The review finished without a clear pass or fail verdict. Read the output, then request changes or mark done explicitly.';
    case 'FAILED':
      return 'The review did not complete. Re-run it or inspect Debug.';
    case 'CANCELED':
      return 'The partial review result was discarded.';
    case 'STALE':
      return 'The diff changed after the last review.';
    case 'RUNNING':
      return 'Codex is reviewing the current diff.';
  }
}

function describeGitSnapshot(snapshot?: GitSnapshotRecord): string {
  if (!snapshot) {
    return 'not captured';
  }
  const files =
    snapshot.workingDiffFileCount ||
    snapshot.committedDiffFileCount ||
    snapshot.stagedCount + snapshot.unstagedCount + snapshot.untrackedCount;
  const fileLabel = `${files} file${files === 1 ? '' : 's'}`;
  const head = snapshot.headSha?.slice(0, 8) ?? 'unknown';
  return `${head} · ${fileLabel} · ${snapshot.status.toLowerCase()}`;
}

function describeReviewedDiff(
  reviewGate: NonNullable<Task['projection']['codexReview']>,
  currentSnapshot?: GitSnapshotRecord
): string {
  const head = reviewGate.reviewedHeadSha ?? currentSnapshot?.headSha;
  const fingerprint = reviewGate.reviewedDirtyFingerprint;
  if (!head && !fingerprint) {
    return 'not captured';
  }
  return `${head?.slice(0, 8) ?? 'unknown'}${fingerprint ? ` · fp ${fingerprint.slice(0, 8)}` : ''}`;
}

function defaultReviewFollowUpInstruction(
  task: Task,
  reviewGate: NonNullable<Task['projection']['codexReview']>,
  reviewRun: RunRecord | undefined,
  selectedFindingIds: string[]
): string {
  const selectedFindings = (reviewGate.result?.findings ?? []).filter((finding) =>
    selectedFindingIds.includes(finding.id)
  );
  const lines = [
    `Address the Codex review result for "${task.title}".`,
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
  lines.push(
    '',
    'Make the necessary code changes, preserve the existing task intent, and stop when the follow-up is ready for review again.'
  );
  return lines.join('\n');
}

function defaultSelectedFindingIds(findings: CodexReviewFinding[]): string[] {
  const blocking = findings.filter(
    (finding) => finding.severity === 'BLOCKER' || finding.severity === 'MAJOR'
  );
  return (blocking.length > 0 ? blocking : findings).map((finding) => finding.id);
}

function formatFindingLocation(finding: CodexReviewFinding): string {
  if (!finding.path) {
    return 'location not specified';
  }
  if (!finding.line) {
    return finding.path;
  }
  return `${finding.path}:${finding.line}`;
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
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
