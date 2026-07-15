import crypto, { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DISCOURSE_LIMITS,
  DISCOURSE_STORE_SCHEMA_VERSION,
  type DiscourseConversationAggregateRecord,
  type DiscourseConversationPage,
  type DiscourseConversationRecord,
  type DiscourseConversationSummary,
  type DiscourseConversationTombstoneRecord,
  type DiscourseAgentJobRecord,
  type DiscourseJsonValue,
  type DiscourseMessagePage,
  type DiscourseMessageRecord,
  type DiscourseResponseWaveRecord,
  type DiscourseContextSelectionSnapshot,
  type ConversationContextLinkRecord,
  type ConversationContextRevisionRecord,
  type DiscourseDraftRecord,
  type DiscourseDraftTokenInput,
  type ContextSnapshotRecord,
  type DiscourseParticipantRecord,
  type DiscourseParticipantRevisionRecord,
  type DiscourseConcernRecord
} from '../../shared/discourse';
import type {
  AppendHumanDiscourseMessageInput,
  AppendAgentDiscourseMessageInput,
  CreateDiscourseWaveInput,
  CreateDiscourseConversationInput,
  DiscourseStore
} from '../discourse/DiscourseStore';
import {
  assertDiscourseMessageAppend,
  assertDiscourseDeliveryTransition,
  assertDiscourseJobTransition,
  assertDiscourseWaveTransition,
  deriveDiscourseWaveAggregate,
  reconcileDiscourseDelivery,
  assertDiscourseWaveRecord,
  assertDiscourseJobRecord,
  assertContextSnapshotRecord
} from '../discourse/DiscourseState';
import {
  enforcePosixMode,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported
} from '../filesystem/secureFilesystem';
import {
  FileDiscourseEventLog,
  type DiscourseLogEvent
} from './FileDiscourseEventLog';

const INDEX_FILE = 'index.json';
const METADATA_FILE = 'metadata.json';
const CONVERSATIONS_DIRECTORY = 'conversations';
const DRAFTS_DIRECTORY = 'drafts';
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_DRAFT_BYTES = 96 * 1024;

interface DiscourseCreateOperation {
  operationId: string;
  requestFingerprint: string;
  conversationId: string;
}

interface DiscourseIndexFile {
  schemaVersion: typeof DISCOURSE_STORE_SCHEMA_VERSION;
  revision: number;
  summaries: DiscourseConversationSummary[];
  createOperations: DiscourseCreateOperation[];
  tombstones: DiscourseConversationTombstoneRecord[];
  checksum: string;
}

interface DiscourseConversationMetadata {
  schemaVersion: typeof DISCOURSE_STORE_SCHEMA_VERSION;
  conversationId: string;
  lastAppliedEventSequence: number;
  summary: DiscourseConversationSummary;
  createOperation: DiscourseCreateOperation;
  checksum: string;
}

interface MessageHeader {
  id: string;
  conversationId: string;
  ordinal: number;
  author: DiscourseMessageRecord['author'];
  status: DiscourseMessageRecord['status'];
  replyToMessageId?: string;
  waveId?: string;
  jobId?: string;
}

interface DiscourseDraftFile {
  schemaVersion: typeof DISCOURSE_STORE_SCHEMA_VERSION;
  draft: DiscourseDraftRecord;
  checksum: string;
}

interface LoadedConversation {
  aggregate: DiscourseConversationAggregateRecord;
  messageHeaders: Map<string, MessageHeader>;
  createOperation?: DiscourseCreateOperation;
  lastMessageAt?: string;
  tombstone?: DiscourseConversationTombstoneRecord;
}

interface ConversationHandle {
  log: FileDiscourseEventLog;
  loaded?: LoadedConversation;
  queue: Promise<unknown>;
}

export interface FileDiscourseStoreOptions {
  now?: () => string;
  createId?: () => string;
  eventLogOptions?: ConstructorParameters<typeof FileDiscourseEventLog>[1];
}

/** Dedicated curated-conversation authority; task/runtime records never enter it. */
export class FileDiscourseStore implements DiscourseStore {
  private readonly conversationsDir: string;
  private readonly draftsDir: string;
  private readonly indexPath: string;
  private index: DiscourseIndexFile = emptyIndex();
  private initPromise?: Promise<void>;
  private globalQueue: Promise<unknown> = Promise.resolve();
  private readonly handles = new Map<string, ConversationHandle>();
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(
    private readonly rootDir: string,
    private readonly options: FileDiscourseStoreOptions = {}
  ) {
    this.conversationsDir = path.join(rootDir, CONVERSATIONS_DIRECTORY);
    this.draftsDir = path.join(rootDir, DRAFTS_DIRECTORY);
    this.indexPath = path.join(rootDir, INDEX_FILE);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => randomUUID());
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  async close(): Promise<void> {
    await this.globalQueue.catch(() => undefined);
    await Promise.all([...this.handles.values()].map((handle) => handle.queue.catch(() => undefined)));
  }

  createConversation(
    input: CreateDiscourseConversationInput
  ): Promise<DiscourseConversationRecord> {
    return this.enqueueGlobal(async () => {
      await this.init();
      validateTitle(input.title);
      validateOperationId(input.clientOperationId);
      assertParticipantSeed(input);
      const fingerprint = hashRequest({
        id: input.id ?? null,
        title: input.title.trim(),
        defaultPolicy: input.defaultPolicy,
        participants: input.participants,
        participantRevisions: input.participantRevisions
      });
      const prior = this.index.createOperations.find(
        (operation) => operation.operationId === input.clientOperationId
      );
      if (prior) {
        if (prior.requestFingerprint !== fingerprint) {
          throw new Error('REQUEST_CONFLICT: conversation create operation changed.');
        }
        return (await this.loadConversation(prior.conversationId)).aggregate.conversation;
      }
      if (this.index.summaries.length >= DISCOURSE_LIMITS.maxConversationSummariesInSnapshot) {
        throw new Error('Discourse conversation limit reached. Archive/export policy is required.');
      }
      const id = input.id ?? this.createId();
      requireSafeId(id, 'conversation id');
      if (this.index.summaries.some((summary) => summary.id === id)) {
        throw new Error(`Discourse conversation already exists: ${id}`);
      }
      if (this.index.tombstones.some((tombstone) => tombstone.conversationId === id)) {
        throw new Error(`Deleted discourse conversation ids cannot be reused: ${id}`);
      }
      const now = requireTimestamp(this.now());
      const participants = input.participants.map((participant) => ({
        ...participant,
        conversationId: id
      }));
      const participantRevisions = input.participantRevisions.map((revision) => ({
        ...revision,
        conversationId: id
      }));
      const conversation: DiscourseConversationRecord = {
        id,
        title: input.title.trim(),
        status: 'OPEN',
        defaultPolicy: input.defaultPolicy,
        participantIds: participants.map((participant) => participant.id),
        recordRevision: 1,
        latestOrdinal: 0,
        readOrdinal: 0,
        createdAt: now,
        updatedAt: now
      };
      const handle = this.getHandle(id);
      const event = await handle.log.append({
        kind: 'CONVERSATION_CREATED',
        operationId: input.clientOperationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({
          conversation,
          participants,
          participantRevisions
        })
      });
      const loaded = applyEvent(emptyLoaded(conversation), event);
      handle.loaded = loaded;
      this.index = {
        ...this.index,
        revision: this.index.revision + 1,
        summaries: [summaryFromLoaded(loaded), ...this.index.summaries],
        createOperations: [
          ...this.index.createOperations,
          {
            operationId: input.clientOperationId,
            requestFingerprint: fingerprint,
            conversationId: id
          }
        ]
      };
      try {
        await this.persistConversationMetadata(loaded);
        await this.persistIndex();
      } catch (error) {
        this.handles.delete(id);
        throw error;
      }
      return clone(conversation);
    });
  }

  async getConversation(conversationId: string): Promise<DiscourseConversationAggregateRecord> {
    await this.init();
    assertConversationNotDeleted(this.index, conversationId);
    const loaded = await this.loadConversation(conversationId);
    return clone(loaded.aggregate);
  }

