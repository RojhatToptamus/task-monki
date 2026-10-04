import type { AgentItemRecord, AgentPlanRevisionRecord, RunRecord, TaskInstruction, InteractionRequestRecord } from '../../shared/contracts';
import { buildRunActivityProjection } from './runActivity';
import { buildOverviewRunActivityRows, type OverviewActivityRow } from './overviewRunActivity';

export type SessionStep =
  | { key: string; at: string; kind: 'tool'; row: OverviewActivityRow }
  | { key: string; at: string; kind: 'reasoning'; text: string; seconds?: number; active: boolean };

export type SessionEntry =
  | { key: string; at: string; kind: 'message'; author: 'You' | 'Agent'; text: string; status?: string }
  | { key: string; at: string; kind: 'steps'; steps: SessionStep[] }
  | { key: string; at: string; kind: 'interaction'; interaction: InteractionRequestRecord }
  | { key: string; at: string; kind: 'plan'; plan: AgentPlanRevisionRecord };

export type SessionTurnState = 'active' | 'completed' | 'stopped' | 'failed' | 'interrupted';

export type SessionTurnOpener =
  | { kind: 'prompt'; key: string; text: string; at: string }
  | { kind: 'marker'; key: string; label: string; at: string };

export interface SessionTurn {
  key: string;
  run: RunRecord;
  opener?: SessionTurnOpener;
  entries: SessionEntry[];
  state: SessionTurnState;
  durationMs?: number;
  answer?: string;
}

const ACTIVE_RUN_STATUSES = new Set<RunRecord['status']>(['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING']);

export function isActiveRunStatus(status: RunRecord['status']): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

/**
 * One run is one turn: the message that started it, then the agent's messages,
 * plans and tool steps in the order they were observed. Provider user-message
 * echoes contain generated prompts; authored text has its own owner.
 */
export function sessionTurn(run: RunRecord, items: AgentItemRecord[], instructions: TaskInstruction[], options: {
  prompt?: string; cwd?: string; plans?: AgentPlanRevisionRecord[]; interactions?: InteractionRequestRecord[];
} = {}): SessionTurn {
  const runInstructions = instructions.filter((item) => item.runId === run.id);
  const authored = runInstructions.find((item) => item.mode !== 'STEER');
  const opener: SessionTurnOpener | undefined = authored
    ? { kind: 'prompt', key: authored.id, text: authored.text, at: run.startedAt }
    : options.prompt !== undefined ? { kind: 'prompt', key: `${run.id}:prompt`, text: options.prompt, at: run.startedAt }
    : run.mode === 'RETRY' ? { kind: 'marker', key: `${run.id}:marker`, label: 'Retried', at: run.startedAt }
    : run.mode === 'FOLLOW_UP' ? { kind: 'marker', key: `${run.id}:marker`, label: 'Continued', at: run.startedAt }
    : undefined;
  // A review is a detached gate; its findings belong to the review surface.
  const entries = run.mode === 'REVIEW' ? []
    : sessionEntries(run, items, runInstructions.filter((item) => item.mode === 'STEER'), options.cwd, options.plans, options.interactions);
  const state = turnState(run);
  const end = run.endedAt ?? (state === 'active' ? undefined : run.lastEventAt);
  const durationMs = end ? Date.parse(end) - Date.parse(run.startedAt) : undefined;
  const answer = state === 'completed'
    ? [...entries].reverse().find((entry) => entry.kind === 'message' && entry.author === 'Agent')
    : undefined;
  return { key: run.id, run, opener, entries, state,
    durationMs: durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined,
    answer: answer?.kind === 'message' ? answer.text : undefined };
}

