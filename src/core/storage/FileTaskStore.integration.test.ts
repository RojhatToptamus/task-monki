import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentExecutionSettings,
  AgentRunMode,
  AgentSessionRecord,
  CiChecksStatus,
  GitSnapshotRecord,
  MergeStatus,
  PreviewExecutionAuthority,
  PreviewPlanSource,
  PreviewSourceIdentity,
  RunRecord,
  Task,
  TaskIteration,
  WorktreeRecord
} from '../../shared/contracts';
import { TASK_STORE_SCHEMA_VERSION } from '../../shared/contracts';
import { ArtifactAppendAmbiguousError, FileTaskStore } from './FileTaskStore';
import { FileAgentRuntimeStore } from './FileAgentRuntimeStore';
import type { TaskAgentRuntimeAccess } from '../agent/AgentRuntimeStore';
import { createDomainEvent } from './domainEvent';
import { addTestRepository } from '../../testSupport/repositoryFixture';

const TEST_PREVIEW_RECIPE_DIGEST = 'a'.repeat(64);
const TEST_PREVIEW_EXECUTION_DIGEST = 'b'.repeat(64);
const TEST_PREVIEW_HEAD_SHA = 'c'.repeat(40);

const runtimeFixtures = new Set<FileAgentRuntimeStore>();
const runtimeByTaskStore = new WeakMap<
  FileTaskStore,
  { store: FileAgentRuntimeStore; task: TaskAgentRuntimeAccess }
>();

afterEach(async () => {
  await Promise.all([...runtimeFixtures].map((runtime) => runtime.close()));
  runtimeFixtures.clear();
});

