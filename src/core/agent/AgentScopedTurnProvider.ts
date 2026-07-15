import type {
  AgentExecutionContext,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord
} from '../../shared/agentRuntime';

export interface StartScopedAgentTurnInput {
  session: AgentRuntimeSessionRecord;
  run: AgentRuntimeRunRecord;
  executionContext: AgentExecutionContext;
  prompt: string;
}

export interface StartedScopedAgentTurn {
  serverInstanceId: string;
  providerSessionId: string;
  providerSessionTreeId?: string;
  providerTurnId: string;
  startedAt: string;
}

/** Owner-neutral provider mutation boundary used by task and discourse coordinators. */
export interface AgentScopedTurnProvider {
  startScopedTurn(input: StartScopedAgentTurnInput): Promise<StartedScopedAgentTurn>;
  interruptScopedTurn?(input: {
    session: AgentRuntimeSessionRecord;
    run: AgentRuntimeRunRecord;
  }): Promise<void>;
}

export class AgentScopedMutationError extends Error {
  constructor(
    readonly delivery: 'NOT_DELIVERED' | 'AMBIGUOUS',
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'AgentScopedMutationError';
  }
}
