import type {
  AgentCommandApprovalRequest,
  AgentInteractionAction,
  AgentSessionRecord,
  RunRecord
} from '../../../shared/contracts';
import { buildInteractionPolicy } from '../AgentInteractionPolicy';
import { interactionActionsForAcpOptions } from './AcpEventMapper';
import type { AcpPermissionOption, AcpToolCallUpdate } from './AcpProtocol';

export interface MaterializedAcpPermission {
  request: AgentCommandApprovalRequest;
  allowedActions: AgentInteractionAction[];
  warnings: string[];
}

/** Intersects opaque provider choices with Task Monki's local safety policy. */
export function materializeAcpPermission(input: {
  toolCall: AcpToolCallUpdate;
  options: readonly AcpPermissionOption[];
  session: AgentSessionRecord;
  run: RunRecord;
}): MaterializedAcpPermission {
  const request: AgentCommandApprovalRequest = {
    startedAtMs: Date.now(),
    approvalId: input.toolCall.toolCallId,
    reason: input.toolCall.title ?? 'The ACP agent requested tool permission.',
    command: commandFromToolCall(input.toolCall),
    cwd: cwdFromToolCall(input.toolCall) ?? input.session.worktreePath,
    commandActions: [toAgentJson(input.toolCall)],
    providerOptions: input.options.map((option) => ({
      id: option.optionId,
      label: option.name,
      kind: option.kind
    }))
  };
  const warnings: string[] = [];
  let localAllowed: AgentInteractionAction[];

  if (['edit', 'delete', 'move', 'read'].includes(input.toolCall.kind ?? '')) {
    const paths = pathsFromToolCall(input.toolCall);
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
    if (paths.length === 0) {
      warnings.push('ACP did not provide verifiable file scope for this tool call.');
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
    if (!request.command) {
      warnings.push('ACP did not provide a verifiable command for this execution request.');
    }
  } else if (input.toolCall.kind === 'fetch' || input.toolCall.kind === 'search') {
    request.networkApprovalContext = networkContext(input.toolCall);
    const policy = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request,
      session: input.session,
      run: input.run
    });
    localAllowed = policy.allowedActions;
    warnings.push(...policy.warnings);
  } else {
    localAllowed = ['DECLINE', 'CANCEL'];
    warnings.push(
      `Task Monki cannot independently verify ACP tool kind ${input.toolCall.kind ?? 'unknown'}.`
    );
  }

  if (warnings.length > 0) {
    localAllowed = localAllowed.filter((action) => !isApproval(action));
  }
  const providerAllowed = interactionActionsForAcpOptions(input.options);
  return {
    request,
    allowedActions: providerAllowed.filter((action) =>
      action === 'DECLINE' || action === 'DECLINE_FOR_SESSION' || action === 'CANCEL'
        ? true
        : localAllowed.includes(action)
    ),
    warnings: [
      ...new Set([
        ...warnings,
        'The ACP agent executes this tool in its own process. Provider details are untrusted telemetry.'
      ])
    ]
  };
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

function networkContext(toolCall: AcpToolCallUpdate): { host: string; protocol: string } {
  const raw = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  const candidate = ['url', 'uri', 'host']
    .map((key) => raw[key])
    .find((value) => typeof value === 'string');
  if (typeof candidate === 'string') {
    try {
      const url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
      return { host: url.hostname, protocol: url.protocol.replace(/:$/u, '') };
    } catch {
      return { host: candidate, protocol: 'unknown' };
    }
  }
  return { host: 'provider-requested-network', protocol: 'unknown' };
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
