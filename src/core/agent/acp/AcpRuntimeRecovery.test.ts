import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppEventBus } from '../../runner/AppEventBus';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { AcpRuntimeAdapter } from './AcpRuntimeAdapter';
import { TEST_ACP_PROFILE } from '../../../testSupport/acpRuntimeProfile';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('ACP cold recovery', () => {
  it('passively reconciles a persisted active run without starting or replaying ACP', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-recovery-'));
    temporaryDirectories.push(directory);
    const storeDirectory = path.join(directory, 'store');
    const seedStore = new FileTaskStore(storeDirectory);
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
      repositoryPath: directory,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      agentSettings: settings
    });
    const { iteration, worktree } = await seedStore.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-cold-recovery',
      worktreePath: directory,
      baseSha: 'base'
    });
    const createdSession = await seedStore.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      requestedSettings: settings
    });
    const session = await seedStore.updateAgentSession(createdSession.id, {
      providerSessionId: 'provider-session-persisted',
      status: 'ACTIVE',
      materialized: true
    });
    let server = await seedStore.createAgentServer({
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: 'gemini',
      argv: ['--acp'],
      runtimeVersion: '1.0.0',
      schemaVersion: '1.19.0'
    });
    server = await seedStore.updateAgentServer(server.id, {
      status: 'READY',
      initializedAt: new Date().toISOString()
    });
    server = await seedStore.updateAgentServer(server.id, { status: 'RUNNING' });
    const createdRun = await seedStore.createRun({
      task,
      session,
      serverInstanceId: server.id,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: settings
    });
    const run = await seedStore.updateRun(createdRun.id, {
      providerTurnId: `${server.id}:41`,
      status: 'RUNNING'
    });
    const beforeEventCount = (await seedStore.snapshot()).events.length;
    const journalPath = server.protocolJournalPath;
    await seedStore.close();

    const recoveredStore = new FileTaskStore(storeDirectory);
    const appEvents = new AppEventBus();
    const observedAppEvents: string[] = [];
    appEvents.on((event) => observedAppEvents.push(event.type));
    let resolutionCalls = 0;
    const adapter = new AcpRuntimeAdapter(
      recoveredStore,
      appEvents,
      TEST_ACP_PROFILE,
      {
        cwd: directory,
        runtimeResolver: async () => {
          resolutionCalls += 1;
          expect(await recoveredStore.getRun(run.id)).toMatchObject({
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
      expect(observedAppEvents).toContain('run.activity');
      expect(observedAppEvents).not.toContain('run.started');
      expect(observedAppEvents).not.toContain('run.output');
      await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await adapter.shutdown();
      await recoveredStore.close();
    }
  });

  it('does not downgrade a run when terminalization wins the reconciliation race', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-reconcile-race-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
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
      repositoryPath: directory,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-reconcile-race',
      worktreePath: directory,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      requestedSettings: settings
    });
    const createdRun = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: settings
    });
    const server = await store.createAgentServer({
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: 'test-acp',
      argv: ['--acp'],
      runtimeVersion: '1.0.0',
      schemaVersion: '1.19.0'
    });
    const run = await store.updateRun(createdRun.id, {
      providerTurnId: `${server.id}:1`,
      serverInstanceId: server.id,
      status: 'RUNNING'
    });
    const adapter = new AcpRuntimeAdapter(store, new AppEventBus(), TEST_ACP_PROFILE, {
      cwd: directory
    });
    const appendIfStatus = store.appendRunEventIfStatus.bind(store);
    let terminalized = false;
    store.appendRunEventIfStatus = async (event, expectedStatuses) => {
      if (event.type === 'AGENT_RUNTIME_RECONCILED' && !terminalized) {
        terminalized = true;
        await store.updateRun(run.id, {
          status: 'COMPLETED',
          endedAt: new Date().toISOString()
        });
      }
      return appendIfStatus(event, expectedStatuses);
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
  });

  it('does not publish runtime loss when terminalization wins after the loss snapshot', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-loss-race-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
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
      repositoryPath: directory,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-loss-race',
      worktreePath: directory,
      baseSha: 'base'
    });
    const createdSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      requestedSettings: settings
    });
    const session = await store.updateAgentSession(createdSession.id, { status: 'ACTIVE' });
    const server = await store.createAgentServer({
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: 'test-acp',
      argv: ['--acp'],
      runtimeVersion: '1.0.0',
      schemaVersion: '1.19.0'
    });
    const createdRun = await store.createRun({
      task,
      session,
      serverInstanceId: server.id,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: settings
    });
    const run = await store.updateRun(createdRun.id, {
      providerTurnId: `${server.id}:1`,
      status: 'RUNNING'
    });
    const observedEvents: string[] = [];
    const appEvents = new AppEventBus();
    appEvents.on((event) => observedEvents.push(event.type));
    const adapter = new AcpRuntimeAdapter(store, appEvents, TEST_ACP_PROFILE, {
      cwd: directory
    });
    const appendIfStatus = store.appendRunEventIfStatus.bind(store);
    let expectedStatuses: readonly string[] | undefined;
    store.appendRunEventIfStatus = async (event, statuses) => {
      if (event.type === 'AGENT_RUNTIME_LOST') {
        expectedStatuses = statuses;
        await store.updateRun(run.id, {
          status: 'COMPLETED',
          endedAt: new Date().toISOString()
        });
      }
      return appendIfStatus(event, statuses);
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
    expect((await store.getAgentSession(session.id))?.status).toBe('ACTIVE');
    expect(observedEvents).not.toContain('run.activity');
  });
});
