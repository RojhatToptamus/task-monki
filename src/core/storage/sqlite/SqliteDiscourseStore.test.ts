import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentAssignmentSnapshot,
  ContextSnapshotRecord,
  DiscourseAgentJobRecord,
  DiscourseParticipantRecord,
  DiscourseParticipantRevisionRecord,
  DiscourseResponseWaveRecord
} from '../../../shared/discourse';
import { AppDatabase } from './AppDatabase';
import { SqliteDiscourseStore } from './SqliteDiscourseStore';

describe('SqliteDiscourseStore', () => {
  it('reopens normalized conversation, message, and draft records', async () => {
    const fixture = await createFixture();
    const conversation = await createConversation(fixture.store);
    const message = await fixture.store.appendHumanMessage({
      conversationId: conversation.id,
      body: 'Keep this durable.',
      context: [{
        entityKind: 'TASK',
        entityId: 'task-1',
        labelSnapshot: 'Task One',
        availability: 'AVAILABLE'
      }],
      clientMessageId: 'message-1'
    });
    const draft = await fixture.store.saveDraft({
      conversationId: conversation.id,
      body: 'Continue later',
      policy: 'DIRECT',
      tokens: []
    });
    await fixture.store.close();
    await fixture.database.close();

    const reopenedDatabase = await AppDatabase.open(fixture.databasePath, { acquireLease: false });
    const reopened = new SqliteDiscourseStore(reopenedDatabase);
    await reopened.init();

    await expect(reopened.getConversation(conversation.id)).resolves.toMatchObject({
      conversation: { id: conversation.id, latestOrdinal: 1 },
      participants: [{ id: 'participant-conversation-1' }],
      contextLinks: [{ entityId: 'task-1', createdByMessageId: message.id }],
      drafts: []
    });
    await expect(reopened.listMessages({ conversationId: conversation.id })).resolves.toEqual({
      messages: [message]
    });
    await expect(reopened.getDraft(draft.id)).resolves.toEqual(draft);
    await reopened.close();
    await reopenedDatabase.close();
  });

  it('serializes concurrent appends and scopes idempotency receipts to their owner', async () => {
    const fixture = await createFixture();
    await createConversation(fixture.store, 'conversation-1', 'create-1');
    await createConversation(fixture.store, 'conversation-2', 'create-2');

    const [first, second] = await Promise.all([
      fixture.store.appendHumanMessage({
        conversationId: 'conversation-1',
        body: 'First',
        clientMessageId: 'message-1'
      }),
      fixture.store.appendHumanMessage({
        conversationId: 'conversation-1',
        body: 'Second',
        clientMessageId: 'message-2'
      })
    ]);
    expect(new Set([first.ordinal, second.ordinal])).toEqual(new Set([1, 2]));
    await expect(fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'First',
      clientMessageId: 'message-1'
    })).resolves.toEqual(first);
    await expect(fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Changed',
      clientMessageId: 'message-1'
    })).rejects.toThrow('REQUEST_CONFLICT');

    const otherOwner = await fixture.store.appendHumanMessage({
      conversationId: 'conversation-2',
      body: 'Owner two',
      clientMessageId: 'message-1'
    });
    expect(otherOwner.conversationId).toBe('conversation-2');
    await fixture.store.close();
    await fixture.database.close();
  });

  it('loads only the selected conversation page', async () => {
    const fixture = await createFixture();
    await createConversation(fixture.store, 'conversation-1', 'create-1');
    await createConversation(fixture.store, 'conversation-2', 'create-2');
    await createConversation(fixture.store, 'conversation-3', 'create-3');
    await fixture.database.write((transaction) => {
      transaction.run(
        `UPDATE discourse_conversations SET title = 'Tampered' WHERE id = ?`,
        ['conversation-1']
      );
    });

    const first = await fixture.store.listConversations({ limit: 1 });
    expect(first.conversations.map(({ id }) => id)).toEqual(['conversation-3']);
    expect(first.nextCursor).toBeDefined();
    const second = await fixture.store.listConversations({
      limit: 1,
      cursor: first.nextCursor
    });
    expect(second.conversations.map(({ id }) => id)).toEqual(['conversation-2']);
    expect(second.nextCursor).toBeDefined();
    await expect(fixture.store.listConversations({
      limit: 1,
      cursor: second.nextCursor
    })).rejects.toThrow('Stored discourse aggregate is invalid');
    await fixture.store.close();
    await fixture.database.close();
  });

  it('joins an outer write and rolls records and receipts back together', async () => {
    const fixture = await createFixture();
    await createConversation(fixture.store);

    await expect(fixture.database.write(async () => {
      await fixture.store.appendHumanMessage({
        conversationId: 'conversation-1',
        body: 'Must roll back',
        clientMessageId: 'rollback-message'
      });
      throw new Error('outer failure');
    })).rejects.toThrow('outer failure');

    await expect(fixture.store.getMessageByClientId({
      conversationId: 'conversation-1',
      clientMessageId: 'rollback-message'
    })).resolves.toBeUndefined();
    await expect(fixture.store.getConversation('conversation-1')).resolves.toMatchObject({
      conversation: { latestOrdinal: 0, recordRevision: 1 },
      latestEventSequence: 1
    });
    const retry = await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Must roll back',
      clientMessageId: 'rollback-message'
    });
    expect(retry.ordinal).toBe(1);
    await fixture.store.close();
    await fixture.database.close();
  });

  it('persists wave, context snapshot, and job records as one aggregate update', async () => {
    const fixture = await createFixture();
    await createConversation(fixture.store);
    const trigger = await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Plan a direct response.',
      clientMessageId: 'trigger-1'
    });
    const before = await fixture.store.getConversation('conversation-1');
    const assignment = assignmentFromRevision(before.participantRevisions[0]!);
    const wave = directWave(trigger.id, trigger.contextRevisionId!, assignment);
    const job = directJob(trigger.id, assignment);
    const snapshot = contextSnapshot(wave, trigger.ordinal);

    const planned = await fixture.store.createWave({
      conversationId: 'conversation-1',
      expectedConversationRevision: before.conversation.recordRevision,
      wave,
      jobs: [job],
      contextSnapshot: snapshot,
      clientOperationId: wave.clientOperationId
    });
    expect(planned).toEqual({ wave, jobs: [job] });
    await expect(fixture.store.createWave({
      conversationId: 'conversation-1',
      expectedConversationRevision: before.conversation.recordRevision,
      wave,
      jobs: [job],
      contextSnapshot: snapshot,
      clientOperationId: wave.clientOperationId
    })).resolves.toEqual(planned);
    await expect(fixture.store.getConversation('conversation-1')).resolves.toMatchObject({
      contextSnapshots: [{ id: snapshot.id }],
      waves: [{ id: wave.id }],
      jobs: [{ id: job.id }]
    });
    await fixture.store.close();
    await fixture.database.close();
  });

  it('preserves participant and job insertion order across restart', async () => {
    const fixture = await createFixture();
    const first = participantSeed('conversation-1');
    first.participant.id = 'participant-z';
    first.participant.currentRevisionId = 'revision-z';
    first.revision.id = 'revision-z';
    first.revision.stableParticipantId = first.participant.id;
    const second = structuredClone(first);
    second.participant.id = 'participant-a';
    second.participant.agentProfileId = 'builtin.skeptic';
    second.participant.currentRevisionId = 'revision-a';
    second.revision.id = 'revision-a';
    second.revision.stableParticipantId = second.participant.id;
    second.revision.agentProfileId = second.participant.agentProfileId;
    second.revision.displayNameSnapshot = 'Skeptic';
    second.revision.configuredRole = 'SKEPTIC';

    await fixture.store.createConversation({
      id: 'conversation-1',
      title: 'Ordered panel',
      defaultPolicy: 'PANEL',
      participants: [first.participant, second.participant],
      participantRevisions: [first.revision, second.revision],
      requestFingerprint: 'f'.repeat(64),
      clientOperationId: 'create-ordered'
    });
    const trigger = await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Answer in configured order.',
      clientMessageId: 'ordered-message'
    });
    const aggregate = await fixture.store.getConversation('conversation-1');
    const assignments = aggregate.participants.map((participant) =>
      assignmentFromRevision(
        aggregate.participantRevisions.find(
          (revision) => revision.id === participant.currentRevisionId
        )!
      )
    );
    assignments.forEach((assignment) => {
      assignment.assignmentRole = 'PANELIST';
    });
    const wave = directWave(trigger.id, trigger.contextRevisionId!, assignments[0]!);
    wave.policy = 'PANEL';
    wave.assignments = assignments;
    const firstJob = directJob(trigger.id, assignments[0]!);
    firstJob.id = 'job-z';
    const secondJob = directJob(trigger.id, assignments[1]!);
    secondJob.id = 'job-a';
    secondJob.attemptId = 'attempt-2';
    secondJob.generationKey = 'generation-2';
    await fixture.store.createWave({
      conversationId: 'conversation-1',
      expectedConversationRevision: aggregate.conversation.recordRevision,
      wave,
      jobs: [firstJob, secondJob],
      contextSnapshot: contextSnapshot(wave, trigger.ordinal),
      clientOperationId: wave.clientOperationId
    });
    await fixture.store.close();
    await fixture.database.close();

    const reopenedDatabase = await AppDatabase.open(fixture.databasePath, {
      acquireLease: false
    });
    const reopened = new SqliteDiscourseStore(reopenedDatabase);
    await reopened.init();
    const durable = await reopened.getConversation('conversation-1');
    expect(durable.participants.map(({ id }) => id)).toEqual([
      'participant-z',
      'participant-a'
    ]);
    expect(durable.jobs.map(({ id }) => id)).toEqual(['job-z', 'job-a']);
    await reopened.close();
    await reopenedDatabase.close();
  });

  it('fails closed when a durable aggregate ordinal is not contiguous', async () => {
    const fixture = await createFixture();
    await createConversation(fixture.store);
    await fixture.database.write((transaction) => {
      transaction.run(
        'UPDATE discourse_participants SET aggregate_ordinal = 1 WHERE conversation_id = ?',
        ['conversation-1']
      );
    });

    await expect(fixture.store.getConversation('conversation-1')).rejects.toThrow(
      'participant aggregate ordinal is not contiguous'
    );
    await fixture.store.close();
    await fixture.database.close();
  });

  it('rejects a filtered conversation index mismatch while reopening the full inventory', async () => {
    const fixture = await createFixture();
    await createConversation(fixture.store);
    await fixture.database.write((transaction) => {
      transaction.run(
        `UPDATE discourse_conversations SET status = 'ARCHIVED' WHERE id = ?`,
        ['conversation-1']
      );
    });
    await fixture.store.close();
    await fixture.database.close();

    const reopenedDatabase = await AppDatabase.open(fixture.databasePath, {
      acquireLease: false
    });
    const reopened = new SqliteDiscourseStore(reopenedDatabase);
    await expect(reopened.init()).rejects.toThrow('Stored discourse aggregate is invalid');
    await reopened.close();
    await reopenedDatabase.close();
  });

  it('rejects a child index mismatch while reopening the full inventory', async () => {
    const fixture = await createFixture();
    await createConversation(fixture.store);
    await fixture.database.write((transaction) => {
      transaction.run(
        `UPDATE discourse_participants SET agent_profile_id = 'builtin.skeptic'
          WHERE conversation_id = ?`,
        ['conversation-1']
      );
    });
    await fixture.store.close();
    await fixture.database.close();

    const reopenedDatabase = await AppDatabase.open(fixture.databasePath, {
      acquireLease: false
    });
    const reopened = new SqliteDiscourseStore(reopenedDatabase);
    await expect(reopened.init()).rejects.toThrow(/participant column agentProfileId/);
    await reopened.close();
    await reopenedDatabase.close();
  });

  it('rejects participant rows whose durable order disagrees with the conversation roster', async () => {
    const fixture = await createFixture();
    const first = participantSeed('conversation-1');
    const second = structuredClone(first);
    second.participant.id = 'participant-second';
    second.participant.agentProfileId = 'builtin.skeptic';
    second.participant.currentRevisionId = 'revision-second';
    second.revision.id = 'revision-second';
    second.revision.stableParticipantId = second.participant.id;
    second.revision.agentProfileId = second.participant.agentProfileId;
    second.revision.displayNameSnapshot = 'Skeptic';
    second.revision.configuredRole = 'SKEPTIC';
    await fixture.store.createConversation({
      id: 'conversation-1',
      title: 'Ordered panel',
      defaultPolicy: 'PANEL',
      participants: [first.participant, second.participant],
      participantRevisions: [first.revision, second.revision],
      requestFingerprint: 'f'.repeat(64),
      clientOperationId: 'create-ordered-tamper'
    });
    await fixture.database.write((transaction) => {
      transaction.run(
        'UPDATE discourse_participants SET aggregate_ordinal = 2 WHERE id = ?',
        [first.participant.id]
      );
      transaction.run(
        'UPDATE discourse_participants SET aggregate_ordinal = 0 WHERE id = ?',
        [second.participant.id]
      );
      transaction.run(
        'UPDATE discourse_participants SET aggregate_ordinal = 1 WHERE id = ?',
        [first.participant.id]
      );
    });
    await fixture.store.close();
    await fixture.database.close();

    const reopenedDatabase = await AppDatabase.open(fixture.databasePath, {
      acquireLease: false
    });
    const reopened = new SqliteDiscourseStore(reopenedDatabase);
    await expect(reopened.init()).rejects.toThrow('conversation participant roster is inconsistent');
    await reopened.close();
    await reopenedDatabase.close();
  });

  it('rejects semantic payload corruption instead of silently repairing it', async () => {
    const fixture = await createFixture();
    await createConversation(fixture.store);
    await fixture.database.write((transaction) => {
      transaction.run(
        `UPDATE discourse_conversations
            SET payload_json = json_set(payload_json, '$.title', 'Tampered')
          WHERE id = ?`,
        ['conversation-1']
      );
    });

    await expect(fixture.store.getConversation('conversation-1')).rejects.toThrow(
      'Stored discourse aggregate is invalid'
    );
    await fixture.store.close();
    await fixture.database.close();
  });

  it('publishes a durable tombstone and cascades owned records atomically', async () => {
    const fixture = await createFixture();
    const conversation = await createConversation(fixture.store);
    await fixture.store.appendHumanMessage({
      conversationId: conversation.id,
      body: 'Delete with the owner.',
      clientMessageId: 'message-before-delete'
    });
    const current = await fixture.store.getConversation(conversation.id);
    const request = {
      conversationId: conversation.id,
      expectedRevision: current.conversation.recordRevision,
      clientOperationId: 'delete-1'
    };

    const tombstone = await fixture.store.deleteConversation(request);
    await expect(fixture.store.deleteConversation(request)).resolves.toEqual(tombstone);
    await expect(fixture.store.getConversation(conversation.id)).rejects.toThrow(
      'was deleted'
    );
    await expect(fixture.store.getConversationTombstone(conversation.id)).resolves.toEqual(
      tombstone
    );
    await expect(fixture.store.findCreatedConversation({
      clientOperationId: 'create-1',
      requestFingerprint: 'f'.repeat(64)
    })).resolves.toBeUndefined();
    await expect(fixture.database.read((reader) => reader.get<{ count: number }>(
      'SELECT count(*) AS count FROM discourse_messages WHERE conversation_id = ?',
      [conversation.id]
    )?.count)).resolves.toBe(0);
    await fixture.store.close();
    await fixture.database.close();
  });
});

