import type { OverviewActivityLeaf, OverviewActivityRow } from '../model/overviewRunActivity';

interface RunActivityTimelineProps {
  rows: OverviewActivityRow[];
  outputSummary?: string;
  onShowDebug?: () => void;
}

export function RunActivityTimeline({
  rows,
  outputSummary,
  onShowDebug
}: RunActivityTimelineProps) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="tm-run-activity tm-run-activity--live" aria-label="Agent activity">
      <div className="tm-run-activity__head">
        <span>Activity</span>
        <span>following tail</span>
      </div>
      <div className="tm-run-activity__list">
        {rows.map((row) => (
          <ActivityRow key={row.key} row={row} />
        ))}
      </div>
      {outputSummary ? (
        <button
          type="button"
          className="tm-run-activity__output"
          onClick={onShowDebug}
          disabled={!onShowDebug}
          title="Open Debug for provider output"
        >
          {outputSummary}
        </button>
      ) : null}
    </section>
  );
}

function ActivityRow({ row }: { row: OverviewActivityRow }) {
  const expandable = row.grouped && row.children && row.children.length > 0;
  const className = [
    'tm-run-activity__row',
    `tm-run-activity__row--${row.kind}`,
    row.status === 'active' ? 'tm-run-activity__row--active' : '',
    row.status === 'failed' ? 'tm-run-activity__row--failed' : ''
  ].filter(Boolean).join(' ');

  if (expandable) {
    return (
      <details className={className} open={row.defaultOpen}>
        <summary className="tm-run-activity__summary">
          <ActivityIcon icon={row.icon} />
          <ActivityCopy row={row} />
        </summary>
        <div className="tm-run-activity__children">
          {row.children?.map((child) => (
            <div className="tm-run-activity__child" key={child.key}>
              <ActivityCopy row={child} child />
            </div>
          ))}
        </div>
      </details>
    );
  }

  return (
    <div className={className}>
      <ActivityIcon icon={row.icon} />
      <ActivityCopy row={row} />
    </div>
  );
}

function ActivityCopy({
  row,
  child = false
}: {
  row: OverviewActivityLeaf;
  child?: boolean;
}) {
  const detailClass = [
    'tm-run-activity__detail',
    row.detailKind === 'command' ? 'tm-run-activity__detail--command' : '',
    row.detailKind === 'path' ? 'tm-run-activity__detail--path' : '',
    row.detailKind === 'count' ? 'tm-run-activity__detail--count' : ''
  ].filter(Boolean).join(' ');

  return (
    <span className={`tm-run-activity__copy ${child ? 'tm-run-activity__copy--child' : ''}`}>
      <span className="tm-run-activity__label">{row.label}</span>
      {row.detail ? <span className={detailClass}>{row.detail}</span> : null}
      {row.metric ? <span className="tm-run-activity__metric">{row.metric}</span> : null}
    </span>
  );
}

function ActivityIcon({ icon }: { icon: OverviewActivityLeaf['icon'] }) {
  return (
    <span className={`tm-run-activity__icon tm-run-activity__icon--${icon}`} aria-hidden="true">
      <ActivitySvg icon={icon} />
    </span>
  );
}

function ActivitySvg({ icon }: { icon: OverviewActivityLeaf['icon'] }) {
  if (icon === 'message') {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <path d="M3.5 3.5h9v6h-4L5 12v-2.5H3.5z" />
        <path d="M5 5.75h6M5 7.75h3" />
      </svg>
    );
  }
  if (icon === 'terminal' || icon === 'error') {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <path d="M2.75 3.25h10.5v9.5H2.75z" />
        <path d="m5 6 2 2-2 2M8.25 10h3" />
      </svg>
    );
  }
  if (icon === 'search') {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="3.75" />
        <path d="m10 10 3 3" />
      </svg>
    );
  }
  if (icon === 'edit') {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <path d="M3.25 11.5 4 8.75l5.5-5.5 2.25 2.25-5.5 5.5z" />
        <path d="M8.75 4 11 6.25M3 13h10" />
      </svg>
    );
  }
  if (icon === 'wait') {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5" />
        <path d="M8 5v3l2 1.5" />
      </svg>
    );
  }
  if (icon === 'tool') {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <path d="M6 3.25 3.25 6 5 7.75l2.75-2.75M8.25 8.25 11 5.5 12.75 7.25 10 10" />
        <path d="m6.5 9.5-3 3M9.5 6.5l3-3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M4.25 2.75h5L12 5.5v7.75H4.25z" />
      <path d="M9.25 2.75V5.5H12" />
    </svg>
  );
}
