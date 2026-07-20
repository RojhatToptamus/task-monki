import type {
  AgentModel,
  AgentRuntimeCatalog,
  AgentRuntimeState
} from '../../shared/agent';
import type {
  AgentProfileCatalogEntry,
  AgentProfileCatalogSnapshot,
  AgentProfileRecord
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
    const runtimeId = settings.defaultRuntimeId ?? catalog.defaultRuntimeId;
    const runtime = catalog.runtimes.find(
      (candidate) => candidate.preflight.runtime.id === runtimeId
    );
    const resolved = runtime
      ? resolveCatalogSettings(runtime, settings)
      : undefined;
    const unavailableReason = runtimeUnavailableReason(runtime, resolved);
    return {
      profiles: BUILT_IN_PROFILES.map((profile): AgentProfileCatalogEntry => ({
        profile: { ...profile },
        availability: unavailableReason ? 'UNAVAILABLE' : 'AVAILABLE',
        ...(unavailableReason
          ? { unavailableReason }
          : { resolvedSettings: { ...resolved! } })
      })),
      refreshedAt: catalog.refreshedAt
    };
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
  runtime: AgentRuntimeState,
  settings: AgentProfileCatalogSettings
): AgentProfileCatalogEntry['resolvedSettings'] | undefined {
  const models = runtime.models.filter(
    (model) =>
      model.runtimeId === runtime.preflight.runtime.id &&
      (settings.defaultModelProvider === undefined ||
        model.modelProvider === settings.defaultModelProvider)
  );
  const explicitlySelected = settings.defaultModel
    ? models.find(
        (model) =>
          model.id === settings.defaultModel || model.model === settings.defaultModel
      )
    : undefined;
  const visible = models.filter((model) => !model.hidden);
  const selected =
    explicitlySelected ?? visible.find((model) => model.isDefault) ?? visible[0];
  if (!selected) return undefined;

  const preferredEffort = settings.defaultReasoningEffort;
  const reasoningEffort =
    preferredEffort && selected.supportedReasoningEfforts.includes(preferredEffort)
      ? preferredEffort
      : selected.defaultReasoningEffort ?? selected.supportedReasoningEfforts[0];
  return {
    runtimeId: selected.runtimeId,
    model: selected.model,
    modelProvider: selected.modelProvider ?? selected.runtimeId,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(selected.defaultServiceTier ? { serviceTier: selected.defaultServiceTier } : {})
  };
}

function runtimeUnavailableReason(
  runtime: AgentRuntimeState | undefined,
  settings: AgentProfileCatalogEntry['resolvedSettings'] | undefined
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
  if (!settings) return 'No compatible model is available. Check the selected agent in Settings.';
  return undefined;
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
