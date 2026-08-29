import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addTestRepository } from '../../../testSupport/repositoryFixture';
import { AppEventBus } from '../../runner/AppEventBus';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { FileAgentRuntimeStore } from '../../storage/FileAgentRuntimeStore';
import type { TaskAgentRuntimeAccess } from '../AgentRuntimeStore';
import { createAgentSessionAccessEpoch } from '../AgentRuntimeOwnership';
import { AcpRuntimeAdapter } from './AcpRuntimeAdapter';
import { TEST_ACP_PROFILE } from '../../../testSupport/acpRuntimeProfile';
import type {
  AgentExecutionSettings,
  AgentSessionRecord,
  RunRecord,
  Task,
  TaskIteration,
  WorktreeRecord
} from '../../../shared/contracts';

const temporaryDirectories: string[] = [];
let operationOrdinal = 0;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

interface RecoveryFixture {
  tasks: FileTaskStore;
  runtimeStore: FileAgentRuntimeStore;
  runtime: TaskAgentRuntimeAccess;
}

function createRecoveryFixture(taskRoot: string, runtimeRoot: string): RecoveryFixture {
  const tasks = new FileTaskStore(taskRoot);
  const runtimeStore = new FileAgentRuntimeStore(runtimeRoot);
  const runtime = runtimeStore.taskAgentRuntimeAccess(async (event) => {
    await tasks.appendEvent(event);
  });
  tasks.bindAgentRuntime(runtime);
  return { tasks, runtimeStore, runtime };
}

function operationId(action: string): string {
  operationOrdinal += 1;
  return `acp-recovery-test:${action}:${operationOrdinal}`;
}

async function createRuntimeSession(
  fixture: RecoveryFixture,
  task: Task,
  iteration: TaskIteration,
  worktree: WorktreeRecord,
  settings: AgentExecutionSettings
): Promise<AgentSessionRecord> {
  const id = randomUUID();
  const owner = { kind: 'TASK' as const, taskId: task.id };
  const clientOperationId = operationId(`session:${id}`);
  const executionContext = {
    attestation: { status: 'ATTESTED' as const },
    primaryCwd: worktree.worktreePath,
    repositoryAccess: 'WRITE' as const,
    readRoots: [{
      canonicalPath: worktree.worktreePath,
      kind: 'WORKTREE' as const,
      entityId: worktree.id
    }],
    managedAttachments: [],
    permissionProfileHash: 'a'.repeat(64),
    modelSettings: settings,
    externalTools: {
      network: settings.networkAccess === true,
      webSearch: settings.networkAccess === true ? 'live' as const : 'disabled' as const,
      mcpServers: false,
      apps: false,
      dynamicTools: false
    },
    clientOperationId
  };
  await fixture.runtimeStore.createSession({
    id,
    owner,
    accessEpoch: createAgentSessionAccessEpoch({
      owner,
      sessionId: id,
      epoch: 1,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      model: settings.model ?? 'default',
      executionContext
    }),
    executionContext,
    clientOperationId,
    runtimeId: TEST_ACP_PROFILE.descriptor.id,
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    status: 'NOT_MATERIALIZED',
    materialized: false,
    requestedSettings: settings,
    taskContext: {
      iterationId: iteration.id,
      worktreeId: worktree.id,
      worktreePath: worktree.worktreePath
    }
  });
  const session = await fixture.runtime.getAgentSession(id);
  if (!session) throw new Error('Recovery test session was not created.');
  await fixture.tasks.recordAgentSessionCreated(session);
  return session;
}

