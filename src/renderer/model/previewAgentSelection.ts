import type { AgentExecutionSettings, AgentRuntimeState, RunRecord } from '../../shared/contracts';
import { runtimeExecutionUnavailableReason } from './runtimeReadiness';

/** Execution identity survives catalog loading; a missing catalog entry never selects another model. */
export interface PreviewAgentSelection extends Pick<AgentExecutionSettings, 'model' | 'modelProvider' | 'reasoningEffort'> {
  runtimeId: string;
}

export type PreviewAgentDefaults = PreviewAgentSelection;

/** Continue the last requested conversation, otherwise start with the Settings default. */
export function initialPreviewAgentSelection(runs: readonly RunRecord[], defaults: PreviewAgentDefaults): PreviewAgentSelection {
  const latest = [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  // Sessions are keyed by the requested model, not a provider's resolved alias.
  const settings = latest?.requestedSettings;
  return latest ? {
    runtimeId: latest.runtimeId,
    model: settings?.model,
    modelProvider: settings?.modelProvider,
    reasoningEffort: settings?.reasoningEffort
  } : {
    runtimeId: defaults.runtimeId,
    model: defaults.model,
    modelProvider: defaults.modelProvider,
    reasoningEffort: defaults.reasoningEffort
  };
}

export function previewAgentUnavailableReason(selection: PreviewAgentSelection, runtimes: AgentRuntimeState[]): string | undefined {
  return runtimeExecutionUnavailableReason(
    runtimes.find((runtime) => runtime.preflight.runtime.id === selection.runtimeId), 'PREVIEW_AGENT'
  );
}
