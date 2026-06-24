import path from 'node:path';
import { realpathSync } from 'node:fs';
import type {
  AgentCommandApprovalDecision,
  AgentCommandApprovalRequest,
  AgentFileChangeApprovalRequest,
  AgentInteractionAction,
  AgentInteractionDecision,
  AgentInteractionRequestPayload,
  AgentJsonValue,
  AgentMcpElicitationDecision,
  AgentMcpElicitationRequest,
  AgentPermissionApprovalDecision,
  AgentPermissionApprovalRequest,
  AgentPermissionProfile,
  AgentSessionRecord,
  AgentUserInputDecision,
  AgentUserInputRequest,
  InteractionRequestRecord,
  InteractionRequestType,
  RunRecord
} from '../../shared/contracts';

export interface AgentInteractionPolicy {
  allowedActions: AgentInteractionAction[];
  warnings: string[];
}

export function buildInteractionPolicy(input: {
  type: InteractionRequestType;
  request: AgentInteractionRequestPayload;
  session: AgentSessionRecord;
  run: RunRecord;
  providerItemPayload?: unknown;
}): AgentInteractionPolicy {
  switch (input.type) {
    case 'COMMAND_APPROVAL':
      return commandPolicy(
        input.request as AgentCommandApprovalRequest,
        input.session,
        input.run
      );
    case 'FILE_CHANGE_APPROVAL':
      return fileChangePolicy(
        input.request as AgentFileChangeApprovalRequest,
        input.session,
        input.providerItemPayload
      );
    case 'PERMISSION_APPROVAL':
      return permissionPolicy(
        input.request as AgentPermissionApprovalRequest,
        input.session,
        input.run
      );
    case 'MCP_ELICITATION':
      return {
        allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
        warnings: ['MCP content and URLs are provider-supplied and must be reviewed as untrusted.']
      };
    case 'USER_INPUT': {
      const request = input.request as AgentUserInputRequest;
      if (request.questions.some((question) => question.isSecret)) {
        return {
          allowedActions: [],
          warnings: [
            'Secret user-input requests are disabled because Task Monki does not provide a secret-safe response channel.'
          ]
        };
      }
      return {
        allowedActions: ['ANSWER'],
        warnings: [
          'User-input requests are experimental in the current Codex protocol.'
        ]
      };
    }
    case 'DYNAMIC_TOOL':
      return {
        allowedActions: [],
        warnings: ['Dynamic client tools are not registered and are rejected automatically.']
      };
  }
}

export function validateInteractionDecision(
  interaction: InteractionRequestRecord,
  decision: AgentInteractionDecision,
  session: AgentSessionRecord,
  run: RunRecord
): void {
  if (decision.interactionType !== interaction.type) {
    throw new Error(
      `Decision type ${decision.interactionType} does not match ${interaction.type}.`
    );
  }
  if (
    decision.action !== 'REJECT_UNREGISTERED' &&
    !interaction.allowedActions.includes(decision.action)
  ) {
    throw new Error(
      `Decision ${decision.action} is not allowed for interaction ${interaction.id}.`
    );
  }

  switch (interaction.type) {
    case 'COMMAND_APPROVAL':
      validateCommandDecision(
        interaction.request as AgentCommandApprovalRequest,
        decision as AgentCommandApprovalDecision
      );
      return;
    case 'FILE_CHANGE_APPROVAL':
      return;
    case 'PERMISSION_APPROVAL':
      validatePermissionDecision(
        interaction.request as AgentPermissionApprovalRequest,
        decision as AgentPermissionApprovalDecision,
        session,
        run
      );
      return;
    case 'MCP_ELICITATION':
      validateMcpDecision(
        interaction.request as AgentMcpElicitationRequest,
        decision as AgentMcpElicitationDecision
      );
      return;
    case 'USER_INPUT':
      validateUserInputDecision(
        interaction.request as AgentUserInputRequest,
        decision as AgentUserInputDecision
      );
      return;
    case 'DYNAMIC_TOOL':
      if (decision.action !== 'REJECT_UNREGISTERED') {
        throw new Error('Task Monki does not register dynamic client tools.');
      }
  }
}