export function sessionEntries(run: RunRecord, items: AgentItemRecord[], steers: TaskInstruction[], cwd?: string, plans: AgentPlanRevisionRecord[] = [], interactions: InteractionRequestRecord[] = []): SessionEntry[] {
  const questions = interactions.filter((interaction) => interaction.runId === run.id && interaction.type === 'USER_INPUT');
  const questionItemIds = new Set(questions.flatMap((interaction) => interaction.providerItemId ? [interaction.providerItemId] : []));
  const runItems = items.filter((item) => item.runId === run.id && !questionItemIds.has(item.providerItemId));
  const live = isActiveRunStatus(run.status);
  const entries: Array<SessionEntry | SessionStep> = steers.map((item) => ({
    key: item.id, at: item.createdAt, kind: 'message', author: 'You', text: item.text,
    status: ({ SENDING: 'Sending now…', SUBMITTED: undefined, FAILED: 'Not delivered', UNCERTAIN: 'Delivery uncertain', QUEUED: 'Queued', HELD: 'Held' } as const)[item.status]
  }));
  for (const interaction of questions) {
    if (interaction.status === 'PENDING' || interaction.status === 'RESPONDING') continue;
    entries.push({ key: interaction.id, at: interaction.respondedAt ?? interaction.requestedAt, kind: 'interaction', interaction });
  }
  for (const item of runItems) {
    if (item.type === 'REASONING_SUMMARY') {
      const payload = item.payload as { summary?: unknown; text?: unknown } | null;
      const text = typeof payload?.text === 'string' ? payload.text
        : Array.isArray(payload?.summary) ? payload.summary.filter((part) => typeof part === 'string').join('\n\n') : '';
      if (text.trim()) entries.push({ key: item.id, at: item.createdAt, kind: 'reasoning', text,
        active: live && item.status !== 'COMPLETED', seconds: reasoningSeconds(item) });
    }
    if (item.type !== 'AGENT_MESSAGE') continue;
    const payload = item.payload as { text?: unknown } | null;
    if (typeof payload?.text !== 'string' || !payload.text.trim()) continue;
    entries.push({ key: item.id, at: item.createdAt, kind: 'message', author: 'Agent', text: payload.text });
  }
  // The final-message projection is a fallback when the provider did not emit a message item.
  if (run.finalMessage?.trim() && !entries.some((entry) => entry.kind === 'message' && entry.author === 'Agent' && entry.text.trim() === run.finalMessage!.trim())) {
    entries.push({ key: `${run.id}:final`, at: run.endedAt ?? run.lastEventAt ?? run.startedAt,
      kind: 'message', author: 'Agent', text: run.finalMessage });
  }
  const activity = buildRunActivityProjection({ run,
    items: runItems.filter((item) => item.type !== 'AGENT_MESSAGE' && item.type !== 'REASONING_SUMMARY'), groupContext: false, cwd }).rows.flatMap((row) => buildOverviewRunActivityRows([row]));
  if (!live) {
    // A terminal run cannot leave a step looking active; the provider record is unchanged.
    for (const row of activity) for (const leaf of [row, ...(row.children ?? [])]) {
      if (leaf.status === 'active') {
        leaf.status = 'failed';
        leaf.tone = run.status === 'INTERRUPTED' ? 'neutral' : 'error';
        leaf.label = run.status === 'INTERRUPTED' ? 'Stopped' : 'Unfinished';
      }
    }
  }
  const itemTimes = new Map(runItems.map((item) => [item.id, item.createdAt]));
  for (const row of activity) entries.push({ key: row.key, at: itemTimes.get(row.sourceItemIds[0]) ?? row.at, kind: 'tool', row });
  const revisions = plans.filter((plan) => plan.runId === run.id).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  if (revisions.at(-1)?.steps.length) entries.push({ key: `${run.id}:plan`, at: revisions[0].observedAt, kind: 'plan', plan: revisions.at(-1)! });
  entries.sort((a, b) => a.at.localeCompare(b.at));
  const grouped: SessionEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'tool' && entry.kind !== 'reasoning') { grouped.push(entry); continue; }
    const previous = grouped.at(-1);
    if (previous?.kind === 'steps') previous.steps.push(entry);
    else grouped.push({ key: `steps:${entry.key}`, at: entry.at, kind: 'steps', steps: [entry] });
  }
  return grouped;
}

export const HISTORY_PAGE = 80;

/** The loaded history: whole turns from `first`, minus `clip` leading entries of that turn. */
export interface HistoryWindow { first: number; clip: number }

/**
 * Reveals about one page of earlier blocks, finishing a clipped turn before
 * reaching into the one before it. A turn's opener and outcome count as blocks,
 * and an outcome is never shown without at least the turn's last entry.
 */
export function earlierHistory(turns: SessionTurn[], window: HistoryWindow, page = HISTORY_PAGE): HistoryWindow {
  let { first, clip } = window;
  let budget = page;
  while (budget > 0) {
    if (clip > 0) {
      const shown = Math.min(clip, budget);
      clip -= shown;
      budget -= shown;
      continue;
    }
    if (first === 0) break;
    first -= 1;
    budget -= 2;
    clip = turns[first]!.entries.length;
  }
  return { first, clip: clampClip(turns[first], clip) };
}

export function clampClip(turn: SessionTurn | undefined, clip: number): number {
  return Math.max(0, Math.min(clip, (turn?.entries.length ?? 0) - 1));
}

