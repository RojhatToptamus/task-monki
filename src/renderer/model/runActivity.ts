import type {
  AgentItemRecord,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';

export type RunActivityCategory =
  | 'read'
  | 'search'
  | 'list'
  | 'edit'
  | 'write'
  | 'patch'
  | 'bash'
  | 'verify'
  | 'git'
  | 'web'
  | 'mcp'
  | 'subagent'
  | 'permission'
  | 'question'
  | 'compaction'
  | 'error'
  | 'other';

export type RunActivityStatus = 'active' | 'completed' | 'failed';
export type RunActivityTone = 'neutral' | 'success' | 'action' | 'error';

export interface RunActivityLeaf {
  key: string;
  category: RunActivityCategory;
  label: string;
  detail?: string;
  metric?: string;
  tone: RunActivityTone;
  status: RunActivityStatus;
  at: string;
  sourceItemIds: string[];
  sourceInteractionIds: string[];
}

export interface RunActivityRow extends RunActivityLeaf {
  grouped?: boolean;
  children?: RunActivityLeaf[];
}

export type RunActivitySectionKey =
  | 'files'
  | 'commands'
  | 'tools'
  | 'subagents'
  | 'requests';

export interface RunActivitySection {
  key: RunActivitySectionKey;
  title: string;
  rows: RunActivityRow[];
}

export interface RunActivityProjection {
  rows: RunActivityRow[];
  sections: RunActivitySection[];
  outputSummary?: string;
}

interface ActivityCandidate extends RunActivityLeaf {
  order: number;
}

const CONTEXT_CATEGORIES = new Set<RunActivityCategory>(['read', 'search', 'list']);
const WORKING_TEXT_LIMIT = 180;
const DETAIL_TEXT_LIMIT = 120;

export function buildRunActivityProjection(input: {
  run: Pick<RunRecord, 'id' | 'status' | 'startedAt' | 'lastEventAt'>;
  items: AgentItemRecord[];
  interactions?: InteractionRequestRecord[];
  includeWaiting?: boolean;
  groupContext?: boolean;
}): RunActivityProjection {
  const runItems = input.items.filter((item) => item.runId === input.run.id);
  const runInteractions = (input.interactions ?? []).filter(
    (interaction) => interaction.runId === input.run.id
  );
  let order = 0;
  const itemRows = runItems.flatMap((item) =>
    activityRowsFromItem(item).map((candidate) => ({ ...candidate, order: order++ }))
  );
  const requestRows = runInteractions.map((interaction) => ({
    ...activityRowFromInteraction(interaction),
    order: order++
  }));
  const waiting = input.includeWaiting === false
    ? undefined
    : waitingActivityRow(input.run, requestRows);
  const candidates = waiting ? [...itemRows, ...requestRows, { ...waiting, order: order++ }] : [...itemRows, ...requestRows];
  const rows = [...candidates]
    .sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order)
    .map(stripCandidateOrder);
  const groupedRows = input.groupContext === false ? rows : groupContextRows(rows);

  return {
    rows: groupedRows,
    sections: buildRunActivitySections(groupedRows),
    outputSummary: commandOutputSummary(runItems)
  };
}

export function buildRunActivitySections(rows: RunActivityRow[]): RunActivitySection[] {
  const sectionDefs: Array<{
    key: RunActivitySectionKey;
    title: string;
    categories: Set<RunActivityCategory>;
  }> = [
    {
      key: 'files',
      title: 'Files',
      categories: new Set(['read', 'search', 'list', 'edit', 'write', 'patch'])
    },
    {
      key: 'commands',
      title: 'Commands',
      categories: new Set(['bash', 'verify', 'git', 'error'])
    },
    {
      key: 'tools',
      title: 'Tools',
      categories: new Set(['web', 'mcp', 'compaction', 'other'])
    },
    {
      key: 'subagents',
      title: 'Subagents',
      categories: new Set(['subagent'])
    },
    {
      key: 'requests',
      title: 'Requests',
      categories: new Set(['permission', 'question'])
    }
  ];

  return sectionDefs
    .map((section) => ({
      key: section.key,
      title: section.title,
      rows: rows.filter((row) => section.categories.has(row.category))
    }))
    .filter((section) => section.rows.length > 0);
}

