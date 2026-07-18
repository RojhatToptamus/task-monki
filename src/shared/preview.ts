export type PreviewNodeKind = 'JOB' | 'SERVICE' | 'WORKER' | 'RESOURCE' | 'ATTACHMENT' | 'PROBE';

export const PREVIEW_POSIX_INHERITED_ENV_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER'
] as const;

export const PREVIEW_WINDOWS_INHERITED_ENV_KEYS = [
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'SYSTEMROOT',
  'USERPROFILE',
  'WINDIR'
] as const;

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

export type PreviewNodeAttemptState =
  | 'INTENDED'
  | 'PREPARING_LAUNCHER'
  | 'RUNNING'
  | 'WAITING_READY'
  | 'READY'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'STOPPING'
  | 'STOPPED'
  | 'RECOVERY_REQUIRED';

export interface PreviewCommandPlan {
  cwd: string;
  command: string[];
}

export interface PreviewJobPlan extends PreviewCommandPlan {
  id: string;
  label?: string;
  role: 'generic' | 'migration' | 'seed';
  retrySafe: boolean;
  needs: Record<string, 'succeeded' | 'ready'>;
  env: Record<string, PreviewEnvironmentValue>;
}

export interface PreviewPortPlan {
  env: string;
}

export type PreviewEnvironmentValue =
  | string
  | {
      type: 'private-input';
      input: string;
    }
  | {
      type: 'service-origin';
      service: string;
      port: string;
    }
  | {
      type: 'route-origin';
      route: string;
    }
  | {
      type: 'postgres-url';
      resource: string;
    }
  | {
      type: 'redis-url';
      resource: string;
    }
  | {
      type: 'attached-http-origin';
      attachment: string;
    }
  | {
      type: 'attached-tcp-host';
      attachment: string;
    }
  | {
      type: 'attached-tcp-port';
      attachment: string;
    }
  | {
      type: 'attached-postgres-url';
      attachment: string;
    }
  | {
      type: 'attached-redis-url';
      attachment: string;
    };

export interface PreviewHttpReadinessPlan {
  type: 'http';
  port: string;
  path: string;
  timeoutSeconds: number;
}

export interface PreviewTcpReadinessPlan {
  type: 'tcp';
  port: string;
  timeoutSeconds: number;
}

export interface PreviewArgvReadinessPlan extends PreviewCommandPlan {
  type: 'argv';
  timeoutSeconds: number;
  env?: Record<string, PreviewEnvironmentValue>;
}

export type PreviewReadinessPlan =
  | PreviewHttpReadinessPlan
  | PreviewTcpReadinessPlan
  | PreviewArgvReadinessPlan;

export interface PreviewLivenessPlan {
  probe: PreviewReadinessPlan;
  intervalSeconds: number;
  failureThreshold: number;
}

export interface PreviewRestartPlan {
  mode: 'never' | 'on-failure' | 'always';
  maxRestarts: number;
  backoffMs: number;
}

export interface PreviewLongRunningPlan extends PreviewCommandPlan {
  id: string;
  label?: string;
  needs: Record<string, 'succeeded' | 'ready'>;
  env: Record<string, PreviewEnvironmentValue>;
  ports: Record<string, PreviewPortPlan>;
  critical: boolean;
  restart: PreviewRestartPlan;
  liveness?: PreviewLivenessPlan;
}

export interface PreviewServicePlan extends PreviewLongRunningPlan {
  ready: PreviewReadinessPlan;
}

export interface PreviewWorkerPlan extends PreviewLongRunningPlan {
  ready: PreviewReadinessPlan;
  overlap: 'exclusive' | 'safe';
}

export interface PreviewRoutePlan {
  id: string;
  service: string;
  port: string;
  primary: boolean;
}

export interface PreviewComposePortPlan {
  target: number;
  protocol: 'tcp';
}

export interface PreviewComposeServicePlan {
  id: string;
  ports: Record<string, PreviewComposePortPlan>;
  ready?: PreviewHttpReadinessPlan | PreviewTcpReadinessPlan;
}

