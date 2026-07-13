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

export type PreviewExecutionBlocker =
  | { kind: 'PRIVATE_INPUT_MISSING'; inputId: string }
  | { kind: 'PRIVATE_INPUT_LOCKED'; inputId: string }
  | { kind: 'PRIVATE_INPUT_CORRUPT'; inputId: string }
  | { kind: 'PROTECTION_UNAVAILABLE'; inputId: string };

export interface PreviewExecutionReadiness {
  status: 'READY' | 'BLOCKED';
  blockers: PreviewExecutionBlocker[];
}

export type ResolvePreviewResult =
  | { status: 'UNAVAILABLE'; reason: string }
  | {
      status: 'CONFIGURATION_REQUIRED';
      reason: string;
      attachmentIds: string[];
    }
  | {
      status: 'PLAN';
      plan: PreviewPlanRecord;
      approval?: PreviewApprovalRecord;
      executionReadiness: PreviewExecutionReadiness;
    };

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