export function compactActivitySummary(row: RunActivityRow): string {
  const parts = [row.label, row.detail, row.metric].filter(Boolean);
  return parts.join(' ');
}

function stripCandidateOrder(candidate: ActivityCandidate): RunActivityRow {
  const { order: _order, ...row } = candidate;
  return row;
}

function activityRowsFromItem(item: AgentItemRecord): RunActivityLeaf[] {
  const payload = objectPayload(item.payload);
  const at = item.providerCompletedAt ?? item.providerStartedAt ?? item.updatedAt ?? item.createdAt;
  switch (item.type) {
    case 'AGENT_MESSAGE': {
      const text = stringValue(payload.text);
      const detail = text ? curateAgentMessage(text, item.status) : undefined;
      return detail
        ? [
            rowFromItem(item, {
              category: 'other',
              label: 'Progress',
              detail,
              tone: activityToneForStatus(activityStatusForItem(item.status), false),
              status: activityStatusForItem(item.status),
              at,
              suffix: `message:${normalizeKey(detail)}`
            })
          ]
        : [];
    }
    case 'COMMAND_EXECUTION':
      return commandActivityRows(item, payload, at);
    case 'FILE_CHANGE':
      return fileChangeActivityRows(item, payload, at);
    case 'MCP_TOOL_CALL':
      return [
        rowFromItem(item, {
          category: 'mcp',
          label: 'MCP',
          detail: compactToolName(payload) ?? 'tool call',
          tone: activityToneForStatus(activityStatusForItem(item.status), false),
          status: activityStatusForItem(item.status),
          at,
          suffix: `mcp:${normalizeKey(compactToolName(payload) ?? '')}`
        })
      ];
    case 'DYNAMIC_TOOL_CALL':
      return [
        rowFromItem(item, {
          category: 'mcp',
          label: 'Tool',
          detail: compactToolName(payload) ?? 'dynamic tool',
          tone: activityToneForStatus(activityStatusForItem(item.status), false),
          status: activityStatusForItem(item.status),
          at,
          suffix: `dynamic-tool:${normalizeKey(compactToolName(payload) ?? '')}`
        })
      ];
    case 'WEB_SEARCH':
      return [
        rowFromItem(item, {
          category: 'web',
          label: 'Web',
          detail: compactValue(stringValue(payload.query) ?? 'search', 72),
          tone: activityToneForStatus(activityStatusForItem(item.status), false),
          status: activityStatusForItem(item.status),
          at,
          suffix: `web:${normalizeKey(stringValue(payload.query) ?? '')}`
        })
      ];
    case 'CONTEXT_COMPACTION':
      return [
        rowFromItem(item, {
          category: 'compaction',
          label: 'Compact',
          detail: 'context',
          tone: activityToneForStatus(activityStatusForItem(item.status), false),
          status: activityStatusForItem(item.status),
          at,
          suffix: 'context-compaction'
        })
      ];
    case 'SUBAGENT':
      return [
        rowFromItem(item, {
          category: 'subagent',
          label: 'Subagent',
          detail: compactValue(
            stringValue(payload.tool) ??
              stringValue(payload.agentPath) ??
              stringValue(payload.kind) ??
              'delegated work',
            72
          ),
          tone: activityToneForStatus(activityStatusForItem(item.status), false),
          status: activityStatusForItem(item.status),
          at,
          suffix: `subagent:${normalizeKey(stringValue(payload.tool) ?? stringValue(payload.agentPath) ?? '')}`
        })
      ];
    case 'REVIEW':
      return [
        rowFromItem(item, {
          category: 'other',
          label: 'Review',
          detail: compactValue(stringValue(payload.type) ?? stringValue(payload.review) ?? 'provider review', 72),
          tone: activityToneForStatus(activityStatusForItem(item.status), false),
          status: activityStatusForItem(item.status),
          at,
          suffix: 'review'
        })
      ];
    case 'PLAN':
    case 'REASONING_SUMMARY':
    case 'USER_MESSAGE':
    case 'OTHER':
    default:
      return [];
  }
}

