import type {
  AgentCommandApprovalRequest,
  AgentDynamicToolRequest,
  AgentFileChangeApprovalRequest,
  AgentInteractionDecision,
  AgentInteractionRequestPayload,
  AgentJsonValue,
  AgentMcpElicitationRequest,
  AgentPermissionApprovalRequest,
  AgentPermissionProfile,
  AgentUserInputRequest,
  InteractionRequestType
} from '../../../shared/contracts';
import type { ServerRequest } from './protocol/generated/ServerRequest';
import type { CommandExecutionRequestApprovalResponse } from './protocol/generated/v2/CommandExecutionRequestApprovalResponse';
import type { DynamicToolCallResponse } from './protocol/generated/v2/DynamicToolCallResponse';
import type { FileChangeRequestApprovalResponse } from './protocol/generated/v2/FileChangeRequestApprovalResponse';
import type { McpServerElicitationRequestResponse } from './protocol/generated/v2/McpServerElicitationRequestResponse';
import type { PermissionsRequestApprovalResponse } from './protocol/generated/v2/PermissionsRequestApprovalResponse';
import type { GrantedPermissionProfile } from './protocol/generated/v2/GrantedPermissionProfile';
import type { RequestPermissionProfile } from './protocol/generated/v2/RequestPermissionProfile';
import type { ToolRequestUserInputResponse } from './protocol/generated/v2/ToolRequestUserInputResponse';

export interface MappedCodexInteraction {
  type: InteractionRequestType;
  request: AgentInteractionRequestPayload;
}

export function mapCodexInteractionRequest(
  request: ServerRequest
): MappedCodexInteraction | undefined {
  switch (request.method) {
    case 'item/commandExecution/requestApproval': {
      const params = request.params;
      const mapped: AgentCommandApprovalRequest = {
        startedAtMs: params.startedAtMs,
        approvalId: params.approvalId ?? undefined,
        reason: params.reason ?? undefined,
        command: params.command ?? undefined,
        cwd: params.cwd ?? undefined,
        commandActions: asJsonArray(params.commandActions),
        networkApprovalContext: params.networkApprovalContext
          ? {
              host: params.networkApprovalContext.host,
              protocol: params.networkApprovalContext.protocol
            }
          : undefined,
        proposedExecPolicyAmendment: params.proposedExecpolicyAmendment ?? undefined,
        proposedNetworkPolicyAmendments:
          params.proposedNetworkPolicyAmendments?.map((amendment) => ({
            host: amendment.host,
            action: amendment.action
          })) ?? undefined
      };
      return { type: 'COMMAND_APPROVAL', request: mapped };
    }
    case 'item/fileChange/requestApproval': {
      const mapped: AgentFileChangeApprovalRequest = {
        startedAtMs: request.params.startedAtMs,
        reason: request.params.reason ?? undefined,
        grantRoot: request.params.grantRoot ?? undefined
      };
      return { type: 'FILE_CHANGE_APPROVAL', request: mapped };
    }
    case 'item/permissions/requestApproval': {
      const mapped: AgentPermissionApprovalRequest = {
        startedAtMs: request.params.startedAtMs,
        environmentId: request.params.environmentId ?? undefined,
        cwd: request.params.cwd,
        reason: request.params.reason ?? undefined,
        permissions: mapPermissionProfile(request.params.permissions)
      };
      return { type: 'PERMISSION_APPROVAL', request: mapped };
    }
    case 'mcpServer/elicitation/request': {
      const params = request.params;
      const mapped: AgentMcpElicitationRequest =
        params.mode === 'form'
          ? {
              mode: 'form',
              serverName: params.serverName,
              message: params.message,
              metadata: asJsonValue(params._meta) ?? undefined,
              requestedSchema: params.requestedSchema as unknown as {
                [key: string]: AgentJsonValue;
              }
            }
          : {
              mode: 'url',
              serverName: params.serverName,
              message: params.message,
              metadata: asJsonValue(params._meta) ?? undefined,
              url: params.url,
              elicitationId: params.elicitationId
            };
      return { type: 'MCP_ELICITATION', request: mapped };
    }
    case 'item/tool/requestUserInput': {
      const mapped: AgentUserInputRequest = {
        autoResolutionMs: request.params.autoResolutionMs ?? undefined,
        questions: request.params.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          isOther: question.isOther,
          isSecret: question.isSecret,
          options: question.options ?? undefined
        }))
      };
      return { type: 'USER_INPUT', request: mapped };
    }
    case 'item/tool/call': {
      const mapped: AgentDynamicToolRequest = {
        callId: request.params.callId,
        namespace: request.params.namespace ?? undefined,
        tool: request.params.tool,
        arguments: request.params.arguments as AgentJsonValue
      };
      return { type: 'DYNAMIC_TOOL', request: mapped };
    }
    default:
      return undefined;
  }
}

