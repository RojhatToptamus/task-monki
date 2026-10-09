import type { AgentExecutionSettings } from './agent';

export type PreviewGenerationState =
  | 'CREATED'
  | 'PREPARING_SOURCE'
  | 'RUNNING_GRAPH'
  | 'WAITING_READY'
  | 'READY'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'
  | 'CLEANUP_INCOMPLETE';

export interface PreviewSourceIdentity { type: 'EXACT_COMMIT'; repositoryId: string; commitSha: string; designRevisionId?: string; }

export interface PreviewRouteRecord {
  id: string;
  url: string;
  state: 'DETACHED' | 'ATTACHED';
}

export interface PreviewGenerationRecord {
  id: string;
  previewKey: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  runtimeAttemptId?: string;
  source: PreviewSourceIdentity;
  workspacePath: string;
  state: PreviewGenerationState;
  routingState: 'CANDIDATE' | 'ACTIVE' | 'RETIRED';
  replacesGenerationId?: string;
  routes: PreviewRouteRecord[];
  failureReason?: string;
  cleanupReason?: string;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  cutoverAt?: string;
  stoppedAt?: string;
}

/** The agent's own account of a proposal: one summary and the facts it rests on. */
export interface PreviewRecipeGenerationReport {
  summary: string;
  notes: string[];
}

export type PreviewRecipeValidationIssueCode =
  | 'EMPTY_RECIPE'
  | 'RECIPE_TOO_LARGE'
  | 'INVALID_RECIPE'
  | 'SECRET_LITERAL'
  | 'INCOMPATIBLE_COMMAND'
  | 'DEPENDENCY_PREPARATION_REQUIRED';

export interface PreviewRecipeValidationIssue {
  code: PreviewRecipeValidationIssueCode;
  message: string;
}

export type PreviewRecipeValidation =
  | { status: 'VALID' }
  | { status: 'INVALID'; issues: PreviewRecipeValidationIssue[] };

/** A configuration the Preview agent proposed. It lives in memory until the user saves or discards it. */
export interface PreviewRecipeGenerationDraft {
  id: string;
  taskId: string;
  yaml: string;
  report: PreviewRecipeGenerationReport;
  validation: PreviewRecipeValidation;
  generatedAt: string;
  fileName: 'preview.yaml' | 'preview.yml';
  replacesExistingFile: boolean;
}

export interface PreviewRecipeGenerationSnapshot {
  taskId: string;
  status: 'EMPTY' | 'READY';
  draft?: PreviewRecipeGenerationDraft;
}

export interface GetPreviewRecipeGenerationRequest {
  taskId: string;
}

/** One message to the task's Preview agent; `id` makes a retry idempotent. */
export interface SendPreviewAgentMessageRequest {
  taskId: string;
  id: string;
  text: string;
  /** Runtime, model and reasoning effort for this and later turns; defaults come from Settings. */
  settings?: AgentExecutionSettings;
}

export interface StopPreviewAgentRequest {
  taskId: string;
}

export interface ValidatePreviewRecipeDraftRequest {
  taskId: string;
  draftId: string;
  yaml: string;
}

export interface AcceptPreviewRecipeDraftRequest
  extends ValidatePreviewRecipeDraftRequest {}

export interface AcceptPreviewRecipeDraftResult {
  recipePath: 'preview.yaml' | 'preview.yml';
}

export interface DiscardPreviewRecipeDraftRequest {
  taskId: string;
}

export interface OpenPreviewRequest {
  taskId: string;
  generationId: string;
  routeId: string;
}

export interface OpenPreviewResult {
  opened: boolean;
  url: string;
}
