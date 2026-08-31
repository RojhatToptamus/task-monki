import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeAdapter,
  StartAgentRuntimeTurn,
  StartedAgentRuntimeTurn
} from '../agent/AgentRuntimeAdapter';
import type {
  AgentRuntimeTurnEvent,
  BuildAgentRuntimeExecutionContextInput
} from '../agent/AgentRuntimeCoordinator';
import { AppEventBus } from '../runner/AppEventBus';
import { SqliteAgentRuntimeStore } from '../storage/SqliteAgentRuntimeStore';
import { ScriptedAgentRuntimeAdapter } from '../../testSupport/taskMonkiScenario';
import {
  openTestPersistence,
  taskManagerPersistenceOptions
} from '../../testSupport/persistenceFixture';
import type {
  BuiltInAgentProfileId,
  DiscourseAgentSelectionInput
} from '../../shared/discourse';
import { TaskManagerService } from './TaskManagerService';

function selections(
  ...agentProfileIds: BuiltInAgentProfileId[]
): DiscourseAgentSelectionInput[] {
  return agentProfileIds.map((agentProfileId) => ({ agentProfileId }));
}

class DiscourseCapableRuntimeAdapter extends ScriptedAgentRuntimeAdapter {
  readonly runtimeStarts: StartAgentRuntimeTurn[] = [];
  readonly interruptedRunIds: string[] = [];
  private readonly runtimeListeners = new Set<
    (event: AgentRuntimeTurnEvent) => void
  >();

  constructor(private readonly runtimeStore: SqliteAgentRuntimeStore) {
    super(runtimeStore.taskAgentRuntimeAccess());
  }

  async buildExecutionContext(input: BuildAgentRuntimeExecutionContextInput) {
    return {
      attestation: { status: 'ATTESTED' as const },
      repositoryAccess: 'READ_ONLY' as const,
      primaryCwd: input.primaryCwd,
      readRoots: input.readRoots,
      managedAttachments: [],
      permissionProfileHash: 'a'.repeat(64),
      modelSettings: {
        ...input.modelSettings,
        runtimeId: this.descriptor.id,
        sandbox: 'READ_ONLY' as const,
        networkAccess: false,
        approvalPolicy: 'NEVER'
      },
      externalTools: {
        network: false,
        webSearch: 'disabled' as const,
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      clientOperationId: input.clientOperationId
    };
  }

  async forkSession(): Promise<never> {
    throw new Error('Discourse does not fork Task sessions.');
  }

  async syncGoal(): Promise<never> {
    throw new Error('Discourse does not synchronize Task goals.');
  }

  async startRuntimeTurn(
    input: StartAgentRuntimeTurn
  ): Promise<StartedAgentRuntimeTurn> {
    this.runtimeStarts.push(input);
    const sequence = this.runtimeStarts.length;
    return {
      serverInstanceId: 'server-discourse',
      providerSessionId: `thread-${sequence}`,
      providerTurnId: `turn-${sequence}`,
      startedAt: new Date().toISOString()
    };
  }

  async interruptRuntimeTurn(input: Parameters<
    NonNullable<AgentRuntimeAdapter['interruptRuntimeTurn']>
  >[0]): Promise<void> {
    this.interruptedRunIds.push(input.run.id);
  }

  onRuntimeTurnEvent(listener: (event: AgentRuntimeTurnEvent) => void): () => void {
    this.runtimeListeners.add(listener);
    return () => this.runtimeListeners.delete(listener);
  }

  emit(event: AgentRuntimeTurnEvent): void {
    for (const listener of this.runtimeListeners) listener(event);
  }

  async complete(runId: string, body: string): Promise<void> {
    let run = await this.requireRuntimeRun(runId);
    const output = await this.runtimeStore.getArtifact(run.outputArtifactId);
    if (!output) throw new Error(`Runtime output artifact not found: ${run.outputArtifactId}`);
    await this.runtimeStore.updateArtifact({
      artifactId: output.id,
      expectedRevision: output.recordRevision,
      clientOperationId: `test-output:${run.id}`,
      content: body
    });
    run = await this.requireRuntimeRun(run.id);
    const completedAt = new Date().toISOString();
    run = await this.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        recoveryState: 'NONE',
        providerTerminalSource: 'TEST_RUNTIME_EVENT',
        lastEventAt: completedAt,
        endedAt: completedAt
      },
      `test-terminal:${run.id}`
    );
    this.emit({
      type: 'TERMINAL',
      runId: run.id,
      providerTurnId: requireProviderTurnId(run.providerTurnId),
      status: 'completed',
      completedAt
    });
  }

  async confirmInterrupted(runId: string): Promise<void> {
    let run = await this.requireRuntimeRun(runId);
    const completedAt = new Date().toISOString();
    run = await this.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'INTERRUPTED',
        delivery: 'TERMINAL',
        interruptDelivery: 'TERMINAL',
        recoveryState: 'NONE',
        terminalReason: 'Provider confirmed interruption.',
        providerTerminalSource: 'TEST_RUNTIME_EVENT',
        lastEventAt: completedAt,
        endedAt: completedAt
      },
      `test-interrupted:${run.id}`
    );
    this.emit({
      type: 'TERMINAL',
      runId: run.id,
      providerTurnId: requireProviderTurnId(run.providerTurnId),
      status: 'interrupted',
      error: 'Provider confirmed interruption.',
      completedAt
    });
  }

  private async requireRuntimeRun(runId: string) {
    const run = await this.runtimeStore.getRun(runId);
    if (!run) throw new Error(`Runtime run not found: ${runId}`);
    return run;
  }
}