async function createFixture(): Promise<{
  databasePath: string;
  database: AppDatabase;
  store: SqliteDiscourseStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-sqlite-discourse-'));
  const databasePath = path.join(root, 'task-monki.sqlite');
  const database = await AppDatabase.open(databasePath, { acquireLease: false });
  let tick = 0;
  const store = new SqliteDiscourseStore(database, {
    now: () => new Date(Date.UTC(2026, 6, 13, 0, 0, tick++)).toISOString()
  });
  await store.init();
  return { databasePath, database, store };
}

async function createConversation(
  store: SqliteDiscourseStore,
  conversationId = 'conversation-1',
  operationId = 'create-1'
) {
  const seed = participantSeed(conversationId);
  return store.createConversation({
    id: conversationId,
    title: 'Architecture review',
    defaultPolicy: 'TEAM',
    participants: [seed.participant],
    participantRevisions: [seed.revision],
    requestFingerprint: 'f'.repeat(64),
    clientOperationId: operationId
  });
}

function participantSeed(conversationId: string): {
  participant: DiscourseParticipantRecord;
  revision: DiscourseParticipantRevisionRecord;
} {
  return {
    participant: {
      id: `participant-${conversationId}`,
      conversationId,
      agentProfileId: 'builtin.lead',
      currentRevisionId: `participant-revision-${conversationId}`,
      enabled: true,
      recordRevision: 1,
      createdAt: '2026-07-13T00:00:00.000Z'
    },
    revision: {
      id: `participant-revision-${conversationId}`,
      conversationId,
      stableParticipantId: `participant-${conversationId}`,
      agentProfileId: 'builtin.lead',
      profileRevision: 1,
      displayNameSnapshot: 'Lead',
      runtimeId: 'codex',
      model: 'gpt-test',
      modelProvider: 'openai',
      configuredRole: 'LEAD',
      roleContractVersion: 1,
      roleContractHash: 'a'.repeat(64),
      revision: 1,
      createdAt: '2026-07-13T00:00:00.000Z'
    }
  };
}