describe('FileTaskStore', () => {
  it('allows exactly one live owner for a store root', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-owner-'));
    const first = new FileTaskStore(dir);
    const second = new FileTaskStore(dir);
    await first.snapshot();

    await expect(second.snapshot()).rejects.toThrow(
      `already owned by process ${process.pid}`
    );
    const task = await first.createTask({
      title: 'Single durable owner',
      prompt: 'Prevent lost updates from a second writer.',
      repositoryId: (await addTestRepository(first, dir)).id
    });
    await first.close();

    await expect(second.getTask(task.id)).resolves.toMatchObject({ id: task.id });
    await second.close();
  });

  it('does not let a delayed stale-lease contender evict the new owner', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-reclaim-'));
    const stale = await writeStaleStoreLease(dir);
    const first = new FileTaskStore(dir);
    const second = new FileTaskStore(dir);
    const renameFile = fs.rename.bind(fs);
    let releaseRename!: () => void;
    let signalRenameStarted!: () => void;
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    const renameStarted = new Promise<void>((resolve) => { signalRenameStarted = resolve; });
    let delayed = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (
        !delayed &&
        String(source) === stale.ownerPath &&
        String(destination).startsWith(`${stale.canonicalPath}.${stale.token}.reclaim.`)
      ) {
        delayed = true;
        signalRenameStarted();
        await renameGate;
      }
      await renameFile(source, destination);
    });

    try {
      const delayedInitialization = first.snapshot();
      await renameStarted;
      await expect(second.snapshot()).resolves.toMatchObject({ tasks: [] });
      releaseRename();
      await expect(delayedInitialization).rejects.toThrow(
        `already owned by process ${process.pid}`
      );
      await expect(
        second.createTask({
          title: 'Reclaim winner',
          prompt: 'Keep the new live lease intact.',
          repositoryId: (await addTestRepository(second, dir)).id
        })
      ).resolves.toMatchObject({ title: 'Reclaim winner' });
    } finally {
      releaseRename();
      rename.mockRestore();
      await first.close();
      await second.close();
    }
  });

  it('recovers a stale lease after its reclaimer exits mid-takeover', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-reclaim-crash-'));
    const stale = await writeStaleStoreLease(dir);
    const abandonedReclaim = `${stale.canonicalPath}.${stale.token}.reclaim.${randomUUID()}`;
    await fs.rename(stale.ownerPath, abandonedReclaim);

    const store = new FileTaskStore(dir);
    await expect(store.snapshot()).resolves.toMatchObject({ tasks: [] });
    await expect(fs.access(abandonedReclaim)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.close();
  });

  it('drains an admitted mutation before terminal close and rejects late work', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-close-'));
    const store = new FileTaskStore(dir);
    const repository = await addTestRepository(store, dir);
    const creation = store.createTask({
      title: 'Admitted before close',
      prompt: 'Publish this mutation before releasing ownership.',
      repositoryId: repository.id
    });
    const closing = store.close();

    expect(store.close()).toBe(closing);
    await expect(creation).resolves.toMatchObject({ title: 'Admitted before close' });
    await expect(closing).resolves.toBeUndefined();
    await expect(store.snapshot()).rejects.toThrow('Task store is closed');
    await expect(
      store.createTask({
        title: 'Too late',
        prompt: 'Do not admit work after shutdown begins.',
        repositoryId: repository.id
      })
    ).rejects.toThrow('Task store is closed');

    const restarted = new FileTaskStore(dir);
    await expect(restarted.snapshot()).resolves.toMatchObject({
      tasks: [expect.objectContaining({ title: 'Admitted before close' })]
    });
    await restarted.close();
  });

  it('waits for an admitted mutation while the store is still opening', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-opening-read-'));
    const store = new FileTaskStore(dir);
    const storePath = path.join(dir, 'store.json');
    const renameFile = fs.rename.bind(fs);
    let signalInitializationRename!: () => void;
    let signalMutationRename!: () => void;
    let releaseInitializationRename!: () => void;
    let releaseMutationRename!: () => void;
    const initializationRenameStarted = new Promise<void>((resolve) => {
      signalInitializationRename = resolve;
    });
    const mutationRenameStarted = new Promise<void>((resolve) => {
      signalMutationRename = resolve;
    });
    const initializationRenameGate = new Promise<void>((resolve) => {
      releaseInitializationRename = resolve;
    });
    const mutationRenameGate = new Promise<void>((resolve) => {
      releaseMutationRename = resolve;
    });
    let storeRenameCount = 0;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === storePath) {
        storeRenameCount += 1;
        if (storeRenameCount === 1) {
          signalInitializationRename();
          await initializationRenameGate;
        } else if (storeRenameCount === 2) {
          signalMutationRename();
          await mutationRenameGate;
        }
      }
      await renameFile(source, destination);
    });
    const creation = store.addRepository({
      path: dir,
      root: dir,
      status: 'VALID',
      headSha: 'test-head',
      branch: 'main',
      remotes: [],
      checkedAt: new Date(0).toISOString()
    });
    let reading: ReturnType<FileTaskStore['snapshot']> | undefined;

    try {
      await initializationRenameStarted;
      reading = store.snapshot();
      releaseInitializationRename();
      await mutationRenameStarted;
      let readFinished = false;
      void reading.then(() => {
        readFinished = true;
      });
      await Promise.resolve();
      expect(readFinished).toBe(false);

      releaseMutationRename();
      await expect(creation).resolves.toMatchObject({ path: dir });
      await expect(reading).resolves.toMatchObject({
        repositories: [expect.objectContaining({ path: dir })]
      });
    } finally {
      releaseInitializationRename();
      releaseMutationRename();
      rename.mockRestore();
      await Promise.allSettled([creation, ...(reading ? [reading] : [])]);
      await store.close();
    }
  });

  it('reuses the published serialization for isolated snapshots and compact persistence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-snapshot-cache-'));
    const store = new FileTaskStore(dir);
    const repository = await addTestRepository(store, dir);
    const task = await store.createTask({
      title: 'Published snapshot cache',
      prompt: 'Avoid serializing the unchanged full store for every reader.',
      repositoryId: repository.id
    });

    const persisted = await fs.readFile(path.join(dir, 'store.json'), 'utf8');
    expect(persisted.endsWith('\n')).toBe(true);
    expect(persisted).not.toContain('\n  "');
    expect(JSON.parse(persisted)).toMatchObject({
      tasks: [expect.objectContaining({ id: task.id })]
    });

    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const first = await store.snapshot();
      first.tasks[0]!.title = 'Mutated caller copy';
      const second = await store.snapshot();

      expect(second.tasks[0]?.title).toBe('Published snapshot cache');
      expect(first).not.toBe(second);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
      await store.close();
    }
  });

  it('derives compact board and task-owned detail reads from published state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-client-reads-'));
    const store = new FileTaskStore(dir);
    const repository = await addTestRepository(store, dir);
    const consumer = await store.createTask({
      title: 'Consumer',
      prompt: 'consumer prompt that must not reach the board',
      repositoryId: repository.id
    });
    const producer = await store.createTask({
      title: 'Producer',
      prompt: 'producer prompt that must not reach the board',
      repositoryId: repository.id
    });
    const consumerOwnership = await store.createIterationAndWorktree({
      task: consumer,
      branchName: 'codex/consumer',
      worktreePath: dir,
      baseSha: 'base'
    });
    const producerOwnership = await store.createIterationAndWorktree({
      task: producer,
      branchName: 'codex/producer',
      worktreePath: dir,
      baseSha: 'base'
    });
    const consumerSession = await createTestAgentSession(store, {
      task: consumer,
      ...consumerOwnership,
      runtimeId: 'codex'
    });
    const producerSession = await createTestAgentSession(store, {
      task: producer,
      ...producerOwnership,
      runtimeId: 'codex'
    });
    const server = await createTestAgentServer(store, {
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const eventOnlyServer = await createTestAgentServer(store, {
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    await store.appendEvent(
      createDomainEvent({
        type: 'PROJECTION_UPDATED',
        taskId: consumer.id,
        serverInstanceId: eventOnlyServer.id,
        source: 'provider',
        payload: { reason: 'event-only server reference' }
      })
    );
    const rawMessage = await appendTestProtocolMessage(store,
      server.id,
      'INBOUND',
      '{"method":"seed/update"}',
      { method: 'seed/update' }
    );
    const consumerRun = await createTestRun(store, {
      task: consumer,
      session: consumerSession,
      serverInstanceId: server.id,
      mode: 'IMPLEMENTATION',
      prompt: consumer.prompt
    });
    const producerRun = await createTestRun(store, {
      task: producer,
      session: producerSession,
      serverInstanceId: server.id,
      mode: 'IMPLEMENTATION',
      prompt: producer.prompt
    });
    await updateTestAgentSession(store, consumerSession.id, {
      providerSessionId: 'consumer-session',
      status: 'ACTIVE',
      materialized: true
    });
    await updateTestRun(store, consumerRun.id, {
      status: 'STARTING',
      providerTurnId: 'consumer-turn'
    });
    await updateTestRun(store, consumerRun.id, { status: 'RUNNING' });
    const consumerItem = await upsertTestAgentItem(store, {
      taskId: consumer.id,
      iterationId: consumerOwnership.iteration.id,
      runId: consumerRun.id,
      sessionId: consumerSession.id,
      providerItemId: 'consumer-item',
      type: 'AGENT_MESSAGE',
      status: 'COMPLETED',
      payload: { text: 'current consumer item' },
      rawMessage
    });
    const producerItem = await upsertTestAgentItem(store, {
      taskId: producer.id,
      iterationId: producerOwnership.iteration.id,
      runId: producerRun.id,
      sessionId: producerSession.id,
      providerItemId: 'producer-item',
      type: 'AGENT_MESSAGE',
      status: 'COMPLETED',
      payload: { text: 'unrelated producer item' },
      rawMessage
    });
    const consumerPlan = await recordTestAgentPlanRevision(store, {
      taskId: consumer.id,
      iterationId: consumerOwnership.iteration.id,
      runId: consumerRun.id,
      sessionId: consumerSession.id,
      runtimeId: 'codex',
      explanation: 'Current consumer plan',
      steps: [{ step: 'Inspect', status: 'IN_PROGRESS' }],
      rawMessage
    });
    const consumerUsage = await recordTestAgentUsageSnapshot(store, {
      taskId: consumer.id,
      iterationId: consumerOwnership.iteration.id,
      runId: consumerRun.id,
      sessionId: consumerSession.id,
      runtimeId: 'codex',
      total: testUsage(100),
      last: testUsage(40),
      modelContextWindow: 200_000,
      rawMessage
    });
    const consumerInteraction = await createTestInteractionRequest(store, {
      runtimeId: 'codex',
      serverInstanceId: server.id,
      providerRequestId: 'consumer-request',
      taskId: consumer.id,
      iterationId: consumerOwnership.iteration.id,
      runId: consumerRun.id,
      sessionId: consumerSession.id,
      providerItemId: consumerItem.providerItemId,
      type: 'COMMAND_APPROVAL',
      request: { command: 'npm test', startedAtMs: 0 },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
      policyWarnings: [],
      requestRawMessage: rawMessage
    });
    const now = '2026-07-26T00:00:00.000Z';
    await store.savePreviewPlan({
      id: 'producer-plan',
      taskId: producer.id,
      iterationId: producerOwnership.iteration.id,
      worktreeId: producerOwnership.worktree.id,
      planSource: repositoryPreviewPlanSource(),
      executionDigest: TEST_PREVIEW_EXECUTION_DIGEST,
      executionPlan: {
        version: 1,
        jobs: [],
        resources: [],
        services: [],
        workers: [],
        routes: [{ id: 'api', service: 'web', port: 'http', primary: true }],
        scenarios: [{ id: 'default', jobs: [], resources: [] }],
        selectedScenarioId: 'default'
      },
      warnings: [],
      createdAt: now
    });

    const board = await store.getBoardSnapshot();
    expect(board.tasks.map((task) => task.id).sort()).toEqual(
      [consumer.id, producer.id].sort()
    );
    expect(board).not.toHaveProperty('runs');
    expect(board).not.toHaveProperty('events');
    expect(JSON.stringify(board)).not.toContain(consumer.prompt);
    expect(JSON.stringify(board)).not.toContain(producer.prompt);

    const detail = await store.getTaskDetail(consumer.id);
    expect(detail.task.id).toBe(consumer.id);
    expect(detail.runs.map((run) => run.id)).toEqual([consumerRun.id]);
    expect(detail.runs).not.toContainEqual(expect.objectContaining({ id: producerRun.id }));
    expect(detail.agentServers.map((record) => record.id).sort()).toEqual(
      [server.id, eventOnlyServer.id].sort()
    );
    expect(detail.agentItems.map((record) => record.id)).toEqual([consumerItem.id]);
    expect(detail.agentItems).not.toContainEqual(
      expect.objectContaining({ id: producerItem.id })
    );
    expect(detail.agentPlanRevisions.map((record) => record.id)).toEqual([
      consumerPlan.id
    ]);
    expect(detail.agentUsageSnapshots.map((record) => record.id)).toEqual([
      consumerUsage.id
    ]);
    expect(detail.interactionRequests.map((record) => record.id)).toEqual([
      consumerInteraction.id
    ]);
    expect(detail.iterations).toHaveLength(1);
    expect(detail.worktrees).toHaveLength(1);
    expect(detail.previewTaskRoutes).toEqual([
      {
        taskId: producer.id,
        taskTitle: 'Producer',
        routeId: 'api',
        available: false
      }
    ]);

    await runtimeFixture(store).store.close();
    await store.close();
    const restarted = new FileTaskStore(dir);
    runtimeFixture(restarted);
    await expect(restarted.getBoardSnapshot()).resolves.toEqual(board);
    await expect(restarted.getTaskDetail(consumer.id)).resolves.toMatchObject({
      task: { id: consumer.id },
      runs: [{ id: consumerRun.id }]
    });
    await restarted.close();
  });

  it('keeps provider runtime records out of the durable Task store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-runtime-boundary-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Keep runtime state separate',
      prompt: 'Exercise the canonical provider store.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/runtime-boundary',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: 'base'
    });
    const session = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: 'codex'
    });
    const server = await createTestAgentServer(store, {
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const rawMessage = await appendTestProtocolMessage(
      store,
      server.id,
      'INBOUND',
      '{"method":"item/completed"}',
      { method: 'item/completed' }
    );
    const run = await createTestRun(store, {
      task,
      session,
      serverInstanceId: server.id,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await updateTestAgentSession(store, session.id, {
      providerSessionId: 'runtime-boundary-session',
      status: 'ACTIVE',
      materialized: true
    });
    await updateTestRun(store, run.id, {
      status: 'STARTING',
      providerTurnId: 'runtime-boundary-turn'
    });
    await updateTestRun(store, run.id, { status: 'RUNNING' });
    const item = await upsertTestAgentItem(store, {
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      providerItemId: 'runtime-boundary-item',
      type: 'AGENT_MESSAGE',
      status: 'COMPLETED',
      payload: { text: 'Runtime-owned item.' },
      rawMessage
    });
    await createTestInteractionRequest(store, {
      runtimeId: 'codex',
      serverInstanceId: server.id,
      providerRequestId: 'runtime-boundary-request',
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      providerItemId: item.providerItemId,
      type: 'COMMAND_APPROVAL',
      request: { command: 'npm test', startedAtMs: 0 },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
      policyWarnings: [],
      requestRawMessage: rawMessage
    });

    const taskState = JSON.parse(
      await fs.readFile(path.join(dir, 'store.json'), 'utf8')
    ) as Record<string, unknown>;
    for (const runtimeKey of [
      'agentServers',
      'agentSessions',
      'runs',
      'agentItems',
      'agentGoalSnapshots',
      'agentPlanRevisions',
      'agentUsageSnapshots',
      'agentSettingsObservations',
      'agentSubagentObservations',
      'interactionRequests'
    ]) {
      expect(taskState).not.toHaveProperty(runtimeKey);
    }

    const runtimeState = await runtimeFixture(store).store.snapshot();
    expect(runtimeState.servers).toHaveLength(1);
    expect(runtimeState.sessions).toHaveLength(1);
    expect(runtimeState.runs).toHaveLength(1);
    expect(runtimeState.items).toHaveLength(1);
    expect(runtimeState.interactions).toHaveLength(1);

    await runtimeFixture(store).store.close();
    await store.close();
    const restarted = new FileTaskStore(dir);
    runtimeFixture(restarted);
    await expect(restarted.getTaskDetail(task.id)).resolves.toMatchObject({
      runs: [{ id: run.id }],
      agentSessions: [{ id: session.id }],
      agentItems: [{ id: item.id }],
      interactionRequests: [expect.objectContaining({ taskId: task.id })]
    });
    await restarted.close();
  });

  it('rejects provider runtime collections in the current Task store schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-runtime-shape-'));
    const store = new FileTaskStore(dir);
    await store.snapshot();
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as Record<
      string,
      unknown
    >;
    persisted.agentSessions = [];
    await fs.writeFile(storePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'agentSessions belongs to the agent runtime store'
    );
  });

  it('rejects provider artifacts in the current Task store schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-runtime-artifact-'));
    const store = new FileTaskStore(dir);
    await store.snapshot();
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      artifacts: unknown[];
    };
    persisted.artifacts.push({ kind: 'agent-output' });
    await fs.writeFile(storePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'agent artifacts belong to the agent runtime store'
    );
  });

  it('switches the current primary session together with its replacement run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-primary-session-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Replace the primary session',
      prompt: 'Continue through the newest usable session.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/replace-primary-session',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: 'base'
    });
    const original = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: task.runtimeId
    });
    const originalRun = await createTestRun(store, {
      task,
      session: original,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await updateTestRun(store, originalRun.id, { status: 'FAILED' });

    const replacement = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: task.runtimeId,
      parentSessionId: original.id
    });
    await expect(store.getTask(task.id)).resolves.toMatchObject({
      currentRunId: originalRun.id,
      currentAgentSessionId: original.id
    });

    const replacementRun = await createTestRun(store, {
      task,
      session: replacement,
      mode: 'FOLLOW_UP',
      prompt: 'Continue in the replacement session.',
      continuedFromRunId: originalRun.id
    });
    await expect(store.getTask(task.id)).resolves.toMatchObject({
      currentRunId: replacementRun.id,
      currentAgentSessionId: replacement.id
    });
    await expect(
      store.getPrimaryAgentSession(task.id, iteration.id)
    ).resolves.toMatchObject({ id: replacement.id });
  });

  it.runIf(process.platform !== 'win32')(
    'makes canonical lease release durable before removing its owner anchor',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-lease-release-'));
      const store = new FileTaskStore(dir);
      await store.snapshot();
      const canonicalPath = path.join(dir, '.task-monki-owner.lock');
      const ownerName = (await fs.readdir(dir)).find(
        (entry) =>
          entry.startsWith('.task-monki-owner.lock.') && entry.endsWith('.owner')
      );
      expect(ownerName).toBeDefined();
      const ownerPath = path.join(dir, ownerName!);
      const openFile = fs.open.bind(fs);
      let signalDirectorySync!: () => void;
      let releaseDirectorySync!: () => void;
      const directorySyncStarted = new Promise<void>((resolve) => {
        signalDirectorySync = resolve;
      });
      const directorySyncGate = new Promise<void>((resolve) => {
        releaseDirectorySync = resolve;
      });
      let delayed = false;
      const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await openFile(...args);
        if (!delayed && String(args[0]) === dir) {
          delayed = true;
          vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            signalDirectorySync();
            await directorySyncGate;
          });
        }
        return handle;
      });
      const closing = store.close();

      try {
        await directorySyncStarted;
        await expect(fs.access(canonicalPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.access(ownerPath)).resolves.toBeUndefined();
        releaseDirectorySync();
        await expect(closing).resolves.toBeUndefined();
        await expect(fs.access(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        releaseDirectorySync();
        open.mockRestore();
        await closing;
      }
    }
  );

  it.runIf(process.platform === 'win32')(
    'accepts the existing managed artifact directory with different Windows casing',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-case-'));
      await fs.mkdir(path.join(dir, 'Artifacts'));
      const store = new FileTaskStore(dir);

      await expect(store.snapshot()).resolves.toMatchObject({ artifacts: [] });
      await store.close();
    }
  );

  it('rejects a mutation before publishing a snapshot too large to reload', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-limit-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Bound the store file',
      prompt: 'Reject an oversized snapshot before publication.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const originalByteLength = Buffer.byteLength.bind(Buffer);
    const byteLength = vi.spyOn(Buffer, 'byteLength').mockImplementation(
      (value, encoding) =>
        typeof value === 'string' && value.includes('"workflowPhase":"BACKLOG"')
          ? Number.MAX_SAFE_INTEGER
          : originalByteLength(value, encoding)
    );
    try {
      await expect(
        store.transitionTask(task.id, 'BACKLOG', 'exercise snapshot size boundary')
      ).rejects.toThrow('snapshot exceeds its durable size limit');
    } finally {
      byteLength.mockRestore();
    }

    await expect(store.getTask(task.id)).resolves.toMatchObject({
      workflowPhase: 'READY'
    });
    await store.close();
    const reloaded = new FileTaskStore(dir);
    await expect(reloaded.getTask(task.id)).resolves.toMatchObject({
      workflowPhase: 'READY'
    });
    await reloaded.close();
  });

  it.runIf(process.platform !== 'win32')(
    'reconciles managed file orphans after a published delete survives restart',
    async () => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-manager-artifact-reconcile-')
      );
      const store = new FileTaskStore(dir);
      const draft = await store.createAttachmentDraft();
      await store.stageTaskAttachment({
        draftId: draft.id,
        displayName: 'context.txt',
        bytes: Buffer.from('durable task context')
      });
      const task = await store.createTask({
        title: 'Artifact crash cleanup',
        prompt: 'Leave artifacts until restart can resolve publication.',
        repositoryId: (await addTestRepository(store, dir)).id,
        attachmentDraftId: draft.id
      });
      const attachmentPath = (await store.verifyTaskAttachments(task.id))[0]!
        .absolutePath;
      await store.writeTextArtifact(task.id, 'git-snapshot', 'captured git state');
      const artifactPaths = (await store.snapshot()).artifacts
        .filter((artifact) => artifact.taskId === task.id)
        .map((artifact) => artifact.path);

      const artifactsDir = path.join(dir, 'artifacts');
      const unknownFile = path.join(artifactsDir, 'user-notes.txt');
      const unknownDirectory = path.join(artifactsDir, 'user-folder');
      const almostManaged = path.join(
        artifactsDir,
        `${task.id}-task-agent-final-not-a-managed-uuid.log`
      );
      await fs.writeFile(unknownFile, 'preserve me', 'utf8');
      await fs.mkdir(unknownDirectory);
      await fs.writeFile(almostManaged, 'also preserve me', 'utf8');

      const originalOpen = fs.open.bind(fs);
      let injectedFailure = false;
      const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (!injectedFailure && String(args[0]) === dir) {
          injectedFailure = true;
          vi.spyOn(handle, 'sync').mockRejectedValueOnce(
            new Error('Injected post-publication directory sync failure.')
          );
        }
        return handle;
      });
      try {
        await store.deleteTask(task.id);
      } finally {
        open.mockRestore();
      }
      for (const artifactPath of artifactPaths) {
        await expect(fs.access(artifactPath)).resolves.toBeUndefined();
      }
      await expect(fs.access(attachmentPath)).resolves.toBeUndefined();
      await store.close();

      const restarted = new FileTaskStore(dir);
      await restarted.snapshot();
      for (const artifactPath of artifactPaths) {
        await expect(fs.access(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(fs.access(attachmentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(unknownFile, 'utf8')).resolves.toBe('preserve me');
      await expect(fs.readFile(almostManaged, 'utf8')).resolves.toBe('also preserve me');
      expect((await fs.stat(unknownDirectory)).isDirectory()).toBe(true);
      await restarted.close();
    }
  );

  it('does not report failure after task deletion is durably published', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-delete-cleanup-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Durable deletion',
      prompt: 'Treat post-publication cleanup as recoverable maintenance.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(
      task.id,
      'git-snapshot',
      'orphan until restart'
    );
    const unlinkFile = fs.unlink.bind(fs);
    let injected = false;
    const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async (filePath) => {
      if (!injected && String(filePath) === artifact.path) {
        injected = true;
        throw new Error('Injected post-publication cleanup failure.');
      }
      await unlinkFile(filePath);
    });
    try {
      await expect(store.deleteTask(task.id)).resolves.toBeUndefined();
    } finally {
      unlink.mockRestore();
    }

    expect(injected).toBe(true);
    await expect(store.getTask(task.id)).resolves.toBeUndefined();
    await expect(fs.access(artifact.path)).resolves.toBeUndefined();
    await store.close();

    const restarted = new FileTaskStore(dir);
    await expect(restarted.snapshot()).resolves.toMatchObject({ tasks: [] });
    await expect(fs.access(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.close();
  });

  it.runIf(process.platform !== 'win32')(
    'fails closed on unsafe artifact entries without following or removing them',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-unsafe-'));
      const first = new FileTaskStore(dir);
      await first.snapshot();
      await first.close();
      const outside = path.join(dir, 'outside.txt');
      await fs.writeFile(outside, 'outside', 'utf8');
      const unsafeName =
        '00000000-0000-4000-8000-000000000001-task-agent-final-' +
        '00000000-0000-4000-8000-000000000002.log';
      const unsafePath = path.join(dir, 'artifacts', unsafeName);
      await fs.symlink(outside, unsafePath);

      await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
        'artifact directory contains an unsafe entry'
      );
      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside');
      expect((await fs.lstat(unsafePath)).isSymbolicLink()).toBe(true);
    }
  );

  it('rejects a Git snapshot that does not belong to its recorded worktree', async () => {
    const fixture = await createRunFixture('cross-worktree-git-snapshot');
    await fixture.store.recordGitSnapshot(
      {
        taskId: fixture.task.id,
        iterationId: fixture.iteration.id,
        worktreeId: fixture.worktree.id,
        worktreePath: fixture.worktree.worktreePath,
        repoRoot: fixture.dir,
        gitCommonDir: path.join(fixture.dir, '.git'),
        headSha: 'head',
        branch: fixture.worktree.branchName,
        baseSha: fixture.worktree.baseSha,
        aheadCount: 0,
        behindCount: 0,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        commitsAheadOfBase: 0,
        committedDiffFileCount: 0,
        workingDiffFileCount: 0,
        diffStat: '',
        dirtyFingerprint: 'clean',
        status: 'CLEAN'
      },
      ''
    );
    await fixture.store.close();
    const storePath = path.join(fixture.dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      gitSnapshots: Array<{ worktreeId: string }>;
    };
    persisted.gitSnapshots[0]!.worktreeId = randomUUID();
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(fixture.dir).snapshot()).rejects.toThrow(
      'git snapshot ownership is inconsistent'
    );
  });

  it('rejects GitHub evidence that does not belong to its recorded worktree', async () => {
    const fixture = await createRunFixture('cross-worktree-github-evidence');
    await recordOpenPullRequest(
      fixture.store,
      fixture.task.id,
      fixture.iteration,
      fixture.worktree
    );
    await fixture.store.close();
    const storePath = path.join(fixture.dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      ciRollups: Array<{ worktreeId: string }>;
    };
    persisted.ciRollups[0]!.worktreeId = randomUUID();
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(fixture.dir).snapshot()).rejects.toThrow(
      'CI rollup ownership is inconsistent'
    );
  });

  it('fails closed when durable evidence is missing or shorter than its record', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-missing-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Require durable evidence',
      prompt: 'Do not reinterpret missing evidence as empty output.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(task.id, 'git-snapshot', 'verified evidence');

    await fs.unlink(artifact.path);
    await expect(store.readArtifact(artifact.id)).rejects.toThrow(
      'artifact file is missing'
    );
    await store.close();
    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'referenced task artifact file is missing'
    );

    await fs.writeFile(artifact.path, 'short', { mode: 0o600 });
    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'artifact is missing referenced bytes'
    );
  });

  it('discards an uncommitted artifact tail during crash reconciliation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-tail-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Fence crash tails',
      prompt: 'Keep only artifact bytes named by the durable snapshot.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(task.id, 'git-snapshot', 'committed');
    await fs.appendFile(artifact.path, '-uncommitted');
    await expect(store.readArtifact(artifact.id)).rejects.toThrow(
      'artifact changed during read'
    );
    await expect(store.appendArtifact(artifact.id, '-later')).rejects.toThrow(
      'artifact changed during append'
    );
    await store.close();

    const restarted = new FileTaskStore(dir);
    await expect(restarted.readArtifact(artifact.id)).resolves.toBe('committed');
  });

  it('serializes artifact reads with legitimate appends', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-read-append-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Read committed artifact evidence',
      prompt: 'Do not expose an artifact while its durable metadata is changing.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(
      task.id,
      'git-snapshot',
      'committed'
    );
    const openFile = fs.open.bind(fs);
    const lstatFile = fs.lstat.bind(fs);
    let signalReadStarted!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readPaused = false;
    let appendOverlappedRead = false;
    let artifactOpenCount = 0;
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === artifact.path && readPaused) {
        appendOverlappedRead = true;
      }
      return lstatFile(...args);
    });
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (String(args[0]) !== artifact.path) return handle;
      artifactOpenCount += 1;
      if (artifactOpenCount === 1) {
        const readFile = handle.readFile.bind(handle);
        vi.spyOn(handle, 'readFile').mockImplementationOnce(async (...readArgs) => {
          readPaused = true;
          signalReadStarted();
          try {
            await readGate;
            return await readFile(...readArgs);
          } finally {
            readPaused = false;
          }
        });
      }
      return handle;
    });

    let reading: Promise<string> | undefined;
    let appending: Promise<void> | undefined;
    try {
      reading = store.readArtifact(artifact.id);
      await readStarted;
      appending = store.appendArtifact(artifact.id, '-appended');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(appendOverlappedRead).toBe(false);
      expect(artifactOpenCount).toBe(1);

      releaseRead();
      await expect(reading).resolves.toBe('committed');
      await expect(appending).resolves.toBeUndefined();
      expect(artifactOpenCount).toBe(2);
    } finally {
      releaseRead();
      open.mockRestore();
      lstat.mockRestore();
      await Promise.allSettled([reading, appending].filter(Boolean));
    }

    await expect(store.readArtifact(artifact.id)).resolves.toBe(
      'committed-appended'
    );
    await store.close();
  });

  it.runIf(process.platform !== 'win32')(
    'rejects live access after artifact permissions become unsafe',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-mode-'));
      const store = new FileTaskStore(dir);
      const task = await store.createTask({
        title: 'Protect live artifacts',
        prompt: 'Fail closed if artifact permissions change.',
      repositoryId: (await addTestRepository(store, dir)).id
      });
      const artifact = await store.writeTextArtifact(
        task.id,
        'git-snapshot',
        'private evidence'
      );

      await fs.chmod(artifact.path, 0o644);
      await expect(store.readArtifact(artifact.id)).rejects.toThrow(
        'artifact entry has unsafe permissions'
      );
      await expect(store.appendArtifact(artifact.id, 'more')).rejects.toThrow(
        'artifact entry has unsafe permissions'
      );
      await store.close();

      const restarted = new FileTaskStore(dir);
      await expect(restarted.readArtifact(artifact.id)).resolves.toBe('private evidence');
      expect((await fs.stat(artifact.path)).mode & 0o777).toBe(0o600);
      await restarted.close();
    }
  );

  it('retains a visible truncation marker when an artifact reaches its budget', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-budget-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Bound retained evidence',
      prompt: 'Keep artifact growth finite.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(
      task.id,
      'pr-body',
      'x'.repeat(300 * 1024)
    );

    expect(artifact.byteCount).toBeLessThanOrEqual(256 * 1024);
    await expect(store.readArtifact(artifact.id)).resolves.toMatch(
      /Task Monki truncated pr-body/u
    );
  });

  it('preserves committed artifact bytes when overflow metadata publication fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-rollback-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Rollback bounded evidence',
      prompt: 'Never rewrite bytes named by the durable snapshot.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const limit = 256 * 1024;
    const marker = Buffer.from(
      `\n[Task Monki truncated pr-body after ${limit} retained bytes.]\n`
    );
    const artifact = await store.writeTextArtifact(
      task.id,
      'pr-body',
      'x'.repeat(limit - marker.byteLength - 1)
    );
    const committed = await fs.readFile(artifact.path);
    const renameFile = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (!injected && String(destination) === path.join(dir, 'store.json')) {
        injected = true;
        throw new Error('Injected artifact metadata publication failure.');
      }
      await renameFile(source, destination);
    });
    try {
      await expect(store.appendArtifact(artifact.id, 'yz')).rejects.toThrow(
        'Injected artifact metadata publication failure'
      );
    } finally {
      rename.mockRestore();
    }

    expect(injected).toBe(true);
    expect(await fs.readFile(artifact.path)).toEqual(committed);
    await store.appendArtifact(artifact.id, 'yz');
    await expect(store.readArtifact(artifact.id)).resolves.toMatch(
      /Task Monki truncated pr-body/u
    );
    await store.close();
  });

  it('distinguishes an artifact append whose metadata and file rollback both fail', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-ambiguous-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Surface ambiguous artifact bytes',
      prompt: 'Do not retry an append whose bytes could not be rolled back.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(
      task.id,
      'git-snapshot',
      'committed'
    );
    const renameFile = fs.rename.bind(fs);
    const openFile = fs.open.bind(fs);
    let metadataFailureInjected = false;
    let artifactOpenCount = 0;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (!metadataFailureInjected && String(destination) === path.join(dir, 'store.json')) {
        metadataFailureInjected = true;
        throw new Error('Injected ambiguous metadata failure.');
      }
      await renameFile(source, destination);
    });
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (String(args[0]) === artifact.path) {
        artifactOpenCount += 1;
        if (artifactOpenCount === 2) {
          vi.spyOn(handle, 'truncate').mockRejectedValueOnce(
            new Error('Injected artifact rollback failure.')
          );
        }
      }
      return handle;
    });

    try {
      const failure = await store.appendArtifact(artifact.id, '-possibly-retained').catch(
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(ArtifactAppendAmbiguousError);
      expect(failure).toMatchObject({ artifactId: artifact.id });
    } finally {
      open.mockRestore();
      rename.mockRestore();
    }

    expect(metadataFailureInjected).toBe(true);
    expect(artifactOpenCount).toBe(2);
    await store.close();
  });

  it('removes appended artifact bytes when the file flush fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-flush-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Rollback failed artifact flush',
      prompt: 'Do not retain an uncommitted append.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(
      task.id,
      'git-snapshot',
      'committed'
    );
    const openFile = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (!injected && String(args[0]) === artifact.path) {
        injected = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          new Error('Injected artifact flush failure.')
        );
      }
      return handle;
    });
    try {
      await expect(store.appendArtifact(artifact.id, '-uncommitted')).rejects.toThrow(
        'Injected artifact flush failure'
      );
    } finally {
      open.mockRestore();
    }

    expect(injected).toBe(true);
    await expect(fs.readFile(artifact.path, 'utf8')).resolves.toBe('committed');
    await expect(store.readArtifact(artifact.id)).resolves.toBe('committed');
    await store.close();
  });

  it('restores retry-safe artifact bytes when close fails after a successful append', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-close-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Recover an artifact close failure',
      prompt: 'Keep a failed append safe to retry.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(
      task.id,
      'git-snapshot',
      'committed'
    );
    const openFile = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (!injected && String(args[0]) === artifact.path) {
        injected = true;
        const closeFile = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await closeFile();
          throw new Error('Injected artifact close failure.');
        });
      }
      return handle;
    });

    try {
      const failure = await store.appendArtifact(artifact.id, '-retryable').catch(
        (error: unknown) => error
      );
      expect(failure).not.toBeInstanceOf(ArtifactAppendAmbiguousError);
      expect(failure).toMatchObject({ message: 'Injected artifact close failure.' });
    } finally {
      open.mockRestore();
    }

    expect(injected).toBe(true);
    await expect(store.readArtifact(artifact.id)).resolves.toBe('committed');
    await store.appendArtifact(artifact.id, '-retryable');
    await expect(store.readArtifact(artifact.id)).resolves.toBe('committed-retryable');
    await store.close();
  });

  it('preserves the write failure after close also fails on a completed rollback', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-rollback-close-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Recover a rolled-back close failure',
      prompt: 'Keep the original append failure retry-safe.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(
      task.id,
      'git-snapshot',
      'committed'
    );
    const openFile = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (!injected && String(args[0]) === artifact.path) {
        injected = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          new Error('Injected artifact write flush failure.')
        );
        const closeFile = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await closeFile();
          throw new Error('Injected artifact rollback close failure.');
        });
      }
      return handle;
    });

    try {
      const failure = await store.appendArtifact(artifact.id, '-retryable').catch(
        (error: unknown) => error
      );
      expect(failure).not.toBeInstanceOf(ArtifactAppendAmbiguousError);
      expect(failure).toMatchObject({
        message: 'Injected artifact write flush failure.'
      });
    } finally {
      open.mockRestore();
    }

    expect(injected).toBe(true);
    await expect(store.readArtifact(artifact.id)).resolves.toBe('committed');
    await store.appendArtifact(artifact.id, '-retryable');
    await expect(store.readArtifact(artifact.id)).resolves.toBe('committed-retryable');
    await store.close();
  });

  it('distinguishes an artifact append whose partial bytes cannot be removed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-write-ambiguous-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Surface ambiguous partial bytes',
      prompt: 'Do not retry a partial append whose rollback failed.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(
      task.id,
      'git-snapshot',
      'committed'
    );
    const openFile = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (!injected && String(args[0]) === artifact.path) {
        injected = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          new Error('Injected partial artifact flush failure.')
        );
        vi.spyOn(handle, 'truncate').mockRejectedValueOnce(
          new Error('Injected partial artifact rollback failure.')
        );
      }
      return handle;
    });

    try {
      const failure = await store.appendArtifact(artifact.id, '-possibly-partial').catch(
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(ArtifactAppendAmbiguousError);
      expect(failure).toMatchObject({ artifactId: artifact.id });
    } finally {
      open.mockRestore();
    }

    expect(injected).toBe(true);
    await store.close();
  });

  it('fails closed instead of recursively deleting a temporary-path directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-temp-'));
    const store = new FileTaskStore(dir);
    await store.snapshot();
    await store.close();
    const temporaryDirectory = path.join(dir, 'store.json.attacker.tmp');
    await fs.mkdir(temporaryDirectory);
    await fs.writeFile(path.join(temporaryDirectory, 'keep.txt'), 'keep', 'utf8');

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'temporary path failed its integrity check'
    );
    await expect(
      fs.readFile(path.join(temporaryDirectory, 'keep.txt'), 'utf8')
    ).resolves.toBe('keep');
  });

  it('recovers queued persistence after a write failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-retry-'));
    const store = new FileTaskStore(dir);

    await store.createTask({
      title: 'Initial task',
      prompt: 'Seed the store.',
      repositoryId: (await addTestRepository(store, dir)).id
    });

    const originalOpen = fs.open.bind(fs);
    const storeTemporaryPathPrefix = `${path.join(dir, 'store.json')}.`;
    let injectedFailure = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (
        !injectedFailure &&
        String(args[0]).startsWith(storeTemporaryPathPrefix) &&
        String(args[0]).endsWith('.tmp')
      ) {
        injectedFailure = true;
        vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(
          new Error('Injected store write failure.')
        );
      }
      return handle;
    });
    try {
      await expect(
        store.createTask({
          title: 'Fails while store write is unavailable',
          prompt: 'This persist should fail.',
          repositoryId: (await addTestRepository(store, dir)).id
        })
      ).rejects.toThrow('Injected store write failure');
    } finally {
      open.mockRestore();
    }

    expect(injectedFailure).toBe(true);
    expect((await store.snapshot()).tasks.map((task) => task.title)).toEqual([
      'Initial task'
    ]);
    expect(
      (await fs.readdir(dir)).filter(
        (entry) => entry.startsWith('store.json.') && entry.endsWith('.tmp')
      )
    ).toEqual([]);

    await store.createTask({
      title: 'Persists after recovery',
      prompt: 'This persist should succeed.',
      repositoryId: (await addTestRepository(store, dir)).id
    });

    await store.close();
    const reloaded = new FileTaskStore(dir);
    const snapshot = await reloaded.snapshot();
    expect(snapshot.tasks.map((task) => task.title)).toContain('Initial task');
    expect(snapshot.tasks.map((task) => task.title)).not.toContain(
      'Fails while store write is unavailable'
    );
    expect(snapshot.tasks.map((task) => task.title)).toContain('Persists after recovery');
  });

  it('validates optional task completion policy input', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-policy-input-'));
    const store = new FileTaskStore(dir);

    const manual = await store.createTask({
      title: 'Manual policy task',
      prompt: 'Keep manual completion.',
      repositoryId: (await addTestRepository(store, dir)).id,
      completionPolicy: 'MANUAL'
    });

    expect(manual.completionPolicy).toBe('MANUAL');
    await expect(
      store.createTask({
        title: 'Invalid policy task',
        prompt: 'Reject bad input.',
        repositoryId: (await addTestRepository(store, dir)).id,
        completionPolicy: 'NOT_A_POLICY' as never
      })
    ).rejects.toThrow('Invalid completion policy');
  });

  it('rejects malformed persisted task-creation retry metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-create-key-'));
    const store = new FileTaskStore(dir);
    await store.createTask({
      title: 'Idempotent task',
      prompt: 'Persist the retry key.',
      repositoryId: (await addTestRepository(store, dir)).id,
      creationToken: 'task-create-persisted-shape-0001'
    });
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ creationRequestFingerprint?: string }>;
    };
    persisted.tasks[0]!.creationRequestFingerprint = 'not-a-sha256';
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'tasks contains invalid creation retry metadata'
    );
  });

  it('rejects malformed current-schema task primitives before domain use', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-shape-'));
    const store = new FileTaskStore(dir);
    await store.createTask({
      title: 'Validate durable primitives',
      prompt: 'Reject values that would crash downstream services.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ prompt: unknown }>;
    };
    persisted.tasks[0]!.prompt = 42;
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, {
      mode: 0o600
    });

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'tasks contains a malformed record'
    );
  });

  it('rejects blank review decisions in the current schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-review-repair-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Repair blank review decision',
      prompt: 'Keep a current-schema GitHub snapshot loadable.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-repair',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: 'base'
    });
    await store.recordPullRequestSync({
      pullRequest: {
        taskId: task.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        number: 8,
        url: 'https://github.com/example/repo/pull/8',
        status: 'OPEN_DRAFT',
        headRefName: worktree.branchName,
        headRefOid: 'head'
      },
      ci: {
        taskId: task.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        pullRequestNumber: 8,
        headSha: 'head',
        status: 'NO_CHECKS',
        requiredStatus: 'NO_CHECKS',
        totalCount: 0,
        pendingCount: 0,
        passingCount: 0,
        failingCount: 0,
        skippedCount: 0,
        canceledCount: 0,
        checkDetails: []
      },
      reviews: {
        taskId: task.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        pullRequestNumber: 8,
        headSha: 'head',
        status: 'NOT_REQUESTED'
      },
      merge: {
        taskId: task.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        pullRequestNumber: 8,
        headSha: 'head',
        status: 'NOT_MERGED'
      }
    });
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      reviewRollups: Array<Record<string, unknown>>;
    };
    persisted.reviewRollups[0]!.reviewDecision = '';
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, {
      mode: 0o600
    });

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid`
    );
  });

  it('rejects duplicate persisted task-creation retry tokens', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-create-duplicate-'));
    const store = new FileTaskStore(dir);
    await store.createTask({
      title: 'First idempotent task',
      prompt: 'Persist the first retry key.',
      repositoryId: (await addTestRepository(store, dir)).id,
      creationToken: 'task-create-persisted-first-0001'
    });
    await store.createTask({
      title: 'Second idempotent task',
      prompt: 'Persist the second retry key.',
      repositoryId: (await addTestRepository(store, dir)).id,
      creationToken: 'task-create-persisted-second-0001'
    });
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ creationToken?: string }>;
    };
    persisted.tasks[1]!.creationToken = persisted.tasks[0]!.creationToken;
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'tasks contains invalid creation retry metadata'
    );
  });

  it('rejects unsupported store schemas without rewriting them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-old-schema-'));
    const store = new FileTaskStore(dir);
    await store.createTask({
      title: 'Unsupported schema task',
      prompt: 'Fail closed.',
      repositoryId: (await addTestRepository(store, dir)).id
    });

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          ...persisted,
          schemaVersion: TASK_STORE_SCHEMA_VERSION + 1
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    await store.close();

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      `Unsupported Task Monki store schema ${TASK_STORE_SCHEMA_VERSION + 1}`
    );
    const unchanged = JSON.parse(await fs.readFile(storePath, 'utf8')) as Record<string, unknown>;
    expect(unchanged.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION + 1);
  });

  it('allows stopped environment history but enforces one live environment per task', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-managed-environment-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({ title: 'Managed environment', prompt: 'Test', repositoryId: (await addTestRepository(store, dir)).id });
    const engine = {
      contextName: 'desktop-linux', endpointDigest: 'endpoint', engineId: 'engine',
      serverVersion: '1', apiVersion: '1', operatingSystem: 'linux', architecture: 'arm64'
    };
    const environment = (id: string, state: 'READY' | 'STOPPED') => ({
      id, previewKey: 'task-preview', taskId: task.id, state, engine,
      network: { engine, objectId: `network-${id}`, objectName: `network-${id}`, labelsDigest: 'labels' },
      ownershipMarkerDigest: 'marker', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    await store.savePreviewManagedEnvironment(environment('old', 'STOPPED'));
    await store.savePreviewManagedEnvironment(environment('live', 'READY'));
    await store.savePreviewManagedEnvironment(environment('old', 'STOPPED'));

    await expect(store.savePreviewManagedEnvironment(environment('duplicate', 'READY')))
      .rejects.toThrow('only one managed environment');
  });

  it('persists preview records and refuses task deletion while ownership is unresolved', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-preview-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Preview task',
      prompt: 'Run the preview.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/preview',
      worktreePath: dir,
      baseSha: 'base'
    });
    const now = new Date().toISOString();
    const sourceSnapshot = await recordTestPreviewSnapshot(
      store,
      task.id,
      iteration,
      worktree,
      dir
    );
    const plan = await store.savePreviewPlan({
      id: 'plan-1',
      taskId: task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      planSource: repositoryPreviewPlanSource(),
      executionDigest: TEST_PREVIEW_EXECUTION_DIGEST,
      executionPlan: { version: 1, jobs: [], resources: [], services: [], workers: [], routes: [], scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default' },
      warnings: [],
      createdAt: now
    });
    const approval = await store.savePreviewApproval({
      id: randomUUID(),
      taskId: task.id,
      planId: plan.id,
      executionDigest: plan.executionDigest,
      scope: 'TASK',
      approvedAt: now
    });
    const generation = await store.savePreviewGeneration({
      id: 'generation-1',
      previewKey: 'preview-task',
      taskId: task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      planId: plan.id,
      executionAuthority: userPreviewAuthority(approval.id, plan.executionDigest),
      source: previewSnapshotIdentity(sourceSnapshot),
      workspacePath: path.join(dir, 'preview-runtime', 'generation-1'),
      state: 'CREATED',
      routingState: 'CANDIDATE',
      freshness: 'CURRENT',
      routes: [],
      createdAt: now,
      updatedAt: now
    });
    await store.savePreviewPlan({
      ...plan,
      id: 'plan-2',
      planSource: repositoryPreviewPlanSource('c'.repeat(64)),
      executionDigest: 'd'.repeat(64),
      createdAt: new Date(Date.parse(now) + 1).toISOString()
    });
    await expect(
      store.savePreviewGeneration({ ...generation, state: 'PREPARING_SOURCE' })
    ).resolves.toMatchObject({ state: 'PREPARING_SOURCE' });
    await expect(
      store.savePreviewGeneration({ ...generation, id: 'generation-2' })
    ).rejects.toThrow('missing or mismatched task authority');
    const resource = await store.savePreviewResource({
      id: 'resource-1',
      taskId: task.id,
      generationId: generation.id,
      logicalNodeId: 'web',
      adapterKind: 'NATIVE_PROCESS',
      state: 'INTENDED',
      ownershipMarkerDigest: 'marker',
      updatedAt: now
    });

    await expect(store.deleteTask(task.id)).rejects.toThrow('active or unverified preview resource');
    await store.savePreviewResource({ ...resource, state: 'STOPPED', updatedAt: new Date().toISOString() });
    await store.savePreviewGeneration({
      ...generation,
      state: 'STOPPED',
      stoppedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await store.deleteTask(task.id);

    await expect(store.savePreviewGeneration(generation)).rejects.toThrow(
      'missing or mismatched task authority'
    );

    await store.close();
    const snapshot = await new FileTaskStore(dir).snapshot();
    expect(snapshot.previewPlans).toEqual([]);
    expect(snapshot.previewApprovals).toEqual([]);
    expect(snapshot.previewGenerations).toEqual([]);
    expect(snapshot.previewResources).toEqual([]);
  });

  it('reads bounded artifact ranges without splitting UTF-8 code points', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-artifact-range-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({ title: 'Logs', prompt: 'Tail safely', repositoryId: (await addTestRepository(store, dir)).id });
    const artifact = await store.createPreviewArtifact(task.id, 'preview-stdout');
    await store.appendBoundedArtifact(artifact.id, 'a😀b');
    const first = await store.readArtifactRange(artifact.id, 0, 4);
    expect(first).toEqual({ chunk: 'a', nextOffset: 1, endOfFile: false });
    const second = await store.readArtifactRange(artifact.id, first.nextOffset, 4);
    expect(second).toEqual({ chunk: '😀', nextOffset: 5, endOfFile: false });
    await expect(store.readArtifactRange(artifact.id, second.nextOffset, 64)).resolves.toEqual({
      chunk: 'b', nextOffset: 6, endOfFile: true
    });
    await expect(store.readArtifactRange(artifact.id, 1, 3)).rejects.toThrow('4-65536');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('bounds terminal preview history and removes its child evidence and files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-preview-prune-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({ title: 'History', prompt: 'Bound it', repositoryId: (await addTestRepository(store, dir)).id });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task, branchName: 'codex/history', worktreePath: dir, baseSha: 'base'
    });
    const now = Date.now();
    const sourceSnapshot = await recordTestPreviewSnapshot(
      store,
      task.id,
      iteration,
      worktree,
      dir
    );
    const plan = await store.savePreviewPlan({
      id: 'plan', taskId: task.id, iterationId: iteration.id, worktreeId: worktree.id,
      planSource: repositoryPreviewPlanSource(),
      executionDigest: TEST_PREVIEW_EXECUTION_DIGEST, executionPlan: { version: 1, jobs: [], resources: [], services: [], workers: [], routes: [], scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default' },
      warnings: [], createdAt: new Date(now).toISOString()
    });
    const approval = await store.savePreviewApproval({
      id: randomUUID(), taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
      scope: 'TASK', approvedAt: new Date(now).toISOString()
    });
    const engine = {
      contextName: 'desktop-linux', endpointDigest: 'endpoint', engineId: 'engine',
      serverVersion: '1', apiVersion: '1', operatingSystem: 'linux', architecture: 'arm64'
    };
    const environment = await store.savePreviewManagedEnvironment({
      id: 'environment', previewKey: 'task-history', taskId: task.id, state: 'READY', engine,
      network: { engine, objectId: 'network', objectName: 'network', labelsDigest: 'network-labels' },
      ownershipMarkerDigest: 'environment-marker', createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString()
    });
    const managedResource = await store.savePreviewManagedResource({
      id: 'managed-database', taskId: task.id, environmentId: environment.id,
      logicalResourceId: 'database', type: 'postgres', state: 'READY', planDigest: 'resource-plan',
      ownershipMarkerDigest: 'resource-marker',
      container: { engine, objectId: 'container', objectName: 'container', labelsDigest: 'container-labels' },
      volume: { engine, objectId: 'volume', objectName: 'volume', labelsDigest: 'volume-labels' },
      binding: {
        id: 'binding', digest: 'binding-digest', host: '127.0.0.1', ports: { postgres: 41000 },
        username: 'safe_user', database: 'app'
      },
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
    });
    const artifactPaths = new Map<string, string>();
    for (let index = 0; index < 4; index += 1) {
      const timestamp = new Date(now + index).toISOString();
      const generationId = `generation-${index}`;
      await store.savePreviewGeneration({
        id: generationId, previewKey: 'task-history', taskId: task.id, iterationId: iteration.id,
        worktreeId: worktree.id, planId: plan.id,
        executionAuthority: userPreviewAuthority(approval.id, plan.executionDigest),
        source: previewSnapshotIdentity(sourceSnapshot), workspacePath: `/preview/${index}`,
        state: 'STOPPED', routingState: 'RETIRED', freshness: 'CURRENT', routes: [],
        createdAt: timestamp, updatedAt: timestamp, stoppedAt: timestamp
      });
      await store.savePreviewGenerationAttachments([{
        id: `attachment-${index}`, taskId: task.id, generationId,
        managedResourceId: managedResource.id, logicalResourceId: managedResource.logicalResourceId,
        bindingId: managedResource.binding!.id, attachedAt: timestamp
      }]);
      const stdout = await store.createPreviewArtifact(task.id, 'preview-stdout');
      const stderr = await store.createPreviewArtifact(task.id, 'preview-stderr');
      artifactPaths.set(generationId, stdout.path);
      await store.savePreviewNodeAttempt({
        id: `attempt-${index}`, taskId: task.id, generationId, nodeId: 'web', kind: 'SERVICE',
        attempt: 1, commandDigest: 'command', state: 'STOPPED',
        stdoutArtifactId: stdout.id, stderrArtifactId: stderr.id
      });
    }
    await expect(store.prunePreviewHistory(task.id, 2)).resolves.toBe(2);
    const snapshot = await store.snapshot();
    expect(snapshot.previewGenerations.map((generation) => generation.id).sort()).toEqual([
      'generation-2', 'generation-3'
    ]);
    expect(snapshot.previewNodeAttempts).toHaveLength(2);
    expect(snapshot.previewManagedEnvironments).toEqual([environment]);
    expect(snapshot.previewManagedResources).toEqual([managedResource]);
    expect(snapshot.previewGenerationAttachments.map((attachment) => attachment.generationId).sort()).toEqual([
      'generation-2', 'generation-3'
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('postgresql://');
    await expect(fs.access(artifactPaths.get('generation-0')!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(artifactPaths.get('generation-3')!)).resolves.toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('bounds completed argv probe attempts and resources while a generation remains active', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-probe-prune-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({ title: 'Probe history', prompt: 'Bound it live', repositoryId: (await addTestRepository(store, dir)).id });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task, branchName: 'codex/probe-history', worktreePath: dir, baseSha: 'base'
    });
    const now = Date.now();
    const sourceSnapshot = await recordTestPreviewSnapshot(
      store,
      task.id,
      iteration,
      worktree,
      dir
    );
    const plan = await store.savePreviewPlan({
      id: 'plan', taskId: task.id, iterationId: iteration.id, worktreeId: worktree.id,
      planSource: repositoryPreviewPlanSource(),
      executionDigest: TEST_PREVIEW_EXECUTION_DIGEST, executionPlan: { version: 1, jobs: [], resources: [], services: [], workers: [], routes: [], scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default' },
      warnings: [], createdAt: new Date(now).toISOString()
    });
    const approval = await store.savePreviewApproval({
      id: randomUUID(), taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
      scope: 'TASK', approvedAt: new Date(now).toISOString()
    });
    const generation = await store.savePreviewGeneration({
      id: 'generation', previewKey: 'task-probe', taskId: task.id, iterationId: iteration.id,
      worktreeId: worktree.id, planId: plan.id,
      executionAuthority: userPreviewAuthority(approval.id, plan.executionDigest),
      source: previewSnapshotIdentity(sourceSnapshot), workspacePath: '/preview', state: 'READY',
      routingState: 'ACTIVE', freshness: 'CURRENT', routes: [],
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
    });
    const artifactPaths = new Map<number, string>();
    for (let index = 1; index <= 8; index += 1) {
      const stdout = await store.createPreviewArtifact(task.id, 'preview-stdout');
      const stderr = await store.createPreviewArtifact(task.id, 'preview-stderr');
      artifactPaths.set(index, stdout.path);
      await store.savePreviewNodeAttempt({
        id: `attempt-${index}`, taskId: task.id, generationId: generation.id,
        nodeId: 'web-probe', kind: 'PROBE', attempt: index, commandDigest: 'probe',
        state: 'SUCCEEDED', stdoutArtifactId: stdout.id, stderrArtifactId: stderr.id,
        endedAt: new Date(now + index).toISOString()
      });
      await store.savePreviewResource({
        id: `resource-${index}`, taskId: task.id, generationId: generation.id,
        logicalNodeId: 'web-probe', adapterKind: 'NATIVE_PROCESS', state: 'EXITED',
        ownershipMarkerDigest: 'marker', updatedAt: new Date(now + index).toISOString()
      });
    }

    await expect(store.prunePreviewProbeHistory(generation.id, 'web-probe', 3)).resolves.toBe(5);
    const snapshot = await store.snapshot();
    expect(snapshot.previewNodeAttempts.filter((attempt) => attempt.nodeId === 'web-probe')).toHaveLength(3);
    expect(snapshot.previewResources.filter((resource) => resource.logicalNodeId === 'web-probe')).toHaveLength(3);
    expect(
      snapshot.events.some(
        (event) =>
          event.previewGenerationId === generation.id &&
          (event.payload as { nodeId?: string } | undefined)?.nodeId === 'web-probe'
      )
    ).toBe(false);
    await expect(fs.access(artifactPaths.get(1)!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(artifactPaths.get(8)!)).resolves.toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rolls back both in-memory generation roles when atomic cutover persistence fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-cutover-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({ title: 'Cutover', prompt: 'Stay atomic', repositoryId: (await addTestRepository(store, dir)).id });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task, branchName: 'codex/cutover', worktreePath: dir, baseSha: 'base'
    });
    const now = new Date().toISOString();
    const sourceSnapshot = await recordTestPreviewSnapshot(
      store,
      task.id,
      iteration,
      worktree,
      dir
    );
    const plan = await store.savePreviewPlan({
      id: 'plan', taskId: task.id, iterationId: iteration.id, worktreeId: worktree.id,
      planSource: repositoryPreviewPlanSource(),
      executionDigest: TEST_PREVIEW_EXECUTION_DIGEST, executionPlan: { version: 1, jobs: [], resources: [], services: [], workers: [], routes: [], scenarios: [{ id: 'default', jobs: [], resources: [] }], selectedScenarioId: 'default' },
      warnings: [], createdAt: now
    });
    const approval = await store.savePreviewApproval({
      id: randomUUID(), taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
      scope: 'TASK', approvedAt: now
    });
    const authority = {
      previewKey: 'task-cutover', taskId: task.id, iterationId: iteration.id, worktreeId: worktree.id,
      planId: plan.id,
      executionAuthority: userPreviewAuthority(approval.id, plan.executionDigest),
      source: previewSnapshotIdentity(sourceSnapshot),
      freshness: 'CURRENT' as const, routes: [], createdAt: now, updatedAt: now
    };
    const active = await store.savePreviewGeneration({
      ...authority, id: 'active', workspacePath: '/active', state: 'READY', routingState: 'ACTIVE'
    });
    const candidate = await store.savePreviewGeneration({
      ...authority, id: 'candidate', workspacePath: '/candidate', state: 'WAITING_READY',
      routingState: 'CANDIDATE', replacesGenerationId: active.id
    });
    const originalOpen = fs.open.bind(fs);
    const storeTemporaryPathPrefix = `${path.join(dir, 'store.json')}.`;
    let injected = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (
        !injected &&
        String(args[0]).startsWith(storeTemporaryPathPrefix) &&
        String(args[0]).endsWith('.tmp')
      ) {
        injected = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          new Error('injected persistence failure')
        );
      }
      return handle;
    });
    try {
      await expect(store.cutoverPreviewGenerations({
        candidate: { ...candidate, state: 'READY', routingState: 'ACTIVE' },
        replaced: { ...active, routingState: 'RETIRED' }
      })).rejects.toThrow('persistence failure');
    } finally {
      open.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await store.getPreviewGeneration(active.id)).toMatchObject({ routingState: 'ACTIVE' });
    expect(await store.getPreviewGeneration(candidate.id)).toMatchObject({ routingState: 'CANDIDATE' });
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('links forked alternative tasks to their source task and run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-fork-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Compare approaches',
      prompt: 'Implement the feature.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/source',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: 'codex'
    });
    const run = await createTestRun(store, {
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });

    const alternative = await store.createForkedAlternativeTask({
      title: 'Alternative: Compare approaches',
      prompt: 'Try another implementation.',
      repositoryId: (await addTestRepository(store, dir)).id,
      sourceTaskId: task.id,
      sourceRunId: run.id
    });
    const snapshot = await store.snapshot();
    const source = snapshot.tasks.find((candidate) => candidate.id === task.id);
    const linkedAlternative = snapshot.tasks.find(
      (candidate) => candidate.id === alternative.id
    );

    expect(source?.forkedAlternativeTaskIds).toEqual([alternative.id]);
    expect(linkedAlternative?.forkedFromTaskId).toBe(task.id);
    expect(linkedAlternative?.forkedFromRunId).toBe(run.id);
    expect(
      snapshot.events.some(
        (event) =>
          event.type === 'TASK_ALTERNATIVE_CREATED' &&
          event.taskId === task.id &&
          event.runId === run.id
      )
    ).toBe(true);
  });

  it('moves only the linked task to merged completion policy when PR evidence is recorded', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-pr-policy-'));
    const store = new FileTaskStore(dir);

    const linkedTask = await store.createTask({
      title: 'Linked PR task',
      prompt: 'Open a PR for this task.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const untouchedTask = await store.createTask({
      title: 'Untouched local task',
      prompt: 'Keep this task local.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task: linkedTask,
      branchName: 'codex/linked-pr',
      worktreePath: path.join(dir, 'linked'),
      baseSha: 'base'
    });

    await recordOpenPullRequest(store, linkedTask.id, iteration, worktree);

    const snapshot = await store.snapshot();
    const linked = snapshot.tasks.find((task) => task.id === linkedTask.id);
    const untouched = snapshot.tasks.find((task) => task.id === untouchedTask.id);
    expect(linked?.completionPolicy).toBe('MERGED');
    expect(linked?.phaseVersion).toBe(linkedTask.phaseVersion + 1);
    expect(untouched?.completionPolicy).toBe('LOCAL_ACCEPTANCE');
  });

  it('records in-progress branch publication as a request, not a failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-branch-pushing-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Publish branch',
      prompt: 'Push the branch.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/publish-branch',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: 'base'
    });

    await store.recordBranchPublication({
      taskId: task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      remoteName: 'origin',
      branchName: worktree.branchName,
      remoteRef: `origin/${worktree.branchName}`,
      status: 'PUSHING'
    });

    const snapshot = await store.snapshot();
    expect(snapshot.branchPublications[0]).toMatchObject({ status: 'PUSHING' });
    expect(snapshot.tasks.find((candidate) => candidate.id === task.id)?.projection).toMatchObject({
      branchPublication: 'PUSHING'
    });
    expect(
      snapshot.events.some((event) => event.type === 'BRANCH_PUBLISH_REQUESTED')
    ).toBe(true);
    expect(snapshot.events.some((event) => event.type === 'BRANCH_PUBLISH_FAILED')).toBe(false);
  });

  it('does not downgrade stricter or manual completion policies when PR evidence refreshes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-pr-policy-preserve-'));
    const store = new FileTaskStore(dir);

    const verifiedTask = await store.createTask({
      title: 'Verified merge task',
      prompt: 'Keep verification after merge.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const manualTask = await store.createTask({
      title: 'Manual completion task',
      prompt: 'Keep manual completion.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const verifiedRecords = await store.createIterationAndWorktree({
      task: verifiedTask,
      branchName: 'codex/verified-policy',
      worktreePath: path.join(dir, 'verified'),
      baseSha: 'base'
    });
    const manualRecords = await store.createIterationAndWorktree({
      task: manualTask,
      branchName: 'codex/manual-policy',
      worktreePath: path.join(dir, 'manual'),
      baseSha: 'base'
    });

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ id: string; completionPolicy: string }>;
    };
    persisted.tasks = persisted.tasks.map((task) =>
      task.id === verifiedTask.id
        ? { ...task, completionPolicy: 'MERGED_AND_VERIFIED' }
        : task.id === manualTask.id
          ? { ...task, completionPolicy: 'MANUAL' }
          : task
    );
    await store.close();
    await fs.writeFile(storePath, JSON.stringify(persisted, null, 2));

    const reloaded = new FileTaskStore(dir);
    await recordOpenPullRequest(
      reloaded,
      verifiedTask.id,
      verifiedRecords.iteration,
      verifiedRecords.worktree
    );
    await recordOpenPullRequest(
      reloaded,
      manualTask.id,
      manualRecords.iteration,
      manualRecords.worktree,
      83
    );

    const snapshot = await reloaded.snapshot();
    expect(snapshot.tasks.find((task) => task.id === verifiedTask.id)?.completionPolicy).toBe(
      'MERGED_AND_VERIFIED'
    );
    expect(snapshot.tasks.find((task) => task.id === manualTask.id)?.completionPolicy).toBe(
      'MANUAL'
    );
  });

  it('auto-completes only when merged PR evidence satisfies the task completion policy', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-pr-auto-done-'));
    const store = new FileTaskStore(dir);

    const mergedTask = await store.createTask({
      title: 'Merged task',
      prompt: 'Complete when merged.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const verifiedTask = await store.createTask({
      title: 'Verified task',
      prompt: 'Require checks after merge.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const verifiedStaleTask = await store.createTask({
      title: 'Verified stale task',
      prompt: 'Reject old passing checks after merge.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const verifiedPassingTask = await store.createTask({
      title: 'Verified passing task',
      prompt: 'Complete when merged checks match.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const manualTask = await store.createTask({
      title: 'Manual task',
      prompt: 'Require explicit completion.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const archivedTask = await store.createTask({
      title: 'Archived task',
      prompt: 'Retain remote evidence without reactivating the task.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const mismatchedTask = await store.createTask({
      title: 'Mismatched merge task',
      prompt: 'Reject a merge snapshot for another head.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const mergedRecords = await store.createIterationAndWorktree({
      task: mergedTask,
      branchName: 'codex/merged-task',
      worktreePath: path.join(dir, 'merged'),
      baseSha: 'base'
    });
    const verifiedRecords = await store.createIterationAndWorktree({
      task: verifiedTask,
      branchName: 'codex/verified-task',
      worktreePath: path.join(dir, 'verified'),
      baseSha: 'base'
    });
    const verifiedStaleRecords = await store.createIterationAndWorktree({
      task: verifiedStaleTask,
      branchName: 'codex/verified-stale-task',
      worktreePath: path.join(dir, 'verified-stale'),
      baseSha: 'base'
    });
    const verifiedPassingRecords = await store.createIterationAndWorktree({
      task: verifiedPassingTask,
      branchName: 'codex/verified-passing-task',
      worktreePath: path.join(dir, 'verified-passing'),
      baseSha: 'base'
    });
    const manualRecords = await store.createIterationAndWorktree({
      task: manualTask,
      branchName: 'codex/manual-task',
      worktreePath: path.join(dir, 'manual'),
      baseSha: 'base'
    });
    const archivedRecords = await store.createIterationAndWorktree({
      task: archivedTask,
      branchName: 'codex/archived-task',
      worktreePath: path.join(dir, 'archived'),
      baseSha: 'base'
    });
    const mismatchedRecords = await store.createIterationAndWorktree({
      task: mismatchedTask,
      branchName: 'codex/mismatched-task',
      worktreePath: path.join(dir, 'mismatched'),
      baseSha: 'base'
    });

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ id: string; completionPolicy: string }>;
    };
    persisted.tasks = persisted.tasks.map((task) =>
      task.id === verifiedTask.id ||
      task.id === verifiedStaleTask.id ||
      task.id === verifiedPassingTask.id
        ? { ...task, completionPolicy: 'MERGED_AND_VERIFIED' }
        : task.id === manualTask.id
          ? { ...task, completionPolicy: 'MANUAL' }
          : task
    );
    await store.close();
    await fs.writeFile(storePath, JSON.stringify(persisted, null, 2));

    const reloaded = new FileTaskStore(dir);
    await reloaded.transitionTask(archivedTask.id, 'ARCHIVED', 'Archive before merge refresh.');
    await recordOpenPullRequest(reloaded, mergedTask.id, mergedRecords.iteration, mergedRecords.worktree, {
      mergeStatus: 'MERGED'
    });
    await recordOpenPullRequest(
      reloaded,
      verifiedTask.id,
      verifiedRecords.iteration,
      verifiedRecords.worktree,
      { ciStatus: 'FAILING', mergeStatus: 'MERGED', pullRequestNumber: 83 }
    );
    await recordOpenPullRequest(
      reloaded,
      verifiedStaleTask.id,
      verifiedStaleRecords.iteration,
      verifiedStaleRecords.worktree,
      {
        ciStatus: 'PASSING',
        ciHeadSha: 'old-head',
        mergeHeadSha: 'merged-head',
        mergeStatus: 'MERGED',
        pullRequestNumber: 84
      }
    );
    await recordOpenPullRequest(
      reloaded,
      verifiedPassingTask.id,
      verifiedPassingRecords.iteration,
      verifiedPassingRecords.worktree,
      {
        ciStatus: 'PASSING',
        ciHeadSha: 'merged-head',
        mergeHeadSha: 'merged-head',
        mergeStatus: 'MERGED',
        pullRequestNumber: 85
      }
    );
    await recordOpenPullRequest(
      reloaded,
      manualTask.id,
      manualRecords.iteration,
      manualRecords.worktree,
      { mergeStatus: 'MERGED', pullRequestNumber: 86 }
    );
    await recordOpenPullRequest(
      reloaded,
      archivedTask.id,
      archivedRecords.iteration,
      archivedRecords.worktree,
      { mergeStatus: 'MERGED', pullRequestNumber: 87 }
    );
    await recordOpenPullRequest(
      reloaded,
      mismatchedTask.id,
      mismatchedRecords.iteration,
      mismatchedRecords.worktree,
      {
        mergeStatus: 'MERGED',
        mergeHeadSha: 'merged-head',
        pullRequestHeadSha: 'stale-head',
        pullRequestNumber: 88
      }
    );

    const snapshot = await reloaded.snapshot();
    expect(snapshot.tasks.find((task) => task.id === mergedTask.id)).toMatchObject({
      completionPolicy: 'MERGED',
      workflowPhase: 'DONE',
      resolution: 'COMPLETED'
    });
    expect(snapshot.tasks.find((task) => task.id === verifiedTask.id)).toMatchObject({
      completionPolicy: 'MERGED_AND_VERIFIED',
      workflowPhase: 'READY',
      resolution: 'NONE'
    });
    expect(snapshot.tasks.find((task) => task.id === verifiedStaleTask.id)).toMatchObject({
      completionPolicy: 'MERGED_AND_VERIFIED',
      workflowPhase: 'READY',
      resolution: 'NONE'
    });
    expect(snapshot.tasks.find((task) => task.id === verifiedPassingTask.id)).toMatchObject({
      completionPolicy: 'MERGED_AND_VERIFIED',
      workflowPhase: 'DONE',
      resolution: 'COMPLETED'
    });
    expect(snapshot.tasks.find((task) => task.id === manualTask.id)).toMatchObject({
      completionPolicy: 'MANUAL',
      workflowPhase: 'READY',
      resolution: 'NONE'
    });
    expect(snapshot.tasks.find((task) => task.id === archivedTask.id)).toMatchObject({
      completionPolicy: 'MERGED',
      workflowPhase: 'ARCHIVED',
      resolution: 'NONE',
      projection: { merge: 'MERGED' }
    });
    expect(snapshot.tasks.find((task) => task.id === mismatchedTask.id)).toMatchObject({
      completionPolicy: 'MERGED',
      workflowPhase: 'READY',
      resolution: 'NONE',
      projection: { merge: 'MERGED' }
    });
  });

  it('does not auto-complete a merged task whose implementation failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-pr-retry-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Retry before review',
      prompt: 'Make the requested change.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/retry-before-merge',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: 'base'
    });
    const session = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: task.runtimeId
    });
    const run = await createTestRun(store, {
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_FAILED',
        taskId: task.id,
        iterationId: iteration.id,
        runId: run.id,
        source: 'provider',
        payload: { error: 'Provider implementation failed.' }
      })
    );

    await recordOpenPullRequest(store, task.id, iteration, worktree, {
      mergeStatus: 'MERGED'
    });

    expect(await store.getTask(task.id)).toMatchObject({
      completionPolicy: 'MERGED',
      workflowPhase: 'IN_PROGRESS',
      resolution: 'NONE',
      projection: {
        merge: 'MERGED',
        agentRun: 'FAILED'
      }
    });
  });

  it('deletes only the selected task records and repairs fork links', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-delete-'));
    const store = new FileTaskStore(dir);

    const sourceTask = await store.createTask({
      title: 'Compare deletion',
      prompt: 'Build the source task.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration: sourceIteration, worktree: sourceWorktree } =
      await store.createIterationAndWorktree({
        task: sourceTask,
        branchName: 'codex/source-delete',
        worktreePath: path.join(dir, 'source'),
        baseSha: 'base'
      });
    const sourceSession = await createTestAgentSession(store, {
      task: sourceTask,
      iteration: sourceIteration,
      worktree: sourceWorktree,
      runtimeId: 'codex'
    });
    const sourceRun = await createTestRun(store, {
      task: sourceTask,
      session: sourceSession,
      mode: 'IMPLEMENTATION',
      prompt: sourceTask.prompt
    });

    const alternativeTask = await store.createForkedAlternativeTask({
      title: 'Alternative: Compare deletion',
      prompt: 'Try another implementation.',
      repositoryId: (await addTestRepository(store, dir)).id,
      sourceTaskId: sourceTask.id,
      sourceRunId: sourceRun.id
    });
    const { iteration: alternativeIteration, worktree: alternativeWorktree } =
      await store.createIterationAndWorktree({
        task: alternativeTask,
        branchName: 'codex/alternative-delete',
        worktreePath: path.join(dir, 'alternative'),
        baseSha: 'base'
      });
    const gitSnapshot = await store.recordGitSnapshot(
      {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        worktreePath: alternativeWorktree.worktreePath,
        repoRoot: dir,
        gitCommonDir: path.join(dir, '.git'),
        headSha: 'head',
        branch: alternativeWorktree.branchName,
        baseSha: alternativeWorktree.baseSha,
        aheadCount: 0,
        behindCount: 0,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        commitsAheadOfBase: 0,
        committedDiffFileCount: 0,
        workingDiffFileCount: 0,
        diffStat: '',
        dirtyFingerprint: 'clean',
        status: 'CLEAN'
      },
      ''
    );
    await store.recordGitHubPreflight({
      taskId: alternativeTask.id,
      iterationId: alternativeIteration.id,
      worktreeId: alternativeWorktree.id,
      remoteName: 'origin',
      remoteUrl: 'https://github.com/example/repo.git',
      host: 'github.com',
      owner: 'example',
      repo: 'repo',
      status: 'READY'
    });
    await store.recordBranchPublication({
      taskId: alternativeTask.id,
      iterationId: alternativeIteration.id,
      worktreeId: alternativeWorktree.id,
      remoteName: 'origin',
      branchName: alternativeWorktree.branchName,
      remoteRef: `refs/heads/${alternativeWorktree.branchName}`,
      headSha: 'head',
      status: 'PUSHED'
    });
    await store.recordPullRequestSync({
      pullRequest: {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        number: 42,
        url: 'https://github.com/example/repo/pull/42',
        status: 'OPEN_DRAFT',
        headRefName: alternativeWorktree.branchName,
        headRefOid: 'head'
      },
      ci: {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        pullRequestNumber: 42,
        headSha: 'head',
        status: 'PASSING',
        requiredStatus: 'PASSING',
        totalCount: 1,
        pendingCount: 0,
        passingCount: 1,
        failingCount: 0,
        skippedCount: 0,
        canceledCount: 0,
        checkDetails: []
      },
      reviews: {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        pullRequestNumber: 42,
        headSha: 'head',
        status: 'APPROVED'
      },
      merge: {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        pullRequestNumber: 42,
        headSha: 'head',
        status: 'MERGEABLE'
      }
    });
    const artifactsBeforeDelete = (await store.snapshot()).artifacts;
    const artifactPath = (artifactId: string) =>
      artifactsBeforeDelete.find((artifact) => artifact.id === artifactId)!.path;
    const diffArtifactPath = artifactPath(gitSnapshot.diffArtifactId!);

    await store.deleteTask(alternativeTask.id);

    const snapshot = await store.snapshot();
    const sourceAfterDelete = snapshot.tasks.find((task) => task.id === sourceTask.id);

    expect(snapshot.tasks.some((task) => task.id === alternativeTask.id)).toBe(false);
    expect(sourceAfterDelete).toBeDefined();
    expect(sourceAfterDelete?.forkedAlternativeTaskIds).not.toContain(alternativeTask.id);
    expect(snapshot.runs.some((run) => run.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.iterations.some((iteration) => iteration.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.worktrees.some((worktree) => worktree.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.gitSnapshots.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.githubRepositories.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.branchPublications.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.pullRequests.some((record) => record.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.ciRollups.some((record) => record.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.reviewRollups.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.mergeSnapshots.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.agentSessions.some((session) => session.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.events.some((event) => event.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.artifacts.some((artifact) => artifact.taskId === alternativeTask.id)).toBe(false);
    expect(
      snapshot.events.some(
        (event) =>
          event.taskId === sourceTask.id &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          !Array.isArray(event.payload) &&
          (event.payload as { alternativeTaskId?: string }).alternativeTaskId === alternativeTask.id
      )
    ).toBe(true);
    await expect(fs.access(diffArtifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not delete fork alternatives when deleting their source task', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-delete-source-'));
    const store = new FileTaskStore(dir);

    const sourceTask = await store.createTask({
      title: 'Source delete',
      prompt: 'Build the original task.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task: sourceTask,
      branchName: 'codex/delete-source',
      worktreePath: path.join(dir, 'source'),
      baseSha: 'base'
    });
    const session = await createTestAgentSession(store, {
      task: sourceTask,
      iteration,
      worktree,
      runtimeId: 'codex'
    });
    const run = await createTestRun(store, {
      task: sourceTask,
      session,
      mode: 'IMPLEMENTATION',
      prompt: sourceTask.prompt
    });
    const alternativeTask = await store.createForkedAlternativeTask({
      title: 'Alternative: Source delete',
      prompt: 'Keep this alternative.',
      repositoryId: (await addTestRepository(store, dir)).id,
      sourceTaskId: sourceTask.id,
      sourceRunId: run.id
    });

    await updateTestRun(store, run.id, { status: 'FAILED' });
    await runtimeFixture(store).store.purgeTask(sourceTask.id);
    await store.deleteTask(sourceTask.id);

    const snapshot = await store.snapshot();
    const alternativeAfterDelete = snapshot.tasks.find(
      (candidate) => candidate.id === alternativeTask.id
    );

    expect(snapshot.tasks.some((candidate) => candidate.id === sourceTask.id)).toBe(false);
    expect(alternativeAfterDelete).toBeDefined();
    expect(alternativeAfterDelete?.forkedFromTaskId).toBeUndefined();
    expect(alternativeAfterDelete?.forkedFromRunId).toBeUndefined();
  });

  it('rejects schema-current task records missing required alternative ids', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-repair-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair task shape',
      prompt: 'Keep current records loadable.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.tasks = raw.tasks.map((candidate: any) => {
      if (candidate.id !== task.id) {
        return candidate;
      }
      const withoutAlternatives = { ...candidate };
      delete withoutAlternatives.forkedAlternativeTaskIds;
      return withoutAlternatives;
    });
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    await store.close();

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      `Task Monki store schema ${TASK_STORE_SCHEMA_VERSION} is invalid`
    );
  });

  it('preserves structured terminal review status when reloading', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-status-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Keep review verdict',
      prompt: 'Render passed review actions.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-verdict',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: 'codex'
    });
    const implementationRun = await createTestRun(store, {
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: task.id,
        iterationId: iteration.id,
        runId: implementationRun.id,
        worktreeId: worktree.id,
        agentSessionId: implementationSession.id,
        source: 'provider',
        payload: { terminalReason: 'completed' }
      })
    );

    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await createTestAgentSession(store, {
      task: reviewTask,
      iteration,
      worktree,
      runtimeId: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await createTestRun(store, {
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: task.id,
        iterationId: iteration.id,
        runId: reviewRun.id,
        worktreeId: worktree.id,
        agentSessionId: reviewSession.id,
        source: 'provider',
        payload: {
          mode: 'REVIEW',
          agentReviewResult: {
            schemaVersion: 'agent-review/v1',
            verdict: 'PASSED',
            summary: 'No blocking issues found.',
            findings: []
          }
        }
      })
    );

    expect((await store.getTask(task.id))?.projection.agentReview?.status).toBe('PASSED');
    await store.close();
    const reloadedTask = (await new FileTaskStore(dir).getTask(task.id))!;
    expect(reloadedTask.projection.agentReview?.status).toBe('PASSED');
    expect(reloadedTask.projection.agentReview?.result?.verdict).toBe('PASSED');
  });

  it.each([
    ['review run', 'runId'],
    ['source run', 'sourceRunId'],
    ['final artifact', 'finalArtifactId']
  ] as const)('rejects an agent review whose %s belongs to another task', async (_label, field) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-ownership-'));
    const store = new FileTaskStore(dir);

    const createReview = async (title: string) => {
      const task = await store.createTask({
        title,
        prompt: 'Implement and review.',
      repositoryId: (await addTestRepository(store, dir)).id
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: `codex/${title.toLowerCase().replaceAll(' ', '-')}`,
        worktreePath: path.join(dir, task.id),
        baseSha: 'base'
      });
      const sourceSession = await createTestAgentSession(store, {
        task,
        iteration,
        worktree,
        runtimeId: task.runtimeId
      });
      const sourceRun = await createTestRun(store, {
        task,
        session: sourceSession,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt
      });
      await store.transitionTask(task.id, 'REVIEW', 'Implementation complete.');
      const reviewSession = await createTestAgentSession(store, {
        task: (await store.getTask(task.id))!,
        iteration,
        worktree,
        runtimeId: task.runtimeId,
        role: 'REVIEW',
        parentSessionId: sourceSession.id,
        forkedFromSessionId: sourceSession.id
      });
      const reviewRun = await createTestRun(store, {
        task: (await store.getTask(task.id))!,
        session: reviewSession,
        mode: 'REVIEW',
        prompt: 'Review the implementation.',
        continuedFromRunId: sourceRun.id
      });
      const finalArtifact = await writeTestFinalArtifact(store,
        task.id,
        reviewRun.id,
        'Review complete.\n'
      );
      return { task, sourceRun, reviewRun, finalArtifact };
    };

    const target = await createReview('Target review');
    const foreign = await createReview('Foreign review');
    await store.close();

    const foreignId = {
      runId: foreign.reviewRun.id,
      sourceRunId: foreign.sourceRun.id,
      finalArtifactId: foreign.finalArtifact.id
    }[field];
    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8'));
    persisted.tasks = persisted.tasks.map((task: any) =>
      task.id === target.task.id
        ? {
            ...task,
            projection: {
              ...task.projection,
              agentReview: { ...task.projection.agentReview, [field]: foreignId }
            }
          }
        : task
    );
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const reopened = new FileTaskStore(dir);
    runtimeFixture(reopened);
    await expect(reopened.snapshot()).rejects.toThrow('task agent review');
  });

  it('keeps detached review runs inside the review workflow phase', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-store-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Review flow',
      prompt: 'Implement and review.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-flow',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: 'codex'
    });
    const implementationRun = await createTestRun(store, {
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });

    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await createTestAgentSession(store, {
      task: reviewTask,
      iteration,
      worktree,
      runtimeId: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await createTestRun(store, {
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const storedTask = (await store.getTask(task.id))!;
    expect(storedTask.workflowPhase).toBe('REVIEW');
    expect(storedTask.currentRunId).toBe(implementationRun.id);
    expect(storedTask.projection.agentReview?.status).toBe('RUNNING');
    expect(storedTask.projection.agentReview?.runId).toBe(reviewRun.id);
  });
});

async function createRunFixture(suffix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `task-manager-${suffix}-`));
  const store = new FileTaskStore(dir);
  const task = await store.createTask({
    title: 'Durable run fixture',
    prompt: 'Keep record ownership consistent.',
      repositoryId: (await addTestRepository(store, dir)).id
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: `codex/${suffix}`,
    worktreePath: dir,
    baseSha: 'base'
  });
  const session = await createTestAgentSession(store, {
    task,
    iteration,
    worktree,
    runtimeId: 'codex'
  });
  const run = await createTestRun(store, {
    task,
    session,
    mode: 'IMPLEMENTATION',
    prompt: task.prompt
  });
  return { dir, store, task, iteration, worktree, run };
}

function repositoryPreviewPlanSource(
  recipeDigest = TEST_PREVIEW_RECIPE_DIGEST
): PreviewPlanSource {
  return {
    type: 'REPOSITORY_RECIPE',
    recipePath: '.taskmonki/preview.yaml',
    recipeVersion: 1,
    recipeDigest
  };
}

function userPreviewAuthority(
  approvalId: string,
  executionDigest: string
): PreviewExecutionAuthority {
  return { type: 'USER_APPROVAL', approvalId, executionDigest };
}

function previewSnapshotIdentity(snapshot: GitSnapshotRecord): PreviewSourceIdentity {
  return {
    type: 'WORKTREE_SNAPSHOT',
    gitSnapshotId: snapshot.id,
    headSha: snapshot.headSha!,
    dirtyFingerprint: snapshot.dirtyFingerprint
  };
}

async function recordTestPreviewSnapshot(
  store: FileTaskStore,
  taskId: string,
  iteration: TaskIteration,
  worktree: WorktreeRecord,
  repositoryPath: string
): Promise<GitSnapshotRecord> {
  return store.recordGitSnapshot(
    {
      taskId,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      worktreePath: worktree.worktreePath,
      repoRoot: repositoryPath,
      gitCommonDir: path.join(repositoryPath, '.git'),
      headSha: TEST_PREVIEW_HEAD_SHA,
      branch: worktree.branchName,
      baseSha: worktree.baseSha,
      aheadCount: 0,
      behindCount: 0,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      commitsAheadOfBase: 0,
      committedDiffFileCount: 0,
      workingDiffFileCount: 0,
      diffStat: '',
      dirtyFingerprint: 'clean',
      status: 'CLEAN'
    },
    ''
  );
}

async function writeStaleStoreLease(directory: string): Promise<{
  canonicalPath: string;
  ownerPath: string;
  token: string;
}> {
  const token = randomUUID();
  const canonicalPath = path.join(directory, '.task-monki-owner.lock');
  const ownerPath = `${canonicalPath}.${token}.owner`;
  await fs.writeFile(
    ownerPath,
    `${JSON.stringify({
      token,
      pid: 2_147_483_647,
      acquiredAt: '2026-07-18T00:00:00.000Z'
    })}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  await fs.link(ownerPath, canonicalPath);
  return { canonicalPath, ownerPath, token };
}