  async listConversations(
    input: {
      status?: 'OPEN' | 'ARCHIVED';
      cursor?: string;
      limit?: number;
    } = {}
  ): Promise<DiscourseConversationPage> {
    await this.init();
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Discourse conversation page limit must be between 1 and 100.');
    }
    const filtered = this.index.summaries
      .filter((summary) => !input.status || summary.status === input.status)
      .sort(compareSummaries);
    const offset = decodeOffsetCursor(input.cursor, filtered.length);
    const conversations = filtered.slice(offset, offset + limit);
    return {
      conversations: clone(conversations),
      ...(offset + conversations.length < filtered.length
        ? { nextCursor: encodeOffsetCursor(offset + conversations.length) }
        : {})
    };
  }

  addParticipants(input: {
    conversationId: string;
    participants: DiscourseParticipantRecord[];
    participantRevisions: DiscourseParticipantRevisionRecord[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationAggregateRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      const fingerprint = hashRequest(input);
      const operationId = `roster:${input.clientOperationId}`;
      if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(handle.log, operationId, fingerprint);
        if (replay) return clone(loaded.aggregate);
        throw new Error('Discourse conversation changed before roster update.');
      }
      if (input.participants.length !== input.participantRevisions.length) {
        throw new Error('Discourse roster update requires matching participant revisions.');
      }
      const existingParticipantIds = new Set(
        loaded.aggregate.participants.map((record) => record.id)
      );
      const existingRevisionIds = new Set(
        loaded.aggregate.participantRevisions.map((record) => record.id)
      );
      for (const [index, participant] of input.participants.entries()) {
        const revision = input.participantRevisions[index]!;
        if (
          participant.conversationId !== input.conversationId ||
          revision.conversationId !== input.conversationId ||
          revision.stableParticipantId !== participant.id ||
          participant.currentRevisionId !== revision.id ||
          existingParticipantIds.has(participant.id) ||
          existingRevisionIds.has(revision.id)
        ) {
          throw new Error('Discourse roster update contains invalid participant ownership.');
        }
      }
      const conversation: DiscourseConversationRecord = {
        ...loaded.aggregate.conversation,
        participantIds: [
          ...loaded.aggregate.conversation.participantIds,
          ...input.participants.map((participant) => participant.id)
        ],
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: requireTimestamp(this.now())
      };
      const event = await handle.log.append({
        kind: 'ROSTER_UPDATED',
        operationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({
          conversation,
          participants: input.participants,
          participantRevisions: input.participantRevisions
        })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) {
        return clone(loaded.aggregate);
      }
      return this.publishConversationEvent(handle, loaded, event, () =>
        clone(applyEvent(loaded, event).aggregate)
      );
    });
  }

  appendHumanMessage(
    input: AppendHumanDiscourseMessageInput
  ): Promise<DiscourseMessageRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      if (loaded.aggregate.conversation.status !== 'OPEN') {
        throw new Error('Archived discourse conversations cannot accept messages.');
      }
      validateMessageBody(input.body);
      validateOperationId(input.clientMessageId);
      const sourceMessageIds = uniqueIds(input.sourceMessageIds ?? []);
      const context = normalizeResolvedContext(input.context ?? []);
      const fingerprint = hashRequest({
        conversationId: input.conversationId,
        body: input.body,
        replyToMessageId: input.replyToMessageId ?? null,
        supersedesMessageId: input.supersedesMessageId ?? null,
        sourceMessageIds,
        context
      });
      const messageId = this.createId();
      const now = requireTimestamp(this.now());
      const contextUpdate = buildMessageContextUpdate({
        loaded,
        messageId,
        context,
        createId: this.createId,
        now
      });
      const message: DiscourseMessageRecord = {
        id: messageId,
        conversationId: input.conversationId,
        ordinal: loaded.aggregate.conversation.latestOrdinal + 1,
        author: { kind: 'USER' },
        body: input.body,
        status: 'VISIBLE',
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        ...(input.supersedesMessageId
          ? { supersedesMessageId: input.supersedesMessageId }
          : {}),
        sourceMessageIds,
        ...(contextUpdate.revision ? { contextRevisionId: contextUpdate.revision.id } : {}),
        clientMessageId: input.clientMessageId,
        requestFingerprint: fingerprint,
        createdAt: now
      };
      assertMessageAgainstHeaders(loaded, message);
      if (input.supersedesMessageId) {
        const superseded = loaded.messageHeaders.get(input.supersedesMessageId);
        if (!superseded || superseded.status !== 'VISIBLE') {
          throw new Error('Only a visible discourse message can be corrected.');
        }
      }
      const conversation: DiscourseConversationRecord = {
        ...loaded.aggregate.conversation,
        latestOrdinal: message.ordinal,
        readOrdinal: message.ordinal,
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: message.createdAt
      };
      const event = await handle.log.append({
        kind: 'MESSAGE_APPENDED',
        operationId: `message:${input.clientMessageId}`,
        requestFingerprint: fingerprint,
        payload: toJsonValue({
          message,
          conversation,
          contextLinks: contextUpdate.links,
          contextRevision: contextUpdate.revision ?? null,
          supersededMessageId: input.supersedesMessageId ?? null
        })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) {
        return requireEventMessage(event);
      }
      return this.publishConversationEvent(handle, loaded, event, () =>
        requireEventMessage(event)
      );
    });
  }

  appendAgentMessage(
    input: AppendAgentDiscourseMessageInput
  ): Promise<DiscourseMessageRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      if (loaded.aggregate.conversation.status !== 'OPEN') {
        throw new Error('Archived discourse conversations cannot accept messages.');
      }
      validateAgentContribution(input.body);
      validateOperationId(input.clientOperationId);
      const job = loaded.aggregate.jobs.find((candidate) => candidate.id === input.jobId);
      if (
        !job ||
        job.waveId !== input.waveId ||
        job.assignment.stableParticipantId !== input.stableParticipantId ||
        job.assignment.participantRevisionId !== input.participantRevisionId ||
        job.assignment.displayNameSnapshot !== input.displayNameSnapshot
      ) {
        throw new Error('Discourse agent message does not match its durable job assignment.');
      }
      const sourceMessageIds = uniqueIds(input.sourceMessageIds);
      const fingerprint = hashRequest({
        ...input,
        sourceMessageIds
      });
      const operationId = `agent-message:${input.clientOperationId}`;
      const replay = await findConversationEvent(handle.log, operationId, fingerprint);
      if (replay) return requireEventMessage(replay);
      if (
        [...loaded.messageHeaders.values()].some((header) => header.jobId === input.jobId)
      ) {
        throw new Error('A discourse job cannot publish more than one visible message.');
      }
      const message: DiscourseMessageRecord = {
        id: this.createId(),
        conversationId: input.conversationId,
        ordinal: loaded.aggregate.conversation.latestOrdinal + 1,
        author: {
          kind: 'AGENT',
          stableParticipantId: input.stableParticipantId,
          participantRevisionId: input.participantRevisionId,
          displayNameSnapshot: input.displayNameSnapshot
        },
        body: input.body,
        status: 'VISIBLE',
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        ...(input.supersedesMessageId
          ? { supersedesMessageId: input.supersedesMessageId }
          : {}),
        sourceMessageIds,
        waveId: input.waveId,
        jobId: input.jobId,
        ...(input.contextSnapshotId ? { contextSnapshotId: input.contextSnapshotId } : {}),
        freshnessAtCompletion: input.freshnessAtCompletion,
        createdAt: requireTimestamp(this.now())
      };
      assertMessageAgainstHeaders(loaded, message);
      const conversation: DiscourseConversationRecord = {
        ...loaded.aggregate.conversation,
        latestOrdinal: message.ordinal,
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: message.createdAt
      };
      const event = await handle.log.append({
        kind: 'AGENT_MESSAGE_APPENDED',
        operationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ message, conversation })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) {
        return requireEventMessage(event);
      }
      return this.publishConversationEvent(handle, loaded, event, () =>
        requireEventMessage(event)
      );
    });
  }

  tombstoneMessage(input: {
    conversationId: string;
    messageId: string;
    expectedConversationRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      requireSafeId(input.messageId, 'message id');
      validateOperationId(input.clientOperationId);
      const operationId = `message-tombstone:${input.clientOperationId}`;
      const fingerprint = hashRequest(input);
      if (loaded.aggregate.conversation.recordRevision !== input.expectedConversationRevision) {
        const replay = await findConversationEvent(handle.log, operationId, fingerprint);
        if (replay) return requireEventConversation(replay);
        throw new Error('Discourse conversation changed before message deletion.');
      }
      const header = loaded.messageHeaders.get(input.messageId);
      if (!header || header.author.kind !== 'USER') {
        throw new Error('Only an existing human message can be deleted.');
      }
      if (header.status === 'TOMBSTONE') {
        throw new Error('The discourse message is already deleted.');
      }
      const conversation: DiscourseConversationRecord = {
        ...loaded.aggregate.conversation,
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: requireTimestamp(this.now())
      };
      const event = await handle.log.append({
        kind: 'MESSAGE_TOMBSTONED',
        operationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ messageId: input.messageId, conversation })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) {
        return requireEventConversation(event);
      }
      return this.publishConversationEvent(handle, loaded, event, () => conversation);
    });
  }

  async listMessages(input: {
    conversationId: string;
    beforeCursor?: string;
    limit?: number;
  }): Promise<DiscourseMessagePage> {
    await this.init();
    requireSafeId(input.conversationId, 'conversation id');
    assertConversationNotDeleted(this.index, input.conversationId);
    if (!this.index.summaries.some((summary) => summary.id === input.conversationId)) {
      throw new Error(`Discourse conversation not found: ${input.conversationId}`);
    }
    const limit = input.limit ?? DISCOURSE_LIMITS.transcriptPageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DISCOURSE_LIMITS.transcriptPageSize) {
      throw new Error('Discourse message page limit is invalid.');
    }
    const handle = this.getHandle(input.conversationId);
    const loaded = await this.loadConversation(input.conversationId);
    let before = decodeSequenceCursor(input.beforeCursor);
    const messages: DiscourseMessageRecord[] = [];
    let previousCursor: string | undefined;
    while (messages.length < limit) {
      const page = await handle.log.readPageBefore({
        ...(before ? { beforeSequence: before } : {}),
        limit: limit - messages.length
      });
      if (page.events.length === 0) break;
      const selected = page.events.flatMap((event) =>
        event.kind === 'MESSAGE_APPENDED' || event.kind === 'AGENT_MESSAGE_APPENDED'
          ? [applyMessagePresentationState(requireEventMessage(event), loaded)]
          : []
      );
      messages.unshift(...selected);
      const earliestSequence = page.events[0]!.sequence;
      if (!page.previousCursor) {
        previousCursor = undefined;
        break;
      }
      previousCursor = encodeSequenceCursor(earliestSequence);
      before = earliestSequence;
    }
    return { messages: clone(messages), ...(previousCursor ? { previousCursor } : {}) };
  }

  renameConversation(input: {
    conversationId: string;
    title: string;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateTitle(input.title);
      validateOperationId(input.clientOperationId);
      const fingerprint = hashRequest({
        conversationId: input.conversationId,
        title: input.title.trim(),
        expectedRevision: input.expectedRevision
      });
      if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(
          handle.log,
          `conversation:${input.clientOperationId}`,
          fingerprint
        );
        if (replay) return requireEventConversation(replay);
        throw new Error('Discourse conversation changed before rename.');
      }
      const conversation = {
        ...loaded.aggregate.conversation,
        title: input.title.trim(),
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: requireTimestamp(this.now())
      };
      const event = await handle.log.append({
        kind: 'CONVERSATION_UPDATED',
        operationId: `conversation:${input.clientOperationId}`,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ conversation })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) {
        return requireEventConversation(event);
      }
      return this.publishConversationEvent(handle, loaded, event, () => conversation);
    });
  }

  setConversationReadOrdinal(input: {
    conversationId: string;
    readOrdinal: number;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      if (
        !Number.isSafeInteger(input.readOrdinal) ||
        input.readOrdinal < 0 ||
        input.readOrdinal > loaded.aggregate.conversation.latestOrdinal
      ) {
        throw new Error('Discourse read ordinal is invalid.');
      }
      const fingerprint = hashRequest(input);
      if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(
          handle.log,
          `conversation:${input.clientOperationId}`,
          fingerprint
        );
        if (replay) return requireEventConversation(replay);
        // Read acknowledgements are monotonic and auxiliary. Two guarded
        // conversation loads can legitimately acknowledge the same ordinal at
        // once; once either succeeds, the other request is already satisfied
        // and must not surface as a failed mutation.
        if (loaded.aggregate.conversation.readOrdinal >= input.readOrdinal) {
          return loaded.aggregate.conversation;
        }
        throw new Error('Discourse conversation changed before marking read.');
      }
      const conversation = {
        ...loaded.aggregate.conversation,
        readOrdinal: input.readOrdinal,
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: requireTimestamp(this.now())
      };
      const event = await handle.log.append({
        kind: 'CONVERSATION_UPDATED',
        operationId: `conversation:${input.clientOperationId}`,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ conversation })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) {
        return requireEventConversation(event);
      }
      return this.publishConversationEvent(handle, loaded, event, () => conversation);
    });
  }

  setConversationArchived(input: {
    conversationId: string;
    archived: boolean;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      const fingerprint = hashRequest(input);
      const operationId = `conversation:${input.clientOperationId}`;
      if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(handle.log, operationId, fingerprint);
        if (replay) return requireEventConversation(replay);
        throw new Error('Discourse conversation changed before archive update.');
      }
      const now = requireTimestamp(this.now());
      const conversation: DiscourseConversationRecord = {
        ...loaded.aggregate.conversation,
        status: input.archived ? 'ARCHIVED' : 'OPEN',
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: now,
        ...(input.archived
          ? { archivedAt: now }
          : { archivedAt: undefined })
      };
      const event = await handle.log.append({
        kind: 'CONVERSATION_UPDATED',
        operationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ conversation })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) {
        return requireEventConversation(event);
      }
      return this.publishConversationEvent(handle, loaded, event, () => conversation);
    });
  }

  async deleteConversation(input: {
    conversationId: string;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationTombstoneRecord> {
    await this.init();
    requireSafeId(input.conversationId, 'conversation id');
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest(input);
    const indexed = this.index.tombstones.find(
      (tombstone) => tombstone.conversationId === input.conversationId
    );
    if (indexed) {
      if (
        indexed.clientOperationId !== input.clientOperationId ||
        indexed.requestFingerprint !== fingerprint
      ) {
        throw new Error('REQUEST_CONFLICT: conversation was already deleted.');
      }
      await this.cleanupDeletedConversation(input.conversationId);
      return clone(indexed);
    }
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      const operationId = `delete:${input.clientOperationId}`;
      if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(handle.log, operationId, fingerprint);
        if (!replay) throw new Error('Discourse conversation changed before deletion.');
        const tombstone = requireEventTombstone(replay);
        await this.publishTombstone(tombstone);
        await this.cleanupDeletedConversation(input.conversationId);
        return tombstone;
      }
      const tombstone: DiscourseConversationTombstoneRecord = {
        conversationId: input.conversationId,
        deletedAt: requireTimestamp(this.now()),
        clientOperationId: input.clientOperationId,
        requestFingerprint: fingerprint,
        lastEventSequence: loaded.aggregate.latestEventSequence + 1
      };
      const event = await handle.log.append({
        kind: 'CONVERSATION_DELETED',
        operationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ tombstone })
      });
      const durable = requireEventTombstone(event);
      if (event.sequence > loaded.aggregate.latestEventSequence) {
        handle.loaded = applyEvent(loaded, event);
      }
      await this.publishTombstone(durable);
      await this.cleanupDeletedConversation(input.conversationId);
      return durable;
    });
  }

  async getConversationTombstone(
    conversationId: string
  ): Promise<DiscourseConversationTombstoneRecord | undefined> {
    await this.init();
    requireSafeId(conversationId, 'conversation id');
    return clone(
      this.index.tombstones.find(
        (tombstone) => tombstone.conversationId === conversationId
      )
    );
  }

  setPinnedContext(input: {
    conversationId: string;
    context: DiscourseContextSelectionSnapshot[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<ConversationContextRevisionRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      const context = normalizeResolvedContext(input.context);
      const operationId = `context:${input.clientOperationId}`;
      const fingerprint = hashRequest({ ...input, context });
      if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(handle.log, operationId, fingerprint);
        if (replay) return requireEventContextRevision(replay);
        throw new Error('Discourse conversation changed before pinned context update.');
      }
      const now = requireTimestamp(this.now());
      const links: ConversationContextLinkRecord[] = context.map((reference) => ({
        id: this.createId(),
        conversationId: input.conversationId,
        scope: 'PINNED',
        entityKind: reference.entityKind,
        entityId: reference.entityId,
        availability: reference.availability,
        recordRevision: 1,
        createdAt: now,
        updatedAt: now
      }));
      const revision: ConversationContextRevisionRecord = {
        id: this.createId(),
        conversationId: input.conversationId,
        revision: (loaded.aggregate.contextRevisions.at(-1)?.revision ?? 0) + 1,
        references: links.map((link, index) => ({
          contextLinkId: link.id,
          entityKind: link.entityKind,
          entityId: link.entityId,
          labelSnapshot: context[index]!.labelSnapshot,
          availability: link.availability,
          scope: 'PINNED'
        })),
        createdAt: now
      };
      const conversation: DiscourseConversationRecord = {
        ...loaded.aggregate.conversation,
        pinnedContextRevisionId: revision.id,
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: now
      };
      const event = await handle.log.append({
        kind: 'CONTEXT_PINNED',
        operationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ links, revision, conversation })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) {
        return requireEventContextRevision(event);
      }
      return this.publishConversationEvent(handle, loaded, event, () => revision);
    });
  }

  saveDraft(input: {
    draftId?: string;
    conversationId?: string;
    expectedRevision?: number;
    body: string;
    replyToMessageId?: string;
    policy: DiscourseDraftRecord['policy'];
    recipientParticipantIds: string[];
    tokens: DiscourseDraftTokenInput[];
  }): Promise<DiscourseDraftRecord> {
    return this.enqueueGlobal(async () => {
      await this.init();
      const id = input.draftId ?? this.createId();
      requireSafeId(id, 'draft id');
      if (input.conversationId) {
        requireSafeId(input.conversationId, 'conversation id');
        assertConversationNotDeleted(this.index, input.conversationId);
        if (!this.index.summaries.some((summary) => summary.id === input.conversationId)) {
          throw new Error(`Discourse conversation not found: ${input.conversationId}`);
        }
      }
      validateDraftInput(input);
      const existing = await this.readDraft(id);
      if (existing && input.expectedRevision !== existing.recordRevision) {
        throw new Error('Discourse draft changed before it could be saved.');
      }
      if (!existing && input.expectedRevision !== undefined && input.expectedRevision !== 0) {
        throw new Error('Discourse draft does not exist at the expected revision.');
      }
      const draft: DiscourseDraftRecord = {
        id,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        recordRevision: (existing?.recordRevision ?? 0) + 1,
        body: input.body,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        policy: input.policy,
        recipientParticipantIds: uniqueIds(input.recipientParticipantIds),
        tokens: normalizeDraftTokens(input.tokens),
        updatedAt: requireTimestamp(this.now())
      };
      const unsigned = { schemaVersion: DISCOURSE_STORE_SCHEMA_VERSION, draft };
      const file: DiscourseDraftFile = { ...unsigned, checksum: checksum(unsigned) };
      await atomicPrivateWrite(this.draftsDir, this.draftPath(id), `${JSON.stringify(file)}\n`);
      return clone(draft);
    });
  }

  async getDraft(draftId: string): Promise<DiscourseDraftRecord | undefined> {
    await this.init();
    requireSafeId(draftId, 'draft id');
    return clone(await this.readDraft(draftId));
  }

  async listDrafts(): Promise<DiscourseDraftRecord[]> {
    await this.init();
    const ids = (await fs.readdir(this.draftsDir))
      .flatMap((file) => file.endsWith('.json') ? [file.slice(0, -5)] : [])
      .filter((id) => SAFE_ID.test(id));
    if (ids.length > DISCOURSE_LIMITS.maxConversationSummariesInSnapshot + 1) {
      throw new Error('Discourse draft directory exceeds its safety limit.');
    }
    const drafts = (await Promise.all(ids.map((id) => this.readDraft(id))))
      .filter((draft): draft is DiscourseDraftRecord => Boolean(draft))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return clone(drafts);
  }

  deleteDraft(input: { draftId: string; expectedRevision: number }): Promise<void> {
    return this.enqueueGlobal(async () => {
      await this.init();
      requireSafeId(input.draftId, 'draft id');
      const existing = await this.readDraft(input.draftId);
      if (!existing) return;
      if (existing.recordRevision !== input.expectedRevision) {
        throw new Error('Discourse draft changed before it could be deleted.');
      }
      await fs.unlink(this.draftPath(input.draftId));
      await syncDirectoryIfSupported(this.draftsDir);
    });
  }

  createWave(input: CreateDiscourseWaveInput): Promise<{
    wave: DiscourseResponseWaveRecord;
    jobs: DiscourseAgentJobRecord[];
  }> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      if (loaded.aggregate.conversation.recordRevision !== input.expectedConversationRevision) {
        const replay = await findConversationEvent(
          handle.log,
          `wave:${input.clientOperationId}`,
          hashRequest(input)
        );
        if (replay) return requireWavePlanEvent(replay);
        throw new Error('Discourse conversation changed before wave planning.');
      }
      if (loaded.aggregate.conversation.status !== 'OPEN') {
        throw new Error('Archived discourse conversations cannot plan response waves.');
      }
      if (
        loaded.aggregate.waves.filter((wave) => wave.status !== 'SETTLED').length >= 8
      ) {
        throw new Error('Discourse conversation has reached its queued-wave safety limit.');
      }
      assertWavePlan(input, loaded);
      const conversation = {
        ...loaded.aggregate.conversation,
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: requireTimestamp(this.now())
      };
      const fingerprint = hashRequest(input);
      const event = await handle.log.append({
        kind: 'WAVE_PLANNED',
        operationId: `wave:${input.clientOperationId}`,
        requestFingerprint: fingerprint,
        payload: toJsonValue({
          conversation,
          wave: input.wave,
          jobs: input.jobs,
          contextSnapshot: input.contextSnapshot
        })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) {
        return requireWavePlanEvent(event);
      }
      return this.publishConversationEvent(handle, loaded, event, () => ({
        wave: input.wave,
        jobs: input.jobs
      }));
    });
  }

  addJobsToWave(input: {
    conversationId: string;
    waveId: string;
    jobs: DiscourseAgentJobRecord[];
    expectedConversationRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord[]> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      const fingerprint = hashRequest(input);
      const operationId = `wave-jobs:${input.clientOperationId}`;
      if (loaded.aggregate.conversation.recordRevision !== input.expectedConversationRevision) {
        const replay = await findConversationEvent(handle.log, operationId, fingerprint);
        if (replay) return requireAddedJobs(replay);
        throw new Error('Discourse conversation changed before downstream job planning.');
      }
      const wave = loaded.aggregate.waves.find((candidate) => candidate.id === input.waveId);
      if (!wave || wave.status === 'SETTLED') {
        throw new Error('Discourse downstream jobs require an active wave.');
      }
      if (input.jobs.length === 0 || loaded.aggregate.jobs.filter((job) => job.waveId === wave.id).length + input.jobs.length > DISCOURSE_LIMITS.maxTeamJobs) {
        throw new Error('Discourse downstream job plan exceeds its safety limit.');
      }
      for (const job of input.jobs) {
        assertNewDownstreamJob(job, wave, loaded);
      }
      const conversation: DiscourseConversationRecord = {
        ...loaded.aggregate.conversation,
        recordRevision: loaded.aggregate.conversation.recordRevision + 1,
        updatedAt: requireTimestamp(this.now())
      };
      const event = await handle.log.append({
        kind: 'WAVE_JOBS_ADDED',
        operationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ conversation, waveId: wave.id, jobs: input.jobs })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) return requireAddedJobs(event);
      return this.publishConversationEvent(handle, loaded, event, () => input.jobs);
    });
  }

  completeReviewJob(input: {
    conversationId: string;
    job: DiscourseAgentJobRecord;
    concerns: DiscourseConcernRecord[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      const fingerprint = hashRequest(input);
      const operationId = `review-terminal:${input.clientOperationId}`;
      const existing = loaded.aggregate.jobs.find((candidate) => candidate.id === input.job.id);
      if (!existing) throw new Error(`Discourse review job not found: ${input.job.id}`);
      if (existing.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(handle.log, operationId, fingerprint);
        if (replay) return requireEventJob(replay);
        throw new Error('Discourse review job changed before terminal ingestion.');
      }
      if (
        existing.role !== 'CRITIQUE' ||
        input.job.status !== 'COMPLETED' ||
        input.job.result?.kind !== 'REVIEW' ||
        input.job.recordRevision !== existing.recordRevision + 1
      ) {
        throw new Error('Discourse review terminal is invalid.');
      }
      assertDiscourseJobTransition(existing.status, input.job.status);
      assertDiscourseJobRecord(input.job);
      const resultConcernIds = new Set(input.job.result.concernIds);
      const suppliedConcernIds = new Set(input.concerns.map((concern) => concern.id));
      if (
        resultConcernIds.size !== suppliedConcernIds.size ||
        [...resultConcernIds].some((concernId) => !suppliedConcernIds.has(concernId))
      ) {
        throw new Error('Discourse review result concern ids do not match its concern records.');
      }
      const existingConcernIds = new Set(loaded.aggregate.concerns.map((concern) => concern.id));
      for (const concern of input.concerns) {
        if (
          existingConcernIds.has(concern.id) ||
          concern.conversationId !== input.conversationId ||
          concern.waveId !== existing.waveId ||
          concern.reviewJobId !== existing.id ||
          concern.reviewerParticipantRevisionId !== existing.assignment.participantRevisionId ||
          !existing.targetMessageIds.includes(concern.targetMessageId) ||
          concern.recordRevision !== 1
        ) {
          throw new Error('Discourse review concern ownership is invalid.');
        }
        requireTimestamp(concern.createdAt);
        existingConcernIds.add(concern.id);
      }
      const event = await handle.log.append({
        kind: 'REVIEW_COMPLETED',
        operationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ job: input.job, concerns: input.concerns })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) return requireEventJob(event);
      return this.publishConversationEvent(handle, loaded, event, () => input.job);
    });
  }

  completeCorrectionJob(input: {
    conversationId: string;
    job: DiscourseAgentJobRecord;
    concernIds: string[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      const fingerprint = hashRequest(input);
      const operationId = `correction-terminal:${input.clientOperationId}`;
      const existing = loaded.aggregate.jobs.find((candidate) => candidate.id === input.job.id);
      if (!existing) throw new Error(`Discourse correction job not found: ${input.job.id}`);
      if (existing.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(handle.log, operationId, fingerprint);
        if (replay) return requireEventJob(replay);
        throw new Error('Discourse correction job changed before terminal ingestion.');
      }
      const correctionResult = input.job.result;
      if (
        existing.role !== 'CORRECT' ||
        input.job.status !== 'COMPLETED' ||
        correctionResult?.kind !== 'CORRECTION' ||
        input.job.recordRevision !== existing.recordRevision + 1
      ) {
        throw new Error('Discourse correction terminal is invalid.');
      }
      assertDiscourseJobTransition(existing.status, input.job.status);
      assertDiscourseJobRecord(input.job);
      if (new Set(input.concernIds).size !== input.concernIds.length) {
        throw new Error('Discourse correction concern ids must be unique.');
      }
      const concernIds = new Set(input.concernIds);
      const concerns = loaded.aggregate.concerns
        .filter((concern) => concernIds.has(concern.id))
        .map((concern): DiscourseConcernRecord => ({
          ...concern,
          recordRevision: concern.recordRevision + 1,
          resolution: {
            correctionJobId: input.job.id,
            ...(correctionResult.outputMessageId
              ? { correctionMessageId: correctionResult.outputMessageId }
              : {}),
            outcome: correctionResult.outcome
          }
        }));
      if (
        concerns.length !== concernIds.size ||
        concerns.some(
          (concern) =>
            concern.conversationId !== input.conversationId ||
            concern.waveId !== existing.waveId ||
            concern.resolution?.correctionJobId !== existing.id
        )
      ) {
        throw new Error('Discourse correction references an unknown concern.');
      }
      const event = await handle.log.append({
        kind: 'CORRECTION_COMPLETED',
        operationId,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ job: input.job, concerns })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) return requireEventJob(event);
      return this.publishConversationEvent(handle, loaded, event, () => input.job);
    });
  }

  updateWave(input: {
    conversationId: string;
    wave: DiscourseResponseWaveRecord;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseResponseWaveRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      const fingerprint = hashRequest(input);
      const existing = loaded.aggregate.waves.find((wave) => wave.id === input.wave.id);
      if (!existing) throw new Error(`Discourse wave not found: ${input.wave.id}`);
      if (existing.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(
          handle.log,
          `wave-update:${input.clientOperationId}`,
          fingerprint
        );
        if (replay) return requireEventWave(replay);
        throw new Error('Discourse wave changed before update.');
      }
      assertImmutableWave(existing, input.wave);
      if (input.wave.recordRevision !== existing.recordRevision + 1) {
        throw new Error('Discourse wave update requires the next record revision.');
      }
      if (input.wave.status !== existing.status) {
        assertDiscourseWaveTransition(existing.status, input.wave.status);
      }
      assertDiscourseWaveRecord(input.wave);
      const event = await handle.log.append({
        kind: 'WAVE_UPDATED',
        operationId: `wave-update:${input.clientOperationId}`,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ wave: input.wave })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) return requireEventWave(event);
      return this.publishConversationEvent(handle, loaded, event, () => input.wave);
    });
  }

  updateJob(input: {
    conversationId: string;
    job: DiscourseAgentJobRecord;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord> {
    return this.withConversation(input.conversationId, async (handle, loaded) => {
      validateOperationId(input.clientOperationId);
      const fingerprint = hashRequest(input);
      const existing = loaded.aggregate.jobs.find((job) => job.id === input.job.id);
      if (!existing) throw new Error(`Discourse job not found: ${input.job.id}`);
      if (existing.recordRevision !== input.expectedRevision) {
        const replay = await findConversationEvent(
          handle.log,
          `job-update:${input.clientOperationId}`,
          fingerprint
        );
        if (replay) return requireEventJob(replay);
        throw new Error('Discourse job changed before update.');
      }
      assertImmutableJob(existing, input.job);
      if (input.job.recordRevision !== existing.recordRevision + 1) {
        throw new Error('Discourse job update requires the next record revision.');
      }
      if (input.job.status !== existing.status) {
        assertDiscourseJobTransition(existing.status, input.job.status);
      }
      if (input.job.delivery !== existing.delivery) {
        if (existing.delivery === 'AMBIGUOUS') {
          if (
            input.job.delivery !== 'ACKNOWLEDGED' &&
            input.job.delivery !== 'NOT_DELIVERED' &&
            input.job.delivery !== 'TERMINAL'
          ) {
            throw new Error('Invalid authoritative discourse delivery reconciliation.');
          }
          reconcileDiscourseDelivery(existing.delivery, input.job.delivery);
        } else {
          assertDiscourseDeliveryTransition(existing.delivery, input.job.delivery);
        }
      }
      assertDiscourseJobRecord(input.job);
      assertJobResultMessageLink(input.job, loaded);
      const event = await handle.log.append({
        kind: 'JOB_UPDATED',
        operationId: `job-update:${input.clientOperationId}`,
        requestFingerprint: fingerprint,
        payload: toJsonValue({ job: input.job })
      });
      if (event.sequence <= loaded.aggregate.latestEventSequence) return requireEventJob(event);
      return this.publishConversationEvent(handle, loaded, event, () => input.job);
    });
  }

  private async publishConversationEvent<T>(
    handle: ConversationHandle,
    loaded: LoadedConversation,
    event: DiscourseLogEvent,
    result: () => T
  ): Promise<T> {
    const next = applyEvent(loaded, event);
    handle.loaded = next;
    try {
      await this.persistConversationMetadata(next);
      await this.updateIndexSummary(summaryFromLoaded(next));
    } catch (error) {
      handle.loaded = undefined;
      throw error;
    }
    return clone(result());
  }

  private async updateIndexSummary(summary: DiscourseConversationSummary): Promise<void> {
    await this.enqueueGlobal(async () => {
      const summaries = this.index.summaries.filter((candidate) => candidate.id !== summary.id);
      this.index = {
        ...this.index,
        revision: this.index.revision + 1,
        summaries: [summary, ...summaries]
      };
      await this.persistIndex();
    });
  }

  private async publishTombstone(
    tombstone: DiscourseConversationTombstoneRecord
  ): Promise<void> {
    await this.enqueueGlobal(async () => {
      const existing = this.index.tombstones.find(
        (candidate) => candidate.conversationId === tombstone.conversationId
      );
      if (existing && stableStringify(existing) !== stableStringify(tombstone)) {
        throw new Error('Discourse deletion tombstone is contradictory.');
      }
      this.index = {
        ...this.index,
        revision: this.index.revision + 1,
        summaries: this.index.summaries.filter(
          (summary) => summary.id !== tombstone.conversationId
        ),
        createOperations: this.index.createOperations.filter(
          (operation) => operation.conversationId !== tombstone.conversationId
        ),
        tombstones: existing
          ? this.index.tombstones
          : [...this.index.tombstones, tombstone]
      };
      await this.persistIndex();
    });
  }

  private async cleanupDeletedConversation(conversationId: string): Promise<void> {
    const directory = path.join(this.conversationsDir, conversationId);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
        throw new Error('Deleted discourse conversation directory failed its integrity check.');
      }
      await fs.rm(directory, { recursive: true, force: false });
      await syncDirectoryIfSupported(this.conversationsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.handles.delete(conversationId);
  }

  private withConversation<T>(
    conversationId: string,
    operation: (handle: ConversationHandle, loaded: LoadedConversation) => Promise<T>
  ): Promise<T> {
    requireSafeId(conversationId, 'conversation id');
    assertConversationNotDeleted(this.index, conversationId);
    const handle = this.getHandle(conversationId);
    const queued = handle.queue.catch(() => undefined).then(async () => {
      await this.init();
      assertConversationNotDeleted(this.index, conversationId);
      const loaded = handle.loaded ?? (await this.loadConversationUnqueued(conversationId, handle));
      try {
        return await operation(handle, loaded);
      } catch (error) {
        handle.loaded = undefined;
        throw error;
      }
    });
    handle.queue = queued.catch(() => undefined);
    return queued;
  }

  private async loadConversation(conversationId: string): Promise<LoadedConversation> {
    requireSafeId(conversationId, 'conversation id');
    const handle = this.getHandle(conversationId);
    if (handle.loaded) return handle.loaded;
    const queued = handle.queue.catch(() => undefined).then(() =>
      handle.loaded ?? this.loadConversationUnqueued(conversationId, handle)
    );
    handle.queue = queued.catch(() => undefined);
    return queued;
  }

  private async loadConversationUnqueued(
    conversationId: string,
    handle: ConversationHandle
  ): Promise<LoadedConversation> {
    let cursor = 0;
    let loaded: LoadedConversation | undefined;
    while (true) {
      const page = await handle.log.readPage({ afterSequence: cursor, limit: 200 });
      for (const event of page.events) {
        loaded = event.kind === 'CONVERSATION_CREATED' && !loaded
          ? applyEvent(emptyLoaded(requireEventConversation(event)), event)
          : loaded
            ? applyEvent(loaded, event)
            : undefined;
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (!loaded) throw new Error(`Discourse conversation not found or corrupt: ${conversationId}`);
    if (loaded.aggregate.conversation.id !== conversationId) {
      throw new Error('Discourse conversation directory does not match its durable owner.');
    }
    handle.loaded = loaded;
    return loaded;
  }

  private getHandle(conversationId: string): ConversationHandle {
    requireSafeId(conversationId, 'conversation id');
    let handle = this.handles.get(conversationId);
    if (!handle) {
      handle = {
        log: new FileDiscourseEventLog(
          path.join(this.conversationsDir, conversationId),
          this.options.eventLogOptions
        ),
        queue: Promise.resolve()
      };
      this.handles.set(conversationId, handle);
    }
    return handle;
  }

  private draftPath(draftId: string): string {
    requireSafeId(draftId, 'draft id');
    return path.join(this.draftsDir, `${draftId}.json`);
  }

  private async readDraft(draftId: string): Promise<DiscourseDraftRecord | undefined> {
    const parsed = await readPrivateJson(this.draftPath(draftId), MAX_DRAFT_BYTES);
    if (parsed === undefined) return undefined;
    const record = requireRecord(parsed, 'draft file');
    const { checksum: storedChecksum, ...unsigned } = record;
    if (
      record.schemaVersion !== DISCOURSE_STORE_SCHEMA_VERSION ||
      typeof storedChecksum !== 'string' ||
      storedChecksum !== checksum(unsigned) ||
      !record.draft || typeof record.draft !== 'object' || Array.isArray(record.draft)
    ) {
      throw new Error('Discourse draft file failed its integrity check.');
    }
    const draft = record.draft as unknown as DiscourseDraftRecord;
    validateDraftRecord(draft, draftId);
    return draft;
  }

  private async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.rootDir);
    await ensurePrivateDirectory(this.conversationsDir);
    await ensurePrivateDirectory(this.draftsDir);
    const storedIndex = await readCheckedIndex(this.indexPath);
    this.index = storedIndex ?? emptyIndex();
    const discovered = (await fs.readdir(this.conversationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
      .map((entry) => entry.name);
    if (discovered.length > DISCOURSE_LIMITS.maxConversationSummariesInSnapshot) {
      throw new Error('Discourse conversation directory exceeds its safety limit.');
    }
    const summaries: DiscourseConversationSummary[] = [];
    const metadataCreateOperations: DiscourseCreateOperation[] = [];
    const recoveredTombstones: DiscourseConversationTombstoneRecord[] = [];
    for (const conversationId of discovered) {
      const metadata = await readCheckedMetadata(
        path.join(this.conversationsDir, conversationId, METADATA_FILE),
        conversationId
      );
      const handle = this.getHandle(conversationId);
      const durableSummary = await handle.log.inspectDurableSummary();
      const latestSequence =
        durableSummary?.latestSequence ?? (await handle.log.latestSequence());
      if (latestSequence === 0) continue;
      if (metadata && metadata.lastAppliedEventSequence === latestSequence) {
        summaries.push(metadata.summary);
        metadataCreateOperations.push(metadata.createOperation);
      } else {
        const loaded = await this.loadConversationUnqueued(conversationId, handle);
        if (loaded.tombstone) {
          recoveredTombstones.push(loaded.tombstone);
        } else {
          summaries.push(summaryFromLoaded(loaded));
          if (loaded.createOperation) metadataCreateOperations.push(loaded.createOperation);
          await this.persistConversationMetadata(loaded);
        }
      }
    }
    const tombstones = dedupeTombstones([
      ...this.index.tombstones,
      ...recoveredTombstones
    ]);
    const tombstoneIds = new Set(tombstones.map((tombstone) => tombstone.conversationId));
    const liveSummaries = summaries.filter((summary) => !tombstoneIds.has(summary.id));
    const discoveredIds = new Set(summaries.map((summary) => summary.id));
    const createOperations = dedupeCreateOperations(
      [
        ...metadataCreateOperations,
        ...this.index.createOperations.filter((operation) =>
          discoveredIds.has(operation.conversationId)
        )
      ]
    );
    if (
      stableStringify([...liveSummaries].sort(compareSummaries)) !==
        stableStringify([...this.index.summaries].sort(compareSummaries)) ||
      stableStringify(createOperations) !== stableStringify(this.index.createOperations) ||
      stableStringify(tombstones) !== stableStringify(this.index.tombstones)
    ) {
      this.index = {
        ...this.index,
        revision: this.index.revision + 1,
        summaries: liveSummaries,
        createOperations: createOperations.filter(
          (operation) => !tombstoneIds.has(operation.conversationId)
        ),
        tombstones
      };
      await this.persistIndex();
    }
    for (const tombstone of tombstones) {
      await this.cleanupDeletedConversation(tombstone.conversationId);
    }
  }

  private async persistConversationMetadata(loaded: LoadedConversation): Promise<void> {
    const unsigned = {
      schemaVersion: DISCOURSE_STORE_SCHEMA_VERSION,
      conversationId: loaded.aggregate.conversation.id,
      lastAppliedEventSequence: loaded.aggregate.latestEventSequence,
      summary: summaryFromLoaded(loaded),
      createOperation:
        loaded.createOperation ??
        (() => {
          throw new Error('Discourse conversation metadata is missing its create operation.');
        })()
    };
    const metadata: DiscourseConversationMetadata = {
      ...unsigned,
      checksum: checksum(unsigned)
    };
    await atomicPrivateWrite(
      path.join(this.conversationsDir, loaded.aggregate.conversation.id),
      path.join(
        this.conversationsDir,
        loaded.aggregate.conversation.id,
        METADATA_FILE
      ),
      `${JSON.stringify(metadata)}\n`
    );
  }

  private async persistIndex(): Promise<void> {
    const unsigned = {
      schemaVersion: DISCOURSE_STORE_SCHEMA_VERSION,
      revision: this.index.revision,
      summaries: this.index.summaries,
      createOperations: this.index.createOperations,
      tombstones: this.index.tombstones
    };
    this.index = { ...unsigned, checksum: checksum(unsigned) };
    await atomicPrivateWrite(this.rootDir, this.indexPath, `${JSON.stringify(this.index)}\n`);
  }

  private enqueueGlobal<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.globalQueue.catch(() => undefined).then(operation);
    this.globalQueue = queued.catch(() => undefined);
    return queued;
  }
}

function emptyLoaded(conversation: DiscourseConversationRecord): LoadedConversation {
  return {
    aggregate: {
      conversation,
      participants: [],
      participantRevisions: [],
      contextLinks: [],
      contextRevisions: [],
      contextSnapshots: [],
      waves: [],
      jobs: [],
      concerns: [],
      summaries: [],
      drafts: [],
      latestEventSequence: 0
    },
    messageHeaders: new Map()
  };
}

function applyEvent(
  current: LoadedConversation,
  event: DiscourseLogEvent
): LoadedConversation {
  if (event.sequence !== current.aggregate.latestEventSequence + 1) {
    throw new Error('Discourse aggregate event sequence is not contiguous.');
  }
  const next = cloneLoaded(current);
  const payload = requireRecord(event.payload, 'event payload');
  switch (event.kind) {
    case 'CONVERSATION_CREATED': {
      const conversation = requireConversation(payload.conversation);
      if (current.aggregate.latestEventSequence !== 0) {
        throw new Error('Discourse conversation creation must be the first event.');
      }
      next.aggregate.conversation = conversation;
      next.aggregate.participants = requireArray(payload.participants, 'participants') as never;
      next.aggregate.participantRevisions = requireArray(
        payload.participantRevisions,
        'participant revisions'
      ) as never;
      next.createOperation = {
        operationId: event.operationId,
        requestFingerprint: event.requestFingerprint,
        conversationId: conversation.id
      };
      break;
    }
    case 'CONVERSATION_UPDATED':
      next.aggregate.conversation = requireConversation(payload.conversation);
      break;
    case 'MESSAGE_APPENDED':
    case 'AGENT_MESSAGE_APPENDED': {
      const message = requireMessage(payload.message);
      const conversation = requireConversation(payload.conversation);
      if (message.conversationId !== next.aggregate.conversation.id) {
        throw new Error('Discourse message event crosses conversation ownership.');
      }
      if (next.messageHeaders.has(message.id)) {
        throw new Error('Discourse message ids must be unique within a conversation.');
      }
      assertMessageAgainstHeaders(next, message);
      next.messageHeaders.set(message.id, {
        id: message.id,
        conversationId: message.conversationId,
        ordinal: message.ordinal,
        author: message.author,
        status: message.status,
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
        ...(message.waveId ? { waveId: message.waveId } : {}),
        ...(message.jobId ? { jobId: message.jobId } : {})
      });
      const contextLinks = payload.contextLinks === undefined
        ? []
        : requireArray(payload.contextLinks, 'context links') as unknown as ConversationContextLinkRecord[];
      const contextRevision = payload.contextRevision && typeof payload.contextRevision === 'object'
        ? payload.contextRevision as unknown as ConversationContextRevisionRecord
        : undefined;
      if (contextLinks.length > 0) next.aggregate.contextLinks.push(...contextLinks);
      if (contextRevision) next.aggregate.contextRevisions.push(contextRevision);
      if (typeof payload.supersededMessageId === 'string') {
        const superseded = next.messageHeaders.get(payload.supersededMessageId);
        if (!superseded) throw new Error('Discourse correction targets an unknown message.');
        superseded.status = 'SUPERSEDED';
      }
      next.aggregate.conversation = conversation;
      next.lastMessageAt = message.createdAt;
      break;
    }
    case 'MESSAGE_TOMBSTONED': {
      const messageId = String(payload.messageId ?? '');
      const header = next.messageHeaders.get(messageId);
      if (!header) throw new Error('Discourse deletion targets an unknown message.');
      header.status = 'TOMBSTONE';
      next.aggregate.conversation = requireConversation(payload.conversation);
      break;
    }
    case 'CONTEXT_PINNED': {
      const links = requireArray(payload.links, 'context links') as unknown as ConversationContextLinkRecord[];
      const revision = requireContextRevision(payload.revision);
      next.aggregate.contextLinks.push(...links);
      next.aggregate.contextRevisions.push(revision);
      next.aggregate.conversation = requireConversation(payload.conversation);
      break;
    }
    case 'ROSTER_UPDATED': {
      const participants = requireArray(
        payload.participants,
        'participants'
      ) as unknown as DiscourseParticipantRecord[];
      const participantRevisions = requireArray(
        payload.participantRevisions,
        'participant revisions'
      ) as unknown as DiscourseParticipantRevisionRecord[];
      next.aggregate.participants.push(...participants);
      next.aggregate.participantRevisions.push(...participantRevisions);
      next.aggregate.conversation = requireConversation(payload.conversation);
      break;
    }
    case 'WAVE_PLANNED': {
      next.aggregate.conversation = requireConversation(payload.conversation);
      const plan = requireWavePlanPayload(payload);
      next.aggregate.contextSnapshots.push(plan.contextSnapshot);
      next.aggregate.waves.push(plan.wave);
      next.aggregate.jobs.push(...plan.jobs);
      break;
    }
    case 'WAVE_JOBS_ADDED': {
      const jobs = requireArray(payload.jobs, 'wave jobs').map((value) => requireJob(value));
      next.aggregate.jobs.push(...jobs);
      next.aggregate.conversation = requireConversation(payload.conversation);
      break;
    }
    case 'WAVE_UPDATED': {
      const wave = requireWave(payload.wave);
      replaceRecord(next.aggregate.waves, wave, 'wave');
      break;
    }
    case 'JOB_UPDATED': {
      const job = requireJob(payload.job);
      replaceRecord(next.aggregate.jobs, job, 'job');
      break;
    }
    case 'REVIEW_COMPLETED': {
      const job = requireJob(payload.job);
      replaceRecord(next.aggregate.jobs, job, 'job');
      const concerns = requireArray(
        payload.concerns,
        'review concerns'
      ) as unknown as DiscourseConcernRecord[];
      next.aggregate.concerns.push(...concerns);
      break;
    }
    case 'CORRECTION_COMPLETED': {
      const job = requireJob(payload.job);
      replaceRecord(next.aggregate.jobs, job, 'job');
      const concerns = requireArray(
        payload.concerns,
        'corrected concerns'
      ) as unknown as DiscourseConcernRecord[];
      for (const concern of concerns) replaceRecord(next.aggregate.concerns, concern, 'concern');
      break;
    }
    case 'CONVERSATION_DELETED': {
      const tombstone = requireTombstone(payload.tombstone);
      if (
        tombstone.conversationId !== next.aggregate.conversation.id ||
        tombstone.lastEventSequence !== event.sequence
      ) {
        throw new Error('Discourse deletion tombstone does not match its event owner.');
      }
      next.tombstone = tombstone;
      break;
    }
    default:
      throw new Error(`Unsupported discourse aggregate event: ${event.kind}`);
  }
  next.aggregate.latestEventSequence = event.sequence;
  validateLoaded(next);
  return next;
}

function validateLoaded(loaded: LoadedConversation): void {
  const conversation = loaded.aggregate.conversation;
  requireSafeId(conversation.id, 'conversation id');
  validateTitle(conversation.title);
  if (
    !Number.isSafeInteger(conversation.recordRevision) ||
    conversation.recordRevision < 1 ||
    !Number.isSafeInteger(conversation.latestOrdinal) ||
    conversation.latestOrdinal < 0 ||
    !Number.isSafeInteger(conversation.readOrdinal) ||
    conversation.readOrdinal < 0 ||
    conversation.readOrdinal > conversation.latestOrdinal
  ) {
    throw new Error('Discourse conversation counters are invalid.');
  }
  requireTimestamp(conversation.createdAt);
  requireTimestamp(conversation.updatedAt);
  if (loaded.lastMessageAt) requireTimestamp(loaded.lastMessageAt);
  if (loaded.tombstone) {
    requireTombstone(loaded.tombstone);
    if (
      loaded.tombstone.conversationId !== conversation.id ||
      loaded.tombstone.lastEventSequence !== loaded.aggregate.latestEventSequence
    ) {
      throw new Error('Discourse aggregate deletion tombstone is inconsistent.');
    }
  }
  if (new Set(conversation.participantIds).size !== conversation.participantIds.length) {
    throw new Error('Discourse conversation participant ids must be unique.');
  }
  assertUniqueRecordIds(loaded.aggregate.participants, 'participant');
  assertUniqueRecordIds(loaded.aggregate.participantRevisions, 'participant revision');
  const participantIds = new Set(loaded.aggregate.participants.map((participant) => participant.id));
  if (
    participantIds.size !== conversation.participantIds.length ||
    conversation.participantIds.some((id) => !participantIds.has(id))
  ) {
    throw new Error('Discourse conversation participant roster is inconsistent.');
  }
  for (const participant of loaded.aggregate.participants) {
    const revision = loaded.aggregate.participantRevisions.find(
      (candidate) => candidate.id === participant.currentRevisionId
    );
    if (
      participant.conversationId !== conversation.id ||
      participant.recordRevision < 1 ||
      !revision ||
      revision.conversationId !== conversation.id ||
      revision.stableParticipantId !== participant.id ||
      revision.agentProfileId !== participant.agentProfileId ||
      !revision.displayNameSnapshot.trim() ||
      !revision.providerId.trim() ||
      !revision.model.trim() ||
      !/^[a-f0-9]{64}$/u.test(revision.roleContractHash)
    ) {
      throw new Error('Discourse participant binding is invalid.');
    }
    requireTimestamp(participant.createdAt);
    requireTimestamp(revision.createdAt);
  }
  if (loaded.messageHeaders.size !== conversation.latestOrdinal) {
    throw new Error('Discourse conversation latest ordinal does not match its messages.');
  }
  assertUniqueRecordIds(loaded.aggregate.waves, 'wave');
  assertUniqueRecordIds(loaded.aggregate.jobs, 'job');
  assertUniqueRecordIds(loaded.aggregate.contextLinks, 'context link');
  assertUniqueRecordIds(loaded.aggregate.contextRevisions, 'context revision');
  assertUniqueRecordIds(loaded.aggregate.contextSnapshots, 'context snapshot');
  assertUniqueRecordIds(loaded.aggregate.concerns, 'concern');
  const contextLinkIds = new Set(loaded.aggregate.contextLinks.map((link) => link.id));
  loaded.aggregate.contextRevisions.forEach((revision, index) => {
    if (
      revision.conversationId !== conversation.id ||
      revision.revision !== index + 1 ||
      revision.references.length > DISCOURSE_LIMITS.maxContextReferencesPerWave
    ) {
      throw new Error('Discourse context revision history is invalid.');
    }
    revision.references.forEach((reference) => {
      if (!contextLinkIds.has(reference.contextLinkId)) {
        throw new Error('Discourse context revision references an unknown link.');
      }
    });
  });
  if (
    conversation.pinnedContextRevisionId &&
    !loaded.aggregate.contextRevisions.some(
      (revision) => revision.id === conversation.pinnedContextRevisionId
    )
  ) {
    throw new Error('Discourse pinned context revision is missing.');
  }
  for (const snapshot of loaded.aggregate.contextSnapshots) {
    assertContextSnapshotRecord(snapshot);
    if (
      snapshot.conversationId !== conversation.id ||
      !loaded.aggregate.contextRevisions.some(
        (revision) => revision.id === snapshot.contextRevisionId
      )
    ) {
      throw new Error('Discourse context snapshot ownership is invalid.');
    }
  }
  for (const wave of loaded.aggregate.waves) {
    assertDiscourseWaveRecord(wave);
    deriveDiscourseWaveAggregate({
      wave,
      jobs: loaded.aggregate.jobs.filter((job) => job.waveId === wave.id),
      concerns: loaded.aggregate.concerns.filter((concern) => concern.waveId === wave.id)
    });
  }
  for (const job of loaded.aggregate.jobs) {
    assertDiscourseJobRecord(job);
    if (!loaded.aggregate.waves.some((wave) => wave.id === job.waveId)) {
      throw new Error('Discourse job references an unknown wave.');
    }
  }
  for (const concern of loaded.aggregate.concerns) {
    const review = loaded.aggregate.jobs.find((job) => job.id === concern.reviewJobId);
    const correction = concern.resolution
      ? loaded.aggregate.jobs.find((job) => job.id === concern.resolution!.correctionJobId)
      : undefined;
    if (
      concern.conversationId !== conversation.id ||
      !review ||
      review.role !== 'CRITIQUE' ||
      review.waveId !== concern.waveId ||
      review.assignment.participantRevisionId !== concern.reviewerParticipantRevisionId ||
      !review.targetMessageIds.includes(concern.targetMessageId) ||
      !concern.targetClaim.trim() ||
      !concern.category.trim() ||
      !concern.reason.trim() ||
      !concern.evidence.trim() ||
      !concern.suggestedResolution.trim() ||
      concern.recordRevision < 1 ||
      (concern.resolution && (!correction || correction.role !== 'CORRECT'))
    ) {
      throw new Error('Discourse concern record is invalid.');
    }
    requireTimestamp(concern.createdAt);
  }
}

function assertMessageAgainstHeaders(
  loaded: LoadedConversation,
  message: DiscourseMessageRecord
): void {
  assertDiscourseMessageAppend({
    conversationId: loaded.aggregate.conversation.id,
    latestOrdinal: loaded.aggregate.conversation.latestOrdinal,
    findExistingMessage: (messageId) => {
      const header = loaded.messageHeaders.get(messageId);
      return header
        ? {
            id: header.id,
            conversationId: header.conversationId,
            ordinal: header.ordinal,
            author: header.author,
            body: '',
            status: header.status,
            ...(header.replyToMessageId
              ? { replyToMessageId: header.replyToMessageId }
              : {}),
            ...(header.waveId ? { waveId: header.waveId } : {}),
            ...(header.jobId ? { jobId: header.jobId } : {}),
            sourceMessageIds: [],
            createdAt: loaded.aggregate.conversation.createdAt
          }
        : undefined;
    },
    message
  });
  for (const sourceMessageId of message.sourceMessageIds) {
    if (!loaded.messageHeaders.has(sourceMessageId)) {
      throw new Error('A discourse message source must exist in the same conversation.');
    }
  }
}

function buildMessageContextUpdate(input: {
  loaded: LoadedConversation;
  messageId: string;
  context: DiscourseContextSelectionSnapshot[];
  createId(): string;
  now: string;
}): {
  links: ConversationContextLinkRecord[];
  revision?: ConversationContextRevisionRecord;
} {
  const conversationId = input.loaded.aggregate.conversation.id;
  const links: ConversationContextLinkRecord[] = input.context.map((reference) => ({
    id: input.createId(),
    conversationId,
    scope: 'MESSAGE',
    createdByMessageId: input.messageId,
    entityKind: reference.entityKind,
    entityId: reference.entityId,
    availability: reference.availability,
    recordRevision: 1,
    createdAt: input.now,
    updatedAt: input.now
  }));
  const pinned = currentPinnedReferences(input.loaded);
  const messageReferences = links.map((link, index) => ({
    contextLinkId: link.id,
    entityKind: link.entityKind,
    entityId: link.entityId,
    labelSnapshot: input.context[index]!.labelSnapshot,
    availability: link.availability,
    scope: 'MESSAGE' as const,
    createdByMessageId: input.messageId
  }));
  const references = dedupeContextReferenceSnapshots([...pinned, ...messageReferences]);
  if (references.length > DISCOURSE_LIMITS.maxContextReferencesPerWave) {
    throw new Error(
      `Discourse context is limited to ${DISCOURSE_LIMITS.maxContextReferencesPerWave} references.`
    );
  }
  return {
    links,
    revision: {
      id: input.createId(),
      conversationId,
      revision: (input.loaded.aggregate.contextRevisions.at(-1)?.revision ?? 0) + 1,
      references,
      createdAt: input.now
    }
  };
}

function currentPinnedReferences(
  loaded: LoadedConversation
): ConversationContextRevisionRecord['references'] {
  const revisionId = loaded.aggregate.conversation.pinnedContextRevisionId;
  if (!revisionId) return [];
  const revision = loaded.aggregate.contextRevisions.find(
    (candidate) => candidate.id === revisionId
  );
  if (!revision) throw new Error('Discourse pinned context revision is missing.');
  return revision.references
    .filter((reference) => reference.scope === 'PINNED')
    .map((reference) => clone(reference));
}

function dedupeContextReferenceSnapshots(
  references: ConversationContextRevisionRecord['references']
): ConversationContextRevisionRecord['references'] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.entityKind}:${reference.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeResolvedContext(
  references: readonly DiscourseContextSelectionSnapshot[]
): DiscourseContextSelectionSnapshot[] {
  if (references.length > DISCOURSE_LIMITS.maxContextReferencesPerWave) {
    throw new Error(
      `Discourse context is limited to ${DISCOURSE_LIMITS.maxContextReferencesPerWave} references.`
    );
  }
  const seen = new Set<string>();
  const normalized: DiscourseContextSelectionSnapshot[] = [];
  for (const reference of references) {
    if (reference.entityKind !== 'TASK' && reference.entityKind !== 'REPOSITORY') {
      throw new Error('Discourse context entity kind is invalid.');
    }
    requireSafeId(reference.entityId, 'context entity id');
    const labelSnapshot = normalizeDisplayLabel(reference.labelSnapshot, 'context label');
    if (!['AVAILABLE', 'UNAVAILABLE', 'TOMBSTONED'].includes(reference.availability)) {
      throw new Error('Discourse context availability is invalid.');
    }
    const key = `${reference.entityKind}:${reference.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...reference, labelSnapshot });
  }
  return normalized;
}

function applyMessagePresentationState(
  message: DiscourseMessageRecord,
  loaded: LoadedConversation
): DiscourseMessageRecord {
  const header = loaded.messageHeaders.get(message.id);
  if (!header) throw new Error('Discourse message index is missing a durable message.');
  return {
    ...message,
    status: header.status,
    ...(header.status === 'TOMBSTONE' ? { body: '' } : {})
  };
}

function normalizeDraftTokens(
  tokens: readonly DiscourseDraftTokenInput[]
): DiscourseDraftRecord['tokens'] {
  if (tokens.length > DISCOURSE_LIMITS.maxContextReferencesPerWave + 3) {
    throw new Error('Discourse draft has too many structured tokens.');
  }
  const seen = new Set<string>();
  return tokens.flatMap((token) => {
    if (!['TASK', 'REPOSITORY', 'AGENT'].includes(token.kind)) {
      throw new Error('Discourse draft token kind is invalid.');
    }
    if (token.kind === 'AGENT') {
      if (!['builtin.lead', 'builtin.skeptic', 'builtin.verifier'].includes(token.entityId)) {
        throw new Error('Discourse draft agent profile id is invalid.');
      }
    } else {
      requireSafeId(token.entityId, 'draft token entity id');
    }
    const key = `${token.kind}:${token.entityId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      id: crypto.createHash('sha256').update(key).digest('hex'),
      ...token,
      labelSnapshot: normalizeDisplayLabel(token.labelSnapshot, 'draft token label')
    }];
  });
}

