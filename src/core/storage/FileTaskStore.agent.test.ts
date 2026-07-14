import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION } from '../../shared/contracts';
import { FileTaskStore } from './FileTaskStore';

describe('FileTaskStore agent persistence', () => {
  it('persists provider-neutral server, session, turn, item, and interaction records', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-store-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Agent persistence',
      prompt: 'Inspect the repository.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/agent-persistence',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: { model: 'model-a', reasoningEffort: 'high' }
    });
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio'],
      runtimeVersion: '0.141.0',
      schemaHash: 'schema-hash',
      runtimeResolution: {
        selectedExecutable: '/Applications/Codex.app/Contents/Resources/codex',
        selectedSource: 'codex-app-bundle',
        selectedVersion: '0.142.4',
        selectedLaunchArgv: ['app-server', '--stdio'],
        requiredCapabilities: ['thread/start', 'turn/start'],
        probes: [
          {
            executable: '/opt/homebrew/bin/codex',
            source: 'path',
            explicit: false,
            compatible: false,
            version: '0.22.0',
            detail: 'Codex App Server command or stdio transport was not detected.'
          },
          {
            executable: '/Applications/Codex.app/Contents/Resources/codex',
            source: 'codex-app-bundle',
            explicit: false,
            compatible: true,
            version: '0.142.4',
            launchArgv: ['app-server', '--stdio'],
            launchForm: 'stdio-flag',
            detail: 'Compatible Codex App Server via stdio-flag.'
          }
        ]
      }
    });
    const run = await store.createRun({
      task,
      session,
      serverInstanceId: server.id,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: session.requestedSettings
    });
    const storeBeforeOutput = await fs.readFile(path.join(dir, 'store.json'), 'utf8');
    await store.appendArtifact(run.outputArtifactId, 'streamed output\n');
    expect(await fs.readFile(path.join(dir, 'store.json'), 'utf8')).toBe(storeBeforeOutput);
    const rawRequest = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"item/commandExecution/requestApproval","id":7}',
      { method: 'item/commandExecution/requestApproval' }
    );
    const item = await store.upsertAgentItem({
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      providerItemId: 'item-1',
      type: 'COMMAND_EXECUTION',
      status: 'IN_PROGRESS',
      payload: { command: 'npm test' },
      rawMessage: rawRequest
    });
    await store.upsertAgentItem({
      ...item,
      status: 'COMPLETED',
      payload: { command: 'npm test', exitCode: 0 }
    });
    await expect(
      store.upsertAgentItem({
        ...item,
        status: 'IN_PROGRESS',
        payload: { command: 'npm test' }
      })
    ).rejects.toThrow('Invalid agent item transition');
    const interaction = await store.createInteractionRequest({
      runtimeId: 'codex',
      serverInstanceId: server.id,
      providerRequestId: 7,
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      providerItemId: item.providerItemId,
      type: 'COMMAND_APPROVAL',
      request: { command: 'npm test', startedAtMs: Date.now() },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
      policyWarnings: [],
      requestRawMessage: rawRequest
    });

    await store.transitionInteractionRequest(interaction.id, 'PENDING', {
      status: 'RESPONDING',
      decision: {
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT'
      },
      respondedAt: new Date().toISOString()
    });
    await expect(
      store.transitionInteractionRequest(interaction.id, 'PENDING', {
        status: 'RESPONDING'
      })
    ).rejects.toThrow('expected PENDING');
    await store.transitionInteractionRequest(interaction.id, 'RESPONDING', {
      status: 'RESOLVED',
      resolution: { accepted: true },
      resolvedAt: new Date().toISOString()
    });

    const reloaded = await new FileTaskStore(dir).snapshot();
    expect(reloaded.agentServers).toHaveLength(1);
    expect(reloaded.agentServers[0]?.runtimeResolution).toMatchObject({
      selectedExecutable: '/Applications/Codex.app/Contents/Resources/codex',
      selectedVersion: '0.142.4',
      probes: [
        {
          executable: '/opt/homebrew/bin/codex',
          compatible: false,
          version: '0.22.0'
        },
        {
          executable: '/Applications/Codex.app/Contents/Resources/codex',
          compatible: true,
          launchForm: 'stdio-flag'
        }
      ]
    });
    expect(reloaded.agentSessions).toHaveLength(1);
    expect(reloaded.agentItems).toHaveLength(1);
    expect(reloaded.interactionRequests[0]?.status).toBe('RESOLVED');
    expect(reloaded.runs[0]?.sessionId).toBe(session.id);
    expect(reloaded.runs[0]?.promptArtifactId).toBeTruthy();
  });

  it('keeps protocol traffic out of the monolithic store and continues journal sequences', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-journal-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const storePath = path.join(dir, 'store.json');
    const before = await fs.readFile(storePath, 'utf8');

    const first = await store.appendProtocolMessage(server.id, 'INBOUND', '{"id":1}');
    const secondStore = new FileTaskStore(dir);
    await secondStore.init();
    const second = await secondStore.appendProtocolMessage(server.id, 'OUTBOUND', '{"id":2}');

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(await fs.readFile(storePath, 'utf8')).toBe(before);

    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    expect(journal.trim().split('\n')).toHaveLength(2);
    if (process.platform !== 'win32') {
      expect((await fs.stat(server.protocolJournalPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('flushes protocol journal data when the store closes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-close-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const reference = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"event":"before-close"}'
    );

    await store.close();

    const restarted = new FileTaskStore(dir);
    await expect(restarted.readProtocolMessage(reference)).resolves.toEqual({
      raw: '{"event":"before-close"}'
    });
    await restarted.close();
  });

  it('scopes provider session and turn identifiers by runtime', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-scope-'));
    const store = new FileTaskStore(dir);
    const createRuntimeContext = async (runtimeId: string) => {
      const task = await store.createTask({
        runtimeId,
        title: `${runtimeId} task`,
        prompt: 'Exercise scoped provider identifiers.',
        repositoryPath: dir
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: `codex/${runtimeId}-scope`,
        worktreePath: dir,
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        runtimeId
      });
      await store.updateAgentSession(session.id, { providerSessionId: 'shared-session-id' });
      const run = await store.createRun({
        task,
        session,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt
      });
      await store.updateRun(run.id, { providerTurnId: 'shared-turn-id' });
      return { session, run };
    };

    const codex = await createRuntimeContext('codex');
    const opencode = await createRuntimeContext('opencode');

    await expect(store.getAgentSessionByProviderId('codex', 'shared-session-id')).resolves
      .toMatchObject({ id: codex.session.id, runtimeId: 'codex' });
    await expect(store.getAgentSessionByProviderId('opencode', 'shared-session-id')).resolves
      .toMatchObject({ id: opencode.session.id, runtimeId: 'opencode' });
    await expect(store.getRunByProviderTurnId('codex', 'shared-turn-id')).resolves
      .toMatchObject({ id: codex.run.id, runtimeId: 'codex' });
    await expect(store.getRunByProviderTurnId('opencode', 'shared-turn-id')).resolves
      .toMatchObject({ id: opencode.run.id, runtimeId: 'opencode' });
  });

  it('allows a distinct runtime only for detached review sessions and review runs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-review-runtime-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      runtimeId: 'codex',
      title: 'Review with another runtime',
      prompt: 'Implement with Codex, then review with OpenCode.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/cross-runtime-review',
      worktreePath: dir,
      baseSha: 'base'
    });

    await expect(
      store.createAgentSession({ task, iteration, worktree, runtimeId: 'opencode' })
    ).rejects.toThrow('Primary task work must use the task runtime');

    const reviewSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'opencode',
      role: 'REVIEW'
    });
    expect(reviewSession).toMatchObject({ runtimeId: 'opencode', role: 'REVIEW' });
    await expect(
      store.createRun({
        task,
        session: reviewSession,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt
      })
    ).rejects.toThrow('Only detached review runs may use a runtime other than the task runtime');
    await expect(
      store.createRun({
        task,
        session: reviewSession,
        mode: 'REVIEW',
        prompt: 'Review the implementation.'
      })
    ).resolves.toMatchObject({ runtimeId: 'opencode', mode: 'REVIEW' });
  });

  it('migrates schema 11 provider identity into runtime-owned records and settings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-schema11-runtime-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Legacy runtime identity',
      prompt: 'Preserve the owning runtime.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/schema11-runtime',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex'
    });
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'legacy-agent',
      argv: ['serve']
    });
    const run = await store.createRun({
      task,
      session,
      serverInstanceId: server.id,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    const rawRequest = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"permission","id":1}'
    );
    await store.createInteractionRequest({
      runtimeId: 'codex',
      serverInstanceId: server.id,
      providerRequestId: 1,
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      type: 'COMMAND_APPROVAL',
      request: { command: 'npm test', startedAtMs: 1 },
      allowedActions: ['ACCEPT', 'DECLINE'],
      policyWarnings: [],
      requestRawMessage: rawRequest
    });
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      schemaVersion: number;
      tasks: Array<Record<string, unknown>>;
      runs: Array<Record<string, unknown>>;
      agentServers: Array<Record<string, unknown>>;
      agentSessions: Array<Record<string, unknown>>;
      interactionRequests: Array<Record<string, unknown>>;
    };
    persisted.schemaVersion = 11;
    for (const record of [
      persisted.tasks[0]!,
      persisted.runs[0]!,
      persisted.agentServers[0]!,
      persisted.agentSessions[0]!
    ]) {
      delete record.runtimeId;
    }
    persisted.agentSessions[0]!.provider = 'opencode';
    persisted.agentServers[0]!.provider = 'opencode';
    delete persisted.interactionRequests[0]!.runtimeId;
    delete (persisted.tasks[0]!.agentSettings as Record<string, unknown>).runtimeId;
    delete (persisted.runs[0]!.requestedSettings as Record<string, unknown>).runtimeId;
    delete (persisted.agentSessions[0]!.requestedSettings as Record<string, unknown>).runtimeId;
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });

    const migrated = await new FileTaskStore(dir).snapshot();
    expect(migrated.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(migrated.tasks[0]).toMatchObject({
      runtimeId: 'opencode',
      agentSettings: { runtimeId: 'opencode' }
    });
    expect(migrated.agentSessions[0]).toMatchObject({
      runtimeId: 'opencode',
      requestedSettings: { runtimeId: 'opencode' }
    });
    expect(migrated.runs[0]).toMatchObject({
      runtimeId: 'opencode',
      requestedSettings: { runtimeId: 'opencode' }
    });
    expect(migrated.agentServers[0]).toMatchObject({ runtimeId: 'opencode' });
    expect(migrated.interactionRequests[0]).toMatchObject({ runtimeId: 'opencode' });
    const rewritten = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      schemaVersion: number;
      agentSessions: Array<Record<string, unknown>>;
    };
    expect(rewritten.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(rewritten.agentSessions[0]).not.toHaveProperty('provider');
  });

  it('rejects malformed schema 11 collections instead of dropping durable records', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-schema11-malformed-'));
    const store = new FileTaskStore(dir);
    await store.createTask({
      title: 'Do not lose records',
      prompt: 'Reject corrupt migration input.',
      repositoryPath: dir
    });
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as Record<
      string,
      unknown
    >;
    persisted.schemaVersion = 11;
    persisted.agentSessions = [null];
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });

    await expect(new FileTaskStore(dir).init()).rejects.toThrow(
      'agentSessions contains a malformed record'
    );
  });

  it('rejects old store formats instead of maintaining compatibility code', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-old-store-'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'store.json'), JSON.stringify({ tasks: [] }), {
      encoding: 'utf8',
      mode: 0o600
    });

    await expect(new FileTaskStore(dir).init()).rejects.toThrow(
      'migrations are intentionally not supported'
    );
  });
});
