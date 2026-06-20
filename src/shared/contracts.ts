export type WorkflowPhase =
  | 'BACKLOG'
  | 'READY'
  | 'IN_PROGRESS'
  | 'REVIEW'
  | 'DONE'
  | 'BLOCKED'
  | 'CANCELED';

export type Resolution = 'NONE' | 'COMPLETED' | 'CANCELED';

export type CompletionPolicy = 'ARTIFACT_ACCEPTANCE';

export type RequestedActionStatus =
  | 'NONE'
  | 'REQUESTED'
  | 'STARTING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELED';

export type CodexRunStatus =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED'
  | 'UNKNOWN';

export type ProcessStatus =
  | 'CREATED'
  | 'SPAWNING'
  | 'RUNNING'
  | 'EXITED'
  | 'SIGNALED'
  | 'CANCELING'
  | 'ORPHANED'
  | 'UNKNOWN';

export type RepositoryPreflightStatus = 'VALID' | 'INVALID' | 'UNKNOWN';

export type ArtifactStatus = 'NONE' | 'FINAL_MESSAGE_PRESENT' | 'MISSING';

export type HealthStatus = 'HEALTHY' | 'INFO' | 'WARNING' | 'ERROR' | 'BLOCKED';

export type DomainEventType =
  | 'TASK_CREATED'
  | 'TRANSITION_REQUESTED'
  | 'ACTION_ATTEMPT_STARTED'
  | 'PROCESS_STARTED'
  | 'CODEX_STDOUT_LINE'
  | 'CODEX_EVENT_PARSED'
  | 'CODEX_STDERR_CHUNK'
  | 'CODEX_RUN_COMPLETED'
  | 'CODEX_RUN_FAILED'
  | 'PROCESS_EXITED'
  | 'PROCESS_SIGNALED'
  | 'CANCEL_REQUESTED'
  | 'ARTIFACT_CREATED'
  | 'PROJECTION_UPDATED'
  | 'REPOSITORY_PREFLIGHT_COMPLETED';

export type ArtifactKind = 'stdout' | 'stderr' | 'jsonl' | 'final-message';

export interface Finding {
  id: string;
  code: string;
  severity: HealthStatus;
  message: string;
  createdAt: string;
  clearedAt?: string;
}

export interface StatusProjection {
  requestedAction: RequestedActionStatus;
  codexRun: CodexRunStatus;
  osProcess: ProcessStatus;
  repositoryPreflight: RepositoryPreflightStatus;
  artifact: ArtifactStatus;
  health: HealthStatus;
  summary: string;
  findings: Finding[];
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  repositoryPath: string;
  workflowPhase: WorkflowPhase;
  resolution: Resolution;
  completionPolicy: CompletionPolicy;
  phaseVersion: number;
  currentRunId?: string;
  createdAt: string;
  updatedAt: string;
  projection: StatusProjection;
}

export interface RunRecord {
  id: string;
  taskId: string;
  status: CodexRunStatus;
  processStatus: ProcessStatus;
  executable: string;
  argv: string[];
  cwd: string;
  pid?: number;
  startedAt: string;
  lastEventAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutArtifactId: string;
  stderrArtifactId: string;
  jsonlArtifactId: string;
  finalArtifactId?: string;
  eventCount: number;
  lastEventType?: string;
  finalMessage?: string;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  runId?: string;
  kind: ArtifactKind;
  path: string;
  byteCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DomainEvent {
  id: string;
  type: DomainEventType;
  taskId: string;
  runId?: string;
  source: 'ui' | 'codex' | 'process' | 'storage' | 'repository' | 'projection';
  sourceEventId: string;
  occurredAt: string;
  receivedAt: string;
  payload: unknown;
}

export interface RepositoryPreflight {
  path: string;
  status: RepositoryPreflightStatus;
  root?: string;
  headSha?: string;
  branch?: string;
  remotes: Array<{ name: string; url: string; direction: 'fetch' | 'push' }>;
  error?: string;
  checkedAt: string;
}

export interface TaskSnapshot {
  tasks: Task[];
  runs: RunRecord[];
  events: DomainEvent[];
  artifacts: ArtifactRecord[];
}

export interface CreateTaskRequest {
  title: string;
  prompt: string;
  repositoryPath: string;
}

export interface StartRunRequest {
  taskId: string;
}

export interface CancelRunRequest {
  runId: string;
}

export interface ReadArtifactRequest {
  artifactId: string;
}

export interface AppUpdateEvent {
  type:
    | 'task.updated'
    | 'run.started'
    | 'run.output'
    | 'run.eventParsed'
    | 'run.stderr'
    | 'run.terminal'
    | 'projection.updated'
    | 'finding.updated';
  taskId: string;
  runId?: string;
  payload: unknown;
  at: string;
}

export interface TaskManagerApi {
  getDefaultRepositoryPath(): Promise<string>;
  validateRepository(path: string): Promise<RepositoryPreflight>;
  listTasks(): Promise<TaskSnapshot>;
  createTask(input: CreateTaskRequest): Promise<Task>;
  startRun(input: StartRunRequest): Promise<RunRecord>;
  cancelRun(input: CancelRunRequest): Promise<void>;
  readArtifact(input: ReadArtifactRequest): Promise<string>;
  onUpdate(listener: (event: AppUpdateEvent) => void): () => void;
}

export function createInitialProjection(now: string): StatusProjection {
  return {
    requestedAction: 'NONE',
    codexRun: 'UNKNOWN',
    osProcess: 'UNKNOWN',
    repositoryPreflight: 'UNKNOWN',
    artifact: 'NONE',
    health: 'INFO',
    summary: 'Ready for a read-only Codex run.',
    findings: [],
    updatedAt: now
  };
}
