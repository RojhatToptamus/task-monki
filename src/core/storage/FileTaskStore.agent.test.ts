import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION } from '../../shared/contracts';
import {
  FileTaskStore,
  type CreateInteractionRequestInput
} from './FileTaskStore';

describe('FileTaskStore agent persistence', () => {
  it('publishes an awaiting interaction, run, and session as one durable boundary', async () => {
    const fixture = await createAwaitingInteractionFixture();

    const interaction = await fixture.store.createInteractionRequest(
      fixture.interaction
    );

    assertCompleteAwaitingBoundary(await fixture.store.snapshot(), fixture, interaction.id);
    await fixture.store.close();
    assertCompleteAwaitingBoundary(
      await new FileTaskStore(fixture.dir).snapshot(),
      fixture,
      interaction.id
    );
  });

  it('rejects a persisted interaction whose task does not own its run and session', async () => {
    const fixture = await createAwaitingInteractionFixture();
    await fixture.store.createInteractionRequest(fixture.interaction);
    await fixture.store.close();
    const storePath = path.join(fixture.dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      interactionRequests: Array<{ taskId: string }>;
    };
    persisted.interactionRequests[0]!.taskId = randomUUID();
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(fixture.dir).snapshot()).rejects.toThrow(
      'interaction runtime ownership is inconsistent'
    );
  });

  it('rejects duplicate persisted interaction identifiers', async () => {
    const fixture = await createAwaitingInteractionFixture();
    await fixture.store.createInteractionRequest(fixture.interaction);
    await fixture.store.close();
    const storePath = path.join(fixture.dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      interactionRequests: Array<Record<string, unknown>>;
    };
    persisted.interactionRequests.push({ ...persisted.interactionRequests[0]! });
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(fixture.dir).snapshot()).rejects.toThrow(
      'interactionRequests contains duplicate identifiers'
    );
  });

  it('rejects duplicate persisted interaction occurrences with distinct record ids', async () => {
    const fixture = await createAwaitingInteractionFixture();
    await fixture.store.createInteractionRequest(fixture.interaction);
    await fixture.store.close();
    const storePath = path.join(fixture.dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      interactionRequests: Array<Record<string, unknown>>;
    };
    persisted.interactionRequests.push({
      ...persisted.interactionRequests[0]!,
      id: randomUUID()
    });
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(fixture.dir).snapshot()).rejects.toThrow(
      'interaction occurrence identity is duplicated'
    );
  });

  it('rejects an interaction request whose raw message belongs to another server', async () => {
    const fixture = await createAwaitingInteractionFixture();
    const otherServer = await fixture.store.createAgentServer({
      runtimeId: fixture.interaction.runtimeId,
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const otherRaw = await fixture.store.appendProtocolMessage(
      otherServer.id,
      'INBOUND',
      '{"method":"session/request_permission","id":"wrong-server"}'
    );

    await expect(
      fixture.store.createInteractionRequest({
        ...fixture.interaction,
        requestRawMessage: otherRaw
      })
    ).rejects.toThrow('raw message does not match its server');
    expect((await fixture.store.snapshot()).interactionRequests).toEqual([]);
    await fixture.store.close();
  });

  it('rejects an interaction response whose raw message belongs to another server', async () => {
    const fixture = await createAwaitingInteractionFixture();
    const interaction = await fixture.store.createInteractionRequest(
      fixture.interaction
    );
    const otherServer = await fixture.store.createAgentServer({
      runtimeId: fixture.interaction.runtimeId,
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const otherRaw = await fixture.store.appendProtocolMessage(
      otherServer.id,
      'OUTBOUND',
      '{"id":"atomic-approval-request","result":"accept"}'
    );

    await expect(
      fixture.store.transitionInteractionRequest(interaction.id, 'PENDING', {
        status: 'RESPONDING',
        responseRawMessage: otherRaw
      })
    ).rejects.toThrow('response raw message does not match its server');
    const unchanged = await fixture.store.getInteractionRequest(interaction.id);
    expect(unchanged?.status).toBe('PENDING');
    expect(unchanged?.responseRawMessage).toBeUndefined();
    await fixture.store.close();
  });

  it('replays the exact occurrence after terminal provider request id reuse', async () => {
    const fixture = await createAwaitingInteractionFixture();
    const first = await fixture.store.createInteractionRequest(fixture.interaction);
    await fixture.store.transitionInteractionRequest(first.id, 'PENDING', {
      status: 'DECLINED',
      resolvedAt: new Date().toISOString()
    });
    const secondRaw = await fixture.store.appendProtocolMessage(
      fixture.interaction.serverInstanceId,
      'INBOUND',
      '{"method":"session/request_permission","id":"atomic-approval-request","occurrence":2}'
    );
    const secondInput: CreateInteractionRequestInput = {
      ...fixture.interaction,
      requestRawMessage: secondRaw
    };
    const second = await fixture.store.createInteractionRequest(secondInput);
    await fixture.store.close();

    const storePath = path.join(fixture.dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      interactionRequests: Array<Record<string, unknown>>;
    };
    persisted.interactionRequests.reverse();
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const restarted = new FileTaskStore(fixture.dir);
    const thirdRaw = await restarted.appendProtocolMessage(
      fixture.interaction.serverInstanceId,
      'INBOUND',
      '{"method":"session/request_permission","id":"atomic-approval-request","occurrence":3}'
    );
    await expect(
      restarted.createInteractionRequest({
        ...fixture.interaction,
        requestRawMessage: thirdRaw
      })
    ).rejects.toThrow('previous occurrence is still active');
    await expect(
      restarted.createInteractionRequest({
        ...secondInput,
        request: { command: 'npm run build', startedAtMs: Date.now() }
      })
    ).rejects.toThrow('does not match its original immutable fields');
    await expect(restarted.createInteractionRequest(secondInput)).resolves.toMatchObject({
      id: second.id,
      status: 'PENDING'
    });
    expect((await restarted.snapshot()).interactionRequests).toHaveLength(2);
    await restarted.close();
  });

  it('rejects an agent item output artifact owned outside its run', async () => {
    const fixture = await createAwaitingInteractionFixture();
    const run = (await fixture.store.getRun(fixture.runId))!;
    const item = await fixture.store.upsertAgentItem({
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      sessionId: run.sessionId,
      providerItemId: 'artifact-owner-item',
      type: 'COMMAND_EXECUTION',
      status: 'COMPLETED',
      payload: {},
      outputArtifactId: run.outputArtifactId
    });
    const taskArtifact = await fixture.store.writeTextArtifact(
      run.taskId,
      'diff',
      'Task-owned artifact outside the run.'
    );
    await fixture.store.close();
    const storePath = path.join(fixture.dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      agentItems: Array<{ id: string; outputArtifactId?: string }>;
    };
    persisted.agentItems.find((candidate) => candidate.id === item.id)!.outputArtifactId =
      taskArtifact.id;
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(fixture.dir).snapshot()).rejects.toThrow(
      'agent item output artifact ownership is inconsistent'
    );
  });

  it('never exposes a partially actionable awaiting interaction while its write fails', async () => {
    const fixture = await createAwaitingInteractionFixture();
    let markWriteEntered!: () => void;
    let failWrite!: (cause: Error) => void;
    const writeEntered = new Promise<void>((resolve) => {
      markWriteEntered = resolve;
    });
    const failedWrite = new Promise<void>((_resolve, reject) => {
      failWrite = reject;
    });
    const internals = fixture.store as unknown as {
      persistSnapshot(): Promise<boolean>;
    };
    const persist = vi
      .spyOn(internals, 'persistSnapshot')
      .mockImplementationOnce(async () => {
        markWriteEntered();
        await failedWrite;
        return true;
      });

    const activation = fixture.store.createInteractionRequest(
      fixture.interaction
    );
    const rejected = expect(activation).rejects.toThrow(
      'injected awaiting-boundary write failure'
    );
    await writeEntered;

    let readSettled = false;
    const live = fixture.store.snapshot().then((snapshot) => {
      readSettled = true;
      return snapshot;
    });
    await Promise.resolve();
    expect(readSettled).toBe(false);

    failWrite(new Error('injected awaiting-boundary write failure'));
    await rejected;
    persist.mockRestore();

    const rolledBack = await live;
    expect(rolledBack.interactionRequests).toHaveLength(0);
    expect(rolledBack.runs.find((run) => run.id === fixture.runId)?.status).toBe('RUNNING');
    expect(rolledBack.agentSessions.find((session) => session.id === fixture.sessionId)?.status)
      .toBe('ACTIVE');
    await fixture.store.close();
    const durable = await new FileTaskStore(fixture.dir).snapshot();
    expect(durable.interactionRequests).toHaveLength(0);
    expect(durable.runs.find((run) => run.id === fixture.runId)?.status).toBe('RUNNING');
    expect(durable.agentSessions.find((session) => session.id === fixture.sessionId)?.status)
      .toBe('ACTIVE');
  });

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
    await store.appendArtifact(run.outputArtifactId, 'streamed output\n');
    expect(
      JSON.parse(await fs.readFile(path.join(dir, 'store.json'), 'utf8')).artifacts.find(
        (artifact: { id: string }) => artifact.id === run.outputArtifactId
      )
    ).toMatchObject({ byteCount: Buffer.byteLength('streamed output\n') });
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
    await store.updateAgentServer(server.id, {
      status: 'EXITED',
      exitCode: 1,
      signal: null,
      exitedAt: new Date().toISOString()
    });

    await store.close();
    const reloaded = await new FileTaskStore(dir).snapshot();
    expect(reloaded.agentServers).toHaveLength(1);
    expect(reloaded.agentServers[0]).toMatchObject({ exitCode: 1, signal: null });
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
    const closing = store.close();
    await expect(
      store.appendProtocolMessage(server.id, 'OUTBOUND', '{"event":"too-late"}')
    ).rejects.toThrow('Task store is closed');
    await expect(store.readProtocolMessage(first)).rejects.toThrow(
      'Task store is closed'
    );
    await closing;
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
    const server = await store.createAgentServer({
      runtimeId: 'opencode',
      runtimeKind: 'HTTP_AGENT',
      transport: 'HTTP_SSE',
      executable: 'opencode',
      argv: ['serve']
    });
    const reviewRun = await store.createRun({
      task,
      session: reviewSession,
      serverInstanceId: server.id,
      mode: 'REVIEW',
      prompt: 'Review the implementation.'
    });
    expect(reviewRun).toMatchObject({ runtimeId: 'opencode', mode: 'REVIEW' });

    const raw = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"type":"session.updated","properties":{"info":{"id":"child"}}}'
    );
    const child = await store.observeSubagent({
      parentSessionId: reviewSession.id,
      parentRunId: reviewRun.id,
      providerChildSessionId: 'opencode-review-child',
      source: 'SUBAGENT_ACTIVITY',
      rawMessage: raw
    });
    const childRun = await store.createObservedSubagentRun({
      session: child.session,
      providerTurnId: 'opencode-review-child-turn',
      serverInstanceId: server.id,
      parentRunId: reviewRun.id
    });
    await store.close();

    const reloaded = await new FileTaskStore(dir).snapshot();
    expect(
      reloaded.agentSessions.find((session) => session.id === child.session.id)
    ).toMatchObject({ runtimeId: 'opencode', role: 'SUBAGENT' });
    expect(reloaded.runs.find((run) => run.id === childRun.id)).toMatchObject({
      runtimeId: 'opencode',
      mode: 'SUBAGENT'
    });
  });

  it.each([
    ['schema 12', 12],
    ['a missing schema', undefined]
  ])('rejects %s instead of maintaining compatibility code', async (_label, version) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-old-store-'));
    const store = new FileTaskStore(dir);
    await store.createTask({
      title: 'Current schema only',
      prompt: 'Reject legacy durable state.',
      repositoryPath: dir
    });
    await store.close();
    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as Record<
      string,
      unknown
    >;
    if (version === undefined) delete persisted.schemaVersion;
    else persisted.schemaVersion = version;
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });

    await expect(new FileTaskStore(dir).init()).rejects.toThrow(
      `This build accepts only schema ${TASK_STORE_SCHEMA_VERSION}`
    );
  });
});

