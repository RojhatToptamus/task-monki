import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentExecutionSettings,
  AgentGoalSnapshotRecord,
  AgentItemRecord,
  AgentItemStatus,
  AgentProtocolMessageReference,
  AgentPlanRevisionRecord,
  AgentRunMode,
  AgentServerInstance,
  AgentServerStatus,
  AgentSessionRecord,
  AgentSettingsObservationRecord,
  AgentSubagentObservationRecord,
  AgentSubagentStatus,
  AgentUsageSnapshotRecord,
  ArtifactKind,
  ArtifactRecord,
  Board,
  BoardColor,
  BoardSnapshot,
  BoardTaskSummary,
  BranchPublicationRecord,
  CiRollupRecord,
  CreateBoardRequest,
  CreateBlankDesignRequest,
  CreateTaskRequest,
  DesignConversationEntry,
  DesignDetailSnapshot,
  DesignConversationPage,
  DesignListItem,
  DesignReference,
  DesignRevision,
  DesignTurn,
  DesignTurnCheckpoint,
  DesignTurnOutcome,
  ListDesignConversationRequest,
  DomainEvent,
  GitSnapshotRecord,
  GitHubRepositoryRecord,
  InteractionRequestRecord,
  InteractionRequestStatus,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  PreviewApprovalRecord,
  PreviewComposeProjectRecord,
  PreviewGenerationRecord,
  PreviewGenerationAttachmentRecord,
  PreviewLocalAttachmentBindingRecord,
  PreviewManagedEnvironmentRecord,
  PreviewManagedResourceRecord,
  PreviewNodeAttemptRecord,
  PreviewNativeResourceRecord,
  PreviewPlanRecord,
  PreviewResourceRecord,
  ReviewRollupRecord,
  Repository,
  RepositoryPreflight,
  RunRecord,
  Task,
  TaskAttachmentRecord,
  TaskDetailSnapshot,
  AttachmentContent,
  AttachmentDraftSnapshot,
  StageAttachmentBytesInput,
  StagedAttachmentRecord,
  TaskIteration,
  TaskSnapshot,
  UpdateBoardRequest,
  WorkflowPhase,
  WorktreeRecord
} from '../../shared/contracts';
import { DESIGN_LIMITS } from '../../shared/design';
import {
  BOARD_COLORS,
  TASK_STORE_SCHEMA_VERSION,
  ARTIFACT_KINDS,
  CODEX_RUNTIME_ID,
  completionPolicyRequiresMerge,
  completionPolicyRequiresPassingChecks,
  createInitialProjection,
  getImplementationRetryReason,
  isImplementationRunMode,
  isTaskCreationToken,
  verifiedChecksMatchMergeHead
} from '../../shared/contracts';
import {
  AgentProtocolJournal,
  DEFAULT_AGENT_PROTOCOL_JOURNAL_LIMITS
} from '../agent/journal/AgentProtocolJournal';
import {
  enforcePosixMode,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  posixModeMatches,
  syncDirectoryIfSupported
} from '../filesystem/secureFilesystem';
import { applyEventToState, createEmptyState, type StoreState } from '../projection/reducer';
import { createDomainEvent } from './domainEvent';
import {
  AttachmentAdoptionAmbiguousError,
  AttachmentFileStore,
  AttachmentStoreError,
  validateTaskAttachmentRecords,
  type PreparedAttachmentDraft,
  type PreparedAttachmentAppend,
  type StoredAttachmentContent,
  type VerifiedTaskAttachment
} from './AttachmentFileStore';
import { validateCurrentStoreRecords } from './currentStoreValidation';
import {
  migratePersistedStateToCurrent,
  normalizeLoadedState,
  normalizePersistedStateBeforeValidation
} from './currentStoreNormalization';
import {
  STORE_OWNERSHIP_LEASE_FILE,
  acquireStoreOwnershipLease,
  assertStoreOwnershipLease,
  releaseStoreOwnershipLease,
  type StoreOwnershipLease
} from './StoreOwnershipLease';

export interface CreateAgentSessionInput {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  runtimeId: string;
  role?: AgentSessionRecord['role'];
  requestedSettings?: AgentExecutionSettings;
  parentSessionId?: string;
  forkedFromSessionId?: string;
}

export interface CreateTaskStoreInput extends CreateTaskRequest {
  /**
   * Internal idempotency source retained when the service persists runtime-
   * resolved settings. It is never copied into the durable task record.
   */
  creationFingerprintInput?: CreateTaskRequest;
}

export interface CreateRunInput {
  task: Task;
  session: AgentSessionRecord;
  mode: AgentRunMode;
  prompt: string;
  serverInstanceId?: string;
  generationKey?: string;
  retryOfRunId?: string;
  continuedFromRunId?: string;
  requestedSettings?: AgentExecutionSettings;
  beforeGitSnapshotId?: string;
}

export interface ManagedDesignRepositoryInput {
  id: string;
  name: string;
  path: string;
  headSha: string;
  branch: string;
  checkedAt: string;
}

export interface CreateDesignBundleInput {
  request: CreateBlankDesignRequest;
  repository: ManagedDesignRepositoryInput;
}

export interface CreateDesignBundleResult {
  task: Task;
  repository: Repository;
  turn: DesignTurn;
  references: DesignReference[];
}

export interface CreateInlineDesignTurnInput {
  designId: string;
  clientMessageId: string;
  message: string;
  referenceIds: string[];
  attachmentDraftId?: string;
}

export interface UpdateDesignTurnCheckpointInput {
  designId: string;
  turnId: string;
  checkpoint: DesignTurnCheckpoint;
}

export interface UpdateDesignOpenedCandidateInput {
  designId: string;
  turnId: string;
  candidate: NonNullable<DesignTurn['finalOpenedCandidate']>;
}

export interface SettleDesignTurnInput {
  designId: string;
  turnId: string;
  outcome: Exclude<DesignTurnOutcome, 'READY'>;
  failureReason?: string;
}

export interface DesignPreviewSettlementInput {
  designId: string;
  turnId: string;
  runId: string;
  commitSha: string;
  routeId: string;
}

export interface DeleteTaskStorageResult {
  removedManagedRepository?: Repository;
}

export type CreateInteractionRequestInput = Omit<
  InteractionRequestRecord,
  'id' | 'status' | 'requestedAt'
>;

export interface CreateForkedAlternativeTaskInput extends CreateTaskRequest {
  sourceTaskId: string;
  sourceRunId: string;
}

export interface CreateObservedSubagentRunInput {
  session: AgentSessionRecord;
  providerTurnId: string;
  serverInstanceId: string;
  parentRunId?: string;
  prompt?: string;
  requestedSettings?: AgentExecutionSettings;
}

export interface ObserveSubagentInput {
  parentSessionId: string;
  parentRunId?: string;
  providerChildSessionId: string;
  providerParentSessionId?: string;
  providerForkedFromSessionId?: string;
  source: AgentSubagentObservationRecord['source'];
  status?: AgentSubagentStatus;
  delegatedPrompt?: string;
  requestedSettings?: AgentExecutionSettings;
  providerSessionTreeId?: string;
  providerNickname?: string;
  providerRole?: string;
  agentPath?: string;
  materialized?: boolean;
  rawMessage: AgentProtocolMessageReference;
}

export interface CreateAgentServerInput {
  runtimeId: string;
  runtimeKind: AgentServerInstance['runtimeKind'];
  transport: AgentServerInstance['transport'];
  executable: string;
  argv: string[];
  runtimeVersion?: string;
  schemaVersion?: string;
  schemaHash?: string;
  runtimeResolution?: AgentServerInstance['runtimeResolution'];
}

export const DEFAULT_UNREFERENCED_TERMINAL_AGENT_SERVER_LIMIT = 8;

export interface FileTaskStoreOptions {
  /** Newest unreferenced terminal server diagnostics retained across runtimes. */
  maxUnreferencedTerminalAgentServers?: number;
}

interface PrSyncInput {
  pullRequest: Omit<PullRequestSnapshotRecord, 'id' | 'observedAt'>;
  ci: Omit<CiRollupRecord, 'id' | 'observedAt'>;
  reviews: Omit<ReviewRollupRecord, 'id' | 'observedAt'>;
  merge: Omit<MergeSnapshotRecord, 'id' | 'observedAt'>;
}

type RunUpdate = Partial<
  Pick<
    RunRecord,
    | 'providerTurnId'
    | 'serverInstanceId'
    | 'status'
    | 'observedSettings'
    | 'recoveryState'
    | 'afterGitSnapshotId'
    | 'terminalReason'
    | 'providerTerminalSource'
    | 'providerTerminalRawMessage'
    | 'lastEventAt'
    | 'endedAt'
    | 'finalArtifactId'
    | 'finalMessage'
    | 'attachmentSubmissions'
  >
>;

type AgentServerUpdate = Partial<
  Pick<
    AgentServerInstance,
    | 'status'
    | 'pid'
    | 'runtimeVersion'
    | 'schemaVersion'
    | 'schemaHash'
    | 'initializedAt'
    | 'lastHealthAt'
    | 'disconnectedAt'
    | 'exitedAt'
    | 'exitCode'
    | 'signal'
    | 'exitReason'
  >
>;

type AgentSessionUpdate = Partial<
  Pick<
    AgentSessionRecord,
    | 'providerSessionId'
    | 'providerSessionTreeId'
    | 'parentSessionId'
    | 'forkedFromSessionId'
    | 'providerParentSessionId'
    | 'providerForkedFromSessionId'
    | 'parentRunId'
    | 'relationshipState'
    | 'relationshipDetail'
    | 'providerNickname'
    | 'providerRole'
    | 'delegatedPrompt'
    | 'agentPath'
    | 'subagentStatus'
    | 'status'
    | 'materialized'
    | 'observedSettings'
    | 'requestedSettings'
    | 'lastAttachedAt'
  >
>;

type InteractionRequestUpdate = Partial<
  Pick<
    InteractionRequestRecord,
    | 'status'
    | 'decision'
    | 'responseRawMessage'
    | 'resolution'
    | 'respondedAt'
    | 'resolvedAt'
  >
>;

function completionPolicyAfterPullRequestSync(
  task: Task,
  pullRequestStatus: PullRequestSnapshotRecord['status']
): Task['completionPolicy'] {
  if (pullRequestStatus === 'UNLINKED') {
    return task.completionPolicy;
  }
  if (
    task.completionPolicy === 'LOCAL_ACCEPTANCE' ||
    task.completionPolicy === 'ARTIFACT_ACCEPTANCE'
  ) {
    return 'MERGED';
  }
  return task.completionPolicy;
}

function shouldCompleteFromPullRequestSync(
  task: Task,
  pullRequest: PullRequestSnapshotRecord,
  ci: CiRollupRecord,
  merge: MergeSnapshotRecord
): boolean {
  if (!taskAllowsMergeCompletion(task)) {
    return false;
  }
  if (merge.status !== 'MERGED' || !completionPolicyRequiresMerge(task.completionPolicy)) {
    return false;
  }
  if (
    pullRequest.number !== merge.pullRequestNumber ||
    !pullRequest.headRefOid ||
    pullRequest.headRefOid !== merge.headSha
  ) {
    return false;
  }
  return (
    !completionPolicyRequiresPassingChecks(task.completionPolicy) ||
    verifiedChecksMatchMergeHead({
      ciStatus: ci.status,
      ciHeadSha: ci.headSha,
      ciPullRequestNumber: ci.pullRequestNumber,
      mergeHeadSha: merge.headSha,
      mergePullRequestNumber: merge.pullRequestNumber
    })
  );
}

function taskAllowsMergeCompletion(task: Task): boolean {
  return (
    ['READY', 'REVIEW', 'IN_REVIEW'].includes(task.workflowPhase) &&
    task.projection.agentReview?.status !== 'RUNNING' &&
    !getImplementationRetryReason(task)
  );
}

const CREATE_TASK_COMPLETION_POLICIES: Task['completionPolicy'][] = [
  'ARTIFACT_ACCEPTANCE',
  'LOCAL_ACCEPTANCE',
  'MERGED',
  'MERGED_AND_VERIFIED',
  'MANUAL'
];
const MAX_STORE_FILE_BYTES = 256 * 1024 * 1024;
const ARTIFACT_BYTE_LIMITS: Readonly<Record<ArtifactKind, number>> = {
  'agent-prompt': 8 * 1024 * 1024,
  'agent-output': 32 * 1024 * 1024,
  'agent-diagnostics': 16 * 1024 * 1024,
  'agent-final': 8 * 1024 * 1024,
  'design-message': 1024 * 1024,
  diff: 32 * 1024 * 1024,
  'git-snapshot': 8 * 1024 * 1024,
  'pr-body': 256 * 1024,
  'preview-source-manifest': 8 * 1024 * 1024,
  'preview-stdout': 256 * 1024,
  'preview-stderr': 256 * 1024
};
const UUID_FILE_SEGMENT =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_FILE_SEGMENT_PATTERN = new RegExp(`^${UUID_FILE_SEGMENT}$`, 'u');
const MANAGED_ARTIFACT_FILE_PATTERN = new RegExp(
  `^${UUID_FILE_SEGMENT}-(?:task|${UUID_FILE_SEGMENT})-(?:${ARTIFACT_KINDS.join('|')})-${UUID_FILE_SEGMENT}\\.log$`,
  'u'
);
const WORKFLOW_PHASES = new Set<WorkflowPhase>([
  'BACKLOG',
  'READY',
  'IN_PROGRESS',
  'REVIEW',
  'IN_REVIEW',
  'DONE',
  'BLOCKED',
  'CANCELED',
  'ARCHIVED'
]);
const BOARD_COLOR_VALUES = new Set<string>(BOARD_COLORS);

function validateBoardInput(
  input: CreateBoardRequest,
  repositories: readonly Repository[]
): Pick<Board, 'name' | 'color' | 'repositoryIds' | 'workflowPhases'> {
  if (
    typeof input.name !== 'string' ||
    typeof input.color !== 'string' ||
    !BOARD_COLOR_VALUES.has(input.color) ||
    !Array.isArray(input.repositoryIds) ||
    !input.repositoryIds.every((value) => typeof value === 'string') ||
    !Array.isArray(input.workflowPhases) ||
    !input.workflowPhases.every((value) => typeof value === 'string')
  ) {
    throw new Error('Board filter is invalid.');
  }
  const name = input.name.trim();
  if (!name) throw new Error('Board name is required.');
  const knownRepositoryIds = new Set(
    repositories
      .filter((repository) => repository.kind === 'USER_REGISTERED')
      .map((repository) => repository.id)
  );
  const repositoryIds = uniqueIds(input.repositoryIds);
  if (repositoryIds.some((repositoryId) => !knownRepositoryIds.has(repositoryId))) {
    throw new Error('Board references an unknown repository.');
  }
  const workflowPhases = uniqueIds(input.workflowPhases) as WorkflowPhase[];
  if (workflowPhases.some((phase) => !WORKFLOW_PHASES.has(phase))) {
    throw new Error('Board contains an invalid workflow phase.');
  }
  return { name, color: input.color as BoardColor, repositoryIds, workflowPhases };
}

function normalizeCreateTaskCompletionPolicy(
  value: CreateTaskRequest['completionPolicy']
): Task['completionPolicy'] {
  if (value === undefined) {
    return 'LOCAL_ACCEPTANCE';
  }
  if (CREATE_TASK_COMPLETION_POLICIES.includes(value)) {
    return value;
  }
  throw new Error(`Invalid completion policy: ${String(value)}`);
}

interface TaskCreationMetadata {
  token: string;
  fingerprint: string;
}

function designCreationMetadata(
  input: CreateBlankDesignRequest
): TaskCreationMetadata {
  if (!isTaskCreationToken(input.creationToken)) {
    throw new TaskCreationRequestError(
      'TASK_CREATION_INVALID_REQUEST',
      'Design creation retry token is invalid.',
      400
    );
  }
  const brief = input.brief.trim();
  const model = normalizedOptionalString(input.model);
  const reasoningEffort = normalizedOptionalString(input.reasoningEffort);
  if (
    !brief ||
    Buffer.byteLength(brief, 'utf8') > 1024 * 1024 ||
    (input.model !== undefined && !model) ||
    (input.reasoningEffort !== undefined && !reasoningEffort)
  ) {
    throw new TaskCreationRequestError(
      'TASK_CREATION_INVALID_REQUEST',
      'Design creation request is invalid.',
      400
    );
  }
  const canonicalRequest = stableJsonStringify({
    kind: 'DESIGN_BLANK',
    brief,
    runtimeId: CODEX_RUNTIME_ID,
    model: model ?? null,
    reasoningEffort: reasoningEffort ?? null,
    attachmentDraftId: input.attachmentDraftId ?? null
  });
  if (!canonicalRequest) {
    throw new TaskCreationRequestError(
      'TASK_CREATION_INVALID_REQUEST',
      'Design creation request cannot be used for a safe retry.',
      400
    );
  }
  return {
    token: input.creationToken,
    fingerprint: createHash('sha256').update(canonicalRequest).digest('hex')
  };
}

function deriveDesignTitle(brief: string): string {
  const compact = brief.replace(/\s+/gu, ' ').trim();
  if (compact.length <= 60) return compact;
  return `${compact.slice(0, 57).trimEnd()}…`;
}

function validateInlineDesignTurnInput(input: CreateInlineDesignTurnInput): void {
  if (!isTaskCreationToken(input.clientMessageId)) {
    throw new Error('Design message id is invalid.');
  }
  if (!input.message.trim()) throw new Error('Design message is required.');
  if (Buffer.byteLength(input.message, 'utf8') > ARTIFACT_BYTE_LIMITS['design-message']) {
    throw new Error('Design message exceeds its durable byte limit.');
  }
  if (
    !Array.isArray(input.referenceIds) ||
    new Set(input.referenceIds).size !== input.referenceIds.length
  ) {
    throw new Error('Design reference selection is invalid.');
  }
  if (
    input.attachmentDraftId !== undefined &&
    !isTaskCreationToken(input.attachmentDraftId)
  ) {
    throw new Error('Design attachment draft id is invalid.');
  }
}

function normalizedOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function taskCreationMetadata(
  input: CreateTaskStoreInput
): TaskCreationMetadata | undefined {
  const fingerprintInput = input.creationFingerprintInput ?? input;
  if (
    input.creationFingerprintInput &&
    input.creationToken !== fingerprintInput.creationToken
  ) {
    throw new TaskCreationRequestError(
      'TASK_CREATION_INVALID_REQUEST',
      'Task creation retry metadata is inconsistent.',
      400
    );
  }
  if (fingerprintInput.creationToken === undefined) {
    return undefined;
  }
  if (!isTaskCreationToken(fingerprintInput.creationToken)) {
    throw new TaskCreationRequestError(
      'TASK_CREATION_INVALID_REQUEST',
      'Task creation retry token is invalid.',
      400
    );
  }

  let canonicalRequest: string | undefined;
  try {
    const requestedRuntimeId =
      fingerprintInput.runtimeId ??
      fingerprintInput.agentSettings?.runtimeId ??
      CODEX_RUNTIME_ID;
    const { runtimeId: _runtimeId, ...portableAgentSettings } =
      fingerprintInput.agentSettings ?? {};
    canonicalRequest = stableJsonStringify({
      title: fingerprintInput.title.trim(),
      prompt: fingerprintInput.prompt.trim(),
      repositoryId: fingerprintInput.repositoryId.trim(),
      completionPolicy: normalizeCreateTaskCompletionPolicy(
        fingerprintInput.completionPolicy
      ),
      runtimeId: requestedRuntimeId,
      agentSettings: { ...portableAgentSettings, runtimeId: requestedRuntimeId },
      attachmentDraftId: fingerprintInput.attachmentDraftId ?? null
    });
  } catch {
    throw new TaskCreationRequestError(
      'TASK_CREATION_INVALID_REQUEST',
      'Task creation request cannot be used for a safe retry.',
      400
    );
  }
  if (!canonicalRequest) {
    throw new TaskCreationRequestError(
      'TASK_CREATION_INVALID_REQUEST',
      'Task creation request cannot be used for a safe retry.',
      400
    );
  }

  return {
    token: fingerprintInput.creationToken,
    fingerprint: createHash('sha256').update(canonicalRequest).digest('hex')
  };
}

