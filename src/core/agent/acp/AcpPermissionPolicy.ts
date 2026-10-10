import path from 'node:path';
import type {
  AgentCommandApprovalRequest,
  AgentInteractionAction,
  AgentPermissionApprovalDecision,
  AgentPermissionApprovalRequest,
  AgentSessionRecord,
  RunRecord
} from '../../../shared/contracts';
import { buildInteractionPolicy, previewInspectionReadPaths } from '../AgentInteractionPolicy';
import { redactExternalPermissionPaths } from '../AgentPermissionRedaction';
import {
  agentActionForAcpPermissionKind,
  acpPermissionKindRemembersChoice,
  interactionActionsForAcpOptions
} from './AcpEventMapper';
import type { AcpPermissionOption, AcpToolCallUpdate } from './AcpProtocol';

export interface MaterializedAcpPermission {
  request: AgentCommandApprovalRequest;
  allowedActions: AgentInteractionAction[];
  warnings: string[];
  /** Set when the request is the active run's own Task Monki tool. */
  trustedAppTool?: string;
}

export interface MaterializedAcpReadPermission {
  request: AgentPermissionApprovalRequest;
  allowedActions: AgentInteractionAction[];
  warnings: string[];
}

/** Intersects opaque provider choices with Task Monki's local safety policy. */
export function materializeAcpPermission(input: {
  toolCall: AcpToolCallUpdate;
  options: readonly AcpPermissionOption[];
  session: AgentSessionRecord;
  run: RunRecord;
  /**
   * A Task Monki tool the active run may call. It is accepted automatically through
   * the provider's single one-time choice, like a Codex dynamic tool call.
   */
  trustedAppTool?: string;
  rememberedPermissionOwner?: string;
}): MaterializedAcpPermission {
  const paths = pathsFromToolCall(input.toolCall);
  const reason = reasonFromToolCall(input.toolCall);
  const request: AgentCommandApprovalRequest = {
    startedAtMs: Date.now(),
    approvalId: input.toolCall.toolCallId,
    ...(reason ? { reason } : {}),
    command: commandFromToolCall(input.toolCall),
    cwd: cwdFromToolCall(input.toolCall),
    ...(paths.length > 0 ? { paths } : {}),
    commandActions: [toAgentJson(input.toolCall)]
  };
  const warnings: string[] = [];
  let localAllowed: AgentInteractionAction[];
  let hardBlocked = false;

  if (input.trustedAppTool) {
    localAllowed = ['ACCEPT', 'DECLINE', 'CANCEL'];
    if (!uniqueOption(input.options, 'allow_once')) {
      warnings.push(`ACP did not offer one exact one-time choice for Task Monki tool ${input.trustedAppTool}.`);
      hardBlocked = true;
    }
  } else if (['edit', 'delete', 'move', 'read'].includes(input.toolCall.kind ?? '')) {
    const policy = buildInteractionPolicy({
      type: 'FILE_CHANGE_APPROVAL',
      request: {
        startedAtMs: request.startedAtMs,
        reason: request.reason,
        changes: paths.map((filePath) => ({
          path: filePath,
          kind: input.toolCall.kind ?? 'other',
          diff: ''
        }))
      },
      session: input.session,
      run: input.run,
      providerItemPayload: { changes: paths.map((filePath) => ({ path: filePath })) }
    });
    localAllowed = policy.allowedActions;
    warnings.push(...policy.warnings);
    hardBlocked = policy.warnings.length > 0;
    if (paths.length === 0) {
      warnings.push('ACP did not provide verifiable file scope for this tool call.');
      hardBlocked = true;
    }
  } else if (input.toolCall.kind === 'execute') {
    const policy = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request,
      session: input.session,
      run: input.run
    });
    localAllowed = policy.allowedActions;
    warnings.push(...policy.warnings);
    hardBlocked = policy.warnings.length > 0;
    if (!request.command) {
      warnings.push('ACP did not provide a verifiable command for this execution request.');
      hardBlocked = true;
    }
  } else if (input.toolCall.kind === 'fetch') {
    request.networkApprovalContext = networkContext(input.toolCall);
    const policy = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request,
      session: input.session,
      run: input.run
    });
    localAllowed = policy.allowedActions;
    warnings.push(...policy.warnings);
    hardBlocked = policy.warnings.length > 0;
  } else if (input.toolCall.kind === 'search') {
    const policy = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request,
      session: input.session,
      run: input.run
    });
    localAllowed = policy.allowedActions;
    warnings.push(...policy.warnings);
    hardBlocked = policy.warnings.length > 0;
  } else {
    localAllowed = ['DECLINE', 'CANCEL'];
    hardBlocked = true;
    warnings.push(
      `Task Monki cannot independently verify ACP tool kind ${input.toolCall.kind ?? 'unknown'}.`
    );
  }

  if (hardBlocked) {
    localAllowed = localAllowed.filter((action) => !isApproval(action));
  }
  const permittedOptions = input.options.filter((option) => {
    const action = agentActionForAcpPermissionKind(option.kind);
    if (
      acpPermissionKindRemembersChoice(option.kind) &&
      input.rememberedPermissionOwner === undefined
    ) {
      return false;
    }
    if (action === 'DECLINE') return true;
    if (!localAllowed.includes('ACCEPT')) return false;
    return true;
  });
  request.providerOptions = permittedOptions.map((option) => ({
    id: option.optionId,
    label: option.name,
    action: agentActionForAcpPermissionKind(option.kind),
    providerRemembersChoice: acpPermissionKindRemembersChoice(option.kind)
  }));
  const allowedActions = interactionActionsForAcpOptions(permittedOptions);
  const hasRememberedOption = request.providerOptions.some(
    (option) => option.providerRemembersChoice
  );
  const rememberedPermissionOwner = input.rememberedPermissionOwner ?? 'The provider';
  return {
    request,
    allowedActions,
    ...(input.trustedAppTool ? { trustedAppTool: input.trustedAppTool } : {}),
    warnings: [
      ...new Set([
        ...warnings,
        ...(hasRememberedOption
          ? [
              `${rememberedPermissionOwner} owns the scope and lifetime of remembered choices.`
            ]
          : [])
      ])
    ]
  };
}

