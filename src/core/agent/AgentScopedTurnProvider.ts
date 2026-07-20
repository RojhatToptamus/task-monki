import type {
  AgentAttestedReadRoot,
  AgentExecutionContext,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord
} from '../../shared/agentRuntime';
import type { AgentExecutionSettings } from '../../shared/agent';
import type { AgentRuntimeDescriptor } from '../../shared/agent';
import type { AgentRuntimeAdapter } from './AgentRuntimeAdapter';

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

export interface BuildScopedAgentExecutionContextInput {
  sessionId: string;
  primaryCwd: string;
  readRoots: AgentAttestedReadRoot[];
  modelSettings: AgentExecutionSettings;
  clientOperationId: string;
}

export type AgentScopedTurnEvent =
  | {
      type: 'DELTA';
      runId: string;
      providerTurnId: string;
      text: string;
      observedAt: string;
    }
  | {
      type: 'RECOVERY_REQUIRED';
      runId: string;
      providerTurnId?: string;
      reason: string;
      observedAt: string;
    }
  | {
      type: 'TERMINAL';
      runId: string;
      providerTurnId: string;
      status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
      finalMessage?: string;
      error?: string;
      completedAt: string;
    };

/** Owner-neutral provider mutation boundary used by task and discourse coordinators. */
export interface AgentScopedTurnProvider {
  startScopedTurn(input: StartScopedAgentTurnInput): Promise<StartedScopedAgentTurn>;
  interruptScopedTurn?(input: {
    session: AgentRuntimeSessionRecord;
    run: AgentRuntimeRunRecord;
  }): Promise<void>;
  onScopedTurnEvent?(listener: (event: AgentScopedTurnEvent) => void): () => void;
}

export interface AgentScopedRuntimeBinding {
  runtimeId: string;
  provider: AgentScopedTurnProvider;
  buildExecutionContext(
    input: BuildScopedAgentExecutionContextInput
  ): Promise<AgentExecutionContext>;
}

/** Optional capability implemented by runtime adapters that can attest scoped turns. */
export interface AgentScopedRuntimeAdapter extends AgentRuntimeAdapter, AgentScopedTurnProvider {
  readonly descriptor: AgentRuntimeDescriptor;
  buildScopedExecutionContext(
    input: BuildScopedAgentExecutionContextInput
  ): Promise<AgentExecutionContext>;
}

export function isAgentScopedRuntimeAdapter(
  candidate: unknown
): candidate is AgentScopedRuntimeAdapter {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as Partial<AgentScopedRuntimeAdapter>;
  return (
    typeof value.descriptor?.id === 'string' &&
    typeof value.buildScopedExecutionContext === 'function' &&
    typeof value.startScopedTurn === 'function'
  );
}

export function scopedRuntimeBinding(
  adapter: AgentScopedRuntimeAdapter
): AgentScopedRuntimeBinding {
  return {
    runtimeId: adapter.descriptor.id,
    provider: adapter,
    buildExecutionContext: (input) => adapter.buildScopedExecutionContext(input)
  };
}

/** Routes one immutable participant revision to its exact runtime binding. */
export class AgentScopedTurnRouter implements AgentScopedTurnProvider {
  private readonly bindings = new Map<string, AgentScopedRuntimeBinding>();

  constructor(bindings: readonly AgentScopedRuntimeBinding[]) {
    for (const binding of bindings) {
      if (!binding.runtimeId.trim() || this.bindings.has(binding.runtimeId)) {
        throw new Error(`Invalid or duplicate scoped agent runtime: ${binding.runtimeId}`);
      }
      this.bindings.set(binding.runtimeId, binding);
    }
  }

  has(runtimeId: string): boolean {
    return this.bindings.has(runtimeId);
  }

  runtimeIds(): string[] {
    return [...this.bindings.keys()];
  }

  buildExecutionContext(
    runtimeId: string,
    input: BuildScopedAgentExecutionContextInput
  ): Promise<AgentExecutionContext> {
    return this.require(runtimeId).buildExecutionContext(input);
  }

  startScopedTurn(input: StartScopedAgentTurnInput): Promise<StartedScopedAgentTurn> {
    return this.require(input.session.runtimeId).provider.startScopedTurn(input);
  }

  interruptScopedTurn(input: {
    session: AgentRuntimeSessionRecord;
    run: AgentRuntimeRunRecord;
  }): Promise<void> {
    const provider = this.require(input.session.runtimeId).provider;
    if (!provider.interruptScopedTurn) {
      throw new AgentScopedMutationError(
        'NOT_DELIVERED',
        `Runtime ${input.session.runtimeId} does not support Discourse interruption.`
      );
    }
    return provider.interruptScopedTurn(input);
  }

  subscribe(listener: (event: AgentScopedTurnEvent) => void): () => void {
    const disposers = [...this.bindings.values()].flatMap((binding) =>
      binding.provider.onScopedTurnEvent
        ? [binding.provider.onScopedTurnEvent(listener)]
        : []
    );
    return () => disposers.forEach((dispose) => dispose());
  }

  private require(runtimeId: string): AgentScopedRuntimeBinding {
    const binding = this.bindings.get(runtimeId);
    if (!binding) {
      throw new AgentScopedMutationError(
        'NOT_DELIVERED',
        `Runtime ${runtimeId} is not configured for Discourse.`
      );
    }
    return binding;
  }
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
