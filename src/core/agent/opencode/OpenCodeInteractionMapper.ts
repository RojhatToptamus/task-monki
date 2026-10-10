import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import type {
  AgentExecutionSettings,
  AgentInteractionDecision,
  AgentInteractionRequestPayload,
  AgentPermissionApprovalRequest,
  AgentJsonValue,
  InteractionRequestType
} from '../../../shared/agent';
import {
  OPENCODE_CLIENT_TOOL_NAMES,
  type OpenCodePermissionRule,
  type OpenCodePermissionRequest,
  type OpenCodeQuestionRequest
} from './OpenCodeProtocol';
import { OPENCODE_RUNTIME_ID } from './OpenCodeRuntimeResolver';

/** `runtimeOptions.opencode.permissionProfile` value selecting the interactive read-only rules. */
const INTERACTIVE_READ_ONLY_PROFILE = 'read-only';

export interface MappedOpenCodeInteraction {
  type: InteractionRequestType;
  request: AgentInteractionRequestPayload;
  providerItemId?: string;
  providerItemPayload?: unknown;
}

/**
 * OpenCode does not provide an OS sandbox. Unknown and mutation-capable tools
 * therefore remain approval-gated in the on-request preset. The execution
 * settings always report `DANGER_FULL_ACCESS`: OpenCode's native permission
 * rules are an approval boundary, not an OS confinement boundary.
 */
export function openCodePermissionRules(
  settings: AgentExecutionSettings
): OpenCodePermissionRule[] {
  assertOpenCodeExecutionSettings(settings);
  if (isOpenCodeInteractiveReadOnlySettings(settings)) {
    return openCodeInteractiveReadOnlyPermissionRules();
  }
  const defaultAction = settings.approvalPolicy === 'never' ? 'allow' : 'ask';
  const taskAction = settings.approvalPolicy === 'never' ? 'allow' : 'deny';
  const networkAction = settings.networkAccess === true ? 'allow' : 'deny';
  return [
    { permission: '*', pattern: '*', action: defaultAction },
    { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'glob', pattern: '*', action: 'allow' },
    { permission: 'grep', pattern: '*', action: 'allow' },
    { permission: 'list', pattern: '*', action: 'allow' },
    { permission: 'lsp', pattern: '*', action: 'allow' },
    { permission: 'question', pattern: '*', action: 'allow' },
    { permission: 'task', pattern: '*', action: taskAction },
    { permission: 'external_directory', pattern: '*', action: defaultAction },
    { permission: 'edit', pattern: '*', action: defaultAction },
    { permission: 'bash', pattern: '*', action: defaultAction },
    { permission: 'webfetch', pattern: '*', action: networkAction },
    { permission: 'websearch', pattern: '*', action: networkAction }
  ];
}

/**
 * Provider-native policy for Task Monki read-only workflows. This policy does
 * not confine the OpenCode process. It only denies mutation-capable OpenCode
 * tools while leaving repository inspection available.
 */
export function openCodeReadOnlyPermissionRules(): OpenCodePermissionRule[] {
  return [
    { permission: '*', pattern: '*', action: 'deny' },
    { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'glob', pattern: '*', action: 'allow' },
    { permission: 'grep', pattern: '*', action: 'allow' },
    { permission: 'list', pattern: '*', action: 'allow' },
    { permission: 'lsp', pattern: '*', action: 'allow' },
    { permission: 'question', pattern: '*', action: 'deny' },
    { permission: 'task', pattern: '*', action: 'deny' },
    { permission: 'external_directory', pattern: '*', action: 'deny' },
    { permission: 'edit', pattern: '*', action: 'deny' },
    { permission: 'bash', pattern: '*', action: 'deny' },
    { permission: 'webfetch', pattern: '*', action: 'deny' },
    { permission: 'websearch', pattern: '*', action: 'deny' }
  ];
}

/**
 * Provider-native policy for interactive read-only work such as the Preview
 * agent. It keeps the read-only workflow denials for mutation, delegation, and
 * web tools, and likewise does not confine the OpenCode process. It also allows
 * native questions and Task Monki's own MCP tools, and asks before any path
 * outside the worktree so the person can consent to reading that folder.
 */
export function openCodeInteractiveReadOnlyPermissionRules(): OpenCodePermissionRule[] {
  const interactive: Partial<Record<string, OpenCodePermissionRule['action']>> = {
    question: 'allow',
    external_directory: 'ask'
  };
  return [
    ...openCodeReadOnlyPermissionRules().map((rule) => ({
      ...rule,
      action: interactive[rule.permission] ?? rule.action
    })),
    ...OPENCODE_CLIENT_TOOL_NAMES.map((permission) => ({
      permission,
      pattern: '*',
      action: 'allow' as const
    }))
  ];
}

