import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentModel, AgentRuntimeCatalog } from '../shared/agent';
import type {
  CancelRunRequest,
  CreateTaskRequest,
  GitSnapshotRecord,
  RefreshEvidenceRequest,
  RunRecord,
  StartRunRequest,
  Task,
  TaskSnapshot
} from '../shared/contracts';
import { createEmptyState } from '../core/projection/reducer';
import { git } from '../core/git/gitCli';
import {
  discoverProviderSmokeTargets,
  parseProviderSmokeArguments,
  providerSmokeSucceeded,
  runProviderSmoke,
  selectLowestReasoningEffort,
  type ProviderSmokeDependencies,
  type ProviderSmokeOptions,
  type ProviderSmokeService
} from './providerSmoke';

describe('parseProviderSmokeArguments', () => {
  it('requires explicit throwaway and provider-usage confirmations', () => {
    expect(() =>
      parseProviderSmokeArguments(['--repository', '/tmp/smoke'])
    ).toThrow('--confirm-throwaway');
    expect(() =>
      parseProviderSmokeArguments([
        '--repository',
        '/tmp/smoke',
        '--confirm-throwaway'
      ])
    ).toThrow('--confirm-provider-usage');
  });

  it('parses repeatable selectors and a bounded timeout', () => {
    expect(
      parseProviderSmokeArguments([
        '--repository',
        '/tmp/smoke',
        '--runtime',
        'codex',
        '--runtime',
        'codex',
        '--model',
        'codex:openai/gpt-test',
        '--timeout-seconds',
        '45',
        '--confirm-throwaway',
        '--confirm-provider-usage'
      ])
    ).toMatchObject({
      repositoryPath: '/tmp/smoke',
      runtimeIds: ['codex'],
      modelIds: ['codex:openai/gpt-test'],
      timeoutMs: 45_000,
      confirmThrowaway: true,
      confirmProviderUsage: true
    });
  });

  it('does not require mutation confirmations to show help', () => {
    expect(parseProviderSmokeArguments(['--help']).help).toBe(true);
  });
});

describe('selectLowestReasoningEffort', () => {
  it('selects the least expensive recognized effort independent of catalog order', () => {
    expect(
      selectLowestReasoningEffort(
        model('codex:openai/gpt-test', ['high', 'low', 'minimal', 'medium'], 'high')
      )
    ).toBe('minimal');
  });

  it('preserves the provider default when effort names have provider-native semantics', () => {
    expect(
      selectLowestReasoningEffort(
        model('opencode:provider/model', ['deliberate', 'fast'], 'fast')
      )
    ).toBe('fast');
  });

  it('does not guess the cost ordering of provider-native efforts', () => {
    expect(
      selectLowestReasoningEffort(
        model('opencode:provider/model', ['deliberate', 'fast'])
      )
    ).toBeUndefined();
    expect(
      selectLowestReasoningEffort(model('opencode:provider/model', ['fast', 'high']))
    ).toBeUndefined();
  });

  it('omits effort when the runtime does not advertise choices', () => {
    expect(selectLowestReasoningEffort(model('grok-acp:xai/grok-build'))).toBeUndefined();
  });
});

describe('discoverProviderSmokeTargets', () => {
  it('includes visible models from startable runtimes and applies exact selectors', () => {
    const codexModel = model('codex:openai/gpt-test', ['high', 'low'], 'high');
    const hiddenModel = { ...model('codex:openai/hidden'), hidden: true };
    const unavailableModel = model('offline:vendor/model');
    const catalog = catalogWith([
      runtime('codex', 'READY', true, [codexModel, hiddenModel]),
      runtime('offline', 'AUTHENTICATION_REQUIRED', false, [unavailableModel])
    ]);

    expect(
      discoverProviderSmokeTargets(catalog, {
        runtimeIds: ['codex'],
        modelIds: [codexModel.id]
      })
    ).toEqual([
      expect.objectContaining({
        runtimeId: 'codex',
        runtimeStatus: 'READY',
        model: codexModel,
        reasoningEffort: 'low'
      })
    ]);
  });

  it('does not enqueue a model that already has a result', () => {
    const candidate = model('grok-acp:xai/grok-build');
    const catalog = catalogWith([runtime('grok-acp', 'DISCOVERED', true, [candidate])]);
    expect(
      discoverProviderSmokeTargets(
        catalog,
        { runtimeIds: [], modelIds: [] },
        new Set([candidate.id])
      )
    ).toEqual([]);
  });
});

