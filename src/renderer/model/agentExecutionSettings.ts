import type { AgentExecutionSettings, AgentModel } from '../../shared/contracts';

export function resolveModelExecutionSettings(
  models: AgentModel[],
  preferredModel: string | undefined,
  preferredReasoningEffort: string | undefined,
  preferredRuntimeId?: string,
  preferredModelProvider?: string
): AgentExecutionSettings | undefined {
  const selected = selectModel(
    models,
    preferredModel,
    preferredRuntimeId,
    preferredModelProvider
  );
  if (!selected) {
    return undefined;
  }
  return {
    runtimeId: selected.runtimeId,
    model: selected.model,
    modelProvider: selected.modelProvider,
    reasoningEffort: resolveReasoningEffort(selected, preferredReasoningEffort)
  };
}

export function selectModel(
  models: AgentModel[],
  preferredModel: string | undefined,
  preferredRuntimeId?: string,
  preferredModelProvider?: string
): AgentModel | undefined {
  const runtimeModels = preferredRuntimeId
    ? models.filter((model) => model.runtimeId === preferredRuntimeId)
    : models;
  const providerModels = preferredModelProvider
    ? runtimeModels.filter((model) => model.modelProvider === preferredModelProvider)
    : runtimeModels;
  const configuredModel = providerModels.find(
    (model) => model.id === preferredModel || model.model === preferredModel
  );
  if (configuredModel) {
    return configuredModel;
  }
  if (preferredModelProvider) {
    return providerModels.find((model) => model.isDefault) ?? providerModels[0];
  }
  return (
    runtimeModels.find(
      (model) => model.id === preferredModel || model.model === preferredModel
    ) ??
    runtimeModels.find((model) => model.isDefault) ??
    runtimeModels[0]
  );
}

export function resolveReasoningEffort(
  model: AgentModel | undefined,
  preferredReasoningEffort: string | undefined
): string | undefined {
  if (!model) {
    return undefined;
  }
  if (
    preferredReasoningEffort &&
    model.supportedReasoningEfforts.includes(preferredReasoningEffort)
  ) {
    return preferredReasoningEffort;
  }
  return model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0];
}
