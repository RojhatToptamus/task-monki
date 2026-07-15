import type {
  CancelRunRequest,
  ContinueRunRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreateStoredTaskRequest,
  DeleteTaskRequest,
  DeleteTaskResult,
  GitSnapshotRecord,
  GitHubPreflightRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  PullRequestSnapshotRecord,
  ReadArtifactRequest,
  ReadProtocolMessageRequest,
  RefinePromptRequest,
  RefinePromptResponse,
  RepositoryPreflight,
  RunRecord,
  StartRunRequest,
  Task,
  TaskSnapshot,
  TransitionTaskRequest,
  WorktreeRecord,
  RefreshEvidenceRequest,
  CreatePullRequestRequest,
  RefreshGitHubRequest,
  RespondToInteractionRequest,
  RetryRunRequest,
  StartReviewRequest,
  SteerRunRequest,
  SyncAgentGoalRequest,
  AgentExecutionSettings,
  AgentRunMode,
  TaskManagerAppSettings,
  UpdateAppSettingsRequest,
  ExternalToolStatusReport,
  TestExternalToolRequest,
  ExternalToolProbeResult,
  InspectOpenTargetRequest,
  OpenTargetInspection,
  ExecuteOpenTargetActionRequest,
  OpenTargetActionResult,
  AttachmentContent,
  AttachmentDraftSnapshot,
  DiscardTaskAttachmentDraftRequest,
  ReadTaskAttachmentRequest,
  StageTaskAttachmentBatchRequest,
} from '../../shared/contracts';
import type {
  AddRepositoryRequest,
  RelinkRepositoryRequest,
  RemoveRepositoryRequest,
  RepositoryCatalogSnapshot,
  SelectRepositoryRequest
} from '../../shared/repositories';
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  completionPolicyRequiresPassingChecks,
  completionPolicyRequiresMerge,
  normalizeAgentApprovalsReviewer,
  normalizePullRequestTitle,
  verifiedChecksMatchMergeHead
} from '../../shared/contracts';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configureGitExecutablePath, git, gitSucceeds } from '../git/gitCli';
import { buildDiffEvidence, inspectGitSnapshot } from '../git/GitSnapshotService';
import { GitHubService } from '../github/GitHubService';
import { PromptRefinementService } from '../prompt/PromptRefinementService';
import {
  buildContinuationPrompt,
  buildForkAlternativeTaskPrompt,
  buildInitialRunPrompt,
  buildSteerInstruction
} from '../../shared/promptTemplates';
import { WorktreeService } from '../worktree/WorktreeService';
import { validateRepositoryPath } from '../repository/RepositoryPreflight';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';
import { AgentOrchestrator } from '../agent/AgentOrchestrator';
import type { AgentProviderAdapter } from '../agent/AgentProviderAdapter';
import { CodexAppServerAdapter } from '../agent/codex/CodexAppServerAdapter';
import { codexReadOnlyScopeProfile } from '../agent/codex/CodexPermissionProfile';
import {
  MemoryAppSettingsStore,
  type AppSettingsStorage
} from '../settings/AppSettingsStore';
import { ExternalToolResolver } from '../tools/ExternalToolResolver';
import { OpenTargetService, type OpenTargetHost } from '../open/OpenTargetService';
import {
  assertAttachmentSandboxSupportsDelivery,
  AgentAttachmentDeliveryError,
  assertModelSupportsAttachments
} from '../agent/AgentAttachmentDelivery';
import { AttachmentStoreError } from '../storage/AttachmentFileStore';
import type { RepositoryRegistry } from '../repository/RepositoryRegistry';
import type { AgentRuntimeStore } from '../agent/AgentRuntimeStore';
import { AgentTurnScheduler } from '../agent/AgentTurnScheduler';
import { TaskAgentRuntimeMigrator } from '../agent/TaskAgentRuntimeMigrator';
import type { DiscourseStore } from '../discourse/DiscourseStore';
import { DiscourseRuntimeCoordinator } from '../discourse/DiscourseRuntimeCoordinator';
import { DiscourseContextResolver } from '../discourse/DiscourseContextResolver';
import { DiscourseContextSnapshotService } from '../discourse/DiscourseContextSnapshotService';
import { DiscourseService } from '../discourse/DiscourseService';
import { DiscourseWorkspace } from '../discourse/DiscourseWorkspace';
import {
  appendDiscourseDelta,
  createDiscourseDeltaAccumulator,
  drainDiscourseDeltas,
  type DiscourseDeltaAccumulatorState
} from '../discourse/DiscourseDeltaAccumulator';
import { DISCOURSE_LIMITS } from '../../shared/discourse';
import type {
  AppendHumanDiscourseMessageRequest,
  CreateDiscourseConversationRequest,
  DeleteDiscourseConversationRequest,
  DeleteDiscourseDraftRequest,
  ListDiscourseConversationsRequest,
  ListDiscourseMessagesRequest,
  PreviewDiscourseContextRequest,
  RenameDiscourseConversationRequest,
  SaveDiscourseDraftRequest,
  SendDiscourseMessageRequest,
  ConfirmDiscourseWaveContextRequest,
  SetDiscourseConversationArchivedRequest,
  SetDiscourseConversationReadRequest,
  SetPinnedDiscourseContextRequest,
  StopDiscourseWaveRequest,
  TombstoneDiscourseMessageRequest
} from '../../shared/discourse';

export type RepositoryRequestErrorCode =
  | 'REPOSITORY_INVALID_REQUEST'
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_UNAVAILABLE'
  | 'REPOSITORY_IN_USE'
  | 'REPOSITORY_DEFAULT'
  | 'REPOSITORY_IDENTITY_MISMATCH';

export class RepositoryRequestError extends Error {
  constructor(
    readonly code: RepositoryRequestErrorCode,
    readonly httpStatus: 400 | 404 | 409,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'RepositoryRequestError';
  }
}

export class TaskManagerService {
  readonly events: AppEventBus;
  private readonly agents: AgentOrchestrator;
  private readonly codexAdapter: CodexAppServerAdapter;
  private readonly worktrees: WorktreeService;
  private readonly github: GitHubService;
  private readonly promptRefiner = new PromptRefinementService();
  private readonly appSettingsStore: AppSettingsStorage;
  private readonly repositoryRegistry?: RepositoryRegistry;
  private readonly externalToolResolver: ExternalToolResolver;
  private readonly openTargets: OpenTargetService;
  private readonly browserDevAgentBoundary: boolean;
  private readonly agentRuntimeStore?: AgentRuntimeStore;
  private readonly discourseStore?: DiscourseStore;
  private readonly discourseCoordinator?: DiscourseRuntimeCoordinator;
  private readonly discourseContextSnapshots?: DiscourseContextSnapshotService;
  private readonly discourse?: DiscourseService;
  private readonly agentTurnScheduler?: AgentTurnScheduler;
  private readonly serviceLifecycleId = randomUUID();
  private readonly discourseDeltaAccumulators = new Map<string, DiscourseDeltaAccumulatorState>();
  private readonly discourseDeltaTimers = new Map<string, NodeJS.Timeout>();
  private readonly taskActionLocks = new Map<string, string>();
  private readonly activeAttachmentDrafts = new Set<string>();
  private readonly agentProviderStartupDisabledReason?: string;
  private appSettings: TaskManagerAppSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS;
  private codexExecutable: string | undefined;

