import { useEffect, useRef, useState } from 'react';
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
  TestRunRecord,
  WorkflowPhase,
  WorktreeRecord
} from '../../shared/contracts';
import {
  canPrepareWorktree,
  canRunTests,
  canStartRun,
  formatShortId
} from '../model/selectors';
import { describeHealthFinding } from '../model/debugDiagnostics';
import { ActivityTimeline } from './ActivityTimeline';
import { AgentControlPanel } from './AgentControlPanel';
import { EvidencePanel } from './EvidencePanel';
import { InteractionPanel } from './InteractionPanel';
import { InteractionAuditPanel } from './InteractionAuditPanel';
import { ProviderActivityPanel } from './ProviderActivityPanel';
import { ProviderOverviewPanel } from './ProviderOverviewPanel';
import { SubagentHierarchyPanel } from './SubagentHierarchyPanel';
import { TaskActionsMenu } from './TaskActionsMenu';
import { Chip, dotStyle } from './MainColumn';
import { StatusChip } from './StatusBadge';
import {
  canRequestCodexReviewChanges,
  codexReviewGate,
  describeTaskState,
  finishActionsForTask,
  getFinishEvidenceState,
  markDoneModalCopy,
  type FinishEvidenceState,
  type Tone
} from './taskView';
import { humanizeEnum } from './display';