/** Whether the settings select OpenCode's interactive read-only permission rules. */
export function isOpenCodeInteractiveReadOnlySettings(settings: AgentExecutionSettings): boolean {
  const native = settings.runtimeOptions?.[OPENCODE_RUNTIME_ID];
  return isRecord(native) && native.permissionProfile === INTERACTIVE_READ_ONLY_PROFILE;
}

/**
 * Native settings for a portable read-only request that still needs questions
 * and consent. OpenCode cannot attest an OS sandbox or an offline process, so
 * the settings report provider-controlled access like the read-only workflows;
 * the recorded permission profile selects the native rules that deny mutation
 * and web tools.
 */
export function openCodeInteractiveReadOnlySettings(
  settings: AgentExecutionSettings
): AgentExecutionSettings {
  const native = settings.runtimeOptions?.[OPENCODE_RUNTIME_ID];
  return {
    ...settings,
    sandbox: 'DANGER_FULL_ACCESS',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    networkAccess: true,
    runtimeOptions: {
      ...settings.runtimeOptions,
      [OPENCODE_RUNTIME_ID]: {
        ...(isRecord(native) ? (native as Record<string, AgentJsonValue>) : {}),
        permissionProfile: INTERACTIVE_READ_ONLY_PROFILE
      }
    }
  };
}

/** OpenCode applies the last matching rule, so the desired suffix is effective. */
export function openCodePermissionRulesEndWith(
  actual: readonly OpenCodePermissionRule[] | undefined,
  expected: readonly OpenCodePermissionRule[]
): boolean {
  if (!actual || actual.length < expected.length) return false;
  const offset = actual.length - expected.length;
  return expected.every((rule, index) => {
    const candidate = actual[offset + index];
    return candidate !== undefined &&
      candidate.permission === rule.permission &&
      candidate.pattern === rule.pattern &&
      candidate.action === rule.action;
  });
}

export function assertOpenCodeExecutionSettings(settings: AgentExecutionSettings): void {
  if (settings.networkAccess !== true) {
    throw new Error(
      'OpenCode cannot attest network-disabled execution because providers, plugins, MCP servers, and shell tools share its credential-bearing process. Enable provider-controlled network access or choose a runtime with an attested network boundary.'
    );
  }
  if (settings.sandbox !== 'DANGER_FULL_ACCESS') {
    throw new Error(
      `OpenCode cannot attest Task Monki's ${settings.sandbox ?? 'restricted'} filesystem sandbox. Use a provider-controlled full-access preset; on-request approvals can still gate native tool mutations.`
    );
  }
  if (settings.approvalPolicy !== 'on-request' && settings.approvalPolicy !== 'never') {
    throw new Error(
      `OpenCode supports only on-request or never approval policies; ${settings.approvalPolicy ?? 'an unspecified policy'} is not enforceable.`
    );
  }
  const native = settings.runtimeOptions?.[OPENCODE_RUNTIME_ID];
  if (
    isRecord(native) &&
    native.permissionProfile !== undefined &&
    (native.permissionProfile !== INTERACTIVE_READ_ONLY_PROFILE ||
      settings.approvalPolicy !== 'on-request')
  ) {
    throw new Error(
      'OpenCode supports only its interactive read-only permission profile, and only with on-request approvals.'
    );
  }
}

