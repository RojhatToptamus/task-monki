import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedAgentProviderAdapter } from '../../testSupport/taskMonkiScenario';
import type { RunRecord } from '../../shared/contracts';
import type { AgentExecutionContext, AgentSchedulerQueueEntry } from '../../shared/agentRuntime';
import { AppEventBus } from '../runner/AppEventBus';
import { FileAgentRuntimeStore } from '../storage/FileAgentRuntimeStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { createDomainEvent } from '../storage/domainEvent';
import { AgentOrchestrator } from './AgentOrchestrator';
import { createAgentSessionAccessEpoch } from './AgentRuntimeOwnership';
import { AgentTurnScheduler } from './AgentTurnScheduler';

describe('AgentOrchestrator durable task scheduler', () => {
  it('queues beyond global capacity, starts after terminal evidence, and cancels queued work without provider delivery', async () => {
    const fixture = await createFixture();
    const contexts = await Promise.all([
      createTaskContext(fixture, 'one'),
      createTaskContext(fixture, 'two'),
      createTaskContext(fixture, 'three'),
      createTaskContext(fixture, 'four')
    ]);
    const runs: RunRecord[] = [];
    for (const context of contexts) {
      runs.push(await fixture.orchestrator.startTurn(turnInput(context)));
    }

    await waitFor(() => fixture.adapter.startedTurns.length === 2);
    expect(fixture.adapter.startedTurns.map((turn) => turn.localRunId)).toEqual([
      runs[0]!.id,
      runs[1]!.id
    ]);
    expect((await fixture.runtime.getRun(runs[2]!.id))?.status).toBe('QUEUED');
    expect((await fixture.runtime.getRun(runs[3]!.id))?.status).toBe('QUEUED');

    await fixture.orchestrator.interruptRun(runs[3]!.id);
    await waitFor(async () => (await fixture.runtime.getRun(runs[3]!.id))?.status === 'INTERRUPTED');
    expect(fixture.adapter.startedTurns.some((turn) => turn.localRunId === runs[3]!.id)).toBe(false);
    expect(queueFor(await fixture.runtime.snapshot(), runs[3]!.id)?.status).toBe('CANCELED');
    expect((await fixture.runtime.getRun(runs[3]!.id))?.delivery).toBe('NOT_DELIVERED');

    await completeTaskRun(fixture, runs[0]!);
    await waitFor(() => fixture.adapter.startedTurns.length === 3);
    expect(fixture.adapter.startedTurns[2]?.localRunId).toBe(runs[2]!.id);
    expect(queueFor(await fixture.runtime.snapshot(), runs[0]!.id)?.status).toBe('SETTLED');
  });

  it('dispatches detached reviews through the durable queue with exact target metadata', async () => {
    const fixture = await createFixture();
    const context = await createTaskContext(fixture, 'review');
    const source = await fixture.orchestrator.startTurn(turnInput(context));
    await waitFor(async () => (await fixture.runtime.getRun(source.id))?.delivery === 'ACKNOWLEDGED');
    await completeTaskRun(fixture, source);
    await waitFor(async () => queueFor(await fixture.runtime.snapshot(), source.id)?.status === 'SETTLED');

    const target = { type: 'BASE_BRANCH' as const, branch: 'main' };
    const review = await fixture.orchestrator.startReview({
      ...context,
      sourceRun: (await fixture.store.getRun(source.id))!,
      target,
      settings: context.task.agentSettings
    });

    await waitFor(() => fixture.adapter.startedReviews.length === 1);
    expect(fixture.adapter.startedReviews[0]).toMatchObject({
      localRunId: review.id,
      target
    });
    await waitFor(async () => (await fixture.runtime.getRun(review.id))?.delivery === 'ACKNOWLEDGED');
    expect(await fixture.runtime.getRun(review.id)).toMatchObject({
      purpose: 'TASK_REVIEW',
      taskReviewTarget: target,
      delivery: 'ACKNOWLEDGED'
    });
  });

  it('releases a crash-leased but unsubmitted task turn and dispatches it once after restart', async () => {
    const fixture = await createFixture();
    const run = await prepareCrashLeasedTask(fixture, 'restart-safe');
    const startsBeforeRestart = fixture.adapter.startedTurns.length;

    const restarted = new AgentOrchestrator(
      fixture.store,
      fixture.events,
      fixture.adapter,
      { runtimeStore: fixture.runtime, scheduler: fixture.scheduler }
    );
    await restarted.initialize();
    await waitFor(() => fixture.adapter.startedTurns.length === startsBeforeRestart + 1);
    expect(fixture.adapter.startedTurns.at(-1)?.localRunId).toBe(run.id);
    await waitFor(async () => (await fixture.runtime.getRun(run.id))?.delivery === 'ACKNOWLEDGED');
    expect((await fixture.runtime.getRun(run.id))?.delivery).toBe('ACKNOWLEDGED');
  });

  it('does not replay a crash-leased task turn after durable provider-submission intent', async () => {
    const fixture = await createFixture();
    const run = await prepareCrashLeasedTask(fixture, 'restart-ambiguous');
    const startsBeforeRestart = fixture.adapter.startedTurns.length;
    const runtimeRun = (await fixture.runtime.getRun(run.id))!;
    await fixture.runtime.updateRun(
      run.id,
      runtimeRun.recordRevision,
      { status: 'STARTING', delivery: 'SENDING', startedAt: new Date().toISOString() },
      'test-provider-submission-intent'
    );

    const restarted = new AgentOrchestrator(
      fixture.store,
      fixture.events,
      fixture.adapter,
      { runtimeStore: fixture.runtime, scheduler: fixture.scheduler }
    );
    await restarted.initialize();

    expect(fixture.adapter.startedTurns).toHaveLength(startsBeforeRestart);
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      delivery: 'AMBIGUOUS',
      recoveryState: 'REQUIRES_USER_ACTION'
    });
    expect((await fixture.store.getRun(run.id))?.status).toBe('RECOVERY_REQUIRED');
    expect(queueFor(await fixture.runtime.snapshot(), run.id)?.status).toBe('LEASED');
  });

  it('fails a task projection whose generic runtime record was never published without provider delivery', async () => {
    const fixture = await createFixture();
    const { taskRun } = await createUnlinkedTaskRun(fixture, 'missing-runtime');

    await fixture.orchestrator.initialize();

    expect(fixture.adapter.startedTurns).toEqual([]);
    expect(await fixture.store.getRun(taskRun.id)).toMatchObject({
      status: 'FAILED',
      terminalReason: expect.stringContaining('never published')
    });
    expect(await fixture.runtime.getRun(taskRun.id)).toBeUndefined();
  });

  it('repairs missing generic artifacts and queue linkage before one safe dispatch', async () => {
    const fixture = await createFixture();
    const linked = await createUnlinkedTaskRun(fixture, 'missing-queue');
    const owner = { kind: 'TASK' as const, taskId: linked.context.task.id };
    const runtimeSession = await fixture.runtime.createSession({
      id: linked.taskSession.id,
      owner,
      accessEpoch: createAgentSessionAccessEpoch({
        owner,
        sessionId: linked.taskSession.id,
        epoch: 1,
        providerId: 'codex',
        model: linked.executionContext.modelSettings.model!,
        executionContext: linked.executionContext,
        createdAt: linked.taskSession.createdAt
      }),
      executionContext: linked.executionContext,
      clientOperationId: `repair-session:${linked.taskSession.id}`,
      provider: 'codex',
      role: 'PRIMARY',
      relationshipState: 'ROOT',
      status: 'NOT_MATERIALIZED',
      materialized: false,
      requestedSettings: linked.executionContext.modelSettings
    });
    await fixture.runtime.createRun({
      id: linked.taskRun.id,
      owner,
      scope: {
        kind: 'TASK',
        taskId: linked.taskRun.taskId,
        iterationId: linked.taskRun.iterationId,
        worktreeId: linked.taskRun.worktreeId
      },
      sessionId: runtimeSession.id,
      sessionAccessEpoch: runtimeSession.accessEpoch.epoch,
      purpose: 'TASK_IMPLEMENTATION',
      generationKey: `repair-generation:${linked.taskRun.id}`,
      clientOperationId: `repair-run:${linked.taskRun.id}`,
      requestedSettings: linked.executionContext.modelSettings,
      promptArtifactId: linked.taskRun.promptArtifactId,
      outputArtifactId: linked.taskRun.outputArtifactId,
      diagnosticArtifactId: linked.taskRun.diagnosticArtifactId
    });

    await fixture.orchestrator.initialize();
    await waitFor(() => fixture.adapter.startedTurns.length === 1);

    const runtimeSnapshot = await fixture.runtime.snapshot();
    expect(
      runtimeSnapshot.artifacts.filter((artifact) => artifact.runId === linked.taskRun.id)
    ).toHaveLength(3);
    expect(queueFor(runtimeSnapshot, linked.taskRun.id)?.status).toBe('LEASED');
    expect(fixture.adapter.startedTurns[0]?.localRunId).toBe(linked.taskRun.id);
  });

  it('uses one global aging decision when real task work competes with discourse work', async () => {
    let clock = '2026-07-13T00:00:00.000Z';
    const discourseDispatches: string[] = [];
    const fixture = await createFixture({
      now: () => clock,
      dispatchNonTaskQueueEntry: async (entry) => {
        discourseDispatches.push(entry.runId);
      }
    });
    const active = await enqueueDiscourseRuntime(fixture.runtime, 'active', 'conversation-active');
    await fixture.scheduler.leaseAvailable('lease-active');
    const aged = await enqueueDiscourseRuntime(fixture.runtime, 'aged', 'conversation-aged');

    clock = '2026-07-13T00:02:00.000Z';
    const context = await createTaskContext(fixture, 'fairness-task');
    const taskRun = await fixture.orchestrator.startTurn(turnInput(context));

    await waitFor(() => discourseDispatches.includes(aged.id));
    expect(discourseDispatches).toEqual([aged.id]);
    expect(fixture.adapter.startedTurns).toHaveLength(0);
    expect((await fixture.runtime.getRun(taskRun.id))?.status).toBe('QUEUED');
    expect(queueFor(await fixture.runtime.snapshot(), active.id)?.status).toBe('LEASED');
    expect(queueFor(await fixture.runtime.snapshot(), aged.id)?.status).toBe('LEASED');
  });
});

