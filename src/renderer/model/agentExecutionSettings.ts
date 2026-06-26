import type { AgentExecutionSettings, AgentModel } from '../../shared/contracts';

export function resolveModelExecutionSettings(
  models: AgentModel[],
  preferredModel: string | undefined,
  preferredReasoningEffort: string | undefined
): AgentExecutionSettings | undefined {
  const selected = selectModel(models, preferredModel);
  if (!selected) {
    return undefined;
  }
  return {
    model: selected.model,
    modelProvider: 'openai',
    reasoningEffort: resolveReasoningEffort(selected, preferredReasoningEffort)
  };
}

export function selectModel(
  models: AgentModel[],
  preferredModel: string | undefined
): AgentModel | undefined {
  return (
    models.find((model) => model.model === preferredModel) ??
    models.find((model) => model.isDefault) ??
    models[0]
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