/** Names what a group of steps did, by kind, in the order the kinds first appeared. */
export function stepsSummary(steps: SessionStep[]): string {
  const counts = new Map<string, Set<string> | number>();
  const add = (kind: string, id?: string) => {
    if (id === undefined) counts.set(kind, ((counts.get(kind) as number | undefined) ?? 0) + 1);
    else counts.set(kind, ((counts.get(kind) as Set<string> | undefined) ?? new Set<string>()).add(id));
  };
  for (const step of steps) {
    if (step.kind === 'reasoning') { add('reasoning'); continue; }
    const { row } = step;
    if (row.kind === 'context') add(row.category);
    else if (row.kind === 'file') add('file', row.detail ?? row.key);
    else if (row.kind === 'command') add('command');
    else if (row.kind === 'request') add(row.category);
    else add('tool');
  }
  const size = (value: Set<string> | number) => typeof value === 'number' ? value : value.size;
  const phrases = [...counts].filter(([kind]) => kind !== 'reasoning' || counts.size === 1).map(([kind, value]) => {
    const count = size(value);
    switch (kind) {
      case 'read': return `read ${count} ${plural(count, 'file')}`;
      case 'search': return count === 1 ? 'searched the code' : `searched ${count} times`;
      case 'list': return count === 1 ? 'listed files' : `listed ${count} directories`;
      case 'file': return `edited ${count} ${plural(count, 'file')}`;
      case 'command': return `ran ${count} ${plural(count, 'command')}`;
      case 'permission': return count === 1 ? 'requested approval' : `requested ${count} approvals`;
      case 'question': return `asked ${count} ${plural(count, 'question')}`;
      case 'reasoning': return reasoningLabel(steps.reduce((total, step) => total + (step.kind === 'reasoning' ? step.seconds ?? 0 : 0), 0) || undefined, false).toLowerCase();
      default: return `used ${count} ${plural(count, 'tool')}`;
    }
  });
  const text = phrases.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function reasoningLabel(seconds: number | undefined, active: boolean): string {
  if (active) return 'Thinking';
  if (seconds === undefined) return 'Reasoning';
  return seconds < 1 ? 'Thought briefly' : `Thought for ${formatElapsed(seconds * 1000)}`;
}

/** One line of the latest agent answer for Overview — never user or generated prompt text. */
export function conversationPreview(turn: SessionTurn, limit = 140): string | undefined {
  const latest = turn.state === 'active'
    ? [...turn.entries].reverse().find((entry) => entry.kind === 'message' && entry.author === 'Agent')
    : undefined;
  const text = latest?.kind === 'message' ? latest.text : turn.answer;
  const compact = text?.replace(/\s+/gu, ' ').trim();
  if (!compact) return undefined;
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

export function turnOutcomeLabel(turn: Pick<SessionTurn, 'state' | 'durationMs'>): string {
  const elapsed = turn.durationMs === undefined ? undefined : formatElapsed(turn.durationMs);
  switch (turn.state) {
    case 'completed': return elapsed ? `Worked for ${elapsed}` : 'Completed';
    case 'stopped': return elapsed ? `Stopped after ${elapsed}` : 'Stopped';
    case 'failed': return elapsed ? `Failed after ${elapsed}` : 'Failed';
    case 'interrupted': return elapsed ? `Interrupted after ${elapsed}` : 'Interrupted';
    default: return 'Working';
  }
}

/** A terminal run marks where a stale active step ended without changing provider steps. */
export function planMarker(run: RunRecord, plan: AgentPlanRevisionRecord): { index: number; kind: 'failed' | 'stopped' | 'unfinished' } | undefined {
  if (isActiveRunStatus(run.status)) return undefined;
  const index = plan.steps.findIndex((step) => step.status === 'IN_PROGRESS');
  if (index < 0) return undefined;
  return { index, kind: run.status === 'COMPLETED' ? 'unfinished' : run.status === 'INTERRUPTED' ? 'stopped' : 'failed' };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

function turnState(run: RunRecord): SessionTurnState {
  if (isActiveRunStatus(run.status)) return 'active';
  if (run.status === 'COMPLETED') return 'completed';
  if (run.status === 'INTERRUPTED') return 'stopped';
  if (run.status === 'FAILED') return 'failed';
  return 'interrupted';
}

function reasoningSeconds(item: AgentItemRecord): number | undefined {
  const start = Date.parse(item.providerStartedAt ?? item.createdAt);
  const end = Date.parse(item.providerCompletedAt ?? (item.status === 'COMPLETED' ? item.updatedAt : ''));
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : undefined;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
