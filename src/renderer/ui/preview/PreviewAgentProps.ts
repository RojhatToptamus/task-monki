import type { RefObject } from 'react';
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
import type { AgentConversationRecords } from '../../model/agentRecords';
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

/**
 * The task page's side sheet that shows the Preview agent, as for the reviewer
 * and side questions. The Preview owns the conversation and renders it into
 * `slot`; the page owns whether it is open, where it docks, and its toggle.
 */
export interface PreviewAgentHost {
  open: boolean;
  /** `focus` when the person asked for it, so a panel opened by a question never takes focus. */
  onOpenChange(open: boolean, focus?: boolean): void;
  slot: HTMLElement | null;
  docked: boolean;
  autoFocus: boolean;
  toggleRef: RefObject<HTMLElement | null>;
}