function assignmentFromRevision(
  revision: DiscourseParticipantRevisionRecord
): AgentAssignmentSnapshot {
  return {
    stableParticipantId: revision.stableParticipantId,
    participantRevisionId: revision.id,
    agentProfileId: revision.agentProfileId,
    profileRevision: revision.profileRevision,
    displayNameSnapshot: revision.displayNameSnapshot,
    runtimeId: revision.runtimeId,
    model: revision.model,
    ...(revision.modelProvider ? { modelProvider: revision.modelProvider } : {}),
    configuredRole: revision.configuredRole,
    roleContractVersion: revision.roleContractVersion,
    roleContractHash: revision.roleContractHash,
    assignmentRole: 'PRIMARY',
    required: true
  };
}

function directWave(
  triggerMessageId: string,
  contextRevisionId: string,
  assignment: AgentAssignmentSnapshot
): DiscourseResponseWaveRecord {
  return {
    id: 'wave-1',
    conversationId: 'conversation-1',
    triggerMessageId,
    policy: 'DIRECT',
    policyVersion: 1,
    assignments: [assignment],
    sourceMessageIds: [triggerMessageId],
    plannedContextRevisionId: contextRevisionId,
    contextSnapshotId: 'context-snapshot-1',
    attempt: 1,
    recordRevision: 1,
    status: 'PLANNED',
    phase: 'ANSWER',
    clientOperationId: 'wave-plan-1',
    requestFingerprint: 'b'.repeat(64),
    dispatchGate: {
      status: 'READY',
      previewFingerprint: 'preview-1',
      confirmedAtRevision: 1
    },
    createdAt: '2026-07-13T00:01:00.000Z'
  };
}