async function recordOpenPullRequest(
  store: FileTaskStore,
  taskId: string,
  iteration: TaskIteration,
  worktree: WorktreeRecord,
  options: number | {
    ciStatus?: CiChecksStatus;
    ciHeadSha?: string;
    mergeStatus?: MergeStatus;
    mergeHeadSha?: string;
    pullRequestHeadSha?: string;
    pullRequestNumber?: number;
  } = 82
): Promise<void> {
  const pullRequestNumber =
    typeof options === 'number' ? options : options.pullRequestNumber ?? 82;
  const ciStatus = typeof options === 'number' ? 'PASSING' : options.ciStatus ?? 'PASSING';
  const ciHeadSha = typeof options === 'number' ? 'head' : options.ciHeadSha ?? 'head';
  const mergeStatus = typeof options === 'number' ? 'MERGEABLE' : options.mergeStatus ?? 'MERGEABLE';
  const mergeHeadSha = typeof options === 'number' ? 'head' : options.mergeHeadSha ?? 'head';
  const pullRequestHeadSha =
    typeof options === 'number' ? 'head' : options.pullRequestHeadSha ?? mergeHeadSha;
  await store.recordPullRequestSync({
    pullRequest: {
      taskId,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      number: pullRequestNumber,
      url: `https://github.com/example/repo/pull/${pullRequestNumber}`,
      status: 'OPEN_READY',
      state: 'OPEN',
      isDraft: false,
      headRefName: worktree.branchName,
      headRefOid: pullRequestHeadSha,
      baseRefName: 'main'
    },
    ci: {
      taskId,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      pullRequestNumber,
      headSha: ciHeadSha,
      status: ciStatus,
      requiredStatus: 'PASSING',
      totalCount: 1,
      pendingCount: 0,
      passingCount: ciStatus === 'PASSING' ? 1 : 0,
      failingCount: ciStatus === 'FAILING' || ciStatus === 'BLOCKED' ? 1 : 0,
      skippedCount: 0,
      canceledCount: 0,
      checkDetails: []
    },
    reviews: {
      taskId,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      pullRequestNumber,
      headSha: 'head',
      status: 'NOT_REQUESTED'
    },
    merge: {
      taskId,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      pullRequestNumber,
      headSha: mergeHeadSha,
      status: mergeStatus
    }
  });
}

