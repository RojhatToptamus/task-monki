import fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type {
  AgentExecutionSettings,
  AgentJsonValue,
  AgentModel,
  AgentPreflight,
  AgentRuntimeCapabilities,
  AgentSessionRecord,
  AgentSessionSnapshot,
  RunRecord
} from '../../../shared/contracts';
import type { AppEventBus } from '../../runner/AppEventBus';
import { createDomainEvent } from '../../storage/domainEvent';
import type { FileTaskStore } from '../../storage/FileTaskStore';
import {
  ProcessSupervisor,
  redactProcessDiagnostic,
  type SupervisedProcess
} from '../../process/ProcessSupervisor';
import { execFilePortable } from '../../process/portableChildProcess';
import type { AgentTurnAttachment } from '../AgentAttachmentDelivery';
import {
  type AgentInteractionResponse,
  type AgentReconciliationResult,
  type AgentRuntimeAdapter,
  type AgentSessionRef,
  type AgentTurn,
  type CreateAgentSession,
  type InterruptAgentTurn,
  type ResolvedAgentExecution,
  type ResolveAgentExecution,
  type StartAgentTurn
} from '../AgentRuntimeAdapter';
import {
  createRuntimeReadiness,
  errorDiagnostic,
  infoDiagnostic,
  warningDiagnostic
} from '../AgentRuntimeReadiness';
import { sensitiveEnvironmentValues } from '../ProviderEnvironmentPolicy';
import {
  ANTIGRAVITY_RUNTIME_DESCRIPTOR,
  ANTIGRAVITY_RUNTIME_ID,
  antigravityCapabilities
} from './AntigravityCapabilities';
import {
  ANTIGRAVITY_ENVIRONMENT_POLICY,
  antigravityChildEnvironment
} from './AntigravityEnvironmentPolicy';
import { parseAntigravityModels } from './AntigravityProtocol';
import {
  AntigravityRuntimeResolutionError,
  resolveAntigravityRuntime,
  type AntigravityRuntimeResolverOptions,
  type ResolvedAntigravityRuntime
} from './AntigravityRuntimeResolver';

const MODEL_CATALOG_TIMEOUT_MS = 45_000;
const MODEL_CATALOG_TTL_MS = 60_000;
const MODEL_CATALOG_MAX_BYTES = 256 * 1024;
const MODEL_CATALOG_DIAGNOSTIC_MAX_BYTES = 16 * 1024;
const PRINT_TIMEOUT = '30m';
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const MAX_JOURNAL_CHUNK_BYTES = 64 * 1024;
const MAX_OUTPUT_LINE_BYTES = 64 * 1024;
const STDOUT_TRUNCATION_MARKER = '\n[Antigravity output truncated at 1 MiB.]\n';
const STDERR_TRUNCATION_MARKER =
  '\n[Antigravity diagnostics truncated at 128 KiB.]\n';
const ACTIVE_RUN_STATUSES: readonly RunRecord['status'][] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
];

type AntigravitySafetyFenceReason =
  | 'PROCESS_TERMINATION_UNCONFIRMED'
  | 'RECOVERY_PUBLICATION_FAILED';

interface BufferedAntigravityStream {
  decoder: StringDecoder;
  pendingLine: string;
  pendingLineBytes: number;
  discardingOversizedLine: boolean;
  flushed: boolean;
}

interface ActiveAntigravityTurn {
  runId: string;
  sessionId: string;
  serverId: string;
  correlationId: string;
  process: SupervisedProcess;
  stdoutStream: BufferedAntigravityStream;
  stderrStream: BufferedAntigravityStream;
  stdout: string;
  stdoutBytes: number;
  stderr: string;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cleanupStarted: boolean;
  processEventsFenced: boolean;
  processExitConfirmed: boolean;
  cancelReason?: string;
  startupError?: Error;
  rejectStartup?: (cause: unknown) => void;
  queueFailure?: Promise<void>;
  terminal: Promise<void>;
  resolveTerminal(): void;
  rejectTerminal(error: unknown): void;
}

export interface AntigravityAdapterOptions
  extends Omit<AntigravityRuntimeResolverOptions, 'cwd'> {
  cwd: string;
  runtimeResolver?: typeof resolveAntigravityRuntime;
  processSupervisor?: ProcessSupervisor;
  modelCatalogTimeoutMs?: number;
  /** Successful catalog reads are reused for this long. Primarily overridden by tests. */
  modelCatalogTtlMs?: number;
}

/**
 * Dedicated adapter for Antigravity's documented non-interactive CLI.
 *
 * It deliberately does not impersonate Gemini ACP or infer a private language
 * server protocol. Each Task Monki run owns exactly one `agy --print` process.
 */
export class AntigravityAdapter implements AgentRuntimeAdapter {
  readonly descriptor = ANTIGRAVITY_RUNTIME_DESCRIPTOR;

  private runtime?: ResolvedAntigravityRuntime;
  private models: AgentModel[] = [];
  private modelCatalogRefreshedAt?: number;
  private modelCatalogRefresh?: Promise<void>;
  private modelCatalogRefreshController?: AbortController;
  private modelCatalogGeneration = 0;
  private initialized = false;
  private initialization?: Promise<void>;
  private shuttingDown = false;
  private failedInitializationReported = true;
  private configuredExecutable?: string;
  private readonly processSupervisor: ProcessSupervisor;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly sensitiveValues: readonly string[];
  private readonly activeTurns = new Map<string, ActiveAntigravityTurn>();
  private readonly processQueues = new Map<string, Promise<void>>();
  private runtimeSafetyFence?: Error;
  private preflightState: AgentPreflight = {
    runtime: ANTIGRAVITY_RUNTIME_DESCRIPTOR,
    readiness: createRuntimeReadiness(
      'INITIALIZING',
      'Antigravity has not been initialized.',
      { checks: { initialization: 'NOT_STARTED' } }
    ),
    capabilities: antigravityCapabilities()
  };

  constructor(
    private readonly store: FileTaskStore,
    private readonly appEvents: AppEventBus,
    private readonly options: AntigravityAdapterOptions
  ) {
    this.configuredExecutable = normalizeExecutable(options.executable);
    this.processSupervisor = options.processSupervisor ?? new ProcessSupervisor();
    this.environment = options.environment ?? process.env;
    this.sensitiveValues = sensitiveEnvironmentValues(
      ANTIGRAVITY_ENVIRONMENT_POLICY,
      this.environment
    );
  }

  initialize(): Promise<void> {
    if (this.runtimeSafetyFence) return Promise.reject(this.runtimeSafetyFence);
    if (this.shuttingDown) {
      return Promise.reject(new Error('Antigravity runtime shutdown is in progress.'));
    }
    if (this.initialized) return Promise.resolve();
    if (this.initialization) return this.initialization;
    const tracked = this.initializeRuntime().finally(() => {
      if (this.initialization === tracked) this.initialization = undefined;
    });
    this.initialization = tracked;
    return tracked;
  }

