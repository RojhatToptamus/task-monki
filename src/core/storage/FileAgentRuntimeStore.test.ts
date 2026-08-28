import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentExecutionContext,
  AgentOwnerScope,
  AgentRunScope
} from '../../shared/agentRuntime';
import { AGENT_RUNTIME_STORE_SCHEMA_VERSION } from '../../shared/agentRuntime';
import { createAgentSessionAccessEpoch } from '../agent/AgentRuntimeOwnership';
import { createDomainEvent } from './domainEvent';
import type {
  CreateRuntimeRunInput,
  CreateRuntimeSessionInput
} from '../agent/AgentRuntimeStore';
import {
  AgentRuntimeStorePublishedError,
  FileAgentRuntimeStore
} from './FileAgentRuntimeStore';

describe('FileAgentRuntimeStore', () => {
  it('creates and restarts one canonical Task runtime projection with atomic artifacts', async () => {
    const fixture = await storeFixture();
    const delivered: string[] = [];
    const runtime = fixture.store.taskAgentRuntimeAccess(async (event) => {
      delivered.push(event.id);
    });
    const context = executionContext('create-task-session');
    const session = await runtime.createTaskSession({
      id: 'task-session-atomic',
      taskId: 'task-1',
      iterationId: 'iteration-1',
      worktreeId: 'worktree-1',
      worktreePath: context.primaryCwd,
      runtimeId: 'codex',
      requestedSettings: {
        runtimeId: 'codex',
        model: 'gpt-test',
        sandbox: 'READ_ONLY',
        approvalPolicy: 'NEVER',
        networkAccess: false
      },
      executionContext: context,
      operationId: 'create-task-session'
    });
    const run = await runtime.createTaskRun({
      id: 'task-run-atomic',
      taskId: 'task-1',
      iterationId: 'iteration-1',
      worktreeId: 'worktree-1',
      sessionId: session.id,
      mode: 'IMPLEMENTATION',
      prompt: 'Implement the task.',
      generationKey: 'task-generation-atomic',
      beforeGitSnapshotId: 'git-before',
      operationId: 'create-task-run'
    });
    expect(await fixture.store.readArtifact(run.promptArtifactId)).toBe(
      'Implement the task.'
    );
    expect((await runtime.snapshot()).artifacts).toHaveLength(3);

    await runtime.updateRun(
      run.id,
      {
        providerTurnId: 'turn-atomic',
        status: 'STARTING',
        lastEventAt: '2026-07-13T00:00:20.000Z'
      },
      'send-task-run'
    );
    const started = createDomainEvent({
      type: 'PROCESS_STARTED',
      taskId: 'task-1',
      iterationId: 'iteration-1',
      runId: run.id,
      source: 'process',
      payload: {}
    });
    await runtime.applyTaskRuntimeEvent(started, 'apply-process-started');
    await runtime.upsertAgentItem(
      {
        taskId: 'task-1',
        iterationId: 'iteration-1',
        runId: run.id,
        sessionId: session.id,
        providerItemId: 'provider-item-atomic',
        type: 'AGENT_MESSAGE',
        status: 'COMPLETED',
        payload: { text: 'provider output' }
      },
      'record-provider-item'
    );
    await runtime.recordAgentGoalSnapshot(
      {
        taskId: 'task-1',
        iterationId: 'iteration-1',
        sessionId: session.id,
        runtimeId: 'codex',
        taskGoalHash: 'a'.repeat(64),
        syncState: 'IN_SYNC',
        source: 'TASK_MONKI_SYNC'
      },
      'record-goal-snapshot'
    );
    await runtime.appendArtifact(
      run.outputArtifactId,
      'provider output',
      'append-provider-output'
    );
    const final = await runtime.writeFinalArtifact(
      'task-1',
      run.id,
      'final answer',
      'write-final-answer'
    );
    expect(final.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    const completed = createDomainEvent({
      type: 'AGENT_RUN_COMPLETED',
      taskId: 'task-1',
      iterationId: 'iteration-1',
      runId: run.id,
      source: 'provider',
      payload: { finalArtifactId: final.id }
    });
    await runtime.applyTaskRuntimeEvent(completed, 'apply-run-completed');
    expect(delivered).toEqual([started.id, completed.id]);

    const restarted = new FileAgentRuntimeStore(fixture.root);
    const snapshot = await restarted.taskAgentRuntimeAccess().snapshot();
    expect(snapshot.agentSessions).toEqual([session]);
    expect(snapshot.runs[0]).toMatchObject({
      id: run.id,
      status: 'COMPLETED',
      beforeGitSnapshotId: 'git-before',
      finalArtifactId: final.id
    });
    expect(snapshot.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      'agent-diagnostics',
      'agent-final',
      'agent-output',
      'agent-prompt'
    ]);
    expect(snapshot.agentItems).toHaveLength(1);
    expect(snapshot.agentGoalSnapshots).toHaveLength(1);
  });

  it('prepares a generic turn as one idempotent durable unit', async () => {
    const fixture = await storeFixture();
    const session = sessionInput(
      'prepared-session',
      discourseOwner,
      'prepare-turn:session'
    );
    const run = genericRunInput(
      'prepared-run',
      session,
      discourseScope,
      'prepare-turn:run'
    );
    const request = {
      session,
      run,
      prompt: 'Answer the discussion.',
      priority: 'DISCOURSE_RESPONSE' as const,
      queueOperationId: 'prepare-turn:enqueue'
    };

    const prepared = await fixture.store.prepareRuntimeTurn(request);
    await expect(fixture.store.prepareRuntimeTurn(request)).resolves.toEqual(prepared);
    await expect(
      fixture.store.prepareRuntimeTurn({ ...request, prompt: 'Different prompt.' })
    ).rejects.toThrow('conflicts with its durable artifacts');

    const snapshot = await fixture.store.snapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.artifacts).toHaveLength(3);
    expect(snapshot.queueEntries).toHaveLength(1);
    await expect(fixture.store.readArtifact(run.promptArtifactId)).resolves.toBe(
      request.prompt
    );

    await fixture.store.close();
    const restarted = new FileAgentRuntimeStore(fixture.root);
    await expect(restarted.snapshot()).resolves.toMatchObject({
      sessions: [{ id: session.id }],
      runs: [{ id: run.id }],
      queueEntries: [{ runId: run.id }]
    });
    await expect(restarted.readArtifact(run.promptArtifactId)).resolves.toBe(
      request.prompt
    );
    await restarted.close();
  });

  it('does not publish a partial generic turn when preparation fails before commit', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-agent-runtime-prepare-crash-')
    );
    let fileSyncs = 0;
    const store = new FileAgentRuntimeStore(root, {
      afterFileSync: async () => {
        fileSyncs += 1;
        if (fileSyncs === 2) throw new Error('crash before turn publish');
      }
    });
    await store.snapshot();
    const session = sessionInput(
      'crashed-prepared-session',
      discourseOwner,
      'crashed-prepare:session'
    );
    const run = genericRunInput(
      'crashed-prepared-run',
      session,
      discourseScope,
      'crashed-prepare:run'
    );

    await expect(
      store.prepareRuntimeTurn({
        session,
        run,
        prompt: 'Do not leave partial state.',
        priority: 'DISCOURSE_RESPONSE',
        queueOperationId: 'crashed-prepare:enqueue'
      })
    ).rejects.toThrow('crash before turn publish');

    const restarted = new FileAgentRuntimeStore(root);
    await expect(restarted.snapshot()).resolves.toMatchObject({
      sessions: [],
      runs: [],
      artifacts: [],
      queueEntries: []
    });
    await restarted.close();
  });

  it('keeps an ambiguous pre-turn provider mutation out of the prompt delivery record', async () => {
    const fixture = await storeFixture();
    const runtime = fixture.store.taskAgentRuntimeAccess();
    const context = executionContext('create-ambiguous-session');
    const session = await runtime.createTaskSession({
      id: 'task-session-ambiguous',
      taskId: 'task-ambiguous',
      iterationId: 'iteration-ambiguous',
      worktreeId: 'worktree-ambiguous',
      worktreePath: context.primaryCwd,
      runtimeId: 'codex',
      requestedSettings: context.modelSettings,
      executionContext: context,
      operationId: 'create-ambiguous-session'
    });
    const run = await runtime.createTaskRun({
      id: 'task-run-ambiguous',
      taskId: 'task-ambiguous',
      iterationId: 'iteration-ambiguous',
      worktreeId: 'worktree-ambiguous',
      sessionId: session.id,
      mode: 'IMPLEMENTATION',
      prompt: 'Do not send this prompt twice.',
      operationId: 'create-ambiguous-run'
    });

    await runtime.applyTaskRuntimeEvent(
      createDomainEvent({
        type: 'AGENT_MUTATION_AMBIGUOUS',
        taskId: 'task-ambiguous',
        iterationId: 'iteration-ambiguous',
        runId: run.id,
        source: 'provider',
        payload: { reason: 'The provider response was lost.' }
      }),
      'record-ambiguous-delivery'
    );

    await expect(fixture.store.getRun(run.id)).resolves.toMatchObject({
      status: 'RECOVERY_REQUIRED',
      delivery: 'NOT_DELIVERED',
      recoveryState: 'REQUIRES_USER_ACTION'
    });
  });

  it('owns App Server lifecycle and bounded protocol evidence outside task storage', async () => {
    const fixture = await storeFixture();
    const server = await fixture.store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: '/usr/local/bin/codex',
      argv: ['app-server', '--stdio'],
      runtimeVersion: '1.2.3'
    });
    const running = await fixture.store.updateAgentServer(server.id, {
      status: 'RUNNING',
      pid: 42
    });
    expect(running.status).toBe('RUNNING');
    const outbound = await fixture.store.appendProtocolMessage(
      server.id,
      'OUTBOUND',
      '{"method":"initialize"}',
      { transport: 'stdio' }
    );
    const inbound = await fixture.store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"id":1,"result":{}}'
    );
    expect(inbound.sequence).toBe(2);
    await expect(fixture.store.readProtocolMessage(outbound)).resolves.toEqual({
      raw: '{"method":"initialize"}',
      metadata: { transport: 'stdio' }
    });

    const reloaded = new FileAgentRuntimeStore(fixture.root);
    expect(await reloaded.listAgentServers()).toEqual([running]);
    expect(
      await reloaded.appendProtocolMessage(server.id, 'OUTBOUND', '{"method":"initialized"}')
    ).toMatchObject({ sequence: 3 });
    await expect(
      reloaded.appendProtocolMessage('unknown-server', 'INBOUND', '{}')
    ).rejects.toThrow('not owned');
  });

  it('drains admitted runtime mutations and protocol writes before closing', async () => {
    const fixture = await storeFixture();
    const server = await createServerWithJournal(fixture.store, 'close');
    const pendingSession = fixture.store.createSession(
      sessionInput('closing-session', taskOwner, 'closing-session-operation')
    );
    const pendingMessage = fixture.store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"event":"before-close"}'
    );

    const closing = fixture.store.close();
    expect(fixture.store.close()).toBe(closing);
    const [session, reference] = await Promise.all([
      pendingSession,
      pendingMessage
    ]);
    await closing;

    await expect(fixture.store.snapshot()).rejects.toThrow('store is closed');
    await expect(
      fixture.store.createSession(
        sessionInput('late-session', taskOwner, 'late-session-operation')
      )
    ).rejects.toThrow('store is closed');
    await expect(
      fixture.store.appendProtocolMessage(server.id, 'OUTBOUND', '{}')
    ).rejects.toThrow('store is closed');
    await expect(fixture.store.readProtocolMessage(reference)).rejects.toThrow(
      'store is closed'
    );

    const restarted = new FileAgentRuntimeStore(fixture.root);
    expect((await restarted.snapshot()).sessions).toEqual([session]);
    await expect(restarted.readProtocolMessage(reference)).resolves.toEqual({
      raw: '{"event":"before-close"}'
    });
    await expect(
      restarted.appendProtocolMessage(server.id, 'OUTBOUND', '{"event":"after-restart"}')
    ).resolves.toMatchObject({ sequence: 3 });
    await restarted.close();
  });

  it('retains active and the eight newest unreferenced terminal servers', async () => {
    const fixture = await storeFixture();
    const active = await createServerWithJournal(fixture.store, 'active');
    await fixture.store.updateAgentServer(active.id, { status: 'READY' });
    const terminalServers = [];
    for (let index = 0; index < 9; index += 1) {
      const server = await createServerWithJournal(
        fixture.store,
        `terminal-${index}`
      );
      await fixture.store.updateAgentServer(server.id, {
        status: 'EXITED',
        exitedAt: new Date(Date.UTC(2026, 6, 13, 10, index)).toISOString()
      });
      terminalServers.push(server);
    }

    const retainedIds = new Set(
      (await fixture.store.listAgentServers()).map((server) => server.id)
    );
    expect(retainedIds).toEqual(
      new Set([active.id, ...terminalServers.slice(1).map((server) => server.id)])
    );
    await expect(
      fs.access(terminalServers[0]!.protocolJournalPath)
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(active.protocolJournalPath)).resolves.toBeUndefined();
    await expect(
      fs.access(terminalServers.at(-1)!.protocolJournalPath)
    ).resolves.toBeUndefined();
    await fixture.store.close();
  });

  it('collects a terminal server only after its Task runtime references are purged', async () => {
    const fixture = await storeFixture();
    const referenced = await createServerWithJournal(fixture.store, 'referenced');
    const session = await fixture.store.createSession(
      sessionInput('referenced-session', taskOwner, 'referenced-session-operation')
    );
    const run = await fixture.store.createRun({
      ...runInput('referenced-run', session, taskScope, 'referenced-run-operation'),
      serverInstanceId: referenced.id
    });
    await fixture.store.updateAgentServer(referenced.id, {
      status: 'EXITED',
      exitedAt: '2026-07-13T09:00:00.000Z'
    });
    for (let index = 0; index < 8; index += 1) {
      const server = await createServerWithJournal(fixture.store, `retained-${index}`);
      await fixture.store.updateAgentServer(server.id, {
        status: 'FAILED',
        exitedAt: new Date(Date.UTC(2026, 6, 13, 10, index)).toISOString()
      });
    }
    expect(await fixture.store.getAgentServer(referenced.id)).toBeDefined();
    await expect(fs.access(referenced.protocolJournalPath)).resolves.toBeUndefined();

    await fixture.store.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'INTERRUPTED',
        delivery: 'NOT_DELIVERED',
        endedAt: '2026-07-13T12:00:00.000Z'
      },
      'settle-referenced-run'
    );
    await expect(fixture.store.purgeTask('task-1')).resolves.toMatchObject({
      sessionCount: 1,
      runCount: 1
    });

    expect(await fixture.store.getAgentServer(referenced.id)).toBeUndefined();
    await expect(fs.access(referenced.protocolJournalPath)).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await fixture.store.close();
  });

  it('removes safe orphan journal segments during restart reconciliation', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-agent-runtime-orphan-journal-')
    );
    const initial = new FileAgentRuntimeStore(root);
    await initial.snapshot();
    await initial.close();
    const journalDirectory = path.join(root, 'protocol-journals');
    const orphanPath = path.join(journalDirectory, 'orphan-server.2.ndjson');
    const unrelatedPath = path.join(journalDirectory, 'operator-notes.txt');
    await fs.writeFile(orphanPath, '{"orphan":true}\n', { mode: 0o600 });
    await fs.writeFile(unrelatedPath, 'preserve\n', { mode: 0o600 });

    const restarted = new FileAgentRuntimeStore(root);
    await restarted.snapshot();

    await expect(fs.access(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(unrelatedPath, 'utf8')).resolves.toBe('preserve\n');
    await restarted.close();
  });

  it('stores bounded owner-neutral telemetry with durable scope and idempotency', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('telemetry-session', taskOwner, 'telemetry-session-operation')
    );
    const run = await fixture.store.createRun(
      runInput('telemetry-run', session, taskScope, 'telemetry-run-operation')
    );
    const request = {
      id: 'telemetry-item-1',
      kind: 'ITEM' as const,
      owner: taskOwner,
      sessionId: session.id,
      runId: run.id,
      providerIdentity: 'provider-item-1',
      clientOperationId: 'telemetry-item-operation',
      payload: { type: 'AGENT_MESSAGE', status: 'COMPLETED' },
      observedAt: '2026-07-13T00:05:00.000Z'
    };
    const stored = await fixture.store.recordTelemetry(request);
    expect(await fixture.store.recordTelemetry(request)).toEqual(stored);
    expect(await fixture.store.listTelemetryByOwner(taskOwner)).toEqual([stored]);
    await expect(
      fixture.store.recordTelemetry({
        ...request,
        payload: { type: 'AGENT_MESSAGE', status: 'FAILED' }
      })
    ).rejects.toThrow('conflicts');
    await expect(
      fixture.store.recordTelemetry({
        ...request,
        id: 'telemetry-item-2',
        clientOperationId: 'telemetry-oversized-operation',
        payload: { text: 'x'.repeat(300 * 1024) }
      })
    ).rejects.toThrow('safety limit');

    const reloaded = new FileAgentRuntimeStore(fixture.root);
    expect(await reloaded.listTelemetryByOwner(taskOwner)).toEqual([stored]);
  });

  it('persists task and discourse owners without fabricated cross-scope fields', async () => {
    const fixture = await storeFixture();
    const taskSession = await fixture.store.createSession(
      sessionInput('task-session', taskOwner, 'task-session-operation')
    );
    const discourseSession = await fixture.store.createSession(
      sessionInput('discourse-session', discourseOwner, 'discourse-session-operation')
    );
    await fixture.store.createRun(
      runInput('task-run', taskSession, taskScope, 'task-run-operation')
    );
    await fixture.store.createRun(
      runInput('discourse-run', discourseSession, discourseScope, 'discourse-run-operation')
    );

    const reloaded = new FileAgentRuntimeStore(fixture.root);
    const snapshot = await reloaded.snapshot();
    expect(snapshot.runs.map((run) => run.owner.kind)).toEqual(['TASK', 'DISCOURSE']);
    expect(snapshot.runs[1]?.scope).toMatchObject({
      kind: 'DISCOURSE',
      conversationId: 'conversation-1',
      jobId: 'job-1'
    });
    expect(snapshot.runs[1]).not.toHaveProperty('taskId');
  });

  it('deduplicates lost session/run responses and rejects changed operation payloads', async () => {
    const fixture = await storeFixture();
    const sessionRequest = sessionInput('session-1', taskOwner, 'session-operation');
    const firstSession = await fixture.store.createSession(sessionRequest);
    expect(await fixture.store.createSession(sessionRequest)).toEqual(firstSession);
    await expect(
      fixture.store.createSession({ ...sessionRequest, runtimeId: 'another-runtime' })
    ).rejects.toThrow('does not match its access epoch');

    const request = runInput('run-1', firstSession, taskScope, 'run-operation');
    const firstRun = await fixture.store.createRun(request);
    expect(await fixture.store.createRun(request)).toEqual(firstRun);
    await expect(
      fixture.store.createRun({ ...request, generationKey: 'changed-generation' })
    ).rejects.toThrow('conflicts');
    expect((await fixture.store.snapshot()).revision).toBe(2);
  });

  it('records provider-observed subagent runs as acknowledged without scheduler send intent', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('observed-session', taskOwner, 'observed-session-operation')
    );
    const request = {
      ...runInput('observed-run', session, taskScope, 'observed-run-operation'),
      serverInstanceId: 'server-1',
      providerTurnId: 'turn-child-1',
      purpose: 'PROVIDER_SUBAGENT' as const,
      startedAt: '2026-07-13T00:00:03.000Z'
    };
    const observed = await fixture.store.createObservedRun(request);
    expect(observed).toMatchObject({
      status: 'RUNNING',
      delivery: 'ACKNOWLEDGED',
      recoveryState: 'NONE',
      providerTurnId: 'turn-child-1'
    });
    expect(await fixture.store.createObservedRun(request)).toEqual(observed);
    expect((await fixture.store.snapshot()).queueEntries).toEqual([]);
    expect((await new FileAgentRuntimeStore(fixture.root).getRun(observed.id))).toEqual(
      observed
    );
  });

  it('rejects owner/session mixing and stale or invalid run transitions', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('session-1', taskOwner, 'session-operation')
    );
    await expect(
      fixture.store.createRun(
        runInput('run-1', session, discourseScope, 'run-operation')
      )
    ).rejects.toThrow('does not belong');

    const run = await fixture.store.createRun(
      runInput('run-2', session, taskScope, 'run-operation-2')
    );
    const starting = await fixture.store.updateRun(
      run.id,
      run.recordRevision,
      { status: 'STARTING', delivery: 'SENDING' },
      'start-run'
    );
    expect(
      await fixture.store.updateRun(
        run.id,
        run.recordRevision,
        { status: 'STARTING', delivery: 'SENDING' },
        'start-run'
      )
    ).toEqual(starting);
    await expect(
      fixture.store.updateRun(
        run.id,
        run.recordRevision,
        { status: 'FAILED' },
        'start-run'
      )
    ).rejects.toThrow('conflicts');
    await expect(
      fixture.store.updateRun(
        run.id,
        run.recordRevision,
        { status: 'RUNNING' },
        'stale-update'
      )
    ).rejects.toThrow('changed before');
    await expect(
      fixture.store.updateRun(
        run.id,
        starting.recordRevision,
        { status: 'QUEUED' },
        'invalid-transition'
      )
    ).rejects.toThrow('Invalid agent runtime run transition');
  });

  it('keeps provider session identity and materialization monotonic', async () => {
    const fixture = await storeFixture();
    const first = await fixture.store.createSession(
      sessionInput('session-1', discourseOwner, 'session-operation-1')
    );
    const second = await fixture.store.createSession(
      sessionInput('session-2', discourseOwner, 'session-operation-2')
    );
    const owned = await fixture.store.updateSession(
      first.id,
      first.recordRevision,
      {
        providerSessionId: 'provider-session-1',
        status: 'IDLE',
        materialized: false
      },
      'own-provider-session-1'
    );
    await expect(
      fixture.store.updateSession(
        second.id,
        second.recordRevision,
        {
          providerSessionId: 'provider-session-1',
          status: 'IDLE',
          materialized: false
        },
        'duplicate-unmaterialized-provider-session'
      )
    ).rejects.toThrow('already assigned');
    const materialized = await fixture.store.updateSession(
      owned.id,
      owned.recordRevision,
      {
        materialized: true,
        lastAttachedAt: '2026-07-13T00:00:10.000Z'
      },
      'materialize-session-1'
    );

    await expect(
      fixture.store.updateSession(
        materialized.id,
        materialized.recordRevision,
        { providerSessionId: 'provider-session-changed' },
        'change-provider-session'
      )
    ).rejects.toThrow('identity is immutable');
    await expect(
      fixture.store.updateSession(
        materialized.id,
        materialized.recordRevision,
        { materialized: false },
        'reverse-materialization'
      )
    ).rejects.toThrow('cannot be reversed');
    await expect(
      fixture.store.updateSession(
        materialized.id,
        materialized.recordRevision,
        { status: 'AWAITING_APPROVAL' },
        'invalid-session-transition'
      )
    ).rejects.toThrow('Invalid agent runtime session transition');
    await expect(
      fixture.store.updateSession(
        second.id,
        second.recordRevision,
        {
          providerSessionId: 'provider-session-1',
          status: 'IDLE',
          materialized: true
        },
        'duplicate-provider-session'
      )
    ).rejects.toThrow('already assigned');
  });

  it('tracks interrupt delivery independently from start delivery', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('session-1', discourseOwner, 'session-operation')
    );
    const queued = await fixture.store.createRun(
      runInput('run-1', session, discourseScope, 'run-operation')
    );
    const starting = await fixture.store.updateRun(
      queued.id,
      queued.recordRevision,
      { status: 'STARTING', delivery: 'SENDING' },
      'start-intent'
    );
    const running = await fixture.store.updateRun(
      starting.id,
      starting.recordRevision,
      {
        status: 'RUNNING',
        delivery: 'ACKNOWLEDGED',
        providerTurnId: 'provider-turn-1',
        serverInstanceId: 'server-1'
      },
      'start-acknowledged'
    );
    await expect(
      fixture.store.updateRun(
        running.id,
        running.recordRevision,
        {
          status: 'INTERRUPTING',
          interruptDelivery: 'ACKNOWLEDGED',
          stopRequestedAt: '2026-07-13T00:00:20.000Z'
        },
        'invalid-interrupt-ack'
      )
    ).rejects.toThrow('must begin with durable send intent');
    const interrupting = await fixture.store.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'INTERRUPTING',
        interruptDelivery: 'SENDING',
        stopRequestedAt: '2026-07-13T00:00:20.000Z'
      },
      'interrupt-intent'
    );
    const acknowledged = await fixture.store.updateRun(
      interrupting.id,
      interrupting.recordRevision,
      { interruptDelivery: 'ACKNOWLEDGED' },
      'interrupt-acknowledged'
    );
    await expect(
      fixture.store.updateRun(
        acknowledged.id,
        acknowledged.recordRevision,
        { interruptDelivery: 'SENDING' },
        'interrupt-regression'
      )
    ).rejects.toThrow('Invalid agent runtime interrupt delivery transition');
    await expect(
      fixture.store.updateRun(
        acknowledged.id,
        acknowledged.recordRevision,
        {
          status: 'INTERRUPTED',
          delivery: 'TERMINAL',
          interruptDelivery: 'TERMINAL',
          endedAt: '2026-07-13T00:00:30.000Z'
        },
        'interrupt-terminal'
      )
    ).resolves.toMatchObject({
      status: 'INTERRUPTED',
      delivery: 'TERMINAL',
      interruptDelivery: 'TERMINAL'
    });
  });

  it('durably queues, leases, settles, cancels, and latches shutdown', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('session-1', discourseOwner, 'session-operation')
    );
    const firstRun = await fixture.store.createRun(
      runInput('run-1', session, discourseScope, 'run-operation-1')
    );
    const secondRun = await fixture.store.createRun(
      runInput(
        'run-2',
        session,
        discourseScopeFor('job-2', 'attempt-2'),
        'run-operation-2'
      )
    );
    const [first, second] = await Promise.all([
      fixture.store.enqueueRun(firstRun.id, 'DISCOURSE_RESPONSE', 'enqueue-1'),
      fixture.store.enqueueRun(secondRun.id, 'DISCOURSE_TARGETED', 'enqueue-2')
    ]);
    expect(new Set([first.enqueueOrdinal, second.enqueueOrdinal]).size).toBe(2);
    const leased = await fixture.store.leaseQueueEntry(
      first.id,
      first.recordRevision,
      'lease-1'
    );
    expect(
      await fixture.store.leaseQueueEntry(first.id, first.recordRevision, 'lease-1')
    ).toEqual(leased);
    const released = await fixture.store.releaseQueueEntry(
      leased.id,
      leased.recordRevision,
      'release-1'
    );
    const releasedAgain = await fixture.store.releaseQueueEntry(
      leased.id,
      leased.recordRevision,
      'release-1'
    );
    expect(releasedAgain).toEqual(released);
    const leasedAgain = await fixture.store.leaseQueueEntry(
      released.id,
      released.recordRevision,
      'lease-again-1'
    );
    await fixture.store.settleQueueEntry(
      leasedAgain.id,
      leasedAgain.recordRevision,
      'settle-1'
    );
    await fixture.store.cancelQueueEntry(
      second.id,
      second.recordRevision,
      'User stopped the queued response.',
      'cancel-2'
    );

    await fixture.store.setShutdownLatched(true, 'shutdown');
    const thirdRun = await fixture.store.createRun(
      runInput(
        'run-3',
        session,
        discourseScopeFor('job-3', 'attempt-3'),
        'run-operation-3'
      )
    );
    await expect(
      fixture.store.enqueueRun(thirdRun.id, 'DISCOURSE_RESPONSE', 'enqueue-3')
    ).rejects.toThrow('shut down');
    await fixture.store.setShutdownLatched(false, 'restart-reconciled');
    await expect(
      fixture.store.enqueueRun(thirdRun.id, 'DISCOURSE_RESPONSE', 'enqueue-3')
    ).resolves.toMatchObject({ status: 'QUEUED' });
  });

  it('stores bounded runtime artifacts as verified immutable file revisions', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('session-1', discourseOwner, 'session-operation')
    );
    const run = await fixture.store.createRun(
      runInput('run-1', session, discourseScope, 'run-operation')
    );
    const prompt = await fixture.store.createArtifact({
      id: run.promptArtifactId,
      owner: run.owner,
      runId: run.id,
      kind: 'PROMPT',
      clientOperationId: 'create-prompt',
      content: 'Prompt revision one'
    });
    expect(await fixture.store.readArtifact(prompt.id)).toBe('Prompt revision one');
    expect(
      await fixture.store.createArtifact({
        id: run.promptArtifactId,
        owner: run.owner,
        runId: run.id,
        kind: 'PROMPT',
        clientOperationId: 'create-prompt',
        content: 'Prompt revision one'
      })
    ).toEqual(prompt);
    await expect(
      fixture.store.createArtifact({
        id: run.promptArtifactId,
        owner: run.owner,
        runId: run.id,
        kind: 'PROMPT',
        clientOperationId: 'create-prompt',
        content: 'Changed retry'
      })
    ).rejects.toThrow('conflicts');

    const updated = await fixture.store.updateArtifact({
      artifactId: prompt.id,
      expectedRevision: prompt.recordRevision,
      clientOperationId: 'update-prompt',
      content: 'Prompt revision two'
    });
    expect(updated).toMatchObject({ recordRevision: 2, byteCount: 19 });
    expect(await fixture.store.readArtifact(prompt.id)).toBe('Prompt revision two');
    await expect(
      fs.stat(path.join(fixture.root, 'artifacts', `${prompt.id}-r1.txt`))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const restarted = new FileAgentRuntimeStore(fixture.root);
    expect(await restarted.readArtifact(prompt.id)).toBe('Prompt revision two');
    await fs.writeFile(
      path.join(fixture.root, 'artifacts', updated.storageKey),
      'tampered',
      { mode: 0o600 }
    );
    await expect(new FileAgentRuntimeStore(fixture.root).snapshot()).rejects.toThrow(
      'artifact file failed its integrity check'
    );
  });

  it('purges only settled discourse runtime records and their artifact files', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('session-1', discourseOwner, 'session-operation')
    );
    const run = await fixture.store.createRun(
      runInput('run-1', session, discourseScope, 'run-operation')
    );
    const prompt = await fixture.store.createArtifact({
      id: run.promptArtifactId,
      owner: run.owner,
      runId: run.id,
      kind: 'PROMPT',
      clientOperationId: 'create-prompt',
      content: 'Scoped prompt'
    });
    await fixture.store.enqueueRun(run.id, 'DISCOURSE_RESPONSE', 'enqueue-run');
    await expect(
      fixture.store.purgeDiscourseConversation('conversation-1')
    ).rejects.toThrow('still needs settlement');

    const currentRun = (await fixture.store.getRun(run.id))!;
    await fixture.store.updateRun(
      run.id,
      currentRun.recordRevision,
      {
        status: 'INTERRUPTED',
        delivery: 'NOT_DELIVERED',
        endedAt: '2026-07-13T00:00:20.000Z'
      },
      'cancel-run'
    );
    const queue = (await fixture.store.snapshot()).queueEntries[0]!;
    await fixture.store.cancelQueueEntry(
      queue.id,
      queue.recordRevision,
      'Conversation deleted.',
      'cancel-queue'
    );
    await expect(
      fixture.store.purgeDiscourseConversation('conversation-1')
    ).resolves.toEqual({
      sessionCount: 1,
      runCount: 1,
      artifactCount: 1,
      queueEntryCount: 1
    });
    expect(await fixture.store.snapshot()).toMatchObject({
      sessions: [],
      runs: [],
      queueEntries: [],
      artifacts: []
    });
    await expect(
      fs.stat(path.join(fixture.root, 'artifacts', prompt.storageKey))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fixture.store.purgeDiscourseConversation('conversation-1')
    ).resolves.toEqual({
      sessionCount: 0,
      runCount: 0,
      artifactCount: 0,
      queueEntryCount: 0
    });
  });

  it('purges settled task runtime sessions even when no run survived the task-store saga', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('orphan-task-session', taskOwner, 'orphan-task-session-operation')
    );
    await fixture.store.recordTelemetry({
      id: 'orphan-task-telemetry',
      kind: 'SETTINGS',
      owner: taskOwner,
      sessionId: session.id,
      clientOperationId: 'orphan-task-telemetry-operation',
      payload: { source: 'legacy' },
      observedAt: '2026-07-13T00:00:10.000Z'
    });

    await expect(fixture.store.purgeTask('task-1')).resolves.toEqual({
      sessionCount: 1,
      runCount: 0,
      artifactCount: 0,
      queueEntryCount: 0
    });
    expect(await fixture.store.snapshot()).toMatchObject({
      sessions: [],
      telemetryRecords: []
    });
  });

  it('repairs pre-publish crashes and forces restart after a post-rename failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-runtime-crash-'));
    let fileSyncs = 0;
    const beforePublish = new FileAgentRuntimeStore(path.join(root, 'before'), {
      afterFileSync: async () => {
        fileSyncs += 1;
        if (fileSyncs === 2) throw new Error('crash before publish');
      }
    });
    await beforePublish.snapshot();
    await expect(
      beforePublish.createSession(sessionInput('session-1', taskOwner, 'session-operation'))
    ).rejects.toThrow('crash before publish');
    expect((await new FileAgentRuntimeStore(path.join(root, 'before')).snapshot()).sessions).toEqual([]);

    let renames = 0;
    const afterPublish = new FileAgentRuntimeStore(path.join(root, 'after'), {
      afterRename: async () => {
        renames += 1;
        if (renames === 2) throw new Error('crash after publish');
      }
    });
    await afterPublish.snapshot();
    await expect(
      afterPublish.createSession(sessionInput('session-2', taskOwner, 'session-operation-2'))
    ).rejects.toBeInstanceOf(AgentRuntimeStorePublishedError);
    await expect(afterPublish.snapshot()).resolves.toMatchObject({ sessions: [] });
    await expect(
      afterPublish.createSession(sessionInput('session-3', taskOwner, 'session-operation-3'))
    ).rejects.toThrow('restart before continuing');
    expect((await new FileAgentRuntimeStore(path.join(root, 'after')).snapshot()).sessions).toHaveLength(1);
  });

  it.each([1, 2, 3])('rejects older agent runtime schema %s without rewriting it', async (schemaVersion) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-runtime-old-'));
    const storePath = path.join(root, 'runtime.json');
    const encoded = `${JSON.stringify({ schemaVersion })}\n`;
    await fs.writeFile(storePath, encoded, { mode: 0o600 });

    await expect(new FileAgentRuntimeStore(root).snapshot()).rejects.toThrow(
      `Unsupported or invalid Agent runtime schema ${schemaVersion}`
    );
    await expect(fs.readFile(storePath, 'utf8')).resolves.toBe(encoded);
  });

  it('fails closed for newer schemas, corrupt ownership, and symlinked roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-runtime-invalid-'));
    const newer = path.join(root, 'newer');
    await fs.mkdir(newer, { mode: 0o700 });
    await fs.writeFile(
      path.join(newer, 'runtime.json'),
      `${JSON.stringify({ schemaVersion: AGENT_RUNTIME_STORE_SCHEMA_VERSION + 1 })}\n`,
      { mode: 0o600 }
    );
    await expect(new FileAgentRuntimeStore(newer).snapshot()).rejects.toThrow(
      'newer than this app supports'
    );

    const valid = await storeFixture(path.join(root, 'valid'));
    const session = await valid.store.createSession(
      sessionInput('session-1', taskOwner, 'session-operation')
    );
    await valid.store.createRun(runInput('run-1', session, taskScope, 'run-operation'));
    const state = await valid.store.snapshot();
    state.runs[0]!.owner = discourseOwner;
    await fs.writeFile(
      path.join(valid.root, 'runtime.json'),
      `${JSON.stringify(state)}\n`,
      { mode: 0o600 }
    );
    await expect(new FileAgentRuntimeStore(valid.root).snapshot()).rejects.toThrow(
      'does not belong'
    );

    const target = path.join(root, 'target');
    const linked = path.join(root, 'linked');
    await fs.mkdir(target);
    await fs.symlink(target, linked);
    await expect(new FileAgentRuntimeStore(linked).snapshot()).rejects.toThrow(
      'root failed its integrity check'
    );
  });
});

