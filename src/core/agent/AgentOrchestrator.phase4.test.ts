import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentModel,
  AgentPreflight,
  AgentProviderCapabilities,
  AgentSessionRecord,
  AgentSessionSnapshot
} from '../../shared/agent';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  type AgentProviderAdapter,
  type AgentReconciliationResult,
  type AgentSessionRef,
  type AgentTurn,
  type CreateAgentSession,
  type ForkAgentSession,
  type InterruptAgentTurn,
  type StartAgentReview,
  type StartAgentTurn,
  type SteerAgentTurn
} from './AgentProviderAdapter';
import { AgentOrchestrator } from './AgentOrchestrator';
import { codexCapabilities } from './codex/codexCapabilities';

describe('AgentOrchestrator Phase 4', () => {
  it('normalizes legacy codex adapter provider settings before starting a turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-provider-normalize-'));
    const store = new FileTaskStore(dir);
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Normalize provider',
      prompt: 'Start with legacy settings.',
      repositoryPath: dir,
      agentSettings: {
        model: 'test-model',
        modelProvider: 'codex',
        reasoningEffort: 'high'
      }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/provider-normalize',
      worktreePath: dir,
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

  it('preserves session lineage across steer, continue, forked retry, and detached review', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-phase4-'));
    const store = new FileTaskStore(dir);
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Phase 4',
      prompt: 'Implement continuation controls.',
      repositoryPath: dir,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/phase-4',
      worktreePath: dir,
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

    await terminal(store, first, 'AGENT_RUN_INTERRUPTED');
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

    await terminal(store, continued, 'AGENT_RUN_FAILED');
    const forked = await orchestrator.forkAndStartTurn({
      task,
      iteration,
      worktree,
      sourceRun: (await store.getRun(continued.id))!,
      retryStrategy: 'FORK',
      mode: 'RETRY',
      prompt: 'Try an alternative approach.',
      settings: task.agentSettings
    });
    const forkSession = await store.getAgentSession(forked.sessionId);
    expect(forkSession?.role).toBe('ALTERNATIVE');
    expect(forkSession?.forkedFromSessionId).toBe(first.sessionId);
    expect(forked.retryOfRunId).toBe(continued.id);

    await terminal(store, forked, 'AGENT_RUN_COMPLETED');
    const reviewed = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun: (await store.getRun(forked.id))!,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: {
        ...task.agentSettings,
        sandbox: 'READ_ONLY'
      }
    });
    const reviewSession = await store.getAgentSession(reviewed.sessionId);
    expect(reviewSession?.role).toBe('REVIEW');
    expect(reviewSession?.parentSessionId).toBe(forkSession?.id);
    expect(reviewed.mode).toBe('REVIEW');
  });

  it('recreates a missing provider session and retries the same follow-up run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-missing-session-'));
    const store = new FileTaskStore(dir);
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Missing provider thread',
      prompt: 'Continue even when provider session storage was evicted.',
      repositoryPath: dir,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/missing-provider-thread',
      worktreePath: dir,
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
    await terminal(store, first, 'AGENT_RUN_COMPLETED');
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

    const recoveredSession = (await store.getAgentSession(first.sessionId))!;
    const snapshot = await store.snapshot();
    expect(continued.id).toBeTruthy();
    expect(continued.sessionId).toBe(first.sessionId);
    expect(continued.status).toBe('RUNNING');
    expect(recoveredSession.providerSessionId).toBe('thread-2');
    expect(recoveredSession.providerSessionId).not.toBe(originalSession.providerSessionId);
    expect(recoveredSession.relationshipDetail).toContain('was missing during turn/start');
    expect(
      snapshot.events.some(
        (event) =>
          event.type === 'AGENT_RUN_FAILED' &&
          event.runId === continued.id
      )
    ).toBe(false);
  });

  it('records ambiguous turn submission as recovery-required without false failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-phase4-ambiguous-'));
    const store = new FileTaskStore(dir);
    const adapter = new Phase4Adapter(store);
    adapter.ambiguousStart = true;
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Ambiguous start',
      prompt: 'Do not duplicate this mutation.',
      repositoryPath: dir,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/ambiguous',
      worktreePath: dir,
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
  });
});

class Phase4Adapter implements AgentProviderAdapter {
  ambiguousStart = false;
  missingProviderSessionOnStart?: string;
  lastStart?: StartAgentTurn;
  lastSteer?: SteerAgentTurn;
  private turnCounter = 0;
  private threadCounter = 0;

  constructor(private readonly store: FileTaskStore) {}

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  preflight(): Promise<AgentPreflight> {
    return Promise.resolve({
      provider: 'codex',
      ready: true,
      capabilities: codexCapabilities(),
      problems: [],
      warnings: []
    });
  }

  capabilities(): Promise<AgentProviderCapabilities> {
    return Promise.resolve(codexCapabilities());
  }

  listModels(): Promise<AgentModel[]> {
    return Promise.resolve([
      {
        id: 'test-model',
        provider: 'codex',
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

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    this.threadCounter += 1;
    return this.store.updateAgentSession(input.localSessionId, {
      providerSessionId: `thread-${this.threadCounter}`,
      providerSessionTreeId: `thread-${this.threadCounter}`,
      status: 'IDLE',
      requestedSettings: input.settings
    });
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
    });
    return { localRunId: input.localRunId, providerTurnId };
  }

  steerTurn(input: SteerAgentTurn): Promise<void> {
    this.lastSteer = input;
    return Promise.resolve();
  }

  interruptTurn(_input: InterruptAgentTurn): Promise<void> {
    return Promise.resolve();
  }

  async forkSession(input: ForkAgentSession): Promise<AgentSessionRecord> {
    this.threadCounter += 1;
    return this.store.updateAgentSession(input.localSessionId, {
      providerSessionId: `thread-${this.threadCounter}`,
      providerSessionTreeId: `thread-${this.threadCounter}`,
      status: 'IDLE',
      requestedSettings: input.settings
    });
  }

  async startReview(input: StartAgentReview): Promise<AgentTurn> {
    this.threadCounter += 1;
    this.turnCounter += 1;
    const providerTurnId = `review-${this.turnCounter}`;
    await this.store.updateAgentSession(input.reviewSessionId, {
      providerSessionId: `review-thread-${this.threadCounter}`,
      providerSessionTreeId: `review-thread-${this.threadCounter}`,
      status: 'ACTIVE'
    });
    await this.store.updateRun(input.localRunId, {
      providerTurnId,
      status: 'RUNNING'
    });
    return { localRunId: input.localRunId, providerTurnId };
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
    return Promise.resolve();
  }
}

async function terminal(
  store: FileTaskStore,
  run: { id: string; taskId: string; iterationId: string; worktreeId: string; sessionId: string },
  type: 'AGENT_RUN_COMPLETED' | 'AGENT_RUN_FAILED' | 'AGENT_RUN_INTERRUPTED'
): Promise<void> {
  await store.appendEvent(
    createDomainEvent({
      type,
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      agentSessionId: run.sessionId,
      source: 'provider',
      payload: type === 'AGENT_RUN_FAILED' ? { error: 'failed' } : {}
    })
  );
}
