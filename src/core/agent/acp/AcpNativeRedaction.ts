import type { AgentJsonValue } from '../../../shared/agent';
import type {
  AcpInitializeResponse,
  AcpSessionConfigOption,
  AcpSessionModeState
} from './AcpProtocol';
import type { AcpNativeSessionState } from './AcpEventMapper';

const MAX_NATIVE_DEPTH = 8;
const MAX_NATIVE_COLLECTION = 500;
const MAX_NATIVE_STRING = 4_096;

/** Renderer/persistence-safe view; lossless opaque data remains in the 0600 journal. */
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
  const result: Record<string, AgentJsonValue> = {};
  for (const [key, nested] of Object.entries(value).slice(0, MAX_NATIVE_COLLECTION)) {
    // `_meta` is explicitly opaque in ACP. It belongs only in the protected
    // raw journal, never in settings, model catalogs, or renderer payloads.
    if (key === '_meta') continue;
    result[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redactAcpNativeValue(nested, depth + 1);
  }
  return result;
}

export function sanitizeAcpNativeSession(state: AcpNativeSessionState): AcpNativeSessionState {
  return {
    sessionId: state.sessionId,
    modes: state.modes
      ? {
          currentModeId: state.modes.currentModeId,
          availableModes: state.modes.availableModes.map((mode) => ({
            id: mode.id,
            name: redactNativeString(mode.name),
            description: mode.description ? redactNativeString(mode.description) : null
          }))
        }
      : null,
    configOptions: state.configOptions
      .filter((option) => !isSensitiveConfig(option))
      .map(projectConfigOption)
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
  return value
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu,
      '$1=[REDACTED]'
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]');
}

function projectConfigOption(option: AcpSessionConfigOption): AcpSessionConfigOption {
  const common = {
    id: option.id,
    name: redactNativeString(option.name),
    description: option.description ? redactNativeString(option.description) : null,
    category: option.category ?? null
  };
  if (option.type === 'boolean') {
    return {
      ...common,
      type: 'boolean',
      currentValue: option.currentValue
    };
  }
  return {
    ...common,
    type: 'select',
    currentValue: option.currentValue,
    options: option.options.map((entry) =>
      'options' in entry
        ? {
            group: entry.group,
            name: redactNativeString(entry.name),
            options: entry.options.map((nested) => ({
              value: nested.value,
              name: redactNativeString(nested.name),
              description: nested.description
                ? redactNativeString(nested.description)
                : null
            }))
          }
        : {
            value: entry.value,
            name: redactNativeString(entry.name),
            description: entry.description ? redactNativeString(entry.description) : null
          }
    )
  };
}

function isSensitiveConfig(option: AcpSessionConfigOption): boolean {
  return [option.id, option.name, option.category ?? ''].some(isSensitiveKey);
}

function isSensitiveKey(key: string): boolean {
  return /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|auth[_-]?token|credential|cookie|password|secret)s?$/iu.test(
    key
  ) || /(?:apiKey|accessToken|authToken|clientSecret)$/u.test(key);
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