describe('runProviderSmoke', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((candidate) =>
        fs.rm(candidate, { recursive: true, force: true })
      )
    );
  });

  it('executes dynamically discovered models once and requests the lowest known effort', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const first = model('codex:openai/first', ['high', 'low'], 'high');
    const second = model('codex:openai/second');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [
        catalogWith([runtime('codex', 'READY', true, [first])]),
        catalogWith([runtime('codex', 'READY', true, [first, second])])
      ]
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(service.startedModels).toEqual([
      { model: 'first', reasoningEffort: 'low' },
      { model: 'second', reasoningEffort: undefined }
    ]);
    expect(report.results.map((result) => result.modelId)).toEqual([
      first.id,
      second.id
    ]);
    expect(report.authoritative).toBe(true);
    expect(providerSmokeSucceeded(report)).toBe(true);
  });

  it('marks successful but unattested model selection as UNATTESTED', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('codex:openai/unattested');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [candidate])])],
      observation: 'none'
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.results[0]).toMatchObject({
      verdict: 'UNATTESTED',
      selectionAttestation: 'REQUESTED_ONLY'
    });
    expect(report.authoritative).toBe(false);
  });

  it('reports an exact adapter resolution without calling it provider-confirmed', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('antigravity:google/Gemini Low');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('antigravity', 'READY', true, [candidate])])],
      observation: 'adapter'
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.results[0]).toMatchObject({
      verdict: 'PASSED',
      selectionAttestation: 'ADAPTER_RESOLVED',
      observationSource: 'TASK_MONKI_RESOLUTION'
    });
  });

  it('prefers genuine provider evidence over a later outbound adapter resolution', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model(
      'opencode:anthropic/claude-test',
      ['high', 'low'],
      'high'
    );
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('opencode', 'READY', true, [candidate])])],
      observation: 'provider-then-adapter'
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.results[0]).toMatchObject({
      verdict: 'PASSED',
      selectionAttestation: 'PROVIDER_CONFIRMED',
      observationSource: 'THREAD_SETTINGS_NOTIFICATION',
      observedModelProvider: 'anthropic',
      observedModel: 'claude-test',
      observedReasoningEffort: 'low'
    });
  });

  it('reports acknowledged ACP post-configuration selection as adapter-resolved', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('grok-acp:xai/grok-build');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('grok-acp', 'READY', true, [candidate])])],
      observation: 'acp-post-configuration'
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.results[0]).toMatchObject({
      verdict: 'PASSED',
      selectionAttestation: 'ADAPTER_RESOLVED',
      observationSource: 'TASK_MONKI_RESOLUTION',
      observedModelProvider: 'xai',
      observedModel: 'grok-build'
    });
  });

  it('fails a terminal run when any interaction record was created', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('codex:openai/interactive');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [candidate])])],
      interactionStatus: 'RESOLVED'
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.results[0]?.verdict).toBe('FAILED');
    expect(report.results[0]?.error).toContain('interaction request');
  });

  it('rejects a final message that only mentions the smoke sentinel', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('codex:openai/verbose-response');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [candidate])])],
      finalMessage:
        'The requested response was "TASK_MONKI_PROVIDER_SMOKE_OK".'
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.results[0]).toMatchObject({
      verdict: 'FAILED',
      receivedSentinel: false
    });
    expect(report.results[0]?.error).toContain('did not return');
  });

  it('uses the exact explicit post-run Git snapshot', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('codex:openai/git-evidence');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [candidate])])],
      gitStatus: 'DIRTY',
      retainDifferentStoredGitSnapshot: true
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.results[0]).toMatchObject({
      verdict: 'FAILED',
      gitStatus: 'DIRTY',
      gitSnapshotId: 'git-1'
    });
  });

  it('rejects a clean task worktree whose HEAD moved beyond its base', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('codex:openai/committed-edit');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [candidate])])],
      committedTaskChange: true
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.results[0]).toMatchObject({
      verdict: 'FAILED',
      gitStatus: 'CLEAN'
    });
    expect(report.results[0]?.error).toContain(
      'worktree no longer matches its base commit'
    );
  });

  it('bounds a hung start lifecycle, cancels its discovered run, and writes a report', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('codex:openai/hung');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [candidate])])],
      hangStart: true
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths, {
      timeoutMs: 20
    });

    expect(service.cancelCount).toBeGreaterThan(0);
    expect(report.completionStatus).toBe('STOPPED_EARLY');
    expect(report.results[0]?.verdict).toBe('FAILED');
    await expect(fs.readFile(path.join(report.stateRoot, 'report.json'), 'utf8')).resolves.toContain(
      'provider lifecycle did not settle'
    );
  });

  it('waits through INTERRUPTING within the cancellation budget and continues the matrix', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const first = model('codex:openai/first-timeout');
    const second = model('codex:openai/second-success');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [first, second])])],
      timedOutRunCount: 1,
      cancelTerminalDelayMs: 10
    });

    const report = await runHarness(
      repositoryPath,
      service,
      cleanupPaths,
      { timeoutMs: 20 },
      { cancelTimeoutMs: 75 }
    );

    expect(service.cancellationTransitions).toEqual([
      { runId: 'run-1', status: 'INTERRUPTING' },
      { runId: 'run-1', status: 'INTERRUPTED' }
    ]);
    expect(service.startedModels.map(({ model }) => model)).toEqual([
      'first-timeout',
      'second-success'
    ]);
    expect(report.results).toMatchObject([
      { modelId: first.id, verdict: 'FAILED', runStatus: 'INTERRUPTED' },
      { modelId: second.id, verdict: 'PASSED', runStatus: 'COMPLETED' }
    ]);
    expect(report.completionStatus).toBe('COMPLETED');
  });

  it('bounds a cancellation that never settles and stops before the next model', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const first = model('codex:openai/first-hung-cancel');
    const second = model('codex:openai/second-not-reached');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [first, second])])],
      timedOutRunCount: 1,
      hangCancel: true
    });
    const startedAt = Date.now();

    const report = await runHarness(
      repositoryPath,
      service,
      cleanupPaths,
      { timeoutMs: 20 },
      { cancelTimeoutMs: 25 }
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(service.startedModels.map(({ model }) => model)).toEqual([
      'first-hung-cancel'
    ]);
    expect(report.completionStatus).toBe('STOPPED_EARLY');
    expect(report.results[0]).toMatchObject({
      modelId: first.id,
      verdict: 'FAILED',
      runStatus: 'INTERRUPTING'
    });
    expect(report.results[0]?.error).toContain(
      'Cancellation did not settle and reach a terminal run state'
    );
    expect(report.selection.notExecutedModelIds).toEqual([second.id]);
  });

  it('stops the matrix when cancellation ends in an uncontained recovery state', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const first = model('codex:openai/ambiguous-cancel');
    const second = model('codex:openai/not-started');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [first, second])])],
      timedOutRunCount: 1,
      cancelTerminalStatus: 'RECOVERY_REQUIRED'
    });

    const report = await runHarness(
      repositoryPath,
      service,
      cleanupPaths,
      { timeoutMs: 20 },
      { cancelTimeoutMs: 75 }
    );

    expect(service.startedModels.map(({ model }) => model)).toEqual([
      'ambiguous-cancel'
    ]);
    expect(report.completionStatus).toBe('STOPPED_EARLY');
    expect(report.results[0]).toMatchObject({
      verdict: 'FAILED',
      runStatus: 'RECOVERY_REQUIRED'
    });
    expect(report.results[0]?.error).toContain(
      'does not prove that provider execution is contained'
    );
  });

  it('writes an auditable non-success report for selected unavailable targets', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('offline:vendor/model');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [
        catalogWith([
          runtime('offline', 'AUTHENTICATION_REQUIRED', false, [candidate])
        ])
      ]
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths, {
      runtimeIds: ['offline'],
      modelIds: [candidate.id]
    });

    expect(report.selection.unavailableRuntimeIds).toEqual(['offline']);
    expect(report.selection.unavailableModelIds).toEqual([candidate.id]);
    expect(report.results).toEqual([]);
    expect(providerSmokeSucceeded(report)).toBe(false);
    await expect(fs.stat(path.join(report.stateRoot, 'report.json'))).resolves.toBeTruthy();
  });

  it('retains an unmatched late-model selector instead of rejecting before reporting', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const available = model('grok-acp:xai/grok-build');
    const requested = 'grok-acp:xai/not-discovered';
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [
        catalogWith([runtime('grok-acp', 'READY', true, [available])])
      ]
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths, {
      runtimeIds: ['grok-acp'],
      modelIds: [requested]
    });

    expect(report.selection.unmatchedModelIds).toEqual([requested]);
    expect(report.results).toEqual([]);
    expect(providerSmokeSucceeded(report)).toBe(false);
  });

  it('retains catalog failures in a report instead of exiting before evidence is written', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [new Error('catalog exploded')]
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.completionStatus).toBe('STOPPED_EARLY');
    expect(report.errors.join(' ')).toContain('catalog exploded');
    await expect(fs.stat(path.join(report.stateRoot, 'report.json'))).resolves.toBeTruthy();
  });

  it('writes queued models as not executed when the discovery safety limit stops the pass', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const first = model('codex:openai/first');
    const second = model('codex:openai/second');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [first, second])])]
    });

    const report = await runHarness(
      repositoryPath,
      service,
      cleanupPaths,
      {},
      { maxModels: 1 }
    );

    expect(report.results).toHaveLength(1);
    expect(report.selection.notExecutedModelIds).toHaveLength(1);
    expect(report.errors.join(' ')).toContain('1-model safety limit');
    expect(providerSmokeSucceeded(report)).toBe(false);
  });

  it('detects a clean original repository whose HEAD changed', async () => {
    const repositoryPath = await createThrowawayRepository(cleanupPaths);
    const candidate = model('codex:openai/head-change');
    const service = new FakeProviderSmokeService(repositoryPath, {
      catalogs: [catalogWith([runtime('codex', 'READY', true, [candidate])])],
      onStart: async () => {
        await fs.writeFile(path.join(repositoryPath, 'provider.txt'), 'changed\n');
        await git(repositoryPath, ['add', 'provider.txt']);
        await git(repositoryPath, ['commit', '-m', 'Provider changed source checkout']);
      }
    });

    const report = await runHarness(repositoryPath, service, cleanupPaths);

    expect(report.repositoryClean).toBe(true);
    expect(report.repositoryIdentityUnchanged).toBe(false);
    expect(report.results[0]?.verdict).toBe('FAILED');
    expect(providerSmokeSucceeded(report)).toBe(false);
  });
});