  constructor(
    private readonly store: FileTaskStore,
    private readonly defaultRepositoryPath: string,
    events = new AppEventBus(),
    options: {
      worktreeRoot?: string;
      gitPath?: string;
      ghPath?: string;
      codexPath?: string;
      agentCwd?: string;
      appSettingsStore?: AppSettingsStorage;
      repositoryRegistry?: RepositoryRegistry;
      agentProviderAdapter?: AgentProviderAdapter;
      openTargetHost?: OpenTargetHost;
      allowAgentNetworkAccess?: boolean;
      agentProviderStartupDisabledReason?: string;
      agentRuntimeStore?: AgentRuntimeStore;
      discourseStore?: DiscourseStore;
      discourseWorkspaceRoot?: string;
    } = {}
  ) {
    if (Boolean(options.agentRuntimeStore) !== Boolean(options.discourseStore)) {
      throw new Error(
        'The agent runtime and discourse stores must be configured together.'
      );
    }
    const agentCwd = options.agentCwd ?? (defaultRepositoryPath || process.cwd());
    this.browserDevAgentBoundary = options.allowAgentNetworkAccess === false;
    this.agentProviderStartupDisabledReason =
      options.agentProviderStartupDisabledReason;
    this.events = events;
    this.appSettingsStore = options.appSettingsStore ?? new MemoryAppSettingsStore();
    this.repositoryRegistry = options.repositoryRegistry;
    this.externalToolResolver = new ExternalToolResolver({
      cwd: agentCwd,
      overrides: {
        git: options.gitPath,
        codex: options.codexPath,
        gh: options.ghPath
      }
    });
    this.openTargets = new OpenTargetService(options.openTargetHost);
    this.agentRuntimeStore = options.agentRuntimeStore;
    this.discourseStore = options.discourseStore;
    if (this.discourseStore && this.repositoryRegistry) {
      const contextResolver = new DiscourseContextResolver(
        this.store,
        this.repositoryRegistry
      );
      this.discourseContextSnapshots = new DiscourseContextSnapshotService(
        contextResolver,
        new DiscourseWorkspace(
          options.discourseWorkspaceRoot ??
            path.join(os.tmpdir(), 'task-monki-discourse-workspaces')
        ),
        async (input) => {
          const profile = await codexReadOnlyScopeProfile({
            sessionId: input.sessionId,
            scope: {
              primaryCwd: input.primaryCwd,
              readOnlyRoots: input.readRoots.map((root) => root.canonicalPath)
            },
            reasoningEffort: input.modelSettings.reasoningEffort
          });
          return {
            attestation: { status: 'ATTESTED' },
            primaryCwd: input.primaryCwd,
            readRoots: input.readRoots,
            managedAttachments: [],
            permissionProfileHash: profile.scopeHash,
            modelSettings: input.modelSettings,
            externalTools: {
              network: false,
              webSearch: 'disabled',
              mcpServers: false,
              apps: false,
              dynamicTools: false
            },
            clientOperationId: input.clientOperationId
          };
        }
      );
    }
    if (this.agentRuntimeStore && this.discourseStore) {
      this.discourseCoordinator = new DiscourseRuntimeCoordinator(
        this.discourseStore,
        this.agentRuntimeStore
      );
      this.agentTurnScheduler = new AgentTurnScheduler(this.agentRuntimeStore);
    }
    this.codexAdapter = new CodexAppServerAdapter(store, events, {
      cwd: agentCwd,
      executable: options.codexPath,
      toolSettings: this.appSettings.codexExternalTools,
      failClosedMcpDiscovery: this.browserDevAgentBoundary,
      enforceBrowserDevBoundary: this.browserDevAgentBoundary,
      ...(this.agentRuntimeStore
        ? { providerRuntimeStore: this.agentRuntimeStore }
        : {}),
      ...(this.agentRuntimeStore && this.discourseCoordinator
        ? {
            scopedRuntimeStore: this.agentRuntimeStore,
            onScopedTurnCompleted: async (input) => {
              await this.ingestScopedCodexTerminal(input);
            },
            onScopedTurnDelta: async (input) => {
              await this.ingestScopedCodexDelta(input);
            }
          }
        : {})
    });
    this.agents = new AgentOrchestrator(
      store,
      events,
      options.agentProviderAdapter ?? this.codexAdapter,
      {
        allowNetworkAccess: options.allowAgentNetworkAccess,
        providerStartupDisabledReason: options.agentProviderStartupDisabledReason,
        ...(this.agentRuntimeStore && this.agentTurnScheduler
          ? {
              runtimeStore: this.agentRuntimeStore,
              scheduler: this.agentTurnScheduler,
              dispatchNonTaskQueueEntry: async (entry) => {
                if (entry.scope.kind !== 'DISCOURSE' || !this.discourseCoordinator) {
                  throw new Error('Global scheduler routed an invalid non-task entry.');
                }
                const scope = entry.scope;
                const aggregate = await this.discourseStore!.getConversation(
                  scope.conversationId
                );
                const snapshot = aggregate.contextSnapshots.find(
                  (candidate) => candidate.id === scope.contextSnapshotId
                );
                if (
                  !snapshot ||
                  (this.discourseContextSnapshots &&
                    await this.discourseContextSnapshots.freshness(snapshot) !== 'FRESH')
                ) {
                  const job = await this.discourseCoordinator.rejectLeasedJobForStaleContext(
                    entry.id,
                    `service-stale:${entry.id}:${entry.recordRevision}`
                  );
                  this.events.emit({
                    type: 'discourse.job.updated',
                    scope: {
                      kind: 'DISCOURSE',
                      conversationId: scope.conversationId,
                      waveId: scope.waveId,
                      jobId: scope.jobId
                    },
                    payload: job,
                    at: new Date().toISOString()
                  });
                  return;
                }
                const run = await this.discourseCoordinator.dispatchLeasedJob(
                  entry.id,
                  this.codexAdapter,
                  `service-dispatch:${entry.id}:${entry.recordRevision}`
                );
                this.events.emit({
                  type: 'discourse.job.updated',
                  scope: {
                    kind: 'DISCOURSE',
                    conversationId: scope.conversationId,
                    waveId: scope.waveId,
                    jobId: scope.jobId
                  },
                  runId: run.id,
                  payload: { status: run.status, delivery: run.delivery },
                  at: new Date().toISOString()
                });
              }
            }
          : {})
      }
    );
    this.worktrees = new WorktreeService(
      options.worktreeRoot ??
        process.env.TASK_MANAGER_WORKTREE_ROOT ??
        path.join(os.tmpdir(), 'task-monki-worktrees')
    );
    this.github = new GitHubService(options.ghPath);
    if (this.discourseStore && this.repositoryRegistry) {
      const contextResolver = new DiscourseContextResolver(this.store, this.repositoryRegistry);
      this.discourse = new DiscourseService(
        this.discourseStore,
        contextResolver,
        this.events,
        {
          getProviderState: () => this.agents.getProviderState(),
          getAppSettings: () => this.getAppSettings(),
          ...(this.discourseCoordinator && this.discourseContextSnapshots
            ? {
                runtime: {
                  coordinator: this.discourseCoordinator,
                  contextSnapshots: this.discourseContextSnapshots,
                  provider: this.codexAdapter,
                  notifySchedulerWorkAvailable: () =>
                    this.agents.notifySchedulerWorkAvailable()
                }
              }
            : {})
        }
      );
    }
    this.events.on((event) => {
      if (event.type === 'run.terminal' && event.runId) {
        void this.capturePostRunEvidence(event.runId);
      }
    });
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.initializeDiscourseRuntime();
    const initialSnapshot = await this.store.snapshot();
    if (this.repositoryRegistry) {
      await this.repositoryRegistry.reconcile([
        ...(this.defaultRepositoryPath
          ? [{ path: this.defaultRepositoryPath, source: 'DEFAULT' as const, isDefault: true }]
          : []),
        ...initialSnapshot.tasks.map((task) => ({
          path: task.repositoryPath,
          source: 'TASK' as const
        }))
      ]);
    }
    await this.appSettingsStore.initializeRepositories(async (legacy) => {
      const registry = this.requireRepositoryRegistry();
      await registry.reconcile([
        ...legacy.knownPaths.map((candidatePath) => ({
          path: candidatePath,
          source: 'LEGACY_SETTINGS' as const
        })),
        ...(legacy.selectedPath
          ? [{ path: legacy.selectedPath, source: 'LEGACY_SETTINGS' as const }]
          : [])
      ]);
      const selected = legacy.selectedPath
        ? await registry.resolveRecordedPath(legacy.selectedPath)
        : undefined;
      const state = await registry.snapshot();
      return {
        selectedRepositoryId:
          selected?.repositoryId ?? state.defaultRepositoryId ??
          state.repositories.find((record) => !record.removedAt)?.id ?? null
      };
    });
    this.appSettings = await this.loadBoundarySafeAppSettings();
    if (this.repositoryRegistry) {
      const catalog = await this.getRepositoryCatalog();
      if (catalog.selectedRepositoryId !== this.appSettings.repositories.selectedRepositoryId) {
        this.appSettings = await this.appSettingsStore.setSelectedRepositoryId(
          catalog.selectedRepositoryId
        );
      }
    }
    await this.applyRuntimeSettings({ restartCodex: false, updateCodex: true });
    await this.agents.initialize();
    if (this.agentProviderStartupDisabledReason) {
      return;
    }
    const snapshot = await this.store.snapshot();
    const recoveryTaskIds = new Set(
      snapshot.runs
        .filter((run) => run.recoveryState !== 'NONE')
        .map((run) => run.taskId)
    );
    await Promise.all(
      [...recoveryTaskIds].map((taskId) =>
        this.refreshEvidence({ taskId }).catch(() => undefined)
      )
    );
  }

  async getRepositoryCatalog(): Promise<RepositoryCatalogSnapshot> {
    const registry = this.requireRepositoryRegistry();
    const [settings, snapshot] = await Promise.all([
      this.appSettingsStore.get(),
      this.store.snapshot()
    ]);
    return registry.catalog({
      selectedRepositoryId: settings.repositories.selectedRepositoryId,
      tasks: snapshot.tasks
    });
  }

  async selectRepository(input: SelectRepositoryRequest): Promise<RepositoryCatalogSnapshot> {
    const repositoryId = requireRepositoryId(input?.repositoryId);
    await this.resolveRepository(repositoryId);
    this.appSettings = await this.appSettingsStore.setSelectedRepositoryId(repositoryId);
    return this.getRepositoryCatalog();
  }

  async addRepositoryFromTrustedPath(
    candidatePath: string,
    input: AddRepositoryRequest
  ): Promise<RepositoryCatalogSnapshot> {
    requireRepositoryMutationId(input?.clientMutationId);
    let record: Awaited<ReturnType<RepositoryRegistry['registerTrustedPath']>>;
    try {
      record = await this.requireRepositoryRegistry().registerTrustedPath(candidatePath);
    } catch (error) {
      throw new RepositoryRequestError(
        'REPOSITORY_UNAVAILABLE',
        409,
        'The selected folder is not an available Git repository.',
        { cause: error }
      );
    }
    this.appSettings = await this.appSettingsStore.setSelectedRepositoryId(record.id);
    return this.getRepositoryCatalog();
  }

  async relinkRepositoryFromTrustedPath(
    candidatePath: string,
    input: RelinkRepositoryRequest
  ): Promise<RepositoryCatalogSnapshot> {
    requireRepositoryMutationId(input?.clientMutationId);
    const repositoryId = requireRepositoryId(input?.repositoryId);
    try {
      await this.requireRepositoryRegistry().relinkTrustedPath(repositoryId, candidatePath);
    } catch (error) {
      throw new RepositoryRequestError(
        'REPOSITORY_IDENTITY_MISMATCH',
        409,
        'The selected folder does not match this registered repository.',
        { cause: error }
      );
    }
    return this.getRepositoryCatalog();
  }