export function mapCodexInteractionResponse(
  decision: AgentInteractionDecision
): unknown {
  switch (decision.interactionType) {
    case 'COMMAND_APPROVAL': {
      let mapped: CommandExecutionRequestApprovalResponse['decision'];
      switch (decision.action) {
        case 'ACCEPT':
          mapped = 'accept';
          break;
        case 'ACCEPT_FOR_SESSION':
          mapped = 'acceptForSession';
          break;
        case 'ACCEPT_EXEC_POLICY_AMENDMENT':
          mapped = {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: decision.amendment
            }
          };
          break;
        case 'APPLY_NETWORK_POLICY_AMENDMENT':
          mapped = {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: decision.amendment
            }
          };
          break;
        case 'DECLINE':
          mapped = 'decline';
          break;
        case 'DECLINE_FOR_SESSION':
          throw new Error('Codex does not expose a persistent command-denial decision.');
        case 'CANCEL':
          mapped = 'cancel';
          break;
      }
      return { decision: mapped } satisfies CommandExecutionRequestApprovalResponse;
    }
    case 'FILE_CHANGE_APPROVAL': {
      const mapped: FileChangeRequestApprovalResponse['decision'] =
        decision.action === 'ACCEPT'
          ? 'accept'
          : decision.action === 'ACCEPT_FOR_SESSION'
            ? 'acceptForSession'
            : decision.action === 'DECLINE'
              ? 'decline'
              : 'cancel';
      return { decision: mapped } satisfies FileChangeRequestApprovalResponse;
    }
    case 'PERMISSION_APPROVAL': {
      const response: PermissionsRequestApprovalResponse =
        decision.action === 'DECLINE'
          ? { permissions: {}, scope: 'turn' }
          : {
              permissions: mapGrantedPermissions(decision.permissions),
              scope: decision.action === 'GRANT_SESSION' ? 'session' : 'turn'
            };
      return response;
    }
    case 'MCP_ELICITATION': {
      const response: McpServerElicitationRequestResponse =
        decision.action === 'ACCEPT'
          ? { action: 'accept', content: decision.content, _meta: null }
          : {
              action: decision.action === 'DECLINE' ? 'decline' : 'cancel',
              content: null,
              _meta: null
            };
      return response;
    }
    case 'USER_INPUT': {
      const response: ToolRequestUserInputResponse = {
        answers: Object.fromEntries(
          Object.entries(decision.answers).map(([id, answers]) => [
            id,
            { answers }
          ])
        )
      };
      return response;
    }
    case 'DYNAMIC_TOOL': {
      const response: DynamicToolCallResponse = {
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: 'Task Monki did not register this dynamic client tool.'
          }
        ]
      };
      return response;
    }
  }
}

function mapGrantedPermissions(
  profile: AgentPermissionProfile
): GrantedPermissionProfile {
  return {
    network: profile.network
      ? { enabled: profile.network.enabled ?? null }
      : undefined,
    fileSystem: profile.fileSystem
      ? {
          read: profile.fileSystem.read ?? null,
          write: profile.fileSystem.write ?? null,
          globScanMaxDepth: profile.fileSystem.globScanMaxDepth,
          entries: profile.fileSystem.entries?.map((entry) => ({
            path: entry.path as never,
            access: entry.access
          }))
        }
      : undefined
  };
}

function mapPermissionProfile(
  profile: RequestPermissionProfile
): AgentPermissionProfile {
  return {
    network: profile.network
      ? { enabled: profile.network.enabled ?? undefined }
      : undefined,
    fileSystem: profile.fileSystem
      ? {
          read: profile.fileSystem.read ?? undefined,
          write: profile.fileSystem.write ?? undefined,
          globScanMaxDepth: profile.fileSystem.globScanMaxDepth,
          entries: profile.fileSystem.entries?.map((entry) => ({
            path: entry.path as AgentJsonValue,
            access: entry.access
          }))
        }
      : undefined
  };
}

function asJsonArray(value: unknown[] | null | undefined): AgentJsonValue[] | undefined {
  return value?.map((item) => item as AgentJsonValue);
}

function asJsonValue(value: unknown): AgentJsonValue | undefined {
  return value === undefined || value === null ? undefined : (value as AgentJsonValue);
}