function commandActivityRows(
  item: AgentItemRecord,
  payload: Record<string, unknown>,
  at: string
): RunActivityLeaf[] {
  const commandStatus = commandActivityStatus(payload, item.status);
  const actions = Array.isArray(payload.commandActions) ? payload.commandActions : [];
  const structured = actions.flatMap((action, index) =>
    commandActionActivityRows(action, item, payload, commandStatus, at, index)
  );
  const fallback = commandFallbackActivityRow(item, payload, commandStatus, at);

  if (!fallback) {
    return structured;
  }
  if (
    structured.length === 0 ||
    fallback.category === 'verify' ||
    fallback.category === 'git' ||
    fallback.status === 'failed'
  ) {
    return [...structured, fallback];
  }
  return structured;
}

function commandActionActivityRows(
  value: unknown,
  item: AgentItemRecord,
  payload: Record<string, unknown>,
  status: RunActivityStatus,
  at: string,
  index: number
): RunActivityLeaf[] {
  const action = objectPayload(value);
  const type = stringValue(action.type);
  const command = stringValue(action.command) ?? stringValue(payload.command);
  const cwd = stringValue(payload.cwd) ?? stringValue(action.cwd);
  if (type === 'read') {
    const path = stringValue(action.path) ?? extractPath(command ?? '');
    const detail = shortPath(path, cwd) ?? compactValue(stringValue(action.name) ?? 'file', 72);
    return [
      rowFromItem(item, {
        category: 'read',
        label: 'Read',
        detail,
        metric: status === 'completed' ? lineCountMetric(stringValue(payload.aggregatedOutput)) : undefined,
        tone: activityToneForStatus(status, false),
        status,
        at,
        suffix: `action:${index}:read:${normalizeKey(detail ?? '')}`
      })
    ];
  }
  if (type === 'listFiles') {
    const detail = shortPath(stringValue(action.path), cwd) ?? 'project files';
    return [
      rowFromItem(item, {
        category: 'list',
        label: 'List',
        detail,
        tone: activityToneForStatus(status, false),
        status,
        at,
        suffix: `action:${index}:list:${normalizeKey(detail)}`
      })
    ];
  }
  if (type === 'search') {
    const detail = searchActivityDetail(
      stringValue(action.query),
      stringValue(action.path),
      cwd
    );
    return [
      rowFromItem(item, {
        category: 'search',
        label: 'Search',
        detail,
        tone: activityToneForStatus(status, false),
        status,
        at,
        suffix: `action:${index}:search:${normalizeKey(detail ?? '')}`
      })
    ];
  }
  return [];
}

function commandFallbackActivityRow(
  item: AgentItemRecord,
  payload: Record<string, unknown>,
  status: RunActivityStatus,
  at: string
): RunActivityLeaf | undefined {
  const command = stringValue(payload.command);
  const visibleCommand = command ? unwrapShellCommand(command) : undefined;
  const lower = (visibleCommand ?? '').toLowerCase();
  const failed = status === 'failed';
  const active = status === 'active';
  const commandLabel = visibleCommand ? compactCommandLabel(visibleCommand) : undefined;
  const commandMetric = commandActivityMetric(payload, status);

  if (looksLikeVerificationCommand(lower)) {
    return rowFromItem(item, {
      category: 'verify',
      label: 'Verify',
      detail: commandLabel ?? (failed ? 'verification failed' : 'verification command'),
      metric: commandMetric,
      tone: activityToneForStatus(status, status === 'completed'),
      status,
      at,
      suffix: `command:verify:${normalizeKey(commandLabel ?? '')}`
    });
  }
  if (looksLikeGitCommand(lower)) {
    const detail = commandLabel ?? gitCommandDetail(visibleCommand) ?? 'local state';
    return rowFromItem(item, {
      category: 'git',
      label: 'Git',
      detail,
      metric: commandMetric,
      tone: activityToneForStatus(status, false),
      status,
      at,
      suffix: `command:git:${normalizeKey(detail)}`
    });
  }
  if (looksLikeReadCommand(lower)) {
    if (!active && !failed) {
      return undefined;
    }
    return rowFromItem(item, {
      category: 'read',
      label: 'Read',
      detail: failed ? 'context failed' : 'project context',
      tone: activityToneForStatus(status, false),
      status,
      at,
      suffix: `command:read-context:${status}`
    });
  }
  if (active || failed) {
    return rowFromItem(item, {
      category: failed ? 'error' : 'bash',
      label: 'Bash',
      detail: commandLabel ?? (failed ? 'command failed' : 'running command'),
      metric: commandMetric,
      tone: activityToneForStatus(status, false),
      status,
      at,
      suffix: `command:generic:${status}`
    });
  }
  return undefined;
}