  async removeRepository(input: RemoveRepositoryRequest): Promise<RepositoryCatalogSnapshot> {
    requireRepositoryMutationId(input?.clientMutationId);
    const repositoryId = requireRepositoryId(input?.repositoryId);
    const registry = this.requireRepositoryRegistry();
    const snapshot = await this.store.snapshot();
    const catalog = await registry.catalog({
      selectedRepositoryId: this.appSettings.repositories.selectedRepositoryId,
      tasks: snapshot.tasks
    });
    const inUse = catalog.taskAssociations.some(
      (association) => association.repositoryId === repositoryId
    );
    const record = (await registry.snapshot()).repositories.find(
      (candidate) => candidate.id === repositoryId
    );
    if (!record) {
      throw new RepositoryRequestError(
        'REPOSITORY_NOT_FOUND',
        404,
        'The repository is no longer registered.'
      );
    }
    if (!record.removedAt) {
      try {
        await registry.remove(repositoryId, { inUse });
      } catch (error) {
        const isDefault = repositoryId === (await registry.snapshot()).defaultRepositoryId;
        throw new RepositoryRequestError(
          isDefault ? 'REPOSITORY_DEFAULT' : inUse ? 'REPOSITORY_IN_USE' : 'REPOSITORY_UNAVAILABLE',
          409,
          isDefault
            ? 'The default repository cannot be removed.'
            : inUse
              ? 'Move or delete this repository’s tasks before removing it.'
              : 'The repository could not be removed.',
          { cause: error }
        );
      }
    }
    const repaired = await registry.catalog({
      selectedRepositoryId: this.appSettings.repositories.selectedRepositoryId,
      tasks: snapshot.tasks
    });
    if (repaired.selectedRepositoryId !== this.appSettings.repositories.selectedRepositoryId) {
      this.appSettings = await this.appSettingsStore.setSelectedRepositoryId(
        repaired.selectedRepositoryId
      );
    }
    return this.getRepositoryCatalog();
  }

  async getAppSettings(): Promise<TaskManagerAppSettings> {
    this.appSettings = await this.loadBoundarySafeAppSettings();
    return structuredClone(this.appSettings);
  }

  async updateAppSettings(
    input: UpdateAppSettingsRequest
  ): Promise<TaskManagerAppSettings> {
    if (input && typeof input === 'object' && 'repositories' in input) {
      throw new RepositoryRequestError(
        'REPOSITORY_INVALID_REQUEST',
        400,
        'Repository selection must use the repository catalog API and an authoritative repository id.'
      );
    }
    if (
      this.browserDevAgentBoundary &&
      input.codexExternalTools &&
      !codexExternalToolsAreDisabled({
        ...(await this.appSettingsStore.get()).codexExternalTools,
        ...input.codexExternalTools
      })
    ) {
      throw new Error(
        'Codex web search, MCP servers, and apps are disabled in the browser development server because external tool processes are outside its loopback security boundary. Use the Electron app to enable them.'
      );
    }
    const safeInput: UpdateAppSettingsRequest = this.browserDevAgentBoundary
      ? {
          ...input,
          codexExternalTools: { ...DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS }
        }
      : input;
    this.appSettings = await this.appSettingsStore.update(safeInput);
    const affectsExternalTools = Boolean(input.codexExternalTools || input.externalExecutables);
    if (affectsExternalTools) {
      const affectsCodexRuntime = affectsCodexRuntimeSettings(input);
      try {
        await this.applyRuntimeSettings({
          restartCodex: affectsCodexRuntime && !(await this.hasActiveAgentRun()),
          updateCodex: affectsCodexRuntime
        });
      } catch {
        // The setting is still saved; provider/tool status reports the runtime failure.
      }
      if (affectsCodexRuntime) {
        this.events.emit({
          type: 'provider.updated',
          scope: { kind: 'APP' },
          payload: await this.getAgentProviderState(),
          at: new Date().toISOString()
        });
      }
    }
    return structuredClone(this.appSettings);
  }

  async getExternalToolStatus(): Promise<ExternalToolStatusReport> {
    this.appSettings = await this.appSettingsStore.get();
    return this.externalToolResolver.getStatus(this.appSettings.externalExecutables);
  }

  async testExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult> {
    this.appSettings = await this.appSettingsStore.get();
    return this.externalToolResolver.probe(
      input.tool,
      this.appSettings.externalExecutables,
      input
    );
  }

  async inspectOpenTarget(input: InspectOpenTargetRequest): Promise<OpenTargetInspection> {
    return this.openTargets.inspect(input, {
      snapshot: await this.store.snapshot(),
      resolveRepositoryPath: async (repositoryId) =>
        (await this.resolveRepository(requireRepositoryId(repositoryId))).canonicalRealPath
    });
  }

  async executeOpenTargetAction(
    input: ExecuteOpenTargetActionRequest
  ): Promise<OpenTargetActionResult> {
    return this.openTargets.execute(input, {
      snapshot: await this.store.snapshot(),
      resolveRepositoryPath: async (repositoryId) =>
        (await this.resolveRepository(requireRepositoryId(repositoryId))).canonicalRealPath
    });
  }

  getAgentProviderState() {
    return this.agents.getProviderState();
  }

  listTasks(): Promise<TaskSnapshot> {
    return this.store.snapshot();
  }

  listDiscourseConversations(input: ListDiscourseConversationsRequest = {}) {
    return this.requireDiscourseService().listConversations(input);
  }

  getDiscourseConversation(conversationId: string) {
    return this.requireDiscourseService().getConversation(conversationId);
  }

  listDiscourseMessages(input: ListDiscourseMessagesRequest) {
    return this.requireDiscourseService().listMessages(input);
  }

  getDiscourseMentionCatalog() {
    return this.requireDiscourseService().getMentionCatalog();
  }

  createDiscourseConversation(input: CreateDiscourseConversationRequest) {
    return this.requireDiscourseService().createConversation(input);
  }

  appendHumanDiscourseMessage(input: AppendHumanDiscourseMessageRequest) {
    return this.requireDiscourseService().appendHumanMessage(input);
  }

  sendDiscourseMessage(input: SendDiscourseMessageRequest) {
    return this.requireDiscourseService().sendMessage(input);
  }

  tombstoneDiscourseMessage(input: TombstoneDiscourseMessageRequest) {
    return this.requireDiscourseService().tombstoneMessage(input);
  }

  setPinnedDiscourseContext(input: SetPinnedDiscourseContextRequest) {
    return this.requireDiscourseService().setPinnedContext(input);
  }

  previewDiscourseContext(input: PreviewDiscourseContextRequest) {
    return this.requireDiscourseService().previewContext(input);
  }

  saveDiscourseDraft(input: SaveDiscourseDraftRequest) {
    return this.requireDiscourseService().saveDraft(input);
  }

  getDiscourseDraft(draftId: string) {
    return this.requireDiscourseService().getDraft(draftId);
  }

  listDiscourseDrafts() {
    return this.requireDiscourseService().listDrafts();
  }

  deleteDiscourseDraft(input: DeleteDiscourseDraftRequest) {
    return this.requireDiscourseService().deleteDraft(input);
  }

  renameDiscourseConversation(input: RenameDiscourseConversationRequest) {
    return this.requireDiscourseService().renameConversation(input);
  }

  setDiscourseConversationRead(input: SetDiscourseConversationReadRequest) {
    return this.requireDiscourseService().setConversationRead(input);
  }

  setDiscourseConversationArchived(input: SetDiscourseConversationArchivedRequest) {
    return this.requireDiscourseService().setConversationArchived(input);
  }

  deleteDiscourseConversation(input: DeleteDiscourseConversationRequest) {
    return this.requireDiscourseService().deleteConversation(input);
  }

  stopDiscourseWave(input: StopDiscourseWaveRequest) {
    return this.requireDiscourseService().stopWave(input);
  }

  confirmDiscourseWaveContext(input: ConfirmDiscourseWaveContextRequest) {
    return this.requireDiscourseService().confirmWaveContext(input);
  }

  async stageTaskAttachmentBatch(
    input: StageTaskAttachmentBatchRequest
  ): Promise<AttachmentDraftSnapshot> {
    const attachments = input?.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) {
      throw new AttachmentStoreError(
        'ATTACHMENT_INVALID_REQUEST',
        'At least one attachment is required.',
        400
      );
    }
    if (attachments.length > ATTACHMENT_MAX_COUNT) {
      throw new AttachmentStoreError(
        'ATTACHMENT_LIMIT_EXCEEDED',
        `A task can have at most ${ATTACHMENT_MAX_COUNT} attachments.`,
        413
      );
    }
    let totalBytes = 0;
    for (const attachment of attachments) {
      if (!(attachment?.bytes instanceof ArrayBuffer)) {
        throw new AttachmentStoreError(
          'ATTACHMENT_INVALID_REQUEST',
          'Attachment bytes are required.',
          400
        );
      }
      totalBytes += attachment.bytes.byteLength;
      if (totalBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
        throw new AttachmentStoreError(
          'ATTACHMENT_TOTAL_TOO_LARGE',
          'Attachments exceed the per-task size limit.',
          413
        );
      }
    }

