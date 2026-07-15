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
});