function validateDraftInput(input: {
  body: string;
  replyToMessageId?: string;
  recipientParticipantIds: string[];
  tokens: DiscourseDraftTokenInput[];
}): void {
  if (Buffer.byteLength(input.body, 'utf8') > DISCOURSE_LIMITS.maxHumanMessageBytes) {
    throw new Error('Discourse draft exceeds its text-size safety limit.');
  }
  if (input.replyToMessageId) requireSafeId(input.replyToMessageId, 'reply message id');
  input.recipientParticipantIds.forEach((id) => requireSafeId(id, 'draft recipient id'));
  normalizeDraftTokens(input.tokens);
}

function validateDraftRecord(draft: DiscourseDraftRecord, expectedId: string): void {
  if (
    draft.id !== expectedId ||
    !Number.isSafeInteger(draft.recordRevision) ||
    draft.recordRevision < 1
  ) {
    throw new Error('Discourse draft record is invalid.');
  }
  if (draft.conversationId) requireSafeId(draft.conversationId, 'conversation id');
  validateDraftInput(draft);
  const normalizedTokens = normalizeDraftTokens(draft.tokens);
  if (
    normalizedTokens.length !== draft.tokens.length ||
    normalizedTokens.some((token, index) => token.id !== draft.tokens[index]?.id)
  ) {
    throw new Error('Discourse draft token identity is invalid.');
  }
  requireTimestamp(draft.updatedAt);
}

