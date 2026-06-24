import { useState } from 'react';
import type {
  ArtifactRecord,
  BranchPublicationRecord,
  CiRollupRecord,
  DomainEvent,
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
  canCreateDeliveryCommit,
  canCreatePullRequest,
  canPrepareWorktree,
  canRunTests,
  canStartRun,
  formatShortId
} from '../model/selectors';
import { ActivityTimeline } from './ActivityTimeline';
import { AgentControlPanel } from './AgentControlPanel';
import { EvidencePanel } from './EvidencePanel';
import { InteractionPanel } from './InteractionPanel';
import { InteractionAuditPanel } from './InteractionAuditPanel';
import { ProviderActivityPanel } from './ProviderActivityPanel';
import { ProviderOverviewPanel } from './ProviderOverviewPanel';
import { SubagentHierarchyPanel } from './SubagentHierarchyPanel';
import { Chip, dotStyle } from './MainColumn';
import { describeTaskState, type Tone } from './taskView';
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

export function TaskDetail(props: TaskDetailProps) {
  const { task, error } = props;
  const [tab, setTab] = useState<DetailTab>('overview');

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

  const primaryAction = getPrimaryAction({
    task,
    worktreePresent: Boolean(worktree),
    onPrepareWorktree: props.onPrepareWorktree,
    onStart: props.onStart,
    onCreatePullRequest: props.onCreatePullRequest
  });

  const headActions: HeadAction[] = [];
  headActions.push({
    label: 'Move to review',
    kind: 'soft',
    disabled:
      task.workflowPhase === 'REVIEW' ||
      task.workflowPhase === 'IN_REVIEW' ||
      task.workflowPhase === 'DONE' ||
      task.projection.agentRun !== 'COMPLETED',
    onClick: () => void props.onTransition(task.id, 'REVIEW')
  });
  if (primaryAction) {
    headActions.push({
      label: primaryAction.label,
      kind: 'primary',
      disabled: primaryAction.disabled,
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
    {
      label: 'Commit',
      disabled: !canCreateDeliveryCommit(task),
      onClick: () => void props.onCreateDeliveryCommit(task.id)
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
            <h1 className="tm-detail__title">{task.title}</h1>
            <div className="tm-detail__meta">
              {repositoryName(task.repositoryPath)}
              {worktree?.branchName ? ` · ${worktree.branchName}` : ''}
            </div>
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

      <div className="tm-detail__body">
        {error ? <div className="tm-error">{error}</div> : null}

        {tab === 'overview' ? (
          <div className="tm-overview">
            <div className="tm-overview__col">
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
                <details className="tm-raw" open>
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
                onReview={props.onReview}
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
                    <span className="tm-evchip" key={chip.label}>
                      <span className="tm-evchip__dot" style={dotStyle(chip.tone)} />
                      {chip.label} <strong>{chip.value}</strong>
                    </span>
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

              <div className="tm-teaser">
                <div>
                  <h3 className="tm-teaser__title">Provider telemetry</h3>
                  <span className="tm-teaser__sub">Raw turns, tool calls, usage, subagents</span>
                </div>
                <button type="button" className="tm-headbtn" onClick={() => setTab('debug')}>
                  Open debug →
                </button>
              </div>
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
            {task.projection.findings.length > 0 ? (
              <div className="tm-panel">
                <h3 className="tm-panel__title">Findings</h3>
                {task.projection.findings.map((finding) => (
                  <div className="tm-fact" key={finding.id}>
                    <span className="tm-fact__k">{finding.code}</span>
                    <span className="tm-fact__v" style={{ fontFamily: 'var(--font-ui)' }}>
                      {finding.message}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === 'debug' ? (
          <div className="tm-debug">
            <div className="tm-debug__notice">
              Debug surface — everything here is provider-reported and not authoritative. Verified
              state lives under Evidence.
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
            <ActivityTimeline events={props.events} />
          </div>
        ) : null}
      </div>
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

function repositoryName(repositoryPath: string): string {
  const parts = repositoryPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? repositoryPath;
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
  worktreePresent: boolean;
  onPrepareWorktree(taskId: string): Promise<void>;
  onStart(taskId: string): Promise<void>;
  onCreatePullRequest(taskId: string): Promise<void>;
}): { label: string; disabled?: boolean; onClick(): void } | undefined {
  if (input.task.workflowPhase === 'REVIEW' && input.worktreePresent) {
    return {
      label: 'Create draft PR',
      disabled: !canCreatePullRequest(input.task),
      onClick: () => void input.onCreatePullRequest(input.task.id)
    };
  }

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