/** Deterministic JSON encoding with normal JSON omission/null semantics. */
function stableJsonStringify(
  value: unknown,
  ancestors: Set<object> = new Set()
): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return undefined;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('BigInt is not valid JSON.');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Circular data is not valid JSON.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry) => stableJsonStringify(entry, ancestors) ?? 'null')
        .join(',')}]`;
    }
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = stableJsonStringify(
        (value as Record<string, unknown>)[key],
        ancestors
      );
      if (encoded !== undefined) {
        fields.push(`${JSON.stringify(key)}:${encoded}`);
      }
    }
    return `{${fields.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isCanonicalStoreTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

type PersistedState = Omit<Partial<StoreState>, 'schemaVersion'> & {
  schemaVersion?: unknown;
};

export type TaskCreationRequestErrorCode =
  | 'TASK_CREATION_INVALID_REQUEST'
  | 'TASK_CREATION_CONFLICT';

export class TaskCreationRequestError extends Error {
  readonly name = 'TaskCreationRequestError';

  constructor(
    readonly code: TaskCreationRequestErrorCode,
    message: string,
    readonly httpStatus: 400 | 409
  ) {
    super(message);
  }
}

/**
 * The artifact bytes may have been appended even though their metadata could
 * not be published or rolled back. Callers must not retry the same chunk.
 */
export class ArtifactAppendAmbiguousError extends AggregateError {
  readonly name = 'ArtifactAppendAmbiguousError';

  constructor(
    readonly artifactId: string,
    persistenceError: unknown,
    rollbackError: unknown
  ) {
    super(
      [persistenceError, rollbackError],
      'Artifact append failed and its durable file state could not be proven.'
    );
  }
}

type StoreLifecycle = 'NEW' | 'OPENING' | 'OPEN' | 'CLOSING' | 'CLOSED';

export class FileTaskStore {
  private readonly storePath: string;
  private readonly leasePath: string;
  private readonly artifactsDir: string;
  private readonly protocolJournal: AgentProtocolJournal;
  private readonly attachmentFiles: AttachmentFileStore;
  private state: StoreState = createEmptyState();
  private publishedState: StoreState = this.state;
  private publishedSnapshotJson = JSON.stringify(this.state);
  private loaded = false;
  private lifecycle: StoreLifecycle = 'NEW';
  private initialization?: Promise<void>;
  private closePromise?: Promise<void>;
  private retainedAttachmentDraftIds = new Set<string>();
  private lease?: StoreOwnershipLease;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private readonly mutationContext = new AsyncLocalStorage<boolean>();
  private readonly ownedIoContext = new AsyncLocalStorage<boolean>();
  private readonly activeOwnedIo = new Set<Promise<unknown>>();
  private readonly maxUnreferencedTerminalAgentServers: number;

  constructor(
    private readonly baseDir: string,
    options: FileTaskStoreOptions = {}
  ) {
    const maxUnreferencedTerminalAgentServers =
      options.maxUnreferencedTerminalAgentServers ??
      DEFAULT_UNREFERENCED_TERMINAL_AGENT_SERVER_LIMIT;
    if (
      !Number.isSafeInteger(maxUnreferencedTerminalAgentServers) ||
      maxUnreferencedTerminalAgentServers < 0
    ) {
      throw new Error(
        'Unreferenced terminal agent server retention must be a non-negative integer.'
      );
    }
    this.maxUnreferencedTerminalAgentServers =
      maxUnreferencedTerminalAgentServers;
    this.storePath = path.join(baseDir, 'store.json');
    this.leasePath = path.join(baseDir, STORE_OWNERSHIP_LEASE_FILE);
    this.artifactsDir = path.join(baseDir, 'artifacts');
    this.protocolJournal = new AgentProtocolJournal(path.join(baseDir, 'protocol-journals'));
    this.attachmentFiles = new AttachmentFileStore(baseDir);
  }

  getStoreIdentity(): string {
    return createHash('sha256').update(path.resolve(this.baseDir)).digest('hex');
  }

  /** Registers durable composer drafts before the first store initialization. */
  retainAttachmentDrafts(draftIds: readonly string[]): void {
    if (this.loaded || this.initialization || this.lifecycle !== 'NEW') {
      throw new Error(
        'Attachment draft retention must be configured before task-store initialization.'
      );
    }
    this.retainedAttachmentDraftIds = new Set(draftIds);
  }

  async init(): Promise<void> {
    const admitted = this.mutationContext.getStore() || this.ownedIoContext.getStore();
    if ((this.lifecycle === 'CLOSING' || this.lifecycle === 'CLOSED') && !admitted) {
      throw new Error('Task store is closed.');
    }
    const initialization = this.ensureInitialized();
    if (admitted) {
      await initialization;
      return;
    }
    const admittedMutations = this.mutationQueue.catch(() => undefined);
    await initialization;
    await admittedMutations;
  }

  private ensureInitialized(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.lifecycle = 'OPENING';
    const initialization = (async () => {
      try {
        await this.initialize();
        if (this.lifecycle === 'OPENING') this.lifecycle = 'OPEN';
      } catch (error) {
        if (this.lifecycle === 'OPENING') this.lifecycle = 'NEW';
        throw error;
      } finally {
        this.initialization = undefined;
      }
    })();
    this.initialization = initialization;
    return initialization;
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const baseEntry = await fs.lstat(this.baseDir);
    if (
      !baseEntry.isDirectory() ||
      baseEntry.isSymbolicLink() ||
      !isOwnedByCurrentUser(baseEntry)
    ) {
      throw new Error('Task store root failed its directory integrity check.');
    }
    await enforcePosixMode(this.baseDir, 0o700);
    this.lease = await acquireStoreOwnershipLease(this.baseDir, this.leasePath);
    try {
      await cleanupStoreTemporaryFiles(this.baseDir, this.storePath);
      await this.attachmentFiles.init();
      await initializeArtifactDirectory(this.baseDir, this.artifactsDir);
      let raw: string | undefined;
      try {
        raw = await readPrivateStoreFile(this.storePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      if (raw === undefined) {
        this.state = createEmptyState();
        await this.attachmentFiles.reconcile(
          this.state.attachments,
          this.retainedAttachmentDraftIds
        );
        await this.reconcileArtifacts();
        await this.persist();
      } else {
        const persisted = JSON.parse(raw) as PersistedState;
        const migrated = migratePersistedStateToCurrent(persisted);
        const repaired = normalizePersistedStateBeforeValidation(migrated.state);
        const normalized = normalizeLoadedState(requireCurrentState(repaired.state));
        this.state = normalized.state;
        await this.attachmentFiles.reconcile(
          this.state.attachments,
          this.retainedAttachmentDraftIds
        );
        await this.reconcileArtifacts();
        const prunedServerIds = this.pruneUnreferencedTerminalAgentServers();
        if (
          migrated.changed ||
          repaired.changed ||
          normalized.changed ||
          prunedServerIds.length > 0
        ) {
          await this.persist();
        }
      }
      await this.protocolJournal.reconcileServers(
        this.state.agentServers.map((server) => server.id)
      );
      if (this.publishedState !== this.state) {
        this.publishedState = this.state;
        this.publishedSnapshotJson = JSON.stringify(this.state);
      }
      this.loaded = true;
    } catch (error) {
      await this.releaseLease().catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycle = 'CLOSING';
    this.closePromise = this.closeOwnedResources();
    return this.closePromise;
  }

  private async closeOwnedResources(): Promise<void> {
    await this.initialization?.catch(() => undefined);
    await this.mutationQueue.catch(() => undefined);
    await Promise.allSettled([...this.activeOwnedIo]);
    const closeResults = await Promise.allSettled([
      this.attachmentFiles.close(),
      this.protocolJournal.close()
    ]);
    const failures = closeResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    this.loaded = false;
    try {
      await this.releaseLease();
    } catch (error) {
      failures.push(error);
    } finally {
      this.lifecycle = 'CLOSED';
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Task store shutdown did not complete cleanly.');
    }
  }

  private async releaseLease(): Promise<void> {
    if (!this.lease) return;
    const lease = this.lease;
    this.lease = undefined;
    await releaseStoreOwnershipLease(this.baseDir, this.leasePath, lease);
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutationContext.getStore()) return operation();
    if (this.lifecycle === 'CLOSING' || this.lifecycle === 'CLOSED') {
      return Promise.reject(new Error('Task store is closed.'));
    }
    const initialization = this.ensureInitialized();
    const queued = this.mutationQueue.catch(() => undefined).then(() =>
      this.mutationContext.run(true, async () => {
        await initialization;
        try {
          return await operation();
        } catch (error) {
          this.state = this.publishedState;
          throw error;
        }
      })
    );
    this.mutationQueue = queued.catch(() => undefined);
    return queued;
  }

  private withOwnedIo<T>(operation: () => Promise<T>): Promise<T> {
    if (this.ownedIoContext.getStore()) return operation();
    if (this.lifecycle === 'CLOSING' || this.lifecycle === 'CLOSED') {
      return Promise.reject(new Error('Task store is closed.'));
    }
    const initialization = this.ensureInitialized();
    const admittedMutations = this.mutationContext.getStore()
      ? Promise.resolve()
      : this.mutationQueue.catch(() => undefined);
    const running = this.ownedIoContext.run(true, async () => {
      await initialization;
      await admittedMutations;
      return operation();
    });
    this.activeOwnedIo.add(running);
    void running.then(
      () => this.activeOwnedIo.delete(running),
      () => this.activeOwnedIo.delete(running)
    );
    return running;
  }
  private async reconcileArtifacts(): Promise<void> {
    await assertArtifactDirectory(this.baseDir, this.artifactsDir);
    const taskIds = new Set(this.state.tasks.map((task) => task.id));
    const runsById = new Map(this.state.runs.map((run) => [run.id, run]));
    const artifactIds = new Set<string>();
    const expectedByName = new Map<string, ArtifactRecord>();
    for (const artifact of this.state.artifacts) {
      const fileName = validateArtifactRecord(
        artifact,
        this.artifactsDir,
        taskIds,
        runsById
      );
      if (artifactIds.has(artifact.id) || expectedByName.has(fileName)) {
        throw new Error('Task artifact records contain duplicate managed identifiers.');
      }
      artifactIds.add(artifact.id);
      expectedByName.set(fileName, artifact);
    }

    let removedOrphans = 0;
    for (const entry of await fs.readdir(this.artifactsDir, { withFileTypes: true })) {
      const entryPath = path.join(this.artifactsDir, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error('Task artifact directory contains an unsafe entry.');
      }
      const expected = expectedByName.get(entry.name);
      if (expected) {
        if (!stat.isFile()) {
          throw new Error('Stored task artifact path is not a regular file.');
        }
        await reconcileArtifactFile(entryPath, expected.byteCount);
        expectedByName.delete(entry.name);
        continue;
      }
      if (!MANAGED_ARTIFACT_FILE_PATTERN.test(entry.name)) {
        // Unknown regular files and directories are not Task Monki records and
        // are intentionally left untouched.
        continue;
      }
      if (!stat.isFile()) {
        throw new Error('Orphan task artifact path is not a regular file.');
      }
      assertArtifactOwnedByCurrentUser(stat);
      await fs.unlink(entryPath);
      removedOrphans += 1;
    }
    if (expectedByName.size > 0) {
      throw new Error('A referenced task artifact file is missing.');
    }
    if (removedOrphans > 0) await syncDirectoryIfSupported(this.artifactsDir);
  }

  async snapshot(): Promise<TaskSnapshot> {
    await this.init();
    return JSON.parse(this.publishedSnapshotJson) as TaskSnapshot;
  }

  async getBoardSnapshot(): Promise<BoardSnapshot> {
    await this.init();
    const state = this.publishedState;
    return clone({
      schemaVersion: state.schemaVersion,
      repositories: state.repositories.filter(
        (repository) => repository.kind === 'USER_REGISTERED'
      ),
      boards: state.boards,
      tasks: state.tasks
        .filter((task) => task.kind === 'NORMAL')
        .map(projectBoardTask),
      interactionRequests: state.interactionRequests.filter(
        (interaction) =>
          (interaction.status === 'PENDING' || interaction.status === 'RESPONDING') &&
          state.tasks.some(
            (task) => task.id === interaction.taskId && task.kind === 'NORMAL'
          )
      )
    });
  }

  async listDesigns(): Promise<DesignListItem[]> {
    await this.init();
    const state = this.publishedState;
    return clone(
      state.tasks
        .filter((task) => task.kind === 'DESIGN')
        .map((task) => projectDesignListItem(state, task))
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.title.localeCompare(right.title)
        )
    );
  }

  async getDesignDetail(designId: string): Promise<DesignDetailSnapshot> {
    await this.init();
    const state = this.publishedState;
    const task = state.tasks.find(
      (candidate) => candidate.id === designId && candidate.kind === 'DESIGN'
    );
    if (!task) throw new Error('Design not found.');
    const repository = state.repositories.find(
      (candidate) => candidate.id === task.repositoryId
    );
    if (!repository) throw new Error('Design repository not found.');
    const revisions = state.designRevisions
      .filter((revision) => revision.designId === designId)
      .sort((left, right) => left.ordinal - right.ordinal);
    const conversationPage = await projectDesignConversationPage(state, task, {});
    const visibleTurnIds = new Set(
      conversationPage.entries.map((entry) => entry.turn.id)
    );
    const unsettledEntries = await Promise.all(
      state.designTurns
        .filter(
          (turn) =>
            turn.designId === designId &&
            turn.outcome === undefined &&
            !visibleTurnIds.has(turn.id)
        )
        .map((turn) => projectDesignConversationEntry(state, task, turn))
    );
    const conversation = [...unsettledEntries, ...conversationPage.entries].sort(
      (left, right) => left.turn.order - right.turn.order
    );
    const turns = conversation.map((entry) => entry.turn);
    const interactions = state.interactionRequests
      .filter(
        (interaction) =>
          interaction.taskId === designId &&
          (interaction.status === 'PENDING' || interaction.status === 'RESPONDING')
      )
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .slice(-20);
    const sessionIds = new Set([
      ...interactions.map((interaction) => interaction.sessionId),
      ...(task.currentAgentSessionId ? [task.currentAgentSessionId] : [])
    ]);
    const sessions = state.agentSessions
      .filter((session) => sessionIds.has(session.id))
      .slice(-20);
    const runIds = new Set(turns.flatMap((turn) => (turn.runId ? [turn.runId] : [])));
    const items = state.agentItems
      .filter((item) => item.taskId === designId && runIds.has(item.runId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-DESIGN_LIMITS.recentTelemetryItems);
    const currentPreview = selectCurrentDesignPreview(state, designId, revisions.at(-1));
    return clone({
      schemaVersion: state.schemaVersion,
      design: projectDesignListItem(state, task),
      task,
      repository,
      turns,
      references: state.designReferences.filter(
        (reference) => reference.designId === designId
      ),
      attachments: state.attachments
        .filter((attachment) => attachment.taskId === designId)
        .sort((left, right) => left.ordinal - right.ordinal),
      projectFiles: [],
      projectFilesTruncated: false,
      revisions,
      conversation,
      previousConversationCursor: conversationPage.previousCursor,
      interactions,
      sessions,
      items,
      currentIteration: state.iterations.find(
        (iteration) => iteration.id === task.currentIterationId
      ),
      currentWorktree: state.worktrees.find(
        (worktree) => worktree.id === task.currentWorktreeId
      ),
      currentRun: state.runs.find((run) => run.id === task.currentRunId),
      currentSession: state.agentSessions.find(
        (session) => session.id === task.currentAgentSessionId
      ),
      currentPreview,
      canvas: projectDesignCanvas(state, task, revisions.at(-1), currentPreview),
      actions: projectDesignActions(state, task, revisions.at(-1), currentPreview)
    });
  }

  async listDesignConversation(
    input: ListDesignConversationRequest
  ): Promise<DesignConversationPage> {
    await this.init();
    const state = this.publishedState;
    const task = state.tasks.find(
      (candidate) => candidate.id === input.designId && candidate.kind === 'DESIGN'
    );
    if (!task) throw new Error('Design not found.');
    return clone(await projectDesignConversationPage(state, task, input));
  }

  async getTaskDetail(taskId: string): Promise<TaskDetailSnapshot> {
    await this.init();
    const state = this.publishedState;
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error('Task not found.');
    }

    const runs = state.runs.filter((record) => record.taskId === taskId);
    const agentItems = state.agentItems.filter((record) => record.taskId === taskId);
    const agentGoalSnapshots = state.agentGoalSnapshots.filter(
      (record) => record.taskId === taskId
    );
    const agentPlanRevisions = state.agentPlanRevisions.filter(
      (record) => record.taskId === taskId
    );
    const agentUsageSnapshots = state.agentUsageSnapshots.filter(
      (record) => record.taskId === taskId
    );
    const agentSettingsObservations = state.agentSettingsObservations.filter(
      (record) => record.taskId === taskId
    );
    const agentSubagentObservations = state.agentSubagentObservations.filter(
      (record) => record.taskId === taskId
    );
    const interactionRequests = state.interactionRequests.filter(
      (record) => record.taskId === taskId
    );
    const events = state.events.filter((record) => record.taskId === taskId);
    const serverIds = new Set<string>();
    const addServerReference = (
      reference: AgentProtocolMessageReference | undefined
    ) => {
      if (reference) serverIds.add(reference.serverInstanceId);
    };
    for (const run of runs) {
      if (run.serverInstanceId) serverIds.add(run.serverInstanceId);
      addServerReference(run.providerTerminalRawMessage);
    }
    for (const item of agentItems) addServerReference(item.rawMessage);
    for (const goal of agentGoalSnapshots) addServerReference(goal.rawMessage);
    for (const plan of agentPlanRevisions) addServerReference(plan.rawMessage);
    for (const usage of agentUsageSnapshots) addServerReference(usage.rawMessage);
    for (const settings of agentSettingsObservations) {
      addServerReference(settings.rawMessage);
    }
    for (const observation of agentSubagentObservations) {
      addServerReference(observation.rawMessage);
    }
    for (const interaction of interactionRequests) {
      serverIds.add(interaction.serverInstanceId);
      addServerReference(interaction.requestRawMessage);
      addServerReference(interaction.responseRawMessage);
    }
    for (const event of events) {
      if (event.serverInstanceId) serverIds.add(event.serverInstanceId);
    }

    const taskRecords = <T extends { taskId: string }>(records: readonly T[]): T[] =>
      records.filter((record) => record.taskId === taskId);
    return clone({
      schemaVersion: state.schemaVersion,
      task,
      repository: state.repositories.find(
        (repository) => repository.id === task.repositoryId
      ),
      iterations: taskRecords(state.iterations),
      worktrees: taskRecords(state.worktrees),
      gitSnapshots: taskRecords(state.gitSnapshots),
      githubRepositories: taskRecords(state.githubRepositories),
      branchPublications: taskRecords(state.branchPublications),
      pullRequests: taskRecords(state.pullRequests),
      ciRollups: taskRecords(state.ciRollups),
      reviewRollups: taskRecords(state.reviewRollups),
      mergeSnapshots: taskRecords(state.mergeSnapshots),
      runs,
      agentServers: state.agentServers.filter((server) => serverIds.has(server.id)),
      agentSessions: taskRecords(state.agentSessions),
      agentItems,
      agentGoalSnapshots,
      agentPlanRevisions,
      agentUsageSnapshots,
      agentSettingsObservations,
      agentSubagentObservations,
      interactionRequests,
      previewPlans: taskRecords(state.previewPlans),
      previewApprovals: taskRecords(state.previewApprovals),
      previewComposeProjects: taskRecords(state.previewComposeProjects),
      previewGenerations: taskRecords(state.previewGenerations),
      previewManagedEnvironments: taskRecords(state.previewManagedEnvironments),
      previewManagedResources: taskRecords(state.previewManagedResources),
      previewGenerationAttachments: taskRecords(state.previewGenerationAttachments),
      previewLocalBindings: taskRecords(state.previewLocalBindings),
      previewNodeAttempts: taskRecords(state.previewNodeAttempts),
      previewResources: taskRecords(state.previewResources),
      events,
      artifacts: taskRecords(state.artifacts),
      attachments: taskRecords(state.attachments),
      previewTaskRoutes: selectPreviewTaskRouteOptions(state, taskId),
      textExcerpts: []
    });
  }

  async getRepository(repositoryId: string): Promise<Repository | undefined> {
    await this.init();
    return clone(
      this.state.repositories.find((repository) => repository.id === repositoryId)
    );
  }

  addRepository(preflight: RepositoryPreflight): Promise<Repository> {
    return this.serializeMutation(async () => {
      if (preflight.status !== 'VALID' || !preflight.root || !preflight.headSha) {
        throw new Error(
          preflight.error ?? 'Repository validation must pass before it can be added.'
        );
      }
      const repositoryPath = path.resolve(preflight.root);
      const existing = this.state.repositories.find(
        (repository) => path.resolve(repository.path) === repositoryPath
      );
      if (existing) {
        if (existing.status === 'DISCONNECTED') {
          throw new Error(
            'Repository is disconnected. Reconnect the existing repository instead.'
          );
        }
        return this.recordRepositoryPreflight(existing.id, preflight);
      }
      const now = new Date().toISOString();
      const repository: Repository = {
        id: randomUUID(),
        kind: 'USER_REGISTERED',
        name: path.basename(repositoryPath) || repositoryPath,
        path: repositoryPath,
        status: 'AVAILABLE',
        headSha: preflight.headSha,
        branch: preflight.branch,
        remotes: preflight.remotes,
        createdAt: now,
        updatedAt: now,
        checkedAt: preflight.checkedAt
      };
      this.state = {
        ...this.state,
        repositories: [repository, ...this.state.repositories]
      };
      await this.persistSnapshot();
      return clone(repository);
    });
  }

  recordRepositoryPreflight(
    repositoryId: string,
    preflight: RepositoryPreflight
  ): Promise<Repository> {
    return this.serializeMutation(async () => {
      const existing = this.state.repositories.find(
        (repository) => repository.id === repositoryId
      );
      if (!existing) {
        throw new Error('Repository not found.');
      }
      if (
        preflight.status === 'VALID' &&
        preflight.root &&
        this.state.repositories.some(
          (repository) =>
            repository.id !== repositoryId &&
            path.resolve(repository.path) === path.resolve(preflight.root!)
        )
      ) {
        throw new Error('Repository path is already connected to another repository.');
      }
      const repository: Repository = {
        ...existing,
        path:
          preflight.status === 'VALID' && preflight.root
            ? path.resolve(preflight.root)
            : existing.path,
        status:
          preflight.status === 'VALID'
            ? 'AVAILABLE'
            : preflight.status === 'MISSING'
              ? 'MISSING'
              : 'INVALID',
        headSha: preflight.status === 'VALID' ? preflight.headSha : existing.headSha,
        branch: preflight.status === 'VALID' ? preflight.branch : existing.branch,
        remotes: preflight.status === 'VALID' ? preflight.remotes : existing.remotes,
        error: preflight.status === 'VALID' ? undefined : preflight.error,
        updatedAt: new Date().toISOString(),
        checkedAt: preflight.checkedAt
      };
      this.state = {
        ...this.state,
        repositories: this.state.repositories.map((candidate) =>
          candidate.id === repositoryId ? repository : candidate
        )
      };
      await this.persistSnapshot();
      return clone(repository);
    });
  }

  disconnectRepository(repositoryId: string): Promise<Repository> {
    return this.serializeMutation(async () => {
      const existing = this.state.repositories.find(
        (repository) => repository.id === repositoryId
      );
      if (!existing) {
        throw new Error('Repository not found.');
      }
      if (existing.status === 'DISCONNECTED') {
        return clone(existing);
      }
      const repository: Repository = {
        ...existing,
        status: 'DISCONNECTED',
        error: undefined,
        updatedAt: new Date().toISOString()
      };
      this.state = {
        ...this.state,
        repositories: this.state.repositories.map((candidate) =>
          candidate.id === repositoryId ? repository : candidate
        )
      };
      await this.persistSnapshot();
      return clone(repository);
    });
  }

  createBoard(input: CreateBoardRequest): Promise<Board> {
    return this.serializeMutation(async () => {
      const values = validateBoardInput(input, this.state.repositories);
      const now = new Date().toISOString();
      const board: Board = {
        id: randomUUID(),
        ...values,
        createdAt: now,
        updatedAt: now
      };
      this.state = { ...this.state, boards: [board, ...this.state.boards] };
      await this.persistSnapshot();
      return clone(board);
    });
  }

  updateBoard(input: UpdateBoardRequest): Promise<Board> {
    return this.serializeMutation(async () => {
      const existing = this.state.boards.find((board) => board.id === input.boardId);
      if (!existing) {
        throw new Error('Board not found.');
      }
      const values = validateBoardInput(input, this.state.repositories);
      const board: Board = {
        ...existing,
        ...values,
        updatedAt: new Date().toISOString()
      };
      this.state = {
        ...this.state,
        boards: this.state.boards.map((candidate) =>
          candidate.id === board.id ? board : candidate
        )
      };
      await this.persistSnapshot();
      return clone(board);
    });
  }

  deleteBoard(boardId: string): Promise<void> {
    return this.serializeMutation(async () => {
      if (!this.state.boards.some((board) => board.id === boardId)) {
        throw new Error('Board not found.');
      }
      this.state = {
        ...this.state,
        boards: this.state.boards.filter((board) => board.id !== boardId)
      };
      await this.persistSnapshot();
    });
  }

  createAttachmentDraft(): Promise<AttachmentDraftSnapshot> {
    return this.withOwnedIo(() => this.attachmentFiles.createDraft());
  }

  stageTaskAttachment(input: StageAttachmentBytesInput): Promise<StagedAttachmentRecord> {
    return this.withOwnedIo(() => this.attachmentFiles.stageBytes(input));
  }

  listAttachmentDraft(draftId: string): Promise<AttachmentDraftSnapshot> {
    return this.withOwnedIo(() => this.attachmentFiles.listDraft(draftId));
  }

  discardAttachmentDraft(draftId: string): Promise<void> {
    return this.withOwnedIo(() => this.attachmentFiles.discardDraft(draftId));
  }

  async getTaskAttachments(taskId: string): Promise<TaskAttachmentRecord[]> {
    await this.init();
    return clone(
      this.state.attachments
        .filter((attachment) => attachment.taskId === taskId)
        .sort((left, right) => left.ordinal - right.ordinal)
    );
  }

  async getTurnAttachments(input: {
    taskId: string;
    mode: AgentRunMode;
    generationKey?: string;
  }): Promise<TaskAttachmentRecord[]> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) throw new Error('Task not found.');
    if (input.mode !== 'DESIGN') return this.getTaskAttachments(input.taskId);
    if (task.kind !== 'DESIGN' || !input.generationKey) {
      throw new Error('DESIGN attachments require a DesignTurn generation key.');
    }
    const turn = this.requireDesignTurn(task.id, input.generationKey);
    return clone(this.attachmentRecordsForDesignTurn(turn));
  }

  verifyTaskAttachments(taskId: string): Promise<VerifiedTaskAttachment[]> {
    return this.withOwnedIo(async () => {
      const records = await this.getTaskAttachments(taskId);
      return records.length === 0 ? [] : this.attachmentFiles.verifyTask(taskId, records);
    });
  }

  /** Returns verified immutable task-owned files for provider delivery. */
  prepareRunAttachments(
    runId: string,
    taskId: string
  ): Promise<VerifiedTaskAttachment[]> {
    return this.withOwnedIo(async () => {
      const worktreePath = await this.requireRunAttachmentWorktree(runId, taskId);
      const run = this.state.runs.find(
        (candidate) => candidate.id === runId && candidate.taskId === taskId
      );
      if (!run) throw new Error('Run attachments do not belong to the selected task and run.');
      const records =
        run.mode === 'DESIGN'
          ? this.attachmentRecordsForDesignTurn(
              this.requireDesignTurn(taskId, run.generationKey ?? '')
            )
          : this.state.attachments.filter((attachment) => attachment.taskId === taskId);
      const attachments =
        records.length === 0
          ? []
          : run.mode === 'DESIGN'
            ? await this.attachmentFiles.verifyTaskSelection(taskId, records)
            : await this.attachmentFiles.verifyTask(taskId, records);
      assertAttachmentsOutsideWorktree(attachments, worktreePath);
      return attachments;
    });
  }

  /** Revalidates task-owned files immediately before provider submission. */
  verifyRunAttachments(
    runId: string,
    taskId: string
  ): Promise<VerifiedTaskAttachment[]> {
    return this.withOwnedIo(async () => {
      const worktreePath = await this.requireRunAttachmentWorktree(runId, taskId);
      const run = this.state.runs.find(
        (candidate) => candidate.id === runId && candidate.taskId === taskId
      );
      if (!run) throw new Error('Run attachments do not belong to the selected task and run.');
      const records =
        run.mode === 'DESIGN'
          ? this.attachmentRecordsForDesignTurn(
              this.requireDesignTurn(taskId, run.generationKey ?? '')
            )
          : this.state.attachments.filter((attachment) => attachment.taskId === taskId);
      const attachments =
        records.length === 0
          ? []
          : run.mode === 'DESIGN'
            ? await this.attachmentFiles.verifyTaskSelection(taskId, records)
            : await this.attachmentFiles.verifyTask(taskId, records);
      assertAttachmentsOutsideWorktree(attachments, worktreePath);
      return attachments;
    });
  }

  /**
   * Crash recovery verifies attachments for active runs without creating a
   * second filesystem representation.
   */
  reconcileRunAttachments(): Promise<{
    preparedRunIds: string[];
    failedRunIds: string[];
  }> {
    return this.withOwnedIo(() => this.reconcileRunAttachmentsOwned());
  }

  private async reconcileRunAttachmentsOwned(): Promise<{
    preparedRunIds: string[];
    failedRunIds: string[];
  }> {
    await this.init();
    const activeRuns = this.state.runs.filter((run) =>
      [
        'QUEUED',
        'STARTING',
        'RUNNING',
        'AWAITING_APPROVAL',
        'AWAITING_USER_INPUT',
        'INTERRUPTING',
        'RECOVERY_REQUIRED'
      ].includes(run.status)
    );
    const preparedRunIds: string[] = [];
    const failedRunIds: string[] = [];
    for (const run of activeRuns) {
      try {
        await this.prepareRunAttachments(run.id, run.taskId);
        preparedRunIds.push(run.id);
      } catch {
        failedRunIds.push(run.id);
      }
    }
    return { preparedRunIds, failedRunIds };
  }

  private async requireRunAttachmentWorktree(
    runId: string,
    taskId: string
  ): Promise<string> {
    await this.init();
    const run = this.state.runs.find((candidate) => candidate.id === runId);
    if (!run || run.taskId !== taskId) {
      throw new Error('Run attachments do not belong to the selected task and run.');
    }
    const worktree = this.state.worktrees.find(
      (candidate) => candidate.id === run.worktreeId && candidate.taskId === taskId
    );
    if (!worktree) {
      throw new Error('Run attachments do not have an authoritative worktree.');
    }
    return worktree.worktreePath;
  }

  readTaskAttachment(attachmentId: string): Promise<AttachmentContent> {
    return this.withOwnedIo(async () => {
      const record = this.state.attachments.find((attachment) => attachment.id === attachmentId);
      if (!record) {
        throw new AttachmentStoreError('ATTACHMENT_NOT_FOUND', 'Attachment not found.', 404);
      }
      const stored = await this.attachmentFiles.readTask(record);
      return { ...stored, bytes: exactArrayBuffer(stored.bytes) };
    });
  }

  readDraftAttachment(draftId: string, attachmentId: string): Promise<AttachmentContent> {
    return this.withOwnedIo(async () => {
      const stored = await this.attachmentFiles.readDraft(draftId, attachmentId);
      return { ...stored, bytes: exactArrayBuffer(stored.bytes) };
    });
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    await this.init();
    return clone(this.state.tasks.find((task) => task.id === taskId));
  }

  async getPreviewPlan(planId: string): Promise<PreviewPlanRecord | undefined> {
    await this.init();
    return clone(this.state.previewPlans.find((plan) => plan.id === planId));
  }

  async getLatestPreviewPlan(taskId: string): Promise<PreviewPlanRecord | undefined> {
    await this.init();
    return clone(
      this.state.previewPlans
        .filter((plan) => plan.taskId === taskId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    );
  }

  async getMatchingPreviewApproval(
    taskId: string,
    executionDigest: string
  ): Promise<PreviewApprovalRecord | undefined> {
    await this.init();
    return clone(
      this.state.previewApprovals
        .filter(
          (approval) =>
            approval.taskId === taskId &&
            approval.executionDigest === executionDigest &&
            !approval.invalidatedAt
        )
        .sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))[0]
    );
  }

  async getPreviewGeneration(generationId: string): Promise<PreviewGenerationRecord | undefined> {
    await this.init();
    return clone(
      this.state.previewGenerations.find((generation) => generation.id === generationId)
    );
  }

  async getPreviewGenerations(taskId?: string): Promise<PreviewGenerationRecord[]> {
    await this.init();
    return clone(
      this.state.previewGenerations.filter(
        (generation) => !taskId || generation.taskId === taskId
      )
    );
  }

  async getPreviewManagedEnvironment(taskId: string): Promise<PreviewManagedEnvironmentRecord | undefined> {
    await this.init();
    return clone(this.state.previewManagedEnvironments.find((environment) => environment.taskId === taskId));
  }

  async getPreviewComposeProject(taskId: string): Promise<PreviewComposeProjectRecord | undefined> {
    await this.init();
    return clone(this.state.previewComposeProjects.find((project) => project.taskId === taskId));
  }

  async getPreviewComposeProjects(): Promise<PreviewComposeProjectRecord[]> {
    await this.init();
    return clone(this.state.previewComposeProjects);
  }

  async getPreviewManagedEnvironments(): Promise<PreviewManagedEnvironmentRecord[]> {
    await this.init();
    return clone(this.state.previewManagedEnvironments);
  }

  async getPreviewManagedResource(resourceId: string): Promise<PreviewManagedResourceRecord | undefined> {
    await this.init();
    return clone(this.state.previewManagedResources.find((resource) => resource.id === resourceId));
  }

  async getPreviewManagedResources(taskId?: string): Promise<PreviewManagedResourceRecord[]> {
    await this.init();
    return clone(this.state.previewManagedResources.filter((resource) => !taskId || resource.taskId === taskId));
  }

  async getPreviewGenerationAttachments(generationId?: string): Promise<PreviewGenerationAttachmentRecord[]> {
    await this.init();
    return clone(this.state.previewGenerationAttachments.filter((attachment) => !generationId || attachment.generationId === generationId));
  }

  async getPreviewNodeAttempts(generationId: string): Promise<PreviewNodeAttemptRecord[]> {
    await this.init();
    return clone(
      this.state.previewNodeAttempts.filter((attempt) => attempt.generationId === generationId)
    );
  }

  async isPreviewLogArtifactOwned(taskId: string, artifactId: string): Promise<boolean> {
    await this.init();
    return this.state.previewNodeAttempts.some(
      (attempt) =>
        attempt.taskId === taskId &&
        (attempt.stdoutArtifactId === artifactId || attempt.stderrArtifactId === artifactId)
    );
  }

  async getPreviewResources(generationId?: string): Promise<PreviewResourceRecord[]> {
    await this.init();
    return clone(
      this.state.previewResources.filter(
        (resource) => !generationId || resource.generationId === generationId
      )
    );
  }

  async getPreviewLocalBindings(taskId?: string): Promise<PreviewLocalAttachmentBindingRecord[]> {
    await this.init();
    return clone(
      this.state.previewLocalBindings.filter((binding) => !taskId || binding.taskId === taskId)
    );
  }

  async getPreviewLocalBinding(
    taskId: string,
    attachmentId: string
  ): Promise<PreviewLocalAttachmentBindingRecord | undefined> {
    await this.init();
    return clone(
      this.state.previewLocalBindings.find(
        (binding) => binding.taskId === taskId && binding.attachmentId === attachmentId
      )
    );
  }

  async savePreviewLocalBinding(
    binding: PreviewLocalAttachmentBindingRecord
  ): Promise<PreviewLocalAttachmentBindingRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      if (!this.state.tasks.some((task) => task.id === binding.taskId)) {
        throw new Error('Preview local binding references a missing task.');
      }
      const conflicting = this.state.previewLocalBindings.find(
        (candidate) =>
          candidate.taskId === binding.taskId &&
          candidate.attachmentId === binding.attachmentId &&
          candidate.id !== binding.id
      );
      if (conflicting) throw new Error('Preview attachment already has a local binding.');
      this.state = {
        ...this.state,
        previewLocalBindings: [
          binding,
          ...this.state.previewLocalBindings.filter((candidate) => candidate.id !== binding.id)
        ]
      };
      await this.persistSnapshot();
      return clone(binding);
    });
  }

  async deletePreviewLocalBinding(taskId: string, attachmentId: string): Promise<void> {
    return this.serializeMutation(async () => {
      await this.init();
      this.state = {
        ...this.state,
        previewLocalBindings: this.state.previewLocalBindings.filter(
          (binding) => binding.taskId !== taskId || binding.attachmentId !== attachmentId
        )
      };
      await this.persistSnapshot();
    });
  }

  async savePreviewPlan(plan: PreviewPlanRecord): Promise<PreviewPlanRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      this.assertPreviewPlanReferences(plan);
      const now = new Date().toISOString();
      this.state = {
        ...this.state,
        previewPlans: [
          plan,
          ...this.state.previewPlans.filter((candidate) => candidate.id !== plan.id)
        ],
        previewApprovals: this.state.previewApprovals.map((approval) =>
          approval.taskId === plan.taskId &&
          approval.executionDigest !== plan.executionDigest &&
          !approval.invalidatedAt
            ? {
                ...approval,
                invalidatedAt: now,
                invalidatedReason: 'Preview execution plan changed.'
              }
            : approval
        )
      };
      await this.appendEventInternal(
        createDomainEvent({
          type: 'PREVIEW_PLAN_RESOLVED',
          taskId: plan.taskId,
          iterationId: plan.iterationId,
          worktreeId: plan.worktreeId,
          previewPlanId: plan.id,
          source: 'preview',
          payload: { executionDigest: plan.executionDigest }
        }),
        false
      );
      await this.persistSnapshot();
      return clone(plan);
    });
  }

  async savePreviewApproval(approval: PreviewApprovalRecord): Promise<PreviewApprovalRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      this.assertPreviewApprovalReferences(approval);
      this.state = {
        ...this.state,
        previewApprovals: [
          approval,
          ...this.state.previewApprovals.filter((candidate) => candidate.id !== approval.id)
        ]
      };
      await this.appendEventInternal(
        createDomainEvent({
          type: 'PREVIEW_PLAN_APPROVED',
          taskId: approval.taskId,
          previewPlanId: approval.planId,
          source: 'preview',
          payload: { executionDigest: approval.executionDigest, scope: approval.scope }
        }),
        false
      );
      await this.persistSnapshot();
      return clone(approval);
    });
  }

  async savePreviewGeneration(
    generation: PreviewGenerationRecord
  ): Promise<PreviewGenerationRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      this.assertPreviewGenerationReferences(generation);
      const exists = this.state.previewGenerations.some(
        (candidate) => candidate.id === generation.id
      );
      this.state = {
        ...this.state,
        previewGenerations: [
          generation,
          ...this.state.previewGenerations.filter((candidate) => candidate.id !== generation.id)
        ]
      };
      await this.appendEventInternal(
        createDomainEvent({
          type: exists ? 'PREVIEW_GENERATION_UPDATED' : 'PREVIEW_GENERATION_CREATED',
          taskId: generation.taskId,
          iterationId: generation.iterationId,
          worktreeId: generation.worktreeId,
          previewPlanId: generation.planId,
          previewGenerationId: generation.id,
          source: 'preview',
          payload: { state: generation.state, freshness: generation.freshness }
        }),
        false
      );
      await this.persistSnapshot();
      return clone(generation);
    });
  }

  async savePreviewManagedEnvironment(
    environment: PreviewManagedEnvironmentRecord
  ): Promise<PreviewManagedEnvironmentRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      if (!this.state.tasks.some((task) => task.id === environment.taskId)) {
        throw new Error('Preview managed environment references a missing task.');
      }
      const hasOtherLiveEnvironment = this.state.previewManagedEnvironments.some(
        (candidate) =>
          candidate.taskId === environment.taskId &&
          candidate.id !== environment.id &&
          candidate.state !== 'STOPPED'
      );
      if (environment.state !== 'STOPPED' && hasOtherLiveEnvironment) {
        throw new Error('A task preview may have only one managed environment.');
      }
      this.state = {
        ...this.state,
        previewManagedEnvironments: [
          environment,
          ...this.state.previewManagedEnvironments.filter((candidate) => candidate.id !== environment.id)
        ]
      };
      await this.persistSnapshot();
      return clone(environment);
    });
  }

  async savePreviewComposeProject(
    project: PreviewComposeProjectRecord
  ): Promise<PreviewComposeProjectRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      if (!this.state.tasks.some((task) => task.id === project.taskId)) {
        throw new Error('Preview Compose project references a missing task.');
      }
      const conflicting = this.state.previewComposeProjects.find(
        (candidate) => candidate.taskId === project.taskId && candidate.id !== project.id
      );
      if (conflicting && conflicting.state !== 'STOPPED') {
        throw new Error('A task preview may have only one Compose project record.');
      }
      this.state = {
        ...this.state,
        previewComposeProjects: [
          project,
          ...this.state.previewComposeProjects.filter((candidate) => candidate.taskId !== project.taskId)
        ]
      };
      await this.persistSnapshot();
      return clone(project);
    });
  }

  async savePreviewManagedResource(
    resource: PreviewManagedResourceRecord
  ): Promise<PreviewManagedResourceRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      const environment = this.state.previewManagedEnvironments.find(
        (candidate) => candidate.id === resource.environmentId && candidate.taskId === resource.taskId
      );
      if (!environment) throw new Error('Preview managed resource references a missing environment.');
      const duplicate = this.state.previewManagedResources.find(
        (candidate) =>
          candidate.environmentId === resource.environmentId &&
          candidate.logicalResourceId === resource.logicalResourceId &&
          candidate.id !== resource.id &&
          candidate.state !== 'STOPPED'
      );
      if (resource.state !== 'STOPPED' && duplicate) {
        throw new Error(`Managed resource ${resource.logicalResourceId} already exists.`);
      }
      this.state = {
        ...this.state,
        previewManagedResources: [
          resource,
          ...this.state.previewManagedResources.filter((candidate) => candidate.id !== resource.id)
        ]
      };
      await this.persistSnapshot();
      return clone(resource);
    });
  }

  async savePreviewGenerationAttachments(
    attachments: PreviewGenerationAttachmentRecord[]
  ): Promise<PreviewGenerationAttachmentRecord[]> {
    return this.serializeMutation(async () => {
      await this.init();
      for (const attachment of attachments) {
        const generation = this.state.previewGenerations.find(
          (candidate) => candidate.id === attachment.generationId && candidate.taskId === attachment.taskId
        );
        const resource = this.state.previewManagedResources.find(
          (candidate) =>
            candidate.id === attachment.managedResourceId &&
            candidate.taskId === attachment.taskId &&
            candidate.logicalResourceId === attachment.logicalResourceId &&
            candidate.binding?.id === attachment.bindingId
        );
        if (!generation || !resource) {
          throw new Error('Preview generation attachment references missing authority.');
        }
      }
      const ids = new Set(attachments.map((attachment) => attachment.id));
      const generationIds = new Set(attachments.map((attachment) => attachment.generationId));
      this.state = {
        ...this.state,
        previewGenerationAttachments: [
          ...attachments,
          ...this.state.previewGenerationAttachments.filter(
            (candidate) => !ids.has(candidate.id) && !generationIds.has(candidate.generationId)
          )
        ]
      };
      await this.persistSnapshot();
      return clone(attachments);
    });
  }

  async cutoverPreviewGenerations(input: {
    candidate: PreviewGenerationRecord;
    replaced?: PreviewGenerationRecord;
    designSettlement?: DesignPreviewSettlementInput;
  }): Promise<{
    candidate: PreviewGenerationRecord;
    replaced?: PreviewGenerationRecord;
    revision?: DesignRevision;
  }> {
    return this.serializeMutation(async () => {
      await this.init();
      this.assertPreviewGenerationReferences(input.candidate);
      if (input.replaced) this.assertPreviewGenerationReferences(input.replaced);
      const storedCandidate = this.state.previewGenerations.find(
        (generation) => generation.id === input.candidate.id
      );
      const storedActive = this.state.previewGenerations.filter(
        (generation) =>
          generation.taskId === input.candidate.taskId &&
          generation.routingState === 'ACTIVE' &&
          generation.state === 'READY'
      );
      if (
        storedCandidate?.routingState !== 'CANDIDATE' ||
        input.candidate.routingState !== 'ACTIVE' ||
        input.candidate.replacesGenerationId !== input.replaced?.id ||
        storedActive.some((generation) => generation.id !== input.replaced?.id) ||
        (input.replaced &&
          (storedActive.length !== 1 ||
            input.replaced.taskId !== input.candidate.taskId ||
            input.replaced.routingState !== 'RETIRED'))
      ) {
        throw new Error('Preview cutover requires one active candidate and an optional retired generation for the same task.');
      }
      let candidate = input.candidate;
      let revision: DesignRevision | undefined;
      let settledTurn: DesignTurn | undefined;
      if (input.designSettlement) {
        const settlement = input.designSettlement;
        const design = this.requireDesign(settlement.designId);
        const turn = this.requireDesignTurn(settlement.designId, settlement.turnId);
        const run = this.state.runs.find(
          (candidateRun) =>
            candidateRun.id === settlement.runId &&
            candidateRun.taskId === design.id &&
            candidateRun.mode === 'DESIGN' &&
            candidateRun.generationKey === turn.id
        );
        const selectedRoute = candidate.routes.find(
          (route) => route.id === settlement.routeId && route.state === 'ATTACHED'
        );
        if (
          candidate.taskId !== design.id ||
          candidate.source.type !== 'EXACT_COMMIT' ||
          candidate.source.repositoryId !== design.repositoryId ||
          candidate.source.commitSha !== settlement.commitSha ||
          candidate.source.designRevisionId !== undefined ||
          !isGitObjectId(settlement.commitSha) ||
          !run ||
          run.status !== 'COMPLETED' ||
          turn.runId !== run.id ||
          turn.outcome !== undefined ||
          turn.checkpoint?.boundary !== 'PREVIEW_CANDIDATE_READY' ||
          turn.checkpoint.previewGenerationId !== candidate.id ||
          turn.checkpoint.commitSha !== settlement.commitSha ||
          !selectedRoute ||
          this.state.designRevisions.some(
            (existing) =>
              existing.designId === design.id &&
              (existing.turnId === turn.id || existing.runId === run.id)
          )
        ) {
          throw new Error('Design Preview settlement ownership is inconsistent.');
        }
        const now = new Date().toISOString();
        revision = {
          id: randomUUID(),
          designId: design.id,
          ordinal:
            Math.max(
              0,
              ...this.state.designRevisions
                .filter((existing) => existing.designId === design.id)
                .map((existing) => existing.ordinal)
            ) + 1,
          commitSha: settlement.commitSha,
          changeSource: 'AGENT_TURN',
          turnId: turn.id,
          runId: run.id,
          routeId: selectedRoute.id,
          createdAt: now
        };
        candidate = {
          ...candidate,
          source: { ...candidate.source, designRevisionId: revision.id },
          freshness: 'REVISION'
        };
        settledTurn = {
          ...turn,
          checkpoint: undefined,
          finalOpenedCandidate: undefined,
          outcome: 'READY',
          settledAt: now
        };
      } else if (
        input.candidate.source.type === 'EXACT_COMMIT' &&
        input.candidate.source.designRevisionId === undefined
      ) {
        throw new Error('An exact-commit Design cutover requires durable revision settlement.');
      }
      const updates = new Map(
        [candidate, input.replaced]
          .filter(Boolean)
          .map((generation) => [generation!.id, generation!])
      );
      this.state = {
        ...this.state,
        tasks: settledTurn
          ? this.state.tasks.map((task) =>
              task.id === settledTurn!.designId
                ? { ...task, updatedAt: settledTurn!.settledAt! }
                : task
            )
          : this.state.tasks,
        designTurns: settledTurn
          ? this.state.designTurns.map((turn) =>
              turn.id === settledTurn!.id ? settledTurn! : turn
            )
          : this.state.designTurns,
        designRevisions: revision
          ? [revision, ...this.state.designRevisions]
          : this.state.designRevisions,
        previewGenerations: [
          candidate,
          ...(input.replaced ? [input.replaced] : []),
          ...this.state.previewGenerations.filter((generation) => !updates.has(generation.id))
        ]
      };
      for (const generation of updates.values()) {
        await this.appendEventInternal(
          createDomainEvent({
            type: 'PREVIEW_GENERATION_UPDATED',
            taskId: generation.taskId,
            iterationId: generation.iterationId,
            worktreeId: generation.worktreeId,
            previewPlanId: generation.planId,
            previewGenerationId: generation.id,
            source: 'preview',
            payload: {
              state: generation.state,
              freshness: generation.freshness,
              routingState: generation.routingState
            }
          }),
          false
        );
      }
      await this.persistSnapshot();
      return clone({ candidate, replaced: input.replaced, revision });
    });
  }

  async prunePreviewHistory(taskId: string, maxTerminalGenerations = 20): Promise<number> {
    return this.serializeMutation(async () => {
      await this.init();
      if (!Number.isInteger(maxTerminalGenerations) || maxTerminalGenerations < 1 || maxTerminalGenerations > 100) {
        throw new Error('Preview history retention must be between 1 and 100 generations.');
      }
      const terminal = this.state.previewGenerations
        .filter((generation) => generation.taskId === taskId && ['STOPPED', 'FAILED'].includes(generation.state))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const removedIds = new Set(terminal.slice(maxTerminalGenerations).map((generation) => generation.id));
      if (removedIds.size === 0) return 0;
      const removedAttempts = this.state.previewNodeAttempts.filter((attempt) => removedIds.has(attempt.generationId));
      const removedGenerations = this.state.previewGenerations.filter((generation) => removedIds.has(generation.id));
      const artifactIds = new Set([
        ...removedAttempts.flatMap((attempt) => [attempt.stdoutArtifactId, attempt.stderrArtifactId]),
        ...removedGenerations.flatMap((generation) => generation.sourceManifestArtifactId ? [generation.sourceManifestArtifactId] : [])
      ]);
      const artifacts = this.state.artifacts.filter((artifact) => artifactIds.has(artifact.id));
      this.state = {
        ...this.state,
        previewGenerations: this.state.previewGenerations.filter((generation) => !removedIds.has(generation.id)),
        previewNodeAttempts: this.state.previewNodeAttempts.filter((attempt) => !removedIds.has(attempt.generationId)),
        previewResources: this.state.previewResources.filter((resource) => !removedIds.has(resource.generationId)),
        previewGenerationAttachments: this.state.previewGenerationAttachments.filter(
          (attachment) => !removedIds.has(attachment.generationId)
        ),
        events: this.state.events.filter((event) => !event.previewGenerationId || !removedIds.has(event.previewGenerationId)),
        artifacts: this.state.artifacts.filter((artifact) => !artifactIds.has(artifact.id))
      };
      await this.persistSnapshot();
      await Promise.all(artifacts.map((artifact) => unlinkIfExists(artifact.path)));
      return removedIds.size;
    });
  }

  async prunePreviewProbeHistory(
    generationId: string,
    nodeId: string,
    maxAttempts = 20
  ): Promise<number> {
    return this.serializeMutation(async () => {
      await this.init();
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
        throw new Error('Preview probe retention must be between 1 and 100 attempts.');
      }
      const terminalAttempts = this.state.previewNodeAttempts
        .filter(
          (attempt) =>
            attempt.generationId === generationId &&
            attempt.nodeId === nodeId &&
            attempt.kind === 'PROBE' &&
            ['SUCCEEDED', 'FAILED', 'STOPPED'].includes(attempt.state)
        )
        .sort((a, b) => b.attempt - a.attempt);
      const removedAttempts = terminalAttempts.slice(maxAttempts);
      if (removedAttempts.length === 0) return 0;
      const removedAttemptIds = new Set(removedAttempts.map((attempt) => attempt.id));
      const artifactIds = new Set(
        removedAttempts.flatMap((attempt) => [attempt.stdoutArtifactId, attempt.stderrArtifactId])
      );
      const terminalResources = this.state.previewResources
        .filter(
          (resource) =>
            resource.generationId === generationId &&
            resource.logicalNodeId === nodeId &&
            ['STOPPED', 'EXITED', 'FAILED'].includes(resource.state)
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const removedResourceIds = new Set(
        terminalResources.slice(maxAttempts).map((resource) => resource.id)
      );
      const artifacts = this.state.artifacts.filter((artifact) => artifactIds.has(artifact.id));
      this.state = {
        ...this.state,
        previewNodeAttempts: this.state.previewNodeAttempts.filter(
          (attempt) => !removedAttemptIds.has(attempt.id)
        ),
        previewResources: this.state.previewResources.filter(
          (resource) => !removedResourceIds.has(resource.id)
        ),
        events: this.state.events.filter(
          (event) => {
            if (event.previewGenerationId !== generationId || !event.payload) return true;
            const payload = event.payload as { nodeId?: unknown; resourceId?: unknown };
            return payload.nodeId !== nodeId &&
              (typeof payload.resourceId !== 'string' || !removedResourceIds.has(payload.resourceId));
          }
        ),
        artifacts: this.state.artifacts.filter((artifact) => !artifactIds.has(artifact.id))
      };
      await this.persistSnapshot();
      await Promise.all(artifacts.map((artifact) => unlinkIfExists(artifact.path)));
      return removedAttempts.length;
    });
  }

  async savePreviewNodeAttempt(
    attempt: PreviewNodeAttemptRecord
  ): Promise<PreviewNodeAttemptRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      this.assertPreviewChildReferences(attempt.taskId, attempt.generationId, 'attempt');
      this.state = {
        ...this.state,
        previewNodeAttempts: [
          attempt,
          ...this.state.previewNodeAttempts.filter((candidate) => candidate.id !== attempt.id)
        ]
      };
      await this.appendEventInternal(
        createDomainEvent({
          type: 'PREVIEW_NODE_UPDATED',
          taskId: attempt.taskId,
          previewGenerationId: attempt.generationId,
          source: 'preview',
          payload: { nodeId: attempt.nodeId, state: attempt.state }
        }),
        false
      );
      await this.persistSnapshot();
      return clone(attempt);
    });
  }

  async savePreviewResource(resource: PreviewNativeResourceRecord): Promise<PreviewNativeResourceRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      this.assertPreviewChildReferences(resource.taskId, resource.generationId, 'resource');
      this.state = {
        ...this.state,
        previewResources: [
          resource,
          ...this.state.previewResources.filter((candidate) => candidate.id !== resource.id)
        ]
      };
      await this.appendEventInternal(
        createDomainEvent({
          type: 'PREVIEW_RESOURCE_UPDATED',
          taskId: resource.taskId,
          previewGenerationId: resource.generationId,
          source: 'preview',
          payload: { resourceId: resource.id, state: resource.state }
        }),
        false
      );
      await this.persistSnapshot();
      return clone(resource);
    });
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    await this.init();
    return clone(this.state.runs.find((run) => run.id === runId));
  }

  async getRunByProviderTurnId(
    runtimeId: string,
    providerTurnId: string
  ): Promise<RunRecord | undefined> {
    await this.init();
    return clone(
      this.state.runs.find(
        (run) => run.runtimeId === runtimeId && run.providerTurnId === providerTurnId
      )
    );
  }

  async getActiveRunForSession(sessionId: string): Promise<RunRecord | undefined> {
    await this.init();
    return clone(
      this.state.runs.find(
        (run) =>
          run.sessionId === sessionId &&
          [
            'QUEUED',
            'STARTING',
            'RUNNING',
            'AWAITING_APPROVAL',
            'AWAITING_USER_INPUT',
            'INTERRUPTING'
          ].includes(run.status)
      )
    );
  }

  async updateRun(
    runId: string,
    update: RunUpdate
  ): Promise<RunRecord> {
    return this.serializeMutation(() => this.updateRunInternal(runId, update));
  }

  private async updateRunInternal(
    runId: string,
    update: RunUpdate
  ): Promise<RunRecord> {
    await this.init();
    const existing = this.state.runs.find((run) => run.id === runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }
    const stored = { ...existing, ...update };
    if (stored.serverInstanceId) {
      assertServerRuntime(
        this.state,
        stored.runtimeId,
        stored.serverInstanceId,
        'Run'
      );
    }
    if (
      stored.providerTurnId &&
      this.state.runs.some(
        (run) =>
          run.id !== stored.id &&
          run.runtimeId === stored.runtimeId &&
          run.providerTurnId === stored.providerTurnId
      )
    ) {
      throw new Error(
        `Provider turn ${stored.providerTurnId} is already owned by another ${stored.runtimeId} run.`
      );
    }
    let designReferences = this.state.designReferences;
    if (
      existing.mode === 'DESIGN' &&
      existing.generationKey &&
      update.attachmentSubmissions?.length
    ) {
      const turn = this.requireDesignTurn(existing.taskId, existing.generationKey);
      const selectedReferenceIds = new Set(turn.referenceIds);
      const deliveryTimeByAttachment = new Map(
        update.attachmentSubmissions.map((submission) => [
          submission.attachmentId,
          submission.submittedAt
        ])
      );
      designReferences = this.state.designReferences.map((reference) => {
        const deliveredAt = deliveryTimeByAttachment.get(reference.attachmentId);
        return selectedReferenceIds.has(reference.id) && deliveredAt && !reference.firstDeliveredAt
          ? { ...reference, firstDeliveredAt: deliveredAt }
          : reference;
      });
    }
    this.state = {
      ...this.state,
      runs: this.state.runs.map((run) => (run.id === runId ? stored : run)),
      designReferences
    };
    await this.persistSnapshot();
    return clone(stored);
  }

  async getAgentServer(serverInstanceId: string): Promise<AgentServerInstance | undefined> {
    await this.init();
    return clone(this.state.agentServers.find((server) => server.id === serverInstanceId));
  }

  async getAgentSession(sessionId: string): Promise<AgentSessionRecord | undefined> {
    await this.init();
    return clone(this.state.agentSessions.find((session) => session.id === sessionId));
  }

  async getAgentSessionByProviderId(
    runtimeId: string,
    providerSessionId: string
  ): Promise<AgentSessionRecord | undefined> {
    await this.init();
    return clone(
      this.state.agentSessions.find(
        (session) =>
          session.runtimeId === runtimeId && session.providerSessionId === providerSessionId
      )
    );
  }

  async getInteractionRequestByProviderId(
    serverInstanceId: string,
    providerRequestId: string | number
  ): Promise<InteractionRequestRecord | undefined> {
    await this.init();
    return clone(
      this.state.interactionRequests.find(
        (request) =>
          request.serverInstanceId === serverInstanceId &&
          request.providerRequestId === providerRequestId
      )
    );
  }

  async getInteractionRequest(
    interactionRequestId: string
  ): Promise<InteractionRequestRecord | undefined> {
    await this.init();
    return clone(
      this.state.interactionRequests.find(
        (request) => request.id === interactionRequestId
      )
    );
  }

  async getAgentItemsForRun(runId: string): Promise<AgentItemRecord[]> {
    await this.init();
    return clone(this.state.agentItems.filter((item) => item.runId === runId));
  }

  async getAgentItemByProviderId(
    runId: string,
    providerItemId: string
  ): Promise<AgentItemRecord | undefined> {
    await this.init();
    return clone(
      this.state.agentItems.find(
        (item) => item.runId === runId && item.providerItemId === providerItemId
      )
    );
  }

  async getRunsRequiringRecovery(options: {
    includeQueued?: boolean;
    runtimeId?: string;
  } = {}): Promise<RunRecord[]> {
    await this.init();
    const statuses: RunRecord['status'][] = [
      'RECOVERY_REQUIRED',
      'RUNNING',
      'STARTING',
      'AWAITING_APPROVAL',
      'AWAITING_USER_INPUT',
      'INTERRUPTING'
    ];
    if (options.includeQueued) statuses.push('QUEUED');
    return clone(
      this.state.runs.filter(
        (run) =>
          statuses.includes(run.status) &&
          (!options.runtimeId || run.runtimeId === options.runtimeId)
      )
    );
  }

  async getIteration(iterationId: string): Promise<TaskIteration | undefined> {
    await this.init();
    return clone(this.state.iterations.find((iteration) => iteration.id === iterationId));
  }

  async getWorktree(worktreeId: string): Promise<WorktreeRecord | undefined> {
    await this.init();
    return clone(this.state.worktrees.find((worktree) => worktree.id === worktreeId));
  }

  async getPrimaryAgentSession(
    taskId: string,
    iterationId: string
  ): Promise<AgentSessionRecord | undefined> {
    await this.init();
    return clone(
      this.state.agentSessions.find(
        (session) =>
          session.taskId === taskId &&
          session.iterationId === iterationId &&
          session.role === 'PRIMARY'
      )
    );
  }

  async getCurrentIteration(taskId: string): Promise<TaskIteration | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    return clone(this.state.iterations.find((iteration) => iteration.id === task?.currentIterationId));
  }

  async getCurrentWorktree(taskId: string): Promise<WorktreeRecord | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    return clone(this.state.worktrees.find((worktree) => worktree.id === task?.currentWorktreeId));
  }

  async getLatestGitSnapshot(taskId: string): Promise<GitSnapshotRecord | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    const iterationId = task?.currentIterationId;
    return clone(
      this.state.gitSnapshots
        .filter((snapshot) => snapshot.taskId === taskId && snapshot.iterationId === iterationId)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0]
    );
  }

  async getLatestPullRequest(taskId: string): Promise<PullRequestSnapshotRecord | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    return clone(
      this.state.pullRequests
        .filter((pr) => pr.taskId === taskId && pr.iterationId === task?.currentIterationId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
    );
  }

  async createDesignBundle(
    input: CreateDesignBundleInput
  ): Promise<CreateDesignBundleResult> {
    return this.serializeMutation(async () => {
      await this.init();
      const retry = this.resolveDesignCreationRetryFromState(input.request);
      if (retry) return clone(retry);

      const metadata = designCreationMetadata(input.request);
      const brief = input.request.brief.trim();
      if (!brief) throw new Error('Design brief is required.');
      const repositoryPath = path.resolve(input.repository.path);
      if (
        !UUID_FILE_SEGMENT_PATTERN.test(input.repository.id) ||
        !input.repository.name.trim() ||
        !input.repository.branch.trim() ||
        !isGitObjectId(input.repository.headSha) ||
        !isCanonicalIsoTimestamp(input.repository.checkedAt)
      ) {
        throw new Error('Managed Design repository identity is invalid.');
      }
      if (
        this.state.repositories.some(
          (repository) =>
            repository.id === input.repository.id ||
            sameAbsolutePath(path.resolve(repository.path), repositoryPath)
        )
      ) {
        throw new Error('Managed Design repository identity is already registered.');
      }

      const now = new Date().toISOString();
      const repository: Repository = {
        id: input.repository.id,
        kind: 'DESIGN_MANAGED',
        name: input.repository.name.trim(),
        path: repositoryPath,
        status: 'AVAILABLE',
        headSha: input.repository.headSha,
        branch: input.repository.branch.trim(),
        remotes: [],
        createdAt: now,
        updatedAt: now,
        checkedAt: input.repository.checkedAt
      };
      const task: Task = {
        id: randomUUID(),
        kind: 'DESIGN',
        runtimeId: CODEX_RUNTIME_ID,
        title: deriveDesignTitle(brief),
        prompt: brief,
        repositoryId: repository.id,
        creationToken: metadata.token,
        creationRequestFingerprint: metadata.fingerprint,
        workflowPhase: 'READY',
        resolution: 'NONE',
        completionPolicy: 'MANUAL',
        phaseVersion: 1,
        forkedAlternativeTaskIds: [],
        agentSettings: {
          runtimeId: CODEX_RUNTIME_ID,
          model: normalizedOptionalString(input.request.model),
          reasoningEffort: normalizedOptionalString(input.request.reasoningEffort),
          sandbox: 'WORKSPACE_WRITE',
          networkAccess: false,
          approvalPolicy: 'never',
          approvalsReviewer: 'user'
        },
        createdAt: now,
        updatedAt: now,
        projection: createInitialProjection(now)
      };

      const previousState = this.state;
      let preparedDraft: PreparedAttachmentDraft | undefined;
      let attachmentRecords: TaskAttachmentRecord[] = [];
      let publishedWithoutDirectorySync = false;
      try {
        if (input.request.attachmentDraftId) {
          preparedDraft = await this.attachmentFiles.prepareDraftForTask(
            input.request.attachmentDraftId,
            task.id
          );
          attachmentRecords = preparedDraft.records;
        }
        const references: DesignReference[] = attachmentRecords.map((attachment) => ({
          id: randomUUID(),
          designId: task.id,
          attachmentId: attachment.id,
          role: 'REFERENCE',
          state: 'ACTIVE',
          sourceDraftId: input.request.attachmentDraftId,
          createdAt: now
        }));
        const turn: DesignTurn = {
          id: randomUUID(),
          designId: task.id,
          clientMessageId: input.request.creationToken,
          order: 1,
          messageSource: 'TASK_PROMPT',
          attachmentDraftId: input.request.attachmentDraftId,
          referenceIds: references.map((reference) => reference.id),
          checkpoint: { boundary: 'QUEUED' },
          createdAt: now
        };
        this.state = {
          ...this.state,
          repositories: [repository, ...this.state.repositories],
          tasks: [task, ...this.state.tasks],
          designTurns: [turn, ...this.state.designTurns],
          designReferences: [...references, ...this.state.designReferences],
          attachments: [...attachmentRecords, ...this.state.attachments]
        };
        this.state = applyEventToState(
          this.state,
          createDomainEvent({
            type: 'TASK_CREATED',
            taskId: task.id,
            source: 'ui',
            payload: {
              kind: task.kind,
              title: task.title,
              repositoryId: task.repositoryId,
              attachmentIds: attachmentRecords.map((attachment) => attachment.id),
              designTurnId: turn.id
            }
          })
        );
        publishedWithoutDirectorySync = !(await this.persistSnapshot());
        if (!publishedWithoutDirectorySync && preparedDraft) {
          await this.attachmentFiles.finalizeDraftForTask(preparedDraft).catch(
            () => undefined
          );
        }
        return clone({ task, repository, turn, references });
      } catch (error) {
        this.state = previousState;
        if (preparedDraft) {
          try {
            await this.attachmentFiles.rollbackDraftForTask(preparedDraft);
          } catch (rollbackError) {
            throw new AttachmentAdoptionAmbiguousError(
              preparedDraft,
              error,
              rollbackError
            );
          }
        }
        throw error;
      }
    });
  }

  async resolveDesignCreationRetry(
    request: CreateBlankDesignRequest
  ): Promise<CreateDesignBundleResult | undefined> {
    await this.init();
    return clone(this.resolveDesignCreationRetryFromState(request));
  }

  async createInlineDesignTurn(
    input: CreateInlineDesignTurnInput
  ): Promise<DesignTurn> {
    return this.serializeMutation(async () => {
      await this.init();
      const design = this.requireDesign(input.designId);
      validateInlineDesignTurnInput(input);
      const existing = this.state.designTurns.find(
        (turn) =>
          turn.designId === design.id &&
          turn.clientMessageId === input.clientMessageId
      );
      if (existing) {
        await this.assertInlineDesignTurnRetry(existing, input);
        return clone(existing);
      }
      const queuedTurnCount = this.state.designTurns.filter(
        (turn) =>
          turn.designId === design.id &&
          turn.outcome === undefined &&
          !turn.runId
      ).length;
      if (queuedTurnCount >= DESIGN_LIMITS.queuedTurns) {
        throw new Error('This Design message queue is full.');
      }

      const now = new Date().toISOString();
      const selectedReferences = input.referenceIds.map((referenceId) =>
        this.state.designReferences.find(
          (reference) =>
            reference.id === referenceId &&
            reference.designId === design.id &&
            reference.state === 'ACTIVE'
        )
      );
      if (selectedReferences.some((reference) => !reference)) {
        throw new Error('A selected Design reference is not active.');
      }
      const referenceIds = [...input.referenceIds];
      const previousState = this.state;
      let prepared: PreparedAttachmentAppend | undefined;
      let artifact: ArtifactRecord | undefined;
      try {
        if (input.attachmentDraftId) {
          const existingRecords = this.state.attachments
            .filter((attachment) => attachment.taskId === design.id)
            .sort((left, right) => left.ordinal - right.ordinal);
          prepared = await this.attachmentFiles.prepareDraftForExistingTask(
            input.attachmentDraftId,
            design.id,
            existingRecords
          );
        }
        const addedReferences = (prepared?.records ?? []).map<DesignReference>(
          (attachment) => ({
            id: randomUUID(),
            designId: design.id,
            attachmentId: attachment.id,
            role: 'REFERENCE',
            state: 'ACTIVE',
            sourceDraftId: input.attachmentDraftId,
            createdAt: now
          })
        );
        artifact = await this.createArtifactRecord(design.id, 'design-message');
        await writeNewArtifactFiles(this.artifactsDir, [
          { artifact, content: input.message }
        ]);
        const order =
          Math.max(
            0,
            ...this.state.designTurns
              .filter((turn) => turn.designId === design.id)
              .map((turn) => turn.order)
          ) + 1;
        const turn: DesignTurn = {
          id: randomUUID(),
          designId: design.id,
          clientMessageId: input.clientMessageId,
          order,
          messageSource: 'INLINE_MESSAGE',
          messageArtifactId: artifact.id,
          attachmentDraftId: input.attachmentDraftId,
          referenceIds: [...referenceIds, ...addedReferences.map((reference) => reference.id)],
          checkpoint: { boundary: 'QUEUED' },
          createdAt: now
        };
        this.state = {
          ...this.state,
          tasks: this.state.tasks.map((task) =>
            task.id === design.id ? { ...task, updatedAt: now } : task
          ),
          attachments: [...this.state.attachments, ...(prepared?.records ?? [])],
          designReferences: [...this.state.designReferences, ...addedReferences],
          designTurns: [turn, ...this.state.designTurns],
          artifacts: [artifact, ...this.state.artifacts]
        };
        const directorySynced = await this.persistSnapshot();
        if (directorySynced && prepared) {
          await this.attachmentFiles
            .finalizeDraftForExistingTask(prepared)
            .catch(() => undefined);
        }
        return clone(turn);
      } catch (error) {
        this.state = previousState;
        if (artifact) await this.cleanupUnpublishedArtifacts([artifact]);
        if (prepared) {
          try {
            await this.attachmentFiles.rollbackDraftForExistingTask(prepared);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Design message failed and its prepared reference files could not be removed.'
            );
          }
        }
        throw error;
      }
    });
  }

  async resolveInlineDesignTurnRetry(
    input: CreateInlineDesignTurnInput
  ): Promise<DesignTurn | undefined> {
    await this.init();
    validateInlineDesignTurnInput(input);
    const existing = this.state.designTurns.find(
      (turn) =>
        turn.designId === input.designId &&
        turn.clientMessageId === input.clientMessageId
    );
    if (!existing) return undefined;
    await this.assertInlineDesignTurnRetry(existing, input);
    return clone(existing);
  }

  async addDesignReferences(input: {
    designId: string;
    attachmentDraftId: string;
  }): Promise<DesignReference[]> {
    return this.serializeMutation(async () => {
      await this.init();
      const design = this.requireDesign(input.designId);
      const retry = this.state.designReferences.filter(
        (reference) =>
          reference.designId === design.id &&
          reference.sourceDraftId === input.attachmentDraftId
      );
      if (retry.length > 0) {
        await this.attachmentFiles
          .discardDraft(input.attachmentDraftId)
          .catch(() => undefined);
        return clone(retry);
      }

      const existingRecords = this.state.attachments
        .filter((attachment) => attachment.taskId === design.id)
        .sort((left, right) => left.ordinal - right.ordinal);
      const previousState = this.state;
      let prepared: PreparedAttachmentAppend | undefined;
      try {
        prepared = await this.attachmentFiles.prepareDraftForExistingTask(
          input.attachmentDraftId,
          design.id,
          existingRecords
        );
        const now = new Date().toISOString();
        const references = prepared.records.map<DesignReference>((attachment) => ({
          id: randomUUID(),
          designId: design.id,
          attachmentId: attachment.id,
          role: 'REFERENCE',
          state: 'ACTIVE',
          sourceDraftId: input.attachmentDraftId,
          createdAt: now
        }));
        this.state = {
          ...this.state,
          tasks: this.state.tasks.map((task) =>
            task.id === design.id ? { ...task, updatedAt: now } : task
          ),
          attachments: [...this.state.attachments, ...prepared.records],
          designReferences: [...this.state.designReferences, ...references]
        };
        const directorySynced = await this.persistSnapshot();
        if (directorySynced) {
          await this.attachmentFiles
            .finalizeDraftForExistingTask(prepared)
            .catch(() => undefined);
        }
        return clone(references);
      } catch (error) {
        this.state = previousState;
        if (prepared) {
          try {
            await this.attachmentFiles.rollbackDraftForExistingTask(prepared);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Reference adoption failed and its prepared files could not be removed.'
            );
          }
        }
        throw error;
      }
    });
  }

  async removeDesignReference(input: {
    designId: string;
    referenceId: string;
  }): Promise<DesignReference> {
    return this.serializeMutation(async () => {
      await this.init();
      this.requireDesign(input.designId);
      const reference = this.state.designReferences.find(
        (candidate) =>
          candidate.id === input.referenceId &&
          candidate.designId === input.designId
      );
      if (!reference) throw new Error('Design reference not found.');
      if (reference.state === 'INACTIVE') return clone(reference);
      const now = new Date().toISOString();
      const updated: DesignReference = {
        ...reference,
        state: 'INACTIVE',
        deactivatedAt: now
      };
      const previousState = this.state;
      this.state = {
        ...this.state,
        tasks: this.state.tasks.map((task) =>
          task.id === input.designId ? { ...task, updatedAt: now } : task
        ),
        designReferences: this.state.designReferences.map((candidate) =>
          candidate.id === updated.id ? updated : candidate
        )
      };
      try {
        await this.persistSnapshot();
      } catch (error) {
        this.state = previousState;
        throw error;
      }
      return clone(updated);
    });
  }

  async readDesignReferenceContent(
    designId: string,
    referenceId: string
  ): Promise<{
    reference: DesignReference;
    content: StoredAttachmentContent;
    sha256: string;
  }> {
    return this.withOwnedIo(async () => {
      await this.init();
      this.requireDesign(designId);
      const reference = this.state.designReferences.find(
        (candidate) =>
          candidate.id === referenceId && candidate.designId === designId
      );
      if (!reference || reference.state !== 'ACTIVE') {
        throw new Error('Active Design reference not found.');
      }
      const attachment = this.state.attachments.find(
        (candidate) =>
          candidate.id === reference.attachmentId && candidate.taskId === designId
      );
      if (!attachment) throw new Error('Design reference attachment not found.');
      return {
        reference: clone(reference),
        content: await this.attachmentFiles.readTask(attachment),
        sha256: attachment.sha256
      };
    });
  }

  async recordDesignReferenceAsset(input: {
    designId: string;
    referenceId: string;
    projectAssetPath: string;
  }): Promise<DesignReference> {
    return this.serializeMutation(async () => {
      await this.init();
      if (!isSafeDesignProjectPath(input.projectAssetPath)) {
        throw new Error('Design project asset path is invalid.');
      }
      this.requireDesign(input.designId);
      const reference = this.state.designReferences.find(
        (candidate) =>
          candidate.id === input.referenceId &&
          candidate.designId === input.designId &&
          candidate.state === 'ACTIVE'
      );
      if (!reference) throw new Error('Active Design reference not found.');
      if (reference.role === 'PROJECT_ASSET_SOURCE') {
        if (reference.projectAssetPath !== input.projectAssetPath) {
          throw new Error('Design reference already owns another project asset.');
        }
        return clone(reference);
      }
      const now = new Date().toISOString();
      const updated: DesignReference = {
        ...reference,
        role: 'PROJECT_ASSET_SOURCE',
        projectAssetPath: input.projectAssetPath
      };
      const previousState = this.state;
      this.state = {
        ...this.state,
        tasks: this.state.tasks.map((task) =>
          task.id === input.designId ? { ...task, updatedAt: now } : task
        ),
        designReferences: this.state.designReferences.map((candidate) =>
          candidate.id === updated.id ? updated : candidate
        )
      };
      try {
        await this.persistSnapshot();
      } catch (error) {
        this.state = previousState;
        throw error;
      }
      return clone(updated);
    });
  }

  async getRunByGenerationKey(
    taskId: string,
    generationKey: string
  ): Promise<RunRecord | undefined> {
    await this.init();
    return clone(
      this.publishedState.runs.find(
        (run) =>
          run.taskId === taskId &&
          run.mode === 'DESIGN' &&
          run.generationKey === generationKey
      )
    );
  }

  async linkDesignTurnRun(input: {
    designId: string;
    turnId: string;
    runId: string;
  }): Promise<DesignTurn> {
    return this.serializeMutation(async () => {
      await this.init();
      this.requireDesign(input.designId);
      const turn = this.requireDesignTurn(input.designId, input.turnId);
      const run = this.state.runs.find(
        (candidate) =>
          candidate.id === input.runId &&
          candidate.taskId === input.designId &&
          candidate.mode === 'DESIGN' &&
          candidate.generationKey === input.turnId
      );
      if (!run) throw new Error('Design turn Run ownership is inconsistent.');
      if (turn.runId && turn.runId !== run.id) {
        throw new Error('Design turn is already linked to another Run.');
      }
      if (turn.runId === run.id) return clone(turn);
      if (turn.outcome !== undefined || turn.checkpoint?.boundary !== 'QUEUED') {
        throw new Error('Only a queued unsettled Design turn can link its Run.');
      }
      const updated: DesignTurn = {
        ...turn,
        runId: run.id,
        checkpoint: { boundary: 'RUN_LINKED' }
      };
      this.state = {
        ...this.state,
        designTurns: this.state.designTurns.map((candidate) =>
          candidate.id === updated.id ? updated : candidate
        )
      };
      await this.persistSnapshot();
      return clone(updated);
    });
  }

  async updateDesignTurnCheckpoint(
    input: UpdateDesignTurnCheckpointInput
  ): Promise<DesignTurn> {
    return this.serializeMutation(async () => {
      await this.init();
      const design = this.requireDesign(input.designId);
      const turn = this.requireDesignTurn(input.designId, input.turnId);
      if (turn.outcome !== undefined) {
        throw new Error('A settled Design turn cannot change its checkpoint.');
      }
      if (sameJsonValue(turn.checkpoint, input.checkpoint)) return clone(turn);
      const currentCheckpoint = turn.checkpoint;
      const priorPreviewCandidate =
        currentCheckpoint?.boundary === 'PREVIEW_CANDIDATE_READY'
          ? this.state.previewGenerations.find(
              (generation) => generation.id === currentCheckpoint.previewGenerationId
            )
          : undefined;
      const replacesUnavailablePreviewCandidate =
        currentCheckpoint?.boundary === 'PREVIEW_CANDIDATE_READY' &&
        input.checkpoint.boundary === 'PREVIEW_CANDIDATE_READY' &&
        currentCheckpoint.commitSha === input.checkpoint.commitSha &&
        (!priorPreviewCandidate ||
          priorPreviewCandidate.state === 'STOPPED' ||
          priorPreviewCandidate.state === 'FAILED');
      if (!replacesUnavailablePreviewCandidate) {
        assertDesignCheckpointTransition(turn.checkpoint, input.checkpoint);
      }
      this.assertDesignCheckpointOwnership(design, turn, input.checkpoint);
      const updated: DesignTurn = { ...turn, checkpoint: clone(input.checkpoint) };
      this.state = {
        ...this.state,
        designTurns: this.state.designTurns.map((candidate) =>
          candidate.id === updated.id ? updated : candidate
        )
      };
      await this.persistSnapshot();
      return clone(updated);
    });
  }

  async updateDesignOpenedCandidate(
    input: UpdateDesignOpenedCandidateInput
  ): Promise<DesignTurn> {
    return this.serializeMutation(async () => {
      await this.init();
      const design = this.requireDesign(input.designId);
      const turn = this.requireDesignTurn(input.designId, input.turnId);
      if (turn.outcome !== undefined || !turn.runId) {
        throw new Error('Only an active Design turn can record an opened candidate.');
      }
      if (sameJsonValue(turn.finalOpenedCandidate, input.candidate)) {
        return clone(turn);
      }
      const run = this.state.runs.find(
        (candidate) =>
          candidate.id === turn.runId &&
          candidate.taskId === design.id &&
          candidate.mode === 'DESIGN' &&
          candidate.generationKey === turn.id &&
          [
            'QUEUED',
            'STARTING',
            'RUNNING',
            'AWAITING_APPROVAL',
            'AWAITING_USER_INPUT'
          ].includes(candidate.status)
      );
      const source = input.candidate.source;
      const worktree = this.state.worktrees.find(
        (candidate) =>
          candidate.id === source.worktreeId &&
          candidate.id === design.currentWorktreeId &&
          candidate.taskId === design.id &&
          candidate.repositoryId === design.repositoryId &&
          candidate.branchName === source.branchName
      );
      const generation = this.state.previewGenerations.find(
        (candidate) =>
          candidate.id === input.candidate.previewGenerationId &&
          candidate.taskId === design.id &&
          candidate.state === 'READY' &&
          candidate.routingState === 'CANDIDATE' &&
          candidate.source.type === 'EXACT_COMMIT' &&
          candidate.source.repositoryId === design.repositoryId &&
          candidate.source.commitSha === source.candidateCommitSha &&
          candidate.source.designRevisionId === undefined
      );
      if (
        !run ||
        !worktree ||
        source.repositoryId !== design.repositoryId ||
        !isGitObjectId(source.expectedParentCommit) ||
        !isGitObjectId(source.treeSha) ||
        !isGitObjectId(source.candidateCommitSha) ||
        !generation
      ) {
        throw new Error('Opened Design candidate ownership is inconsistent.');
      }
      const updated: DesignTurn = {
        ...turn,
        finalOpenedCandidate: clone(input.candidate)
      };
      this.state = {
        ...this.state,
        designTurns: this.state.designTurns.map((candidate) =>
          candidate.id === updated.id ? updated : candidate
        )
      };
      await this.persistSnapshot();
      return clone(updated);
    });
  }

  async settleDesignTurn(input: SettleDesignTurnInput): Promise<DesignTurn> {
    return this.serializeMutation(async () => {
      await this.init();
      const design = this.requireDesign(input.designId);
      const turn = this.requireDesignTurn(input.designId, input.turnId);
      const failureReason = normalizedOptionalString(input.failureReason);
      if (
        (input.outcome === 'FAILED' || input.outcome === 'NEEDS_ATTENTION') &&
        !failureReason
      ) {
        throw new Error('Failed Design turn settlement requires a reason.');
      }
      if (turn.outcome !== undefined) {
        if (
          turn.outcome === input.outcome &&
          turn.failureReason === failureReason
        ) {
          return clone(turn);
        }
        throw new Error('Design turn is already settled with a different outcome.');
      }
      if (input.outcome === 'NO_CHANGE') {
        const run = turn.runId
          ? this.state.runs.find((candidate) => candidate.id === turn.runId)
          : undefined;
        if (
          !run ||
          run.status !== 'COMPLETED' ||
          turn.checkpoint?.boundary !== 'POST_RUN_EVIDENCE_RECORDED' ||
          !this.state.designRevisions.some(
            (revision) => revision.designId === design.id
          )
        ) {
          throw new Error(
            'No-change settlement requires a completed evidenced Run and an existing ready revision.'
          );
        }
      }
      const now = new Date().toISOString();
      const updated: DesignTurn = {
        ...turn,
        checkpoint: undefined,
        finalOpenedCandidate: undefined,
        outcome: input.outcome,
        failureReason,
        settledAt: now
      };
      this.state = {
        ...this.state,
        tasks: this.state.tasks.map((task) =>
          task.id === design.id ? { ...task, updatedAt: now } : task
        ),
        designTurns: this.state.designTurns.map((candidate) =>
          candidate.id === updated.id ? updated : candidate
        )
      };
      await this.persistSnapshot();
      return clone(updated);
    });
  }

  async createTask(input: CreateTaskStoreInput): Promise<Task> {
    return this.serializeMutation(() => this.createTaskRecord(input, 'ui'));
  }

  async createForkedAlternativeTask(input: CreateForkedAlternativeTaskInput): Promise<Task> {
    return this.serializeMutation(() =>
      this.createTaskRecord(input, 'ui', {
        sourceTaskId: input.sourceTaskId,
        sourceRunId: input.sourceRunId
      })
    );
  }

  /**
   * Resolves an acknowledged create before callers touch a possibly-consumed
   * attachment draft. A token reused with different normalized input is a
   * conflict, never permission to return the first task.
   */
  async resolveTaskCreationRetry(input: CreateTaskRequest): Promise<Task | undefined> {
    await this.init();
    return clone(this.resolveTaskCreationRetryFromState(input));
  }

  async deleteTask(taskId: string): Promise<void> {
    return this.serializeMutation(async () => {
      await this.deleteTaskInternal(taskId);
    });
  }

  async deleteTaskAndReleaseManagedRepository(
    taskId: string
  ): Promise<DeleteTaskStorageResult> {
    return this.serializeMutation(() => this.deleteTaskInternal(taskId));
  }

  private async deleteTaskInternal(taskId: string): Promise<DeleteTaskStorageResult> {
    await this.init();

    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (
      task.kind === 'DESIGN' &&
      this.state.designTurns.some(
        (turn) => turn.designId === taskId && turn.outcome === undefined
      )
    ) {
      throw new Error('Design has an unsettled turn. Settle or cancel it before deletion.');
    }
    const activePreviewResource = this.state.previewResources.find(
      (resource) =>
        resource.taskId === taskId &&
        !['STOPPED', 'EXITED', 'FAILED'].includes(resource.state)
    );
    if (activePreviewResource) {
      throw new Error(
        `Task has an active or unverified preview resource: ${activePreviewResource.id}. Stop or reconcile it before deletion.`
      );
    }
    const activeManagedEnvironment = this.state.previewManagedEnvironments.find(
      (environment) => environment.taskId === taskId && environment.state !== 'STOPPED'
    );
    const activeManagedResource = this.state.previewManagedResources.find(
      (resource) => resource.taskId === taskId && resource.state !== 'STOPPED'
    );
    if (activeManagedEnvironment || activeManagedResource) {
      throw new Error('Task has an active or unverified managed preview environment. Stop or reconcile it before deletion.');
    }
    const activeComposeProject = this.state.previewComposeProjects.find(
      (project) => project.taskId === taskId && project.state !== 'STOPPED'
    );
    if (activeComposeProject) {
      throw new Error('Task has an active or unverified Compose preview project. Stop or reconcile it before deletion.');
    }
    const nonterminalPreviewGeneration = this.state.previewGenerations.find(
      (generation) =>
        generation.taskId === taskId && !['STOPPED', 'FAILED'].includes(generation.state)
    );
    if (nonterminalPreviewGeneration) {
      throw new Error(
        `Task has an active or unverified preview generation: ${nonterminalPreviewGeneration.id}. Stop or reconcile it before deletion.`
      );
    }

    const runIds = new Set(
      this.state.runs.filter((run) => run.taskId === taskId).map((run) => run.id)
    );
    const sessionIds = new Set(
      this.state.agentSessions
        .filter((session) => session.taskId === taskId)
        .map((session) => session.id)
    );
    const worktreeIds = new Set(
      this.state.worktrees
        .filter((worktree) => worktree.taskId === taskId)
        .map((worktree) => worktree.id)
    );
    const artifactsToDelete = this.state.artifacts.filter(
      (artifact) =>
        artifact.taskId === taskId ||
        (artifact.runId ? runIds.has(artifact.runId) : false)
    );
    const artifactIds = new Set(artifactsToDelete.map((artifact) => artifact.id));
    const now = new Date().toISOString();
    const removedManagedRepository = this.state.repositories.find(
      (repository) =>
        repository.id === task.repositoryId &&
        repository.kind === 'DESIGN_MANAGED' &&
        !this.state.tasks.some(
          (candidate) =>
            candidate.id !== task.id && candidate.repositoryId === repository.id
        )
    );
    const previousState = this.state;
    let publishedWithoutDirectorySync = false;
    let prunedServerIds: string[] = [];

    try {
      this.state = {
        ...this.state,
      repositories: removedManagedRepository
        ? this.state.repositories.filter(
            (repository) => repository.id !== removedManagedRepository.id
          )
        : this.state.repositories,
      boards: removedManagedRepository
        ? this.state.boards.map((board) => ({
            ...board,
            repositoryIds: board.repositoryIds.filter(
              (repositoryId) => repositoryId !== removedManagedRepository.id
            ),
            updatedAt: now
          }))
        : this.state.boards,
      tasks: this.state.tasks
        .filter((candidate) => candidate.id !== taskId)
        .map((candidate) => removeTaskLink(candidate, taskId, now)),
      designTurns: this.state.designTurns.filter((turn) => turn.designId !== taskId),
      designReferences: this.state.designReferences.filter(
        (reference) => reference.designId !== taskId
      ),
      designRevisions: this.state.designRevisions.filter(
        (revision) => revision.designId !== taskId
      ),
      iterations: this.state.iterations.filter((iteration) => iteration.taskId !== taskId),
      worktrees: this.state.worktrees.filter((worktree) => worktree.taskId !== taskId),
      gitSnapshots: this.state.gitSnapshots.filter((snapshot) => snapshot.taskId !== taskId),
      githubRepositories: this.state.githubRepositories.filter(
        (record) => record.taskId !== taskId
      ),
      branchPublications: this.state.branchPublications.filter(
        (record) => record.taskId !== taskId
      ),
      pullRequests: this.state.pullRequests.filter((record) => record.taskId !== taskId),
      ciRollups: this.state.ciRollups.filter((record) => record.taskId !== taskId),
      reviewRollups: this.state.reviewRollups.filter((record) => record.taskId !== taskId),
      mergeSnapshots: this.state.mergeSnapshots.filter((record) => record.taskId !== taskId),
      runs: this.state.runs.filter((run) => run.taskId !== taskId),
      agentSessions: this.state.agentSessions.filter((session) => session.taskId !== taskId),
      agentItems: this.state.agentItems.filter(
        (item) =>
          item.taskId !== taskId &&
          !runIds.has(item.runId) &&
          !sessionIds.has(item.sessionId)
      ),
      agentGoalSnapshots: this.state.agentGoalSnapshots.filter(
        (goal) => goal.taskId !== taskId && !sessionIds.has(goal.sessionId)
      ),
      agentPlanRevisions: this.state.agentPlanRevisions.filter(
        (plan) =>
          plan.taskId !== taskId &&
          !runIds.has(plan.runId) &&
          !sessionIds.has(plan.sessionId)
      ),
      agentUsageSnapshots: this.state.agentUsageSnapshots.filter(
        (usage) =>
          usage.taskId !== taskId &&
          (usage.runId ? !runIds.has(usage.runId) : true) &&
          !sessionIds.has(usage.sessionId)
      ),
      agentSettingsObservations: this.state.agentSettingsObservations.filter(
        (observation) =>
          observation.taskId !== taskId && !sessionIds.has(observation.sessionId)
      ),
      agentSubagentObservations: this.state.agentSubagentObservations.filter(
        (observation) =>
          observation.taskId !== taskId &&
          !sessionIds.has(observation.sessionId) &&
          !sessionIds.has(observation.parentSessionId)
      ),
      interactionRequests: this.state.interactionRequests.filter(
        (request) =>
          request.taskId !== taskId &&
          !runIds.has(request.runId) &&
          !sessionIds.has(request.sessionId)
      ),
      previewPlans: this.state.previewPlans.filter((record) => record.taskId !== taskId),
      previewApprovals: this.state.previewApprovals.filter(
        (record) => record.taskId !== taskId
      ),
      previewComposeProjects: this.state.previewComposeProjects.filter(
        (record) => record.taskId !== taskId
      ),
      previewGenerations: this.state.previewGenerations.filter(
        (record) => record.taskId !== taskId
      ),
      previewManagedEnvironments: this.state.previewManagedEnvironments.filter(
        (record) => record.taskId !== taskId
      ),
      previewManagedResources: this.state.previewManagedResources.filter(
        (record) => record.taskId !== taskId
      ),
      previewGenerationAttachments: this.state.previewGenerationAttachments.filter(
        (record) => record.taskId !== taskId
      ),
      previewLocalBindings: this.state.previewLocalBindings.filter(
        (record) => record.taskId !== taskId
      ),
      previewNodeAttempts: this.state.previewNodeAttempts.filter(
        (record) => record.taskId !== taskId
      ),
      previewResources: this.state.previewResources.filter(
        (record) => record.taskId !== taskId
      ),
      events: this.state.events.filter(
        (event) =>
          !eventBelongsToDeletedTask(event, taskId, {
            runIds,
            sessionIds,
            worktreeIds
          })
      ),
        artifacts: this.state.artifacts.filter((artifact) => !artifactIds.has(artifact.id)),
        attachments: this.state.attachments.filter(
          (attachment) => attachment.taskId !== taskId
        )
      };
      prunedServerIds = this.pruneUnreferencedTerminalAgentServers();

      publishedWithoutDirectorySync = !(await this.persistSnapshot());
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    if (!publishedWithoutDirectorySync) {
      // Files are removed only after the parent-directory sync proves the
      // record deletion durable. Startup retries cleanup after later failures.
      await this.attachmentFiles.discardTaskFiles(taskId).catch(() => undefined);
      await this.cleanupPrunedServerJournals(prunedServerIds);
      await Promise.allSettled(
        artifactsToDelete.map((artifact) => unlinkIfExists(artifact.path))
      );
    }
    return clone({ removedManagedRepository });
  }

  private async createTaskRecord(
    input: CreateTaskStoreInput,
    source: DomainEvent['source'],
    fork?: { sourceTaskId: string; sourceRunId: string }
  ): Promise<Task> {
    await this.init();

    if (!fork) {
      const existing = this.resolveTaskCreationRetryFromState(input);
      if (existing) {
        return clone(existing);
      }
    }

    const now = new Date().toISOString();
    const sourceTask = fork
      ? this.state.tasks.find((candidate) => candidate.id === fork.sourceTaskId)
      : undefined;
    const sourceRun = fork
      ? this.state.runs.find(
          (candidate) =>
            candidate.id === fork.sourceRunId && candidate.taskId === fork.sourceTaskId
        )
      : undefined;
    if (fork && (!sourceTask || !sourceRun)) {
      throw new Error('Fork source task or run was not found.');
    }
    const creationMetadata = fork ? undefined : taskCreationMetadata(input);
    const runtimeId =
      input.runtimeId ?? input.agentSettings?.runtimeId ?? sourceTask?.runtimeId ?? CODEX_RUNTIME_ID;
    if (input.agentSettings?.runtimeId && input.agentSettings.runtimeId !== runtimeId) {
      throw new Error('Task runtime and execution settings runtime must match.');
    }
    const task: Task = {
      id: randomUUID(),
      kind: 'NORMAL',
      runtimeId,
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      repositoryId: input.repositoryId.trim(),
      creationToken: creationMetadata?.token,
      creationRequestFingerprint: creationMetadata?.fingerprint,
      workflowPhase: 'READY',
      resolution: 'NONE',
      completionPolicy: normalizeCreateTaskCompletionPolicy(input.completionPolicy),
      phaseVersion: 1,
      forkedAlternativeTaskIds: [],
      forkedFromTaskId: fork?.sourceTaskId,
      forkedFromRunId: fork?.sourceRunId,
      agentSettings: { ...input.agentSettings, runtimeId },
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };

    if (!task.title) {
      throw new Error('Task title is required.');
    }
    if (!task.prompt) {
      throw new Error('Task prompt is required.');
    }
    const repository = this.state.repositories.find(
      (candidate) => candidate.id === task.repositoryId
    );
    if (!repository) {
      throw new Error('Repository not found.');
    }
    if (repository.kind !== 'USER_REGISTERED') {
      throw new Error('Normal task creation requires a registered repository.');
    }
    if (repository.status !== 'AVAILABLE') {
      throw new Error('Repository is not available.');
    }

    if (fork && input.attachmentDraftId) {
      throw new Error('Forked alternatives inherit source attachments and cannot adopt a draft.');
    }

    const previousState = this.state;
    let preparedDraft: PreparedAttachmentDraft | undefined;
    let attachmentRecords: TaskAttachmentRecord[] = [];
    let publishedWithoutDirectorySync = false;
    try {
      if (fork) {
        attachmentRecords = await this.attachmentFiles.copyTaskAttachments(
          fork.sourceTaskId,
          task.id,
          this.state.attachments.filter((attachment) => attachment.taskId === fork.sourceTaskId)
        );
      } else if (input.attachmentDraftId) {
        preparedDraft = await this.attachmentFiles.prepareDraftForTask(
          input.attachmentDraftId,
          task.id
        );
        attachmentRecords = preparedDraft.records;
      }

      this.state = {
        ...this.state,
        tasks: [
          task,
          ...this.state.tasks.map((existing) =>
            fork && existing.id === fork.sourceTaskId
              ? {
                  ...existing,
                  forkedAlternativeTaskIds: uniqueIds([
                    ...existing.forkedAlternativeTaskIds,
                    task.id
                  ]),
                  updatedAt: now
                }
              : existing
          )
        ],
        attachments: [...attachmentRecords, ...this.state.attachments]
      };

      this.state = applyEventToState(
        this.state,
        createDomainEvent({
          type: 'TASK_CREATED',
          taskId: task.id,
          source,
          payload: {
            title: task.title,
            repositoryId: task.repositoryId,
            forkedFromTaskId: task.forkedFromTaskId,
            forkedFromRunId: task.forkedFromRunId,
            attachmentIds: attachmentRecords.map((attachment) => attachment.id)
          }
        })
      );

      if (fork) {
        this.state = applyEventToState(
          this.state,
          createDomainEvent({
            type: 'TASK_ALTERNATIVE_CREATED',
            taskId: fork.sourceTaskId,
            runId: fork.sourceRunId,
            source,
            payload: {
              alternativeTaskId: task.id,
              alternativeTitle: task.title
            }
          })
        );
      }

      publishedWithoutDirectorySync = !(await this.persistSnapshot());
    } catch (error) {
      this.state = previousState;
      if (preparedDraft) {
        try {
          await this.attachmentFiles.rollbackDraftForTask(preparedDraft);
        } catch (rollbackError) {
          throw new AttachmentAdoptionAmbiguousError(
            preparedDraft,
            error,
            rollbackError
          );
        }
      } else if (fork && attachmentRecords.length > 0) {
        await this.attachmentFiles.discardTaskFiles(task.id).catch(() => undefined);
      }
      throw error;
    }
    if (!publishedWithoutDirectorySync && preparedDraft) {
      await this.attachmentFiles.finalizeDraftForTask(preparedDraft).catch(
        () => undefined
      );
    }
    return clone(task);
  }

  private requireDesign(designId: string): Task {
    const design = this.state.tasks.find(
      (task) => task.id === designId && task.kind === 'DESIGN'
    );
    if (!design) throw new Error('Design not found.');
    return design;
  }

  private requireDesignTurn(designId: string, turnId: string): DesignTurn {
    const turn = this.state.designTurns.find(
      (candidate) => candidate.id === turnId && candidate.designId === designId
    );
    if (!turn) throw new Error('Design turn not found.');
    return turn;
  }

  private attachmentRecordsForDesignTurn(
    turn: DesignTurn
  ): TaskAttachmentRecord[] {
    return turn.referenceIds.map((referenceId) => {
      const reference = this.state.designReferences.find(
        (candidate) =>
          candidate.id === referenceId && candidate.designId === turn.designId
      );
      const attachment = reference
        ? this.state.attachments.find(
            (candidate) =>
              candidate.id === reference.attachmentId &&
              candidate.taskId === turn.designId
          )
        : undefined;
      if (!reference || !attachment) {
        throw new Error('Design turn reference attachment is unavailable.');
      }
      return attachment;
    });
  }

  private async assertInlineDesignTurnRetry(
    existing: DesignTurn,
    input: CreateInlineDesignTurnInput
  ): Promise<void> {
    const artifact = existing.messageArtifactId
      ? this.state.artifacts.find(
          (candidate) => candidate.id === existing.messageArtifactId
        )
      : undefined;
    const storedMessage = artifact
      ? await readPrivateArtifactFile(artifact.path, artifact.byteCount)
      : undefined;
    const adoptedReferenceIds = input.attachmentDraftId
      ? existing.referenceIds.filter((referenceId) =>
          this.state.designReferences.some(
            (reference) =>
              reference.id === referenceId &&
              reference.designId === input.designId &&
              reference.sourceDraftId === input.attachmentDraftId
          )
        )
      : [];
    const expectedReferenceIds = [...input.referenceIds, ...adoptedReferenceIds];
    if (
      existing.messageSource !== 'INLINE_MESSAGE' ||
      storedMessage !== input.message ||
      existing.attachmentDraftId !== input.attachmentDraftId ||
      existing.referenceIds.length !== expectedReferenceIds.length ||
      existing.referenceIds.some(
        (referenceId, index) => referenceId !== expectedReferenceIds[index]
      )
    ) {
      throw new Error('This Design message id was already used for different content.');
    }
  }

  private resolveDesignCreationRetryFromState(
    request: CreateBlankDesignRequest
  ): CreateDesignBundleResult | undefined {
    const metadata = designCreationMetadata(request);
    const existing = this.state.tasks.find(
      (task) => task.creationToken === metadata.token
    );
    if (!existing) return undefined;
    if (
      existing.kind !== 'DESIGN' ||
      existing.creationRequestFingerprint !== metadata.fingerprint
    ) {
      throw new TaskCreationRequestError(
        'TASK_CREATION_CONFLICT',
        'This creation retry token was already used for a different request.',
        409
      );
    }
    const repository = this.state.repositories.find(
      (candidate) => candidate.id === existing.repositoryId
    );
    const turn = this.state.designTurns.find(
      (candidate) =>
        candidate.designId === existing.id &&
        candidate.messageSource === 'TASK_PROMPT' &&
        candidate.order === 1
    );
    if (!repository || !turn) {
      throw new Error('Stored Design creation bundle is incomplete.');
    }
    return {
      task: existing,
      repository,
      turn,
      references: this.state.designReferences.filter(
        (reference) => reference.designId === existing.id
      )
    };
  }

  private assertDesignCheckpointOwnership(
    design: Task,
    turn: DesignTurn,
    checkpoint: DesignTurnCheckpoint
  ): void {
    if (checkpoint.boundary === 'QUEUED') return;
    if (checkpoint.boundary === 'RUN_LINKED') {
      const run = turn.runId
        ? this.state.runs.find(
            (candidate) =>
              candidate.id === turn.runId &&
              candidate.taskId === design.id &&
              candidate.mode === 'DESIGN' &&
              candidate.generationKey === turn.id
          )
        : undefined;
      if (!run) throw new Error('Design checkpoint Run ownership is inconsistent.');
      return;
    }
    if (checkpoint.boundary === 'POST_RUN_EVIDENCE_RECORDED') {
      const run = turn.runId
        ? this.state.runs.find((candidate) => candidate.id === turn.runId)
        : undefined;
      const snapshot = this.state.gitSnapshots.find(
        (candidate) =>
          candidate.id === checkpoint.gitSnapshotId &&
          candidate.taskId === design.id &&
          candidate.worktreeId === design.currentWorktreeId &&
          candidate.id === run?.afterGitSnapshotId
      );
      if (!snapshot) {
        throw new Error('Design checkpoint Git evidence ownership is inconsistent.');
      }
      return;
    }
    if (checkpoint.boundary === 'PREVIEW_CANDIDATE_READY') {
      const generation = this.state.previewGenerations.find(
        (candidate) =>
          candidate.id === checkpoint.previewGenerationId &&
          candidate.taskId === design.id &&
          candidate.state === 'READY' &&
          candidate.routingState === 'CANDIDATE' &&
          candidate.source.type === 'EXACT_COMMIT' &&
          candidate.source.repositoryId === design.repositoryId &&
          candidate.source.commitSha === checkpoint.commitSha &&
          candidate.source.designRevisionId === undefined
      );
      if (!generation) {
        throw new Error('Design checkpoint Preview ownership is inconsistent.');
      }
      return;
    }
    const source = checkpoint.source;
    const worktree = this.state.worktrees.find(
      (candidate) =>
        candidate.id === source.worktreeId &&
        candidate.id === design.currentWorktreeId &&
        candidate.taskId === design.id &&
        candidate.repositoryId === design.repositoryId &&
        candidate.branchName === source.branchName
    );
    if (
      source.repositoryId !== design.repositoryId ||
      !worktree ||
      !isGitObjectId(source.expectedParentCommit) ||
      !isGitObjectId(source.treeSha) ||
      ('candidateCommitSha' in source &&
        source.candidateCommitSha !== undefined &&
        !isGitObjectId(source.candidateCommitSha))
    ) {
      throw new Error('Design checkpoint source ownership is inconsistent.');
    }
  }

  private assertPreviewPlanReferences(plan: PreviewPlanRecord): void {
    const task = this.state.tasks.find((candidate) => candidate.id === plan.taskId);
    const iteration = this.state.iterations.find(
      (candidate) => candidate.id === plan.iterationId && candidate.taskId === plan.taskId
    );
    const worktree = this.state.worktrees.find(
      (candidate) =>
        candidate.id === plan.worktreeId &&
        candidate.taskId === plan.taskId &&
        candidate.iterationId === plan.iterationId
    );
    if (!task || !iteration || !worktree) {
      throw new Error('Preview plan references a missing or mismatched task context.');
    }
  }

  private assertPreviewApprovalReferences(approval: PreviewApprovalRecord): void {
    const plan = this.state.previewPlans.find(
      (candidate) =>
        candidate.id === approval.planId &&
        candidate.taskId === approval.taskId &&
        candidate.executionDigest === approval.executionDigest
    );
    if (!plan || !this.state.tasks.some((task) => task.id === approval.taskId)) {
      throw new Error('Preview approval references a missing or mismatched plan.');
    }
  }

  private assertPreviewGenerationReferences(generation: PreviewGenerationRecord): void {
    const existing = this.state.previewGenerations.find(
      (candidate) => candidate.id === generation.id
    );
    const authority = generation.executionAuthority;
    const executionDigest = authority.executionDigest;
    const plan = this.state.previewPlans.find(
      (candidate) =>
        candidate.id === generation.planId &&
        candidate.taskId === generation.taskId &&
        candidate.iterationId === generation.iterationId &&
        candidate.worktreeId === generation.worktreeId &&
        candidate.executionDigest === executionDigest
    );
    const task = this.state.tasks.find((candidate) => candidate.id === generation.taskId);
    const approval =
      authority.type === 'USER_APPROVAL'
        ? this.state.previewApprovals.find(
            (candidate) =>
              candidate.id === authority.approvalId &&
              candidate.taskId === generation.taskId &&
              candidate.executionDigest === executionDigest &&
              candidate.scope === 'TASK' &&
              (!candidate.invalidatedAt || Boolean(existing))
          )
        : undefined;
    const authorityValid =
      authority.type === 'USER_APPROVAL'
        ? Boolean(approval) && plan?.planSource.type === 'REPOSITORY_RECIPE'
        : authority.adapterVersion === 1 &&
          plan?.planSource.type === 'MANAGED_DESIGN_STATIC' &&
          task?.kind === 'DESIGN';
    const sourceValid = (() => {
      const source = generation.source;
      if (source.type === 'WORKTREE_SNAPSHOT') {
        const snapshot = this.state.gitSnapshots.find(
          (candidate) =>
            candidate.id === source.gitSnapshotId &&
            candidate.taskId === generation.taskId &&
            candidate.iterationId === generation.iterationId &&
            candidate.worktreeId === generation.worktreeId
        );
        return Boolean(
          snapshot &&
            snapshot.headSha === source.headSha &&
            snapshot.dirtyFingerprint === source.dirtyFingerprint &&
            plan?.planSource.type === 'REPOSITORY_RECIPE'
        );
      }
      const repository = this.state.repositories.find(
        (candidate) => candidate.id === source.repositoryId
      );
      const revision = source.designRevisionId
        ? this.state.designRevisions.find(
            (candidate) => candidate.id === source.designRevisionId
          )
        : undefined;
      return Boolean(
        task?.kind === 'DESIGN' &&
          repository?.id === task.repositoryId &&
          repository.kind === 'DESIGN_MANAGED' &&
          plan?.planSource.type === 'MANAGED_DESIGN_STATIC' &&
          (!source.designRevisionId ||
            (revision?.designId === task.id &&
              revision.commitSha === source.commitSha))
      );
    })();
    const authorityChanged =
      existing &&
      (existing.taskId !== generation.taskId ||
        existing.iterationId !== generation.iterationId ||
        existing.worktreeId !== generation.worktreeId ||
        existing.planId !== generation.planId ||
        !sameJsonValue(existing.executionAuthority, generation.executionAuthority) ||
        !sameJsonValue(existing.source, generation.source));
    if (
      !plan ||
      !authorityValid ||
      !sourceValid ||
      authorityChanged ||
      !task
    ) {
      throw new Error('Preview generation references missing or mismatched task authority.');
    }
  }

  private assertPreviewChildReferences(
    taskId: string,
    generationId: string,
    kind: 'attempt' | 'resource'
  ): void {
    const generation = this.state.previewGenerations.find(
      (candidate) => candidate.id === generationId && candidate.taskId === taskId
    );
    if (!generation || !this.state.tasks.some((task) => task.id === taskId)) {
      throw new Error(`Preview ${kind} references a missing or mismatched generation.`);
    }
  }

  private resolveTaskCreationRetryFromState(
    input: CreateTaskStoreInput
  ): Task | undefined {
    const metadata = taskCreationMetadata(input);
    if (!metadata) {
      return undefined;
    }
    const existing = this.state.tasks.find(
      (candidate) => candidate.creationToken === metadata.token
    );
    if (!existing) {
      return undefined;
    }
    if (
      existing.kind !== 'NORMAL' ||
      existing.creationRequestFingerprint !== metadata.fingerprint
    ) {
      throw new TaskCreationRequestError(
        'TASK_CREATION_CONFLICT',
        'This task creation retry token was already used for a different request.',
        409
      );
    }
    return existing;
  }

  async createAgentServer(input: CreateAgentServerInput): Promise<AgentServerInstance> {
    return this.serializeMutation(() => this.createAgentServerInternal(input));
  }

  private async createAgentServerInternal(
    input: CreateAgentServerInput
  ): Promise<AgentServerInstance> {
    await this.init();
    if (!isRuntimeId(input.runtimeId)) {
      throw new Error('Agent server runtime id is invalid.');
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const server: AgentServerInstance = {
      id,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      transport: input.transport,
      status: 'STARTING',
      executable: input.executable,
      argv: [...input.argv],
      runtimeVersion: input.runtimeVersion,
      schemaVersion: input.schemaVersion,
      schemaHash: input.schemaHash,
      runtimeResolution: clone(input.runtimeResolution),
      protocolJournalPath: this.protocolJournal.pathFor(id),
      startedAt: now
    };

    this.state = {
      ...this.state,
      agentServers: [server, ...this.state.agentServers]
    };
    await this.persistSnapshot();
    return clone(server);
  }

  async updateAgentServer(
    serverInstanceId: string,
    update: AgentServerUpdate
  ): Promise<AgentServerInstance> {
    return this.serializeMutation(() =>
      this.updateAgentServerInternal(serverInstanceId, update)
    );
  }

  private async updateAgentServerInternal(
    serverInstanceId: string,
    update: AgentServerUpdate
  ): Promise<AgentServerInstance> {
    await this.init();
    const existing = this.state.agentServers.find((server) => server.id === serverInstanceId);
    if (!existing) {
      throw new Error(`Agent server instance not found: ${serverInstanceId}`);
    }
    validateAgentServerTransition(existing.status, update.status);
    const stored = { ...existing, ...update };
    this.state = {
      ...this.state,
      agentServers: this.state.agentServers.map((server) =>
        server.id === serverInstanceId ? stored : server
      )
    };
    const prunedServerIds = this.pruneUnreferencedTerminalAgentServers();
    await this.persistSnapshot();
    await this.cleanupPrunedServerJournals(prunedServerIds);
    return clone(stored);
  }

  appendProtocolMessage(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    return this.withOwnedIo(() => {
      if (!this.state.agentServers.some((server) => server.id === serverInstanceId)) {
        throw new Error('Protocol journal server instance is not owned by this store.');
      }
      return this.protocolJournal.append(serverInstanceId, direction, raw, metadata);
    });
  }

  readProtocolMessage(reference: AgentProtocolMessageReference) {
    return this.withOwnedIo(() => {
      if (
        !Number.isInteger(reference.sequence) ||
        reference.sequence <= 0 ||
        !Number.isInteger(reference.byteOffset) ||
        reference.byteOffset < 0 ||
        !Number.isInteger(reference.byteLength) ||
        reference.byteLength <= 0 ||
        reference.byteLength > DEFAULT_AGENT_PROTOCOL_JOURNAL_LIMITS.maxEntryBytes ||
        (reference.segment !== undefined &&
          (!Number.isSafeInteger(reference.segment) || reference.segment < 0))
      ) {
        throw new Error('Protocol journal reference is invalid.');
      }
      if (!this.state.agentServers.some((server) => server.id === reference.serverInstanceId)) {
        throw new Error('Protocol journal server instance is not owned by this store.');
      }
      return this.protocolJournal.read(reference);
    });
  }

  async getLatestAgentGoalSnapshot(
    sessionId: string
  ): Promise<AgentGoalSnapshotRecord | undefined> {
    await this.init();
    return clone(
      this.state.agentGoalSnapshots
        .filter((record) => record.sessionId === sessionId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
    );
  }

  async recordAgentGoalSnapshot(
    record: Omit<AgentGoalSnapshotRecord, 'id' | 'observedAt'>
  ): Promise<AgentGoalSnapshotRecord> {
    return this.serializeMutation(() => this.recordAgentGoalSnapshotInternal(record));
  }

  private async recordAgentGoalSnapshotInternal(
    record: Omit<AgentGoalSnapshotRecord, 'id' | 'observedAt'>
  ): Promise<AgentGoalSnapshotRecord> {
    await this.init();
    assertRuntimeOwnedAgentRecord(this.state, record, 'Agent goal snapshot');
    const stored: AgentGoalSnapshotRecord = {
      ...record,
      id: randomUUID(),
      observedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentGoalSnapshots: [stored, ...this.state.agentGoalSnapshots]
    };
    await this.appendEvent(
      createDomainEvent({
        type:
          stored.source === 'PROVIDER_CLEARED'
            ? 'AGENT_GOAL_CLEARED'
            : stored.source === 'SYNC_ERROR'
              ? 'AGENT_GOAL_SYNC_FAILED'
              : 'AGENT_GOAL_UPDATED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        agentSessionId: stored.sessionId,
        source: 'provider',
        payload: {
          syncState: stored.syncState,
          providerStatus: stored.providerStatus,
          source: stored.source
        }
      }),
      false
    );
    await this.persistSnapshot();
    return clone(stored);
  }

  async recordAgentPlanRevision(
    record: Omit<AgentPlanRevisionRecord, 'id' | 'revision' | 'observedAt'>
  ): Promise<AgentPlanRevisionRecord> {
    return this.serializeMutation(() => this.recordAgentPlanRevisionInternal(record));
  }

  private async recordAgentPlanRevisionInternal(
    record: Omit<AgentPlanRevisionRecord, 'id' | 'revision' | 'observedAt'>
  ): Promise<AgentPlanRevisionRecord> {
    await this.init();
    assertRuntimeOwnedAgentRecord(this.state, record, 'Agent plan revision', true);
    const revision =
      this.state.agentPlanRevisions.filter((item) => item.runId === record.runId)
        .length + 1;
    const stored: AgentPlanRevisionRecord = {
      ...record,
      id: randomUUID(),
      revision,
      observedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentPlanRevisions: [stored, ...this.state.agentPlanRevisions]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_PLAN_REVISED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: stored.runId,
        agentSessionId: stored.sessionId,
        source: 'provider',
        payload: { revision: stored.revision, stepCount: stored.steps.length }
      }),
      false
    );
    await this.persistSnapshot();
    return clone(stored);
  }

  async recordAgentUsageSnapshot(
    record: Omit<AgentUsageSnapshotRecord, 'id' | 'observedAt'>
  ): Promise<AgentUsageSnapshotRecord> {
    return this.serializeMutation(() => this.recordAgentUsageSnapshotInternal(record));
  }

  private async recordAgentUsageSnapshotInternal(
    record: Omit<AgentUsageSnapshotRecord, 'id' | 'observedAt'>
  ): Promise<AgentUsageSnapshotRecord> {
    await this.init();
    assertRuntimeOwnedAgentRecord(this.state, record, 'Agent usage snapshot');
    const stored: AgentUsageSnapshotRecord = {
      ...record,
      id: randomUUID(),
      observedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentUsageSnapshots: [stored, ...this.state.agentUsageSnapshots]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_USAGE_UPDATED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: stored.runId,
        agentSessionId: stored.sessionId,
        source: 'provider',
        payload: {
          totalTokens: stored.total.totalTokens,
          modelContextWindow: stored.modelContextWindow
        }
      }),
      false
    );
    await this.persistSnapshot();
    return clone(stored);
  }

  async recordAgentSettingsObservation(
    record: Omit<AgentSettingsObservationRecord, 'id' | 'observedAt'>
  ): Promise<AgentSettingsObservationRecord> {
    return this.serializeMutation(() =>
      this.recordAgentSettingsObservationInternal(record)
    );
  }

  private async recordAgentSettingsObservationInternal(
    record: Omit<AgentSettingsObservationRecord, 'id' | 'observedAt'>
  ): Promise<AgentSettingsObservationRecord> {
    await this.init();
    const normalizedRecord = {
      ...record,
      settings: { ...record.settings, runtimeId: record.runtimeId }
    };
    assertRuntimeOwnedAgentRecord(
      this.state,
      normalizedRecord,
      'Agent settings observation'
    );
    const stored: AgentSettingsObservationRecord = {
      ...normalizedRecord,
      id: randomUUID(),
      observedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentSettingsObservations: [
        stored,
        ...this.state.agentSettingsObservations
      ]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_SETTINGS_OBSERVED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: stored.runId,
        agentSessionId: stored.sessionId,
        source: 'provider',
        payload: { source: stored.source, settings: stored.settings }
      }),
      false
    );
    await this.persistSnapshot();
    return clone(stored);
  }

  async createAgentSession(input: CreateAgentSessionInput): Promise<AgentSessionRecord> {
    return this.serializeMutation(() => this.createAgentSessionInternal(input));
  }

  private async createAgentSessionInternal(
    input: CreateAgentSessionInput
  ): Promise<AgentSessionRecord> {
    await this.init();
    if (input.iteration.taskId !== input.task.id || input.worktree.taskId !== input.task.id) {
      throw new Error('Agent session task, iteration, and worktree must have the same owner.');
    }
    if (input.worktree.iterationId !== input.iteration.id) {
      throw new Error('Agent session worktree must belong to the selected iteration.');
    }
    const role = input.role ?? 'PRIMARY';
    if (role !== 'REVIEW' && input.runtimeId !== input.task.runtimeId) {
      throw new Error('Primary task work must use the task runtime.');
    }
    const existing =
      role === 'PRIMARY'
        ? this.state.agentSessions.find(
            (session) =>
              session.taskId === input.task.id &&
              session.iterationId === input.iteration.id &&
              session.role === 'PRIMARY'
          )
        : undefined;
    if (existing) {
      if (existing.runtimeId !== input.runtimeId) {
        throw new Error('Existing primary session runtime does not match its task.');
      }
      return clone(existing);
    }

    const now = new Date().toISOString();
    const session: AgentSessionRecord = {
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      runtimeId: input.runtimeId,
      role,
      parentSessionId: input.parentSessionId,
      forkedFromSessionId: input.forkedFromSessionId,
      relationshipState:
        role === 'SUBAGENT'
          ? input.parentSessionId
            ? 'RESOLVED'
            : 'UNRESOLVED'
          : input.parentSessionId || input.forkedFromSessionId
            ? 'RESOLVED'
            : 'ROOT',
      worktreePath: input.worktree.worktreePath,
      status: 'NOT_MATERIALIZED',
      materialized: false,
      requestedSettings: { ...input.requestedSettings, runtimeId: input.runtimeId },
      ownership: 'TASK_MONKI',
      createdAt: now,
      updatedAt: now
    };

    this.state = {
      ...this.state,
      agentSessions: [session, ...this.state.agentSessions],
      tasks: this.state.tasks.map((task) =>
        task.id === input.task.id && role === 'PRIMARY'
          ? { ...task, currentAgentSessionId: session.id, updatedAt: now }
          : task
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_SESSION_CREATED',
        taskId: input.task.id,
        iterationId: input.iteration.id,
        worktreeId: input.worktree.id,
        agentSessionId: session.id,
        source: 'provider',
        payload: {
          runtimeId: session.runtimeId,
          role: session.role,
          worktreePath: session.worktreePath
        }
      }),
      false
    );
    await this.persistSnapshot();
    return clone(session);
  }

  async updateAgentSession(
    sessionId: string,
    update: AgentSessionUpdate
  ): Promise<AgentSessionRecord> {
    return this.serializeMutation(() =>
      this.updateAgentSessionInternal(sessionId, update)
    );
  }

  private async updateAgentSessionInternal(
    sessionId: string,
    update: AgentSessionUpdate
  ): Promise<AgentSessionRecord> {
    await this.init();
    const existing = this.state.agentSessions.find((session) => session.id === sessionId);
    if (!existing) {
      throw new Error(`Agent session not found: ${sessionId}`);
    }
    const stored: AgentSessionRecord = {
      ...existing,
      ...update,
      requestedSettings: update.requestedSettings
        ? { ...update.requestedSettings, runtimeId: existing.runtimeId }
        : existing.requestedSettings,
      observedSettings: update.observedSettings
        ? { ...update.observedSettings, runtimeId: existing.runtimeId }
        : update.observedSettings === undefined && 'observedSettings' in update
          ? undefined
          : existing.observedSettings,
      updatedAt: new Date().toISOString()
    };
    if (
      stored.providerSessionId &&
      this.state.agentSessions.some(
        (session) =>
          session.id !== stored.id &&
          session.runtimeId === stored.runtimeId &&
          session.providerSessionId === stored.providerSessionId
      )
    ) {
      throw new Error(
        `Provider session ${stored.providerSessionId} is already owned by another ${stored.runtimeId} session.`
      );
    }
    this.state = {
      ...this.state,
      agentSessions: this.state.agentSessions.map((session) =>
        session.id === sessionId ? stored : session
      )
    };
    await this.persistSnapshot();
    return clone(stored);
  }

  async observeSubagent(
    input: ObserveSubagentInput
  ): Promise<{
    session: AgentSessionRecord;
    observation: AgentSubagentObservationRecord;
  }> {
    return this.serializeMutation(() => this.observeSubagentInternal(input));
  }

  private async observeSubagentInternal(
    input: ObserveSubagentInput
  ): Promise<{
    session: AgentSessionRecord;
    observation: AgentSubagentObservationRecord;
  }> {
    await this.init();
    const parent = this.state.agentSessions.find(
      (session) => session.id === input.parentSessionId
    );
    if (!parent) {
      throw new Error(`Parent agent session not found: ${input.parentSessionId}`);
    }
    assertProtocolReferenceRuntime(
      this.state,
      parent.runtimeId,
      input.rawMessage,
      'Subagent observation'
    );
    if (input.parentRunId) {
      const parentRun = this.state.runs.find((run) => run.id === input.parentRunId);
      if (
        !parentRun ||
        parentRun.sessionId !== parent.id ||
        parentRun.runtimeId !== parent.runtimeId
      ) {
        throw new Error('Subagent observation parent run ownership is inconsistent.');
      }
    }

    const existing = this.state.agentSessions.find(
      (session) =>
        session.runtimeId === parent.runtimeId &&
        session.providerSessionId === input.providerChildSessionId
    );
    if (existing && existing.taskId !== parent.taskId) {
      throw new Error(
        `Provider child thread ${input.providerChildSessionId} is already owned by another task.`
      );
    }

    const relationshipProblems = [
      input.providerChildSessionId === parent.providerSessionId
        ? 'Provider reported a thread as its own child.'
        : undefined,
      input.providerParentSessionId &&
      parent.providerSessionId &&
      input.providerParentSessionId !== parent.providerSessionId
        ? `Supplied parent thread ${input.providerParentSessionId} does not match local parent ${parent.providerSessionId}.`
        : undefined,
      existing?.parentSessionId && existing.parentSessionId !== parent.id
        ? `Child was already linked to local parent ${existing.parentSessionId}.`
        : undefined,
      existing?.parentRunId &&
      input.parentRunId &&
      existing.parentRunId !== input.parentRunId
        ? `Child was already linked to parent run ${existing.parentRunId}.`
        : undefined
    ].filter((problem): problem is string => Boolean(problem));
    const relationshipState =
      relationshipProblems.length > 0 ? 'CONTRADICTORY' : 'RESOLVED';
    const now = new Date().toISOString();
    const requestedSettings = {
      ...parent.requestedSettings,
      ...(existing?.requestedSettings ?? {}),
      ...(input.requestedSettings ?? {}),
      runtimeId: parent.runtimeId
    };
    const stored: AgentSessionRecord = existing
      ? {
          ...existing,
          role: 'SUBAGENT',
          providerSessionTreeId:
            input.providerSessionTreeId ?? existing.providerSessionTreeId,
          parentSessionId:
            relationshipState === 'RESOLVED'
              ? existing.parentSessionId ?? parent.id
              : existing.parentSessionId,
          providerParentSessionId:
            input.providerParentSessionId ?? existing.providerParentSessionId,
          providerForkedFromSessionId:
            input.providerForkedFromSessionId ??
            existing.providerForkedFromSessionId,
          parentRunId:
            relationshipState === 'RESOLVED'
              ? existing.parentRunId ?? input.parentRunId
              : existing.parentRunId,
          relationshipState,
          relationshipDetail:
            relationshipProblems.join(' ') || existing.relationshipDetail,
          providerNickname: input.providerNickname ?? existing.providerNickname,
          providerRole: input.providerRole ?? existing.providerRole,
          delegatedPrompt:
            existing.delegatedPrompt ?? input.delegatedPrompt,
          agentPath: input.agentPath ?? existing.agentPath,
          subagentStatus: input.status ?? existing.subagentStatus,
          status:
            input.status === 'RUNNING'
              ? 'ACTIVE'
              : input.status === 'ERRORED'
                ? 'SYSTEM_ERROR'
                : existing.status,
          materialized: input.materialized ?? existing.materialized,
          requestedSettings,
          updatedAt: now
        }
      : {
          id: randomUUID(),
          taskId: parent.taskId,
          iterationId: parent.iterationId,
          worktreeId: parent.worktreeId,
          runtimeId: parent.runtimeId,
          role: 'SUBAGENT',
          providerSessionId: input.providerChildSessionId,
          providerSessionTreeId: input.providerSessionTreeId,
          parentSessionId: relationshipState === 'RESOLVED' ? parent.id : undefined,
          providerParentSessionId: input.providerParentSessionId,
          providerForkedFromSessionId: input.providerForkedFromSessionId,
          parentRunId:
            relationshipState === 'RESOLVED' ? input.parentRunId : undefined,
          relationshipState,
          relationshipDetail: relationshipProblems.join(' ') || undefined,
          providerNickname: input.providerNickname,
          providerRole: input.providerRole,
          delegatedPrompt: input.delegatedPrompt,
          agentPath: input.agentPath,
          subagentStatus: input.status,
          worktreePath: parent.worktreePath,
          status:
            input.status === 'RUNNING'
              ? 'ACTIVE'
              : input.status === 'ERRORED'
                ? 'SYSTEM_ERROR'
                : 'UNKNOWN',
          materialized: input.materialized ?? false,
          requestedSettings,
          ownership: 'TASK_MONKI',
          createdAt: now,
          updatedAt: now
        };

    const observation: AgentSubagentObservationRecord = {
      id: randomUUID(),
      runtimeId: parent.runtimeId,
      taskId: stored.taskId,
      iterationId: stored.iterationId,
      sessionId: stored.id,
      parentSessionId: parent.id,
      parentRunId: input.parentRunId,
      providerChildSessionId: input.providerChildSessionId,
      providerParentSessionId: input.providerParentSessionId,
      providerForkedFromSessionId: input.providerForkedFromSessionId,
      source: input.source,
      relationshipState,
      status: input.status,
      delegatedPrompt: input.delegatedPrompt,
      requestedSettings: input.requestedSettings,
      providerNickname: input.providerNickname,
      providerRole: input.providerRole,
      agentPath: input.agentPath,
      detail: relationshipProblems.join(' ') || undefined,
      rawMessage: input.rawMessage,
      observedAt: now
    };

    this.state = {
      ...this.state,
      agentSessions: existing
        ? this.state.agentSessions.map((session) =>
            session.id === existing.id ? stored : session
          )
        : [stored, ...this.state.agentSessions],
      agentSubagentObservations: [
        observation,
        ...this.state.agentSubagentObservations
      ]
    };
    await this.appendEvent(
      createDomainEvent({
        type:
          relationshipState === 'CONTRADICTORY'
            ? 'AGENT_SUBAGENT_RELATIONSHIP_UNRESOLVED'
            : existing
              ? 'AGENT_SUBAGENT_UPDATED'
              : 'AGENT_SUBAGENT_DISCOVERED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: input.parentRunId,
        worktreeId: stored.worktreeId,
        agentSessionId: stored.id,
        source: 'provider',
        payload: {
          parentSessionId: parent.id,
          providerChildSessionId: input.providerChildSessionId,
          providerParentSessionId: input.providerParentSessionId,
          source: input.source,
          relationshipState,
          status: input.status,
          detail: observation.detail
        }
      }),
      false
    );
    await this.persistSnapshot();
    return { session: clone(stored), observation: clone(observation) };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    return this.serializeMutation(() => this.createRunInternal(input));
  }

  private async createRunInternal(input: CreateRunInput): Promise<RunRecord> {
    await this.init();

    const persistedTask = this.state.tasks.find(
      (task) => task.id === input.task.id
    );
    if (!persistedTask) throw new Error('Run task does not exist.');
    if (
      (persistedTask.kind === 'DESIGN') !== (input.mode === 'DESIGN')
    ) {
      throw new Error('DESIGN runs and Design tasks must use each other exclusively.');
    }
    if (input.mode === 'DESIGN') {
      const turn = input.generationKey
        ? this.state.designTurns.find(
            (candidate) =>
              candidate.id === input.generationKey &&
              candidate.designId === persistedTask.id &&
              candidate.outcome === undefined
          )
        : undefined;
      if (!turn) {
        throw new Error('DESIGN run requires an unsettled DesignTurn generation key.');
      }
      if (
        this.state.runs.some(
          (run) =>
            run.taskId === persistedTask.id &&
            run.mode === 'DESIGN' &&
            run.generationKey === input.generationKey
        )
      ) {
        throw new Error('A DESIGN Run already exists for this DesignTurn generation key.');
      }
    }
    const persistedSession = this.state.agentSessions.find(
      (session) => session.id === input.session.id
    );
    if (
      !persistedSession ||
      persistedSession.taskId !== input.session.taskId ||
      persistedSession.iterationId !== input.session.iterationId ||
      persistedSession.worktreeId !== input.session.worktreeId ||
      persistedSession.runtimeId !== input.session.runtimeId ||
      persistedSession.role !== input.session.role
    ) {
      throw new Error('Run session does not match its durable ownership record.');
    }
    if (input.session.taskId !== input.task.id) {
      throw new Error('Run session must belong to the task.');
    }
    if (
      input.session.runtimeId !== input.task.runtimeId &&
      !(input.mode === 'REVIEW' && input.session.role === 'REVIEW')
    ) {
      throw new Error('Only detached review runs may use a runtime other than the task runtime.');
    }
    if (input.serverInstanceId) {
      assertServerRuntime(
        this.state,
        input.session.runtimeId,
        input.serverInstanceId,
        'Run'
      );
    }

    const now = new Date().toISOString();
    const runId = randomUUID();
    const promptArtifact = await this.createArtifactRecord(input.task.id, 'agent-prompt', { runId });
    const outputArtifact = await this.createArtifactRecord(input.task.id, 'agent-output', { runId });
    const diagnosticArtifact = await this.createArtifactRecord(input.task.id, 'agent-diagnostics', {
      runId
    });
    await writeNewArtifactFiles(this.artifactsDir, [
      { artifact: promptArtifact, content: input.prompt },
      { artifact: outputArtifact, content: '' },
      { artifact: diagnosticArtifact, content: '' }
    ]);

    const run: RunRecord = {
      id: runId,
      runtimeId: input.session.runtimeId,
      taskId: input.task.id,
      iterationId: input.session.iterationId,
      worktreeId: input.session.worktreeId,
      sessionId: input.session.id,
      serverInstanceId: input.serverInstanceId,
      mode: input.mode,
      origin: 'TASK_MONKI',
      generationKey: input.generationKey,
      retryOfRunId: input.retryOfRunId,
      continuedFromRunId: input.continuedFromRunId,
      status: 'QUEUED',
      recoveryState: 'NONE',
      requestedSettings: {
        ...(input.requestedSettings ?? input.session.requestedSettings),
        runtimeId: input.session.runtimeId
      },
      promptArtifactId: promptArtifact.id,
      outputArtifactId: outputArtifact.id,
      diagnosticArtifactId: diagnosticArtifact.id,
      beforeGitSnapshotId: input.beforeGitSnapshotId,
      startedAt: now,
      eventCount: 0
    };
    const bindsCurrentTask = input.mode !== 'REVIEW';
    const advancesWorkflow = bindsCurrentTask && input.mode !== 'DESIGN';
    const reviewedSnapshot = input.beforeGitSnapshotId
      ? this.state.gitSnapshots.find((snapshot) => snapshot.id === input.beforeGitSnapshotId)
      : undefined;

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((existing) =>
        existing.id === input.task.id
          ? {
              ...existing,
              workflowPhase: advancesWorkflow ? 'IN_PROGRESS' : existing.workflowPhase,
              currentRunId: bindsCurrentTask ? run.id : existing.currentRunId,
              currentAgentSessionId: bindsCurrentTask
                ? input.session.id
                : existing.currentAgentSessionId,
              currentIterationId: bindsCurrentTask
                ? input.session.iterationId
                : existing.currentIterationId,
              currentWorktreeId: bindsCurrentTask
                ? input.session.worktreeId
                : existing.currentWorktreeId,
              phaseVersion: advancesWorkflow ? existing.phaseVersion + 1 : existing.phaseVersion,
              updatedAt: now
            }
          : existing
      ),
      runs: [run, ...this.state.runs],
      artifacts: [
        promptArtifact,
        outputArtifact,
        diagnosticArtifact,
        ...this.state.artifacts
      ]
    };

    if (advancesWorkflow) {
      await this.appendEvent(
        createDomainEvent({
          type: 'TRANSITION_REQUESTED',
          taskId: input.task.id,
          iterationId: input.session.iterationId,
          runId: run.id,
          worktreeId: input.session.worktreeId,
          agentSessionId: input.session.id,
          serverInstanceId: input.serverInstanceId,
          source: 'ui',
          payload: { fromPhase: persistedTask.workflowPhase, toPhase: 'IN_PROGRESS' }
        }),
        false
      );
    }

    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_STARTED',
        taskId: input.task.id,
        iterationId: input.session.iterationId,
        runId: run.id,
        worktreeId: input.session.worktreeId,
        agentSessionId: input.session.id,
        serverInstanceId: input.serverInstanceId,
        source: 'provider',
        payload: {
          mode: run.mode,
          generationKey: run.generationKey,
          requestedSettings: run.requestedSettings,
          beforeGitSnapshotId: run.beforeGitSnapshotId,
          reviewedHeadSha: reviewedSnapshot?.headSha,
          reviewedDirtyFingerprint: reviewedSnapshot?.dirtyFingerprint
        }
      }),
      false
    );

    try {
      await this.persistSnapshot();
    } catch (error) {
      await this.cleanupUnpublishedArtifacts([
        promptArtifact,
        outputArtifact,
        diagnosticArtifact
      ]);
      throw error;
    }
    return clone(run);
  }

  async createObservedSubagentRun(
    input: CreateObservedSubagentRunInput
  ): Promise<RunRecord> {
    return this.serializeMutation(() => this.createObservedSubagentRunInternal(input));
  }

  private async createObservedSubagentRunInternal(
    input: CreateObservedSubagentRunInput
  ): Promise<RunRecord> {
    await this.init();
    const existing = this.state.runs.find(
      (run) =>
        run.runtimeId === input.session.runtimeId &&
        run.providerTurnId === input.providerTurnId
    );
    if (existing) {
      if (existing.sessionId !== input.session.id) {
        throw new Error(
          `Provider turn ${input.providerTurnId} is already owned by another ${input.session.runtimeId} session.`
        );
      }
      return clone(existing);
    }
    if (input.session.role !== 'SUBAGENT') {
      throw new Error('Only observed subagent sessions may create observed child runs.');
    }
    const persistedSession = this.state.agentSessions.find(
      (session) => session.id === input.session.id
    );
    if (
      !persistedSession ||
      persistedSession.runtimeId !== input.session.runtimeId ||
      persistedSession.taskId !== input.session.taskId
    ) {
      throw new Error('Observed subagent run session ownership is inconsistent.');
    }
    assertServerRuntime(
      this.state,
      input.session.runtimeId,
      input.serverInstanceId,
      'Observed subagent run'
    );

    const now = new Date().toISOString();
    const runId = randomUUID();
    const prompt =
      input.prompt ??
      input.session.delegatedPrompt ??
      'Provider-observed subagent turn.';
    const promptArtifact = await this.createArtifactRecord(
      input.session.taskId,
      'agent-prompt',
      { runId }
    );
    const outputArtifact = await this.createArtifactRecord(
      input.session.taskId,
      'agent-output',
      { runId }
    );
    const diagnosticArtifact = await this.createArtifactRecord(
      input.session.taskId,
      'agent-diagnostics',
      { runId }
    );
    await writeNewArtifactFiles(this.artifactsDir, [
      { artifact: promptArtifact, content: prompt },
      { artifact: outputArtifact, content: '' },
      { artifact: diagnosticArtifact, content: '' }
    ]);

    const run: RunRecord = {
      id: runId,
      runtimeId: input.session.runtimeId,
      taskId: input.session.taskId,
      iterationId: input.session.iterationId,
      worktreeId: input.session.worktreeId,
      sessionId: input.session.id,
      serverInstanceId: input.serverInstanceId,
      providerTurnId: input.providerTurnId,
      mode: 'SUBAGENT',
      origin: 'PROVIDER_SUBAGENT',
      parentRunId: input.parentRunId ?? input.session.parentRunId,
      status: 'RUNNING',
      recoveryState: 'NONE',
      requestedSettings:
        {
          ...(input.requestedSettings ?? input.session.requestedSettings),
          runtimeId: input.session.runtimeId
        },
      promptArtifactId: promptArtifact.id,
      outputArtifactId: outputArtifact.id,
      diagnosticArtifactId: diagnosticArtifact.id,
      startedAt: now,
      lastEventAt: now,
      eventCount: 0
    };
    this.state = {
      ...this.state,
      runs: [run, ...this.state.runs],
      artifacts: [
        promptArtifact,
        outputArtifact,
        diagnosticArtifact,
        ...this.state.artifacts
      ]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_STARTED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'provider',
        payload: {
          mode: run.mode,
          origin: run.origin,
          parentRunId: run.parentRunId,
          providerTurnId: run.providerTurnId,
          observedSubagent: true,
          requestedSettings: run.requestedSettings
        }
      }),
      false
    );
    try {
      await this.persistSnapshot();
    } catch (error) {
      await this.cleanupUnpublishedArtifacts([
        promptArtifact,
        outputArtifact,
        diagnosticArtifact
      ]);
      throw error;
    }
    return clone(run);
  }

  async upsertAgentItem(
    item: Omit<AgentItemRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ): Promise<AgentItemRecord> {
    return this.serializeMutation(() => this.upsertAgentItemInternal(item));
  }

  private async upsertAgentItemInternal(
    item: Omit<AgentItemRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ): Promise<AgentItemRecord> {
    await this.init();
    const run = this.state.runs.find((candidate) => candidate.id === item.runId);
    if (
      !run ||
      run.taskId !== item.taskId ||
      run.iterationId !== item.iterationId ||
      run.sessionId !== item.sessionId
    ) {
      throw new Error('Agent item ownership does not match its run.');
    }
    if (item.rawMessage) {
      assertProtocolReferenceRuntime(
        this.state,
        run.runtimeId,
        item.rawMessage,
        'Agent item'
      );
    }
    if (item.outputArtifactId) {
      const outputArtifact = this.state.artifacts.find(
        (artifact) => artifact.id === item.outputArtifactId
      );
      if (
        !outputArtifact ||
        outputArtifact.taskId !== item.taskId ||
        outputArtifact.runId !== item.runId
      ) {
        throw new Error('Agent item output artifact ownership does not match its run.');
      }
    }

    const existing = this.state.agentItems.find(
      (candidate) =>
        candidate.runId === item.runId &&
        candidate.providerItemId === item.providerItemId
    );
    if (existing) {
      validateAgentItemTransition(existing.status, item.status);
    }
    const now = new Date().toISOString();
    const stored: AgentItemRecord = existing
      ? {
          ...existing,
          ...item,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: now
        }
      : {
          ...item,
          id: item.id ?? randomUUID(),
          createdAt: now,
          updatedAt: now
        };

    this.state = {
      ...this.state,
      agentItems: existing
        ? this.state.agentItems.map((candidate) =>
            candidate.id === existing.id ? stored : candidate
          )
        : [stored, ...this.state.agentItems]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'AGENT_ITEM_UPDATED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        runId: stored.runId,
        worktreeId: run.worktreeId,
        agentSessionId: stored.sessionId,
        agentItemId: stored.id,
        source: 'provider',
        payload: {
          providerItemId: stored.providerItemId,
          type: stored.type,
          status: stored.status
        }
      }),
      false
    );
    await this.persistSnapshot();
    return clone(stored);
  }

  /**
   * Publishes the actionable interaction, matching run projection/event, and
   * exact owning session awaiting state as one durable store boundary.
   */
  async createInteractionRequest(
    input: CreateInteractionRequestInput
  ): Promise<InteractionRequestRecord> {
    return this.serializeMutation(() => this.createInteractionRequestInternal(input));
  }

  private async createInteractionRequestInternal(
    input: CreateInteractionRequestInput
  ): Promise<InteractionRequestRecord> {
    await this.init();
    const run = this.state.runs.find((candidate) => candidate.id === input.runId);
    const session = this.state.agentSessions.find(
      (candidate) => candidate.id === input.sessionId
    );
    if (
      !run ||
      !session ||
      run.taskId !== input.taskId ||
      run.iterationId !== input.iterationId ||
      run.sessionId !== input.sessionId ||
      run.serverInstanceId !== input.serverInstanceId ||
      run.runtimeId !== input.runtimeId ||
      session.taskId !== input.taskId ||
      session.iterationId !== input.iterationId ||
      session.worktreeId !== run.worktreeId ||
      session.runtimeId !== input.runtimeId
    ) {
      throw new Error('Interaction request ownership does not match its run.');
    }
    assertServerRuntime(
      this.state,
      input.runtimeId,
      input.serverInstanceId,
      'Interaction request'
    );
    assertProtocolReferenceRuntime(
      this.state,
      input.runtimeId,
      input.requestRawMessage,
      'Interaction request'
    );
    if (
      input.requestRawMessage.serverInstanceId !== input.serverInstanceId ||
      input.requestRawMessage.direction !== 'INBOUND'
    ) {
      throw new Error('Interaction request raw message does not match its server.');
    }
    const priorOccurrences = this.state.interactionRequests.filter(
      (request) =>
        request.serverInstanceId === input.serverInstanceId &&
        request.providerRequestId === input.providerRequestId
    );
    const sameOccurrence = priorOccurrences.find(
      (request) => request.requestRawMessage.sequence === input.requestRawMessage.sequence
    );
    if (sameOccurrence) {
      if (!sameInteractionOccurrenceInput(sameOccurrence, input)) {
        throw new Error(
          'Duplicate interaction request does not match its original immutable fields.'
        );
      }
      return clone(sameOccurrence);
    }
    if (
      priorOccurrences.some(
        (request) => request.status === 'PENDING' || request.status === 'RESPONDING'
      )
    ) {
      throw new Error(
        'Provider reused an interaction request id while its previous occurrence is still active.'
      );
    }

    const stored: InteractionRequestRecord = {
      ...input,
      id: randomUUID(),
      status: 'PENDING',
      requestedAt: new Date().toISOString()
    };
    const requestedEvent = createDomainEvent({
      type: 'AGENT_INTERACTION_REQUESTED',
      taskId: stored.taskId,
      iterationId: stored.iterationId,
      runId: stored.runId,
      worktreeId: run.worktreeId,
      agentSessionId: stored.sessionId,
      serverInstanceId: stored.serverInstanceId,
      interactionRequestId: stored.id,
      source: 'provider',
      payload: { type: stored.type, providerRequestId: stored.providerRequestId }
    });
    let nextState = applyEventToState(
      {
        ...this.state,
        interactionRequests: [stored, ...this.state.interactionRequests]
      },
      requestedEvent
    );
    const awaitingStatus =
      stored.type === 'USER_INPUT' ? 'AWAITING_USER_INPUT' : 'AWAITING_APPROVAL';
    const updatedSession: AgentSessionRecord = {
      ...session,
      status: awaitingStatus,
      updatedAt: stored.requestedAt
    };
    nextState = {
      ...nextState,
      agentSessions: nextState.agentSessions.map((candidate) =>
        candidate.id === updatedSession.id ? updatedSession : candidate
      )
    };
    this.state = nextState;
    await this.persistSnapshot();
    return clone(stored);
  }

  async transitionInteractionRequest(
    interactionRequestId: string,
    expectedStatus: InteractionRequestStatus,
    update: InteractionRequestUpdate
  ): Promise<InteractionRequestRecord> {
    return this.serializeMutation(() =>
      this.transitionInteractionRequestInternal(
        interactionRequestId,
        expectedStatus,
        update
      )
    );
  }

  private async transitionInteractionRequestInternal(
    interactionRequestId: string,
    expectedStatus: InteractionRequestStatus,
    update: InteractionRequestUpdate
  ): Promise<InteractionRequestRecord> {
    await this.init();
    const existing = this.state.interactionRequests.find(
      (request) => request.id === interactionRequestId
    );
    if (!existing) {
      throw new Error(`Interaction request not found: ${interactionRequestId}`);
    }
    if (existing.status !== expectedStatus) {
      throw new Error(
        `Interaction request ${interactionRequestId} is ${existing.status}; expected ${expectedStatus}.`
      );
    }
    const nextStatus = update.status ?? existing.status;
    validateInteractionTransition(existing.status, nextStatus);
    if (update.responseRawMessage) {
      assertProtocolReferenceRuntime(
        this.state,
        existing.runtimeId,
        update.responseRawMessage,
        'Interaction response'
      );
      if (
        update.responseRawMessage.serverInstanceId !==
        existing.serverInstanceId
      ) {
        throw new Error('Interaction response raw message does not match its server.');
      }
    }
    const stored: InteractionRequestRecord = { ...existing, ...update, status: nextStatus };
    this.state = {
      ...this.state,
      interactionRequests: this.state.interactionRequests.map((request) =>
        request.id === interactionRequestId ? stored : request
      )
    };

    if (isInteractionTerminal(nextStatus)) {
      const run = this.state.runs.find((candidate) => candidate.id === stored.runId);
      await this.appendEvent(
        createDomainEvent({
          type: 'AGENT_INTERACTION_RESOLVED',
          taskId: stored.taskId,
          iterationId: stored.iterationId,
          runId: stored.runId,
          worktreeId: run?.worktreeId,
          agentSessionId: stored.sessionId,
          serverInstanceId: stored.serverInstanceId,
          interactionRequestId: stored.id,
          source: 'provider',
          payload: { type: stored.type, status: stored.status }
        }),
        false
      );
    }

    await this.persistSnapshot();
    return clone(stored);
  }

  async createIterationAndWorktree(input: {
    task: Task;
    branchName: string;
    worktreePath: string;
    baseRef?: string;
    baseSha: string;
  }): Promise<{ iteration: TaskIteration; worktree: WorktreeRecord }> {
    return this.serializeMutation(() =>
      this.createIterationAndWorktreeInternal(input)
    );
  }

  private async createIterationAndWorktreeInternal(input: {
    task: Task;
    branchName: string;
    worktreePath: string;
    baseRef?: string;
    baseSha: string;
  }): Promise<{ iteration: TaskIteration; worktree: WorktreeRecord }> {
    await this.init();

    const now = new Date().toISOString();
    const iteration: TaskIteration = {
      id: randomUUID(),
      taskId: input.task.id,
      actionRequestId: randomUUID(),
      generationKey: randomUUID(),
      status: 'ACTIVE',
      branchName: input.branchName,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      createdAt: now,
      updatedAt: now
    };
    const worktree: WorktreeRecord = {
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: iteration.id,
      repositoryId: input.task.repositoryId,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      status: 'CREATING',
      createdAt: now,
      updatedAt: now
    };
    const storedIteration = { ...iteration, worktreeId: worktree.id };

    this.state = {
      ...this.state,
      iterations: [storedIteration, ...this.state.iterations],
      worktrees: [worktree, ...this.state.worktrees],
      tasks: this.state.tasks.map((existing) =>
        existing.id === input.task.id
          ? {
              ...existing,
              currentIterationId: storedIteration.id,
              currentWorktreeId: worktree.id,
              updatedAt: now
            }
          : existing
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'TASK_ITERATION_CREATED',
        taskId: input.task.id,
        iterationId: storedIteration.id,
        worktreeId: worktree.id,
        source: 'ui',
        payload: {
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          baseSha: input.baseSha
        }
      }),
      false
    );

    await this.appendEvent(
      createDomainEvent({
        type: 'WORKTREE_CREATE_REQUESTED',
        taskId: input.task.id,
        iterationId: storedIteration.id,
        worktreeId: worktree.id,
        source: 'git',
        payload: {
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          baseSha: input.baseSha
        }
      }),
      false
    );

    await this.persistSnapshot();
    return { iteration: clone(storedIteration), worktree: clone(worktree) };
  }

  async updateWorktree(worktree: WorktreeRecord, eventType: 'WORKTREE_CREATED' | 'WORKTREE_VERIFIED' | 'WORKTREE_FAILED'): Promise<WorktreeRecord> {
    return this.serializeMutation(() =>
      this.updateWorktreeInternal(worktree, eventType)
    );
  }

  private async updateWorktreeInternal(
    worktree: WorktreeRecord,
    eventType: 'WORKTREE_CREATED' | 'WORKTREE_VERIFIED' | 'WORKTREE_FAILED'
  ): Promise<WorktreeRecord> {
    await this.init();
    const now = new Date().toISOString();
    const stored: WorktreeRecord = {
      ...worktree,
      updatedAt: now,
      lastVerifiedAt: eventType === 'WORKTREE_FAILED' ? worktree.lastVerifiedAt : now
    };

    this.state = {
      ...this.state,
      worktrees: this.state.worktrees.map((candidate) =>
        candidate.id === stored.id ? stored : candidate
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: eventType,
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.id,
        source: 'git',
        payload: {
          status: stored.status,
          branchName: stored.branchName,
          worktreePath: stored.worktreePath,
          headSha: stored.headSha,
          error: stored.error
        }
      }),
      false
    );
    await this.persistSnapshot();
    return clone(stored);
  }

  async recordGitSnapshot(snapshot: Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'>, diffEvidence: string): Promise<GitSnapshotRecord> {
    return this.serializeMutation(() =>
      this.recordGitSnapshotInternal(snapshot, diffEvidence)
    );
  }

  private async recordGitSnapshotInternal(
    snapshot: Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'>,
    diffEvidence: string
  ): Promise<GitSnapshotRecord> {
    await this.init();

    const diffArtifact = await this.createTextArtifact(snapshot.taskId, 'diff', diffEvidence);
    const stored: GitSnapshotRecord = {
      id: randomUUID(),
      ...snapshot,
      capturedAt: new Date().toISOString(),
      diffArtifactId: diffArtifact.id
    };

    this.state = {
      ...this.state,
      gitSnapshots: [stored, ...this.state.gitSnapshots]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'DIFF_ARTIFACT_CREATED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'storage',
        payload: { artifactId: diffArtifact.id, byteCount: diffArtifact.byteCount }
      }),
      false
    );

    await this.appendEvent(
      createDomainEvent({
        type: 'GIT_SNAPSHOT_CAPTURED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'git',
        payload: stored
      }),
      false
    );

    try {
      await this.persistSnapshot();
    } catch (error) {
      await this.cleanupUnpublishedArtifacts([diffArtifact]);
      throw error;
    }
    return clone(stored);
  }

  async transitionTask(taskId: string, toPhase: Task['workflowPhase'], reason: string): Promise<Task> {
    return this.serializeMutation(() =>
      this.transitionTaskInternal(taskId, toPhase, reason)
    );
  }

  private async transitionTaskInternal(
    taskId: string,
    toPhase: Task['workflowPhase'],
    reason: string
  ): Promise<Task> {
    await this.init();

    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const now = new Date().toISOString();
    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) =>
        candidate.id === taskId
          ? {
              ...candidate,
              workflowPhase: toPhase,
              resolution: toPhase === 'DONE' ? 'COMPLETED' : candidate.resolution,
              phaseVersion: candidate.phaseVersion + 1,
              updatedAt: now
            }
          : candidate
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'TRANSITION_COMPLETED',
        taskId,
        iterationId: task.currentIterationId,
        worktreeId: task.currentWorktreeId,
        source: 'ui',
        payload: { fromPhase: task.workflowPhase, toPhase, reason }
      }),
      false
    );
    await this.persistSnapshot();

    const updated = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!updated) {
      throw new Error(`Task not found after transition: ${taskId}`);
    }
    return clone(updated);
  }

  async recordBlockedTransition(task: Task, toPhase: Task['workflowPhase'], reason: string): Promise<void> {
    await this.appendEvent(
      createDomainEvent({
        type: 'TRANSITION_BLOCKED',
        taskId: task.id,
        iterationId: task.currentIterationId,
        worktreeId: task.currentWorktreeId,
        source: 'projection',
        payload: { fromPhase: task.workflowPhase, toPhase, reason }
      })
    );
  }

  async recordGitHubPreflight(
    record: Omit<GitHubRepositoryRecord, 'id' | 'checkedAt'>
  ): Promise<GitHubRepositoryRecord> {
    return this.serializeMutation(() => this.recordGitHubPreflightInternal(record));
  }

  private async recordGitHubPreflightInternal(
    record: Omit<GitHubRepositoryRecord, 'id' | 'checkedAt'>
  ): Promise<GitHubRepositoryRecord> {
    await this.init();
    const stored: GitHubRepositoryRecord = {
      id: randomUUID(),
      ...record,
      checkedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      githubRepositories: [stored, ...this.state.githubRepositories]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'GITHUB_PREFLIGHT_COMPLETED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'github',
        payload: stored
      }),
      false
    );
    await this.persistSnapshot();
    return clone(stored);
  }

  async recordBranchPublishRequested(
    task: Task,
    worktree: WorktreeRecord,
    remoteName: string,
    headSha: string
  ): Promise<BranchPublicationRecord> {
    return this.recordBranchPublication({
      taskId: task.id,
      iterationId: worktree.iterationId,
      worktreeId: worktree.id,
      remoteName,
      branchName: worktree.branchName,
      remoteRef: `${remoteName}/${worktree.branchName}`,
      headSha,
      status: 'PUSHING'
    });
  }

  async recordBranchPublication(
    record: Omit<BranchPublicationRecord, 'id' | 'requestedAt' | 'updatedAt'>
  ): Promise<BranchPublicationRecord> {
    return this.serializeMutation(() => this.recordBranchPublicationInternal(record));
  }

  private async recordBranchPublicationInternal(
    record: Omit<BranchPublicationRecord, 'id' | 'requestedAt' | 'updatedAt'>
  ): Promise<BranchPublicationRecord> {
    await this.init();
    const now = new Date().toISOString();
    const stored: BranchPublicationRecord = {
      id: randomUUID(),
      ...record,
      requestedAt: now,
      updatedAt: now
    };
    this.state = {
      ...this.state,
      branchPublications: [stored, ...this.state.branchPublications]
    };
    const eventType = branchPublicationEventType(stored.status);
    await this.appendEvent(
      createDomainEvent({
        type: eventType,
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'github',
        payload: stored
      }),
      false
    );
    await this.persistSnapshot();
    return clone(stored);
  }

  async recordPullRequestCreateRequested(task: Task, worktree: WorktreeRecord): Promise<void> {
    await this.appendEvent(
      createDomainEvent({
        type: 'PR_CREATE_REQUESTED',
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        source: 'github',
        payload: { branchName: worktree.branchName }
      })
    );
  }

  async recordPullRequestBodyArtifact(task: Task, content: string): Promise<ArtifactRecord> {
    return this.serializeMutation(() =>
      this.recordPullRequestBodyArtifactInternal(task, content)
    );
  }

  private async recordPullRequestBodyArtifactInternal(
    task: Task,
    content: string
  ): Promise<ArtifactRecord> {
    const artifact = await this.createTextArtifact(task.id, 'pr-body', content);
    await this.appendEvent(
      createDomainEvent({
        type: 'PR_BODY_ARTIFACT_CREATED',
        taskId: task.id,
        iterationId: task.currentIterationId,
        worktreeId: task.currentWorktreeId,
        source: 'storage',
        payload: { artifactId: artifact.id, byteCount: artifact.byteCount }
      }),
      false
    );
    try {
      await this.persistSnapshot();
    } catch (error) {
      await this.cleanupUnpublishedArtifacts([artifact]);
      throw error;
    }
    return clone(artifact);
  }

  async recordPullRequestSync(input: PrSyncInput): Promise<PullRequestSnapshotRecord> {
    return this.serializeMutation(() => this.recordPullRequestSyncInternal(input));
  }

  private async recordPullRequestSyncInternal(
    input: PrSyncInput
  ): Promise<PullRequestSnapshotRecord> {
    await this.init();
    const observedAt = new Date().toISOString();
    const pullRequest: PullRequestSnapshotRecord = {
      id: randomUUID(),
      ...input.pullRequest,
      observedAt
    };
    const ci: CiRollupRecord = {
      id: randomUUID(),
      ...input.ci,
      observedAt
    };
    const reviews: ReviewRollupRecord = {
      id: randomUUID(),
      ...input.reviews,
      observedAt
    };
    const merge: MergeSnapshotRecord = {
      id: randomUUID(),
      ...input.merge,
      observedAt
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((task) => {
        if (task.id !== pullRequest.taskId) {
          return task;
        }
        const completionPolicy = completionPolicyAfterPullRequestSync(task, pullRequest.status);
        return completionPolicy === task.completionPolicy
          ? task
          : {
              ...task,
              completionPolicy,
              updatedAt: observedAt,
              phaseVersion: task.phaseVersion + 1
            };
      }),
      pullRequests: [pullRequest, ...this.state.pullRequests],
      ciRollups: [ci, ...this.state.ciRollups],
      reviewRollups: [reviews, ...this.state.reviewRollups],
      mergeSnapshots: [merge, ...this.state.mergeSnapshots]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'PR_SNAPSHOT_CAPTURED',
        taskId: pullRequest.taskId,
        iterationId: pullRequest.iterationId,
        worktreeId: pullRequest.worktreeId,
        source: 'github',
        payload: pullRequest
      }),
      false
    );
    await this.appendEvent(
      createDomainEvent({
        type: 'CI_ROLLUP_CAPTURED',
        taskId: ci.taskId,
        iterationId: ci.iterationId,
        worktreeId: ci.worktreeId,
        source: 'github',
        payload: ci
      }),
      false
    );
    await this.appendEvent(
      createDomainEvent({
        type: 'REVIEW_ROLLUP_CAPTURED',
        taskId: reviews.taskId,
        iterationId: reviews.iterationId,
        worktreeId: reviews.worktreeId,
        source: 'github',
        payload: reviews
      }),
      false
    );
    const taskBeforeMerge = this.state.tasks.find((task) => task.id === merge.taskId);
    const shouldComplete = taskBeforeMerge
      ? shouldCompleteFromPullRequestSync(taskBeforeMerge, pullRequest, ci, merge)
      : false;
    await this.appendEvent(
      createDomainEvent({
        type: 'MERGE_SNAPSHOT_CAPTURED',
        taskId: merge.taskId,
        iterationId: merge.iterationId,
        worktreeId: merge.worktreeId,
        source: 'github',
        payload: merge
      }),
      false
    );

    if (shouldComplete) {
      const now = new Date().toISOString();
      this.state = {
        ...this.state,
        tasks: this.state.tasks.map((task) =>
          task.id === merge.taskId
            ? {
                ...task,
                workflowPhase: 'DONE',
                resolution: 'COMPLETED',
                updatedAt: now,
                phaseVersion: task.phaseVersion + 1
              }
            : task
        )
      };
    }

    await this.persistSnapshot();
    return clone(pullRequest);
  }

  async appendEvent(event: DomainEvent, persist = true): Promise<void> {
    if (!persist && !this.mutationContext.getStore()) {
      throw new Error('Non-publishing store events are internal to a serialized mutation.');
    }
    return this.serializeMutation(() => this.appendEventInternal(event, persist));
  }

  private async appendEventInternal(event: DomainEvent, persist: boolean): Promise<void> {
    await this.init();
    this.state = applyEventToState(this.state, event);
    if (persist) {
      await this.persistSnapshot();
    }
  }

  /**
   * Atomically checks the current run projection and appends an event without
   * yielding between the status guard and projection update.
   */
  async appendRunEventIfStatus(
    event: DomainEvent,
    allowedStatuses: readonly RunRecord['status'][]
  ): Promise<boolean> {
    return this.serializeMutation(() =>
      this.appendRunEventIfStatusInternal(event, allowedStatuses)
    );
  }

  private async appendRunEventIfStatusInternal(
    event: DomainEvent,
    allowedStatuses: readonly RunRecord['status'][]
  ): Promise<boolean> {
    await this.init();
    if (!event.runId) {
      throw new Error('A conditional run event requires a run id.');
    }
    const run = this.state.runs.find((candidate) => candidate.id === event.runId);
    if (!run || !allowedStatuses.includes(run.status)) {
      return false;
    }
    this.state = applyEventToState(this.state, event);
    await this.persistSnapshot();
    return true;
  }

  async appendArtifact(artifactId: string, chunk: string): Promise<void> {
    return this.serializeMutation(() => this.appendArtifactInternal(artifactId, chunk));
  }

  private async appendArtifactInternal(artifactId: string, chunk: string): Promise<void> {
    await this.init();

    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    const byteCount = await appendBoundedArtifactFile(artifact, chunk);
    const updatedAt = new Date().toISOString();
    this.state = {
      ...this.state,
      artifacts: this.state.artifacts.map((candidate) =>
        candidate.id === artifactId
          ? { ...candidate, byteCount, updatedAt }
          : candidate
      )
    };
    try {
      await this.persistSnapshot();
    } catch (error) {
      const published = this.publishedState.artifacts.find(
        (candidate) => candidate.id === artifactId
      );
      if (published) {
        try {
          await reconcileArtifactFile(published.path, published.byteCount);
        } catch (rollbackError) {
          throw new ArtifactAppendAmbiguousError(
            artifactId,
            error,
            rollbackError
          );
        }
      }
      throw error;
    }
  }

  async createPreviewArtifact(
    taskId: string,
    kind: 'preview-stdout' | 'preview-stderr'
  ): Promise<ArtifactRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      const artifact = await this.createArtifactRecord(taskId, kind);
      await writeNewArtifactFiles(this.artifactsDir, [{ artifact, content: '' }]);
      this.state = {
        ...this.state,
        artifacts: [artifact, ...this.state.artifacts]
      };
      try {
        await this.persistSnapshot();
      } catch (error) {
        await this.cleanupUnpublishedArtifacts([artifact]);
        throw error;
      }
      return clone(artifact);
    });
  }

  async appendBoundedArtifact(
    artifactId: string,
    chunk: string | Buffer,
    maxBytes = 256 * 1024
  ): Promise<{ byteCount: number; truncated: boolean }> {
    return this.serializeMutation(async () => {
      await this.init();
      const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact) {
        throw new Error(`Artifact not found: ${artifactId}`);
      }
      const limit = Math.min(maxBytes, ARTIFACT_BYTE_LIMITS[artifact.kind]);
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new Error('Artifact byte limit must be a non-negative safe integer.');
      }
      if (artifact.byteCount >= limit) {
        return { byteCount: artifact.byteCount, truncated: true };
      }

      const marker = Buffer.from('\n[Task Monki preview log truncated]\n', 'utf8');
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      const remaining = limit - artifact.byteCount;
      const truncated = input.byteLength > remaining;
      const output = truncated
        ? Buffer.concat([
            input.subarray(0, Math.max(0, remaining - marker.byteLength)),
            marker.subarray(0, Math.min(marker.byteLength, remaining))
          ])
        : input;
      if (output.byteLength > 0) {
        await appendManagedArtifactFile(artifact.path, output);
      }

      const byteCount = artifact.byteCount + output.byteLength;
      const updatedAt = new Date().toISOString();
      this.state = {
        ...this.state,
        artifacts: this.state.artifacts.map((candidate) =>
          candidate.id === artifactId ? { ...candidate, byteCount, updatedAt } : candidate
        )
      };
      try {
        await this.persistSnapshot();
      } catch (error) {
        try {
          await reconcileArtifactFile(artifact.path, artifact.byteCount);
        } catch (rollbackError) {
          throw new ArtifactAppendAmbiguousError(artifactId, error, rollbackError);
        }
        throw error;
      }
      return { byteCount, truncated };
    });
  }

  async syncArtifactByteCount(artifactId: string): Promise<ArtifactRecord> {
    return this.serializeMutation(async () => {
      await this.init();
      const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
      const handle = await openManagedArtifactFile(artifact.path, fsConstants.O_RDONLY).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      const stat = handle ? await handle.stat().finally(() => handle.close()) : undefined;
      const byteCount = stat?.size ?? 0;
      if (byteCount > ARTIFACT_BYTE_LIMITS[artifact.kind]) {
        throw new Error('Stored task artifact exceeds its byte limit.');
      }
      const updated: ArtifactRecord = {
        ...artifact,
        byteCount,
        updatedAt: new Date().toISOString()
      };
      this.state = {
        ...this.state,
        artifacts: this.state.artifacts.map((candidate) =>
          candidate.id === artifactId ? updated : candidate
        )
      };
      await this.persistSnapshot();
      return clone(updated);
    });
  }

  async writeFinalArtifact(taskId: string, runId: string, content: string): Promise<ArtifactRecord> {
    return this.serializeMutation(() =>
      this.writeFinalArtifactInternal(taskId, runId, content)
    );
  }

  private async writeFinalArtifactInternal(
    taskId: string,
    runId: string,
    content: string
  ): Promise<ArtifactRecord> {
    await this.init();

    const run = this.state.runs.find((candidate) => candidate.id === runId);
    if (!run || run.taskId !== taskId) {
      throw new Error(`Run ${runId} does not belong to task ${taskId}.`);
    }
    const existing = this.state.artifacts.find(
      (artifact) => artifact.runId === runId && artifact.kind === 'agent-final'
    );
    if (existing) return clone(existing);

    const artifact = await this.createArtifactRecord(taskId, 'agent-final', { runId });
    await writeNewArtifactFiles(this.artifactsDir, [{ artifact, content }]);

    const storedContent = await readPrivateArtifactFile(
      artifact.path,
      artifact.byteCount
    );
    const hash = createHash('sha256').update(storedContent).digest('hex');
    const stored: ArtifactRecord = {
      ...artifact,
      updatedAt: new Date().toISOString()
    };

    const stateWithArtifact = {
      ...this.state,
      artifacts: [stored, ...this.state.artifacts]
    };
    this.state = applyEventToState(
      stateWithArtifact,
      createDomainEvent({
        type: 'ARTIFACT_CREATED',
        taskId,
        runId,
        source: 'storage',
        payload: { artifactId: stored.id, kind: stored.kind, hash }
      })
    );

    try {
      await this.persistSnapshot();
    } catch (error) {
      await this.cleanupUnpublishedArtifacts([stored]);
      throw error;
    }
    return clone(stored);
  }

  async writeTextArtifact(taskId: string, kind: ArtifactKind, content: string): Promise<ArtifactRecord> {
    return this.serializeMutation(() =>
      this.writeTextArtifactInternal(taskId, kind, content)
    );
  }

  private async writeTextArtifactInternal(
    taskId: string,
    kind: ArtifactKind,
    content: string
  ): Promise<ArtifactRecord> {
    await this.init();

    const stored = await this.createTextArtifact(taskId, kind, content);
    try {
      await this.persistSnapshot();
    } catch (error) {
      await this.cleanupUnpublishedArtifacts([stored]);
      throw error;
    }
    return clone(stored);
  }

  private async createTextArtifact(
    taskId: string,
    kind: ArtifactKind,
    content: string
  ): Promise<ArtifactRecord> {

    const artifact = await this.createArtifactRecord(taskId, kind);
    await writeNewArtifactFiles(this.artifactsDir, [{ artifact, content }]);

    const stored: ArtifactRecord = {
      ...artifact,
      updatedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      artifacts: [stored, ...this.state.artifacts]
    };
    return stored;
  }

  readArtifact(artifactId: string): Promise<string> {
    // The file bytes and recorded byte count are one durable unit. Use the
    // store's exclusive queue so an append cannot change either during a read.
    return this.serializeMutation(() => {
      const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact) {
        throw new Error(`Artifact not found: ${artifactId}`);
      }
      return readPrivateArtifactFile(artifact.path, artifact.byteCount);
    });
  }

  private pruneUnreferencedTerminalAgentServers(): string[] {
    const referencedServerIds = collectReferencedAgentServerIds(this.state);
    const unreferencedTerminalServers = this.state.agentServers
      .filter(
        (server) =>
          isTerminalAgentServerStatus(server.status) &&
          !referencedServerIds.has(server.id)
      )
      .sort(compareAgentServerDiagnosticsNewestFirst);
    const prunedServerIds = unreferencedTerminalServers
      .slice(this.maxUnreferencedTerminalAgentServers)
      .map((server) => server.id);
    if (prunedServerIds.length === 0) return [];
    const pruned = new Set(prunedServerIds);
    this.state = {
      ...this.state,
      agentServers: this.state.agentServers.filter((server) => !pruned.has(server.id))
    };
    return prunedServerIds;
  }

  private async cleanupPrunedServerJournals(serverInstanceIds: string[]): Promise<void> {
    // The record removal was already published. Cleanup failure leaves an
    // orphan that startup reconciliation can retry without risking a dangling
    // durable reference.
    await Promise.allSettled(
      serverInstanceIds.map((serverInstanceId) =>
        this.protocolJournal.removeServer(serverInstanceId)
      )
    );
  }

  private async cleanupUnpublishedArtifacts(
    artifacts: readonly ArtifactRecord[]
  ): Promise<void> {
    const publishedIds = new Set(this.publishedState.artifacts.map((artifact) => artifact.id));
    const unpublished = artifacts.filter((artifact) => !publishedIds.has(artifact.id));
    if (unpublished.length === 0) return;
    await Promise.allSettled(unpublished.map((artifact) => fs.unlink(artifact.path)));
    await syncDirectoryIfSupported(this.artifactsDir).catch(() => undefined);
  }

  readArtifactRange(
    artifactId: string,
    offset: number,
    maxBytes: number
  ): Promise<{ chunk: string; nextOffset: number; endOfFile: boolean }> {
    return this.serializeMutation(async () => {
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error('Artifact offset must be a nonnegative integer.');
      }
      if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > 64 * 1024) {
        throw new Error('Artifact range must contain 4-65536 bytes.');
      }
      const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
      const handle = await openManagedArtifactFile(artifact.path, fsConstants.O_RDONLY).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (!handle) return { chunk: '', nextOffset: offset, endOfFile: true };
      try {
        const stat = await handle.stat();
        if (offset >= stat.size) return { chunk: '', nextOffset: stat.size, endOfFile: true };
        const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const safeBytes = utf8SafePrefixLength(
          buffer.subarray(0, bytesRead),
          offset + bytesRead >= stat.size
        );
        return {
          chunk: buffer.subarray(0, safeBytes).toString('utf8'),
          nextOffset: offset + safeBytes,
          endOfFile: offset + safeBytes >= stat.size
        };
      } finally {
        await handle.close();
      }
    });
  }

  async getArtifactPath(artifactId: string): Promise<string> {
    await this.init();
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    return artifact.path;
  }

  private async createArtifactRecord(
    taskId: string,
    kind: ArtifactKind,
    ids: { runId?: string } = {}
  ): Promise<ArtifactRecord> {
    if (!UUID_FILE_SEGMENT_PATTERN.test(taskId)) {
      throw new Error('Task artifact owner id is invalid.');
    }
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (ids.runId && !UUID_FILE_SEGMENT_PATTERN.test(ids.runId)) {
      throw new Error('Task artifact run id is invalid.');
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const ownerId = ids.runId ?? 'task';
    const fileName = `${taskId}-${ownerId}-${kind}-${id}.log`;
    const artifactPath = path.resolve(this.artifactsDir, fileName);
    if (
      !MANAGED_ARTIFACT_FILE_PATTERN.test(fileName) ||
      !sameAbsolutePath(path.dirname(artifactPath), path.resolve(this.artifactsDir))
    ) {
      throw new Error('Task artifact path escaped its managed directory.');
    }
    return {
      id,
      taskId,
      runId: ids.runId,
      kind,
      path: artifactPath,
      byteCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  private async persistSnapshot(): Promise<boolean> {
    return this.persist();
  }

  private async persist(): Promise<boolean> {
    const lease = this.lease;
    if (!lease) {
      throw new Error('Task store persistence requires an active ownership lease.');
    }
    await assertStoreOwnershipLease(this.leasePath, lease);
    // A durable store record must never be published ahead of the raw protocol
    // entry it references. High-volume unmaterialized input remains batch-synced.
    await this.protocolJournal.flush();
    await fs.mkdir(this.baseDir, { recursive: true });
    const publishedSnapshotJson = JSON.stringify(this.state);
    const serialized = `${publishedSnapshotJson}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_FILE_BYTES) {
      throw new Error('Task store snapshot exceeds its durable size limit.');
    }
    const tmpPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let published = false;
    try {
      handle = await fs.open(
        tmpPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      );
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await enforcePosixMode(handle, 0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertStoreOwnershipLease(this.leasePath, lease);
      await fs.rename(tmpPath, this.storePath);
      published = true;
      this.publishedState = this.state;
      this.publishedSnapshotJson = publishedSnapshotJson;
      await syncDirectoryIfSupported(this.baseDir);
      return true;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(tmpPath).catch(() => undefined);
      if (published) return false;
      throw error;
    }
  }
}

async function readPrivateStoreFile(storePath: string): Promise<string> {
  const handle = await fs.open(
    storePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > MAX_STORE_FILE_BYTES ||
      !hasNoGroupOrOtherPosixAccess(stat) ||
      !isOwnedByCurrentUser(stat)
    ) {
      throw new Error('Task store file failed its integrity check.');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) {
      throw new Error('Task store file changed while it was being read.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

async function cleanupStoreTemporaryFiles(
  baseDir: string,
  storePath: string
): Promise<void> {
  const storeName = path.basename(storePath);
  for (const entry of await fs.readdir(baseDir, { withFileTypes: true })) {
    if (
      entry.name !== `${storeName}.tmp` &&
      !(entry.name.startsWith(`${storeName}.`) && entry.name.endsWith('.tmp'))
    ) {
      continue;
    }
    const temporaryPath = path.join(baseDir, entry.name);
    const stat = await fs.lstat(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) continue;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error('Task store temporary path failed its integrity check.');
    }
    await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function initializeArtifactDirectory(
  baseDir: string,
  artifactsDir: string
): Promise<void> {
  try {
    await fs.mkdir(artifactsDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const before = await inspectArtifactDirectory(baseDir, artifactsDir);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      artifactsDir,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch {
    throw new Error('Task artifact directory failed its integrity check.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || !sameFileIdentity(stat, before)) {
      throw new Error('Task artifact directory changed during initialization.');
    }
    assertArtifactOwnedByCurrentUser(stat);
    await enforcePosixMode(handle, 0o700);
  } finally {
    await handle.close();
  }
  await assertArtifactDirectory(baseDir, artifactsDir);
}

async function assertArtifactDirectory(
  baseDir: string,
  artifactsDir: string
): Promise<void> {
  const stat = await inspectArtifactDirectory(baseDir, artifactsDir);
  assertArtifactPrivateMode(stat, 0o700);
}

async function inspectArtifactDirectory(
  baseDir: string,
  artifactsDir: string
): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  const stat = await fs.lstat(artifactsDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Task artifact directory failed its integrity check.');
  }
  assertArtifactOwnedByCurrentUser(stat);
  const [baseRealPath, artifactRealPath] = await Promise.all([
    fs.realpath(baseDir),
    fs.realpath(artifactsDir)
  ]);
  const expectedArtifactPath = path.join(baseRealPath, path.basename(artifactsDir));
  if (!sameAbsolutePath(artifactRealPath, expectedArtifactPath)) {
    throw new Error('Task artifact directory escaped its managed root.');
  }
  return stat;
}

function validateArtifactRecord(
  artifact: ArtifactRecord,
  artifactsDir: string,
  taskIds: ReadonlySet<string>,
  runsById: ReadonlyMap<string, RunRecord>
): string {
  const run = artifact.runId === undefined ? undefined : runsById.get(artifact.runId);
  if (
    !artifact ||
    typeof artifact !== 'object' ||
    !UUID_FILE_SEGMENT_PATTERN.test(artifact.id) ||
    !UUID_FILE_SEGMENT_PATTERN.test(artifact.taskId) ||
    (artifact.runId !== undefined && !UUID_FILE_SEGMENT_PATTERN.test(artifact.runId)) ||
    !ARTIFACT_KINDS.includes(artifact.kind) ||
    !Number.isSafeInteger(artifact.byteCount) ||
    artifact.byteCount < 0 ||
    artifact.byteCount > ARTIFACT_BYTE_LIMITS[artifact.kind] ||
    !isCanonicalStoreTimestamp(artifact.createdAt) ||
    !isCanonicalStoreTimestamp(artifact.updatedAt) ||
    artifact.updatedAt < artifact.createdAt ||
    !taskIds.has(artifact.taskId) ||
    (artifact.runId !== undefined && (!run || run.taskId !== artifact.taskId))
  ) {
    throw new Error('Task artifact record failed its integrity check.');
  }
  const ownerId = artifact.runId ?? 'task';
  const fileName = `${artifact.taskId}-${ownerId}-${artifact.kind}-${artifact.id}.log`;
  if (
    !MANAGED_ARTIFACT_FILE_PATTERN.test(fileName) ||
    !sameAbsolutePath(artifact.path, path.join(artifactsDir, fileName))
  ) {
    throw new Error('Task artifact path failed its managed-path integrity check.');
  }
  return fileName;
}

async function reconcileArtifactFile(
  filePath: string,
  expectedByteCount: number
): Promise<void> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Stored task artifact is not a regular file.');
  }
  assertArtifactOwnedByCurrentUser(before);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch {
    throw new Error('Stored task artifact could not be opened safely.');
  }
  try {
    const stat = await handle.stat();
    if (!sameFileIdentity(stat, before)) {
      throw new Error('Stored task artifact changed during validation.');
    }
    assertArtifactOwnedByCurrentUser(stat);
    if (stat.size < expectedByteCount) {
      throw new Error('Stored task artifact is missing referenced bytes.');
    }
    if (stat.size > expectedByteCount) {
      await handle.truncate(expectedByteCount);
      await handle.sync();
    }
    if (!posixModeMatches(stat, 0o600)) {
      await enforcePosixMode(handle, 0o600);
      await handle.sync();
    }
    assertArtifactPrivateMode(await handle.stat(), 0o600);
  } finally {
    await handle.close();
  }
}

async function writeNewArtifactFiles(
  artifactsDir: string,
  entries: Array<{ artifact: ArtifactRecord; content: string }>
): Promise<void> {
  const createdPaths: string[] = [];
  try {
    for (const entry of entries) {
      const bytes = boundedArtifactBytes(entry.artifact.kind, entry.content);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(
          entry.artifact.path,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            (fsConstants.O_NOFOLLOW ?? 0),
          0o600
        );
        createdPaths.push(entry.artifact.path);
        await handle.writeFile(bytes);
        await handle.sync();
        await enforcePosixMode(handle, 0o600);
        await handle.sync();
      } finally {
        await handle?.close().catch(() => undefined);
      }
      entry.artifact.byteCount = bytes.byteLength;
    }
    await syncDirectoryIfSupported(artifactsDir);
  } catch (error) {
    await Promise.allSettled(createdPaths.map((filePath) => fs.unlink(filePath)));
    await syncDirectoryIfSupported(artifactsDir).catch(() => undefined);
    throw error;
  }
}

async function appendBoundedArtifactFile(
  artifact: ArtifactRecord,
  chunk: string
): Promise<number> {
  if (!chunk) return artifact.byteCount;
  const before = await fs.lstat(artifact.path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Stored task artifact is not a regular file.');
  }
  assertArtifactOwnedByCurrentUser(before);

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      artifact.path,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch {
    throw new Error('Stored task artifact could not be opened safely.');
  }
  let appendAttempted = false;
  let operationFailed = false;
  let operationError: unknown;
  let byteCount: number | undefined;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      (stat.ino !== 0 && before.ino !== 0 && stat.ino !== before.ino) ||
      stat.size !== artifact.byteCount
    ) {
      throw new Error('Stored task artifact changed during append.');
    }
    assertArtifactOwnedByCurrentUser(stat);
    assertArtifactPrivateMode(stat, 0o600);

    const incoming = Buffer.from(chunk, 'utf8');
    const limit = ARTIFACT_BYTE_LIMITS[artifact.kind];
    const marker = artifactTruncationMarker(artifact.kind, limit);
    if (artifact.byteCount >= marker.byteLength) {
      const tail = Buffer.alloc(marker.byteLength);
      await readAllAt(handle, tail, artifact.byteCount - marker.byteLength);
      if (tail.equals(marker)) byteCount = artifact.byteCount;
    }
    if (byteCount === undefined) {
      const contentLimit = limit - marker.byteLength;
      if (artifact.byteCount > contentLimit) {
        throw new Error('Stored task artifact exceeds its appendable content budget.');
      }

      const available = contentLimit - artifact.byteCount;
      const append = incoming.byteLength <= available
        ? incoming
        : Buffer.concat([truncateUtf8Buffer(incoming, available), marker]);
      appendAttempted = true;
      try {
        await writeAllAt(handle, append, artifact.byteCount);
        await handle.sync();
        byteCount = artifact.byteCount + append.byteLength;
      } catch (error) {
        try {
          await handle.truncate(artifact.byteCount);
          await handle.sync();
        } catch (rollbackError) {
          throw new ArtifactAppendAmbiguousError(
            artifact.id,
            error,
            rollbackError
          );
        }
        throw error;
      }
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (closeError !== undefined) {
    if (operationError instanceof ArtifactAppendAmbiguousError) {
      throw operationError;
    }
    if (appendAttempted) {
      try {
        await reconcileArtifactFile(artifact.path, artifact.byteCount);
      } catch (rollbackError) {
        const appendError = operationFailed
          ? new AggregateError(
              [operationError, closeError],
              'Artifact append and close both failed.'
            )
          : closeError;
        throw new ArtifactAppendAmbiguousError(
          artifact.id,
          appendError,
          rollbackError
        );
      }
    }
    if (operationFailed) throw operationError;
    throw closeError;
  }
  if (operationFailed) throw operationError;
  return byteCount!;
}

function boundedArtifactBytes(kind: ArtifactKind, content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  const limit = ARTIFACT_BYTE_LIMITS[kind];
  const marker = artifactTruncationMarker(kind, limit);
  const contentLimit = limit - marker.byteLength;
  if (bytes.byteLength <= contentLimit) return bytes;
  return Buffer.concat([
    truncateUtf8Buffer(bytes, contentLimit),
    marker
  ]);
}

function artifactTruncationMarker(kind: ArtifactKind, limit: number): Buffer {
  return Buffer.from(
    `\n[Task Monki truncated ${kind} after ${limit} retained bytes.]\n`,
    'utf8'
  );
}

function truncateUtf8Buffer(bytes: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (bytes.byteLength <= maxBytes) return bytes;
  let end = maxBytes;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > Math.max(0, maxBytes - 4)) {
    const candidate = bytes.subarray(0, end);
    try {
      decoder.decode(candidate);
      return candidate;
    } catch {
      end -= 1;
    }
  }
  throw new Error('Task artifact content is not valid UTF-8.');
}

async function writeAllAt(
  handle: Awaited<ReturnType<typeof fs.open>>,
  bytes: Buffer,
  position: number
): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      position + written
    );
    if (result.bytesWritten <= 0) {
      throw new Error('Task artifact write made no progress.');
    }
    written += result.bytesWritten;
  }
}

async function readAllAt(
  handle: Awaited<ReturnType<typeof fs.open>>,
  bytes: Buffer,
  position: number
): Promise<void> {
  let read = 0;
  while (read < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      read,
      bytes.byteLength - read,
      position + read
    );
    if (result.bytesRead <= 0) {
      throw new Error('Task artifact changed while it was being read.');
    }
    read += result.bytesRead;
  }
}

async function readPrivateArtifactFile(
  filePath: string,
  expectedByteCount: number
): Promise<string> {
  const before = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new Error('Stored task artifact file is missing.');
    }
    throw error;
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Stored task artifact is not a regular file.');
  }
  assertArtifactOwnedByCurrentUser(before);
  assertArtifactPrivateMode(before, 0o600);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch {
    throw new Error('Stored task artifact could not be opened safely.');
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      (stat.ino !== 0 && before.ino !== 0 && stat.ino !== before.ino) ||
      stat.size !== expectedByteCount
    ) {
      throw new Error('Stored task artifact changed during read.');
    }
    assertArtifactOwnedByCurrentUser(stat);
    assertArtifactPrivateMode(stat, 0o600);
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) {
      throw new Error('Stored task artifact changed while it was being read.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

async function appendManagedArtifactFile(
  filePath: string,
  content: string | Buffer
): Promise<void> {
  const handle = await openManagedArtifactFile(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT,
    0o600
  );
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

async function openManagedArtifactFile(
  filePath: string,
  flags: number,
  mode?: number
): Promise<Awaited<ReturnType<typeof fs.open>>> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      filePath,
      flags | (fsConstants.O_NOFOLLOW ?? 0),
      mode
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error('Stored task artifact could not be opened safely.', { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('Stored task artifact is not a regular file.');
    }
    assertArtifactOwnedByCurrentUser(stat);
    if (!posixModeMatches(stat, 0o600)) {
      await enforcePosixMode(handle, 0o600);
    }
    assertArtifactPrivateMode(await handle.stat(), 0o600);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function assertArtifactOwnedByCurrentUser(
  stat: { uid: number | bigint }
): void {
  if (!isOwnedByCurrentUser(stat)) {
    throw new Error('Task artifact entry is not owned by the current user.');
  }
}

function assertArtifactPrivateMode(
  stat: { mode: number | bigint },
  expected: number
): void {
  if (!posixModeMatches(stat, expected)) {
    throw new Error('Task artifact entry has unsafe permissions.');
  }
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint }
): boolean {
  if (left.dev !== right.dev) return false;
  return left.ino === 0 || right.ino === 0 || left.ino === right.ino;
}

function sameAbsolutePath(left: string, right: string): boolean {
  return path.isAbsolute(left) && path.isAbsolute(right) && path.relative(left, right) === '';
}

function isSafeDesignProjectPath(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 1_024 &&
    value.startsWith('assets/') &&
    !path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    value !== '..' &&
    !value.startsWith('../')
  );
}

function requireCurrentState(state: PersistedState): StoreState {
  if (state.schemaVersion !== TASK_STORE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Task Monki store schema ${String(state.schemaVersion)}. ` +
        `This build accepts only schema ${TASK_STORE_SCHEMA_VERSION}.`
    );
  }
  const requiredCollections: Array<keyof StoreState> = [
    'repositories',
    'boards',
    'tasks',
    'designTurns',
    'designReferences',
    'designRevisions',
    'iterations',
    'worktrees',
    'gitSnapshots',
    'githubRepositories',
    'branchPublications',
    'pullRequests',
    'ciRollups',
    'reviewRollups',
    'mergeSnapshots',
    'runs',
    'agentServers',
    'agentSessions',
    'agentItems',
    'agentGoalSnapshots',
    'agentPlanRevisions',
    'agentUsageSnapshots',
    'agentSettingsObservations',
    'agentSubagentObservations',
    'interactionRequests',
    'previewPlans',
    'previewApprovals',
    'previewComposeProjects',
    'previewGenerations',
    'previewManagedEnvironments',
    'previewManagedResources',
    'previewGenerationAttachments',
    'previewLocalBindings',
    'previewNodeAttempts',
    'previewResources',
    'events',
    'artifacts',
    'attachments'
  ];
  for (const key of requiredCollections) {
    if (!Array.isArray(state[key])) {
      throw new Error(`Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: ${key} is missing.`);
    }
  }
  const current = state as StoreState;
  validateCurrentStoreRecords(current);
  validatePersistedRelationships(current);
  validatePersistedDesignRelationships(current);
  validatePersistedRuntimeIdentity(current);
  validatePersistedRepositoryReferences(current);
  validatePersistedBoards(current);
  validatePersistedTaskCreationMetadata(current);
  validatePersistedAttachments(current);
  return current;
}

function validatePersistedRelationships(state: StoreState): void {
  const tasks = indexUniqueRecords(state.tasks, 'tasks');
  const iterations = indexUniqueRecords(state.iterations, 'iterations');
  const worktrees = indexUniqueRecords(state.worktrees, 'worktrees');
  const sessions = indexUniqueRecords(state.agentSessions, 'agentSessions');
  const runs = indexUniqueRecords(state.runs, 'runs');
  const artifacts = indexUniqueRecords(state.artifacts, 'artifacts');
  const gitSnapshots = indexUniqueRecords(state.gitSnapshots, 'gitSnapshots');
  const githubRepositories = indexUniqueRecords(
    state.githubRepositories,
    'githubRepositories'
  );
  const branchPublications = indexUniqueRecords(
    state.branchPublications,
    'branchPublications'
  );
  const pullRequests = indexUniqueRecords(state.pullRequests, 'pullRequests');
  const ciRollups = indexUniqueRecords(state.ciRollups, 'ciRollups');
  const reviewRollups = indexUniqueRecords(state.reviewRollups, 'reviewRollups');
  const mergeSnapshots = indexUniqueRecords(state.mergeSnapshots, 'mergeSnapshots');
  indexUniqueRecords(state.interactionRequests, 'interactionRequests');

  for (const iteration of state.iterations) {
    const worktree = iteration.worktreeId
      ? worktrees.get(iteration.worktreeId)
      : undefined;
    if (
      !tasks.has(iteration.taskId) ||
      (iteration.worktreeId &&
        (!worktree ||
          worktree.taskId !== iteration.taskId ||
          worktree.iterationId !== iteration.id))
    ) {
      invalidPersistedRelationship('iteration ownership');
    }
  }

  for (const worktree of state.worktrees) {
    const iteration = iterations.get(worktree.iterationId);
    if (
      !tasks.has(worktree.taskId) ||
      !iteration ||
      iteration.taskId !== worktree.taskId
    ) {
      invalidPersistedRelationship('worktree ownership');
    }
  }

  for (const session of state.agentSessions) {
    const iteration = iterations.get(session.iterationId);
    const worktree = worktrees.get(session.worktreeId);
    if (
      !tasks.has(session.taskId) ||
      !iteration ||
      iteration.taskId !== session.taskId ||
      !worktree ||
      worktree.taskId !== session.taskId ||
      worktree.iterationId !== session.iterationId ||
      worktree.worktreePath !== session.worktreePath
    ) {
      invalidPersistedRelationship('agent session ownership');
    }
  }

  for (const run of state.runs) {
    const iteration = iterations.get(run.iterationId);
    const worktree = worktrees.get(run.worktreeId);
    const session = sessions.get(run.sessionId);
    if (
      !tasks.has(run.taskId) ||
      !iteration ||
      iteration.taskId !== run.taskId ||
      !worktree ||
      worktree.taskId !== run.taskId ||
      worktree.iterationId !== run.iterationId ||
      !session ||
      session.taskId !== run.taskId ||
      session.iterationId !== run.iterationId ||
      session.worktreeId !== run.worktreeId
    ) {
      invalidPersistedRelationship('run ownership');
    }
    assertRunArtifact(artifacts, run, run.promptArtifactId, 'agent-prompt');
    assertRunArtifact(artifacts, run, run.outputArtifactId, 'agent-output');
    assertRunArtifact(
      artifacts,
      run,
      run.diagnosticArtifactId,
      'agent-diagnostics'
    );
    if (run.finalArtifactId) {
      assertRunArtifact(artifacts, run, run.finalArtifactId, 'agent-final');
    }
    if (run.beforeGitSnapshotId) {
      assertRunGitSnapshot(gitSnapshots, run, run.beforeGitSnapshotId);
    }
    if (run.afterGitSnapshotId) {
      assertRunGitSnapshot(gitSnapshots, run, run.afterGitSnapshotId);
    }
  }

  for (const artifact of state.artifacts) {
    const run = artifact.runId ? runs.get(artifact.runId) : undefined;
    if (
      !tasks.has(artifact.taskId) ||
      (artifact.runId && (!run || run.taskId !== artifact.taskId))
    ) {
      invalidPersistedRelationship('artifact ownership');
    }
  }

  for (const item of state.agentItems) {
    if (!item.outputArtifactId) continue;
    const artifact = artifacts.get(item.outputArtifactId);
    if (
      !artifact ||
      artifact.taskId !== item.taskId ||
      artifact.runId !== item.runId
    ) {
      invalidPersistedRelationship('agent item output artifact ownership');
    }
  }

  for (const snapshot of gitSnapshots.values()) {
    const worktree = assertEvidenceOwnership(
      tasks,
      iterations,
      worktrees,
      snapshot,
      'git snapshot ownership'
    );
    if (snapshot.worktreePath !== worktree.worktreePath) {
      invalidPersistedRelationship('git snapshot ownership');
    }
    if (snapshot.diffArtifactId) {
      assertTaskArtifact(
        artifacts,
        snapshot.taskId,
        snapshot.diffArtifactId,
        'diff',
        'git snapshot artifact ownership'
      );
    }
  }

  for (const [records, label] of [
    [githubRepositories, 'GitHub repository ownership'],
    [branchPublications, 'branch publication ownership'],
    [pullRequests, 'pull request ownership'],
    [ciRollups, 'CI rollup ownership'],
    [reviewRollups, 'review rollup ownership'],
    [mergeSnapshots, 'merge snapshot ownership']
  ] as const) {
    for (const record of records.values()) {
      assertEvidenceOwnership(tasks, iterations, worktrees, record, label);
    }
  }

  for (const pullRequest of pullRequests.values()) {
    if (pullRequest.bodyArtifactId) {
      assertTaskArtifact(
        artifacts,
        pullRequest.taskId,
        pullRequest.bodyArtifactId,
        'pr-body',
        'pull request body artifact ownership'
      );
    }
  }

  for (const task of state.tasks) {
    const iteration = task.currentIterationId
      ? iterations.get(task.currentIterationId)
      : undefined;
    const worktree = task.currentWorktreeId
      ? worktrees.get(task.currentWorktreeId)
      : undefined;
    const session = task.currentAgentSessionId
      ? sessions.get(task.currentAgentSessionId)
      : undefined;
    const run = task.currentRunId ? runs.get(task.currentRunId) : undefined;
    assertAgentReviewOwnership(runs, artifacts, gitSnapshots, task);
    if (
      (task.currentIterationId && (!iteration || iteration.taskId !== task.id)) ||
      (task.currentWorktreeId &&
        (!worktree ||
          worktree.taskId !== task.id ||
          (iteration && worktree.iterationId !== iteration.id))) ||
      (task.currentAgentSessionId &&
        (!session ||
          session.taskId !== task.id ||
          (iteration && session.iterationId !== iteration.id) ||
          (worktree && session.worktreeId !== worktree.id))) ||
      (task.currentRunId &&
        (!run ||
          run.taskId !== task.id ||
          (iteration && run.iterationId !== iteration.id) ||
          (worktree && run.worktreeId !== worktree.id) ||
          (session && run.sessionId !== session.id)))
    ) {
      invalidPersistedRelationship('task current record');
    }
  }
}

function assertAgentReviewOwnership(
  runs: ReadonlyMap<string, RunRecord>,
  artifacts: ReadonlyMap<string, ArtifactRecord>,
  gitSnapshots: ReadonlyMap<string, GitSnapshotRecord>,
  task: Task
): void {
  const review = task.projection.agentReview;
  if (!review) return;

  const reviewRun = review.runId ? runs.get(review.runId) : undefined;
  if (
    review.runId &&
    (!reviewRun || reviewRun.taskId !== task.id || reviewRun.mode !== 'REVIEW')
  ) {
    invalidPersistedRelationship('task agent review ownership');
  }

  if (review.sourceRunId) {
    const sourceRun = runs.get(review.sourceRunId);
    if (
      !reviewRun ||
      !sourceRun ||
      sourceRun.taskId !== task.id ||
      sourceRun.iterationId !== reviewRun.iterationId ||
      sourceRun.worktreeId !== reviewRun.worktreeId ||
      !isImplementationRunMode(sourceRun.mode)
    ) {
      invalidPersistedRelationship('task agent review source ownership');
    }
  }

  if (review.reviewedGitSnapshotId) {
    const snapshot = gitSnapshots.get(review.reviewedGitSnapshotId);
    if (
      !reviewRun ||
      !snapshot ||
      snapshot.taskId !== task.id ||
      snapshot.iterationId !== reviewRun.iterationId ||
      snapshot.worktreeId !== reviewRun.worktreeId
    ) {
      invalidPersistedRelationship('task agent review snapshot ownership');
    }
  }

  if (review.finalArtifactId) {
    const artifact = artifacts.get(review.finalArtifactId);
    if (
      !reviewRun ||
      !artifact ||
      artifact.taskId !== task.id ||
      artifact.runId !== reviewRun.id ||
      artifact.kind !== 'agent-final'
    ) {
      invalidPersistedRelationship('task agent review artifact ownership');
    }
  }
}

function indexUniqueRecords<T extends { id: string }>(
  records: readonly T[],
  collection: string
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const record of records) {
    if (indexed.has(record.id)) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: ${collection} contains duplicate identifiers.`
      );
    }
    indexed.set(record.id, record);
  }
  return indexed;
}

function assertRunArtifact(
  artifacts: ReadonlyMap<string, ArtifactRecord>,
  run: RunRecord,
  artifactId: string,
  kind: ArtifactKind
): void {
  const artifact = artifacts.get(artifactId);
  if (
    !artifact ||
    artifact.taskId !== run.taskId ||
    artifact.runId !== run.id ||
    artifact.kind !== kind
  ) {
    invalidPersistedRelationship('run artifact ownership');
  }
}

function assertTaskArtifact(
  artifacts: ReadonlyMap<string, ArtifactRecord>,
  taskId: string,
  artifactId: string,
  kind: ArtifactKind,
  label: string
): void {
  const artifact = artifacts.get(artifactId);
  if (
    !artifact ||
    artifact.taskId !== taskId ||
    artifact.runId !== undefined ||
    artifact.kind !== kind
  ) {
    invalidPersistedRelationship(label);
  }
}

function assertRunGitSnapshot(
  snapshots: ReadonlyMap<string, GitSnapshotRecord>,
  run: RunRecord,
  snapshotId: string
): void {
  const snapshot = snapshots.get(snapshotId);
  if (
    !snapshot ||
    snapshot.taskId !== run.taskId ||
    snapshot.iterationId !== run.iterationId ||
    snapshot.worktreeId !== run.worktreeId
  ) {
    invalidPersistedRelationship('run git snapshot ownership');
  }
}

function assertEvidenceOwnership(
  tasks: ReadonlyMap<string, Task>,
  iterations: ReadonlyMap<string, TaskIteration>,
  worktrees: ReadonlyMap<string, WorktreeRecord>,
  record: { taskId: string; iterationId: string; worktreeId: string },
  label: string
): WorktreeRecord {
  const iteration = iterations.get(record.iterationId);
  const worktree = worktrees.get(record.worktreeId);
  if (
    !tasks.has(record.taskId) ||
    !iteration ||
    iteration.taskId !== record.taskId ||
    !worktree ||
    worktree.taskId !== record.taskId ||
    worktree.iterationId !== record.iterationId
  ) {
    invalidPersistedRelationship(label);
  }
  return worktree;
}

function invalidPersistedRelationship(label: string): never {
  throw new Error(
    `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: ${label} is inconsistent.`
  );
}

function validatePersistedRuntimeIdentity(state: StoreState): void {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const sessions = new Map(state.agentSessions.map((session) => [session.id, session]));
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  const providerSessionOwners = new Set<string>();
  const providerTurnOwners = new Set<string>();
  const interactionOccurrences = new Set<string>();
  const serverIds = new Set<string>();
  for (const server of state.agentServers) {
    if (
      !isRuntimeId(server.runtimeId) ||
      !server.id ||
      serverIds.has(server.id)
    ) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: agent server runtime identity is inconsistent.`
      );
    }
    serverIds.add(server.id);
  }
  for (const task of state.tasks) {
    if (!isRuntimeId(task.runtimeId) || task.agentSettings.runtimeId !== task.runtimeId) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: task runtime ownership is inconsistent.`
      );
    }
  }
  for (const session of state.agentSessions) {
    const task = tasks.get(session.taskId);
    if (
      !task ||
      !isRuntimeId(session.runtimeId) ||
      (session.runtimeId !== task.runtimeId &&
        !belongsToDetachedReviewLineage(session, sessions)) ||
      session.requestedSettings.runtimeId !== session.runtimeId ||
      (session.observedSettings?.runtimeId !== undefined &&
        session.observedSettings.runtimeId !== session.runtimeId)
    ) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: session runtime ownership is inconsistent.`
      );
    }
    if (session.providerSessionId) {
      const providerKey = `${session.runtimeId}\u0000${session.providerSessionId}`;
      if (providerSessionOwners.has(providerKey)) {
        throw new Error(
          `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: provider session identity is duplicated within a runtime.`
        );
      }
      providerSessionOwners.add(providerKey);
    }
  }
  for (const run of state.runs) {
    const task = tasks.get(run.taskId);
    const session = sessions.get(run.sessionId);
    if (
      !task ||
      !session ||
      !isRuntimeId(run.runtimeId) ||
      run.runtimeId !== session.runtimeId ||
      (run.runtimeId !== task.runtimeId &&
        !(
          (run.mode === 'REVIEW' && session.role === 'REVIEW') ||
          (run.mode === 'SUBAGENT' &&
            session.role === 'SUBAGENT' &&
            belongsToDetachedReviewLineage(session, sessions))
        )) ||
      run.requestedSettings.runtimeId !== run.runtimeId ||
      (run.observedSettings?.runtimeId !== undefined &&
        run.observedSettings.runtimeId !== run.runtimeId)
    ) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: run runtime ownership is inconsistent.`
      );
    }
    if (run.serverInstanceId) {
      assertServerRuntime(state, run.runtimeId, run.serverInstanceId, 'Persisted run');
    }
    if (run.providerTurnId) {
      const providerKey = `${run.runtimeId}\u0000${run.providerTurnId}`;
      if (providerTurnOwners.has(providerKey)) {
        throw new Error(
          `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: provider turn identity is duplicated within a runtime.`
        );
      }
      providerTurnOwners.add(providerKey);
    }
  }
  for (const interaction of state.interactionRequests) {
    const occurrence = interactionOccurrenceIdentity(interaction);
    if (interactionOccurrences.has(occurrence)) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: interaction occurrence identity is duplicated.`
      );
    }
    interactionOccurrences.add(occurrence);
    const run = runs.get(interaction.runId);
    const session = sessions.get(interaction.sessionId);
    if (
      !run ||
      !session ||
      interaction.runtimeId !== run.runtimeId ||
      interaction.runtimeId !== session.runtimeId ||
      interaction.taskId !== run.taskId ||
      interaction.taskId !== session.taskId ||
      interaction.iterationId !== run.iterationId ||
      interaction.iterationId !== session.iterationId ||
      interaction.sessionId !== run.sessionId ||
      (['PENDING', 'RESPONDING'].includes(interaction.status) &&
        interaction.serverInstanceId !== run.serverInstanceId) ||
      interaction.requestRawMessage.serverInstanceId !== interaction.serverInstanceId ||
      (interaction.responseRawMessage !== undefined &&
        interaction.responseRawMessage.serverInstanceId !== interaction.serverInstanceId)
    ) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: interaction runtime ownership is inconsistent.`
      );
    }
    assertServerRuntime(
      state,
      interaction.runtimeId,
      interaction.serverInstanceId,
      'Persisted interaction'
    );
    assertProtocolReferenceRuntime(
      state,
      interaction.runtimeId,
      interaction.requestRawMessage,
      'Persisted interaction request'
    );
    if (interaction.responseRawMessage) {
      assertProtocolReferenceRuntime(
        state,
        interaction.runtimeId,
        interaction.responseRawMessage,
        'Persisted interaction response'
      );
    }
  }
  for (const record of state.agentGoalSnapshots) {
    assertRuntimeOwnedAgentRecord(state, record, 'Persisted agent goal snapshot');
  }
  for (const record of state.agentPlanRevisions) {
    assertRuntimeOwnedAgentRecord(
      state,
      record,
      'Persisted agent plan revision',
      true
    );
  }
  for (const record of state.agentUsageSnapshots) {
    assertRuntimeOwnedAgentRecord(state, record, 'Persisted agent usage snapshot');
  }
  for (const record of state.agentSettingsObservations) {
    assertRuntimeOwnedAgentRecord(
      state,
      record,
      'Persisted agent settings observation'
    );
    if (record.settings.runtimeId !== record.runtimeId) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: settings observation runtime is inconsistent.`
      );
    }
  }
  for (const item of state.agentItems) {
    const run = runs.get(item.runId);
    if (
      !run ||
      run.taskId !== item.taskId ||
      run.iterationId !== item.iterationId ||
      run.sessionId !== item.sessionId
    ) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: agent item ownership is inconsistent.`
      );
    }
    if (item.rawMessage) {
      assertProtocolReferenceRuntime(
        state,
        run.runtimeId,
        item.rawMessage,
        'Persisted agent item'
      );
    }
  }
  for (const observation of state.agentSubagentObservations) {
    const child = sessions.get(observation.sessionId);
    const parent = sessions.get(observation.parentSessionId);
    const parentRun = observation.parentRunId
      ? runs.get(observation.parentRunId)
      : undefined;
    if (
      !child ||
      !parent ||
      child.role !== 'SUBAGENT' ||
      observation.runtimeId !== child.runtimeId ||
      observation.runtimeId !== parent.runtimeId ||
      observation.taskId !== child.taskId ||
      observation.taskId !== parent.taskId ||
      observation.iterationId !== child.iterationId ||
      observation.iterationId !== parent.iterationId ||
      (observation.parentRunId &&
        (!parentRun || parentRun.sessionId !== parent.id))
    ) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: subagent observation ownership is inconsistent.`
      );
    }
    assertProtocolReferenceRuntime(
      state,
      observation.runtimeId,
      observation.rawMessage,
      'Persisted subagent observation'
    );
  }
}

