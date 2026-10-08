import type {
  PreviewRecipeGenerationSnapshot,
  PreviewRecipeValidation,
  AcceptPreviewRecipeDraftResult
} from '../../../shared/contracts';

/** The same authoring mechanism serves first setup, edits, and failure recovery. */
export interface PreviewAgentActions {
  state?: PreviewRecipeGenerationSnapshot;
  disabledReason?: string;
  get(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  generate(
    taskId: string,
    clarification?: string
  ): Promise<PreviewRecipeGenerationSnapshot>;
  validate(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<PreviewRecipeValidation>;
  accept(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<AcceptPreviewRecipeDraftResult>;
  discard(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
}
