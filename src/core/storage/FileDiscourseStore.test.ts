import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentAssignmentSnapshot,
  DiscourseAgentJobRecord,
  DiscourseConversationRecord,
  DiscourseJsonValue,
  DiscourseMessageRecord,
  DiscourseParticipantRecord,
  DiscourseParticipantRevisionRecord,
  DiscourseResponseWaveRecord
} from '../../shared/discourse';
import {
  createDiscourseLogEvent,
  encodeDiscourseLogEvent
} from './FileDiscourseEventLog';
import { FileDiscourseStore } from './FileDiscourseStore';

describe('FileDiscourseStore', () => {
  it('persists a first-class conversation aggregate and rebuildable summary index', async () => {
    const fixture = await storeFixture();
    const conversation = await createConversation(fixture.store, 'conversation-1', 'create-1');
    expect(conversation).toMatchObject({
      id: 'conversation-1',
      title: 'Architecture review',
      defaultPolicy: 'TEAM',
      latestOrdinal: 0
    });

    const restarted = new FileDiscourseStore(fixture.root);
    expect(await restarted.getConversation(conversation.id)).toMatchObject({
      conversation: { id: 'conversation-1' },
      participants: [{ conversationId: 'conversation-1', id: 'participant-1' }],
      participantRevisions: [
        { conversationId: 'conversation-1', stableParticipantId: 'participant-1' }
      ]
    });
    expect(await restarted.listConversations()).toMatchObject({
      conversations: [{ id: 'conversation-1', unreadCount: 0, activeWaveCount: 0 }]
    });
  });

  it('replays a pre-semantic-fingerprint create by durable participant semantics', async () => {
    const fixture = await storeFixture();
    const originalSeed = participantSeed('conversation-legacy');
    await fixture.store.createConversation({
      id: 'conversation-legacy',
      title: 'Architecture review',
      defaultPolicy: 'TEAM',
      participants: [originalSeed.participant],
      participantRevisions: [originalSeed.revision],
      requestFingerprint: 'a'.repeat(64),
      clientOperationId: 'legacy-create-operation'
    });
    await fixture.store.close();

    const conversationDir = path.join(
      fixture.root,
      'conversations',
      'conversation-legacy'
    );
    const eventPath = path.join(conversationDir, 'events-000001.jsonl');
    const storedEvent = JSON.parse(await fs.readFile(eventPath, 'utf8')) as {
      payload: Record<string, DiscourseJsonValue>;
    };
    delete storedEvent.payload.createFingerprintVersion;
    await fs.writeFile(
      eventPath,
      encodeDiscourseLogEvent(createDiscourseLogEvent({
        formatVersion: 1,
        sequence: 1,
        kind: 'CONVERSATION_CREATED',
        operationId: 'legacy-create-operation',
        requestFingerprint: 'c'.repeat(64),
        payload: storedEvent.payload
      })),
      { mode: 0o600 }
    );
    await Promise.all([
      fs.rm(path.join(fixture.root, 'index.json'), { force: true }),
      fs.rm(path.join(conversationDir, 'metadata.json'), { force: true }),
      fs.rm(path.join(conversationDir, 'manifest.json'), { force: true }),
      fs.rm(path.join(conversationDir, 'events-000001.index.json'), { force: true })
    ]);

    const restarted = new FileDiscourseStore(fixture.root);
    await expect(restarted.findCreatedConversation({
      clientOperationId: 'legacy-create-operation',
      requestFingerprint: 'd'.repeat(64)
    })).resolves.toBeUndefined();
    const retrySeed = participantSeed('');
    retrySeed.participant.id = 'retry-participant';
    retrySeed.participant.currentRevisionId = 'retry-revision';
    retrySeed.revision.id = 'retry-revision';
    retrySeed.revision.stableParticipantId = 'retry-participant';
    const retry = {
      title: 'Architecture review',
      defaultPolicy: 'TEAM' as const,
      participants: [retrySeed.participant],
      participantRevisions: [retrySeed.revision],
      requestFingerprint: 'd'.repeat(64),
      clientOperationId: 'legacy-create-operation'
    };
    await expect(restarted.createConversation(retry)).resolves.toMatchObject({
      id: 'conversation-legacy'
    });
    await expect(restarted.createConversation({
      ...retry,
      participantRevisions: [{ ...retrySeed.revision, model: 'changed-model' }]
    })).rejects.toThrow('REQUEST_CONFLICT');
  });

  it('appends participant configuration revisions without rewriting attributable history', async () => {
    const fixture = await storeFixture();
    const conversation = await createConversation(fixture.store, 'conversation-1', 'create-1');
    const aggregate = await fixture.store.getConversation(conversation.id);
    const participant = aggregate.participants[0]!;
    const currentRevision = aggregate.participantRevisions[0]!;
    const input = {
      conversationId: conversation.id,
      participants: [{
        ...participant,
        currentRevisionId: 'participant-revision-2',
        recordRevision: participant.recordRevision + 1
      }],
      participantRevisions: [{
        ...currentRevision,
        id: 'participant-revision-2',
        model: 'gpt-next',
        revision: currentRevision.revision + 1,
        createdAt: '2026-07-13T00:05:00.000Z'
      }],
      expectedRevision: conversation.recordRevision,
      clientOperationId: 'configure-1'
    };

    const revised = await fixture.store.configureParticipants(input);
    expect(revised.participants[0]).toMatchObject({
      id: participant.id,
      currentRevisionId: 'participant-revision-2',
      recordRevision: 2
    });
    expect(revised.participantRevisions.map((revision) => revision.model)).toEqual([
      'gpt-test',
      'gpt-next'
    ]);
    await expect(fixture.store.configureParticipants(input)).resolves.toEqual(revised);

    const restarted = await new FileDiscourseStore(fixture.root).getConversation(conversation.id);
    expect(restarted.participantRevisions.map((revision) => revision.id)).toEqual([
      'participant-revision-1',
      'participant-revision-2'
    ]);
  });

  it('rejects one configuration batch that would create duplicate enabled agent profiles', async () => {
    const fixture = await storeFixture();
    const conversation = await createConversation(fixture.store, 'conversation-1', 'create-1');
    const makeBinding = (suffix: string) => ({
      participant: {
        id: `skeptic-participant-${suffix}`,
        conversationId: conversation.id,
        agentProfileId: 'builtin.skeptic' as const,
        currentRevisionId: `skeptic-revision-${suffix}`,
        enabled: true,
        recordRevision: 1,
        createdAt: '2026-07-13T00:05:00.000Z'
      },
      revision: {
        id: `skeptic-revision-${suffix}`,
        conversationId: conversation.id,
        stableParticipantId: `skeptic-participant-${suffix}`,
        agentProfileId: 'builtin.skeptic' as const,
        profileRevision: 1,
        displayNameSnapshot: 'Skeptic',
        runtimeId: 'codex',
        model: 'gpt-test',
        modelProvider: 'openai',
        configuredRole: 'SKEPTIC' as const,
        roleContractVersion: 1,
        roleContractHash: 'a'.repeat(64),
        revision: 1,
        createdAt: '2026-07-13T00:05:00.000Z'
      }
    });
    const first = makeBinding('one');
    const second = makeBinding('two');

    await expect(fixture.store.configureParticipants({
      conversationId: conversation.id,
      participants: [first.participant, second.participant],
      participantRevisions: [first.revision, second.revision],
      expectedRevision: conversation.recordRevision,
      clientOperationId: 'duplicate-profile-batch'
    })).rejects.toThrow('participant configuration revision is invalid');
    expect((await fixture.store.getConversation(conversation.id)).participants).toHaveLength(1);
  });

  it('serializes concurrent appends, pages backward, and retries a lost response exactly', async () => {
    const fixture = await storeFixture();
    await createConversation(fixture.store, 'conversation-1', 'create-1');
    const [first, second] = await Promise.all([
      fixture.store.appendHumanMessage({
        conversationId: 'conversation-1',
        body: 'First question',
        clientMessageId: 'message-operation-1'
      }),
      fixture.store.appendHumanMessage({
        conversationId: 'conversation-1',
        body: 'Second question',
        clientMessageId: 'message-operation-2'
      })
    ]);
    expect(new Set([first.ordinal, second.ordinal])).toEqual(new Set([1, 2]));

    const replay = await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'First question',
      clientMessageId: 'message-operation-1'
    });
    expect(replay.id).toBe(first.id);
    await expect(
      fixture.store.appendHumanMessage({
        conversationId: 'conversation-1',
        body: 'Changed question',
        clientMessageId: 'message-operation-1'
      })
    ).rejects.toThrow('REQUEST_CONFLICT');

    const latest = await fixture.store.listMessages({
      conversationId: 'conversation-1',
      limit: 1
    });
    expect(latest.messages.map((message) => message.ordinal)).toEqual([2]);
    expect(latest.previousCursor).toBeTruthy();
    expect(
      (
        await fixture.store.listMessages({
          conversationId: 'conversation-1',
          beforeCursor: latest.previousCursor,
          limit: 1
        })
      ).messages.map((message) => message.ordinal)
    ).toEqual([1]);
  });

  it('treats a concurrent stale read acknowledgement as an already-satisfied no-op', async () => {
    const fixture = await storeFixture();
    await createConversation(fixture.store, 'conversation-1', 'create-1');
    await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Already visible to the author',
      clientMessageId: 'message-1'
    });
    const before = (await fixture.store.getConversation('conversation-1')).conversation;

    const first = await fixture.store.setConversationReadOrdinal({
      conversationId: 'conversation-1',
      readOrdinal: before.readOrdinal,
      expectedRevision: before.recordRevision,
      clientOperationId: 'read-1'
    });
    const concurrent = await fixture.store.setConversationReadOrdinal({
      conversationId: 'conversation-1',
      readOrdinal: before.readOrdinal,
      expectedRevision: before.recordRevision,
      clientOperationId: 'read-2'
    });

    expect(concurrent).toEqual(first);
  });

  it('keeps reply ancestry valid across reload and rejects nested replies', async () => {
    const fixture = await storeFixture();
    await createConversation(fixture.store, 'conversation-1', 'create-1');
    const root = await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Root message',
      clientMessageId: 'message-root'
    });
    const restarted = new FileDiscourseStore(fixture.root);
    const reply = await restarted.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Reply',
      replyToMessageId: root.id,
      clientMessageId: 'message-reply'
    });
    await expect(
      restarted.appendHumanMessage({
        conversationId: 'conversation-1',
        body: 'Nested reply',
        replyToMessageId: reply.id,
        clientMessageId: 'message-nested'
      })
    ).rejects.toThrow('one visible nesting level');
  });

  it('freezes pinned and message context revisions without rewriting history', async () => {
    const fixture = await storeFixture();
    const conversation = await createConversation(fixture.store, 'conversation-1', 'create-1');
    const pinned = await fixture.store.setPinnedContext({
      conversationId: conversation.id,
      context: [{
        entityKind: 'REPOSITORY',
        entityId: 'repository-1',
        labelSnapshot: 'task-monki',
        availability: 'AVAILABLE'
      }],
      expectedRevision: conversation.recordRevision,
      clientOperationId: 'pin-1'
    });
    const message = await fixture.store.appendHumanMessage({
      conversationId: conversation.id,
      body: 'Compare this task with the repository baseline.',
      context: [{
        entityKind: 'TASK',
        entityId: 'task-1',
        labelSnapshot: 'Context refactor',
        availability: 'AVAILABLE'
      }],
      clientMessageId: 'message-context-1'
    });
    const aggregate = await fixture.store.getConversation(conversation.id);
    expect(aggregate.conversation.pinnedContextRevisionId).toBe(pinned.id);
    expect(message.contextRevisionId).toBeTruthy();
    expect(
      aggregate.contextRevisions.find((revision) => revision.id === message.contextRevisionId)
        ?.references.map((reference) => `${reference.scope}:${reference.entityKind}`)
    ).toEqual(['PINNED:REPOSITORY', 'MESSAGE:TASK']);

    await fixture.store.setPinnedContext({
      conversationId: conversation.id,
      context: [],
      expectedRevision: aggregate.conversation.recordRevision,
      clientOperationId: 'unpin-1'
    });
    const restarted = new FileDiscourseStore(fixture.root);
    const reloaded = await restarted.getConversation(conversation.id);
    expect(reloaded.contextRevisions.find((revision) => revision.id === message.contextRevisionId))
      .toEqual(expect.objectContaining({ references: expect.arrayContaining([
        expect.objectContaining({ entityId: 'repository-1' }),
        expect.objectContaining({ entityId: 'task-1' })
      ]) }));
    expect(
      reloaded.contextRevisions.find(
        (revision) => revision.id === reloaded.conversation.pinnedContextRevisionId
      )?.references
    ).toEqual([]);
  });

  it('appends attributable corrections and tombstones without deleting message ordinals', async () => {
    const fixture = await storeFixture();
    await createConversation(fixture.store, 'conversation-1', 'create-1');
    const original = await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'The store is task-owned.',
      clientMessageId: 'message-original'
    });
    const correction = await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Correction: the discourse store is conversation-owned.',
      supersedesMessageId: original.id,
      clientMessageId: 'message-correction'
    });
    let aggregate = await fixture.store.getConversation('conversation-1');
    await fixture.store.tombstoneMessage({
      conversationId: 'conversation-1',
      messageId: correction.id,
      expectedConversationRevision: aggregate.conversation.recordRevision,
      clientOperationId: 'delete-message-1'
    });
    const restarted = new FileDiscourseStore(fixture.root);
    const page = await restarted.listMessages({ conversationId: 'conversation-1' });
    expect(page.messages).toMatchObject([
      { id: original.id, ordinal: 1, status: 'SUPERSEDED', body: 'The store is task-owned.' },
      { id: correction.id, ordinal: 2, status: 'TOMBSTONE', body: '' }
    ]);
    aggregate = await restarted.getConversation('conversation-1');
    expect(aggregate.conversation.latestOrdinal).toBe(2);
  });

  it('persists bounded optimistic drafts separately from conversation logs', async () => {
    const fixture = await storeFixture();
    await createConversation(fixture.store, 'conversation-1', 'create-1');
    const draft = await fixture.store.saveDraft({
      conversationId: 'conversation-1',
      body: 'unfinished note',
      policy: 'NONE',
      recipientParticipantIds: [],
      tokens: [{
        kind: 'TASK',
        entityId: 'task-1',
        labelSnapshot: 'Task one'
      }]
    });
    expect(draft.tokens).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^[a-f0-9]{64}$/u),
      kind: 'TASK',
      entityId: 'task-1'
    })]);
    const agentDraft = await fixture.store.saveDraft({
      body: 'ask the lead',
      policy: 'DIRECT',
      recipientParticipantIds: [],
      agentSelections: [{
        agentProfileId: 'builtin.lead',
        runtimeId: 'codex',
        modelId: 'codex:gpt-test',
        reasoningEffort: 'medium'
      }],
      pendingClientMessageId: 'pending-agent-send-1',
      tokens: [{
        kind: 'AGENT',
        entityId: 'builtin.lead',
        labelSnapshot: 'Lead'
      }]
    });
    expect(agentDraft.tokens).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^[a-f0-9]{64}$/u),
      entityId: 'builtin.lead'
    })]);
    expect(agentDraft.agentSelections).toEqual([{
      agentProfileId: 'builtin.lead',
      runtimeId: 'codex',
      modelId: 'codex:gpt-test',
      reasoningEffort: 'medium'
    }]);
    expect(agentDraft.pendingClientMessageId).toBe('pending-agent-send-1');
    await fixture.store.deleteDraft({
      draftId: agentDraft.id,
      expectedRevision: agentDraft.recordRevision
    });
    const updated = await fixture.store.saveDraft({
      draftId: draft.id,
      conversationId: 'conversation-1',
      expectedRevision: draft.recordRevision,
      body: 'unfinished note, revised',
      policy: 'NONE',
      recipientParticipantIds: [],
      tokens: draft.tokens
    });
    await createConversation(fixture.store, 'conversation-2', 'create-2');
    const rebound = await fixture.store.saveDraft({
      draftId: updated.id,
      conversationId: 'conversation-2',
      expectedRevision: updated.recordRevision,
      body: updated.body,
      policy: updated.policy,
      recipientParticipantIds: updated.recipientParticipantIds,
      tokens: updated.tokens
    });
    expect(rebound).toMatchObject({
      id: draft.id,
      conversationId: 'conversation-2',
      recordRevision: updated.recordRevision + 1
    });
    await expect(fixture.store.saveDraft({
      draftId: draft.id,
      conversationId: 'conversation-1',
      expectedRevision: draft.recordRevision,
      body: 'stale write',
      policy: 'NONE',
      recipientParticipantIds: [],
      tokens: []
    })).rejects.toThrow('draft changed');

    const restarted = new FileDiscourseStore(fixture.root);
    expect(await restarted.listDrafts()).toEqual([rebound]);
    await restarted.deleteDraft({ draftId: rebound.id, expectedRevision: rebound.recordRevision });
    expect(await restarted.getDraft(rebound.id)).toBeUndefined();
  });

  it('finds a human message by client identity beyond the newest transcript page', async () => {
    const fixture = await storeFixture();
    await createConversation(fixture.store, 'conversation-1', 'create-1');
    const original = await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Original message with a retained draft checkpoint.',
      context: [],
      clientMessageId: 'message-original'
    });
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      fixture.store.appendHumanMessage({
        conversationId: 'conversation-1',
        body: `Later message ${index + 1}.`,
        context: [],
        clientMessageId: `message-later-${index + 1}`
      })
    ));
    const newest = await fixture.store.listMessages({
      conversationId: 'conversation-1',
      limit: 100
    });
    expect(newest.messages).toHaveLength(100);
    expect(newest.messages.some((message) => message.id === original.id)).toBe(false);

    const restarted = new FileDiscourseStore(fixture.root);
    expect(await restarted.getMessageByClientId({
      conversationId: 'conversation-1',
      clientMessageId: 'message-original'
    })).toEqual(original);
    expect(await restarted.getMessageByClientId({
      conversationId: 'conversation-1',
      clientMessageId: 'message-missing'
    })).toBeUndefined();
  }, 20_000);

  it('uses optimistic and idempotent conversation metadata updates', async () => {
    const fixture = await storeFixture();
    const original = await createConversation(fixture.store, 'conversation-1', 'create-1');
    const renamed = await fixture.store.renameConversation({
      conversationId: original.id,
      title: 'Renamed conversation',
      expectedRevision: original.recordRevision,
      clientOperationId: 'rename-1'
    });
    expect(renamed.recordRevision).toBe(2);
    expect(
      await fixture.store.renameConversation({
        conversationId: original.id,
        title: 'Renamed conversation',
        expectedRevision: original.recordRevision,
        clientOperationId: 'rename-1'
      })
    ).toEqual(renamed);
    await expect(
      fixture.store.renameConversation({
        conversationId: original.id,
        title: 'Conflicting rename',
        expectedRevision: original.recordRevision,
        clientOperationId: 'rename-1'
      })
    ).rejects.toThrow('REQUEST_CONFLICT');
    await expect(
      fixture.store.renameConversation({
        conversationId: original.id,
        title: 'Stale rename',
        expectedRevision: original.recordRevision,
        clientOperationId: 'rename-2'
      })
    ).rejects.toThrow('changed before rename');
  });

  it('persists a wave, runtime-linked job, agent output, and exact terminal replay', async () => {
    const fixture = await storeFixture();
    const conversation = await createConversation(
      fixture.store,
      'conversation-1',
      'create-1'
    );
    const trigger = await fixture.store.appendHumanMessage({
      conversationId: conversation.id,
      body: 'Give me a direct architecture answer.',
      clientMessageId: 'message-trigger'
    });
    const aggregate = await fixture.store.getConversation(conversation.id);
    const assignment = assignmentFromRevision(aggregate.participantRevisions[0]!);
    const wave = directWave(trigger.id, trigger.contextRevisionId!, assignment);
    const job = directJob(trigger.id, assignment);
    const snapshot = contextSnapshot(wave, trigger.ordinal);

    const planned = await fixture.store.createWave({
      conversationId: conversation.id,
      expectedConversationRevision: aggregate.conversation.recordRevision,
      wave,
      jobs: [job],
      contextSnapshot: snapshot,
      clientOperationId: wave.clientOperationId
    });
    expect(planned).toEqual({ wave, jobs: [job] });
    expect(
      await fixture.store.createWave({
        conversationId: conversation.id,
        expectedConversationRevision: aggregate.conversation.recordRevision,
        wave,
        jobs: [job],
        contextSnapshot: snapshot,
        clientOperationId: wave.clientOperationId
      })
    ).toEqual(planned);

    let currentJob = await fixture.store.updateJob({
      conversationId: conversation.id,
      expectedRevision: 1,
      clientOperationId: 'job-context-1',
      job: {
        ...job,
        recordRevision: 2,
        status: 'RESOLVING_CONTEXT'
      }
    });
    currentJob = await fixture.store.updateJob({
      conversationId: conversation.id,
      expectedRevision: currentJob.recordRevision,
      clientOperationId: 'job-starting-1',
      job: {
        ...currentJob,
        recordRevision: currentJob.recordRevision + 1,
        sessionId: 'session-1',
        executionProfileHash: 'c'.repeat(64),
        runId: 'run-1',
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt: '2026-07-13T00:02:00.000Z'
      }
    });
    currentJob = await fixture.store.updateJob({
      conversationId: conversation.id,
      expectedRevision: currentJob.recordRevision,
      clientOperationId: 'job-running-1',
      job: {
        ...currentJob,
        recordRevision: currentJob.recordRevision + 1,
        status: 'RUNNING',
        delivery: 'ACKNOWLEDGED'
      }
    });

    const output = await fixture.store.appendAgentMessage({
      conversationId: conversation.id,
      body: 'Use one owner-neutral runtime and keep discourse state separate.',
      stableParticipantId: assignment.stableParticipantId,
      participantRevisionId: assignment.participantRevisionId,
      displayNameSnapshot: assignment.displayNameSnapshot,
      waveId: wave.id,
      jobId: currentJob.id,
      sourceMessageIds: [trigger.id],
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'agent-output-1'
    });
    expect(
      await fixture.store.appendAgentMessage({
        conversationId: conversation.id,
        body: 'Use one owner-neutral runtime and keep discourse state separate.',
        stableParticipantId: assignment.stableParticipantId,
        participantRevisionId: assignment.participantRevisionId,
        displayNameSnapshot: assignment.displayNameSnapshot,
        waveId: wave.id,
        jobId: currentJob.id,
        sourceMessageIds: [trigger.id],
        freshnessAtCompletion: 'FRESH',
        clientOperationId: 'agent-output-1'
      })
    ).toEqual(output);
    await expect(
      fixture.store.appendAgentMessage({
        conversationId: conversation.id,
        body: 'A second output must not be accepted.',
        stableParticipantId: assignment.stableParticipantId,
        participantRevisionId: assignment.participantRevisionId,
        displayNameSnapshot: assignment.displayNameSnapshot,
        waveId: wave.id,
        jobId: currentJob.id,
        sourceMessageIds: [trigger.id],
        freshnessAtCompletion: 'FRESH',
        clientOperationId: 'agent-output-2'
      })
    ).rejects.toThrow('more than one visible message');

    currentJob = await fixture.store.updateJob({
      conversationId: conversation.id,
      expectedRevision: currentJob.recordRevision,
      clientOperationId: 'job-completed-1',
      job: {
        ...currentJob,
        recordRevision: currentJob.recordRevision + 1,
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        freshnessAtCompletion: 'FRESH',
        result: { kind: 'CONTRIBUTION', outputMessageId: output.id },
        finishedAt: '2026-07-13T00:03:00.000Z'
      }
    });
    expect(currentJob.result).toEqual({
      kind: 'CONTRIBUTION',
      outputMessageId: output.id
    });

    const settled = await fixture.store.updateWave({
      conversationId: conversation.id,
      expectedRevision: wave.recordRevision,
      clientOperationId: 'wave-settled-1',
      wave: {
        ...wave,
        recordRevision: wave.recordRevision + 1,
        status: 'SETTLED',
        phase: 'COMPLETE',
        outcome: 'COMPLETE',
        settlementReason: 'COMPLETED',
        settledAt: '2026-07-13T00:04:00.000Z'
      }
    });
    expect(settled.status).toBe('SETTLED');

    const restarted = new FileDiscourseStore(fixture.root);
    const reloaded = await restarted.getConversation(conversation.id);
    expect(reloaded).toMatchObject({
      waves: [{ id: wave.id, status: 'SETTLED', outcome: 'COMPLETE' }],
      jobs: [{ id: job.id, status: 'COMPLETED', runId: 'run-1' }]
    });
    expect(
      (await restarted.listMessages({ conversationId: conversation.id })).messages
    ).toMatchObject([
      { id: trigger.id, author: { kind: 'USER' } },
      { id: output.id, author: { kind: 'AGENT' }, jobId: job.id }
    ]);
  });

  it('rejects cross-participant plans and immutable job rewrites', async () => {
    const fixture = await storeFixture();
    const conversation = await createConversation(
      fixture.store,
      'conversation-1',
      'create-1'
    );
    const trigger = await fixture.store.appendHumanMessage({
      conversationId: conversation.id,
      body: 'Check ownership.',
      clientMessageId: 'message-trigger'
    });
    const aggregate = await fixture.store.getConversation(conversation.id);
    const assignment = assignmentFromRevision(aggregate.participantRevisions[0]!);
    const wave = directWave(trigger.id, trigger.contextRevisionId!, assignment);
    const job = directJob(trigger.id, assignment);
    const snapshot = contextSnapshot(wave, trigger.ordinal);
    await expect(
      fixture.store.createWave({
        conversationId: conversation.id,
        expectedConversationRevision: aggregate.conversation.recordRevision,
        wave: {
          ...wave,
          assignments: [{ ...assignment, model: 'different-model' }]
        },
        jobs: [{ ...job, assignment: { ...assignment, model: 'different-model' } }],
        contextSnapshot: snapshot,
        clientOperationId: wave.clientOperationId
      })
    ).rejects.toThrow('immutable participant revision');

    await fixture.store.createWave({
      conversationId: conversation.id,
      expectedConversationRevision: aggregate.conversation.recordRevision,
      wave,
      jobs: [job],
      contextSnapshot: snapshot,
      clientOperationId: wave.clientOperationId
    });
    await expect(
      fixture.store.updateJob({
        conversationId: conversation.id,
        expectedRevision: job.recordRevision,
        clientOperationId: 'rewrite-job-1',
        job: {
          ...job,
          recordRevision: job.recordRevision + 1,
          generationKey: 'rewritten-generation',
          status: 'RESOLVING_CONTEXT'
        }
      })
    ).rejects.toThrow('immutable execution identity');
  });

  it('archives without changing last-message time and deletes through a durable tombstone', async () => {
    const fixture = await storeFixture();
    const created = await createConversation(fixture.store, 'conversation-1', 'create-1');
    const message = await fixture.store.appendHumanMessage({
      conversationId: created.id,
      body: 'Keep this message timestamp.',
      clientMessageId: 'message-1'
    });
    const beforeArchive = await fixture.store.getConversation(created.id);
    const archived = await fixture.store.setConversationArchived({
      conversationId: created.id,
      archived: true,
      expectedRevision: beforeArchive.conversation.recordRevision,
      clientOperationId: 'archive-1'
    });
    expect(archived.status).toBe('ARCHIVED');
    expect((await fixture.store.listConversations()).conversations[0]).toMatchObject({
      status: 'ARCHIVED',
      lastMessageAt: message.createdAt
    });
    const reopened = await fixture.store.setConversationArchived({
      conversationId: created.id,
      archived: false,
      expectedRevision: archived.recordRevision,
      clientOperationId: 'reopen-1'
    });
    expect(reopened).toMatchObject({ status: 'OPEN', archivedAt: undefined });

    const tombstone = await fixture.store.deleteConversation({
      conversationId: created.id,
      expectedRevision: reopened.recordRevision,
      clientOperationId: 'delete-1'
    });
    expect(tombstone).toMatchObject({
      conversationId: created.id,
      clientOperationId: 'delete-1'
    });
    expect(await fixture.store.getConversationTombstone(created.id)).toEqual(tombstone);
    expect(await fixture.store.listConversations()).toEqual({ conversations: [] });
    await expect(fixture.store.getConversation(created.id)).rejects.toThrow('was deleted');
    await expect(
      createConversation(fixture.store, 'conversation-1', 'create-reused-id')
    ).rejects.toThrow('cannot be reused');
    expect(
      await fixture.store.deleteConversation({
        conversationId: created.id,
        expectedRevision: reopened.recordRevision,
        clientOperationId: 'delete-1'
      })
    ).toEqual(tombstone);
    await expect(
      fixture.store.deleteConversation({
        conversationId: created.id,
        expectedRevision: reopened.recordRevision,
        clientOperationId: 'different-delete'
      })
    ).rejects.toThrow('REQUEST_CONFLICT');
    await expect(
      fs.stat(path.join(fixture.root, 'conversations', created.id))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const restarted = new FileDiscourseStore(fixture.root);
    expect(await restarted.getConversationTombstone(created.id)).toEqual(tombstone);
    expect(await restarted.listConversations()).toEqual({ conversations: [] });
  });

  it('repairs a deletion interrupted after its authoritative event append', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-delete-crash-'));
    let appends = 0;
    const interrupted = new FileDiscourseStore(root, {
      eventLogOptions: {
        afterSegmentIndexBeforeManifest: () => {
          appends += 1;
          if (appends === 2) throw new Error('injected delete publication crash');
        }
      }
    });
    const created = await createConversation(interrupted, 'conversation-1', 'create-1');
    await expect(
      interrupted.deleteConversation({
        conversationId: created.id,
        expectedRevision: created.recordRevision,
        clientOperationId: 'delete-1'
      })
    ).rejects.toThrow('injected delete publication crash');

    const recovered = new FileDiscourseStore(root);
    await recovered.init();
    expect(await recovered.getConversationTombstone(created.id)).toMatchObject({
      conversationId: created.id,
      clientOperationId: 'delete-1'
    });
    expect(await recovered.listConversations()).toEqual({ conversations: [] });
    await expect(
      fs.stat(path.join(root, 'conversations', created.id))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an fsynced message when metadata/index publication is interrupted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-store-crash-'));
    let appends = 0;
    const interrupted = new FileDiscourseStore(root, {
      eventLogOptions: {
        afterSegmentIndexBeforeManifest: () => {
          appends += 1;
          if (appends === 2) throw new Error('injected aggregate publication crash');
        }
      }
    });
    await createConversation(interrupted, 'conversation-1', 'create-1');
    await expect(
      interrupted.appendHumanMessage({
        conversationId: 'conversation-1',
        body: 'Durable despite the stale summary',
        clientMessageId: 'message-1'
      })
    ).rejects.toThrow('injected aggregate publication crash');

    const recovered = new FileDiscourseStore(root);
    expect(
      (await recovered.listMessages({ conversationId: 'conversation-1' })).messages
    ).toMatchObject([{ body: 'Durable despite the stale summary', ordinal: 1 }]);
    expect((await recovered.listConversations()).conversations[0]).toMatchObject({
      latestOrdinal: 1,
      readOrdinal: 1
    });
    await expect(
      recovered.appendHumanMessage({
        conversationId: 'conversation-1',
        body: 'Durable despite the stale summary',
        clientMessageId: 'message-1'
      })
    ).resolves.toMatchObject({ ordinal: 1 });
  });

  it('rebuilds corrupt indexes/metadata but refuses newer schemas and symlink roots', async () => {
    const fixture = await storeFixture();
    await createConversation(fixture.store, 'conversation-1', 'create-1');
    await fixture.store.appendHumanMessage({
      conversationId: 'conversation-1',
      body: 'Preserve me',
      clientMessageId: 'message-1'
    });
    await fs.writeFile(path.join(fixture.root, 'index.json'), '{corrupt', 'utf8');
    await fs.writeFile(
      path.join(fixture.root, 'conversations', 'conversation-1', 'metadata.json'),
      '{corrupt',
      'utf8'
    );
    const repaired = new FileDiscourseStore(fixture.root);
    expect((await repaired.listConversations()).conversations[0]?.latestOrdinal).toBe(1);
    expect(
      JSON.parse(await fs.readFile(path.join(fixture.root, 'index.json'), 'utf8'))
        .createOperations
    ).toHaveLength(1);

    const newerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-newer-'));
    await fs.mkdir(path.join(newerRoot, 'conversations'));
    await fs.writeFile(
      path.join(newerRoot, 'index.json'),
      `${JSON.stringify({ schemaVersion: 2 })}\n`,
      { mode: 0o600 }
    );
    await expect(new FileDiscourseStore(newerRoot).init()).rejects.toThrow(
      'newer than this app supports'
    );

    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-link-'));
    const target = path.join(parent, 'target');
    const linked = path.join(parent, 'linked');
    await fs.mkdir(target);
    await fs.symlink(target, linked);
    await expect(new FileDiscourseStore(linked).init()).rejects.toThrow(
      'root failed its integrity check'
    );
  });

  it('pages a 10,000-message conversation without replaying its transcript at cold startup', async () => {
    const fixture = await storeFixture();
    const conversation = await createConversation(
      fixture.store,
      'conversation-1',
      'create-1'
    );
    await fixture.store.close();
    await seedMessageEvents(fixture.root, conversation, 10_000);

    // The first recovery creates authoritative indexes and current aggregate
    // metadata for the synthetic long-history fixture.
    const recovered = new FileDiscourseStore(fixture.root);
    await recovered.init();
    await recovered.close();

    const firstSegmentIndex = path.join(
      fixture.root,
      'conversations',
      conversation.id,
      'events-000001.index.json'
    );
    await fs.writeFile(firstSegmentIndex, '{corrupt', 'utf8');
    const cold = new FileDiscourseStore(fixture.root);
    await cold.init();

    // A current checksummed metadata/manifest pair is enough to build the rail;
    // the transcript index remains untouched until a page is requested.
    await expect(fs.readFile(firstSegmentIndex, 'utf8')).resolves.toBe('{corrupt');
    const latest = await cold.listMessages({
      conversationId: conversation.id,
      limit: 100
    });
    expect(latest.messages).toHaveLength(100);
    expect(latest.messages[0]?.ordinal).toBe(9_901);
    expect(latest.messages.at(-1)?.ordinal).toBe(10_000);
    expect(latest.previousCursor).toBeTruthy();
    const previous = await cold.listMessages({
      conversationId: conversation.id,
      beforeCursor: latest.previousCursor,
      limit: 100
    });
    expect(previous.messages[0]?.ordinal).toBe(9_801);
    expect(previous.messages.at(-1)?.ordinal).toBe(9_900);
    await expect(fs.readFile(firstSegmentIndex, 'utf8')).resolves.toContain(
      'message:bulk-message-1'
    );
  }, 30_000);
});