function belongsToDetachedReviewLineage(
  session: AgentSessionRecord,
  sessions: ReadonlyMap<string, AgentSessionRecord>
): boolean {
  if (session.role === 'REVIEW') return true;
  if (session.role !== 'SUBAGENT') return false;

  const visited = new Set<string>([session.id]);
  let child = session;
  while (child.role === 'SUBAGENT' && child.parentSessionId) {
    const parent = sessions.get(child.parentSessionId);
    if (
      !parent ||
      visited.has(parent.id) ||
      parent.taskId !== child.taskId ||
      parent.iterationId !== child.iterationId ||
      parent.worktreeId !== child.worktreeId ||
      parent.runtimeId !== child.runtimeId
    ) {
      return false;
    }
    if (parent.role === 'REVIEW') return true;
    visited.add(parent.id);
    child = parent;
  }
  return false;
}

function assertRuntimeOwnedAgentRecord(
  state: StoreState,
  record: {
    taskId: string;
    iterationId: string;
    sessionId: string;
    runId?: string;
    runtimeId: string;
    rawMessage?: AgentProtocolMessageReference;
  },
  label: string,
  requireRun = false
): void {
  const session = state.agentSessions.find(
    (candidate) => candidate.id === record.sessionId
  );
  if (
    !session ||
    !isRuntimeId(record.runtimeId) ||
    session.taskId !== record.taskId ||
    session.iterationId !== record.iterationId ||
    session.runtimeId !== record.runtimeId
  ) {
    throw new Error(`${label} ownership does not match its agent session.`);
  }
  if (requireRun && !record.runId) {
    throw new Error(`${label} must belong to an agent run.`);
  }
  if (record.runId) {
    const run = state.runs.find((candidate) => candidate.id === record.runId);
    if (
      !run ||
      run.taskId !== record.taskId ||
      run.iterationId !== record.iterationId ||
      run.sessionId !== record.sessionId ||
      run.runtimeId !== record.runtimeId
    ) {
      throw new Error(`${label} ownership does not match its agent run.`);
    }
  }
  if (record.rawMessage) {
    assertProtocolReferenceRuntime(
      state,
      record.runtimeId,
      record.rawMessage,
      label
    );
  }
}

