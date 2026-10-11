import type { Ref } from 'react';
import type { DomainEvent } from '../../shared/contracts';
import type {
  TaskActivityEvidence,
  TaskActivityEvidenceRow,
  TaskActivityItem,
  TaskActivityViewModel
} from '../model/taskActivity';
import { summarizeEvent } from '../model/eventSummary';
import { DisclosureChevron } from './DisclosureChevron';
import { OverviewSection } from './TaskOverview';

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

/**
 * The Overview's History: the latest consequential entries, in order, each as
 * what happened, when, and who recorded it, with the date stated once per day.
 * The evidence behind each entry, and the raw audit, stay in the full ledger in
 * Debug, so the Overview never repeats what its Now panel already says.
 */
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
  return (
    <OverviewSection
      title="History"
      inset
      className="tm-taskactivity-panel tm-taskactivity-panel--overview"
      aside={
        onViewAll ? (
          <button type="button" className="tm-osection__link" onClick={onViewAll}>
            Full history
          </button>
        ) : undefined
      }
    >
      <OverviewHistoryDays items={view.items} />
    </OverviewSection>
  );
}

/** Entries grouped by local day; each states its time, then who recorded it. */
function OverviewHistoryDays({ items }: { items: TaskActivityItem[] }) {
  const days: { key: string; label: string; items: { item: TaskActivityItem; timestamp: TaskActivityTimestamp }[] }[] = [];
  for (const item of items) {
    const timestamp = formatTaskActivityTimestamp(item.at);
    const day = days.at(-1);
    if (day?.key === timestamp.date) day.items.push({ item, timestamp });
    else days.push({ key: timestamp.date, label: timestamp.day, items: [{ item, timestamp }] });
  }
  return (
    <div className="tm-ohistory">
      {days.map((day) => (
        <section key={day.key} className="tm-ohistory__day" aria-label={day.label}>
          <h4 className="tm-ohistory__date">{day.label}</h4>
          <ol className="tm-ohistory__list">
            {day.items.map(({ item, timestamp }) => (
              <li key={item.id} className="tm-ohistory__item">
                <span className="tm-ohistory__title">{item.title}</span>
                <time className="tm-ohistory__time" dateTime={item.at} title={timestamp.full}>{timestamp.time}</time>
                <span className="tm-ohistory__actor">{item.actor}</span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
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

/** What happened first; who recorded it and when, beneath. */
function TaskActivityRow({ item }: { item: TaskActivityItem }) {
  const timestamp = formatTaskActivityTimestamp(item.at);
  return (
    <article className="tm-taskactivity__item">
      <strong className="tm-taskactivity__title">{item.title}</strong>
      <div className="tm-taskactivity__meta">
        <span className="tm-taskactivity__actor">{item.actor}</span>
        <time className="tm-taskactivity__time" dateTime={item.at} title={timestamp.full}>
          {timestamp.label}
        </time>
      </div>
      {item.evidence ? <TimelineEvidence evidence={item.evidence} /> : null}
    </article>
  );
}

function TimelineEvidence({ evidence }: { evidence: TaskActivityEvidence }) {
  if (!evidence.rows?.length) {
    return <p className="tm-taskactivity__evidence">{evidence.summary}</p>;
  }

  return (
    <details className="tm-taskactivity__details">
      <summary>
        <DisclosureChevron />
        <span>{evidence.summary}</span>
      </summary>
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
      <summary><DisclosureChevron /><span>Full event audit · {events.length} events</span></summary>
      <div className="tm-eventaudit__list">
        {sortedEvents.map(({ event }) => {
          const summary = summarizeEvent(event);
          const timestamp = formatTaskActivityTimestamp(event.receivedAt);
          return (
            <article className="tm-eventaudit__item" key={event.id} title={event.type}>
              <time dateTime={event.receivedAt} title={timestamp.full}>
                {timestamp.time}
              </time>
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
  /** The day alone, e.g. "Jul 2", with the year when it is not this year. */
  day: string;
  time: string;
  full: string;
  /** Compact but absolute, e.g. "Jul 2, 10:05 AM" in the system clock format; never relative to now. */
  label: string;
}

// Every time in the app follows the system clock format, as conversation times do.
const ACTIVITY_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const ACTIVITY_DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

const ACTIVITY_DAY_FORMAT_WITH_YEAR = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

const ACTIVITY_LABEL_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
});

const ACTIVITY_LABEL_FORMAT_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
});

export function formatTaskActivityTimestamp(value: string): TaskActivityTimestamp {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return {
      date: 'Unknown',
      day: 'Unknown date',
      time: '',
      full: 'Unknown time',
      label: 'Unknown time'
    };
  }
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const dateLabel = `${year}-${month}-${day}`;
  const timeLabel = ACTIVITY_TIME_FORMAT.format(date);
  const thisYear = year === new Date().getFullYear();
  const label = (thisYear ? ACTIVITY_LABEL_FORMAT : ACTIVITY_LABEL_FORMAT_WITH_YEAR).format(date);
  return {
    date: dateLabel,
    day: (thisYear ? ACTIVITY_DAY_FORMAT : ACTIVITY_DAY_FORMAT_WITH_YEAR).format(date),
    time: timeLabel,
    full: `${dateLabel} ${timeLabel}`,
    label
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
