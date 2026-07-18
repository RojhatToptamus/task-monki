import type { AgentJsonValue } from '../../../shared/agent';
import {
  REDACTED_CREDENTIAL,
  isSensitiveCredentialFieldName,
  redactCredentialText,
  shouldRedactCredentialRecordEntry
} from '../AgentCredentialRedaction';
import type {
  AcpInitializeResponse,
  AcpSessionConfigOption,
  AcpSessionModelState,
  AcpSessionModeState
} from './AcpProtocol';
import type { AcpNativeSessionState } from './AcpEventMapper';

const MAX_NATIVE_DEPTH = 8;
const MAX_NATIVE_COLLECTION = 500;
const MAX_NATIVE_STRING = 4_096;

/** Renderer/persistence-safe view; opaque data remains in the redacted 0600 journal. */
export function redactAcpNativeValue(value: unknown, depth = 0): AgentJsonValue {
  if (depth > MAX_NATIVE_DEPTH) return '[TRUNCATED]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return redactNativeString(value).slice(0, MAX_NATIVE_STRING);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_NATIVE_COLLECTION)
      .map((entry) => redactAcpNativeValue(entry, depth + 1));
  }
  if (typeof value !== 'object' || value === undefined) return String(value);
  const record = value as Record<string, unknown>;
  const result: Record<string, AgentJsonValue> = {};
  for (const [key, nested] of Object.entries(record).slice(0, MAX_NATIVE_COLLECTION)) {
    // `_meta` is explicitly opaque in ACP. It belongs only in the protected
    // raw journal, never in settings, model catalogs, or renderer payloads.
    if (key === '_meta') continue;
    result[key] = shouldRedactCredentialRecordEntry(record, key, nested)
      ? REDACTED_CREDENTIAL
      : redactAcpNativeValue(nested, depth + 1);
  }
  return result;
}

export function sanitizeAcpNativeSession(
  state: AcpNativeSessionState,
  sensitiveValues: readonly string[] = []
): AcpNativeSessionState {
  if (!isSafeOperationalIdentifier(state.sessionId, sensitiveValues)) {
    throw new Error(
      'ACP native session view cannot publish a sensitive operational identifier.'
    );
  }
  const availableModes = (state.modes?.availableModes ?? []).filter((mode) =>
    isSafeOperationalIdentifier(mode.id, sensitiveValues)
  );
  const availableModels = (state.models?.availableModels ?? []).filter((model) =>
    isSafeOperationalIdentifier(model.modelId, sensitiveValues)
  );
  return {
    sessionId: state.sessionId,
    modes: state.modes && availableModes.some((mode) => mode.id === state.modes?.currentModeId)
      ? {
          currentModeId: state.modes.currentModeId,
          availableModes: availableModes.map((mode) => ({
            id: mode.id,
            name: redactCredentialText(mode.name, sensitiveValues),
            description: mode.description
              ? redactCredentialText(mode.description, sensitiveValues)
              : null
          }))
        }
      : null,
    models: state.models && availableModels.some(
      (model) => model.modelId === state.models?.currentModelId
    )
      ? {
          currentModelId: state.models.currentModelId,
          availableModels: availableModels.map((model) => ({
            modelId: model.modelId,
            name: redactCredentialText(model.name, sensitiveValues),
            description: model.description
              ? redactCredentialText(model.description, sensitiveValues)
              : null,
            ...projectReasoningEfforts(model, true, sensitiveValues)
          }))
        }
      : null,
    configOptions: state.configOptions
      .filter(
        (option) =>
          !isSensitiveConfig(option) &&
          isSafeOperationalIdentifier(option.id, sensitiveValues)
      )
      .flatMap((option) => projectConfigOption(option, sensitiveValues))
  };
}

