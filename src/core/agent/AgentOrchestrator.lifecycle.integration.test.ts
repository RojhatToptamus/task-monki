import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentExecutionSettings,
  AgentPreflight,
  AgentRuntimeCapabilities,
  AgentSessionRecord,
  AgentSessionSnapshot
} from '../../shared/agent';
import type { Task, TaskIteration, WorktreeRecord } from '../../shared/contracts';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { SqliteTaskStore } from '../storage/SqliteTaskStore';
import { SqliteAgentRuntimeStore } from '../storage/SqliteAgentRuntimeStore';
import type { TaskAgentRuntimeAccess } from './AgentRuntimeStore';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  AgentRuntimeDeliveryError,
  type AgentRuntimeAdapter,
  type AgentReconciliationResult,
  type AgentSessionRef,
  type AgentTurn,
  type CreateAgentSession,
  type InterruptAgentTurn,
  type ForkAgentSession,
  type StartAgentTurn,
  type SteerAgentTurn,
  type SyncAgentGoal,
  type ResolveAgentExecution,
  type ResolvedAgentExecution
} from './AgentRuntimeAdapter';
import { createRuntimeReadiness } from './AgentRuntimeReadiness';
import { AgentOrchestrator } from './AgentOrchestrator';
import { AgentRuntimeRegistry } from './AgentRuntimeRegistry';
import type { AgentRuntimeTurnEvent } from './AgentRuntimeCoordinator';
import { assertModelSupportsAttachments } from './AgentAttachmentDelivery';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from './codex/codexCapabilities';
import {
  OPENCODE_RUNTIME_DESCRIPTOR,
  opencodeCapabilities
} from './opencode/opencodeCapabilities';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { git } from '../git/gitCli';
import type { ApplicationPersistence } from '../storage/sqlite/ApplicationPersistence';

