import type {
  AgentCapability,
  AgentPreflight,
  AgentRuntimeCapabilities,
  AgentRuntimeCatalog,
  AgentRuntimeId,
  AgentRuntimeState
} from '../../shared/agent';
import type { AgentRuntimeAdapter } from './AgentRuntimeAdapter';
import {
  appendRuntimeDiagnostic,
  createRuntimeReadiness,
  errorDiagnostic,
  warningDiagnostic
} from './AgentRuntimeReadiness';

export interface AgentRuntimeInitializationFailure {
  runtimeId: AgentRuntimeId;
  error: Error;
}

/**
 * Static, application-owned registry for complete agent runtimes.
 *
 * Runtime selection is persisted on tasks and sessions. This registry never
 * falls back from an existing session to the current default runtime.
 */
export class AgentRuntimeRegistry {
  private readonly adapters = new Map<AgentRuntimeId, AgentRuntimeAdapter>();
  private readonly initializationFailures = new Map<AgentRuntimeId, Error>();

  constructor(
    adapters: readonly AgentRuntimeAdapter[],
    readonly defaultRuntimeId: AgentRuntimeId
  ) {
    if (adapters.length === 0) {
      throw new Error('At least one agent runtime must be registered.');
    }
    for (const adapter of adapters) {
      const runtimeId = normalizeRuntimeId(adapter.descriptor.id);
      if (this.adapters.has(runtimeId)) {
        throw new Error(`Duplicate agent runtime id: ${runtimeId}`);
      }
      this.adapters.set(runtimeId, adapter);
    }
    if (!this.adapters.has(normalizeRuntimeId(defaultRuntimeId))) {
      throw new Error(`Default agent runtime is not registered: ${defaultRuntimeId}`);
    }
  }

  list(): readonly AgentRuntimeAdapter[] {
    return [...this.adapters.values()];
  }

  has(runtimeId: AgentRuntimeId): boolean {
    return this.adapters.has(normalizeRuntimeId(runtimeId));
  }

  require(runtimeId: AgentRuntimeId): AgentRuntimeAdapter {
    const normalized = normalizeRuntimeId(runtimeId);
    const adapter = this.adapters.get(normalized);
    if (!adapter) {
      throw new Error(`Agent runtime is not registered: ${runtimeId}`);
    }
    return adapter;
  }

  async initializeAll(): Promise<AgentRuntimeInitializationFailure[]> {
    return this.initialize(this.list().map((adapter) => adapter.descriptor.id));
  }

  async initialize(
    runtimeIds: readonly AgentRuntimeId[]
  ): Promise<AgentRuntimeInitializationFailure[]> {
    const adapters = [...new Set(runtimeIds)].map((runtimeId) =>
      this.require(runtimeId)
    );
    const failures = await Promise.all(
      adapters.map(async (adapter): Promise<AgentRuntimeInitializationFailure | undefined> => {
        try {
          await validateAdapterContract(adapter);
          await adapter.initialize();
          this.initializationFailures.delete(adapter.descriptor.id);
          return undefined;
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          this.initializationFailures.set(adapter.descriptor.id, error);
          await adapter.shutdown().catch(() => undefined);
          return { runtimeId: adapter.descriptor.id, error };
        }
      })
    );
    return failures.filter(
      (failure): failure is AgentRuntimeInitializationFailure => failure !== undefined
    );
  }

  async getCatalog(options: {
    disabledRuntimeIds?: ReadonlySet<AgentRuntimeId>;
    excludedRuntimeIds?: ReadonlySet<AgentRuntimeId>;
    exclusionReason?: string;
  } = {}): Promise<AgentRuntimeCatalog> {
    const refreshedAt = new Date().toISOString();
    const runtimes = await Promise.all(
      this.list().map((adapter) =>
        options.disabledRuntimeIds?.has(adapter.descriptor.id)
          ? this.getDisabledRuntimeState(adapter, refreshedAt)
          : options.excludedRuntimeIds?.has(adapter.descriptor.id)
          ? this.getExcludedRuntimeState(
              adapter,
              refreshedAt,
              options.exclusionReason ?? 'Runtime initialization is disabled.'
            )
          : this.getRuntimeState(adapter, refreshedAt)
      )
    );
    const models = runtimes.flatMap((runtime) => runtime.models);
    const modelIds = new Set<string>();
    for (const model of models) {
      if (modelIds.has(model.id)) {
        throw new Error(`Duplicate qualified agent model id: ${model.id}`);
      }
      modelIds.add(model.id);
    }
    return {
      runtimes,
      models,
      defaultRuntimeId: this.defaultRuntimeId,
      refreshedAt
    };
  }

