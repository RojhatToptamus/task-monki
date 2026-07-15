import type { AgentModel, AgentProviderState } from '../../shared/agent';
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
    providerId: 'codex',
    defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
    defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
    roleContractVersion: 1,
    revision: 1
  },
  {
    id: 'builtin.skeptic',
    displayName: 'Skeptic',
    roleTemplate: 'SKEPTIC',
    providerId: 'codex',
    defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
    defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
    roleContractVersion: 1,
    revision: 1
  },
  {
    id: 'builtin.verifier',
    displayName: 'Verifier',
    roleTemplate: 'VERIFIER',
    providerId: 'codex',
    defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
    defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
    roleContractVersion: 1,
    revision: 1
  }
];

export interface AgentProfileCatalogSettings {
  defaultModel?: string;
  defaultReasoningEffort?: string;
}

/**
 * Code-defined v1 profiles are stable global identities. Provider availability
 * and concrete model settings are resolved afresh and are snapshotted later by
 * participant revisions; they never mutate the profile definition.
 */
export class AgentProfileCatalog {
  list(
    providerState: AgentProviderState,
    settings: AgentProfileCatalogSettings = {}
  ): AgentProfileCatalogSnapshot {
    const resolved = resolveCatalogSettings(
      providerState.models.filter((model) => model.provider === 'codex'),
      settings
    );
    const unavailableReason =
      providerState.preflight.provider !== 'codex'
        ? 'The configured provider does not match the built-in agent profiles.'
        : providerUnavailableReason(providerState, resolved);
    return {
      profiles: BUILT_IN_PROFILES.map((profile): AgentProfileCatalogEntry => ({
        profile: { ...profile },
        availability: unavailableReason ? 'UNAVAILABLE' : 'AVAILABLE',
        ...(unavailableReason
          ? { unavailableReason }
          : { resolvedSettings: { ...resolved! } })
      })),
      refreshedAt: providerState.refreshedAt
    };
  }

  require(profileId: string): AgentProfileRecord {
    const profile = BUILT_IN_PROFILES.find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new Error(`Unknown agent profile id: ${profileId}`);
    }
    return { ...profile };
  }

  roleContract(profileId: string): string {
    this.require(profileId);
    switch (profileId) {
      case 'builtin.lead':
        return 'Produce the primary answer and respond once to eligible review concerns.';
      case 'builtin.skeptic':
        return 'Challenge material assumptions and identify specific counterexamples.';
      case 'builtin.verifier':
        return 'Check factual claims against the supplied context and evidence boundary.';
      default:
        throw new Error(`Unknown agent profile id: ${profileId}`);
    }
  }
}

function resolveCatalogSettings(
  models: readonly AgentModel[],
  settings: AgentProfileCatalogSettings
): AgentProfileCatalogEntry['resolvedSettings'] | undefined {
  const explicitlySelected = settings.defaultModel
    ? models.find((model) => model.model === settings.defaultModel)
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
    model: selected.model,
    modelProvider: selected.provider === 'codex' ? 'openai' : selected.provider,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(selected.defaultServiceTier ? { serviceTier: selected.defaultServiceTier } : {})
  };
}

function providerUnavailableReason(
  providerState: AgentProviderState,
  settings: AgentProfileCatalogEntry['resolvedSettings'] | undefined
): string | undefined {
  if (!providerState.preflight.ready) {
    return providerState.preflight.problems[0] ?? 'The agent provider is unavailable.';
  }
  if (!settings) {
    return 'No compatible agent model is available.';
  }
  return undefined;
}