function validatePersistedBoards(state: StoreState): void {
  const boardIds = new Set<string>();
  for (const board of state.boards) {
    try {
      if (typeof board.id !== 'string' || !board.id || boardIds.has(board.id)) {
        throw new Error('invalid board id');
      }
      if (typeof board.createdAt !== 'string' || typeof board.updatedAt !== 'string') {
        throw new Error('invalid board timestamps');
      }
      validateBoardInput(board, state.repositories);
      boardIds.add(board.id);
    } catch {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: boards contains an invalid record.`
      );
    }
  }
}

function validatePersistedRepositoryReferences(state: StoreState): void {
  const repositoryIds = new Set<string>();
  for (const repository of state.repositories) {
    if (
      typeof repository.id !== 'string' ||
      !repository.id ||
      repositoryIds.has(repository.id) ||
      typeof repository.path !== 'string' ||
      !repository.path ||
      !['USER_REGISTERED', 'DESIGN_MANAGED'].includes(repository.kind) ||
      !['AVAILABLE', 'MISSING', 'INVALID', 'DISCONNECTED'].includes(repository.status)
    ) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: repositories contains an invalid record.`
      );
    }
    repositoryIds.add(repository.id);
  }
  if (
    state.tasks.some(
      (task) =>
        !repositoryIds.has(task.repositoryId) ||
        !Array.isArray(task.forkedAlternativeTaskIds) ||
        !task.forkedAlternativeTaskIds.every((taskId) => typeof taskId === 'string')
    ) ||
    state.worktrees.some((worktree) => !repositoryIds.has(worktree.repositoryId))
  ) {
    throw new Error(
      `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: a task or worktree references an unknown repository.`
    );
  }
}

