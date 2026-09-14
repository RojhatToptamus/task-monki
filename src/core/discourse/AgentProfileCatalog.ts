import type {
  AgentModel,
  AgentRuntimeCatalog,
  AgentRuntimeState
} from '../../shared/agent';
import { projectAgentExecutionSupport } from '../../shared/agentExecutionSupport';
import type {
  AgentProfileCatalogEntry,
  AgentProfileCatalogSnapshot,
  AgentProfileRecord,
  DiscourseAgentSelectionInput
} from '../../shared/discourse';

const BUILT_IN_PROFILES: readonly AgentProfileRecord[] = [
  {
    id: 'builtin.lead',
    displayName: 'A',
    roleTemplate: 'GENERAL',
    defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
    defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
    roleContractVersion: 4,
    revision: 2
  },
  {
    id: 'builtin.skeptic',
    displayName: 'B',
    roleTemplate: 'GENERAL',
    defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
    defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
    roleContractVersion: 4,
    revision: 2
  },
  {
    id: 'builtin.verifier',
    displayName: 'C',
    roleTemplate: 'GENERAL',
    defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
    defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
    roleContractVersion: 4,
    revision: 2
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
        );
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
    if (version === 4) return 'Answer the assigned question using concise claims, evidence, assumptions, and uncertainty. No permanent adversarial role or authority applies. Agreement, no issue found, uncertainty, and abstention are valid. Never invent criticism or evidence. Change position only for an explicit reason.';
    throw new Error(`Retired role contract version ${version} cannot start new work for ${profileId}.`);
  }
}


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
    ...(selected.modelProvider ? { modelProvider: selected.modelProvider } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(selected.defaultServiceTier ? { serviceTier: selected.defaultServiceTier } : {})
  };
}

export function discourseRuntimeUnavailableReason(
  runtime: AgentRuntimeState | undefined
): string | undefined {
  if (!runtime) return 'The selected agent connection is not configured.';
  if (!runtime.preflight.readiness.canStart) {
    return runtime.preflight.readiness.detail;
  }
  const support = projectAgentExecutionSupport(
    runtime.preflight.capabilities,
    'DISCOURSE'
  );
  return support.supported ? undefined : support.reason;
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
    model.modelProvider === revision.modelProvider
  );
}
