import type { DomainEvent } from '../../shared/contracts';

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
          events.map((event) => (
            <article className="timeline__event" key={event.id}>
              <time>{new Date(event.receivedAt).toLocaleTimeString()}</time>
              <strong>{event.type}</strong>
              <span>{summarizePayload(event.payload)}</span>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function summarizePayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const data = payload as Record<string, unknown>;
  if (typeof data.eventType === 'string') {
    return data.eventType;
  }
  if (typeof data.text === 'string') {
    return data.text.trim().slice(0, 140);
  }
  if (typeof data.error === 'string') {
    return data.error;
  }
  if (typeof data.exitCode === 'number') {
    return `exit ${data.exitCode}`;
  }
  if (typeof data.signal === 'string') {
    return data.signal;
  }
  return '';
}