function validatePersistedDesignRelationships(state: StoreState): void {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const repositories = new Map(
    state.repositories.map((repository) => [repository.id, repository])
  );
  const artifacts = indexUniqueRecords(state.artifacts, 'artifacts');
  const attachments = indexUniqueRecords(state.attachments, 'attachments');
  const runs = indexUniqueRecords(state.runs, 'runs');
  const references = indexUniqueRecords(state.designReferences, 'designReferences');
  const turns = indexUniqueRecords(state.designTurns, 'designTurns');
  const revisions = indexUniqueRecords(state.designRevisions, 'designRevisions');
  const designRunKeys = new Set<string>();

  for (const task of state.tasks) {
    const repository = repositories.get(task.repositoryId);
    if (
      task.kind === 'DESIGN' &&
      (repository?.kind !== 'DESIGN_MANAGED' ||
        !['READY', 'ARCHIVED'].includes(task.workflowPhase) ||
        task.completionPolicy !== 'MANUAL' ||
        task.runtimeId !== CODEX_RUNTIME_ID ||
        !hasRestrictedDesignRequestedSettings(task.agentSettings) ||
        !state.designTurns.some((turn) => turn.designId === task.id))
    ) {
      invalidPersistedRelationship('Design task ownership');
    }
    if (task.kind === 'NORMAL' && repository?.kind !== 'USER_REGISTERED') {
      invalidPersistedRelationship('normal task repository ownership');
    }
  }
  for (const repository of state.repositories) {
    if (repository.kind !== 'DESIGN_MANAGED') continue;
    const owners = state.tasks.filter((task) => task.repositoryId === repository.id);
    if (owners.length !== 1 || owners[0]?.kind !== 'DESIGN') {
      invalidPersistedRelationship('managed Design repository ownership');
    }
  }

  for (const session of state.agentSessions) {
    const task = tasks.get(session.taskId);
    if (
      task?.kind === 'DESIGN' &&
      (!hasRestrictedDesignRequestedSettings(session.requestedSettings) ||
        hasContradictoryDesignObservedSettings(session.observedSettings))
    ) {
      invalidPersistedRelationship('Design session execution policy');
    }
  }

  for (const run of state.runs) {
    const task = tasks.get(run.taskId);
    if (!task) continue;
    if (
      task.kind === 'DESIGN' &&
      (!hasRestrictedDesignRequestedSettings(run.requestedSettings) ||
        hasContradictoryDesignObservedSettings(run.observedSettings))
    ) {
      invalidPersistedRelationship('Design Run execution policy');
    }
    if (run.mode === 'DESIGN') {
      const turn = run.generationKey ? turns.get(run.generationKey) : undefined;
      const key = `${run.taskId}:${run.generationKey ?? ''}`;
      if (
        task.kind !== 'DESIGN' ||
        !turn ||
        turn.designId !== task.id ||
        designRunKeys.has(key)
      ) {
        invalidPersistedRelationship('Design Run generation ownership');
      }
      designRunKeys.add(key);
    } else if (task.kind === 'DESIGN' && run.origin !== 'PROVIDER_SUBAGENT') {
      invalidPersistedRelationship('Design Run mode');
    }
  }

  const turnsByDesign = new Map<string, DesignTurn[]>();
  for (const turn of state.designTurns) {
    const design = tasks.get(turn.designId);
    if (design?.kind !== 'DESIGN') {
      invalidPersistedRelationship('Design turn owner');
    }
    const hasValidMessageLineage =
      turn.messageSource === 'TASK_PROMPT'
        ? turn.order === 1 &&
          turn.messageArtifactId === undefined &&
          turn.clientMessageId === design.creationToken
        : turn.order > 1 && turn.messageArtifactId !== undefined;
    if (
      !hasValidMessageLineage ||
      new Set(turn.referenceIds).size !== turn.referenceIds.length ||
      (turn.attachmentDraftId !== undefined &&
        !turn.referenceIds.some(
          (referenceId) =>
            references.get(referenceId)?.sourceDraftId === turn.attachmentDraftId
        ))
    ) {
      invalidPersistedRelationship('Design turn lineage');
    }
    const ownerTurns = turnsByDesign.get(turn.designId) ?? [];
    if (
      ownerTurns.some(
        (existing) =>
          existing.clientMessageId === turn.clientMessageId ||
          existing.order === turn.order
      )
    ) {
      invalidPersistedRelationship('Design turn ordering');
    }
    ownerTurns.push(turn);
    turnsByDesign.set(turn.designId, ownerTurns);

    if (turn.messageArtifactId) {
      assertTaskArtifact(
        artifacts,
        turn.designId,
        turn.messageArtifactId,
        'design-message',
        'Design message artifact ownership'
      );
    }
    if (
      turn.referenceIds.some((referenceId) => {
        const reference = references.get(referenceId);
        return !reference || reference.designId !== turn.designId;
      })
    ) {
      invalidPersistedRelationship('Design turn reference ownership');
    }
    if (turn.runId) {
      const run = runs.get(turn.runId);
      if (
        !run ||
        run.taskId !== turn.designId ||
        run.mode !== 'DESIGN' ||
        run.generationKey !== turn.id
      ) {
        invalidPersistedRelationship('Design turn Run ownership');
      }
    }
    validatePersistedDesignCheckpoint(state, design, turn, runs.get(turn.runId ?? ''));
  }
  for (const ownerTurns of turnsByDesign.values()) {
    const orders = ownerTurns.map((turn) => turn.order).sort((a, b) => a - b);
    const unsettled = ownerTurns.filter((turn) => turn.outcome === undefined);
    if (
      orders.some((order, index) => order !== index + 1) ||
      unsettled.filter((turn) => turn.runId !== undefined).length > 1 ||
      unsettled.filter((turn) => turn.runId === undefined).length >
        DESIGN_LIMITS.queuedTurns
    ) {
      invalidPersistedRelationship('Design turn sequence');
    }
  }

  for (const reference of state.designReferences) {
    const design = tasks.get(reference.designId);
    const attachment = attachments.get(reference.attachmentId);
    if (
      design?.kind !== 'DESIGN' ||
      !attachment ||
      attachment.taskId !== design.id ||
      (reference.projectAssetPath !== undefined &&
        !isSafeDesignProjectPath(reference.projectAssetPath)) ||
      (reference.firstDeliveredAt !== undefined &&
        !state.designTurns.some((turn) => {
          if (!turn.referenceIds.includes(reference.id) || !turn.runId) return false;
          const run = runs.get(turn.runId);
          return run?.attachmentSubmissions?.some(
            (submission) =>
              submission.attachmentId === reference.attachmentId &&
              submission.submittedAt === reference.firstDeliveredAt
          );
        }))
    ) {
      invalidPersistedRelationship('Design reference ownership');
    }
  }
  for (const attachment of state.attachments) {
    const task = tasks.get(attachment.taskId);
    if (task?.kind !== 'DESIGN') continue;
    if (
      state.designReferences.filter(
        (reference) => reference.attachmentId === attachment.id
      ).length !== 1
    ) {
      invalidPersistedRelationship('Design attachment reference ownership');
    }
  }

  const revisionsByDesign = new Map<string, DesignRevision[]>();
  for (const revision of state.designRevisions) {
    const design = tasks.get(revision.designId);
    const turn = turns.get(revision.turnId);
    const run = runs.get(revision.runId);
    if (
      design?.kind !== 'DESIGN' ||
      revision.changeSource !== 'AGENT_TURN' ||
      !turn ||
      turn.designId !== design.id ||
      turn.outcome !== 'READY' ||
      !run ||
      run.taskId !== design.id ||
      run.id !== turn.runId ||
      run.mode !== 'DESIGN'
    ) {
      invalidPersistedRelationship('Design revision ownership');
    }
    const ownerRevisions = revisionsByDesign.get(revision.designId) ?? [];
    if (
      ownerRevisions.some(
        (existing) =>
          existing.ordinal === revision.ordinal ||
          existing.turnId === revision.turnId ||
          existing.runId === revision.runId
      )
    ) {
      invalidPersistedRelationship('Design revision identity');
    }
    ownerRevisions.push(revision);
    revisionsByDesign.set(revision.designId, ownerRevisions);
  }
  for (const ownerRevisions of revisionsByDesign.values()) {
    const ordinals = ownerRevisions
      .map((revision) => revision.ordinal)
      .sort((a, b) => a - b);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1)) {
      invalidPersistedRelationship('Design revision sequence');
    }
  }

  for (const generation of state.previewGenerations) {
    if (generation.source.type !== 'EXACT_COMMIT') continue;
    const task = tasks.get(generation.taskId);
    const repository = repositories.get(generation.source.repositoryId);
    const revision = generation.source.designRevisionId
      ? revisions.get(generation.source.designRevisionId)
      : undefined;
    if (
      task?.kind !== 'DESIGN' ||
      repository?.id !== task.repositoryId ||
      (generation.routingState === 'ACTIVE' &&
        generation.state === 'READY' &&
        !revision) ||
      (revision &&
        (revision.designId !== task.id ||
          revision.commitSha !== generation.source.commitSha))
    ) {
      invalidPersistedRelationship('Design Preview source ownership');
    }
  }
}