interface TaskDetailProps {
  error?: string;
  task?: Task;
  run?: RunRecord;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  testRun?: TestRunRecord;
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
  onRefreshEvidence(taskId: string): Promise<void>;
  onRunTests(taskId: string): Promise<void>;
  onCreateDeliveryCommit(taskId: string): Promise<void>;
  onPreflightGitHub(taskId: string): Promise<void>;
  onCreatePullRequest(taskId: string): Promise<void>;
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

interface UtilAction {
  label: string;
  disabled?: boolean;
  onClick(): void;
}

type DetailTab = 'overview' | 'evidence' | 'debug';
type ReviewActionPauseReason = 'review-starting' | 'review-running' | 'implementation-running';

export function TaskDetail(props: TaskDetailProps) {
  const { task, error } = props;
  const [tab, setTab] = useState<DetailTab>('overview');
  const [requestDrawerOpen, setRequestDrawerOpen] = useState(false);
  const [selectedReviewFindingIds, setSelectedReviewFindingIds] = useState<string[]>([]);
  const [markDoneModal, setMarkDoneModal] = useState<'clean' | 'issues'>();
  const [requestInstruction, setRequestInstruction] = useState('');
  const [reviewActionBusy, setReviewActionBusy] = useState(false);
  const [reviewStartPending, setReviewStartPending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setReviewStartPending(false);
    setRequestDrawerOpen(false);
    setSelectedReviewFindingIds([]);
  }, [task?.id]);

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
    testRun,
    pullRequest,
    interactions,
    sessions,
    planRevisions
  } = props;

  const state = describeTaskState(task);
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
  const reviewActionsPaused = Boolean(reviewPauseReason);
  const canStartCodexReview =
    Boolean(reviewSourceRun) && !reviewActionsPaused && reviewPhaseVisible;

  const runCodexReview = async (sourceRunId: string) => {
    setReviewStartPending(true);
    setReviewActionBusy(true);
    try {
      await props.onReview(sourceRunId);
    } catch {
      setReviewStartPending(false);
    } finally {
      setReviewActionBusy(false);
      setReviewStartPending(false);
    }
  };

  const openRequestChanges = (findingIds?: string[]) => {
    if (!reviewSourceRun || reviewActionsPaused) {
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
    if (!reviewSourceRun || !requestInstruction.trim()) {
      return;
    }
    setReviewActionBusy(true);
    try {
      await props.onContinue(reviewSourceRun.id, requestInstruction.trim());
      setRequestDrawerOpen(false);
    } catch {
      // The app shell reports the error. Keep the drawer open so the user can retry.
    } finally {
      setReviewActionBusy(false);
    }
  };

  const toggleSelectedReviewFinding = (findingId: string) => {
    const next = selectedReviewFindingIds.includes(findingId)
      ? selectedReviewFindingIds.filter((id) => id !== findingId)
      : [...selectedReviewFindingIds, findingId];
    setSelectedReviewFindingIds(next);
    setRequestInstruction(defaultReviewFollowUpInstruction(task, reviewGate, reviewRun, next));
  };

  const markDone = async () => {
    setReviewActionBusy(true);
    try {
      await props.onTransition(task.id, 'DONE');
      setMarkDoneModal(undefined);
    } catch {
      // The app shell reports the error. Keep the modal open so the user can retry.
    } finally {
      setReviewActionBusy(false);
    }
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

  const utilityActions: UtilAction[] = [
    { label: 'Run tests', disabled: !canRunTests(task), onClick: () => void props.onRunTests(task.id) },
    {
      label: 'Refresh evidence',
      disabled: task.projection.worktree !== 'PRESENT',
      onClick: () => void props.onRefreshEvidence(task.id)
    },
    pullRequest
      ? { label: 'Refresh GitHub', onClick: () => void props.onRefreshGitHub(task.id) }
      : { label: 'Check GitHub', disabled: !worktree, onClick: () => void props.onPreflightGitHub(task.id) }
  ];

  const model =
    run?.observedSettings?.model ?? run?.requestedSettings.model ?? task.agentSettings.model ?? 'unknown';
  const effort =
    run?.observedSettings?.reasoningEffort ??
    run?.requestedSettings.reasoningEffort ??
    task.agentSettings.reasoningEffort ??
    'default';

  const evidenceChips = buildEvidenceChips(props);
  const dirtyFileCount =
    (gitSnapshot?.stagedCount ?? 0) +
    (gitSnapshot?.unstagedCount ?? 0) +
    (gitSnapshot?.untrackedCount ?? 0);
  const finishEvidence = getFinishEvidenceState(task, reviewGate.status, dirtyFileCount);
  const evidenceRows: Array<{ k: string; v: string }> = [
    { k: 'Head', v: gitSnapshot?.headSha?.slice(0, 12) ?? '—' },
    { k: 'Dirty fp', v: gitSnapshot?.dirtyFingerprint?.slice(0, 12) ?? '—' },
    { k: 'Worktree', v: worktree?.worktreePath ? truncateMiddle(worktree.worktreePath, 38) : 'Not created' }
  ];
  if (pullRequest?.url) {
    evidenceRows.push({ k: 'Pull request', v: pullRequest.url });
  }

  const isFailed = ['FAILED', 'LOST', 'RECOVERY_REQUIRED'].includes(task.projection.agentRun);

  return (
    <main className="tm-detail">
      <div className="tm-detail__head">
        <div className="tm-detail__row">
          <div className="tm-detail__heading">
            <div className="tm-detail__ids">
              <span className="tm-detail__num">#{formatShortId(task.id)}</span>
              <Chip tone={state.tone} label={state.label} />
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
                  actionsPausedReason={reviewPauseReason}
                  onRunReview={(sourceRunId) => void runCodexReview(sourceRunId)}
                  onStopReview={(reviewRunId) => void props.onCancel(reviewRunId)}
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
                  <ConfigRow k="Test command" v={task.testCommand ?? 'npm test'} />
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
              <div className="tm-panel">
                <div className="tm-evidence__head">
                  <span className="tm-evidence__dot" />
                  <h3 className="tm-panel__title" style={{ margin: 0 }}>
                    Verified evidence
                  </h3>
                </div>
                <p className="tm-evidence__note">
                  Checked locally by Task Monki — independent of the provider.
                </p>
                <div className="tm-evidence__chips">
                  {evidenceChips.map((chip) => (
                    <StatusChip
                      key={chip.label}
                      label={chip.label}
                      value={chip.value}
                      tone={chip.tone}
                    />
                  ))}
                </div>
                <div className="tm-evidence__rows">
                  {evidenceRows.map((row) => (
                    <div key={row.k} style={{ display: 'contents' }}>
                      <span className="k">{row.k}</span>
                      <span className="v">{row.v}</span>
                    </div>
                  ))}
                </div>
                <div className="tm-evidence__util">
                  {utilityActions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      className="tm-utilbtn"
                      disabled={action.disabled}
                      onClick={action.onClick}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>

              {reviewPhaseVisible ? (
                <FinishPanel
                  task={task}
                  reviewStatus={reviewPending ? 'RUNNING' : reviewGate.status}
                  finishEvidence={finishEvidence}
                  actionBusy={reviewActionBusy}
                  actionsPaused={reviewActionsPaused}
                  actionsPausedReason={reviewPauseReason}
                  onOpenMarkDone={(withIssues) =>
                    setMarkDoneModal(withIssues ? 'issues' : 'clean')
                  }
                  onCreateDeliveryCommit={() => void props.onCreateDeliveryCommit(task.id)}
                  onCreatePullRequest={() => void props.onCreatePullRequest(task.id)}
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
              testRun={testRun}
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
            <ActivityTimeline events={props.events} runs={props.runs} />
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
          busy={reviewActionBusy}
          onCancel={() => setMarkDoneModal(undefined)}
          onConfirm={() => void markDone()}
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
  const staleContextNote =
    effectiveStatus === 'STALE' && hasReviewOutput
      ? 'Previous review output is shown for context only. Re-run the review before acting on the current diff.'
      : undefined;

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
          <div>
            <span className="tm-reviewcard__eyebrow">Suggested next action</span>
            <p>
              {reviewActionsBlockedByImplementation
                ? 'Follow-up work is running. Review actions are paused until the agent finishes, then this task returns for re-review.'
                : nextReviewAction(effectiveStatus)}
            </p>
          </div>
          <div className="tm-reviewcard__buttons">
            {actionsPaused && !reviewIsRunning ? (
              <span className="tm-reviewcard__hint">
                {reviewActionsBlockedByImplementation
                  ? 'The active agent run is fixing review feedback.'
                  : 'Review actions are paused while the review starts.'}
              </span>
            ) : null}

            {!actionsPaused && effectiveStatus === 'NOT_RUN' ? (
              <>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!canStartReview || actionBusy || !sourceRunId}
                  onClick={() => sourceRunId && onRunReview(sourceRunId)}
                >
                  Run Codex review
                </button>
              </>
            ) : null}

            {reviewIsRunning ? (
              <>
                <button
                  type="button"
                  className="outline-button"
                  disabled={!canStopReview || actionBusy || !reviewRun}
                  onClick={() => reviewRun && onStopReview(reviewRun.id)}
                >
                  Stop review
                </button>
                <span className="tm-reviewcard__hint">
                  Actions are paused while the review runs.
                </span>
              </>
            ) : null}

            {!actionsPaused && effectiveStatus === 'PASSED' ? (
              <>
                <button
                  type="button"
                  className="outline-button"
                  disabled={!canRunAgain || actionBusy || !sourceRunId}
                  onClick={() => sourceRunId && onRunReview(sourceRunId)}
                >
                  Run review again
                </button>
              </>
            ) : null}

            {!actionsPaused &&
            ['NEEDS_CHANGES', 'INCONCLUSIVE', 'FAILED', 'CANCELED', 'STALE'].includes(
              effectiveStatus
            ) ? (
              <>
                {canRequestChanges ? (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={actionBusy}
                    onClick={() => onOpenRequestChanges()}
                  >
                    Request changes
                  </button>
                ) : null}
                <button
                  type="button"
                  className="outline-button"
                  disabled={!canRunAgain || actionBusy || !sourceRunId}
                  onClick={() => sourceRunId && onRunReview(sourceRunId)}
                >
                  Run review again
                </button>
              </>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}

function FinishPanel({
  task,
  reviewStatus,
  finishEvidence,
  actionBusy,
  actionsPaused,
  actionsPausedReason,
  onOpenMarkDone,
  onCreateDeliveryCommit,
  onCreatePullRequest
}: {
  task: Task;
  reviewStatus: CodexReviewGateStatus;
  finishEvidence: FinishEvidenceState;
  actionBusy: boolean;
  actionsPaused: boolean;
  actionsPausedReason?: ReviewActionPauseReason;
  onOpenMarkDone(withIssues: boolean): void;
  onCreateDeliveryCommit(): void;
  onCreatePullRequest(): void;
}) {
  if (task.workflowPhase === 'DONE') {
    return null;
  }

  const reviewPassed = reviewStatus === 'PASSED';
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
      : 'Finish actions pause while review runs.';

  return (
    <section className="tm-panel tm-finishpanel" aria-label="Finish task">
      <div className="tm-finishpanel__head">
        <h3 className="tm-panel__title">Finish</h3>
        {reviewPassed ? <Chip tone="success" label="Review passed" /> : null}
      </div>
      <div className="tm-finishpanel__actions">
        {actionsPaused ? <span className="tm-reviewcard__hint">{pausedText}</span> : null}
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`${action.kind === 'primary' ? 'primary-button' : 'outline-button'} ${
              action.id === 'mark-done' && action.withIssues
                ? 'tm-finishpanel__mark-done-anyway'
                : ''
            }`}
            disabled={action.disabled}
            onClick={
              action.id === 'create-draft-pr'
                ? onCreatePullRequest
                : action.id === 'commit'
                  ? onCreateDeliveryCommit
                  : () => onOpenMarkDone(Boolean(action.withIssues))
            }
          >
            {action.label}
          </button>
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
  busy,
  onCancel,
  onConfirm
}: {
  withIssues: boolean;
  warnings: FinishEvidenceState['warnings'];
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const copy = markDoneModalCopy(withIssues, busy);
  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="mark-done-title">
      <div className="tm-modal__scrim" onClick={onCancel} />
      <div className="tm-modal__panel">
        <h3 id="mark-done-title">{copy.title}</h3>
        <p>{copy.body}</p>
        {withIssues && warnings.length === 0 ? (
          <div className="tm-modal__warning">
            <strong>{copy.fallbackWarningTitle}</strong>
            <span>{copy.fallbackWarningDetail}</span>
          </div>
        ) : null}
        {withIssues
          ? warnings.map((warning) => (
              <div className="tm-modal__warning" key={warning.title}>
                <strong>{warning.title}</strong>
                <span>{warning.detail}</span>
              </div>
            ))
          : null}
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

interface EvidenceChip {
  label: string;
  value: string;
  tone: Tone;
}

function buildEvidenceChips(props: TaskDetailProps): EvidenceChip[] {
  const task = props.task!;
  const chips: EvidenceChip[] = [
    { label: 'Git', value: humanizeEnum(task.projection.git), tone: gitTone(task.projection.git) },
    {
      label: 'Tests',
      value: humanizeEnum(task.projection.tests),
      tone: testsTone(task.projection.tests)
    }
  ];
  if (task.projection.githubPullRequest !== 'UNLINKED' && task.projection.githubPullRequest !== 'NOT_CREATED') {
    chips.push({
      label: 'PR',
      value: humanizeEnum(task.projection.githubPullRequest),
      tone: prTone(task.projection.githubPullRequest)
    });
  }
  if (task.projection.ciChecks !== 'NOT_APPLICABLE') {
    chips.push({
      label: 'CI',
      value: humanizeEnum(task.projection.ciChecks),
      tone: ciTone(task.projection.ciChecks)
    });
  }
  return chips;
}

function gitTone(value: string): Tone {
  if (value === 'PUSHED') return 'success';
  if (value === 'DIRTY') return 'action';
  if (value === 'CONFLICTED' || value === 'DIVERGED') return 'error';
  if (value === 'COMMITTED_UNPUSHED') return 'info';
  return 'neutral';
}

function testsTone(value: string): Tone {
  if (value === 'PASSED') return 'success';
  if (value === 'FAILED' || value === 'ERROR') return 'error';
  if (value === 'RUNNING' || value === 'QUEUED') return 'info';
  if (value === 'STALE') return 'action';
  return 'neutral';
}

function prTone(value: string): Tone {
  if (value === 'MERGED') return 'success';
  if (value === 'CLOSED_UNMERGED') return 'error';
  if (value === 'OPEN_DRAFT' || value === 'OPEN_READY') return 'info';
  return 'neutral';
}

function ciTone(value: string): Tone {
  if (value === 'PASSING') return 'success';
  if (value === 'FAILING' || value === 'BLOCKED') return 'error';
  if (value === 'PENDING') return 'action';
  if (value === 'STALE') return 'action';
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
      return { label: 'Review complete', tone: 'action' };
    case 'FAILED':
      return { label: 'Failed', tone: 'error' };
    case 'CANCELED':
      return { label: 'Stopped', tone: 'action' };
    case 'STALE':
      return { label: 'Needs re-review', tone: 'action' };
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
      return 'Review the output, then request changes or mark done explicitly.';
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

function nextReviewAction(
  status: NonNullable<Task['projection']['codexReview']>['status']
): string {
  switch (status) {
    case 'NOT_RUN':
      return 'Run a review.';
    case 'RUNNING':
      return 'Wait for the review to finish, or stop it if it is no longer useful.';
    case 'PASSED':
      return 'Create a draft PR, commit locally, or mark done.';
    case 'NEEDS_CHANGES':
      return 'Request changes.';
    case 'INCONCLUSIVE':
      return 'Request changes or mark done explicitly.';
    case 'FAILED':
      return 'Run the review again or inspect Debug.';
    case 'CANCELED':
      return 'Run the review again.';
    case 'STALE':
      return 'Re-run the review.';
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
