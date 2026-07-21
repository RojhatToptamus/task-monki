import type { RefObject } from 'react';
import type {
  PreviewApprovalRecord,
  PreviewComposeProjectRecord,
  PreviewGenerationAttachmentRecord,
  PreviewGenerationRecord,
  PreviewLocalAttachmentBindingRecord,
  PreviewManagedResourceRecord,
  PreviewNodeAttemptRecord,
  PreviewPlanRecord,
  PreviewRecipeGenerationSnapshot,
  PreviewRecipeValidation,
  PreviewResolvedAttachmentTarget,
  PreviewResourceRecord,
  ReadPreviewLogResult,
  ResolvePreviewResult,
  Task,
  WorktreeRecord
} from '../../../shared/contracts';
import type { PreviewExecutionReadiness } from '../../../shared/preview';
import type {
  PreviewActionId,
  PreviewActionModel,
  PreviewViewModel
} from '../../model/preview';
import type { PreviewTaskRouteOption } from '../../model/previewBindings';

export interface PreviewPanelProps {
  task: Task;
  worktree?: WorktreeRecord;
  plans: PreviewPlanRecord[];
  approvals: PreviewApprovalRecord[];
  generations: PreviewGenerationRecord[];
  generationAttachments: PreviewGenerationAttachmentRecord[];
  attempts: PreviewNodeAttemptRecord[];
  managedResources: PreviewManagedResourceRecord[];
  composeProjects: PreviewComposeProjectRecord[];
  localBindings: PreviewLocalAttachmentBindingRecord[];
  taskRouteOptions: PreviewTaskRouteOption[];
  runtimeResources: PreviewResourceRecord[];
  executionReadiness?: PreviewExecutionReadiness;
  resolution?: ResolvePreviewResult;
  recipeGeneration?: PreviewRecipeGenerationSnapshot;
  onResolve(taskId: string, scenarioId?: string): Promise<void>;
  onSetLocalBinding(
    taskId: string,
    attachmentId: string,
    target: PreviewResolvedAttachmentTarget,
    scenarioId: string
  ): Promise<void>;
  onGetRecipeGeneration(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  onGenerateRecipe(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  onValidateRecipeDraft(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<PreviewRecipeValidation>;
  onAcceptRecipeDraft(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<import('../../../shared/contracts').AcceptPreviewRecipeDraftResult>;
  onDiscardRecipeDraft(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  onWriteRecipeManually(taskId: string, worktreeId: string): Promise<void>;
  onApprove(taskId: string, planId: string, executionDigest: string): Promise<void>;
  onStart(taskId: string, scenarioId?: string): Promise<void>;
  onOpen(taskId: string, generationId: string, routeId: string): Promise<void>;
  onStop(taskId: string, generationId: string): Promise<void>;
  onResetData(
    taskId: string,
    generationId: string,
    resourceId: string,
    scenarioId: string
  ): Promise<void>;
  onRetrySetup(
    taskId: string,
    generationId: string,
    scenarioId: string
  ): Promise<void>;
  onReadLog(
    taskId: string,
    artifactId: string,
    offset: number,
    maxBytes: number
  ): Promise<ReadPreviewLogResult>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  modalRootRef: RefObject<HTMLElement | null>;
  onModalOpenChange(open: boolean): void;
}

export interface PreviewConfirmation {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  impacts?: Array<{
    tone: 'deleted' | 'kept' | 'untouched';
    detail: string;
  }>;
  requireText?: string;
  returnFocus?: HTMLElement;
  run(): Promise<void>;
}

export interface PreviewController {
  view: PreviewViewModel;
  busy: Set<PreviewActionId>;
  resetBusy?: string;
  resettableResources: PreviewPlanRecord['executionPlan']['resources'];
  confirmation?: PreviewConfirmation;
  confirmationBusy: boolean;
  runAction(action: PreviewActionId): Promise<void>;
  requestAction(action: PreviewActionModel, returnFocus?: HTMLElement): void;
  requestReset(resourceId: string, returnFocus?: HTMLElement): void;
  closeConfirmation(): void;
  confirm(): Promise<void>;
}