describe('AgentOrchestrator lifecycle and recovery', () => {
  it('keeps a prepared turn provably unsent when its local prompt cannot be read', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-runtime-prompt-read-failure-')
    );
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      adapter
    );
    const primaryCwd = path.join(dir, 'empty-workspace');
    await fs.mkdir(primaryCwd);
    const modelSettings = {
      runtimeId: 'codex',
      model: 'test-model',
      sandbox: 'READ_ONLY' as const,
      approvalPolicy: 'NEVER' as const,
      networkAccess: false
    };
    const executionContext = {
      attestation: { status: 'ATTESTED' as const },
      repositoryAccess: 'WRITE' as const,
      primaryCwd,
      readRoots: [{ canonicalPath: primaryCwd, kind: 'EMPTY_MANAGED' as const }],
      managedAttachments: [],
      permissionProfileHash: 'c'.repeat(64),
      modelSettings,
      externalTools: {
        network: false,
        webSearch: 'disabled' as const,
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      clientOperationId: 'prepare-local-prompt-failure'
    };
    const prepared = await orchestrator.prepareTurn({
      sessionId: 'prompt-failure-session',
      runId: 'prompt-failure-run',
      owner: {
        kind: 'DISCOURSE',
        conversationId: 'prompt-failure-conversation',
        stableParticipantId: 'prompt-failure-participant'
      },
      scope: {
        kind: 'DISCOURSE',
        conversationId: 'prompt-failure-conversation',
        waveId: 'prompt-failure-wave',
        jobId: 'prompt-failure-job',
        contextSnapshotId: 'prompt-failure-context',
        attemptId: 'prompt-failure-attempt'
      },
      runtimeId: 'codex',
      model: 'test-model',
      purpose: 'DISCOURSE_ANSWER',
      generationKey: 'prompt-failure-generation',
      executionContext,
      prompt: 'This prompt must be verified before delivery intent.',
      priority: 'DISCOURSE_RESPONSE',
      clientOperationId: 'prepare-local-prompt-failure',
      createdAt: '2026-07-13T00:00:00.000Z'
    });
    const leased = await runtime.store.leaseQueueEntry(
      prepared.queueEntry.id,
      prepared.queueEntry.recordRevision,
      'lease-local-prompt-failure'
    );
    vi.spyOn(runtime.store, 'readArtifact').mockRejectedValueOnce(
      new Error('prompt artifact failed verification')
    );

    await expect(
      orchestrator.startPreparedTurn(leased.id, 'start-local-prompt-failure')
    ).rejects.toThrow('prompt artifact failed verification');

    expect(adapter.runtimeStartCount).toBe(0);
    await expect(runtime.store.getRun(prepared.run.id)).resolves.toMatchObject({
      status: 'QUEUED',
      delivery: 'NOT_SENT'
    });
  });

  it('leaves synthetic server evidence unchanged when provider startup is disabled', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-disabled-runtime-loss-')
    );
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const server = await runtime.store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    await runtime.store.updateAgentServer(server.id, { status: 'READY' });
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      adapter,
      { providerStartupDisabledReason: 'Synthetic scenario host.' }
    );

    await orchestrator.initialize();

    expect(adapter.initializeCount).toBe(0);
    await expect(store.snapshot()).resolves.toMatchObject({
      agentServers: [
        expect.objectContaining({ id: server.id, status: 'READY' })
      ]
    });
  });

  it('marks an idle on-demand runtime server lost without launching that runtime', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-idle-runtime-loss-'));
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const staleServer = await runtime.store.createAgentServer({
      runtimeId: 'grok-acp',
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: 'grok',
      argv: ['--acp']
    });
    await runtime.store.updateAgentServer(staleServer.id, { status: 'READY' });
    const codex = new Phase4Adapter(runtime.task);
    const grok = new Phase4Adapter(runtime.task, {
      ...CODEX_RUNTIME_DESCRIPTOR,
      id: 'grok-acp',
      displayName: 'Grok ACP',
      startupPolicy: 'ON_DEMAND'
    });
    const registry = new AgentRuntimeRegistry([codex, grok], 'codex');
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), registry);

    await orchestrator.initialize();

    expect(codex.initializeCount).toBe(1);
    expect(grok.initializeCount).toBe(0);
    await expect(store.snapshot()).resolves.toMatchObject({
      agentServers: [
        expect.objectContaining({
          id: staleServer.id,
          status: 'LOST',
          disconnectedAt: expect.any(String),
          exitedAt: expect.any(String),
          exitReason: 'Task Monki restarted without the prior provider process.'
        })
      ]
    });
  });

  it('starts on-demand runtimes that own persisted Discourse and refinement work', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-owner-neutral-runtime-recovery-')
    );
    const workspace = path.join(dir, 'workspace');
    await fs.mkdir(workspace);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const codex = new Phase4Adapter(runtime.task);
    const discourseRuntime = new Phase4Adapter(runtime.task, {
      ...CODEX_RUNTIME_DESCRIPTOR,
      id: 'grok-acp',
      displayName: 'Grok ACP',
      startupPolicy: 'ON_DEMAND'
    });
    const refinementRuntime = new Phase4Adapter(runtime.task, {
      ...CODEX_RUNTIME_DESCRIPTOR,
      id: 'cursor-acp',
      displayName: 'Cursor ACP',
      startupPolicy: 'ON_DEMAND'
    });
    const registry = new AgentRuntimeRegistry(
      [codex, discourseRuntime, refinementRuntime],
      'codex'
    );
    const beforeRestart = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      registry
    );
    const settings = (runtimeId: string) => ({
      runtimeId,
      model: 'test-model',
      sandbox: 'READ_ONLY' as const,
      approvalPolicy: 'NEVER' as const,
      networkAccess: false
    });
    const contextFor = (adapter: Phase4Adapter, runtimeId: string, sessionId: string) =>
      adapter.buildExecutionContext!({
        sessionId,
        primaryCwd: workspace,
        readRoots: [{ canonicalPath: workspace, kind: 'EMPTY_MANAGED' as const }],
        modelSettings: settings(runtimeId),
        clientOperationId: `context:${sessionId}`,
        attachments: []
      });
    const discourseContext = await contextFor(
      discourseRuntime,
      'grok-acp',
      'discourse-session'
    );
    const discourse = await beforeRestart.prepareTurn({
      sessionId: 'discourse-session',
      runId: 'discourse-run',
      owner: {
        kind: 'DISCOURSE',
        conversationId: 'conversation-1',
        stableParticipantId: 'participant-1'
      },
      scope: {
        kind: 'DISCOURSE',
        conversationId: 'conversation-1',
        waveId: 'wave-1',
        jobId: 'job-1',
        contextSnapshotId: 'context-1',
        attemptId: 'attempt-1'
      },
      runtimeId: 'grok-acp',
      model: 'test-model',
      purpose: 'DISCOURSE_ANSWER',
      generationKey: 'discourse-generation',
      executionContext: discourseContext,
      prompt: 'Recover this participant turn.',
      priority: 'DISCOURSE_RESPONSE',
      clientOperationId: 'prepare-discourse-recovery',
      createdAt: '2026-07-13T00:00:00.000Z'
    });
    await beforeRestart.startPreparedTurnNow(
      discourse.queueEntry.id,
      'start-discourse-recovery'
    );
    const refinementContext = await contextFor(
      refinementRuntime,
      'cursor-acp',
      'refinement-session'
    );
    const refinement = await beforeRestart.prepareTurn({
      sessionId: 'refinement-session',
      runId: 'refinement-run',
      owner: { kind: 'PROMPT_REFINEMENT', requestId: 'request-1' },
      scope: { kind: 'PROMPT_REFINEMENT', requestId: 'request-1' },
      runtimeId: 'cursor-acp',
      model: 'test-model',
      purpose: 'PROMPT_REFINEMENT',
      generationKey: 'refinement-generation',
      executionContext: refinementContext,
      prompt: 'Recover this refinement turn.',
      priority: 'TASK_FOREGROUND',
      clientOperationId: 'prepare-refinement-recovery',
      createdAt: '2026-07-13T00:00:00.000Z'
    });
    await beforeRestart.startPreparedTurnNow(
      refinement.queueEntry.id,
      'start-refinement-recovery'
    );
    await expect(runtime.store.snapshot()).resolves.toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: discourse.session.id, runtimeId: 'grok-acp' }),
        expect.objectContaining({ id: refinement.session.id, runtimeId: 'cursor-acp' })
      ]),
      runs: expect.arrayContaining([
        expect.objectContaining({ id: discourse.run.id, status: 'RUNNING' }),
        expect.objectContaining({ id: refinement.run.id, status: 'RUNNING' })
      ])
    });

    const restarted = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      registry
    );
    await restarted.initialize();

    expect(codex.initializeCount).toBe(1);
    expect(discourseRuntime.initializeCount).toBe(1);
    expect(refinementRuntime.initializeCount).toBe(1);
    await expect(runtime.store.getRun(discourse.run.id)).resolves.toMatchObject({
      owner: { kind: 'DISCOURSE' },
      status: 'RUNNING'
    });
    await expect(runtime.store.getRun(refinement.run.id)).resolves.toMatchObject({
      owner: { kind: 'PROMPT_REFINEMENT' },
      status: 'RUNNING'
    });
  });

  it('rejects image delivery before creating a run when the selected model is text-only', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-text-model-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter, {
    });
    const draft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: draft.id,
      displayName: 'screen.png',
      bytes: onePixelPng()
    });
    const task = await store.createTask({
      title: 'Text-only model',
      prompt: 'Inspect the screenshot.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      attachmentDraftId: draft.id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/text-only-model',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toThrow('does not accept image attachments');

    const snapshot = await store.snapshot();
    expect(snapshot.runs).toHaveLength(0);
    expect(snapshot.agentSessions).toHaveLength(0);
  });

  it('uses the adapter-resolved provider identity before starting a turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-provider-normalize-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Normalize provider',
      prompt: 'Start with resolved settings.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: {
        model: 'test-model',
        modelProvider: 'openai',
        reasoningEffort: 'high'
      }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/provider-normalize',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });

    expect(adapter.lastStart?.settings?.modelProvider).toBe('openai');
  });

  it('cancels a queued Task turn before provider submission and prevents a later send', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cancel-unsent-turn-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      adapter
    );
    const task = await store.createTask({
      title: 'Cancel unsent turn',
      prompt: 'Do not send this prompt after cancellation.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/cancel-unsent-turn',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const createSession = adapter.createSession.bind(adapter);
    let releaseSession!: () => void;
    let sessionStarted!: () => void;
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const sessionStart = new Promise<void>((resolve) => {
      sessionStarted = resolve;
    });
    vi.spyOn(adapter, 'createSession').mockImplementation(async (input) => {
      sessionStarted();
      await sessionGate;
      return createSession(input);
    });

    const starting = orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await sessionStart;
    const queued = (await runtime.task.snapshot()).runs[0]!;
    expect(queued).toMatchObject({ status: 'QUEUED', providerTurnId: undefined });

    await expect(orchestrator.interruptRun(queued.id)).resolves.toBeUndefined();
    releaseSession();

    await expect(starting).resolves.toMatchObject({
      id: queued.id,
      status: 'INTERRUPTED',
      providerTurnId: undefined,
      terminalReason: 'Canceled before the turn was sent to the provider.'
    });
    expect(adapter.startCount).toBe(0);
    await expect(runtime.store.getRun(queued.id)).resolves.toMatchObject({
      status: 'INTERRUPTED',
      delivery: 'NOT_DELIVERED'
    });
  });

  it('does not report a successful stop while Task submission is awaiting acknowledgement', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-stop-sending-turn-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      adapter
    );
    const task = await store.createTask({
      title: 'Stop sending turn',
      prompt: 'Wait for provider acknowledgement before Stop is available.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/stop-sending-turn',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const startTurn = adapter.startTurn.bind(adapter);
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    vi.spyOn(adapter, 'startTurn').mockImplementation(async (input) => {
      providerStarted();
      await providerGate;
      return startTurn(input);
    });

    const starting = orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await providerStart;
    const sending = (await runtime.task.snapshot()).runs[0]!;
    expect(sending).toMatchObject({ status: 'STARTING', providerTurnId: undefined });

    await expect(orchestrator.interruptRun(sending.id)).rejects.toThrow(
      'This turn is being sent to the provider.'
    );
    const stillSending = await runtime.store.getRun(sending.id);
    expect(stillSending).toMatchObject({
      status: 'STARTING',
      delivery: 'SENDING'
    });
    expect(stillSending?.interruptDelivery).toBeUndefined();

    releaseProvider();
    await expect(starting).resolves.toMatchObject({ status: 'RUNNING' });
  });

  it('preserves session lineage across steer, continue, and detached review', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-lifecycle-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    await initializeRepository(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Agent lifecycle',
      prompt: 'Implement continuation controls.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/phase-4',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    const first = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await orchestrator.steerRun(first.id, 'Focus on recovery first.');
    expect(adapter.lastSteer?.providerTurnId).toBe(first.providerTurnId);
    expect(adapter.lastSteer?.clientMessageId).toBeTruthy();

    await terminal(runtime.task, first, 'AGENT_RUN_INTERRUPTED');
    const continued = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      sessionId: first.sessionId,
      mode: 'FOLLOW_UP',
      prompt: 'Continue after interruption.',
      settings: task.agentSettings,
      continuedFromRunId: first.id
    });
    expect(continued.sessionId).toBe(first.sessionId);
    expect(continued.continuedFromRunId).toBe(first.id);

    await terminal(runtime.task, continued, 'AGENT_RUN_COMPLETED');
    const reviewed = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun: (await store.getRun(continued.id))!,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: {
        ...task.agentSettings,
        sandbox: 'READ_ONLY'
      }
    });
    const reviewSession = await store.getAgentSession(reviewed.sessionId);
    expect(reviewSession?.role).toBe('REVIEW');
    expect(reviewSession?.parentSessionId).toBe(first.sessionId);
    expect(reviewed.mode).toBe('REVIEW');
    await orchestrator.interruptRun(reviewed.id);
    expect(adapter.runtimeInterruptCount).toBe(1);
  });

  it('recreates a missing provider session and retries the same follow-up run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-missing-session-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Missing provider thread',
      prompt: 'Continue even when provider session storage was evicted.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/missing-provider-thread',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const first = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal(runtime.task, first, 'AGENT_RUN_COMPLETED');
    const originalSession = (await store.getAgentSession(first.sessionId))!;
    adapter.missingProviderSessionOnStart = originalSession.providerSessionId;

    const continued = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      sessionId: first.sessionId,
      mode: 'FOLLOW_UP',
      prompt: 'Fix review feedback.',
      settings: task.agentSettings,
      continuedFromRunId: first.id
    });

    const snapshot = await store.snapshot();
    const replacementSession = snapshot.agentSessions.find(
      (session) => session.id === continued.sessionId
    )!;
    const undeliveredAttempt = snapshot.runs.find(
      (run) =>
        run.id !== continued.id &&
        run.continuedFromRunId === first.id &&
        !run.retryOfRunId
    )!;
    const canonicalAttempt = (await runtime.store.snapshot()).runs.find(
      (run) => run.id === undeliveredAttempt.id
    );
    expect(continued.sessionId).not.toBe(first.sessionId);
    expect(continued.status).toBe('RUNNING');
    expect(continued.retryOfRunId).toBe(undeliveredAttempt.id);
    expect(replacementSession).toMatchObject({
      parentSessionId: first.sessionId,
      providerSessionId: 'thread-2'
    });
    expect(replacementSession.relationshipDetail).toContain('replaced session');
    expect(undeliveredAttempt).toMatchObject({ status: 'FAILED' });
    expect(undeliveredAttempt.providerTurnId).toBeUndefined();
    expect(canonicalAttempt?.delivery).toBe('NOT_DELIVERED');
    expect(originalSession.providerSessionId).toBe('thread-1');

    await terminal(runtime.task, continued, 'AGENT_RUN_COMPLETED');
    const third = await orchestrator.startTurn({
      task: (await store.getTask(task.id))!,
      iteration,
      worktree,
      mode: 'FOLLOW_UP',
      prompt: 'Continue in the replacement session.',
      settings: task.agentSettings,
      continuedFromRunId: continued.id
    });
    expect(third.sessionId).toBe(replacementSession.id);
    expect(adapter.lastStart?.session.localSessionId).toBe(replacementSession.id);
  });

  it('records ambiguous turn submission as recovery-required without false failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-ambiguous-start-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    adapter.ambiguousStart = true;
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Ambiguous start',
      prompt: 'Do not duplicate this mutation.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/ambiguous',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);

    const snapshot = await store.snapshot();
    expect(snapshot.runs[0]?.status).toBe('RECOVERY_REQUIRED');
    expect(snapshot.runs[0]?.recoveryState).toBe('REQUIRES_USER_ACTION');
    expect(
      snapshot.events.some((event) => event.type === 'AGENT_RUN_FAILED')
    ).toBe(false);

    await orchestrator.interruptRun(snapshot.runs[0]!.id);
    await expect(store.getRun(snapshot.runs[0]!.id)).resolves.toMatchObject({
      status: 'INTERRUPTED',
      recoveryState: 'NONE',
      terminalReason: 'Recovery-required run was explicitly abandoned by the user.'
    });
  });

  it('preserves recovery established by a provider before startup rejects', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-provider-start-recovery-')
    );
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    adapter.recoveryThenRejectStart = true;
    const appEvents = new AppEventBus();
    const terminalEvents: unknown[] = [];
    appEvents.on((event) => {
      if (event.type === 'run.terminal') terminalEvents.push(event);
    });
    const orchestrator = new AgentOrchestrator(store, runtime.store, appEvents, adapter);
    const task = await store.createTask({
      title: 'Provider startup recovery',
      prompt: 'Preserve provider recovery evidence.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/provider-start-recovery',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    const getRun = runtime.task.getRun.bind(runtime.task);
    let staleActiveRun: Awaited<ReturnType<typeof getRun>>;
    let returnedStaleRun = false;
    vi.spyOn(runtime.task, 'getRun').mockImplementation(async (runId) => {
      const current = await getRun(runId);
      if (current && current.status !== 'RECOVERY_REQUIRED' && !staleActiveRun) {
        staleActiveRun = current;
      }
      if (
        current?.status === 'RECOVERY_REQUIRED' &&
        staleActiveRun &&
        !returnedStaleRun
      ) {
        returnedStaleRun = true;
        return staleActiveRun;
      }
      return current;
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toThrow('provider failed after publishing recovery');

    const snapshot = await store.snapshot();
    expect(snapshot.runs[0]).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      recoveryState: 'REQUIRES_USER_ACTION',
      terminalReason: 'Provider established recovery before rejecting startup.'
    });
    expect(
      snapshot.events.filter((event) => event.type === 'AGENT_MUTATION_AMBIGUOUS')
    ).toHaveLength(1);
    expect(
      snapshot.events.some((event) => event.type === 'AGENT_RUN_FAILED')
    ).toBe(false);
    expect(returnedStaleRun).toBe(true);
    expect(terminalEvents).toEqual([]);

    const recoveryRun = snapshot.runs[0]!;
    expect(recoveryRun.finalArtifactId).toBeUndefined();
    expect(
      snapshot.artifacts.filter(
        (artifact) =>
          artifact.runId === recoveryRun.id && artifact.kind === 'agent-final'
      )
    ).toEqual([]);

    await orchestrator.interruptRun(recoveryRun.id);
    const resolved = (await store.getRun(recoveryRun.id))!;
    expect(resolved).toMatchObject({
      status: 'INTERRUPTED',
      recoveryState: 'NONE',
      terminalReason: 'Recovery-required run was explicitly abandoned by the user.'
    });
    expect(resolved.finalArtifactId).toBeTruthy();
    await expect(runtime.store.readArtifact(resolved.finalArtifactId!)).resolves.toContain(
      '# Recovery run closed'
    );
    await expect(runtime.store.readArtifact(resolved.finalArtifactId!)).resolves.not.toContain(
      'provider failed after publishing recovery'
    );
  });

  it('links a winning startup failure artifact to its failed review projection', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-start-failure-')
    );
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    await initializeRepository(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Review startup failure',
      prompt: 'Keep failed review evidence coherent.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-start-failure',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const implementation = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal(runtime.task, implementation, 'AGENT_RUN_COMPLETED');
    adapter.reviewStartFailure = 'provider review failed to start';

    await expect(
      orchestrator.startReview({
        task,
        iteration,
        worktree,
        sourceRun: (await store.getRun(implementation.id))!,
        target: { type: 'UNCOMMITTED_CHANGES' },
        settings: { ...task.agentSettings, sandbox: 'READ_ONLY' }
      })
    ).rejects.toThrow('provider review failed to start');

    const snapshot = await store.snapshot();
    const failedReview = snapshot.runs.find((run) => run.mode === 'REVIEW')!;
    expect(failedReview).toMatchObject({
      status: 'FAILED',
      terminalReason: 'provider review failed to start'
    });
    expect(failedReview.finalArtifactId).toBeTruthy();
    expect(snapshot.tasks[0]?.projection.agentReview).toMatchObject({
      status: 'FAILED',
      runId: failedReview.id,
      finalArtifactId: failedReview.finalArtifactId,
      summary: 'provider review failed to start'
    });
    const failureEvent = snapshot.events.find(
      (event) => event.runId === failedReview.id && event.type === 'AGENT_RUN_FAILED'
    );
    const artifactEvent = snapshot.events.find(
      (event) => event.runId === failedReview.id && event.type === 'ARTIFACT_CREATED'
    );
    expect(failureEvent?.payload).toMatchObject({
      error: 'provider review failed to start'
    });
    expect(artifactEvent?.payload).toMatchObject({
      artifactId: failedReview.finalArtifactId,
      kind: 'agent-final'
    });
    expect(snapshot.events.indexOf(failureEvent!)).toBeLessThan(
      snapshot.events.indexOf(artifactEvent!)
    );
    await expect(runtime.store.readArtifact(failedReview.finalArtifactId!)).resolves.toContain(
      'provider review failed to start'
    );
    const runtimeSnapshot = await runtime.store.snapshot();
    expect(
      runtimeSnapshot.runs.find((run) => run.id === failedReview.id)
    ).toMatchObject({
      status: 'FAILED',
      repositoryIntegrity: { status: 'UNCHANGED' }
    });
    expect(
      runtimeSnapshot.queueEntries.find((entry) => entry.runId === failedReview.id)
    ).toMatchObject({ status: 'SETTLED' });
    expect(adapter.runtimeReleaseCount).toBe(1);
  });

  it('settles and releases a recovered review after provider termination is known', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-recovery-cleanup-')
    );
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    await initializeRepository(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const server = await runtime.store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    await runtime.store.updateAgentServer(server.id, { status: 'READY' });
    adapter.runtimeServerId = server.id;
    const orchestrator = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      adapter
    );
    const task = await store.createTask({
      title: 'Recovered review cleanup',
      prompt: 'Keep the review boundary intact during recovery.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-recovery-cleanup',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const implementation = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal(runtime.task, implementation, 'AGENT_RUN_COMPLETED');
    const review = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun: (await store.getRun(implementation.id))!,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: { ...task.agentSettings, sandbox: 'READ_ONLY' }
    });
    const lostAt = new Date().toISOString();
    await runtime.task.applyTaskRuntimeEvent(
      createDomainEvent({
        type: 'AGENT_RUNTIME_LOST',
        taskId: review.taskId,
        iterationId: review.iterationId,
        runId: review.id,
        worktreeId: review.worktreeId,
        agentSessionId: review.sessionId,
        source: 'provider',
        payload: { reason: 'Provider connection was lost.' }
      }),
      `review-recovery:${review.id}`
    );
    const canonical = (await runtime.store.getRun(review.id))!;
    await runtime.store.updateRun(
      canonical.id,
      canonical.recordRevision,
      {
        status: 'RECOVERY_REQUIRED',
        delivery: 'ACKNOWLEDGED',
        recoveryState: 'REQUIRES_USER_ACTION',
        terminalReason: 'Provider connection was lost.',
        lastEventAt: lostAt
      },
      `review-provider-recovery:${review.id}`
    );
    adapter.onRuntimeInterrupt = async () => {
      const active = (await runtime.store.getRun(review.id))!;
      const completedAt = new Date().toISOString();
      await runtime.store.updateRun(
        active.id,
        active.recordRevision,
        {
          status: 'INTERRUPTED',
          delivery: 'TERMINAL',
          interruptDelivery: 'TERMINAL',
          recoveryState: 'NONE',
          terminalReason: 'Provider confirmed that the review stopped.',
          lastEventAt: completedAt,
          endedAt: completedAt
        },
        `review-provider-terminal:${review.id}`
      );
      adapter.emitRuntimeTurnEvent({
        type: 'TERMINAL',
        runId: review.id,
        providerTurnId: active.providerTurnId!,
        status: 'interrupted',
        error: 'Provider confirmed that the review stopped.',
        completedAt
      });
    };

    await orchestrator.interruptRun(review.id);

    await expect(store.getRun(review.id)).resolves.toMatchObject({
      status: 'INTERRUPTED',
      terminalReason: 'Provider confirmed that the review stopped.'
    });
    const runtimeSnapshot = await runtime.store.snapshot();
    expect(runtimeSnapshot.runs.find((run) => run.id === review.id)).toMatchObject({
      status: 'INTERRUPTED',
      repositoryIntegrity: { status: 'UNCHANGED' }
    });
    expect(
      runtimeSnapshot.queueEntries.find((entry) => entry.runId === review.id)
    ).toMatchObject({ status: 'SETTLED' });
    expect(adapter.runtimeReleaseCount).toBe(1);
  });

  it('does not finish review verification when interrupt settlement is ambiguous', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-ambiguous-stop-')
    );
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    await initializeRepository(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const server = await runtime.store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    await runtime.store.updateAgentServer(server.id, { status: 'READY' });
    adapter.runtimeServerId = server.id;
    adapter.runtimeInterruptFailure = new AgentRuntimeDeliveryError(
      'AMBIGUOUS',
      'The provider process did not confirm shutdown.'
    );
    const orchestrator = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      adapter
    );
    const task = await store.createTask({
      title: 'Ambiguous review stop',
      prompt: 'Keep the repository boundary open until the provider stops.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/ambiguous-review-stop',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const implementation = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal(runtime.task, implementation, 'AGENT_RUN_COMPLETED');
    const review = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun: (await store.getRun(implementation.id))!,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: { ...task.agentSettings, sandbox: 'READ_ONLY' }
    });

    await orchestrator.interruptRun(review.id);

    await expect(runtime.store.getRun(review.id)).resolves.toMatchObject({
      status: 'INTERRUPTING',
      interruptDelivery: 'AMBIGUOUS',
      repositoryIntegrity: { status: 'PENDING' }
    });
    expect((await runtime.store.getRun(review.id))?.repositoryIntegrity?.afterFingerprint)
      .toBeUndefined();
    await expect(store.getRun(review.id)).resolves.toMatchObject({
      status: 'INTERRUPTING'
    });
    expect(
      (await store.snapshot()).events.some(
        (event) => event.runId === review.id && event.type === 'AGENT_RUNTIME_LOST'
      )
    ).toBe(false);
  });

  it('projects a preverified terminal review after restart', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-preverified-recovery-')
    );
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    await initializeRepository(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const server = await runtime.store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    await runtime.store.updateAgentServer(server.id, { status: 'READY' });
    adapter.runtimeServerId = server.id;
    const orchestrator = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      adapter
    );
    const task = await store.createTask({
      title: 'Preverified review recovery',
      prompt: 'Project a terminal review after restart.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/preverified-review-recovery',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const implementation = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal(runtime.task, implementation, 'AGENT_RUN_COMPLETED');
    const review = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun: (await store.getRun(implementation.id))!,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: { ...task.agentSettings, sandbox: 'READ_ONLY' }
    });
    let canonical = (await runtime.store.getRun(review.id))!;
    const output = await runtime.store.getArtifact(canonical.outputArtifactId);
    await runtime.store.updateArtifact({
      artifactId: output!.id,
      expectedRevision: output!.recordRevision,
      clientOperationId: `preverified-review-output:${review.id}`,
      content: JSON.stringify({
        verdict: 'PASSED',
        summary: 'The recovered review passed.',
        findings: []
      })
    });
    const completedAt = new Date().toISOString();
    canonical = await runtime.store.updateRun(
      canonical.id,
      canonical.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        recoveryState: 'NONE',
        providerTerminalSource: 'SCRIPTED_CRASH_AFTER_INTEGRITY',
        repositoryIntegrity: {
          ...canonical.repositoryIntegrity,
          status: 'UNCHANGED',
          afterFingerprint: canonical.repositoryIntegrity?.beforeFingerprint,
          checkedAt: completedAt
        },
        lastEventAt: completedAt,
        endedAt: completedAt
      },
      `preverified-review-terminal:${review.id}`
    );

    const restarted = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      adapter
    );
    await restarted.initialize();

    await expect(store.getRun(review.id)).resolves.toMatchObject({
      status: 'COMPLETED',
      finalArtifactId: expect.any(String)
    });
    await expect(store.getTask(task.id)).resolves.toMatchObject({
      projection: {
        agentReview: {
          status: 'PASSED',
          runId: review.id,
          summary: 'The recovered review passed.'
        }
      }
    });
    expect(
      (await runtime.store.snapshot()).queueEntries.find(
        (entry) => entry.runId === review.id
      )
    ).toMatchObject({ status: 'SETTLED' });
    expect(adapter.runtimeReleaseCount).toBe(1);
  });

  it('preserves the provider startup error when supplementary artifact creation fails', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-start-failure-artifact-')
    );
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    adapter.startFailure = 'provider startup failed';
    const appEvents = new AppEventBus();
    const terminalEvents: unknown[] = [];
    appEvents.on((event) => {
      if (event.type === 'run.terminal') terminalEvents.push(event);
    });
    const orchestrator = new AgentOrchestrator(store, runtime.store, appEvents, adapter);
    const task = await store.createTask({
      title: 'Startup artifact failure',
      prompt: 'Preserve the original provider error.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/start-failure-artifact',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    vi.spyOn(runtime.task, 'writeFinalArtifact').mockRejectedValueOnce(
      new Error('final artifact storage unavailable')
    );

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toThrow('provider startup failed');

    const snapshot = await store.snapshot();
    const failedRun = snapshot.runs[0]!;
    expect(failedRun).toMatchObject({
      status: 'FAILED',
      terminalReason: 'provider startup failed'
    });
    expect(failedRun.finalArtifactId).toBeUndefined();
    expect(
      snapshot.artifacts.filter(
        (artifact) => artifact.runId === failedRun.id && artifact.kind === 'agent-final'
      )
    ).toEqual([]);
    expect(terminalEvents).toEqual([
      expect.objectContaining({
        runId: failedRun.id,
        payload: { status: 'failed', error: 'provider startup failed' }
      })
    ]);
    await expect(runtime.store.readArtifact(failedRun.diagnosticArtifactId)).resolves.toContain(
      'final artifact storage unavailable'
    );
  });

  it('refuses network-enabled turns when the browser development boundary disables them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-network-boundary-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });
    const task = await store.createTask({
      title: 'Keep dev API isolated',
      prompt: 'Do not expose the browser development API.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: { model: 'test-model', networkAccess: true }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/network-boundary',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toThrow('browser development server');
    expect((await store.snapshot()).runs).toHaveLength(0);

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: {
          ...task.agentSettings,
          networkAccess: false,
          sandbox: 'DANGER_FULL_ACCESS'
        }
      })
    ).rejects.toThrow('browser development server');
    expect((await store.snapshot()).runs).toHaveLength(0);

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: {
          ...task.agentSettings,
          networkAccess: false,
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user'
        }
      })
    ).rejects.toThrow('non-escalatable agent runs');
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: {
          ...task.agentSettings,
          networkAccess: false,
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'never',
          approvalsReviewer: 'auto_review'
        }
      })
    ).rejects.toThrow('automated approval reviewer');
    expect((await store.snapshot()).runs).toHaveLength(0);

    const existingSession = await createRuntimeSession(runtime.task, {
      task,
      iteration,
      worktree,
      settings: {
        model: 'test-model',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      }
    });
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: {
          model: 'test-model',
          networkAccess: false,
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'never',
          approvalsReviewer: 'user'
        }
      })
    ).rejects.toThrow('Selected session is unsafe');
    await runtime.task.updateAgentSession(existingSession.id, {
      requestedSettings: {
        model: 'test-model',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      },
      observedSettings: {
        model: 'test-model',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: true,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      }
    }, `test-session-unsafe-observation:${existingSession.id}`);
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      networkAccess: false,
      sandbox: 'WORKSPACE_WRITE',
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: safeSettings
      })
    ).rejects.toThrow('Selected session observed settings is unsafe');
    await runtime.task.updateAgentSession(
      existingSession.id,
      { observedSettings: safeSettings },
      `test-session-safe-observation:${existingSession.id}`
    );
    await runtime.task.recordAgentSettingsObservation({
      taskId: task.id,
      iterationId: iteration.id,
      sessionId: existingSession.id,
      runtimeId: 'codex',
      source: 'THREAD_SETTINGS_NOTIFICATION',
      settings: { ...safeSettings, sandbox: 'DANGER_FULL_ACCESS' }
    }, `test-settings-unsafe:${existingSession.id}`);
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: safeSettings
      })
    ).rejects.toThrow('latest settings observation is unsafe');
    await runtime.task.recordAgentSettingsObservation({
      taskId: task.id,
      iterationId: iteration.id,
      sessionId: existingSession.id,
      runtimeId: 'codex',
      source: 'THREAD_SETTINGS_NOTIFICATION',
      settings: safeSettings
    }, `test-settings-safe:${existingSession.id}`);

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: safeSettings
      })
    ).resolves.toMatchObject({
      requestedSettings: {
        networkAccess: false,
        sandbox: 'WORKSPACE_WRITE',
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      }
    });
  });

  it('rejects an unattested runtime before browser development can resolve provider state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-boundary-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    Object.defineProperty(adapter, 'descriptor', {
      value: OPENCODE_RUNTIME_DESCRIPTOR
    });
    vi.spyOn(adapter, 'capabilities').mockResolvedValue(opencodeCapabilities());
    const resolveExecution = vi.spyOn(adapter, 'resolveExecution');
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });
    const task = await store.createTask({
      runtimeId: 'opencode',
      title: 'Reject unattested runtime',
      prompt: 'Do not probe the provider.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      agentSettings: {
        runtimeId: 'opencode',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'task-monki/runtime-boundary',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toThrow('browser development');
    expect(resolveExecution).not.toHaveBeenCalled();
    expect((await store.snapshot()).runs).toEqual([]);
  });

  it('rechecks provider-observed settings after creating a session and before turn/start', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-created-boundary-'));
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    adapter.createdSessionObservedSettings = {
      ...safeSettings,
      networkAccess: true
    };
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });
const { task, iteration, worktree } = await createTaskContext(
      store,
      dir,
      safeSettings
    );

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: safeSettings
      })
    ).rejects.toThrow('Created session observed settings is unsafe');

    expect(adapter.startCount).toBe(0);
    expect((await store.snapshot()).runs).toEqual([
      expect.objectContaining({ status: 'FAILED' })
    ]);
  });

  it('rechecks recreated session observations before retrying turn/start', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-recreated-boundary-'));
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const adapter = new Phase4Adapter(runtime.task);
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });
    const { task, iteration, worktree } = await createTaskContext(
      store,
      dir,
      safeSettings
    );
    const first = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: safeSettings
    });
    await terminal(runtime.task, first, 'AGENT_RUN_COMPLETED');
    const originalSession = (await store.getAgentSession(first.sessionId))!;
    adapter.missingProviderSessionOnStart = originalSession.providerSessionId;
    adapter.createdSessionObservedSettings = {
      ...safeSettings,
      sandbox: 'DANGER_FULL_ACCESS'
    };

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        sessionId: first.sessionId,
        mode: 'FOLLOW_UP',
        prompt: 'Continue safely.',
        settings: safeSettings,
        continuedFromRunId: first.id
      })
    ).rejects.toThrow('Replacement session observed settings is unsafe');

    expect(adapter.startCount).toBe(2);
    const snapshot = await store.snapshot();
    const undeliveredAttempt = snapshot.runs.find(
      (run) => run.continuedFromRunId === first.id && !run.retryOfRunId
    )!;
    const rejectedReplacement = snapshot.runs.find(
      (run) => run.retryOfRunId === undeliveredAttempt.id
    )!;
    const replacementSession = snapshot.agentSessions.find(
      (session) => session.id === rejectedReplacement.sessionId
    );
    expect(undeliveredAttempt).toMatchObject({ status: 'FAILED' });
    expect(undeliveredAttempt.providerTurnId).toBeUndefined();
    expect(rejectedReplacement).toMatchObject({ status: 'FAILED' });
    expect(rejectedReplacement.providerTurnId).toBeUndefined();
    expect(replacementSession).toMatchObject({
      parentSessionId: first.sessionId,
      observedSettings: expect.objectContaining({ sandbox: 'DANGER_FULL_ACCESS' })
    });
  });

  it('stops the provider when recovery first observes unsafe browser-dev settings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-recovery-boundary-'));
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    const { task, iteration, worktree } = await createTaskContext(
      store,
      dir,
      safeSettings
    );
    const session = await createRuntimeSession(runtime.task, {
      task,
      iteration,
      worktree,
      settings: safeSettings
    });
    const run = await createRuntimeRun(runtime.task, {
      task,
      iteration,
      worktree,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: safeSettings
    });
    const adapter = new Phase4Adapter(runtime.task);
    adapter.initializeObservedSettings = {
      sessionId: session.id,
      settings: { ...safeSettings, approvalPolicy: 'on-request' }
    };
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });

    await expect(orchestrator.initialize()).rejects.toThrow(
      'Runtime recovery reported unsafe observed settings'
    );

    expect(adapter.initializeCount).toBe(1);
    expect(adapter.shutdownCount).toBe(1);
    await expect(store.getRun(run.id)).resolves.toMatchObject({ status: 'FAILED' });
  });

  it('terminalizes unsafe persisted runs before browser-dev provider initialization', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cold-boundary-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    const server = await runtime.store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      sandbox: 'WORKSPACE_WRITE' as const,
      networkAccess: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user' as const
    };
    const persisted: Array<{
      runId: string;
      sessionId: string;
      unsafe: boolean;
    }> = [];
    const persistRun = async (input: {
      title: string;
      status: 'QUEUED' | 'STARTING' | 'RUNNING' | 'RECOVERY_REQUIRED';
      runSettings: AgentExecutionSettings;
      sessionSettings?: AgentExecutionSettings;
      runObservedSettings?: AgentExecutionSettings;
      sessionObservedSettings?: AgentExecutionSettings;
      latestSettingsObservation?: AgentExecutionSettings;
      unsafe: boolean;
      attachment?: boolean;
    }) => {
      let attachmentDraftId: string | undefined;
      if (input.attachment) {
        const draft = await store.createAttachmentDraft();
        await store.stageTaskAttachment({
          draftId: draft.id,
          displayName: 'startup-input.txt',
          bytes: new TextEncoder().encode('cold-start boundary input')
        });
        attachmentDraftId = draft.id;
      }
      const task = await store.createTask({
        title: input.title,
        prompt: input.title,
        repositoryId: (await addTestRepository(store, repositoryDir)).id,
        agentSettings: input.runSettings,
        attachmentDraftId
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: `codex/${input.title}`,
        worktreePath: repositoryDir,
        baseSha: 'base'
      });
      const session = await createRuntimeSession(runtime.task, {
        task,
        iteration,
        worktree,
        settings: input.sessionSettings ?? input.runSettings
      });
      await store.recordAgentSessionCreated(session);
      if (input.sessionObservedSettings) {
        await runtime.task.updateAgentSession(
          session.id,
          { observedSettings: input.sessionObservedSettings },
          `test-persist-session-observation:${session.id}`
        );
      }
      const run = await createRuntimeRun(runtime.task, {
        task,
        iteration,
        worktree,
        session,
        serverInstanceId: server.id,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: input.runSettings,
        status: input.status,
        observedSettings: input.runObservedSettings
      });
      await store.recordAgentRunStarted(run);
      if (input.latestSettingsObservation) {
        await runtime.task.recordAgentSettingsObservation({
          taskId: task.id,
          iterationId: iteration.id,
          sessionId: session.id,
          runId: run.id,
          runtimeId: 'codex',
          source: 'THREAD_SETTINGS_NOTIFICATION',
          settings: input.latestSettingsObservation
        }, `test-persist-settings-observation:${run.id}`);
      }
      persisted.push({ runId: run.id, sessionId: session.id, unsafe: input.unsafe });
      const deliveryPath = input.attachment
        ? (await store.prepareRunAttachments(run.id, task.id))[0]?.absolutePath
        : undefined;
      return { task, iteration, worktree, session, run, deliveryPath };
    };

    const queuedNetwork = await persistRun({
      title: 'queued-network',
      status: 'QUEUED',
      runSettings: { ...safeSettings, networkAccess: true },
      unsafe: true,
      attachment: true
    });
    await persistRun({
      title: 'running-full-access',
      status: 'RUNNING',
      runSettings: { ...safeSettings, sandbox: 'DANGER_FULL_ACCESS' },
      unsafe: true
    });
    const pendingApprovalWithSafeSettings = await persistRun({
      title: 'running-pending-approval',
      status: 'RUNNING',
      runSettings: safeSettings,
      unsafe: true
    });
    await persistRun({
      title: 'recovery-escalatable',
      status: 'RECOVERY_REQUIRED',
      runSettings: { ...safeSettings, approvalPolicy: 'on-request' },
      unsafe: true
    });
    await persistRun({
      title: 'starting-session-reviewer',
      status: 'STARTING',
      runSettings: safeSettings,
      sessionSettings: { ...safeSettings, approvalsReviewer: 'guardian_subagent' },
      unsafe: true
    });
    await persistRun({
      title: 'running-session-observed-network',
      status: 'RUNNING',
      runSettings: safeSettings,
      sessionObservedSettings: { ...safeSettings, networkAccess: true },
      unsafe: true
    });
    await persistRun({
      title: 'running-run-observed-full-access',
      status: 'RUNNING',
      runSettings: safeSettings,
      runObservedSettings: { ...safeSettings, sandbox: 'DANGER_FULL_ACCESS' },
      unsafe: true
    });
    await persistRun({
      title: 'running-latest-observation-escalatable',
      status: 'RUNNING',
      runSettings: safeSettings,
      latestSettingsObservation: { ...safeSettings, approvalPolicy: 'on-request' },
      unsafe: true
    });
    await persistRun({
      title: 'queued-safe',
      status: 'QUEUED',
      runSettings: safeSettings,
      unsafe: false
    });
    expect(queuedNetwork.deliveryPath).toBeTruthy();
    await expect(fs.stat(queuedNetwork.deliveryPath!)).resolves.toBeTruthy();
    const rawInteraction = await runtime.store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"item/commandExecution/requestApproval","id":71}',
      { method: 'item/commandExecution/requestApproval' }
    );
    const pendingInteraction = await runtime.task.createInteractionRequest({
      runtimeId: 'codex',
      serverInstanceId: server.id,
      providerRequestId: 71,
      taskId: pendingApprovalWithSafeSettings.task.id,
      iterationId: pendingApprovalWithSafeSettings.iteration.id,
      runId: pendingApprovalWithSafeSettings.run.id,
      sessionId: pendingApprovalWithSafeSettings.session.id,
      type: 'COMMAND_APPROVAL',
      request: { command: 'curl http://127.0.0.1:3099', startedAtMs: Date.now() },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
      policyWarnings: [],
      requestRawMessage: rawInteraction
    }, `test-pending-interaction:${pendingApprovalWithSafeSettings.run.id}`);

    const electronAdapter = new Phase4Adapter(runtime.task);
    const electronOrchestrator = new AgentOrchestrator(
      store,
      runtime.store,
      new AppEventBus(),
      electronAdapter,
      {}
    );
    await electronOrchestrator.initialize();
    expect(
      electronAdapter.runsAtInitialize.filter((run) =>
        persisted.some((expected) => expected.unsafe && expected.runId === run.id)
      )
    ).toHaveLength(persisted.filter((expected) => expected.unsafe).length);
    await expect(fs.stat(queuedNetwork.deliveryPath!)).resolves.toBeTruthy();

    const terminalRunIds: string[] = [];
    const events = new AppEventBus();
    events.on((event) => {
      if (event.type === 'run.terminal' && event.runId) terminalRunIds.push(event.runId);
    });
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(store, runtime.store, events, adapter, {
      allowNetworkAccess: false,
    });

    const failedTerminalWrite = vi
      .spyOn(runtime.task, 'writeFinalArtifact')
      .mockRejectedValueOnce(new Error('simulated storage failure'));
    await expect(orchestrator.initialize()).rejects.toThrow('simulated storage failure');
    expect(adapter.initializeCount).toBe(0);
    failedTerminalWrite.mockRestore();

    await orchestrator.initialize();

    expect(adapter.initializeCount).toBe(1);
    const snapshot = await store.snapshot();
    await expect(fs.stat(queuedNetwork.deliveryPath!)).resolves.toBeTruthy();
    expect(
      snapshot.interactionRequests.find((request) => request.id === pendingInteraction.id)
    ).toMatchObject({ status: 'STALE' });
    for (const expected of persisted) {
      const run = snapshot.runs.find((candidate) => candidate.id === expected.runId);
      const statusAtProviderInitialize = adapter.runsAtInitialize.find(
        (candidate) => candidate.id === expected.runId
      )?.status;
      if (expected.unsafe) {
        expect(run).toMatchObject({
          status: 'FAILED',
          recoveryState: 'NONE'
        });
        expect(run?.terminalReason).toContain('persisted run was not resumed');
        expect(statusAtProviderInitialize).toBe('FAILED');
        expect(terminalRunIds).toContain(expected.runId);
        expect(
          snapshot.agentSessions.find((session) => session.id === expected.sessionId)?.status
        ).toBe('NOT_LOADED');
      } else {
        expect(run?.status).toBe('QUEUED');
        expect(statusAtProviderInitialize).toBe('QUEUED');
        expect(terminalRunIds).not.toContain(expected.runId);
      }
    }
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === 'AGENT_RUN_FAILED' &&
          JSON.stringify(event.payload).includes('BROWSER_DEV')
      )
    ).toHaveLength(persisted.filter((expected) => expected.unsafe).length);
    await orchestrator.shutdown();
    await electronOrchestrator.shutdown();
  }, 20_000);

  it('rejects unexpected provider approval acceptance in browser-dev mode', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-browser-approval-'));
    const getInteractionRequest = vi.fn().mockResolvedValue({
      id: 'interaction-one',
      taskId: 'task-one',
      runId: 'run-one',
      runtimeId: 'codex',
      type: 'COMMAND_APPROVAL'
    });
    const store = await openOrchestratorTaskStore(path.join(dir, 'profile'));
    const runtime = bindTaskRuntime(store);
    vi.spyOn(runtime.store, 'taskAgentRuntimeAccess').mockReturnValue({
      ...runtime.task,
      getInteractionRequest
    });
    const adapter = new Phase4Adapter(runtime.task);
    const orchestrator = new AgentOrchestrator(store, runtime.store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });

    await expect(
      orchestrator.respondToInteraction({
        taskId: 'task-one',
        runId: 'run-one',
        interactionRequestId: 'interaction-one',
        decision: {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT'
        }
      })
    ).rejects.toThrow('can only be declined or canceled');
    expect(getInteractionRequest).toHaveBeenCalledWith('interaction-one');
  });
});