function model(
  id: string,
  supportedReasoningEfforts: string[] = [],
  defaultReasoningEffort?: string
): AgentModel {
  const colon = id.indexOf(':');
  const slash = id.indexOf('/');
  const runtimeId = id.slice(0, colon);
  const modelProvider = id.slice(colon + 1, slash);
  const modelId = id.slice(slash + 1);
  return {
    id,
    runtimeId,
    modelProvider,
    model: modelId,
    displayName: modelId,
    hidden: false,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    serviceTiers: [],
    inputModalities: ['text'],
    isDefault: false
  };
}

function runtime(
  runtimeId: string,
  status: string,
  canStart: boolean,
  models: AgentModel[]
) {
  return {
    preflight: {
      runtime: { id: runtimeId, displayName: runtimeId },
      readiness: {
        status,
        canStart,
        summary: status,
        detail: canStart ? `${runtimeId} is available.` : `${runtimeId} is unavailable.`
      }
    },
    models,
    refreshedAt: '2026-07-14T00:00:00.000Z'
  };
}

function catalogWith(runtimes: ReturnType<typeof runtime>[]): AgentRuntimeCatalog {
  return {
    runtimes,
    models: runtimes.flatMap((candidate) => candidate.models),
    defaultRuntimeId: 'codex',
    refreshedAt: '2026-07-14T00:00:00.000Z'
  } as AgentRuntimeCatalog;
}