function runtimeFixture(store: FileTaskStore): {
  store: FileAgentRuntimeStore;
  task: TaskAgentRuntimeAccess;
} {
  const current = runtimeByTaskStore.get(store);
  if (current) return current;
  const runtimeStore = new FileAgentRuntimeStore(
    path.join(store.getStorageRoot(), '.test-agent-runtime')
  );
  const task = runtimeStore.taskAgentRuntimeAccess((event, operationId) =>
    store.recordAgentRuntimeEvent(event, operationId)
  );
  store.bindAgentRuntime(task);
  const fixture = { store: runtimeStore, task };
  runtimeByTaskStore.set(store, fixture);
  runtimeFixtures.add(runtimeStore);
  return fixture;
}

async function createTestAgentSession(
  store: FileTaskStore,
  input: {
    task: Task;
    iteration: TaskIteration;
    worktree: WorktreeRecord;
    runtimeId: string;
    role?: AgentSessionRecord['role'];
    requestedSettings?: AgentExecutionSettings;
    parentSessionId?: string;
    forkedFromSessionId?: string;
  }
): Promise<AgentSessionRecord> {
  const id = randomUUID();
  const operationId = `test:session:${id}`;
  const requestedSettings = {
    ...(input.requestedSettings ?? input.task.agentSettings),
    runtimeId: input.runtimeId,
    model: input.requestedSettings?.model ?? input.task.agentSettings.model ?? 'test-model'
  };
  const permissionProfileHash = createHash('sha256')
    .update(JSON.stringify({ id, path: input.worktree.worktreePath, requestedSettings }))
    .digest('hex');
  const session = await runtimeFixture(store).task.createTaskSession({
    id,
    taskId: input.task.id,
    iterationId: input.iteration.id,
    worktreeId: input.worktree.id,
    worktreePath: input.worktree.worktreePath,
    runtimeId: input.runtimeId,
    role: input.role,
    requestedSettings,
    executionContext: {
      attestation: { status: 'ATTESTED' },
      primaryCwd: input.worktree.worktreePath,
      readRoots: [{
        canonicalPath: input.worktree.worktreePath,
        kind: 'WORKTREE',
        entityId: input.worktree.id
      }],
      managedAttachments: [],
      permissionProfileHash,
      modelSettings: requestedSettings,
      externalTools: {
        network: requestedSettings.networkAccess === true,
        webSearch: 'disabled',
        mcpServers: false,
        apps: false,
        dynamicTools: input.task.kind === 'DESIGN'
      },
      clientOperationId: operationId
    },
    operationId,
    parentSessionId: input.parentSessionId,
    forkedFromSessionId: input.forkedFromSessionId
  });
  await store.recordAgentSessionCreated(session);
  return session;
}

