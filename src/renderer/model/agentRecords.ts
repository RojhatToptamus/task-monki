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

export type AgentConversationOwner = 'task' | 'preview' | 'side';

/**
 * Splits a task's agent records between the conversations that render them.
 * A PREVIEW run, its session, items, questions and messages belong to the
 * Preview tab; a SIDE_QUESTION run and its SIDE messages belong to Ask.
 * Neither ever reaches the Agent tab or the task's run selection. Review runs
 * themselves stay with the task.
 */
export function partitionAgentRecords(records: AgentConversationRecords): Record<AgentConversationOwner, AgentConversationRecords> {
  const runOwner = (run: RunRecord): AgentConversationOwner =>
    run.mode === 'PREVIEW' ? 'preview' : run.mode === 'SIDE_QUESTION' ? 'side' : 'task';
  const ownerOfRun = new Map<string, AgentConversationOwner>(records.runs.map((run) => [run.id, runOwner(run)]));
  const byRun = (runId: string | undefined): AgentConversationOwner => ownerOfRun.get(runId ?? '') ?? 'task';
  const instructionOwner = (instruction: TaskInstruction): AgentConversationOwner =>
    instruction.role === 'PREVIEW' ? 'preview' : instruction.role === 'SIDE' ? 'side' : 'task';
  const sessionOwner = (session: AgentSessionRecord): AgentConversationOwner =>
    session.role === 'PREVIEW' ? 'preview' : session.role === 'SIDE' ? 'side' : 'task';
  const split = (owner: AgentConversationOwner): AgentConversationRecords => ({
    runs: records.runs.filter((run) => ownerOfRun.get(run.id) === owner),
    items: records.items.filter((item) => byRun(item.runId) === owner),
    instructions: records.instructions.filter((instruction) => instructionOwner(instruction) === owner),
    interactions: records.interactions.filter((interaction) => byRun(interaction.runId) === owner),
    sessions: records.sessions.filter((session) => sessionOwner(session) === owner),
    plans: records.plans.filter((plan) => byRun(plan.runId) === owner)
  });
  return { task: split('task'), preview: split('preview'), side: split('side') };
}
