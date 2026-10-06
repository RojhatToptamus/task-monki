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

export type PreviewRecipeGenerationStage =
  | 'PREPARING_EVIDENCE'
  | 'GENERATING_DRAFT'
  | 'VALIDATING_DRAFT';

export interface PreviewRecipeGenerationEvidence {
  path: string;
  finding: string;
}

export interface PreviewRecipeGenerationReport {
  summary: string;
  evidence: PreviewRecipeGenerationEvidence[];
  assumptions: string[];
  omissions: string[];
  unresolvedDecisions: string[];
  publicEnvironmentDecisions: PreviewPublicEnvironmentDecision[];
}

export interface PreviewPublicEnvironmentDecision {
  candidateId: string;
  key: string;
  decision: 'HTTP_ATTACHMENT' | 'SOURCE_DEFAULT' | 'OMIT';
  reason: string;
  attachmentId?: string;
}

export type PreviewRecipeValidationIssueCode =
  | 'EMPTY_RECIPE'
  | 'RECIPE_TOO_LARGE'
  | 'INVALID_RECIPE'
  | 'SECRET_LITERAL'
  | 'INCOMPATIBLE_COMMAND'
  | 'DEPENDENCY_PREPARATION_REQUIRED'
  | 'PUBLIC_ENVIRONMENT_DECISION_INVALID';

export interface PreviewRecipeValidationIssue {
  code: PreviewRecipeValidationIssueCode;
  message: string;
}

export type PreviewRecipeValidation =
  | { status: 'VALID' }
  | { status: 'INVALID'; issues: PreviewRecipeValidationIssue[] };

export interface PreviewRecipeGenerationDraft {
  id: string;
  taskId: string;
  yaml: string;
  report: PreviewRecipeGenerationReport;
  validation: PreviewRecipeValidation;
  generatedAt: string;
}

export type PreviewRecipeGenerationFailureCode =
  | 'AGENT_UNAVAILABLE'
  | 'GENERATION_TIMED_OUT'
  | 'INVALID_AGENT_OUTPUT'
  | 'INSUFFICIENT_EVIDENCE'
  | 'RECIPE_EXISTS'
  | 'CANCELLATION_UNCONFIRMED';

export interface PreviewRecipeGenerationSnapshot {
  taskId: string;
  status: 'EMPTY' | 'GENERATING' | 'READY' | 'NEEDS_INPUT' | 'FAILED';
  stage?: PreviewRecipeGenerationStage;
  draft?: PreviewRecipeGenerationDraft;
  report?: PreviewRecipeGenerationReport;
  failureCode?: PreviewRecipeGenerationFailureCode;
  message?: string;
  startedAt?: string;
}

export interface GetPreviewRecipeGenerationRequest {
  taskId: string;
}

export interface GeneratePreviewRecipeRequest {
  taskId: string;
  clarification?: string;
}

export interface ValidatePreviewRecipeDraftRequest {
  taskId: string;
  draftId: string;
  yaml: string;
}

export interface AcceptPreviewRecipeDraftRequest
  extends ValidatePreviewRecipeDraftRequest {}

export interface AcceptPreviewRecipeDraftResult {
  recipePath: 'preview.yaml';
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
