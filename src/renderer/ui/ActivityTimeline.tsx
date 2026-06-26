import type { DomainEvent, RunRecord } from '../../shared/contracts';
import { buildTaskHistory } from '../model/taskHistory';
import { summarizeEvent } from '../model/eventSummary';

interface ActivityTimelineProps {
  events: DomainEvent[];
  runs?: RunRecord[];
}

export function ActivityTimeline({ events, runs = [] }: ActivityTimelineProps) {
  const history = buildTaskHistory(events, runs);
  return (
    <section className="card card--activity">
      <div className="card__header">
        <div>
          <h3>Task activity</h3>
          <p className="provider-subtitle">Requests, runs, reviews, evidence, and delivery changes.</p>
        </div>
        <span className="count-pill">{history.length} key events</span>
      </div>
      <div className="timeline">
        {history.length === 0 ? (
          <p className="muted">No key activity yet.</p>
        ) : (
          history.map((entry) => {
            return (
              <article className="timeline__event" key={entry.id} title={entry.category}>
                <time>{new Date(entry.at).toLocaleTimeString()}</time>
                <span
                  className={`timeline__dot timeline__dot--${entry.tone}`}
                  aria-hidden="true"
                />
                <span className="timeline__body">
                  <strong>{entry.title}</strong>
                  {entry.detail ? <span>{entry.detail}</span> : null}
                </span>
              </article>
            );
          })
        )}
      </div>
      {events.length > history.length ? (
        <details className="timeline__raw">
          <summary>Full event audit · {events.length} events</summary>
          <div className="timeline timeline--raw">
            {events.map((event) => {
              const summary = summarizeEvent(event);
              return (
                <article className="timeline__event" key={event.id} title={event.type}>
                  <time>{new Date(event.receivedAt).toLocaleTimeString()}</time>
                  <span
                    className={`timeline__dot timeline__dot--${toneForEvent(event.type)}`}
                    aria-hidden="true"
                  />
                  <span className="timeline__body">
                    <strong>{summary.label}</strong>
                    {summary.detail ? <span>{summary.detail}</span> : null}
                  </span>
                </article>
              );
            })}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function toneForEvent(type: string): 'success' | 'error' | 'info' | 'action' | 'neutral' {
  if (
    type.endsWith('_FAILED') ||
    type.endsWith('_BLOCKED') ||
    type === 'AGENT_RUN_FAILED'
  ) {
    return 'error';
  }
  if (
    type === 'WORKTREE_CREATED' ||
    type === 'GIT_SNAPSHOT_CAPTURED' ||
    type === 'AGENT_RUN_COMPLETED' ||
    type === 'TEST_RUN_COMPLETED' ||
    type === 'BRANCH_PUBLISHED' ||
    type === 'TRANSITION_COMPLETED'
  ) {
    return 'success';
  }
  if (
    type === 'TASK_ITERATION_CREATED' ||
    type === 'PROCESS_STARTED' ||
    type === 'TEST_RUN_STARTED' ||
    type === 'AGENT_ACTIVITY_RECEIVED'
  ) {
    return 'info';
  }
  if (type === 'CANCEL_REQUESTED' || type === 'TEST_RESULT_STALE') {
    return 'action';
  }
  return 'neutral';
}