class Phase4Adapter implements AgentRuntimeAdapter {
  ambiguousStart = false;
  recoveryThenRejectStart = false;
  startFailure?: string;
  reviewStartFailure?: string;
  missingProviderSessionOnStart?: string;
  createdSessionObservedSettings?: AgentExecutionSettings;
  initializeObservedSettings?: {
    sessionId: string;
    settings: AgentExecutionSettings;
  };
  lastStart?: StartAgentTurn;
  startCount = 0;
  runtimeStartCount = 0;
  runtimeInterruptCount = 0;
  runtimeReleaseCount = 0;
  runtimeInterruptFailure?: AgentRuntimeDeliveryError;
  runtimeServerId = 'runtime-server';
  onRuntimeInterrupt?: () => Promise<void>;
  initializeCount = 0;
  shutdownCount = 0;
  runsAtInitialize: Array<{ id: string; status: string }> = [];
  lastSteer?: SteerAgentTurn;
  private turnCounter = 0;
  private threadCounter = 0;

  constructor(
    private readonly store: TaskAgentRuntimeAccess,
    readonly descriptor = CODEX_RUNTIME_DESCRIPTOR
  ) {}

  async initialize(): Promise<void> {
    this.initializeCount += 1;
    if (this.initializeObservedSettings) {
      await this.store.updateAgentSession(this.initializeObservedSettings.sessionId, {
        observedSettings: this.initializeObservedSettings.settings
      }, `test-initialize-settings:${this.initializeObservedSettings.sessionId}`);
    }
    this.runsAtInitialize = (await this.store.snapshot()).runs.map((run) => ({
      id: run.id,
      status: run.status
    }));
  }

