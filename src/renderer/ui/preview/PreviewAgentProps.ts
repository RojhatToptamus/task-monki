import type {
  AcceptPreviewRecipeDraftResult,
  AgentExecutionSettings,
  AgentInteractionDecision,
  AgentModel,
  AgentRuntimeState,
  InteractionRequestRecord,
  PreviewRecipeGenerationSnapshot,
  PreviewRecipeValidation
} from '../../../shared/contracts';
import type { AgentConversationRecords } from '../../model/previewAgentRecords';
import type { PreviewAgentDefaults } from '../../model/previewAgentSelection';

/** The proposal the Preview agent left for review: validate, save, or discard it. */
export interface PreviewProposalActions {
  state?: PreviewRecipeGenerationSnapshot;
  get(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  validate(taskId: string, draftId: string, yaml: string): Promise<PreviewRecipeValidation>;
  accept(taskId: string, draftId: string, yaml: string): Promise<AcceptPreviewRecipeDraftResult>;
  discard(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
}

/** The task's Preview conversation: its records and the actions the panel can take on it. */
export interface PreviewAgentConversation extends AgentConversationRecords {
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  defaults: PreviewAgentDefaults;
  /** Why no message can be sent, such as an unavailable configured runtime. */
  disabledReason?: string;
  onDiscoverModels?(runtimeId: string): Promise<void>;
  /** Sends now or queues behind the active turn; the same id resends a held message. */
  send(text: string, id: string, settings?: AgentExecutionSettings): Promise<void>;
  stop(): Promise<void>;
  /** Changes a pending message's text, or removes it when text is omitted. */
  editQueued(id: string, text?: string): Promise<void>;
  respond(interaction: InteractionRequestRecord, decision: AgentInteractionDecision): Promise<void>;
  readArtifact?(id: string): Promise<string>;
}
