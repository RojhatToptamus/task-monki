import { useEffect, useRef, useState } from 'react';
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
import { StatusChip } from './StatusBadge';

interface TaskDetailProps {
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

interface ActionItem {
  label: string;
  disabled?: boolean;
  onClick(): void;
  tone?: 'danger';
}

export function TaskDetail({
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
  const promptLineCount = task.prompt.split(/\r?\n/).length;

  const segmentedActions: ActionItem[] = [
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
      label: 'Commit',
      disabled: !canCreateDeliveryCommit(task),
      onClick: () => void onCreateDeliveryCommit(task.id)
    }
  ];

  const moveToReview: ActionItem = {
    label: 'Move to review',
    disabled:
      task.workflowPhase === 'REVIEW' ||
      task.workflowPhase === 'IN_REVIEW' ||
      task.workflowPhase === 'DONE' ||
      task.projection.codexRun !== 'COMPLETED',
    onClick: () => void onTransition(task.id, 'REVIEW')
  };

  const overflowActions: ActionItem[] = [
    {
      label: 'Check GitHub',
      disabled: !worktree,
      onClick: () => void onPreflightGitHub(task.id)
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
        <div className="detail__heading-text">
          <span className="detail__eyebrow">
            Task #{formatShortId(task.id)}
            <span className={`health-pill health-pill--${verdict.tone}`}>
              <span className="health-pill__dot" aria-hidden="true" />
              {formatStatus(task.projection.health)}
            </span>
          </span>
          <h1>{task.title}</h1>
        </div>
        <div className="detail__actions">
          <div className="segmented" role="group" aria-label="Task actions">
            {segmentedActions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="segmented__btn"
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="outline-button"
            disabled={moveToReview.disabled}
            onClick={moveToReview.onClick}
          >
            {moveToReview.label}
          </button>
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
          <OverflowMenu actions={overflowActions} />
        </div>
      </header>

      <section className="status-strip" aria-label="Current status">
        <StatusChip label="Phase" value={task.workflowPhase} />
        <StatusChip label="Repo" value={task.projection.repositoryPreflight} />
        <StatusChip label="Worktree" value={task.projection.worktree} />
        <StatusChip label="Git" value={task.projection.git} />
        <StatusChip
          label="Tests"
          value={task.projection.tests}
          muted={task.projection.tests === 'NOT_RUN'}
        />
        <StatusChip label="Codex" value={task.projection.codexRun} />
        <StatusChip
          label="GitHub"
          value={task.projection.githubRepository}
          muted={task.projection.githubRepository === 'NOT_CHECKED'}
        />
      </section>

      <div className="detail__grid">
        <div className="detail__col">
          <section className="card card--prompt">
            <details className="prompt-disclosure">
              <summary>
                <span className="prompt-disclosure__title">
                  <strong>Prompt &amp; config</strong>
                  <span>{promptLineCount} lines</span>
                </span>
                <span className="prompt-disclosure__action">
                  <span className="prompt-disclosure__show">Show prompt</span>
                  <span className="prompt-disclosure__hide">Hide prompt</span>
                  <span className="prompt-disclosure__chevron" aria-hidden="true" />
                </span>
              </summary>
              <pre className="prompt-box">{task.prompt}</pre>
            </details>
            <div className="kv-grid">
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
            <section className="card card--findings">
              <div className="card__header">
                <h3>Findings</h3>
                <span className="count-pill">{task.projection.findings.length}</span>
              </div>
              {task.projection.findings.map((finding) => (
                <article className="finding" key={finding.id}>
                  <strong>{finding.code}</strong>
                  <span>{finding.message}</span>
                </article>
              ))}
            </section>
          ) : null}

          <ActivityTimeline events={events} />
        </div>

        <div className="detail__col">
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
      </div>
    </main>
  );
}

function OverflowMenu({ actions }: { actions: ActionItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="overflow" ref={ref}>
      <button
        type="button"
        className="overflow__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div className="overflow__menu" role="menu">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className={`overflow__item ${action.tone === 'danger' ? 'overflow__item--danger' : ''}`}
              disabled={action.disabled}
              onClick={() => {
                action.onClick();
                setOpen(false);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
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
