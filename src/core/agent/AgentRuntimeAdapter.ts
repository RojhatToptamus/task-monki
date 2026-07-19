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
  InteractionRequestRecord
} from '../../shared/agent';
import type { RefinePromptResponse } from '../../shared/contracts';
import type { AgentTurnAttachment } from './AgentAttachmentDelivery';

export interface CreateAgentSession {
  runtimeId: AgentRuntimeId;
  localSessionId: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  worktreePath: string;
  settings: AgentExecutionSettings;
  /**
   * Storage-verified task attachments whose exact managed paths must be part
   * of a provider session's initial confinement boundary.
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

export interface ResolveAgentExecution {
  settings: AgentExecutionSettings;
  attachments: readonly Pick<AgentTurnAttachment, 'kind'>[];
}

export interface ResolvedAgentExecution {
  settings: AgentExecutionSettings;
  model: AgentModel;
}

export interface RefineAgentPrompt {
  repositoryPath: string;
  input: string;
  settings: AgentExecutionSettings;
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
  refinePrompt?(input: RefineAgentPrompt): Promise<RefinePromptResponse>;
  createSession(input: CreateAgentSession): Promise<AgentSessionRecord>;
  attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord>;
  /** Release runtime resources without deleting the provider-owned conversation. */
  releaseSession?(ref: AgentSessionRef): Promise<void>;
  readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot>;
  startTurn(input: StartAgentTurn): Promise<AgentTurn>;
  steerTurn?(input: SteerAgentTurn): Promise<void>;
  interruptTurn?(input: InterruptAgentTurn): Promise<void>;
  forkSession?(input: ForkAgentSession): Promise<AgentSessionRecord>;
  startReview?(input: StartAgentReview): Promise<AgentTurn>;
  syncGoal?(input: SyncAgentGoal): Promise<AgentGoalSnapshotRecord>;
  respondToInteraction(input: AgentInteractionResponse): Promise<void>;
  /** Release runtime-owned processes/streams for a task after Task Monki proves no work is active. */
  releaseTask?(taskId: string): Promise<void>;
  reconcile(): Promise<AgentReconciliationResult>;
  shutdown(): Promise<void>;
}
