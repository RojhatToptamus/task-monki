import type {
  AgentModel,
  AgentPreflight,
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor,
  AgentRuntimeId,
  AgentSessionControlSet,
  AgentSessionControlValue,
  AgentJsonValue,
  AgentGoalSnapshotRecord,
  AgentReviewTarget,
  AgentRunMode,
  AgentSessionRecord,
  AgentSessionSnapshot,
  AgentExecutionSettings,
  AgentInteractionDecision,
  AgentInstructionProfile,
  InteractionRequestRecord
} from '../../shared/agent';
import type { AgentTurnAttachment } from './AgentAttachmentDelivery';
import type {
  AgentAttachmentSelection,
  AttachmentSubmissionRecord
} from '../../shared/attachments';
import type {
  AgentExecutionContext,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord
} from '../../shared/agentRuntime';
import type {
  AgentRuntimeTurnEvent,
  BuildAgentRuntimeExecutionContextInput
} from './AgentRuntimeCoordinator';

export interface CreateAgentSession {
  runtimeId: AgentRuntimeId;
  localSessionId: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  worktreePath: string;
  mode?: AgentRunMode;
  instructionProfile?: AgentInstructionProfile;
  settings: AgentExecutionSettings;
  /**
   * Storage-verified task attachments used to qualify the initial session.
   * Each adapter owns any session-scoped access and turn transport.
   */
  attachments?: AgentTurnAttachment[];
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
  instructionProfile?: AgentInstructionProfile;
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

export interface ResolveAgentExecution {
  settings: AgentExecutionSettings;
  attachments: readonly Pick<
    AgentAttachmentSelection,
    'kind' | 'mediaType' | 'byteCount' | 'sha256'
  >[];
}

export interface ResolvedAgentExecution {
  settings: AgentExecutionSettings;
  model: AgentModel;
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

export class AgentRuntimeDeliveryError extends Error {
  constructor(
    readonly delivery: 'NOT_DELIVERED' | 'AMBIGUOUS',
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'AgentRuntimeDeliveryError';
  }
}

export interface StartAgentRuntimeTurn {
  session: AgentRuntimeSessionRecord;
  run: AgentRuntimeRunRecord;
  executionContext: AgentExecutionContext;
  prompt: string;
  attachments: readonly AgentTurnAttachment[];
}

export interface StartedAgentRuntimeTurn {
  serverInstanceId: string;
  providerSessionId: string;
  providerSessionTreeId?: string;
  providerTurnId: string;
  startedAt: string;
  attachmentSubmissions?: AttachmentSubmissionRecord[];
}

export interface AgentRuntimeAdapter {
  readonly descriptor: AgentRuntimeDescriptor;
  initialize(): Promise<void>;
  preflight(): Promise<AgentPreflight>;
  capabilities(): Promise<AgentRuntimeCapabilities>;
  listModels(): Promise<AgentModel[]>;
  /** Refresh a provider-owned model catalog after an explicit user request. */
  discoverModels?(): Promise<void>;
  readNativeState?(): Promise<AgentJsonValue | undefined>;
  listSessionControls?(): Promise<AgentSessionControlSet[]>;
  applySessionControl?(input: {
    localSessionId: string;
    controlId: string;
    value: AgentSessionControlValue;
    revision: string;
  }): Promise<{ native: AgentJsonValue; controls: AgentSessionControlSet }>;
  configureRuntime?(input: {
    executable?: string;
    restart: boolean;
  }): Promise<void>;
  resolveExecution(input: ResolveAgentExecution): Promise<ResolvedAgentExecution>;
  /** Owner-neutral lifecycle used by workflows with an attested execution context. */
  buildExecutionContext?(
    input: BuildAgentRuntimeExecutionContextInput
  ): Promise<AgentExecutionContext>;
  startRuntimeTurn?(
    input: StartAgentRuntimeTurn
  ): Promise<StartedAgentRuntimeTurn>;
  interruptRuntimeTurn?(input: {
    session: AgentRuntimeSessionRecord;
    run: AgentRuntimeRunRecord;
  }): Promise<void>;
  onRuntimeTurnEvent?(
    listener: (event: AgentRuntimeTurnEvent) => void
  ): () => void;
  createSession(input: CreateAgentSession): Promise<AgentSessionRecord>;
  attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord>;
  /** Release runtime resources without deleting the provider-owned conversation. */
  releaseSession?(ref: AgentSessionRef): Promise<void>;
  readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot>;
  startTurn(input: StartAgentTurn): Promise<AgentTurn>;
  steerTurn?(input: SteerAgentTurn): Promise<void>;
  interruptTurn?(input: InterruptAgentTurn): Promise<void>;
  forkSession?(input: ForkAgentSession): Promise<AgentSessionRecord>;
  syncGoal?(input: SyncAgentGoal): Promise<AgentGoalSnapshotRecord>;
  respondToInteraction(input: AgentInteractionResponse): Promise<void>;
  /** Release runtime-owned processes/streams for a task after Task Monki proves no work is active. */
  releaseTask?(taskId: string): Promise<void>;
  /** Permanently delete provider history owned by a task when the protocol supports it. */
  deleteTaskProviderHistory?(taskId: string): Promise<void>;
  reconcile(): Promise<AgentReconciliationResult>;
  shutdown(): Promise<void>;
}
