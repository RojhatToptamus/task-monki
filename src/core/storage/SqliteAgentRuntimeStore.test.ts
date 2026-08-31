import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_LIMITS,
  type AgentExecutionContext,
  type AgentOwnerScope,
  type AgentRunScope
} from '../../shared/agentRuntime';
import { createAgentSessionAccessEpoch } from '../agent/AgentRuntimeOwnership';
import { createDomainEvent } from './domainEvent';
import type {
  CreateRuntimeRunInput,
  CreateRuntimeSessionInput
} from '../agent/AgentRuntimeStore';
import { SqliteAgentRuntimeStore } from './SqliteAgentRuntimeStore';
import { AppDatabase } from './sqlite/AppDatabase';
import { ManagedFileStore } from './sqlite/ManagedFileStore';

const fixtureCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(fixtureCleanups.splice(0).map((cleanup) => cleanup()));
});

describe('SqliteAgentRuntimeStore', () => {
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

    const restarted = fixture.openStore();
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
    const restarted = fixture.openStore();
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

    const reloaded = fixture.openStore();
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

    const restarted = fixture.openStore();
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
    const fixture = await storeFixture(root);
    const initial = fixture.store;
    await initial.snapshot();
    await initial.close();
    const journalDirectory = path.join(root, 'protocol-journals');
    const orphanPath = path.join(journalDirectory, 'orphan-server.2.ndjson');
    const unrelatedPath = path.join(journalDirectory, 'operator-notes.txt');
    await fs.writeFile(orphanPath, '{"orphan":true}\n', { mode: 0o600 });
    await fs.writeFile(unrelatedPath, 'preserve\n', { mode: 0o600 });

    const restarted = fixture.openStore();
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
    expect(
      (await fixture.store.snapshot()).events.filter(
        (event) => event.type === 'TELEMETRY_RECORDED'
      )
    ).toHaveLength(1);
    await expect(
      fixture.store.recordTelemetry({
        ...request,
        payload: { type: 'AGENT_MESSAGE', status: 'FAILED' }
      })
    ).rejects.toThrow('conflicts');
    await expect(
      fixture.store.recordTelemetry({
        ...request,
        clientOperationId: 'telemetry-duplicate-id-operation'
      })
    ).rejects.toThrow('already exists');
    await expect(
      fixture.store.recordTelemetry({
        ...request,
        id: 'telemetry-wrong-owner',
        owner: discourseOwner,
        clientOperationId: 'telemetry-wrong-owner-operation'
      })
    ).rejects.toThrow('invalid session owner');
    await expect(
      fixture.store.recordTelemetry({
        ...request,
        id: 'telemetry-item-2',
        clientOperationId: 'telemetry-oversized-operation',
        payload: { text: 'x'.repeat(300 * 1024) }
      })
    ).rejects.toThrow('safety limit');

    expect(await runtimeReceiptCount(fixture.database, 'task:task-1')).toBeGreaterThan(0);
    await fixture.store.close();
    await fixture.database.write((transaction) => {
      transaction.run(
        `DELETE FROM runtime_events WHERE operation_id = ?`,
        [request.clientOperationId]
      );
    });
    const reloaded = fixture.openStore();
    expect(await reloaded.listTelemetryByOwner(taskOwner)).toEqual([stored]);
    expect(await reloaded.recordTelemetry(request)).toEqual(stored);
    await expect(
      reloaded.recordTelemetry({
        ...request,
        payload: { type: 'AGENT_MESSAGE', status: 'FAILED' }
      })
    ).rejects.toThrow('conflicts');
  });

  it('rolls back both telemetry rows and their event when the row-native transaction fails', async () => {
    const fixture = await storeFixture();
    const before = await fixture.store.snapshot();
    await fixture.database.write((transaction) => {
      transaction.run(
        `CREATE TRIGGER reject_telemetry_event
         BEFORE INSERT ON runtime_events
         WHEN NEW.type = 'TELEMETRY_RECORDED'
         BEGIN
           SELECT RAISE(ABORT, 'reject telemetry event');
         END`
      );
    });
    const request = {
      id: 'telemetry-rollback',
      kind: 'SERVER' as const,
      clientOperationId: 'telemetry-rollback-operation',
      payload: { status: 'READY' },
      observedAt: '2026-07-13T00:05:00.000Z'
    };

    await expect(fixture.store.recordTelemetry(request)).rejects.toThrow(
      'reject telemetry event'
    );
    expect(await fixture.store.snapshot()).toMatchObject({
      revision: before.revision,
      nextEventOrdinal: before.nextEventOrdinal,
      telemetryRecords: before.telemetryRecords,
      events: before.events
    });
    expect(
      await fixture.database.read((reader) =>
        reader.get('SELECT id FROM runtime_telemetry WHERE id = ?', [request.id])
      )
    ).toBeUndefined();
    expect(await runtimeReceiptCount(fixture.database, 'app:telemetry')).toBe(0);

    await fixture.database.write((transaction) => {
      transaction.run('DROP TRIGGER reject_telemetry_event');
    });
    const stored = await fixture.store.recordTelemetry(request);
    expect(await runtimeReceiptCount(fixture.database, 'app:telemetry')).toBe(1);
    const restarted = fixture.openStore();
    expect((await restarted.snapshot()).telemetryRecords).toEqual([stored]);
  });

  it('uses the aggregate fallback so telemetry participates in an outer rollback', async () => {
    const fixture = await storeFixture();
    const request = {
      id: 'telemetry-outer-rollback',
      kind: 'SERVER' as const,
      clientOperationId: 'telemetry-outer-rollback-operation',
      payload: { status: 'READY' },
      observedAt: '2026-07-13T00:05:00.000Z'
    };

    await expect(
      fixture.database.write(async () => {
        await fixture.store.recordTelemetry(request);
        expect((await fixture.store.snapshot()).telemetryRecords).toHaveLength(1);
        throw new Error('rollback outer transaction');
      })
    ).rejects.toThrow('rollback outer transaction');
    expect((await fixture.store.snapshot()).telemetryRecords).toEqual([]);
    expect(await runtimeReceiptCount(fixture.database, 'app:telemetry')).toBe(0);
    await expect(fixture.store.recordTelemetry(request)).resolves.toMatchObject({
      id: request.id
    });
  });

  it(
    'appends ten thousand telemetry observations without aggregate-history work',
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-agent-runtime-telemetry-scale-')
      );
      const database = await AppDatabase.open(':memory:');
      const managedFiles = new ManagedFileStore(path.join(root, 'managed-files'));
      let eventId = 0;
      const store = new SqliteAgentRuntimeStore(
        database,
        managedFiles,
        path.join(root, 'protocol-journals'),
        {
          now: () => '2026-07-13T00:05:00.000Z',
          createId: () => `telemetry-event-${++eventId}`
        }
      );
      await store.snapshot();

      for (let index = 0; index < 10_000; index += 1) {
        await store.recordTelemetry({
          id: `telemetry-${index}`,
          kind: 'SERVER',
          clientOperationId: `telemetry-operation-${index}`,
          payload: { sequence: index },
          observedAt: '2026-07-13T00:05:00.000Z'
        });
      }

      const snapshot = await store.snapshot();
      expect(snapshot.telemetryRecords).toHaveLength(10_000);
      expect(snapshot.events).toHaveLength(10_000);
      expect(snapshot.nextEventOrdinal).toBe(10_001);
      await store.close();
      await database.close();
      await fs.rm(root, { recursive: true });
    },
    60_000
  );

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

    const reloaded = fixture.openStore();
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

  it('stores the exact attachment selection and rejects changed retries or evidence', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('attachment-session', taskOwner, 'attachment-session-operation')
    );
    const selection = [{
      attachmentId: 'attachment-1',
      ordinal: 0,
      kind: 'text' as const,
      mediaType: 'text/plain',
      byteCount: 12,
      sha256: 'a'.repeat(64)
    }];
    const request = {
      ...runInput('attachment-run', session, taskScope, 'attachment-run-operation'),
      attachmentSelection: selection
    };
    const run = await fixture.store.createRun(request);
    expect(run.attachmentSelection).toEqual(selection);
    await expect(
      fixture.store.createRun({
        ...request,
        attachmentSelection: [{ ...selection[0]!, sha256: 'b'.repeat(64) }]
      })
    ).rejects.toThrow('conflicts');
    await expect(
      fixture.store.updateRun(
        run.id,
        run.recordRevision,
        {
          status: 'STARTING',
          delivery: 'SENDING',
          attachmentSubmissions: [{
            ...selection[0]!,
            sha256: 'b'.repeat(64),
            transport: 'text-block',
            verifiedAt: '2026-07-13T00:00:10.000Z',
            correlation: { kind: 'client-request', id: 'request-1' },
            submittedAt: '2026-07-13T00:00:11.000Z'
          }]
        },
        'attachment-run-invalid-evidence'
      )
    ).rejects.toThrow('submission evidence is invalid');
    expect((await fixture.store.getRun(run.id))?.delivery).toBe('NOT_SENT');
  });

  it('binds first-turn access to a queued selected run but keeps it immutable after materialization', async () => {
    const fixture = await storeFixture();
    const runtime = fixture.store.taskAgentRuntimeAccess(async () => undefined);
    const session = await fixture.store.createSession(
      sessionInput('attachment-access-session', taskOwner, 'attachment-access-session')
    );
    const run = await fixture.store.createRun({
      ...runInput('attachment-access-run', session, taskScope, 'attachment-access-run'),
      attachmentSelection: [{
        attachmentId: 'attachment-1',
        ordinal: 0,
        kind: 'text',
        mediaType: 'text/plain',
        byteCount: 12,
        sha256: 'b'.repeat(64)
      }]
    });
    expect(run).toMatchObject({ status: 'QUEUED', delivery: 'NOT_SENT' });
    const executionContext: AgentExecutionContext = {
      ...session.executionContext,
      managedAttachments: [{
        attachmentId: 'attachment-1',
        contentSha256: 'b'.repeat(64),
        byteCount: 12
      }],
      permissionProfileHash: 'c'.repeat(64)
    };
    const accessEpoch = createAgentSessionAccessEpoch({
      owner: session.owner,
      sessionId: session.id,
      epoch: session.accessEpoch.epoch,
      runtimeId: session.runtimeId,
      model: session.accessEpoch.model,
      executionContext,
      createdAt: session.accessEpoch.createdAt
    });

    await expect(
      runtime.updateAgentSessionAccess(
        session.id,
        { executionContext, accessEpoch },
        'attachment-access-before-provider-prompt'
      )
    ).resolves.toBeDefined();

    const updated = (await fixture.store.getSession(session.id))!;
    const owned = await fixture.store.updateSession(
      updated.id,
      updated.recordRevision,
      { providerSessionId: 'thread-1', status: 'IDLE', materialized: false },
      'attachment-access-provider-session'
    );
    await fixture.store.updateSession(
      owned.id,
      owned.recordRevision,
      { materialized: true },
      'attachment-access-materialized'
    );
    await expect(
      runtime.updateAgentSessionAccess(
        session.id,
        {
          executionContext: {
            ...executionContext,
            managedAttachments: []
          },
          accessEpoch: createAgentSessionAccessEpoch({
            owner: session.owner,
            sessionId: session.id,
            epoch: session.accessEpoch.epoch,
            runtimeId: session.runtimeId,
            model: session.accessEpoch.model,
            executionContext: {
              ...executionContext,
              managedAttachments: []
            },
            createdAt: session.accessEpoch.createdAt
          })
        },
        'attachment-access-after-provider-prompt'
      )
    ).rejects.toThrow('immutable after provider delivery');
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
    expect((await fixture.openStore().getRun(observed.id))).toEqual(
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

  it(
    'compacts full diagnostic history while durable receipts preserve active-work replay',
    async () => {
      const fixture = await storeFixture();
      const session = await fixture.store.createSession(
        sessionInput('retention-session', discourseOwner, 'retention-session-create')
      );
      const run = await fixture.store.createRun(
        runInput('retention-run', session, discourseScope, 'retention-run-create')
      );
      const queued = await fixture.store.enqueueRun(
        run.id,
        'DISCOURSE_RESPONSE',
        'retention-enqueue'
      );
      const leased = await fixture.store.leaseQueueEntry(
        queued.id,
        queued.recordRevision,
        'retention-lease'
      );

      await replaceRuntimeEventHistory(
        fixture.database,
        AGENT_RUNTIME_LIMITS.maxEvents
      );
      await fixture.store.close();

      let restarted = fixture.openStore();
      const atCapacity = await restarted.snapshot();
      expect(atCapacity.events).toHaveLength(AGENT_RUNTIME_LIMITS.maxEvents);
      const firstRetainedOrdinal = atCapacity.events[0]!.ordinal;
      expect(
        atCapacity.events.some((event) => event.operationId === 'retention-lease')
      ).toBe(false);
      await restarted.setShutdownLatched(true, 'retention-shutdown');
      const afterShutdown = await restarted.snapshot();
      expect(afterShutdown.events).toHaveLength(AGENT_RUNTIME_LIMITS.maxEvents);
      expect(afterShutdown.events[0]!.ordinal).toBeGreaterThan(firstRetainedOrdinal);
      expect(afterShutdown.events.at(-1)).toMatchObject({
        operationId: 'retention-shutdown',
        type: 'SHUTDOWN_LATCHED'
      });
      await expect(
        restarted.leaseQueueEntry(
          queued.id,
          queued.recordRevision,
          'retention-lease'
        )
      ).resolves.toEqual(leased);
      await expect(
        restarted.cancelQueueEntry(
          queued.id,
          queued.recordRevision,
          'Conflicting retry.',
          'retention-lease'
        )
      ).rejects.toThrow('conflicts');

      const activeRun = (await restarted.getRun(run.id))!;
      await restarted.updateRun(
        activeRun.id,
        activeRun.recordRevision,
        {
          status: 'INTERRUPTED',
          delivery: 'NOT_DELIVERED',
          endedAt: '2026-07-13T00:10:00.000Z'
        },
        'retention-settle-run'
      );
      const settled = await restarted.settleQueueEntry(
        leased.id,
        leased.recordRevision,
        'retention-settle-queue'
      );
      expect((await restarted.snapshot()).events).toHaveLength(
        AGENT_RUNTIME_LIMITS.maxEvents
      );
      await restarted.close();

      restarted = fixture.openStore();
      await expect(
        restarted.settleQueueEntry(
          leased.id,
          leased.recordRevision,
          'retention-settle-queue'
        )
      ).resolves.toEqual(settled);
      await restarted.setShutdownLatched(false, 'retention-reopen');
      const nextRun = await restarted.createRun(
        runInput(
          'retention-run-next',
          session,
          discourseScopeFor('retention-job-next', 'retention-attempt-next'),
          'retention-run-next-create'
        )
      );
      await expect(
        restarted.enqueueRun(
          nextRun.id,
          'DISCOURSE_RESPONSE',
          'retention-enqueue-next'
        )
      ).resolves.toMatchObject({ status: 'QUEUED' });
      expect((await restarted.snapshot()).events).toHaveLength(
        AGENT_RUNTIME_LIMITS.maxEvents
      );
    },
    60_000
  );

  it('bounds application-wide receipts and retains the current shutdown replay', async () => {
    const fixture = await storeFixture();
    const operationCount = AGENT_RUNTIME_LIMITS.maxGlobalOperationReceipts + 1;
    await fixture.database.write(async () => {
      for (let index = 0; index < operationCount; index += 1) {
        await fixture.store.setShutdownLatched(index % 2 === 0, `shutdown-cycle-${index}`);
      }
      for (let index = 0; index < operationCount; index += 1) {
        await fixture.store.recordTelemetry({
          id: `global-telemetry-${index}`,
          kind: 'SERVER',
          clientOperationId: `global-telemetry-operation-${index}`,
          payload: { index },
          observedAt: '2026-07-13T00:05:00.000Z'
        });
      }
    });

    expect(
      await runtimeReceiptCount(fixture.database, 'app:shutdown')
    ).toBe(AGENT_RUNTIME_LIMITS.maxGlobalOperationReceipts);
    expect(
      await runtimeReceiptCount(fixture.database, 'app:telemetry')
    ).toBe(AGENT_RUNTIME_LIMITS.maxGlobalOperationReceipts);
    await fixture.store.close();
    const restarted = fixture.openStore();
    await expect(
      restarted.setShutdownLatched(true, `shutdown-cycle-${operationCount - 1}`)
    ).resolves.toBeUndefined();
    await expect(
      restarted.setShutdownLatched(false, `shutdown-cycle-${operationCount - 1}`)
    ).rejects.toThrow('conflicts');
    expect((await restarted.snapshot()).shutdownLatched).toBe(true);
    await restarted.setShutdownLatched(true, 'shutdown-already-latched');
    await restarted.setShutdownLatched(false, 'shutdown-reopen-after-noop');
    await expect(
      restarted.setShutdownLatched(true, 'shutdown-already-latched')
    ).resolves.toBeUndefined();
    expect((await restarted.snapshot()).shutdownLatched).toBe(false);
  });

  it('keeps shutdown state and receipts inside an outer transaction rollback', async () => {
    const fixture = await storeFixture();
    await expect(
      fixture.database.write(async () => {
        await fixture.store.setShutdownLatched(true, 'shutdown-outer-rollback');
        expect((await fixture.store.snapshot()).shutdownLatched).toBe(true);
        expect(
          await runtimeReceiptCount(fixture.database, 'app:shutdown')
        ).toBe(1);
        throw new Error('rollback shutdown');
      })
    ).rejects.toThrow('rollback shutdown');

    expect((await fixture.store.snapshot()).shutdownLatched).toBe(false);
    expect(await runtimeReceiptCount(fixture.database, 'app:shutdown')).toBe(0);
    await expect(
      fixture.store.setShutdownLatched(true, 'shutdown-outer-rollback')
    ).resolves.toBeUndefined();
    expect((await fixture.store.snapshot()).shutdownLatched).toBe(true);
  });

  it('rejects a corrupt runtime operation receipt during startup', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('receipt-session', taskOwner, 'receipt-session-create')
    );
    await fixture.store.updateSession(
      session.id,
      session.recordRevision,
      { status: 'IDLE' },
      'receipt-session-update'
    );
    await fixture.database.write((transaction) => {
      transaction.run(
        `UPDATE operation_receipts SET request_fingerprint = 'invalid'
         WHERE domain = 'AGENT_RUNTIME' AND owner_id = 'task:task-1'`
      );
    });

    await expect(fixture.openStore().snapshot()).rejects.toThrow(
      'operation receipt fingerprint is invalid'
    );
  });

  it('keeps Task event replay and conflict detection after diagnostic compaction', async () => {
    const fixture = await storeFixture();
    const session = await fixture.store.createSession(
      sessionInput('task-event-session', taskOwner, 'task-event-session-create')
    );
    const run = await fixture.store.createRun(
      runInput('task-event-run', session, taskScope, 'task-event-run-create')
    );
    await fixture.store.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt: '2026-07-13T00:00:10.000Z'
      },
      'task-event-send'
    );
    const event = createDomainEvent({
      type: 'PROCESS_STARTED',
      taskId: 'task-1',
      iterationId: 'iteration-1',
      runId: run.id,
      source: 'process',
      payload: { pid: 42 }
    });
    await fixture.store
      .taskAgentRuntimeAccess()
      .applyTaskRuntimeEvent(event, 'task-event-apply');
    await fixture.store
      .taskAgentRuntimeAccess()
      .applyTaskRuntimeEvent(event, 'task-event-redundant');
    expect(
      await fixture.database.read((reader) =>
        reader.get(
          `SELECT client_operation_id FROM operation_receipts
           WHERE domain = 'AGENT_RUNTIME' AND owner_id = 'task:task-1'
             AND client_operation_id = 'task-event-redundant'`
        )
      )
    ).toBeDefined();
    expect(
      await fixture.database.read((reader) =>
        reader.get(
          `SELECT id FROM runtime_events WHERE operation_id = 'task-event-redundant'`
        )
      )
    ).toBeUndefined();
    await expect(
      fixture.store.taskAgentRuntimeAccess().applyTaskRuntimeEvent(
        { ...event, payload: { pid: 43 } },
        'task-event-redundant'
      )
    ).rejects.toThrow('conflicts');
    await fixture.store.close();
    await fixture.database.write((transaction) => {
      transaction.run('DELETE FROM runtime_events WHERE operation_id = ?', [
        'task-event-apply'
      ]);
    });

    const restarted = fixture.openStore().taskAgentRuntimeAccess();
    await expect(
      restarted.applyTaskRuntimeEvent(event, 'task-event-apply')
    ).resolves.toBeUndefined();
    await expect(
      restarted.applyTaskRuntimeEvent(
        { ...event, payload: { pid: 43 } },
        'task-event-apply'
      )
    ).rejects.toThrow('conflicts');
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
      fs.stat(path.join(fixture.managedFiles.rootPath, prompt.storageKey))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const restarted = fixture.openStore();
    expect(await restarted.readArtifact(prompt.id)).toBe('Prompt revision two');
    const updatedPath = path.join(fixture.managedFiles.rootPath, updated.storageKey);
    await fs.chmod(updatedPath, 0o600);
    await fs.writeFile(updatedPath, 'tampered');
    await fs.chmod(updatedPath, 0o400);
    await expect(fixture.openStore().snapshot()).rejects.toThrow(/managed file|integrity/i);
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
    expect(
      await runtimeReceiptCount(
        fixture.database,
        'discourse:conversation-1:participant-1'
      )
    ).toBeGreaterThan(0);
    await expect(
      fixture.store.purgeDiscourseConversation('conversation-1')
    ).resolves.toEqual({
      sessionCount: 1,
      runCount: 1,
      artifactCount: 1,
      queueEntryCount: 1
    });
    expect(
      await runtimeReceiptCount(
        fixture.database,
        'discourse:conversation-1:participant-1'
      )
    ).toBe(0);
    expect(await fixture.store.snapshot()).toMatchObject({
      sessions: [],
      runs: [],
      queueEntries: [],
      artifacts: []
    });
    await expect(
      fs.stat(path.join(fixture.managedFiles.rootPath, prompt.storageKey))
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
    await fixture.store.updateSession(
      session.id,
      session.recordRevision,
      { status: 'IDLE' },
      'orphan-task-session-update'
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
    expect(await runtimeReceiptCount(fixture.database, 'task:task-1')).toBeGreaterThan(0);

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
    expect(await runtimeReceiptCount(fixture.database, 'task:task-1')).toBe(0);
  });

  it('purges settled prompt-refinement sessions and artifacts', async () => {
    const fixture = await storeFixture();
    const owner: AgentOwnerScope = {
      kind: 'PROMPT_REFINEMENT',
      requestId: 'refinement-1'
    };
    const scope: AgentRunScope = {
      kind: 'PROMPT_REFINEMENT',
      requestId: 'refinement-1'
    };
    const session = await fixture.store.createSession(
      sessionInput('refinement-session', owner, 'create-refinement-session')
    );
    const run = await fixture.store.createRun({
      ...runInput('refinement-run', session, scope, 'create-refinement-run'),
      purpose: 'PROMPT_REFINEMENT'
    });
    const artifact = await fixture.store.createArtifact({
      id: run.outputArtifactId,
      owner,
      runId: run.id,
      kind: 'OUTPUT',
      clientOperationId: 'create-refinement-output',
      content: 'Refined prompt'
    });
    const queued = await fixture.store.enqueueRun(
      run.id,
      'TASK_FOREGROUND',
      'enqueue-refinement'
    );
    await fixture.store.leaseQueueEntry(
      queued.id,
      queued.recordRevision,
      'lease-refinement'
    );
    let current = (await fixture.store.getRun(run.id))!;
    current = await fixture.store.updateRun(
      current.id,
      current.recordRevision,
      {
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt: '2026-07-13T00:00:10.000Z'
      },
      'start-refinement'
    );
    await fixture.store.updateRun(
      current.id,
      current.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        providerTurnId: 'refinement-turn',
        endedAt: '2026-07-13T00:00:20.000Z'
      },
      'complete-refinement'
    );
    const leased = (await fixture.store.snapshot()).queueEntries[0]!;
    await fixture.store.settleQueueEntry(
      leased.id,
      leased.recordRevision,
      'settle-refinement'
    );
    expect(
      await runtimeReceiptCount(
        fixture.database,
        'prompt-refinement:refinement-1'
      )
    ).toBeGreaterThan(0);

    await expect(
      fixture.store.purgePromptRefinement('refinement-1')
    ).resolves.toEqual({
      sessionCount: 1,
      runCount: 1,
      artifactCount: 1,
      queueEntryCount: 1
    });
    expect(
      await runtimeReceiptCount(
        fixture.database,
        'prompt-refinement:refinement-1'
      )
    ).toBe(0);
    await expect(
      fs.stat(path.join(fixture.managedFiles.rootPath, artifact.storageKey))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists and purges only the exact settled Preview recipe generation', async () => {
    const fixture = await storeFixture();
    const createGeneration = async (generationId: string) => {
      const owner: AgentOwnerScope = {
        kind: 'PREVIEW_RECIPE_GENERATION',
        taskId: 'task-1',
        generationId
      };
      const scope: AgentRunScope = { ...owner };
      const session = await fixture.store.createSession(
        sessionInput(`${generationId}-session`, owner, 'create-preview-session')
      );
      const run = await fixture.store.createRun({
        ...runInput(`${generationId}-run`, session, scope, 'create-preview-run'),
        purpose: 'PREVIEW_RECIPE_GENERATION'
      });
      const artifact = await fixture.store.createArtifact({
        id: run.outputArtifactId,
        owner,
        runId: run.id,
        kind: 'OUTPUT',
        clientOperationId: 'create-preview-output',
        content: `Preview recipe ${generationId}`
      });
      await fixture.store.updateRun(
        run.id,
        run.recordRevision,
        {
          status: 'FAILED',
          delivery: 'NOT_DELIVERED',
          terminalReason: 'Synthetic terminal generation.',
          endedAt: '2026-07-13T00:00:20.000Z'
        },
        'finish-preview-generation'
      );
      return { artifact, run, session };
    };
    const target = await createGeneration('generation-1');
    const retained = await createGeneration('generation-2');
    const targetOwner = 'preview-recipe-generation:task-1:generation-1';
    const retainedOwner = 'preview-recipe-generation:task-1:generation-2';

    await fixture.store.close();
    const restarted = await fixture.openStore();
    await expect(restarted.getSession(target.session.id)).resolves.toBeDefined();
    await expect(
      restarted.purgePreviewRecipeGeneration('task-1', 'generation-1')
    ).resolves.toEqual({
      sessionCount: 1,
      runCount: 1,
      artifactCount: 1,
      queueEntryCount: 0
    });
    await expect(restarted.getSession(target.session.id)).resolves.toBeUndefined();
    await expect(restarted.getRun(target.run.id)).resolves.toBeUndefined();
    await expect(restarted.getSession(retained.session.id)).resolves.toBeDefined();
    await expect(restarted.getRun(retained.run.id)).resolves.toBeDefined();
    expect(await runtimeReceiptCount(fixture.database, targetOwner)).toBe(0);
    expect(await runtimeReceiptCount(fixture.database, retainedOwner)).toBeGreaterThan(0);
    await expect(
      fs.stat(path.join(fixture.managedFiles.rootPath, target.artifact.storageKey))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(fixture.managedFiles.rootPath, retained.artifact.storageKey))
    ).resolves.toBeDefined();
    await restarted.close();
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
  store: SqliteAgentRuntimeStore,
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

async function replaceRuntimeEventHistory(
  database: AppDatabase,
  eventCount: number
): Promise<void> {
  await database.write((transaction) => {
    const metadata = transaction.get<{ next_event_ordinal: number | bigint }>(
      `SELECT next_event_ordinal FROM store_metadata WHERE domain = 'RUNTIME'`
    );
    const firstOrdinal = Number(metadata?.next_event_ordinal);
    if (!Number.isSafeInteger(firstOrdinal) || firstOrdinal < 1) {
      throw new Error('Runtime metadata is missing from the retention test fixture.');
    }
    transaction.run('DELETE FROM runtime_events');
    transaction.run(
      `WITH RECURSIVE event_numbers(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM event_numbers WHERE value + 1 < ?
       )
       INSERT INTO runtime_events (
         id, event_ordinal, type, run_id, session_id, queue_entry_id,
         artifact_id, operation_id, occurred_at, payload_json
       )
       SELECT
         printf('retained-event-%09d', value),
         ? + value,
         'TELEMETRY_RECORDED',
         NULL,
         NULL,
         NULL,
         NULL,
         printf('retained-operation-%09d', value),
         '2026-07-13T00:05:00.000Z',
         json_object(
           'id', printf('retained-event-%09d', value),
           'ordinal', ? + value,
           'type', 'TELEMETRY_RECORDED',
           'operationId', printf('retained-operation-%09d', value),
           'occurredAt', '2026-07-13T00:05:00.000Z',
           'payload', json_object('diagnostic', 1)
         )
       FROM event_numbers`,
      [eventCount, firstOrdinal, firstOrdinal]
    );
    transaction.run(
      `UPDATE store_metadata
       SET record_revision = record_revision + 1, next_event_ordinal = ?
       WHERE domain = 'RUNTIME'`,
      [firstOrdinal + eventCount]
    );
  });
}

async function runtimeReceiptCount(
  database: AppDatabase,
  ownerId: string
): Promise<number> {
  return database.read((reader) =>
    Number(
      reader.get<{ count: number | bigint }>(
        `SELECT count(*) AS count FROM operation_receipts
         WHERE domain = 'AGENT_RUNTIME' AND owner_id = ?`,
        [ownerId]
      )?.count ?? 0
    )
  );
}

async function storeFixture(root?: string) {
  const directory =
    root ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-runtime-')));
  const times = Array.from(
    { length: 1_000 },
    (_, index) => new Date(Date.UTC(2026, 6, 13, 0, 0, index)).toISOString()
  );
  let timeIndex = 0;
  let id = 0;
  const database = await AppDatabase.open(path.join(directory, 'task-monki.sqlite'));
  const managedFiles = new ManagedFileStore(path.join(directory, 'managed-files'));
  const stores = new Set<SqliteAgentRuntimeStore>();
  const options = {
    now: () => times[timeIndex++]!,
    createId: () =>
      `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
  };
  const openStore = () => {
    const store = new SqliteAgentRuntimeStore(
      database,
      managedFiles,
      path.join(directory, 'protocol-journals'),
      options
    );
    stores.add(store);
    return store;
  };
  fixtureCleanups.push(async () => {
    await Promise.allSettled([...stores].map((candidate) => candidate.close()));
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = openStore();
  await store.snapshot();
  return { root: directory, store, database, managedFiles, openStore };
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
  session: Awaited<ReturnType<SqliteAgentRuntimeStore['createSession']>>,
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
    repositoryAccess: 'READ_ONLY',
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