const taskOwner: AgentOwnerScope = { kind: 'TASK', taskId: 'task-1' };
const discourseOwner: AgentOwnerScope = {
  kind: 'DISCOURSE',
  conversationId: 'conversation-1',
  stableParticipantId: 'participant-1'
};
const taskScope: AgentRunScope = {
  kind: 'TASK',
  taskId: 'task-1',
  iterationId: 'iteration-1',
  worktreeId: 'worktree-1'
};
const discourseScope: AgentRunScope = {
  kind: 'DISCOURSE',
  conversationId: 'conversation-1',
  waveId: 'wave-1',
  jobId: 'job-1',
  contextSnapshotId: 'context-1',
  attemptId: 'attempt-1'
};

function discourseScopeFor(jobId: string, attemptId: string): AgentRunScope {
  return {
    kind: 'DISCOURSE',
    conversationId: 'conversation-1',
    waveId: 'wave-1',
    jobId,
    contextSnapshotId: 'context-1',
    attemptId
  };
}

async function createServerWithJournal(
  store: FileAgentRuntimeStore,
  label: string
) {
  const server = await store.createAgentServer({
    runtimeId: 'codex',
    runtimeKind: 'APP_SERVER',
    transport: 'STDIO',
    executable: `codex-${label}`,
    argv: ['app-server', '--stdio']
  });
  await store.appendProtocolMessage(
    server.id,
    'INBOUND',
    JSON.stringify({ label })
  );
  return server;
}

