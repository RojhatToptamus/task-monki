import { useState } from 'react';
import {
  CircleAlert,
  Clock3,
  FileText,
  MessageSquareText,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon
} from 'lucide-react';
import type { OverviewActivityLeaf, OverviewActivityRow } from '../model/overviewRunActivity';
import { DisclosureChevron } from './DisclosureChevron';

interface RunActivityTimelineProps {
  rows: OverviewActivityRow[];
  outputSummary?: string;
  onShowDebug?: () => void;
  live?: boolean;
  compact?: boolean;
}

export function RunActivityTimeline({
  rows,
  outputSummary,
  onShowDebug,
  live = true,
  compact = false
}: RunActivityTimelineProps) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <section
      className={`tm-run-activity ${live ? 'tm-run-activity--live' : ''} ${compact ? 'tm-run-activity--compact' : ''}`}
      aria-label="Agent activity"
    >
      {!compact ? <div className="tm-run-activity__head">
        <span>{live ? 'Activity' : 'Recent activity'}</span>
        {live ? <span>following tail</span> : null}
      </div> : null}
      {compact && rows.length > 1 ? <details className="tm-run-activity__group">
        <summary><DisclosureChevron /><Wrench size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>{rows.length} operations</span>
          {rows.some((row) => row.status === 'active') ? <span className="tm-run-activity__state">{rows.filter((row) => row.status === 'active').length} running</span>
            : rows.some((row) => row.status === 'failed') ? <span className="tm-run-activity__state">{rows.filter((row) => row.status === 'failed').length} unsuccessful</span> : null}
        </summary>
        <div className="tm-run-activity__list">{rows.map((row) => <ActivityRow key={row.key} row={row} compact />)}</div>
      </details> : <div className="tm-run-activity__list">{rows.map((row) => <ActivityRow key={row.key} row={row} compact={compact} />)}</div>}
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

function ActivityRow({ row, compact }: { row: OverviewActivityRow; compact: boolean }) {
  const expandable = row.grouped && row.children && row.children.length > 0;
  const [open, setOpen] = useState(Boolean(row.defaultOpen));
  const className = [
    'tm-run-activity__row',
    `tm-run-activity__row--${row.kind}`,
    row.status === 'active' ? 'tm-run-activity__row--active' : '',
    row.status === 'failed' && row.tone === 'error' ? 'tm-run-activity__row--failed' : ''
  ].filter(Boolean).join(' ');

  if (compact && !expandable && (row.execution || row.kind === 'command')) {
    const label = row.status === 'failed' ? row.label === 'Stopped' ? 'Stopped' : row.label === 'Unfinished' ? 'Unfinished' : 'Failed'
      : row.status === 'active' ? 'Running' : 'Ran';
    const hasDetails = Boolean(row.execution?.command || row.execution?.output || row.execution?.error);
    const heading = <><ActivityIcon icon={row.icon} /><span className="tm-run-activity__copy"><span>{label}</span>
      {row.detail ? <span className="tm-run-activity__detail" title={row.detail}>{row.detail}</span> : null}</span>
      </>;
    if (!hasDetails) return <div className={className}>{heading}</div>;
    return <details className={className}>
      <summary className="tm-run-activity__summary">{heading}<DisclosureChevron /></summary>
      <div className="tm-run-activity__execution">
        {row.execution?.command ? <pre>{row.execution.command}</pre> : null}
        {row.execution?.error ? <p className="tm-run-activity__error">{row.execution.error}</p> : null}
        {row.execution?.output ? <pre className="tm-run-activity__output-text">{row.execution.output}</pre> : null}
      </div>
    </details>;
  }

  if (expandable) {
    return (
      <details
        className={className}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="tm-run-activity__summary">
          <ActivityIcon icon={row.icon} />
          <ActivityCopy row={row} />
          <DisclosureChevron className="tm-run-activity__chevron" />
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
      {row.detail ? <span className={detailClass} title={row.detail}>{row.detail}</span> : null}
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
  const components: Partial<Record<OverviewActivityLeaf['icon'], LucideIcon>> = {
    edit: Pencil,
    error: CircleAlert,
    message: MessageSquareText,
    search: Search,
    terminal: SquareTerminal,
    tool: Wrench,
    wait: Clock3
  };
  const Component = components[icon] ?? FileText;
  return <Component absoluteStrokeWidth size={16} strokeWidth={1.5} />;
}