function directJob(
  triggerMessageId: string,
  assignment: AgentAssignmentSnapshot
): DiscourseAgentJobRecord {
  return {
    id: 'job-1',
    conversationId: 'conversation-1',
    waveId: 'wave-1',
    assignment,
    role: 'ANSWER',
    phase: 1,
    targetMessageIds: [],
    visibleMessageIds: [triggerMessageId],
    contextSnapshotId: 'context-snapshot-1',
    attemptId: 'attempt-1',
    generationKey: 'generation-1',
    recordRevision: 1,
    status: 'QUEUED',
    delivery: 'NOT_SENT',
    createdAt: '2026-07-13T00:01:00.000Z'
  };
}

function contextSnapshot(
  wave: DiscourseResponseWaveRecord,
  triggerOrdinal: number
): ContextSnapshotRecord {
  return {
    id: wave.contextSnapshotId!,
    conversationId: wave.conversationId,
    waveId: wave.id,
    contextRevisionId: wave.plannedContextRevisionId,
    recordRevision: 1,
    status: 'READY',
    sources: [],
    transcriptOrdinals: [triggerOrdinal],
    attachmentIds: [],
    budget: {
      inputBytes: 128,
      estimatedInputTokens: 32,
      reservedOutputTokens: 16_000,
      sourceCount: 0
    },
    exclusions: [],
    contextSchemaVersion: 1,
    promptPolicyVersion: 1,
    createdAt: '2026-07-13T00:01:00.000Z',
    resolvedAt: '2026-07-13T00:01:00.000Z'
  };
}