  async discoverAgentRuntimeModels(
    runtimeId: AgentRuntimeId,
    options: {
      disabledRuntimeIds?: ReadonlySet<AgentRuntimeId>;
      excludedRuntimeIds?: ReadonlySet<AgentRuntimeId>;
      exclusionReason?: string;
    } = {}
  ): Promise<AgentRuntimeState> {
    const adapter = this.require(runtimeId);
    if (options.disabledRuntimeIds?.has(adapter.descriptor.id)) {
      throw new Error(`${adapter.descriptor.displayName} is disabled.`);
    }
    if (options.excludedRuntimeIds?.has(adapter.descriptor.id)) {
      throw new Error(
        options.exclusionReason ?? `${adapter.descriptor.displayName} is unavailable.`
      );
    }
    await adapter.discoverModels?.();
    return this.getRuntimeState(adapter, new Date().toISOString());
  }

  async reconcileAll(): Promise<void> {
    await Promise.all(
      this.list().map(async (adapter) => {
        try {
          await adapter.reconcile();
        } catch (cause) {
          this.initializationFailures.set(
            adapter.descriptor.id,
            cause instanceof Error ? cause : new Error(String(cause))
          );
        }
      })
    );
  }

  async shutdownAll(): Promise<void> {
    const results = await Promise.allSettled(this.list().map((adapter) => adapter.shutdown()));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more agent runtimes failed to shut down.');
    }
  }

  private async getRuntimeState(
    adapter: AgentRuntimeAdapter,
    refreshedAt: string
  ): Promise<AgentRuntimeState> {
    let preflight: AgentPreflight;
    try {
      await validateAdapterContract(adapter);
      preflight = await adapter.preflight();
      assertPreflightIdentity(adapter, preflight);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const initializationError = this.initializationFailures.get(adapter.descriptor.id);
      const messages = [initializationError?.message, error.message].filter(
        (message, index, all): message is string =>
          Boolean(message) && all.indexOf(message) === index
      );
      preflight = {
        runtime: adapter.descriptor,
        readiness: createRuntimeReadiness(
          'FAILED',
          messages[0] ?? 'Runtime health could not be determined.',
          {
            diagnostics: messages.map((message) =>
              errorDiagnostic('RUNTIME_PREFLIGHT_FAILED', 'HEALTH', message)
            ),
            nextAction: { kind: 'RETRY', label: 'Retry discovery' }
          }
        ),
        capabilities: await safeCapabilities(adapter),
      };
    }

    let models: AgentRuntimeState['models'] = [];
    let native: AgentRuntimeState['native'];
    let sessionControls: AgentRuntimeState['sessionControls'];
    if (preflight.readiness.canStart) {
      try {
        models = await adapter.listModels();
        const modelIds = new Set<string>();
        for (const model of models) {
          if (
            model.runtimeId !== adapter.descriptor.id ||
            !model.id.startsWith(`${adapter.descriptor.id}:`) ||
            !model.model.trim() ||
            (model.modelProvider !== undefined && !model.modelProvider.trim())
          ) {
            throw new Error(
              `Runtime ${adapter.descriptor.id} returned an invalid or unqualified model identity: ${model.id}.`
            );
          }
          if (modelIds.has(model.id)) {
            throw new Error(
              `Runtime ${adapter.descriptor.id} returned duplicate model id ${model.id}.`
            );
          }
          modelIds.add(model.id);
        }
        // Model discovery may be the runtime's first live operation. Re-read
        // readiness so the catalog reports the state proven by that operation
        // instead of the passive discovery snapshot captured above.
        preflight = await adapter.preflight();
        assertPreflightIdentity(adapter, preflight);
        if (!preflight.readiness.canStart) {
          models = [];
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        try {
          const latestPreflight = await adapter.preflight();
          assertPreflightIdentity(adapter, latestPreflight);
          preflight = latestPreflight;
        } catch {
          // Retain the last valid snapshot when the adapter cannot report a
          // newer typed failure state.
        }
        preflight = modelCatalogFailurePreflight(preflight, message);
        models = [];
      }
    }
    if (preflight.readiness.canStart && adapter.readNativeState) {
      try {
        native = await adapter.readNativeState();
      } catch (cause) {
        preflight = appendRuntimeDiagnostic(
          preflight,
          warningDiagnostic(
            'NATIVE_METADATA_UNAVAILABLE',
            'HEALTH',
            'Native runtime metadata is unavailable.',
            cause instanceof Error ? cause.message : String(cause)
          )
        );
      }
    }
    if (preflight.readiness.canStart && adapter.listSessionControls) {
      try {
        sessionControls = await adapter.listSessionControls();
      } catch (cause) {
        preflight = appendRuntimeDiagnostic(
          preflight,
          warningDiagnostic(
            'SESSION_CONTROLS_UNAVAILABLE',
            'HEALTH',
            'Provider-native session controls are unavailable.',
            cause instanceof Error ? cause.message : String(cause)
          )
        );
      }
    }
    return { preflight, models, native, sessionControls, refreshedAt };
  }

  private async getExcludedRuntimeState(
    adapter: AgentRuntimeAdapter,
    refreshedAt: string,
    reason: string
  ): Promise<AgentRuntimeState> {
    return {
      preflight: {
        runtime: adapter.descriptor,
        readiness: createRuntimeReadiness('UNSUPPORTED_SECURITY_POLICY', reason, {
          diagnostics: [
            errorDiagnostic('SECURITY_POLICY_UNSUPPORTED', 'SECURITY', reason)
          ],
          nextAction: {
            kind: 'VIEW_DETAILS',
            label: 'Use the desktop app for agent runs'
          }
        }),
        capabilities: await safeCapabilities(adapter),
      },
      models: [],
      refreshedAt
    };
  }

  private async getDisabledRuntimeState(
    adapter: AgentRuntimeAdapter,
    refreshedAt: string
  ): Promise<AgentRuntimeState> {
    return {
      preflight: {
        runtime: adapter.descriptor,
        readiness: createRuntimeReadiness(
          'DISABLED',
          `${adapter.descriptor.displayName} is disabled in Settings.`,
          {
            diagnostics: [
              warningDiagnostic(
                'RUNTIME_DISABLED',
                'CONFIGURATION',
                `${adapter.descriptor.displayName} is disabled for new agent work.`
              )
            ],
            nextAction: {
              kind: 'CONFIGURE',
              label: 'Enable in Settings'
            }
          }
        ),
        capabilities: await safeCapabilities(adapter)
      },
      models: [],
      refreshedAt
    };
  }
}