export interface PreviewComposeHostInput {
  kind: 'COMPOSE_FILE' | 'ENV_FILE' | 'SECRET_FILE' | 'BUILD_CONTEXT' | 'DOCKERFILE';
  path: string;
  format?: 'COMPOSE' | 'RAW';
}

export interface PreviewComposeServiceInspection {
  id: string;
  image?: string;
  platform?: string;
  build?: { context: string; dockerfile?: string };
  command?: string[];
  entrypoint?: string[];
  user?: string;
  workingDirectory?: string;
  dependsOn: Array<{
    service: string;
    condition: 'service_started' | 'service_healthy';
    required: boolean;
    restart: boolean;
  }>;
  exposedPorts: number[];
  environmentKeys: string[];
  secretSources: string[];
  namedVolumes: Array<{ source: string; target: string; readOnly: boolean }>;
  networks: string[];
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    startPeriod?: string;
    retries?: number;
  };
}

export interface PreviewComposeInspection {
  composeVersion: string;
  supportsNoEnvResolution: true;
  trustDigest: string;
  configDigest: string;
  hostInputs: PreviewComposeHostInput[];
  services: PreviewComposeServiceInspection[];
  volumes: Array<{ name: string; external: boolean; driver?: string }>;
  networks: Array<{ name: string; external: boolean }>;
}

export interface PreviewComposePlan {
  files: string[];
  projectDirectory: string;
  profiles: string[];
  rootServices: string[];
  services: PreviewComposeServicePlan[];
  inspection?: PreviewComposeInspection;
}

export interface PreviewOciResourceLimits {
  cpus?: number;
  memoryMb?: number;
  diskMb?: number;
  pids?: number;
}

interface PreviewOciResourcePlanBase {
  id: string;
  label?: string;
  image: string;
  limits: PreviewOciResourceLimits;
}

export interface PreviewPostgresResourcePlan extends PreviewOciResourcePlanBase {
  type: 'postgres';
  database: string;
}

export interface PreviewRedisResourcePlan extends PreviewOciResourcePlanBase {
  type: 'redis';
}

export type PreviewOciResourcePlan =
  | PreviewPostgresResourcePlan
  | PreviewRedisResourcePlan;

export interface PreviewPrivateInputPlan {
  id: string;
  type: 'private';
  label?: string;
}

export interface PreviewLocalAttachmentTarget {
  type: 'local';
}

export interface PreviewHttpEndpointTarget {
  type: 'endpoint';
  scheme: 'http' | 'https';
  host: string;
  port: number;
  basePath: string;
}

export interface PreviewTcpEndpointTarget {
  type: 'endpoint';
  host: string;
  port: number;
}

export interface PreviewPostgresEndpointTarget {
  type: 'endpoint';
  host: string;
  port: number;
  database: string;
  username: string;
  tls: 'disabled' | 'system-verified';
}

export interface PreviewRedisEndpointTarget {
  type: 'endpoint';
  host: string;
  port: number;
  database: number;
  username?: string;
  tls: 'disabled' | 'system-verified';
}

export interface PreviewTaskRouteTarget {
  type: 'task-preview-route';
  targetTaskId: string;
  routeId: string;
  basePath: string;
}

export interface PreviewAttachmentCheckPlan {
  timeoutSeconds: number;
  path?: string;
}

interface PreviewAttachmentPlanBase {
  id: string;
  label?: string;
  check?: PreviewAttachmentCheckPlan;
}

export interface PreviewHttpAttachmentPlan extends PreviewAttachmentPlanBase {
  type: 'http';
  target: PreviewLocalAttachmentTarget | PreviewHttpEndpointTarget | PreviewTaskRouteTarget;
}

export interface PreviewTcpAttachmentPlan extends PreviewAttachmentPlanBase {
  type: 'tcp';
  target: PreviewLocalAttachmentTarget | PreviewTcpEndpointTarget;
}