async function storeFixture(root?: string) {
  const directory =
    root ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-runtime-')));
  const times = Array.from(
    { length: 100 },
    (_, index) => new Date(Date.UTC(2026, 6, 13, 0, 0, index)).toISOString()
  );
  let timeIndex = 0;
  let id = 0;
  const store = new FileAgentRuntimeStore(directory, {
    now: () => times[timeIndex++]!,
    createId: () =>
      `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
  });
  await store.snapshot();
  return { root: directory, store };
}

function sessionInput(
  id: string,
  owner: AgentOwnerScope,
  clientOperationId: string
): CreateRuntimeSessionInput {
  const context = executionContext(clientOperationId);
  return {
    id,
    owner,
    accessEpoch: createAgentSessionAccessEpoch({
      owner,
      sessionId: id,
      epoch: 1,
      runtimeId: 'codex',
      model: 'gpt-test',
      executionContext: context,
      createdAt: '2026-07-13T00:00:00.000Z'
    }),
    executionContext: context,
    clientOperationId,
    runtimeId: 'codex',
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    status: 'NOT_MATERIALIZED',
    materialized: false,
    requestedSettings: {
      model: 'gpt-test',
      sandbox: 'READ_ONLY',
      approvalPolicy: 'NEVER',
      networkAccess: false
    },
    ...(owner.kind === 'TASK'
      ? {
          taskContext: {
            iterationId: 'iteration-1',
            worktreeId: 'worktree-1',
            worktreePath: context.primaryCwd
          }
        }
      : {})
  };
}

function runInput(
  id: string,
  session: Awaited<ReturnType<FileAgentRuntimeStore['createSession']>>,
  scope: AgentRunScope,
  clientOperationId: string
): CreateRuntimeRunInput {
  return {
    id,
    owner: session.owner,
    scope,
    sessionId: session.id,
    sessionAccessEpoch: session.accessEpoch.epoch,
    purpose: scope.kind === 'TASK' ? 'TASK_IMPLEMENTATION' : 'DISCOURSE_ANSWER',
    generationKey: `${scope.kind.toLowerCase()}-generation`,
    clientOperationId,
    requestedSettings: session.requestedSettings,
    promptArtifactId: `${id}-prompt`,
    outputArtifactId: `${id}-output`,
    diagnosticArtifactId: `${id}-diagnostics`
  };
}

function genericRunInput(
  id: string,
  session: CreateRuntimeSessionInput,
  scope: AgentRunScope,
  clientOperationId: string
): CreateRuntimeRunInput {
  return {
    id,
    owner: session.owner,
    scope,
    sessionId: session.id,
    sessionAccessEpoch: session.accessEpoch.epoch,
    purpose: scope.kind === 'TASK' ? 'TASK_IMPLEMENTATION' : 'DISCOURSE_ANSWER',
    generationKey: `${scope.kind.toLowerCase()}-generation`,
    clientOperationId,
    requestedSettings: session.requestedSettings,
    promptArtifactId: `${id}-prompt`,
    outputArtifactId: `${id}-output`,
    diagnosticArtifactId: `${id}-diagnostics`
  };
}

function executionContext(clientOperationId: string): AgentExecutionContext {
  const primaryCwd = path.join(path.parse(process.cwd()).root, 'tmp', 'runtime-primary');
  return {
    attestation: { status: 'ATTESTED' },
    primaryCwd,
    readRoots: [{ canonicalPath: primaryCwd, kind: 'EMPTY_MANAGED' }],
    managedAttachments: [],
    permissionProfileHash: 'a'.repeat(64),
    modelSettings: {
      model: 'gpt-test',
      sandbox: 'READ_ONLY',
      approvalPolicy: 'NEVER',
      networkAccess: false
    },
    externalTools: {
      network: false,
      webSearch: 'disabled',
      mcpServers: false,
      apps: false,
      dynamicTools: false
    },
    clientOperationId
  };
}