export function interactionTerminalStatus(
  decision: AgentInteractionDecision
): InteractionRequestRecord['status'] {
  if (decision.action === 'DECLINE') {
    return 'DECLINED';
  }
  if (decision.action === 'CANCEL') {
    return 'CANCELED';
  }
  return 'RESOLVED';
}

function commandPolicy(
  request: AgentCommandApprovalRequest,
  session: AgentSessionRecord,
  run: RunRecord
): AgentInteractionPolicy {
  const warnings: string[] = [];
  if (request.cwd && !isAllowedWorkspacePath(session.worktreePath, request.cwd)) {
    warnings.push('The command working directory is outside the task worktree.');
  }
  if (request.networkApprovalContext && run.requestedSettings.networkAccess !== true) {
    warnings.push('The task policy does not allow command network access.');
  }
  if (request.command && isTaskMonkiControlledCommand(request.command)) {
    warnings.push(
      'Task Monki reserves commit, publication, merge, remote, and worktree administration for explicit application actions.'
    );
  }
  if (warnings.length > 0) {
    return { allowedActions: ['DECLINE', 'CANCEL'], warnings };
  }

  const allowedActions: AgentInteractionAction[] = [
    'ACCEPT',
    'ACCEPT_FOR_SESSION',
    'DECLINE',
    'CANCEL'
  ];
  if (request.proposedExecPolicyAmendment?.length) {
    allowedActions.splice(2, 0, 'ACCEPT_EXEC_POLICY_AMENDMENT');
  }
  if (
    request.proposedNetworkPolicyAmendments?.length &&
    run.requestedSettings.networkAccess === true
  ) {
    allowedActions.splice(2, 0, 'APPLY_NETWORK_POLICY_AMENDMENT');
  }
  return { allowedActions, warnings };
}

function fileChangePolicy(
  request: AgentFileChangeApprovalRequest,
  session: AgentSessionRecord,
  providerItemPayload: unknown
): AgentInteractionPolicy {
  const changedPaths = readFileChangePaths(providerItemPayload);
  const unsafePaths = changedPaths.filter(
    (candidate) => !isAllowedWorkspacePath(session.worktreePath, candidate)
  );
  const warnings: string[] = [];
  if (changedPaths.length === 0) {
    warnings.push('Task Monki could not verify the requested file paths.');
  }
  if (unsafePaths.length > 0) {
    warnings.push(
      `The requested change includes paths outside the writable task boundary: ${unsafePaths.join(', ')}`
    );
  }
  if (
    request.grantRoot &&
    !isAllowedWorkspacePath(session.worktreePath, request.grantRoot)
  ) {
    warnings.push('The requested session write root is outside the task worktree.');
  }
  if (warnings.length > 0) {
    return { allowedActions: ['DECLINE', 'CANCEL'], warnings };
  }
  return {
    allowedActions: request.grantRoot
      ? ['ACCEPT', 'ACCEPT_FOR_SESSION', 'DECLINE', 'CANCEL']
      : ['ACCEPT', 'DECLINE', 'CANCEL'],
    warnings
  };
}

function permissionPolicy(
  request: AgentPermissionApprovalRequest,
  session: AgentSessionRecord,
  run: RunRecord
): AgentInteractionPolicy {
  const warnings = permissionPolicyWarnings(
    request.permissions,
    session.worktreePath,
    run.requestedSettings.networkAccess === true
  );
  const hasGrantablePermission = hasAnyPermission(request.permissions) && warnings.length === 0;
  return {
    allowedActions: hasGrantablePermission
      ? ['GRANT_TURN', 'GRANT_SESSION', 'DECLINE']
      : ['DECLINE'],
    warnings
  };
}

function validateCommandDecision(
  request: AgentCommandApprovalRequest,
  decision: AgentCommandApprovalDecision
): void {
  if (decision.action === 'ACCEPT_EXEC_POLICY_AMENDMENT') {
    if (!deepEqual(decision.amendment, request.proposedExecPolicyAmendment)) {
      throw new Error('The execution-policy amendment does not match the provider proposal.');
    }
  }
  if (decision.action === 'APPLY_NETWORK_POLICY_AMENDMENT') {
    if (
      !request.proposedNetworkPolicyAmendments?.some((proposal) =>
        deepEqual(proposal, decision.amendment)
      )
    ) {
      throw new Error('The network-policy amendment does not match a provider proposal.');
    }
  }
}

