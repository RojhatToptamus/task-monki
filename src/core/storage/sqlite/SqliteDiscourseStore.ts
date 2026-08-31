import crypto, { randomUUID } from 'node:crypto';
import {
  DISCOURSE_LIMITS,
  type AgentAssignmentSnapshot,
  type ConversationContextLinkRecord,
  type ConversationContextRevisionRecord,
  type ContextSnapshotRecord,
  type DiscourseAcceptedSendRecord,
  type DiscourseAgentJobRecord,
  type DiscourseAgentSelectionInput,
  type DiscourseConcernRecord,
  type DiscourseContextSelectionSnapshot,
  type DiscourseConversationAggregateRecord,
  type DiscourseConversationPage,
  type DiscourseConversationRecord,
  type DiscourseConversationSummary,
  type DiscourseConversationTombstoneRecord,
  type DiscourseDraftRecord,
  type DiscourseDraftTokenInput,
  type DiscourseMessagePage,
  type DiscourseMessageRecord,
  type DiscourseParticipantRecord,
  type DiscourseParticipantRevisionRecord,
  type DiscourseResponseWaveRecord,
  type DiscourseSummaryRecord,
  type SaveDiscourseDraftRequest
} from '../../../shared/discourse';
import type {
  AcceptAgentDiscourseSendInput,
  AppendAgentDiscourseMessageInput,
  AppendHumanDiscourseMessageInput,
  CreateDiscourseConversationInput,
  CreateDiscourseWaveInput,
  DiscourseStore
} from '../../discourse/DiscourseStore';
import {
  assertContextSnapshotRecord,
  assertDiscourseDeliveryTransition,
  assertDiscourseJobRecord,
  assertDiscourseJobTransition,
  assertDiscourseMessageAppend,
  assertDiscourseWaveRecord,
  assertDiscourseWaveTransition,
  deriveDiscourseWaveAggregate,
  reconcileDiscourseDelivery
} from '../../discourse/DiscourseState';
import {
  AppDatabase,
  type AppDatabaseTransaction,
  type SqlReader
} from './AppDatabase';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RECEIPT_DOMAIN = 'DISCOURSE';
const CREATE_RECEIPT_DOMAIN = 'DISCOURSE_CREATE';
const CREATE_RECEIPT_OWNER = 'APP';

export interface SqliteDiscourseStoreOptions {
  now?: () => string;
  createId?: () => string;
}

interface PayloadRow {
  payloadJson: string;
}

interface IndexedPayloadRow extends PayloadRow {
  [column: string]: unknown;
}

interface OrderedPayloadRow extends IndexedPayloadRow {
  aggregateOrdinal: number;
}

interface ConversationRow extends PayloadRow {
  id: string;
  title: string;
  status: string;
  defaultPolicy: string;
  latestOrdinal: number;
  readOrdinal: number;
  latestEventSequence: number;
  recordRevision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface MessageRow extends PayloadRow {
  id: string;
  conversationId: string;
  clientMessageId: string | null;
  messageOrdinal: number;
  authorKind: string;
  parentMessageId: string | null;
  status: string;
  createdAt: string;
}

interface DraftRow extends PayloadRow {
  id: string;
  conversationId: string | null;
  recordRevision: number;
  updatedAt: string;
}

interface TombstoneRow extends PayloadRow {
  conversationId: string;
  clientOperationId: string;
  requestFingerprint: string;
  lastEventSequence: number;
  deletedAt: string;
}

class MessageLookup {
  private readonly records = new Map<string, DiscourseMessageRecord>();

  constructor(
    readonly reader: SqlReader,
    private readonly conversationId: string
  ) {}

  remember(message: DiscourseMessageRecord): void {
    this.records.set(message.id, clone(message));
  }

  get(messageId: string): MessageHeader | undefined {
    const message = this.getRecord(messageId);
    if (!message) return undefined;
    return {
      id: message.id,
      conversationId: message.conversationId,
      ordinal: message.ordinal,
      author: clone(message.author),
      status: message.status,
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(message.waveId ? { waveId: message.waveId } : {}),
      ...(message.jobId ? { jobId: message.jobId } : {})
    };
  }

  getRecord(messageId: string): DiscourseMessageRecord | undefined {
    const cached = this.records.get(messageId);
    if (cached) return clone(cached);
    const row = this.reader.get<MessageRow>(
      `SELECT id, conversation_id AS conversationId,
              client_message_id AS clientMessageId,
              message_ordinal AS messageOrdinal, author_kind AS authorKind,
              parent_message_id AS parentMessageId, status, created_at AS createdAt,
              payload_json AS payloadJson
         FROM discourse_messages
        WHERE id = ? AND conversation_id = ?`,
      [messageId, this.conversationId]
    );
    if (!row) return undefined;
    const message = parseMessageRow(row);
    this.records.set(message.id, message);
    return clone(message);
  }