    const draft = await this.store.createAttachmentDraft();
    try {
      for (const attachment of attachments) {
        await this.store.stageTaskAttachment({
          draftId: draft.id,
          clientToken: attachment.clientToken,
          displayName: attachment.displayName,
          declaredMediaType: attachment.declaredMediaType,
          bytes: new Uint8Array(attachment.bytes.slice(0))
        });
      }
      return this.store.listAttachmentDraft(draft.id);
    } catch (error) {
      await this.store.discardAttachmentDraft(draft.id).catch(() => undefined);
      throw error;
    }
  }

  discardTaskAttachmentDraft(
    input: DiscardTaskAttachmentDraftRequest
  ): Promise<void> {
    return this.withAttachmentDraft(input.draftId, () =>
      this.store.discardAttachmentDraft(input.draftId)
    );
  }

  readTaskAttachment(input: ReadTaskAttachmentRequest): Promise<AttachmentContent> {
    return this.store.readTaskAttachment(input.attachmentId);
  }

  async createTask(input: CreateTaskRequest): Promise<Task> {
    const resolved = await this.resolveRepository(requireRepositoryId(input?.repositoryId));
    const { repositoryId: _repositoryId, ...rest } = input;
    return this.createTaskFromTrustedPath({
      ...rest,
      repositoryPath: resolved.canonicalRealPath
    });
  }

  async createTaskFromTrustedPath(input: CreateStoredTaskRequest): Promise<Task> {
    const acknowledgedTask = await this.store.resolveTaskCreationRetry(input);
    if (acknowledgedTask) {
      return acknowledgedTask;
    }
    if (!input.attachmentDraftId) {
      return this.store.createTask(input);
    }
    return this.withAttachmentDraft(input.attachmentDraftId, async () => {
      // The first request may complete between the initial lookup and entry to
      // this critical section. Resolve it before reading a draft that successful
      // task creation has intentionally consumed.
      const acknowledgedInsideLock = await this.store.resolveTaskCreationRetry(input);
      if (acknowledgedInsideLock) {
        return acknowledgedInsideLock;
      }
      const draft = await this.store.listAttachmentDraft(input.attachmentDraftId!);
      if (input.agentSettings?.networkAccess === true) {
        throw new Error('Network access must be disabled for tasks with attachments.');
      }
      if (!codexExternalToolsAreDisabled(this.appSettings.codexExternalTools)) {
        throw new Error(
          'Disable Codex web search, MCP servers, and apps before creating a task with attachments.'
        );
      }
      assertAttachmentSandboxSupportsDelivery(
        input.agentSettings ?? {},
        draft.attachments
      );
      if (draft.attachments.some((attachment) => attachment.kind === 'image')) {
        const provider = await this.agents.getProviderState();
        const requestedModel = input.agentSettings?.model;
        const model =
          provider.models.find((candidate) => candidate.model === requestedModel) ??
          provider.models.find((candidate) => candidate.id === requestedModel) ??
          provider.models.find((candidate) => candidate.isDefault) ??
          provider.models[0];
        if (!model) {
          throw new AgentAttachmentDeliveryError(
            'MODEL_DOES_NOT_SUPPORT_IMAGES',
            'Codex must report an image-capable model before this task can be created with images.'
          );
        }
        assertModelSupportsAttachments(model, draft.attachments);
      }
      return this.store.createTask(input);
    });
  }

  async refinePrompt(input: RefinePromptRequest): Promise<RefinePromptResponse> {
    await this.assertAttachmentProviderBoundaryAvailable();
    const repository = await this.resolveRepository(requireRepositoryId(input?.repositoryId));
    const refined = await this.promptRefiner.refine(
      repository.canonicalRealPath,
      input.input,
      input.model,
      this.codexExecutable,
      this.appSettings.codexExternalTools,
      this.browserDevAgentBoundary
    );
    this.events.emit({
      type: 'prompt.refined',
      taskId: 'prompt-preview',
      payload: refined,
      at: new Date().toISOString()
    });
    return refined;
  }

  async prepareWorktree(input: PrepareWorktreeRequest): Promise<WorktreeRecord> {
    const task = await this.requireTask(input.taskId);
    const existing = await this.store.getCurrentWorktree(task.id);
    if (existing && existing.status !== 'ERROR' && existing.status !== 'MISSING') {
      const verified = await this.worktrees.verify(existing);
      return this.store.updateWorktree(verified, 'WORKTREE_VERIFIED');
    }

    const preflight = await this.validateAndRecordRepository(task);
    const spec = this.worktrees.buildSpec(task, preflight);
    return this.createAndPrepareWorktree(task, spec);
  }

  private async createAndPrepareWorktree(
    task: Task,
    spec: {
      branchName: string;
      worktreePath: string;
      baseRef?: string;
      baseSha: string;
    }
  ): Promise<WorktreeRecord> {
    const { worktree } = await this.store.createIterationAndWorktree({
      task,
      branchName: spec.branchName,
      worktreePath: spec.worktreePath,
      baseRef: spec.baseRef,
      baseSha: spec.baseSha
    });

    try {
      const created = await this.worktrees.create(worktree);
      const stored = await this.store.updateWorktree(created, 'WORKTREE_CREATED');
      await this.refreshEvidence({ taskId: task.id });
      this.events.emit({
        type: 'worktree.updated',
        taskId: task.id,
        iterationId: stored.iterationId,
        worktreeId: stored.id,
        payload: stored,
        at: new Date().toISOString()
      });
      return stored;
    } catch (error) {
      const failed: WorktreeRecord = {
        ...worktree,
        status: 'ERROR',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      };
      await this.store.updateWorktree(failed, 'WORKTREE_FAILED');
      throw error;
    }
  }

  async startRun(input: StartRunRequest): Promise<RunRecord> {
    return this.withTaskAction(input.taskId, 'Agent run', async () => {
      await this.assertAttachmentProviderBoundaryAvailable();
      const task = await this.requireTask(input.taskId);
      const snapshot = await this.store.snapshot();
      this.assertNoActiveTaskRun(snapshot, task.id, 'starting agent work');
      const worktree = await this.prepareWorktree({ taskId: task.id });
      return this.startPreparedRun({
        task,
        worktree,
        mode: input.mode,
        settings: input.settings
      });
    });
  }

  private async startPreparedRun(input: {
    task: Task;
    worktree: WorktreeRecord;
    mode?: AgentRunMode;
    settings?: AgentExecutionSettings;
  }): Promise<RunRecord> {
    await this.assertAttachmentProviderBoundaryAvailable();
    const { task, worktree } = input;
    const iteration = await this.store.getCurrentIteration(task.id);
    if (!iteration) {
      throw new Error('Task iteration was not created.');
    }
    if (iteration.id !== worktree.iterationId) {
      throw new Error('Prepared worktree does not match the current task iteration.');
    }
    const snapshot = await this.refreshEvidence({ taskId: task.id });
    const mode = input.mode ?? 'IMPLEMENTATION';
    const readOnlyMode = mode === 'ANALYSIS' || mode === 'REVIEW';
    const settings = mergeRunSettings({
      readOnly: readOnlyMode,
      settings: [task.agentSettings, input.settings]
    });
    const prompt = buildInitialRunPrompt({ task, worktree, settings, readOnlyMode });

    return this.agents.startTurn({
      task,
      iteration,
      worktree,
      mode,
      prompt,
      settings,
      generationKey: snapshot.dirtyFingerprint,
      beforeGitSnapshotId: snapshot.id
    });
  }

  cancelRun(input: CancelRunRequest): Promise<void> {
    return this.agents.interruptRun(input.runId);
  }

  async steerRun(input: SteerRunRequest): Promise<void> {
    const run = await this.requireRunForTask(input.runId, input.taskId);
    const snapshot = await this.store.snapshot();
    const worktree = snapshot.worktrees.find((candidate) => candidate.id === run.worktreeId);
    return this.agents.steerRun(
      run.id,
      buildSteerInstruction({
        instruction: input.instruction,
        worktreePath: worktree?.worktreePath
      })
    );
  }

  async continueRun(input: ContinueRunRequest): Promise<RunRecord> {
    return this.withTaskAction(input.taskId, 'Agent follow-up', async () => {
      await this.assertAttachmentProviderBoundaryAvailable();
      const { task, run, iteration, worktree } = await this.requireContinuationContext(
        input.taskId,
        input.runId
      );
      const snapshot = await this.store.snapshot();
      assertContinuable(run);
      this.assertNoActiveTaskRun(snapshot, task.id, 'starting follow-up work', {
        exceptRunId: run.id
      });
      const gitSnapshot = await this.refreshEvidence({ taskId: task.id });
      const settings = followUpSettings(task, run, input.settings, false);
      const prompt = buildContinuationPrompt({
        task,
        run,
        gitSnapshot,
        instruction: input.instruction,
        kind: 'continuation'
      });
      await this.agents.resolveRecoveryRunForReplacement(run.id);
      return this.agents.startTurn({
        task,
        iteration,
        worktree,
        sessionId: run.sessionId,
        mode: 'FOLLOW_UP',
        prompt,
        settings,
        generationKey: gitSnapshot.dirtyFingerprint,
        beforeGitSnapshotId: gitSnapshot.id,
        continuedFromRunId: run.id
      });
    });
  }

  async retryRun(input: RetryRunRequest): Promise<RunRecord> {
    return this.withTaskAction(input.taskId, 'Agent retry', async () => {
      await this.assertAttachmentProviderBoundaryAvailable();
      const { task, run, iteration, worktree } = await this.requireContinuationContext(
        input.taskId,
        input.runId
      );
      const snapshot = await this.store.snapshot();
      assertRetryable(run);
      this.assertNoActiveTaskRun(snapshot, task.id, 'retrying agent work', {
        exceptRunId: run.id
      });
      if (input.strategy === 'FORK') {
        await this.agents.resolveRecoveryRunForReplacement(run.id);
        return this.startForkedAlternative({
          sourceTaskId: task.id,
          sourceRun: run,
          sourceWorktree: worktree,
          instruction: input.instruction,
          settings: input.settings
        });
      }
      const gitSnapshot = await this.refreshEvidence({ taskId: task.id });
      const settings = followUpSettings(task, run, input.settings, false);
      const prompt = buildContinuationPrompt({
        task,
        run,
        gitSnapshot,
        instruction: input.instruction,
        kind: 'retry'
      });
      await this.agents.resolveRecoveryRunForReplacement(run.id);
      return this.agents.startTurn({
        task,
        iteration,
        worktree,
        sessionId: run.sessionId,
        mode: 'RETRY',
        prompt,
        settings,
        generationKey: gitSnapshot.dirtyFingerprint,
        beforeGitSnapshotId: gitSnapshot.id,
        retryOfRunId: run.id
      });
    });
  }

  private async startForkedAlternative(input: {
    sourceTaskId: string;
    sourceRun: RunRecord;
    sourceWorktree: WorktreeRecord;
    instruction?: string;
    settings?: AgentExecutionSettings;
  }): Promise<RunRecord> {
    const sourceTask = await this.requireTask(input.sourceTaskId);
    const alternativeNumber = (sourceTask.forkedAlternativeTaskIds?.length ?? 0) + 1;
    const alternativeTask = await this.store.createForkedAlternativeTask({
      title: `Alternative #${alternativeNumber}: ${sourceTask.title}`,
      prompt: buildForkAlternativeTaskPrompt({
        task: sourceTask,
        run: input.sourceRun,
        worktree: input.sourceWorktree,
        instruction: input.instruction
      }),
      repositoryPath: sourceTask.repositoryPath,
      agentSettings: sourceTask.agentSettings,
      sourceTaskId: sourceTask.id,
      sourceRunId: input.sourceRun.id
    });
    try {
      const spec = this.worktrees.buildSpecFromBase(alternativeTask, {
        baseRef: input.sourceWorktree.baseRef,
        baseSha: input.sourceWorktree.baseSha
      });
      const alternativeWorktree = await this.createAndPrepareWorktree(alternativeTask, spec);
      return await this.startPreparedRun({
        task: alternativeTask,
        worktree: alternativeWorktree,
        mode: 'IMPLEMENTATION',
        settings: input.settings
      });
    } catch (error) {
      await this.markForkedAlternativeSetupFailed(alternativeTask.id, error);
      throw error;
    }
  }

  private async markForkedAlternativeSetupFailed(
    taskId: string,
    error: unknown
  ): Promise<void> {
    const reason = `Fork alternative setup failed: ${error instanceof Error ? error.message : String(error)}`;
    try {
      await this.store.transitionTask(taskId, 'BLOCKED', reason);
    } catch {
      // Preserve the original setup failure for the caller.
    }
  }

  private async applyRuntimeSettings(input: {
    restartCodex: boolean;
    updateCodex: boolean;
  }): Promise<ExternalToolStatusReport> {
    const status = await this.externalToolResolver.getStatus(
      this.appSettings.externalExecutables
    );
    configureGitExecutablePath(executableForRuntime(status.tools.git));
    this.github.setExecutable(executableForRuntime(status.tools.gh));
    if (input.updateCodex) {
      this.codexExecutable = explicitExecutableForCodexRuntime(status.tools.codex);
      await this.codexAdapter.updateRuntimeConfig({
        executable: this.codexExecutable,
        toolSettings: this.appSettings.codexExternalTools,
        restart: input.restartCodex
      });
    }
    return status;
  }

  private async loadBoundarySafeAppSettings(): Promise<TaskManagerAppSettings> {
    const stored = await this.appSettingsStore.get();
    if (
      !this.browserDevAgentBoundary ||
      codexExternalToolsAreDisabled(stored.codexExternalTools)
    ) {
      return stored;
    }
    return this.appSettingsStore.update({
      codexExternalTools: { ...DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS }
    });
  }

  private requireRepositoryRegistry(): RepositoryRegistry {
    if (!this.repositoryRegistry) {
      throw new Error('Repository registry is not configured for this Task Monki service.');
    }
    return this.repositoryRegistry;
  }

  private requireDiscourseService(): DiscourseService {
    if (!this.discourse) {
      throw new Error('Global discourse is not configured for this Task Monki service.');
    }
    return this.discourse;
  }

  private async resolveRepository(repositoryId: string) {
    try {
      return await this.requireRepositoryRegistry().resolve(repositoryId);
    } catch (error) {
      throw new RepositoryRequestError(
        'REPOSITORY_UNAVAILABLE',
        409,
        'The repository is unavailable or its identity has changed.',
        { cause: error }
      );
    }
  }

  private async hasActiveAgentRun(): Promise<boolean> {
    const snapshot = await this.store.snapshot();
    return snapshot.runs.some((run) => ACTIVE_AGENT_RUN_STATUSES.has(run.status));
  }

  async startReview(input: StartReviewRequest): Promise<RunRecord> {
    return this.withTaskAction(input.taskId, 'Codex review', async () => {
      await this.assertAttachmentProviderBoundaryAvailable();
      const task = await this.requireTask(input.taskId);
      const snapshot = await this.store.snapshot();
      this.assertNoActiveTaskRun(snapshot, task.id, 'starting a review');
      const runId = input.runId ?? task.currentRunId;
      if (!runId) {
        throw new Error('Complete an agent turn before starting a detached review.');
      }
      const run = await this.requireRunForTask(runId, task.id);
      if (
        ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING'].includes(
          run.status
        )
      ) {
        throw new Error('Wait for the active turn to finish before starting a review.');
      }
      const iteration = snapshot.iterations.find(
        (candidate) => candidate.id === run.iterationId
      );
      const worktree = snapshot.worktrees.find(
        (candidate) => candidate.id === run.worktreeId
      );
      if (!iteration || !worktree) {
        throw new Error('The source run no longer has a valid task iteration.');
      }
      const gitSnapshot = await this.refreshEvidence({ taskId: task.id });
      const settings = followUpSettings(task, run, input.settings, true);
      return this.agents.startReview({
        task,
        iteration,
        worktree,
        sourceRun: run,
        target: input.target ?? { type: 'UNCOMMITTED_CHANGES' },
        settings,
        generationKey: gitSnapshot.dirtyFingerprint,
        beforeGitSnapshotId: gitSnapshot.id
      });
    });
  }

  async syncAgentGoal(input: SyncAgentGoalRequest) {
    await this.assertAttachmentProviderBoundaryAvailable();
    const task = await this.requireTask(input.taskId);
    return this.agents.syncGoal(task, input.sessionId);
  }

  respondToInteraction(input: RespondToInteractionRequest) {
    return this.agents.respondToInteraction(input);
  }

  async shutdown(): Promise<void> {
    let firstError: unknown;
    for (const timer of this.discourseDeltaTimers.values()) clearTimeout(timer);
    this.discourseDeltaTimers.clear();
    this.discourseDeltaAccumulators.clear();
    if (this.agentTurnScheduler) {
      try {
        await this.agentTurnScheduler.latchShutdown(
          `service-shutdown:${this.serviceLifecycleId}`
        );
      } catch (error) {
        firstError = error;
      }
    }
    try {
      await this.agents.shutdown();
    } catch (error) {
      firstError ??= error;
    }
    for (const close of [
      () => this.discourseStore?.close(),
      () => this.agentRuntimeStore?.close(),
      () => this.store.close()
    ]) {
      try {
        await close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) {
      throw firstError;
    }
  }

  private async initializeDiscourseRuntime(): Promise<void> {
    if (!this.agentRuntimeStore || !this.discourseStore || !this.discourseCoordinator) {
      return;
    }
    await this.agentRuntimeStore.init();
    await new TaskAgentRuntimeMigrator(
      this.store,
      this.agentRuntimeStore
    ).migrateTaskStoreV11();
    await this.repairDeletedTaskRuntime();
    await this.discourseStore.init();

    const conversationIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.discourseStore.listConversations({
        ...(cursor ? { cursor } : {}),
        limit: 100
      });
      page.conversations.forEach((conversation) => {
        conversationIds.add(conversation.id);
      });
      cursor = page.nextCursor;
    } while (cursor);

    const runtimeSnapshot = await this.agentRuntimeStore.snapshot();
    runtimeSnapshot.runs.forEach((run) => {
      if (run.scope.kind === 'DISCOURSE') {
        conversationIds.add(run.scope.conversationId);
      }
    });
    for (const conversationId of conversationIds) {
      if (this.discourse) {
        await this.discourse.recoverConversation(conversationId);
      } else {
        await this.discourseCoordinator.recoverConversation(conversationId);
      }
    }

    const recoveredSnapshot = await this.agentRuntimeStore.snapshot();
    if (
      recoveredSnapshot.shutdownLatched &&
      !recoveredSnapshot.queueEntries.some((entry) => entry.status === 'LEASED')
    ) {
      await this.agentTurnScheduler?.reopenAfterRecovery(
        `service-startup:${this.serviceLifecycleId}`
      );
    }
  }

  private async repairDeletedTaskRuntime(): Promise<void> {
    if (!this.agentRuntimeStore) return;
    const [tasks, runtime] = await Promise.all([
      this.store.snapshot(),
      this.agentRuntimeStore.snapshot()
    ]);
    const taskIds = new Set(tasks.tasks.map((task) => task.id));
    const orphanTaskIds = new Set(
      [...runtime.sessions, ...runtime.runs]
        .filter(
          (record) =>
            record.owner.kind === 'TASK' && !taskIds.has(record.owner.taskId)
        )
        .map((record) =>
          record.owner.kind === 'TASK' ? record.owner.taskId : ''
        )
        .filter(Boolean)
    );
    for (const taskId of orphanTaskIds) {
      await this.agentRuntimeStore.purgeTask(taskId);
    }
  }

  private async ingestScopedCodexTerminal(input: {
    runId: string;
    providerTurnId: string;
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
    finalMessage?: string;
    error?: string;
    completedAt: string;
  }): Promise<void> {
    if (!this.agentRuntimeStore || !this.discourseCoordinator) return;
    try {
      await this.flushScopedCodexDelta(input.runId);
      this.discourseDeltaAccumulators.delete(input.runId);
      const run = await this.agentRuntimeStore.getRun(input.runId);
      if (!run || run.scope.kind !== 'DISCOURSE') {
        throw new Error(`Scoped Codex terminal references an unknown discourse run: ${input.runId}`);
      }
      const scope = run.scope;
      const body =
        input.finalMessage ??
        (await this.agentRuntimeStore.readArtifact(run.outputArtifactId));
      const discourseAggregate = this.discourseStore
        ? await this.discourseStore.getConversation(scope.conversationId)
        : undefined;
      const snapshot = discourseAggregate?.contextSnapshots.find(
        (candidate) => candidate.id === scope.contextSnapshotId
      );
      const freshness = this.discourseContextSnapshots && snapshot
        ? await this.discourseContextSnapshots.freshness(snapshot)
        : run.contextFreshnessAtCompletion ?? 'UNKNOWN';
      const job = discourseAggregate?.jobs.find((candidate) => candidate.id === scope.jobId);
      const operationId = `codex-terminal:${input.runId}:${input.providerTurnId}`;
      if (run.status === 'COMPLETED' && body.trim()) {
        if (!job) throw new Error(`Scoped Codex terminal references an unknown job: ${scope.jobId}`);
        const terminalInput = {
          runId: input.runId,
          providerTurnId: input.providerTurnId,
          body,
          freshnessAtCompletion: freshness,
          clientOperationId: operationId,
          completedAt: input.completedAt,
          providerTerminalSource:
            run.providerTerminalSource ?? 'TURN_COMPLETED_NOTIFICATION'
        };
        const result = job.role === 'CRITIQUE'
          ? await this.discourseCoordinator.ingestReview(terminalInput)
          : job.role === 'CORRECT'
            ? await this.discourseCoordinator.ingestCorrection(terminalInput)
            : await this.discourseCoordinator.ingestContribution(terminalInput);
        if (result.kind !== 'CONVERSATION_DELETED') {
          await this.discourse?.advanceWave(
            scope.conversationId,
            scope.waveId,
            `${operationId}:advance`
          );
        }
        this.events.emit({
          type: result.kind === 'CURATED'
            ? 'discourse.message.appended'
            : 'discourse.job.updated',
          scope: {
            kind: 'DISCOURSE',
            conversationId: scope.conversationId,
            waveId: scope.waveId,
            jobId: scope.jobId
          },
          runId: run.id,
          payload: result,
          at: input.completedAt
        });
        return;
      }
      await this.discourseCoordinator.ingestFailure({
        runId: input.runId,
        providerTurnId: input.providerTurnId,
        clientOperationId: operationId,
        completedAt: input.completedAt,
        providerTerminalSource:
          run.providerTerminalSource ?? 'TURN_COMPLETED_NOTIFICATION',
        reason:
          input.error ??
          (input.status === 'completed'
            ? 'Codex completed the scoped turn without a response.'
              : `Codex scoped turn ended with status ${input.status}.`)
      });
      await this.discourse?.advanceWave(
        scope.conversationId,
        scope.waveId,
        `${operationId}:advance-failure`
      );
      this.events.emit({
        type: 'discourse.job.updated',
        scope: {
          kind: 'DISCOURSE',
          conversationId: scope.conversationId,
          waveId: scope.waveId,
          jobId: scope.jobId
        },
        runId: run.id,
        payload: { status: 'FAILED' },
        at: input.completedAt
      });
    } finally {
      this.agents.notifySchedulerWorkAvailable();
    }
  }

  private async ingestScopedCodexDelta(input: {
    runId: string;
    providerTurnId: string;
    text: string;
    observedAt: string;
  }): Promise<void> {
    if (!this.agentRuntimeStore || !this.discourseStore) return;
    const run = await this.agentRuntimeStore.getRun(input.runId);
    if (
      !run ||
      run.scope.kind !== 'DISCOURSE' ||
      run.providerTurnId !== input.providerTurnId ||
      run.status !== 'RUNNING'
    ) return;
    const scope = run.scope;
    const aggregate = await this.discourseStore.getConversation(scope.conversationId);
    const wave = aggregate.waves.find((candidate) => candidate.id === scope.waveId);
    if (!wave) return;
    const current = this.discourseDeltaAccumulators.get(run.id) ??
      createDiscourseDeltaAccumulator(scope.jobId, wave.attempt);
    const appended = appendDiscourseDelta(current, {
      jobId: scope.jobId,
      attempt: wave.attempt,
      text: input.text
    });
    if (!appended.accepted) return;
    this.discourseDeltaAccumulators.set(run.id, appended.state);
    if (this.discourseDeltaTimers.has(run.id)) return;
    const timer = setTimeout(() => {
      this.discourseDeltaTimers.delete(run.id);
      void this.flushScopedCodexDelta(run.id, input.observedAt);
    }, DISCOURSE_LIMITS.deltaCoalesceIntervalMs);
    this.discourseDeltaTimers.set(run.id, timer);
  }

  private async flushScopedCodexDelta(
    runId: string,
    observedAt = new Date().toISOString()
  ): Promise<void> {
    const timer = this.discourseDeltaTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.discourseDeltaTimers.delete(runId);
    const current = this.discourseDeltaAccumulators.get(runId);
    if (!current) return;
    const drained = drainDiscourseDeltas(current);
    if (drained.publication) {
      const run = await this.agentRuntimeStore?.getRun(runId);
      if (run?.scope.kind === 'DISCOURSE') {
        this.events.emit({
          type: 'discourse.delta',
          scope: {
            kind: 'DISCOURSE',
            conversationId: run.scope.conversationId,
            waveId: run.scope.waveId,
            jobId: run.scope.jobId
          },
          runId,
          payload: {
            jobId: run.scope.jobId,
            attempt: current.attempt,
            publication: drained.publication
          },
          at: observedAt
        });
      }
    }
    if (drained.state.truncated) {
      this.discourseDeltaAccumulators.delete(runId);
    } else {
      this.discourseDeltaAccumulators.set(runId, drained.state);
    }
  }

  private async assertAttachmentProviderBoundaryAvailable(): Promise<void> {
    if (this.agentProviderStartupDisabledReason) {
      throw new Error(this.agentProviderStartupDisabledReason);
    }
  }

  async refreshEvidence(input: RefreshEvidenceRequest): Promise<GitSnapshotRecord> {
    const task = await this.requireTask(input.taskId);
    const worktree = await this.requireWorktree(task);
    const verified = await this.worktrees.verify(worktree);
    const storedWorktree = await this.store.updateWorktree(verified, 'WORKTREE_VERIFIED');
    if (storedWorktree.status !== 'PRESENT') {
      throw new Error(`Worktree is not ready: ${storedWorktree.status}`);
    }

    const snapshot = await inspectGitSnapshot(storedWorktree);
    const diffEvidence = await buildDiffEvidence(storedWorktree);
    const storedSnapshot = await this.store.recordGitSnapshot(snapshot, diffEvidence);
    this.events.emit({
      type: 'git.updated',
      taskId: task.id,
      iterationId: storedSnapshot.iterationId,
      worktreeId: storedSnapshot.worktreeId,
      payload: storedSnapshot,
      at: new Date().toISOString()
    });
    return storedSnapshot;
  }

  async createDeliveryCommit(input: CreateDeliveryCommitRequest): Promise<GitSnapshotRecord> {
    return this.withTaskAction(input.taskId, 'GitHub delivery', () =>
      this.createDeliveryCommitUnlocked(input)
    );
  }

  private async createDeliveryCommitUnlocked(
    input: CreateDeliveryCommitRequest
  ): Promise<GitSnapshotRecord> {
    const task = await this.requireTask(input.taskId);
    const snapshot = await this.store.snapshot();
    this.assertNoActiveTaskRun(snapshot, task.id, 'creating a delivery commit');
    const worktree = await this.requireWorktree(task);
    const latestGit = await this.refreshEvidence({ taskId: task.id });
    if (
      latestGit.status === 'CONFLICTED' ||
      latestGit.status === 'DIVERGED' ||
      latestGit.status === 'UNAVAILABLE' ||
      latestGit.status === 'UNKNOWN'
    ) {
      throw new Error(`Cannot create delivery commit while Git status is ${latestGit.status}.`);
    }
    if (latestGit.workingDiffFileCount === 0 && latestGit.stagedCount === 0 && latestGit.untrackedCount === 0) {
      throw new Error('No uncommitted task changes are available to commit.');
    }

    await git(worktree.worktreePath, ['add', '-A']);
    const hasStagedChanges = !(await gitSucceeds(worktree.worktreePath, ['diff', '--cached', '--quiet']));
    if (!hasStagedChanges) {
      throw new Error('No staged changes are available to commit.');
    }
    await git(worktree.worktreePath, ['commit', '-m', `Task: ${task.title}`], 120_000);
    const headSha = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await this.store.appendEvent(
      createDomainEvent({
        type: 'DELIVERY_COMMIT_CREATED',
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        source: 'git',
        payload: { headSha, branchName: worktree.branchName }
      })
    );
    return this.refreshEvidence({ taskId: task.id });
  }

  async preflightGitHub(input: GitHubPreflightRequest) {
    const task = await this.requireTask(input.taskId);
    const worktree = await this.requireWorktree(task);
    const preflight = await this.github.preflight(task, worktree);
    const stored = await this.store.recordGitHubPreflight(preflight);
    this.emitGitHubUpdate(task.id, worktree, stored);
    return stored;
  }

  async publishBranch(input: PublishBranchRequest) {
    return this.withTaskAction(input.taskId, 'GitHub delivery', () =>
      this.publishBranchUnlocked(input)
    );
  }

  private async publishBranchUnlocked(input: PublishBranchRequest) {
    const task = await this.requireTask(input.taskId);
    const snapshot = await this.store.snapshot();
    this.assertNoActiveTaskRun(snapshot, task.id, 'publishing the branch');
    const worktree = await this.requireWorktree(task);
    const latestGit = await this.ensureCommittedPublishableGit(task);

    assertPublishReady(latestGit);

    const githubReady = await this.preflightGitHub({ taskId: task.id });
    if (githubReady.status !== 'READY') {
      throw new Error(githubReady.error ?? `GitHub preflight is ${githubReady.status}.`);
    }

    await this.store.recordBranchPublishRequested(task, worktree);
    const publication = await this.github.publishBranch({
      task,
      worktree,
      remoteName: githubReady.remoteName
    });
    const stored = await this.store.recordBranchPublication(publication);
    this.emitGitHubUpdate(task.id, worktree, stored);
    if (stored.status !== 'PUSHED') {
      throw new Error(stored.error ?? 'Branch publication failed.');
    }
    await this.refreshEvidence({ taskId: task.id });
    return stored;
  }

  async createPullRequest(input: CreatePullRequestRequest): Promise<PullRequestSnapshotRecord> {
    return this.withTaskAction(input.taskId, 'GitHub delivery', () =>
      this.createPullRequestUnlocked(input)
    );
  }

  private async createPullRequestUnlocked(
    input: CreatePullRequestRequest
  ): Promise<PullRequestSnapshotRecord> {
    const task = await this.requireTask(input.taskId);
    const activeSnapshot = await this.store.snapshot();
    this.assertNoActiveTaskRun(activeSnapshot, task.id, 'opening a pull request');
    const worktree = await this.requireWorktree(task);
    let latestGit: GitSnapshotRecord | undefined =
      await this.ensureCommittedPublishableGit(task);
    let snapshot = await this.store.snapshot();
    let latestPublication = latestForIteration(
      snapshot.branchPublications,
      task.currentIterationId,
      'updatedAt'
    );

    if (latestPublication?.status !== 'PUSHED' || latestPublication.headSha !== latestGit.headSha) {
      latestPublication = await this.publishBranchUnlocked({ taskId: task.id });
      snapshot = await this.store.snapshot();
      latestGit = latestForIteration(snapshot.gitSnapshots, task.currentIterationId, 'capturedAt');
    }
    assertPublishReady(latestGit);
    const title = normalizePullRequestTitle(input.title, task.title);

    const prBodyContent = await this.github.writePullRequestBody({
      filePath: path.join(os.tmpdir(), `task-monki-pr-${task.id}.md`),
      task,
      gitDiffStat: latestGit.diffStat,
      agentSummary: snapshot.runs.find((run) => run.id === task.currentRunId)?.finalMessage
    });
    const bodyArtifact = await this.store.recordPullRequestBodyArtifact(task, prBodyContent);
    const bodyPath = await this.store.getArtifactPath(bodyArtifact.id);

    await this.store.recordPullRequestCreateRequested(task, worktree);
    const sync = await this.github.createOrFindDraftPullRequest({
      task,
      worktree,
      baseRef: worktree.baseRef,
      bodyFilePath: bodyPath,
      title
    });
    sync.pullRequest.bodyArtifactId = bodyArtifact.id;
    const pullRequest = await this.store.recordPullRequestSync(sync);
    this.emitGitHubUpdate(task.id, worktree, pullRequest);

    if (pullRequest.status === 'OPEN_DRAFT' || pullRequest.status === 'OPEN_READY') {
      await this.store.transitionTask(task.id, 'IN_REVIEW', 'GitHub confirmed a matching open pull request.');
    }

    return pullRequest;
  }

  async refreshGitHub(input: RefreshGitHubRequest): Promise<PullRequestSnapshotRecord | undefined> {
    return this.withTaskAction(input.taskId, 'GitHub refresh', async () => {
      const task = await this.requireTask(input.taskId);
      const worktree = await this.requireWorktree(task);
      const latest = await this.store.getLatestPullRequest(task.id);
      if (!latest?.number && !latest?.url) {
        return undefined;
      }
      try {
        const sync = await this.github.viewPullRequest(worktree, latest.number ?? latest.url ?? worktree.branchName);
        const stored = await this.store.recordPullRequestSync(sync);
        this.emitGitHubUpdate(task.id, worktree, stored);
        return stored;
      } catch (error) {
        await this.store.appendEvent(
          createDomainEvent({
            type: 'GITHUB_SYNC_FAILED',
            taskId: task.id,
            iterationId: worktree.iterationId,
            worktreeId: worktree.id,
            source: 'github',
            payload: { error: error instanceof Error ? error.message : String(error) }
          })
        );
        throw error;
      }
    });
  }

  async transitionTask(input: TransitionTaskRequest): Promise<Task> {
    return this.withTaskAction(input.taskId, 'Workflow transition', async () => {
      const task = await this.requireTask(input.taskId);
      const snapshot = await this.store.snapshot();
      this.assertNoActiveTaskRun(snapshot, task.id, 'changing this task');
      const latestGit = snapshot.gitSnapshots
        .filter((candidate) => candidate.taskId === task.id && candidate.iterationId === task.currentIterationId)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
      const latestPr = snapshot.pullRequests
        .filter((candidate) => candidate.taskId === task.id && candidate.iterationId === task.currentIterationId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      const latestCi = snapshot.ciRollups
        .filter((candidate) => candidate.taskId === task.id && candidate.iterationId === task.currentIterationId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      const latestMerge = snapshot.mergeSnapshots
        .filter((candidate) => candidate.taskId === task.id && candidate.iterationId === task.currentIterationId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];

      const blockedReason = transitionBlocker(task, input.toPhase, {
        hasWorktree: Boolean(task.currentWorktreeId),
        hasGitSnapshot: Boolean(latestGit),
        gitStatus: latestGit?.status ?? task.projection.git,
        gitHeadSha: latestGit?.headSha,
        gitDirtyFingerprint: latestGit?.dirtyFingerprint,
        pullRequestStatus: latestPr?.status,
        pullRequestHeadSha: latestPr?.headRefOid,
        ciStatus: latestCi?.status ?? task.projection.ciChecks,
        ciHeadSha: latestCi?.headSha,
        ciPullRequestNumber: latestCi?.pullRequestNumber,
        mergeStatus: latestMerge?.status,
        mergeHeadSha: latestMerge?.headSha,
        mergePullRequestNumber: latestMerge?.pullRequestNumber
      });
      if (blockedReason) {
        await this.store.recordBlockedTransition(task, input.toPhase, blockedReason);
        throw new Error(blockedReason);
      }

      return this.store.transitionTask(task.id, input.toPhase, 'Guarded transition accepted.');
    });
  }

  async deleteTask(input: DeleteTaskRequest): Promise<DeleteTaskResult> {
    return this.withTaskAction(input.taskId, 'Task deletion', async () => {
      const task = await this.requireTask(input.taskId);
      const snapshot = await this.store.snapshot();
      const blockedReason = taskDeletionBlocker(task, snapshot);
      if (blockedReason) {
        throw new Error(blockedReason);
      }

      let removedWorktree = false;
      if (input.removeWorktree) {
        const worktrees = snapshot.worktrees.filter(
          (worktree) => worktree.taskId === task.id
        );
        for (const worktree of worktrees) {
          await this.worktrees.remove(worktree);
          removedWorktree = true;
        }
      }

      await this.store.deleteTask(task.id);
      await this.agentRuntimeStore?.purgeTask(task.id);
      const result = { taskId: task.id, removedWorktree };
      this.events.emit({
        type: 'task.deleted',
        taskId: task.id,
        payload: result,
        at: new Date().toISOString()
      });
      return result;
    });
  }

  readArtifact(input: ReadArtifactRequest): Promise<string> {
    return this.store.readArtifact(input.artifactId);
  }

  async readProtocolMessage(input: ReadProtocolMessageRequest) {
    if (this.agentRuntimeStore) {
      const runtimeServer = await this.agentRuntimeStore.getAgentServer(
        input.reference.serverInstanceId
      );
      if (runtimeServer) {
        return this.agentRuntimeStore.readProtocolMessage(input.reference);
      }
    }
    return this.store.readProtocolMessage(input.reference);
  }

  private async validateAndRecordRepository(task: Task): Promise<RepositoryPreflight> {
    const preflight = await validateRepositoryPath(task.repositoryPath);
    await this.store.appendEvent(
      createDomainEvent({
        type: 'REPOSITORY_PREFLIGHT_COMPLETED',
        taskId: task.id,
        source: 'repository',
        payload: preflight
      })
    );

    if (preflight.status !== 'VALID') {
      throw new Error(preflight.error ?? 'Repository preflight failed.');
    }
    return preflight;
  }

  private async capturePostRunEvidence(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (
      !run ||
      !['IMPLEMENTATION', 'FOLLOW_UP', 'RETRY', 'REVIEW'].includes(run.mode)
    ) {
      return;
    }
    try {
      const snapshot = await this.refreshEvidence({ taskId: run.taskId });
      await this.store.updateRun(run.id, { afterGitSnapshotId: snapshot.id });
      if (run.mode === 'REVIEW' && run.beforeGitSnapshotId) {
        const state = await this.store.snapshot();
        const before = state.gitSnapshots.find(
          (candidate) => candidate.id === run.beforeGitSnapshotId
        );
        if (before && before.dirtyFingerprint !== snapshot.dirtyFingerprint) {
          await this.store.appendEvent(
            createDomainEvent({
              type: 'AGENT_REVIEW_POLICY_VIOLATION',
              taskId: run.taskId,
              iterationId: run.iterationId,
              runId: run.id,
              worktreeId: run.worktreeId,
              agentSessionId: run.sessionId,
              source: 'git',
              payload: {
                beforeDirtyFingerprint: before.dirtyFingerprint,
                afterDirtyFingerprint: snapshot.dirtyFingerprint
              }
            })
          );
        }
      }
    } catch {
      // The terminal event already completed the run. Evidence refresh failures remain visible
      // through explicit refresh attempts and stored runtime/provider artifacts.
    }
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private async requireRunForTask(runId: string, taskId: string): Promise<RunRecord> {
    const run = await this.store.getRun(runId);
    if (!run || run.taskId !== taskId) {
      throw new Error(`Run ${runId} does not belong to task ${taskId}.`);
    }
    return run;
  }

  private async requireContinuationContext(taskId: string, runId: string) {
    const [task, snapshot] = await Promise.all([
      this.requireTask(taskId),
      this.store.snapshot()
    ]);
    const run = snapshot.runs.find(
      (candidate) => candidate.id === runId && candidate.taskId === taskId
    );
    if (!run) {
      throw new Error(`Run ${runId} does not belong to task ${taskId}.`);
    }
    const iteration = snapshot.iterations.find(
      (candidate) => candidate.id === run.iterationId
    );
    const worktree = snapshot.worktrees.find(
      (candidate) => candidate.id === run.worktreeId
    );
    if (!iteration || !worktree) {
      throw new Error('The source run no longer has a valid task iteration.');
    }
    return { task, run, iteration, worktree };
  }

  private async requireWorktree(task: Task): Promise<WorktreeRecord> {
    const worktree = await this.store.getCurrentWorktree(task.id);
    if (!worktree) {
      throw new Error('Create a task worktree before running this action.');
    }
    return worktree;
  }

  private emitGitHubUpdate(taskId: string, worktree: WorktreeRecord, payload: unknown): void {
    this.events.emit({
      type: 'github.updated',
      taskId,
      iterationId: worktree.iterationId,
      worktreeId: worktree.id,
      payload,
      at: new Date().toISOString()
    });
  }

  private async ensureCommittedPublishableGit(task: Task): Promise<GitSnapshotRecord> {
    const latestGit = await this.refreshEvidence({ taskId: task.id });
    if (latestGit.status === 'DIRTY') {
      return this.createDeliveryCommitUnlocked({ taskId: task.id });
    }
    return latestGit;
  }

  private async withTaskAction<T>(
    taskId: string,
    label: string,
    action: () => Promise<T>
  ): Promise<T> {
    const current = this.taskActionLocks.get(taskId);
    if (current) {
      throw new Error(`${current} is already running for this task.`);
    }
    this.taskActionLocks.set(taskId, label);
    try {
      return await action();
    } finally {
      if (this.taskActionLocks.get(taskId) === label) {
        this.taskActionLocks.delete(taskId);
      }
    }
  }

  private async withAttachmentDraft<T>(
    draftId: string,
    action: () => Promise<T>
  ): Promise<T> {
    if (this.activeAttachmentDrafts.has(draftId)) {
      throw new AttachmentStoreError(
        'ATTACHMENT_CONFLICT',
        'Another operation is already updating this attachment draft.',
        409
      );
    }
    this.activeAttachmentDrafts.add(draftId);
    try {
      return await action();
    } finally {
      this.activeAttachmentDrafts.delete(draftId);
    }
  }

  private assertNoActiveTaskRun(
    snapshot: TaskSnapshot,
    taskId: string,
    action: string,
    options: { exceptRunId?: string } = {}
  ): void {
    const activeRun = snapshot.runs.find(
      (run) =>
        run.taskId === taskId &&
        run.id !== options.exceptRunId &&
        ACTIVE_AGENT_RUN_STATUSES.has(run.status)
    );
    if (!activeRun) {
      return;
    }
    if (activeRun.mode === 'REVIEW') {
      throw new Error(`Wait for the Codex review to finish before ${action}.`);
    }
    throw new Error(`Stop or let the active agent run finish before ${action}.`);
  }
}

function followUpSettings(
  task: Task,
  run: RunRecord,
  overrides: AgentExecutionSettings | undefined,
  readOnly: boolean
): AgentExecutionSettings {
  return mergeRunSettings({
    readOnly,
    settings: [run.requestedSettings, task.agentSettings, overrides]
  });
}

export function mergeRunSettings(input: {
  readOnly: boolean;
  settings: Array<AgentExecutionSettings | undefined>;
}): AgentExecutionSettings {
  const defaultSandbox: NonNullable<AgentExecutionSettings['sandbox']> = input.readOnly
    ? 'READ_ONLY'
    : 'WORKSPACE_WRITE';
  const requestedSettings: AgentExecutionSettings = Object.assign(
    {
      sandbox: defaultSandbox,
      networkAccess: false,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user'
    } satisfies AgentExecutionSettings,
    ...input.settings.filter(Boolean)
  );
  const approvalPolicy = requestedSettings.approvalPolicy ?? 'on-request';
  return {
    ...requestedSettings,
    sandbox: input.readOnly
      ? 'READ_ONLY'
      : (requestedSettings.sandbox ?? defaultSandbox),
    networkAccess: requestedSettings.networkAccess ?? false,
    approvalPolicy,
    approvalsReviewer:
      input.readOnly || approvalPolicy === 'never'
        ? 'user'
        : normalizeAgentApprovalsReviewer(requestedSettings.approvalsReviewer)
  };
}

function assertContinuable(run: RunRecord): void {
  if (
    !['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
      run.status
    )
  ) {
    throw new Error(`Run ${run.id} cannot continue while it is ${run.status}.`);
  }
}

function assertRetryable(run: RunRecord): void {
  if (
    !['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
      run.status
    )
  ) {
    throw new Error(`Run ${run.id} cannot be retried while it is ${run.status}.`);
  }
}

function executableForRuntime(result: ExternalToolProbeResult): string {
  return result.resolvedPath ?? result.executable;
}

function explicitExecutableForCodexRuntime(
  result: ExternalToolProbeResult
): string | undefined {
  if (result.source === 'auto') {
    return undefined;
  }
  return result.configuredPath ?? result.executable;
}

function affectsCodexRuntimeSettings(input: UpdateAppSettingsRequest): boolean {
  return Boolean(
    input.codexExternalTools ||
      (input.externalExecutables && 'codexExecutablePath' in input.externalExecutables)
  );
}

function codexExternalToolsAreDisabled(
  settings: TaskManagerAppSettings['codexExternalTools']
): boolean {
  return (
    settings.webSearchMode === 'disabled' &&
    settings.mcpServers === 'disabled' &&
    settings.apps === 'disabled'
  );
}

const ACTIVE_AGENT_RUN_STATUSES: ReadonlySet<RunRecord['status']> = new Set([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
]);

function requireRepositoryId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(value)
  ) {
    throw new RepositoryRequestError(
      'REPOSITORY_INVALID_REQUEST',
      400,
      'A valid repository id is required.'
    );
  }
  return value;
}

function requireRepositoryMutationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(value)
  ) {
    throw new RepositoryRequestError(
      'REPOSITORY_INVALID_REQUEST',
      400,
      'A valid repository mutation id is required.'
    );
  }
  return value;
}

function activeTaskOperationBlocker(task: Task): string | undefined {
  if (ACTIVE_AGENT_RUN_STATUSES.has(task.projection.agentRun as RunRecord['status'])) {
    return 'Stop or let the active agent run finish before changing this task.';
  }
  if (['REQUESTED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED'].includes(task.projection.requestedAction)) {
    return 'Resolve the pending provider request before changing this task.';
  }
  return undefined;
}

export function taskDeletionBlocker(task: Task, snapshot: TaskSnapshot): string | undefined {
  const activeRun = snapshot.runs.find(
    (run) => run.taskId === task.id && ACTIVE_AGENT_RUN_STATUSES.has(run.status)
  );
  if (activeRun) {
    return 'Stop or let the active agent run finish before deleting this task.';
  }

  const activeInteraction = snapshot.interactionRequests.find(
    (request) => request.taskId === task.id && ['PENDING', 'RESPONDING'].includes(request.status)
  );
  if (activeInteraction) {
    return 'Resolve the pending provider request before deleting this task.';
  }

  return undefined;
}