function normalizeDisplayLabel(value: string, label: string): string {
  const normalized = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized || normalized.length > 256) {
    throw new Error(`Discourse ${label} is invalid.`);
  }
  return normalized;
}

function summaryFromLoaded(loaded: LoadedConversation): DiscourseConversationSummary {
  if (loaded.tombstone) {
    throw new Error('Deleted discourse conversations cannot produce live summaries.');
  }
  const conversation = loaded.aggregate.conversation;
  const lastMessageAt = loaded.lastMessageAt;
  const activeWaves = loaded.aggregate.waves.filter((wave) => wave.status !== 'SETTLED');
  const latestWave = loaded.aggregate.waves.at(-1);
  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    defaultPolicy: conversation.defaultPolicy,
    participantIds: [...conversation.participantIds],
    latestOrdinal: conversation.latestOrdinal,
    readOrdinal: conversation.readOrdinal,
    unreadCount: Math.max(0, conversation.latestOrdinal - conversation.readOrdinal),
    needsAttention:
      activeWaves.some((wave) => wave.status === 'RECOVERY_REQUIRED') ||
      activeWaves.some((wave) => wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED') ||
      loaded.aggregate.jobs.some((job) => job.status === 'RECOVERY_REQUIRED') ||
      Boolean(
        latestWave?.status === 'SETTLED' &&
        ['STALE', 'FAILED', 'NO_RESPONSE'].includes(latestWave.outcome ?? '')
      ),
    activeWaveCount: activeWaves.length,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(lastMessageAt ? { lastMessageAt } : {}),
    ...(conversation.archivedAt ? { archivedAt: conversation.archivedAt } : {})
  };
}