  getByJob(jobId: string): DiscourseMessageRecord | undefined {
    const cached = [...this.records.values()].find((message) => message.jobId === jobId);
    if (cached) return clone(cached);
    const row = this.reader.get<MessageRow>(
      `SELECT id, conversation_id AS conversationId,
              client_message_id AS clientMessageId,
              message_ordinal AS messageOrdinal, author_kind AS authorKind,
              parent_message_id AS parentMessageId, status, created_at AS createdAt,
              payload_json AS payloadJson
         FROM discourse_messages
        WHERE conversation_id = ? AND json_extract(payload_json, '$.jobId') = ?
        LIMIT 1`,
      [this.conversationId, jobId]
    );
    if (!row) return undefined;
    const message = parseMessageRow(row);
    this.records.set(message.id, message);
    return clone(message);
  }
}

function loadConversation(reader: SqlReader, conversationId: string): LoadedConversation {
  requireSafeId(conversationId, 'conversation id');
  const tombstone = findTombstone(reader, conversationId);
  if (tombstone) throw new Error(`Discourse conversation was deleted: ${conversationId}`);
  const row = reader.get<ConversationRow>(
    `SELECT id, title, status, default_policy AS defaultPolicy,
            latest_ordinal AS latestOrdinal, read_ordinal AS readOrdinal,
            latest_event_sequence AS latestEventSequence,
            record_revision AS recordRevision, created_at AS createdAt,
            updated_at AS updatedAt, archived_at AS archivedAt,
            payload_json AS payloadJson
       FROM discourse_conversations WHERE id = ?`,
    [conversationId]
  );
  if (!row) throw new Error(`Discourse conversation not found: ${conversationId}`);

  try {
    const conversation = parsePayload<DiscourseConversationRecord>(
      row.payloadJson,
      'conversation'
    );
    if (
      conversation.id !== row.id ||
      conversation.id !== conversationId ||
      conversation.title !== row.title ||
      conversation.status !== row.status ||
      conversation.defaultPolicy !== row.defaultPolicy ||
      conversation.latestOrdinal !== row.latestOrdinal ||
      conversation.readOrdinal !== row.readOrdinal ||
      conversation.recordRevision !== row.recordRevision ||
      conversation.createdAt !== row.createdAt ||
      conversation.updatedAt !== row.updatedAt ||
      (conversation.archivedAt ?? null) !== row.archivedAt
    ) {
      throw new Error('conversation columns do not match its payload');
    }

    const aggregate: DiscourseConversationAggregateRecord = {
      conversation,
      participants: loadOrderedPayloads<DiscourseParticipantRecord>(
        reader,
        `SELECT id, conversation_id AS conversationId,
                aggregate_ordinal AS aggregateOrdinal,
                agent_profile_id AS agentProfileId,
                current_revision_id AS currentRevisionId,
                enabled, record_revision AS recordRevision,
                created_at AS createdAt, payload_json AS payloadJson
           FROM discourse_participants
          WHERE conversation_id = ? ORDER BY aggregate_ordinal`,
        [conversationId],
        'participant',
        (record) => ({
          id: record.id,
          conversationId: record.conversationId,
          agentProfileId: record.agentProfileId,
          currentRevisionId: record.currentRevisionId,
          enabled: record.enabled ? 1 : 0,
          recordRevision: record.recordRevision,
          createdAt: record.createdAt
        })
      ),
      participantRevisions: loadPayloads<DiscourseParticipantRevisionRecord>(
        reader,
        `SELECT id, conversation_id AS conversationId,
                stable_participant_id AS stableParticipantId,
                revision, created_at AS createdAt, payload_json AS payloadJson
           FROM discourse_participant_revisions
          WHERE conversation_id = ? ORDER BY revision, id`,
        [conversationId],
        'participant revision',
        (record) => ({
          id: record.id,
          conversationId: record.conversationId,
          stableParticipantId: record.stableParticipantId,
          revision: record.revision,
          createdAt: record.createdAt
        })
      ),
      acceptedSends: loadOrderedPayloads<DiscourseAcceptedSendRecord>(
        reader,
        `SELECT id, conversation_id AS conversationId,
                aggregate_ordinal AS aggregateOrdinal,
                client_message_id AS clientMessageId,
                request_fingerprint AS requestFingerprint,
                status, record_revision AS recordRevision,
                created_at AS createdAt, canceled_at AS canceledAt,
                payload_json AS payloadJson
           FROM discourse_accepted_sends
          WHERE conversation_id = ? ORDER BY aggregate_ordinal`,
        [conversationId],
        'accepted send',
        (record) => ({
          id: record.id,
          conversationId: record.conversationId,
          clientMessageId: record.clientMessageId,
          requestFingerprint: record.requestFingerprint,
          status: record.status,
          recordRevision: record.recordRevision,
          createdAt: record.createdAt,
          canceledAt: record.canceledAt ?? null
        })
      ),
      contextLinks: loadOrderedPayloads<ConversationContextLinkRecord>(
        reader,
        `SELECT id, conversation_id AS conversationId,
                aggregate_ordinal AS aggregateOrdinal,
                created_by_message_id AS createdByMessageId,
                entity_kind AS entityKind, entity_id AS entityId,
                scope, availability, record_revision AS recordRevision,
                created_at AS createdAt, updated_at AS updatedAt,
                payload_json AS payloadJson
           FROM discourse_context_links
          WHERE conversation_id = ? ORDER BY aggregate_ordinal`,
        [conversationId],
        'context link',
        (record) => ({
          id: record.id,
          conversationId: record.conversationId,
          createdByMessageId: record.createdByMessageId ?? null,
          entityKind: record.entityKind,
          entityId: record.entityId,
          scope: record.scope,
          availability: record.availability,
          recordRevision: record.recordRevision,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        })
      ),
      contextRevisions: loadPayloads<ConversationContextRevisionRecord>(
        reader,
        `SELECT id, conversation_id AS conversationId, revision,
                created_at AS createdAt, payload_json AS payloadJson
           FROM discourse_context_revisions
          WHERE conversation_id = ? ORDER BY revision, id`,
        [conversationId],
        'context revision',
        (record) => ({
          id: record.id,
          conversationId: record.conversationId,
          revision: record.revision,
          createdAt: record.createdAt
        })
      ),
      contextSnapshots: loadContextSnapshots(reader, conversationId),
      waves: loadOrderedPayloads<DiscourseResponseWaveRecord>(
        reader,
        `SELECT id, conversation_id AS conversationId,
                aggregate_ordinal AS aggregateOrdinal,
                context_snapshot_id AS contextSnapshotId,
                status, phase, outcome,
                client_operation_id AS clientOperationId,
                request_fingerprint AS requestFingerprint,
                record_revision AS recordRevision,
                created_at AS createdAt, started_at AS startedAt,
                settled_at AS settledAt, payload_json AS payloadJson
           FROM discourse_waves
          WHERE conversation_id = ? ORDER BY aggregate_ordinal`,
        [conversationId],
        'wave',
        (record) => ({
          id: record.id,
          conversationId: record.conversationId,
          contextSnapshotId: record.contextSnapshotId ?? null,
          status: record.status,
          phase: record.phase ?? null,
          outcome: record.outcome ?? null,
          clientOperationId: record.clientOperationId,
          requestFingerprint: record.requestFingerprint,
          recordRevision: record.recordRevision,
          createdAt: record.createdAt,
          startedAt: record.startedAt ?? null,
          settledAt: record.settledAt ?? null
        })
      ),
      jobs: loadOrderedPayloads<DiscourseAgentJobRecord>(
        reader,
        `SELECT id, conversation_id AS conversationId,
                aggregate_ordinal AS aggregateOrdinal, wave_id AS waveId,
                stable_participant_id AS stableParticipantId,
                session_id AS sessionId, run_id AS runId,
                status, delivery_status AS deliveryStatus,
                attempt_id AS attemptId, generation_key AS generationKey,
                record_revision AS recordRevision,
                created_at AS createdAt, started_at AS startedAt,
                finished_at AS finishedAt, payload_json AS payloadJson
           FROM discourse_jobs
          WHERE conversation_id = ? ORDER BY aggregate_ordinal`,
        [conversationId],
        'job',
        (record) => ({
          id: record.id,
          conversationId: record.conversationId,
          waveId: record.waveId,
          stableParticipantId: record.assignment.stableParticipantId,
          sessionId: record.sessionId ?? null,
          runId: record.runId ?? null,
          status: record.status,
          deliveryStatus: record.delivery,
          attemptId: record.attemptId,
          generationKey: record.generationKey,
          recordRevision: record.recordRevision,
          createdAt: record.createdAt,
          startedAt: record.startedAt ?? null,
          finishedAt: record.finishedAt ?? null
        })
      ),
      concerns: loadOrderedPayloads<DiscourseConcernRecord>(
        reader,
        `SELECT id, conversation_id AS conversationId,
                aggregate_ordinal AS aggregateOrdinal, wave_id AS waveId,
                review_job_id AS reviewJobId, severity,
                record_revision AS recordRevision,
                created_at AS createdAt, payload_json AS payloadJson
           FROM discourse_concerns
          WHERE conversation_id = ? ORDER BY aggregate_ordinal`,
        [conversationId],
        'concern',
        (record) => ({
          id: record.id,
          conversationId: record.conversationId,
          waveId: record.waveId,
          reviewJobId: record.reviewJobId,
          severity: record.severity,
          recordRevision: record.recordRevision,
          createdAt: record.createdAt
        })
      ),
      summaries: loadPayloads<DiscourseSummaryRecord>(
        reader,
        `SELECT id, conversation_id AS conversationId, revision,
                covered_ordinal_start AS coveredOrdinalStart,
                covered_ordinal_end AS coveredOrdinalEnd,
                created_at AS createdAt, payload_json AS payloadJson
           FROM discourse_summaries
          WHERE conversation_id = ? ORDER BY revision, id`,
        [conversationId],
        'summary',
        (record) => ({
          id: record.id,
          conversationId: record.conversationId,
          revision: record.revision,
          coveredOrdinalStart: record.coveredOrdinalStart,
          coveredOrdinalEnd: record.coveredOrdinalEnd,
          createdAt: record.createdAt
        })
      ),
      // Drafts retain their existing independent list/get lifecycle. They are
      // linked for deletion, but are not part of conversation mutation state.
      drafts: [],
      latestEventSequence: row.latestEventSequence
    };
    const loaded = { aggregate, messages: new MessageLookup(reader, conversationId) };
    validateLoaded(loaded, reader);
    return loaded;
  } catch (error) {
    if (isStoredIntegrityError(error)) throw error;
    throw storedIntegrity(`aggregate is invalid: ${errorMessage(error)}`);
  }
}

function loadPayloads<T>(
  reader: SqlReader,
  sql: string,
  parameters: readonly (string | number)[],
  label: string,
  indexedValues: (record: T, index: number) => Record<string, unknown>
): T[] {
  return reader.all<IndexedPayloadRow>(sql, parameters).map((row, index) => {
    const record = parsePayload<T>(row.payloadJson, label);
    assertIndexedPayload(row, indexedValues(record, index), label);
    return record;
  });
}

function loadOrderedPayloads<T>(
  reader: SqlReader,
  sql: string,
  parameters: readonly (string | number)[],
  label: string,
  indexedValues: (record: T, index: number) => Record<string, unknown>
): T[] {
  return reader.all<OrderedPayloadRow>(sql, parameters).map((row, index) => {
    if (row.aggregateOrdinal !== index) {
      throw new Error(`${label} aggregate ordinal is not contiguous`);
    }
    const record = parsePayload<T>(row.payloadJson, label);
    assertIndexedPayload(row, indexedValues(record, index), label);
    return record;
  });
}

function assertIndexedPayload(
  row: IndexedPayloadRow,
  expected: Record<string, unknown>,
  label: string
): void {
  for (const [column, value] of Object.entries(expected)) {
    const stored = row[column];
    if (stored === value || integerValuesEqual(stored, value)) continue;
    throw new Error(
      `${label} column ${column} does not match its payload ` +
        `(stored ${String(stored)}, payload ${String(value)})`
    );
  }
}

function integerValuesEqual(left: unknown, right: unknown): boolean {
  if (
    (typeof left !== 'number' && typeof left !== 'bigint') ||
    (typeof right !== 'number' && typeof right !== 'bigint')
  ) {
    return false;
  }
  return Number.isSafeInteger(Number(left)) && Number(left) === Number(right);
}

function loadContextSnapshots(
  reader: SqlReader,
  conversationId: string
): ContextSnapshotRecord[] {
  const snapshots = loadOrderedPayloads<ContextSnapshotRecord>(
    reader,
    `SELECT id, conversation_id AS conversationId,
            aggregate_ordinal AS aggregateOrdinal, wave_id AS waveId,
            context_revision_id AS contextRevisionId, status,
            record_revision AS recordRevision,
            created_at AS createdAt, resolved_at AS resolvedAt,
            payload_json AS payloadJson
       FROM discourse_context_snapshots
      WHERE conversation_id = ? ORDER BY aggregate_ordinal`,
    [conversationId],
    'context snapshot',
    (record) => ({
      id: record.id,
      conversationId: record.conversationId,
      waveId: record.waveId,
      contextRevisionId: record.contextRevisionId,
      status: record.status,
      recordRevision: record.recordRevision,
      createdAt: record.createdAt,
      resolvedAt: record.resolvedAt ?? null
    })
  );
  for (const snapshot of snapshots) {
    const sources = loadOrderedPayloads<ContextSnapshotRecord['sources'][number]>(
      reader,
      `SELECT context_snapshot_id AS contextSnapshotId,
              context_link_id AS contextLinkId, entity_kind AS entityKind,
              entity_id AS entityId, access_mode AS accessMode,
              source_ordinal AS aggregateOrdinal, payload_json AS payloadJson
         FROM discourse_context_sources
        WHERE context_snapshot_id = ? ORDER BY source_ordinal`,
      [snapshot.id],
      'context source',
      (record) => ({
        contextSnapshotId: snapshot.id,
        contextLinkId: record.contextLinkId,
        entityKind: record.entityKind,
        entityId: record.entityId,
        accessMode: record.accessMode
      })
    );
    if (stableStringify(sources) !== stableStringify(snapshot.sources)) {
      throw new Error('context snapshot source rows do not match its payload');
    }
  }
  return snapshots;
}

function validateLoaded(loaded: LoadedConversation, reader: SqlReader): void {
  const aggregate = loaded.aggregate;
  const conversation = aggregate.conversation;
  requireSafeId(conversation.id, 'conversation id');
  validateTitle(conversation.title);
  if (
    !['OPEN', 'ARCHIVED'].includes(conversation.status) ||
    !['TEAM', 'PANEL', 'DIRECT', 'NONE'].includes(conversation.defaultPolicy) ||
    !Number.isSafeInteger(conversation.recordRevision) ||
    conversation.recordRevision < 1 ||
    !Number.isSafeInteger(conversation.latestOrdinal) ||
    conversation.latestOrdinal < 0 ||
    !Number.isSafeInteger(conversation.readOrdinal) ||
    conversation.readOrdinal < 0 ||
    conversation.readOrdinal > conversation.latestOrdinal ||
    !Number.isSafeInteger(aggregate.latestEventSequence) ||
    aggregate.latestEventSequence < 1
  ) {
    throw new Error('conversation counters or state are invalid');
  }
  requireTimestamp(conversation.createdAt);
  requireTimestamp(conversation.updatedAt);
  if (conversation.archivedAt) requireTimestamp(conversation.archivedAt);

  assertUniqueRecordIds(aggregate.participants, 'participant');
  assertUniqueRecordIds(aggregate.participantRevisions, 'participant revision');
  const participantIds = aggregate.participants.map(({ id }) => id);
  if (stableStringify(participantIds) !== stableStringify(conversation.participantIds)) {
    throw new Error('conversation participant roster is inconsistent');
  }
  for (const participant of aggregate.participants) {
    const revision = aggregate.participantRevisions.find(
      ({ id }) => id === participant.currentRevisionId
    );
    if (
      participant.conversationId !== conversation.id ||
      participant.recordRevision < 1 ||
      !revision ||
      revision.conversationId !== conversation.id ||
      revision.stableParticipantId !== participant.id ||
      revision.agentProfileId !== participant.agentProfileId
    ) {
      throw new Error('participant binding is invalid');
    }
    requireTimestamp(participant.createdAt);
    assertParticipantRevisionRecord(revision);
  }
  const enabledProfiles = aggregate.participants
    .filter(({ enabled }) => enabled)
    .map(({ agentProfileId }) => agentProfileId);
  if (new Set(enabledProfiles).size !== enabledProfiles.length) {
    throw new Error('enabled participant profiles are not unique');
  }

  const messageStats = reader.get<{ count: number; maximum: number | null }>(
    `SELECT count(*) AS count, max(message_ordinal) AS maximum
       FROM discourse_messages WHERE conversation_id = ?`,
    [conversation.id]
  );
  if (
    (messageStats?.count ?? 0) !== conversation.latestOrdinal ||
    (messageStats?.maximum ?? 0) !== conversation.latestOrdinal
  ) {
    throw new Error('conversation latest ordinal does not match its messages');
  }

  assertUniqueRecordIds(aggregate.acceptedSends, 'accepted send');
  for (const accepted of aggregate.acceptedSends) {
    if (
      accepted.conversationId !== conversation.id ||
      accepted.recordRevision < 1 ||
      !loaded.messages.get(accepted.triggerMessageId) ||
      accepted.visibleMessageIds.some((id) => !loaded.messages.get(id))
    ) {
      throw new Error('accepted send binding is invalid');
    }
  }

  assertUniqueRecordIds(aggregate.contextLinks, 'context link');
  assertUniqueRecordIds(aggregate.contextRevisions, 'context revision');
  const linkIds = new Set(aggregate.contextLinks.map(({ id }) => id));
  for (const [index, revision] of aggregate.contextRevisions.entries()) {
    if (
      revision.conversationId !== conversation.id ||
      revision.revision !== index + 1 ||
      revision.references.length > DISCOURSE_LIMITS.maxContextReferencesPerWave ||
      revision.references.some(({ contextLinkId }) => !linkIds.has(contextLinkId))
    ) {
      throw new Error('context revision history is invalid');
    }
  }
  if (
    conversation.pinnedContextRevisionId &&
    !aggregate.contextRevisions.some(({ id }) => id === conversation.pinnedContextRevisionId)
  ) {
    throw new Error('pinned context revision is missing');
  }

  assertUniqueRecordIds(aggregate.contextSnapshots, 'context snapshot');
  for (const snapshot of aggregate.contextSnapshots) {
    assertContextSnapshotRecord(snapshot);
    if (
      snapshot.conversationId !== conversation.id ||
      !aggregate.contextRevisions.some(({ id }) => id === snapshot.contextRevisionId)
    ) {
      throw new Error('context snapshot ownership is invalid');
    }
  }

  assertUniqueRecordIds(aggregate.waves, 'wave');
  assertUniqueRecordIds(aggregate.jobs, 'job');
  assertUniqueRecordIds(aggregate.concerns, 'concern');
  for (const wave of aggregate.waves) {
    assertDiscourseWaveRecord(wave);
    if (wave.conversationId !== conversation.id) {
      throw new Error('wave ownership is invalid');
    }
    deriveDiscourseWaveAggregate({
      wave,
      jobs: aggregate.jobs.filter(({ waveId }) => waveId === wave.id),
      concerns: aggregate.concerns.filter(({ waveId }) => waveId === wave.id)
    });
  }
  for (const job of aggregate.jobs) {
    assertDiscourseJobRecord(job);
    if (
      job.conversationId !== conversation.id ||
      !aggregate.waves.some(({ id }) => id === job.waveId)
    ) {
      throw new Error('job ownership is invalid');
    }
    assertJobResultMessageLink(job, loaded);
  }
  for (const concern of aggregate.concerns) validateConcern(concern, loaded);
}

function validateConcern(concern: DiscourseConcernRecord, loaded: LoadedConversation): void {
  const review = loaded.aggregate.jobs.find(({ id }) => id === concern.reviewJobId);
  const correction = concern.resolution
    ? loaded.aggregate.jobs.find(({ id }) => id === concern.resolution!.correctionJobId)
    : undefined;
  if (
    concern.conversationId !== loaded.aggregate.conversation.id ||
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
    throw new Error('concern record is invalid');
  }
  requireTimestamp(concern.createdAt);
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

interface LoadedConversation {
  aggregate: DiscourseConversationAggregateRecord;
  messages: MessageLookup;
}

interface MutationResult<T> {
  result: T;
  receipt: Record<string, unknown>;
  messages?: DiscourseMessageRecord[];
}

interface OperationReceipt {
  requestFingerprint: string;
  result: Record<string, unknown>;
}

/** SQLite-backed authority for curated Discourse records. */
export class SqliteDiscourseStore implements DiscourseStore {
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly active = new Set<Promise<unknown>>();
  private closing = false;

  constructor(
    private readonly database: AppDatabase,
    options: SqliteDiscourseStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
  }

  init(): Promise<void> {
    return this.track(this.database.read((reader) => {
      validateDiscourseInventory(reader);
    }));
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active]);
  }