function hasRestrictedDesignRequestedSettings(
  settings: AgentExecutionSettings
): boolean {
  return (
    settings.runtimeId === CODEX_RUNTIME_ID &&
    settings.sandbox === 'WORKSPACE_WRITE' &&
    settings.networkAccess === false &&
    settings.approvalPolicy === 'never' &&
    settings.approvalsReviewer === 'user'
  );
}

function hasContradictoryDesignObservedSettings(
  settings: AgentExecutionSettings | undefined
): boolean {
  if (!settings) return false;
  return (
    (settings.runtimeId !== undefined && settings.runtimeId !== CODEX_RUNTIME_ID) ||
    (settings.sandbox !== undefined && settings.sandbox !== 'WORKSPACE_WRITE') ||
    (settings.networkAccess !== undefined && settings.networkAccess !== false) ||
    (settings.approvalPolicy !== undefined && settings.approvalPolicy !== 'never') ||
    (settings.approvalsReviewer !== undefined && settings.approvalsReviewer !== 'user')
  );
}

function validatePersistedDesignCheckpoint(
  state: StoreState,
  design: Task,
  turn: DesignTurn,
  run: RunRecord | undefined
): void {
  const checkpoint = turn.checkpoint;
  if (turn.outcome !== undefined) {
    if (checkpoint || turn.finalOpenedCandidate) {
      invalidPersistedRelationship('settled Design turn checkpoint');
    }
    return;
  }
  if (!checkpoint) invalidPersistedRelationship('unsettled Design turn checkpoint');
  if (checkpoint.boundary === 'QUEUED') {
    if (turn.runId) invalidPersistedRelationship('queued Design turn Run link');
    return;
  }
  if (!run) invalidPersistedRelationship('Design checkpoint Run ownership');
  if (turn.finalOpenedCandidate) {
    const opened = turn.finalOpenedCandidate;
    const source = opened.source;
    const worktree = state.worktrees.find(
      (candidate) =>
        candidate.id === source.worktreeId &&
        candidate.id === design.currentWorktreeId &&
        candidate.taskId === design.id &&
        candidate.repositoryId === design.repositoryId &&
        candidate.branchName === source.branchName
    );
    const generation = state.previewGenerations.find(
      (candidate) => candidate.id === opened.previewGenerationId
    );
    if (
      source.repositoryId !== design.repositoryId ||
      !worktree ||
      !generation ||
      generation.taskId !== design.id ||
      generation.source.type !== 'EXACT_COMMIT' ||
      generation.source.repositoryId !== design.repositoryId ||
      generation.source.commitSha !== source.candidateCommitSha ||
      generation.source.designRevisionId !== undefined ||
      !(
        (generation.state === 'READY' && generation.routingState === 'CANDIDATE') ||
        generation.state === 'STOPPED' ||
        generation.state === 'FAILED'
      )
    ) {
      invalidPersistedRelationship('opened Design candidate ownership');
    }
  }
  if (checkpoint.boundary === 'RUN_LINKED') return;
  if (checkpoint.boundary === 'POST_RUN_EVIDENCE_RECORDED') {
    const snapshot = state.gitSnapshots.find(
      (candidate) =>
        candidate.id === checkpoint.gitSnapshotId &&
        candidate.taskId === design.id &&
        candidate.worktreeId === design.currentWorktreeId &&
        candidate.id === run.afterGitSnapshotId
    );
    if (!snapshot) invalidPersistedRelationship('Design checkpoint Git evidence ownership');
    return;
  }
  if (checkpoint.boundary === 'PREVIEW_CANDIDATE_READY') {
    const generation = state.previewGenerations.find(
      (candidate) => candidate.id === checkpoint.previewGenerationId
    );
    if (!generation) return;
    const sourceMatches =
      generation.taskId === design.id &&
      generation.source.type === 'EXACT_COMMIT' &&
      generation.source.repositoryId === design.repositoryId &&
      generation.source.commitSha === checkpoint.commitSha &&
      generation.source.designRevisionId === undefined;
    const readyCandidate =
      generation.state === 'READY' && generation.routingState === 'CANDIDATE';
    const unavailableCandidate =
      generation.state === 'STOPPED' || generation.state === 'FAILED';
    if (!sourceMatches || (!readyCandidate && !unavailableCandidate)) {
      invalidPersistedRelationship('Design checkpoint Preview ownership');
    }
    return;
  }

  const source = checkpoint.source;
  const worktree = state.worktrees.find(
    (candidate) =>
      candidate.id === source.worktreeId &&
      candidate.id === design.currentWorktreeId &&
      candidate.taskId === design.id &&
      candidate.repositoryId === design.repositoryId &&
      candidate.branchName === source.branchName
  );
  if (source.repositoryId !== design.repositoryId || !worktree) {
    invalidPersistedRelationship('Design checkpoint source ownership');
  }
}