function assertParticipantSeed(input: CreateDiscourseConversationInput): void {
  const participantIds = new Set(input.participants.map((participant) => participant.id));
  if (participantIds.size !== input.participants.length) {
    throw new Error('Discourse participant seed contains duplicate ids.');
  }
  const revisionIds = new Set(
    input.participantRevisions.map((revision) => revision.id)
  );
  if (revisionIds.size !== input.participantRevisions.length) {
    throw new Error('Discourse participant seed contains duplicate revision ids.');
  }
  for (const participant of input.participants) {
    requireSafeId(participant.id, 'participant id');
    requireSafeId(participant.currentRevisionId, 'participant revision id');
    if (participant.recordRevision !== 1 || !participant.enabled) {
      throw new Error('Discourse participant seed must start as an enabled first revision.');
    }
    requireTimestamp(participant.createdAt);
    if (participant.conversationId !== (input.id ?? participant.conversationId)) {
      // Generated conversation ids are assigned after this validation; callers
      // may leave a generated seed conversation id blank.
      if (input.id || participant.conversationId) {
        throw new Error('Discourse participant seed crosses conversation ownership.');
      }
    }
    const revision = input.participantRevisions.find(
      (candidate) => candidate.id === participant.currentRevisionId
    );
    if (!revision || revision.stableParticipantId !== participant.id) {
      throw new Error('Discourse participant seed is missing its immutable revision.');
    }
  }
  for (const revision of input.participantRevisions) {
    requireSafeId(revision.id, 'participant revision id');
    requireSafeId(revision.stableParticipantId, 'participant id');
    if (
      !participantIds.has(revision.stableParticipantId) ||
      !revision.displayNameSnapshot.trim() ||
      !revision.providerId.trim() ||
      !revision.model.trim() ||
      !/^[a-f0-9]{64}$/u.test(revision.roleContractHash) ||
      !Number.isSafeInteger(revision.revision) ||
      revision.revision < 1 ||
      !Number.isSafeInteger(revision.profileRevision) ||
      revision.profileRevision < 1
    ) {
      throw new Error('Discourse participant revision seed is invalid.');
    }
    requireTimestamp(revision.createdAt);
  }
}