export interface PreviewPostgresAttachmentPlan extends PreviewAttachmentPlanBase {
  type: 'postgres';
  target: PreviewLocalAttachmentTarget | PreviewPostgresEndpointTarget;
  passwordInput?: string;
}

export interface PreviewRedisAttachmentPlan extends PreviewAttachmentPlanBase {
  type: 'redis';
  target: PreviewLocalAttachmentTarget | PreviewRedisEndpointTarget;
  passwordInput?: string;
}

export type PreviewAttachmentPlan =
  | PreviewHttpAttachmentPlan
  | PreviewTcpAttachmentPlan
  | PreviewPostgresAttachmentPlan
  | PreviewRedisAttachmentPlan;

export type PreviewResolvedAttachmentTarget =
  | PreviewHttpEndpointTarget
  | PreviewTcpEndpointTarget
  | PreviewPostgresEndpointTarget
  | PreviewRedisEndpointTarget
  | PreviewTaskRouteTarget;

export interface PreviewLocalAttachmentBindingRecord {
  id: string;
  taskId: string;
  attachmentId: string;
  target: PreviewResolvedAttachmentTarget;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewScenarioPlan {
  id: string;
  label?: string;
  jobs: string[];
  resources: string[];
}

export interface PreviewExecutionPlan {
  version: 1;
  adapter?: 'NATIVE' | 'COMPOSE';
  compose?: PreviewComposePlan;
  inputs?: PreviewPrivateInputPlan[];
  attachments?: PreviewAttachmentPlan[];
  jobs: PreviewJobPlan[];
  resources: PreviewOciResourcePlan[];
  services: PreviewServicePlan[];
  workers: PreviewWorkerPlan[];
  routes: PreviewRoutePlan[];
  scenarios: PreviewScenarioPlan[];
  selectedScenarioId: string;
}

export interface PreviewPlanRecord {
  id: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  recipePath: '.taskmonki/preview.yaml';
  recipeVersion: 1;
  recipeDigest: string;
  executionDigest: string;
  executionPlan: PreviewExecutionPlan;
  ociCapability?: PreviewOciEngineCapability;
  warnings: string[];
  createdAt: string;
}

export interface PreviewApprovalRecord {
  id: string;
  taskId: string;
  planId: string;
  executionDigest: string;
  scope: 'TASK';
  approvedAt: string;
  invalidatedAt?: string;
  invalidatedReason?: string;
}

export interface PreviewRouteRecord {
  id: string;
  hostname: string;
  url: string;
  gatewayPort: number;
  targetHost: '127.0.0.1';
  targetPort: number;
  state: 'DETACHED' | 'ATTACHED';
}

export interface PreviewGenerationRecord {
  id: string;
  previewKey: string;
  taskId: string;
  iterationId: string;
  worktreeId: string;
  planId: string;
  approvalId: string;
  executionDigest: string;
  adapter?: 'NATIVE' | 'COMPOSE';
  composeChange?: PreviewComposeChangeKind;
  sourceGitSnapshotId: string;
  sourceHeadSha: string;
  sourceDirtyFingerprint: string;
  sourceManifestArtifactId?: string;
  sourceManifestDigest?: string;
  workspacePath: string;
  state: PreviewGenerationState;
  routingState: 'CANDIDATE' | 'ACTIVE' | 'RETIRED';
  replacesGenerationId?: string;
  freshness: 'CURRENT' | 'STALE' | 'UNKNOWN';
  routes: PreviewRouteRecord[];
  attachmentReadiness?: PreviewAttachmentReadinessEvidence[];
  failureReason?: string;
  cleanupReason?: string;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  cutoverAt?: string;
  stoppedAt?: string;
}

export type PreviewComposeChangeKind =
  | 'IN_PLACE_UPDATE'
  | 'RESTART_PRESERVE_DATA'
  | 'DESTRUCTIVE_RESET_REQUIRED';

export type PreviewComposeProjectState =
  | 'INTENDED'
  | 'STARTING'
  | 'READY'
  | 'PREPARING_UPDATE'
  | 'UPDATING'
  | 'RESTARTING'
  | 'RECOVERY_REQUIRED'
  | 'STOPPING'
  | 'STOPPED'
  | 'CLEANUP_INCOMPLETE';

export interface PreviewComposeContainerRecord {
  serviceId: string;
  object: PreviewOciObjectIdentity;
}

export interface PreviewComposeVolumeRecord {
  logicalName: string;
  external: boolean;
  state: 'ACTIVE' | 'RETAINED';
  object?: PreviewOciObjectIdentity;
}

export interface PreviewComposeNetworkRecord {
  logicalName: string;
  external: boolean;
  object?: PreviewOciObjectIdentity;
}

export interface PreviewComposeProjectRecord {
  id: string;
  taskId: string;
  previewKey: string;
  projectName: string;
  state: PreviewComposeProjectState;
  engine: PreviewOciEngineIdentity;
  composeVersion: string;
  trustDigest: string;
  configDigest: string;
  ownershipMarkerDigest: string;
  activeGenerationId?: string;
  pendingGenerationId?: string;
  containers: PreviewComposeContainerRecord[];
  volumes: PreviewComposeVolumeRecord[];
  networks: PreviewComposeNetworkRecord[];
  failureReason?: string;
  cleanupAttemptedAt?: string;
  cleanupError?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
}

export type PreviewAttachmentFailureCode =
  | 'TARGET_UNAVAILABLE'
  | 'CHECK_TIMEOUT'
  | 'TLS_FAILED'
  | 'AUTHENTICATION_FAILED'
  | 'CHECK_FAILED'
  | 'CHECK_CANCELED';

export interface PreviewAttachmentReadinessEvidence {
  attachmentId: string;
  status: 'PASSED' | 'FAILED';
  observedAt: string;
  failureCode?: PreviewAttachmentFailureCode;
}

export interface PreviewProcessIdentity {
  pid: number;
  processGroupId: number;
  startedAt: string;
  command: string;
}

export interface PreviewNativeProcessIdentity {
  receiptPath: string;
  ownershipToken: string;
  commandDigest: string;
  launcher: PreviewProcessIdentity;
  target?: PreviewProcessIdentity;
}

export type PreviewOciCapabilityStatus =
  | 'READY'
  | 'ENGINE_MISSING'
  | 'ENGINE_UNAVAILABLE'
  | 'UNSUPPORTED_ENGINE';

export interface PreviewOciEngineIdentity {
  contextName: string;
  endpointDigest: string;
  engineId: string;
  serverVersion: string;
  apiVersion: string;
  operatingSystem: string;
  architecture: string;
}

export interface PreviewOciEngineCapability {
  status: PreviewOciCapabilityStatus;
  contextName?: string;
  identity?: PreviewOciEngineIdentity;
  supportsMemoryLimit: boolean;
  supportsCpuLimit: boolean;
  supportsPidsLimit: boolean;
  reason?: string;
}

export interface PreviewOciPublishedPort {
  containerPort: number;
  protocol: 'tcp' | 'udp';
  hostIp: '127.0.0.1';
  hostPort: number;
}

export interface PreviewOciObjectIdentity {
  engine: PreviewOciEngineIdentity;
  objectId?: string;
  objectName: string;
  labelsDigest: string;
  imageReference?: string;
  imageId?: string;
  publishedPorts?: PreviewOciPublishedPort[];
}

export type PreviewManagedEnvironmentState =
  | 'INTENDED'
  | 'STARTING'
  | 'READY'
  | 'STOPPING'
  | 'STOPPED'
  | 'CLEANUP_INCOMPLETE';

export interface PreviewManagedEnvironmentRecord {
  id: string;
  previewKey: string;
  taskId: string;
  state: PreviewManagedEnvironmentState;
  engine: PreviewOciEngineIdentity;
  network: PreviewOciObjectIdentity;
  ownershipMarkerDigest: string;
  cleanupAttemptedAt?: string;
  cleanupError?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
}

export type PreviewManagedResourceState =
  | 'INTENDED'
  | 'STARTING'
  | 'SETTING_UP'
  | 'READY'
  | 'SETUP_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'FAILED'
  | 'STOPPING'
  | 'STOPPED'
  | 'CLEANUP_INCOMPLETE';

export interface PreviewManagedResourceBindingRecord {
  id: string;
  digest: string;
  host: '127.0.0.1';
  ports: Record<string, number>;
  username?: string;
  database?: string;
}

export interface PreviewManagedResourceRecord {
  id: string;
  taskId: string;
  environmentId: string;
  logicalResourceId: string;
  type: 'postgres' | 'redis';
  state: PreviewManagedResourceState;
  planDigest: string;
  ownershipMarkerDigest: string;
  container: PreviewOciObjectIdentity;
  volume: PreviewOciObjectIdentity;
  binding?: PreviewManagedResourceBindingRecord;
  creationAttemptedAt?: string;
  setupAttemptedAt?: string;
  readyAt?: string;
  failureReason?: string;
  cleanupAttemptedAt?: string;
  cleanupError?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
}

export interface PreviewGenerationAttachmentRecord {
  id: string;
  taskId: string;
  generationId: string;
  managedResourceId: string;
  logicalResourceId: string;
  bindingId: string;
  attachedAt: string;
}

interface PreviewResourceRecordBase {
  id: string;
  taskId: string;
  generationId: string;
  logicalNodeId: string;
  state: 'INTENDED' | 'PREPARED' | 'RUNNING' | 'STOPPED' | 'EXITED' | 'FAILED' | 'CLEANUP_INCOMPLETE';
  ownershipMarkerDigest: string;
  receiptPath?: string;
  targetHost?: '127.0.0.1';
  targetPort?: number;
  creationAttemptedAt?: string;
  cleanupAttemptedAt?: string;
  cleanupError?: string;
  updatedAt: string;
}

export interface PreviewNativeResourceRecord extends PreviewResourceRecordBase {
  adapterKind: 'NATIVE_PROCESS';
  native?: PreviewNativeProcessIdentity;
}

export type PreviewResourceRecord = PreviewNativeResourceRecord;

export interface PreviewNodeAttemptRecord {
  id: string;
  taskId: string;
  generationId: string;
  nodeId: string;
  kind: PreviewNodeKind;
  attempt: number;
  commandDigest: string;
  state: PreviewNodeAttemptState;
  stdoutArtifactId: string;
  stderrArtifactId: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  readiness?: {
    status: 'PENDING' | 'PASSED' | 'FAILED';
    lastStatusCode?: number;
    lastError?: string;
    observedAt?: string;
  };
}

export interface ResolvePreviewRequest {
  taskId: string;
  scenarioId?: string;
}

export type PreviewUnavailableReasonCode = 'RECIPE_MISSING';

export type PreviewExecutionBlocker =
  | { kind: 'PRIVATE_INPUT_MISSING'; inputId: string }
  | { kind: 'PRIVATE_INPUT_LOCKED'; inputId: string }
  | { kind: 'PRIVATE_INPUT_CORRUPT'; inputId: string }
  | { kind: 'PROTECTION_UNAVAILABLE'; inputId: string };

export interface PreviewExecutionReadiness {
  status: 'READY' | 'BLOCKED';
  blockers: PreviewExecutionBlocker[];
}

export type PreviewLocalAttachmentUsage =
  | {
      kind: 'ENVIRONMENT';
      recipient: 'PROCESS' | 'READINESS_PROBE' | 'LIVENESS_PROBE';
      nodeKind: 'JOB' | 'SERVICE' | 'WORKER';
      nodeId: string;
      environmentKeys: string[];
    }
  | {
      kind: 'READINESS_DEPENDENCY';
      nodeKind: 'JOB' | 'SERVICE' | 'WORKER';
      nodeId: string;
    };

export interface PreviewLocalAttachmentRequirement {
  attachmentId: string;
  label?: string;
  attachmentType: PreviewAttachmentPlan['type'];
  allowedTargetTypes: Array<'endpoint' | 'task-preview-route'>;
  usages: PreviewLocalAttachmentUsage[];
}

export type ResolvePreviewResult =
  | {
      status: 'UNAVAILABLE';
      reason: string;
      reasonCode?: PreviewUnavailableReasonCode;
    }
  | {
      status: 'CONFIGURATION_REQUIRED';
      reason: string;
      selectedScenarioId: string;
      requirements: PreviewLocalAttachmentRequirement[];
    }
  | {
      status: 'PLAN';
      plan: PreviewPlanRecord;
      approval?: PreviewApprovalRecord;
      executionReadiness: PreviewExecutionReadiness;
    };

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
  | 'INSUFFICIENT_EVIDENCE';

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
  model?: string;
}

