import type { Ref } from 'react';
import type { DomainEvent } from '../../shared/contracts';
import type {
  TaskActivityEvidence,
  TaskActivityEvidenceRow,
  TaskActivityItem,
  TaskActivityViewModel
} from '../model/taskActivity';
import { summarizeEvent } from '../model/eventSummary';

interface TaskActivityPanelProps {
  view: TaskActivityViewModel;
  variant: 'overview' | 'debug';
  rawEvents?: DomainEvent[];
  onViewAll?: () => void;
  rootRef?: Ref<HTMLElement>;
}

export function TaskActivityPanel({
  view,
  variant,
  rawEvents = [],
  onViewAll,
  rootRef
}: TaskActivityPanelProps) {
  if (variant === 'overview') {
    return <OverviewTaskActivity view={view} onViewAll={onViewAll} />;
  }

  return <DebugTaskActivity view={view} rawEvents={rawEvents} rootRef={rootRef} />;
}

function OverviewTaskActivity({
  view,
  onViewAll
}: {
  view: TaskActivityViewModel;
  onViewAll?: () => void;
}) {
  if (!view.items.length) {
    return null;
  }
  const latest = view.items.at(-1);
  if (!latest) {
    return null;
  }
  const earlierCount = view.hiddenCount + view.items.length - 1;

  return (
    <section
      className="tm-panel tm-taskactivity-panel tm-taskactivity-panel--overview"
      aria-label="Activity"
    >
      <div className="tm-taskactivity__head">
        <h3 className="tm-panel__title">Activity</h3>
        {earlierCount > 0 ? (
          <span className="tm-taskactivity__count">
            {earlierCount} earlier {earlierCount === 1 ? 'item' : 'items'}
          </span>
        ) : null}
      </div>
      <TaskActivityList items={[latest]} />
      {onViewAll && earlierCount > 0 ? (
        <button type="button" className="tm-taskactivity__viewall" onClick={onViewAll}>
          View full activity
        </button>
      ) : null}
    </section>
  );
}

function DebugTaskActivity({
  view,
  rawEvents,
  rootRef
}: {
  view: TaskActivityViewModel;
  rawEvents: DomainEvent[];
  rootRef?: Ref<HTMLElement>;
}) {
  return (
    <section
      ref={rootRef}
      tabIndex={rootRef ? -1 : undefined}
      className="card card--activity tm-taskactivity-panel tm-taskactivity-panel--debug"
      aria-label="Task activity"
    >
      <div className="card__header">
        <div>
          <h3>Task activity</h3>
        </div>
        <span className="count-pill">{view.totalCount} key events</span>
      </div>
      {view.items.length ? (
        <TaskActivityList items={view.items} />
      ) : (
        <p className="muted">No key activity yet.</p>
      )}
      {rawEvents.length > view.totalCount ? <RawEventAudit events={rawEvents} /> : null}
    </section>
  );
}

function TaskActivityList({ items }: { items: TaskActivityItem[] }) {
  return (
    <div className="tm-taskactivity__list">
      {items.map((item) => (
        <TaskActivityRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function TaskActivityRow({ item }: { item: TaskActivityItem }) {
  const timestamp = formatTaskActivityTimestamp(item.at);
  return (
    <article className={`tm-taskactivity__item tm-taskactivity__item--${item.tone}`}>
      <time className="tm-taskactivity__time" dateTime={item.at} title={timestamp.full}>
        <span>{timestamp.date}</span>
        <span>{timestamp.time}</span>
      </time>
      <span
        className={`tm-taskactivity__dot tm-taskactivity__dot--${item.tone}`}
        aria-hidden="true"
      />
      <div className="tm-taskactivity__body">
        <div className="tm-taskactivity__line">
          <span className="tm-taskactivity__actor">{item.actor}</span>
          <strong>{item.title}</strong>
        </div>
        {item.evidence ? <TimelineEvidence evidence={item.evidence} /> : null}
      </div>
    </article>
  );
}

function TimelineEvidence({ evidence }: { evidence: TaskActivityEvidence }) {
  if (!evidence.rows?.length) {
    return <p className="tm-taskactivity__evidence">{evidence.summary}</p>;
  }

  return (
    <details className="tm-taskactivity__details">
      <summary>{evidence.summary}</summary>
      <div className="tm-taskactivity__evidence-rows">
        {evidence.rows.map((row, index) => (
          <EvidenceRow key={`${row.label}:${index}`} row={row} />
        ))}
      </div>
    </details>
  );
}

function EvidenceRow({ row }: { row: TaskActivityEvidenceRow }) {
  const label = row.href ? (
    <a href={row.href} target="_blank" rel="noreferrer">
      {row.label}
    </a>
  ) : (
    <span>{row.label}</span>
  );
  return (
    <div className="tm-taskactivity__evidence-row">
      {label}
      {row.value ? <strong>{row.value}</strong> : null}
    </div>
  );
}

function RawEventAudit({ events }: { events: DomainEvent[] }) {
  const sortedEvents = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => compareTimeAscending(a.event.receivedAt, b.event.receivedAt) || a.index - b.index);
  return (
    <details className="tm-eventaudit">
      <summary>Full event audit · {events.length} events</summary>
      <div className="tm-eventaudit__list">
        {sortedEvents.map(({ event }) => {
          const summary = summarizeEvent(event);
          const timestamp = formatTaskActivityTimestamp(event.receivedAt);
          return (
            <article className="tm-eventaudit__item" key={event.id} title={event.type}>
              <time dateTime={event.receivedAt} title={timestamp.full}>
                {timestamp.time}
              </time>
              <span className="tm-eventaudit__dot" aria-hidden="true" />
              <span className="tm-eventaudit__body">
                <strong>{summary.label}</strong>
                {summary.detail ? <span>{summary.detail}</span> : null}
              </span>
            </article>
          );
        })}
      </div>
    </details>
  );
}

export interface TaskActivityTimestamp {
  date: string;
  time: string;
  full: string;
}

export function formatTaskActivityTimestamp(value: string): TaskActivityTimestamp {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return {
      date: 'Unknown',
      time: '',
      full: 'Unknown time'
    };
  }
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const dateLabel = `${year}-${month}-${day}`;
  const timeLabel = `${hours}:${minutes}`;
  return {
    date: dateLabel,
    time: timeLabel,
    full: `${dateLabel} ${timeLabel}`
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function compareTimeAscending(a: string, b: string): number {
  return timeValue(a) - timeValue(b);
}

function timeValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