function validatePermissionDecision(
  request: AgentPermissionApprovalRequest,
  decision: AgentPermissionApprovalDecision,
  session: AgentSessionRecord,
  run: RunRecord
): void {
  if (decision.action === 'DECLINE') {
    return;
  }
  if (!isPermissionSubset(decision.permissions, request.permissions)) {
    throw new Error('Granted permissions must be a subset of the provider request.');
  }
  const warnings = permissionPolicyWarnings(
    decision.permissions,
    session.worktreePath,
    run.requestedSettings.networkAccess === true
  );
  if (warnings.length > 0) {
    throw new Error(warnings.join(' '));
  }
}

function validateMcpDecision(
  request: AgentMcpElicitationRequest,
  decision: AgentMcpElicitationDecision
): void {
  if (decision.action !== 'ACCEPT') {
    return;
  }
  if (request.mode === 'url') {
    if (decision.content !== null) {
      throw new Error('URL elicitations must be accepted with null content.');
    }
    return;
  }
  validateMcpFormContent(request.requestedSchema, decision.content);
}

function validateUserInputDecision(
  request: AgentUserInputRequest,
  decision: AgentUserInputDecision
): void {
  const questionIds = new Set(request.questions.map((question) => question.id));
  for (const key of Object.keys(decision.answers)) {
    if (!questionIds.has(key)) {
      throw new Error(`Unknown user-input question id: ${key}.`);
    }
  }
  for (const question of request.questions) {
    const answers = decision.answers[question.id];
    if (!answers?.length || answers.some((answer) => !answer.trim())) {
      throw new Error(`An answer is required for ${question.header}.`);
    }
    if (
      question.options &&
      !question.isOther &&
      answers.some(
        (answer) => !question.options?.some((option) => option.label === answer)
      )
    ) {
      throw new Error(`Answer for ${question.header} is not one of the supplied options.`);
    }
  }
}

function permissionPolicyWarnings(
  permissions: AgentPermissionProfile,
  worktreePath: string,
  networkAllowed: boolean
): string[] {
  const warnings: string[] = [];
  if (permissions.network?.enabled && !networkAllowed) {
    warnings.push('The task policy does not allow network access.');
  }
  for (const candidate of permissionPaths(permissions)) {
    if (!isAllowedWorkspacePath(worktreePath, candidate)) {
      warnings.push(`Filesystem permission is outside the task worktree: ${candidate}`);
    }
  }
  if (
    permissions.fileSystem?.entries?.some(
      (entry) => !isConcretePathEntry(entry.path)
    )
  ) {
    warnings.push('Non-path filesystem permission entries are not supported.');
  }
  return warnings;
}

function isPermissionSubset(
  granted: AgentPermissionProfile,
  requested: AgentPermissionProfile
): boolean {
  if (granted.network?.enabled && requested.network?.enabled !== true) {
    return false;
  }
  const requestedRead = new Set(requested.fileSystem?.read ?? []);
  const requestedWrite = new Set(requested.fileSystem?.write ?? []);
  if (granted.fileSystem?.read?.some((value) => !requestedRead.has(value))) {
    return false;
  }
  if (granted.fileSystem?.write?.some((value) => !requestedWrite.has(value))) {
    return false;
  }
  const requestedEntries = requested.fileSystem?.entries ?? [];
  if (
    granted.fileSystem?.entries?.some(
      (entry) => !requestedEntries.some((candidate) => deepEqual(candidate, entry))
    )
  ) {
    return false;
  }
  return true;
}

function validateMcpFormContent(
  schema: { [key: string]: AgentJsonValue },
  content: AgentJsonValue
): void {
  if (!isJsonObject(content)) {
    throw new Error('MCP form content must be an object.');
  }
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : [];
  for (const key of required) {
    if (!(key in content)) {
      throw new Error(`MCP form field ${key} is required.`);
    }
  }
  for (const [key, value] of Object.entries(content)) {
    const fieldSchema = properties[key];
    if (!isJsonObject(fieldSchema)) {
      throw new Error(`MCP form field ${key} is not declared by the provider schema.`);
    }
    validateMcpField(key, fieldSchema, value);
  }
}

