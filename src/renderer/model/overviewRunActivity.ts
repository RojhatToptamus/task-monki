import type {
  RunActivityCategory,
  RunActivityRow,
  RunActivityStatus,
  RunActivityTone
} from './runActivity';

export type OverviewActivityKind =
  | 'prose'
  | 'command'
  | 'context'
  | 'file'
  | 'tool'
  | 'request';

export type OverviewActivityIcon =
  | 'message'
  | 'terminal'
  | 'file'
  | 'search'
  | 'edit'
  | 'tool'
  | 'wait'
  | 'error';

export type OverviewActivityDetailKind = 'text' | 'command' | 'path' | 'count';

export interface OverviewActivityLeaf {
  key: string;
  category: RunActivityCategory;
  kind: OverviewActivityKind;
  icon: OverviewActivityIcon;
  label: string;
  detail?: string;
  detailKind?: OverviewActivityDetailKind;
  metric?: string;
  tone: RunActivityTone;
  status: RunActivityStatus;
  at: string;
  sourceItemIds: string[];
  sourceInteractionIds: string[];
}

export interface OverviewActivityRow extends OverviewActivityLeaf {
  grouped?: boolean;
  defaultOpen?: boolean;
  children?: OverviewActivityLeaf[];
}

const COMMAND_CATEGORIES = new Set<RunActivityCategory>(['bash', 'verify', 'git']);
const CONTEXT_CATEGORIES = new Set<RunActivityCategory>(['read', 'search', 'list']);
const FILE_CATEGORIES = new Set<RunActivityCategory>(['edit', 'write', 'patch']);

export function buildOverviewRunActivityRows(rows: RunActivityRow[]): OverviewActivityRow[] {
  const formatted = rows
    .map(overviewRowFromRunActivity)
    .filter((row): row is OverviewActivityRow => Boolean(row));
  return groupCompletedCommands(formatted);
}

export function overviewActivitySummary(row: OverviewActivityLeaf): string {
  return [row.label, row.detail, row.metric].filter(Boolean).join(' ');
}

function overviewRowFromRunActivity(row: RunActivityRow): OverviewActivityRow | undefined {
  if (row.category === 'other' && row.label === 'Progress') {
    return overviewMessageRow(row);
  }
  if (COMMAND_CATEGORIES.has(row.category) || row.category === 'error') {
    return overviewCommandRow(row);
  }
  if (CONTEXT_CATEGORIES.has(row.category)) {
    return overviewContextRow(row);
  }
  if (FILE_CATEGORIES.has(row.category)) {
    return overviewFileRow(row);
  }
  if (row.category === 'permission' || row.category === 'question') {
    return copyRow(row, {
      kind: 'request',
      icon: 'wait',
      label: row.category === 'permission' ? 'Waiting' : 'Question',
      detail: row.detail,
      detailKind: 'text'
    });
  }
  return copyRow(row, {
    kind: 'tool',
    icon: toolIcon(row.category),
    label: row.label,
    detail: row.detail,
    detailKind: 'text'
  });
}

function overviewMessageRow(row: RunActivityRow): OverviewActivityRow | undefined {
  const text = row.detail?.trim();
  if (!text || !isUsefulProgressMessage(text)) {
    return undefined;
  }
  return copyRow(row, {
    kind: 'prose',
    icon: 'message',
    label: text,
    detail: undefined,
    detailKind: undefined
  });
}

function overviewCommandRow(row: RunActivityRow): OverviewActivityRow {
  const detail = commandDetail(row);
  if (row.status === 'active') {
    return copyRow(row, {
      kind: 'command',
      icon: 'terminal',
      label: 'Running',
      detail,
      detailKind: 'command',
      metric: undefined
    });
  }
  if (row.status === 'failed') {
    return copyRow(row, {
      kind: 'command',
      icon: 'error',
      label: 'Command failed',
      detail: detail === 'command failed' ? undefined : detail,
      detailKind: detail === 'command failed' ? undefined : 'command',
      metric: row.metric
    });
  }
  return copyRow(row, {
    kind: 'command',
    icon: 'terminal',
    label: 'Ran',
    detail,
    detailKind: 'command',
    metric: durationCopy(row.metric)
  });
}

function overviewContextRow(row: RunActivityRow): OverviewActivityRow {
  const active = row.status === 'active';
  const label = contextLabel(row.category, active, Boolean(row.grouped));
  return copyRow(row, {
    kind: 'context',
    icon: row.category === 'search' ? 'search' : 'file',
    label,
    detail: row.detail,
    detailKind: row.grouped ? 'count' : contextDetailKind(row.category),
    metric: row.metric,
    children: mapChildren(row)
  });
}

function overviewFileRow(row: RunActivityRow): OverviewActivityRow {
  return copyRow(row, {
    kind: 'file',
    icon: row.category === 'write' ? 'file' : 'edit',
    label: fileLabel(row),
    detail: row.detail,
    detailKind: 'path',
    metric: row.metric
  });
}

