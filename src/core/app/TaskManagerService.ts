import { isDeepStrictEqual } from 'node:util';
import type {
  Board,
  BoardSnapshot,
  AcceptPreviewRecipeDraftRequest,
  AcceptPreviewRecipeDraftResult,
  CancelRunRequest,
  CancelDesignTurnRequest,
  ContinueRunRequest,
  CreateDeliveryCommitRequest,
  CreateBoardRequest,
  CreateTaskRequest,
  CreateBlankDesignRequest,
  AddDesignReferencesRequest,
  RemoveDesignReferenceRequest,
  ImportDesignReferenceAssetRequest,
  DeleteTaskRequest,
  DeleteTaskResult,
  DesignDetailSnapshot,
  DesignConversationPage,
  DesignDraftRecord,
  DesignListItem,
  DeleteDesignDraftRequest,
  DisconnectRepositoryRequest,
  DiscardPreviewRecipeDraftRequest,
  GitSnapshotRecord,
  GitHubPreflightRequest,
  GeneratePreviewRecipeRequest,
  GetPreviewRecipeGenerationRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  BranchPublicationRecord,
  PullRequestSnapshotRecord,
  ReadArtifactRequest,
  ReadProtocolMessageRequest,
  RefinePromptRequest,
  RefinePromptResponse,
  ReconnectRepositoryRequest,
  Repository,
  RepositoryImpact,
  RepositoryPreflight,
  RunRecord,
  StartRunRequest,
  Task,
  TaskDetailSnapshot,
  TaskSnapshot,
  TransitionTaskRequest,
  WorktreeRecord,
  RefreshEvidenceRequest,
  CreatePullRequestRequest,
  RefreshGitHubRequest,
  RespondToInteractionRequest,
  RetryRunRequest,
  RestartDesignPreviewRequest,
  ListDesignConversationRequest,
  SaveDesignDraftRequest,
  StartReviewRequest,
  SteerRunRequest,
  SubmitDesignTurnRequest,
  SyncAgentGoalRequest,
  AgentExecutionSettings,
  AgentRunMode,
  TaskManagerAppSettings,
  UpdateAppSettingsRequest,
  UpdateAgentNativeSessionRequest,
  UpdateAgentNativeSessionResult,
  UpdateBoardRequest,
  ExternalToolStatusReport,
  TestExternalToolRequest,
  ExternalToolProbeResult,
  InspectOpenTargetRequest,
  InteractionRequestRecord,
  OpenTargetInspection,
  ExecuteOpenTargetActionRequest,
  OpenTargetActionResult,
  ApprovePreviewPlanRequest,
  DeletePreviewLocalAttachmentBindingRequest,
  OpenPreviewRequest,
  OpenPreviewResult,
  PreviewApprovalRecord,
  PreviewGenerationRecord,
  PreviewLocalAttachmentBindingRecord,
  PreviewRecipeGenerationSnapshot,
  PreviewRecipeValidation,
  ReadPreviewLogRequest,
  ReadPreviewLogResult,
  ReadDesignDraftAttachmentRequest,
  ResetPreviewDataRequest,
  RetryPreviewSetupRequest,
  ResolvePreviewRequest,
  ResolvePreviewResult,
  StartPreviewRequest,
  SetPreviewLocalAttachmentBindingRequest,
  StopPreviewRequest,
  ValidatePreviewRecipeDraftRequest,
  AttachmentContent,
  AttachmentDraftSnapshot,
  DiscardTaskAttachmentDraftRequest,
  ReadTaskAttachmentRequest,
  StageTaskAttachmentBatchRequest
} from '../../shared/contracts';
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  getImplementationRetryReason,
  isImplementationRunMode,
  normalizePullRequestTitle,
} from '../../shared/contracts';
import { CODEX_RUNTIME_ID, type AgentRuntimeId } from '../../shared/agent';
import type {
  AppendHumanDiscourseMessageRequest,
  ConfirmDiscourseWaveContextRequest,
  CreateDiscourseConversationRequest,
  DeleteDiscourseConversationRequest,
  DeleteDiscourseDraftRequest,
  ListDiscourseConversationsRequest,
  ListDiscourseMessagesRequest,
  GetDiscourseMessageByClientIdRequest,
  PreviewDiscourseContextRequest,
  RenameDiscourseConversationRequest,
  SaveDiscourseDraftRequest,
  SendDiscourseMessageRequest,
  SetDiscourseConversationArchivedRequest,
  SetDiscourseConversationReadRequest,
  SetPinnedDiscourseContextRequest,
  StopDiscourseWaveRequest,
  TombstoneDiscourseMessageRequest
} from '../../shared/discourse';
import os from 'node:os';
import path from 'node:path';
import { configureGitExecutablePath, git, gitSucceeds } from '../git/gitCli';
import { buildDiffEvidence, inspectGitSnapshot } from '../git/GitSnapshotService';
import { GitHubService } from '../github/GitHubService';
import {
  buildContinuationPrompt,
  buildForkAlternativeTaskPrompt,
  buildInitialRunPrompt,
  buildRetryPrompt,
  buildSteerInstruction
} from '../../shared/promptTemplates';
import { WorktreeService } from '../worktree/WorktreeService';
import { validateRepositoryPath } from '../repository/RepositoryPreflight';
import { selectRepositoryImpact } from '../repository/repositoryImpact';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';
import { AgentOrchestrator } from '../agent/AgentOrchestrator';
import type { AgentRuntimeAdapter } from '../agent/AgentRuntimeAdapter';
import { AgentRuntimeRegistry } from '../agent/AgentRuntimeRegistry';
import type { AgentRuntimeStore } from '../agent/AgentRuntimeStore';
import type { AgentScopedRuntimeBinding } from '../agent/AgentScopedTurnProvider';
import type { CodexAppServerAdapter } from '../agent/codex/CodexAppServerAdapter';
import {
  mergeAppSettings,
  MemoryAppSettingsStore,
  type AppSettingsStorage
} from '../settings/AppSettingsStore';
import { ExternalToolResolver } from '../tools/ExternalToolResolver';
import { OpenTargetService, type OpenTargetHost } from '../open/OpenTargetService';
import { PreviewManager, type PreviewTaskContext } from '../preview/PreviewManager';
import { createPreviewManager } from '../preview/createPreviewManager';
import type { DesignCanvasCutoverFence } from '../preview/DesignCanvasCutoverFence';
import { PreviewRecipeGenerationService } from '../preview/generation/PreviewRecipeGenerationService';
import type {
  PreviewUrlHost,
  ResolvedPreviewRoute
} from '../preview/runtime/PreviewOpenService';
import {
  assertAttachmentSandboxSupportsDelivery,
  type AgentTurnAttachment
} from '../agent/AgentAttachmentDelivery';
import { AttachmentStoreError } from '../storage/AttachmentFileStore';
import type { DiscourseStore } from '../discourse/DiscourseStore';
import { DiscourseService } from '../discourse/DiscourseService';
import {
  assertBrowserDevRuntimeIsolation,
  hasBrowserDevRuntimeIsolation
} from '../agent/BrowserDevAgentBoundary';
import {
  assertContinuable,
  assertForkable,
  assertRetryable,
  followUpSettings,
  mergeRunSettings,
  portableSecuritySettings
} from './AgentRunSettingsPolicy';
import {
  ACTIVE_AGENT_RUN_STATUSES,
  assertPublishReady,
  taskDeletionBlocker,
  transitionBlocker
} from './TaskTransitionPolicy';
import { RuntimeOperationGate } from './RuntimeOperationGate';
import { projectTaskDetailForClient } from './TaskDetailClientProjection';
import { DiscourseRuntimeHost } from './DiscourseRuntimeHost';
import {
  builtInRuntimeExecutableOverrides,
  createBuiltInAgentRuntimes,
  createScopedTurnRouter,
  findCodexRuntimeAdapter
} from './AgentRuntimeComposition';
import { DesignSourceService } from '../design/DesignSourceService';
import { DesignUpdateCoordinator } from '../design/DesignUpdateCoordinator';
import { FileDesignDraftStore } from '../design/FileDesignDraftStore';
import {
  AgentBrowserRuntime,
  type DesignBrowserOwner
} from '../design/AgentBrowserRuntime';

type TaskManagerLifecycleState =
  | 'NEW'
  | 'INITIALIZING'
  | 'READY'
  | 'SHUTTING_DOWN'
  | 'STOPPED';

interface TaskActionWork {
  label: string;
  work: Promise<unknown>;
}

export class TaskManagerService {
  readonly events: AppEventBus;
  private readonly agents: AgentOrchestrator;
  private readonly runtimeRegistry: AgentRuntimeRegistry;
  private readonly agentRuntimeStore?: AgentRuntimeStore;
  private readonly discourseHost?: DiscourseRuntimeHost;
  private readonly codexAdapter?: CodexAppServerAdapter;
  private readonly worktrees: WorktreeService;
  private readonly designWorktrees?: WorktreeService;
  private readonly designSource?: DesignSourceService;
  private readonly designUpdates?: DesignUpdateCoordinator;
  private readonly designBrowser?: DesignBrowserOwner;
  private readonly designDrafts?: FileDesignDraftStore;
  private readonly github: GitHubService;
  private readonly appSettingsStore: AppSettingsStorage;
  private readonly externalToolResolver: ExternalToolResolver;
  private readonly openTargets: OpenTargetService;
  private readonly previews: PreviewManager;
  private readonly previewRecipeGenerator: PreviewRecipeGenerationService;
  private readonly previewEnabled: boolean;
  private readonly previewReconcile: boolean;
  private readonly browserDevAgentBoundary: boolean;
  private readonly runtimeExecutableOverrides: Readonly<Record<string, string | undefined>>;
  private readonly runtimeOperations = new RuntimeOperationGate();
  private readonly postRunEvidenceTasks = new Map<string, Promise<void>>();
  private readonly disposeAgentEventListener: () => void;
  private readonly agentProviderStartupDisabledReason?: string;
  private readonly taskActionLocks = new Map<string, TaskActionWork>();
  private readonly designCreationLocks = new Map<string, Promise<unknown>>();
  private readonly activeControlActions = new Set<Promise<unknown>>();
  private readonly activeAttachmentDrafts = new Set<string>();
  private lifecycleState: TaskManagerLifecycleState = 'NEW';
  private initWork?: Promise<void>;
  private shutdownWork?: Promise<void>;
  private appSettings: TaskManagerAppSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS;
  private codexExecutable?: string;

  constructor(
    private readonly store: FileTaskStore,
    agentCwd: string,
    events = new AppEventBus(),
    options: {
      worktreeRoot?: string;
      gitPath?: string;
      ghPath?: string;
      codexPath?: string;
      openCodePath?: string;
      acpExecutablePaths?: Partial<Record<string, string>>;
      agentCwd?: string;
      appSettingsStore?: AppSettingsStorage;
      agentRuntimeAdapters?: readonly AgentRuntimeAdapter[];
      agentRuntimeStore?: AgentRuntimeStore;
      discourseStore?: DiscourseStore;
      discourseWorkspaceRoot?: string;
      agentScopedRuntimeBindings?: readonly AgentScopedRuntimeBinding[];
      defaultAgentRuntimeId?: string;
      openTargetHost?: OpenTargetHost;
      previewManager?: PreviewManager;
      previewRecipeGenerator?: PreviewRecipeGenerationService;
      previewRoot?: string;
      previewLauncherPath?: string;
      previewLauncherExecPath?: string;
      previewLauncherEnv?: NodeJS.ProcessEnv;
      managedDesignStaticServerPath?: string;
      previewOciExecutablePath?: string;
      previewOciContextName?: string;
      previewOciEnv?: NodeJS.ProcessEnv;
      previewOpenHost?: PreviewUrlHost;
      previewSecretProtector?: import('../preview/private/PreviewPrivateVault').PreviewSecretProtector;
      previewEnabled?: boolean;
      previewReconcile?: boolean;
      allowAgentNetworkAccess?: boolean;
      agentProviderStartupDisabledReason?: string;
      designRepositoryRoot?: string;
      designWorktreeRoot?: string;
      designCanvasFence?: DesignCanvasCutoverFence;
      designSkillRoot?: string;
      designDraftRoot?: string;
      designBrowserRuntime?: DesignBrowserOwner;
      designBrowserExecutablePath?: string;
      designBrowserChromeExecutablePath?: string;
      designBrowserScratchRoot?: string;
      designBrowserSocketRoot?: string;
      designBrowserRequireCodeSignature?: boolean;
    } = {}
  ) {
    if (Boolean(options.agentRuntimeStore) !== Boolean(options.discourseStore)) {
      throw new Error('The agent runtime and discourse stores must be configured together.');
    }
    agentCwd = options.agentCwd ?? (agentCwd || process.cwd());
    this.browserDevAgentBoundary = options.allowAgentNetworkAccess === false;
    this.agentProviderStartupDisabledReason =
      options.agentProviderStartupDisabledReason;
    this.runtimeExecutableOverrides = builtInRuntimeExecutableOverrides(
      options.openCodePath,
      options.acpExecutablePaths
    );
    this.events = events;
    this.appSettingsStore = options.appSettingsStore ?? new MemoryAppSettingsStore();
    this.externalToolResolver = new ExternalToolResolver({
      cwd: agentCwd,
      overrides: {
        git: options.gitPath,
        codex: options.codexPath,
        gh: options.ghPath
      }
    });
    this.openTargets = new OpenTargetService(options.openTargetHost);
    this.previewEnabled = options.previewEnabled === true;
    this.previewReconcile = options.previewReconcile !== false;
    this.previewRecipeGenerator =
      options.previewRecipeGenerator ?? new PreviewRecipeGenerationService();
    this.previews =
      options.previewManager ??
      createPreviewManager(store, events, {
        previewRoot:
          options.previewRoot ??
          process.env.TASK_MANAGER_PREVIEW_ROOT ??
          path.join(os.tmpdir(), 'task-monki-preview-runtime'),
        launcherPath:
          options.previewLauncherPath ??
          path.join(process.cwd(), 'src/core/preview/runtime/native-preview-launcher.mjs'),
        launcherExecPath: options.previewLauncherExecPath,
        launcherEnv: options.previewLauncherEnv,
        managedDesignStaticServerPath: options.managedDesignStaticServerPath,
        ociExecutablePath:
          options.previewOciExecutablePath ?? process.env.TASK_MANAGER_OCI_BIN,
        ociContextName:
          options.previewOciContextName ?? process.env.TASK_MANAGER_OCI_CONTEXT,
        ociEnv: options.previewOciEnv,
        openHost: options.previewOpenHost,
        secretProtector: options.previewSecretProtector
      });
    const runtimeAdapters = options.agentRuntimeAdapters ??
      createBuiltInAgentRuntimes(store, events, {
        cwd: agentCwd,
        codexExecutable: options.codexPath,
        openCodeExecutable: options.openCodePath,
        acpExecutablePaths: options.acpExecutablePaths,
        browserDevBoundary: this.browserDevAgentBoundary,
        codexToolSettings: this.appSettings.codexExternalTools,
        scopedRuntimeStore: options.agentRuntimeStore,
        designSkillRoot: options.designSkillRoot
      });
    this.codexAdapter = findCodexRuntimeAdapter(runtimeAdapters);
    this.runtimeRegistry = new AgentRuntimeRegistry(
      runtimeAdapters,
      options.defaultAgentRuntimeId ?? runtimeAdapters[0].descriptor.id
    );
    this.agentRuntimeStore = options.agentRuntimeStore;
    const scopedTurnRouter = createScopedTurnRouter(
      runtimeAdapters,
      options.agentRuntimeStore,
      options.agentScopedRuntimeBindings
    );
    if (this.agentRuntimeStore && options.discourseStore) {
      this.discourseHost = new DiscourseRuntimeHost({
        taskStore: this.store,
        runtimeStore: this.agentRuntimeStore,
        discourseStore: options.discourseStore,
        scopedTurnRouter,
        events: this.events,
        runtimeOperations: this.runtimeOperations,
        workspaceRoot: options.discourseWorkspaceRoot,
        providerStartupDisabledReason: this.agentProviderStartupDisabledReason,
        getRuntimeCatalog: () => this.getAgentRuntimeCatalogUnlocked(),
        getAppSettings: () => this.appSettings
      });
    }
    this.agents = new AgentOrchestrator(
      store,
      events,
      this.runtimeRegistry,
      {
        allowNetworkAccess: options.allowAgentNetworkAccess,
        providerStartupDisabledReason: options.agentProviderStartupDisabledReason
      }
    );
    this.worktrees = new WorktreeService(
      options.worktreeRoot ??
        process.env.TASK_MANAGER_WORKTREE_ROOT ??
        path.join(os.tmpdir(), 'task-monki-worktrees')
    );
    if (options.designRepositoryRoot || options.designWorktreeRoot || options.designCanvasFence) {
      if (
        !options.designRepositoryRoot ||
        !options.designWorktreeRoot ||
        !options.designCanvasFence
      ) {
        throw new Error(
          'Design Mode requires managed repository, worktree, and canvas owners together.'
        );
      }
      this.designWorktrees = new WorktreeService(options.designWorktreeRoot);
      this.designSource = new DesignSourceService({
        repositoryRoot: options.designRepositoryRoot,
        worktreeRoot: options.designWorktreeRoot
      });
      this.designDrafts = new FileDesignDraftStore(
        options.designDraftRoot ??
          path.join(path.dirname(options.designRepositoryRoot), 'design-drafts')
      );
      this.designBrowser =
        options.designBrowserRuntime ??
        createDesignBrowserRuntime({
          executablePath: options.designBrowserExecutablePath,
          browserExecutablePath: options.designBrowserChromeExecutablePath,
          scratchRoot: options.designBrowserScratchRoot,
          socketRoot: options.designBrowserSocketRoot,
          requireCodeSignature: options.designBrowserRequireCodeSignature
        });
      this.designUpdates = new DesignUpdateCoordinator({
        store,
        agents: this.agents,
        previews: this.previews,
        source: this.designSource,
        browser: this.designBrowser,
        fence: options.designCanvasFence,
        events: this.events,
        refreshGitEvidence: (designId) => this.refreshDesignGitEvidence(designId),
        ensurePostRunEvidence: (runId) => this.ensurePostRunEvidence(runId)
      });
    }
    this.github = new GitHubService(options.ghPath);
    this.disposeAgentEventListener = this.events.on((event) => {
      if (event.type === 'run.terminal' && event.runId) {
        this.trackPostRunEvidence(event.runId);
        void this.designUpdates?.handleRunTerminal(event.runId).catch(() => undefined);
        this.scheduleDeferredCodexRuntimeRestart(event.runId);
      }
    });
  }