function fileChangeActivityRows(
  item: AgentItemRecord,
  payload: Record<string, unknown>,
  at: string
): RunActivityLeaf[] {
  const status = activityStatusForItem(item.status);
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  if (changes.length === 0) {
    return [
      rowFromItem(item, {
        category: status === 'failed' ? 'error' : 'patch',
        label: 'Patch',
        detail: status === 'failed' ? 'file change failed' : 'files',
        tone: activityToneForStatus(status, false),
        status,
        at,
        suffix: `file-change:${status}`
      })
    ];
  }
  return changes.map((change, index) => {
    const value = objectPayload(change);
    const kind = fileChangeKind(value);
    const path = shortPath(stringValue(value.path)) ?? 'file';
    const label = fileChangeLabel(kind);
    return rowFromItem(item, {
      category: fileChangeCategory(kind),
      label,
      detail: path,
      metric: fileChangeMetric(stringValue(value.diff), kind),
      tone: activityToneForStatus(status, false),
      status,
      at,
      suffix: `file-change:${index}:${normalizeKey(label)}:${normalizeKey(path)}`
    });
  });
}

function activityRowFromInteraction(interaction: InteractionRequestRecord): RunActivityLeaf {
  const status = activityStatusForInteraction(interaction.status);
  const category = interactionCategory(interaction.type);
  return {
    key: `interaction:${interaction.id}`,
    category,
    label: category === 'permission' ? 'Permission' : 'Question',
    detail: interactionDetail(interaction),
    tone: activityToneForStatus(status, false),
    status,
    at: interaction.resolvedAt ?? interaction.respondedAt ?? interaction.requestedAt,
    sourceItemIds: [],
    sourceInteractionIds: [interaction.id]
  };
}

function waitingActivityRow(
  run: Pick<RunRecord, 'id' | 'status' | 'startedAt' | 'lastEventAt'>,
  requestRows: ActivityCandidate[]
): RunActivityLeaf | undefined {
  const at = run.lastEventAt ?? run.startedAt;
  if (run.status === 'AWAITING_APPROVAL') {
    if (requestRows.some((row) => row.category === 'permission' && row.status === 'active')) {
      return undefined;
    }
    return {
      key: `run-waiting:${run.id}:permission`,
      category: 'permission',
      label: 'Waiting',
      detail: 'for approval',
      tone: 'action',
      status: 'active',
      at,
      sourceItemIds: [],
      sourceInteractionIds: []
    };
  }
  if (run.status === 'AWAITING_USER_INPUT') {
    if (requestRows.some((row) => row.category === 'question' && row.status === 'active')) {
      return undefined;
    }
    return {
      key: `run-waiting:${run.id}:question`,
      category: 'question',
      label: 'Waiting',
      detail: 'for user input',
      tone: 'action',
      status: 'active',
      at,
      sourceItemIds: [],
      sourceInteractionIds: []
    };
  }
  return undefined;
}

function rowFromItem(
  item: AgentItemRecord,
  input: Omit<RunActivityLeaf, 'key' | 'sourceItemIds' | 'sourceInteractionIds'> & {
    suffix: string;
  }
): RunActivityLeaf {
  const { suffix, ...row } = input;
  return {
    ...row,
    key: `item:${item.id}:${suffix}`,
    sourceItemIds: [item.id],
    sourceInteractionIds: []
  };
}

function groupContextRows(rows: RunActivityRow[]): RunActivityRow[] {
  const grouped: RunActivityRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!CONTEXT_CATEGORIES.has(row.category)) {
      grouped.push(row);
      index += 1;
      continue;
    }

    const children = [row];
    let next = index + 1;
    while (
      next < rows.length &&
      rows[next].category === row.category &&
      CONTEXT_CATEGORIES.has(rows[next].category)
    ) {
      children.push(rows[next]);
      next += 1;
    }

    grouped.push(children.length > 1 ? contextGroupRow(row.category, children) : row);
    index = next;
  }
  return grouped;
}

