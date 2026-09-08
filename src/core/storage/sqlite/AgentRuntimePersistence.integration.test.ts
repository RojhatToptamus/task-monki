import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentExecutionContext,
  AgentOwnerScope,
  AgentRunScope
} from '../../../shared/agentRuntime';
import { createAgentSessionAccessEpoch } from '../../agent/AgentRuntimeOwnership';
import { createDomainEvent } from '../domainEvent';
import type {
  CreateRuntimeRunInput,
  CreateRuntimeSessionInput
} from '../../agent/AgentRuntimeStore';
import { SqliteAgentRuntimeStore } from '../SqliteAgentRuntimeStore';
import { AgentRuntimeStateMapper } from './AgentRuntimeStateMapper';
import { AppDatabase } from './AppDatabase';
import { ManagedFileStore } from './ManagedFileStore';

describe('Agent runtime persistence across restarts and transactions', () => {
  const fixtures: RuntimeFixture[] = [];

  afterEach(async () => {
    await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.close()));
  });

  it('commits a prepared turn and its managed artifacts as restartable state', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const session = sessionInput('session-restart', 'prepare-restart:session');
    const run = runInput('run-restart', session, 'prepare-restart:run');

    await fixture.store.prepareRuntimeTurn({
      session,
      run,
      prompt: 'Keep this prompt durable.',
      priority: 'DISCOURSE_RESPONSE',
      queueOperationId: 'prepare-restart:queue'
    });
    await fixture.store.appendArtifact(
      run.outputArtifactId,
      'streamed output',
      'append-restart-output'
    );

    expect(await fixture.store.readArtifact(run.promptArtifactId)).toBe(
      'Keep this prompt durable.'
    );
    expect(await fixture.store.readArtifact(run.outputArtifactId)).toBe('streamed output');

    await fixture.reopen();
    const restarted = await fixture.store.snapshot();
    expect(restarted.sessions.map((record) => record.id)).toEqual([session.id]);
    expect(restarted.runs.map((record) => record.id)).toEqual([run.id]);
    expect(restarted.queueEntries).toHaveLength(1);
    expect(restarted.artifacts).toHaveLength(3);
    expect(await fixture.store.readArtifact(run.outputArtifactId)).toBe('streamed output');
  });

  it('keeps staged runtime state invisible after an outer transaction rolls back', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const session = sessionInput('session-rollback', 'rollback:session');

    await expect(
      fixture.database.write(async () => {
        await fixture.store.createSession(session);
        expect(await fixture.store.getSession(session.id)).toMatchObject({ id: session.id });
        throw new Error('force outer rollback');
      })
    ).rejects.toThrow('force outer rollback');

    await expect(fixture.store.getSession(session.id)).resolves.toBeUndefined();
    expect(
      await fixture.database.read((reader) =>
        reader.get('SELECT id FROM runtime_sessions WHERE id = ?', [session.id])
      )
    ).toBeUndefined();
  });

  it('removes a newly published artifact revision when its outer transaction rolls back', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const session = sessionInput('session-artifact-rollback', 'artifact-rollback:session');
    const run = runInput('run-artifact-rollback', session, 'artifact-rollback:run');
    await fixture.store.prepareRuntimeTurn({
      session,
      run,
      prompt: 'preserve the committed revision',
      priority: 'DISCOURSE_RESPONSE',
      queueOperationId: 'artifact-rollback:queue'
    });
    const previous = await fixture.store.snapshot();
    const current = previous.artifacts.find(({ id }) => id === run.outputArtifactId)!;
    const replacement = await fixture.managedFiles.publish(
      `runtime/artifacts/${current.id}-r${current.recordRevision + 1}.txt`,
      Buffer.from('rolled back replacement')
    );
    const next = structuredClone(previous);
    next.artifacts = next.artifacts.map((artifact) => artifact.id === current.id ? {
      ...artifact,
      clientOperationId: 'artifact-rollback:append',
      requestFingerprint: 'f'.repeat(64),
      storageKey: replacement.storageKey,
      contentSha256: replacement.sha256,
      byteCount: replacement.byteCount,
      recordRevision: artifact.recordRevision + 1,
      updatedAt: '2026-08-29T00:00:01.000Z'
    } : artifact);
    const mapper = new AgentRuntimeStateMapper(fixture.database, fixture.managedFiles);
    await expect(fixture.database.write(async () => {
      await mapper.persist(previous, next);
      expect(
        fixture.database.get<{ storageKey: string }>(
          `SELECT mf.storage_key AS storageKey
             FROM runtime_artifacts a
             JOIN managed_files mf ON mf.id = a.managed_file_id
            WHERE a.id = ?`,
          [current.id]
        )
      ).toEqual({ storageKey: replacement.storageKey });
      throw new Error('force artifact rollback');
    })).rejects.toThrow('force artifact rollback');
    await fixture.managedFiles.drain();
    expect(
      await fileExists(path.join(fixture.managedFiles.rootPath, replacement.storageKey))
    ).toBe(false);
    expect(
      await fileExists(path.join(fixture.managedFiles.rootPath, current.storageKey))
    ).toBe(true);
    await fixture.reopen();
    await expect(fixture.store.getArtifact(current.id)).resolves.toEqual(current);
    await expect(fixture.store.readArtifact(current.id)).resolves.toBe('');
  });

  it('commits or rolls back a runtime event and its Task-owned projection together', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await seedTask(fixture.database, 'task-shared-event');
    const taskOwner: AgentOwnerScope = { kind: 'TASK', taskId: 'task-shared-event' };
    const context = executionContext('shared-event:session');
    const session: CreateRuntimeSessionInput = {
      ...sessionInput('session-shared-event', 'shared-event:session'),
      owner: taskOwner,
      accessEpoch: createAgentSessionAccessEpoch({
        owner: taskOwner,
        sessionId: 'session-shared-event',
        epoch: 1,
        runtimeId: 'codex',
        model: 'gpt-test',
        executionContext: context,
        createdAt: '2026-08-29T00:00:00.000Z'
      }),
      taskContext: {
        iterationId: 'iteration-shared-event',
        worktreeId: 'worktree-shared-event',
        worktreePath: context.primaryCwd
      }
    };
    const storedSession = await fixture.store.createSession(session);
    const run = await fixture.store.createRun({
      ...runInput('run-shared-event', session, 'shared-event:run'),
      owner: taskOwner,
      scope: {
        kind: 'TASK',
        taskId: taskOwner.taskId,
        iterationId: session.taskContext!.iterationId,
        worktreeId: session.taskContext!.worktreeId
      },
      sessionId: storedSession.id,
      purpose: 'TASK_IMPLEMENTATION'
    });
    const starting = await fixture.store.updateRun(
      run.id,
      run.recordRevision,
      { status: 'STARTING', delivery: 'SENDING' },
      'shared-event:start'
    );
    const event = createDomainEvent({
      type: 'PROCESS_STARTED',
      taskId: taskOwner.taskId,
      iterationId: session.taskContext!.iterationId,
      runId: run.id,
      source: 'process',
      payload: {}
    });
    let rejectProjection = true;
    const runtime = fixture.store.taskAgentRuntimeAccess(async (projected) => {
      await fixture.database.write((transaction) => {
        transaction.run(
          `INSERT INTO task_domain_events (
             id, task_id, iteration_id, run_id, type, source, source_event_id,
             occurred_at, received_at, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            projected.id,
            projected.taskId,
            projected.iterationId ?? null,
            projected.runId ?? null,
            projected.type,
            projected.source,
            projected.id,
            projected.occurredAt,
            projected.receivedAt,
            JSON.stringify(projected.payload)
          ]
        );
        if (rejectProjection) throw new Error('reject Task projection');
      });
    });

    await expect(
      runtime.applyTaskRuntimeEvent(event, 'shared-event:apply')
    ).rejects.toThrow('reject Task projection');
    await expect(fixture.store.getRun(run.id)).resolves.toMatchObject({
      status: starting.status,
      recordRevision: starting.recordRevision
    });
    expect(
      await fixture.database.read((reader) =>
        reader.get('SELECT id FROM task_domain_events WHERE id = ?', [event.id])
      )
    ).toBeUndefined();

    rejectProjection = false;
    await runtime.applyTaskRuntimeEvent(event, 'shared-event:apply');
    await expect(fixture.store.getRun(run.id)).resolves.toMatchObject({ status: 'RUNNING' });
    expect(
      await fixture.database.read((reader) =>
        reader.get<{ id: string }>('SELECT id FROM task_domain_events WHERE id = ?', [event.id])
      )
    ).toEqual({ id: event.id });
  });

  it('deletes a replaced artifact revision only after its database reference commits', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const session = sessionInput('session-replace', 'replace:session');
    const run = runInput('run-replace', session, 'replace:run');
    await fixture.store.prepareRuntimeTurn({
      session,
      run,
      prompt: 'prompt',
      priority: 'DISCOURSE_RESPONSE',
      queueOperationId: 'replace:queue'
    });
    const before = await fixture.store.getArtifact(run.outputArtifactId);
    expect(before).toBeDefined();

    const after = await fixture.store.appendArtifact(
      run.outputArtifactId,
      'replacement',
      'replace:append'
    );

    expect(await fileExists(path.join(fixture.managedFiles.rootPath, before!.storageKey))).toBe(
      false
    );
    expect(await fileExists(path.join(fixture.managedFiles.rootPath, after.storageKey))).toBe(
      true
    );
    expect(
      await fixture.database.read((reader) =>
        reader.get('SELECT storage_key FROM managed_file_gc WHERE storage_key = ?', [
          before!.storageKey
        ])
      )
    ).toBeUndefined();
  });

  it('retries only runtime-owned garbage collection during startup recovery', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const runtimeFile = await fixture.managedFiles.publish(
      'runtime/artifacts/pending-runtime-file.txt',
      Buffer.from('runtime garbage')
    );
    const taskFile = await fixture.managedFiles.publish(
      'task/artifacts/pending-task-file.txt',
      Buffer.from('task garbage')
    );
    await fixture.database.write((transaction) => {
      transaction.run(
        `INSERT INTO managed_file_gc (storage_key, reason, queued_at)
         VALUES (?, 'runtime test', '2026-08-29T00:00:00.000Z'),
                (?, 'task test', '2026-08-29T00:00:01.000Z')`,
        [runtimeFile.storageKey, taskFile.storageKey]
      );
    });

    await fixture.reopen();

    expect(
      await fileExists(path.join(fixture.managedFiles.rootPath, runtimeFile.storageKey))
    ).toBe(false);
    expect(
      await fileExists(path.join(fixture.managedFiles.rootPath, taskFile.storageKey))
    ).toBe(true);
    expect(
      await fixture.database.read((reader) =>
        reader.all<{ storage_key: string }>(
          'SELECT storage_key FROM managed_file_gc ORDER BY storage_key'
        )
      )
    ).toEqual([{ storage_key: taskFile.storageKey }]);
  });

  it('rejects corrupt managed artifact bytes during startup recovery', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const session = sessionInput('session-corrupt', 'corrupt:session');
    const run = runInput('run-corrupt', session, 'corrupt:run');
    await fixture.store.prepareRuntimeTurn({
      session,
      run,
      prompt: 'verified prompt',
      priority: 'DISCOURSE_RESPONSE',
      queueOperationId: 'corrupt:queue'
    });
    const artifact = await fixture.store.getArtifact(run.promptArtifactId);
    expect(artifact).toBeDefined();
    const artifactPath = path.join(fixture.managedFiles.rootPath, artifact!.storageKey);
    await fixture.store.close();
    await fixture.database.close();
    await fs.chmod(artifactPath, 0o600);
    await fs.writeFile(artifactPath, 'corrupt');
    await fs.chmod(artifactPath, 0o400);

    fixture.database = await AppDatabase.open(path.join(fixture.root, 'task-monki.sqlite'));
    fixture.store = new SqliteAgentRuntimeStore(
      fixture.database,
      fixture.managedFiles,
      path.join(fixture.root, 'protocol-journals')
    );
    await expect(fixture.store.init()).rejects.toThrow(/managed file|integrity/i);
  });

  it('rejects a runtime artifact whose indexed columns disagree with its payload', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const session = sessionInput('session-index-tamper', 'index-tamper:session');
    const run = runInput('run-index-tamper', session, 'index-tamper:run');
    await fixture.store.prepareRuntimeTurn({
      session,
      run,
      prompt: 'indexed metadata is authoritative only when consistent',
      priority: 'DISCOURSE_RESPONSE',
      queueOperationId: 'index-tamper:queue'
    });
    await fixture.database.write((transaction) => {
      transaction.run('UPDATE runtime_artifacts SET kind = ? WHERE id = ?', [
        'FINAL',
        run.promptArtifactId
      ]);
    });

    await expect(fixture.reopen()).rejects.toThrow(/Runtime artifact .* column kind/);
  });

  it('rejects a runtime artifact whose managed-file ownership metadata is inconsistent', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const session = sessionInput('session-managed-tamper', 'managed-tamper:session');
    const run = runInput('run-managed-tamper', session, 'managed-tamper:run');
    await fixture.store.prepareRuntimeTurn({
      session,
      run,
      prompt: 'managed ownership must match the artifact',
      priority: 'DISCOURSE_RESPONSE',
      queueOperationId: 'managed-tamper:queue'
    });
    await fixture.database.write((transaction) => {
      transaction.run(
        `UPDATE managed_files SET domain = 'TASK'
          WHERE id = (SELECT managed_file_id FROM runtime_artifacts WHERE id = ?)`,
        [run.promptArtifactId]
      );
    });

    await expect(fixture.reopen()).rejects.toThrow(/managed file column managed_file_domain/);
  });

  it('rejects a nullable runtime shutdown latch instead of silently clearing it', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await fixture.store.createSession(sessionInput('session-latch', 'latch:session'));
    await fixture.database.write((transaction) => {
      transaction.run(
        `UPDATE store_metadata SET shutdown_latched = NULL WHERE domain = 'RUNTIME'`
      );
    });

    await expect(fixture.reopen()).rejects.toThrow('Stored runtime shutdown latch is invalid');
  });
});

interface RuntimeFixture {
  root: string;
  database: AppDatabase;
  managedFiles: ManagedFileStore;
  store: SqliteAgentRuntimeStore;
  reopen(): Promise<void>;
  close(): Promise<void>;
}

async function createFixture(): Promise<RuntimeFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-sqlite-runtime-'));
  let database = await AppDatabase.open(path.join(root, 'task-monki.sqlite'));
  const managedFiles = new ManagedFileStore(path.join(root, 'managed-files'));
  let store = new SqliteAgentRuntimeStore(
    database,
    managedFiles,
    path.join(root, 'protocol-journals')
  );
  const fixture: RuntimeFixture = {
    root,
    database,
    managedFiles,
    store,
    async reopen() {
      await store.close();
      await database.close();
      database = await AppDatabase.open(path.join(root, 'task-monki.sqlite'));
      store = new SqliteAgentRuntimeStore(
        database,
        managedFiles,
        path.join(root, 'protocol-journals')
      );
      fixture.database = database;
      fixture.store = store;
      await store.init();
    },
    async close() {
      await store.close().catch(() => undefined);
      await database.close().catch(() => undefined);
    }
  };
  await store.init();
  return fixture;
}

const owner: AgentOwnerScope = {
  kind: 'DISCOURSE',
  conversationId: 'conversation-1',
  stableParticipantId: 'participant-1'
};

const scope: AgentRunScope = {
  kind: 'DISCOURSE',
  conversationId: 'conversation-1',
  waveId: 'wave-1',
  jobId: 'job-1',
  contextSnapshotId: 'context-1',
  attemptId: 'attempt-1'
};

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

function sessionInput(id: string, clientOperationId: string): CreateRuntimeSessionInput {
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
      createdAt: '2026-08-29T00:00:00.000Z'
    }),
    executionContext: context,
    clientOperationId,
    runtimeId: 'codex',
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    status: 'NOT_MATERIALIZED',
    materialized: false,
    requestedSettings: context.modelSettings
  };
}

function runInput(
  id: string,
  session: CreateRuntimeSessionInput,
  clientOperationId: string
): CreateRuntimeRunInput {
  return {
    id,
    owner,
    scope,
    sessionId: session.id,
    sessionAccessEpoch: session.accessEpoch.epoch,
    purpose: 'DISCOURSE_ANSWER',
    generationKey: `${id}:generation`,
    clientOperationId,
    requestedSettings: session.requestedSettings,
    promptArtifactId: `${id}-prompt`,
    outputArtifactId: `${id}-output`,
    diagnosticArtifactId: `${id}-diagnostic`
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function seedTask(database: AppDatabase, taskId: string): Promise<void> {
  const now = '2026-08-29T00:00:00.000Z';
  await database.write((transaction) => {
    transaction.run(
      `INSERT INTO repositories (
         id, kind, name, path, status, remotes_json, payload_json,
         record_revision, created_at, updated_at
       ) VALUES (?, 'USER_REGISTERED', 'Repository', '/tmp/repository', 'READY', '[]', '{}', 1, ?, ?)`,
      ['repository-shared-event', now, now]
    );
    transaction.run(
      `INSERT INTO tasks (
         id, kind, runtime_id, title, prompt, repository_id, workflow_phase,
         resolution, completion_policy, phase_version, agent_settings_json,
         payload_json, record_revision, created_at, updated_at
       ) VALUES (?, 'NORMAL', 'codex', 'Task', 'Prompt', ?, 'IN_PROGRESS',
                 'ACTIVE', 'LOCAL_ACCEPTANCE', 1, '{}', '{}', 1, ?, ?)`,
      [taskId, 'repository-shared-event', now, now]
    );
  });
}
