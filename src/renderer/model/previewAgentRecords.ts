import type {
  AgentItemRecord,
  AgentPlanRevisionRecord,
  AgentSessionRecord,
  InteractionRequestRecord,
  RunRecord,
  TaskInstruction
} from '../../shared/contracts';

/** The records one conversation surface renders. */
export interface AgentConversationRecords {
  runs: RunRecord[];
  items: AgentItemRecord[];
  instructions: TaskInstruction[];
  interactions: InteractionRequestRecord[];
  sessions: AgentSessionRecord[];
  plans: AgentPlanRevisionRecord[];
}

/**
 * Splits a task's agent records between the task conversation and the Preview conversation.
 * A PREVIEW run, its session, its items, questions and messages belong to the Preview tab and
 * never to the Agent tab or the task's run selection.
 */
export function partitionPreviewAgentRecords(records: AgentConversationRecords): {
  task: AgentConversationRecords;
  preview: AgentConversationRecords;
} {
  const previewRunIds = new Set(records.runs.filter((run) => run.mode === 'PREVIEW').map((run) => run.id));
  const byRun = <T extends { runId?: string }>(list: T[], preview: boolean) =>
    list.filter((record) => previewRunIds.has(record.runId ?? '') === preview);
  const split = (preview: boolean): AgentConversationRecords => ({
    runs: records.runs.filter((run) => (run.mode === 'PREVIEW') === preview),
    items: byRun(records.items, preview),
    instructions: records.instructions.filter((instruction) => (instruction.role === 'PREVIEW') === preview),
    interactions: byRun(records.interactions, preview),
    sessions: records.sessions.filter((session) => (session.role === 'PREVIEW') === preview),
    plans: byRun(records.plans, preview)
  });
  return { task: split(false), preview: split(true) };
}
