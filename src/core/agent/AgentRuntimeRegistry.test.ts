import { describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor
} from '../../shared/agent';
import type { AgentRuntimeAdapter } from './AgentRuntimeAdapter';
import { AgentRuntimeRegistry } from './AgentRuntimeRegistry';

describe('AgentRuntimeRegistry', () => {
  it('rejects duplicate runtime IDs and an unregistered default', () => {
    expect(
      () => new AgentRuntimeRegistry([runtime('codex'), runtime('codex')], 'codex')
    ).toThrow('Duplicate agent runtime id: codex');
    expect(() => new AgentRuntimeRegistry([runtime('codex')], 'opencode')).toThrow(
      'Default agent runtime is not registered: opencode'
    );
  });

  it('isolates initialization and preflight failure to the owning runtime', async () => {
    const healthy = runtime('codex');
    const unavailable = runtime('opencode', {
      initialize: vi.fn().mockRejectedValue(new Error('server failed to bind')),
      preflight: vi.fn().mockRejectedValue(new Error('health endpoint unavailable'))
    });
    const registry = new AgentRuntimeRegistry([healthy, unavailable], 'codex');

    const failures = await registry.initializeAll();
    const catalog = await registry.getCatalog();

    expect(failures).toEqual([
      expect.objectContaining({
        runtimeId: 'opencode',
        error: expect.objectContaining({ message: 'server failed to bind' })
      })
    ]);
    expect(healthy.initialize).toHaveBeenCalledOnce();
    expect(catalog.runtimes).toEqual([
      expect.objectContaining({
        preflight: expect.objectContaining({ ready: true }),
        models: [expect.objectContaining({ runtimeId: 'codex' })]
      }),
      expect.objectContaining({
        preflight: expect.objectContaining({
          ready: false,
          problems: ['server failed to bind', 'health endpoint unavailable']
        }),
        models: []
      })
    ]);
    expect(catalog.models).toEqual([
      expect.objectContaining({ runtimeId: 'codex', modelProvider: 'openai' })
    ]);
  });

  it('rejects models attributed to another runtime without degrading healthy runtimes', async () => {
    const healthy = runtime('codex');
    const mismatched = runtime('opencode', {
      listModels: vi.fn().mockResolvedValue([model('codex')])
    });
    const registry = new AgentRuntimeRegistry([healthy, mismatched], 'codex');

    const catalog = await registry.getCatalog();

    expect(catalog.runtimes[0]).toMatchObject({
      preflight: { ready: true },
      models: [{ runtimeId: 'codex' }]
    });
    expect(catalog.runtimes[1]).toMatchObject({
      preflight: {
        ready: false,
        problems: [
          'Runtime opencode returned an invalid or unqualified model identity: codex:test/model.'
        ]
      },
      models: []
    });
    expect(() => registry.require('unknown')).toThrow(
      'Agent runtime is not registered: unknown'
    );
  });

  it('requires typed operations for stable native session configuration', async () => {
    const incomplete = runtime('gemini-acp');
    const capabilities = unsupportedCapabilities('gemini-acp');
    capabilities.extensions.nativeSessionConfiguration = { maturity: 'stable' };
    incomplete.capabilities = vi.fn().mockResolvedValue(capabilities);
    const registry = new AgentRuntimeRegistry([incomplete], 'gemini-acp');

    const [failure] = await registry.initializeAll();

    expect(failure?.error.message).toContain(
      'does not implement both typed session configuration operations'
    );
    expect(incomplete.initialize).not.toHaveBeenCalled();
  });
});

function runtime(
  runtimeId: string,
  overrides: Partial<AgentRuntimeAdapter> = {}
): AgentRuntimeAdapter {
  const descriptor: AgentRuntimeDescriptor = {
    id: runtimeId,
    displayName: runtimeId,
    kind: 'NATIVE_AGENT',
    transport: 'IN_PROCESS',
    lifecycleScope: 'APPLICATION'
  };
  const capabilities = unsupportedCapabilities(runtimeId);
  const adapter: AgentRuntimeAdapter = {
    descriptor,
    initialize: vi.fn().mockResolvedValue(undefined),
    preflight: vi.fn().mockResolvedValue({
      runtime: descriptor,
      ready: true,
      capabilities,
      problems: [],
      warnings: []
    }),
    capabilities: vi.fn().mockResolvedValue(capabilities),
    listModels: vi.fn().mockResolvedValue([model(runtimeId)]),
    resolveExecution: vi.fn().mockImplementation(async ({ settings }) => ({
      settings: { ...settings, runtimeId },
      model: model(runtimeId)
    })),
    createSession: vi.fn().mockRejectedValue(new Error('not used')),
    attachSession: vi.fn().mockRejectedValue(new Error('not used')),
    readSession: vi.fn().mockRejectedValue(new Error('not used')),
    startTurn: vi.fn().mockRejectedValue(new Error('not used')),
    respondToInteraction: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn().mockResolvedValue({
      reconciledSessionIds: [],
      recoveryRequiredSessionIds: []
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  return adapter;
}

function model(runtimeId: string): AgentModel {
  return {
    id: `${runtimeId}:test/model`,
    runtimeId,
    modelProvider: runtimeId === 'codex' ? 'openai' : runtimeId,
    model: 'test/model',
    displayName: `${runtimeId} model`,
    hidden: false,
    supportedReasoningEfforts: [],
    serviceTiers: [],
    inputModalities: ['text'],
    isDefault: true
  };
}

function unsupportedCapabilities(runtimeId: string): AgentRuntimeCapabilities {
  const unsupported = { maturity: 'unsupported' as const };
  return {
    runtimeId,
    executionPolicy: testExecutionPolicy(),
    promptRefinement: unsupported,
    modelCatalog: unsupported,
    reasoningEffort: unsupported,
    persistentSessions: unsupported,
    sessionResume: unsupported,
    sessionFork: unsupported,
    activeTurnSteering: unsupported,
    turnInterruption: unsupported,
    truePause: unsupported,
    interactiveApprovals: unsupported,
    userInputRequests: unsupported,
    goals: unsupported,
    plans: unsupported,
    review: unsupported,
    subagents: unsupported,
    backgroundTerminals: unsupported,
    dynamicTools: unsupported,
    attachmentDelivery: unsupported,
    runtimeRecovery: unsupported,
    extensions: {}
  };
}

function testExecutionPolicy(): AgentRuntimeCapabilities['executionPolicy'] {
  return {
    defaultPresetId: 'read-only',
    detail: 'Test policy.',
    presets: [
      {
        id: 'read-only',
        label: 'Read only',
        detail: 'Test read-only policy.',
        sandbox: 'READ_ONLY',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        networkAccess: 'DISABLED'
      }
    ]
  };
}