async function createRuntimeRun(
  fixture: RecoveryFixture,
  task: Task,
  session: AgentSessionRecord,
  settings: AgentExecutionSettings,
  serverInstanceId?: string
): Promise<RunRecord> {
  const id = randomUUID();
  const owner = { kind: 'TASK' as const, taskId: task.id };
  const created = await fixture.runtimeStore.createRun({
    id,
    owner,
    scope: {
      kind: 'TASK',
      taskId: task.id,
      iterationId: session.iterationId,
      worktreeId: session.worktreeId
    },
    sessionId: session.id,
    sessionAccessEpoch: 1,
    ...(serverInstanceId ? { serverInstanceId } : {}),
    purpose: 'TASK_IMPLEMENTATION',
    generationKey: `acp-recovery:${id}`,
    clientOperationId: operationId(`run:${id}`),
    requestedSettings: settings,
    promptArtifactId: `${id}-prompt`,
    outputArtifactId: `${id}-output`,
    diagnosticArtifactId: `${id}-diagnostic`,
    taskDetails: { eventCount: 0 }
  });
  await Promise.all([
    fixture.runtimeStore.createArtifact({
      id: created.promptArtifactId,
      owner,
      runId: id,
      kind: 'PROMPT',
      clientOperationId: operationId(`prompt:${id}`),
      content: task.prompt
    }),
    fixture.runtimeStore.createArtifact({
      id: created.outputArtifactId,
      owner,
      runId: id,
      kind: 'OUTPUT',
      clientOperationId: operationId(`output:${id}`),
      content: ''
    }),
    fixture.runtimeStore.createArtifact({
      id: created.diagnosticArtifactId,
      owner,
      runId: id,
      kind: 'DIAGNOSTIC',
      clientOperationId: operationId(`diagnostic:${id}`),
      content: ''
    })
  ]);
  const run = await fixture.runtime.getRun(id);
  if (!run) throw new Error('Recovery test run was not created.');
  await fixture.tasks.recordAgentRunStarted(run);
  return fixture.runtime.updateRun(
    id,
    { status: 'STARTING' },
    operationId(`run-starting:${id}`)
  );
}