async function seedMessageEvents(
  root: string,
  original: DiscourseConversationRecord,
  messageCount: number
): Promise<void> {
  const directory = path.join(root, 'conversations', original.id);
  const creationLine = await fs.readFile(path.join(directory, 'events-000001.jsonl'), 'utf8');
  const segmentLines: string[][] = [[creationLine]];
  for (let ordinal = 1; ordinal <= messageCount; ordinal += 1) {
    const createdAt = new Date(Date.UTC(2026, 6, 13, 1, 0, 0, ordinal)).toISOString();
    const message: DiscourseMessageRecord = {
      id: `bulk-message-${ordinal}`,
      conversationId: original.id,
      ordinal,
      author: { kind: 'USER' },
      body: `Bounded message ${ordinal}`,
      status: 'VISIBLE',
      sourceMessageIds: [],
      clientMessageId: `bulk-message-${ordinal}`,
      requestFingerprint: 'f'.repeat(64),
      createdAt
    };
    const conversation: DiscourseConversationRecord = {
      ...original,
      recordRevision: original.recordRevision + ordinal,
      latestOrdinal: ordinal,
      readOrdinal: ordinal,
      updatedAt: createdAt
    };
    const sequence = ordinal + 1;
    const segmentIndex = Math.floor((sequence - 1) / 2_048);
    const lines = segmentLines[segmentIndex] ?? [];
    lines.push(
      encodeDiscourseLogEvent(
        createDiscourseLogEvent({
          formatVersion: 1,
          sequence,
          kind: 'MESSAGE_APPENDED',
          operationId: `message:bulk-message-${ordinal}`,
          requestFingerprint: 'f'.repeat(64),
          payload: JSON.parse(
            JSON.stringify({ message, conversation })
          ) as DiscourseJsonValue
        })
      )
    );
    segmentLines[segmentIndex] = lines;
  }
  await Promise.all(
    segmentLines.map((lines, index) =>
      fs.writeFile(
        path.join(directory, `events-${String(index + 1).padStart(6, '0')}.jsonl`),
        lines.join(''),
        { mode: 0o600 }
      )
    )
  );
}