  preflight(): Promise<AgentPreflight> {
    const capabilities = {
      ...runtimeCapabilities(),
      runtimeId: this.descriptor.id
    };
    return Promise.resolve({
      runtime: this.descriptor,
      readiness: createRuntimeReadiness('READY', 'Test runtime is ready.'),
      capabilities,
    });
  }

  capabilities(): Promise<AgentRuntimeCapabilities> {
    return Promise.resolve({
      ...runtimeCapabilities(),
      runtimeId: this.descriptor.id
    });
  }

  listModels(): Promise<AgentModel[]> {
    return Promise.resolve([
      {
        id: `${this.descriptor.id}:openai/test-model`,
        runtimeId: this.descriptor.id,
        modelProvider: 'openai',
        model: 'test-model',
        displayName: 'Test model',
        hidden: false,
        supportedReasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [],
        inputModalities: ['text'],
        isDefault: true
      }
    ]);
  }

  async resolveExecution(input: ResolveAgentExecution): Promise<ResolvedAgentExecution> {
    const model = (await this.listModels())[0]!;
    assertModelSupportsAttachments(model, input.attachments);
    return {
      model,
      settings: {
        ...input.settings,
        runtimeId: this.descriptor.id,
        model: model.model,
        modelProvider: model.modelProvider,
        reasoningEffort: input.settings.reasoningEffort ?? model.defaultReasoningEffort
      }
    };
  }