function contextGroupRow(
  category: RunActivityCategory,
  children: RunActivityRow[]
): RunActivityRow {
  const count = children.length;
  const status = children.some((child) => child.status === 'failed')
    ? 'failed'
    : children.some((child) => child.status === 'active')
      ? 'active'
      : 'completed';
  const sourceItemIds = unique(children.flatMap((child) => child.sourceItemIds));
  const sourceInteractionIds = unique(
    children.flatMap((child) => child.sourceInteractionIds)
  );
  return {
    key: `context:${category}:${children[0].key}`,
    category,
    ...contextGroupCopy(category, count),
    tone: activityToneForStatus(status, false),
    status,
    at: children.at(-1)?.at ?? children[0].at,
    sourceItemIds,
    sourceInteractionIds,
    grouped: true,
    children: children.map((child) => ({
      key: child.key,
      category: child.category,
      label: child.label,
      detail: child.detail,
      metric: child.metric,
      tone: child.tone,
      status: child.status,
      at: child.at,
      sourceItemIds: child.sourceItemIds,
      sourceInteractionIds: child.sourceInteractionIds
    }))
  };
}

function contextGroupCopy(
  category: RunActivityCategory,
  count: number
): Pick<RunActivityRow, 'label' | 'detail'> {
  if (category === 'read') {
    return { label: 'Read', detail: `${count} ${plural(count, 'file')}` };
  }
  if (category === 'search') {
    return { label: 'Searched', detail: `${count} ${plural(count, 'time')}` };
  }
  return {
    label: 'Listed',
    detail: count === 1 ? '1 directory' : `${count} directories`
  };
}

function activityStatusForItem(status: AgentItemRecord['status']): RunActivityStatus {
  if (status === 'COMPLETED') {
    return 'completed';
  }
  if (status === 'FAILED' || status === 'DECLINED' || status === 'INTERRUPTED') {
    return 'failed';
  }
  return 'active';
}

function activityStatusForInteraction(
  status: InteractionRequestRecord['status']
): RunActivityStatus {
  if (status === 'RESOLVED') {
    return 'completed';
  }
  if (status === 'PENDING' || status === 'RESPONDING') {
    return 'active';
  }
  return 'failed';
}

function interactionCategory(
  type: InteractionRequestRecord['type']
): Extract<RunActivityCategory, 'permission' | 'question'> {
  if (
    type === 'COMMAND_APPROVAL' ||
    type === 'FILE_CHANGE_APPROVAL' ||
    type === 'PERMISSION_APPROVAL'
  ) {
    return 'permission';
  }
  return 'question';
}

function interactionDetail(interaction: InteractionRequestRecord): string {
  const request = objectPayload(interaction.request);
  switch (interaction.type) {
    case 'COMMAND_APPROVAL':
      return 'command approval';
    case 'FILE_CHANGE_APPROVAL':
      return 'file change approval';
    case 'PERMISSION_APPROVAL':
      return 'permission request';
    case 'MCP_ELICITATION':
      return compactValue(
        stringValue(request.serverName) ?? stringValue(request.message) ?? 'MCP request',
        72
      );
    case 'USER_INPUT': {
      const questions = Array.isArray(request.questions) ? request.questions : [];
      const first = objectPayload(questions[0]);
      return compactValue(
        stringValue(first.header) ?? stringValue(first.question) ?? 'user input',
        72
      );
    }
    case 'DYNAMIC_TOOL':
      return compactValue(stringValue(request.tool) ?? 'dynamic tool', 72);
    default:
      return 'request';
  }
}

function commandActivityStatus(
  payload: Record<string, unknown>,
  itemStatus: AgentItemRecord['status']
): RunActivityStatus {
  const exitCode = numberValue(payload.exitCode);
  if (itemStatus === 'COMPLETED' && exitCode !== undefined && exitCode !== 0) {
    return 'failed';
  }
  return activityStatusForItem(itemStatus);
}

function activityToneForStatus(
  status: RunActivityStatus,
  verified: boolean
): RunActivityTone {
  if (status === 'failed') {
    return 'error';
  }
  if (status === 'active') {
    return 'action';
  }
  return verified ? 'success' : 'neutral';
}