async function createTestRun(
  store: FileTaskStore,
  input: {
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
): Promise<RunRecord> {
  const id = randomUUID();
  let run = await runtimeFixture(store).task.createTaskRun({
    id,
    taskId: input.task.id,
    iterationId: input.session.iterationId,
    worktreeId: input.session.worktreeId,
    sessionId: input.session.id,
    mode: input.mode,
    prompt: input.prompt,
    generationKey: input.generationKey,
    requestedSettings: input.requestedSettings,
    beforeGitSnapshotId: input.beforeGitSnapshotId,
    retryOfRunId: input.retryOfRunId,
    continuedFromRunId: input.continuedFromRunId,
    reviewTarget: input.mode === 'REVIEW' ? { type: 'UNCOMMITTED_CHANGES' } : undefined,
    operationId: `test:run:${id}`
  });
  await store.recordAgentRunStarted(run);
  if (input.serverInstanceId) {
    run = await updateTestRun(store, run.id, {
      serverInstanceId: input.serverInstanceId
    });
  }
  return run;
}

function updateTestRun(
  store: FileTaskStore,
  runId: string,
  update: Partial<RunRecord>
): Promise<RunRecord> {
  return runtimeFixture(store).task.updateRun(
    runId,
    update,
    `test:run-update:${randomUUID()}`
  );
}

function updateTestAgentSession(
  store: FileTaskStore,
  sessionId: string,
  update: Partial<AgentSessionRecord>
): Promise<AgentSessionRecord> {
  return runtimeFixture(store).task.updateAgentSession(
    sessionId,
    update,
    `test:session-update:${randomUUID()}`
  );
}

function createTestAgentServer(
  store: FileTaskStore,
  input: Parameters<FileAgentRuntimeStore['createAgentServer']>[0]
) {
  return runtimeFixture(store).store.createAgentServer(input);
}

function appendTestProtocolMessage(
  store: FileTaskStore,
  ...input: Parameters<FileAgentRuntimeStore['appendProtocolMessage']>
) {
  return runtimeFixture(store).store.appendProtocolMessage(...input);
}

function upsertTestAgentItem(
  store: FileTaskStore,
  item: Parameters<TaskAgentRuntimeAccess['upsertAgentItem']>[0]
) {
  return runtimeFixture(store).task.upsertAgentItem(
    item,
    `test:item:${randomUUID()}`
  );
}

function recordTestAgentPlanRevision(
  store: FileTaskStore,
  record: Parameters<TaskAgentRuntimeAccess['recordAgentPlanRevision']>[0]
) {
  return runtimeFixture(store).task.recordAgentPlanRevision(
    record,
    `test:plan:${randomUUID()}`
  );
}

function recordTestAgentUsageSnapshot(
  store: FileTaskStore,
  record: Parameters<TaskAgentRuntimeAccess['recordAgentUsageSnapshot']>[0]
) {
  return runtimeFixture(store).task.recordAgentUsageSnapshot(
    record,
    `test:usage:${randomUUID()}`
  );
}

function createTestInteractionRequest(
  store: FileTaskStore,
  input: Parameters<TaskAgentRuntimeAccess['createInteractionRequest']>[0]
) {
  return runtimeFixture(store).task.createInteractionRequest(
    input,
    `test:interaction:${randomUUID()}`
  );
}

function writeTestFinalArtifact(
  store: FileTaskStore,
  taskId: string,
  runId: string,
  content: string
) {
  return runtimeFixture(store).task.writeFinalArtifact(
    taskId,
    runId,
    content,
    `test:final:${randomUUID()}`
  );
}

function testUsage(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  };
}