function copyRow(
  row: RunActivityRow,
  overrides: Pick<OverviewActivityRow, 'kind' | 'icon' | 'label'> &
    Partial<Pick<OverviewActivityRow, 'detail' | 'detailKind' | 'metric' | 'children'>>
): OverviewActivityRow {
  return {
    key: `overview:${row.key}`,
    category: row.category,
    kind: overrides.kind,
    icon: overrides.icon,
    label: overrides.label,
    detail: overrides.detail,
    detailKind: overrides.detailKind,
    metric: overrides.metric ?? row.metric,
    tone: row.tone,
    status: row.status,
    at: row.at,
    sourceItemIds: row.sourceItemIds,
    sourceInteractionIds: row.sourceInteractionIds,
    grouped: row.grouped,
    children: overrides.children
  };
}

function mapChildren(row: RunActivityRow): OverviewActivityLeaf[] | undefined {
  const children = row.children
    ?.map(overviewRowFromRunActivity)
    .filter((child): child is OverviewActivityRow => Boolean(child))
    .map(({ grouped: _grouped, defaultOpen: _defaultOpen, children: _children, ...child }) => child);
  return children && children.length > 0 ? children : undefined;
}

function groupCompletedCommands(rows: OverviewActivityRow[]): OverviewActivityRow[] {
  const grouped: OverviewActivityRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!isCompletedCommand(row)) {
      grouped.push(row);
      index += 1;
      continue;
    }

    const children = [toLeaf(row)];
    let next = index + 1;
    while (next < rows.length && isCompletedCommand(rows[next])) {
      children.push(toLeaf(rows[next]));
      next += 1;
    }

    grouped.push(children.length > 1 ? commandGroupRow(children) : row);
    index = next;
  }
  return grouped;
}

function isCompletedCommand(row: OverviewActivityRow): boolean {
  return row.kind === 'command' && row.status === 'completed';
}

function commandGroupRow(children: OverviewActivityLeaf[]): OverviewActivityRow {
  return {
    key: `overview:commands:${children[0].key}`,
    category: 'bash',
    kind: 'command',
    icon: 'terminal',
    label: 'Ran',
    detail: `${children.length} commands`,
    detailKind: 'count',
    tone: 'neutral',
    status: 'completed',
    at: children.at(-1)?.at ?? children[0].at,
    sourceItemIds: unique(children.flatMap((child) => child.sourceItemIds)),
    sourceInteractionIds: unique(children.flatMap((child) => child.sourceInteractionIds)),
    grouped: true,
    defaultOpen: true,
    children
  };
}

function toLeaf(row: OverviewActivityRow): OverviewActivityLeaf {
  const { grouped: _grouped, defaultOpen: _defaultOpen, children: _children, ...leaf } = row;
  return leaf;
}

function commandDetail(row: RunActivityRow): string {
  return row.detail?.trim() || 'command';
}

function durationCopy(metric: string | undefined): string | undefined {
  const duration = readableDuration(metric);
  return duration ? `for ${duration}` : undefined;
}

function readableDuration(metric: string | undefined): string | undefined {
  if (!metric) {
    return undefined;
  }
  const minutesMatch = /^(\d+):(\d{2})$/.exec(metric);
  if (minutesMatch) {
    const minutes = Number(minutesMatch[1]);
    const seconds = Number(minutesMatch[2]);
    if (minutes === 0) {
      return `${seconds}s`;
    }
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const msMatch = /^(\d+)\s*ms$/.exec(metric);
  if (msMatch) {
    return `${msMatch[1]}ms`;
  }
  if (/^\d+s$/.test(metric) || /^\d+m(?:\s+\d+s)?$/.test(metric)) {
    return metric;
  }
  return undefined;
}

function contextLabel(
  category: RunActivityCategory,
  active: boolean,
  grouped: boolean
): string {
  if (category === 'read') {
    return active && !grouped ? 'Reading' : 'Read';
  }
  if (category === 'search') {
    return active && !grouped ? 'Searching' : 'Searched';
  }
  return active && !grouped ? 'Listing' : 'Listed';
}

function contextDetailKind(category: RunActivityCategory): OverviewActivityDetailKind {
  return category === 'search' ? 'text' : 'path';
}

function fileLabel(row: RunActivityRow): string {
  const base = row.label.toLowerCase();
  const active = row.status === 'active';
  if (base === 'write') {
    return active ? 'Writing' : 'Wrote';
  }
  if (base === 'delete') {
    return active ? 'Deleting' : 'Deleted';
  }
  if (base === 'patch') {
    return active ? 'Patching' : 'Patched';
  }
  return active ? 'Editing' : 'Edited';
}

function toolIcon(category: RunActivityCategory): OverviewActivityIcon {
  if (category === 'web') {
    return 'search';
  }
  if (category === 'error') {
    return 'error';
  }
  return 'tool';
}

function isUsefulProgressMessage(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[.!?]+$/g, '').trim();
  if (!normalized) {
    return false;
  }
  return !new Set([
    'working',
    'working now',
    'continuing',
    'proceeding',
    'done',
    'ok',
    'okay'
  ]).has(normalized);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
