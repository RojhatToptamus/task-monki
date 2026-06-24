import type {
  AgentExecutionSettings,
  AgentGoalSnapshotRecord,
  AgentItemStatus,
  AgentItemType,
  AgentModel,
  AgentPlanStep,
  AgentTokenUsageBreakdown,
  AgentSessionRecord,
  RunRecord
} from '../../../shared/contracts';
import type { Account } from './protocol/generated/v2/Account';
import type { Model } from './protocol/generated/v2/Model';
import type { SandboxPolicy } from './protocol/generated/v2/SandboxPolicy';
import type { ThreadGoal } from './protocol/generated/v2/ThreadGoal';
import type { ThreadItem } from './protocol/generated/v2/ThreadItem';
import type { ThreadSettings } from './protocol/generated/v2/ThreadSettings';
import type { TokenUsageBreakdown } from './protocol/generated/v2/TokenUsageBreakdown';
import type { TurnPlanStep } from './protocol/generated/v2/TurnPlanStep';
import type { ThreadStatus } from './protocol/generated/v2/ThreadStatus';
import type { Turn } from './protocol/generated/v2/Turn';

export function mapModel(model: Model): AgentModel {
  return {
    id: model.id,
    provider: 'codex',
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map(
      (option) => option.reasoningEffort
    ),
    defaultReasoningEffort: model.defaultReasoningEffort,
    serviceTiers: model.serviceTiers.map((tier) => tier.id),
    defaultServiceTier: model.defaultServiceTier ?? undefined,
    inputModalities: model.inputModalities,
    isDefault: model.isDefault
  };
}

export function describeAccount(account: Account | null): string | undefined {
  if (!account) {
    return undefined;
  }
  if (account.type === 'chatgpt') {
    return `${account.email} (${account.planType})`;
  }
  if (account.type === 'apiKey') {
    return 'OpenAI API key';
  }
  return 'Amazon Bedrock';
}

export function settingsFromThreadResponse(response: {
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  reasoningEffort: string | null;
  approvalPolicy: unknown;
  sandbox: SandboxPolicy;
}): AgentExecutionSettings {
  return {
    model: response.model,
    modelProvider: response.modelProvider,
    serviceTier: response.serviceTier ?? undefined,
    reasoningEffort: response.reasoningEffort ?? undefined,
    approvalPolicy:
      typeof response.approvalPolicy === 'string' ? response.approvalPolicy : 'granular',
    sandbox: mapSandbox(response.sandbox),
    networkAccess:
      response.sandbox.type === 'dangerFullAccess'
        ? true
        : response.sandbox.type === 'externalSandbox'
          ? undefined
          : response.sandbox.networkAccess
  };
}

export function settingsFromThreadSettings(
  settings: ThreadSettings
): AgentExecutionSettings {
  return {
    model: settings.model,
    modelProvider: settings.modelProvider,
    serviceTier: settings.serviceTier ?? undefined,
    reasoningEffort: settings.effort ?? undefined,
    approvalPolicy:
      typeof settings.approvalPolicy === 'string'
        ? settings.approvalPolicy
        : 'granular',
    sandbox: mapSandbox(settings.sandboxPolicy),
    networkAccess:
      settings.sandboxPolicy.type === 'dangerFullAccess'
        ? true
        : settings.sandboxPolicy.type === 'externalSandbox'
          ? undefined
          : settings.sandboxPolicy.networkAccess
  };
}

export function mapPlanSteps(steps: TurnPlanStep[]): AgentPlanStep[] {
  return steps.map((step) => ({
    step: step.step,
    status:
      step.status === 'inProgress'
        ? 'IN_PROGRESS'
        : step.status === 'completed'
          ? 'COMPLETED'
          : 'PENDING'
  }));
}

export function mapTokenUsage(
  usage: TokenUsageBreakdown
): AgentTokenUsageBreakdown {
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens
  };
}

export function mapGoalFields(goal: ThreadGoal): Pick<
  AgentGoalSnapshotRecord,
  | 'providerObjective'
  | 'providerStatus'
  | 'tokenBudget'
  | 'tokensUsed'
  | 'timeUsedSeconds'
  | 'providerCreatedAt'
  | 'providerUpdatedAt'
> {
  return {
    providerObjective: goal.objective,
    providerStatus: goal.status,
    tokenBudget: goal.tokenBudget ?? undefined,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    providerCreatedAt: new Date(goal.createdAt * 1_000).toISOString(),
    providerUpdatedAt: new Date(goal.updatedAt * 1_000).toISOString()
  };
}

