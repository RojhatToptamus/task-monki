import type {
  AgentModel,
  AgentRuntimeCatalog,
  AgentRuntimeState
} from '../../shared/agent';
import type {
  AgentProfileCatalogEntry,
  AgentProfileCatalogSnapshot,
  AgentProfileRecord,
  DiscourseAgentSelectionInput
} from '../../shared/discourse';

const BUILT_IN_PROFILES: readonly AgentProfileRecord[] = [
  {
    id: 'builtin.lead',
    displayName: 'Lead',
    roleTemplate: 'LEAD',
    defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
    defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
    roleContractVersion: 3,
    revision: 1
  },
  {
    id: 'builtin.skeptic',
    displayName: 'Skeptic',
    roleTemplate: 'SKEPTIC',
    defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
    defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
    roleContractVersion: 3,
    revision: 1
  },
  {
    id: 'builtin.verifier',
    displayName: 'Verifier',
    roleTemplate: 'VERIFIER',
    defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
    defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
    roleContractVersion: 3,
    revision: 1
  }
];

export interface AgentProfileCatalogSettings {
  defaultRuntimeId?: string;
  defaultModel?: string;
  defaultModelProvider?: string;
  defaultReasoningEffort?: string;
}

/**
 * Code-defined roles stay globally stable while every participant revision
 * snapshots a runtime-qualified model. Runtime drift never silently reroutes
 * an existing participant to a different integration or upstream provider.
 */
export class AgentProfileCatalog {
  list(
    catalog: AgentRuntimeCatalog,
    settings: AgentProfileCatalogSettings = {}
  ): AgentProfileCatalogSnapshot {
    const eligibleRuntime = orderedRuntimes(catalog, settings.defaultRuntimeId).find(
      (runtime) => !discourseRuntimeUnavailableReason(runtime)
    );
    let resolved: AgentProfileCatalogEntry['resolvedSettings'];
    if (eligibleRuntime) {
      try {
        resolved = resolveCatalogSettings(catalog, {}, settings);
      } catch {
        resolved = undefined;
      }
    }
    const unavailableReason = eligibleRuntime
      ? undefined
      : discourseRuntimeUnavailableReason(
          catalog.runtimes.find(
            (runtime) => runtime.preflight.runtime.id === settings.defaultRuntimeId
          ) ?? catalog.runtimes[0]
        ) ?? 'No agent can confirm the read-only, offline access required by Discourse.';
    return {
      profiles: BUILT_IN_PROFILES.map((profile): AgentProfileCatalogEntry => ({
        profile: { ...profile },
        availability: unavailableReason ? 'UNAVAILABLE' : 'AVAILABLE',
        ...(unavailableReason
          ? { unavailableReason }
          : resolved
            ? { resolvedSettings: { ...resolved } }
            : { configurationRequired: true })
      })),
      refreshedAt: catalog.refreshedAt
    };
  }

  resolveSelection(
    catalog: AgentRuntimeCatalog,
    selection: DiscourseAgentSelectionInput,
    settings: AgentProfileCatalogSettings = {}
  ): NonNullable<AgentProfileCatalogEntry['resolvedSettings']> {
    this.require(selection.agentProfileId);
    return resolveCatalogSettings(catalog, selection, settings);
  }

  require(profileId: string): AgentProfileRecord {
    const profile = BUILT_IN_PROFILES.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`Unknown agent profile id: ${profileId}`);
    return { ...profile };
  }

  roleContract(profileId: string, version = this.require(profileId).roleContractVersion): string {
    this.require(profileId);
    const contract = ROLE_CONTRACTS[profileId]?.[version];
    if (!contract) {
      throw new Error(`Unknown role contract version ${version} for ${profileId}.`);
    }
    return contract;
  }
}

const ROLE_CONTRACTS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  'builtin.lead': {
    1: 'Produce the primary answer and respond once to eligible review concerns.',
    2: 'Synthesize the strongest actionable answer. Weigh tradeoffs, rank the decision criteria, and respond once to eligible review concerns.',
    3: 'Own the decision synthesis. Make and bound an actionable choice, explain the deciding tradeoff, give the concrete next step, and surface the strongest credible caveat or alternative. In an independent Panel answer, emphasize the operating path instead of listing generic risks or trying to anticipate another panelist. Respond once to eligible review concerns.'
  },
  'builtin.skeptic': {
    1: 'Challenge material assumptions and identify specific counterexamples.',
    2: 'Independently seek the strongest conclusion-changing counterexample. Do not echo another plausible answer; if you agree, surface a distinct residual risk, missing assumption, or disconfirming test.',
    3: 'Take an adversarial decision lens. Develop the strongest credible counter-position or boundary condition, identify the hidden assumption or failure mode that would change the decision, and name the evidence or test that would discriminate. Do not spend an independent Panel answer paraphrasing the likely consensus; if the bottom line is obvious, focus on the distinct reasoning and decision-changing caveat.'
  },
  'builtin.verifier': {
    1: 'Check factual claims against the supplied context and evidence boundary.',
    2: 'Audit factual claims against exact supplied evidence. Separate verified facts from inference, call out unsupported certainty, and identify the smallest check that would resolve remaining uncertainty.',
    3: 'Take an evidence-audit lens. Separate supplied facts, inference, and unknowns; identify the claim on which the decision actually turns; and name the smallest check that would resolve it. In an independent Panel answer, center evidentiary confidence and avoid duplicating a general recommendation unless the evidence boundary changes it.'
  }
};