  buildExecutionContext(
    input: Parameters<NonNullable<AgentRuntimeAdapter['buildExecutionContext']>>[0]
  ) {
    return Promise.resolve({
      attestation: { status: 'ATTESTED' as const },
      repositoryAccess: 'READ_ONLY' as const,
      primaryCwd: input.primaryCwd,
      readRoots: input.readRoots,
      managedAttachments: (input.attachments ?? []).map((attachment) => ({
        attachmentId: attachment.attachmentId,
        contentSha256: attachment.sha256,
        byteCount: attachment.byteCount
      })),
      permissionProfileHash: 'b'.repeat(64),
      modelSettings: {
        ...input.modelSettings,
        runtimeId: this.descriptor.id,
        sandbox: 'READ_ONLY' as const,
        approvalPolicy: 'NEVER' as const,
        networkAccess: false
      },
      externalTools: {
        network: false,
        webSearch: 'disabled' as const,
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      clientOperationId: input.clientOperationId
    });
  }

  async startRuntimeTurn(
    input: Parameters<NonNullable<AgentRuntimeAdapter['startRuntimeTurn']>>[0]
  ) {
    if (this.reviewStartFailure && input.run.purpose === 'TASK_REVIEW') {
      throw new AgentRuntimeDeliveryError('NOT_DELIVERED', this.reviewStartFailure);
    }
    this.runtimeStartCount += 1;
    return {
      serverInstanceId: this.runtimeServerId,
      providerSessionId: `runtime-session-${input.session.id}`,
      providerTurnId: `runtime-turn-${input.run.id}`,
      startedAt: '2026-07-13T00:00:01.000Z'
    };
  }

  private readonly runtimeTurnListeners = new Set<
    (event: AgentRuntimeTurnEvent) => void
  >();

  onRuntimeTurnEvent(listener: (event: AgentRuntimeTurnEvent) => void): () => void {
    this.runtimeTurnListeners.add(listener);
    return () => this.runtimeTurnListeners.delete(listener);
  }

  emitRuntimeTurnEvent(event: AgentRuntimeTurnEvent): void {
    for (const listener of this.runtimeTurnListeners) listener(event);
  }

  async interruptRuntimeTurn(): Promise<void> {
    this.runtimeInterruptCount += 1;
    if (this.runtimeInterruptFailure) throw this.runtimeInterruptFailure;
    await this.onRuntimeInterrupt?.();
  }

  releaseSession(): Promise<void> {
    this.runtimeReleaseCount += 1;
    return Promise.resolve();
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    this.threadCounter += 1;
    return this.store.updateAgentSession(input.localSessionId, {
      providerSessionId: `thread-${this.threadCounter}`,
      providerSessionTreeId: `thread-${this.threadCounter}`,
      status: 'IDLE',
      requestedSettings: input.settings,
      observedSettings: this.createdSessionObservedSettings
    }, `test-create-session:${input.localSessionId}:${this.threadCounter}`);
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    const session = await this.store.getAgentSession(ref.localSessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    return session;
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot> {
    return { session: await this.attachSession(ref), runs: [] };
  }

  async startTurn(input: StartAgentTurn): Promise<AgentTurn> {
    this.lastStart = input;
    this.startCount += 1;
    if (this.startFailure) {
      throw new Error(this.startFailure);
    }
    await this.store.updateRun(input.localRunId, {
      status: 'STARTING'
    }, `test-starting-turn:${input.localRunId}:${this.startCount}`);
    if (
      this.missingProviderSessionOnStart &&
      input.session.providerSessionId === this.missingProviderSessionOnStart
    ) {
      this.missingProviderSessionOnStart = undefined;
      throw new AgentProviderSessionMissingError(
        'turn/start',
        `thread not found: ${input.session.providerSessionId}`
      );
    }
    if (this.recoveryThenRejectStart) {
      const run = await this.store.getRun(input.localRunId);
      if (!run) throw new Error('Run not found.');
      await this.store.applyTaskRuntimeEvent(
        createDomainEvent({
          type: 'AGENT_MUTATION_AMBIGUOUS',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          source: 'provider',
          payload: {
            operation: 'turn/start',
            reason: 'Provider established recovery before rejecting startup.',
            automaticResubmission: false
          }
        }),
        `test-recovery:${run.id}`
      );
      throw new Error('provider failed after publishing recovery');
    }
    if (this.ambiguousStart) {
      throw new AgentMutationAmbiguousError(
        'turn/start',
        'Connection closed after submission.'
      );
    }
    this.turnCounter += 1;
    const providerTurnId = `turn-${this.turnCounter}`;
    await this.store.updateRun(input.localRunId, {
      providerTurnId,
      status: 'RUNNING'
    }, `test-start-turn:${input.localRunId}:${providerTurnId}`);
    return { localRunId: input.localRunId, providerTurnId };
  }

  steerTurn(input: SteerAgentTurn): Promise<void> {
    this.lastSteer = input;
    return Promise.resolve();
  }

  interruptTurn(_input: InterruptAgentTurn): Promise<void> {
    return Promise.resolve();
  }

  forkSession(_input: ForkAgentSession): Promise<AgentSessionRecord> {
    return Promise.reject(new Error('Session fork is not exercised by this fake.'));
  }

  syncGoal(_input: SyncAgentGoal): ReturnType<NonNullable<AgentRuntimeAdapter['syncGoal']>> {
    return Promise.reject(new Error('Goal sync is not exercised by this fake.'));
  }

  respondToInteraction(): Promise<void> {
    return Promise.resolve();
  }

  reconcile(): Promise<AgentReconciliationResult> {
    return Promise.resolve({
      reconciledSessionIds: [],
      recoveryRequiredSessionIds: []
    });
  }

  shutdown(): Promise<void> {
    this.shutdownCount += 1;
    return Promise.resolve();
  }
}

function runtimeCapabilities(): AgentRuntimeCapabilities {
  return {
    ...codexCapabilities(),
    promptRefinement: {
      maturity: 'unsupported',
      detail: 'The phase-four test adapter does not implement prompt refinement.'
    }
  };
}

async function initializeRepository(repositoryPath: string): Promise<void> {
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'task-monki@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Runtime test\n');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial commit']);
}

async function createTaskContext(
  store: SqliteTaskStore,
  dir: string,
  settings: AgentExecutionSettings
) {
  const repositoryDir = path.join(dir, 'repository');
  await fs.mkdir(repositoryDir, { recursive: true });
  const task = await store.createTask({
    title: 'Browser development boundary',
    prompt: 'Keep this turn inside the restricted boundary.',
    repositoryId: (await addTestRepository(store, repositoryDir)).id,
    agentSettings: settings
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: `codex/browser-boundary-${task.id}`,
    worktreePath: repositoryDir,
    baseSha: 'base'
  });
  return { task, iteration, worktree };
}

async function createRuntimeSession(
  runtime: TaskAgentRuntimeAccess,
  input: {
    task: Task;
    iteration: TaskIteration;
    worktree: WorktreeRecord;
    settings: AgentExecutionSettings;
  }
): Promise<AgentSessionRecord> {
  const id = `session-${input.task.id}`;
  const operationId = `test-create-session:${id}`;
  const settings = { ...input.settings, runtimeId: 'codex' };
  return runtime.createTaskSession({
    id,
    taskId: input.task.id,
    iterationId: input.iteration.id,
    worktreeId: input.worktree.id,
    worktreePath: input.worktree.worktreePath,
    runtimeId: 'codex',
    requestedSettings: settings,
    executionContext: {
      attestation: { status: 'ATTESTED' },
      repositoryAccess: 'WRITE',
      primaryCwd: input.worktree.worktreePath,
      readRoots: [
        {
          canonicalPath: input.worktree.worktreePath,
          kind: 'WORKTREE',
          entityId: input.worktree.id
        }
      ],
      managedAttachments: [],
      permissionProfileHash: 'a'.repeat(64),
      modelSettings: settings,
      externalTools: {
        network: settings.networkAccess === true,
        webSearch: 'disabled',
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      clientOperationId: operationId
    },
    operationId
  });
}

async function createRuntimeRun(
  runtime: TaskAgentRuntimeAccess,
  input: {
    task: Task;
    iteration: TaskIteration;
    worktree: WorktreeRecord;
    session: AgentSessionRecord;
    mode: 'IMPLEMENTATION';
    prompt: string;
    settings: AgentExecutionSettings;
    serverInstanceId?: string;
    status?: 'QUEUED' | 'STARTING' | 'RUNNING' | 'RECOVERY_REQUIRED';
    observedSettings?: AgentExecutionSettings;
  }
) {
  const id = `run-${input.task.id}`;
  let run = await runtime.createTaskRun({
    id,
    taskId: input.task.id,
    iterationId: input.iteration.id,
    worktreeId: input.worktree.id,
    sessionId: input.session.id,
    mode: input.mode,
    prompt: input.prompt,
    requestedSettings: input.settings,
    operationId: `test-create-run:${id}`
  });
  const status = input.status ?? 'QUEUED';
  if (status !== 'QUEUED') {
    await runtime.updateAgentSession(
      input.session.id,
      {
        providerSessionId: `thread-${input.session.id}`,
        providerSessionTreeId: `thread-${input.session.id}`,
        materialized: true,
        status: 'ACTIVE'
      },
      `test-materialize-session:${input.session.id}`
    );
  }
  if (status === 'STARTING' || status === 'RUNNING') {
    run = await runtime.updateRun(
      id,
      {
        status: 'STARTING',
        serverInstanceId: input.serverInstanceId,
        observedSettings: input.observedSettings
      },
      `test-start-run:${id}`
    );
  } else if (status === 'RECOVERY_REQUIRED') {
    run = await runtime.updateRun(
      id,
      { status: 'STARTING', serverInstanceId: input.serverInstanceId },
      `test-start-recovery-run:${id}`
    );
    run = await runtime.updateRun(
      id,
      {
        status,
        serverInstanceId: input.serverInstanceId,
        recoveryState: 'REQUIRES_USER_ACTION',
        observedSettings: input.observedSettings
      },
      `test-recover-run:${id}`
    );
  } else if (input.observedSettings) {
    run = await runtime.updateRun(
      id,
      { observedSettings: input.observedSettings },
      `test-observe-run:${id}`
    );
  }
  if (status === 'RUNNING') {
    run = await runtime.updateRun(
      id,
      { status: 'RUNNING', providerTurnId: `turn-${id}` },
      `test-acknowledge-run:${id}`
    );
  }
  return run;
}

async function terminal(
  store: TaskAgentRuntimeAccess,
  run: { id: string; taskId: string; iterationId: string; worktreeId: string; sessionId: string },
  type: 'AGENT_RUN_COMPLETED' | 'AGENT_RUN_FAILED' | 'AGENT_RUN_INTERRUPTED'
): Promise<void> {
  await store.applyTaskRuntimeEvent(
    createDomainEvent({
      type,
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      agentSessionId: run.sessionId,
      source: 'provider',
      payload: type === 'AGENT_RUN_FAILED' ? { error: 'failed' } : {}
    }),
    `test-terminal:${run.id}:${type}`
  );
}

const persistenceByTaskStore = new WeakMap<
  SqliteTaskStore,
  ApplicationPersistence
>();

async function openOrchestratorTaskStore(
  profileRoot: string
): Promise<SqliteTaskStore> {
  const persistence = await openTestPersistence(profileRoot);
  persistenceByTaskStore.set(persistence.tasks, persistence);
  return persistence.tasks;
}

function bindTaskRuntime(store: SqliteTaskStore): {
  store: SqliteAgentRuntimeStore;
  task: TaskAgentRuntimeAccess;
} {
  const persistence = persistenceByTaskStore.get(store);
  if (!persistence) {
    throw new Error('AgentOrchestrator test store has no persistence owner.');
  }
  const runtimeStore = persistence.agentRuntime;
  const task = persistence.taskRuntime;
  vi.spyOn(runtimeStore, 'taskAgentRuntimeAccess').mockReturnValue(task);
  return { store: runtimeStore, task };
}

function onePixelPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}