export function toSandboxMode(
  settings: AgentExecutionSettings
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (settings.sandbox === 'DANGER_FULL_ACCESS') {
    return 'danger-full-access';
  }
  if (settings.sandbox === 'READ_ONLY') {
    return 'read-only';
  }
  return 'workspace-write';
}

export function toSandboxPolicy(
  settings: AgentExecutionSettings,
  worktreePath: string
): SandboxPolicy {
  if (settings.sandbox === 'DANGER_FULL_ACCESS') {
    return { type: 'dangerFullAccess' };
  }
  if (settings.sandbox === 'READ_ONLY') {
    return { type: 'readOnly', networkAccess: settings.networkAccess ?? false };
  }
  return {
    type: 'workspaceWrite',
    writableRoots: [worktreePath],
    networkAccess: settings.networkAccess ?? false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

export function mapThreadStatus(status: ThreadStatus): AgentSessionRecord['status'] {
  if (status.type === 'notLoaded') {
    return 'NOT_LOADED';
  }
  if (status.type === 'idle') {
    return 'IDLE';
  }
  if (status.type === 'systemError') {
    return 'SYSTEM_ERROR';
  }
  if (status.activeFlags.includes('waitingOnApproval')) {
    return 'AWAITING_APPROVAL';
  }
  if (status.activeFlags.includes('waitingOnUserInput')) {
    return 'AWAITING_USER_INPUT';
  }
  return 'ACTIVE';
}

export function mapTurnStatus(status: Turn['status']): RunRecord['status'] {
  if (status === 'completed') {
    return 'COMPLETED';
  }
  if (status === 'failed') {
    return 'FAILED';
  }
  if (status === 'interrupted') {
    return 'INTERRUPTED';
  }
  return 'RUNNING';
}

export function mapItemType(item: ThreadItem): AgentItemType {
  switch (item.type) {
    case 'userMessage':
      return 'USER_MESSAGE';
    case 'agentMessage':
      return 'AGENT_MESSAGE';
    case 'reasoning':
      return 'REASONING_SUMMARY';
    case 'plan':
      return 'PLAN';
    case 'commandExecution':
      return 'COMMAND_EXECUTION';
    case 'fileChange':
      return 'FILE_CHANGE';
    case 'mcpToolCall':
      return 'MCP_TOOL_CALL';
    case 'dynamicToolCall':
      return 'DYNAMIC_TOOL_CALL';
    case 'webSearch':
      return 'WEB_SEARCH';
    case 'contextCompaction':
      return 'CONTEXT_COMPACTION';
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return 'REVIEW';
    case 'collabAgentToolCall':
    case 'subAgentActivity':
      return 'SUBAGENT';
    default:
      return 'OTHER';
  }
}

export function mapCompletedItemStatus(item: ThreadItem): AgentItemStatus {
  const status =
    item.type === 'commandExecution' ||
    item.type === 'fileChange' ||
    item.type === 'mcpToolCall' ||
    item.type === 'dynamicToolCall'
      ? item.status
      : 'completed';
  if (status === 'failed') {
    return 'FAILED';
  }
  if (status === 'declined') {
    return 'DECLINED';
  }
  if (status === 'inProgress') {
    return 'IN_PROGRESS';
  }
  return 'COMPLETED';
}

export function formatFinalArtifact(
  run: RunRecord,
  turn: Turn,
  finalMessage: string | undefined
): string {
  return [
    `# Agent ${run.mode.toLowerCase()} turn ${turn.status}`,
    '',
    `Run: ${run.id}`,
    `Session: ${run.sessionId}`,
    `Provider turn: ${turn.id}`,
    `Status: ${turn.status}`,
    `Duration: ${turn.durationMs ?? 'unknown'} ms`,
    turn.error ? `Error: ${turn.error.message}` : undefined,
    '',
    '## Final message',
    '',
    finalMessage?.trim() || 'No final agent message was emitted.',
    ''
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function mapSandbox(policy: SandboxPolicy): AgentExecutionSettings['sandbox'] {
  if (policy.type === 'dangerFullAccess') {
    return 'DANGER_FULL_ACCESS';
  }
  if (policy.type === 'readOnly') {
    return 'READ_ONLY';
  }
  return 'WORKSPACE_WRITE';
}
