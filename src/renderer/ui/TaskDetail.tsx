import type {
  ArtifactRecord,
  DomainEvent,
  GitSnapshotRecord,
  RunRecord,
  Task,
  TestRunRecord,
  WorkflowPhase,
  WorktreeRecord
} from '../../shared/contracts';
import {
  canCancelRun,
  canPrepareWorktree,
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
  events: DomainEvent[];
  artifacts: ArtifactRecord[];
  onPrepareWorktree(taskId: string): Promise<void>;
  onStart(taskId: string): Promise<void>;
  onCancel(runId: string): Promise<void>;
  onRefreshEvidence(taskId: string): Promise<void>;
  onRunTests(taskId: string): Promise<void>;
  onTransition(taskId: string, toPhase: WorkflowPhase): Promise<void>;
}

export function TaskDetail({
  task,
  run,
  worktree,
  gitSnapshot,
  testRun,
  events,
  artifacts,
  onPrepareWorktree,
  onStart,
  onCancel,
  onRefreshEvidence,
  onRunTests,
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
        </div>
      </header>

      <section className="status-strip" aria-label="Current status">
        <StatusBadge label="Workflow" value={task.workflowPhase} />
        <StatusBadge label="Worktree" value={task.projection.worktree} />
        <StatusBadge label="Git" value={task.projection.git} />
        <StatusBadge label="Tests" value={task.projection.tests} />
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
          artifacts={artifacts}
        />
      </div>
    </main>
  );
}