function modelCatalogFailurePreflight(
  preflight: AgentPreflight,
  message: string
): AgentPreflight {
  const diagnostic = errorDiagnostic(
    'MODEL_CATALOG_FAILED',
    'MODEL_CATALOG',
    message
  );
  if (!preflight.readiness.canStart) {
    return {
      ...preflight,
      readiness: {
        ...preflight.readiness,
        checks: {
          ...preflight.readiness.checks,
          modelCatalog: 'FAILED'
        },
        diagnostics: [...preflight.readiness.diagnostics, diagnostic]
      }
    };
  }
  return {
    ...preflight,
    readiness: createRuntimeReadiness(
      'FAILED',
      'The runtime model catalog is unavailable.',
      {
        checks: {
          ...preflight.readiness.checks,
          modelCatalog: 'FAILED'
        },
        diagnostics: [...preflight.readiness.diagnostics, diagnostic],
        nextAction: { kind: 'RETRY', label: 'Retry model discovery' }
      }
    )
  };
}

function normalizeRuntimeId(runtimeId: AgentRuntimeId): AgentRuntimeId {
  const normalized = runtimeId.trim();
  if (!normalized || normalized !== runtimeId) {
    throw new Error(`Invalid agent runtime id: ${JSON.stringify(runtimeId)}`);
  }
  return normalized;
}

