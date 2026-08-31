import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
import { SqliteTaskStore } from './SqliteTaskStore';
import { SqliteAgentRuntimeStore } from './SqliteAgentRuntimeStore';
import type { TaskAgentRuntimeAccess } from '../agent/AgentRuntimeStore';
import { createDomainEvent } from './domainEvent';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import type { ApplicationPersistence } from './sqlite/ApplicationPersistence';

const TEST_PREVIEW_RECIPE_DIGEST = 'a'.repeat(64);
const TEST_PREVIEW_EXECUTION_DIGEST = 'b'.repeat(64);
const TEST_PREVIEW_HEAD_SHA = 'c'.repeat(40);

const persistenceByTaskStore = new WeakMap<SqliteTaskStore, ApplicationPersistence>();

async function createStore(profileRoot: string): Promise<SqliteTaskStore> {
  const persistence = await openTestPersistence(profileRoot);
  persistenceByTaskStore.set(persistence.tasks, persistence);
  return persistence.tasks;
}

function persistenceFixture(store: SqliteTaskStore): ApplicationPersistence {
  const persistence = persistenceByTaskStore.get(store);
  if (!persistence) throw new Error('Task store does not belong to this test fixture.');
  return persistence;
}

function closeStore(store: SqliteTaskStore): Promise<void> {
  return persistenceFixture(store).close();
}