  private async initializeRuntime(): Promise<void> {
    try {
      await this.recoverPersistedRuntimeLosses();
      if (!this.runtime) this.runtime = await this.resolveRuntime();
      await this.refreshModelsIfStale();
      this.initialized = true;
      this.failedInitializationReported = true;
      this.preflightState = {
        runtime: this.descriptor,
        readiness: createRuntimeReadiness(
          'READY',
          'Antigravity is ready for turn-scoped print runs.',
          {
            checks: {
              discovery: 'FOUND',
              compatibility: 'COMPATIBLE',
              initialization: 'INITIALIZED',
              authentication: 'AUTHENTICATED',
              modelCatalog: 'AVAILABLE'
            },
            diagnostics: [
              infoDiagnostic(
                'TURN_SCOPED_RUNTIME',
                'INITIALIZATION',
                'Antigravity conversations are intentionally not persisted or resumed by Task Monki.'
              ),
              warningDiagnostic(
                'PROMPT_VISIBLE_IN_PROCESS_ARGV',
                'SECURITY',
                'Antigravity receives the full task prompt in the live process argument list. Do not place secrets in Antigravity task prompts.',
                'Task Monki redacts the prompt from durable command records, but the public CLI exposes no documented stdin or prompt-file input.'
              )
            ]
          }
        ),
        capabilities: antigravityCapabilities()
      };
      this.emitRuntimeUpdate();
    } catch (cause) {
      this.initialized = false;
      this.models = [];
      this.modelCatalogRefreshedAt = undefined;
      if (!this.shuttingDown) {
        this.preflightState = antigravityFailurePreflight(cause, this.sensitiveValues);
        this.failedInitializationReported = false;
        this.emitRuntimeUpdate();
      }
      throw cause;
    }
  }

  async preflight(): Promise<AgentPreflight> {
    if (this.runtimeSafetyFence) return structuredClone(this.preflightState);
    if (!this.initialized && !this.initialization && !this.failedInitializationReported) {
      this.failedInitializationReported = true;
      return structuredClone(this.preflightState);
    }
    if (
      !this.initialized &&
      !this.initialization &&
      this.runtime &&
      isRetryableInitializationFailure(this.preflightState)
    ) {
      this.preflightState = discoveredAntigravityPreflight();
    }
    if (!this.runtime && !this.initialization) {
      try {
        this.runtime = await this.resolveRuntime();
        this.preflightState = discoveredAntigravityPreflight();
      } catch (cause) {
        this.preflightState = antigravityFailurePreflight(
          cause,
          this.sensitiveValues
        );
      }
    }
    return structuredClone(this.preflightState);
  }

  capabilities(): Promise<AgentRuntimeCapabilities> {
    return Promise.resolve(antigravityCapabilities());
  }

  async listModels(): Promise<AgentModel[]> {
    if (!this.initialized) await this.initialize();
    await this.refreshModelsIfStale();
    return structuredClone(this.models);
  }

  readNativeState(): Promise<AgentJsonValue> {
    return Promise.resolve({
      integration: 'documented-cli-print',
      sessionScope: 'turn',
      promptTransport: 'process-argv',
      promptDurableRecord: 'redacted',
      modelCommand: ['models'],
      requiredTurnFlags: ['--new-project', '--sandbox', '--print-timeout'],
      implementationMode: 'accept-edits',
      models: this.models.map((model) => ({
        label: model.model,
        provider: model.modelProvider
      }))
    });
  }

  async configureRuntime(input: {
    executable?: string;
    restart: boolean;
  }): Promise<void> {
    this.assertRuntimeSafe();
    const executable = normalizeExecutable(input.executable);
    if (executable === this.configuredExecutable && !input.restart) return;
    this.configuredExecutable = executable;
    this.runtime = undefined;
    this.models = [];
    this.modelCatalogRefreshedAt = undefined;
    this.initialized = false;
    this.failedInitializationReported = true;
    this.preflightState = {
      runtime: this.descriptor,
      readiness: createRuntimeReadiness(
        'INITIALIZING',
        'Antigravity configuration changed and requires discovery.',
        { checks: { initialization: 'NOT_STARTED' } }
      ),
      capabilities: antigravityCapabilities()
    };
    if (input.restart) await this.initialize();
  }

