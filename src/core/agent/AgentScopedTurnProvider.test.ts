import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionContext } from '../../shared/agentRuntime';
import {
  AgentScopedMutationError,
  AgentScopedTurnRouter,
  type AgentScopedRuntimeBinding,
  type AgentScopedTurnEvent,
  type StartScopedAgentTurnInput
} from './AgentScopedTurnProvider';

describe('AgentScopedTurnRouter', () => {
  it('routes context, start, interrupt, and events through exact runtime bindings', async () => {
    const a = binding('runtime-a');
    const b = binding('runtime-b');
    const router = new AgentScopedTurnRouter([a.binding, b.binding]);
    const events: AgentScopedTurnEvent[] = [];
    const dispose = router.subscribe((event) => events.push(event));

    await router.buildExecutionContext('runtime-b', contextInput());
    await router.startScopedTurn(turnInput('runtime-b'));
    await router.interruptScopedTurn(turnInput('runtime-b'));
    b.emit({
      type: 'DELTA',
      runId: 'run-b',
      providerTurnId: 'turn-b',
      text: 'independent output',
      observedAt: '2026-07-20T00:00:00.000Z'
    });

    expect(a.buildExecutionContext).not.toHaveBeenCalled();
    expect(a.startScopedTurn).not.toHaveBeenCalled();
    expect(b.buildExecutionContext).toHaveBeenCalledOnce();
    expect(b.startScopedTurn).toHaveBeenCalledOnce();
    expect(b.interruptScopedTurn).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    dispose();
    b.emit({
      type: 'DELTA',
      runId: 'run-b',
      providerTurnId: 'turn-b',
      text: 'after dispose',
      observedAt: '2026-07-20T00:00:01.000Z'
    });
    expect(events).toHaveLength(1);
  });

  it('fails closed instead of falling back to another runtime', async () => {
    const a = binding('runtime-a');
    const router = new AgentScopedTurnRouter([a.binding]);

    expect(() => router.startScopedTurn(turnInput('runtime-missing'))).toThrow(
      'Runtime runtime-missing is not configured for Discourse.'
    );
    try {
      router.startScopedTurn(turnInput('runtime-missing'));
    } catch (error) {
      expect(error).toEqual(expect.objectContaining<Partial<AgentScopedMutationError>>({
        delivery: 'NOT_DELIVERED'
      }));
    }
    expect(a.startScopedTurn).not.toHaveBeenCalled();
  });
});

function binding(runtimeId: string) {
  const listeners = new Set<(event: AgentScopedTurnEvent) => void>();
  const buildExecutionContext = vi.fn(async () => ({
    permissionProfileHash: `${runtimeId}-profile`
  } as AgentExecutionContext));
  const startScopedTurn = vi.fn(async () => ({
    serverInstanceId: `${runtimeId}-server`,
    providerSessionId: `${runtimeId}-session`,
    providerTurnId: `${runtimeId}-turn`,
    startedAt: '2026-07-20T00:00:00.000Z'
  }));
  const interruptScopedTurn = vi.fn(async () => undefined);
  const binding: AgentScopedRuntimeBinding = {
    runtimeId,
    buildExecutionContext,
    provider: {
      startScopedTurn,
      interruptScopedTurn,
      onScopedTurnEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    }
  };
  return {
    binding,
    buildExecutionContext,
    startScopedTurn,
    interruptScopedTurn,
    emit(event: AgentScopedTurnEvent) {
      listeners.forEach((listener) => listener(event));
    }
  };
}

function contextInput(): Parameters<AgentScopedRuntimeBinding['buildExecutionContext']>[0] {
  return {
    sessionId: 'session-b',
    primaryCwd: '/tmp/discourse',
    readRoots: [{ canonicalPath: '/tmp/discourse', kind: 'EMPTY_MANAGED' }],
    modelSettings: {
      model: 'model-b',
      sandbox: 'READ_ONLY',
      networkAccess: false,
      approvalPolicy: 'NEVER',
      approvalsReviewer: 'user'
    },
    clientOperationId: 'context-b'
  };
}

function turnInput(runtimeId: string): StartScopedAgentTurnInput {
  return {
    session: { id: `${runtimeId}-session`, runtimeId } as StartScopedAgentTurnInput['session'],
    run: { id: `${runtimeId}-run` } as StartScopedAgentTurnInput['run'],
    executionContext: { permissionProfileHash: 'profile' } as AgentExecutionContext,
    prompt: 'Respond independently.'
  };
}