export function transitionBlocker(
  task: Task,
  toPhase: Task['workflowPhase'],
  evidence: {
    hasWorktree: boolean;
    hasGitSnapshot?: boolean;
    gitStatus?: Task['projection']['git'];
    gitHeadSha?: string;
    gitDirtyFingerprint?: string;
    pullRequestStatus?: Task['projection']['githubPullRequest'];
    pullRequestHeadSha?: string;
    ciStatus?: Task['projection']['ciChecks'];
    ciHeadSha?: string;
    ciPullRequestNumber?: number;
    mergeStatus?: Task['projection']['merge'];
    mergeHeadSha?: string;
    mergePullRequestNumber?: number;
  }
): string | undefined {
  if (toPhase === 'IN_PROGRESS') {
    return evidence.hasWorktree ? undefined : 'A task worktree is required before implementation starts.';
  }
  if (toPhase === 'REVIEW') {
    if (!evidence.hasWorktree) {
      return 'A task worktree is required before review.';
    }
    if (task.projection.agentRun !== 'COMPLETED') {
      return 'The agent turn must complete before moving to review.';
    }
    return undefined;
  }
  if (toPhase === 'IN_REVIEW') {
    if (evidence.pullRequestStatus !== 'OPEN_DRAFT' && evidence.pullRequestStatus !== 'OPEN_READY') {
      return 'A matching open GitHub pull request is required before IN_REVIEW.';
    }
    if (evidence.gitHeadSha && evidence.pullRequestHeadSha && evidence.gitHeadSha !== evidence.pullRequestHeadSha) {
      return 'GitHub pull request head SHA does not match the current task branch HEAD.';
    }
    return undefined;
  }
  if (toPhase === 'DONE') {
    if (completionPolicyRequiresMerge(task.completionPolicy) && evidence.mergeStatus !== 'MERGED') {
      return 'GitHub must report the pull request merged before DONE.';
    }
    if (
      completionPolicyRequiresPassingChecks(task.completionPolicy) &&
      !verifiedChecksMatchMergeHead({
        ciStatus: evidence.ciStatus,
        ciHeadSha: evidence.ciHeadSha,
        ciPullRequestNumber: evidence.ciPullRequestNumber,
        mergeHeadSha: evidence.mergeHeadSha,
        mergePullRequestNumber: evidence.mergePullRequestNumber
      })
    ) {
      return 'GitHub checks must pass for the merged PR head before DONE.';
    }
    return undefined;
  }
  if (toPhase === 'ARCHIVED') {
    return activeTaskOperationBlocker(task);
  }
  return undefined;
}

