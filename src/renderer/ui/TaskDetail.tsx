import type { ArtifactRecord, DomainEvent, RunRecord, Task } from '../../shared/contracts';
import { canCancelRun, canStartRun, formatShortId } from '../model/selectors';
import { ActivityTimeline } from './ActivityTimeline';
import { EvidencePanel } from './EvidencePanel';
import { StatusBadge } from './StatusBadge';

interface TaskDetailProps {
  task?: Task;
  run?: RunRecord;
  events: DomainEvent[];
  artifacts: ArtifactRecord[];
  onStart(taskId: string): Promise<void>;
  onCancel(runId: string): Promise<void>;
}

export function TaskDetail({ task, run, events, artifacts, onStart, onCancel }: TaskDetailProps) {
  if (!task) {
    return (
      <main className="detail detail--empty">
        <h2>Select a task</h2>
        <p>Create or select a card to inspect read-only Codex evidence.</p>
      </main>
    );
  }

  return (
    <main className="detail">
      <header className="detail__header">
        <div>
          <span className="detail__eyebrow">Read-only Codex run · #{formatShortId(task.id)}</span>
          <h1>{task.title}</h1>
          <p>{task.projection.summary}</p>
        </div>
        <div className="detail__actions">
          <button
            className="primary-button"
            type="button"
            disabled={!canStartRun(task)}
            onClick={() => void onStart(task.id)}
          >
            Start run
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!canCancelRun(run)}
            onClick={() => run && void onCancel(run.id)}
          >
            Cancel
          </button>
        </div>
      </header>

      <section className="status-strip" aria-label="Current status">
        <StatusBadge label="Workflow" value={task.workflowPhase} />
        <StatusBadge label="Process" value={task.projection.osProcess} />
        <StatusBadge label="Codex" value={task.projection.codexRun} />
        <StatusBadge label="Repository" value={task.projection.repositoryPreflight} />
        <StatusBadge label="Health" value={task.projection.health} />
      </section>

      <section className="panel">
        <div className="panel__header">
          <h3>Prompt</h3>
          <span>{task.repositoryPath}</span>
        </div>
        <pre className="prompt-box">{task.prompt}</pre>
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
        <EvidencePanel run={run} artifacts={artifacts} />
      </div>
    </main>
  );
}