async function createAwaitingInteractionFixture(): Promise<{
  dir: string;
  store: FileTaskStore;
  taskId: string;
  runId: string;
  sessionId: string;
  interaction: CreateInteractionRequestInput;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-awaiting-boundary-'));
  const store = new FileTaskStore(dir);
  const task = await store.createTask({
    title: 'Atomic approval boundary',
    prompt: 'Request approval.',
    repositoryPath: dir
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: 'codex/atomic-approval-boundary',
    worktreePath: dir,
    baseSha: 'base'
  });
  const createdSession = await store.createAgentSession({
    task,
    iteration,
    worktree,
    runtimeId: 'codex'
  });
  const session = await store.updateAgentSession(createdSession.id, {
    providerSessionId: 'atomic-approval-session',
    status: 'ACTIVE',
    materialized: true
  });
  const server = await store.createAgentServer({
    runtimeId: 'codex',
    runtimeKind: 'APP_SERVER',
    transport: 'STDIO',
    executable: 'codex',
    argv: ['app-server', '--stdio']
  });
  const createdRun = await store.createRun({
    task,
    session,
    serverInstanceId: server.id,
    mode: 'IMPLEMENTATION',
    prompt: task.prompt
  });
  const run = await store.updateRun(createdRun.id, {
    providerTurnId: 'atomic-approval-turn',
    status: 'RUNNING'
  });
  const requestRawMessage = await store.appendProtocolMessage(
    server.id,
    'INBOUND',
    '{"method":"session/request_permission","id":"atomic-approval-request"}'
  );
  return {
    dir,
    store,
    taskId: task.id,
    runId: run.id,
    sessionId: session.id,
    interaction: {
      runtimeId: 'codex',
      serverInstanceId: server.id,
      providerRequestId: 'atomic-approval-request',
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      providerTurnId: run.providerTurnId,
      type: 'COMMAND_APPROVAL',
      request: { command: 'npm test', startedAtMs: Date.now() },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
      policyWarnings: [],
      requestRawMessage
    }
  };
}

function assertCompleteAwaitingBoundary(
  snapshot: Awaited<ReturnType<FileTaskStore['snapshot']>>,
  fixture: { taskId: string; runId: string; sessionId: string },
  interactionId: string
): void {
  expect(snapshot.interactionRequests.find((interaction) => interaction.id === interactionId))
    .toMatchObject({ status: 'PENDING', runId: fixture.runId, sessionId: fixture.sessionId });
  expect(snapshot.runs.find((run) => run.id === fixture.runId)?.status)
    .toBe('AWAITING_APPROVAL');
  expect(snapshot.agentSessions.find((session) => session.id === fixture.sessionId)?.status)
    .toBe('AWAITING_APPROVAL');
  expect(snapshot.tasks.find((task) => task.id === fixture.taskId)?.projection.agentRun)
    .toBe('AWAITING_APPROVAL');
  expect(
    snapshot.events.filter(
      (event) =>
        event.type === 'AGENT_INTERACTION_REQUESTED' &&
        event.interactionRequestId === interactionId
    )
  ).toHaveLength(1);
}