  createConversation(
    input: CreateDiscourseConversationInput
  ): Promise<DiscourseConversationRecord> {
    validateTitle(input.title);
    validateOperationId(input.clientOperationId);
    requireFingerprint(input.requestFingerprint, 'conversation request fingerprint');
    return this.write((transaction) => {
      const prior = readReceipt(
        transaction,
        CREATE_RECEIPT_DOMAIN,
        CREATE_RECEIPT_OWNER,
        input.clientOperationId
      );
      if (prior) {
        assertReceiptFingerprint(prior, input.requestFingerprint);
        return clone(
          loadConversation(
            transaction,
            requireReceiptId(prior.result, 'conversationId')
          ).aggregate.conversation
        );
      }
      const count = transaction.get<{ count: number }>(
        'SELECT count(*) AS count FROM discourse_conversations'
      )?.count ?? 0;
      if (count >= DISCOURSE_LIMITS.maxConversationSummariesInSnapshot) {
        throw new Error('Discourse conversation limit reached. Archive/export policy is required.');
      }
      const id = input.id ?? this.createId();
      requireSafeId(id, 'conversation id');
      if (findTombstone(transaction, id)) {
        throw new Error(`Deleted discourse conversation ids cannot be reused: ${id}`);
      }
      if (conversationExists(transaction, id)) {
        throw new Error(`Discourse conversation already exists: ${id}`);
      }
      const participants = input.participants.map((participant) => ({
        ...participant,
        conversationId: id
      }));
      const participantRevisions = input.participantRevisions.map((revision) => ({
        ...revision,
        conversationId: id
      }));
      assertParticipantSeed(participants, participantRevisions, id);
      const timestamp = requireTimestamp(this.now());
      const conversation: DiscourseConversationRecord = {
        id,
        title: input.title.trim(),
        status: 'OPEN',
        defaultPolicy: input.defaultPolicy,
        participantIds: participants.map((participant) => participant.id),
        recordRevision: 1,
        latestOrdinal: 0,
        readOrdinal: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const aggregate: DiscourseConversationAggregateRecord = {
        conversation,
        participants,
        participantRevisions,
        acceptedSends: [],
        contextLinks: [],
        contextRevisions: [],
        contextSnapshots: [],
        waves: [],
        jobs: [],
        concerns: [],
        summaries: [],
        drafts: [],
        latestEventSequence: 1
      };
      validateLoaded(
        { aggregate, messages: new MessageLookup(transaction, id) },
        transaction
      );
      persistAggregate(transaction, aggregate);
      writeReceipt(transaction, {
        domain: CREATE_RECEIPT_DOMAIN,
        ownerId: CREATE_RECEIPT_OWNER,
        operationId: input.clientOperationId,
        requestFingerprint: input.requestFingerprint,
        result: { conversationId: id },
        createdAt: timestamp
      });
      return clone(conversation);
    });
  }

  findCreatedConversation(input: {
    clientOperationId: string;
    requestFingerprint: string;
  }): Promise<DiscourseConversationRecord | undefined> {
    validateOperationId(input.clientOperationId);
    requireFingerprint(input.requestFingerprint, 'conversation request fingerprint');
    return this.read((reader) => {
      const receipt = readReceipt(
        reader,
        CREATE_RECEIPT_DOMAIN,
        CREATE_RECEIPT_OWNER,
        input.clientOperationId
      );
      if (!receipt) return undefined;
      assertReceiptFingerprint(receipt, input.requestFingerprint);
      return clone(
        loadConversation(reader, requireReceiptId(receipt.result, 'conversationId'))
          .aggregate.conversation
      );
    });
  }

  getConversation(conversationId: string): Promise<DiscourseConversationAggregateRecord> {
    requireSafeId(conversationId, 'conversation id');
    return this.read((reader) => clone(loadConversation(reader, conversationId).aggregate));
  }

  listConversations(
    input: { status?: 'OPEN' | 'ARCHIVED'; cursor?: string; limit?: number } = {}
  ): Promise<DiscourseConversationPage> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Discourse conversation page limit must be between 1 and 100.');
    }
    return this.read((reader) => {
      const whereClause = input.status ? ' WHERE status = ?' : '';
      const statusParameters = input.status ? [input.status] : [];
      const total = reader.get<{ count: number }>(
        `SELECT count(*) AS count FROM discourse_conversations${whereClause}`,
        statusParameters
      )?.count ?? 0;
      const offset = decodeOffsetCursor(input.cursor, total);
      const selected = reader.all<{ id: string }>(
        `SELECT id FROM discourse_conversations${whereClause}
          ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
        [...statusParameters, limit, offset]
      );
      const conversations = selected.map(({ id }) =>
        summaryFromLoaded(loadConversation(reader, id), reader)
      );
      return {
        conversations,
        ...(offset + selected.length < total
          ? { nextCursor: encodeOffsetCursor(offset + selected.length) }
          : {})
      };
    });
  }

  addParticipants(input: {
    conversationId: string;
    participants: DiscourseParticipantRecord[];
    participantRevisions: DiscourseParticipantRevisionRecord[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationAggregateRecord> {
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest(input);
    return this.mutateConversation(
      input.conversationId,
      `roster:${input.clientOperationId}`,
      fingerprint,
      (_receipt, loaded) => clone(loaded.aggregate),
      (loaded) => {
        if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
          throw new Error('Discourse conversation changed before roster update.');
        }
        if (input.participants.length !== input.participantRevisions.length) {
          throw new Error('Discourse roster update requires matching participant revisions.');
        }
        const participantIds = new Set(loaded.aggregate.participants.map(({ id }) => id));
        const revisionIds = new Set(loaded.aggregate.participantRevisions.map(({ id }) => id));
        for (const [index, participant] of input.participants.entries()) {
          const revision = input.participantRevisions[index]!;
          if (
            participant.conversationId !== input.conversationId ||
            revision.conversationId !== input.conversationId ||
            revision.stableParticipantId !== participant.id ||
            participant.currentRevisionId !== revision.id ||
            participantIds.has(participant.id) ||
            revisionIds.has(revision.id)
          ) {
            throw new Error('Discourse roster update contains invalid participant ownership.');
          }
        }
        loaded.aggregate.participants.push(...clone(input.participants));
        loaded.aggregate.participantRevisions.push(...clone(input.participantRevisions));
        loaded.aggregate.conversation = bumpConversation(
          loaded.aggregate.conversation,
          this.now(),
          {
            participantIds: [
              ...loaded.aggregate.conversation.participantIds,
              ...input.participants.map(({ id }) => id)
            ]
          }
        );
        return { result: clone(loaded.aggregate), receipt: { kind: 'aggregate' } };
      }
    );
  }

  configureParticipants(input: {
    conversationId: string;
    participants: DiscourseParticipantRecord[];
    participantRevisions: DiscourseParticipantRevisionRecord[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationAggregateRecord> {
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest(input);
    return this.mutateConversation(
      input.conversationId,
      `participant-configuration:${input.clientOperationId}`,
      fingerprint,
      (_receipt, loaded) => clone(loaded.aggregate),
      (loaded) => {
        if (loaded.aggregate.conversation.status !== 'OPEN') {
          throw new Error('Archived discourse conversations cannot change agent configuration.');
        }
        if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
          throw new Error('Discourse conversation changed before participant configuration update.');
        }
        const newIds = validateParticipantConfigurationBatch(
          loaded,
          input.conversationId,
          input.participants,
          input.participantRevisions,
          false
        );
        for (const participant of input.participants) {
          replaceOrAppend(loaded.aggregate.participants, clone(participant));
        }
        loaded.aggregate.participantRevisions.push(...clone(input.participantRevisions));
        loaded.aggregate.conversation = bumpConversation(
          loaded.aggregate.conversation,
          this.now(),
          {
            participantIds: [...loaded.aggregate.conversation.participantIds, ...newIds]
          }
        );
        return { result: clone(loaded.aggregate), receipt: { kind: 'aggregate' } };
      }
    );
  }

  acceptAgentSend(input: AcceptAgentDiscourseSendInput): Promise<{
    message: DiscourseMessageRecord;
    acceptedSend: DiscourseAcceptedSendRecord;
    aggregate: DiscourseConversationAggregateRecord;
  }> {
    validateOperationId(input.clientMessageId);
    requireFingerprint(input.requestFingerprint, 'send request fingerprint');
    requireFingerprint(input.previewFingerprint, 'context preview fingerprint');
    if (!['DIRECT', 'PANEL', 'TEAM'].includes(input.policy)) {
      throw new Error('Discourse accepted send policy or context preview is invalid.');
    }
    return this.mutateConversation(
      input.conversationId,
      `agent-send:${input.clientMessageId}`,
      input.requestFingerprint,
      (receipt, loaded, transaction) => {
        const message = loadMessage(
          transaction,
          requireReceiptId(receipt, 'messageId'),
          input.conversationId
        );
        const acceptedSendId = requireReceiptId(receipt, 'acceptedSendId');
        const acceptedSend = loaded.aggregate.acceptedSends.find(
          ({ id }) => id === acceptedSendId
        );
        if (!acceptedSend) throw storedIntegrity('accepted send receipt target is missing');
        return { message: presentMessage(message), acceptedSend: clone(acceptedSend), aggregate: clone(loaded.aggregate) };
      },
      (loaded) => {
        const aggregate = loaded.aggregate;
        if (aggregate.conversation.status !== 'OPEN') {
          throw new Error('Archived discourse conversations cannot accept messages.');
        }
        if (aggregate.conversation.recordRevision !== input.expectedRevision) {
          throw new Error('Discourse conversation changed before agent send acceptance.');
        }
        const waveTriggers = new Set(aggregate.waves.map(({ triggerMessageId }) => triggerMessageId));
        const pending = aggregate.acceptedSends.filter(
          (accepted) => accepted.status === 'PENDING' && !waveTriggers.has(accepted.triggerMessageId)
        ).length;
        const active = aggregate.waves.filter(({ status }) => status !== 'SETTLED').length;
        if (pending + active >= 8) {
          throw new Error('Discourse conversation has reached its queued-response safety limit.');
        }
        validateMessageBody(input.body);
        const sourceMessageIds = uniqueIds(input.sourceMessageIds ?? []);
        if (
          input.priorVisibleMessageIds.length > DISCOURSE_LIMITS.maxRecentTranscriptMessages - 1 ||
          new Set(input.priorVisibleMessageIds).size !== input.priorVisibleMessageIds.length
        ) {
          throw new Error('Discourse accepted send transcript window is invalid.');
        }
        assertMessageReferencesExist(loaded, input.priorVisibleMessageIds, 'accepted send visible message');
        const context = normalizeResolvedContext(input.context ?? []);
        const newParticipantIds = validateParticipantConfigurationBatch(
          loaded,
          input.conversationId,
          input.participants,
          input.participantRevisions,
          true
        );
        const revisions = [...aggregate.participantRevisions, ...input.participantRevisions];
        if (
          input.assignments.length === 0 ||
          input.assignments.some((assignment) => {
            const revision = revisions.find(({ id }) => id === assignment.participantRevisionId);
            return !revision || !assignmentMatchesParticipantRevision(assignment, revision);
          })
        ) {
          throw new Error('Discourse accepted send assignments are invalid.');
        }
        const timestamp = requireTimestamp(this.now());
        const messageId = this.createId();
        requireSafeId(messageId, 'message id');
        const contextUpdate = buildMessageContextUpdate({
          loaded,
          messageId,
          context,
          createId: this.createId,
          now: timestamp
        });
        const message: DiscourseMessageRecord = {
          id: messageId,
          conversationId: input.conversationId,
          ordinal: aggregate.conversation.latestOrdinal + 1,
          author: { kind: 'USER' },
          body: input.body,
          status: 'VISIBLE',
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
          ...(input.supersedesMessageId ? { supersedesMessageId: input.supersedesMessageId } : {}),
          sourceMessageIds,
          contextRevisionId: contextUpdate.revision.id,
          clientMessageId: input.clientMessageId,
          requestFingerprint: input.requestFingerprint,
          createdAt: timestamp
        };
        assertMessageAgainstLookup(loaded, message);
        const messages = [message];
        if (input.supersedesMessageId) {
          messages.push(supersedeMessage(loaded, input.supersedesMessageId));
        }
        const acceptedSend: DiscourseAcceptedSendRecord = {
          id: this.createId(),
          conversationId: input.conversationId,
          triggerMessageId: message.id,
          clientMessageId: input.clientMessageId,
          policy: input.policy,
          assignments: clone(input.assignments),
          visibleMessageIds: [...input.priorVisibleMessageIds, message.id],
          previewFingerprint: input.previewFingerprint,
          requestFingerprint: input.requestFingerprint,
          status: 'PENDING',
          recordRevision: 1,
          createdAt: timestamp
        };
        for (const participant of input.participants) {
          replaceOrAppend(aggregate.participants, clone(participant));
        }
        aggregate.participantRevisions.push(...clone(input.participantRevisions));
        aggregate.acceptedSends.push(acceptedSend);
        aggregate.contextLinks.push(...contextUpdate.links);
        aggregate.contextRevisions.push(contextUpdate.revision);
        aggregate.conversation = bumpConversation(aggregate.conversation, timestamp, {
          participantIds: [...aggregate.conversation.participantIds, ...newParticipantIds],
          latestOrdinal: message.ordinal,
          readOrdinal: message.ordinal
        });
        loaded.messages.remember(message);
        return {
          result: { message: clone(message), acceptedSend: clone(acceptedSend), aggregate: clone(aggregate) },
          receipt: { messageId: message.id, acceptedSendId: acceptedSend.id },
          messages
        };
      }
    );
  }

  cancelAcceptedSend(input: {
    conversationId: string;
    acceptedSendId: string;
    expectedConversationRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationAggregateRecord> {
    requireSafeId(input.acceptedSendId, 'accepted send id');
    validateOperationId(input.clientOperationId);
    return this.mutateConversation(
      input.conversationId,
      `accepted-send-cancel:${input.clientOperationId}`,
      hashRequest(input),
      (_receipt, loaded) => clone(loaded.aggregate),
      (loaded) => {
        const aggregate = loaded.aggregate;
        if (aggregate.conversation.recordRevision !== input.expectedConversationRevision) {
          throw new Error('Discourse conversation changed before response cancellation.');
        }
        const accepted = aggregate.acceptedSends.find(({ id }) => id === input.acceptedSendId);
        if (!accepted || accepted.status !== 'PENDING') {
          throw new Error('The interrupted agent response is no longer pending.');
        }
        if (aggregate.waves.some(({ triggerMessageId }) => triggerMessageId === accepted.triggerMessageId)) {
          throw new Error('This agent response has already been planned. Stop its response instead.');
        }
        const timestamp = requireTimestamp(this.now());
        replaceRecord(aggregate.acceptedSends, {
          ...accepted,
          status: 'CANCELED',
          recordRevision: accepted.recordRevision + 1,
          canceledAt: timestamp
        }, 'accepted send');
        aggregate.conversation = bumpConversation(aggregate.conversation, timestamp);
        return { result: clone(aggregate), receipt: { acceptedSendId: accepted.id } };
      }
    );
  }

  appendHumanMessage(input: AppendHumanDiscourseMessageInput): Promise<DiscourseMessageRecord> {
    validateOperationId(input.clientMessageId);
    validateMessageBody(input.body);
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
    return this.mutateConversation(
      input.conversationId,
      `message:${input.clientMessageId}`,
      fingerprint,
      (receipt, _loaded, transaction) => presentMessage(loadMessage(
        transaction,
        requireReceiptId(receipt, 'messageId'),
        input.conversationId
      )),
      (loaded) => {
        if (loaded.aggregate.conversation.status !== 'OPEN') {
          throw new Error('Archived discourse conversations cannot accept messages.');
        }
        const timestamp = requireTimestamp(this.now());
        const messageId = this.createId();
        requireSafeId(messageId, 'message id');
        const contextUpdate = buildMessageContextUpdate({
          loaded,
          messageId,
          context,
          createId: this.createId,
          now: timestamp
        });
        const message: DiscourseMessageRecord = {
          id: messageId,
          conversationId: input.conversationId,
          ordinal: loaded.aggregate.conversation.latestOrdinal + 1,
          author: { kind: 'USER' },
          body: input.body,
          status: 'VISIBLE',
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
          ...(input.supersedesMessageId ? { supersedesMessageId: input.supersedesMessageId } : {}),
          sourceMessageIds,
          contextRevisionId: contextUpdate.revision.id,
          clientMessageId: input.clientMessageId,
          requestFingerprint: fingerprint,
          createdAt: timestamp
        };
        assertMessageAgainstLookup(loaded, message);
        const messages = [message];
        if (input.supersedesMessageId) messages.push(supersedeMessage(loaded, input.supersedesMessageId));
        loaded.aggregate.contextLinks.push(...contextUpdate.links);
        loaded.aggregate.contextRevisions.push(contextUpdate.revision);
        loaded.aggregate.conversation = bumpConversation(loaded.aggregate.conversation, timestamp, {
          latestOrdinal: message.ordinal,
          readOrdinal: message.ordinal
        });
        loaded.messages.remember(message);
        return { result: clone(message), receipt: { messageId: message.id }, messages };
      }
    );
  }

  appendAgentMessage(input: AppendAgentDiscourseMessageInput): Promise<DiscourseMessageRecord> {
    validateOperationId(input.clientOperationId);
    validateAgentContribution(input.body);
    const sourceMessageIds = uniqueIds(input.sourceMessageIds);
    const fingerprint = hashRequest({ ...input, sourceMessageIds });
    return this.mutateConversation(
      input.conversationId,
      `agent-message:${input.clientOperationId}`,
      fingerprint,
      (receipt, _loaded, transaction) => presentMessage(loadMessage(
        transaction,
        requireReceiptId(receipt, 'messageId'),
        input.conversationId
      )),
      (loaded) => {
        if (loaded.aggregate.conversation.status !== 'OPEN') {
          throw new Error('Archived discourse conversations cannot accept messages.');
        }
        const job = loaded.aggregate.jobs.find(({ id }) => id === input.jobId);
        if (
          !job ||
          job.waveId !== input.waveId ||
          job.assignment.stableParticipantId !== input.stableParticipantId ||
          job.assignment.participantRevisionId !== input.participantRevisionId ||
          job.assignment.displayNameSnapshot !== input.displayNameSnapshot
        ) {
          throw new Error('Discourse agent message does not match its durable job assignment.');
        }
        if (loaded.messages.getByJob(input.jobId)) {
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
          ...(input.supersedesMessageId ? { supersedesMessageId: input.supersedesMessageId } : {}),
          sourceMessageIds,
          waveId: input.waveId,
          jobId: input.jobId,
          ...(input.contextSnapshotId ? { contextSnapshotId: input.contextSnapshotId } : {}),
          freshnessAtCompletion: input.freshnessAtCompletion,
          createdAt: requireTimestamp(this.now())
        };
        assertMessageAgainstLookup(loaded, message);
        const messages = [message];
        if (input.supersedesMessageId) messages.push(supersedeMessage(loaded, input.supersedesMessageId));
        loaded.aggregate.conversation = bumpConversation(
          loaded.aggregate.conversation,
          message.createdAt,
          { latestOrdinal: message.ordinal }
        );
        loaded.messages.remember(message);
        return { result: clone(message), receipt: { messageId: message.id }, messages };
      }
    );
  }

  tombstoneMessage(input: {
    conversationId: string;
    messageId: string;
    expectedConversationRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord> {
    requireSafeId(input.messageId, 'message id');
    validateOperationId(input.clientOperationId);
    return this.mutateConversation(
      input.conversationId,
      `message-tombstone:${input.clientOperationId}`,
      hashRequest(input),
      (receipt) => requireReceiptConversation(receipt),
      (loaded) => {
        const aggregate = loaded.aggregate;
        if (aggregate.conversation.recordRevision !== input.expectedConversationRevision) {
          throw new Error('Discourse conversation changed before message deletion.');
        }
        const header = loaded.messages.get(input.messageId);
        if (!header || header.author.kind !== 'USER') {
          throw new Error('Only an existing human message can be deleted.');
        }
        if (header.status === 'TOMBSTONE') {
          throw new Error('The discourse message is already deleted.');
        }
        if (aggregate.acceptedSends.some(
          (accepted) =>
            accepted.triggerMessageId === input.messageId &&
            accepted.status === 'PENDING' &&
            !aggregate.waves.some(({ triggerMessageId }) => triggerMessageId === accepted.triggerMessageId)
        )) {
          throw new Error('Cancel the interrupted agent response before deleting its message.');
        }
        const message = loadMessage(loaded.messages.reader, input.messageId, input.conversationId);
        const tombstoned = { ...message, status: 'TOMBSTONE' as const };
        loaded.messages.remember(tombstoned);
        aggregate.conversation = bumpConversation(aggregate.conversation, this.now());
        return {
          result: clone(aggregate.conversation),
          receipt: { conversation: aggregate.conversation },
          messages: [tombstoned]
        };
      }
    );
  }

  listMessages(input: {
    conversationId: string;
    beforeCursor?: string;
    limit?: number;
  }): Promise<DiscourseMessagePage> {
    requireSafeId(input.conversationId, 'conversation id');
    const limit = input.limit ?? DISCOURSE_LIMITS.transcriptPageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DISCOURSE_LIMITS.transcriptPageSize) {
      throw new Error('Discourse message page limit is invalid.');
    }
    const before = decodeSequenceCursor(input.beforeCursor);
    return this.read((reader) => {
      assertConversationReadable(reader, input.conversationId);
      const rows = reader.all<MessageRow>(
        `SELECT id, conversation_id AS conversationId,
                client_message_id AS clientMessageId,
                message_ordinal AS messageOrdinal, author_kind AS authorKind,
                parent_message_id AS parentMessageId, status, created_at AS createdAt,
                payload_json AS payloadJson
           FROM discourse_messages
          WHERE conversation_id = ? ${before ? 'AND message_ordinal < ?' : ''}
          ORDER BY message_ordinal DESC
          LIMIT ?`,
        before
          ? [input.conversationId, before, limit + 1]
          : [input.conversationId, limit + 1]
      );
      const hasOlder = rows.length > limit;
      const messages = rows.slice(0, limit).map((row) =>
        presentMessage(parseMessageRow(row))
      ).reverse();
      return {
        messages,
        ...(hasOlder && messages[0] ? { previousCursor: encodeSequenceCursor(messages[0].ordinal) } : {})
      };
    });
  }

  getMessageByClientId(input: {
    conversationId: string;
    clientMessageId: string;
  }): Promise<DiscourseMessageRecord | undefined> {
    requireSafeId(input.conversationId, 'conversation id');
    validateOperationId(input.clientMessageId);
    return this.read((reader) => {
      assertConversationReadable(reader, input.conversationId);
      const row = reader.get<MessageRow>(
        `SELECT id, conversation_id AS conversationId,
                client_message_id AS clientMessageId,
                message_ordinal AS messageOrdinal, author_kind AS authorKind,
                parent_message_id AS parentMessageId, status, created_at AS createdAt,
                payload_json AS payloadJson
           FROM discourse_messages
          WHERE conversation_id = ? AND client_message_id = ?`,
        [input.conversationId, input.clientMessageId]
      );
      if (!row) return undefined;
      const message = parseMessageRow(row);
      return presentMessage(message);
    });
  }

  renameConversation(input: {
    conversationId: string;
    title: string;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord> {
    validateTitle(input.title);
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest({
      conversationId: input.conversationId,
      title: input.title.trim(),
      expectedRevision: input.expectedRevision
    });
    return this.mutateConversation(
      input.conversationId,
      `conversation:${input.clientOperationId}`,
      fingerprint,
      (receipt) => requireReceiptConversation(receipt),
      (loaded) => {
        if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
          throw new Error('Discourse conversation changed before rename.');
        }
        loaded.aggregate.conversation = bumpConversation(loaded.aggregate.conversation, this.now(), {
          title: input.title.trim()
        });
        return {
          result: clone(loaded.aggregate.conversation),
          receipt: { conversation: loaded.aggregate.conversation }
        };
      }
    );
  }

  setConversationReadOrdinal(input: {
    conversationId: string;
    readOrdinal: number;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord> {
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest(input);
    return this.write((transaction) => {
      const loaded = loadConversation(transaction, input.conversationId);
      if (
        !Number.isSafeInteger(input.readOrdinal) ||
        input.readOrdinal < 0 ||
        input.readOrdinal > loaded.aggregate.conversation.latestOrdinal
      ) {
        throw new Error('Discourse read ordinal is invalid.');
      }
      const operationId = `conversation:${input.clientOperationId}`;
      const receipt = readReceipt(transaction, RECEIPT_DOMAIN, input.conversationId, operationId);
      if (receipt) {
        assertReceiptFingerprint(receipt, fingerprint);
        return requireReceiptConversation(receipt.result);
      }
      if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
        if (loaded.aggregate.conversation.readOrdinal >= input.readOrdinal) {
          return clone(loaded.aggregate.conversation);
        }
        throw new Error('Discourse conversation changed before marking read.');
      }
      loaded.aggregate.conversation = bumpConversation(loaded.aggregate.conversation, this.now(), {
        readOrdinal: input.readOrdinal
      });
      loaded.aggregate.latestEventSequence += 1;
      persistAggregate(transaction, loaded.aggregate);
      writeReceipt(transaction, {
        domain: RECEIPT_DOMAIN,
        ownerId: input.conversationId,
        operationId,
        requestFingerprint: fingerprint,
        result: { conversation: loaded.aggregate.conversation },
        createdAt: requireTimestamp(this.now())
      });
      return clone(loaded.aggregate.conversation);
    });
  }

  setConversationArchived(input: {
    conversationId: string;
    archived: boolean;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord> {
    validateOperationId(input.clientOperationId);
    return this.mutateConversation(
      input.conversationId,
      `conversation:${input.clientOperationId}`,
      hashRequest(input),
      (receipt) => requireReceiptConversation(receipt),
      (loaded) => {
        const aggregate = loaded.aggregate;
        if (aggregate.conversation.recordRevision !== input.expectedRevision) {
          throw new Error('Discourse conversation changed before archive update.');
        }
        if (input.archived && hasPendingAcceptedSend(aggregate)) {
          throw new Error('Cancel the interrupted agent response before archiving this conversation.');
        }
        const timestamp = requireTimestamp(this.now());
        aggregate.conversation = bumpConversation(aggregate.conversation, timestamp, {
          status: input.archived ? 'ARCHIVED' : 'OPEN',
          archivedAt: input.archived ? timestamp : undefined
        });
        return {
          result: clone(aggregate.conversation),
          receipt: { conversation: aggregate.conversation }
        };
      }
    );
  }

  deleteConversation(input: {
    conversationId: string;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationTombstoneRecord> {
    requireSafeId(input.conversationId, 'conversation id');
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest(input);
    return this.write((transaction) => {
      const prior = findTombstone(transaction, input.conversationId);
      if (prior) {
        if (
          prior.clientOperationId !== input.clientOperationId ||
          prior.requestFingerprint !== fingerprint
        ) {
          throw new Error('REQUEST_CONFLICT: conversation was already deleted.');
        }
        return clone(prior);
      }
      const loaded = loadConversation(transaction, input.conversationId);
      if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
        throw new Error('Discourse conversation changed before deletion.');
      }
      const tombstone: DiscourseConversationTombstoneRecord = {
        conversationId: input.conversationId,
        deletedAt: requireTimestamp(this.now()),
        clientOperationId: input.clientOperationId,
        requestFingerprint: fingerprint,
        lastEventSequence: loaded.aggregate.latestEventSequence + 1
      };
      transaction.run(
        `INSERT INTO discourse_tombstones (
           conversation_id, client_operation_id, request_fingerprint,
           last_event_sequence, deleted_at, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          tombstone.conversationId,
          tombstone.clientOperationId,
          tombstone.requestFingerprint,
          tombstone.lastEventSequence,
          tombstone.deletedAt,
          json(tombstone)
        ]
      );
      transaction.run(
        `DELETE FROM operation_receipts
          WHERE (domain = ? AND owner_id = ?)
             OR (domain = ? AND json_extract(result_json, '$.conversationId') = ?)`,
        [
          RECEIPT_DOMAIN,
          input.conversationId,
          CREATE_RECEIPT_DOMAIN,
          input.conversationId
        ]
      );
      transaction.run('DELETE FROM discourse_conversations WHERE id = ?', [input.conversationId]);
      return clone(tombstone);
    });
  }

  getConversationTombstone(
    conversationId: string
  ): Promise<DiscourseConversationTombstoneRecord | undefined> {
    requireSafeId(conversationId, 'conversation id');
    return this.read((reader) => clone(findTombstone(reader, conversationId)));
  }

  setPinnedContext(input: {
    conversationId: string;
    context: DiscourseContextSelectionSnapshot[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<ConversationContextRevisionRecord> {
    validateOperationId(input.clientOperationId);
    const context = normalizeResolvedContext(input.context);
    return this.mutateConversation(
      input.conversationId,
      `context:${input.clientOperationId}`,
      hashRequest({ ...input, context }),
      (receipt, loaded) => {
        const id = requireReceiptId(receipt, 'contextRevisionId');
        const revision = loaded.aggregate.contextRevisions.find((candidate) => candidate.id === id);
        if (!revision) throw storedIntegrity('context receipt target is missing');
        return clone(revision);
      },
      (loaded) => {
        if (loaded.aggregate.conversation.recordRevision !== input.expectedRevision) {
          throw new Error('Discourse conversation changed before pinned context update.');
        }
        const timestamp = requireTimestamp(this.now());
        const links: ConversationContextLinkRecord[] = context.map((reference) => ({
          id: this.createId(),
          conversationId: input.conversationId,
          scope: 'PINNED',
          entityKind: reference.entityKind,
          entityId: reference.entityId,
          availability: reference.availability,
          recordRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp
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
          createdAt: timestamp
        };
        loaded.aggregate.contextLinks.push(...links);
        loaded.aggregate.contextRevisions.push(revision);
        loaded.aggregate.conversation = bumpConversation(loaded.aggregate.conversation, timestamp, {
          pinnedContextRevisionId: revision.id
        });
        return {
          result: clone(revision),
          receipt: { contextRevisionId: revision.id }
        };
      }
    );
  }

  saveDraft(input: SaveDiscourseDraftRequest): Promise<DiscourseDraftRecord> {
    validateDraftInput(input);
    return this.write((transaction) => {
      const id = input.draftId ?? this.createId();
      requireSafeId(id, 'draft id');
      if (input.conversationId) {
        requireSafeId(input.conversationId, 'conversation id');
        assertConversationReadable(transaction, input.conversationId);
      }
      const existing = readDraft(transaction, id);
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
        ...(input.supersedesMessageId ? { supersedesMessageId: input.supersedesMessageId } : {}),
        sourceMessageIds: uniqueIds(input.sourceMessageIds ?? []),
        policy: input.policy,
        agentSelections: normalizeDraftAgentSelections(input.agentSelections ?? []),
        ...(input.pendingClientMessageId
          ? { pendingClientMessageId: input.pendingClientMessageId }
          : {}),
        tokens: normalizeDraftTokens(input.tokens),
        updatedAt: requireTimestamp(this.now())
      };
      transaction.run(
        `INSERT INTO discourse_drafts (
           id, conversation_id, record_revision, updated_at, payload_json
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           record_revision = excluded.record_revision,
           updated_at = excluded.updated_at,
           payload_json = excluded.payload_json`,
        [draft.id, draft.conversationId ?? null, draft.recordRevision, draft.updatedAt, json(draft)]
      );
      return clone(draft);
    });
  }

  getDraft(draftId: string): Promise<DiscourseDraftRecord | undefined> {
    requireSafeId(draftId, 'draft id');
    return this.read((reader) => clone(readDraft(reader, draftId)));
  }

  listDrafts(): Promise<DiscourseDraftRecord[]> {
    return this.read((reader) => {
      const rows = reader.all<DraftRow>(
        `SELECT id, conversation_id AS conversationId,
                record_revision AS recordRevision, updated_at AS updatedAt,
                payload_json AS payloadJson
           FROM discourse_drafts
          ORDER BY updated_at DESC, id ASC
          LIMIT ?`,
        [DISCOURSE_LIMITS.maxConversationSummariesInSnapshot + 2]
      );
      if (rows.length > DISCOURSE_LIMITS.maxConversationSummariesInSnapshot + 1) {
        throw new Error('Discourse draft collection exceeds its safety limit.');
      }
      return rows.map(parseDraftRow);
    });
  }

  deleteDraft(input: { draftId: string; expectedRevision: number }): Promise<void> {
    requireSafeId(input.draftId, 'draft id');
    return this.write((transaction) => {
      const existing = readDraft(transaction, input.draftId);
      if (!existing) return;
      if (existing.recordRevision !== input.expectedRevision) {
        throw new Error('Discourse draft changed before it could be deleted.');
      }
      transaction.run('DELETE FROM discourse_drafts WHERE id = ?', [input.draftId]);
    });
  }

  createWave(input: CreateDiscourseWaveInput): Promise<{
    wave: DiscourseResponseWaveRecord;
    jobs: DiscourseAgentJobRecord[];
  }> {
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest(input);
    return this.mutateConversation(
      input.conversationId,
      `wave:${input.clientOperationId}`,
      fingerprint,
      (receipt, loaded) => {
        const waveId = requireReceiptId(receipt, 'waveId');
        const wave = loaded.aggregate.waves.find(({ id }) => id === waveId);
        if (!wave) throw storedIntegrity('wave receipt target is missing');
        const jobIds = requireReceiptIds(receipt, 'jobIds');
        const jobs = jobIds.map((id) => {
          const job = loaded.aggregate.jobs.find((candidate) => candidate.id === id);
          if (!job) throw storedIntegrity('wave job receipt target is missing');
          return job;
        });
        return { wave: clone(wave), jobs: clone(jobs) };
      },
      (loaded) => {
        const aggregate = loaded.aggregate;
        if (aggregate.conversation.recordRevision !== input.expectedConversationRevision) {
          throw new Error('Discourse conversation changed before wave planning.');
        }
        if (aggregate.conversation.status !== 'OPEN') {
          throw new Error('Archived discourse conversations cannot plan response waves.');
        }
        if (aggregate.waves.filter(({ status }) => status !== 'SETTLED').length >= 8) {
          throw new Error('Discourse conversation has reached its queued-wave safety limit.');
        }
        assertWavePlan(input, loaded);
        aggregate.contextSnapshots.push(clone(input.contextSnapshot));
        aggregate.waves.push(clone(input.wave));
        aggregate.jobs.push(...clone(input.jobs));
        aggregate.conversation = bumpConversation(aggregate.conversation, this.now());
        return {
          result: { wave: clone(input.wave), jobs: clone(input.jobs) },
          receipt: { waveId: input.wave.id, jobIds: input.jobs.map(({ id }) => id) }
        };
      }
    );
  }

  addJobsToWave(input: {
    conversationId: string;
    waveId: string;
    jobs: DiscourseAgentJobRecord[];
    expectedConversationRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord[]> {
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest(input);
    return this.mutateConversation(
      input.conversationId,
      `wave-jobs:${input.clientOperationId}`,
      fingerprint,
      (receipt, loaded) => requireReceiptIds(receipt, 'jobIds').map((id) => {
        const job = loaded.aggregate.jobs.find((candidate) => candidate.id === id);
        if (!job) throw storedIntegrity('wave job receipt target is missing');
        return clone(job);
      }),
      (loaded) => {
        const aggregate = loaded.aggregate;
        if (aggregate.conversation.recordRevision !== input.expectedConversationRevision) {
          throw new Error('Discourse conversation changed before downstream job planning.');
        }
        const wave = aggregate.waves.find(({ id }) => id === input.waveId);
        if (!wave || wave.status === 'SETTLED') {
          throw new Error('Discourse downstream jobs require an active wave.');
        }
        if (
          input.jobs.length === 0 ||
          aggregate.jobs.filter(({ waveId }) => waveId === wave.id).length + input.jobs.length >
            DISCOURSE_LIMITS.maxTeamJobs
        ) {
          throw new Error('Discourse downstream job plan exceeds its safety limit.');
        }
        for (const job of input.jobs) assertNewDownstreamJob(job, wave, loaded);
        aggregate.jobs.push(...clone(input.jobs));
        aggregate.conversation = bumpConversation(aggregate.conversation, this.now());
        return {
          result: clone(input.jobs),
          receipt: { jobIds: input.jobs.map(({ id }) => id) }
        };
      }
    );
  }

  completeReviewJob(input: {
    conversationId: string;
    job: DiscourseAgentJobRecord;
    concerns: DiscourseConcernRecord[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord> {
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest(input);
    return this.mutateConversation(
      input.conversationId,
      `review-terminal:${input.clientOperationId}`,
      fingerprint,
      (receipt, loaded) => clone(requireAggregateJob(loaded, requireReceiptId(receipt, 'jobId'))),
      (loaded) => {
        const existing = requireAggregateJob(loaded, input.job.id);
        if (existing.recordRevision !== input.expectedRevision) {
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
        const expectedConcernIds = new Set(input.job.result.concernIds);
        const suppliedConcernIds = new Set(input.concerns.map(({ id }) => id));
        if (
          expectedConcernIds.size !== suppliedConcernIds.size ||
          [...expectedConcernIds].some((id) => !suppliedConcernIds.has(id))
        ) {
          throw new Error('Discourse review result concern ids do not match its concern records.');
        }
        const existingIds = new Set(loaded.aggregate.concerns.map(({ id }) => id));
        for (const concern of input.concerns) {
          if (
            existingIds.has(concern.id) ||
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
          existingIds.add(concern.id);
        }
        replaceRecord(loaded.aggregate.jobs, clone(input.job), 'job');
        loaded.aggregate.concerns.push(...clone(input.concerns));
        return {
          result: clone(input.job),
          receipt: { jobId: input.job.id }
        };
      }
    );
  }

  completeCorrectionJob(input: {
    conversationId: string;
    job: DiscourseAgentJobRecord;
    concernIds: string[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord> {
    validateOperationId(input.clientOperationId);
    const fingerprint = hashRequest(input);
    return this.mutateConversation(
      input.conversationId,
      `correction-terminal:${input.clientOperationId}`,
      fingerprint,
      (receipt, loaded) => clone(requireAggregateJob(loaded, requireReceiptId(receipt, 'jobId'))),
      (loaded) => {
        const existing = requireAggregateJob(loaded, input.job.id);
        if (existing.recordRevision !== input.expectedRevision) {
          throw new Error('Discourse correction job changed before terminal ingestion.');
        }
        const result = input.job.result;
        if (
          existing.role !== 'CORRECT' ||
          input.job.status !== 'COMPLETED' ||
          result?.kind !== 'CORRECTION' ||
          input.job.recordRevision !== existing.recordRevision + 1
        ) {
          throw new Error('Discourse correction terminal is invalid.');
        }
        assertDiscourseJobTransition(existing.status, input.job.status);
        assertDiscourseJobRecord(input.job);
        if (new Set(input.concernIds).size !== input.concernIds.length) {
          throw new Error('Discourse correction concern ids must be unique.');
        }
        const ids = new Set(input.concernIds);
        const concerns = loaded.aggregate.concerns
          .filter(({ id }) => ids.has(id))
          .map((concern): DiscourseConcernRecord => ({
            ...concern,
            recordRevision: concern.recordRevision + 1,
            resolution: {
              correctionJobId: input.job.id,
              ...(result.outputMessageId ? { correctionMessageId: result.outputMessageId } : {}),
              outcome: result.outcome
            }
          }));
        if (
          concerns.length !== ids.size ||
          concerns.some((concern) =>
            concern.conversationId !== input.conversationId || concern.waveId !== existing.waveId
          )
        ) {
          throw new Error('Discourse correction references an unknown concern.');
        }
        replaceRecord(loaded.aggregate.jobs, clone(input.job), 'job');
        for (const concern of concerns) replaceRecord(loaded.aggregate.concerns, concern, 'concern');
        return { result: clone(input.job), receipt: { jobId: input.job.id } };
      }
    );
  }

  updateWave(input: {
    conversationId: string;
    wave: DiscourseResponseWaveRecord;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseResponseWaveRecord> {
    validateOperationId(input.clientOperationId);
    return this.mutateConversation(
      input.conversationId,
      `wave-update:${input.clientOperationId}`,
      hashRequest(input),
      (receipt, loaded) => {
        const wave = loaded.aggregate.waves.find(
          ({ id }) => id === requireReceiptId(receipt, 'waveId')
        );
        if (!wave) throw storedIntegrity('wave receipt target is missing');
        return clone(wave);
      },
      (loaded) => {
        const existing = loaded.aggregate.waves.find(({ id }) => id === input.wave.id);
        if (!existing) throw new Error(`Discourse wave not found: ${input.wave.id}`);
        if (existing.recordRevision !== input.expectedRevision) {
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
        replaceRecord(loaded.aggregate.waves, clone(input.wave), 'wave');
        return { result: clone(input.wave), receipt: { waveId: input.wave.id } };
      }
    );
  }

  updateJob(input: {
    conversationId: string;
    job: DiscourseAgentJobRecord;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord> {
    validateOperationId(input.clientOperationId);
    return this.mutateConversation(
      input.conversationId,
      `job-update:${input.clientOperationId}`,
      hashRequest(input),
      (receipt, loaded) => clone(
        requireAggregateJob(loaded, requireReceiptId(receipt, 'jobId'))
      ),
      (loaded) => {
        const existing = requireAggregateJob(loaded, input.job.id);
        if (existing.recordRevision !== input.expectedRevision) {
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
        replaceRecord(loaded.aggregate.jobs, clone(input.job), 'job');
        return { result: clone(input.job), receipt: { jobId: input.job.id } };
      }
    );
  }

  private mutateConversation<T>(
    conversationId: string,
    operationId: string,
    requestFingerprint: string,
    replay: (
      receipt: Record<string, unknown>,
      loaded: LoadedConversation,
      transaction: AppDatabaseTransaction
    ) => T,
    apply: (loaded: LoadedConversation) => MutationResult<T>
  ): Promise<T> {
    requireSafeId(conversationId, 'conversation id');
    requireFingerprint(requestFingerprint, 'request fingerprint');
    return this.write((transaction) => {
      const loaded = loadConversation(transaction, conversationId);
      const receipt = readReceipt(
        transaction,
        RECEIPT_DOMAIN,
        conversationId,
        operationId
      );
      if (receipt) {
        assertReceiptFingerprint(receipt, requestFingerprint);
        return clone(replay(receipt.result, loaded, transaction));
      }

      loaded.aggregate.latestEventSequence += 1;
      const mutation = apply(loaded);
      for (const message of mutation.messages ?? []) persistMessage(transaction, message);
      validateLoaded(loaded, transaction);
      persistAggregate(transaction, loaded.aggregate);
      writeReceipt(transaction, {
        domain: RECEIPT_DOMAIN,
        ownerId: conversationId,
        operationId,
        requestFingerprint,
        result: mutation.receipt,
        createdAt: requireTimestamp(this.now())
      });
      return clone(mutation.result);
    });
  }

  private read<T>(operation: (reader: SqlReader) => T): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Discourse store is closed.'));
    return this.track(this.database.read(operation));
  }

  private write<T>(operation: (transaction: AppDatabaseTransaction) => T): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Discourse store is closed.'));
    return this.track(this.database.write(operation));
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => {
      this.active.delete(tracked);
    });
    this.active.add(tracked);
    return tracked;
  }
}

function persistAggregate(
  transaction: AppDatabaseTransaction,
  aggregate: DiscourseConversationAggregateRecord
): void {
  const conversation = aggregate.conversation;
  transaction.run(
    `INSERT INTO discourse_conversations (
       id, title, status, default_policy, latest_ordinal, read_ordinal,
       latest_event_sequence, record_revision, created_at, updated_at,
       archived_at, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       status = excluded.status,
       default_policy = excluded.default_policy,
       latest_ordinal = excluded.latest_ordinal,
       read_ordinal = excluded.read_ordinal,
       latest_event_sequence = excluded.latest_event_sequence,
       record_revision = excluded.record_revision,
       updated_at = excluded.updated_at,
       archived_at = excluded.archived_at,
       payload_json = excluded.payload_json`,
    [
      conversation.id,
      conversation.title,
      conversation.status,
      conversation.defaultPolicy,
      conversation.latestOrdinal,
      conversation.readOrdinal,
      aggregate.latestEventSequence,
      conversation.recordRevision,
      conversation.createdAt,
      conversation.updatedAt,
      conversation.archivedAt ?? null,
      json(conversation)
    ]
  );

  for (const [aggregateOrdinal, participant] of aggregate.participants.entries()) {
    assertRecordOwner(transaction, 'discourse_participants', participant.id, conversation.id);
    transaction.run(
      `INSERT INTO discourse_participants (
         id, conversation_id, aggregate_ordinal, agent_profile_id, current_revision_id,
         enabled, record_revision, created_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         aggregate_ordinal = excluded.aggregate_ordinal,
         agent_profile_id = excluded.agent_profile_id,
         current_revision_id = excluded.current_revision_id,
         enabled = excluded.enabled,
         record_revision = excluded.record_revision,
         payload_json = excluded.payload_json`,
      [
        participant.id,
        participant.conversationId,
        aggregateOrdinal,
        participant.agentProfileId,
        participant.currentRevisionId,
        participant.enabled ? 1 : 0,
        participant.recordRevision,
        participant.createdAt,
        json(participant)
      ]
    );
  }

  for (const revision of aggregate.participantRevisions) {
    assertRecordOwner(
      transaction,
      'discourse_participant_revisions',
      revision.id,
      conversation.id
    );
    transaction.run(
      `INSERT INTO discourse_participant_revisions (
         id, conversation_id, stable_participant_id, revision, created_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        revision.id,
        revision.conversationId,
        revision.stableParticipantId,
        revision.revision,
        revision.createdAt,
        json(revision)
      ]
    );
  }

  for (const [aggregateOrdinal, accepted] of aggregate.acceptedSends.entries()) {
    assertRecordOwner(transaction, 'discourse_accepted_sends', accepted.id, conversation.id);
    transaction.run(
      `INSERT INTO discourse_accepted_sends (
         id, conversation_id, aggregate_ordinal, client_message_id, request_fingerprint,
         status, record_revision, created_at, canceled_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         aggregate_ordinal = excluded.aggregate_ordinal,
         status = excluded.status,
         record_revision = excluded.record_revision,
         canceled_at = excluded.canceled_at,
         payload_json = excluded.payload_json`,
      [
        accepted.id,
        accepted.conversationId,
        aggregateOrdinal,
        accepted.clientMessageId,
        accepted.requestFingerprint,
        accepted.status,
        accepted.recordRevision,
        accepted.createdAt,
        accepted.canceledAt ?? null,
        json(accepted)
      ]
    );
  }

  for (const [aggregateOrdinal, link] of aggregate.contextLinks.entries()) {
    assertRecordOwner(transaction, 'discourse_context_links', link.id, conversation.id);
    transaction.run(
      `INSERT INTO discourse_context_links (
         id, conversation_id, aggregate_ordinal, created_by_message_id, entity_kind, entity_id,
         scope, availability, record_revision, created_at, updated_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         aggregate_ordinal = excluded.aggregate_ordinal,
         availability = excluded.availability,
         record_revision = excluded.record_revision,
         updated_at = excluded.updated_at,
         payload_json = excluded.payload_json`,
      [
        link.id,
        link.conversationId,
        aggregateOrdinal,
        link.createdByMessageId ?? null,
        link.entityKind,
        link.entityId,
        link.scope,
        link.availability,
        link.recordRevision,
        link.createdAt,
        link.updatedAt,
        json(link)
      ]
    );
  }

  for (const revision of aggregate.contextRevisions) {
    assertRecordOwner(
      transaction,
      'discourse_context_revisions',
      revision.id,
      conversation.id
    );
    transaction.run(
      `INSERT INTO discourse_context_revisions (
         id, conversation_id, revision, created_at, payload_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [revision.id, revision.conversationId, revision.revision, revision.createdAt, json(revision)]
    );
  }

  for (const [aggregateOrdinal, snapshot] of aggregate.contextSnapshots.entries()) {
    persistContextSnapshot(transaction, snapshot, aggregateOrdinal);
  }

  for (const [aggregateOrdinal, wave] of aggregate.waves.entries()) {
    assertRecordOwner(transaction, 'discourse_waves', wave.id, conversation.id);
    transaction.run(
      `INSERT INTO discourse_waves (
         id, conversation_id, aggregate_ordinal, context_snapshot_id, status, phase, outcome,
         client_operation_id, request_fingerprint, record_revision,
         created_at, started_at, settled_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         aggregate_ordinal = excluded.aggregate_ordinal,
         context_snapshot_id = excluded.context_snapshot_id,
         status = excluded.status,
         phase = excluded.phase,
         outcome = excluded.outcome,
         record_revision = excluded.record_revision,
         started_at = excluded.started_at,
         settled_at = excluded.settled_at,
         payload_json = excluded.payload_json`,
      [
        wave.id,
        wave.conversationId,
        aggregateOrdinal,
        wave.contextSnapshotId ?? null,
        wave.status,
        wave.phase ?? null,
        wave.outcome ?? null,
        wave.clientOperationId,
        wave.requestFingerprint,
        wave.recordRevision,
        wave.createdAt,
        wave.startedAt ?? null,
        wave.settledAt ?? null,
        json(wave)
      ]
    );
  }

  for (const [aggregateOrdinal, job] of aggregate.jobs.entries()) {
    assertRecordOwner(transaction, 'discourse_jobs', job.id, conversation.id);
    transaction.run(
      `INSERT INTO discourse_jobs (
         id, conversation_id, aggregate_ordinal, wave_id, stable_participant_id, session_id, run_id,
         status, delivery_status, attempt_id, generation_key, record_revision,
         created_at, started_at, finished_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         aggregate_ordinal = excluded.aggregate_ordinal,
         session_id = excluded.session_id,
         run_id = excluded.run_id,
         status = excluded.status,
         delivery_status = excluded.delivery_status,
         record_revision = excluded.record_revision,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at,
         payload_json = excluded.payload_json`,
      [
        job.id,
        job.conversationId,
        aggregateOrdinal,
        job.waveId,
        job.assignment.stableParticipantId,
        job.sessionId ?? null,
        job.runId ?? null,
        job.status,
        job.delivery,
        job.attemptId,
        job.generationKey,
        job.recordRevision,
        job.createdAt,
        job.startedAt ?? null,
        job.finishedAt ?? null,
        json(job)
      ]
    );
  }

  for (const [aggregateOrdinal, concern] of aggregate.concerns.entries()) {
    assertRecordOwner(transaction, 'discourse_concerns', concern.id, conversation.id);
    transaction.run(
      `INSERT INTO discourse_concerns (
         id, conversation_id, aggregate_ordinal, wave_id, review_job_id, severity,
         record_revision, created_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         aggregate_ordinal = excluded.aggregate_ordinal,
         severity = excluded.severity,
         record_revision = excluded.record_revision,
         payload_json = excluded.payload_json`,
      [
        concern.id,
        concern.conversationId,
        aggregateOrdinal,
        concern.waveId,
        concern.reviewJobId,
        concern.severity,
        concern.recordRevision,
        concern.createdAt,
        json(concern)
      ]
    );
  }

  for (const summary of aggregate.summaries) {
    assertRecordOwner(transaction, 'discourse_summaries', summary.id, conversation.id);
    transaction.run(
      `INSERT INTO discourse_summaries (
         id, conversation_id, revision, covered_ordinal_start,
         covered_ordinal_end, created_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        summary.id,
        summary.conversationId,
        summary.revision,
        summary.coveredOrdinalStart,
        summary.coveredOrdinalEnd,
        summary.createdAt,
        json(summary)
      ]
    );
  }
}

function persistContextSnapshot(
  transaction: AppDatabaseTransaction,
  snapshot: ContextSnapshotRecord,
  aggregateOrdinal: number
): void {
  assertRecordOwner(
    transaction,
    'discourse_context_snapshots',
    snapshot.id,
    snapshot.conversationId
  );
  transaction.run(
    `INSERT INTO discourse_context_snapshots (
       id, conversation_id, aggregate_ordinal, wave_id, context_revision_id, status,
       record_revision, created_at, resolved_at, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       aggregate_ordinal = excluded.aggregate_ordinal,
       status = excluded.status,
       record_revision = excluded.record_revision,
       resolved_at = excluded.resolved_at,
       payload_json = excluded.payload_json`,
    [
      snapshot.id,
      snapshot.conversationId,
      aggregateOrdinal,
      snapshot.waveId,
      snapshot.contextRevisionId,
      snapshot.status,
      snapshot.recordRevision,
      snapshot.createdAt,
      snapshot.resolvedAt ?? null,
      json(snapshot)
    ]
  );
  for (const [ordinal, source] of snapshot.sources.entries()) {
    transaction.run(
      `INSERT INTO discourse_context_sources (
         context_snapshot_id, context_link_id, entity_kind, entity_id,
         access_mode, source_ordinal, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(context_snapshot_id, source_ordinal) DO UPDATE SET
         context_link_id = excluded.context_link_id,
         entity_kind = excluded.entity_kind,
         entity_id = excluded.entity_id,
         access_mode = excluded.access_mode,
         payload_json = excluded.payload_json`,
      [
        snapshot.id,
        source.contextLinkId,
        source.entityKind,
        source.entityId,
        source.accessMode,
        ordinal,
        json(source)
      ]
    );
  }
}

function persistMessage(
  transaction: AppDatabaseTransaction,
  message: DiscourseMessageRecord
): void {
  assertRecordOwner(transaction, 'discourse_messages', message.id, message.conversationId);
  transaction.run(
    `INSERT INTO discourse_messages (
       id, conversation_id, client_message_id, message_ordinal,
       author_kind, parent_message_id, status, created_at, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       payload_json = excluded.payload_json`,
    [
      message.id,
      message.conversationId,
      message.clientMessageId ?? null,
      message.ordinal,
      message.author.kind,
      message.replyToMessageId ?? null,
      message.status,
      message.createdAt,
      json(message)
    ]
  );
}

type ConversationOwnedTable =
  | 'discourse_participants'
  | 'discourse_participant_revisions'
  | 'discourse_accepted_sends'
  | 'discourse_messages'
  | 'discourse_context_links'
  | 'discourse_context_revisions'
  | 'discourse_context_snapshots'
  | 'discourse_waves'
  | 'discourse_jobs'
  | 'discourse_concerns'
  | 'discourse_summaries';

function assertRecordOwner(
  reader: SqlReader,
  table: ConversationOwnedTable,
  id: string,
  conversationId: string
): void {
  const row = reader.get<{ conversationId: string }>(
    `SELECT conversation_id AS conversationId FROM ${table} WHERE id = ?`,
    [id]
  );
  if (row && row.conversationId !== conversationId) {
    throw new Error(`Discourse record id is already owned by another conversation: ${id}`);
  }
}

function parseMessageRow(row: MessageRow): DiscourseMessageRecord {
  const message = parsePayload<DiscourseMessageRecord>(row.payloadJson, 'message');
  if (
    message.id !== row.id ||
    message.conversationId !== row.conversationId ||
    (message.clientMessageId ?? null) !== row.clientMessageId ||
    message.ordinal !== row.messageOrdinal ||
    message.author.kind !== row.authorKind ||
    (message.replyToMessageId ?? null) !== row.parentMessageId ||
    message.status !== row.status ||
    message.createdAt !== row.createdAt
  ) {
    throw storedIntegrity('message columns do not match its payload');
  }
  return message;
}

function loadMessage(
  reader: SqlReader,
  messageId: string,
  conversationId: string
): DiscourseMessageRecord {
  const message = new MessageLookup(reader, conversationId).getRecord(messageId);
  if (!message) throw storedIntegrity('message receipt target is missing');
  return message;
}

function readReceipt(
  reader: SqlReader,
  domain: string,
  ownerId: string,
  operationId: string
): OperationReceipt | undefined {
  const row = reader.get<{ requestFingerprint: string; resultJson: string }>(
    `SELECT request_fingerprint AS requestFingerprint, result_json AS resultJson
       FROM operation_receipts
      WHERE domain = ? AND owner_id = ? AND client_operation_id = ?`,
    [domain, ownerId, operationId]
  );
  if (!row) return undefined;
  return {
    requestFingerprint: row.requestFingerprint,
    result: parsePayload<Record<string, unknown>>(row.resultJson, 'operation receipt')
  };
}

function writeReceipt(
  transaction: AppDatabaseTransaction,
  input: {
    domain: string;
    ownerId: string;
    operationId: string;
    requestFingerprint: string;
    result: Record<string, unknown>;
    createdAt: string;
  }
): void {
  transaction.run(
    `INSERT INTO operation_receipts (
       domain, client_operation_id, owner_id, request_fingerprint,
       result_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.domain,
      input.operationId,
      input.ownerId,
      input.requestFingerprint,
      json(input.result),
      input.createdAt
    ]
  );
}

function assertReceiptFingerprint(receipt: OperationReceipt, fingerprint: string): void {
  if (receipt.requestFingerprint !== fingerprint) {
    throw new Error('REQUEST_CONFLICT: discourse operation changed.');
  }
}

function requireReceiptId(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw storedIntegrity(`operation receipt ${key} is invalid`);
  }
  return value;
}

function requireReceiptIds(result: Record<string, unknown>, key: string): string[] {
  const value = result[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !SAFE_ID.test(item))) {
    throw storedIntegrity(`operation receipt ${key} is invalid`);
  }
  return [...value] as string[];
}

function requireReceiptConversation(
  result: Record<string, unknown>
): DiscourseConversationRecord {
  return parseStoredObject<DiscourseConversationRecord>(result.conversation, 'conversation receipt');
}

function validateDiscourseInventory(reader: SqlReader): void {
  for (const { id } of reader.all<{ id: string }>(
    'SELECT id FROM discourse_conversations ORDER BY id'
  )) {
    loadConversation(reader, id);
  }
  for (const row of reader.all<MessageRow>(
    `SELECT id, conversation_id AS conversationId,
            client_message_id AS clientMessageId,
            message_ordinal AS messageOrdinal, author_kind AS authorKind,
            parent_message_id AS parentMessageId, status, created_at AS createdAt,
            payload_json AS payloadJson
       FROM discourse_messages ORDER BY conversation_id, message_ordinal, id`
  )) {
    parseMessageRow(row);
  }
  for (const row of reader.all<DraftRow>(
    `SELECT id, conversation_id AS conversationId,
            record_revision AS recordRevision, updated_at AS updatedAt,
            payload_json AS payloadJson
       FROM discourse_drafts ORDER BY id`
  )) {
    parseDraftRow(row);
  }
  for (const row of reader.all<TombstoneRow>(
    `SELECT conversation_id AS conversationId,
            client_operation_id AS clientOperationId,
            request_fingerprint AS requestFingerprint,
            last_event_sequence AS lastEventSequence,
            deleted_at AS deletedAt, payload_json AS payloadJson
       FROM discourse_tombstones ORDER BY conversation_id`
  )) {
    parseTombstoneRow(row);
  }
}

function findTombstone(
  reader: SqlReader,
  conversationId: string
): DiscourseConversationTombstoneRecord | undefined {
  const row = reader.get<TombstoneRow>(
    `SELECT conversation_id AS conversationId,
            client_operation_id AS clientOperationId,
            request_fingerprint AS requestFingerprint,
            last_event_sequence AS lastEventSequence,
            deleted_at AS deletedAt, payload_json AS payloadJson
       FROM discourse_tombstones WHERE conversation_id = ?`,
    [conversationId]
  );
  if (!row) return undefined;
  const tombstone = parseTombstoneRow(row);
  if (tombstone.conversationId !== conversationId) {
    throw storedIntegrity('conversation tombstone identity is invalid');
  }
  return tombstone;
}

function readDraft(reader: SqlReader, draftId: string): DiscourseDraftRecord | undefined {
  const row = reader.get<DraftRow>(
    `SELECT id, conversation_id AS conversationId,
            record_revision AS recordRevision, updated_at AS updatedAt,
            payload_json AS payloadJson
       FROM discourse_drafts WHERE id = ?`,
    [draftId]
  );
  if (!row) return undefined;
  const draft = parseDraftRow(row);
  if (draft.id !== draftId) throw storedIntegrity('draft identity is invalid');
  return draft;
}

function parseDraftRow(row: DraftRow): DiscourseDraftRecord {
  const draft = parsePayload<DiscourseDraftRecord>(row.payloadJson, 'draft');
  if (
    draft.id !== row.id ||
    (draft.conversationId ?? null) !== row.conversationId ||
    draft.recordRevision !== row.recordRevision ||
    draft.updatedAt !== row.updatedAt
  ) {
    throw storedIntegrity('draft columns do not match its payload');
  }
  return validateDraftRecord(draft);
}

function parseTombstoneRow(row: TombstoneRow): DiscourseConversationTombstoneRecord {
  const tombstone = parsePayload<DiscourseConversationTombstoneRecord>(
    row.payloadJson,
    'conversation tombstone'
  );
  if (
    tombstone.conversationId !== row.conversationId ||
    tombstone.clientOperationId !== row.clientOperationId ||
    tombstone.requestFingerprint !== row.requestFingerprint ||
    tombstone.lastEventSequence !== row.lastEventSequence ||
    tombstone.deletedAt !== row.deletedAt
  ) {
    throw storedIntegrity('conversation tombstone columns do not match its payload');
  }
  return tombstone;
}

function conversationExists(reader: SqlReader, conversationId: string): boolean {
  return Boolean(reader.get('SELECT 1 FROM discourse_conversations WHERE id = ?', [conversationId]));
}

function assertConversationReadable(reader: SqlReader, conversationId: string): void {
  if (findTombstone(reader, conversationId)) {
    throw new Error(`Discourse conversation was deleted: ${conversationId}`);
  }
  if (!conversationExists(reader, conversationId)) {
    throw new Error(`Discourse conversation not found: ${conversationId}`);
  }
}

function assertMessageAgainstLookup(
  loaded: LoadedConversation,
  message: DiscourseMessageRecord
): void {
  assertDiscourseMessageAppend({
    conversationId: loaded.aggregate.conversation.id,
    latestOrdinal: loaded.aggregate.conversation.latestOrdinal,
    findExistingMessage: (messageId) => loaded.messages.getRecord(messageId),
    message
  });
  for (const sourceMessageId of message.sourceMessageIds) {
    if (!loaded.messages.get(sourceMessageId)) {
      throw new Error('A discourse message source must exist in the same conversation.');
    }
  }
}

function assertMessageReferencesExist(
  loaded: LoadedConversation,
  messageIds: readonly string[],
  label: string
): void {
  for (const messageId of messageIds) {
    requireSafeId(messageId, `${label} id`);
    if (!loaded.messages.get(messageId)) {
      throw new Error(`Discourse ${label} is missing.`);
    }
  }
}

function supersedeMessage(
  loaded: LoadedConversation,
  messageId: string
): DiscourseMessageRecord {
  const message = loaded.messages.getRecord(messageId);
  if (!message) throw new Error('Discourse correction targets an unknown message.');
  if (message.status !== 'VISIBLE') {
    throw new Error('Discourse correction targets a message that is no longer visible.');
  }
  const superseded = { ...message, status: 'SUPERSEDED' as const };
  loaded.messages.remember(superseded);
  return superseded;
}

function presentMessage(message: DiscourseMessageRecord): DiscourseMessageRecord {
  return {
    ...clone(message),
    ...(message.status === 'TOMBSTONE' ? { body: '' } : {})
  };
}

function buildMessageContextUpdate(input: {
  loaded: LoadedConversation;
  messageId: string;
  context: DiscourseContextSelectionSnapshot[];
  createId(): string;
  now: string;
}): {
  links: ConversationContextLinkRecord[];
  revision: ConversationContextRevisionRecord;
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
  const revision = loaded.aggregate.contextRevisions.find(({ id }) => id === revisionId);
  if (!revision) throw new Error('Discourse pinned context revision is missing.');
  return revision.references
    .filter(({ scope }) => scope === 'PINNED')
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

function validateDraftInput(input: SaveDiscourseDraftRequest): void {
  if (Buffer.byteLength(input.body, 'utf8') > DISCOURSE_LIMITS.maxHumanMessageBytes) {
    throw new Error('Discourse draft exceeds its text-size safety limit.');
  }
  if (input.replyToMessageId) requireSafeId(input.replyToMessageId, 'reply message id');
  if (input.supersedesMessageId) requireSafeId(input.supersedesMessageId, 'superseded message id');
  (input.sourceMessageIds ?? []).forEach((id) => requireSafeId(id, 'draft source message id'));
  if (input.pendingClientMessageId) validateOperationId(input.pendingClientMessageId);
  normalizeDraftAgentSelections(input.agentSelections ?? []);
  normalizeDraftTokens(input.tokens);
}

function normalizeDraftAgentSelections(
  selections: readonly DiscourseAgentSelectionInput[]
): DiscourseAgentSelectionInput[] {
  if (selections.length > DISCOURSE_LIMITS.maxTeamParticipants) {
    throw new Error('Discourse draft has too many agent configurations.');
  }
  const seen = new Set<string>();
  return selections.map((selection) => {
    if (
      !['builtin.lead', 'builtin.skeptic', 'builtin.verifier'].includes(selection.agentProfileId) ||
      seen.has(selection.agentProfileId)
    ) {
      throw new Error('Discourse draft agent configuration is invalid.');
    }
    seen.add(selection.agentProfileId);
    if (Boolean(selection.runtimeId) !== Boolean(selection.modelId)) {
      throw new Error('Discourse draft agent configuration is incomplete.');
    }
    for (const [label, value, limit] of [
      ['runtime id', selection.runtimeId, 128],
      ['model id', selection.modelId, 256],
      ['reasoning effort', selection.reasoningEffort, 64]
    ] as const) {
      if (
        value !== undefined &&
        (!value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value))
      ) {
        throw new Error(`Discourse draft agent ${label} is invalid.`);
      }
    }
    return { ...selection };
  });
}

function validateDraftRecord(draft: DiscourseDraftRecord): DiscourseDraftRecord {
  requireSafeId(draft.id, 'draft id');
  if (!Number.isSafeInteger(draft.recordRevision) || draft.recordRevision < 1) {
    throw storedIntegrity('draft record revision is invalid');
  }
  if (draft.conversationId) requireSafeId(draft.conversationId, 'conversation id');
  validateDraftInput(draft);
  const normalizedTokens = normalizeDraftTokens(draft.tokens);
  if (
    normalizedTokens.length !== draft.tokens.length ||
    normalizedTokens.some((token, index) => token.id !== draft.tokens[index]?.id)
  ) {
    throw storedIntegrity('draft token identity is invalid');
  }
  requireTimestamp(draft.updatedAt);
  return draft;
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

function summaryFromLoaded(
  loaded: LoadedConversation,
  reader: SqlReader
): DiscourseConversationSummary {
  const conversation = loaded.aggregate.conversation;
  const lastMessageAt = reader.get<{ createdAt: string }>(
    `SELECT created_at AS createdAt FROM discourse_messages
      WHERE conversation_id = ? ORDER BY message_ordinal DESC LIMIT 1`,
    [conversation.id]
  )?.createdAt;
  const activeWaves = loaded.aggregate.waves.filter(({ status }) => status !== 'SETTLED');
  const waveTriggerIds = new Set(loaded.aggregate.waves.map(({ triggerMessageId }) => triggerMessageId));
  const acceptedWithoutWave = loaded.aggregate.acceptedSends.some(
    (accepted) => accepted.status === 'PENDING' && !waveTriggerIds.has(accepted.triggerMessageId)
  );
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
      acceptedWithoutWave ||
      activeWaves.some(({ status }) => status === 'RECOVERY_REQUIRED') ||
      activeWaves.some(({ dispatchGate }) => dispatchGate.status === 'RECONFIRMATION_REQUIRED') ||
      loaded.aggregate.jobs.some(({ status }) => status === 'RECOVERY_REQUIRED') ||
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

function hasPendingAcceptedSend(aggregate: DiscourseConversationAggregateRecord): boolean {
  const waveTriggers = new Set(aggregate.waves.map(({ triggerMessageId }) => triggerMessageId));
  return aggregate.acceptedSends.some(
    (accepted) => accepted.status === 'PENDING' && !waveTriggers.has(accepted.triggerMessageId)
  );
}

function assertParticipantSeed(
  participants: readonly DiscourseParticipantRecord[],
  revisions: readonly DiscourseParticipantRevisionRecord[],
  conversationId: string
): void {
  if (
    participants.length !== revisions.length ||
    new Set(participants.map(({ id }) => id)).size !== participants.length ||
    new Set(revisions.map(({ id }) => id)).size !== revisions.length
  ) {
    throw new Error('Discourse participant seed contains duplicate or unmatched records.');
  }
  const enabledProfiles = new Set<string>();
  for (const participant of participants) {
    requireSafeId(participant.id, 'participant id');
    requireSafeId(participant.currentRevisionId, 'participant revision id');
    if (
      participant.conversationId !== conversationId ||
      participant.recordRevision !== 1 ||
      !participant.enabled ||
      enabledProfiles.has(participant.agentProfileId)
    ) {
      throw new Error('Discourse participant seed must contain enabled first revisions.');
    }
    enabledProfiles.add(participant.agentProfileId);
    requireTimestamp(participant.createdAt);
    const revision = revisions.find(({ id }) => id === participant.currentRevisionId);
    if (
      !revision ||
      revision.conversationId !== conversationId ||
      revision.stableParticipantId !== participant.id ||
      revision.agentProfileId !== participant.agentProfileId ||
      revision.revision !== 1
    ) {
      throw new Error('Discourse participant seed is missing its immutable revision.');
    }
  }
  for (const revision of revisions) {
    assertParticipantRevisionRecord(revision);
    if (!participants.some(({ id }) => id === revision.stableParticipantId)) {
      throw new Error('Discourse participant revision seed is invalid.');
    }
  }
}

function assertParticipantRevisionRecord(
  revision: DiscourseParticipantRevisionRecord
): void {
  requireSafeId(revision.id, 'participant revision id');
  requireSafeId(revision.stableParticipantId, 'participant id');
  if (
    !revision.displayNameSnapshot.trim() ||
    !revision.runtimeId.trim() ||
    !revision.model.trim() ||
    (revision.modelProvider !== undefined && !revision.modelProvider.trim()) ||
    !SHA256.test(revision.roleContractHash) ||
    !Number.isSafeInteger(revision.revision) ||
    revision.revision < 1 ||
    !Number.isSafeInteger(revision.profileRevision) ||
    revision.profileRevision < 1
  ) {
    throw new Error('Discourse participant revision is invalid.');
  }
  requireTimestamp(revision.createdAt);
}

function validateParticipantConfigurationBatch(
  loaded: LoadedConversation,
  conversationId: string,
  participants: readonly DiscourseParticipantRecord[],
  participantRevisions: readonly DiscourseParticipantRevisionRecord[],
  allowEmpty: boolean
): string[] {
  if (
    (!allowEmpty && participants.length === 0) ||
    participants.length !== participantRevisions.length
  ) {
    throw new Error('Discourse participant configuration requires matching records.');
  }
  const changedParticipantIds = new Set<string>();
  const changedProfileIds = new Set<string>();
  const revisionIds = new Set(loaded.aggregate.participantRevisions.map(({ id }) => id));
  for (const [index, participant] of participants.entries()) {
    const revision = participantRevisions[index]!;
    const existing = loaded.aggregate.participants.find(({ id }) => id === participant.id);
    const currentRevision = existing
      ? loaded.aggregate.participantRevisions.find(({ id }) => id === existing.currentRevisionId)
      : undefined;
    const commonInvalid =
      changedParticipantIds.has(participant.id) ||
      changedProfileIds.has(participant.agentProfileId) ||
      revisionIds.has(revision.id) ||
      participant.conversationId !== conversationId ||
      revision.conversationId !== conversationId ||
      revision.stableParticipantId !== participant.id ||
      revision.agentProfileId !== participant.agentProfileId ||
      participant.currentRevisionId !== revision.id ||
      !participant.enabled;
    const existingInvalid = existing && (
      !currentRevision ||
      !existing.enabled ||
      participant.agentProfileId !== existing.agentProfileId ||
      participant.createdAt !== existing.createdAt ||
      participant.recordRevision !== existing.recordRevision + 1 ||
      revision.revision !== currentRevision.revision + 1
    );
    const newInvalid = !existing && (
      participant.recordRevision !== 1 ||
      revision.revision !== 1 ||
      loaded.aggregate.participants.some(
        (candidate) => candidate.agentProfileId === participant.agentProfileId && candidate.enabled
      )
    );
    if (commonInvalid || existingInvalid || newInvalid) {
      throw new Error('Discourse participant configuration revision is invalid.');
    }
    assertParticipantRevisionRecord(revision);
    changedParticipantIds.add(participant.id);
    changedProfileIds.add(participant.agentProfileId);
    revisionIds.add(revision.id);
  }
  return participants
    .filter((participant) => !loaded.aggregate.participants.some(({ id }) => id === participant.id))
    .map(({ id }) => id);
}

function assignmentMatchesParticipantRevision(
  assignment: AgentAssignmentSnapshot,
  revision: DiscourseParticipantRevisionRecord
): boolean {
  return assignment.stableParticipantId === revision.stableParticipantId &&
    assignment.agentProfileId === revision.agentProfileId &&
    assignment.profileRevision === revision.profileRevision &&
    assignment.displayNameSnapshot === revision.displayNameSnapshot &&
    assignment.runtimeId === revision.runtimeId &&
    assignment.model === revision.model &&
    assignment.modelProvider === revision.modelProvider &&
    assignment.reasoningEffort === revision.reasoningEffort &&
    assignment.serviceTier === revision.serviceTier &&
    assignment.configuredRole === revision.configuredRole &&
    assignment.roleContractVersion === revision.roleContractVersion &&
    assignment.roleContractHash === revision.roleContractHash;
}

function assertWavePlan(input: CreateDiscourseWaveInput, loaded: LoadedConversation): void {
  const { wave, jobs, contextSnapshot } = input;
  requireSafeId(wave.id, 'wave id');
  if (
    wave.conversationId !== input.conversationId ||
    loaded.aggregate.waves.some(({ id }) => id === wave.id)
  ) {
    throw new Error('Discourse wave plan has invalid or duplicate ownership.');
  }
  if (wave.clientOperationId !== input.clientOperationId) {
    throw new Error('Discourse wave plan does not match its client operation.');
  }
  requireFingerprint(wave.requestFingerprint, 'wave request fingerprint');
  const accepted = loaded.aggregate.acceptedSends.find(
    ({ triggerMessageId }) => triggerMessageId === wave.triggerMessageId
  );
  if (
    accepted &&
    (
      accepted.status !== 'PENDING' ||
      wave.clientOperationId !== `${accepted.clientMessageId}:wave` ||
      wave.requestFingerprint !== accepted.requestFingerprint ||
      wave.policy !== accepted.policy ||
      stableStringify(wave.assignments) !== stableStringify(accepted.assignments) ||
      wave.dispatchGate.previewFingerprint !== accepted.previewFingerprint
    )
  ) {
    throw new Error('Discourse wave plan does not match its accepted send intent.');
  }
  if (wave.recordRevision !== 1 || wave.status !== 'PLANNED') {
    throw new Error('A new discourse wave must start as revision-one PLANNED state.');
  }
  if (wave.startedAt || wave.settledAt || wave.outcome || wave.settlementReason) {
    throw new Error('A new discourse wave cannot carry execution or settlement evidence.');
  }
  requireTimestamp(wave.createdAt);
  assertMessageReferencesExist(loaded, [wave.triggerMessageId, ...wave.sourceMessageIds], 'wave source');
  if (
    !wave.sourceMessageIds.includes(wave.triggerMessageId) ||
    new Set(wave.sourceMessageIds).size !== wave.sourceMessageIds.length
  ) {
    throw new Error('A discourse wave source set must contain its trigger without duplicates.');
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
    !loaded.aggregate.contextRevisions.some(({ id }) => id === contextSnapshot.contextRevisionId)
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
    if (loaded.aggregate.jobs.some(({ id }) => id === job.id)) {
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
      job.sessionId || job.executionProfileHash || job.runId || job.startedAt || job.finishedAt ||
      job.result || job.error || job.freshnessAtCompletion || job.promptArtifactId || job.outputArtifactId
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
    loaded.aggregate.jobs.some(({ id }) => id === job.id) ||
    loaded.aggregate.jobs.some(({ generationKey }) => generationKey === job.generationKey)
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
      ({ id }) => id === assignment.stableParticipantId
    );
    const revision = loaded.aggregate.participantRevisions.find(
      ({ id }) => id === assignment.participantRevisionId
    );
    if (
      !participant ||
      !participant.enabled ||
      !revision ||
      revision.stableParticipantId !== participant.id ||
      !assignmentMatchesParticipantRevision(assignment, revision)
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
  const output = loaded.messages.get(outputMessageId);
  if (!output || output.jobId !== job.id || output.waveId !== job.waveId) {
    throw new Error('A discourse job result must reference its own durable output message.');
  }
}

function replaceRecord<T extends { id: string }>(records: T[], next: T, label: string): void {
  const index = records.findIndex(({ id }) => id === next.id);
  if (index < 0) throw new Error(`Discourse ${label} update references an unknown record.`);
  records[index] = next;
}

function replaceOrAppend<T extends { id: string }>(records: T[], next: T): void {
  const index = records.findIndex(({ id }) => id === next.id);
  if (index < 0) records.push(next);
  else records[index] = next;
}

function requireAggregateJob(
  loaded: LoadedConversation,
  jobId: string
): DiscourseAgentJobRecord {
  const job = loaded.aggregate.jobs.find(({ id }) => id === jobId);
  if (!job) throw new Error(`Discourse job not found: ${jobId}`);
  return job;
}

function assertUniqueRecordIds(records: readonly { id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const record of records) {
    requireSafeId(record.id, `${label} id`);
    if (ids.has(record.id)) throw new Error(`Duplicate discourse ${label} id: ${record.id}`);
    ids.add(record.id);
  }
}

function bumpConversation(
  conversation: DiscourseConversationRecord,
  timestamp: string,
  patch: Partial<DiscourseConversationRecord> = {}
): DiscourseConversationRecord {
  return {
    ...conversation,
    ...patch,
    id: conversation.id,
    createdAt: conversation.createdAt,
    recordRevision: conversation.recordRevision + 1,
    updatedAt: requireTimestamp(timestamp)
  };
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

function requireFingerprint(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`Discourse ${label} must be a SHA-256 digest.`);
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

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parsePayload<T>(value: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw storedIntegrity(`${label} payload is not valid JSON`);
  }
  return parseStoredObject<T>(parsed, label);
}

function parseStoredObject<T>(value: unknown, label: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw storedIntegrity(`${label} payload is invalid`);
  }
  return value as T;
}

function storedIntegrity(detail: string): Error {
  return new Error(`Stored discourse ${detail}.`);
}

function isStoredIntegrityError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Stored discourse ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