/** Exact operational identifiers/values, with opaque `_meta` removed. */
export function normalizeAcpOperationalSession(
  state: AcpNativeSessionState
): AcpNativeSessionState {
  return {
    sessionId: state.sessionId,
    modes: state.modes
      ? {
          currentModeId: state.modes.currentModeId,
          availableModes: state.modes.availableModes.map((mode) => ({
            id: mode.id,
            name: mode.name,
            description: mode.description ?? null
          }))
        }
      : null,
    models: projectModelState(state.models, false),
    configOptions: state.configOptions.map((option) =>
      option.type === 'boolean'
        ? {
            id: option.id,
            name: option.name,
            description: option.description ?? null,
            category: option.category ?? null,
            type: 'boolean',
            currentValue: option.currentValue
          }
        : {
            id: option.id,
            name: option.name,
            description: option.description ?? null,
            category: option.category ?? null,
            type: 'select',
            currentValue: option.currentValue,
            options: option.options.map((entry) =>
              'options' in entry
                ? {
                    group: entry.group,
                    name: entry.name,
                    options: entry.options.map((nested) => ({
                      value: nested.value,
                      name: nested.name,
                      description: nested.description ?? null
                    }))
                  }
                : {
                    value: entry.value,
                    name: entry.name,
                    description: entry.description ?? null
                  }
            )
          }
    )
  };
}

function projectModelState(
  models: AcpSessionModelState | null,
  redact: boolean
): AcpSessionModelState | null {
  if (!models) return null;
  return {
    currentModelId: redact
      ? redactNativeString(models.currentModelId)
      : models.currentModelId,
    availableModels: models.availableModels.map((model) => ({
      modelId: redact ? redactNativeString(model.modelId) : model.modelId,
      name: redact ? redactNativeString(model.name) : model.name,
      description: model.description
        ? redact
          ? redactNativeString(model.description)
          : model.description
        : null,
      ...projectReasoningEfforts(model, redact)
    }))
  };
}

function projectReasoningEfforts(
  model: AcpSessionModelState['availableModels'][number],
  redact: boolean,
  sensitiveValues: readonly string[] = []
): Pick<
  AcpSessionModelState['availableModels'][number],
  'reasoningEffort' | 'reasoningEfforts'
> {
  const efforts = (model.reasoningEfforts ?? []).filter(
    (effort) =>
      isSafeOperationalIdentifier(effort.id, sensitiveValues) &&
      isSafeOperationalIdentifier(effort.value, sensitiveValues)
  );
  if (
    !model.reasoningEffort ||
    !isSafeOperationalIdentifier(model.reasoningEffort, sensitiveValues) ||
    !efforts.some((effort) => effort.value === model.reasoningEffort)
  ) {
    return {};
  }
  return {
    reasoningEffort: model.reasoningEffort,
    reasoningEfforts: efforts.map((effort) => ({
      id: effort.id,
      value: effort.value,
      label: redact
        ? redactCredentialText(effort.label, sensitiveValues)
        : effort.label,
      description: effort.description
        ? redact
          ? redactCredentialText(effort.description, sensitiveValues)
          : effort.description
        : null,
      default: effort.default
    }))
  };
}

/** Removes opaque provider metadata while retaining exact model identifiers. */
export function normalizeAcpOperationalModelState(
  models: AcpSessionModelState | null
): AcpSessionModelState | null {
  return projectModelState(models, false);
}

export function acpInitializeNativeView(initialize: AcpInitializeResponse | undefined): AgentJsonValue {
  if (!initialize) return null;
  const capabilities = initialize.agentCapabilities;
  return redactAcpNativeValue({
    protocolVersion: initialize.protocolVersion,
    agentInfo: initialize.agentInfo
      ? {
          name: initialize.agentInfo.name,
          title: initialize.agentInfo.title,
          version: initialize.agentInfo.version
        }
      : null,
    agentCapabilities: {
      loadSession: capabilities.loadSession === true,
      promptCapabilities: {
        image: capabilities.promptCapabilities?.image === true,
        audio: capabilities.promptCapabilities?.audio === true,
        embeddedContext: capabilities.promptCapabilities?.embeddedContext === true
      },
      mcpCapabilities: {
        http: capabilities.mcpCapabilities?.http === true,
        sse: capabilities.mcpCapabilities?.sse === true
      },
      sessionCapabilities: {
        list: Boolean(capabilities.sessionCapabilities?.list),
        delete: Boolean(capabilities.sessionCapabilities?.delete),
        additionalDirectories: Boolean(
          capabilities.sessionCapabilities?.additionalDirectories
        ),
        resume: Boolean(capabilities.sessionCapabilities?.resume),
        close: Boolean(capabilities.sessionCapabilities?.close)
      }
    },
    authMethods: initialize.authMethods.map(schemaSelectedAuthMethod)
  });
}

