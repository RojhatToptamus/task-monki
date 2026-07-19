import { createHash, randomUUID } from 'node:crypto';
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
  BranchPublicationRecord,
  CiRollupRecord,
  CreateBoardRequest,
  CodexReviewGateStatus,
  CreateTaskRequest,
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
  StatusProjection,
  Task,
  TaskAttachmentRecord,
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
import {
  BOARD_COLORS,
  TASK_STORE_SCHEMA_VERSION,
  completionPolicyRequiresMerge,
  completionPolicyRequiresPassingChecks,
  createInitialProjection,
  isTaskCreationToken,
  verifiedChecksMatchMergeHead
} from '../../shared/contracts';
import { AgentProtocolJournal } from '../agent/journal/AgentProtocolJournal';
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
  codexReviewStatusFromResult,
  parseCodexReviewResult
} from '../review/CodexReviewContract';
import {
  AttachmentFileStore,
  AttachmentStoreError,
  validateTaskAttachmentRecords,
  type PreparedAttachmentDraft,
  type VerifiedTaskAttachment
} from './AttachmentFileStore';

export interface CreateAgentSessionInput {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  provider: string;
  role?: AgentSessionRecord['role'];
  requestedSettings?: AgentExecutionSettings;
  parentSessionId?: string;
  forkedFromSessionId?: string;
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
  provider: string;
  runtimeKind: AgentServerInstance['runtimeKind'];
  transport: AgentServerInstance['transport'];
  executable: string;
  argv: string[];
  runtimeVersion?: string;
  schemaVersion?: string;
  schemaHash?: string;
  runtimeResolution?: AgentServerInstance['runtimeResolution'];
}

interface PrSyncInput {
  pullRequest: Omit<PullRequestSnapshotRecord, 'id' | 'observedAt'>;
  ci: Omit<CiRollupRecord, 'id' | 'observedAt'>;
  reviews: Omit<ReviewRollupRecord, 'id' | 'observedAt'>;
  merge: Omit<MergeSnapshotRecord, 'id' | 'observedAt'>;
}

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

const CREATE_TASK_COMPLETION_POLICIES: Task['completionPolicy'][] = [
  'ARTIFACT_ACCEPTANCE',
  'LOCAL_ACCEPTANCE',
  'MERGED',
  'MERGED_AND_VERIFIED',
  'MANUAL'
];
const MAX_STORE_FILE_BYTES = 256 * 1024 * 1024;
const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'agent-prompt',
  'agent-output',
  'agent-diagnostics',
  'agent-final',
  'diff',
  'git-snapshot',
  'pr-body',
  'preview-source-manifest',
  'preview-stdout',
  'preview-stderr'
];
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
  const knownRepositoryIds = new Set(repositories.map((repository) => repository.id));
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