  init(): Promise<void> {
    if (this.lifecycleState === 'READY') return Promise.resolve();
    if (this.initWork) return this.initWork;
    if (
      this.lifecycleState === 'SHUTTING_DOWN' ||
      this.lifecycleState === 'STOPPED'
    ) {
      return Promise.reject(new Error('Task Manager is shutting down.'));
    }
    this.lifecycleState = 'INITIALIZING';
    const work = this.withRuntimeLifecycleChange(() => this.initializeInternal())
      .then(() => {
        this.assertInitializing();
        this.lifecycleState = 'READY';
      })
      .catch((error: unknown) => {
        if (this.lifecycleState === 'INITIALIZING') {
          this.lifecycleState = 'NEW';
        }
        throw error;
      })
      .finally(() => {
        if (this.initWork === work) this.initWork = undefined;
      });
    this.initWork = work;
    return work;
  }

  private async initializeInternal(): Promise<void> {
    let designDrafts: DesignDraftRecord[] = [];
    if (this.designDrafts) {
      await this.designDrafts.init();
      designDrafts = await this.designDrafts.list();
      this.store.retainAttachmentDrafts(
        designDrafts.flatMap((draft) =>
          draft.attachmentDraftId ? [draft.attachmentDraftId] : []
        )
      );
    }
    await this.store.init();
    if (this.designDrafts) {
      await this.reconcileDesignDrafts(designDrafts);
    }
    this.assertInitializing();
    if (this.designSource) {
      const stored = await this.store.snapshot();
      await this.designSource.reconcileOrphanedRepositories(stored.repositories);
      this.assertInitializing();
    }
    if (this.designBrowser) {
      await this.designBrowser.attest();
      this.assertInitializing();
      await this.designBrowser.recover();
      this.assertInitializing();
      if (this.codexAdapter && this.designUpdates) {
        this.codexAdapter.setDesignBrowserToolHandler((input) =>
          this.designUpdates!.inspectDesign(input)
        );
      }
    }
    this.appSettings = await this.loadBoundarySafeAppSettings();
    this.assertInitializing();
    await this.assertRuntimeEnablementValid(this.appSettings);
    await this.applyRuntimeSettings({
      restartCodex: false,
      updateCodex: true,
      updateAgentRuntimeIds: this.runtimeRegistry
        .list()
        .map((adapter) => adapter.descriptor.id),
      restartAgentRuntimes: false
    });
    this.assertInitializing();
    if (this.previewEnabled) {
      const gateway = await this.previews.init(this.appSettings.previewGateway.port ?? 0, {
        reconcile: this.previewReconcile
      });
      this.assertInitializing();
      if (this.appSettings.previewGateway.port !== gateway.port) {
        this.appSettings = await this.appSettingsStore.update({
          previewGateway: { port: gateway.port }
        });
        this.assertInitializing();
      }
    }
    if (!this.agentProviderStartupDisabledReason) {
      await this.reconcileTaskStateOnStartup();
      this.assertInitializing();
    }
    await this.agents.initialize(
      [this.appSettings.defaultRuntimeId],
      new Set(this.appSettings.disabledRuntimeIds)
    );
    this.assertInitializing();
    await this.discourseHost?.initialize();
    this.assertInitializing();
    if (this.agentProviderStartupDisabledReason) return;
    const snapshot = await this.store.snapshot();
    this.assertInitializing();
    const recoveryTaskIds = new Set(
      snapshot.runs
        .filter((run) => run.recoveryState !== 'NONE')
        .map((run) => run.taskId)
    );
    await Promise.all(
      [...recoveryTaskIds].map((taskId) =>
        this.refreshEvidenceInternal({ taskId }).catch(() => undefined)
      )
    );
    this.assertInitializing();
    const recovered = await this.store.snapshot();
    const completedCurrentImplementationRuns = recovered.tasks.flatMap((task) => {
      const run = task.currentRunId
        ? recovered.runs.find((candidate) => candidate.id === task.currentRunId)
        : undefined;
      const requiresReconciliation =
        run &&
        (!run.afterGitSnapshotId ||
          (['IN_PROGRESS', 'REVIEW'].includes(task.workflowPhase) &&
            !getImplementationRetryReason(task) &&
            recovered.interactionRequests.some((interaction) =>
              isRejectedExecutionInteraction(interaction, run.id)
            )));
      return run &&
        isImplementationRunMode(run.mode) &&
        run.status === 'COMPLETED' &&
        requiresReconciliation
        ? [run.id]
        : [];
    });
    await Promise.allSettled(
      completedCurrentImplementationRuns.map((runId) =>
        this.ensurePostRunEvidence(runId)
      )
    );
    this.assertInitializing();
    await this.reconcileDesignWorkspaces();
    this.assertInitializing();
    await this.designUpdates?.recover();
    this.assertInitializing();
  }

