import type {
  ArtifactRecord,
  BranchPublicationRecord,
  CiRollupRecord,
  DomainEvent,
  GitSnapshotRecord,
  GitHubRepositoryRecord,
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
  canCancelRun,
  canCreateDeliveryCommit,
  canCreatePullRequest,
  canPrepareWorktree,
  canRunTests,
  canStartRun,
  formatShortId
} from '../model/selectors';
import { ActivityTimeline } from './ActivityTimeline';
import { EvidencePanel } from './EvidencePanel';
import { StatusBadge } from './StatusBadge';

interface TaskDetailProps {
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
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
  artifacts: ArtifactRecord[];
  onPrepareWorktree(taskId: string): Promise<void>;
  onStart(taskId: string): Promise<void>;
  onCancel(runId: string): Promise<void>;
  onRefreshEvidence(taskId: string): Promise<void>;
  onRunTests(taskId: string): Promise<void>;
  onCreateDeliveryCommit(taskId: string): Promise<void>;
  onPreflightGitHub(taskId: string): Promise<void>;
  onCreatePullRequest(taskId: string): Promise<void>;
  onRefreshGitHub(taskId: string): Promise<void>;
  onTransition(taskId: string, toPhase: WorkflowPhase): Promise<void>;
}

export function TaskDetail({
  sidebarCollapsed,
  onToggleSidebar,
  task,
  run,
  worktree,
  gitSnapshot,
  testRun,
  githubRepository,
  branchPublication,
  pullRequest,
  ciRollup,
  reviewRollup,
  mergeSnapshot,
  events,
  artifacts,
  onPrepareWorktree,
  onStart,
  onCancel,
  onRefreshEvidence,
  onRunTests,
  onCreateDeliveryCommit,
  onPreflightGitHub,
  onCreatePullRequest,
  onRefreshGitHub,
  onTransition
}: TaskDetailProps) {
  if (!task) {
    return (
      <main className="detail detail--empty">
        {sidebarCollapsed ? (
          <button
            type="button"
            className="sidebar-toggle detail__empty-toggle"
            aria-label="Show sidebar"
            title="Show sidebar"
            onClick={onToggleSidebar}
          >
            <SidebarIcon />
          </button>
        ) : null}
        <div className="detail__empty-inner">
          <h2>Select a task</h2>
          <p>Create or select a card to inspect isolated implementation evidence.</p>
        </div>
      </main>
    );
  }

  const primaryAction = getPrimaryAction({
    task,
    worktreePresent: Boolean(worktree),
    onPrepareWorktree,
    onStart,
    onCreatePullRequest
  });
  const verdict = getVerdict(task);
  const deliveryStarted =
    task.projection.branchPublication !== 'NOT_PUSHED' ||
    task.projection.githubPullRequest !== 'UNLINKED';
  const promptLineCount = task.prompt.split(/\r?\n/).length;

  const secondaryActions: Array<{
    label: string;
    disabled?: boolean;
    onClick(): void;
    tone?: 'danger';
  }> = [
    {
      label: 'Move to review',
      disabled:
        task.workflowPhase === 'REVIEW' ||
        task.workflowPhase === 'IN_REVIEW' ||
        task.workflowPhase === 'DONE' ||
        task.projection.codexRun !== 'COMPLETED',
      onClick: () => void onTransition(task.id, 'REVIEW')
    },
    {
      label: 'Run tests',
      disabled: !canRunTests(task),
      onClick: () => void onRunTests(task.id)
    },
    {
      label: 'Refresh evidence',
      disabled: task.projection.worktree !== 'PRESENT',
      onClick: () => void onRefreshEvidence(task.id)
    },
    {
      label: 'Check GitHub',
      disabled: !worktree,
      onClick: () => void onPreflightGitHub(task.id)
    },
    {
      label: 'Commit changes',
      disabled: !canCreateDeliveryCommit(task),
      onClick: () => void onCreateDeliveryCommit(task.id)
    },
    {
      label: 'Refresh GitHub',
      disabled: !pullRequest,
      onClick: () => void onRefreshGitHub(task.id)
    },
    {
      label: 'Cancel run',
      disabled: !canCancelRun(run),
      tone: 'danger',
      onClick: () => run && void onCancel(run.id)
    }
  ];

  return (
    <main className="detail">
      <header className="detail__header">
        <div className="detail__heading">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            aria-pressed={!sidebarCollapsed}
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            onClick={onToggleSidebar}
          >
            <SidebarIcon />
          </button>
          <div className="detail__heading-text">
            <span className="detail__eyebrow">Task #{formatShortId(task.id)}</span>
            <h1>{task.title}</h1>
            <div className={`task-verdict task-verdict--${verdict.tone}`}>
              <span className="task-verdict__dot" aria-hidden="true" />
              <strong>{formatStatus(task.projection.health)}</strong>
              <span>{verdict.message}</span>
            </div>
          </div>
        </div>
        <div className="detail__actions">
          {primaryAction ? (
            <button
              className="primary-button"
              type="button"
              disabled={primaryAction.disabled}
              onClick={primaryAction.onClick}
            >
              {primaryAction.label}
            </button>
          ) : null}
          <div className="detail__secondary-actions">
            {secondaryActions.map((action) => (
              <button
                className={`secondary-button ${action.tone === 'danger' ? 'secondary-button--danger' : ''}`}
                key={action.label}
                type="button"
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <section className="status-overview" aria-label="Current status">
        <div className="status-group">
          <span className="status-group__label">Workflow</span>
          <div className="status-group__items">
            <StatusBadge label="Phase" value={task.workflowPhase} />
            <StatusBadge label="Repository" value={task.projection.repositoryPreflight} />
          </div>
        </div>

        <div className="status-group">
          <span className="status-group__label">Local</span>
          <div className="status-group__items">
            <StatusBadge label="Worktree" value={task.projection.worktree} />
            <StatusBadge label="Git" value={task.projection.git} />
            <StatusBadge
              label="Tests"
              value={task.projection.tests}
              muted={task.projection.tests === 'NOT_RUN'}
            />
            <StatusBadge label="Process" value={task.projection.osProcess} />
            <StatusBadge label="Codex" value={task.projection.codexRun} />
          </div>
        </div>

        <div className="status-group">
          <span className="status-group__label">Delivery</span>
          <div className="status-group__items">
            <StatusBadge label="GitHub" value={task.projection.githubRepository} />
            {deliveryStarted ? (
              <>
                <StatusBadge
                  label="Publish"
                  value={task.projection.branchPublication}
                  muted={task.projection.branchPublication === 'NOT_PUSHED'}
                />
                <StatusBadge
                  label="PR"
                  value={task.projection.githubPullRequest}
                  muted={task.projection.githubPullRequest === 'UNLINKED'}
                />
                <StatusBadge
                  label="Checks"
                  value={task.projection.ciChecks}
                  muted={task.projection.ciChecks === 'NOT_APPLICABLE'}
                />
                <StatusBadge
                  label="Reviews"
                  value={task.projection.reviews}
                  muted={task.projection.reviews === 'NOT_APPLICABLE'}
                />
                <StatusBadge
                  label="Merge"
                  value={task.projection.merge}
                  muted={task.projection.merge === 'NOT_APPLICABLE'}
                />
              </>
            ) : (
              <span className="status-group__empty">Delivery not started</span>
            )}
          </div>
        </div>
      </section>

      <section className="panel panel--prompt">
        <details className="prompt-disclosure">
          <summary>
            <span className="prompt-disclosure__title">
              <strong>Prompt</strong>
              <span>{promptLineCount} lines</span>
            </span>
            <span className="prompt-disclosure__repository">{task.repositoryPath}</span>
            <span className="prompt-disclosure__action">
              <span className="prompt-disclosure__show">Show prompt</span>
              <span className="prompt-disclosure__hide">Hide prompt</span>
              <span className="prompt-disclosure__chevron" aria-hidden="true" />
            </span>
          </summary>
          <pre className="prompt-box">{task.prompt}</pre>
        </details>
        <div className="metadata-grid">
          <span>Test command</span>
          <strong>{task.testCommand ?? 'npm test'}</strong>
          <span>Branch</span>
          <strong>{worktree?.branchName ?? 'Not created'}</strong>
          <span>Worktree</span>
          <strong>{worktree?.worktreePath ?? 'Not created'}</strong>
          <span>Git generation</span>
          <strong>{gitSnapshot?.dirtyFingerprint.slice(0, 12) ?? 'Not inspected'}</strong>
          <span>Pull request</span>
          <strong>{pullRequest?.url ?? 'Not created'}</strong>
          <span>Remote</span>
          <strong>
            {githubRepository?.owner && githubRepository.repo
              ? `${githubRepository.owner}/${githubRepository.repo}`
              : 'Not checked'}
          </strong>
        </div>
      </section>

      {task.projection.findings.length > 0 ? (
        <section className="panel panel--findings">
          <div className="panel__header">
            <h3>Findings</h3>
            <span>{task.projection.findings.length}</span>
          </div>
          {task.projection.findings.map((finding) => (
            <article className="finding" key={finding.id}>
              <strong>{finding.code}</strong>
              <span>{finding.message}</span>
            </article>
          ))}
        </section>
      ) : null}

      <div className="detail__grid">
        <ActivityTimeline events={events} />
        <EvidencePanel
          run={run}
          worktree={worktree}
          gitSnapshot={gitSnapshot}
          testRun={testRun}
          githubRepository={githubRepository}
          branchPublication={branchPublication}
          pullRequest={pullRequest}
          ciRollup={ciRollup}
          reviewRollup={reviewRollup}
          mergeSnapshot={mergeSnapshot}
          artifacts={artifacts}
        />
      </div>
    </main>
  );
}

function getVerdict(task: Task): {
  message: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
} {
  const health = task.projection.health;
  const matchingFinding = [...task.projection.findings]
    .reverse()
    .find((finding) => finding.severity === health);

  return {
    message: matchingFinding?.message ?? task.projection.summary,
    tone:
      health === 'HEALTHY'
        ? 'success'
        : health === 'WARNING'
          ? 'warning'
          : health === 'ERROR' || health === 'BLOCKED'
            ? 'error'
            : 'info'
  };
}

function formatStatus(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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

function SidebarIcon() {
  return (
    <svg
      className="sidebar-toggle__icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <line x1="6.25" y1="3" x2="6.25" y2="13" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