function validateMcpField(
  key: string,
  schema: { [key: string]: AgentJsonValue },
  value: AgentJsonValue
): void {
  const allowed = mcpAllowedValues(schema);
  if (allowed) {
    if (Array.isArray(value)) {
      if (value.some((candidate) => !allowed.some((item) => deepEqual(item, candidate)))) {
        throw new Error(`MCP form field ${key} contains an unsupported selection.`);
      }
    } else if (!allowed.some((candidate) => deepEqual(candidate, value))) {
      throw new Error(`MCP form field ${key} is not an allowed value.`);
    }
    return;
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new Error(`MCP form field ${key} must be a string.`);
      }
      break;
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        (schema.type === 'integer' && !Number.isInteger(value))
      ) {
        throw new Error(`MCP form field ${key} must be a ${schema.type}.`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(`MCP form field ${key} must be a boolean.`);
      }
      break;
    case 'array':
      if (!Array.isArray(value)) {
        throw new Error(`MCP form field ${key} must be an array.`);
      }
      break;
    default:
      throw new Error(`MCP form field ${key} uses an unsupported schema.`);
  }
}

function mcpAllowedValues(
  schema: { [key: string]: AgentJsonValue }
): AgentJsonValue[] | undefined {
  if (Array.isArray(schema.enum)) {
    return schema.enum;
  }
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (alternatives) {
    return alternatives
      .filter(isJsonObject)
      .map((option) => option.const)
      .filter((candidate): candidate is AgentJsonValue => candidate !== undefined);
  }
  if (isJsonObject(schema.items)) {
    return mcpAllowedValues(schema.items);
  }
  return undefined;
}

function permissionPaths(permissions: AgentPermissionProfile): string[] {
  const paths = [
    ...(permissions.fileSystem?.read ?? []),
    ...(permissions.fileSystem?.write ?? [])
  ];
  for (const entry of permissions.fileSystem?.entries ?? []) {
    if (isJsonObject(entry.path) && entry.path.type === 'path' && typeof entry.path.path === 'string') {
      paths.push(entry.path.path);
    }
  }
  return paths;
}

function isConcretePathEntry(value: AgentJsonValue): boolean {
  return (
    isJsonObject(value) &&
    value.type === 'path' &&
    typeof value.path === 'string'
  );
}

function readFileChangePaths(payload: unknown): string[] {
  if (!isJsonObject(payload) || !Array.isArray(payload.changes)) {
    return [];
  }
  return payload.changes
    .filter(isJsonObject)
    .map((change) => change.path)
    .filter((candidate): candidate is string => typeof candidate === 'string');
}

function isAllowedWorkspacePath(worktreePath: string, candidate: string): boolean {
  const root = canonicalPath(worktreePath);
  const resolvedCandidate = path.resolve(root, candidate);
  const resolved = canonicalPath(resolvedCandidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  const firstSegment = relative.split(path.sep)[0];
  return !['.git', '.agents', '.codex'].includes(firstSegment);
}

function canonicalPath(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function hasAnyPermission(permissions: AgentPermissionProfile): boolean {
  return Boolean(
    permissions.network?.enabled ||
      permissions.fileSystem?.read?.length ||
      permissions.fileSystem?.write?.length ||
      permissions.fileSystem?.entries?.length
  );
}

function isTaskMonkiControlledCommand(command: string): boolean {
  return [
    /\bgit\s+(?:-\S+\s+)*commit\b/i,
    /\bgit\s+(?:-\S+\s+)*push\b/i,
    /\bgit\s+(?:-\S+\s+)*merge\b/i,
    /\bgit\s+(?:-\S+\s+)*rebase\b/i,
    /\bgit\s+(?:-\S+\s+)*remote\b/i,
    /\bgit\s+(?:-\S+\s+)*config\b/i,
    /\bgit\s+(?:-\S+\s+)*worktree\s+(?:remove|prune)\b/i,
    /\bgh\s+pr\s+(?:create|close|merge|ready)\b/i,
    /\bgh\s+repo\s+/i
  ].some((pattern) => pattern.test(command));
}

function isJsonObject(
  value: AgentJsonValue | unknown
): value is { [key: string]: AgentJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}
