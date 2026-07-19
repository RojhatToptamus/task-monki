import {
  type AgentCommandApprovalDecision,
  type AgentExecutionSettings,
  type AgentInteractionAction,
  type AgentItemStatus,
  type AgentItemType,
  type AgentJsonValue,
  type AgentProviderPermissionAction,
  type AgentPlanStep
} from '../../../shared/agent';
import {
  type AcpContentBlock,
  type AcpPermissionOption,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionModeState,
  type AcpStopReason,
  type AcpToolCallStatus,
  type AcpToolKind
} from './AcpProtocol';
import type { AcpRuntimeProfile } from './AcpRuntimeProfiles';
import {
  redactAcpNativeValue,
  redactNativeString
} from './AcpNativeRedaction';

export interface AcpNativeSessionState {
  sessionId: string;
  modes: AcpSessionModeState | null;
  models: AcpSessionModelState | null;
  configOptions: AcpSessionConfigOption[];
}

export function mapAcpToolStatus(status: AcpToolCallStatus | null | undefined): AgentItemStatus {
  switch (status) {
    case 'pending':
      return 'STARTED';
    case 'in_progress':
      return 'IN_PROGRESS';
    case 'completed':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    default:
      return 'UNKNOWN';
  }
}

export function mapAcpToolKind(kind: AcpToolKind | null | undefined): AgentItemType {
  switch (kind) {
    case 'edit':
    case 'delete':
    case 'move':
      return 'FILE_CHANGE';
    case 'execute':
      return 'COMMAND_EXECUTION';
    case 'search':
    case 'fetch':
      return 'WEB_SEARCH';
    case 'think':
      return 'REASONING_SUMMARY';
    default:
      return 'OTHER';
  }
}

export function mapAcpStopReason(
  stopReason: AcpStopReason
): 'completed' | 'failed' | 'interrupted' {
  switch (stopReason) {
    case 'end_turn':
      return 'completed';
    case 'cancelled':
      return 'interrupted';
    case 'refusal':
    case 'max_tokens':
    case 'max_turn_requests':
      return 'failed';
  }
}

export function mapAcpPlanEntries(value: unknown): AgentPlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): AgentPlanStep[] => {
    if (!isRecord(candidate) || typeof candidate.content !== 'string') return [];
    const status: AgentPlanStep['status'] =
      candidate.status === 'completed'
        ? 'COMPLETED'
        : candidate.status === 'in_progress'
          ? 'IN_PROGRESS'
          : 'PENDING';
    return [{ step: candidate.content, status }];
  });
}

export function textFromAcpContent(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== 'text' || typeof value.text !== 'string') {
    return undefined;
  }
  return value.text;
}

export function interactionActionsForAcpOptions(
  options: readonly AcpPermissionOption[]
): AgentInteractionAction[] {
  const actions: AgentInteractionAction[] = [];
  for (const option of options) {
    const action = agentActionForAcpPermissionKind(option.kind);
    if (!actions.includes(action)) actions.push(action);
  }
  actions.push('CANCEL');
  return actions;
}

export function permissionOutcomeForDecision(
  options: readonly AcpPermissionOption[],
  decision: AgentCommandApprovalDecision
): { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } {
  if (decision.action === 'CANCEL') return { outcome: 'cancelled' };
  const providerOptionId =
    'providerOptionId' in decision ? decision.providerOptionId : undefined;
  if (!providerOptionId) {
    throw new Error('An ACP permission response requires the exact provider option ID.');
  }
  const selected = options.find((option) => option.optionId === providerOptionId);
  if (!selected) {
    throw new Error(`The ACP agent did not offer permission option ${providerOptionId}.`);
  }
  if (agentActionForAcpPermissionKind(selected.kind) !== decision.action) {
    throw new Error(
      `ACP permission option ${selected.optionId} does not represent ${decision.action}.`
    );
  }
  return { outcome: 'selected', optionId: selected.optionId };
}