function assertServerRuntime(
  state: StoreState,
  runtimeId: string,
  serverInstanceId: string,
  label: string
): void {
  const server = state.agentServers.find(
    (candidate) => candidate.id === serverInstanceId
  );
  if (!server || server.runtimeId !== runtimeId) {
    throw new Error(`${label} server runtime ownership is inconsistent.`);
  }
}

function assertProtocolReferenceRuntime(
  state: StoreState,
  runtimeId: string,
  reference: AgentProtocolMessageReference,
  label: string
): void {
  assertServerRuntime(state, runtimeId, reference.serverInstanceId, label);
}

function isRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function validatePersistedTaskCreationMetadata(state: StoreState): void {
  const tokens = new Set<string>();
  for (const task of state.tasks) {
    const token = task.creationToken;
    const fingerprint = task.creationRequestFingerprint;
    const hasToken = token !== undefined;
    const hasFingerprint = fingerprint !== undefined;
    if (!hasToken && !hasFingerprint) {
      continue;
    }
    if (
      !hasToken ||
      !hasFingerprint ||
      !isTaskCreationToken(token) ||
      typeof fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(fingerprint) ||
      tokens.has(token) ||
      task.forkedFromTaskId !== undefined ||
      task.forkedFromRunId !== undefined
    ) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: tasks contains invalid creation retry metadata.`
      );
    }
    tokens.add(token);
  }
}

function validatePersistedAttachments(state: StoreState): void {
  const taskIds = new Set(state.tasks.map((task) => task.id));
  const attachmentIds = new Set<string>();
  const byTask = new Map<string, TaskAttachmentRecord[]>();
  for (const attachment of state.attachments) {
    if (!taskIds.has(attachment.taskId) || attachmentIds.has(attachment.id)) {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: attachments contains an invalid record.`
      );
    }
    attachmentIds.add(attachment.id);
    byTask.set(attachment.taskId, [
      ...(byTask.get(attachment.taskId) ?? []),
      attachment
    ]);
  }
  for (const [taskId, attachments] of byTask) {
    try {
      validateTaskAttachmentRecords(attachments, taskId);
    } catch {
      throw new Error(
        `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid: attachments contains an invalid record.`
      );
    }
  }
}