interface FakeProviderBehavior {
  catalogs: Array<AgentRuntimeCatalog | Error>;
  finalMessage?: string;
  observation?:
    | 'provider'
    | 'adapter'
    | 'provider-then-adapter'
    | 'acp-post-configuration'
    | 'none';
  interactionStatus?: 'RESOLVED';
  gitStatus?: 'CLEAN' | 'DIRTY';
  committedTaskChange?: boolean;
  retainDifferentStoredGitSnapshot?: boolean;
  hangStart?: boolean;
  timedOutRunCount?: number;
  cancelTerminalDelayMs?: number;
  cancelTerminalStatus?: 'INTERRUPTED' | 'RECOVERY_REQUIRED' | 'LOST';
  hangCancel?: boolean;
  onStart?: () => Promise<void>;
}

class FakeProviderSmokeService implements ProviderSmokeService {
  private readonly snapshot: TaskSnapshot = createEmptyState();
  private catalogIndex = 0;
  private taskSequence = 0;
  private runSequence = 0;
  cancelCount = 0;
  readonly cancellationTransitions: Array<{
    runId: string;
    status: RunRecord['status'];
  }> = [];
  readonly startedModels: Array<{ model?: string; reasoningEffort?: string }> = [];

  constructor(
    private readonly repositoryPath: string,
    private readonly behavior: FakeProviderBehavior
  ) {}

  async init(): Promise<void> {}