describe('SqliteTaskStore', () => {
  it('drains an admitted mutation before terminal close and rejects late work', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-close-'));
    const store = await createStore(dir);
    const repository = await addTestRepository(store, dir);
    const creation = store.createTask({
      title: 'Admitted before close',
      prompt: 'Publish this mutation before releasing ownership.',
      repositoryId: repository.id
    });
    const closing = closeStore(store);

    expect(closeStore(store)).toBe(closing);
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

    const restarted = await createStore(dir);
    await expect(restarted.snapshot()).resolves.toMatchObject({
      tasks: [expect.objectContaining({ title: 'Admitted before close' })]
    });
    await closeStore(restarted);
  });

  it('derives compact board and task-owned detail reads from published state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-client-reads-'));
    const store = await createStore(dir);
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

    await closeStore(store);
    const restarted = await createStore(dir);
    runtimeFixture(restarted);
    const restartedBoard = await restarted.getBoardSnapshot();
    expect({
      ...restartedBoard,
      tasks: [...restartedBoard.tasks].sort((left, right) => left.id.localeCompare(right.id))
    }).toEqual({
      ...board,
      tasks: [...board.tasks].sort((left, right) => left.id.localeCompare(right.id))
    });
    await expect(restarted.getTaskDetail(consumer.id)).resolves.toMatchObject({
      task: { id: consumer.id },
      runs: [{ id: consumerRun.id }]
    });
    await closeStore(restarted);
  }, 15_000);

  it('keeps provider runtime records out of the durable Task store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-runtime-boundary-'));
    const store = await createStore(dir);
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

    const taskRow = await persistenceFixture(store).database.read((reader) =>
      reader.get<{ payload_json: string }>('SELECT payload_json FROM tasks WHERE id = ?', [
        task.id
      ])
    );
    const taskState = JSON.parse(taskRow!.payload_json) as Record<string, unknown>;
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

    await closeStore(store);
    const restarted = await createStore(dir);
    runtimeFixture(restarted);
    await expect(restarted.getTaskDetail(task.id)).resolves.toMatchObject({
      runs: [{ id: run.id }],
      agentSessions: [{ id: session.id }],
      agentItems: [{ id: item.id }],
      interactionRequests: [expect.objectContaining({ taskId: task.id })]
    });
    await closeStore(restarted);
  });

  it('switches the current primary session together with its replacement run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-primary-session-'));
    const store = await createStore(dir);
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

  it('does not report failure after task deletion is durably published', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-delete-cleanup-'));
    const store = await createStore(dir);
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
    await closeStore(store);

    const restarted = await createStore(dir);
    await expect(restarted.snapshot()).resolves.toMatchObject({ tasks: [] });
    await expect(fs.access(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await closeStore(restarted);
  });

  it('rejects a Git snapshot that does not belong to its recorded worktree', async () => {
    const fixture = await createRunFixture('cross-worktree-git-snapshot');
    await expect(
      fixture.store.recordGitSnapshot({
        taskId: fixture.task.id,
        iterationId: fixture.iteration.id,
        worktreeId: randomUUID(),
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
      }, '')
    ).rejects.toThrow('FOREIGN KEY constraint failed');
  });

  it('rejects GitHub evidence that does not belong to its recorded worktree', async () => {
    const fixture = await createRunFixture('cross-worktree-github-evidence');
    await expect(
      recordOpenPullRequest(fixture.store, fixture.task.id, fixture.iteration, {
        ...fixture.worktree,
        id: randomUUID()
      })
    ).rejects.toThrow('FOREIGN KEY constraint failed');
  });

  it('fails closed when durable evidence is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-missing-'));
    const store = await createStore(dir);
    const task = await store.createTask({
      title: 'Require durable evidence',
      prompt: 'Do not reinterpret missing evidence as empty output.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const artifact = await store.writeTextArtifact(task.id, 'git-snapshot', 'verified evidence');

    await fs.unlink(artifact.path);
    await expect(store.readArtifact(artifact.id)).rejects.toThrow('ENOENT');
    await closeStore(store);
    const restarted = await createStore(dir);
    await expect(restarted.snapshot()).rejects.toThrow('ENOENT');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects live access after artifact permissions become unsafe',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-mode-'));
      const store = await createStore(dir);
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
        'Managed file failed its integrity check'
      );
      await expect(store.appendArtifact(artifact.id, 'more')).rejects.toThrow(
        'Managed file failed its integrity check'
      );
      await closeStore(store);

      await expect(createStore(dir)).rejects.toThrow(
        'Managed file failed its integrity check'
      );
    }
  );

  it('retains a visible truncation marker when an artifact reaches its budget', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-budget-'));
    const store = await createStore(dir);
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

  it('validates optional task completion policy input', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-policy-input-'));
    const store = await createStore(dir);

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

  it('allows stopped environment history but enforces one live environment per task', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-managed-environment-'));
    const store = await createStore(dir);
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
    const store = await createStore(dir);
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

    await closeStore(store);
    const restarted = await createStore(dir);
    const snapshot = await restarted.snapshot();
    expect(snapshot.previewPlans).toEqual([]);
    expect(snapshot.previewApprovals).toEqual([]);
    expect(snapshot.previewGenerations).toEqual([]);
    expect(snapshot.previewResources).toEqual([]);
  });

  it('reads bounded artifact ranges without splitting UTF-8 code points', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-artifact-range-'));
    const store = await createStore(dir);
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
    await closeStore(store);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('bounds terminal preview history and removes its child evidence and files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-preview-prune-'));
    const store = await createStore(dir);
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
    await closeStore(store);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('bounds completed argv probe attempts and resources while a generation remains active', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-probe-prune-'));
    const store = await createStore(dir);
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
    await closeStore(store);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rolls back both in-memory generation roles when atomic cutover persistence fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-cutover-'));
    const store = await createStore(dir);
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
    await expect(
      persistenceFixture(store).database.write(async () => {
        await store.cutoverPreviewGenerations({
          candidate: { ...candidate, state: 'READY', routingState: 'ACTIVE' },
          replaced: { ...active, routingState: 'RETIRED' }
        });
        throw new Error('injected cutover transaction failure');
      })
    ).rejects.toThrow('cutover transaction failure');
    expect(await store.getPreviewGeneration(active.id)).toMatchObject({ routingState: 'ACTIVE' });
    expect(await store.getPreviewGeneration(candidate.id)).toMatchObject({ routingState: 'CANDIDATE' });
    await closeStore(store);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('links forked alternative tasks to their source task and run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-fork-'));
    const store = await createStore(dir);

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
    const store = await createStore(dir);

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
    const store = await createStore(dir);
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
    const store = await createStore(dir);

    const verifiedTask = await store.createTask({
      title: 'Verified merge task',
      prompt: 'Keep verification after merge.',
      repositoryId: (await addTestRepository(store, dir)).id,
      completionPolicy: 'MERGED_AND_VERIFIED'
    });
    const manualTask = await store.createTask({
      title: 'Manual completion task',
      prompt: 'Keep manual completion.',
      repositoryId: (await addTestRepository(store, dir)).id,
      completionPolicy: 'MANUAL'
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

    await closeStore(store);

    const reloaded = await createStore(dir);
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
    const store = await createStore(dir);

    const mergedTask = await store.createTask({
      title: 'Merged task',
      prompt: 'Complete when merged.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const verifiedTask = await store.createTask({
      title: 'Verified task',
      prompt: 'Require checks after merge.',
      repositoryId: (await addTestRepository(store, dir)).id,
      completionPolicy: 'MERGED_AND_VERIFIED'
    });
    const verifiedStaleTask = await store.createTask({
      title: 'Verified stale task',
      prompt: 'Reject old passing checks after merge.',
      repositoryId: (await addTestRepository(store, dir)).id,
      completionPolicy: 'MERGED_AND_VERIFIED'
    });
    const verifiedPassingTask = await store.createTask({
      title: 'Verified passing task',
      prompt: 'Complete when merged checks match.',
      repositoryId: (await addTestRepository(store, dir)).id,
      completionPolicy: 'MERGED_AND_VERIFIED'
    });
    const manualTask = await store.createTask({
      title: 'Manual task',
      prompt: 'Require explicit completion.',
      repositoryId: (await addTestRepository(store, dir)).id,
      completionPolicy: 'MANUAL'
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

    await closeStore(store);

    const reloaded = await createStore(dir);
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
    const store = await createStore(dir);
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
    const store = await createStore(dir);

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
    const store = await createStore(dir);

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

  it('preserves structured terminal review status when reloading', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-status-'));
    const store = await createStore(dir);

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
    await closeStore(store);
    const restarted = await createStore(dir);
    const reloadedTask = (await restarted.getTask(task.id))!;
    expect(reloadedTask.projection.agentReview?.status).toBe('PASSED');
    expect(reloadedTask.projection.agentReview?.result?.verdict).toBe('PASSED');
  });

  it.each([
    ['review run', 'runId'],
    ['source run', 'sourceRunId'],
    ['final artifact', 'finalArtifactId']
  ] as const)('rejects an agent review whose %s belongs to another task', async (_label, field) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-ownership-'));
    const store = await createStore(dir);

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
    const foreignId = {
      runId: foreign.reviewRun.id,
      sourceRunId: foreign.sourceRun.id,
      finalArtifactId: foreign.finalArtifact.id
    }[field];
    await persistenceFixture(store).database.write((transaction) => {
      const row = transaction.get<{ payload_json: string }>(
        'SELECT payload_json FROM tasks WHERE id = ?',
        [target.task.id]
      );
      const task = JSON.parse(row!.payload_json) as Task;
      task.projection.agentReview = {
        ...task.projection.agentReview!,
        [field]: foreignId
      };
      transaction.run('UPDATE tasks SET payload_json = ? WHERE id = ?', [
        JSON.stringify(task),
        target.task.id
      ]);
    });
    await closeStore(store);

    const reopened = await createStore(dir);
    await expect(reopened.snapshot()).rejects.toThrow('task agent review');
  });

  it('keeps detached review runs inside the review workflow phase', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-store-'));
    const store = await createStore(dir);

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
  const store = await createStore(dir);
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
  store: SqliteTaskStore,
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

async function recordOpenPullRequest(
  store: SqliteTaskStore,
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

function runtimeFixture(store: SqliteTaskStore): {
  store: SqliteAgentRuntimeStore;
  task: TaskAgentRuntimeAccess;
} {
  const persistence = persistenceFixture(store);
  return { store: persistence.agentRuntime, task: persistence.taskRuntime };
}

async function createTestAgentSession(
  store: SqliteTaskStore,
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
      repositoryAccess: 'WRITE',
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
  store: SqliteTaskStore,
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
  store: SqliteTaskStore,
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
  store: SqliteTaskStore,
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
  store: SqliteTaskStore,
  input: Parameters<SqliteAgentRuntimeStore['createAgentServer']>[0]
) {
  return runtimeFixture(store).store.createAgentServer(input);
}

function appendTestProtocolMessage(
  store: SqliteTaskStore,
  ...input: Parameters<SqliteAgentRuntimeStore['appendProtocolMessage']>
) {
  return runtimeFixture(store).store.appendProtocolMessage(...input);
}

function upsertTestAgentItem(
  store: SqliteTaskStore,
  item: Parameters<TaskAgentRuntimeAccess['upsertAgentItem']>[0]
) {
  return runtimeFixture(store).task.upsertAgentItem(
    item,
    `test:item:${randomUUID()}`
  );
}

function recordTestAgentPlanRevision(
  store: SqliteTaskStore,
  record: Parameters<TaskAgentRuntimeAccess['recordAgentPlanRevision']>[0]
) {
  return runtimeFixture(store).task.recordAgentPlanRevision(
    record,
    `test:plan:${randomUUID()}`
  );
}

function recordTestAgentUsageSnapshot(
  store: SqliteTaskStore,
  record: Parameters<TaskAgentRuntimeAccess['recordAgentUsageSnapshot']>[0]
) {
  return runtimeFixture(store).task.recordAgentUsageSnapshot(
    record,
    `test:usage:${randomUUID()}`
  );
}

function createTestInteractionRequest(
  store: SqliteTaskStore,
  input: Parameters<TaskAgentRuntimeAccess['createInteractionRequest']>[0]
) {
  return runtimeFixture(store).task.createInteractionRequest(
    input,
    `test:interaction:${randomUUID()}`
  );
}

function writeTestFinalArtifact(
  store: SqliteTaskStore,
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
