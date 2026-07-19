import { describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor
} from '../../shared/agent';
import type { AgentRuntimeAdapter } from './AgentRuntimeAdapter';
import { AgentRuntimeRegistry } from './AgentRuntimeRegistry';
import { createRuntimeReadiness } from './AgentRuntimeReadiness';

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
        preflight: expect.objectContaining({
          readiness: expect.objectContaining({ status: 'READY', canStart: true })
        }),
        models: [expect.objectContaining({ runtimeId: 'codex' })]
      }),
      expect.objectContaining({
        preflight: expect.objectContaining({
          readiness: expect.objectContaining({
            status: 'FAILED',
            diagnostics: [
              expect.objectContaining({ message: 'server failed to bind' }),
              expect.objectContaining({ message: 'health endpoint unavailable' })
            ]
          })
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
      preflight: { readiness: { status: 'READY', canStart: true } },
      models: [{ runtimeId: 'codex' }]
    });
    expect(catalog.runtimes[1]).toMatchObject({
      preflight: {
        readiness: {
          status: 'FAILED',
          diagnostics: [
            expect.objectContaining({
              message:
                'Runtime opencode returned an invalid or unqualified model identity: codex:test/model.'
            })
          ]
        }
      },
      models: []
    });
    expect(() => registry.require('unknown')).toThrow(
      'Agent runtime is not registered: unknown'
    );
  });

  it('requires typed discovery and mutation for stable session controls', async () => {
    const incomplete = runtime('grok-acp');
    const capabilities = unsupportedCapabilities('grok-acp');
    capabilities.sessionControls = { maturity: 'stable' };
    incomplete.capabilities = vi.fn().mockResolvedValue(capabilities);
    const registry = new AgentRuntimeRegistry([incomplete], 'grok-acp');

    const [failure] = await registry.initializeAll();

    expect(failure?.error.message).toContain(
      'does not implement typed control discovery and mutation'
    );
    expect(incomplete.initialize).not.toHaveBeenCalled();
  });

  it('reports a surface isolation mismatch as an unsupported security policy', async () => {
    const adapter = runtime('opencode');
    const registry = new AgentRuntimeRegistry([adapter], 'opencode');

    const catalog = await registry.getCatalog({
      excludedRuntimeIds: new Set(['opencode']),
      exclusionReason: 'This surface requires an attested process sandbox.'
    });

    expect(catalog.runtimes[0]).toMatchObject({
      preflight: {
        readiness: {
          status: 'UNSUPPORTED_SECURITY_POLICY',
          canStart: false,
          nextAction: {
            kind: 'VIEW_DETAILS',
            label: 'Use the desktop app for agent runs'
          },
          diagnostics: [
            expect.objectContaining({
              code: 'SECURITY_POLICY_UNSUPPORTED',
              stage: 'SECURITY'
            })
          ]
        }
      },
      models: []
    });
    expect(adapter.listModels).not.toHaveBeenCalled();
  });

  it('reports user-disabled runtimes without probing or discovering models', async () => {
    const adapter = runtime('cursor-agent-acp');
    const registry = new AgentRuntimeRegistry([adapter], 'cursor-agent-acp');

    const catalog = await registry.getCatalog({
      disabledRuntimeIds: new Set(['cursor-agent-acp'])
    });

    expect(catalog.runtimes[0]).toMatchObject({
      preflight: {
        readiness: {
          status: 'DISABLED',
          canStart: false,
          nextAction: { kind: 'CONFIGURE', label: 'Enable in Settings' },
          diagnostics: [
            expect.objectContaining({
              code: 'RUNTIME_DISABLED',
              stage: 'CONFIGURATION'
            })
          ]
        }
      },
      models: []
    });
    expect(adapter.preflight).not.toHaveBeenCalled();
    expect(adapter.listModels).not.toHaveBeenCalled();
  });

  it('runs provider discovery only for an explicit catalog request', async () => {
    const discoverModels = vi.fn().mockResolvedValue(undefined);
    const adapter = runtime('cursor-agent-acp', { discoverModels });
    const unrelated = runtime('unrelated-runtime');
    const registry = new AgentRuntimeRegistry(
      [adapter, unrelated],
      'cursor-agent-acp'
    );

    await registry.getCatalog();
    expect(discoverModels).not.toHaveBeenCalled();
    vi.mocked(adapter.listModels).mockClear();
    vi.mocked(unrelated.listModels).mockClear();

    const runtimeState = await registry.discoverAgentRuntimeModels('cursor-agent-acp');

    expect(discoverModels).toHaveBeenCalledOnce();
    expect(adapter.listModels).toHaveBeenCalledOnce();
    expect(unrelated.listModels).not.toHaveBeenCalled();
    expect(runtimeState.models).toEqual([
      expect.objectContaining({ runtimeId: 'cursor-agent-acp' })
    ]);
  });

  it('rejects explicit discovery for disabled and unknown runtimes', async () => {
    const discoverModels = vi.fn().mockResolvedValue(undefined);
    const adapter = runtime('cursor-agent-acp', { discoverModels });
    const registry = new AgentRuntimeRegistry([adapter], 'cursor-agent-acp');

    await expect(
      registry.discoverAgentRuntimeModels('cursor-agent-acp', {
        disabledRuntimeIds: new Set(['cursor-agent-acp'])
      })
    ).rejects.toThrow('cursor-agent-acp is disabled');
    await expect(registry.discoverAgentRuntimeModels('unknown')).rejects.toThrow(
      'Agent runtime is not registered: unknown'
    );
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it('returns readiness advanced by live model discovery', async () => {
    const descriptor: AgentRuntimeDescriptor = {
      id: 'grok-acp',
      displayName: 'Grok Build',
      kind: 'ACP_AGENT',
      transport: 'STDIO',
      lifecycleScope: 'APPLICATION'
    };
    const capabilities = unsupportedCapabilities(descriptor.id);
    let preflight = {
      runtime: descriptor,
      readiness: createRuntimeReadiness(
        'DISCOVERED',
        'Executable discovery completed.',
        { checks: { discovery: 'FOUND', initialization: 'NOT_STARTED' } }
      ),
      capabilities
    };
    const adapter = runtime(descriptor.id, {
      descriptor,
      preflight: vi.fn(async () => preflight),
      listModels: vi.fn(async () => {
        preflight = {
          runtime: descriptor,
          readiness: createRuntimeReadiness('DISCOVERED', 'ACP model catalog connected.', {
            checks: {
              discovery: 'FOUND',
              compatibility: 'COMPATIBLE',
              initialization: 'INITIALIZED',
              modelCatalog: 'AVAILABLE'
            }
          }),
          capabilities
        };
        return [model(descriptor.id)];
      })
    });

    const catalog = await new AgentRuntimeRegistry([adapter], descriptor.id).getCatalog();

    expect(catalog.runtimes[0]).toMatchObject({
      preflight: {
        readiness: {
          status: 'DISCOVERED',
          checks: { initialization: 'INITIALIZED', modelCatalog: 'AVAILABLE' }
        }
      },
      models: [{ runtimeId: descriptor.id }]
    });
    expect(adapter.preflight).toHaveBeenCalledTimes(2);
  });

  it('preserves a typed blocked state when live model discovery fails', async () => {
    const adapter = runtime('grok-acp');
    const capabilities = unsupportedCapabilities('grok-acp');
    let preflight = await adapter.preflight();
    adapter.preflight = vi.fn(async () => preflight);
    adapter.listModels = vi.fn(async () => {
      preflight = {
        runtime: adapter.descriptor,
        readiness: createRuntimeReadiness(
          'AUTHENTICATION_REQUIRED',
          'Grok authentication is required.',
          {
            checks: {
              discovery: 'FOUND',
              compatibility: 'COMPATIBLE',
              initialization: 'FAILED',
              authentication: 'REQUIRED'
            },
            nextAction: { kind: 'AUTHENTICATE', label: 'Sign in to Grok' }
          }
        ),
        capabilities
      };
      throw new Error('Grok model catalog requires authentication.');
    });

    const catalog = await new AgentRuntimeRegistry([adapter], 'grok-acp').getCatalog();

    expect(catalog.runtimes[0]).toMatchObject({
      preflight: {
        readiness: {
          status: 'AUTHENTICATION_REQUIRED',
          canStart: false,
          checks: { authentication: 'REQUIRED', modelCatalog: 'FAILED' },
          nextAction: { kind: 'AUTHENTICATE', label: 'Sign in to Grok' },
          diagnostics: [
            expect.objectContaining({
              code: 'MODEL_CATALOG_FAILED',
              message: 'Grok model catalog requires authentication.'
            })
          ]
        }
      },
      models: []
    });
  });
});

function runtime(
  runtimeId: string,
  overrides: Partial<AgentRuntimeAdapter> = {}
): AgentRuntimeAdapter {
  const descriptor: AgentRuntimeDescriptor = {
    id: runtimeId,
    displayName: runtimeId,
    kind: 'ACP_AGENT',
    transport: 'IN_PROCESS',
    lifecycleScope: 'APPLICATION'
  };
  const capabilities = unsupportedCapabilities(runtimeId);
  const adapter: AgentRuntimeAdapter = {
    descriptor,
    initialize: vi.fn().mockResolvedValue(undefined),
    preflight: vi.fn().mockResolvedValue({
      runtime: descriptor,
      readiness: createRuntimeReadiness('READY', 'Test runtime is ready.'),
      capabilities,
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