export interface ValidatePreviewRecipeDraftRequest {
  taskId: string;
  draftId: string;
  yaml: string;
}

export interface AcceptPreviewRecipeDraftRequest
  extends ValidatePreviewRecipeDraftRequest {}

export interface AcceptPreviewRecipeDraftResult {
  recipePath: '.taskmonki/preview.yaml';
  resolution?: ResolvePreviewResult;
  checkError?: string;
}

export interface DiscardPreviewRecipeDraftRequest {
  taskId: string;
}

export interface SetPreviewLocalAttachmentBindingRequest {
  taskId: string;
  attachmentId: string;
  target: PreviewResolvedAttachmentTarget;
}

export interface DeletePreviewLocalAttachmentBindingRequest {
  taskId: string;
  attachmentId: string;
}

export interface SetPreviewPrivateInputRequest {
  taskId: string;
  inputId: string;
  value: string;
}

export interface ImportPreviewPrivateInputRequest {
  taskId: string;
  inputId: string;
  key: string;
}

export interface DeletePreviewPrivateInputRequest {
  taskId: string;
  inputId: string;
}

export interface RetryPreviewVaultCleanupResult {
  status: 'CLEAN' | 'CLEANUP_PENDING' | 'RECOVERY_REQUIRED';
}

export type PreviewPrivateInputOperationResult =
  | { status: 'STORED' | 'IMPORTED' | 'DELETED' | 'CANCELED' }
  | {
      status: 'FAILED';
      code:
        | 'PROTECTION_UNAVAILABLE'
        | 'INPUT_NOT_DECLARED'
        | 'INVALID_VALUE'
        | 'INVALID_KEY'
        | 'KEY_MISSING'
        | 'KEY_DUPLICATE'
        | 'UNSAFE_IMPORT_FILE'
        | 'VAULT_RECOVERY_REQUIRED';
    };