function utf8SafePrefixLength(buffer: Buffer, endOfFile: boolean): number {
  if (endOfFile || buffer.length === 0) return buffer.length;
  let start = buffer.length - 1;
  while (start > 0 && (buffer[start] & 0xc0) === 0x80) start -= 1;
  const lead = buffer[start];
  const expected =
    (lead & 0x80) === 0 ? 1 :
    (lead & 0xe0) === 0xc0 ? 2 :
    (lead & 0xf0) === 0xe0 ? 3 :
    (lead & 0xf8) === 0xf0 ? 4 : 1;
  return buffer.length - start < expected ? start : buffer.length;
}

function removeTaskLink(task: Task, deletedTaskId: string, now: string): Task {
  const forkedAlternativeTaskIds = task.forkedAlternativeTaskIds.filter(
    (alternativeTaskId) => alternativeTaskId !== deletedTaskId
  );
  const removedAlternative =
    forkedAlternativeTaskIds.length !== task.forkedAlternativeTaskIds.length;
  const removedSource = task.forkedFromTaskId === deletedTaskId;

  if (!removedAlternative && !removedSource) {
    return task;
  }

  return {
    ...task,
    forkedAlternativeTaskIds,
    forkedFromTaskId: removedSource ? undefined : task.forkedFromTaskId,
    forkedFromRunId: removedSource ? undefined : task.forkedFromRunId,
    updatedAt: now
  };
}

function eventBelongsToDeletedTask(
  event: DomainEvent,
  taskId: string,
  ids: {
    runIds: Set<string>;
    sessionIds: Set<string>;
    worktreeIds: Set<string>;
  }
): boolean {
  if (event.taskId === taskId) {
    return true;
  }
  if (event.runId && ids.runIds.has(event.runId)) {
    return true;
  }
  if (event.agentSessionId && ids.sessionIds.has(event.agentSessionId)) {
    return true;
  }
  if (event.worktreeId && ids.worktreeIds.has(event.worktreeId)) {
    return true;
  }
  return false;
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function clone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectDesignListItem(state: StoreState, task: Task): DesignListItem {
  const turns = state.designTurns
    .filter((turn) => turn.designId === task.id)
    .sort((left, right) => left.order - right.order);
  const latestTurn = turns.at(-1);
  const latestRevision = state.designRevisions
    .filter((revision) => revision.designId === task.id)
    .sort((left, right) => left.ordinal - right.ordinal)
    .at(-1);
  const run = latestTurn?.runId
    ? state.runs.find((candidate) => candidate.id === latestTurn.runId)
    : undefined;
  const needsInput = state.interactionRequests.some(
    (interaction) =>
      interaction.taskId === task.id &&
      (interaction.status === 'PENDING' || interaction.status === 'RESPONDING')
  );
  const activeRun =
    run &&
    [
      'QUEUED',
      'STARTING',
      'RUNNING',
      'AWAITING_APPROVAL',
      'AWAITING_USER_INPUT',
      'INTERRUPTING',
      'RECOVERY_REQUIRED'
    ].includes(run.status);
  const currentPreview = selectCurrentDesignPreview(state, task.id, latestRevision);
  const previewNeedsRestart = Boolean(
    latestRevision &&
      !(
        currentPreview?.state === 'READY' &&
        currentPreview.routingState === 'ACTIVE'
      )
  );
  const status: DesignListItem['status'] = needsInput
    ? 'NEEDS_INPUT'
    : latestTurn?.outcome === 'FAILED' ||
        latestTurn?.outcome === 'NEEDS_ATTENTION' ||
        (latestTurn?.outcome === 'CANCELED' && !latestRevision) ||
        previewNeedsRestart
      ? 'NEEDS_ATTENTION'
      : latestTurn?.outcome === undefined || activeRun
        ? latestRevision
          ? 'UPDATING'
          : 'STARTING'
        : latestRevision
          ? 'READY'
          : 'STARTING';
  const updatedAt = [
    task.updatedAt,
    latestTurn?.settledAt,
    latestTurn?.createdAt,
    latestRevision?.createdAt,
    run?.lastEventAt,
    run?.endedAt
  ]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)!;
  return {
    id: task.id,
    title: task.title,
    runtimeId: task.runtimeId,
    status,
    latestRevision,
    updatedAt
  };
}

async function projectDesignConversationPage(
  state: StoreState,
  task: Task,
  input: Pick<ListDesignConversationRequest, 'beforeCursor' | 'limit'>
): Promise<DesignConversationPage> {
  const limit = input.limit ?? DESIGN_LIMITS.transcriptPageSize;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > DESIGN_LIMITS.transcriptPageSize
  ) {
    throw new Error('Design conversation page limit is invalid.');
  }
  const beforeOrder = decodeDesignConversationCursor(input.beforeCursor);
  const allTurns = state.designTurns
    .filter(
      (turn) =>
        turn.designId === task.id &&
        (beforeOrder === undefined || turn.order < beforeOrder)
    )
    .sort((left, right) => left.order - right.order);
  const turns = allTurns.slice(-limit);
  const entries = await Promise.all(
    turns.map((turn) => projectDesignConversationEntry(state, task, turn))
  );
  return {
    entries,
    ...(allTurns.length > turns.length && turns[0]
      ? { previousCursor: encodeDesignConversationCursor(turns[0].order) }
      : {})
  };
}

async function projectDesignConversationEntry(
  state: StoreState,
  task: Task,
  turn: DesignTurn
): Promise<DesignConversationEntry> {
  const run = turn.runId
    ? state.runs.find((candidate) => candidate.id === turn.runId)
    : undefined;
  const artifact = turn.messageArtifactId
    ? state.artifacts.find((candidate) => candidate.id === turn.messageArtifactId)
    : undefined;
  return {
    turn,
    userMessage:
      turn.messageSource === 'TASK_PROMPT'
        ? task.prompt
        : artifact
          ? await readPrivateArtifactFile(artifact.path, artifact.byteCount)
          : '',
    assistantMessage: run?.finalMessage,
    runStatus: run?.status
  };
}

function encodeDesignConversationCursor(order: number): string {
  return Buffer.from(`order:${order}`, 'utf8').toString('base64url');
}

function decodeDesignConversationCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^order:(\d+)$/u.exec(decoded);
  const order = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(order) || order < 1) {
    throw new Error('Design conversation cursor is invalid.');
  }
  return order;
}

function selectCurrentDesignPreview(
  state: StoreState,
  designId: string,
  latestRevision: DesignRevision | undefined
): PreviewGenerationRecord | undefined {
  if (!latestRevision) return undefined;
  const matching = state.previewGenerations
    .filter(
      (generation) =>
        generation.taskId === designId &&
        generation.source.type === 'EXACT_COMMIT' &&
        generation.source.designRevisionId === latestRevision.id
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return (
    matching.find(
      (generation) =>
        generation.routingState === 'ACTIVE' && generation.state === 'READY'
    ) ?? matching[0]
  );
}

function projectDesignCanvas(
  state: StoreState,
  task: Task,
  latestRevision: DesignRevision | undefined,
  currentPreview: PreviewGenerationRecord | undefined
): DesignDetailSnapshot['canvas'] {
  const route =
    currentPreview?.routingState === 'ACTIVE' && currentPreview.state === 'READY'
      ? currentPreview.routes.find(
          (candidate) =>
            candidate.id === latestRevision?.routeId && candidate.state === 'ATTACHED'
        )
      : undefined;
  if (currentPreview && route) {
    return {
      state: 'READY',
      target: { generationId: currentPreview.id, routeId: route.id }
    };
  }
  if (latestRevision) {
    return {
      state: 'RESTART_REQUIRED',
      detail: 'The last ready revision needs a new Preview process.'
    };
  }
  if (
    state.designTurns.some(
      (turn) => turn.designId === task.id && turn.outcome === undefined
    )
  ) {
    return { state: 'UPDATING' };
  }
  return { state: 'EMPTY' };
}

function projectDesignActions(
  state: StoreState,
  task: Task,
  latestRevision: DesignRevision | undefined,
  currentPreview: PreviewGenerationRecord | undefined
): DesignDetailSnapshot['actions'] {
  const unsettledTurns = state.designTurns
    .filter((turn) => turn.designId === task.id && turn.outcome === undefined)
    .sort((left, right) => left.order - right.order);
  const queuedTurnCount = unsettledTurns.filter((turn) => !turn.runId).length;
  const canRefine =
    task.workflowPhase === 'READY' && queuedTurnCount < DESIGN_LIMITS.queuedTurns;
  const previewIsReady =
    currentPreview?.routingState === 'ACTIVE' && currentPreview.state === 'READY';
  const currentRun = task.currentRunId
    ? state.runs.find((run) => run.id === task.currentRunId)
    : undefined;
  const activeRun =
    currentRun &&
    [
      'QUEUED',
      'STARTING',
      'RUNNING',
      'AWAITING_APPROVAL',
      'AWAITING_USER_INPUT',
      'INTERRUPTING',
      'RECOVERY_REQUIRED'
    ].includes(currentRun.status)
      ? currentRun
      : undefined;
  const stopTurn = activeRun
    ? unsettledTurns.find((turn) => turn.runId === activeRun.id)
    : undefined;
  const canStop = Boolean(stopTurn && activeRun?.status !== 'INTERRUPTING');
  const canDelete = unsettledTurns.length === 0 && !activeRun;
  return {
    canRefine,
    refineDisabledReason: canRefine
      ? undefined
      : task.workflowPhase !== 'READY'
        ? 'This Design is archived.'
        : 'The Design message queue is full.',
    queuedTurnCount,
    canStop,
    stopTurnId: canStop ? stopTurn?.id : undefined,
    canRestart: Boolean(latestRevision && !previewIsReady),
    canDelete,
    deleteDisabledReason: canDelete
      ? undefined
      : 'Stop and settle the current Design turn before deletion.'
  };
}

function assertDesignCheckpointTransition(
  current: DesignTurnCheckpoint | undefined,
  next: DesignTurnCheckpoint
): void {
  const allowed: Record<DesignTurnCheckpoint['boundary'], DesignTurnCheckpoint['boundary'][]> = {
    QUEUED: ['RUN_LINKED'],
    RUN_LINKED: ['POST_RUN_EVIDENCE_RECORDED'],
    POST_RUN_EVIDENCE_RECORDED: ['SOURCE_CAPTURED', 'PREVIEW_CANDIDATE_READY'],
    SOURCE_CAPTURED: ['REF_UPDATED_INDEX_PENDING'],
    REF_UPDATED_INDEX_PENDING: ['INDEX_REPAIRED'],
    INDEX_REPAIRED: ['PREVIEW_CANDIDATE_READY'],
    PREVIEW_CANDIDATE_READY: []
  };
  if (!current || !allowed[current.boundary].includes(next.boundary)) {
    throw new Error(
      `Invalid Design turn checkpoint transition: ${current?.boundary ?? 'NONE'} -> ${next.boundary}`
    );
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function isGitObjectId(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function projectBoardTask(task: Task): BoardTaskSummary {
  const review = task.projection.agentReview;
  const findingCounts: BoardTaskSummary['projection']['agentReview']['findingCounts'] = {};
  for (const finding of review?.result?.findings ?? []) {
    findingCounts[finding.severity] = (findingCounts[finding.severity] ?? 0) + 1;
  }
  return {
    id: task.id,
    title: task.title,
    repositoryId: task.repositoryId,
    workflowPhase: task.workflowPhase,
    completionPolicy: task.completionPolicy,
    currentRunId: task.currentRunId,
    forkedFromTaskId: task.forkedFromTaskId,
    updatedAt: task.updatedAt,
    projection: {
      agentRun: task.projection.agentRun,
      worktree: task.projection.worktree,
      git: task.projection.git,
      githubPullRequest: task.projection.githubPullRequest,
      githubPullRequestNumber: task.projection.githubPullRequestNumber,
      ciChecks: task.projection.ciChecks,
      reviews: task.projection.reviews,
      merge: task.projection.merge,
      health: task.projection.health,
      summary: task.projection.summary,
      implementationRetry: task.projection.implementationRetry,
      updatedAt: task.projection.updatedAt,
      agentReview: {
        status: review?.status ?? 'NOT_RUN',
        runId: review?.runId,
        hasResult: Boolean(review?.result),
        findingCounts
      }
    }
  };
}

function selectPreviewTaskRouteOptions(
  state: StoreState,
  consumerTaskId: string
): TaskDetailSnapshot['previewTaskRoutes'] {
  const options: TaskDetailSnapshot['previewTaskRoutes'] = [];
  for (const task of state.tasks) {
    if (task.id === consumerTaskId) continue;
    const plan = state.previewPlans
      .filter(
        (candidate) =>
          candidate.taskId === task.id &&
          candidate.iterationId === task.currentIterationId
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!plan) continue;
    const activeGeneration = state.previewGenerations.find(
      (candidate) =>
        candidate.taskId === task.id &&
        candidate.iterationId === task.currentIterationId &&
        candidate.routingState === 'ACTIVE' &&
        candidate.state === 'READY'
    );
    for (const route of plan.executionPlan.routes) {
      options.push({
        taskId: task.id,
        taskTitle: task.title,
        routeId: route.id,
        available: Boolean(
          activeGeneration?.routes.some(
            (candidate) => candidate.id === route.id && candidate.state === 'ATTACHED'
          )
        )
      });
    }
  }
  return options.sort(
    (left, right) =>
      left.taskTitle.localeCompare(right.taskTitle) ||
      left.routeId.localeCompare(right.routeId)
  );
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values)];
}

function validateAgentServerTransition(
  current: AgentServerStatus,
  next: AgentServerStatus | undefined
): void {
  if (!next || next === current) {
    return;
  }
  const allowed: Record<AgentServerStatus, AgentServerStatus[]> = {
    STARTING: ['READY', 'RUNNING', 'FAILED', 'EXITED', 'LOST'],
    READY: ['RUNNING', 'DEGRADED', 'STOPPING', 'EXITED', 'FAILED', 'LOST'],
    RUNNING: ['READY', 'DEGRADED', 'STOPPING', 'EXITED', 'FAILED', 'LOST'],
    DEGRADED: ['READY', 'RUNNING', 'STOPPING', 'EXITED', 'FAILED', 'LOST'],
    STOPPING: ['EXITED', 'FAILED', 'LOST'],
    EXITED: [],
    FAILED: [],
    LOST: []
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid agent server transition: ${current} -> ${next}`);
  }
}

function isTerminalAgentServerStatus(status: AgentServerStatus): boolean {
  return status === 'EXITED' || status === 'FAILED' || status === 'LOST';
}

function collectReferencedAgentServerIds(state: StoreState): Set<string> {
  const knownServerIds = new Set(state.agentServers.map((server) => server.id));
  const referencedServerIds = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (knownServerIds.has(value)) referencedServerIds.add(value);
      return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const item of Object.values(value)) visit(item);
  };

  for (const [collection, value] of Object.entries(state)) {
    if (collection !== 'agentServers') visit(value);
  }
  for (const server of state.agentServers) {
    const { id: _selfIdentity, ...serverMetadata } = server;
    visit(serverMetadata);
  }
  return referencedServerIds;
}

function compareAgentServerDiagnosticsNewestFirst(
  left: AgentServerInstance,
  right: AgentServerInstance
): number {
  const timestampDifference =
    agentServerDiagnosticTimestamp(right) - agentServerDiagnosticTimestamp(left);
  return timestampDifference || right.id.localeCompare(left.id);
}

function agentServerDiagnosticTimestamp(server: AgentServerInstance): number {
  for (const value of [
    server.exitedAt,
    server.disconnectedAt,
    server.lastHealthAt,
    server.initializedAt,
    server.startedAt
  ]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function branchPublicationEventType(
  status: BranchPublicationRecord['status']
): Extract<
  DomainEvent['type'],
  'BRANCH_PUBLISH_REQUESTED' | 'BRANCH_PUBLISHED' | 'BRANCH_PUBLISH_FAILED'
> {
  if (status === 'PUSHED') {
    return 'BRANCH_PUBLISHED';
  }
  if (status === 'PUSHING') {
    return 'BRANCH_PUBLISH_REQUESTED';
  }
  return 'BRANCH_PUBLISH_FAILED';
}

function sameInteractionOccurrenceInput(
  existing: InteractionRequestRecord,
  input: CreateInteractionRequestInput
): boolean {
  let sameRequest: boolean;
  try {
    sameRequest = stableJsonStringify(existing.request) === stableJsonStringify(input.request);
  } catch {
    return false;
  }
  return (
    existing.runtimeId === input.runtimeId &&
    existing.serverInstanceId === input.serverInstanceId &&
    existing.providerRequestId === input.providerRequestId &&
    existing.taskId === input.taskId &&
    existing.iterationId === input.iterationId &&
    existing.runId === input.runId &&
    existing.sessionId === input.sessionId &&
    existing.providerTurnId === input.providerTurnId &&
    existing.providerItemId === input.providerItemId &&
    existing.type === input.type &&
    sameRequest &&
    sameStringArray(existing.allowedActions, input.allowedActions) &&
    sameStringArray(existing.policyWarnings, input.policyWarnings) &&
    sameProtocolReference(existing.requestRawMessage, input.requestRawMessage)
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameProtocolReference(
  left: AgentProtocolMessageReference,
  right: AgentProtocolMessageReference
): boolean {
  return (
    left.serverInstanceId === right.serverInstanceId &&
    left.segment === right.segment &&
    left.sequence === right.sequence &&
    left.direction === right.direction &&
    left.recordedAt === right.recordedAt &&
    left.byteOffset === right.byteOffset &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256
  );
}

function interactionOccurrenceIdentity(
  interaction: Pick<
    InteractionRequestRecord,
    'serverInstanceId' | 'providerRequestId' | 'requestRawMessage'
  >
): string {
  return JSON.stringify([
    interaction.serverInstanceId,
    typeof interaction.providerRequestId,
    interaction.providerRequestId,
    interaction.requestRawMessage.sequence
  ]);
}

function validateInteractionTransition(
  current: InteractionRequestStatus,
  next: InteractionRequestStatus
): void {
  if (current === next) {
    return;
  }
  const allowed: Record<InteractionRequestStatus, InteractionRequestStatus[]> = {
    PENDING: [
      'RESPONDING',
      'DECLINED',
      'CANCELED',
      'ABORTED_SERVER_LOST',
      'STALE'
    ],
    RESPONDING: [
      'PENDING',
      'RESOLVED',
      'DECLINED',
      'CANCELED',
      'ABORTED_SERVER_LOST',
      'STALE'
    ],
    RESOLVED: [],
    DECLINED: [],
    CANCELED: [],
    ABORTED_SERVER_LOST: [],
    STALE: []
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid interaction transition: ${current} -> ${next}`);
  }
}

function validateAgentItemTransition(current: AgentItemStatus, next: AgentItemStatus): void {
  if (current === next) {
    return;
  }
  const allowed: Record<AgentItemStatus, AgentItemStatus[]> = {
    STARTED: ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'DECLINED', 'INTERRUPTED', 'UNKNOWN'],
    IN_PROGRESS: ['COMPLETED', 'FAILED', 'DECLINED', 'INTERRUPTED', 'UNKNOWN'],
    COMPLETED: [],
    FAILED: [],
    DECLINED: [],
    INTERRUPTED: [],
    UNKNOWN: ['STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'DECLINED', 'INTERRUPTED']
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid agent item transition: ${current} -> ${next}`);
  }
}

function isInteractionTerminal(status: InteractionRequestStatus): boolean {
  return !['PENDING', 'RESPONDING'].includes(status);
}

function assertAttachmentsOutsideWorktree(
  attachments: readonly VerifiedTaskAttachment[],
  worktreePath: string
): void {
  const worktree = path.resolve(worktreePath);
  for (const attachment of attachments) {
    const candidate = path.resolve(attachment.absolutePath);
    const relative = path.relative(worktree, candidate);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
      throw new AttachmentStoreError(
        'ATTACHMENT_STORAGE_ERROR',
        'Managed attachments must stay outside the task worktree.',
        409
      );
    }
  }
}
