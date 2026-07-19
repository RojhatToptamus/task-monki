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
  redactNativeString,
  sanitizeAcpNativeSession
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
      return 'ACCEPT';
    case 'allow_always':
      return 'ACCEPT_FOR_SESSION';
    case 'reject_once':
      return 'DECLINE';
    case 'reject_always':
      return 'DECLINE_FOR_SESSION';
  }
}

export function acpPermissionKindForAgentAction(
  action: AgentProviderPermissionAction
): AcpPermissionOption['kind'] {
  switch (action) {
    case 'ACCEPT':
      return 'allow_once';
    case 'ACCEPT_FOR_SESSION':
      return 'allow_always';
    case 'DECLINE':
      return 'reject_once';
    case 'DECLINE_FOR_SESSION':
      return 'reject_always';
  }
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
      [profile.descriptor.id]: nativeOptionsValue(state)
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

export function nativeOptionsValue(state: AcpNativeSessionState): AgentJsonValue {
  const safe = sanitizeAcpNativeSession(state);
  return redactAcpNativeValue({
    modes: safe.modes,
    models: safe.models,
    configOptions: safe.configOptions
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