describe('ACP cold recovery', () => {
  it('passively reconciles a persisted active run without starting or replaying ACP', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-recovery-'));
    temporaryDirectories.push(directory);
    const storeDirectory = path.join(directory, 'store');
    const runtimeDirectory = path.join(directory, 'runtime-store');
    const seed = createRecoveryFixture(storeDirectory, runtimeDirectory);
    const seedStore = seed.tasks;
    const settings = {
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      model: 'default',
      modelProvider: 'google',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };
    const task = await seedStore.createTask({
      title: 'Cold ACP recovery',
      prompt: 'Do not replay this prompt after restart.',
      repositoryId: (await addTestRepository(seedStore, directory)).id,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      agentSettings: settings
    });
    const { iteration, worktree } = await seedStore.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-cold-recovery',
      worktreePath: directory,
      baseSha: 'base'
    });
    const createdSession = await createRuntimeSession(
      seed,
      task,
      iteration,
      worktree,
      settings
    );
    const session = await seed.runtime.updateAgentSession(
      createdSession.id,
      {
        providerSessionId: 'provider-session-persisted',
        status: 'ACTIVE',
        materialized: true
      },
      operationId('session/active')
    );
    let server = await seed.runtimeStore.createAgentServer({
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: 'gemini',
      argv: ['--acp'],
      runtimeVersion: '1.0.0',
      schemaVersion: '1.19.0'
    });
    server = await seed.runtimeStore.updateAgentServer(server.id, {
      status: 'READY',
      initializedAt: new Date().toISOString()
    });
    server = await seed.runtimeStore.updateAgentServer(server.id, { status: 'RUNNING' });
    const createdRun = await createRuntimeRun(seed, task, session, settings, server.id);
    const run = await seed.runtime.updateRun(
      createdRun.id,
      {
        providerTurnId: `${server.id}:41`,
        status: 'RUNNING'
      },
      operationId('run/running')
    );
    const beforeEventCount = (await seedStore.snapshot()).events.length;
    const journalPath = server.protocolJournalPath;
    await seedStore.close();
    await seed.runtimeStore.close();

    const recovered = createRecoveryFixture(storeDirectory, runtimeDirectory);
    const recoveredStore = recovered.tasks;
    const appEvents = new AppEventBus();
    const observedAppEvents: string[] = [];
    appEvents.on((event) => observedAppEvents.push(event.type));
    let resolutionCalls = 0;
    const adapter = new AcpRuntimeAdapter(
      recovered.runtime,
      recovered.runtimeStore,
      appEvents,
      TEST_ACP_PROFILE,
      {
        cwd: directory,
        runtimeResolver: async () => {
          resolutionCalls += 1;
          expect(await recovered.runtime.getRun(run.id)).toMatchObject({
            status: 'RECOVERY_REQUIRED',
            recoveryState: 'REQUIRES_USER_ACTION'
          });
          return {
            executable: process.execPath,
            version: process.version,
            diagnostics: {
              selectedExecutable: process.execPath,
              selectedSource: 'test',
              selectedVersion: process.version,
              selectedLaunchArgv: ['--acp'],
              requiredCapabilities: ['ACP protocolVersion=1'],
              probes: []
            }
          };
        }
      }
    );

    try {
      await adapter.initialize();

      const snapshot = await recoveredStore.snapshot();
      expect(resolutionCalls).toBe(1);
      expect(snapshot.agentServers).toHaveLength(1);
      expect(snapshot.agentServers[0]).toMatchObject({ id: server.id, status: 'LOST' });
      expect(snapshot.agentSessions.find((candidate) => candidate.id === session.id)).toMatchObject({
        status: 'NOT_LOADED'
      });
      expect(snapshot.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        recoveryState: 'REQUIRES_USER_ACTION'
      });
      expect(
        snapshot.events.slice(beforeEventCount).map((event) => event.type)
      ).toEqual(['AGENT_RUNTIME_LOST', 'AGENT_RUNTIME_RECONCILED']);
      expect(observedAppEvents).toContain('run.state.updated');
      expect(observedAppEvents).not.toContain('run.started');
      expect(observedAppEvents).not.toContain('run.output');
      await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await adapter.shutdown();
      await recoveredStore.close();
      await recovered.runtimeStore.close();
    }
  });

  it('does not downgrade a run when terminalization wins the reconciliation race', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-reconcile-race-'));
    temporaryDirectories.push(directory);
    const fixture = createRecoveryFixture(
      path.join(directory, 'store'),
      path.join(directory, 'runtime-store')
    );
    const store = fixture.tasks;
    const settings = {
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      model: 'default',
      modelProvider: 'google',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };
    const task = await store.createTask({
      title: 'ACP reconciliation race',
      prompt: 'Finish before stale reconciliation.',
      repositoryId: (await addTestRepository(store, directory)).id,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-reconcile-race',
      worktreePath: directory,
      baseSha: 'base'
    });
    const session = await createRuntimeSession(fixture, task, iteration, worktree, settings);
    const createdRun = await createRuntimeRun(fixture, task, session, settings);
    const server = await fixture.runtimeStore.createAgentServer({
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: 'test-acp',
      argv: ['--acp'],
      runtimeVersion: '1.0.0',
      schemaVersion: '1.19.0'
    });
    const run = await fixture.runtime.updateRun(
      createdRun.id,
      {
        providerTurnId: `${server.id}:1`,
        serverInstanceId: server.id,
        status: 'RUNNING'
      },
      operationId('run/running-race')
    );
    const adapter = new AcpRuntimeAdapter(
      fixture.runtime,
      fixture.runtimeStore,
      new AppEventBus(),
      TEST_ACP_PROFILE,
      { cwd: directory }
    );
    const appendIfStatus = fixture.runtime.applyTaskRuntimeEventIfRunStatus.bind(
      fixture.runtime
    );
    let terminalized = false;
    fixture.runtime.applyTaskRuntimeEventIfRunStatus = async (
      event,
      expectedStatuses,
      eventOperationId
    ) => {
      if (event.type === 'AGENT_RUNTIME_RECONCILED' && !terminalized) {
        terminalized = true;
        await fixture.runtime.updateRun(
          run.id,
          { status: 'COMPLETED', endedAt: new Date().toISOString() },
          operationId('run/terminal-race')
        );
      }
      return appendIfStatus(event, expectedStatuses, eventOperationId);
    };

    const result = await adapter.reconcile();
    const snapshot = await store.snapshot();

    expect(terminalized).toBe(true);
    expect(result.recoveryRequiredSessionIds).toEqual([]);
    expect(snapshot.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      status: 'COMPLETED'
    });
    expect(snapshot.events.map((event) => event.type)).not.toContain(
      'AGENT_RUNTIME_RECONCILED'
    );
    await store.close();
    await fixture.runtimeStore.close();
  });

  it('does not publish runtime loss when terminalization wins after the loss snapshot', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-loss-race-'));
    temporaryDirectories.push(directory);
    const fixture = createRecoveryFixture(
      path.join(directory, 'store'),
      path.join(directory, 'runtime-store')
    );
    const store = fixture.tasks;
    const settings = {
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      model: 'default',
      modelProvider: 'google',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };
    const task = await store.createTask({
      title: 'ACP runtime-loss race',
      prompt: 'Finish before stale process loss.',
      repositoryId: (await addTestRepository(store, directory)).id,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-loss-race',
      worktreePath: directory,
      baseSha: 'base'
    });
    const createdSession = await createRuntimeSession(
      fixture,
      task,
      iteration,
      worktree,
      settings
    );
    const session = await fixture.runtime.updateAgentSession(
      createdSession.id,
      { status: 'ACTIVE' },
      operationId('session/active-loss-race')
    );
    const server = await fixture.runtimeStore.createAgentServer({
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: 'test-acp',
      argv: ['--acp'],
      runtimeVersion: '1.0.0',
      schemaVersion: '1.19.0'
    });
    const createdRun = await createRuntimeRun(fixture, task, session, settings, server.id);
    const run = await fixture.runtime.updateRun(
      createdRun.id,
      { providerTurnId: `${server.id}:1`, status: 'RUNNING' },
      operationId('run/running-loss-race')
    );
    const observedEvents: string[] = [];
    const appEvents = new AppEventBus();
    appEvents.on((event) => observedEvents.push(event.type));
    const adapter = new AcpRuntimeAdapter(
      fixture.runtime,
      fixture.runtimeStore,
      appEvents,
      TEST_ACP_PROFILE,
      { cwd: directory }
    );
    const appendIfStatus = fixture.runtime.applyTaskRuntimeEventIfRunStatus.bind(
      fixture.runtime
    );
    let expectedStatuses: readonly string[] | undefined;
    fixture.runtime.applyTaskRuntimeEventIfRunStatus = async (
      event,
      statuses,
      eventOperationId
    ) => {
      if (event.type === 'AGENT_RUNTIME_LOST') {
        expectedStatuses = statuses;
        await fixture.runtime.updateRun(
          run.id,
          { status: 'COMPLETED', endedAt: new Date().toISOString() },
          operationId('run/terminal-loss-race')
        );
      }
      return appendIfStatus(event, statuses, eventOperationId);
    };

    await (
      adapter as unknown as {
        handleRuntimeLoss(serverInstanceId: string, reason: string): Promise<void>;
      }
    ).handleRuntimeLoss(server.id, 'Injected process loss.');
    const snapshot = await store.snapshot();

    expect(expectedStatuses).toEqual(['RUNNING']);
    expect(snapshot.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      status: 'COMPLETED'
    });
    expect(snapshot.events.map((event) => event.type)).not.toContain('AGENT_RUNTIME_LOST');
    expect((await fixture.runtime.getAgentSession(session.id))?.status).toBe('ACTIVE');
    expect(observedEvents).not.toContain('run.activity');
    await store.close();
    await fixture.runtimeStore.close();
  });
});