export interface PreviewPrivateInputApi {
  set(input: SetPreviewPrivateInputRequest): Promise<PreviewPrivateInputOperationResult>;
  import(input: ImportPreviewPrivateInputRequest): Promise<PreviewPrivateInputOperationResult>;
  delete(input: DeletePreviewPrivateInputRequest): Promise<PreviewPrivateInputOperationResult>;
  retryCleanup(): Promise<RetryPreviewVaultCleanupResult>;
}

export interface ApprovePreviewPlanRequest {
  taskId: string;
  planId: string;
  executionDigest: string;
}

export interface StartPreviewRequest {
  taskId: string;
  scenarioId?: string;
}

export interface StopPreviewRequest {
  taskId: string;
  generationId: string;
}

export interface ResetPreviewDataRequest {
  taskId: string;
  generationId: string;
  resourceId: string;
  scenarioId: string;
}

export interface RetryPreviewSetupRequest {
  taskId: string;
  generationId: string;
  scenarioId: string;
}

export interface OpenPreviewRequest {
  taskId: string;
  generationId: string;
  routeId: string;
}

export interface ReadPreviewLogRequest {
  taskId: string;
  artifactId: string;
  offset: number;
  maxBytes: number;
}

export interface ReadPreviewLogResult {
  chunk: string;
  nextOffset: number;
  endOfFile: boolean;
}

export interface OpenPreviewResult {
  opened: boolean;
  url: string;
}
