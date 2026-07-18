import path from 'node:path';
import type {
  AgentExecutionSettings,
  AgentInteractionDecision,
  AgentInteractionRequestPayload,
  InteractionRequestType
} from '../../../shared/agent';
import type {
  OpenCodePermissionRule,
  OpenCodePermissionRequest,
  OpenCodeQuestionRequest
} from './OpenCodeProtocol';

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
  const mutationAction = settings.approvalPolicy === 'never' ? 'allow' : 'ask';
  const externalDirectoryAction = settings.approvalPolicy === 'never' ? 'allow' : 'ask';
  const taskAction = settings.approvalPolicy === 'never' ? 'allow' : 'deny';
  const networkAction = settings.networkAccess === true ? 'allow' : 'deny';
  return [
    { permission: '*', pattern: '*', action: 'ask' },
    { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'glob', pattern: '*', action: 'allow' },
    { permission: 'grep', pattern: '*', action: 'allow' },
    { permission: 'list', pattern: '*', action: 'allow' },
    { permission: 'lsp', pattern: '*', action: 'allow' },
    { permission: 'question', pattern: '*', action: 'allow' },
    { permission: 'task', pattern: '*', action: taskAction },
    { permission: 'external_directory', pattern: '*', action: externalDirectoryAction },
    { permission: 'edit', pattern: '*', action: mutationAction },
    { permission: 'bash', pattern: '*', action: mutationAction },
    { permission: 'webfetch', pattern: '*', action: networkAction },
    { permission: 'websearch', pattern: '*', action: networkAction }
  ];
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
}

export function mapOpenCodePermission(
  permission: OpenCodePermissionRequest,
  worktreePath: string
): MappedOpenCodeInteraction {
  const action = (permission.action ?? permission.permission ?? 'unknown').toLowerCase();
  const resources = permission.resources ?? permission.patterns ?? [];
  const startedAtMs = permission.time?.created ?? Date.now();
  const providerItemId = permission.source?.callID ?? permission.tool?.callID;
  if (action.includes('bash') || action.includes('shell')) {
    const command = stringMetadata(permission.metadata, 'command') ?? resources.join(' && ');
    return {
      type: 'COMMAND_APPROVAL',
      providerItemId,
      request: {
        startedAtMs,
        approvalId: permission.id,
        reason: `OpenCode requested ${action} permission.`,
        command,
        cwd: stringMetadata(permission.metadata, 'cwd') ?? worktreePath
      }
    };
  }
  if (['edit', 'write', 'patch', 'apply_patch'].some((name) => action.includes(name))) {
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
  const readOnly = action.includes('read') || action.includes('external_directory');
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
                path: { path: normalizeResourcePath(resource, worktreePath) },
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
        isOther: question.custom === true,
        isSecret: looksLikeSecretQuestion(question.header, question.question),
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
  return {
    path: 'permission',
    body: {
      reply:
        action === 'ACCEPT_FOR_SESSION' || action === 'GRANT_SESSION'
          ? 'always'
          : action === 'DECLINE' ||
              action === 'DECLINE_FOR_SESSION' ||
              action === 'CANCEL'
            ? 'reject'
            : 'once'
    }
  };
}

function questionId(requestId: string, index: number): string {
  return `${requestId}:${index}`;
}

function normalizeResourcePath(resource: string, worktreePath: string): string {
  return path.isAbsolute(resource) ? resource : path.resolve(worktreePath, resource);
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function looksLikeSecretQuestion(header: string, question: string): boolean {
  return /\b(?:api[ -]?key|access[ -]?token|secret|password|credential|private[ -]?key)\b/iu.test(
    `${header} ${question}`
  );
}
