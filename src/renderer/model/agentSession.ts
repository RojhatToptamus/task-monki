import type { AgentItemRecord, RunRecord, TaskInstruction } from '../../shared/contracts';
import { buildRunActivityProjection } from './runActivity';
import { buildOverviewRunActivityRows, type OverviewActivityRow } from './overviewRunActivity';

export type SessionEntry =
  | { key: string; at: string; kind: 'message'; author: 'You' | 'Agent'; text: string; status?: string }
  | { key: string; at: string; kind: 'activity'; rows: OverviewActivityRow[] };

/** Provider user-message echoes contain generated prompts; authored text has its own owner. */
export function sessionEntries(run: RunRecord, items: AgentItemRecord[], instructions: TaskInstruction[]): SessionEntry[] {
  const runItems = items.filter((item) => item.runId === run.id);
  const entries: SessionEntry[] = instructions.filter((item) => item.runId === run.id).map((item) => ({
    key: item.id, at: item.createdAt, kind: 'message', author: 'You', text: item.text,
    status: item.mode === 'STEER'
      ? ({ SENDING: 'Sending now…', SUBMITTED: 'Sent to active turn', FAILED: 'Not delivered', UNCERTAIN: 'Delivery uncertain', QUEUED: 'Queued', HELD: 'Held' }[item.status])
      : undefined
  }));
  for (const item of runItems) {
    if (item.type !== 'AGENT_MESSAGE') continue;
    const payload = item.payload as { text?: unknown } | null;
    if (typeof payload?.text !== 'string' || !payload.text.trim()) continue;
    entries.push({ key: item.id, at: item.createdAt, kind: 'message', author: 'Agent', text: payload.text,
      status: ['RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(run.status) && ['STARTED', 'IN_PROGRESS'].includes(item.status) ? 'Writing…' : undefined });
  }
  // The final-message projection is a fallback when the provider did not emit a message item.
  if (run.finalMessage?.trim() && !entries.some((entry) => entry.kind === 'message' && entry.author === 'Agent' && entry.text.trim() === run.finalMessage!.trim())) {
    entries.push({ key: `${run.id}:final`, at: run.endedAt ?? run.lastEventAt ?? run.startedAt,
      kind: 'message', author: 'Agent', text: run.finalMessage });
  }
  const activity = buildOverviewRunActivityRows(buildRunActivityProjection({ run,
    items: runItems.filter((item) => item.type !== 'AGENT_MESSAGE'), groupContext: true }).rows);
  if (['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(run.status)) {
    for (const row of activity) for (const leaf of [row, ...(row.children ?? [])]) {
      if (leaf.status === 'active') {
        leaf.status = 'failed';
        leaf.tone = run.status === 'INTERRUPTED' ? 'neutral' : 'error';
        leaf.label = run.status === 'INTERRUPTED' ? 'Stopped' : 'Unfinished';
      }
    }
  }
  for (const row of activity) entries.push({ key: row.key, at: row.at, kind: 'activity', rows: [row] });
  entries.sort((a, b) => a.at.localeCompare(b.at));
  const grouped: SessionEntry[] = [];
  for (const entry of entries) {
    const previous = grouped.at(-1);
    if (entry.kind === 'activity' && previous?.kind === 'activity' && previous.rows.length < 8) previous.rows.push(...entry.rows);
    else grouped.push(entry);
  }
  return grouped;
}