export function agentActionForAcpPermissionKind(
  kind: AcpPermissionOption['kind']
): AgentProviderPermissionAction {
  switch (kind) {
    case 'allow_once':
    case 'allow_always':
      return 'ACCEPT';
    case 'reject_once':
    case 'reject_always':
      return 'DECLINE';
  }
}

export function acpPermissionKindForAgentAction(
  action: AgentProviderPermissionAction,
  providerRemembersChoice: boolean
): AcpPermissionOption['kind'] {
  switch (action) {
    case 'ACCEPT':
      return providerRemembersChoice ? 'allow_always' : 'allow_once';
    case 'DECLINE':
      return providerRemembersChoice ? 'reject_always' : 'reject_once';
  }
}

export function acpPermissionKindRemembersChoice(
  kind: AcpPermissionOption['kind']
): boolean {
  return kind === 'allow_always' || kind === 'reject_always';
}

export function observedSettingsFromAcpState(
  profile: AcpRuntimeProfile,
  state: AcpNativeSessionState,
  requested: AgentExecutionSettings
): AgentExecutionSettings {
  const modelSelector = state.configOptions.find(
    (option): option is Extract<AcpSessionConfigOption, { type: 'select' }> =>
      option.type === 'select' && option.category === 'model'
  );
  const observedModel =
    state.models?.currentModelId ??
    modelSelector?.currentValue ??
    requested.model ??
    profile.defaultModel;
  const safeObservedModel = redactNativeString(observedModel);
  const thoughtLevel = acpThoughtLevelSelector(state);
  const providerModelReasoningEffort = state.models?.availableModels.find(
    (model) => model.modelId === state.models?.currentModelId
  )?.reasoningEffort;
  return {
    ...requested,
    runtimeId: profile.descriptor.id,
    model: safeObservedModel === observedModel ? observedModel : undefined,
    modelProvider: requested.modelProvider ?? profile.defaultModelProvider,
    reasoningEffort:
      thoughtLevel?.currentValue ?? providerModelReasoningEffort ?? undefined,
    runtimeOptions: {
      ...requested.runtimeOptions,
      [profile.descriptor.id]: nativeSelectionOptionsValue(state)
    }
  };
}

export function acpThoughtLevelSelector(
  state: AcpNativeSessionState
): Extract<AcpSessionConfigOption, { type: 'select' }> | undefined {
  return state.configOptions.find(
    (option): option is Extract<AcpSessionConfigOption, { type: 'select' }> =>
      option.type === 'select' && option.category === 'thought_level'
  );
}

export function nativeSelectionOptionsValue(
  state: AcpNativeSessionState
): AgentJsonValue {
  const configValues = Object.fromEntries(
    state.configOptions
      .filter(
        (option) =>
          option.category !== 'model' &&
          option.category !== 'thought_level' &&
          !(state.modes && option.category === 'mode')
      )
      .map((option) => [option.id, option.currentValue])
  );
  return redactAcpNativeValue({
    ...(state.modes?.currentModeId ? { modeId: state.modes.currentModeId } : {}),
    ...(Object.keys(configValues).length > 0 ? { configValues } : {})
  });
}

export function requestedNativeConfigValues(
  runtimeId: string,
  settings: AgentExecutionSettings
): Record<string, string | boolean> {
  const value = settings.runtimeOptions?.[runtimeId];
  if (!isRecord(value)) return {};
  const configValues = isRecord(value.configValues) ? value.configValues : {};
  return Object.fromEntries(
    Object.entries(configValues).filter(
      (entry): entry is [string, string | boolean] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'boolean'
    )
  );
}

export function promptInputModalities(capabilities: {
  image?: boolean;
  audio?: boolean;
} | undefined): string[] {
  return [
    'text',
    ...(capabilities?.image ? ['image'] : []),
    ...(capabilities?.audio ? ['audio'] : [])
  ];
}

export function acpTextBlock(text: string): AcpContentBlock {
  return { type: 'text', text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