function requireEventConversation(event: DiscourseLogEvent): DiscourseConversationRecord {
  return requireConversation(requireRecord(event.payload, 'event payload').conversation);
}

function requireEventMessage(event: DiscourseLogEvent): DiscourseMessageRecord {
  return requireMessage(requireRecord(event.payload, 'event payload').message);
}

function requireEventContextRevision(
  event: DiscourseLogEvent
): ConversationContextRevisionRecord {
  return requireContextRevision(requireRecord(event.payload, 'event payload').revision);
}

function requireContextRevision(value: unknown): ConversationContextRevisionRecord {
  const revision = requireRecord(value, 'context revision') as unknown as
    ConversationContextRevisionRecord;
  requireSafeId(revision.id, 'context revision id');
  requireSafeId(revision.conversationId, 'conversation id');
  if (!Number.isSafeInteger(revision.revision) || revision.revision < 1) {
    throw new Error('Discourse context revision number is invalid.');
  }
  if (!Array.isArray(revision.references)) {
    throw new Error('Discourse context revision references are invalid.');
  }
  requireTimestamp(revision.createdAt);
  return revision;
}

function requireContextSnapshot(value: unknown): ContextSnapshotRecord {
  const snapshot = requireRecord(
    value,
    'context snapshot'
  ) as unknown as ContextSnapshotRecord;
  assertContextSnapshotRecord(snapshot);
  return snapshot;
}