async function storeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-store-'));
  let index = 0;
  const store = new FileDiscourseStore(root, {
    now: () => new Date(Date.UTC(2026, 6, 13, 0, 0, index++)).toISOString()
  });
  await store.init();
  return { root, store };
}

async function createConversation(
  store: FileDiscourseStore,
  conversationId: string,
  clientOperationId: string
) {
  const participant = participantSeed(conversationId);
  return store.createConversation({
    id: conversationId,
    title: 'Architecture review',
    defaultPolicy: 'TEAM',
    participants: [participant.participant],
    participantRevisions: [participant.revision],
    requestFingerprint: 'f'.repeat(64),
    clientOperationId
  });
}

function participantSeed(conversationId: string): {
  participant: DiscourseParticipantRecord;
  revision: DiscourseParticipantRevisionRecord;
} {
  return {
    participant: {
      id: 'participant-1',
      conversationId,
      agentProfileId: 'builtin.lead',
      currentRevisionId: 'participant-revision-1',
      enabled: true,
      recordRevision: 1,
      createdAt: '2026-07-13T00:00:00.000Z'
    },
    revision: {
      id: 'participant-revision-1',
      conversationId,
      stableParticipantId: 'participant-1',
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
    modelProvider: revision.modelProvider,
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
): import('../../shared/discourse').ContextSnapshotRecord {
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