  async resolveExecution(input: ResolveAgentExecution): Promise<ResolvedAgentExecution> {
    this.assertRuntimeSafe();
    assertNoAttachments(input.attachments);
    assertAntigravitySettings(input.settings);
    let models = await this.listModels();
    if (!input.settings.model) {
      throw new Error(
        'Antigravity does not advertise a default model. Select an exact label from the current model catalog.'
      );
    }
    const providerMatches = input.settings.modelProvider
      ? models.filter((model) => model.modelProvider === input.settings.modelProvider)
      : models;
    let selected = providerMatches.find(
      (model) =>
        model.model === input.settings.model || model.id === input.settings.model
    );
    if (!selected) {
      // A settings panel may hold an exact label learned after the last normal
      // catalog read. Refresh once before declaring it unavailable; concurrent
      // starts share the same bounded discovery process.
      await this.refreshModelsIfStale(true);
      models = structuredClone(this.models);
      const refreshedProviderMatches = input.settings.modelProvider
        ? models.filter((model) => model.modelProvider === input.settings.modelProvider)
        : models;
      selected = refreshedProviderMatches.find(
        (model) =>
          model.model === input.settings.model || model.id === input.settings.model
      );
    }
    if (!selected) {
      const requested = input.settings.modelProvider
        ? `model ${input.settings.model} for provider ${input.settings.modelProvider}`
        : `model ${input.settings.model}`;
      throw new Error(
        `Antigravity did not advertise ${requested} after refreshing its model catalog. Select an exact advertised label.`
      );
    }
    return {
      model: selected,
      settings: {
        ...input.settings,
        runtimeId: ANTIGRAVITY_RUNTIME_ID,
        model: selected.model,
        modelProvider: selected.modelProvider,
        reasoningEffort: undefined,
        serviceTier: undefined,
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: true,
        approvalPolicy: 'provider-terminal-policy',
        approvalsReviewer: 'user'
      }
    };
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    if (input.runtimeId !== this.descriptor.id) {
      throw new Error('Antigravity session runtime ownership is invalid.');
    }
    const session = await this.requireSession(input.localSessionId);
    this.assertSessionOwnership(session);
    if (
      session.taskId !== input.taskId ||
      session.iterationId !== input.iterationId ||
      session.worktreeId !== input.worktreeId
    ) {
      throw new Error('Antigravity session does not match its Task Monki owner.');
    }
    if (session.providerSessionId) {
      throw new Error('Turn-scoped Antigravity sessions cannot have a provider session ID.');
    }
    await assertCanonicalWorktree(session.worktreePath, input.worktreePath);
    const resolved = await this.resolveExecution({ settings: input.settings, attachments: [] });
    return this.store.updateAgentSession(session.id, {
      status: 'IDLE',
      materialized: true,
      requestedSettings: resolved.settings,
      observedSettings: undefined,
      lastAttachedAt: new Date().toISOString()
    });
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    if (ref.providerSessionId) {
      throw new Error('Antigravity has no provider session to attach.');
    }
    const session = await this.requireSession(ref.localSessionId);
    this.assertSessionOwnership(session);
    await canonicalWorktree(session.worktreePath);
    return session;
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot> {
    const session = await this.attachSession(ref);
    const snapshot = await this.store.snapshot();
    return {
      session,
      runs: snapshot.runs
        .filter((run) => run.sessionId === session.id)
        .map((run) => ({
          id: run.id,
          providerTurnId: run.providerTurnId,
          status: run.status
        }))
    };
  }

  async releaseSession(ref: AgentSessionRef): Promise<void> {
    const session = await this.attachSession(ref);
    const active = [...this.activeTurns.values()].find(
      (turn) => turn.sessionId === session.id
    );
    if (active) {
      if (active.cleanupStarted) {
        await active.terminal.catch(() => undefined);
        if (this.activeTurns.get(active.runId) !== active) return;
      }
      throw new Error(
        `Cannot release Antigravity session ${session.id} while run ${active.runId} is active.`
      );
    }
  }

  async releaseTask(taskId: string): Promise<void> {
    for (const active of this.activeTurns.values()) {
      const run = await this.store.getRun(active.runId);
      if (run?.taskId === taskId) {
        if (active.cleanupStarted) {
          await active.terminal.catch(() => undefined);
          if (this.activeTurns.get(active.runId) !== active) continue;
        }
        throw new Error(`Cannot release task ${taskId} while Antigravity is running.`);
      }
    }
  }

  async startTurn(input: StartAgentTurn): Promise<AgentTurn> {
    this.assertRuntimeSafe();
    assertNoAttachments(input.attachments ?? []);
    if (Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES) {
      throw new Error('Antigravity print prompts cannot exceed 128 KiB.');
    }
    if (!supportedMode(input.mode)) {
      throw new Error(`Antigravity print mode does not support ${input.mode} turns.`);
    }
    const session = await this.requireSession(input.session.localSessionId);
    this.assertSessionOwnership(session);
    if (input.session.providerSessionId || session.providerSessionId) {
      throw new Error('Turn-scoped Antigravity runs cannot use a provider session ID.');
    }
    if (this.activeTurns.has(input.localRunId)) {
      throw new Error(`Antigravity run ${input.localRunId} is already active.`);
    }
    const existingSessionTurn = [...this.activeTurns.values()].find(
      (turn) => turn.sessionId === session.id
    );
    if (existingSessionTurn) {
      throw new Error(
        `Antigravity session ${session.id} already owns run ${existingSessionTurn.runId}.`
      );
    }
    const worktreePath = await canonicalWorktree(session.worktreePath);
    const resolved = await this.resolveExecution({
      settings: input.settings ?? session.requestedSettings,
      attachments: []
    });
    const runtime = this.runtime ?? (await this.resolveRuntime());
    const argv = antigravityTurnArgv(input, resolved.model.model);
    const diagnosticArgv = [...argv];
    diagnosticArgv[1] = '<prompt>';
    await this.store.recordAgentSettingsObservation({
      taskId: session.taskId,
      iterationId: session.iterationId,
      sessionId: session.id,
      runId: input.localRunId,
      runtimeId: this.descriptor.id,
      source: 'TASK_MONKI_RESOLUTION',
      settings: resolved.settings,
      detail:
        'Task Monki resolved the exact advertised Antigravity model and documented CLI arguments before process launch.'
    });
    const server = await this.store.createAgentServer({
      runtimeId: this.descriptor.id,
      runtimeKind: this.descriptor.kind,
      transport: this.descriptor.transport,
      executable: runtime.executable,
      argv: diagnosticArgv,
      schemaVersion: 'documented-cli-print-v1',
      runtimeResolution: runtime.diagnostics
    });
    const correlationId = `antigravity:${input.localRunId}`;
    await this.store.updateRun(input.localRunId, {
      providerTurnId: correlationId,
      serverInstanceId: server.id,
      status: 'STARTING',
      lastEventAt: new Date().toISOString()
    });
    await this.store.appendProtocolMessage(
      server.id,
      'OUTBOUND',
      JSON.stringify({
        type: 'antigravity.print',
        model: resolved.model.model,
        mode: input.mode,
        promptArtifact: (await this.store.getRun(input.localRunId))?.promptArtifactId
      }),
      { stream: 'command' }
    );

    const process = this.processSupervisor.start({
      executable: runtime.executable,
      argv,
      cwd: worktreePath,
      env: antigravityChildEnvironment(this.environment),
      allowedEnvironmentKeys: ANTIGRAVITY_ENVIRONMENT_POLICY.allowedKeys
    });
    const active = createActiveTurn(
      input.localRunId,
      session.id,
      server.id,
      correlationId,
      process
    );
    this.activeTurns.set(input.localRunId, active);

    const started = new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        active.rejectStartup = undefined;
        resolve();
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        active.rejectStartup = undefined;
        reject(error);
      };
      active.rejectStartup = rejectOnce;
      process.events.once('started', ({ pid }) => {
        this.enqueueProcessEvent(active, async () => {
          if (!this.ownsProcessEvents(active)) return;
          await this.store.updateAgentServer(server.id, {
            status: 'RUNNING',
            pid,
            initializedAt: new Date().toISOString(),
            lastHealthAt: new Date().toISOString()
          });
          await this.store.updateRun(input.localRunId, {
            status: 'RUNNING',
            lastEventAt: new Date().toISOString()
          });
          await this.store.updateAgentSession(session.id, {
            status: 'ACTIVE',
            materialized: true,
            requestedSettings: resolved.settings,
            observedSettings: undefined,
            lastAttachedAt: new Date().toISOString()
          });
          const run = await this.requireRun(input.localRunId);
          await this.recordRunActivity(run, 'turn/started', {
            transport: 'documented-cli-print',
            model: resolved.model.model,
            newProject: true,
            sandbox: true
          });
          resolveOnce();
        }).catch(async (cause) => {
          await this.handleProcessQueueFailure(active, cause);
          rejectOnce(cause);
        });
      });
      process.events.on('stdout', (chunk) => {
        void this.enqueueProcessEvent(active, async () => {
          if (!this.ownsProcessEvents(active)) return;
          await this.handleOutput(
            active,
            'stdout',
            active.stdoutStream.decoder.write(chunk)
          );
        }).catch((cause) => this.handleProcessQueueFailure(active, cause));
      });
      process.events.on('stderr', (chunk) => {
        void this.enqueueProcessEvent(active, async () => {
          if (!this.ownsProcessEvents(active)) return;
          await this.handleOutput(
            active,
            'stderr',
            active.stderrStream.decoder.write(chunk)
          );
        }).catch((cause) => this.handleProcessQueueFailure(active, cause));
      });
      process.events.once('error', (error) => {
        void this.enqueueProcessEvent(active, async () => {
          if (!this.ownsProcessEvents(active)) return;
          active.startupError = settled ? undefined : error;
          await this.handleOutput(active, 'stderr', `${error.message}\n`);
        }).catch((cause) => this.handleProcessQueueFailure(active, cause));
      });
      process.events.once('close', ({ exitCode, signal }) => {
        void this.enqueueProcessEvent(active, async () => {
          if (!this.ownsProcessEvents(active)) return;
          active.processExitConfirmed = true;
          active.cleanupStarted = true;
          if (active.queueFailure) {
            await active.queueFailure;
            return;
          }
          if (!settled) {
            const error = active.startupError ?? new Error(
              `Antigravity exited before startup with code ${String(exitCode)}${signal ? ` (${signal})` : ''}.`
            );
            await this.failUnstartedTurn(active, error, exitCode, signal);
            rejectOnce(error);
            return;
          }
          await this.finalizeTurn(active, exitCode, signal);
        }).catch((cause) => this.handleProcessQueueFailure(active, cause));
      });
    });

    try {
      await started;
    } catch (cause) {
      throw cause;
    }
    return { localRunId: input.localRunId, providerTurnId: correlationId };
  }

  async interruptTurn(input: InterruptAgentTurn): Promise<void> {
    const run = await this.store.getRunByProviderTurnId(
      this.descriptor.id,
      input.providerTurnId
    );
    const active = run ? this.activeTurns.get(run.id) : undefined;
    if (!run || !active || run.sessionId !== input.session.localSessionId) {
      throw new Error('The Antigravity turn is no longer active.');
    }
    try {
      await this.queueCancellationDecision(
        active,
        'Antigravity turn was interrupted by the user.'
      );
    } catch (cause) {
      // A cancelReason is assigned immediately before process.cancel(). Its
      // presence after rejection therefore means termination is unconfirmed,
      // not merely that the durable INTERRUPTING transition failed.
      if (this.activeTurns.get(active.runId) === active && active.cancelReason) {
        const fence = this.latchRuntimeSafetyFence(cause);
        await this.retireAfterUnconfirmedTermination(active, fence);
        throw fence;
      }
      throw cause;
    }
    await active.terminal;
  }

  respondToInteraction(_input: AgentInteractionResponse): Promise<void> {
    return Promise.reject(
      new Error('Antigravity print mode has no structured interaction protocol.')
    );
  }

  async reconcile(): Promise<AgentReconciliationResult> {
    const snapshot = await this.store.snapshot();
    const recoveryRequiredSessionIds = new Set<string>();
    for (const run of snapshot.runs.filter(
      (candidate) =>
        candidate.runtimeId === this.descriptor.id &&
        needsAntigravityRecovery(candidate) &&
        !this.activeTurns.has(candidate.id)
    )) {
      if (ACTIVE_RUN_STATUSES.includes(run.status)) {
        await this.store.appendEvent(
          createDomainEvent({
            type: 'AGENT_RUNTIME_LOST',
            taskId: run.taskId,
            iterationId: run.iterationId,
            runId: run.id,
            worktreeId: run.worktreeId,
            agentSessionId: run.sessionId,
            serverInstanceId: run.serverInstanceId,
            source: 'process',
            payload: {
              reason:
                'Task Monki no longer owns this turn-scoped Antigravity process. Its outcome is ambiguous and will not be replayed automatically.',
              automaticReplay: false
            }
          })
        );
      }
      await this.store.appendEvent(
        createDomainEvent({
          type: 'AGENT_RUNTIME_RECONCILED',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId: run.serverInstanceId,
          source: 'process',
          payload: {
            status: 'RECOVERY_REQUIRED',
            recoveryState: 'REQUIRES_USER_ACTION',
            terminal: false
          }
        })
      );
      await this.store.updateAgentSession(run.sessionId, {
        status: 'IDLE',
        materialized: true
      });
      recoveryRequiredSessionIds.add(run.sessionId);
      this.appEvents.emit({
        type: 'run.activity',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        payload: {
          eventType: 'runtime/lost',
          recoveryState: 'RECOVERY_REQUIRED',
          automaticReplay: false
        },
        at: new Date().toISOString()
      });
    }
    return {
      reconciledSessionIds: [],
      recoveryRequiredSessionIds: [...recoveryRequiredSessionIds]
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.activeTurns.values()];
    const initialization = this.initialization;
    const results = await Promise.allSettled(
      [
        ...active.map((turn) => this.shutdownTurn(turn)),
        this.stopModelCatalogRefresh(),
        ...(initialization ? [initialization.catch(() => undefined)] : [])
      ]
    );
    this.initialized = false;
    this.initialization = undefined;
    this.shuttingDown = false;
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Antigravity runtime shutdown was incomplete.');
    }
  }

  private async shutdownTurn(active: ActiveAntigravityTurn): Promise<void> {
    const reason = 'Task Monki shut down the Antigravity turn process.';
    try {
      await this.queueCancellationDecision(active, reason);
    } catch (cause) {
      // A natural close can win the serialized queue before shutdown reaches
      // its cancellation decision. In that case normal finalization already
      // owns the truth and no process fence is necessary.
      if (this.activeTurns.get(active.runId) !== active) {
        await active.terminal;
        return;
      }

      // A retained turn whose child has already exited is waiting only for a
      // durable recovery boundary. Its terminal promise is already settled,
      // so shutdown must not start another cancellation sequence or wait.
      if (active.processExitConfirmed) {
        await active.terminal;
        throw cause;
      }

      // If durable cancellation state failed before process.cancel(), make one
      // direct bounded termination attempt. A cancelReason means the normal
      // path already reached process.cancel() and its rejection is definitive.
      let terminationFailure: unknown = active.cancelReason ? cause : undefined;
      if (!terminationFailure) {
        active.cancelReason = reason;
        try {
          await active.process.cancel();
          active.processExitConfirmed = true;
        } catch (cancelCause) {
          terminationFailure = cancelCause;
        }
      }

      if (terminationFailure) {
        const fence = this.latchRuntimeSafetyFence(terminationFailure);
        await this.retireAfterUnconfirmedTermination(active, fence);
        throw fence;
      }

      // The emergency termination was confirmed. Its close event owns normal
      // finalization, but shutdown still reports the cancellation-state error.
      await active.terminal;
      throw cause;
    }
    await active.terminal;
  }

  private async resolveRuntime(): Promise<ResolvedAntigravityRuntime> {
    return (this.options.runtimeResolver ?? resolveAntigravityRuntime)({
      cwd: this.options.cwd,
      executable: this.configuredExecutable,
      environment: this.environment
    });
  }

  private refreshModelsIfStale(force = false): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Antigravity runtime shutdown is in progress.'));
    }
    const ttl = this.options.modelCatalogTtlMs ?? MODEL_CATALOG_TTL_MS;
    if (!Number.isFinite(ttl) || ttl < 1) {
      return Promise.reject(
        new Error('Antigravity model catalog TTL must be a positive finite duration.')
      );
    }
    if (this.modelCatalogRefresh) return this.modelCatalogRefresh;
    const now = Date.now();
    if (
      !force &&
      this.modelCatalogRefreshedAt !== undefined &&
      now >= this.modelCatalogRefreshedAt &&
      now - this.modelCatalogRefreshedAt < ttl
    ) {
      return Promise.resolve();
    }
    const generation = this.modelCatalogGeneration;
    const controller = new AbortController();
    const tracked = this.refreshModels(controller.signal, generation)
      .then(() => {
        if (
          this.initialized &&
          !this.shuttingDown &&
          generation === this.modelCatalogGeneration
        ) {
          this.emitRuntimeUpdate();
        }
      })
      .catch((cause) => {
        if (
          this.initialized &&
          !this.shuttingDown &&
          generation === this.modelCatalogGeneration
        ) {
          this.markModelCatalogFailure(cause);
        }
        throw cause;
      })
      .finally(() => {
        if (this.modelCatalogRefresh === tracked) this.modelCatalogRefresh = undefined;
        if (this.modelCatalogRefreshController === controller) {
          this.modelCatalogRefreshController = undefined;
        }
      });
    this.modelCatalogRefreshController = controller;
    this.modelCatalogRefresh = tracked;
    return tracked;
  }

  private async stopModelCatalogRefresh(): Promise<void> {
    this.modelCatalogGeneration += 1;
    const refresh = this.modelCatalogRefresh;
    this.modelCatalogRefreshController?.abort();
    await refresh?.catch(() => undefined);
  }

  private markModelCatalogFailure(cause: unknown): void {
    this.initialized = false;
    this.models = [];
    this.modelCatalogRefreshedAt = undefined;
    this.preflightState = antigravityFailurePreflight(cause, this.sensitiveValues);
    this.failedInitializationReported = false;
    this.emitRuntimeUpdate();
  }

  private async refreshModels(
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    const runtime = this.runtime ?? (await this.resolveRuntime());
    const environment = antigravityChildEnvironment(this.environment);
    const timeout = this.options.modelCatalogTimeoutMs ?? MODEL_CATALOG_TIMEOUT_MS;
    try {
      const result = await execFilePortable(runtime.executable, ['models'], {
        cwd: this.options.cwd,
        env: environment,
        timeout,
        maxBuffer: MODEL_CATALOG_MAX_BYTES,
        signal,
        windowsHide: true
      });
      const models = parseAntigravityModels(result.stdout);
      if (signal.aborted || generation !== this.modelCatalogGeneration) {
        throw new Error('Antigravity model catalog refresh was superseded.');
      }
      this.models = models;
      this.modelCatalogRefreshedAt = Date.now();
    } catch (cause) {
      const timeoutDetail = commandTimedOut(cause)
        ? ` The command exceeded its ${formatDuration(timeout)} discovery timeout.`
        : '';
      throw new Error(
        `Antigravity model catalog discovery failed.${timeoutDetail} ${commandErrorMessage(
          cause,
          this.sensitiveValues
        )}`
      );
    }
  }

  private async handleOutput(
    active: ActiveAntigravityTurn,
    source: 'stdout' | 'stderr',
    text: string
  ): Promise<void> {
    if (!text) return;
    const stream = outputStream(active, source);
    if (stream.flushed) return;
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor);
      const end = newline === -1 ? text.length : newline + 1;
      const fragment = text.slice(cursor, end);
      cursor = end;

      if (stream.discardingOversizedLine) {
        if (newline !== -1) stream.discardingOversizedLine = false;
        continue;
      }

      const fragmentBytes = Buffer.byteLength(fragment);
      if (stream.pendingLineBytes + fragmentBytes > MAX_OUTPUT_LINE_BYTES) {
        stream.pendingLine = '';
        stream.pendingLineBytes = 0;
        stream.discardingOversizedLine = newline === -1;
        await this.retainOutput(active, source, oversizedLineMarker(source));
        continue;
      }

      stream.pendingLine += fragment;
      stream.pendingLineBytes += fragmentBytes;
      if (newline !== -1) {
        const line = stream.pendingLine;
        stream.pendingLine = '';
        stream.pendingLineBytes = 0;
        await this.retainOutput(
          active,
          source,
          redactProcessDiagnostic(line, this.sensitiveValues)
        );
      }
    }
  }

  private async retainOutput(
    active: ActiveAntigravityTurn,
    source: 'stdout' | 'stderr',
    safe: string
  ): Promise<void> {
    if (!safe || streamTruncated(active, source)) return;
    const limit = source === 'stdout' ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES;
    const bytes = source === 'stdout' ? active.stdoutBytes : active.stderrBytes;
    const accepted = truncateUtf8(safe, Math.max(0, limit - bytes));
    const truncated = Buffer.byteLength(accepted) < Buffer.byteLength(safe);
    if (accepted) {
      for (const part of splitUtf8(accepted, MAX_JOURNAL_CHUNK_BYTES)) {
        await this.store.appendProtocolMessage(active.serverId, 'INBOUND', part, {
          stream: source
        });
      }
    }
    if (source === 'stdout') {
      active.stdout += accepted;
      active.stdoutBytes += Buffer.byteLength(accepted);
      if (accepted) {
        const run = await this.requireRun(active.runId);
        await this.store.appendArtifact(run.outputArtifactId, accepted);
        this.appEvents.emit({
          type: 'run.output',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          payload: { source: 'antigravity', text: accepted },
          at: new Date().toISOString()
        });
      }
      if (truncated && !active.stdoutTruncated) {
        active.stdoutTruncated = true;
        await this.appendTruncationMarker(active, source, STDOUT_TRUNCATION_MARKER);
        const run = await this.requireRun(active.runId);
        this.appEvents.emit({
          type: 'run.output',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          payload: { source: 'antigravity', text: STDOUT_TRUNCATION_MARKER },
          at: new Date().toISOString()
        });
      }
    } else {
      active.stderr += accepted;
      active.stderrBytes += Buffer.byteLength(accepted);
      if (accepted) {
        const run = await this.requireRun(active.runId);
        await this.store.appendArtifact(run.diagnosticArtifactId, accepted);
      }
      if (truncated && !active.stderrTruncated) {
        active.stderrTruncated = true;
        await this.appendTruncationMarker(active, source, STDERR_TRUNCATION_MARKER);
      }
    }
  }

  private async appendTruncationMarker(
    active: ActiveAntigravityTurn,
    source: 'stdout' | 'stderr',
    marker: string
  ): Promise<void> {
    await this.store.appendProtocolMessage(active.serverId, 'INBOUND', marker, {
      stream: source,
      truncated: true
    });
    const run = await this.requireRun(active.runId);
    await this.store.appendArtifact(
      source === 'stdout' ? run.outputArtifactId : run.diagnosticArtifactId,
      marker
    );
  }

  private async flushOutputStream(
    active: ActiveAntigravityTurn,
    source: 'stdout' | 'stderr'
  ): Promise<void> {
    const stream = outputStream(active, source);
    if (stream.flushed) return;
    await this.handleOutput(active, source, stream.decoder.end());
    if (!stream.discardingOversizedLine && stream.pendingLine) {
      await this.retainOutput(
        active,
        source,
        redactProcessDiagnostic(stream.pendingLine, this.sensitiveValues)
      );
    }
    stream.pendingLine = '';
    stream.pendingLineBytes = 0;
    stream.discardingOversizedLine = false;
    stream.flushed = true;
  }

  private async finalizeTurn(
    active: ActiveAntigravityTurn,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    active.cleanupStarted = true;
    try {
      await this.flushOutputStream(active, 'stdout');
      await this.flushOutputStream(active, 'stderr');
      const run = await this.requireRun(active.runId);
      if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
        active.resolveTerminal();
      } else {
        const status: Extract<RunRecord['status'], 'COMPLETED' | 'FAILED' | 'INTERRUPTED'> =
          active.cancelReason || run.status === 'INTERRUPTING'
            ? 'INTERRUPTED'
            : exitCode === 0
              ? 'COMPLETED'
              : 'FAILED';
        const terminalReason = status === 'INTERRUPTED'
          ? active.cancelReason ?? 'Antigravity was interrupted.'
          : status === 'FAILED'
            ? failureReason(active, exitCode, signal)
            : undefined;
        const serverStatus = status === 'FAILED' ? 'FAILED' : 'EXITED';
        await this.store.updateAgentServer(active.serverId, {
          status: serverStatus,
          exitCode,
          signal,
          exitedAt: new Date().toISOString(),
          exitReason: terminalReason ?? 'Antigravity print turn completed.'
        });
        const finalMessage = active.stdout.trim();
        await this.store.updateRun(run.id, {
          finalMessage: finalMessage || undefined,
          lastEventAt: new Date().toISOString()
        });
        const finalArtifact = await this.store.writeFinalArtifact(
          run.taskId,
          run.id,
          formatFinalArtifact(run, status, active.stdout, terminalReason, active.stdoutTruncated)
        );
        await this.recordRunActivity(run, 'turn/completed', {
          status: status.toLowerCase(),
          exitCode,
          signal,
          stdoutTruncated: active.stdoutTruncated,
          stderrTruncated: active.stderrTruncated,
          ...(finalMessage ? { messageText: finalMessage } : {})
        });
        await this.store.appendEvent(
          createDomainEvent({
            type:
              status === 'COMPLETED'
                ? 'AGENT_RUN_COMPLETED'
                : status === 'INTERRUPTED'
                  ? 'AGENT_RUN_INTERRUPTED'
                  : 'AGENT_RUN_FAILED',
            taskId: run.taskId,
            iterationId: run.iterationId,
            runId: run.id,
            worktreeId: run.worktreeId,
            agentSessionId: run.sessionId,
            serverInstanceId: active.serverId,
            source: 'provider',
            payload: {
              terminalStatus: status.toLowerCase(),
              terminalReason,
              error: status === 'FAILED' ? terminalReason : undefined,
              finalArtifactId: finalArtifact.id
            }
          })
        );
        await this.store.updateAgentSession(run.sessionId, {
          status: 'IDLE',
          materialized: true,
          lastAttachedAt: new Date().toISOString()
        });
        this.appEvents.emit({
          type: 'run.terminal',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          payload: {
            status: status.toLowerCase(),
            error: status === 'FAILED' ? terminalReason : undefined,
            finalArtifactId: finalArtifact.id
          },
          at: new Date().toISOString()
        });
        active.resolveTerminal();
      }
    } catch (cause) {
      await this.recoverFailedTurn(
        active,
        finalizationFailureReason(cause, this.sensitiveValues),
        true,
        cause
      );
      return;
    }
    this.releaseActiveTurn(active);
  }

  private async failUnstartedTurn(
    active: ActiveAntigravityTurn,
    error: Error,
    exitCode: number | null = null,
    signal: NodeJS.Signals | null = null
  ): Promise<void> {
    active.cleanupStarted = true;
    await this.flushOutputStream(active, 'stdout');
    await this.flushOutputStream(active, 'stderr');
    const safe = redactProcessDiagnostic(error.message, this.sensitiveValues);
    const server = await this.store.getAgentServer(active.serverId);
    if (server && !['EXITED', 'FAILED', 'LOST'].includes(server.status)) {
      await this.store.updateAgentServer(active.serverId, {
        status: 'FAILED',
        exitCode,
        signal,
        exitedAt: new Date().toISOString(),
        exitReason: safe
      });
    }
    await this.store.updateAgentSession(active.sessionId, {
      status: 'IDLE',
      materialized: true
    });
    this.finishActiveTurn(active);
  }

  private finishActiveTurn(active: ActiveAntigravityTurn): void {
    this.releaseActiveTurn(active);
    active.resolveTerminal();
  }

  private releaseActiveTurn(active: ActiveAntigravityTurn): void {
    this.activeTurns.delete(active.runId);
    this.processQueues.delete(active.runId);
  }

  private async recoverFailedTurn(
    active: ActiveAntigravityTurn,
    reason: string,
    processExitConfirmed: boolean,
    terminalCause: unknown
  ): Promise<void> {
    active.cleanupStarted = true;
    active.processEventsFenced = true;
    active.processExitConfirmed ||= processExitConfirmed;
    try {
      await this.recordRuntimeLoss(active, reason, processExitConfirmed);
    } catch (publicationCause) {
      const failure = new AggregateError(
        [terminalCause, publicationCause],
        `Antigravity recovery publication failed after provider work stopped. ${redactProcessDiagnostic(
          publicationCause instanceof Error
            ? publicationCause.message
            : String(publicationCause),
          this.sensitiveValues
        )}`
      );
      active.rejectTerminal(
        this.latchRuntimeSafetyFence(failure, 'RECOVERY_PUBLICATION_FAILED')
      );
      return;
    }
    this.releaseActiveTurn(active);
    active.rejectTerminal(terminalCause);
  }

  private async recordRuntimeLoss(
    active: ActiveAntigravityTurn,
    reason: string,
    processExitConfirmed: boolean
  ): Promise<void> {
    const run = await this.requireRun(active.runId);
    const server = await this.store.getAgentServer(active.serverId);
    await this.store.updateAgentSession(active.sessionId, {
      status: 'IDLE',
      materialized: true
    });
    if (server && !['EXITED', 'FAILED', 'LOST'].includes(server.status)) {
      await this.store.updateAgentServer(active.serverId, {
        status: 'LOST',
        disconnectedAt: new Date().toISOString(),
        ...(processExitConfirmed ? { exitedAt: new Date().toISOString() } : {}),
        exitReason: reason
      });
    }
    if (ACTIVE_RUN_STATUSES.includes(run.status)) {
      await this.store.appendEvent(
        createDomainEvent({
          type: 'AGENT_RUNTIME_LOST',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId: active.serverId,
          source: 'process',
          payload: { reason, automaticReplay: false }
        })
      );
    }
    if (needsAntigravityRecovery(run)) {
      await this.store.appendEvent(
        createDomainEvent({
          type: 'AGENT_RUNTIME_RECONCILED',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          serverInstanceId: active.serverId,
          source: 'process',
          payload: {
            status: 'RECOVERY_REQUIRED',
            recoveryState: 'REQUIRES_USER_ACTION',
            terminal: false
          }
        })
      );
    }
  }

  private handleProcessQueueFailure(
    active: ActiveAntigravityTurn,
    cause: unknown
  ): Promise<void> {
    if (active.queueFailure) return active.queueFailure;
    const failure = (async () => {
      // Unblock startTurn immediately. In-memory ownership remains intact until
      // cancellation and recovery publication finish, so a rejected startup
      // cannot leave an untracked child process behind.
      active.cleanupStarted = true;
      active.processEventsFenced = true;
      active.rejectStartup?.(cause);
      let cancellationFailure: unknown;
      if (!active.processExitConfirmed) {
        try {
          await active.process.cancel();
          active.processExitConfirmed = true;
        } catch (cancelCause) {
          cancellationFailure = cancelCause;
        }
      }
      const terminalCause = cancellationFailure
        ? this.latchRuntimeSafetyFence(cancellationFailure)
        : cause;
      const reason = cancellationFailure
        ? `Antigravity process termination is unconfirmed. ${
            terminalCause instanceof Error ? terminalCause.message : String(terminalCause)
          }`
        : finalizationFailureReason(cause, this.sensitiveValues);
      await this.recoverFailedTurn(
        active,
        reason,
        !cancellationFailure && active.processExitConfirmed,
        terminalCause
      );
    })();
    active.queueFailure = failure.catch(() => undefined);
    return active.queueFailure;
  }

  private enqueueProcessEvent(
    active: ActiveAntigravityTurn,
    operation: () => Promise<void>
  ): Promise<void> {
    const previous = this.processQueues.get(active.runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.processQueues.set(active.runId, next);
    return next;
  }

  private ownsProcessEvents(active: ActiveAntigravityTurn): boolean {
    return (
      !active.processEventsFenced &&
      this.activeTurns.get(active.runId) === active
    );
  }

  private async retireAfterUnconfirmedTermination(
    active: ActiveAntigravityTurn,
    fence: Error
  ): Promise<void> {
    // Fence callbacks synchronously before any recovery persistence yields.
    // The OS process may still exist, but it can no longer mutate Task Monki
    // state or be confused with a replacement turn.
    active.cleanupStarted = true;
    active.processEventsFenced = true;
    active.rejectStartup?.(fence);
    await this.recoverFailedTurn(
      active,
      `Antigravity process termination is unconfirmed. ${fence.message}`,
      false,
      fence
    );
  }

  private latchRuntimeSafetyFence(
    cause: unknown,
    reason: AntigravitySafetyFenceReason = 'PROCESS_TERMINATION_UNCONFIRMED'
  ): Error {
    if (!this.runtimeSafetyFence) {
      const detail = redactProcessDiagnostic(
        cause instanceof Error ? cause.message : String(cause),
        this.sensitiveValues
      );
      const publicationFailed = reason === 'RECOVERY_PUBLICATION_FAILED';
      this.runtimeSafetyFence = new Error(
        `Antigravity is safety-fenced until Task Monki restarts because ${
          publicationFailed
            ? 'recovery state could not be persisted'
            : 'process termination is unconfirmed'
        }. ${detail}`
      );
      this.initialized = false;
      this.preflightState = {
        runtime: this.descriptor,
        readiness: createRuntimeReadiness(
          'FAILED',
          publicationFailed
            ? 'Antigravity recovery state could not be persisted.'
            : 'Antigravity process termination is unconfirmed.',
          {
            diagnostics: [
              errorDiagnostic(
                reason,
                publicationFailed ? 'HEALTH' : 'SECURITY',
                'Antigravity cannot start another process until Task Monki restarts.',
                detail
              )
            ]
          }
        ),
        capabilities: antigravityCapabilities()
      };
      this.emitRuntimeUpdate();
    }
    return this.runtimeSafetyFence;
  }

  private assertRuntimeSafe(): void {
    if (this.runtimeSafetyFence) throw this.runtimeSafetyFence;
  }

  private queueCancellationDecision(
    active: ActiveAntigravityTurn,
    reason: string
  ): Promise<void> {
    return this.enqueueProcessEvent(active, async () => {
      if (active.cleanupStarted) {
        throw new Error('The Antigravity turn is no longer active.');
      }
      const run = await this.requireRun(active.runId);
      if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
        throw new Error('The Antigravity turn is no longer active.');
      }
      if (run.status !== 'INTERRUPTING') {
        await this.store.updateRun(run.id, {
          status: 'INTERRUPTING',
          lastEventAt: new Date().toISOString()
        });
      }
      if (active.cleanupStarted) {
        throw new Error('The Antigravity turn is no longer active.');
      }
      active.cancelReason = reason;
      await active.process.cancel();
      active.processExitConfirmed = true;
    });
  }

  private async recoverPersistedRuntimeLosses(): Promise<void> {
    const snapshot = await this.store.snapshot();
    for (const server of snapshot.agentServers.filter(
      (candidate) =>
        candidate.runtimeId === this.descriptor.id &&
        ['STARTING', 'READY', 'RUNNING', 'DEGRADED', 'STOPPING'].includes(
          candidate.status
        )
    )) {
      await this.store.updateAgentServer(server.id, {
        status: 'LOST',
        disconnectedAt: new Date().toISOString(),
        exitedAt: new Date().toISOString(),
        exitReason:
          'Task Monki restarted without ownership of the prior turn-scoped Antigravity process.'
      });
    }
    for (const session of snapshot.agentSessions.filter(
      (candidate) =>
        candidate.runtimeId === this.descriptor.id && candidate.status === 'ACTIVE'
    )) {
      await this.store.updateAgentSession(session.id, {
        status: 'IDLE',
        materialized: true
      });
    }
    await this.reconcile();
  }

  private async requireSession(sessionId: string): Promise<AgentSessionRecord> {
    const session = await this.store.getAgentSession(sessionId);
    if (!session) throw new Error(`Agent session not found: ${sessionId}`);
    return session;
  }

  private async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Agent run not found: ${runId}`);
    return run;
  }

  private assertSessionOwnership(session: AgentSessionRecord): void {
    if (session.runtimeId !== this.descriptor.id || session.ownership !== 'TASK_MONKI') {
      throw new Error(`Agent session ${session.id} is not owned by Antigravity.`);
    }
  }

  private async recordRunActivity(
    run: RunRecord,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_ACTIVITY_RECEIVED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: run.serverInstanceId,
        source: 'provider',
        payload: { eventType, ...payload }
      })
    );
    this.appEvents.emit({
      type: 'run.activity',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      payload: { eventType, ...payload },
      at: new Date().toISOString()
    });
  }

  private emitRuntimeUpdate(): void {
    this.appEvents.emit({
      type: 'runtime.updated',
      taskId: `runtime:${this.descriptor.id}`,
      payload: {
        preflight: structuredClone(this.preflightState),
        models: structuredClone(this.models)
      },
      at: new Date().toISOString()
    });
  }
}

function createActiveTurn(
  runId: string,
  sessionId: string,
  serverId: string,
  correlationId: string,
  process: SupervisedProcess
): ActiveAntigravityTurn {
  let resolveTerminal!: () => void;
  let rejectTerminal!: (error: unknown) => void;
  const terminal = new Promise<void>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  void terminal.catch(() => undefined);
  return {
    runId,
    sessionId,
    serverId,
    correlationId,
    process,
    stdoutStream: createBufferedOutputStream(),
    stderrStream: createBufferedOutputStream(),
    stdout: '',
    stdoutBytes: 0,
    stderr: '',
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    cleanupStarted: false,
    processEventsFenced: false,
    processExitConfirmed: false,
    terminal,
    resolveTerminal,
    rejectTerminal
  };
}

function createBufferedOutputStream(): BufferedAntigravityStream {
  return {
    decoder: new StringDecoder('utf8'),
    pendingLine: '',
    pendingLineBytes: 0,
    discardingOversizedLine: false,
    flushed: false
  };
}

function outputStream(
  active: ActiveAntigravityTurn,
  source: 'stdout' | 'stderr'
): BufferedAntigravityStream {
  return source === 'stdout' ? active.stdoutStream : active.stderrStream;
}

function streamTruncated(
  active: ActiveAntigravityTurn,
  source: 'stdout' | 'stderr'
): boolean {
  return source === 'stdout' ? active.stdoutTruncated : active.stderrTruncated;
}

function oversizedLineMarker(source: 'stdout' | 'stderr'): string {
  return `[Antigravity ${source} line discarded at the 64 KiB safety limit.]\n`;
}

function antigravityTurnArgv(input: StartAgentTurn, model: string): string[] {
  const argv = [
    '--print',
    input.prompt,
    '--model',
    model,
    '--new-project',
    '--sandbox',
    '--print-timeout',
    PRINT_TIMEOUT
  ];
  if (input.mode === 'ANALYSIS') {
    argv.push('--mode', 'plan');
  } else {
    argv.push('--mode', 'accept-edits');
  }
  return argv;
}

function supportedMode(mode: StartAgentTurn['mode']): boolean {
  return ['ANALYSIS', 'IMPLEMENTATION', 'FOLLOW_UP', 'RETRY'].includes(mode);
}

function needsAntigravityRecovery(run: RunRecord): boolean {
  return (
    ACTIVE_RUN_STATUSES.includes(run.status) ||
    run.status === 'LOST' ||
    (run.status === 'RECOVERY_REQUIRED' &&
      run.recoveryState !== 'REQUIRES_USER_ACTION')
  );
}

function finalizationFailureReason(
  cause: unknown,
  sensitiveValues: readonly string[]
): string {
  return `Antigravity exited, but Task Monki could not persist its terminal state: ${redactProcessDiagnostic(
    cause instanceof Error ? cause.message : String(cause),
    sensitiveValues
  )}`;
}

function assertNoAttachments(
  attachments: readonly Pick<AgentTurnAttachment, 'kind'>[]
): void {
  if (attachments.length > 0) {
    throw new Error('Antigravity print mode does not support managed attachments.');
  }
}

function assertAntigravitySettings(settings: AgentExecutionSettings): void {
  if (settings.runtimeId && settings.runtimeId !== ANTIGRAVITY_RUNTIME_ID) {
    throw new Error(`Antigravity cannot execute settings for ${settings.runtimeId}.`);
  }
  if (settings.reasoningEffort) {
    throw new Error(
      'Antigravity reasoning variants must be selected by their exact model label.'
    );
  }
  if (settings.serviceTier) {
    throw new Error('Antigravity does not expose a service-tier selector.');
  }
  if (settings.sandbox && settings.sandbox !== 'WORKSPACE_WRITE') {
    throw new Error('Antigravity requires its sandboxed project execution policy.');
  }
  if (settings.networkAccess === false) {
    throw new Error('Antigravity requires provider network access.');
  }
  if (
    settings.approvalPolicy &&
    settings.approvalPolicy !== 'provider-terminal-policy'
  ) {
    throw new Error('Antigravity terminal permissions remain provider-controlled.');
  }
  if (settings.approvalsReviewer && settings.approvalsReviewer !== 'user') {
    throw new Error(
      'Antigravity print mode cannot delegate structured approvals to an automatic reviewer.'
    );
  }
}

async function assertCanonicalWorktree(left: string, right: string): Promise<void> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalWorktree(left),
    canonicalWorktree(right)
  ]);
  if (canonicalLeft !== canonicalRight) {
    throw new Error(
      `Antigravity session worktree ${left} does not match its Task Monki worktree ${right}.`
    );
  }
}

async function canonicalWorktree(worktreePath: string): Promise<string> {
  const canonical = await fs.realpath(worktreePath);
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) {
    throw new Error(`Antigravity worktree is not a directory: ${worktreePath}`);
  }
  return canonical;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let rest = value;
  while (rest) {
    const part = truncateUtf8(rest, maxBytes);
    if (!part) break;
    parts.push(part);
    rest = rest.slice(part.length);
  }
  return parts;
}

function failureReason(
  active: ActiveAntigravityTurn,
  exitCode: number | null,
  signal: NodeJS.Signals | null
): string {
  const diagnostic = truncateUtf8(active.stderr.trim(), 8 * 1024);
  const status = `Antigravity exited with code ${String(exitCode)}${signal ? ` (${signal})` : ''}.`;
  return diagnostic ? `${status} ${diagnostic}` : status;
}

function formatFinalArtifact(
  run: RunRecord,
  status: RunRecord['status'],
  stdout: string,
  terminalReason: string | undefined,
  truncated: boolean
): string {
  return [
    '# Antigravity turn result',
    '',
    `Status: ${status}`,
    `Model: ${run.observedSettings?.model ?? run.requestedSettings.model ?? 'unknown'}`,
    'Integration: documented turn-scoped CLI print mode',
    '',
    stdout.trim() || terminalReason || 'Antigravity returned no assistant text.',
    ...(truncated ? ['', '[Assistant output was truncated at 1 MiB.]'] : [])
  ].join('\n');
}

function antigravityFailurePreflight(
  cause: unknown,
  sensitiveValues: readonly string[]
): AgentPreflight {
  const message = commandErrorMessage(cause, sensitiveValues);
  const resolution = cause instanceof AntigravityRuntimeResolutionError;
  const authentication =
    !resolution && /(?:sign[ -]?in|log[ -]?in|authenticat|credential|unauthori[sz]ed)/iu.test(message);
  const status = resolution
    ? cause.code === 'ANTIGRAVITY_NOT_FOUND'
      ? 'NOT_INSTALLED'
      : 'INCOMPATIBLE'
    : authentication
      ? 'AUTHENTICATION_REQUIRED'
      : 'FAILED';
  return {
    runtime: ANTIGRAVITY_RUNTIME_DESCRIPTOR,
    readiness: createRuntimeReadiness(
      status,
      message,
      {
        checks: {
          discovery: resolution && cause.code === 'ANTIGRAVITY_NOT_FOUND' ? 'NOT_FOUND' : 'FOUND',
          compatibility: resolution ? 'INCOMPATIBLE' : 'COMPATIBLE',
          initialization: 'FAILED',
          authentication: authentication ? 'REQUIRED' : 'UNKNOWN',
          modelCatalog: resolution ? 'UNKNOWN' : 'FAILED'
        },
        diagnostics: [
          errorDiagnostic(
            resolution ? cause.code : authentication ? 'ANTIGRAVITY_AUTH_REQUIRED' : 'ANTIGRAVITY_INITIALIZATION_FAILED',
            resolution ? 'DISCOVERY' : authentication ? 'AUTHENTICATION' : 'MODEL_CATALOG',
            message
          )
        ],
        nextAction: authentication
          ? { kind: 'AUTHENTICATE', label: 'Sign in with Antigravity' }
          : resolution && cause.code === 'ANTIGRAVITY_NOT_FOUND'
            ? { kind: 'INSTALL', label: 'Install Antigravity', command: 'agy install' }
            : { kind: 'RETRY', label: 'Retry Antigravity discovery' }
      }
    ),
    capabilities: antigravityCapabilities()
  };
}

function commandErrorMessage(
  cause: unknown,
  sensitiveValues: readonly string[] = []
): string {
  if (!cause || typeof cause !== 'object') {
    return truncateUtf8(
      redactProcessDiagnostic(String(cause), sensitiveValues),
      MODEL_CATALOG_DIAGNOSTIC_MAX_BYTES
    );
  }
  const record = cause as { message?: unknown; stdout?: unknown; stderr?: unknown };
  const diagnostic = [record.message, record.stdout, record.stderr]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  return truncateUtf8(
    redactProcessDiagnostic(diagnostic, sensitiveValues),
    MODEL_CATALOG_DIAGNOSTIC_MAX_BYTES
  );
}

function discoveredAntigravityPreflight(): AgentPreflight {
  return {
    runtime: ANTIGRAVITY_RUNTIME_DESCRIPTOR,
    readiness: createRuntimeReadiness(
      'DISCOVERED',
      'The documented Antigravity CLI print contract is available.',
      {
        checks: {
          discovery: 'FOUND',
          compatibility: 'COMPATIBLE',
          authentication: 'UNKNOWN',
          modelCatalog: 'UNKNOWN'
        }
      }
    ),
    capabilities: antigravityCapabilities()
  };
}

function isRetryableInitializationFailure(preflight: AgentPreflight): boolean {
  return (
    preflight.readiness.status === 'AUTHENTICATION_REQUIRED' ||
    preflight.readiness.status === 'FAILED'
  );
}

function commandTimedOut(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const record = cause as { code?: unknown; killed?: unknown; signal?: unknown };
  return (
    record.code === 'ETIMEDOUT' ||
    (record.killed === true && typeof record.signal === 'string')
  );
}

function formatDuration(milliseconds: number): string {
  return milliseconds % 1000 === 0
    ? `${String(milliseconds / 1000)}-second`
    : `${String(milliseconds)}-millisecond`;
}

function normalizeExecutable(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