async function createFixture(options: {
  now?: () => string;
  dispatchNonTaskQueueEntry?: (entry: AgentSchedulerQueueEntry) => Promise<void>;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-task-scheduler-'));
  const store = new FileTaskStore(path.join(root, 'tasks'));
  const runtime = new FileAgentRuntimeStore(path.join(root, 'runtime'), {
    ...(options.now ? { now: options.now } : {})
  });
  const events = new AppEventBus();
  const adapter = new ScriptedAgentProviderAdapter(store);
  await store.init();
  await runtime.init();
  const scheduler = new AgentTurnScheduler(runtime);
  const orchestrator = new AgentOrchestrator(store, events, adapter, {
    runtimeStore: runtime,
    scheduler,
    ...(options.dispatchNonTaskQueueEntry
      ? { dispatchNonTaskQueueEntry: options.dispatchNonTaskQueueEntry }
      : {})
  });
  return { root, store, runtime, events, adapter, scheduler, orchestrator };
}

async function enqueueDiscourseRuntime(
  runtime: FileAgentRuntimeStore,
  suffix: string,
  conversationId: string
) {
  const owner = {
    kind: 'DISCOURSE' as const,
    conversationId,
    stableParticipantId: `participant-${suffix}`
  };
  const sessionId = `discourse-session-${suffix}`;
  const executionContext: AgentExecutionContext = {
    attestation: { status: 'ATTESTED' },
    primaryCwd: path.resolve(os.tmpdir()),
    readRoots: [{ canonicalPath: path.resolve(os.tmpdir()), kind: 'EMPTY_MANAGED' }],
    managedAttachments: [],
    permissionProfileHash: 'a'.repeat(64),
    modelSettings: {
      model: 'scenario-model',
      reasoningEffort: 'low',
      sandbox: 'READ_ONLY',
      approvalPolicy: 'NEVER'
    },
    externalTools: {
      network: false,
      webSearch: 'disabled',
      mcpServers: false,
      apps: false,
      dynamicTools: false
    },
    clientOperationId: `discourse-context-${suffix}`
  };
  const session = await runtime.createSession({
    id: sessionId,
    owner,
    accessEpoch: createAgentSessionAccessEpoch({
      owner,
      sessionId,
      epoch: 1,
      providerId: 'codex',
      model: 'scenario-model',
      executionContext
    }),
    executionContext,
    clientOperationId: `discourse-session-operation-${suffix}`,
    provider: 'codex',
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    status: 'NOT_MATERIALIZED',
    materialized: false,
    requestedSettings: executionContext.modelSettings
  });
  const run = await runtime.createRun({
    id: `discourse-run-${suffix}`,
    owner,
    scope: {
      kind: 'DISCOURSE',
      conversationId,
      waveId: `wave-${suffix}`,
      jobId: `job-${suffix}`,
      contextSnapshotId: `context-${suffix}`,
      attemptId: `attempt-${suffix}`
    },
    sessionId: session.id,
    sessionAccessEpoch: 1,
    purpose: 'DISCOURSE_ANSWER',
    generationKey: `generation-${suffix}`,
    clientOperationId: `discourse-run-operation-${suffix}`,
    requestedSettings: executionContext.modelSettings,
    promptArtifactId: `prompt-${suffix}`,
    outputArtifactId: `output-${suffix}`,
    diagnosticArtifactId: `diagnostic-${suffix}`
  });
  await runtime.enqueueRun(
    run.id,
    'DISCOURSE_BACKGROUND',
    `discourse-enqueue-${suffix}`
  );
  return run;
}

async function prepareCrashLeasedTask(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string
): Promise<RunRecord> {
  const contexts = await Promise.all([
    createTaskContext(fixture, `${name}-active-one`),
    createTaskContext(fixture, `${name}-active-two`),
    createTaskContext(fixture, `${name}-queued`)
  ]);
  const runs: RunRecord[] = [];
  for (const context of contexts) {
    runs.push(await fixture.orchestrator.startTurn(turnInput(context)));
  }
  await waitFor(async () => {
    const active = await fixture.runtime.getRun(runs[0]!.id);
    return active?.delivery === 'ACKNOWLEDGED';
  });
  const firstRuntime = (await fixture.runtime.getRun(runs[0]!.id))!;
  await fixture.runtime.updateRun(
    firstRuntime.id,
    firstRuntime.recordRevision,
    {
      status: 'COMPLETED',
      delivery: 'TERMINAL',
      endedAt: new Date().toISOString()
    },
    `test-free-capacity:${firstRuntime.id}`
  );
  const firstQueue = queueFor(await fixture.runtime.snapshot(), firstRuntime.id)!;
  await fixture.runtime.settleQueueEntry(
    firstQueue.id,
    firstQueue.recordRevision,
    `test-free-capacity-queue:${firstRuntime.id}`
  );
  const leased = await fixture.scheduler.leaseAvailable('test-crash-lease', {
    ownerKinds: ['TASK']
  });
  expect(leased.map((entry) => entry.runId)).toEqual([runs[2]!.id]);
  return runs[2]!;
}

async function createTaskContext(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string
) {
  const repositoryPath = path.join(fixture.root, `repository-${name}`);
  await fs.mkdir(repositoryPath, { recursive: true });
  const task = await fixture.store.createTask({
    title: `Task ${name}`,
    prompt: `Implement ${name}.`,
    repositoryPath,
    agentSettings: { model: 'scenario-model', reasoningEffort: 'low' }
  });
  const { iteration, worktree } = await fixture.store.createIterationAndWorktree({
    task,
    branchName: `codex/${name}`,
    worktreePath: repositoryPath,
    baseSha: 'base'
  });
  return { task, iteration, worktree };
}

async function createUnlinkedTaskRun(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string
) {
  const context = await createTaskContext(fixture, name);
  const taskSession = await fixture.store.createAgentSession({
    task: context.task,
    iteration: context.iteration,
    worktree: context.worktree,
    provider: 'codex',
    requestedSettings: context.task.agentSettings
  });
  const taskRun = await fixture.store.createRun({
    task: context.task,
    session: taskSession,
    mode: 'IMPLEMENTATION',
    prompt: context.task.prompt,
    requestedSettings: context.task.agentSettings
  });
  const executionContext = await fixture.adapter.describeExecutionContext!({
    sessionId: taskSession.id,
    worktreePath: context.worktree.worktreePath,
    settings: context.task.agentSettings,
    attachments: [],
    clientOperationId: `repair-context:${taskSession.id}`
  });
  return { context, taskSession, taskRun, executionContext };
}

function turnInput(context: Awaited<ReturnType<typeof createTaskContext>>) {
  return {
    ...context,
    mode: 'IMPLEMENTATION' as const,
    prompt: context.task.prompt,
    settings: context.task.agentSettings
  };
}

async function completeTaskRun(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  run: RunRecord
): Promise<void> {
  await fixture.store.appendEvent(
    createDomainEvent({
      type: 'AGENT_RUN_COMPLETED',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      agentSessionId: run.sessionId,
      source: 'provider',
      payload: { terminalStatus: 'completed' }
    })
  );
  fixture.events.emit({
    type: 'run.terminal',
    taskId: run.taskId,
    iterationId: run.iterationId,
    runId: run.id,
    worktreeId: run.worktreeId,
    payload: { status: 'COMPLETED' },
    at: new Date().toISOString()
  });
}

function queueFor(
  snapshot: Awaited<ReturnType<FileAgentRuntimeStore['snapshot']>>,
  runId: string
) {
  return snapshot.queueEntries.find((entry) => entry.runId === runId);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for scheduler state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
