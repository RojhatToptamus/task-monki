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
  canPrepareWorktree,
  canPublishBranch,
  canRunTests,
  canStartRun,
  formatShortId
} from '../model/selectors';
import { ActivityTimeline } from './ActivityTimeline';
import { EvidencePanel } from './EvidencePanel';
import { StatusBadge } from './StatusBadge';

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
  onPublishBranch(taskId: string): Promise<void>;
  onCreatePullRequest(taskId: string): Promise<void>;
  onRefreshGitHub(taskId: string): Promise<void>;
  onTransition(taskId: string, toPhase: WorkflowPhase): Promise<void>;
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
  onPublishBranch,
  onCreatePullRequest,
  onRefreshGitHub,
  onTransition
}: TaskDetailProps) {
  if (!task) {
    return (
      <main className="detail detail--empty">
        <h2>Select a task</h2>
        <p>Create or select a card to inspect isolated implementation evidence.</p>
      </main>
    );
  }

  return (
    <main className="detail">
      <header className="detail__header">
        <div>
          <span className="detail__eyebrow">Phase 2 isolated worktree · #{formatShortId(task.id)}</span>
          <h1>{task.title}</h1>
          <p>{task.projection.summary}</p>
        </div>
        <div className="detail__actions">
          <button
            className="secondary-button"
            type="button"
            disabled={!canPrepareWorktree(task)}
            onClick={() => void onPrepareWorktree(task.id)}
          >
            Prepare worktree
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!canStartRun(task)}
            onClick={() => void onStart(task.id)}
          >
            Start implementation
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!canCancelRun(run)}
            onClick={() => run && void onCancel(run.id)}
          >
            Cancel
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={task.projection.worktree !== 'PRESENT'}
            onClick={() => void onRefreshEvidence(task.id)}
          >
            Refresh evidence
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!canRunTests(task)}
            onClick={() => void onRunTests(task.id)}
          >
            Run tests
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!canCreateDeliveryCommit(task)}
            onClick={() => void onCreateDeliveryCommit(task.id)}
          >
            Create delivery commit
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!worktree}
            onClick={() => void onPreflightGitHub(task.id)}
          >
            Check GitHub
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!canPublishBranch(task)}
            onClick={() => void onPublishBranch(task.id)}
          >
            Publish branch
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={branchPublication?.status !== 'PUSHED'}
            onClick={() => void onCreatePullRequest(task.id)}
          >
            Create draft PR
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!pullRequest}
            onClick={() => void onRefreshGitHub(task.id)}
          >
            Refresh GitHub
          </button>
        </div>
      </header>

      <section className="status-strip" aria-label="Current status">
        <StatusBadge label="Workflow" value={task.workflowPhase} />
        <StatusBadge label="Worktree" value={task.projection.worktree} />
        <StatusBadge label="Git" value={task.projection.git} />
        <StatusBadge label="Tests" value={task.projection.tests} />
        <StatusBadge label="GitHub" value={task.projection.githubRepository} />
        <StatusBadge label="Publish" value={task.projection.branchPublication} />
        <StatusBadge label="PR" value={task.projection.githubPullRequest} />
        <StatusBadge label="Checks" value={task.projection.ciChecks} />
        <StatusBadge label="Reviews" value={task.projection.reviews} />
        <StatusBadge label="Merge" value={task.projection.merge} />
        <StatusBadge label="Process" value={task.projection.osProcess} />
        <StatusBadge label="Codex" value={task.projection.codexRun} />
        <StatusBadge label="Repository" value={task.projection.repositoryPreflight} />
        <StatusBadge label="Health" value={task.projection.health} />
      </section>

      <section className="panel">
        <div className="panel__header">
          <h3>Guarded workflow</h3>
          <span>Evidence-backed transitions</span>
        </div>
        <div className="transition-row">
          {(['REVIEW', 'TESTING', 'PR_READY'] as WorkflowPhase[]).map((phase) => (
            <button
              key={phase}
              className="secondary-button"
              type="button"
              disabled={task.workflowPhase === phase}
              onClick={() => void onTransition(task.id, phase)}
            >
              Move to {phase}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel__header">
          <h3>Prompt</h3>
          <span>{task.repositoryPath}</span>
        </div>
        <pre className="prompt-box">{task.prompt}</pre>
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