function resolveCatalogSettings(
  catalog: AgentRuntimeCatalog,
  selection: Pick<
    DiscourseAgentSelectionInput,
    'runtimeId' | 'modelId' | 'reasoningEffort'
  >,
  settings: AgentProfileCatalogSettings
): NonNullable<AgentProfileCatalogEntry['resolvedSettings']> {
  if (Boolean(selection.runtimeId) !== Boolean(selection.modelId)) {
    throw new Error('A Discourse agent selection requires both an agent provider and model.');
  }
  const explicitlySelectedRuntime = selection.runtimeId
    ? catalog.runtimes.find(
        (runtime) => runtime.preflight.runtime.id === selection.runtimeId
      )
    : undefined;
  if (selection.runtimeId && !explicitlySelectedRuntime) {
    throw new Error('The selected Discourse agent provider is no longer available.');
  }
  const runtimes = explicitlySelectedRuntime
    ? [explicitlySelectedRuntime]
    : orderedRuntimes(catalog, settings.defaultRuntimeId);
  let selectedRuntime: AgentRuntimeState | undefined;
  let selected: AgentModel | undefined;
  for (const runtime of runtimes) {
    const unavailable = discourseRuntimeUnavailableReason(runtime);
    if (unavailable) {
      if (selection.runtimeId) throw new Error(unavailable);
      continue;
    }
    const models = runtime.models.filter(
      (model) => model.runtimeId === runtime.preflight.runtime.id
    );
    if (selection.modelId) {
      selected = models.find((model) => model.id === selection.modelId);
      if (!selected) {
        throw new Error('The selected Discourse model is no longer available.');
      }
    } else {
      const preferred = settings.defaultModel
        ? models.find(
            (model) =>
              (settings.defaultModelProvider === undefined ||
                model.modelProvider === settings.defaultModelProvider) &&
              (model.id === settings.defaultModel || model.model === settings.defaultModel)
          )
        : undefined;
      const visible = models.filter((model) => !model.hidden);
      selected = preferred ?? visible.find((model) => model.isDefault) ?? visible[0];
    }
    if (selected) {
      selectedRuntime = runtime;
      break;
    }
    if (selection.runtimeId) break;
  }
  if (!selectedRuntime || !selected) {
    throw new Error('No compatible Discourse model is available. Load models or choose another agent provider.');
  }

  const preferredEffort = selection.reasoningEffort ?? settings.defaultReasoningEffort;
  if (
    selection.reasoningEffort &&
    selection.reasoningEffort !== selected.defaultReasoningEffort &&
    !selected.supportedReasoningEfforts.includes(selection.reasoningEffort)
  ) {
    throw new Error(
      `${selection.reasoningEffort} reasoning is not supported by ${selected.displayName}.`
    );
  }
  const reasoningEffort =
    preferredEffort && selected.supportedReasoningEfforts.includes(preferredEffort)
      ? preferredEffort
      : selected.defaultReasoningEffort ?? selected.supportedReasoningEfforts[0];
  return {
    runtimeId: selectedRuntime.preflight.runtime.id,
    modelId: selected.id,
    model: selected.model,
    modelProvider: selected.modelProvider ?? selected.runtimeId,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(selected.defaultServiceTier ? { serviceTier: selected.defaultServiceTier } : {})
  };
}

export function discourseRuntimeUnavailableReason(
  runtime: AgentRuntimeState | undefined
): string | undefined {
  if (!runtime) return 'The selected agent connection is not configured.';
  if (!runtime.preflight.readiness.canStart) {
    return 'The selected agent is unavailable. Check its connection in Settings.';
  }
  const discourseCapability = runtime.preflight.capabilities.extensions['task-monki.discourse'];
  if (discourseCapability?.maturity !== 'stable') {
    return 'This agent cannot confirm the read-only, offline access required by Discourse.';
  }
  const readOnlyPreset = runtime.preflight.capabilities.executionPolicy.presets.find(
    (preset) =>
      preset.sandbox === 'READ_ONLY' &&
      preset.networkAccess === 'DISABLED' &&
      preset.approvalPolicy.toLowerCase() === 'never'
  );
  if (!readOnlyPreset) {
    return 'This agent cannot confirm the read-only, offline access required by Discourse.';
  }
  return undefined;
}

function orderedRuntimes(
  catalog: AgentRuntimeCatalog,
  preferredRuntimeId?: string
): AgentRuntimeState[] {
  const ids = [preferredRuntimeId, catalog.defaultRuntimeId].filter(
    (id, index, values): id is string => Boolean(id) && values.indexOf(id) === index
  );
  return [
    ...ids.flatMap((id) =>
      catalog.runtimes.filter((runtime) => runtime.preflight.runtime.id === id)
    ),
    ...catalog.runtimes.filter(
      (runtime) => !ids.includes(runtime.preflight.runtime.id)
    )
  ];
}

export function discourseModelMatches(
  model: AgentModel,
  revision: Pick<
    NonNullable<AgentProfileCatalogEntry['resolvedSettings']>,
    'runtimeId' | 'model' | 'modelProvider'
  >
): boolean {
  return (
    model.runtimeId === revision.runtimeId &&
    model.model === revision.model &&
    (model.modelProvider ?? model.runtimeId) === revision.modelProvider
  );
}