describe('TaskManagerService discourse runtime composition', () => {
  it('recovers a clean shutdown latch on startup and latches before closing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-lifecycle-'));
    const persistence = await openTestPersistence(path.join(root, 'profile'));
    const taskStore = persistence.tasks;
    const runtimeStore = persistence.agentRuntime;
    const discourseStore = persistence.discourse;
    await runtimeStore.init();
    await runtimeStore.setShutdownLatched(true, 'previous-process-shutdown');
    const runtimeAdapter = new DiscourseCapableRuntimeAdapter(runtimeStore);
    const service = new TaskManagerService(taskStore, root, undefined, {
      ...taskManagerPersistenceOptions(persistence),
      agentRuntimeAdapters: [runtimeAdapter],
      discourseStore
    });

    await service.init();
    expect((await runtimeStore.snapshot()).shutdownLatched).toBe(false);

    await service.shutdown();
    await persistence.close();
    const reopened = await openTestPersistence(path.join(root, 'profile'));
    expect((await reopened.agentRuntime.snapshot()).shutdownLatched).toBe(true);
    await reopened.close();
  });

  it('dispatches every Panel job through the shared runtime without racing the wave', async () => {
    const fixture = await createFixture('panel-dispatch');
    try {
      const conversation = await fixture.service.createDiscourseConversation({
        title: 'Panel dispatch',
        defaultPolicy: 'PANEL',
        agents: selections('builtin.lead', 'builtin.skeptic'),
        clientOperationId: 'create-panel'
      });
      const preview = await fixture.service.previewDiscourseContext({
        conversationId: conversation.id,
        messageContext: []
      });
      await fixture.service.sendDiscourseMessage({
        conversationId: conversation.id,
        body: 'Compare the two persistence designs independently.',
        context: [],
        clientMessageId: 'panel-message',
        policy: 'PANEL',
        agents: selections('builtin.lead', 'builtin.skeptic'),
        previewFingerprint: preview.fingerprint
      });

      await waitFor(() => fixture.runtimeAdapter.runtimeStarts.length === 2);
      await waitFor(async () =>
        (await fixture.runtimeStore.snapshot()).runs.every(
          (run) => run.status === 'RUNNING'
        )
      );
      expect(fixture.runtimeAdapter.runtimeStarts.map(({ run }) => run.scope)).toEqual([
        expect.objectContaining({ kind: 'DISCOURSE', conversationId: conversation.id }),
        expect.objectContaining({ kind: 'DISCOURSE', conversationId: conversation.id })
      ]);
      expect((await fixture.runtimeStore.snapshot()).runs.map((run) => run.status)).toEqual([
        'RUNNING',
        'RUNNING'
      ]);
    } finally {
      await fixture.service.shutdown();
    }
  });

  it('projects a provider terminal from the shared runtime into the conversation', async () => {
    const fixture = await createFixture('terminal');
    try {
      const { conversationId } = await sendDirectMessage(fixture, 'Complete this answer.');
      await waitFor(() => fixture.runtimeAdapter.runtimeStarts.length === 1);
      const run = fixture.runtimeAdapter.runtimeStarts[0]!.run;
      await waitForActiveJob(fixture, conversationId, run.id);

      await fixture.runtimeAdapter.complete(run.id, 'A complete provider answer.');

      await waitFor(async () => {
        const aggregate = await fixture.discourseStore.getConversation(conversationId);
        return (
          aggregate.jobs[0]?.status === 'COMPLETED' &&
          aggregate.waves[0]?.status === 'SETTLED'
        );
      });
      const aggregate = await fixture.discourseStore.getConversation(conversationId);
      const messages = await fixture.discourseStore.listMessages({
        conversationId,
        limit: 100
      });
      expect(messages.messages.at(-1)).toMatchObject({
        author: { kind: 'AGENT' },
        body: 'A complete provider answer.'
      });
      expect(aggregate.waves[0]).toMatchObject({ status: 'SETTLED' });
      expect(await fixture.runtimeStore.getRun(run.id)).toMatchObject({
        status: 'COMPLETED',
        delivery: 'TERMINAL'
      });
    } finally {
      await fixture.service.shutdown();
    }
  });

  it('persists a stop through the shared runtime and settles on provider interruption', async () => {
    const fixture = await createFixture('interrupt');
    try {
      const { conversationId, waveId } = await sendDirectMessage(
        fixture,
        'Keep working until stopped.'
      );
      await waitFor(() => fixture.runtimeAdapter.runtimeStarts.length === 1);
      const run = fixture.runtimeAdapter.runtimeStarts[0]!.run;
      await waitForActiveJob(fixture, conversationId, run.id);

      await expect(fixture.service.stopDiscourseWave({
        conversationId,
        waveId,
        clientOperationId: 'stop-active-wave',
        reason: 'User stopped the response.'
      })).resolves.toMatchObject({ status: 'STOPPING' });
      expect(fixture.runtimeAdapter.interruptedRunIds).toEqual([run.id]);
      expect(await fixture.runtimeStore.getRun(run.id)).toMatchObject({
        status: 'INTERRUPTING',
        interruptDelivery: 'ACKNOWLEDGED'
      });

      await fixture.runtimeAdapter.confirmInterrupted(run.id);
      await waitFor(async () => {
        const aggregate = await fixture.discourseStore.getConversation(conversationId);
        return aggregate.waves[0]?.status === 'SETTLED';
      });
      expect(await fixture.runtimeStore.getRun(run.id)).toMatchObject({
        status: 'INTERRUPTED',
        delivery: 'TERMINAL',
        interruptDelivery: 'TERMINAL'
      });
      expect(await fixture.discourseStore.getConversation(conversationId)).toMatchObject({
        waves: [{ status: 'SETTLED', outcome: 'CANCELED' }],
        jobs: [{ status: 'CANCELED', delivery: 'TERMINAL' }]
      });
    } finally {
      await fixture.service.shutdown();
    }
  });

  it('joins an admitted Discourse deletion before latching runtime shutdown', async () => {
    const fixture = await createFixture('delete-shutdown');
    const conversation = await fixture.service.createDiscourseConversation({
      title: 'Delete while shutting down',
      defaultPolicy: 'NONE',
      agents: [],
      clientOperationId: 'create-delete-shutdown'
    });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    const deleteConversation = fixture.discourseStore.deleteConversation.bind(
      fixture.discourseStore
    );
    const delayedDelete = vi.spyOn(fixture.discourseStore, 'deleteConversation').mockImplementation(
      async (input) => {
        markDeleteStarted();
        await deleteGate;
        return deleteConversation(input);
      }
    );

    const deletion = fixture.service.deleteDiscourseConversation({
      conversationId: conversation.id,
      expectedRevision: conversation.recordRevision,
      clientOperationId: 'delete-during-shutdown'
    });
    await deleteStarted;
    let shutdownSettled = false;
    const shutdown = fixture.service.shutdown().then(() => {
      shutdownSettled = true;
    });
    expect(() => fixture.runtimeAdapter.emit({
      type: 'DELTA',
      runId: 'late-run',
      providerTurnId: 'late-turn',
      text: 'late shutdown output',
      observedAt: new Date().toISOString()
    })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdownSettled).toBe(false);

    releaseDelete();
    await expect(deletion).resolves.toBeUndefined();
    await shutdown;
    await fixture.persistence.close();
    const reopened = await openTestPersistence(
      fixture.persistence.paths.profileRoot
    );
    expect(await reopened.discourse.getConversationTombstone(conversation.id)).toMatchObject({
      conversationId: conversation.id
    });
    expect((await reopened.agentRuntime.snapshot()).shutdownLatched).toBe(true);
    await reopened.close();
    delayedDelete.mockRestore();
  });

  it('joins a fired Discourse delta flush before closing runtime storage', async () => {
    const fixture = await createFixture('delta-flush-shutdown');
    let releaseFlush: () => void = () => undefined;
    const deltaEvents: unknown[] = [];
    let storeClosed = false;
    let readAfterClose = false;
    let eventAfterClose = false;
    let restoreGetRun: (() => void) | undefined;
    const disposeEvents = fixture.events.on((event) => {
      if (event.type !== 'discourse.delta') return;
      deltaEvents.push(event);
      if (storeClosed) eventAfterClose = true;
    });
    const readRun = fixture.runtimeStore.getRun.bind(fixture.runtimeStore);
    const closeStore = fixture.runtimeStore.close.bind(fixture.runtimeStore);
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      markFlushStarted = resolve;
    });
    let matchingReads = 0;
    const close = vi.spyOn(fixture.runtimeStore, 'close').mockImplementation(
      async () => {
        storeClosed = true;
        await closeStore();
      }
    );

    try {
      const { conversationId } = await sendDirectMessage(
        fixture,
        'Stream an answer while shutdown starts.'
      );
      await waitFor(() => fixture.runtimeAdapter.runtimeStarts.length === 1);
      const run = fixture.runtimeAdapter.runtimeStarts[0]!.run;
      await waitForActiveJob(fixture, conversationId, run.id);
      const activeRun = await fixture.runtimeStore.getRun(run.id);
      const providerTurnId = requireProviderTurnId(activeRun?.providerTurnId);
      const getRun = vi.spyOn(fixture.runtimeStore, 'getRun').mockImplementation(
        async (runId) => {
          if (runId === run.id) {
            matchingReads += 1;
            if (matchingReads === 2) {
              markFlushStarted();
              await flushGate;
              if (storeClosed) readAfterClose = true;
            }
          }
          return readRun(runId);
        }
      );
      restoreGetRun = () => getRun.mockRestore();

      fixture.runtimeAdapter.emit({
        type: 'DELTA',
        runId: run.id,
        providerTurnId,
        text: 'A durable partial answer.',
        observedAt: new Date().toISOString()
      });
      await flushStarted;

      let shutdownSettled = false;
      const shutdown = fixture.service.shutdown().then(() => {
        shutdownSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(shutdownSettled).toBe(false);
      expect(storeClosed).toBe(false);
      expect(deltaEvents).toEqual([]);

      releaseFlush();
      await shutdown;

      expect(storeClosed).toBe(true);
      expect(readAfterClose).toBe(false);
      expect(eventAfterClose).toBe(false);
      expect(deltaEvents).toHaveLength(1);

      fixture.runtimeAdapter.emit({
        type: 'DELTA',
        runId: run.id,
        providerTurnId,
        text: 'Output after shutdown.',
        observedAt: new Date().toISOString()
      });
      expect(matchingReads).toBe(2);
      expect(deltaEvents).toHaveLength(1);
    } finally {
      releaseFlush();
      await fixture.service.shutdown();
      disposeEvents();
      restoreGetRun?.();
      close.mockRestore();
    }
  });

  it('backs off and retries a recovered provider dispatch instead of spinning', async () => {
    const fixture = await createFixture('retry');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const readConversation = fixture.discourseStore.getConversation.bind(
      fixture.discourseStore
    );
    const leaseQueueEntry = fixture.runtimeStore.leaseQueueEntry.bind(
      fixture.runtimeStore
    );
    let releaseLease!: () => void;
    const leaseGate = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    const lease = vi
      .spyOn(fixture.runtimeStore, 'leaseQueueEntry')
      .mockImplementation(async (...args) => {
        await leaseGate;
        return leaseQueueEntry(...args);
      });
    let failNextLeasedRead = true;
    const storeRead = vi.spyOn(fixture.discourseStore, 'getConversation').mockImplementation(
      async (conversationId) => {
        const runtime = await fixture.runtimeStore.snapshot();
        if (
          failNextLeasedRead &&
          runtime.queueEntries.some((entry) => entry.status === 'LEASED')
        ) {
          failNextLeasedRead = false;
          throw new Error('Temporary discourse-store read failure.');
        }
        return readConversation(conversationId);
      }
    );
    try {
      await sendDirectMessage(fixture, 'Retry this after the transient failure.');
      releaseLease();

      await waitFor(() => fixture.runtimeAdapter.runtimeStarts.length === 1);
      const run = fixture.runtimeAdapter.runtimeStarts[0]!.run;
      await waitFor(async () =>
        (await fixture.runtimeStore.getRun(run.id))?.status === 'RUNNING'
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('retrying in 125ms'),
        expect.any(Error)
      );
      expect((await fixture.runtimeStore.snapshot()).runs).toEqual([
        expect.objectContaining({ status: 'RUNNING' })
      ]);
    } finally {
      releaseLease();
      await fixture.service.shutdown();
      lease.mockRestore();
      storeRead.mockRestore();
      error.mockRestore();
    }
  });
});

