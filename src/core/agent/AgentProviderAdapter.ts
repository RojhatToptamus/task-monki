import type {
  AgentModel,
  AgentPreflight,
  AgentProviderCapabilities,
  AgentGoalSnapshotRecord,
  AgentReviewTarget,
  AgentRunMode,
  AgentSessionRecord,
  AgentSessionSnapshot,
  AgentExecutionSettings,
  AgentInteractionDecision,
  InteractionRequestRecord
} from '../../shared/agent';
import type { AgentExecutionContext } from '../../shared/agentRuntime';
import type { AgentTurnAttachment } from './AgentAttachmentDelivery';

export interface CreateAgentSession {
  localSessionId: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  worktreePath: string;
  settings: AgentExecutionSettings;
}

export interface AgentSessionRef {
  localSessionId: string;
  providerSessionId?: string;
}

export interface StartAgentTurn {
  localRunId: string;
  session: AgentSessionRef;
  mode: AgentRunMode;
  prompt: string;
  authoritativeGoal: string;
  attachments?: AgentTurnAttachment[];
  settings?: AgentExecutionSettings;
}

export interface AgentTurn {
  localRunId: string;
  providerTurnId?: string;
}

export interface SteerAgentTurn {
  session: AgentSessionRef;
  providerTurnId: string;
  prompt: string;
  clientMessageId: string;
}

export interface InterruptAgentTurn {
  session: AgentSessionRef;
  providerTurnId: string;
}

export interface ForkAgentSession {
  sourceSession: AgentSessionRef;
  localSessionId: string;
  settings: AgentExecutionSettings;
}

export interface StartAgentReview {
  localRunId: string;
  sourceSession: AgentSessionRef;
  reviewSessionId: string;
  target: AgentReviewTarget;
  attachments?: AgentTurnAttachment[];
}

export interface SyncAgentGoal {
  session: AgentSessionRef;
  authoritativeGoal: string;
  force: boolean;
}

export interface AgentInteractionResponse {
  interaction: InteractionRequestRecord;
  decision: AgentInteractionDecision;
}

export interface AgentReconciliationResult {
  reconciledSessionIds: string[];
  recoveryRequiredSessionIds: string[];
}

export interface DescribeAgentExecutionContext {
  sessionId: string;
  worktreePath: string;
  settings: AgentExecutionSettings;
  attachments: readonly AgentTurnAttachment[];
  clientOperationId: string;
}

export class AgentMutationAmbiguousError extends Error {
  constructor(
    readonly operation: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentMutationAmbiguousError';
  }
}

export class AgentProviderSessionMissingError extends Error {
  constructor(
    readonly operation: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentProviderSessionMissingError';
  }
}

export interface AgentProviderAdapter {
  initialize(): Promise<void>;
  preflight(): Promise<AgentPreflight>;
  capabilities(): Promise<AgentProviderCapabilities>;
  listModels(): Promise<AgentModel[]>;
  describeExecutionContext?(
    input: DescribeAgentExecutionContext
  ): Promise<AgentExecutionContext>;
  createSession(input: CreateAgentSession): Promise<AgentSessionRecord>;
  attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord>;
  readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot>;
  startTurn(input: StartAgentTurn): Promise<AgentTurn>;
  steerTurn?(input: SteerAgentTurn): Promise<void>;
  interruptTurn?(input: InterruptAgentTurn): Promise<void>;
  forkSession?(input: ForkAgentSession): Promise<AgentSessionRecord>;
  startReview?(input: StartAgentReview): Promise<AgentTurn>;
  syncGoal?(input: SyncAgentGoal): Promise<AgentGoalSnapshotRecord>;
  respondToInteraction(input: AgentInteractionResponse): Promise<void>;
  reconcile(): Promise<AgentReconciliationResult>;
  shutdown(): Promise<void>;
}