export function mapOpenCodePermission(
  permission: OpenCodePermissionRequest,
  worktreePath: string,
  /** Interactive read-only rules deny every mutation tool, so an external directory can only be read. */
  interactiveReadOnly = false
): MappedOpenCodeInteraction {
  const nativeAction =
    typeof permission.action === 'string'
      ? permission.action
      : typeof permission.permission === 'string'
        ? permission.permission
        : 'unknown';
  const action = nativeAction.toLowerCase();
  const resources = firstNonEmptyStringArray(permission.resources, permission.patterns);
  const startedAtMs = permission.time?.created ?? Date.now();
  const providerItemId = permission.source?.callID ?? permission.tool?.callID;
  if (action.includes('bash') || action.includes('shell')) {
    const command =
      nonEmptyStringMetadata(permission.metadata, 'command') ??
      (resources.length > 0 ? resources.join(' && ') : undefined);
    return {
      type: 'COMMAND_APPROVAL',
      providerItemId,
      request: {
        startedAtMs,
        approvalId: permission.id,
        reason: `OpenCode requested ${action} permission.`,
        ...(command ? { command } : {}),
        cwd: stringMetadata(permission.metadata, 'cwd') ?? worktreePath
      }
    };
  }
  if (['edit', 'write', 'patch', 'apply_patch'].some((name) => action.includes(name)) &&
      resources.every((resource) => !/[?*]/u.test(resource))) {
    const changes = resources.map((resource) => ({ path: resource, kind: action, diff: '' }));
    return {
      type: 'FILE_CHANGE_APPROVAL',
      providerItemId,
      providerItemPayload: { changes },
      request: {
        startedAtMs,
        reason: `OpenCode requested ${action} permission.`,
        changes
      }
    };
  }
  const network = action.includes('web') || action.includes('network');
  const readOnly =
    action.includes('read') || (interactiveReadOnly && action === 'external_directory');
  return {
    type: 'PERMISSION_APPROVAL',
    providerItemId,
    request: {
      startedAtMs,
      cwd: worktreePath,
      reason: `OpenCode requested ${action} permission.`,
      permissions: network
        ? { network: { enabled: true } }
        : {
            fileSystem: {
              entries: resources.map((resource) => ({
                path: mapResourcePath(resource, worktreePath),
                access: readOnly ? 'read' : 'write'
              }))
            }
          }
    }
  };
}

export function mapOpenCodeQuestion(
  request: OpenCodeQuestionRequest
): MappedOpenCodeInteraction {
  return {
    type: 'USER_INPUT',
    providerItemId: request.tool?.callID,
    request: {
      questions: request.questions.map((question, index) => ({
        id: questionId(request.id, index),
        header: question.header,
        question: question.question,
        isOther: question.custom !== false,
        isSecret: looksLikeSecretQuestion(question.header, question.question),
        allowsMultiple: question.multiple === true ? true : undefined,
        options: question.options?.map((option) => ({
          label: option.label,
          description: option.description ?? ''
        }))
      }))
    }
  };
}

export function mapOpenCodeInteractionResponse(
  decision: AgentInteractionDecision,
  request: AgentInteractionRequestPayload
): { path: 'permission' | 'question'; body: unknown } {
  if (decision.interactionType === 'USER_INPUT') {
    const questions = (request as Extract<AgentInteractionRequestPayload, { questions: unknown }>).questions;
    return {
      path: 'question',
      body: {
        answers: questions.map((question) => decision.answers[question.id] ?? [])
      }
    };
  }
  const action = decision.action;
  if (
    action === 'ACCEPT_FOR_SESSION' ||
    action === 'GRANT_SESSION' ||
    action === 'DECLINE_FOR_SESSION'
  ) {
    throw new Error(
      'OpenCode does not expose a session-scoped permission reply through its public API.'
    );
  }
  if (decision.interactionType === 'PERMISSION_APPROVAL' && action === 'GRANT_TURN' &&
      !isDeepStrictEqual(decision.permissions, (request as AgentPermissionApprovalRequest).permissions)) {
    throw new Error('OpenCode can approve only the complete permission request.');
  }
  return {
    path: 'permission',
    body: {
      reply:
        action === 'DECLINE' ||
        action === 'CANCEL'
          ? 'reject'
          : 'once'
    }
  };
}

function questionId(requestId: string, index: number): string {
  return `${requestId}:${index}`;
}

function mapResourcePath(resource: string, worktreePath: string): AgentJsonValue {
  // A trailing directory wildcard has the same scope as a directory path grant.
  // Keep other patterns non-concrete so the shared policy rejects them.
  const directory = resource.replace(/\/\*{1,2}$/, '');
  if (/[?*]/u.test(directory) || !directory || directory.includes('\0')) {
    return { type: 'pattern', pattern: resource };
  }
  const expanded = directory.replace(/^(?:~|\$HOME)(?=\/|$)/u, os.homedir());
  return { type: 'path', path: path.resolve(worktreePath, expanded) };
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function nonEmptyStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = stringMetadata(metadata, key);
  return value?.trim() ? value : undefined;
}

function firstNonEmptyStringArray(...candidates: unknown[]): string[] {
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const values = candidate.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    );
    if (values.length > 0) return values;
  }
  return [];
}

function looksLikeSecretQuestion(header: string, question: string): boolean {
  return /\b(?:api[ -]?key|access[ -]?token|secret|password|credential|private[ -]?key)\b/iu.test(
    `${header} ${question}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
