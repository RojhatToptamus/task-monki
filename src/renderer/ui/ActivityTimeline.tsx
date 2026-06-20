import type { DomainEvent } from '../../shared/contracts';
import { summarizeEvent } from '../model/eventSummary';

interface ActivityTimelineProps {
  events: DomainEvent[];
}

export function ActivityTimeline({ events }: ActivityTimelineProps) {
  return (
    <section className="card card--activity">
      <div className="card__header">
        <h3>Activity</h3>
        <span className="count-pill">{events.length} events</span>
      </div>
      <div className="timeline">
        {events.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          events.map((event) => {
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
          })
        )}
      </div>
    </section>
  );
}

function toneForEvent(type: string): 'success' | 'error' | 'info' | 'neutral' {
  if (
    type.endsWith('_FAILED') ||
    type.endsWith('_BLOCKED') ||
    type === 'CODEX_RUN_FAILED'
  ) {
    return 'error';
  }
  if (
    type === 'WORKTREE_CREATED' ||
    type === 'GIT_SNAPSHOT_CAPTURED' ||
    type === 'CODEX_RUN_COMPLETED' ||
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
    type === 'CODEX_EVENT_PARSED'
  ) {
    return 'info';
  }
  return 'neutral';
}