function searchActivityDetail(
  query: string | undefined,
  path: string | undefined,
  cwd?: string
): string {
  const compactQuery = query ? compactValue(query, 56) : undefined;
  const compactPath = shortPath(path, cwd);
  if (compactQuery && compactPath) {
    return `${compactQuery} · ${compactPath}`;
  }
  return compactQuery ?? compactPath ?? 'project';
}

function compactToolName(payload: Record<string, unknown>): string | undefined {
  const tool = stringValue(payload.tool) ?? stringValue(payload.name);
  const namespace = stringValue(payload.namespace);
  const server = stringValue(payload.server);
  const parts = [server, namespace, tool].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? compactValue(parts.join('/'), 72) : undefined;
}

function compactCommandLabel(command: string): string {
  return compactValue(command, 82);
}

function unwrapShellCommand(command: string): string {
  const normalized = normalizeLabel(command);
  const quoted = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/.exec(normalized);
  if (quoted) {
    return quoted[2].replace(/\\(["'])/g, '$1');
  }
  const unquoted = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(.+)$/.exec(normalized);
  return unquoted ? unquoted[1] : normalized;
}

function compactValue(value: string, maxLength: number): string {
  return truncateText(cleanOverviewText(value), maxLength);
}

function gitCommandDetail(command: string | undefined): string | undefined {
  const match = /\bgit\s+([a-z-]+)/i.exec(command ?? '');
  const action = match?.[1];
  if (!action) {
    return undefined;
  }
  if (action === 'rev-parse') {
    return 'resolve ref';
  }
  return action;
}

function commandActivityMetric(
  payload: Record<string, unknown>,
  status: RunActivityStatus
): string | undefined {
  const exitCode = numberValue(payload.exitCode);
  if (status === 'failed' && exitCode !== undefined && exitCode !== 0) {
    return `exit ${exitCode}`;
  }
  return durationMetric(numberValue(payload.durationMs));
}

function commandOutputSummary(items: AgentItemRecord[]): string | undefined {
  const lineCount = items
    .filter((item) => item.type === 'COMMAND_EXECUTION')
    .reduce((total, item) => {
      const output = stringValue(objectPayload(item.payload).aggregatedOutput);
      return total + outputLineCount(output);
    }, 0);
  return lineCount > 0
    ? `show full output · ${lineCount} ${plural(lineCount, 'line')}`
    : undefined;
}

function lineCountMetric(output: string | undefined): string | undefined {
  const lineCount = outputLineCount(output);
  return lineCount > 0 ? `${lineCount} ${plural(lineCount, 'line')}` : undefined;
}

function outputLineCount(output: string | undefined): number {
  const normalized = output?.replace(/\r\n/g, '\n').replace(/\n$/, '') ?? '';
  return normalized ? normalized.split('\n').length : 0;
}

function durationMetric(value: number | undefined): string | undefined {
  if (value === undefined || value < 0) {
    return undefined;
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function fileChangeKind(change: Record<string, unknown>): string {
  const raw = change.kind;
  if (typeof raw === 'string') {
    return raw;
  }
  return stringValue(objectPayload(raw).type) ?? 'update';
}

function fileChangeLabel(kind: string): string {
  if (kind === 'add' || kind === 'create' || kind === 'write') {
    return 'Write';
  }
  if (kind === 'delete' || kind === 'remove') {
    return 'Delete';
  }
  if (kind === 'patch' || kind === 'move' || kind === 'rename') {
    return 'Patch';
  }
  return 'Edit';
}

function fileChangeCategory(kind: string): RunActivityCategory {
  if (kind === 'add' || kind === 'create' || kind === 'write') {
    return 'write';
  }
  if (kind === 'patch' || kind === 'move' || kind === 'rename') {
    return 'patch';
  }
  return 'edit';
}

function fileChangeMetric(diff: string | undefined, kind: string): string | undefined {
  const stat = diffStat(diff);
  if (!stat) {
    return undefined;
  }
  if (kind === 'add' || kind === 'create' || kind === 'write') {
    return stat.added > 0 ? `+${stat.added}` : undefined;
  }
  if (kind === 'delete' || kind === 'remove') {
    return stat.removed > 0 ? `-${stat.removed}` : undefined;
  }
  const parts = [];
  if (stat.added > 0) {
    parts.push(`+${stat.added}`);
  }
  if (stat.removed > 0) {
    parts.push(`-${stat.removed}`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function diffStat(diff: string | undefined): { added: number; removed: number } | undefined {
  if (!diff) {
    return undefined;
  }
  let added = 0;
  let removed = 0;
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    }
  }
  return added > 0 || removed > 0 ? { added, removed } : undefined;
}

function looksLikeVerificationCommand(command: string): boolean {
  return /\b(test|vitest|jest|pytest|typecheck|tsc|eslint|lint|build|check:codex-protocol|diff --check|prettier --check|cargo test|scarb test)\b/.test(
    command
  );
}

function looksLikeGitCommand(command: string): boolean {
  return /\bgit\s+(status|diff|show|log|rev-parse|branch)\b/.test(command);
}

function looksLikeReadCommand(command: string): boolean {
  return /\b(rg|grep|sed|cat|ls|find|wc|tree|nl)\b/.test(command);
}

function curateAgentMessage(
  text: string,
  status: AgentItemRecord['status']
): string | undefined {
  const cleaned = cleanOverviewText(text).replace(/^progress:\s*/i, '');
  if (!cleaned) {
    return undefined;
  }
  if (looksLikeOverviewNoise(cleaned)) {
    return undefined;
  }
  const readable = readableOverviewSentence(cleaned, WORKING_TEXT_LIMIT);
  if (readable) {
    return readable;
  }

  const lower = cleaned.toLowerCase();
  const path = shortPath(extractPath(cleaned));
  if (/\b(edit(?:ed|ing)?|updat(?:e|ed|ing)?|wir(?:e|ed|ing)?|implement(?:ed|ing)?|add(?:ed|ing)?|fix(?:ed|ing)?|writ(?:e|ing|ten)?|chang(?:e|ed|ing))\b/.test(lower)) {
    return path ? `Editing ${path}.` : 'Editing files.';
  }
  if (/\b(read(?:ing)?|inspect(?:ed|ing)?|trace(?:d|ing)?|confirm(?:ed|ing)?|check(?:ed|ing)?|discover(?:ed|ing)?|review(?:ed|ing)?)\b/.test(lower)) {
    return path ? `Reading ${path}.` : 'Reading project context.';
  }
  if (/\b(summar|final)\b/.test(lower)) {
    return 'Summarizing changes.';
  }
  if (/\b(verif|test|typecheck|build|check)\b/.test(lower)) {
    return status === 'COMPLETED' ? 'Verification finished.' : 'Running verification.';
  }
  return truncateAtWord(cleaned, DETAIL_TEXT_LIMIT);
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeLabel(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

function normalizeKey(text: string): string {
  return normalizeLabel(text).toLowerCase();
}

function cleanOverviewText(text: string | undefined): string {
  return normalizeLabel(text ?? '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)(\/[^\s'")]+(?:\/[^\s'")]+){2,})/g, (_match, prefix: string, value: string) => {
      return `${prefix}${shortPath(value, undefined, true) ?? value}`;
    });
}

function looksLikeOverviewNoise(text: string): boolean {
  return /(?:\/bin\/(?:zsh|bash|sh)|\s-lc\s|turn\/[a-z-]+|item\/[a-z-]+|jsonrpc|protocol message|provideritemid)/i.test(
    text
  );
}

function readableOverviewSentence(text: string, maxLength: number): string | undefined {
  const normalized = normalizeLabel(text);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return ensureSentencePunctuation(normalized);
  }
  const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
  if (sentences.length > 0) {
    const joined: string[] = [];
    for (const sentence of sentences) {
      const next = [...joined, sentence.trim()].join(' ');
      if (next.length > maxLength) {
        break;
      }
      joined.push(sentence.trim());
      if (joined.length >= 2) {
        break;
      }
    }
    const candidate = joined.join(' ').trim();
    if (candidate.length >= 24) {
      return ensureSentencePunctuation(candidate);
    }
  }
  return undefined;
}

function extractPath(text: string): string | undefined {
  return text.match(/(?:^|\s)([./~\w-]+(?:\/[\w.-]+)+)(?=$|\s|[.,;:)])/u)?.[1];
}

function shortPath(
  path: string | undefined,
  cwd?: string,
  allowAnchoredAbsolute = false
): string | undefined {
  if (!path) {
    return undefined;
  }
  const cleaned = path.replace(/^[`'"]+|[`'".,;:]+$/g, '');
  const normalized = cleaned.replace(/\\/g, '/');
  if (portableAbsolutePath(normalized)) {
    const relative = cwd
      ? relativePortablePath(cwd.replace(/\\/g, '/'), normalized)
      : undefined;
    if (relative) return relative;
    if (allowAnchoredAbsolute) {
      const anchored = anchoredRelativePath(normalized);
      if (anchored) return anchored;
    }
    return compactAbsolutePath(normalized);
  }
  return compactRelativePath(normalized);
}

function compactRelativePath(normalized: string): string | undefined {
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }
  const anchored = anchoredRelativePath(normalized);
  if (anchored) return anchored;
  return segments.length <= 5 ? segments.join('/') : segments.slice(-5).join('/');
}

function anchoredRelativePath(normalized: string): string | undefined {
  const segments = normalized.split('/').filter(Boolean);
  const anchor = ['src', 'tests', 'test', 'docs', 'scripts'].find((candidate) =>
    segments.includes(candidate)
  );
  if (anchor) {
    const index = segments.indexOf(anchor);
    const anchored = segments.slice(index);
    return anchored.length <= 5 ? anchored.join('/') : anchored.slice(-5).join('/');
  }
  const repoIndex = segments.lastIndexOf('repo');
  if (repoIndex >= 0 && repoIndex < segments.length - 1) {
    const repoRelative = segments.slice(repoIndex + 1);
    return repoRelative.length <= 5 ? repoRelative.join('/') : repoRelative.slice(-5).join('/');
  }
  return undefined;
}

function portableAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:\/|\/)/u.test(value);
}

function relativePortablePath(
  basePath: string,
  candidatePath: string
): string | undefined {
  if (!portableAbsolutePath(basePath) || !portableAbsolutePath(candidatePath)) {
    return undefined;
  }
  const windowsStyle =
    /^[A-Za-z]:\//u.test(candidatePath) || candidatePath.startsWith('//');
  const baseWindowsStyle = /^[A-Za-z]:\//u.test(basePath) || basePath.startsWith('//');
  if (windowsStyle !== baseWindowsStyle) return undefined;

  const baseSegments = portablePathSegments(basePath);
  const candidateSegments = portablePathSegments(candidatePath);
  if (candidateSegments.length <= baseSegments.length) return undefined;
  const equal = windowsStyle
    ? (left: string, right: string) =>
        left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : (left: string, right: string) => left === right;
  if (
    !baseSegments.every((segment, index) =>
      equal(segment, candidateSegments[index] ?? '')
    )
  ) {
    return undefined;
  }
  return compactRelativePath(candidateSegments.slice(baseSegments.length).join('/'));
}

function portablePathSegments(value: string): string[] {
  const output: string[] = [];
  for (const segment of value.split('/').filter(Boolean)) {
    if (segment === '.') continue;
    if (segment === '..') {
      output.pop();
      continue;
    }
    output.push(segment);
  }
  return output;
}

function compactAbsolutePath(value: string): string {
  const segments = portablePathSegments(value);
  if (segments.length <= 4) return value;
  if (/^[A-Za-z]:\//u.test(value)) {
    return `${segments[0]}/…/${segments.slice(-3).join('/')}`;
  }
  if (value.startsWith('//')) {
    return `//${segments.slice(0, 2).join('/')}/…/${segments.slice(-3).join('/')}`;
  }
  return `/…/${segments.slice(-3).join('/')}`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function ensureSentencePunctuation(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function truncateAtWord(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return ensureSentencePunctuation(normalized);
  }
  const sliced = normalized.slice(0, Math.max(0, maxLength - 1));
  const boundary = sliced.lastIndexOf(' ');
  const clipped = (boundary > 40 ? sliced.slice(0, boundary) : sliced).trimEnd();
  return `${clipped}...`;
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}
