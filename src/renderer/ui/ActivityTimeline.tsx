import type { DomainEvent } from '../../shared/contracts';
import { summarizeEvent } from '../model/eventSummary';

interface ActivityTimelineProps {
  events: DomainEvent[];
}

export function ActivityTimeline({ events }: ActivityTimelineProps) {
  return (
    <section className="panel">
      <div className="panel__header">
        <h3>Activity</h3>
        <span>{events.length} events</span>
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
                <strong>{summary.label}</strong>
                <span>{summary.detail}</span>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
