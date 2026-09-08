import type {
  AgentExecutionSettings,
  AgentReviewTarget,
  AgentSessionRole
} from '../../shared/agent';
import type { AgentTurnAttachment } from './AgentAttachmentDelivery';
import type { AgentAttachmentSelection } from '../../shared/attachments';
import type {
  AgentAttestedReadRoot,
  AgentExecutionContext,
  AgentOwnerScope,
  AgentRunScope,
  AgentRuntimePurpose,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord,
  AgentSchedulerPriority,
  AgentSchedulerQueueEntry
} from '../../shared/agentRuntime';

export interface BuildAgentRuntimeExecutionContextInput {
  sessionId: string;
  primaryCwd: string;
  readRoots: AgentAttestedReadRoot[];
  modelSettings: AgentExecutionSettings;
  clientOperationId: string;
  attachments?: readonly AgentTurnAttachment[];
}

export interface PrepareAgentRuntimeTurnInput {
  sessionId: string;
  runId: string;
  owner: AgentOwnerScope;
  scope: AgentRunScope;
  runtimeId: string;
  model: string;
  purpose: AgentRuntimePurpose;
  generationKey: string;
  executionContext: AgentExecutionContext;
  prompt: string;
  priority: AgentSchedulerPriority;
  clientOperationId: string;
  createdAt: string;
  notBefore?: string;
  role?: AgentSessionRole;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  taskContext?: AgentRuntimeSessionRecord['taskContext'];
  taskDetails?: AgentRuntimeRunRecord['taskDetails'];
  taskReviewTarget?: AgentReviewTarget;
  attachmentSelection?: readonly AgentAttachmentSelection[];
}

export interface PreparedAgentRuntimeTurn {
  session: AgentRuntimeSessionRecord;
  run: AgentRuntimeRunRecord;
  queueEntry: AgentSchedulerQueueEntry;
}

/**
 * Durable runtime observations. The coordinator persists the related runtime
 * state before it publishes one of these events.
 */
export type AgentRuntimeTurnEvent =
  | {
      type: 'DELTA';
      runId: string;
      providerTurnId: string;
      text: string;
      observedAt: string;
    }
  | {
      type: 'RECOVERY_REQUIRED';
      runId: string;
      providerTurnId?: string;
      reason: string;
      observedAt: string;
    }
  | {
      type: 'TERMINAL';
      runId: string;
      providerTurnId: string;
      status: 'completed' | 'interrupted' | 'failed';
      error?: string;
      completedAt: string;
    };

/**
 * The common provider lifecycle owned by AgentOrchestrator. Workflows keep
 * their own prompts, queues, projections, and user-visible state.
 */
export interface AgentRuntimeCoordinator {
  hasRuntime(runtimeId: string): boolean;
  buildExecutionContext(
    runtimeId: string,
    input: BuildAgentRuntimeExecutionContextInput
  ): Promise<AgentExecutionContext>;
  prepareTurn(input: PrepareAgentRuntimeTurnInput): Promise<PreparedAgentRuntimeTurn>;
  startPreparedTurn(
    queueEntryId: string,
    clientOperationId: string,
    attachments?: readonly AgentTurnAttachment[]
  ): Promise<AgentRuntimeRunRecord>;
  cancelQueuedTurn(
    runId: string,
    reason: string,
    clientOperationId: string
  ): Promise<AgentRuntimeRunRecord>;
  interruptTurn(
    runId: string,
    reason: string,
    clientOperationId: string
  ): Promise<AgentRuntimeRunRecord>;
  /** Settles scheduler state and releases provider resources for a terminal turn. */
  finishRuntimeTurn(runId: string): Promise<void>;
  releaseRuntimeSession(sessionId: string): Promise<void>;
  subscribe(listener: (event: AgentRuntimeTurnEvent) => void): () => void;
}