/**
 * In Preview, an ACP read is read-only access to the exact paths it names. It
 * becomes the shared read-permission approval, so the person can grant it once
 * only for paths inside the worktree or an explicitly shown project folder.
 * Other runs and tool kinds keep the command-approval materialization.
 */
export function materializeAcpReadPermission(input: {
  toolCall: AcpToolCallUpdate;
  options: readonly AcpPermissionOption[];
  session: AgentSessionRecord;
  run: RunRecord;
}): MaterializedAcpReadPermission | undefined {
  if (input.run.mode !== 'PREVIEW' || input.toolCall.kind !== 'read') {
    return undefined;
  }
  const base = cwdFromToolCall(input.toolCall) ?? input.session.worktreePath;
  const paths = pathsFromToolCall(input.toolCall).map((candidate) => path.resolve(base, candidate));
  const reason = reasonFromToolCall(input.toolCall);
  const requested: AgentPermissionApprovalRequest = {
    startedAtMs: Date.now(),
    cwd: input.session.worktreePath,
    ...(reason ? { reason } : {}),
    permissions: {
      fileSystem: {
        entries: [...new Set(paths)].map((candidate) => ({
          path: { type: 'path', path: candidate },
          access: 'read'
        }))
      }
    }
  };
  // Like Codex, conceal external paths other than folders eligible for explicit consent.
  const request = redactExternalPermissionPaths(
    requested,
    input.session.worktreePath,
    previewInspectionReadPaths(requested, input.run)
  );
  const policy = buildInteractionPolicy({
    type: 'PERMISSION_APPROVAL',
    request,
    session: input.session,
    run: input.run
  });
  const warnings = [...policy.warnings];
  if (paths.length === 0) warnings.push('ACP did not provide verifiable file scope for this tool call.');
  const grantable = uniqueOption(input.options, 'allow_once') !== undefined;
  if (!grantable) warnings.push('ACP did not offer one exact one-time choice for this read.');
  return {
    request,
    // ACP grants one tool call; a session-wide grant would be the provider's remembered choice.
    allowedActions: policy.allowedActions.filter(
      (action) => action === 'DECLINE' || (action === 'GRANT_TURN' && grantable)
    ),
    warnings: [...new Set(warnings)]
  };
}

/** The exact provider choice for a read-permission decision; only the complete request can be granted. */
export function acpReadPermissionOutcome(
  options: readonly AcpPermissionOption[],
  request: AgentPermissionApprovalRequest,
  decision: AgentPermissionApprovalDecision
): { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } {
  if (decision.action === 'DECLINE') {
    const reject = uniqueOption(options, 'reject_once');
    return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
  }
  if (decision.action !== 'GRANT_TURN' || canonicalJson(decision.permissions) !== canonicalJson(request.permissions)) {
    throw new Error('ACP can grant only the complete one-time read request.');
  }
  const allow = uniqueOption(options, 'allow_once');
  if (!allow) throw new Error('The ACP agent did not offer one exact one-time choice for this read.');
  return { outcome: 'selected', optionId: allow.optionId };
}

