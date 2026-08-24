import { describe, expect, it } from 'vitest';
import { attestSemanticLabDriver } from './driverEligibility';
import type {
  LabDriverCapabilities,
  LabDriverPreflight,
  LabTextCallInput,
  LabTextCallResult,
  LabTextDriver
} from './textDriver';

describe('semantic driver eligibility', () => {
  it('accepts a fresh exact provider-enforced attestation', async () => {
    const driver = new AttestedDriver();
    await expect(attestSemanticLabDriver(driver, {
      model: 'model-a',
      reasoningEffort: 'high',
      serviceTier: 'priority'
    }, {
      maximumCallMs: 1_000,
      experimentDeadlineMs: Date.now() + 5_000
    })).resolves.toMatchObject({
      ready: true,
      boundary: { status: 'ATTESTED', observedModel: 'model-a' }
    });
  });

  it.each([
    ['capability flag only', (report: LabDriverPreflight) => {
      report.capabilities.textOnlyProviderEnforced = false;
    }],
    ['model reroute', (report: LabDriverPreflight) => {
      report.boundary.observedModel = 'model-b';
    }],
    ['inherited instruction', (report: LabDriverPreflight) => {
      report.boundary.instructionSources.push('AGENTS.md');
    }],
    ['MCP context', (report: LabDriverPreflight) => {
      report.boundary.mcpStartupEvents.push({ name: 'server', status: 'ready' });
    }]
  ])('rejects %s before semantic dispatch', async (_label, mutate) => {
    const driver = new AttestedDriver(mutate);
    await expect(attestSemanticLabDriver(driver, {
      model: 'model-a',
      reasoningEffort: 'high',
      serviceTier: 'priority'
    }, {
      maximumCallMs: 1_000,
      experimentDeadlineMs: Date.now() + 5_000
    })).rejects.toThrow('attestation failed');
    expect(driver.calls).toBe(0);
  });

  it('aborts a hanging preflight and leaves awaited closure to its lifecycle owner', async () => {
    const driver = new HangingPreflightDriver();
    const startedAt = Date.now();

    await expect(attestSemanticLabDriver(driver, {
      model: 'model-a',
      reasoningEffort: 'high'
    }, {
      maximumCallMs: 20,
      experimentDeadlineMs: Date.now() + 1_000
    })).rejects.toThrow('preflight timed out');

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(driver.preflightAborted).toBe(true);
    expect(driver.closeCalls).toBe(0);
    expect(driver.calls).toBe(0);
  });

  it('accepts the explicitly selected H1 harness-verified fallback boundary', async () => {
    const driver = new AttestedDriver(undefined, h1HarnessCapabilities());

    await expect(attestSemanticLabDriver(driver, {
      model: 'model-a',
      reasoningEffort: 'high',
      serviceTier: 'priority'
    }, {
      maximumCallMs: 1_000,
      experimentDeadlineMs: Date.now() + 5_000
    }, 'H1_DEVELOPMENT_HARNESS_VERIFIED')).resolves.toMatchObject({
      ready: true,
      capabilities: {
        textOnlyProviderEnforced: false,
        hardOutputTokenLimit: false,
        harnessVerifiedTextIsolation: true,
        streamingOutputTokenInterrupt: true,
        providerReportedTokenUsage: true
      }
    });
  });

  it('does not silently use the H1 fallback under the provider-enforced policy', async () => {
    const driver = new AttestedDriver(undefined, h1HarnessCapabilities());

    await expect(attestSemanticLabDriver(driver, {
      model: 'model-a',
      reasoningEffort: 'high',
      serviceTier: 'priority'
    }, {
      maximumCallMs: 1_000,
      experimentDeadlineMs: Date.now() + 5_000
    })).rejects.toThrow('provider-enforced-text-only');
  });

  it.each([
    'harnessVerifiedTextIsolation',
    'streamingOutputTokenInterrupt',
    'providerReportedTokenUsage'
  ] as const)('rejects the H1 fallback without %s', async (missingCapability) => {
    const capabilities = h1HarnessCapabilities();
    capabilities[missingCapability] = false;
    const driver = new AttestedDriver(undefined, capabilities);

    await expect(attestSemanticLabDriver(driver, {
      model: 'model-a',
      reasoningEffort: 'high',
      serviceTier: 'priority'
    }, {
      maximumCallMs: 1_000,
      experimentDeadlineMs: Date.now() + 5_000
    }, 'H1_DEVELOPMENT_HARNESS_VERIFIED')).rejects.toThrow('attestation failed');
  });
});

class AttestedDriver implements LabTextDriver {
  readonly id = 'attested-test-driver';
  readonly capabilities: LabDriverCapabilities;
  calls = 0;

  constructor(
    private readonly mutate?: (report: LabDriverPreflight) => void,
    capabilities?: LabDriverCapabilities
  ) {
    this.capabilities = capabilities ?? {
      textOnlyProviderEnforced: true,
      hardOutputTokenLimit: true,
      hardCallTimeLimit: true,
      continuation: true,
      samplingSeed: false
    };
  }

  preflight(): Promise<LabDriverPreflight> {
    const report: LabDriverPreflight = {
      driverId: this.id,
      ready: true,
      accountPresent: true,
      requiresAuthentication: false,
      models: [{
        id: 'model-a',
        model: 'model-a',
        displayName: 'Model A',
        isDefault: true,
        supportedReasoningEfforts: ['high']
      }],
      capabilities: { ...this.capabilities },
      boundary: {
        status: 'ATTESTED',
        requestedModel: 'model-a',
        observedModel: 'model-a',
        requestedReasoningEffort: 'high',
        observedReasoningEffort: 'high',
        requestedServiceTier: 'priority',
        observedServiceTier: 'priority',
        instructionSources: [],
        mcpStartupEvents: [],
        mismatchFields: []
      },
      limitationNotes: []
    };
    this.mutate?.(report);
    return Promise.resolve(report);
  }

  call(input: LabTextCallInput): Promise<LabTextCallResult> {
    this.calls += 1;
    throw new Error(`Unexpected semantic dispatch: ${input.callKey}`);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function h1HarnessCapabilities(): LabDriverCapabilities {
  return {
    textOnlyProviderEnforced: false,
    hardOutputTokenLimit: false,
    harnessVerifiedTextIsolation: true,
    streamingOutputTokenInterrupt: true,
    providerReportedTokenUsage: true,
    hardCallTimeLimit: true,
    continuation: true,
    samplingSeed: false
  };
}

class HangingPreflightDriver extends AttestedDriver {
  preflightAborted = false;
  closeCalls = 0;

  override preflight(input?: Parameters<LabTextDriver['preflight']>[0]): Promise<LabDriverPreflight> {
    input?.signal?.addEventListener('abort', () => {
      this.preflightAborted = true;
    }, { once: true });
    return new Promise(() => undefined);
  }

  override close(): Promise<void> {
    this.closeCalls += 1;
    return new Promise(() => undefined);
  }
}