  async getAgentRuntimeCatalog(): Promise<AgentRuntimeCatalog> {
    const index = Math.min(this.catalogIndex, this.behavior.catalogs.length - 1);
    this.catalogIndex += 1;
    const catalog = this.behavior.catalogs[index];
    if (catalog instanceof Error) throw catalog;
    if (!catalog) throw new Error('Fake catalog is missing.');
    return structuredClone(catalog);
  }

  getDefaultRepositoryPath(): string {
    return this.repositoryPath;
  }

  async createTask(input: CreateTaskRequest): Promise<Task> {
    const now = new Date().toISOString();
    const task = {
      id: `task-${++this.taskSequence}`,
      runtimeId: input.runtimeId!,
      title: input.title,
      prompt: input.prompt,
      repositoryPath: input.repositoryPath,
      agentSettings: input.agentSettings!,
      createdAt: now,
      updatedAt: now
    } as Task;
    this.snapshot.tasks.push(task);
    return structuredClone(task);
  }

  async startRun(input: StartRunRequest): Promise<RunRecord> {
    const task = this.snapshot.tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) throw new Error(`Fake task is missing: ${input.taskId}`);
    const now = new Date().toISOString();
    const timesOut = this.runSequence < (this.behavior.timedOutRunCount ?? 0);
    const run = {
      id: `run-${++this.runSequence}`,
      runtimeId: task.runtimeId,
      taskId: task.id,
      iterationId: `iteration-${task.id}`,
      worktreeId: `worktree-${task.id}`,
      sessionId: `session-${task.id}`,
      mode: input.mode ?? 'IMPLEMENTATION',
      origin: 'TASK_MONKI',
      status: this.behavior.hangStart || timesOut ? 'RUNNING' : 'COMPLETED',
      recoveryState: 'NONE',
      requestedSettings: task.agentSettings,
      promptArtifactId: `prompt-${task.id}`,
      outputArtifactId: `output-${task.id}`,
      diagnosticArtifactId: `diagnostic-${task.id}`,
      startedAt: now,
      endedAt: this.behavior.hangStart || timesOut ? undefined : now,
      eventCount: 1,
      finalMessage: this.behavior.hangStart || timesOut
        ? undefined
        : (this.behavior.finalMessage ?? 'TASK_MONKI_PROVIDER_SMOKE_OK')
    } as RunRecord;
    this.snapshot.runs.push(run);
    this.startedModels.push({
      model: task.agentSettings.model,
      reasoningEffort: task.agentSettings.reasoningEffort
    });
    if ((this.behavior.observation ?? 'provider') !== 'none') {
      const acpPostConfiguration =
        this.behavior.observation === 'acp-post-configuration';
      this.snapshot.agentSettingsObservations.push({
        id: `observation-${run.id}`,
        taskId: task.id,
        iterationId: run.iterationId,
        sessionId: run.sessionId,
        runId: run.id,
        runtimeId: run.runtimeId,
        source:
          this.behavior.observation === 'adapter'
            ? ('TASK_MONKI_RESOLUTION' as never)
            : acpPostConfiguration
              ? 'THREAD_START_RESPONSE'
              : 'THREAD_SETTINGS_NOTIFICATION',
        settings: acpPostConfiguration
          ? { ...task.agentSettings, model: 'grok-composer-2.5-fast' }
          : task.agentSettings,
        ...(acpPostConfiguration
          ? { rawMessage: protocolReference(run, 2, now) }
          : {}),
        observedAt: now
      });
      if (
        this.behavior.observation === 'provider-then-adapter' ||
        acpPostConfiguration
      ) {
        this.snapshot.agentSettingsObservations.push({
          id: `adapter-observation-${run.id}`,
          taskId: task.id,
          iterationId: run.iterationId,
          sessionId: run.sessionId,
          runId: run.id,
          runtimeId: run.runtimeId,
          source: 'TASK_MONKI_RESOLUTION' as never,
          settings: task.agentSettings,
          ...(acpPostConfiguration
            ? { rawMessage: protocolReference(run, 4, now) }
            : {}),
          observedAt: new Date(Date.parse(now) + 1).toISOString()
        });
      }
    }
    if (this.behavior.interactionStatus) {
      this.snapshot.interactionRequests.push({
        id: `interaction-${run.id}`,
        runId: run.id,
        status: this.behavior.interactionStatus
      } as TaskSnapshot['interactionRequests'][number]);
    }
    await this.behavior.onStart?.();
    if (this.behavior.hangStart) {
      return new Promise<RunRecord>(() => undefined);
    }
    return structuredClone(run);
  }

  async listTasks(): Promise<TaskSnapshot> {
    return structuredClone(this.snapshot);
  }

  async refreshEvidence(input: RefreshEvidenceRequest): Promise<GitSnapshotRecord> {
    const status = this.behavior.gitStatus ?? 'CLEAN';
    const snapshot = gitSnapshot(
      input.taskId,
      'git-1',
      status,
      this.repositoryPath,
      this.behavior.committedTaskChange
        ? {
            headSha: 'provider-commit',
            commitsAheadOfBase: 1,
            committedDiffFileCount: 1
          }
        : undefined
    );
    if (this.behavior.retainDifferentStoredGitSnapshot) {
      this.snapshot.gitSnapshots.push(
        gitSnapshot(input.taskId, 'stored-clean', 'CLEAN', this.repositoryPath)
      );
    } else {
      this.snapshot.gitSnapshots.push(snapshot);
    }
    return structuredClone(snapshot);
  }

  async cancelRun(input: CancelRunRequest): Promise<void> {
    this.cancelCount += 1;
    const run = this.snapshot.runs.find((candidate) => candidate.id === input.runId);
    if (run && !['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(run.status)) {
      run.status = 'INTERRUPTING';
      this.cancellationTransitions.push({ runId: run.id, status: run.status });
      if (this.behavior.hangCancel) {
        return new Promise<void>(() => undefined);
      }
      const finish = () => {
        run.status = this.behavior.cancelTerminalStatus ?? 'INTERRUPTED';
        run.endedAt = new Date().toISOString();
        run.terminalReason = 'Canceled by fake smoke service.';
        this.cancellationTransitions.push({ runId: run.id, status: run.status });
      };
      if (this.behavior.cancelTerminalDelayMs !== undefined) {
        setTimeout(finish, this.behavior.cancelTerminalDelayMs);
      } else {
        finish();
      }
    }
  }

  async shutdown(): Promise<void> {}
}