/** Selects an exact provider option only when the chosen access policy permits it. */
export function selectAutomaticAcpPermissionOption(input: {
  approvalPolicy: string | undefined;
  toolCall: Pick<AcpToolCallUpdate, 'kind'>;
  options: readonly AcpPermissionOption[];
  materialized: MaterializedAcpPermission;
}): AcpPermissionOption | undefined {
  const autoAcceptsOneTime =
    input.materialized.trustedAppTool !== undefined ||
    input.approvalPolicy === 'never' ||
    (input.approvalPolicy === 'auto-accept-edits' &&
      ['edit', 'delete', 'move'].includes(input.toolCall.kind ?? ''));
  if (!autoAcceptsOneTime || !input.materialized.allowedActions.includes('ACCEPT')) {
    return undefined;
  }

  const permittedOptionIds = new Set(
    input.materialized.request.providerOptions?.map((option) => option.id)
  );
  const oneTime = input.options.filter(
    (option) => option.kind === 'allow_once' && permittedOptionIds.has(option.optionId)
  );
  return oneTime.length === 1 ? oneTime[0] : undefined;
}

/** Durable records omit undefined fields, so permission profiles compare as canonical JSON. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
      : entry
  );
}

function uniqueOption(
  options: readonly AcpPermissionOption[],
  kind: AcpPermissionOption['kind']
): AcpPermissionOption | undefined {
  const matching = options.filter((option) => option.kind === kind);
  return matching.length === 1 ? matching[0] : undefined;
}

function commandFromToolCall(toolCall: AcpToolCallUpdate): string | undefined {
  if (typeof toolCall.rawInput === 'string') return toolCall.rawInput;
  if (!isRecord(toolCall.rawInput)) return undefined;
  for (const key of ['command', 'cmd', 'script']) {
    const value = toolCall.rawInput[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
      return value.join(' ');
    }
  }
  return undefined;
}

function reasonFromToolCall(toolCall: AcpToolCallUpdate): string | undefined {
  for (const entry of toolCall.content ?? []) {
    if (!isRecord(entry)) continue;
    const content = entry.type === 'content' ? entry.content : entry;
    if (!isRecord(content)) continue;
    if (content.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
      return content.text.trim();
    }
  }
  return toolCall.title?.trim() || undefined;
}

function cwdFromToolCall(toolCall: AcpToolCallUpdate): string | undefined {
  return isRecord(toolCall.rawInput) && typeof toolCall.rawInput.cwd === 'string'
    ? toolCall.rawInput.cwd
    : undefined;
}

function pathsFromToolCall(toolCall: AcpToolCallUpdate): string[] {
  const paths = new Set<string>();
  for (const location of toolCall.locations ?? []) {
    if (isRecord(location) && typeof location.path === 'string') paths.add(location.path);
  }
  for (const content of toolCall.content ?? []) {
    if (!isRecord(content)) continue;
    if (typeof content.path === 'string') paths.add(content.path);
    if (isRecord(content.diff) && typeof content.diff.path === 'string') {
      paths.add(content.diff.path);
    }
  }
  if (isRecord(toolCall.rawInput)) {
    for (const key of ['path', 'file', 'filePath', 'target']) {
      if (typeof toolCall.rawInput[key] === 'string') paths.add(toolCall.rawInput[key]);
    }
  }
  return [...paths];
}

function networkContext(toolCall: AcpToolCallUpdate): {
  host?: string;
  protocol?: string;
} {
  const raw = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  const candidate = ['url', 'uri', 'host']
    .map((key) => raw[key])
    .find((value) => typeof value === 'string');
  if (typeof candidate === 'string') {
    try {
      const url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
      return { host: url.hostname, protocol: url.protocol.replace(/:$/u, '') };
    } catch {
      return { host: candidate };
    }
  }
  return {};
}

function isApproval(action: AgentInteractionAction): boolean {
  return !['DECLINE', 'DECLINE_FOR_SESSION', 'CANCEL'].includes(action);
}

function toAgentJson(value: unknown): import('../../../shared/agent').AgentJsonValue {
  return JSON.parse(JSON.stringify(value)) as import('../../../shared/agent').AgentJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