function latestForIteration<T extends { iterationId: string }>(
  rows: T[],
  iterationId: string | undefined,
  dateKey: keyof T
): T | undefined {
  return rows
    .filter((row) => row.iterationId === iterationId)
    .sort((a, b) => String(b[dateKey]).localeCompare(String(a[dateKey])))[0];
}

export function assertPublishReady(
  latestGit: GitSnapshotRecord | undefined
): asserts latestGit is GitSnapshotRecord {
  if (!latestGit) {
    throw new Error('Refresh Git evidence before opening a draft PR.');
  }
  if (latestGit.status === 'DIRTY') {
    throw new Error('Create a delivery commit before opening a draft PR. Dirty worktree changes cannot be pushed.');
  }
  if (latestGit.status === 'CONFLICTED' || latestGit.status === 'UNAVAILABLE') {
    throw new Error(`Git status ${latestGit.status} blocks draft PR creation.`);
  }
  if (latestGit.status === 'DIVERGED') {
    throw new Error('Sync the branch before opening a draft PR.');
  }
  if (latestGit.status === 'UNKNOWN') {
    throw new Error('Git status must be available before opening a draft PR.');
  }
  if (latestGit.commitsAheadOfBase <= 0 || latestGit.committedDiffFileCount <= 0) {
    throw new Error('The task branch has no committed changes to open a draft PR for.');
  }
}
