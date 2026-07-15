import {
  AGENT_SCHEDULER_POLICY,
  agentOwnerScopeKey,
  type AgentRuntimeStoreState,
  type AgentSchedulerPriority,
  type AgentSchedulerQueueEntry
} from '../../shared/agentRuntime';
import type { AgentRuntimeStore } from './AgentRuntimeStore';

const PRIORITY_RANK: Record<AgentSchedulerPriority, number> = {
  TASK_FOREGROUND: 0,
  DISCOURSE_RESPONSE: 1,
  DISCOURSE_TARGETED: 2,
  DISCOURSE_BACKGROUND: 3
};

/**
 * Durable, owner-fair scheduler. A lease is capacity, not a timer: callers must
 * settle it only after authoritative terminal or recovery resolution.
 */
export class AgentTurnScheduler {
  constructor(
    private readonly store: AgentRuntimeStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async leaseAvailable(
    operationIdPrefix: string,
    options: { ownerKinds?: readonly AgentSchedulerQueueEntry['owner']['kind'][] } = {}
  ): Promise<AgentSchedulerQueueEntry[]> {
    const leased: AgentSchedulerQueueEntry[] = [];
    for (let attempt = 0; attempt < AGENT_SCHEDULER_POLICY.optimisticLeaseRetries; attempt += 1) {
      const snapshot = await this.store.snapshot();
      const candidate = selectNextAgentTurn(snapshot, this.now(), options);
      if (!candidate) return leased;
      try {
        const entry = await this.store.leaseQueueEntry(
          candidate.id,
          candidate.recordRevision,
          `${operationIdPrefix}:${candidate.id}:${candidate.recordRevision}`
        );
        leased.push(entry);
      } catch (error) {
        if (!isOptimisticLeaseConflict(error)) throw error;
      }
    }
    return leased;
  }

  async latchShutdown(operationId: string): Promise<void> {
    await this.store.setShutdownLatched(true, operationId);
  }

  async reopenAfterRecovery(operationId: string): Promise<void> {
    const snapshot = await this.store.snapshot();
    if (snapshot.queueEntries.some((entry) => entry.status === 'LEASED')) {
      throw new Error('Agent scheduler cannot reopen while leased work still needs reconciliation.');
    }
    await this.store.setShutdownLatched(false, operationId);
  }
}

export function selectNextAgentTurn(
  state: AgentRuntimeStoreState,
  now: string,
  options: { ownerKinds?: readonly AgentSchedulerQueueEntry['owner']['kind'][] } = {}
): AgentSchedulerQueueEntry | undefined {
  if (state.shutdownLatched) return undefined;
  const nowMs = requireTimestamp(now);
  const active = state.queueEntries.filter((entry) => entry.status === 'LEASED');
  if (active.length >= AGENT_SCHEDULER_POLICY.maxActiveTurns) return undefined;

  const runById = new Map(state.runs.map((run) => [run.id, run]));
  const eligible = state.queueEntries.filter((entry) => {
    if (options.ownerKinds && !options.ownerKinds.includes(entry.owner.kind)) return false;
    if (entry.status !== 'QUEUED') return false;
    if (entry.notBefore && requireTimestamp(entry.notBefore) > nowMs) return false;
    const run = runById.get(entry.runId);
    if (!run || run.status !== 'QUEUED' || run.delivery !== 'NOT_SENT') return false;
    if (
      active.filter((candidate) => candidate.sessionId === entry.sessionId).length >=
      AGENT_SCHEDULER_POLICY.maxActiveTurnsPerSession
    ) {
      return false;
    }
    if (entry.scope.kind === 'DISCOURSE') {
      const conversationId = entry.scope.conversationId;
      const waveId = entry.scope.waveId;
      const conversationActive = active.filter(
        (candidate) =>
          candidate.scope.kind === 'DISCOURSE' &&
          candidate.scope.conversationId === conversationId
      );
      if (
        conversationActive.length >=
        AGENT_SCHEDULER_POLICY.maxActiveTurnsPerConversation
      ) {
        return false;
      }
      if (
        conversationActive.some(
          (candidate) =>
            candidate.scope.kind === 'DISCOURSE' &&
            candidate.scope.waveId !== waveId
        )
      ) {
        return false;
      }
    }
    return true;
  });
  if (eligible.length === 0) return undefined;

  const effectiveRank = (entry: AgentSchedulerQueueEntry) =>
    Math.max(
      0,
      PRIORITY_RANK[entry.priority] -
        Math.floor(
          Math.max(0, nowMs - requireTimestamp(entry.enqueuedAt)) /
            AGENT_SCHEDULER_POLICY.agingPromotionIntervalMs
        )
    );
  const bestRank = Math.min(...eligible.map(effectiveRank));
  const priorityEligible = eligible.filter((entry) => effectiveRank(entry) === bestRank);

  const lastLeaseByOwner = new Map<string, number>();
  for (const entry of state.queueEntries) {
    if (!entry.leasedAt) continue;
    const ownerKey = schedulerOwnerKey(entry);
    lastLeaseByOwner.set(
      ownerKey,
      Math.max(lastLeaseByOwner.get(ownerKey) ?? 0, requireTimestamp(entry.leasedAt))
    );
  }
  return [...priorityEligible].sort((left, right) => {
    const leftOwner = schedulerOwnerKey(left);
    const rightOwner = schedulerOwnerKey(right);
    const ownerFairness =
      (lastLeaseByOwner.get(leftOwner) ?? 0) -
      (lastLeaseByOwner.get(rightOwner) ?? 0);
    if (ownerFairness !== 0) return ownerFairness;
    if (left.enqueueOrdinal !== right.enqueueOrdinal) {
      return left.enqueueOrdinal - right.enqueueOrdinal;
    }
    const owner = compareCodeUnits(leftOwner, rightOwner);
    return owner || compareCodeUnits(left.id, right.id);
  })[0];
}

function schedulerOwnerKey(entry: AgentSchedulerQueueEntry): string {
  return entry.owner.kind === 'DISCOURSE'
    ? `discourse:${entry.owner.conversationId}`
    : agentOwnerScopeKey(entry.owner);
}

function requireTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('Agent scheduler timestamp is invalid.');
  }
  return parsed;
}

function isOptimisticLeaseConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('changed before') ||
      error.message.includes('Invalid agent runtime queue transition'))
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