async function createFixture(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-discourse-${name}-`));
  const persistence = await openTestPersistence(path.join(root, 'profile'));
  const taskStore = persistence.tasks;
  const runtimeStore = persistence.agentRuntime;
  const discourseStore = persistence.discourse;
  const runtimeAdapter = new DiscourseCapableRuntimeAdapter(runtimeStore);
  const events = new AppEventBus();
  const service = new TaskManagerService(taskStore, root, events, {
    ...taskManagerPersistenceOptions(persistence),
    agentRuntimeAdapters: [runtimeAdapter],
    discourseStore,
    discourseWorkspaceRoot: path.join(root, 'discourse-workspaces')
  });
  await service.init();
  return {
    root,
    persistence,
    taskStore,
    runtimeStore,
    discourseStore,
    runtimeAdapter,
    events,
    service
  };
}

async function sendDirectMessage(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  body: string
): Promise<{ conversationId: string; waveId: string }> {
  const conversation = await fixture.service.createDiscourseConversation({
    title: 'Direct response',
    defaultPolicy: 'DIRECT',
    agents: selections('builtin.lead'),
    clientOperationId: `create-${body}`
  });
  const preview = await fixture.service.previewDiscourseContext({
    conversationId: conversation.id,
    messageContext: []
  });
  const sent = await fixture.service.sendDiscourseMessage({
    conversationId: conversation.id,
    body,
    context: [],
    clientMessageId: `message-${body}`,
    policy: 'DIRECT',
    agents: selections('builtin.lead'),
    previewFingerprint: preview.fingerprint
  });
  if (!sent.wave) throw new Error('Agent Discourse send did not create a response wave.');
  const sentWaveId = sent.wave.id;
  const aggregate = await fixture.discourseStore.getConversation(conversation.id);
  const wave = aggregate.waves.find((candidate) => candidate.id === sentWaveId);
  if (!wave) throw new Error('Discourse wave was not persisted.');
  return { conversationId: conversation.id, waveId: wave.id };
}

function requireProviderTurnId(providerTurnId: string | undefined): string {
  if (!providerTurnId) throw new Error('Runtime run has no provider turn id.');
  return providerTurnId;
}

async function waitForActiveJob(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  conversationId: string,
  runId: string
): Promise<void> {
  await waitFor(async () => {
    const [run, aggregate] = await Promise.all([
      fixture.runtimeStore.getRun(runId),
      fixture.discourseStore.getConversation(conversationId)
    ]);
    return (
      run?.status === 'RUNNING' &&
      aggregate.jobs.some(
        (job) => job.runId === runId && job.status === 'RUNNING'
      )
    );
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous dispatch.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