function taskCreationMetadata(
  input: CreateTaskRequest
): TaskCreationMetadata | undefined {
  if (input.creationToken === undefined) {
    return undefined;
  }
  if (!isTaskCreationToken(input.creationToken)) {
    throw new TaskCreationRequestError(
      'TASK_CREATION_INVALID_REQUEST',
      'Task creation retry token is invalid.',
      400
    );
  }

  let canonicalRequest: string | undefined;
  try {
    canonicalRequest = stableJsonStringify({
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      repositoryId: input.repositoryId.trim(),
      completionPolicy: normalizeCreateTaskCompletionPolicy(input.completionPolicy),
      agentSettings: input.agentSettings ?? {},
      attachmentDraftId: input.attachmentDraftId ?? null
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
    token: input.creationToken,
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

class StorePublishedError extends Error {
  readonly name = 'StorePublishedError';

  constructor(readonly cause: unknown) {
    super('Task store snapshot was published but its directory sync did not complete.');
  }
}

export class FileTaskStore {
  private readonly storePath: string;
  private readonly artifactsDir: string;
  private readonly protocolJournal: AgentProtocolJournal;
  private readonly attachmentFiles: AttachmentFileStore;
  private state: StoreState = createEmptyState();
  private loaded = false;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private taskCreationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly baseDir: string) {
    this.storePath = path.join(baseDir, 'store.json');
    this.artifactsDir = path.join(baseDir, 'artifacts');
    this.protocolJournal = new AgentProtocolJournal(path.join(baseDir, 'protocol-journals'));
    this.attachmentFiles = new AttachmentFileStore(baseDir);
  }

  getStoreIdentity(): string {
    return createHash('sha256').update(path.resolve(this.baseDir)).digest('hex');
  }

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }

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
    await cleanupStoreTemporaryFiles(this.baseDir, this.storePath);
    await this.attachmentFiles.init();
    await initializeArtifactDirectory(this.baseDir, this.artifactsDir);

    try {
      const raw = await readPrivateStoreFile(this.storePath);
      const persisted = JSON.parse(raw) as PersistedState;
      const reconciled = reconcileLoadedState(requireCurrentState(persisted));
      this.state = reconciled.state;
      await this.attachmentFiles.reconcile(this.state.attachments);
      await this.reconcileArtifacts();
      if (reconciled.changed) {
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.state = createEmptyState();
      await this.attachmentFiles.reconcile(this.state.attachments);
      await this.reconcileArtifacts();
      await this.persist();
    }
    this.loaded = true;
  }

  async close(): Promise<void> {
    try {
      await this.taskCreationQueue.catch(() => undefined);
      await this.writeQueue.catch(() => undefined);
    } finally {
      this.loaded = false;
    }
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
        await secureArtifactFile(entryPath);
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
    if (removedOrphans > 0) {
      await syncDirectoryIfSupported(this.artifactsDir);
    }
  }

  async snapshot(): Promise<TaskSnapshot> {
    await this.init();
    return clone(this.state);
  }

  async getRepository(repositoryId: string): Promise<Repository | undefined> {
    await this.init();
    return clone(this.state.repositories.find((repository) => repository.id === repositoryId));
  }

  async addRepository(preflight: RepositoryPreflight): Promise<Repository> {
    await this.init();
    if (preflight.status !== 'VALID' || !preflight.root || !preflight.headSha) {
      throw new Error(preflight.error ?? 'Repository validation must pass before it can be added.');
    }
    const repositoryPath = path.resolve(preflight.root);
    const existing = this.state.repositories.find(
      (repository) => path.resolve(repository.path) === repositoryPath
    );
    if (existing) {
      if (existing.status === 'DISCONNECTED') {
        throw new Error('Repository is disconnected. Reconnect the existing repository instead.');
      }
      return this.recordRepositoryPreflight(existing.id, preflight);
    }
    const now = new Date().toISOString();
    const repository: Repository = {
      id: randomUUID(),
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
    await this.persistQueued();
    return clone(repository);
  }

  async recordRepositoryPreflight(
    repositoryId: string,
    preflight: RepositoryPreflight
  ): Promise<Repository> {
    await this.init();
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
    await this.persistQueued();
    return clone(repository);
  }

  async disconnectRepository(repositoryId: string): Promise<Repository> {
    await this.init();
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
    await this.persistQueued();
    return clone(repository);
  }

  async createBoard(input: CreateBoardRequest): Promise<Board> {
    await this.init();
    const values = validateBoardInput(input, this.state.repositories);
    const now = new Date().toISOString();
    const board: Board = {
      id: randomUUID(),
      ...values,
      createdAt: now,
      updatedAt: now
    };
    this.state = { ...this.state, boards: [board, ...this.state.boards] };
    await this.persistQueued();
    return clone(board);
  }

  async updateBoard(input: UpdateBoardRequest): Promise<Board> {
    await this.init();
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
    await this.persistQueued();
    return clone(board);
  }

  async deleteBoard(boardId: string): Promise<void> {
    await this.init();
    if (!this.state.boards.some((board) => board.id === boardId)) {
      throw new Error('Board not found.');
    }
    this.state = {
      ...this.state,
      boards: this.state.boards.filter((board) => board.id !== boardId)
    };
    await this.persistQueued();
  }

  async createAttachmentDraft(): Promise<AttachmentDraftSnapshot> {
    await this.init();
    return this.attachmentFiles.createDraft();
  }

  async stageTaskAttachment(input: StageAttachmentBytesInput): Promise<StagedAttachmentRecord> {
    await this.init();
    return this.attachmentFiles.stageBytes(input);
  }

  async listAttachmentDraft(draftId: string): Promise<AttachmentDraftSnapshot> {
    await this.init();
    return this.attachmentFiles.listDraft(draftId);
  }

  async discardAttachmentDraft(draftId: string): Promise<void> {
    await this.init();
    return this.attachmentFiles.discardDraft(draftId);
  }

  async getTaskAttachments(taskId: string): Promise<TaskAttachmentRecord[]> {
    await this.init();
    return clone(
      this.state.attachments
        .filter((attachment) => attachment.taskId === taskId)
        .sort((left, right) => left.ordinal - right.ordinal)
    );
  }

  async verifyTaskAttachments(taskId: string): Promise<VerifiedTaskAttachment[]> {
    const records = await this.getTaskAttachments(taskId);
    return records.length === 0 ? [] : this.attachmentFiles.verifyTask(taskId, records);
  }

  /** Returns verified immutable task-owned files for provider delivery. */
  async prepareRunAttachments(
    runId: string,
    taskId: string
  ): Promise<VerifiedTaskAttachment[]> {
    const worktreePath = await this.requireRunAttachmentWorktree(runId, taskId);
    const attachments = await this.verifyTaskAttachments(taskId);
    assertAttachmentsOutsideWorktree(attachments, worktreePath);
    return attachments;
  }

  /** Revalidates task-owned files immediately before provider submission. */
  async verifyRunAttachments(
    runId: string,
    taskId: string
  ): Promise<VerifiedTaskAttachment[]> {
    const worktreePath = await this.requireRunAttachmentWorktree(runId, taskId);
    const attachments = await this.verifyTaskAttachments(taskId);
    assertAttachmentsOutsideWorktree(attachments, worktreePath);
    return attachments;
  }

  /**
   * Crash recovery verifies attachments for active runs without creating a
   * second filesystem representation.
   */
  async reconcileRunAttachments(): Promise<{
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

  async readTaskAttachment(attachmentId: string): Promise<AttachmentContent> {
    await this.init();
    const record = this.state.attachments.find((attachment) => attachment.id === attachmentId);
    if (!record) {
      throw new AttachmentStoreError('ATTACHMENT_NOT_FOUND', 'Attachment not found.', 404);
    }
    const stored = await this.attachmentFiles.readTask(record);
    return { ...stored, bytes: exactArrayBuffer(stored.bytes) };
  }

  async readDraftAttachment(draftId: string, attachmentId: string): Promise<AttachmentContent> {
    await this.init();
    const stored = await this.attachmentFiles.readDraft(draftId, attachmentId);
    return { ...stored, bytes: exactArrayBuffer(stored.bytes) };
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
    await this.persistQueued();
    return clone(binding);
  }

  async deletePreviewLocalBinding(taskId: string, attachmentId: string): Promise<void> {
    await this.init();
    this.state = {
      ...this.state,
      previewLocalBindings: this.state.previewLocalBindings.filter(
        (binding) => binding.taskId !== taskId || binding.attachmentId !== attachmentId
      )
    };
    await this.persistQueued();
  }

  async savePreviewPlan(plan: PreviewPlanRecord): Promise<PreviewPlanRecord> {
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
    await this.appendEvent(
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
    await this.persistQueued();
    return clone(plan);
  }

  async savePreviewApproval(approval: PreviewApprovalRecord): Promise<PreviewApprovalRecord> {
    await this.init();
    this.assertPreviewApprovalReferences(approval);
    this.state = {
      ...this.state,
      previewApprovals: [
        approval,
        ...this.state.previewApprovals.filter((candidate) => candidate.id !== approval.id)
      ]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'PREVIEW_PLAN_APPROVED',
        taskId: approval.taskId,
        previewPlanId: approval.planId,
        source: 'preview',
        payload: { executionDigest: approval.executionDigest, scope: approval.scope }
      }),
      false
    );
    await this.persistQueued();
    return clone(approval);
  }

  async savePreviewGeneration(
    generation: PreviewGenerationRecord
  ): Promise<PreviewGenerationRecord> {
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
    await this.appendEvent(
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
    await this.persistQueued();
    return clone(generation);
  }

  async savePreviewManagedEnvironment(
    environment: PreviewManagedEnvironmentRecord
  ): Promise<PreviewManagedEnvironmentRecord> {
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
    await this.persistQueued();
    return clone(environment);
  }

  async savePreviewComposeProject(
    project: PreviewComposeProjectRecord
  ): Promise<PreviewComposeProjectRecord> {
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
    await this.persistQueued();
    return clone(project);
  }

  async savePreviewManagedResource(
    resource: PreviewManagedResourceRecord
  ): Promise<PreviewManagedResourceRecord> {
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
    await this.persistQueued();
    return clone(resource);
  }

  async savePreviewGenerationAttachments(
    attachments: PreviewGenerationAttachmentRecord[]
  ): Promise<PreviewGenerationAttachmentRecord[]> {
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
    await this.persistQueued();
    return clone(attachments);
  }

  async cutoverPreviewGenerations(input: {
    candidate: PreviewGenerationRecord;
    replaced?: PreviewGenerationRecord;
  }): Promise<{ candidate: PreviewGenerationRecord; replaced?: PreviewGenerationRecord }> {
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
    const updates = new Map(
      [input.candidate, input.replaced].filter(Boolean).map((generation) => [generation!.id, generation!])
    );
    const previousState = this.state;
    try {
      this.state = {
        ...this.state,
        previewGenerations: [
          input.candidate,
          ...(input.replaced ? [input.replaced] : []),
          ...this.state.previewGenerations.filter((generation) => !updates.has(generation.id))
        ]
      };
      for (const generation of updates.values()) {
        await this.appendEvent(
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
      await this.persistQueued();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    return clone(input);
  }

  async prunePreviewHistory(taskId: string, maxTerminalGenerations = 20): Promise<number> {
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
    await this.persistQueued();
    await Promise.all(artifacts.map((artifact) => unlinkIfExists(artifact.path)));
    return removedIds.size;
  }

  async prunePreviewProbeHistory(
    generationId: string,
    nodeId: string,
    maxAttempts = 20
  ): Promise<number> {
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
    await this.persistQueued();
    await Promise.all(artifacts.map((artifact) => unlinkIfExists(artifact.path)));
    return removedAttempts.length;
  }

  async savePreviewNodeAttempt(
    attempt: PreviewNodeAttemptRecord
  ): Promise<PreviewNodeAttemptRecord> {
    await this.init();
    this.assertPreviewChildReferences(attempt.taskId, attempt.generationId, 'attempt');
    this.state = {
      ...this.state,
      previewNodeAttempts: [
        attempt,
        ...this.state.previewNodeAttempts.filter((candidate) => candidate.id !== attempt.id)
      ]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'PREVIEW_NODE_UPDATED',
        taskId: attempt.taskId,
        previewGenerationId: attempt.generationId,
        source: 'preview',
        payload: { nodeId: attempt.nodeId, state: attempt.state }
      }),
      false
    );
    await this.persistQueued();
    return clone(attempt);
  }

  async savePreviewResource(resource: PreviewNativeResourceRecord): Promise<PreviewNativeResourceRecord> {
    await this.init();
    this.assertPreviewChildReferences(resource.taskId, resource.generationId, 'resource');
    this.state = {
      ...this.state,
      previewResources: [
        resource,
        ...this.state.previewResources.filter((candidate) => candidate.id !== resource.id)
      ]
    };
    await this.appendEvent(
      createDomainEvent({
        type: 'PREVIEW_RESOURCE_UPDATED',
        taskId: resource.taskId,
        previewGenerationId: resource.generationId,
        source: 'preview',
        payload: { resourceId: resource.id, state: resource.state }
      }),
      false
    );
    await this.persistQueued();
    return clone(resource);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    await this.init();
    return clone(this.state.runs.find((run) => run.id === runId));
  }

  async getRunByProviderTurnId(providerTurnId: string): Promise<RunRecord | undefined> {
    await this.init();
    return clone(this.state.runs.find((run) => run.providerTurnId === providerTurnId));
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
    update: Partial<
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
    >
  ): Promise<RunRecord> {
    await this.init();
    const existing = this.state.runs.find((run) => run.id === runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }
    const stored = { ...existing, ...update };
    this.state = {
      ...this.state,
      runs: this.state.runs.map((run) => (run.id === runId ? stored : run))
    };
    await this.persistQueued();
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
    providerSessionId: string
  ): Promise<AgentSessionRecord | undefined> {
    await this.init();
    return clone(
      this.state.agentSessions.find(
        (session) => session.providerSessionId === providerSessionId
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
  } = {}): Promise<RunRecord[]> {
    await this.init();
    const statuses: RunRecord['status'][] = [
      'RECOVERY_REQUIRED',
      'RUNNING',
      'STARTING',
      'INTERRUPTING'
    ];
    if (options.includeQueued) statuses.push('QUEUED');
    return clone(
      this.state.runs.filter((run) => statuses.includes(run.status))
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

  async createTask(input: CreateTaskRequest): Promise<Task> {
    return this.enqueueTaskCreation(() => this.createTaskRecord(input, 'ui'));
  }

  async createForkedAlternativeTask(input: CreateForkedAlternativeTaskInput): Promise<Task> {
    return this.enqueueTaskCreation(() =>
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
    await this.taskCreationQueue.catch(() => undefined);
    return clone(this.resolveTaskCreationRetryFromState(input));
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.init();

    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
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
    const previousState = this.state;
    let publishedWithoutDirectorySync = false;

    try {
      this.state = {
        ...this.state,
      tasks: this.state.tasks
        .filter((candidate) => candidate.id !== taskId)
        .map((candidate) => removeTaskLink(candidate, taskId, now)),
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

      await this.persistQueued();
    } catch (error) {
      if (error instanceof StorePublishedError) {
        publishedWithoutDirectorySync = true;
      } else {
        this.state = previousState;
        throw error;
      }
    }
    // Blobs are immutable and shared by metadata reference. Once deletion is
    // durable, unreferenced objects can be collected without a trash/restore
    // transaction; startup reconciliation retries any failed cleanup.
    await this.attachmentFiles.discardTaskFiles(taskId).catch(() => undefined);
    if (!publishedWithoutDirectorySync) {
      await Promise.all(artifactsToDelete.map((artifact) => unlinkIfExists(artifact.path)));
    }
  }

  private async createTaskRecord(
    input: CreateTaskRequest,
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
    const task: Task = {
      id: randomUUID(),
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
      agentSettings: input.agentSettings ?? {},
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

      await this.persistQueued();
    } catch (error) {
      if (error instanceof StorePublishedError) {
        // The snapshot is already visible. Keep the draft until a later
        // startup can compare it with the durable attachment records.
        publishedWithoutDirectorySync = true;
      } else {
        this.state = previousState;
        if (preparedDraft) {
          await this.attachmentFiles.rollbackDraftForTask(preparedDraft).catch(
            () => undefined
          );
        } else if (fork && attachmentRecords.length > 0) {
          await this.attachmentFiles.discardTaskFiles(task.id).catch(() => undefined);
        }
        throw error;
      }
    }
    if (!publishedWithoutDirectorySync) {
      if (preparedDraft) {
        await this.attachmentFiles.finalizeDraftForTask(preparedDraft).catch(() => undefined);
      } else if (attachmentRecords.length > 0) {
        await this.attachmentFiles.syncTaskRecords(this.state.attachments).catch(
          () => undefined
        );
      }
    }
    return clone(task);
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
    const plan = this.state.previewPlans.find(
      (candidate) =>
        candidate.id === generation.planId &&
        candidate.taskId === generation.taskId &&
        candidate.iterationId === generation.iterationId &&
        candidate.worktreeId === generation.worktreeId &&
        candidate.executionDigest === generation.executionDigest
    );
    const approval = this.state.previewApprovals.find(
      (candidate) =>
        candidate.id === generation.approvalId &&
        candidate.taskId === generation.taskId &&
        candidate.executionDigest === generation.executionDigest &&
        candidate.scope === 'TASK' &&
        (!candidate.invalidatedAt || Boolean(existing))
    );
    const authorityChanged =
      existing &&
      (existing.taskId !== generation.taskId ||
        existing.iterationId !== generation.iterationId ||
        existing.worktreeId !== generation.worktreeId ||
        existing.planId !== generation.planId ||
        existing.approvalId !== generation.approvalId ||
        existing.executionDigest !== generation.executionDigest);
    if (
      !plan ||
      !approval ||
      authorityChanged ||
      !this.state.tasks.some((task) => task.id === generation.taskId)
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
    input: CreateTaskRequest
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
    if (existing.creationRequestFingerprint !== metadata.fingerprint) {
      throw new TaskCreationRequestError(
        'TASK_CREATION_CONFLICT',
        'This task creation retry token was already used for a different request.',
        409
      );
    }
    return existing;
  }

  private async enqueueTaskCreation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.taskCreationQueue.catch(() => undefined).then(operation);
    this.taskCreationQueue = queued.catch(() => undefined);
    return queued;
  }

  async createAgentServer(input: CreateAgentServerInput): Promise<AgentServerInstance> {
    await this.init();

    const now = new Date().toISOString();
    const id = randomUUID();
    const server: AgentServerInstance = {
      id,
      provider: input.provider,
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
    await this.persistQueued();
    return clone(server);
  }

  async updateAgentServer(
    serverInstanceId: string,
    update: Partial<
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
    >
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
    await this.persistQueued();
    return clone(stored);
  }

  appendProtocolMessage(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    return this.protocolJournal.append(serverInstanceId, direction, raw, metadata);
  }

  async readProtocolMessage(reference: AgentProtocolMessageReference) {
    await this.init();
    if (
      !Number.isInteger(reference.sequence) ||
      reference.sequence <= 0 ||
      !Number.isInteger(reference.byteOffset) ||
      reference.byteOffset < 0 ||
      !Number.isInteger(reference.byteLength) ||
      reference.byteLength <= 0 ||
      reference.byteLength > 10 * 1024 * 1024
    ) {
      throw new Error('Protocol journal reference is invalid.');
    }
    if (!this.state.agentServers.some((server) => server.id === reference.serverInstanceId)) {
      throw new Error('Protocol journal server instance is not owned by this store.');
    }
    return this.protocolJournal.read(reference);
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
    await this.init();
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
    await this.persistQueued();
    return clone(stored);
  }

  async recordAgentPlanRevision(
    record: Omit<AgentPlanRevisionRecord, 'id' | 'revision' | 'observedAt'>
  ): Promise<AgentPlanRevisionRecord> {
    await this.init();
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
    await this.persistQueued();
    return clone(stored);
  }

  async recordAgentUsageSnapshot(
    record: Omit<AgentUsageSnapshotRecord, 'id' | 'observedAt'>
  ): Promise<AgentUsageSnapshotRecord> {
    await this.init();
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
    await this.persistQueued();
    return clone(stored);
  }

  async recordAgentSettingsObservation(
    record: Omit<AgentSettingsObservationRecord, 'id' | 'observedAt'>
  ): Promise<AgentSettingsObservationRecord> {
    await this.init();
    const stored: AgentSettingsObservationRecord = {
      ...record,
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
    await this.persistQueued();
    return clone(stored);
  }

  async createAgentSession(input: CreateAgentSessionInput): Promise<AgentSessionRecord> {
    await this.init();
    if (input.iteration.taskId !== input.task.id || input.worktree.taskId !== input.task.id) {
      throw new Error('Agent session task, iteration, and worktree must have the same owner.');
    }
    if (input.worktree.iterationId !== input.iteration.id) {
      throw new Error('Agent session worktree must belong to the selected iteration.');
    }

    const role = input.role ?? 'PRIMARY';
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
      return clone(existing);
    }

    const now = new Date().toISOString();
    const session: AgentSessionRecord = {
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      provider: input.provider,
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
      requestedSettings: input.requestedSettings ?? {},
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
          provider: session.provider,
          role: session.role,
          worktreePath: session.worktreePath
        }
      }),
      false
    );
    await this.persistQueued();
    return clone(session);
  }

  async updateAgentSession(
    sessionId: string,
    update: Partial<
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
    >
  ): Promise<AgentSessionRecord> {
    await this.init();
    const existing = this.state.agentSessions.find((session) => session.id === sessionId);
    if (!existing) {
      throw new Error(`Agent session not found: ${sessionId}`);
    }
    const stored: AgentSessionRecord = {
      ...existing,
      ...update,
      updatedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      agentSessions: this.state.agentSessions.map((session) =>
        session.id === sessionId ? stored : session
      )
    };
    await this.persistQueued();
    return clone(stored);
  }

  async observeSubagent(
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

    const existing = this.state.agentSessions.find(
      (session) => session.providerSessionId === input.providerChildSessionId
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
      ...(existing?.requestedSettings ?? {}),
      ...(input.requestedSettings ?? {})
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
          provider: parent.provider,
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
    await this.persistQueued();
    return { session: clone(stored), observation: clone(observation) };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    await this.init();

    if (input.session.taskId !== input.task.id) {
      throw new Error('Run session must belong to the task.');
    }

    const now = new Date().toISOString();
    const runId = randomUUID();
    const promptArtifact = await this.createArtifactRecord(input.task.id, 'agent-prompt', { runId });
    const outputArtifact = await this.createArtifactRecord(input.task.id, 'agent-output', { runId });
    const diagnosticArtifact = await this.createArtifactRecord(input.task.id, 'agent-diagnostics', {
      runId
    });
    await Promise.all([
      writeNewArtifactFile(promptArtifact.path, input.prompt),
      writeNewArtifactFile(outputArtifact.path, ''),
      writeNewArtifactFile(diagnosticArtifact.path, '')
    ]);
    promptArtifact.byteCount = Buffer.byteLength(input.prompt);

    const run: RunRecord = {
      id: runId,
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
      requestedSettings: input.requestedSettings ?? input.session.requestedSettings,
      promptArtifactId: promptArtifact.id,
      outputArtifactId: outputArtifact.id,
      diagnosticArtifactId: diagnosticArtifact.id,
      beforeGitSnapshotId: input.beforeGitSnapshotId,
      startedAt: now,
      eventCount: 0
    };
    const startsWorkflow = input.mode !== 'REVIEW';
    const reviewedSnapshot = input.beforeGitSnapshotId
      ? this.state.gitSnapshots.find((snapshot) => snapshot.id === input.beforeGitSnapshotId)
      : undefined;

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((existing) =>
        existing.id === input.task.id
          ? {
              ...existing,
              workflowPhase: startsWorkflow ? 'IN_PROGRESS' : existing.workflowPhase,
              currentRunId: startsWorkflow ? run.id : existing.currentRunId,
              currentAgentSessionId: startsWorkflow
                ? input.session.id
                : existing.currentAgentSessionId,
              currentIterationId: startsWorkflow
                ? input.session.iterationId
                : existing.currentIterationId,
              currentWorktreeId: startsWorkflow
                ? input.session.worktreeId
                : existing.currentWorktreeId,
              phaseVersion: startsWorkflow ? existing.phaseVersion + 1 : existing.phaseVersion,
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

    if (startsWorkflow) {
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
          payload: { fromPhase: input.task.workflowPhase, toPhase: 'IN_PROGRESS' }
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

    await this.persistQueued();
    return clone(run);
  }

  async createObservedSubagentRun(
    input: CreateObservedSubagentRunInput
  ): Promise<RunRecord> {
    await this.init();
    const existing = this.state.runs.find(
      (run) => run.providerTurnId === input.providerTurnId
    );
    if (existing) {
      return clone(existing);
    }
    if (input.session.role !== 'SUBAGENT') {
      throw new Error('Only observed subagent sessions may create observed child runs.');
    }

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
    await Promise.all([
      writeNewArtifactFile(promptArtifact.path, prompt),
      writeNewArtifactFile(outputArtifact.path, ''),
      writeNewArtifactFile(diagnosticArtifact.path, '')
    ]);
    promptArtifact.byteCount = Buffer.byteLength(prompt);

    const run: RunRecord = {
      id: runId,
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
        input.requestedSettings ?? input.session.requestedSettings,
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
    await this.persistQueued();
    return clone(run);
  }

  async upsertAgentItem(
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
    await this.persistQueued();
    return clone(stored);
  }

  async createInteractionRequest(
    input: Omit<InteractionRequestRecord, 'id' | 'status' | 'requestedAt'>
  ): Promise<InteractionRequestRecord> {
    await this.init();
    const run = this.state.runs.find((candidate) => candidate.id === input.runId);
    if (
      !run ||
      run.taskId !== input.taskId ||
      run.iterationId !== input.iterationId ||
      run.sessionId !== input.sessionId ||
      run.serverInstanceId !== input.serverInstanceId
    ) {
      throw new Error('Interaction request ownership does not match its run.');
    }
    const duplicate = this.state.interactionRequests.find(
      (request) =>
        request.serverInstanceId === input.serverInstanceId &&
        request.providerRequestId === input.providerRequestId
    );
    if (duplicate) {
      return clone(duplicate);
    }

    const stored: InteractionRequestRecord = {
      ...input,
      id: randomUUID(),
      status: 'PENDING',
      requestedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      interactionRequests: [stored, ...this.state.interactionRequests]
    };
    await this.appendEvent(
      createDomainEvent({
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
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async transitionInteractionRequest(
    interactionRequestId: string,
    expectedStatus: InteractionRequestStatus,
    update: Partial<
      Pick<
        InteractionRequestRecord,
        | 'status'
        | 'decision'
        | 'responseRawMessage'
        | 'resolution'
        | 'respondedAt'
        | 'resolvedAt'
      >
    >
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

    await this.persistQueued();
    return clone(stored);
  }

  async createIterationAndWorktree(input: {
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

    await this.persistQueued();
    return { iteration: clone(storedIteration), worktree: clone(worktree) };
  }

  async updateWorktree(worktree: WorktreeRecord, eventType: 'WORKTREE_CREATED' | 'WORKTREE_VERIFIED' | 'WORKTREE_FAILED'): Promise<WorktreeRecord> {
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
    await this.persistQueued();
    return clone(stored);
  }

  async recordGitSnapshot(snapshot: Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'>, diffEvidence: string): Promise<GitSnapshotRecord> {
    await this.init();

    const diffArtifact = await this.writeTextArtifact(snapshot.taskId, 'diff', diffEvidence);
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

    await this.persistQueued();
    return clone(stored);
  }

  async transitionTask(taskId: string, toPhase: Task['workflowPhase'], reason: string): Promise<Task> {
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
    await this.persistQueued();

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
    await this.persistQueued();
    return clone(stored);
  }

  async recordBranchPublishRequested(task: Task, worktree: WorktreeRecord): Promise<void> {
    await this.appendEvent(
      createDomainEvent({
        type: 'BRANCH_PUBLISH_REQUESTED',
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        source: 'github',
        payload: { branchName: worktree.branchName }
      })
    );
  }

  async recordBranchPublication(
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
    await this.persistQueued();
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
    const artifact = await this.writeTextArtifact(task.id, 'pr-body', content);
    await this.appendEvent(
      createDomainEvent({
        type: 'PR_BODY_ARTIFACT_CREATED',
        taskId: task.id,
        iterationId: task.currentIterationId,
        worktreeId: task.currentWorktreeId,
        source: 'storage',
        payload: { artifactId: artifact.id, byteCount: artifact.byteCount }
      })
    );
    return artifact;
  }

  async recordPullRequestSync(input: PrSyncInput): Promise<PullRequestSnapshotRecord> {
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

    if (merge.status === 'MERGED') {
      const now = new Date().toISOString();
      this.state = {
        ...this.state,
        tasks: this.state.tasks.map((task) =>
          task.id === merge.taskId && shouldCompleteFromPullRequestSync(task, pullRequest, ci, merge)
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

    await this.persistQueued();
    return clone(pullRequest);
  }

  async appendEvent(event: DomainEvent, persist = true): Promise<void> {
    await this.init();
    this.state = applyEventToState(this.state, event);
    if (persist) {
      await this.persistQueued();
    }
  }

  async appendArtifact(artifactId: string, chunk: string): Promise<void> {
    await this.init();

    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    await appendManagedArtifactFile(artifact.path, chunk);

    const byteCount = Buffer.byteLength(chunk);
    const updatedAt = new Date().toISOString();
    this.state = {
      ...this.state,
      artifacts: this.state.artifacts.map((candidate) =>
        candidate.id === artifactId
          ? { ...candidate, byteCount: candidate.byteCount + byteCount, updatedAt }
          : candidate
      )
    };
  }

  async createPreviewArtifact(
    taskId: string,
    kind: 'preview-stdout' | 'preview-stderr'
  ): Promise<ArtifactRecord> {
    await this.init();
    const artifact = await this.createArtifactRecord(taskId, kind);
    await writeNewArtifactFile(artifact.path, '');
    this.state = {
      ...this.state,
      artifacts: [artifact, ...this.state.artifacts]
    };
    await this.persistQueued();
    return clone(artifact);
  }

  async appendBoundedArtifact(
    artifactId: string,
    chunk: string | Buffer,
    maxBytes = 256 * 1024
  ): Promise<{ byteCount: number; truncated: boolean }> {
    await this.init();
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    if (artifact.byteCount >= maxBytes) {
      return { byteCount: artifact.byteCount, truncated: true };
    }

    const marker = Buffer.from('\n[Task Monki preview log truncated]\n', 'utf8');
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    const remaining = maxBytes - artifact.byteCount;
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
    return { byteCount, truncated };
  }

  async syncArtifactByteCount(artifactId: string): Promise<ArtifactRecord> {
    await this.init();
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    const handle = await openManagedArtifactFile(artifact.path, fsConstants.O_RDONLY).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const stat = handle ? await handle.stat().finally(() => handle.close()) : undefined;
    const updated: ArtifactRecord = {
      ...artifact,
      byteCount: stat?.size ?? 0,
      updatedAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      artifacts: this.state.artifacts.map((candidate) =>
        candidate.id === artifactId ? updated : candidate
      )
    };
    return clone(updated);
  }

  async writeFinalArtifact(taskId: string, runId: string, content: string): Promise<ArtifactRecord> {
    await this.init();

    const artifact = await this.createArtifactRecord(taskId, 'agent-final', { runId });
    await writeNewArtifactFile(artifact.path, content);

    const hash = createHash('sha256').update(content).digest('hex');
    const stored: ArtifactRecord = {
      ...artifact,
      byteCount: Buffer.byteLength(content),
      updatedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      artifacts: [stored, ...this.state.artifacts]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'ARTIFACT_CREATED',
        taskId,
        runId,
        source: 'storage',
        payload: { artifactId: stored.id, kind: stored.kind, hash }
      }),
      false
    );

    await this.persistQueued();
    return clone(stored);
  }

  async writeTextArtifact(taskId: string, kind: ArtifactKind, content: string): Promise<ArtifactRecord> {
    await this.init();

    const artifact = await this.createArtifactRecord(taskId, kind);
    await writeNewArtifactFile(artifact.path, content);

    const stored: ArtifactRecord = {
      ...artifact,
      byteCount: Buffer.byteLength(content),
      updatedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      artifacts: [stored, ...this.state.artifacts]
    };

    await this.persistQueued();
    return clone(stored);
  }

  async readArtifact(artifactId: string): Promise<string> {
    await this.init();
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    try {
      const handle = await openManagedArtifactFile(artifact.path, fsConstants.O_RDONLY);
      try {
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  async readArtifactRange(
    artifactId: string,
    offset: number,
    maxBytes: number
  ): Promise<{ chunk: string; nextOffset: number; endOfFile: boolean }> {
    await this.init();
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Artifact offset must be a nonnegative integer.');
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
      const safeBytes = utf8SafePrefixLength(buffer.subarray(0, bytesRead), offset + bytesRead >= stat.size);
      return {
        chunk: buffer.subarray(0, safeBytes).toString('utf8'),
        nextOffset: offset + safeBytes,
        endOfFile: offset + safeBytes >= stat.size
      };
    } finally {
      await handle.close();
    }
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
    const now = new Date().toISOString();
    const id = randomUUID();
    const ownerId = ids.runId ?? 'task';
    const fileName = `${taskId}-${ownerId}-${kind}-${id}.log`;
    return {
      id,
      taskId,
      runId: ids.runId,
      kind,
      path: path.join(this.artifactsDir, fileName),
      byteCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  private async persistQueued(): Promise<void> {
    const operation = this.writeQueue.catch(() => undefined).then(() => this.persist());
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
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
      await handle.writeFile(`${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await enforcePosixMode(handle, 0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tmpPath, this.storePath);
      published = true;
      await syncDirectoryIfSupported(this.baseDir);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(tmpPath).catch(() => undefined);
      if (published) throw new StorePublishedError(error);
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

async function secureArtifactFile(filePath: string): Promise<void> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Stored task artifact is not a regular file.');
  }
  assertArtifactOwnedByCurrentUser(before);
  const handle = await openManagedArtifactFile(filePath, fsConstants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (!sameFileIdentity(stat, before)) {
      throw new Error('Stored task artifact changed during validation.');
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

async function writeNewArtifactFile(
  filePath: string,
  content: string | Buffer
): Promise<void> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    await handle.writeFile(content);
    await enforcePosixMode(handle, 0o600);
    await handle.sync();
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

function requireCurrentState(state: PersistedState): StoreState {
  if (state.schemaVersion !== TASK_STORE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Task Monki store schema ${String(state.schemaVersion)}. ` +
        `Delete the local store and restart; migrations are intentionally not supported.`
    );
  }
  const requiredCollections: Array<keyof StoreState> = [
    'repositories',
    'boards',
    'tasks',
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
  validatePersistedRepositoryReferences(current);
  validatePersistedBoards(current);
  validatePersistedTaskCreationMetadata(current);
  validatePersistedAttachments(current);
  return current;
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

function reconcileLoadedState(state: StoreState): { state: StoreState; changed: boolean } {
  let changed = false;
  const previewResources = state.previewResources.filter(
    (resource) => (resource as { adapterKind: string }).adapterKind === 'NATIVE_PROCESS'
  );
  if (previewResources.length !== state.previewResources.length) {
    changed = true;
  }
  const activeRunStatuses: RunRecord['status'][] = [
    'QUEUED',
    'STARTING',
    'RUNNING',
    'AWAITING_APPROVAL',
    'AWAITING_USER_INPUT',
    'INTERRUPTING'
  ];
  const runs = state.runs.map((run) => {
    if (isStaleIdleReviewRun(run, state.agentSessions)) {
      changed = true;
      return {
        ...run,
        status: 'RECOVERY_REQUIRED' as const,
        recoveryState: 'REQUIRES_USER_ACTION' as const,
        terminalReason:
          run.terminalReason ??
          'Codex review stopped sending updates before Task Monki received a terminal event.'
      };
    }
    if (!isStaleInterruptingReviewRun(run, state.agentSessions)) {
      return run;
    }
    changed = true;
    return {
      ...run,
      status: 'INTERRUPTED' as const,
      recoveryState: 'NONE' as const,
      endedAt: run.endedAt ?? run.lastEventAt ?? run.startedAt,
      terminalReason:
        run.terminalReason ??
        'Codex review stop was reconciled after the provider reported no active turn.'
    };
  });
  const tasks = state.tasks.map((task) => {
    const taskCurrentRun = task.currentRunId
      ? runs.find((run) => run.id === task.currentRunId)
      : undefined;
    const currentRun = findReviewRunForRepair(task, runs);
    if (!currentRun) {
      return task;
    }

    const isActiveReview = activeRunStatuses.includes(currentRun.status);
    const hasActiveNonReviewRun =
      taskCurrentRun !== undefined &&
      taskCurrentRun.mode !== 'REVIEW' &&
      activeRunStatuses.includes(taskCurrentRun.status);
    const shouldRepairPhase =
      !hasActiveNonReviewRun &&
      task.workflowPhase !== 'REVIEW' &&
      task.workflowPhase !== 'IN_REVIEW' &&
      task.workflowPhase !== 'DONE' &&
      task.workflowPhase !== 'CANCELED' &&
      task.workflowPhase !== 'ARCHIVED';
    const currentReview = task.projection.codexReview;
    const sameProjectedReview = currentReview?.runId === currentRun.id;
    const reviewResult =
      parseCodexReviewResult(currentRun.finalMessage) ??
      (sameProjectedReview ? currentReview?.result : undefined);
    const projectedReviewStatus =
      sameProjectedReview && currentReview?.status !== 'RUNNING'
        ? currentReview?.status
        : undefined;
    const reviewStatus: CodexReviewGateStatus =
      (sameProjectedReview && currentReview?.status === 'STALE'
        ? 'STALE'
        : codexReviewStatusFromResult(reviewResult)) ??
      projectedReviewStatus ??
      (currentRun.status === 'COMPLETED'
        ? 'INCONCLUSIVE'
        : currentRun.status === 'INTERRUPTED'
          ? 'CANCELED'
          : ['FAILED', 'RECOVERY_REQUIRED', 'LOST'].includes(currentRun.status)
            ? 'FAILED'
            : 'RUNNING');
    const repairedSourceRun =
      taskCurrentRun?.mode === 'REVIEW'
        ? findSourceRunForReviewRepair(currentRun, runs)
        : undefined;
    const shouldRepairCurrentRun = Boolean(repairedSourceRun);
    const shouldRepairReview =
      !currentReview ||
      currentReview.runId !== currentRun.id ||
      currentReview.status !== reviewStatus ||
      (!currentReview.result && Boolean(reviewResult));

    if (!shouldRepairPhase && !shouldRepairReview && !shouldRepairCurrentRun) {
      return task;
    }

    changed = true;
    const reviewedSnapshot = currentRun.beforeGitSnapshotId
      ? state.gitSnapshots.find((snapshot) => snapshot.id === currentRun.beforeGitSnapshotId)
      : undefined;
    const repairedAgentRun = repairedSourceRun?.status as
      | StatusProjection['agentRun']
      | undefined;
    return {
      ...task,
      workflowPhase: shouldRepairPhase ? 'REVIEW' : task.workflowPhase,
      currentRunId: repairedSourceRun?.id ?? task.currentRunId,
      currentAgentSessionId: repairedSourceRun?.sessionId ?? task.currentAgentSessionId,
      currentIterationId: repairedSourceRun?.iterationId ?? task.currentIterationId,
      currentWorktreeId: repairedSourceRun?.worktreeId ?? task.currentWorktreeId,
      projection: {
        ...task.projection,
        agentRun: repairedAgentRun ?? task.projection.agentRun,
        codexReview: {
          ...currentReview,
          status: reviewStatus,
          runId: currentRun.id,
          sourceRunId: currentRun.continuedFromRunId ?? currentReview?.sourceRunId,
          reviewedGitSnapshotId:
            currentRun.beforeGitSnapshotId ?? currentReview?.reviewedGitSnapshotId,
          reviewedHeadSha: reviewedSnapshot?.headSha ?? currentReview?.reviewedHeadSha,
          reviewedDirtyFingerprint:
            reviewedSnapshot?.dirtyFingerprint ?? currentReview?.reviewedDirtyFingerprint,
          finalArtifactId: currentRun.finalArtifactId ?? currentReview?.finalArtifactId,
          result: reviewResult ?? currentReview?.result,
          summary:
            reviewStatus === 'STALE'
              ? currentReview?.summary
              : (reviewResult?.summary ??
                (reviewStatus === 'RUNNING'
                  ? 'Codex is reviewing the current diff.'
                  : reviewStatus === 'CANCELED'
                    ? 'Codex review was stopped before completion.'
                    : reviewStatus === 'FAILED'
                      ? currentRun.terminalReason ??
                        'Codex review needs attention before it can be accepted.'
                      : currentReview?.summary)),
          updatedAt: currentRun.lastEventAt ?? currentRun.startedAt ?? currentReview?.updatedAt
        }
      },
      updatedAt: currentRun.lastEventAt ?? currentRun.startedAt ?? task.updatedAt
    };
  });

  return changed
    ? { state: { ...state, runs, tasks, previewResources }, changed }
    : { state, changed };
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

function isStaleIdleReviewRun(
  run: RunRecord,
  sessions: AgentSessionRecord[]
): boolean {
  if (
    run.mode !== 'REVIEW' ||
    !['STARTING', 'RUNNING'].includes(run.status)
  ) {
    return false;
  }
  const session = sessions.find((candidate) => candidate.id === run.sessionId);
  return (
    session?.role === 'REVIEW' &&
    ['IDLE', 'NOT_LOADED', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED'].includes(
      session.status
    )
  );
}

function isStaleInterruptingReviewRun(
  run: RunRecord,
  sessions: AgentSessionRecord[]
): boolean {
  if (run.mode !== 'REVIEW' || run.status !== 'INTERRUPTING') {
    return false;
  }
  const session = sessions.find((candidate) => candidate.id === run.sessionId);
  return (
    session?.role === 'REVIEW' &&
    ['IDLE', 'NOT_LOADED', 'SYSTEM_ERROR', 'ARCHIVED', 'DELETED'].includes(
      session.status
    )
  );
}

function findReviewRunForRepair(task: Task, runs: RunRecord[]): RunRecord | undefined {
  const projectedRunId = task.projection.codexReview?.runId;
  if (projectedRunId) {
    const projectedRun = runs.find((run) => run.id === projectedRunId && run.mode === 'REVIEW');
    if (projectedRun) {
      return projectedRun;
    }
  }
  if (task.currentRunId) {
    const currentRun = runs.find(
      (run) => run.id === task.currentRunId && run.mode === 'REVIEW'
    );
    if (currentRun) {
      return currentRun;
    }
  }
  return runs
    .filter(
      (run) =>
        run.taskId === task.id &&
        run.mode === 'REVIEW' &&
        (!task.currentIterationId || run.iterationId === task.currentIterationId)
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function findSourceRunForReviewRepair(
  reviewRun: RunRecord,
  runs: RunRecord[]
): RunRecord | undefined {
  if (reviewRun.continuedFromRunId) {
    const sourceRun = runs.find(
      (run) =>
        run.id === reviewRun.continuedFromRunId &&
        run.taskId === reviewRun.taskId &&
        run.mode !== 'REVIEW'
    );
    if (sourceRun) {
      return sourceRun;
    }
  }
  return runs
    .filter(
      (run) =>
        run.taskId === reviewRun.taskId &&
        run.iterationId === reviewRun.iterationId &&
        run.mode !== 'REVIEW'
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function clone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
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