function requireEventTombstone(
  event: DiscourseLogEvent
): DiscourseConversationTombstoneRecord {
  return requireTombstone(requireRecord(event.payload, 'event payload').tombstone);
}

function requireWavePlanEvent(event: DiscourseLogEvent): {
  wave: DiscourseResponseWaveRecord;
  jobs: DiscourseAgentJobRecord[];
} {
  const plan = requireWavePlanPayload(requireRecord(event.payload, 'event payload'));
  return { wave: plan.wave, jobs: plan.jobs };
}

function requireEventWave(event: DiscourseLogEvent): DiscourseResponseWaveRecord {
  return requireWave(requireRecord(event.payload, 'event payload').wave);
}

function requireEventJob(event: DiscourseLogEvent): DiscourseAgentJobRecord {
  return requireJob(requireRecord(event.payload, 'event payload').job);
}

function requireAddedJobs(event: DiscourseLogEvent): DiscourseAgentJobRecord[] {
  return requireArray(
    requireRecord(event.payload, 'event payload').jobs,
    'wave jobs'
  ).map((value) => requireJob(value));
}

function requireWavePlanPayload(payload: Record<string, DiscourseJsonValue>): {
  wave: DiscourseResponseWaveRecord;
  jobs: DiscourseAgentJobRecord[];
  contextSnapshot: ContextSnapshotRecord;
} {
  const wave = requireWave(payload.wave);
  const jobs = requireArray(payload.jobs, 'wave jobs').map((value) => requireJob(value));
  const contextSnapshot = requireContextSnapshot(payload.contextSnapshot);
  return { wave, jobs, contextSnapshot };
}

function requireWave(value: unknown): DiscourseResponseWaveRecord {
  const wave = requireRecord(value, 'wave') as unknown as DiscourseResponseWaveRecord;
  if (!wave.id || !wave.conversationId || !wave.triggerMessageId) {
    throw new Error('Discourse wave event is invalid.');
  }
  assertDiscourseWaveRecord(wave);
  return wave;
}

function requireJob(value: unknown): DiscourseAgentJobRecord {
  const job = requireRecord(value, 'job') as unknown as DiscourseAgentJobRecord;
  if (!job.id || !job.conversationId || !job.waveId) {
    throw new Error('Discourse job event is invalid.');
  }
  assertDiscourseJobRecord(job);
  return job;
}

function assertWavePlan(
  input: CreateDiscourseWaveInput,
  loaded: LoadedConversation
): void {
  const { wave, jobs, contextSnapshot } = input;
  requireSafeId(wave.id, 'wave id');
  if (
    wave.conversationId !== input.conversationId ||
    loaded.aggregate.waves.some((candidate) => candidate.id === wave.id)
  ) {
    throw new Error('Discourse wave plan has invalid or duplicate ownership.');
  }
  if (wave.clientOperationId !== input.clientOperationId) {
    throw new Error('Discourse wave plan does not match its client operation.');
  }
  if (!/^[a-f0-9]{64}$/u.test(wave.requestFingerprint)) {
    throw new Error('Discourse wave plan requires a SHA-256 request fingerprint.');
  }
  if (wave.recordRevision !== 1 || wave.status !== 'PLANNED') {
    throw new Error('A new discourse wave must start as revision-one PLANNED state.');
  }
  if (wave.startedAt || wave.settledAt || wave.outcome || wave.settlementReason) {
    throw new Error('A new discourse wave cannot carry execution or settlement evidence.');
  }
  requireTimestamp(wave.createdAt);
  assertMessageReferencesExist(
    loaded,
    [wave.triggerMessageId, ...wave.sourceMessageIds],
    'wave source'
  );
  if (!wave.sourceMessageIds.includes(wave.triggerMessageId)) {
    throw new Error('A discourse wave source set must include its trigger message.');
  }
  if (new Set(wave.sourceMessageIds).size !== wave.sourceMessageIds.length) {
    throw new Error('A discourse wave source set cannot contain duplicates.');
  }
  requireSafeId(wave.plannedContextRevisionId, 'context revision id');
  if (!wave.contextSnapshotId) {
    throw new Error('A discourse wave requires an immutable context snapshot.');
  }
  requireSafeId(wave.contextSnapshotId, 'context snapshot id');
  assertContextSnapshotRecord(contextSnapshot);
  if (
    contextSnapshot.id !== wave.contextSnapshotId ||
    contextSnapshot.waveId !== wave.id ||
    contextSnapshot.conversationId !== input.conversationId ||
    contextSnapshot.contextRevisionId !== wave.plannedContextRevisionId ||
    !loaded.aggregate.contextRevisions.some(
      (revision) => revision.id === contextSnapshot.contextRevisionId
    )
  ) {
    throw new Error('Discourse wave context snapshot ownership is invalid.');
  }
  assertDiscourseWaveRecord(wave);
  assertUniqueRecordIds(jobs, 'job');
  if (jobs.length > DISCOURSE_LIMITS.maxTeamJobs) {
    throw new Error('Discourse wave job plan exceeds its safety limit.');
  }
  const generationKeys = new Set<string>();
  for (const job of jobs) {
    requireSafeId(job.id, 'job id');
    if (loaded.aggregate.jobs.some((candidate) => candidate.id === job.id)) {
      throw new Error(`Discourse job already exists: ${job.id}`);
    }
    if (
      job.conversationId !== input.conversationId ||
      job.waveId !== wave.id ||
      job.recordRevision !== 1 ||
      job.status !== 'QUEUED' ||
      job.delivery !== 'NOT_SENT'
    ) {
      throw new Error('A new discourse job must be an undispatched revision-one queued child.');
    }
    if (
      job.sessionId ||
      job.executionProfileHash ||
      job.runId ||
      job.startedAt ||
      job.finishedAt ||
      job.result ||
      job.error ||
      job.freshnessAtCompletion ||
      job.promptArtifactId ||
      job.outputArtifactId
    ) {
      throw new Error('A new discourse job cannot carry runtime or terminal evidence.');
    }
    requireSafeId(job.attemptId, 'job attempt id');
    requireSafeId(job.generationKey, 'job generation key');
    if (generationKeys.has(job.generationKey)) {
      throw new Error('Discourse job generation keys must be unique within a wave.');
    }
    generationKeys.add(job.generationKey);
    requireTimestamp(job.createdAt);
    assertMessageReferencesExist(loaded, job.targetMessageIds, 'job target');
    assertMessageReferencesExist(loaded, job.visibleMessageIds, 'job visible message');
    if (
      new Set(job.targetMessageIds).size !== job.targetMessageIds.length ||
      new Set(job.visibleMessageIds).size !== job.visibleMessageIds.length
    ) {
      throw new Error('Discourse job message references cannot contain duplicates.');
    }
    if (job.contextSnapshotId && job.contextSnapshotId !== wave.contextSnapshotId) {
      throw new Error('A discourse job cannot reference another wave context snapshot.');
    }
  }
  assertAssignmentsReferenceParticipants(wave, loaded);
  deriveDiscourseWaveAggregate({ wave, jobs });
}

function assertNewDownstreamJob(
  job: DiscourseAgentJobRecord,
  wave: DiscourseResponseWaveRecord,
  loaded: LoadedConversation
): void {
  assertDiscourseJobRecord(job);
  if (
    job.conversationId !== wave.conversationId ||
    job.waveId !== wave.id ||
    job.recordRevision !== 1 ||
    job.status !== 'QUEUED' ||
    job.delivery !== 'NOT_SENT' ||
    job.contextSnapshotId !== wave.contextSnapshotId ||
    loaded.aggregate.jobs.some((candidate) => candidate.id === job.id) ||
    loaded.aggregate.jobs.some((candidate) => candidate.generationKey === job.generationKey)
  ) {
    throw new Error('A downstream discourse job has invalid immutable identity.');
  }
  const assignment = wave.assignments.find(
    (candidate) =>
      candidate.stableParticipantId === job.assignment.stableParticipantId &&
      candidate.participantRevisionId === job.assignment.participantRevisionId
  );
  if (!assignment || stableStringify(assignment) !== stableStringify(job.assignment)) {
    throw new Error('A downstream discourse job must use a wave assignment.');
  }
  assertMessageReferencesExist(loaded, job.targetMessageIds, 'job target');
  assertMessageReferencesExist(loaded, job.visibleMessageIds, 'job visible message');
  requireTimestamp(job.createdAt);
}

function assertAssignmentsReferenceParticipants(
  wave: DiscourseResponseWaveRecord,
  loaded: LoadedConversation
): void {
  for (const assignment of wave.assignments) {
    const participant = loaded.aggregate.participants.find(
      (candidate) => candidate.id === assignment.stableParticipantId
    );
    const revision = loaded.aggregate.participantRevisions.find(
      (candidate) => candidate.id === assignment.participantRevisionId
    );
    if (
      !participant ||
      !participant.enabled ||
      !revision ||
      revision.stableParticipantId !== participant.id ||
      stableStringify({
        stableParticipantId: assignment.stableParticipantId,
        participantRevisionId: assignment.participantRevisionId,
        agentProfileId: assignment.agentProfileId,
        profileRevision: assignment.profileRevision,
        displayNameSnapshot: assignment.displayNameSnapshot,
        providerId: assignment.providerId,
        model: assignment.model,
        modelProvider: assignment.modelProvider,
        reasoningEffort: assignment.reasoningEffort,
        serviceTier: assignment.serviceTier,
        configuredRole: assignment.configuredRole,
        roleContractVersion: assignment.roleContractVersion,
        roleContractHash: assignment.roleContractHash
      }) !==
        stableStringify({
          stableParticipantId: revision?.stableParticipantId,
          participantRevisionId: revision?.id,
          agentProfileId: revision?.agentProfileId,
          profileRevision: revision?.profileRevision,
          displayNameSnapshot: revision?.displayNameSnapshot,
          providerId: revision?.providerId,
          model: revision?.model,
          modelProvider: revision?.modelProvider,
          reasoningEffort: revision?.reasoningEffort,
          serviceTier: revision?.serviceTier,
          configuredRole: revision?.configuredRole,
          roleContractVersion: revision?.roleContractVersion,
          roleContractHash: revision?.roleContractHash
        })
    ) {
      throw new Error('Discourse wave assignment is not an enabled immutable participant revision.');
    }
  }
}

function assertImmutableWave(
  existing: DiscourseResponseWaveRecord,
  next: DiscourseResponseWaveRecord
): void {
  const immutable = (wave: DiscourseResponseWaveRecord) => ({
    id: wave.id,
    conversationId: wave.conversationId,
    triggerMessageId: wave.triggerMessageId,
    policy: wave.policy,
    policyVersion: wave.policyVersion,
    assignments: wave.assignments,
    sourceMessageIds: wave.sourceMessageIds,
    plannedContextRevisionId: wave.plannedContextRevisionId,
    attempt: wave.attempt,
    clientOperationId: wave.clientOperationId,
    requestFingerprint: wave.requestFingerprint,
    createdAt: wave.createdAt
  });
  if (stableStringify(immutable(existing)) !== stableStringify(immutable(next))) {
    throw new Error('Discourse wave update changed immutable planning identity.');
  }
  assertOptionalLink(existing.contextSnapshotId, next.contextSnapshotId, 'wave context snapshot');
  assertOptionalLink(existing.startedAt, next.startedAt, 'wave start timestamp');
  if (next.contextSnapshotId) requireSafeId(next.contextSnapshotId, 'context snapshot id');
  if (next.startedAt) requireTimestamp(next.startedAt);
  if (next.settledAt) requireTimestamp(next.settledAt);
}