  private async reconcileTaskStateOnStartup(): Promise<void> {
    const snapshot = await this.store.snapshot();
    for (const task of snapshot.tasks) {
      const worktree = snapshot.worktrees.find(
        (candidate) => candidate.id === task.currentWorktreeId
      );
      if (!worktree || ['REMOVED', 'REMOVING'].includes(worktree.status)) {
        continue;
      }
      const repository = snapshot.repositories.find(
        (candidate) => candidate.id === worktree.repositoryId
      );
      if (!repository || repository.status !== 'AVAILABLE') {
        if (worktree.status === 'CREATING') {
          await this.store.updateWorktree(
            {
              ...worktree,
              status: 'ERROR',
              error:
                'Task Monki restarted before worktree preparation completed, and the repository is unavailable.',
              updatedAt: new Date().toISOString()
            },
            'WORKTREE_FAILED'
          );
        }
        continue;
      }

      let storedWorktree: WorktreeRecord;
      try {
        const worktreeOwner =
          task.kind === 'DESIGN' ? this.requireDesignWorktrees() : this.worktrees;
        const verified = await worktreeOwner.verify(worktree, repository.path);
        storedWorktree = sameWorktreeObservation(worktree, verified)
          ? worktree
          : await this.store.updateWorktree(verified, 'WORKTREE_VERIFIED');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          await this.store.recordRepositoryPreflight(
            repository.id,
            await validateRepositoryPath(repository.path)
          );
        } catch {
          // The worktree error remains authoritative for this task even if the
          // repository observation cannot be published atomically.
        }
        await this.store.updateWorktree(
          {
            ...worktree,
            status: 'ERROR',
            error:
              worktree.status === 'CREATING'
                ? `Task Monki could not reconcile interrupted worktree preparation: ${detail}`
                : `Task Monki could not verify this worktree after restart: ${detail}`,
            updatedAt: new Date().toISOString()
          },
          'WORKTREE_FAILED'
        );
        continue;
      }
      if (storedWorktree.status !== 'PRESENT') continue;

      try {
        await this.refreshEvidenceInternal(
          { taskId: task.id },
          {
            persistOnlyIfChanged: true,
            verifiedWorktree: storedWorktree
          }
        );
      } catch {
        continue;
      }
      await this.reconcilePendingBranchPublication(task, storedWorktree).catch(
        () => undefined
      );
      try {
        await this.reconcilePendingPullRequest(task, storedWorktree);
      } catch (error) {
        await this.store.appendEvent(
          createDomainEvent({
            type: 'GITHUB_SYNC_FAILED',
            taskId: task.id,
            iterationId: storedWorktree.iterationId,
            worktreeId: storedWorktree.id,
            source: 'github',
            payload: {
              operation: 'pull-request-recovery',
              error: error instanceof Error ? error.message : String(error)
            }
          })
        );
      }
    }
  }

  private async reconcilePendingBranchPublication(
    task: Task,
    worktree: WorktreeRecord
  ): Promise<BranchPublicationRecord | undefined> {
    const snapshot = await this.store.snapshot();
    const latestPublication = latestForIteration(
      snapshot.branchPublications,
      worktree.iterationId,
      'updatedAt'
    );
    const latestRequest = latestEventForIteration(
      snapshot,
      task.id,
      worktree.iterationId,
      'BRANCH_PUBLISH_REQUESTED'
    );
    const hasPendingAttempt =
      latestPublication?.status === 'PUSHING' ||
      latestPublication?.status === 'AMBIGUOUS' ||
      Boolean(
        latestRequest &&
          (!latestPublication ||
            latestRequest.receivedAt > latestPublication.updatedAt)
      );
    if (!hasPendingAttempt) return undefined;

    const latestRepository = latestForIteration(
      snapshot.githubRepositories,
      worktree.iterationId,
      'checkedAt'
    );
    const observed = await this.github.reconcileBranchPublication({
      task,
      worktree,
      remoteName:
        latestPublication?.remoteName ??
        latestRepository?.remoteName ??
        'origin',
      expectedHeadSha: latestPublication?.headSha,
      failureDetail:
        originalBranchPublishFailure(latestPublication) ??
        (!latestPublication
          ? 'The earlier publication request did not persist its attempted head.'
          : undefined)
    });
    if (
      latestPublication &&
      sameBranchPublicationObservation(latestPublication, observed)
    ) {
      return latestPublication;
    }
    const stored = await this.store.recordBranchPublication(observed);
    this.emitGitHubUpdate(task.id, worktree, stored);
    return stored;
  }

  private async reconcilePendingBranchPublicationBeforeMutation(
    task: Task,
    worktree: WorktreeRecord
  ): Promise<BranchPublicationRecord | undefined> {
    const reconciled = await this.reconcilePendingBranchPublication(
      task,
      worktree
    );
    if (reconciled?.status === 'AMBIGUOUS') {
      throw new Error(
        reconciled.error ??
          'The prior branch publication is ambiguous. Inspect the remote before retrying.'
      );
    }
    return reconciled;
  }

  private async reconcilePendingPullRequest(
    task: Task,
    worktree: WorktreeRecord
  ): Promise<PullRequestSnapshotRecord | undefined> {
    const snapshot = await this.store.snapshot();
    const request = latestEventForIteration(
      snapshot,
      task.id,
      worktree.iterationId,
      'PR_CREATE_REQUESTED'
    );
    const latest = latestForIteration(
      snapshot.pullRequests,
      worktree.iterationId,
      'observedAt'
    );
    if (!request || (latest && latest.observedAt >= request.receivedAt)) {
      return undefined;
    }
    const sync = await this.github.findOpenPullRequest(worktree);
    if (!sync) return undefined;
    const pullRequest = await this.store.recordPullRequestSync(sync);
    this.emitGitHubUpdate(task.id, worktree, pullRequest);
    const currentTask = await this.requireTask(task.id);
    if (
      ['OPEN_DRAFT', 'OPEN_READY'].includes(pullRequest.status) &&
      ['READY', 'IN_PROGRESS', 'REVIEW'].includes(currentTask.workflowPhase)
    ) {
      await this.store.transitionTask(
        task.id,
        'IN_REVIEW',
        'GitHub confirmed a matching open pull request after restart.'
      );
    }
    return pullRequest;
  }

  async getAppSettings(): Promise<TaskManagerAppSettings> {
    this.appSettings = await this.loadBoundarySafeAppSettings();
    return structuredClone(this.appSettings);
  }

  updateAppSettings(
    input: UpdateAppSettingsRequest
  ): Promise<TaskManagerAppSettings> {
    return this.withControlAction(() => this.updateAppSettingsInternal(input));
  }

  private async updateAppSettingsInternal(
    input: UpdateAppSettingsRequest
  ): Promise<TaskManagerAppSettings> {
    return this.withRuntimeLifecycleChange(() =>
      this.updateAppSettingsLocked(input)
    );
  }

  private async updateAppSettingsLocked(
    input: UpdateAppSettingsRequest
  ): Promise<TaskManagerAppSettings> {
    const current = await this.appSettingsStore.get();
    for (const runtimeId of [
      input.defaultRuntimeId,
      input.promptRefinementRuntimeId,
      input.reviewRuntimeId
    ]) {
      if (runtimeId) {
        const adapter = this.runtimeRegistry.require(runtimeId);
        if (this.browserDevAgentBoundary) {
          assertBrowserDevRuntimeIsolation(
            adapter.descriptor,
            await adapter.capabilities()
          );
        }
      }
    }
    if (input.promptRefinementRuntimeId) {
      const adapter = this.runtimeRegistry.require(input.promptRefinementRuntimeId);
      const capabilities = await adapter.capabilities();
      if (capabilities.promptRefinement.maturity === 'unsupported') {
        throw new Error(
          `${adapter.descriptor.displayName} does not support prompt refinement.`
        );
      }
    }
    if (input.reviewRuntimeId) {
      const adapter = this.runtimeRegistry.require(input.reviewRuntimeId);
      const capabilities = await adapter.capabilities();
      const supportsReview =
        capabilities.review.maturity !== 'unsupported' ||
        capabilities.detachedReview.maturity === 'stable';
      if (!supportsReview) {
        throw new Error(
          `${adapter.descriptor.displayName} does not support an isolated review workflow.`
        );
      }
    }
    if (
      this.browserDevAgentBoundary &&
      input.codexExternalTools &&
      !codexExternalToolsAreDisabled({
        ...current.codexExternalTools,
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
    const prospective = mergeAppSettings(current, safeInput);
    await this.assertRuntimeEnablementValid(prospective, current);
    const newlyDisabledRuntimeIds = prospective.disabledRuntimeIds.filter(
      (runtimeId) => !current.disabledRuntimeIds.includes(runtimeId)
    );
    const newlyEnabledRuntimeIds = current.disabledRuntimeIds.filter(
      (runtimeId) => !prospective.disabledRuntimeIds.includes(runtimeId)
    );
    const stoppedRuntimeIds: TaskManagerAppSettings['disabledRuntimeIds'] = [];
    try {
      for (const runtimeId of newlyDisabledRuntimeIds) {
        stoppedRuntimeIds.push(runtimeId);
        await this.runtimeRegistry.require(runtimeId).shutdown();
      }
      this.appSettings = await this.appSettingsStore.update(safeInput);
    } catch (cause) {
      const recoveryFailures = await this.runtimeRegistry.initialize(stoppedRuntimeIds);
      if (recoveryFailures.length > 0) {
        throw new AggregateError(
          [cause, ...recoveryFailures.map((failure) => failure.error)],
          'Runtime disablement failed and Task Monki could not restore every stopped provider.'
        );
      }
      throw cause;
    }
    const affectsExternalTools = Boolean(
      input.codexExternalTools ||
      input.externalExecutables ||
      input.runtimeExecutablePaths
    );
    const affectsRuntimeAvailability = input.disabledRuntimeIds !== undefined;
    const updatedAgentRuntimeIds = Object.keys(input.runtimeExecutablePaths ?? {});
    let runtimeConfigurationChanged = false;
    if (affectsExternalTools) {
      const affectsCodexRuntime = affectsCodexRuntimeSettings(input);
      runtimeConfigurationChanged = Boolean(
        affectsCodexRuntime || updatedAgentRuntimeIds.length > 0
      );
      const activeRuntimeIds = await this.activeAgentRuntimeIds();
      try {
        await this.applyRuntimeSettings({
          restartCodex: affectsCodexRuntime && !activeRuntimeIds.has('codex'),
          updateCodex: affectsCodexRuntime,
          updateAgentRuntimeIds: updatedAgentRuntimeIds,
          restartAgentRuntimes: activeRuntimeIds.size === 0
        });
      } catch {
        // The setting is still saved; provider/tool status reports the runtime failure.
      }
    }
    await this.initializeEnabledRuntimes(newlyEnabledRuntimeIds);
    if (affectsRuntimeAvailability || runtimeConfigurationChanged) {
      this.events.emit({
        type: 'runtime.updated',
        taskId: 'settings',
        payload: await this.getAgentRuntimeCatalogUnlocked(),
        at: new Date().toISOString()
      });
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
    this.appSettings = await this.appSettingsStore.get();
    return this.openTargets.inspect(input, {
      snapshot: await this.store.snapshot()
    });
  }

  async executeOpenTargetAction(
    input: ExecuteOpenTargetActionRequest
  ): Promise<OpenTargetActionResult> {
    return this.withControlAction(() => this.executeOpenTargetActionInternal(input));
  }

  private async executeOpenTargetActionInternal(
    input: ExecuteOpenTargetActionRequest
  ): Promise<OpenTargetActionResult> {
    this.appSettings = await this.appSettingsStore.get();
    return this.openTargets.execute(input, {
      snapshot: await this.store.snapshot()
    });
  }

  async addRepository(repositoryPath: string): Promise<Repository> {
    const preflight = await validateRepositoryPath(repositoryPath);
    if (preflight.status !== 'VALID') {
      throw new Error(preflight.error ?? 'The selected folder is not a valid Git repository.');
    }
    const repository = await this.store.addRepository(preflight);
    this.emitRepositoryUpdate(repository);
    return repository;
  }

  async getRepositoryImpact(repositoryId: string): Promise<RepositoryImpact> {
    await this.requireRepository(repositoryId);
    return selectRepositoryImpact(await this.store.snapshot(), repositoryId);
  }

  async disconnectRepository(input: DisconnectRepositoryRequest): Promise<Repository> {
    if (!input.confirmed) {
      throw new Error('Repository disconnect requires explicit confirmation.');
    }
    const impact = await this.getRepositoryImpact(input.repositoryId);
    if (impact.blockingReason) {
      throw new Error(impact.blockingReason);
    }
    const repository = await this.store.disconnectRepository(input.repositoryId);
    this.emitRepositoryUpdate(repository);
    return repository;
  }

  async reconnectRepository(input: ReconnectRepositoryRequest): Promise<Repository> {
    const existing = await this.requireRepository(input.repositoryId);
    if (existing.status === 'AVAILABLE') {
      throw new Error('Disconnect the repository before changing its path.');
    }
    const impact = selectRepositoryImpact(await this.store.snapshot(), existing.id);
    if (impact.blockingReason) {
      throw new Error(impact.blockingReason);
    }
    const preflight = await validateRepositoryPath(input.path);
    if (preflight.status !== 'VALID') {
      throw new Error(preflight.error ?? 'The selected folder is not a valid Git repository.');
    }
    const repository = await this.store.recordRepositoryPreflight(existing.id, preflight);
    this.emitRepositoryUpdate(repository);
    return repository;
  }

  async refreshRepository(repositoryId: string): Promise<Repository> {
    const existing = await this.requireRepository(repositoryId);
    if (existing.status === 'DISCONNECTED') {
      throw new Error('Reconnect the repository before refreshing it.');
    }
    const repository = await this.store.recordRepositoryPreflight(
      existing.id,
      await validateRepositoryPath(existing.path)
    );
    this.emitRepositoryUpdate(repository);
    return repository;
  }

  async createBoard(input: CreateBoardRequest): Promise<Board> {
    const board = await this.store.createBoard(input);
    this.emitBoardUpdate('board.updated', board);
    return board;
  }

  async updateBoard(input: UpdateBoardRequest): Promise<Board> {
    const board = await this.store.updateBoard(input);
    this.emitBoardUpdate('board.updated', board);
    return board;
  }

  async deleteBoard(boardId: string): Promise<void> {
    await this.store.deleteBoard(boardId);
    this.emitBoardUpdate('board.deleted', { id: boardId });
  }

  async getAgentRuntimeCatalog() {
    return this.withRuntimeOperation(() => this.getAgentRuntimeCatalogUnlocked());
  }

  private getAgentRuntimeCatalogUnlocked() {
    return this.agents.getRuntimeCatalog(new Set(this.appSettings.disabledRuntimeIds));
  }

  async discoverAgentRuntimeModels(runtimeId: AgentRuntimeId) {
    return this.withRuntimeOperation(() =>
      this.agents.discoverAgentRuntimeModels(
        runtimeId,
        new Set(this.appSettings.disabledRuntimeIds)
      )
    );
  }

  async updateAgentNativeSession(
    input: UpdateAgentNativeSessionRequest
  ): Promise<UpdateAgentNativeSessionResult> {
    if (
      !input ||
      typeof input.taskId !== 'string' ||
      !input.taskId ||
      typeof input.sessionId !== 'string' ||
      !input.sessionId ||
      typeof input.runtimeId !== 'string' ||
      !input.runtimeId ||
      typeof input.controlId !== 'string' ||
      !input.controlId ||
      typeof input.revision !== 'string' ||
      !input.revision ||
      !['string', 'boolean'].includes(typeof input.value)
    ) {
      throw new Error(
        'A task, session, and runtime are required for native session updates.'
      );
    }
    return this.withTaskAction(input.taskId, 'Provider session update', () =>
      this.withRuntimeOperation(async () => {
        const session = await this.store.getAgentSession(input.sessionId);
        if (!session || session.taskId !== input.taskId) {
          throw new Error('Agent session ownership does not match the selected task.');
        }
        if (session.runtimeId !== input.runtimeId) {
          throw new Error(
            `Agent session ${session.id} belongs to ${session.runtimeId}, not ${input.runtimeId}.`
          );
        }
        const snapshot = await this.store.snapshot();
        if (
          snapshot.runs.some(
            (run) =>
              run.sessionId === session.id &&
              [
                'QUEUED',
                'STARTING',
                'RUNNING',
                'AWAITING_APPROVAL',
                'AWAITING_USER_INPUT',
                'INTERRUPTING',
                'RECOVERY_REQUIRED'
              ].includes(run.status)
          )
        ) {
          throw new Error(
            'Provider-native session settings cannot change during an active or recovery-required run.'
          );
        }
        if (!['IDLE', 'NOT_LOADED'].includes(session.status)) {
          throw new Error(
            `Agent session ${session.id} is ${session.status} and cannot be configured.`
          );
        }

        this.assertRuntimeEnabled(input.runtimeId);
        const adapter = this.runtimeRegistry.require(input.runtimeId);
        await this.assertAgentRuntimeAvailable();
        await this.assertRuntimeAllowedInCurrentSurface(adapter);
        if (!adapter.applySessionControl) {
          throw new Error(
            `${adapter.descriptor.displayName} does not expose typed provider session controls.`
          );
        }
        if (session.status === 'NOT_LOADED') {
          if (!session.providerSessionId) {
            throw new Error(`Agent session ${session.id} has no provider session ID.`);
          }
          await adapter.attachSession({
            localSessionId: session.id,
            providerSessionId: session.providerSessionId
          });
        }

        const updated = await adapter.applySessionControl({
          localSessionId: session.id,
          controlId: input.controlId,
          value: input.value,
          revision: input.revision
        });
        return {
          taskId: session.taskId,
          sessionId: session.id,
          runtimeId: session.runtimeId,
          native: updated.native,
          controls: updated.controls
        };
      })
    );
  }

  async listTasks(): Promise<TaskSnapshot> {
    return this.store.snapshot();
  }

  async getBoardSnapshot(): Promise<BoardSnapshot> {
    return this.store.getBoardSnapshot();
  }

  async getTaskDetail(taskId: string): Promise<TaskDetailSnapshot> {
    await this.requireNormalTask(taskId, 'Task details');
    return projectTaskDetailForClient(await this.store.getTaskDetail(taskId));
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

  getDiscourseMessageByClientId(input: GetDiscourseMessageByClientIdRequest) {
    return this.requireDiscourseService().getMessageByClientId(input);
  }

  getDiscourseMentionCatalog() {
    return this.withRuntimeOperation(() =>
      this.requireDiscourseService().getMentionCatalog()
    );
  }

  createDiscourseConversation(input: CreateDiscourseConversationRequest) {
    return this.withRuntimeOperation(() =>
      this.requireDiscourseService().createConversation(input)
    );
  }

  appendHumanDiscourseMessage(input: AppendHumanDiscourseMessageRequest) {
    return this.requireDiscourseService().appendHumanMessage(input);
  }

  sendDiscourseMessage(input: SendDiscourseMessageRequest) {
    return this.withRuntimeOperation(() =>
      this.requireDiscourseService().sendMessage(input)
    );
  }

  resumeDiscourseAcceptedSend(input: import('../../shared/discourse').ResumeDiscourseAcceptedSendRequest) {
    return this.withRuntimeOperation(() =>
      this.requireDiscourseService().resumeAcceptedSend(input)
    );
  }

  cancelDiscourseAcceptedSend(input: import('../../shared/discourse').CancelDiscourseAcceptedSendRequest) {
    return this.requireDiscourseService().cancelAcceptedSend(input);
  }

  tombstoneDiscourseMessage(input: TombstoneDiscourseMessageRequest) {
    return this.requireDiscourseService().tombstoneMessage(input);
  }

  setPinnedDiscourseContext(input: SetPinnedDiscourseContextRequest) {
    return this.requireDiscourseService().setPinnedContext(input);
  }

  previewDiscourseContext(input: PreviewDiscourseContextRequest) {
    return this.withRuntimeOperation(() =>
      this.requireDiscourseService().previewContext(input)
    );
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
    return this.withRuntimeOperation(() =>
      this.requireDiscourseService().setConversationArchived(input)
    );
  }

  deleteDiscourseConversation(input: DeleteDiscourseConversationRequest) {
    return this.withRuntimeOperation(() =>
      this.requireDiscourseService().deleteConversation(input)
    );
  }

  stopDiscourseWave(input: StopDiscourseWaveRequest) {
    return this.withRuntimeOperation(() =>
      this.requireDiscourseService().stopWave(input)
    );
  }

  confirmDiscourseWaveContext(input: ConfirmDiscourseWaveContextRequest) {
    return this.withRuntimeOperation(() =>
      this.requireDiscourseService().confirmWaveContext(input)
    );
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
    return this.withRuntimeOperation(() => this.createTaskLocked(input));
  }

  private async createTaskLocked(input: CreateTaskRequest): Promise<Task> {
    if (
      input.runtimeId &&
      input.agentSettings?.runtimeId &&
      input.runtimeId !== input.agentSettings.runtimeId
    ) {
      throw new Error('Task runtime and execution settings runtime must match.');
    }
    const configuredDefaultRuntime = this.runtimeRegistry.has(
      this.appSettings.defaultRuntimeId
    )
      ? this.appSettings.defaultRuntimeId
      : this.runtimeRegistry.defaultRuntimeId;
    const runtimeId =
      input.runtimeId ?? input.agentSettings?.runtimeId ?? configuredDefaultRuntime;
    const adapter = this.runtimeRegistry.require(runtimeId);
    const requestedInput: CreateTaskRequest = {
      ...input,
      runtimeId,
      agentSettings: { ...input.agentSettings, runtimeId }
    };
    const acknowledgedTask = await this.store.resolveTaskCreationRetry(requestedInput);
    if (acknowledgedTask) {
      return acknowledgedTask;
    }
    this.assertRuntimeEnabled(runtimeId);
    await this.assertRuntimeAllowedInCurrentSurface(adapter);
    if (!requestedInput.attachmentDraftId) {
      const settings = await prepareTaskCreationSettings(
        adapter,
        requestedInput.agentSettings ?? { runtimeId },
        []
      );
      return this.store.createTask({
        ...requestedInput,
        agentSettings: settings,
        creationFingerprintInput: requestedInput
      });
    }
    return this.withAttachmentDraft(requestedInput.attachmentDraftId, async () => {
      // The first request may complete between the initial lookup and entry to
      // this critical section. Resolve it before reading a draft that successful
      // task creation has intentionally consumed.
      const acknowledgedInsideLock = await this.store.resolveTaskCreationRetry(requestedInput);
      if (acknowledgedInsideLock) {
        return acknowledgedInsideLock;
      }
      const draft = await this.store.listAttachmentDraft(requestedInput.attachmentDraftId!);
      const settings = await prepareTaskCreationSettings(
        adapter,
        requestedInput.agentSettings ?? { runtimeId },
        draft.attachments
      );
      return this.store.createTask({
        ...requestedInput,
        agentSettings: settings,
        creationFingerprintInput: requestedInput
      });
    });
  }

  listDesigns(): Promise<DesignListItem[]> {
    return this.store.listDesigns();
  }

  async getDesign(designId: string): Promise<DesignDetailSnapshot> {
    const detail = await this.store.getDesignDetail(designId);
    if (!detail.currentWorktree) return detail;
    const project = await this.requireDesignSource().listProjectFiles({
      designId,
      repository: detail.repository,
      worktree: detail.currentWorktree
    });
    return {
      ...detail,
      projectFiles: project.files,
      projectFilesTruncated: project.truncated
    };
  }

  listDesignConversation(
    input: ListDesignConversationRequest
  ): Promise<DesignConversationPage> {
    return this.store.listDesignConversation(input);
  }

  async getDesignDraft(designId: string): Promise<DesignDraftRecord | null> {
    await this.requireDesignTask(designId, 'Design draft read');
    const draft = await this.requireDesignDrafts().get(designId);
    if (!draft) return null;
    return this.resolveDesignDraftAttachments(draft);
  }

  async readDesignDraftAttachment(
    input: ReadDesignDraftAttachmentRequest
  ): Promise<AttachmentContent> {
    await this.requireDesignTask(input.designId, 'Design draft attachment read');
    const draft = await this.requireDesignDrafts().get(input.designId);
    const attachmentDraft = draft?.attachmentDraftId
      ? await this.store.listAttachmentDraft(draft.attachmentDraftId)
      : undefined;
    const attachment = attachmentDraft?.attachments.find(
      (candidate) => candidate.id === input.attachmentId
    );
    if (!draft?.attachmentDraftId || !attachment) {
      throw new AttachmentStoreError(
        'ATTACHMENT_NOT_FOUND',
        'Design draft attachment not found.',
        404
      );
    }
    return this.store.readDraftAttachment(draft.attachmentDraftId, attachment.id);
  }

  saveDesignDraft(input: SaveDesignDraftRequest): Promise<DesignDraftRecord> {
    return this.withTaskAction(input.designId, 'Design draft save', async () => {
      const task = await this.requireDesignTask(input.designId, 'Design draft save');
      const save = async () => {
        await this.validateDesignDraftSelection(input.designId, input.referenceIds);
        if (input.attachmentDraftId) {
          await this.validateDesignAttachmentDraft(task, input.attachmentDraftId);
        }
        const previous = await this.requireDesignDrafts().get(input.designId);
        const saved = await this.requireDesignDrafts().save(input);
        if (
          previous?.attachmentDraftId &&
          previous.attachmentDraftId !== saved.attachmentDraftId
        ) {
          await this.store
            .discardAttachmentDraft(previous.attachmentDraftId)
            .catch(() => undefined);
        }
        return this.resolveDesignDraftAttachments(saved);
      };
      return input.attachmentDraftId
        ? this.withAttachmentDraft(input.attachmentDraftId, save)
        : save();
    });
  }

  deleteDesignDraft(input: DeleteDesignDraftRequest): Promise<void> {
    return this.withTaskAction(input.designId, 'Design draft deletion', async () => {
      await this.requireDesignTask(input.designId, 'Design draft deletion');
      const draft = await this.requireDesignDrafts().get(input.designId);
      await this.requireDesignDrafts().delete(input);
      if (draft?.attachmentDraftId) {
        await this.store
          .discardAttachmentDraft(draft.attachmentDraftId)
          .catch(() => undefined);
      }
    });
  }

  createBlankDesign(
    input: CreateBlankDesignRequest
  ): Promise<DesignDetailSnapshot> {
    return this.withRuntimeOperation(() =>
      this.withDesignCreation(input.creationToken, () =>
        this.createBlankDesignLocked(input)
      )
    );
  }

  private async createBlankDesignLocked(
    input: CreateBlankDesignRequest
  ): Promise<DesignDetailSnapshot> {
    const acknowledged = await this.store.resolveDesignCreationRetry(input);
    if (acknowledged) {
      if (this.designUpdates) {
        await this.ensureDesignWorktree(acknowledged.task.id).catch(() => undefined);
        const updates = await this.requireDesignUpdates().catch(() => undefined);
        await updates?.dispatch(acknowledged.task.id).catch(() => undefined);
      }
      return this.getDesign(acknowledged.task.id);
    }

    const designUpdates = await this.requireDesignUpdates();
    const source = this.requireDesignSource();
    const create = async () => {
      const repositoryInput = await source.prepareBlankRepository({
        creationToken: input.creationToken
      });
      try {
        return await this.store.createDesignBundle({
          request: input,
          repository: repositoryInput
        });
      } catch (error) {
        const stored = await this.store.snapshot();
        await source
          .reconcileOrphanedRepositories(stored.repositories)
          .catch(() => undefined);
        throw error;
      }
    };
    const bundle = input.attachmentDraftId
      ? await this.withAttachmentDraft(input.attachmentDraftId, create)
      : await create();
    await this.ensureDesignWorktree(bundle.task.id);
    await designUpdates.dispatch(bundle.task.id).catch(() => undefined);
    this.emitDesignUpdate(bundle.task.id, { reason: 'created' });
    return this.getDesign(bundle.task.id);
  }

  submitDesignTurn(
    input: SubmitDesignTurnRequest
  ): Promise<DesignDetailSnapshot> {
    return this.withTaskAction(input.designId, 'Design update', () =>
      this.withRuntimeOperation(async () => {
        const designUpdates = await this.requireDesignUpdates();
        const accept = async () => {
          const retry = await this.store.resolveInlineDesignTurnRetry(input);
          if (!retry && input.attachmentDraftId) {
            const task = await this.requireDesignTask(input.designId, 'Design update');
            const draft = await this.requireDesignDrafts().get(input.designId);
            if (draft?.attachmentDraftId !== input.attachmentDraftId) {
              throw new Error('The attached files do not belong to this Design draft.');
            }
            await this.validateDesignAttachmentDraft(task, input.attachmentDraftId);
          }
          await this.store.createInlineDesignTurn(input);
        };
        if (input.attachmentDraftId) {
          await this.withAttachmentDraft(input.attachmentDraftId, accept);
        } else {
          await accept();
        }
        await designUpdates.dispatch(input.designId).catch(() => undefined);
        this.emitDesignUpdate(input.designId, { reason: 'message-accepted' });
        return this.getDesign(input.designId);
      })
    );
  }

  addDesignReferences(
    input: AddDesignReferencesRequest
  ): Promise<DesignDetailSnapshot> {
    return this.withTaskAction(input.designId, 'Reference addition', () =>
      this.withRuntimeOperation(() =>
        this.withAttachmentDraft(input.attachmentDraftId, async () => {
          await this.requireDesignUpdates();
          const task = await this.requireDesignTask(input.designId, 'Reference addition');
          const draft = await this.store.listAttachmentDraft(input.attachmentDraftId);
          const adapter = this.runtimeRegistry.require(task.runtimeId);
          const settings = await prepareTaskCreationSettings(
            adapter,
            task.agentSettings,
            draft.attachments
          );
          if (
            settings.networkAccess !== false ||
            settings.sandbox !== 'WORKSPACE_WRITE' ||
            settings.approvalPolicy !== 'never'
          ) {
            throw new Error('Design references require the restricted Design permission profile.');
          }
          await this.store.addDesignReferences(input);
          this.emitDesignUpdate(input.designId, { reason: 'references-added' });
          return this.getDesign(input.designId);
        })
      )
    );
  }

  removeDesignReference(
    input: RemoveDesignReferenceRequest
  ): Promise<DesignDetailSnapshot> {
    return this.withTaskAction(input.designId, 'Reference removal', async () => {
      await this.requireDesignTask(input.designId, 'Reference removal');
      await this.store.removeDesignReference(input);
      const draft = await this.requireDesignDrafts().get(input.designId);
      if (draft?.referenceIds.includes(input.referenceId)) {
        await this.requireDesignDrafts().save({
          designId: input.designId,
          expectedRevision: draft.recordRevision,
          body: draft.body,
          referenceIds: draft.referenceIds.filter(
            (referenceId) => referenceId !== input.referenceId
          ),
          attachmentDraftId: draft.attachmentDraftId
        });
      }
      this.emitDesignUpdate(input.designId, {
        reason: 'reference-removed',
        referenceId: input.referenceId
      });
      return this.getDesign(input.designId);
    });
  }

  importDesignReferenceAsset(
    input: ImportDesignReferenceAssetRequest
  ): Promise<DesignDetailSnapshot> {
    return this.withTaskAction(input.designId, 'Asset import', async () => {
      const designUpdates = await this.requireDesignUpdates();
      return designUpdates.withExclusiveAccess(input.designId, async () => {
        const detail = await this.store.getDesignDetail(input.designId);
        this.assertNoActiveTaskRun(
          await this.store.snapshot(),
          input.designId,
          'importing a project asset'
        );
        if (
          detail.turns.some(
            (turn) => turn.outcome === undefined && turn.runId === undefined
          )
        ) {
          throw new Error('Wait for queued Design messages before importing a project asset.');
        }
        if (!detail.currentWorktree) {
          throw new Error('The Design workspace is not ready.');
        }
        const stored = await this.store.readDesignReferenceContent(
          input.designId,
          input.referenceId
        );
        const receipt = await this.requireDesignSource().importProjectAsset({
          designId: input.designId,
          repository: detail.repository,
          worktree: detail.currentWorktree,
          displayName: stored.content.displayName,
          bytes: stored.content.bytes,
          sha256: stored.sha256
        });
        try {
          await this.store.recordDesignReferenceAsset({
            ...input,
            projectAssetPath: receipt.relativePath
          });
        } catch (error) {
          try {
            await this.requireDesignSource().rollbackProjectAsset(receipt);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'The asset link failed and the copied project file could not be removed.'
            );
          }
          throw error;
        }
        await this.refreshDesignGitEvidence(input.designId);
        this.emitDesignUpdate(input.designId, {
          reason: 'reference-imported',
          referenceId: input.referenceId
        });
        return this.getDesign(input.designId);
      });
    });
  }

  cancelDesignTurn(
    input: CancelDesignTurnRequest
  ): Promise<DesignDetailSnapshot> {
    return this.withTaskAction(input.designId, 'Design turn cancellation', () =>
      this.withRuntimeOperation(async () => {
        const designUpdates = await this.requireDesignUpdates();
        await designUpdates.cancelTurn(input.designId, input.turnId);
        return this.getDesign(input.designId);
      })
    );
  }

  restartDesignPreview(
    input: RestartDesignPreviewRequest
  ): Promise<DesignDetailSnapshot> {
    return this.withTaskAction(input.designId, 'Design Preview restart', () =>
      this.withRuntimeOperation(async () => {
        const designUpdates = await this.requireDesignUpdates();
        await designUpdates.restartLatestReady(input.designId);
        return this.getDesign(input.designId);
      })
    );
  }

  async refinePrompt(input: RefinePromptRequest): Promise<RefinePromptResponse> {
    return this.withRuntimeOperation(() => this.refinePromptLocked(input));
  }

  private async refinePromptLocked(
    input: RefinePromptRequest
  ): Promise<RefinePromptResponse> {
    await this.assertAgentRuntimeAvailable();
    const repository = await this.requireAvailableRepository(input.repositoryId);
    const configuredRuntimeId =
      this.appSettings.promptRefinementRuntimeId ??
      this.appSettings.defaultRuntimeId;
    const runtimeId = input.runtimeId ?? configuredRuntimeId;
    this.assertRuntimeEnabled(runtimeId);
    const useConfiguredModel = runtimeId === configuredRuntimeId;
    const adapter = this.runtimeRegistry.require(runtimeId);
    await this.assertRuntimeAllowedInCurrentSurface(adapter);
    if (!adapter.refinePrompt) {
      throw new Error(
        `${adapter.descriptor.displayName} does not expose native prompt refinement.`
      );
    }
    const refined = await adapter.refinePrompt({
      repositoryPath: repository.path,
      input: input.input,
      settings: {
        runtimeId,
        model:
          input.model ??
          (useConfiguredModel ? this.appSettings.promptRefinementModel : undefined),
        modelProvider:
          input.modelProvider ??
          (useConfiguredModel
            ? this.appSettings.promptRefinementModelProvider
            : undefined),
        sandbox: 'READ_ONLY',
        networkAccess: false,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      }
    });
    this.events.emit({
      type: 'prompt.refined',
      taskId: 'prompt-preview',
      payload: refined,
      at: new Date().toISOString()
    });
    return refined;
  }

  async prepareWorktree(input: PrepareWorktreeRequest): Promise<WorktreeRecord> {
    return this.withTaskAction(input.taskId, 'Worktree preparation', () =>
      this.requireNormalTask(input.taskId, 'Manual worktree preparation').then(() =>
        this.prepareWorktreeUnlocked(input)
      )
    );
  }

  private async prepareWorktreeUnlocked(
    input: PrepareWorktreeRequest
  ): Promise<WorktreeRecord> {
    const task = await this.requireTask(input.taskId);
    const repository = await this.requireAvailableRepository(task.repositoryId);
    const existing = await this.store.getCurrentWorktree(task.id);
    if (existing && !['REMOVED', 'REMOVING'].includes(existing.status)) {
      const verified = await this.worktrees.verify(existing, repository.path);
      const stored = await this.store.updateWorktree(verified, 'WORKTREE_VERIFIED');
      if (!['ERROR', 'MISSING'].includes(stored.status)) {
        return stored;
      }
      await this.validateAndRecordRepository(task);
      return this.resumeWorktreePreparation(task, stored, repository);
    }

    const preflight = await this.validateAndRecordRepository(task);
    const spec = this.worktrees.buildSpec(task, preflight);
    return this.createAndPrepareWorktree(task, spec);
  }

  private async resumeWorktreePreparation(
    task: Task,
    worktree: WorktreeRecord,
    repository: Repository
  ): Promise<WorktreeRecord> {
    try {
      const created = await this.worktrees.create(worktree, repository.path);
      const stored = await this.store.updateWorktree(created, 'WORKTREE_CREATED');
      await this.refreshEvidenceInternal({ taskId: task.id });
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
      const repository = await this.requireAvailableRepository(task.repositoryId);
      const created = await this.worktrees.create(worktree, repository.path);
      const stored = await this.store.updateWorktree(created, 'WORKTREE_CREATED');
      await this.refreshEvidenceInternal({ taskId: task.id });
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
    return this.withTaskAction(input.taskId, 'Agent run', () =>
      this.withRuntimeOperation(async () => {
        await this.assertAgentRuntimeAvailable();
        let task = await this.requireTask(input.taskId);
        this.assertNormalTask(task, 'Agent work');
        const mode = input.mode ?? 'IMPLEMENTATION';
        if (task.currentRunId) {
          if (isImplementationRunMode(mode)) {
            await this.awaitPostRunEvidence(task.currentRunId);
          } else {
            await this.ensurePostRunEvidence(task.currentRunId);
          }
          task = await this.requireTask(input.taskId);
        }
        const retryReason = getImplementationRetryReason(task);
        if (retryReason && !isImplementationRunMode(mode)) {
          throw new Error(retryReason);
        }
        this.assertRuntimeEnabled(task.runtimeId);
        const snapshot = await this.store.snapshot();
        this.assertNoActiveTaskRun(snapshot, task.id, 'starting agent work');
        const worktree = await this.prepareWorktreeUnlocked({ taskId: task.id });
        return this.startPreparedRun({
          task,
          worktree,
          mode,
          settings: input.settings
        });
      })
    );
  }

  private async startPreparedRun(input: {
    task: Task;
    worktree: WorktreeRecord;
    mode?: AgentRunMode;
    settings?: AgentExecutionSettings;
  }): Promise<RunRecord> {
    await this.assertAgentRuntimeAvailable();
    const { task, worktree } = input;
    this.assertRuntimeEnabled(task.runtimeId);
    const iteration = await this.store.getCurrentIteration(task.id);
    if (!iteration) {
      throw new Error('Task iteration was not created.');
    }
    if (iteration.id !== worktree.iterationId) {
      throw new Error('Prepared worktree does not match the current task iteration.');
    }
    const snapshot = await this.refreshEvidenceInternal({ taskId: task.id });
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

  async cancelRun(input: CancelRunRequest): Promise<void> {
    return this.withRuntimeOperation(async () => {
      const run = await this.store.getRun(input.runId);
      if (!run) return;
      return this.withTaskAction(run.taskId, 'Agent cancellation', async () => {
        const current = await this.store.getRun(input.runId);
        if (!current || current.taskId !== run.taskId) return;
        await this.agents.interruptRun(current.id);
      });
    });
  }

  async steerRun(input: SteerRunRequest): Promise<void> {
    return this.withTaskAction(input.taskId, 'Agent steering', () =>
      this.withRuntimeOperation(async () => {
        await this.requireNormalTask(input.taskId, 'Agent steering');
        const run = await this.requireRunForTask(input.runId, input.taskId);
        const snapshot = await this.store.snapshot();
        const worktree = snapshot.worktrees.find(
          (candidate) => candidate.id === run.worktreeId
        );
        return this.agents.steerRun(
          run.id,
          buildSteerInstruction({
            instruction: input.instruction,
            worktreePath: worktree?.worktreePath
          })
        );
      })
    );
  }

  async continueRun(input: ContinueRunRequest): Promise<RunRecord> {
    return this.withTaskAction(input.taskId, 'Agent follow-up', () =>
      this.withRuntimeOperation(async () => {
        await this.assertAgentRuntimeAvailable();
        await this.awaitPostRunEvidence(input.runId);
        const { task, run, iteration, worktree } = await this.requireContinuationContext(
          input.taskId,
          input.runId
        );
        this.assertNormalTask(task, 'Agent follow-up');
        this.assertRuntimeEnabled(task.runtimeId);
        const snapshot = await this.store.snapshot();
        assertContinuable(run);
        this.assertNoActiveTaskRun(snapshot, task.id, 'starting follow-up work', {
          exceptRunId: run.id
        });
        const gitSnapshot = await this.refreshEvidenceInternal({ taskId: task.id });
        const settings = followUpSettings(task, run, input.settings, false);
        const prompt = buildContinuationPrompt({
          task,
          run,
          gitSnapshot,
          instruction: input.instruction
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
      })
    );
  }

  async retryRun(input: RetryRunRequest): Promise<RunRecord> {
    return this.withTaskAction(input.taskId, 'Agent retry', () =>
      this.withRuntimeOperation(async () => {
        await this.assertAgentRuntimeAvailable();
        await this.awaitPostRunEvidence(input.runId);
        const { task, run, iteration, worktree } = await this.requireContinuationContext(
          input.taskId,
          input.runId
        );
        this.assertNormalTask(task, 'Agent retry');
        this.assertRuntimeEnabled(task.runtimeId);
        const snapshot = await this.store.snapshot();
        this.assertNoActiveTaskRun(snapshot, task.id, 'retrying agent work', {
          exceptRunId: run.id
        });
        if (input.strategy === 'FORK') {
          assertForkable(run);
          await this.agents.resolveRecoveryRunForReplacement(run.id);
          return this.startForkedAlternative({
            sourceTaskId: task.id,
            sourceRun: run,
            sourceWorktree: worktree,
            instruction: input.instruction,
            settings: input.settings
          });
        }
        assertRetryable(run, Boolean(getImplementationRetryReason(task)));
        const gitSnapshot = await this.refreshEvidenceInternal({ taskId: task.id });
        const settings = followUpSettings(task, run, input.settings, false);
        const prompt = buildRetryPrompt({
          task,
          run,
          gitSnapshot,
          instruction: input.instruction
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
      })
    );
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
    const runtimeId = input.settings?.runtimeId ?? sourceTask.runtimeId;
    this.assertRuntimeEnabled(runtimeId);
    const alternativeSettings: AgentExecutionSettings = {
      ...sourceTask.agentSettings,
      ...input.settings,
      runtimeId
    };
    const adapter = this.runtimeRegistry.require(runtimeId);
    await this.assertRuntimeAllowedInCurrentSurface(adapter);
    const sourceAttachments = await this.store.getTaskAttachments(sourceTask.id);
    const resolvedAlternativeSettings = await prepareTaskCreationSettings(
      adapter,
      alternativeSettings,
      sourceAttachments
    );
    const alternativeTask = await this.store.createForkedAlternativeTask({
      title: `Alternative #${alternativeNumber}: ${sourceTask.title}`,
      prompt: buildForkAlternativeTaskPrompt({
        task: sourceTask,
        run: input.sourceRun,
        worktree: input.sourceWorktree,
        instruction: input.instruction
      }),
      repositoryId: sourceTask.repositoryId,
      runtimeId,
      agentSettings: resolvedAlternativeSettings,
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
        settings: resolvedAlternativeSettings
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
    updateAgentRuntimeIds?: readonly string[];
    restartAgentRuntimes?: boolean;
  }): Promise<ExternalToolStatusReport> {
    const status = await this.externalToolResolver.getStatus(
      this.appSettings.externalExecutables
    );
    configureGitExecutablePath(executableForRuntime(status.tools.git));
    this.github.setExecutable(executableForRuntime(status.tools.gh));
    this.codexExecutable = explicitExecutableForCodexRuntime(status.tools.codex);
    if (input.updateCodex && this.codexAdapter) {
      await this.codexAdapter.updateRuntimeConfig({
        executable: this.codexExecutable,
        toolSettings: this.appSettings.codexExternalTools,
        restart:
          input.restartCodex &&
          !this.appSettings.disabledRuntimeIds.includes(this.codexAdapter.descriptor.id)
      });
    }
    if (input.updateAgentRuntimeIds) {
      const updatedRuntimeIds = new Set(input.updateAgentRuntimeIds);
      await Promise.all(
        this.runtimeRegistry.list().map(async (adapter) => {
          if (
            !updatedRuntimeIds.has(adapter.descriptor.id) ||
            !adapter.configureRuntime ||
            adapter.descriptor.id === 'codex'
          ) {
            return;
          }
          if (
            this.browserDevAgentBoundary &&
            !hasBrowserDevRuntimeIsolation(await adapter.capabilities())
          ) {
            return;
          }
          const configured = this.appSettings.runtimeExecutablePaths[adapter.descriptor.id];
          const startupOverride =
            this.runtimeExecutableOverrides[adapter.descriptor.id];
          const executable =
            startupOverride ?? (configured === null ? undefined : configured);
          await adapter.configureRuntime({
            executable,
            restart:
              input.restartAgentRuntimes === true &&
              !this.appSettings.disabledRuntimeIds.includes(adapter.descriptor.id)
          });
        })
      );
    }
    return status;
  }

  private async initializeEnabledRuntimes(
    runtimeIds: readonly TaskManagerAppSettings['defaultRuntimeId'][]
  ): Promise<void> {
    if (runtimeIds.length === 0 || this.agentProviderStartupDisabledReason) return;
    const eligible: TaskManagerAppSettings['disabledRuntimeIds'] = [];
    for (const runtimeId of runtimeIds) {
      const adapter = this.runtimeRegistry.require(runtimeId);
      if (
        this.browserDevAgentBoundary &&
        !hasBrowserDevRuntimeIsolation(await adapter.capabilities())
      ) {
        continue;
      }
      eligible.push(runtimeId);
    }
    await this.runtimeRegistry.initialize(eligible);
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

  private async assertRuntimeEnablementValid(
    prospective: TaskManagerAppSettings,
    current?: TaskManagerAppSettings
  ): Promise<void> {
    const disabled = new Set(prospective.disabledRuntimeIds);
    for (const runtimeId of disabled) {
      this.runtimeRegistry.require(runtimeId);
    }
    for (const [purpose, runtimeId] of [
      ['default task', prospective.defaultRuntimeId],
      ['prompt refinement', prospective.promptRefinementRuntimeId],
      ['review', prospective.reviewRuntimeId]
    ] as const) {
      if (!runtimeId) continue;
      this.runtimeRegistry.require(runtimeId);
      if (disabled.has(runtimeId)) {
        throw new Error(
          `${this.runtimeRegistry.require(runtimeId).descriptor.displayName} cannot be disabled while it is the ${purpose} runtime.`
        );
      }
    }
    for (const runtimeId of Object.keys(prospective.runtimeExecutablePaths)) {
      if (runtimeId === 'codex') {
        throw new Error('Codex does not use a provider runtime executable path.');
      }
      const adapter = this.runtimeRegistry.require(runtimeId);
      if (!adapter.configureRuntime) {
        throw new Error(
          `${adapter.descriptor.displayName} does not use a provider runtime executable path.`
        );
      }
    }

    const newlyDisabled = new Set(
      prospective.disabledRuntimeIds.filter(
        (runtimeId) => !current?.disabledRuntimeIds.includes(runtimeId)
      )
    );
    if (newlyDisabled.size === 0) return;
    const activeRun = (await this.store.snapshot()).runs.find(
      (run) => newlyDisabled.has(run.runtimeId) && ACTIVE_AGENT_RUN_STATUSES.has(run.status)
    );
    if (activeRun) {
      const runtime = this.runtimeRegistry.require(activeRun.runtimeId).descriptor.displayName;
      throw new Error(
        `${runtime} cannot be disabled while run ${activeRun.id} is active or requires recovery.`
      );
    }
    const scopedRuntime = await this.activeDiscourseRuntime(newlyDisabled);
    if (scopedRuntime) {
      const runtime = this.runtimeRegistry.require(scopedRuntime.runtimeId).descriptor.displayName;
      throw new Error(
        `${runtime} cannot be disabled while Discourse response ${scopedRuntime.runId} is active or requires recovery.`
      );
    }
  }

  private assertRuntimeEnabled(runtimeId: TaskManagerAppSettings['defaultRuntimeId']): void {
    if (!this.appSettings.disabledRuntimeIds.includes(runtimeId)) return;
    const runtime = this.runtimeRegistry.require(runtimeId).descriptor.displayName;
    throw new Error(`${runtime} is disabled. Enable it in Settings before starting agent work.`);
  }

  private async activeAgentRuntimeIds(): Promise<Set<AgentRuntimeId>> {
    const snapshot = await this.store.snapshot();
    const runtimeIds = new Set<AgentRuntimeId>(
      snapshot.runs
        .filter((run) => ACTIVE_AGENT_RUN_STATUSES.has(run.status))
        .map((run) => run.runtimeId)
    );
    if (!this.agentRuntimeStore) return runtimeIds;
    const scoped = await this.agentRuntimeStore.snapshot();
    const sessionRuntime = new Map(
      scoped.sessions.map((session) => [session.id, session.runtimeId] as const)
    );
    for (const run of scoped.runs) {
      if (!ACTIVE_SCOPED_AGENT_RUN_STATUSES.has(run.status)) continue;
      const runtimeId = sessionRuntime.get(run.sessionId);
      if (runtimeId) runtimeIds.add(runtimeId);
    }
    return runtimeIds;
  }

  private async activeDiscourseRuntime(
    runtimeIds: ReadonlySet<AgentRuntimeId>
  ): Promise<{ runId: string; runtimeId: AgentRuntimeId } | undefined> {
    if (!this.agentRuntimeStore) return undefined;
    const snapshot = await this.agentRuntimeStore.snapshot();
    const sessionRuntime = new Map(
      snapshot.sessions.map((session) => [session.id, session.runtimeId] as const)
    );
    for (const run of snapshot.runs) {
      if (run.scope.kind !== 'DISCOURSE' || !ACTIVE_SCOPED_AGENT_RUN_STATUSES.has(run.status)) {
        continue;
      }
      const runtimeId = sessionRuntime.get(run.sessionId);
      if (runtimeId && runtimeIds.has(runtimeId)) return { runId: run.id, runtimeId };
    }
    return undefined;
  }

  async startReview(input: StartReviewRequest): Promise<RunRecord> {
    return this.withTaskAction(input.taskId, 'Agent review', () =>
      this.withRuntimeOperation(async () => {
        await this.assertAgentRuntimeAvailable();
        let task = await this.requireTask(input.taskId);
        this.assertNormalTask(task, 'Agent review');
        const runId = input.runId ?? task.currentRunId;
        if (!runId) {
          throw new Error('Complete an agent turn before starting a detached review.');
        }
        await this.ensurePostRunEvidence(runId);
        task = await this.requireTask(input.taskId);
        const implementationRetryReason = getImplementationRetryReason(task);
        if (implementationRetryReason) {
          throw new Error(implementationRetryReason);
        }
        const snapshot = await this.store.snapshot();
        this.assertNoActiveTaskRun(snapshot, task.id, 'starting a review');
        const run = await this.requireRunForTask(runId, task.id);
        if (
          [
            'QUEUED',
            'STARTING',
            'RUNNING',
            'AWAITING_APPROVAL',
            'AWAITING_USER_INPUT',
            'INTERRUPTING'
          ].includes(run.status)
        ) {
          throw new Error('Wait for the active turn to finish before starting a review.');
        }
        if (
          run.id !== task.currentRunId ||
          !isImplementationRunMode(run.mode) ||
          run.status !== 'COMPLETED' ||
          task.workflowPhase !== 'REVIEW'
        ) {
          throw new Error(
            'A review requires a successfully completed implementation run. Retry the implementation or continue unfinished work first.'
          );
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
        const gitSnapshot = await this.refreshEvidenceInternal({ taskId: task.id });
        const configuredReviewRuntimeId =
          this.appSettings.reviewRuntimeId ?? task.runtimeId;
        const reviewRuntimeId = input.settings?.runtimeId ?? configuredReviewRuntimeId;
        this.assertRuntimeEnabled(reviewRuntimeId);
        this.runtimeRegistry.require(reviewRuntimeId);
        const useConfiguredReviewModel = reviewRuntimeId === configuredReviewRuntimeId;
        const configuredReviewSettings: AgentExecutionSettings = {
          ...(useConfiguredReviewModel && this.appSettings.reviewModel
            ? { model: this.appSettings.reviewModel }
            : {}),
          ...(useConfiguredReviewModel && this.appSettings.reviewModelProvider
            ? { modelProvider: this.appSettings.reviewModelProvider }
            : {}),
          ...(useConfiguredReviewModel && this.appSettings.reviewReasoningEffort
            ? { reasoningEffort: this.appSettings.reviewReasoningEffort }
            : {}),
          ...input.settings,
          runtimeId: reviewRuntimeId
        };
        const settings =
          reviewRuntimeId === run.runtimeId
            ? followUpSettings(task, run, configuredReviewSettings, true)
            : mergeRunSettings({
                readOnly: true,
                settings: [
                  portableSecuritySettings(run.requestedSettings),
                  configuredReviewSettings
                ]
              });
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
      })
    );
  }

  async syncAgentGoal(input: SyncAgentGoalRequest) {
    return this.withRuntimeOperation(async () => {
      await this.assertAgentRuntimeAvailable();
      const task = await this.requireTask(input.taskId);
      this.assertNormalTask(task, 'Goal synchronization');
      this.assertRuntimeEnabled(task.runtimeId);
      return this.agents.syncGoal(task, input.sessionId);
    });
  }

  respondToInteraction(input: RespondToInteractionRequest) {
    return this.withTaskAction(input.taskId, 'Interaction response', () =>
      this.withRuntimeOperation(() => this.agents.respondToInteraction(input))
    );
  }

  shutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    if (this.lifecycleState === 'STOPPED') return Promise.resolve();
    this.lifecycleState = 'SHUTTING_DOWN';
    const runtimeDrain = this.runtimeOperations.close();
    const pendingInitialization = this.initWork;
    const pendingTaskActions = [...this.taskActionLocks.values()].map(
      ({ work }) => work
    );
    const pendingControlActions = [...this.activeControlActions];
    const pendingRuntimeLifecycle = runtimeDrain.lifecycle;
    const pendingRuntimeOperations = runtimeDrain.operations;
    const work = this.completeShutdown(
      pendingInitialization,
      pendingTaskActions,
      pendingControlActions,
      pendingRuntimeLifecycle,
      pendingRuntimeOperations
    )
      .finally(() => {
        this.lifecycleState = 'STOPPED';
        if (this.shutdownWork === work) this.shutdownWork = undefined;
      });
    this.shutdownWork = work;
    return work;
  }

  private async completeShutdown(
    pendingInitialization: Promise<void> | undefined,
    pendingTaskActions: Promise<unknown>[],
    pendingControlActions: Promise<unknown>[],
    pendingRuntimeLifecycle: Promise<void>,
    pendingRuntimeOperations: Promise<void>[]
  ): Promise<void> {
    await Promise.allSettled([
      pendingInitialization ?? Promise.resolve(),
      ...pendingTaskActions,
      ...pendingControlActions,
      pendingRuntimeLifecycle,
      ...pendingRuntimeOperations
    ]);
    await this.discourseHost?.beginShutdown();
    const [designResult] = await Promise.allSettled([
      this.designUpdates?.beginShutdown()
    ]);
    const [agentResult] = await Promise.allSettled([
      this.shutdownAgentOwners()
    ]);
    const [postRunEvidenceResult] = await Promise.allSettled([
      this.drainPostRunEvidence()
    ]);
    const [previewResult] = await Promise.allSettled([
      this.previewEnabled === false ? Promise.resolve() : this.previews.shutdown()
    ]);
    this.disposeAgentEventListener();
    const [storeCloseResult] = await Promise.allSettled([
      Promise.allSettled([
        this.discourseHost?.closeStores(),
        this.store.close()
      ]).then((results) => {
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (failed) throw failed.reason;
      })
    ]);
    if (designResult.status === 'rejected') {
      throw designResult.reason;
    }
    if (agentResult.status === 'rejected') {
      throw agentResult.reason;
    }
    if (postRunEvidenceResult.status === 'rejected') {
      throw postRunEvidenceResult.reason;
    }
    if (previewResult.status === 'rejected') {
      throw previewResult.reason;
    }
    if (storeCloseResult.status === 'rejected') {
      throw storeCloseResult.reason;
    }
  }

  private async shutdownAgentOwners(): Promise<void> {
    const [agentResult, previewRecipeGenerationResult] = await Promise.allSettled([
      this.agents.shutdown(),
      this.previewRecipeGenerator.shutdown()
    ]);
    if (agentResult.status === 'rejected') throw agentResult.reason;
    if (previewRecipeGenerationResult.status === 'rejected') {
      throw previewRecipeGenerationResult.reason;
    }
  }

  private requireDiscourseService(): DiscourseService {
    if (!this.discourseHost) {
      throw new Error('Discourse storage is not configured for this Task Monki service.');
    }
    return this.discourseHost.service;
  }

  async resolvePreview(input: ResolvePreviewRequest): Promise<ResolvePreviewResult> {
    this.assertPreviewEnabled();
    return this.withTaskAction(input.taskId, 'Preview plan resolution', async () => {
      await this.requireNormalTask(input.taskId, 'Preview plan resolution');
      const context = await this.requirePreviewContext(input.taskId);
      const result = await this.previews.resolve(context, input.scenarioId);
      this.events.emit({
        type: 'preview.updated',
        taskId: input.taskId,
        iterationId: context.iteration.id,
        worktreeId: context.worktree.id,
        payload: result,
        at: new Date().toISOString()
      });
      return result;
    });
  }

  async getPreviewRecipeGeneration(
    input: GetPreviewRecipeGenerationRequest
  ): Promise<PreviewRecipeGenerationSnapshot> {
    this.assertPreviewEnabled();
    await this.requireNormalTask(input.taskId, 'Preview recipe generation');
    return this.previewRecipeGenerator.get(input.taskId);
  }

  async generatePreviewRecipe(
    input: GeneratePreviewRecipeRequest
  ): Promise<PreviewRecipeGenerationSnapshot> {
    this.assertPreviewEnabled();
    this.assertAgentProviderAvailable();
    await this.requireNormalTask(input.taskId, 'Preview recipe generation');
    const context = await this.withTaskAction(
      input.taskId,
      'Preview recipe generation preparation',
      () => this.requirePreviewContext(input.taskId)
    );
    return this.withControlAction(() =>
      this.previewRecipeGenerator.generate({
        taskId: input.taskId,
        worktreePath: context.worktree.worktreePath,
        model: input.model,
        codexExecutable: this.codexAdapter?.currentRuntimeExecutable ?? this.codexExecutable,
        onUpdate: (state) => this.emitPreviewRecipeGenerationUpdate(context, state)
      })
    );
  }

  async validatePreviewRecipeDraft(
    input: ValidatePreviewRecipeDraftRequest
  ): Promise<PreviewRecipeValidation> {
    this.assertPreviewEnabled();
    await this.requireNormalTask(input.taskId, 'Preview recipe validation');
    return this.previewRecipeGenerator.validate(input.taskId, input.draftId, input.yaml);
  }

  acceptPreviewRecipeDraft(
    input: AcceptPreviewRecipeDraftRequest
  ): Promise<AcceptPreviewRecipeDraftResult> {
    this.assertPreviewEnabled();
    return this.withTaskAction(input.taskId, 'Preview recipe acceptance', async () => {
      await this.requireNormalTask(input.taskId, 'Preview recipe acceptance');
      const context = await this.requirePreviewContext(input.taskId);
      await this.previewRecipeGenerator.writeAcceptedRecipe({
        taskId: input.taskId,
        draftId: input.draftId,
        yaml: input.yaml,
        worktreePath: context.worktree.worktreePath
      });
      this.emitPreviewRecipeGenerationUpdate(
        context,
        this.previewRecipeGenerator.completeAcceptance(input.taskId)
      );
      let resolution: ResolvePreviewResult | undefined;
      let checkError: string | undefined;
      try {
        resolution = await this.previews.resolve(context);
        this.events.emit({
          type: 'preview.updated',
          taskId: input.taskId,
          iterationId: context.iteration.id,
          worktreeId: context.worktree.id,
          payload: resolution,
          at: new Date().toISOString()
        });
      } catch {
        checkError =
          'The recipe was saved, but Preview could not finish checking it. Use Check preview to retry.';
      }
      return {
        recipePath: '.taskmonki/preview.yaml',
        resolution,
        checkError
      };
    });
  }

  async discardPreviewRecipeDraft(
    input: DiscardPreviewRecipeDraftRequest
  ): Promise<PreviewRecipeGenerationSnapshot> {
    this.assertPreviewEnabled();
    await this.requireNormalTask(input.taskId, 'Preview recipe discard');
    const context = await this.requirePreviewContext(input.taskId);
    return this.withControlAction(() =>
      this.previewRecipeGenerator.discard(input.taskId, (state) =>
        this.emitPreviewRecipeGenerationUpdate(context, state)
      )
    );
  }

  private emitPreviewRecipeGenerationUpdate(
    context: PreviewTaskContext,
    state: PreviewRecipeGenerationSnapshot
  ): void {
    this.events.emit({
      type: 'preview.recipe-generation.updated',
      taskId: context.task.id,
      iterationId: context.iteration.id,
      worktreeId: context.worktree.id,
      payload: state,
      at: new Date().toISOString()
    });
  }

  approvePreviewPlan(
    input: ApprovePreviewPlanRequest
  ): Promise<PreviewApprovalRecord> {
    return this.withControlAction(() => this.approvePreviewPlanInternal(input));
  }

  setPreviewPrivateInput(input: { taskId: string; inputId: string; value: string }) {
    return this.withTaskAction(input.taskId, 'Private preview input update', () =>
      this.previews.setPrivateInput(input.taskId, input.inputId, input.value)
    );
  }

  deletePreviewPrivateInput(input: { taskId: string; inputId: string }) {
    return this.withTaskAction(input.taskId, 'Private preview input deletion', () =>
      this.previews.deletePrivateInput(input.taskId, input.inputId)
    );
  }

  retryPreviewPrivateVaultCleanup() {
    return this.withControlAction(() => this.previews.retryPrivateVaultCleanup());
  }

  private async approvePreviewPlanInternal(
    input: ApprovePreviewPlanRequest
  ): Promise<PreviewApprovalRecord> {
    this.assertPreviewEnabled();
    await this.requireNormalTask(input.taskId, 'Preview approval');
    const approval = await this.previews.approve(input);
    this.events.emit({
      type: 'preview.updated',
      taskId: input.taskId,
      payload: approval,
      at: approval.approvedAt
    });
    return approval;
  }

  async startPreview(input: StartPreviewRequest): Promise<PreviewGenerationRecord> {
    return this.startPreviewWithSetup(input);
  }

  private async startPreviewWithSetup(
    input: StartPreviewRequest,
    setupRetry?: RetryPreviewSetupRequest,
    reset?: ResetPreviewDataRequest
  ): Promise<PreviewGenerationRecord> {
    this.assertPreviewEnabled();
    if (process.platform !== 'darwin') {
      throw new Error('Native previews are supported on macOS only.');
    }
    return this.withTaskAction(input.taskId, reset ? 'Preview data reset' : 'Preview startup', async () => {
      await this.requireNormalTask(input.taskId, 'Preview startup');
      const context = await this.requirePreviewContext(input.taskId);
      const currentSnapshot = await this.store.snapshot();
      this.assertNoActiveTaskRun(currentSnapshot, input.taskId, 'capturing a preview');
      const blockingGeneration = currentSnapshot.previewGenerations.find(
        (generation) =>
          generation.taskId === input.taskId &&
          generation.routingState !== 'ACTIVE' &&
          (
            generation.state === 'CLEANUP_INCOMPLETE' ||
            (generation.state === 'RECOVERY_REQUIRED' && !reset) ||
            !['STOPPED', 'FAILED', 'RECOVERY_REQUIRED'].includes(generation.state)
          )
      );
      if (blockingGeneration) {
        throw new Error('Wait for the current preview replacement to finish or stop it before starting another.');
      }
      const gitSnapshot = await this.refreshEvidenceInternal({ taskId: input.taskId });
      if (['CONFLICTED', 'UNAVAILABLE', 'UNKNOWN'].includes(gitSnapshot.status)) {
        throw new Error(`Cannot capture a preview while Git status is ${gitSnapshot.status}.`);
      }
      if (reset) await this.previews.resetData({ ...reset, context });
      const setupRetryResourceIds = setupRetry
        ? await this.previews.authorizeSetupRetry({ ...setupRetry, context })
        : undefined;
      const prepared = await this.previews.prepare({
        context,
        gitSnapshot,
        reobserveGit: () => this.refreshEvidenceInternal({ taskId: input.taskId })
      }, input.scenarioId, setupRetryResourceIds);
      return this.previews.execute(prepared);
    });
  }

  stopPreview(input: StopPreviewRequest): Promise<PreviewGenerationRecord> {
    return this.withControlAction(() => this.stopPreviewInternal(input));
  }

  private async stopPreviewInternal(
    input: StopPreviewRequest
  ): Promise<PreviewGenerationRecord> {
    this.assertPreviewEnabled();
    await this.requireNormalTask(input.taskId, 'Preview stop');
    const generation = await this.store.getPreviewGeneration(input.generationId);
    if (!generation || generation.taskId !== input.taskId) {
      throw new Error('Preview generation was not found for this task.');
    }
    const cancelingStartup =
      generation.routingState === 'CANDIDATE' &&
      !['FAILED', 'STOPPED', 'CLEANUP_INCOMPLETE', 'RECOVERY_REQUIRED'].includes(generation.state);
    if (cancelingStartup) {
      return this.previews.stop(generation.id);
    }
    return this.withTaskAction(input.taskId, 'Preview stop', () =>
      this.previews.stop(generation.id)
    );
  }

  async resetPreviewData(input: ResetPreviewDataRequest): Promise<PreviewGenerationRecord> {
    return this.startPreviewWithSetup(
      { taskId: input.taskId, scenarioId: input.scenarioId },
      undefined,
      input
    );
  }

  async retryPreviewSetup(input: RetryPreviewSetupRequest): Promise<PreviewGenerationRecord> {
    return this.startPreviewWithSetup(
      { taskId: input.taskId, scenarioId: input.scenarioId },
      input
    );
  }

  setPreviewLocalAttachmentBinding(
    input: SetPreviewLocalAttachmentBindingRequest
  ): Promise<PreviewLocalAttachmentBindingRecord> {
    return this.withTaskAction(input.taskId, 'Preview binding update', async () => {
      this.assertPreviewEnabled();
      await this.requireNormalTask(input.taskId, 'Preview binding update');
      const context = await this.requirePreviewContext(input.taskId);
      return this.previews.setLocalAttachmentBinding({ ...input, context });
    });
  }

  deletePreviewLocalAttachmentBinding(
    input: DeletePreviewLocalAttachmentBindingRequest
  ): Promise<void> {
    return this.withTaskAction(input.taskId, 'Preview binding deletion', async () => {
      this.assertPreviewEnabled();
      await this.requireNormalTask(input.taskId, 'Preview binding deletion');
      const context = await this.requirePreviewContext(input.taskId);
      await this.previews.deleteLocalAttachmentBinding({ ...input, context });
    });
  }

  openPreview(input: OpenPreviewRequest): Promise<OpenPreviewResult> {
    return this.withControlAction(() => this.openPreviewInternal(input));
  }

  private async openPreviewInternal(input: OpenPreviewRequest): Promise<OpenPreviewResult> {
    this.assertPreviewEnabled();
    await this.requireNormalTask(input.taskId, 'Open Preview');
    return this.previews.open(input);
  }

  /** Main-process-only route resolution for the isolated Design canvas. */
  async resolveDesignCanvasRoute(
    input: OpenPreviewRequest
  ): Promise<ResolvedPreviewRoute> {
    this.assertPreviewEnabled();
    const task = await this.requireTask(input.taskId);
    if (task.kind !== 'DESIGN') {
      throw new Error('The in-app canvas is available only for Designs.');
    }
    return this.previews.resolveOpenRoute(input);
  }

  readPreviewLog(input: ReadPreviewLogRequest): Promise<ReadPreviewLogResult> {
    this.assertPreviewEnabled();
    return this.previews.readLog(input);
  }

  private async assertAgentRuntimeAvailable(): Promise<void> {
    this.assertAgentProviderAvailable();
  }

  private async assertRuntimeAllowedInCurrentSurface(
    adapter: AgentRuntimeAdapter
  ): Promise<void> {
    if (!this.browserDevAgentBoundary) {
      return;
    }
    assertBrowserDevRuntimeIsolation(
      adapter.descriptor,
      await adapter.capabilities()
    );
  }

  async refreshEvidence(input: RefreshEvidenceRequest): Promise<GitSnapshotRecord> {
    this.assertAcceptingWork();
    return this.refreshEvidenceInternal(input);
  }

  private async refreshEvidenceInternal(
    input: RefreshEvidenceRequest,
    options: {
      persistOnlyIfChanged?: boolean;
      verifiedWorktree?: WorktreeRecord;
    } = {}
  ): Promise<GitSnapshotRecord> {
    const task = await this.requireTask(input.taskId);
    let storedWorktree = options.verifiedWorktree;
    if (!storedWorktree) {
      const repository = await this.requireAvailableRepository(task.repositoryId);
      const worktree = await this.requireWorktree(task);
      const owner =
        task.kind === 'DESIGN' ? this.requireDesignWorktrees() : this.worktrees;
      const verified = await owner.verify(worktree, repository.path);
      storedWorktree =
        options.persistOnlyIfChanged &&
        sameWorktreeObservation(worktree, verified)
          ? worktree
          : await this.store.updateWorktree(verified, 'WORKTREE_VERIFIED');
    }
    if (storedWorktree.status !== 'PRESENT') {
      throw new Error(`Worktree is not ready: ${storedWorktree.status}`);
    }

    const snapshot = await inspectGitSnapshot(storedWorktree);
    if (options.persistOnlyIfChanged) {
      const state = await this.store.snapshot();
      const latest = latestForIteration(
        state.gitSnapshots,
        storedWorktree.iterationId,
        'capturedAt'
      );
      if (latest && sameGitObservation(latest, snapshot)) {
        return latest;
      }
    }
    const diffEvidence = await buildDiffEvidence(storedWorktree);
    const storedSnapshot = await this.store.recordGitSnapshot(snapshot, diffEvidence);
    await this.previews.observeGitSnapshot(storedSnapshot);
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
    const task = await this.requireTaskWithPostRunEvidence(input.taskId);
    this.assertNormalTask(task, 'GitHub delivery');
    this.assertImplementationOutcomeReady(task);
    const snapshot = await this.store.snapshot();
    this.assertNoActiveTaskRun(snapshot, task.id, 'creating a delivery commit');
    const worktree = await this.requireWorktree(task);
    const latestGit = await this.refreshEvidenceInternal({ taskId: task.id });
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
    return this.refreshEvidenceInternal({ taskId: task.id });
  }

  async preflightGitHub(input: GitHubPreflightRequest) {
    const task = await this.requireTask(input.taskId);
    this.assertNormalTask(task, 'GitHub preflight');
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
    const task = await this.requireTaskWithPostRunEvidence(input.taskId);
    this.assertNormalTask(task, 'GitHub delivery');
    this.assertImplementationOutcomeReady(task);
    const snapshot = await this.store.snapshot();
    this.assertNoActiveTaskRun(snapshot, task.id, 'publishing the branch');
    const worktree = await this.requireWorktree(task);
    const reconciled = await this.reconcilePendingBranchPublicationBeforeMutation(
      task,
      worktree
    );

    const latestGit = await this.ensureCommittedPublishableGit(task);
    assertPublishReady(latestGit);
    if (!latestGit.headSha) {
      throw new Error('Cannot publish a branch without a verified local HEAD.');
    }
    if (
      reconciled?.status === 'PUSHED' &&
      reconciled.headSha === latestGit.headSha
    ) {
      await this.refreshEvidenceInternal({ taskId: task.id });
      return reconciled;
    }

    const githubReady = await this.preflightGitHub({ taskId: task.id });
    if (githubReady.status !== 'READY') {
      throw new Error(githubReady.error ?? `GitHub preflight is ${githubReady.status}.`);
    }

    await this.store.recordBranchPublishRequested(
      task,
      worktree,
      githubReady.remoteName ?? 'origin',
      latestGit.headSha
    );
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
    await this.refreshEvidenceInternal({ taskId: task.id });
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
    const task = await this.requireTaskWithPostRunEvidence(input.taskId);
    this.assertNormalTask(task, 'GitHub delivery');
    this.assertImplementationOutcomeReady(task);
    const activeSnapshot = await this.store.snapshot();
    this.assertNoActiveTaskRun(activeSnapshot, task.id, 'opening a pull request');
    const worktree = await this.requireWorktree(task);
    await this.reconcilePendingBranchPublicationBeforeMutation(task, worktree);
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

    const prBodyContent = this.github.buildPullRequestBody({
      task,
      gitDiffStat: latestGit.diffStat,
      agentSummary: snapshot.runs.find((run) => run.id === task.currentRunId)?.finalMessage
    });
    const bodyArtifact = await this.store.recordPullRequestBodyArtifact(task, prBodyContent);

    await this.store.recordPullRequestCreateRequested(task, worktree);
    const sync = await this.github.createOrFindDraftPullRequest({
      worktree,
      baseRef: worktree.baseRef,
      body: prBodyContent,
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
      this.assertNormalTask(task, 'GitHub refresh');
      const worktree = await this.requireWorktree(task);
      const latest = await this.store.getLatestPullRequest(task.id);
      if (!latest?.number && !latest?.url) {
        return undefined;
      }
      try {
        const sync = await this.github.viewPullRequest(worktree, latest.number ?? latest.url ?? worktree.branchName);
        const currentTask = await this.requireTask(task.id);
        if (currentTask.currentRunId) {
          await this.ensurePostRunEvidence(currentTask.currentRunId);
        }
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
      const task = ['REVIEW', 'IN_REVIEW', 'DONE'].includes(input.toPhase)
        ? await this.requireTaskWithPostRunEvidence(input.taskId)
        : await this.requireTask(input.taskId);
      this.assertNormalTask(task, 'Workflow transition');
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
      const currentRun = task.currentRunId
        ? snapshot.runs.find((candidate) => candidate.id === task.currentRunId)
        : undefined;

      const blockedReason = transitionBlocker(task, input.toPhase, {
        hasWorktree: Boolean(task.currentWorktreeId),
        currentRun,
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
    return this.withTaskAction(input.taskId, 'Task deletion', () =>
      this.withRuntimeOperation(async () => {
        const task = await this.requireTask(input.taskId);
        if (task.kind === 'DESIGN') {
          const designUpdates = await this.requireDesignUpdates();
          return designUpdates.withExclusiveAccess(task.id, async () => {
            const currentTask = await this.requireTask(task.id);
            const snapshot = await this.store.snapshot();
            const blockedReason = taskDeletionBlocker(currentTask, snapshot);
            if (blockedReason) throw new Error(blockedReason);
            return this.deleteDesignTaskUnlocked(currentTask, snapshot);
          });
        }

        const snapshot = await this.store.snapshot();
        const blockedReason = taskDeletionBlocker(task, snapshot);
        if (blockedReason) throw new Error(blockedReason);

        // Preview cleanup is part of deletion authority. The store keeps its
        // resource ledger intact if any process or workspace identity is ambiguous.
        await this.previews.stopTask(task.id);
        await this.previewRecipeGenerator.discard(task.id);
        await this.agents.releaseTask(task.id);

        let removedWorktree = false;
        if (input.removeWorktree) {
          const worktrees = snapshot.worktrees.filter(
            (worktree) => worktree.taskId === task.id
          );
          for (const worktree of worktrees) {
            const repository = await this.requireAvailableRepository(
              worktree.repositoryId
            );
            await this.worktrees.remove(worktree, repository.path);
            removedWorktree = true;
          }
        }

        await this.store.deleteTask(task.id);
        await this.previews.retireDeletedTaskPrivateInputs(task.id).catch(() => undefined);
        const result = { taskId: task.id, removedWorktree };
        this.events.emit({
          type: 'task.deleted',
          taskId: task.id,
          payload: result,
          at: new Date().toISOString()
        });
        return result;
      })
    );
  }

  private async deleteDesignTaskUnlocked(
    task: Task,
    snapshot: TaskSnapshot
  ): Promise<DeleteTaskResult> {
    if (
      snapshot.designTurns.some(
        (turn) => turn.designId === task.id && turn.outcome === undefined
      )
    ) {
      throw new Error('Wait for the current Design update to settle before deleting it.');
    }
    const worktreeOwner = this.requireDesignWorktrees();
    const source = this.requireDesignSource();

    await this.previews.stopTask(task.id);
    await this.previewRecipeGenerator.discard(task.id);
    await this.agents.releaseTask(task.id);

    let removedWorktree = false;
    for (const worktree of snapshot.worktrees.filter(
      (candidate) => candidate.taskId === task.id
    )) {
      const repository = await this.requireAvailableRepository(worktree.repositoryId);
      await worktreeOwner.removeOwnedManaged(worktree, repository);
      removedWorktree = true;
    }

    const designDraft = await this.designDrafts?.get(task.id).catch(() => null);
    const released = await this.store.deleteTaskAndReleaseManagedRepository(task.id);
    await this.designDrafts?.deleteForDesign(task.id).catch(() => undefined);
    if (designDraft?.attachmentDraftId) {
      await this.store
        .discardAttachmentDraft(designDraft.attachmentDraftId)
        .catch(() => undefined);
    }
    await this.previews.retireDeletedTaskPrivateInputs(task.id).catch(() => undefined);
    if (released.removedManagedRepository) {
      await source.removeManagedRepository(released.removedManagedRepository);
    }
    const result = { taskId: task.id, removedWorktree };
    this.events.emit({
      type: 'task.deleted',
      scope: { kind: 'DESIGN', designId: task.id },
      taskId: task.id,
      payload: result,
      at: new Date().toISOString()
    });
    return result;
  }

  readArtifact(input: ReadArtifactRequest): Promise<string> {
    return this.store.readArtifact(input.artifactId);
  }

  readProtocolMessage(input: ReadProtocolMessageRequest) {
    return this.store.readProtocolMessage(input.reference);
  }

  private async validateAndRecordRepository(task: Task): Promise<RepositoryPreflight> {
    const repository = await this.requireAvailableRepository(task.repositoryId);
    const preflight = await validateRepositoryPath(repository.path);
    await this.store.recordRepositoryPreflight(repository.id, preflight);
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
      !['IMPLEMENTATION', 'FOLLOW_UP', 'RETRY', 'REVIEW', 'DESIGN'].includes(run.mode)
    ) {
      return;
    }
    const snapshot = await this.refreshEvidenceInternal({ taskId: run.taskId });
    await this.store.updateRun(run.id, { afterGitSnapshotId: snapshot.id });
    if (isImplementationRunMode(run.mode) && run.status === 'COMPLETED') {
      await this.reconcileImplementationOutcome(run, snapshot);
    }
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
  }

  private async reconcileImplementationOutcome(
    run: RunRecord,
    after: GitSnapshotRecord
  ): Promise<void> {
    const state = await this.store.snapshot();
    const task = state.tasks.find((candidate) => candidate.id === run.taskId);
    if (
      task?.currentRunId !== run.id ||
      !['IN_PROGRESS', 'REVIEW'].includes(task.workflowPhase) ||
      getImplementationRetryReason(task)
    ) {
      return;
    }
    const rejectedExecution = state.interactionRequests.find((interaction) =>
      isRejectedExecutionInteraction(interaction, run.id)
    );
    if (!rejectedExecution) {
      return;
    }
    const before = state.gitSnapshots.find(
      (candidate) => candidate.id === run.beforeGitSnapshotId
    );
    if (!before) {
      throw new Error(`Run ${run.id} is missing its pre-run Git evidence.`);
    }
    if (
      before.headSha !== after.headSha ||
      before.dirtyFingerprint !== after.dirtyFingerprint
    ) {
      return;
    }
    const outcome = rejectedExecution.status === 'CANCELED' ? 'canceled' : 'declined';
    const reason = `A provider execution request was ${outcome} and this run produced no Git change. Retry the implementation or continue unfinished work before review.`;
    await this.store.appendEvent(
      createDomainEvent({
        type: 'IMPLEMENTATION_OUTCOME_BLOCKED',
        taskId: task.id,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        source: 'git',
        payload: {
          reason,
          beforeGitSnapshotId: before.id,
          afterGitSnapshotId: after.id
        }
      })
    );
  }

  private scheduleDeferredCodexRuntimeRestart(runId: string): void {
    const codex = this.codexAdapter;
    if (!codex || this.runtimeOperations.isClosing) {
      return;
    }
    void this.enqueueRuntimeLifecycle(async () => {
      const run = await this.store.getRun(runId);
      if (run?.runtimeId !== codex.descriptor.id) {
        return;
      }
      await codex.applyPendingRuntimeConfigIfIdle();
    }).catch(() => undefined);
  }

  private trackPostRunEvidence(runId: string): void {
    if (this.postRunEvidenceTasks.has(runId)) {
      return;
    }
    const pending = this.capturePostRunEvidence(runId);
    this.postRunEvidenceTasks.set(runId, pending);
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (this.postRunEvidenceTasks.get(runId) === pending) {
          this.postRunEvidenceTasks.delete(runId);
        }
      });
  }

  private async awaitPostRunEvidence(runId: string): Promise<void> {
    await this.postRunEvidenceTasks.get(runId)?.catch(() => undefined);
  }

  private async ensurePostRunEvidence(runId: string): Promise<void> {
    await this.awaitPostRunEvidence(runId);
    const run = await this.store.getRun(runId);
    if (
      !run ||
      (!isImplementationRunMode(run.mode) && run.mode !== 'DESIGN') ||
      run.status !== 'COMPLETED'
    ) {
      return;
    }
    let completedRun = run;
    const state = await this.store.snapshot();
    const task = state.tasks.find((candidate) => candidate.id === completedRun.taskId);
    if (task?.currentRunId !== completedRun.id) {
      return;
    }
    const existingAfterId = completedRun.afterGitSnapshotId;
    let after = state.gitSnapshots.find(
      (candidate) => candidate.id === existingAfterId
    );
    if (!after) {
      await this.capturePostRunEvidence(completedRun.id);
      const capturedRun = await this.store.getRun(completedRun.id);
      if (!capturedRun) {
        throw new Error(`Run not found after post-run evidence capture: ${runId}.`);
      }
      completedRun = capturedRun;
      const refreshed = await this.store.snapshot();
      const capturedAfterId = completedRun.afterGitSnapshotId;
      after = refreshed.gitSnapshots.find(
        (candidate) => candidate.id === capturedAfterId
      );
    }
    if (!after) {
      throw new Error(`Run ${completedRun.id} is missing its post-run Git evidence.`);
    }
    if (isImplementationRunMode(completedRun.mode)) {
      await this.reconcileImplementationOutcome(completedRun, after);
    }
  }

  private async requireTaskWithPostRunEvidence(taskId: string): Promise<Task> {
    let task = await this.requireTask(taskId);
    if (task.currentRunId) {
      await this.ensurePostRunEvidence(task.currentRunId);
      task = await this.requireTask(taskId);
    }
    return task;
  }

  private assertImplementationOutcomeReady(task: Task): void {
    const reason = getImplementationRetryReason(task);
    if (reason) {
      throw new Error(reason);
    }
  }

  private async drainPostRunEvidence(): Promise<void> {
    while (this.postRunEvidenceTasks.size > 0) {
      await Promise.allSettled([...this.postRunEvidenceTasks.values()]);
    }
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private async requireNormalTask(taskId: string, action: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    this.assertNormalTask(task, action);
    return task;
  }

  private assertNormalTask(task: Task, action: string): void {
    if (task.kind === 'DESIGN') {
      throw new Error(`${action} is not available for a Design.`);
    }
  }

  private async requireAvailableRepository(repositoryId: string): Promise<Repository> {
    const repository = await this.requireRepository(repositoryId);
    if (repository.status !== 'AVAILABLE') {
      throw new Error(`Repository ${repository.name} is ${repository.status.toLowerCase()}.`);
    }
    return repository;
  }

  private async requireRepository(repositoryId: string): Promise<Repository> {
    const repository = await this.store.getRepository(repositoryId);
    if (!repository) {
      throw new Error(`Repository not found: ${repositoryId}`);
    }
    return repository;
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

  private async reconcileDesignWorkspaces(): Promise<void> {
    if (!this.designUpdates) return;
    for (const design of await this.store.listDesigns()) {
      try {
        await this.ensureDesignWorktree(design.id);
      } catch (error) {
        const detail = await this.store.getDesignDetail(design.id);
        const unsettled = detail.turns.find((turn) => turn.outcome === undefined);
        if (unsettled && !unsettled.runId) {
          await this.store.settleDesignTurn({
            designId: design.id,
            turnId: unsettled.id,
            outcome: 'NEEDS_ATTENTION',
            failureReason:
              error instanceof Error
                ? error.message
                : 'Task Monki could not restore the Design workspace.'
          });
        }
        this.emitDesignUpdate(design.id, { reason: 'workspace-recovery-failed' });
      }
    }
  }

  private async ensureDesignWorktree(designId: string): Promise<WorktreeRecord> {
    const owner = this.requireDesignWorktrees();
    const task = await this.requireTask(designId);
    if (task.kind !== 'DESIGN') throw new Error('Design workspace owner is invalid.');
    const repository = await this.requireAvailableRepository(task.repositoryId);
    if (repository.kind !== 'DESIGN_MANAGED' || !repository.headSha) {
      throw new Error('Managed Design repository is unavailable.');
    }
    let worktree = await this.store.getCurrentWorktree(task.id);
    if (!worktree || ['REMOVED', 'REMOVING'].includes(worktree.status)) {
      const spec = owner.buildSpecFromBase(task, {
        baseRef: repository.branch,
        baseSha: repository.headSha
      });
      ({ worktree } = await this.store.createIterationAndWorktree({
        task,
        branchName: spec.branchName,
        worktreePath: spec.worktreePath,
        baseRef: spec.baseRef,
        baseSha: spec.baseSha
      }));
    }
    try {
      const prepared = await owner.create(worktree, repository.path);
      const stored = await this.store.updateWorktree(prepared, 'WORKTREE_CREATED');
      if (stored.status !== 'PRESENT') {
        throw new Error(`Design worktree is not ready: ${stored.status}.`);
      }
      await this.refreshEvidenceInternal(
        { taskId: task.id },
        { persistOnlyIfChanged: true, verifiedWorktree: stored }
      );
      this.events.emit({
        type: 'worktree.updated',
        scope: { kind: 'DESIGN', designId: task.id },
        taskId: task.id,
        iterationId: stored.iterationId,
        worktreeId: stored.id,
        payload: stored,
        at: new Date().toISOString()
      });
      return stored;
    } catch (error) {
      await this.store.updateWorktree(
        {
          ...worktree,
          status: 'ERROR',
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString()
        },
        'WORKTREE_FAILED'
      );
      throw error;
    }
  }

  private async requireDesignPreviewContext(
    designId: string
  ): Promise<PreviewTaskContext> {
    const task = await this.requireTask(designId);
    if (task.kind !== 'DESIGN') throw new Error('Design not found.');
    const worktree = await this.ensureDesignWorktree(designId);
    const iteration = await this.store.getCurrentIteration(designId);
    if (!iteration || iteration.id !== worktree.iterationId) {
      throw new Error('Design worktree does not match its current iteration.');
    }
    return { task: await this.requireTask(designId), iteration, worktree };
  }

  private async refreshDesignGitEvidence(
    designId: string
  ): Promise<GitSnapshotRecord> {
    const context = await this.requireDesignPreviewContext(designId);
    return this.refreshEvidenceInternal(
      { taskId: designId },
      { verifiedWorktree: context.worktree }
    );
  }

  private requireDesignWorktrees(): WorktreeService {
    if (!this.designWorktrees) {
      throw new Error('Design workspaces are not configured in this Task Monki host.');
    }
    return this.designWorktrees;
  }

  private requireDesignSource(): DesignSourceService {
    if (!this.designSource) {
      throw new Error('Managed Design repositories are not configured in this Task Monki host.');
    }
    return this.designSource;
  }

  private requireDesignDrafts(): FileDesignDraftStore {
    if (!this.designDrafts) {
      throw new Error('Design drafts are not configured in this Task Monki host.');
    }
    return this.designDrafts;
  }

  private async resolveDesignDraftAttachments(
    draft: DesignDraftRecord
  ): Promise<DesignDraftRecord> {
    if (!draft.attachmentDraftId) {
      return { ...draft, attachmentDraft: undefined };
    }
    try {
      return {
        ...draft,
        attachmentDraft: await this.store.listAttachmentDraft(draft.attachmentDraftId)
      };
    } catch (error) {
      if (
        error instanceof AttachmentStoreError &&
        error.code === 'ATTACHMENT_DRAFT_NOT_FOUND'
      ) {
        return {
          ...draft,
          attachmentDraftId: undefined,
          attachmentDraft: undefined
        };
      }
      throw error;
    }
  }

  private async validateDesignDraftSelection(
    designId: string,
    referenceIds: readonly string[]
  ): Promise<void> {
    if (
      !Array.isArray(referenceIds) ||
      new Set(referenceIds).size !== referenceIds.length
    ) {
      throw new Error('Design draft reference selection is invalid.');
    }
    const detail = await this.store.getDesignDetail(designId);
    const activeReferenceIds = new Set(
      detail.references
        .filter((reference) => reference.state === 'ACTIVE')
        .map((reference) => reference.id)
    );
    if (referenceIds.some((referenceId) => !activeReferenceIds.has(referenceId))) {
      throw new Error('A selected Design draft reference is not active.');
    }
  }

  private async validateDesignAttachmentDraft(
    task: Task,
    attachmentDraftId: string
  ): Promise<AttachmentDraftSnapshot> {
    const [draft, existing] = await Promise.all([
      this.store.listAttachmentDraft(attachmentDraftId),
      this.store.getTaskAttachments(task.id)
    ]);
    if (existing.length + draft.attachments.length > ATTACHMENT_MAX_COUNT) {
      throw new AttachmentStoreError(
        'ATTACHMENT_LIMIT_EXCEEDED',
        `A Design can have at most ${ATTACHMENT_MAX_COUNT} references.`,
        413
      );
    }
    const totalBytes = [...existing, ...draft.attachments].reduce(
      (total, attachment) => total + attachment.byteCount,
      0
    );
    if (totalBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new AttachmentStoreError(
        'ATTACHMENT_TOTAL_TOO_LARGE',
        'Design references exceed the total size limit.',
        413
      );
    }
    const adapter = this.runtimeRegistry.require(task.runtimeId);
    const settings = await prepareTaskCreationSettings(
      adapter,
      task.agentSettings,
      draft.attachments
    );
    if (
      settings.networkAccess !== false ||
      settings.sandbox !== 'WORKSPACE_WRITE' ||
      settings.approvalPolicy !== 'never'
    ) {
      throw new Error('Design references require the restricted Design permission profile.');
    }
    return draft;
  }

  private async reconcileDesignDrafts(drafts: readonly DesignDraftRecord[]): Promise<void> {
    const snapshot = await this.store.snapshot();
    const designIds = new Set(
      snapshot.tasks.filter((task) => task.kind === 'DESIGN').map((task) => task.id)
    );
    const adoptedAttachmentDrafts = new Set(
      snapshot.designTurns.flatMap((turn) =>
        turn.attachmentDraftId
          ? [`${turn.designId}\u0000${turn.attachmentDraftId}`]
          : []
      )
    );
    for (const draft of drafts) {
      if (!designIds.has(draft.designId)) {
        await this.requireDesignDrafts().deleteForDesign(draft.designId);
        if (draft.attachmentDraftId) {
          await this.store
            .discardAttachmentDraft(draft.attachmentDraftId)
            .catch(() => undefined);
        }
        continue;
      }
      if (!draft.attachmentDraftId) continue;
      if (
        adoptedAttachmentDrafts.has(
          `${draft.designId}\u0000${draft.attachmentDraftId}`
        )
      ) {
        // The task snapshot is authoritative once the turn owns this staging id.
        // A crash can occur before the renderer clears its saved composer draft.
        await this.requireDesignDrafts().deleteForDesign(draft.designId);
        await this.store.discardAttachmentDraft(draft.attachmentDraftId);
        continue;
      }
      try {
        await this.store.listAttachmentDraft(draft.attachmentDraftId);
      } catch (error) {
        if (
          !(error instanceof AttachmentStoreError) ||
          error.code !== 'ATTACHMENT_DRAFT_NOT_FOUND'
        ) {
          throw error;
        }
        await this.requireDesignDrafts().save({
          designId: draft.designId,
          expectedRevision: draft.recordRevision,
          body: draft.body,
          referenceIds: draft.referenceIds
        });
      }
    }
  }

  private async requireDesignTask(designId: string, action: string): Promise<Task> {
    const task = await this.requireTask(designId);
    if (task.kind !== 'DESIGN') throw new Error(`${action} requires a Design.`);
    return task;
  }

  private async requireDesignUpdates(): Promise<DesignUpdateCoordinator> {
    this.assertPreviewEnabled();
    this.assertAgentProviderAvailable();
    this.assertRuntimeEnabled(CODEX_RUNTIME_ID);
    if (!this.designUpdates) {
      throw new Error('Design Mode is not configured in this Task Monki host.');
    }
    const capabilities = await this.runtimeRegistry
      .require(CODEX_RUNTIME_ID)
      .capabilities();
    if (
      capabilities.extensions['task-monki.design-instructions']?.maturity !==
        'stable' ||
      capabilities.extensions['task-monki.design-skill-access']?.maturity !==
        'stable' ||
      capabilities.extensions['task-monki.design-browser-verification']?.maturity !==
        'stable' ||
      capabilities.attachmentDelivery.maturity !== 'stable' ||
      capabilities.turnInterruption.maturity !== 'stable'
    ) {
      throw new Error(
        'The configured Codex runtime cannot apply Design instructions and skills safely, verify the rendered result, protect Design references, or support Stop.'
      );
    }
    return this.designUpdates;
  }

  private emitDesignUpdate(designId: string, payload: unknown): void {
    this.events.emit({
      type: 'design.updated',
      scope: { kind: 'DESIGN', designId },
      taskId: designId,
      payload,
      at: new Date().toISOString()
    });
  }

  private withDesignCreation<T>(
    creationToken: string,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = this.designCreationLocks.get(creationToken) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(action);
    this.designCreationLocks.set(creationToken, work);
    return work.finally(() => {
      if (this.designCreationLocks.get(creationToken) === work) {
        this.designCreationLocks.delete(creationToken);
      }
    });
  }

  private async requirePreviewContext(taskId: string) {
    const task = await this.requireTask(taskId);
    const worktree = await this.requireWorktree(task);
    const repository = await this.requireAvailableRepository(worktree.repositoryId);
    const verified = await this.worktrees.verify(worktree, repository.path);
    const storedWorktree = await this.store.updateWorktree(verified, 'WORKTREE_VERIFIED');
    if (storedWorktree.status !== 'PRESENT') {
      throw new Error(`Worktree is not ready for preview: ${storedWorktree.status}.`);
    }
    const iteration = await this.store.getCurrentIteration(task.id);
    if (!iteration || iteration.id !== storedWorktree.iterationId) {
      throw new Error('Preview worktree does not match the current task iteration.');
    }
    return { task, iteration, worktree: storedWorktree };
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

  private emitRepositoryUpdate(repository: Repository): void {
    this.events.emit({
      type: 'repository.updated',
      taskId: 'repositories',
      payload: repository,
      at: new Date().toISOString()
    });
  }

  private emitBoardUpdate(
    type: 'board.updated' | 'board.deleted',
    payload: unknown
  ): void {
    this.events.emit({
      type,
      taskId: 'boards',
      payload,
      at: new Date().toISOString()
    });
  }

  private async ensureCommittedPublishableGit(task: Task): Promise<GitSnapshotRecord> {
    const latestGit = await this.refreshEvidenceInternal({ taskId: task.id });
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
    this.assertAcceptingWork();
    const current = this.taskActionLocks.get(taskId);
    if (current) {
      throw new Error(`${current.label} is already running for this task.`);
    }
    const work = Promise.resolve().then(action);
    const entry: TaskActionWork = { label, work };
    this.taskActionLocks.set(taskId, entry);
    try {
      return await work;
    } finally {
      if (this.taskActionLocks.get(taskId) === entry) {
        this.taskActionLocks.delete(taskId);
      }
    }
  }

  private withRuntimeOperation<T>(action: () => Promise<T>): Promise<T> {
    this.assertAcceptingWork();
    return this.runtimeOperations.runOperation(action);
  }

  private withRuntimeLifecycleChange<T>(action: () => Promise<T>): Promise<T> {
    return this.runtimeOperations.runLifecycleChange(action);
  }

  private enqueueRuntimeLifecycle<T>(action: () => Promise<T>): Promise<T> {
    return this.runtimeOperations.enqueueLifecycleChange(action);
  }

  private withControlAction<T>(action: () => Promise<T>): Promise<T> {
    this.assertAcceptingWork();
    const work = Promise.resolve().then(action);
    this.activeControlActions.add(work);
    void work.then(
      () => this.activeControlActions.delete(work),
      () => this.activeControlActions.delete(work)
    );
    return work;
  }

  private assertInitializing(): void {
    if (this.lifecycleState !== 'INITIALIZING') {
      throw new Error('Task Manager is shutting down.');
    }
  }

  private assertAcceptingWork(): void {
    if (
      this.lifecycleState === 'SHUTTING_DOWN' ||
      this.lifecycleState === 'STOPPED'
    ) {
      throw new Error('Task Manager is shutting down.');
    }
  }

  private assertAgentProviderAvailable(): void {
    if (this.agentProviderStartupDisabledReason) {
      throw new Error(this.agentProviderStartupDisabledReason);
    }
  }

  private assertPreviewEnabled(): void {
    if (!this.previewEnabled) {
      throw new Error('Preview runtime is not configured in this Task Monki host.');
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
      throw new Error(`Wait for the agent review to finish before ${action}.`);
    }
    throw new Error(`Stop or let the active agent run finish before ${action}.`);
  }
}

function executableForRuntime(result: ExternalToolProbeResult): string {
  return result.resolvedPath ?? result.executable;
}

async function prepareTaskCreationSettings(
  adapter: AgentRuntimeAdapter,
  requestedSettings: AgentExecutionSettings,
  attachments: readonly Pick<AgentTurnAttachment, 'kind'>[]
): Promise<AgentExecutionSettings> {
  const capabilities = await adapter.capabilities();
  const policy = capabilities.executionPolicy;
  const preset = policy.presets.find(
    (candidate) => candidate.id === policy.defaultPresetId
  );
  if (!preset) {
    throw new Error(
      `${adapter.descriptor.displayName} does not expose a valid default execution policy.`
    );
  }
  if (
    attachments.length > 0 &&
    capabilities.attachmentDelivery.maturity === 'unsupported'
  ) {
    throw new Error(
      `${adapter.descriptor.displayName} does not support managed task attachments.`
    );
  }
  const explicitSettings = Object.fromEntries(
    Object.entries(requestedSettings).filter(([, value]) => value !== undefined)
  ) as AgentExecutionSettings;
  const settings: AgentExecutionSettings = {
    sandbox: preset.sandbox,
    approvalPolicy: preset.approvalPolicy,
    approvalsReviewer: preset.approvalsReviewer,
    networkAccess: preset.networkAccess === 'REQUIRED',
    ...explicitSettings,
    runtimeId: adapter.descriptor.id
  };
  assertAttachmentSandboxSupportsDelivery(settings, attachments);
  if (attachments.length === 0) {
    // Task capture is local and must remain available while a runtime is
    // offline. Model/catalog resolution is definitive at turn start.
    return settings;
  }
  const resolved = await adapter.resolveExecution({ settings, attachments });
  if (
    resolved.settings.runtimeId !== adapter.descriptor.id ||
    resolved.model.runtimeId !== adapter.descriptor.id
  ) {
    throw new Error(
      `${adapter.descriptor.displayName} returned execution settings for another runtime.`
    );
  }
  assertAttachmentSandboxSupportsDelivery(resolved.settings, attachments);
  return resolved.settings;
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

const ACTIVE_SCOPED_AGENT_RUN_STATUSES: ReadonlySet<
  import('../../shared/agentRuntime').AgentRuntimeRunRecord['status']
> = new Set([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
]);

function isDeclinedInteractionAction(action: string | undefined): boolean {
  return action === 'DECLINE' || action === 'DECLINE_FOR_SESSION';
}

function isRejectedExecutionInteraction(
  interaction: Pick<
    InteractionRequestRecord,
    'runId' | 'type' | 'status' | 'decision'
  >,
  runId: string
): boolean {
  return (
    interaction.runId === runId &&
    ['COMMAND_APPROVAL', 'FILE_CHANGE_APPROVAL', 'PERMISSION_APPROVAL'].includes(
      interaction.type
    ) &&
    ((interaction.status === 'DECLINED' &&
      isDeclinedInteractionAction(interaction.decision?.action)) ||
      (interaction.status === 'CANCELED' && interaction.decision?.action === 'CANCEL'))
  );
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

function sameWorktreeObservation(
  stored: WorktreeRecord,
  observed: WorktreeRecord
): boolean {
  return (
    stored.status === observed.status &&
    stored.headSha === observed.headSha &&
    stored.error === observed.error
  );
}

function sameGitObservation(
  stored: GitSnapshotRecord,
  observed: Omit<
    GitSnapshotRecord,
    'id' | 'capturedAt' | 'diffArtifactId'
  >
): boolean {
  const {
    id: _id,
    capturedAt: _capturedAt,
    diffArtifactId: _diffArtifactId,
    ...storedObservation
  } = stored;
  const normalizedObserved = Object.fromEntries(
    Object.entries(observed).filter(([, value]) => value !== undefined)
  );
  return isDeepStrictEqual(storedObservation, normalizedObserved);
}

function sameBranchPublicationObservation(
  stored: BranchPublicationRecord,
  observed: Omit<
    BranchPublicationRecord,
    'id' | 'requestedAt' | 'updatedAt'
  >
): boolean {
  const {
    id: _id,
    requestedAt: _requestedAt,
    updatedAt: _updatedAt,
    ...storedObservation
  } = stored;
  const normalizedObserved = Object.fromEntries(
    Object.entries(observed).filter(([, value]) => value !== undefined)
  );
  return isDeepStrictEqual(storedObservation, normalizedObserved);
}

function originalBranchPublishFailure(
  publication: BranchPublicationRecord | undefined
): string | undefined {
  if (!publication?.error) return undefined;
  if (publication.status === 'PUSHING') return publication.error;
  if (publication.status !== 'AMBIGUOUS') return undefined;
  const marker = ' Original push error: ';
  const markerIndex = publication.error.indexOf(marker);
  return markerIndex >= 0
    ? publication.error.slice(markerIndex + marker.length)
    : undefined;
}

function latestEventForIteration(
  snapshot: TaskSnapshot,
  taskId: string,
  iterationId: string,
  type: TaskSnapshot['events'][number]['type']
): TaskSnapshot['events'][number] | undefined {
  return snapshot.events
    .filter(
      (event) =>
        event.taskId === taskId &&
        event.iterationId === iterationId &&
        event.type === type
    )
    .sort((left, right) =>
      right.receivedAt.localeCompare(left.receivedAt)
    )[0];
}

function createDesignBrowserRuntime(input: {
  executablePath?: string;
  browserExecutablePath?: string;
  scratchRoot?: string;
  socketRoot?: string;
  requireCodeSignature?: boolean;
}): DesignBrowserOwner {
  if (
    !input.executablePath ||
    !input.browserExecutablePath ||
    !input.scratchRoot ||
    !input.socketRoot
  ) {
    throw new Error(
      'Design Mode requires the packaged agent-browser, browser executable, scratch root, and socket root.'
    );
  }
  return new AgentBrowserRuntime({
    executablePath: input.executablePath,
    browserExecutablePath: input.browserExecutablePath,
    scratchRoot: input.scratchRoot,
    socketRoot: input.socketRoot,
    requireCodeSignature: input.requireCodeSignature
  });
}