export function sanitizeAcpInitializeResponse(
  initialize: AcpInitializeResponse
): AcpInitializeResponse {
  const view = acpInitializeNativeView(initialize) as {
    protocolVersion: number;
    agentInfo: AcpInitializeResponse['agentInfo'];
    agentCapabilities: {
      loadSession: boolean;
      promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
      mcpCapabilities: { http: boolean; sse: boolean };
      sessionCapabilities: Record<string, boolean>;
    };
    authMethods: unknown[];
  };
  const sessions = view.agentCapabilities.sessionCapabilities;
  return {
    protocolVersion: view.protocolVersion,
    agentInfo: view.agentInfo,
    authMethods: view.authMethods,
    agentCapabilities: {
      loadSession: view.agentCapabilities.loadSession,
      promptCapabilities: view.agentCapabilities.promptCapabilities,
      mcpCapabilities: view.agentCapabilities.mcpCapabilities,
      sessionCapabilities: {
        ...(sessions.list ? { list: {} } : {}),
        ...(sessions.delete ? { delete: {} } : {}),
        ...(sessions.additionalDirectories ? { additionalDirectories: {} } : {}),
        ...(sessions.resume ? { resume: {} } : {}),
        ...(sessions.close ? { close: {} } : {})
      },
      auth: {}
    }
  };
}

export function redactNativeString(value: string): string {
  return redactCredentialText(value);
}

function projectConfigOption(
  option: AcpSessionConfigOption,
  sensitiveValues: readonly string[] = []
): AcpSessionConfigOption[] {
  const common = {
    id: option.id,
    name: redactCredentialText(option.name, sensitiveValues),
    description: option.description
      ? redactCredentialText(option.description, sensitiveValues)
      : null,
    category: option.category
      ? redactCredentialText(option.category, sensitiveValues)
      : null
  };
  if (option.type === 'boolean') {
    return [{
      ...common,
      type: 'boolean',
      currentValue: option.currentValue
    }];
  }
  const options: Extract<
    AcpSessionConfigOption,
    { type: 'select' }
  >['options'] = [];
  for (const entry of option.options) {
    if ('options' in entry) {
      options.push({
        group: redactCredentialText(entry.group, sensitiveValues),
        name: redactCredentialText(entry.name, sensitiveValues),
        options: entry.options
          .filter((nested) =>
            isSafeOperationalIdentifier(nested.value, sensitiveValues)
          )
          .map((nested) => ({
            value: nested.value,
            name: redactCredentialText(nested.name, sensitiveValues),
            description: nested.description
              ? redactCredentialText(nested.description, sensitiveValues)
              : null
          }))
      });
    } else if (isSafeOperationalIdentifier(entry.value, sensitiveValues)) {
      options.push({
        value: entry.value,
        name: redactCredentialText(entry.name, sensitiveValues),
        description: entry.description
          ? redactCredentialText(entry.description, sensitiveValues)
          : null
      });
    }
  }
  if (!flattenProjectedOptions(options).includes(option.currentValue)) return [];
  return [{
    ...common,
    type: 'select',
    currentValue: option.currentValue,
    options
  }];
}

function isSafeOperationalIdentifier(
  value: string,
  sensitiveValues: readonly string[]
): boolean {
  return redactCredentialText(value, sensitiveValues) === value;
}

function flattenProjectedOptions(
  options: Extract<AcpSessionConfigOption, { type: 'select' }>['options']
): string[] {
  return options.flatMap((entry) =>
    'options' in entry
      ? entry.options.map((option) => option.value)
      : [entry.value]
  );
}

function isSensitiveConfig(option: AcpSessionConfigOption): boolean {
  return [option.id, option.name, option.category ?? ''].some(
    isSensitiveCredentialFieldName
  );
}

function schemaSelectedAuthMethod(value: unknown): AgentJsonValue {
  if (!isRecord(value)) return {};
  return redactAcpNativeValue({
    id: stringValue(value.id),
    name: stringValue(value.name),
    description: stringValue(value.description)
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