function protocolReference(run: RunRecord, sequence: number, recordedAt: string) {
  return {
    serverInstanceId: `server-${run.id}`,
    sequence,
    direction: 'INBOUND' as const,
    recordedAt,
    byteOffset: sequence * 100,
    byteLength: 100,
    sha256: String(sequence).padStart(64, '0')
  };
}

function gitSnapshot(
  taskId: string,
  id: string,
  status: 'CLEAN' | 'DIRTY',
  repositoryPath: string,
  overrides: Partial<GitSnapshotRecord> = {}
): GitSnapshotRecord {
  return {
    id,
    taskId,
    iterationId: `iteration-${taskId}`,
    worktreeId: `worktree-${taskId}`,
    worktreePath: repositoryPath,
    repoRoot: repositoryPath,
    gitCommonDir: path.join(repositoryPath, '.git'),
    headSha: 'base-sha',
    baseSha: 'base-sha',
    aheadCount: 0,
    behindCount: 0,
    stagedCount: status === 'DIRTY' ? 1 : 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    commitsAheadOfBase: 0,
    committedDiffFileCount: 0,
    workingDiffFileCount: status === 'DIRTY' ? 1 : 0,
    diffStat: '',
    dirtyFingerprint: status,
    status,
    capturedAt: new Date().toISOString(),
    ...overrides
  };
}

async function createThrowawayRepository(cleanupPaths: string[]): Promise<string> {
  const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-smoke-test-'));
  cleanupPaths.push(repositoryPath);
  await git(repositoryPath, ['init', '-b', 'main']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki Smoke Test']);
  await git(repositoryPath, ['config', 'user.email', 'smoke@example.invalid']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Smoke test\n');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial fixture']);
  return repositoryPath;
}

async function runHarness(
  repositoryPath: string,
  service: FakeProviderSmokeService,
  cleanupPaths: string[],
  optionOverrides: Partial<ProviderSmokeOptions> = {},
  dependencyOverrides: ProviderSmokeDependencies = {}
) {
  const report = await runProviderSmoke(
    {
      repositoryPath,
      runtimeIds: [],
      modelIds: [],
      timeoutMs: 1_000,
      confirmThrowaway: true,
      confirmProviderUsage: true,
      help: false,
      ...optionOverrides
    },
    {
      createService: () => service,
      pollIntervalMs: 2,
      cancelTimeoutMs: 25,
      ...dependencyOverrides
    }
  );
  cleanupPaths.push(report.stateRoot);
  return report;
}