async function validateAdapterContract(adapter: AgentRuntimeAdapter): Promise<void> {
  if (
    !adapter.descriptor.displayName.trim() ||
    adapter.descriptor.id.trim() !== adapter.descriptor.id
  ) {
    throw new Error('Agent runtime descriptor identity is invalid.');
  }
  const capabilities = await adapter.capabilities();
  if (capabilities.runtimeId !== adapter.descriptor.id) {
    throw new Error(
      `Runtime ${adapter.descriptor.id} returned capabilities for ${capabilities.runtimeId}.`
    );
  }
  const presetIds = new Set<string>();
  for (const preset of capabilities.executionPolicy.presets) {
    if (
      !preset.id.trim() ||
      preset.id !== preset.id.trim() ||
      !preset.label.trim() ||
      !preset.detail.trim() ||
      presetIds.has(preset.id)
    ) {
      throw new Error(
        `Runtime ${adapter.descriptor.id} returned an invalid execution policy preset.`
      );
    }
    presetIds.add(preset.id);
  }
  if (!presetIds.has(capabilities.executionPolicy.defaultPresetId)) {
    throw new Error(
      `Runtime ${adapter.descriptor.id} execution policy has no valid default preset.`
    );
  }
  const requiredMethods: Array<{
    capability: keyof typeof capabilities;
    method: keyof AgentRuntimeAdapter;
  }> = [
    { capability: 'activeTurnSteering', method: 'steerTurn' },
    { capability: 'turnInterruption', method: 'interruptTurn' },
    { capability: 'sessionFork', method: 'forkSession' },
    { capability: 'review', method: 'startReview' },
    { capability: 'goals', method: 'syncGoal' },
    { capability: 'promptRefinement', method: 'refinePrompt' }
  ];
  for (const entry of requiredMethods) {
    const capability = capabilities[entry.capability];
    if (
      typeof capability === 'object' &&
      capability !== null &&
      'maturity' in capability &&
      capability.maturity !== 'unsupported' &&
      typeof adapter[entry.method] !== 'function'
    ) {
      throw new Error(
        `Runtime ${adapter.descriptor.id} declares ${entry.capability} but does not implement ${String(entry.method)}.`
      );
    }
  }
  if (
    capabilities.sessionControls?.maturity === 'stable' &&
    (typeof adapter.listSessionControls !== 'function' ||
      typeof adapter.applySessionControl !== 'function')
  ) {
    throw new Error(
      `Runtime ${adapter.descriptor.id} declares sessionControls but does not implement typed control discovery and mutation.`
    );
  }
}

async function safeCapabilities(
  adapter: AgentRuntimeAdapter
): Promise<AgentRuntimeCapabilities> {
  try {
    const capabilities = await adapter.capabilities();
    if (capabilities.runtimeId === adapter.descriptor.id) {
      return capabilities;
    }
  } catch {
    // A broken capability probe must not hide the health of other runtimes.
  }
  const unavailable = (detail: string): AgentCapability => ({
    maturity: 'unsupported',
    detail
  });
  const detail = 'Runtime capability discovery failed.';
  return {
    runtimeId: adapter.descriptor.id,
    executionPolicy: {
      defaultPresetId: 'unavailable',
      presets: [
        {
          id: 'unavailable',
          label: 'Unavailable',
          detail,
          sandbox: 'READ_ONLY',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          networkAccess: 'DISABLED'
        }
      ],
      detail
    },
    promptRefinement: unavailable(detail),
    modelCatalog: unavailable(detail),
    reasoningEffort: unavailable(detail),
    persistentSessions: unavailable(detail),
    sessionResume: unavailable(detail),
    sessionFork: unavailable(detail),
    activeTurnSteering: unavailable(detail),
    turnInterruption: unavailable(detail),
    truePause: unavailable(detail),
    interactiveApprovals: unavailable(detail),
    userInputRequests: unavailable(detail),
    goals: unavailable(detail),
    plans: unavailable(detail),
    detachedReview: unavailable(detail),
    review: unavailable(detail),
    subagents: unavailable(detail),
    backgroundTerminals: unavailable(detail),
    dynamicTools: unavailable(detail),
    attachmentDelivery: unavailable(detail),
    runtimeRecovery: unavailable(detail),
    extensions: {}
  };
}

function assertPreflightIdentity(
  adapter: AgentRuntimeAdapter,
  preflight: AgentPreflight
): void {
  if (preflight.runtime.id !== adapter.descriptor.id) {
    throw new Error(
      `Runtime ${adapter.descriptor.id} returned preflight for ${preflight.runtime.id}.`
    );
  }
  if (preflight.capabilities.runtimeId !== adapter.descriptor.id) {
    throw new Error(
      `Runtime ${adapter.descriptor.id} returned mismatched preflight capabilities.`
    );
  }
}
