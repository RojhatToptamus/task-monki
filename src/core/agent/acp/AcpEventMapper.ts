import type {
  AgentCommandApprovalDecision,
  AgentExecutionSettings,
  AgentInteractionAction,
  AgentItemStatus,
  AgentItemType,
  AgentJsonValue,
  AgentModel,
  AgentPlanStep
} from '../../../shared/agent';
import {
  flattenSelectOptions,
  type AcpContentBlock,
  type AcpPermissionOption,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionModeState,
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
  if (options.some((option) => option.kind === 'allow_once')) actions.push('ACCEPT');
  if (options.some((option) => option.kind === 'allow_always')) actions.push('ACCEPT_FOR_SESSION');
  if (options.some((option) => option.kind === 'reject_once')) actions.push('DECLINE');
  if (options.some((option) => option.kind === 'reject_always')) actions.push('DECLINE_FOR_SESSION');
  actions.push('CANCEL');
  return actions;
}

export function permissionOutcomeForDecision(
  options: readonly AcpPermissionOption[],
  decision: AgentCommandApprovalDecision
): { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } {
  if (decision.action === 'CANCEL') return { outcome: 'cancelled' };
  const kind =
    decision.action === 'ACCEPT'
      ? 'allow_once'
      : decision.action === 'ACCEPT_FOR_SESSION'
        ? 'allow_always'
        : decision.action === 'DECLINE'
          ? 'reject_once'
          : decision.action === 'DECLINE_FOR_SESSION'
            ? 'reject_always'
            : undefined;
  if (!kind) throw new Error(`ACP cannot represent ${decision.action} as a permission option.`);
  const selected = options.find((option) => option.kind === kind);
  if (!selected) {
    throw new Error(`The ACP agent did not offer a ${kind} permission option.`);
  }
  return { outcome: 'selected', optionId: selected.optionId };
}

export function modelsFromAcpConfig(
  profile: AcpRuntimeProfile,
  sessions: readonly AcpNativeSessionState[],
  inputModalities: string[]
): AgentModel[] {
  const models = new Map<string, AgentModel>();
  const orderedSessions = [...sessions].sort((left, right) =>
    compareStableText(left.sessionId, right.sessionId)
  );

  // Prefer the first-class ACP model catalog over the compatibility config
  // selector, independent of the order in which live sessions were observed.
  for (const session of orderedSessions) {
    const availableModels = [...(session.models?.availableModels ?? [])].sort(
      (left, right) =>
        compareStableText(left.modelId, right.modelId) ||
        compareStableText(left.name, right.name) ||
        compareStableText(left.description ?? '', right.description ?? '')
    );
    for (const model of availableModels) {
      // Model IDs become durable routing identifiers and renderer text. Drop a
      // provider value if credential redaction would alter it; a redacted ID
      // must never become an executable model selection.
      if (redactNativeString(model.modelId) !== model.modelId) continue;
      if (models.has(model.modelId)) continue;
      models.set(model.modelId, {
        id: `${profile.descriptor.id}:${profile.defaultModelProvider}/${model.modelId}`,
        runtimeId: profile.descriptor.id,
        modelProvider: profile.defaultModelProvider,
        model: model.modelId,
        displayName: redactNativeString(model.name),
        description: model.description
          ? redactNativeString(model.description)
          : undefined,
        hidden: false,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        inputModalities,
        isDefault: profile.defaultModel === model.modelId,
        native: redactAcpNativeValue({ source: 'session-models', model })
      });
    }
  }

  for (const session of orderedSessions) {
    const modelConfigs = session.configOptions
      .filter(
        (config): config is Extract<AcpSessionConfigOption, { type: 'select' }> =>
          config.type === 'select' && config.category === 'model'
      )
      .sort((left, right) => compareStableText(left.id, right.id));
    for (const config of modelConfigs) {
      const options = flattenSelectOptions(config).sort(
        (left, right) =>
          compareStableText(left.value, right.value) ||
          compareStableText(left.name, right.name)
      );
      for (const option of options) {
        if (redactNativeString(option.value) !== option.value) continue;
        if (models.has(option.value)) continue;
        models.set(option.value, {
          id: `${profile.descriptor.id}:${profile.defaultModelProvider}/${option.value}`,
          runtimeId: profile.descriptor.id,
          modelProvider: profile.defaultModelProvider,
          model: option.value,
          displayName: redactNativeString(option.name),
          description: option.description
            ? redactNativeString(option.description)
            : undefined,
          hidden: false,
          supportedReasoningEfforts: [],
          serviceTiers: [],
          inputModalities,
          isDefault: profile.defaultModel === option.value,
          native: redactAcpNativeValue({
            configId: config.id,
            category: config.category,
            option
          })
        });
      }
    }
  }
  return [...models.values()].sort(
    (left, right) =>
      compareStableText(left.model, right.model) || compareStableText(left.id, right.id)
  );
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  return {
    ...requested,
    runtimeId: profile.descriptor.id,
    model: safeObservedModel === observedModel ? observedModel : undefined,
    modelProvider: requested.modelProvider ?? profile.defaultModelProvider,
    runtimeOptions: {
      ...requested.runtimeOptions,
      [profile.descriptor.id]: nativeOptionsValue(state)
    }
  };
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
  const configValues = isRecord(value.configValues) ? value.configValues : value;
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
