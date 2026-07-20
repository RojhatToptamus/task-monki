import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentExecutionContext,
  AgentOwnerScope,
  AgentRunScope
} from '../../shared/agentRuntime';
import { createAgentSessionAccessEpoch } from '../agent/AgentRuntimeOwnership';
import type {
  CreateRuntimeRunInput,
  CreateRuntimeSessionInput
} from '../agent/AgentRuntimeStore';
import {
  AgentRuntimeStorePublishedError,
  FileAgentRuntimeStore
} from './FileAgentRuntimeStore';

describe('FileAgentRuntimeStore', () => {
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
    const materialized = await fixture.store.updateSession(
      first.id,
      first.recordRevision,
      {
        providerSessionId: 'provider-session-1',
        status: 'IDLE',
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

  it('migrates schema v1 once, quarantines legacy access, and preserves a rollback copy', async () => {
    const fixture = await storeFixture();
    await fixture.store.createSession(
      sessionInput('legacy-session', taskOwner, 'legacy-session-operation')
    );
    const current = await fixture.store.snapshot();
    const legacy = structuredClone(current) as unknown as {
      schemaVersion: number;
      revision: number;
      telemetryRecords?: unknown[];
      sessions: Array<{
        executionContext: { attestation?: unknown };
      }>;
    };
    legacy.schemaVersion = 1;
    delete legacy.telemetryRecords;
    delete legacy.sessions[0]!.executionContext.attestation;
    const encodedLegacy = `${JSON.stringify(legacy, null, 2)}\n`;
    await fs.writeFile(path.join(fixture.root, 'runtime.json'), encodedLegacy, {
      mode: 0o600
    });

    const migratedStore = new FileAgentRuntimeStore(fixture.root);
    const migrated = await migratedStore.snapshot();
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      revision: legacy.revision + 1,
      telemetryRecords: [],
      sessions: [
        {
          id: 'legacy-session',
          executionContext: {
            attestation: {
              status: 'LEGACY_UNATTESTED',
              reason: expect.stringContaining('schema v1')
            }
          }
        }
      ]
    });
    expect(
      await fs.readFile(path.join(fixture.root, 'runtime.schema-v1.backup.json'), 'utf8')
    ).toBe(encodedLegacy);

    const reloaded = await new FileAgentRuntimeStore(fixture.root).snapshot();
    expect(reloaded.revision).toBe(migrated.revision);
    expect(reloaded.sessions[0]?.accessEpoch.executionProfileHash).toBe(
      migrated.sessions[0]?.accessEpoch.executionProfileHash
    );
  });

  it('fails closed for newer schemas, corrupt ownership, and symlinked roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-runtime-invalid-'));
    const newer = path.join(root, 'newer');
    await fs.mkdir(newer, { mode: 0o700 });
    await fs.writeFile(
      path.join(newer, 'runtime.json'),
      `${JSON.stringify({ schemaVersion: 3 })}\n`,
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
    createId: () => `generated-${++id}`
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
    }
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