function assertImmutableJob(
  existing: DiscourseAgentJobRecord,
  next: DiscourseAgentJobRecord
): void {
  const immutable = (job: DiscourseAgentJobRecord) => ({
    id: job.id,
    conversationId: job.conversationId,
    waveId: job.waveId,
    assignment: job.assignment,
    role: job.role,
    phase: job.phase,
    targetMessageIds: job.targetMessageIds,
    visibleMessageIds: job.visibleMessageIds,
    attemptId: job.attemptId,
    generationKey: job.generationKey,
    createdAt: job.createdAt
  });
  if (stableStringify(immutable(existing)) !== stableStringify(immutable(next))) {
    throw new Error('Discourse job update changed immutable execution identity.');
  }
  assertOptionalLink(existing.contextSnapshotId, next.contextSnapshotId, 'job context snapshot');
  assertOptionalLink(existing.sessionId, next.sessionId, 'job runtime session');
  assertOptionalLink(existing.executionProfileHash, next.executionProfileHash, 'job execution profile');
  assertOptionalLink(existing.runId, next.runId, 'job runtime run');
  assertOptionalLink(existing.promptArtifactId, next.promptArtifactId, 'job prompt artifact');
  assertOptionalLink(existing.outputArtifactId, next.outputArtifactId, 'job output artifact');
  assertOptionalLink(existing.startedAt, next.startedAt, 'job start timestamp');
  if (next.contextSnapshotId) requireSafeId(next.contextSnapshotId, 'context snapshot id');
  if (next.sessionId) requireSafeId(next.sessionId, 'runtime session id');
  if (next.runId) requireSafeId(next.runId, 'runtime run id');
  if (next.startedAt) requireTimestamp(next.startedAt);
  if (next.finishedAt) requireTimestamp(next.finishedAt);
}

function assertOptionalLink(
  existing: string | undefined,
  next: string | undefined,
  label: string
): void {
  if (existing && existing !== next) {
    throw new Error(`Discourse ${label} cannot be removed or changed once linked.`);
  }
}

function assertJobResultMessageLink(
  job: DiscourseAgentJobRecord,
  loaded: LoadedConversation
): void {
  if (job.status !== 'COMPLETED' || !job.result) return;
  const outputMessageId =
    job.result.kind === 'CONTRIBUTION' ||
    job.result.kind === 'REVIEW' ||
    job.result.kind === 'CORRECTION'
      ? job.result.outputMessageId
      : undefined;
  if (!outputMessageId) return;
  const output = loaded.messageHeaders.get(outputMessageId);
  if (!output || output.jobId !== job.id || output.waveId !== job.waveId) {
    throw new Error('A discourse job result must reference its own durable output message.');
  }
}

function assertMessageReferencesExist(
  loaded: LoadedConversation,
  ids: readonly string[],
  label: string
): void {
  for (const id of ids) {
    requireSafeId(id, `${label} id`);
    if (!loaded.messageHeaders.has(id)) {
      throw new Error(`Discourse ${label} references an unknown message.`);
    }
  }
}

function replaceRecord<T extends { id: string }>(
  records: T[],
  next: T,
  label: string
): void {
  const index = records.findIndex((record) => record.id === next.id);
  if (index < 0) throw new Error(`Discourse ${label} update references an unknown record.`);
  records[index] = next;
}

function assertUniqueRecordIds(
  records: readonly { id: string }[],
  label: string
): void {
  const ids = new Set<string>();
  for (const record of records) {
    requireSafeId(record.id, `${label} id`);
    if (ids.has(record.id)) throw new Error(`Duplicate discourse ${label} id: ${record.id}`);
    ids.add(record.id);
  }
}

async function findConversationEvent(
  log: FileDiscourseEventLog,
  operationId: string,
  requestFingerprint: string
): Promise<DiscourseLogEvent | undefined> {
  const event = await log.getByOperationId(operationId);
  if (event && event.requestFingerprint !== requestFingerprint) {
    throw new Error('REQUEST_CONFLICT: conversation operation changed.');
  }
  return event;
}

function requireConversation(value: unknown): DiscourseConversationRecord {
  const record = requireRecord(value, 'conversation');
  return record as unknown as DiscourseConversationRecord;
}

function requireMessage(value: unknown): DiscourseMessageRecord {
  const record = requireRecord(value, 'message') as unknown as DiscourseMessageRecord;
  if (!record.id || !record.conversationId || !Number.isSafeInteger(record.ordinal)) {
    throw new Error('Discourse message event is invalid.');
  }
  return record;
}

function requireTombstone(value: unknown): DiscourseConversationTombstoneRecord {
  const record = requireRecord(value, 'conversation tombstone') as unknown as
    DiscourseConversationTombstoneRecord;
  requireSafeId(record.conversationId, 'conversation id');
  validateOperationId(record.clientOperationId);
  requireTimestamp(record.deletedAt);
  if (
    !/^[a-f0-9]{64}$/u.test(record.requestFingerprint) ||
    !Number.isSafeInteger(record.lastEventSequence) ||
    record.lastEventSequence < 2
  ) {
    throw new Error('Discourse conversation tombstone is invalid.');
  }
  return record;
}

function requireRecord(value: unknown, label: string): Record<string, DiscourseJsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Discourse ${label} is invalid.`);
  }
  return value as Record<string, DiscourseJsonValue>;
}

function requireArray(value: unknown, label: string): DiscourseJsonValue[] {
  if (!Array.isArray(value)) throw new Error(`Discourse ${label} are invalid.`);
  return value;
}

function emptyIndex(): DiscourseIndexFile {
  const unsigned = {
    schemaVersion: DISCOURSE_STORE_SCHEMA_VERSION,
    revision: 0,
    summaries: [],
    createOperations: [],
    tombstones: []
  };
  return { ...unsigned, checksum: checksum(unsigned) };
}

async function readCheckedIndex(filePath: string): Promise<DiscourseIndexFile | undefined> {
  const value = await readPrivateJson(filePath, MAX_INDEX_BYTES);
  if (!value) return undefined;
  const record = value as Partial<DiscourseIndexFile>;
  if (record.schemaVersion !== DISCOURSE_STORE_SCHEMA_VERSION) {
    if (Number(record.schemaVersion) > DISCOURSE_STORE_SCHEMA_VERSION) {
      throw new Error(
        `Discourse schema ${String(record.schemaVersion)} is newer than this app supports.`
      );
    }
    return undefined;
  }
  if (
    !Number.isSafeInteger(record.revision) ||
    !Array.isArray(record.summaries) ||
    !Array.isArray(record.createOperations) ||
    !Array.isArray(record.tombstones) ||
    typeof record.checksum !== 'string'
  ) {
    return undefined;
  }
  const { checksum: stored, ...unsigned } = record as DiscourseIndexFile;
  return stored === checksum(unsigned) ? (record as DiscourseIndexFile) : undefined;
}

async function readCheckedMetadata(
  filePath: string,
  conversationId: string
): Promise<DiscourseConversationMetadata | undefined> {
  const value = await readPrivateJson(filePath, MAX_METADATA_BYTES);
  if (!value) return undefined;
  const record = value as Partial<DiscourseConversationMetadata>;
  if (
    record.schemaVersion !== DISCOURSE_STORE_SCHEMA_VERSION ||
    record.conversationId !== conversationId ||
    !Number.isSafeInteger(record.lastAppliedEventSequence) ||
    !record.summary ||
    !record.createOperation ||
    typeof record.checksum !== 'string'
  ) {
    return undefined;
  }
  const { checksum: stored, ...unsigned } = record as DiscourseConversationMetadata;
  return stored === checksum(unsigned) ? (record as DiscourseConversationMetadata) : undefined;
}

async function readPrivateJson(filePath: string, maxBytes: number): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > maxBytes ||
      !hasNoGroupOrOtherPosixAccess(stat) ||
      !isOwnedByCurrentUser(stat)
    ) {
      throw new Error('Discourse metadata file failed its integrity check.');
    }
    try {
      return JSON.parse(await handle.readFile('utf8')) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
    throw new Error('Discourse store root failed its integrity check.');
  }
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    await enforcePosixMode(handle, 0o700);
  } finally {
    await handle.close();
  }
}

async function atomicPrivateWrite(
  directory: string,
  target: string,
  content: string
): Promise<void> {
  const temporary = path.join(
    directory,
    `.${path.basename(target)}-${process.pid}-${randomUUID()}.tmp`
  );
  const handle = await fs.open(
    temporary,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await enforcePosixMode(handle, 0o600);
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
    await syncDirectoryIfSupported(directory);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function validateTitle(value: string): void {
  const title = value.trim();
  if (
    !title ||
    Buffer.byteLength(title, 'utf8') > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(title)
  ) {
    throw new Error('Discourse conversation title is invalid.');
  }
}

function validateMessageBody(value: string): void {
  if (!value.trim() || Buffer.byteLength(value, 'utf8') > DISCOURSE_LIMITS.maxHumanMessageBytes) {
    throw new Error('Discourse message is empty or exceeds its safety limit.');
  }
}

function validateAgentContribution(value: string): void {
  if (
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > DISCOURSE_LIMITS.maxAgentContributionBytes
  ) {
    throw new Error('Discourse agent contribution is empty or exceeds its safety limit.');
  }
}

function validateOperationId(value: string): void {
  if (!value || Buffer.byteLength(value, 'utf8') > 256 || /\p{Cc}|\p{Cf}/u.test(value)) {
    throw new Error('Discourse client operation id is invalid.');
  }
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Discourse ${label} is invalid.`);
}

function requireTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('Discourse timestamp is invalid.');
  }
  return value;
}

function uniqueIds(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  for (const value of unique) requireSafeId(value, 'message reference id');
  return unique;
}

function hashRequest(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function checksum(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function toJsonValue(value: unknown): DiscourseJsonValue {
  return JSON.parse(JSON.stringify(value)) as DiscourseJsonValue;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneLoaded(value: LoadedConversation): LoadedConversation {
  return {
    aggregate: clone(value.aggregate),
    // This is a private serialized projection cache, not a returned aggregate.
    // Sharing the append-only header index avoids copying the full transcript
    // for every event. A failed publication clears the owning handle, and a
    // restart reconstructs this cache from the authoritative event log.
    messageHeaders: value.messageHeaders,
    ...(value.createOperation ? { createOperation: { ...value.createOperation } } : {}),
    ...(value.lastMessageAt ? { lastMessageAt: value.lastMessageAt } : {}),
    ...(value.tombstone ? { tombstone: { ...value.tombstone } } : {})
  };
}

function compareSummaries(
  left: DiscourseConversationSummary,
  right: DiscourseConversationSummary
): number {
  return (
    compareCodeUnits(right.updatedAt, left.updatedAt) ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dedupeCreateOperations(
  operations: readonly DiscourseCreateOperation[]
): DiscourseCreateOperation[] {
  const byId = new Map<string, DiscourseCreateOperation>();
  for (const operation of operations) {
    const existing = byId.get(operation.operationId);
    if (
      existing &&
      (existing.requestFingerprint !== operation.requestFingerprint ||
        existing.conversationId !== operation.conversationId)
    ) {
      throw new Error('Discourse create-operation index is contradictory.');
    }
    byId.set(operation.operationId, operation);
  }
  return [...byId.values()];
}

function dedupeTombstones(
  tombstones: readonly DiscourseConversationTombstoneRecord[]
): DiscourseConversationTombstoneRecord[] {
  const byConversation = new Map<string, DiscourseConversationTombstoneRecord>();
  for (const tombstone of tombstones) {
    requireTombstone(tombstone);
    const existing = byConversation.get(tombstone.conversationId);
    if (existing && stableStringify(existing) !== stableStringify(tombstone)) {
      throw new Error('Discourse deletion tombstones are contradictory.');
    }
    byConversation.set(tombstone.conversationId, tombstone);
  }
  return [...byConversation.values()].sort((left, right) =>
    compareCodeUnits(left.conversationId, right.conversationId)
  );
}

function assertConversationNotDeleted(
  index: DiscourseIndexFile,
  conversationId: string
): void {
  if (index.tombstones.some((tombstone) => tombstone.conversationId === conversationId)) {
    throw new Error(`Discourse conversation was deleted: ${conversationId}`);
  }
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeOffsetCursor(cursor: string | undefined, length: number): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^offset:(\d+)$/u.exec(decoded);
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0 || value > length) {
    throw new Error('Discourse conversation cursor is invalid.');
  }
  return value;
}

function encodeSequenceCursor(sequence: number): string {
  return Buffer.from(`sequence:${sequence}`, 'utf8').toString('base64url');
}

function decodeSequenceCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^sequence:(\d+)$/u.exec(decoded);
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Discourse message cursor is invalid.');
  }
  return value;
}
