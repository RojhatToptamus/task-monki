export type PreviewNodeKind = 'JOB' | 'SERVICE' | 'WORKER' | 'PROBE';

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
  | 'RUNNING_JOBS'
  | 'STARTING_SERVICES'
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
  needs: Record<string, 'succeeded'>;
}

export interface PreviewPortPlan {
  env: string;
}

export type PreviewEnvironmentValue =
  | string
  | {
      type: 'service-origin';
      service: string;
      port: string;
    }
  | {
      type: 'route-origin';
      route: string;
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
  ready?: PreviewReadinessPlan;
}

export interface PreviewRoutePlan {
  id: string;
  service: string;
  port: string;
  primary: boolean;
}

export interface PreviewExecutionPlan {
  version: 1;
  jobs: PreviewJobPlan[];
  services: PreviewServicePlan[];
  workers: PreviewWorkerPlan[];
  routes: PreviewRoutePlan[];
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
  failureReason?: string;
  cleanupReason?: string;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  cutoverAt?: string;
  stoppedAt?: string;
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

export interface PreviewResourceRecord {
  id: string;
  taskId: string;
  generationId: string;
  logicalNodeId: string;
  adapterKind: 'NATIVE_PROCESS';
  state: 'INTENDED' | 'PREPARED' | 'RUNNING' | 'STOPPED' | 'EXITED' | 'FAILED' | 'CLEANUP_INCOMPLETE';
  ownershipMarkerDigest: string;
  receiptPath?: string;
  native?: PreviewNativeProcessIdentity;
  targetHost?: '127.0.0.1';
  targetPort?: number;
  creationAttemptedAt?: string;
  cleanupAttemptedAt?: string;
  cleanupError?: string;
  updatedAt: string;
}

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
}

export type ResolvePreviewResult =
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'PLAN'; plan: PreviewPlanRecord; approval?: PreviewApprovalRecord };

export interface ApprovePreviewPlanRequest {
  taskId: string;
  planId: string;
  executionDigest: string;
}

export interface StartPreviewRequest {
  taskId: string;
}

export interface StopPreviewRequest {
  taskId: string;
  generationId: string;
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
