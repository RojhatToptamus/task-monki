import type {
  CancelRunRequest,
  ContinueRunRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
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
  UpdateAgentNativeSessionRequest,
  UpdateAgentNativeSessionResult,
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
import { configureGitExecutablePath, git, gitSucceeds } from '../git/gitCli';
import { buildDiffEvidence, inspectGitSnapshot } from '../git/GitSnapshotService';
import { GitHubService } from '../github/GitHubService';
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
import type { AgentRuntimeAdapter } from '../agent/AgentRuntimeAdapter';
import { AgentRuntimeRegistry } from '../agent/AgentRuntimeRegistry';
import { CodexAppServerAdapter } from '../agent/codex/CodexAppServerAdapter';
import { OpenCodeAdapter } from '../agent/opencode/OpenCodeAdapter';
import { AcpRuntimeAdapter } from '../agent/acp/AcpRuntimeAdapter';
import { ACP_RUNTIME_PROFILES } from '../agent/acp/AcpRuntimeProfiles';
import {
  MemoryAppSettingsStore,
  type AppSettingsStorage
} from '../settings/AppSettingsStore';
import { ExternalToolResolver } from '../tools/ExternalToolResolver';
import { OpenTargetService, type OpenTargetHost } from '../open/OpenTargetService';
import {
  assertAttachmentSandboxSupportsDelivery,
  type AgentTurnAttachment
} from '../agent/AgentAttachmentDelivery';
import { AttachmentStoreError } from '../storage/AttachmentFileStore';
import {
  assertBrowserDevRuntimeIsolation,
  hasBrowserDevRuntimeIsolation
} from '../agent/BrowserDevAgentBoundary';

export class TaskManagerService {
  readonly events: AppEventBus;
  private readonly agents: AgentOrchestrator;
  private readonly runtimeRegistry: AgentRuntimeRegistry;
  private readonly codexAdapter?: CodexAppServerAdapter;
  private readonly worktrees: WorktreeService;
  private readonly github: GitHubService;
  private readonly appSettingsStore: AppSettingsStorage;
  private readonly externalToolResolver: ExternalToolResolver;
  private readonly openTargets: OpenTargetService;
  private readonly browserDevAgentBoundary: boolean;
  private readonly runtimeExecutableOverrides: Readonly<Record<string, string | undefined>>;
  private readonly taskActionLocks = new Map<string, string>();
  private readonly activeAttachmentDrafts = new Set<string>();
  private readonly agentProviderStartupDisabledReason?: string;
  private appSettings: TaskManagerAppSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS;

  constructor(
    private readonly store: FileTaskStore,
    private readonly defaultRepositoryPath: string,
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
      agentProviderAdapter?: AgentRuntimeAdapter;
      agentRuntimeAdapters?: readonly AgentRuntimeAdapter[];
      defaultAgentRuntimeId?: string;
      openTargetHost?: OpenTargetHost;
      allowAgentNetworkAccess?: boolean;
      agentProviderStartupDisabledReason?: string;
    } = {}
  ) {
    const agentCwd = options.agentCwd ?? (defaultRepositoryPath || process.cwd());
    this.browserDevAgentBoundary = options.allowAgentNetworkAccess === false;
    this.agentProviderStartupDisabledReason =
      options.agentProviderStartupDisabledReason;
    this.runtimeExecutableOverrides = {
      opencode:
        options.openCodePath ?? process.env.TASK_MONKI_OPENCODE_BIN,
      ...Object.fromEntries(
        ACP_RUNTIME_PROFILES.map((profile) => [
          profile.descriptor.id,
          options.acpExecutablePaths?.[profile.descriptor.id] ??
            process.env[ACP_RUNTIME_EXECUTABLE_ENV[profile.descriptor.id]]
        ])
      )
    };
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
    const runtimeAdapters = options.agentRuntimeAdapters ??
      (options.agentProviderAdapter
        ? [options.agentProviderAdapter]
        : createBuiltInAgentRuntimes(store, events, {
            cwd: agentCwd,
            codexExecutable: options.codexPath,
            openCodeExecutable: options.openCodePath,
            acpExecutablePaths: options.acpExecutablePaths,
            browserDevBoundary: this.browserDevAgentBoundary,
            codexToolSettings: this.appSettings.codexExternalTools
          }));
    this.codexAdapter = runtimeAdapters.find(
      (adapter): adapter is CodexAppServerAdapter =>
        adapter instanceof CodexAppServerAdapter
    );
    this.runtimeRegistry = new AgentRuntimeRegistry(
      runtimeAdapters,
      options.defaultAgentRuntimeId ?? runtimeAdapters[0].descriptor.id
    );
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
    this.github = new GitHubService(options.ghPath);
    this.events.on((event) => {
      if (event.type === 'run.terminal' && event.runId) {
        void this.capturePostRunEvidence(event.runId);
      }
    });
  }

  async init(): Promise<void> {
    await this.store.init();
    this.appSettings = await this.loadBoundarySafeAppSettings();
    await this.applyRuntimeSettings({
      restartCodex: false,
      updateCodex: true,
      updateAgentRuntimes: true,
      restartAgentRuntimes: false
    });
    await this.agents.initialize([
      this.runtimeRegistry.has(this.appSettings.defaultRuntimeId)
        ? this.appSettings.defaultRuntimeId
        : this.runtimeRegistry.defaultRuntimeId
    ]);
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

  getDefaultRepositoryPath(): string {
    return this.defaultRepositoryPath;
  }

  async getAppSettings(): Promise<TaskManagerAppSettings> {
    this.appSettings = await this.loadBoundarySafeAppSettings();
    return structuredClone(this.appSettings);
  }

  async updateAppSettings(
    input: UpdateAppSettingsRequest
  ): Promise<TaskManagerAppSettings> {
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
        capabilities.extensions.genericDetachedReview?.maturity === 'stable';
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
    const affectsExternalTools = Boolean(
      input.codexExternalTools ||
      input.externalExecutables ||
      input.runtimeExecutablePaths
    );
    if (affectsExternalTools) {
      const affectsCodexRuntime = affectsCodexRuntimeSettings(input);
      const hasActiveAgentRun = await this.hasActiveAgentRun();
      try {
        await this.applyRuntimeSettings({
          restartCodex: affectsCodexRuntime && !hasActiveAgentRun,
          updateCodex: affectsCodexRuntime,
          updateAgentRuntimes: Boolean(input.runtimeExecutablePaths),
          restartAgentRuntimes: !hasActiveAgentRun
        });
      } catch {
        // The setting is still saved; provider/tool status reports the runtime failure.
      }
      if (affectsCodexRuntime || input.runtimeExecutablePaths) {
        this.events.emit({
          type: 'runtime.updated',
          taskId: 'settings',
          payload: await this.getAgentRuntimeCatalog(),
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
    this.appSettings = await this.appSettingsStore.get();
    return this.openTargets.inspect(input, {
      snapshot: await this.store.snapshot(),
      defaultRepositoryPath: this.defaultRepositoryPath,
      appSettings: this.appSettings
    });
  }

  async executeOpenTargetAction(
    input: ExecuteOpenTargetActionRequest
  ): Promise<OpenTargetActionResult> {
    this.appSettings = await this.appSettingsStore.get();
    return this.openTargets.execute(input, {
      snapshot: await this.store.snapshot(),
      defaultRepositoryPath: this.defaultRepositoryPath,
      appSettings: this.appSettings
    });
  }

  validateRepository(repositoryPath: string): Promise<RepositoryPreflight> {
    return validateRepositoryPath(repositoryPath);
  }

  getAgentRuntimeCatalog() {
    return this.agents.getRuntimeCatalog();
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
      !input.runtimeId
    ) {
      throw new Error(
        'A task, session, and runtime are required for native session updates.'
      );
    }
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

    const adapter = this.runtimeRegistry.require(input.runtimeId);
    await this.assertAgentRuntimeAvailable();
    await this.assertRuntimeAllowedInCurrentSurface(adapter);
    let updateNative: () => Promise<import('../../shared/agent').AgentJsonValue>;
    if (input.operation === 'SET_MODE') {
      if (typeof input.modeId !== 'string' || !input.modeId || !adapter.setSessionMode) {
        throw new Error(
          `${adapter.descriptor.displayName} does not expose native session modes.`
        );
      }
      const setMode = adapter.setSessionMode.bind(adapter);
      updateNative = () => setMode(session.id, input.modeId);
    } else if (input.operation === 'SET_CONFIG_OPTION') {
      if (
        typeof input.configId !== 'string' ||
        !input.configId ||
        !['string', 'boolean'].includes(typeof input.value) ||
        !adapter.setSessionConfigOption
      ) {
        throw new Error(
          `${adapter.descriptor.displayName} does not expose this native configuration option.`
        );
      }
      const setConfigOption = adapter.setSessionConfigOption.bind(adapter);
      updateNative = () => setConfigOption(session.id, input.configId, input.value);
    } else {
      throw new Error('Unknown provider-native session operation.');
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

    const native = await updateNative();
    return {
      taskId: session.taskId,
      sessionId: session.id,
      runtimeId: session.runtimeId,
      native
    };
  }

  listTasks(): Promise<TaskSnapshot> {
    return this.store.snapshot();
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

  async refinePrompt(input: RefinePromptRequest): Promise<RefinePromptResponse> {
    await this.assertAgentRuntimeAvailable();
    const configuredRuntimeId =
      this.appSettings.promptRefinementRuntimeId ??
      this.appSettings.defaultRuntimeId;
    const runtimeId =
      input.runtimeId ??
      configuredRuntimeId;
    const useConfiguredModel = runtimeId === configuredRuntimeId;
    const adapter = this.runtimeRegistry.require(runtimeId);
    await this.assertRuntimeAllowedInCurrentSurface(adapter);
    if (!adapter.refinePrompt) {
      throw new Error(
        `${adapter.descriptor.displayName} does not expose native prompt refinement.`
      );
    }
    const refined = await adapter.refinePrompt({
      repositoryPath: input.repositoryPath,
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
      await this.assertAgentRuntimeAvailable();
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
    await this.assertAgentRuntimeAvailable();
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
      await this.assertAgentRuntimeAvailable();
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
      await this.assertAgentRuntimeAvailable();
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
    const runtimeId = input.settings?.runtimeId ?? sourceTask.runtimeId;
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
      repositoryPath: sourceTask.repositoryPath,
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
    updateAgentRuntimes?: boolean;
    restartAgentRuntimes?: boolean;
  }): Promise<ExternalToolStatusReport> {
    const status = await this.externalToolResolver.getStatus(
      this.appSettings.externalExecutables
    );
    configureGitExecutablePath(executableForRuntime(status.tools.git));
    this.github.setExecutable(executableForRuntime(status.tools.gh));
    if (input.updateCodex && this.codexAdapter) {
      const codexExecutable = explicitExecutableForCodexRuntime(status.tools.codex);
      await this.codexAdapter.updateRuntimeConfig({
        executable: codexExecutable,
        toolSettings: this.appSettings.codexExternalTools,
        restart: input.restartCodex
      });
    }
    if (input.updateAgentRuntimes) {
      await Promise.all(
        this.runtimeRegistry.list().map(async (adapter) => {
          if (!adapter.configureRuntime || adapter.descriptor.id === 'codex') {
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
            restart: input.restartAgentRuntimes === true
          });
        })
      );
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

  private async hasActiveAgentRun(): Promise<boolean> {
    const snapshot = await this.store.snapshot();
    return snapshot.runs.some((run) => ACTIVE_AGENT_RUN_STATUSES.has(run.status));
  }

  async startReview(input: StartReviewRequest): Promise<RunRecord> {
    return this.withTaskAction(input.taskId, 'Agent review', async () => {
      await this.assertAgentRuntimeAvailable();
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
      const configuredReviewRuntimeId =
        this.appSettings.reviewRuntimeId ?? task.runtimeId;
      const reviewRuntimeId =
        input.settings?.runtimeId ?? configuredReviewRuntimeId;
      this.runtimeRegistry.require(reviewRuntimeId);
      const useConfiguredReviewModel =
        reviewRuntimeId === configuredReviewRuntimeId;
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
    });
  }

  async syncAgentGoal(input: SyncAgentGoalRequest) {
    await this.assertAgentRuntimeAvailable();
    const task = await this.requireTask(input.taskId);
    return this.agents.syncGoal(task, input.sessionId);
  }

  respondToInteraction(input: RespondToInteractionRequest) {
    return this.agents.respondToInteraction(input);
  }

  async shutdown(): Promise<void> {
    try {
      await this.agents.shutdown();
    } finally {
      await this.store.close();
    }
  }

  private async assertAgentRuntimeAvailable(): Promise<void> {
    if (this.agentProviderStartupDisabledReason) {
      throw new Error(this.agentProviderStartupDisabledReason);
    }
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

      await this.agents.releaseTask(task.id);

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

  readProtocolMessage(input: ReadProtocolMessageRequest) {
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
      throw new Error(`Wait for the agent review to finish before ${action}.`);
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

function portableSecuritySettings(
  settings: AgentExecutionSettings
): AgentExecutionSettings {
  return {
    sandbox: settings.sandbox,
    networkAccess: settings.networkAccess,
    approvalPolicy: settings.approvalPolicy,
    approvalsReviewer: settings.approvalsReviewer
  };
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

function createBuiltInAgentRuntimes(
  store: FileTaskStore,
  events: AppEventBus,
  options: {
    cwd: string;
    codexExecutable?: string;
    openCodeExecutable?: string;
    acpExecutablePaths?: Partial<Record<string, string>>;
    browserDevBoundary: boolean;
    codexToolSettings: TaskManagerAppSettings['codexExternalTools'];
  }
): AgentRuntimeAdapter[] {
  const codex = new CodexAppServerAdapter(store, events, {
    cwd: options.cwd,
    executable: options.codexExecutable,
    toolSettings: options.codexToolSettings,
    failClosedMcpDiscovery: options.browserDevBoundary,
    enforceBrowserDevBoundary: options.browserDevBoundary
  });
  const openCode = new OpenCodeAdapter(store, events, {
    cwd: options.cwd,
    executable:
      options.openCodeExecutable ?? process.env.TASK_MONKI_OPENCODE_BIN
  });
  const acp = ACP_RUNTIME_PROFILES.map(
    (profile) =>
      new AcpRuntimeAdapter(store, events, profile, {
        cwd: options.cwd,
        executable:
          options.acpExecutablePaths?.[profile.descriptor.id] ??
          process.env[ACP_RUNTIME_EXECUTABLE_ENV[profile.descriptor.id]]
      })
  );
  return [codex, openCode, ...acp];
}

const ACP_RUNTIME_EXECUTABLE_ENV: Record<string, string> = {
  'gemini-acp': 'TASK_MONKI_GEMINI_ACP_BIN',
  'grok-acp': 'TASK_MONKI_GROK_ACP_BIN',
  'cursor-agent-acp': 'TASK_MONKI_CURSOR_AGENT_ACP_BIN',
  'claude-agent-acp': 'TASK_MONKI_CLAUDE_AGENT_ACP_BIN'
};

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

const ACTIVE_AGENT_RUN_STATUSES: ReadonlySet<RunRecord['status']> = new Set([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
]);

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
