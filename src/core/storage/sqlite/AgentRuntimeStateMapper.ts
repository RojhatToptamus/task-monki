import type {
  AgentOwnerScope,
  AgentRuntimeArtifactRecord,
  AgentRuntimeStoreState
} from '../../../shared/agentRuntime';
import type {
  AppDatabase,
  AppDatabaseTransaction,
  SqlReader,
  SqlValue
} from './AppDatabase';
import type { ManagedFileStore } from './ManagedFileStore';

type RuntimeCollectionKey = Exclude<
  keyof AgentRuntimeStoreState,
  | 'schemaVersion'
  | 'revision'
  | 'nextEventOrdinal'
  | 'nextQueueOrdinal'
  | 'shutdownLatched'
  | 'artifacts'
>;
type RuntimeRecord = { id: string } & Record<string, unknown>;
type RowValues = Record<string, SqlValue>;

interface RuntimeCollectionCodec {
  key: RuntimeCollectionKey;
  table: string;
  orderBy: string;
  values(record: RuntimeRecord): RowValues;
}

interface RuntimeMetadataRow {
  record_revision: number | bigint;
  next_event_ordinal: number | bigint;
  next_queue_ordinal: number | bigint;
  shutdown_latched: number | bigint | null;
}

interface RuntimeArtifactRow {
  [column: string]: SqlValue;
  id: string;
  payload_json: string;
  managed_file_row_id: string | null;
  managed_file_storage_key: string | null;
  managed_file_content_sha256: string | null;
  managed_file_byte_count: number | bigint | null;
}

interface PendingGcRow {
  storage_key: string;
}

const json = (value: unknown): string => JSON.stringify(value);
const nullable = (value: unknown): SqlValue =>
  value === undefined || value === null ? null : (value as SqlValue);
const field = (record: RuntimeRecord, key: string): SqlValue => nullable(record[key]);

function ownerValues(owner: AgentOwnerScope | undefined): RowValues {
  if (!owner) {
    return {
      owner_kind: null,
      task_id: null,
      generation_id: null,
      request_id: null,
      conversation_id: null,
      stable_participant_id: null
    };
  }
  return {
    owner_kind: owner.kind,
    task_id:
      owner.kind === 'TASK' || owner.kind === 'PREVIEW_RECIPE_GENERATION'
        ? owner.taskId
        : null,
    generation_id:
      owner.kind === 'PREVIEW_RECIPE_GENERATION' ? owner.generationId : null,
    request_id: owner.kind === 'PROMPT_REFINEMENT' ? owner.requestId : null,
    conversation_id: owner.kind === 'DISCOURSE' ? owner.conversationId : null,
    stable_participant_id: owner.kind === 'DISCOURSE' ? owner.stableParticipantId : null
  };
}

const COLLECTIONS: readonly RuntimeCollectionCodec[] = [
  {
    key: 'servers',
    table: 'runtime_servers',
    orderBy: 'started_at, id',
    values: (record) => ({
      id: field(record, 'id'),
      runtime_id: field(record, 'runtimeId'),
      status: field(record, 'status'),
      pid: field(record, 'pid'),
      started_at: field(record, 'startedAt'),
      updated_at: nullable(record.lastHealthAt ?? record.exitedAt),
      payload_json: json(record)
    })
  },
  {
    key: 'sessions',
    table: 'runtime_sessions',
    orderBy: 'created_at, id',
    values: (record) => ({
      id: field(record, 'id'),
      runtime_id: field(record, 'runtimeId'),
      ...ownerValues(record.owner as AgentOwnerScope),
      provider_session_id: field(record, 'providerSessionId'),
      status: field(record, 'status'),
      role: field(record, 'role'),
      client_operation_id: field(record, 'clientOperationId'),
      request_fingerprint: field(record, 'requestFingerprint'),
      record_revision: field(record, 'recordRevision'),
      created_at: field(record, 'createdAt'),
      updated_at: field(record, 'updatedAt'),
      payload_json: json(record)
    })
  },
  {
    key: 'runs',
    table: 'runtime_runs',
    orderBy: 'created_at, id',
    values: (record) => {
      const scope = record.scope as Record<string, unknown>;
      return {
        id: field(record, 'id'),
        runtime_id: nullable(
          (record.requestedSettings as Record<string, unknown> | undefined)?.runtimeId
        ),
        ...ownerValues(record.owner as AgentOwnerScope),
        iteration_id: nullable(scope.iterationId),
        worktree_id: nullable(scope.worktreeId),
        wave_id: nullable(scope.waveId),
        job_id: nullable(scope.jobId),
        attempt_id: nullable(scope.attemptId),
        session_id: field(record, 'sessionId'),
        server_instance_id: field(record, 'serverInstanceId'),
        provider_turn_id: field(record, 'providerTurnId'),
        status: field(record, 'status'),
        recovery_state: field(record, 'recoveryState'),
        generation_key: field(record, 'generationKey'),
        client_operation_id: field(record, 'clientOperationId'),
        request_fingerprint: field(record, 'requestFingerprint'),
        record_revision: field(record, 'recordRevision'),
        created_at: field(record, 'createdAt'),
        started_at: field(record, 'startedAt'),
        last_event_at: field(record, 'lastEventAt'),
        ended_at: field(record, 'endedAt'),
        payload_json: json(record)
      };
    }
  },
  {
    key: 'queueEntries',
    table: 'runtime_queue_entries',
    orderBy: 'enqueue_ordinal, id',
    values: (record) => ({
      id: field(record, 'id'),
      run_id: field(record, 'runId'),
      session_id: field(record, 'sessionId'),
      ...ownerValues(record.owner as AgentOwnerScope),
      priority: field(record, 'priority'),
      status: field(record, 'status'),
      enqueue_ordinal: field(record, 'enqueueOrdinal'),
      client_operation_id: field(record, 'clientOperationId'),
      request_fingerprint: field(record, 'requestFingerprint'),
      record_revision: field(record, 'recordRevision'),
      enqueued_at: field(record, 'enqueuedAt'),
      not_before: field(record, 'notBefore'),
      leased_at: field(record, 'leasedAt'),
      settled_at: field(record, 'settledAt'),
      payload_json: json(record)
    })
  },
  {
    key: 'telemetryRecords',
    table: 'runtime_telemetry',
    orderBy: 'observed_at, id',
    values: (record) => ({
      id: field(record, 'id'),
      kind: field(record, 'kind'),
      ...ownerValues(record.owner as AgentOwnerScope | undefined),
      session_id: field(record, 'sessionId'),
      run_id: field(record, 'runId'),
      server_instance_id: field(record, 'serverInstanceId'),
      provider_identity: field(record, 'providerIdentity'),
      client_operation_id: field(record, 'clientOperationId'),
      request_fingerprint: field(record, 'requestFingerprint'),
      observed_at: field(record, 'observedAt'),
      created_at: field(record, 'createdAt'),
      payload_json: json(record)
    })
  },
  typedCodec('items', 'runtime_items', 'created_at, id', (record) => ({
    run_id: field(record, 'runId'),
    provider_item_id: field(record, 'providerItemId'),
    type: field(record, 'type'),
    status: field(record, 'status'),
    created_at: field(record, 'createdAt'),
    updated_at: field(record, 'updatedAt')
  })),
  typedCodec('interactions', 'runtime_interactions', 'requested_at, id', (record) => ({
    run_id: field(record, 'runId'),
    server_instance_id: field(record, 'serverInstanceId'),
    provider_request_id: String(record.providerRequestId),
    type: field(record, 'type'),
    status: field(record, 'status'),
    requested_at: field(record, 'requestedAt'),
    responded_at: field(record, 'respondedAt'),
    resolved_at: field(record, 'resolvedAt')
  })),
  typedCodec('goalSnapshots', 'runtime_goal_snapshots', 'observed_at, id', (record) => ({
    status: field(record, 'providerStatus'),
    observed_at: field(record, 'observedAt')
  })),
  typedCodec('planRevisions', 'runtime_plan_revisions', 'observed_at, id', (record) => ({
    run_id: field(record, 'runId'),
    revision: field(record, 'revision'),
    observed_at: field(record, 'observedAt')
  })),
  typedCodec('usageSnapshots', 'runtime_usage_snapshots', 'observed_at, id', (record) => ({
    run_id: field(record, 'runId'),
    observed_at: field(record, 'observedAt')
  })),
  typedCodec(
    'settingsObservations',
    'runtime_settings_observations',
    'observed_at, id',
    (record) => ({ run_id: field(record, 'runId'), observed_at: field(record, 'observedAt') })
  ),
  typedCodec(
    'subagentObservations',
    'runtime_subagent_observations',
    'observed_at, id',
    (record) => ({
      parent_session_id: field(record, 'parentSessionId'),
      parent_run_id: field(record, 'parentRunId'),
      provider_child_session_id: field(record, 'providerChildSessionId'),
      status: field(record, 'status'),
      observed_at: field(record, 'observedAt')
    })
  ),
  {
    key: 'events',
    table: 'runtime_events',
    orderBy: 'event_ordinal, id',
    values: (record) => ({
      id: field(record, 'id'),
      event_ordinal: field(record, 'ordinal'),
      type: field(record, 'type'),
      run_id: field(record, 'runId'),
      session_id: field(record, 'sessionId'),
      queue_entry_id: field(record, 'queueEntryId'),
      artifact_id: field(record, 'artifactId'),
      operation_id: field(record, 'operationId'),
      occurred_at: field(record, 'occurredAt'),
      payload_json: json(record)
    })
  }
] as const;

function typedCodec(
  key: RuntimeCollectionKey,
  table: string,
  orderBy: string,
  additionalValues: (record: RuntimeRecord) => RowValues
): RuntimeCollectionCodec {
  return {
    key,
    table,
    orderBy,
    values: (record) => ({
      id: field(record, 'id'),
      ...ownerValues(record.owner as AgentOwnerScope),
      session_id: field(record, 'sessionId'),
      client_operation_id: field(record, 'clientOperationId'),
      request_fingerprint: field(record, 'requestFingerprint'),
      record_revision: field(record, 'recordRevision'),
      ...additionalValues(record),
      payload_json: json(record)
    })
  };
}

export class AgentRuntimeStateMapper {
  constructor(
    private readonly database: AppDatabase,
    private readonly managedFiles: ManagedFileStore
  ) {}

  async load(empty: () => AgentRuntimeStoreState): Promise<AgentRuntimeStoreState> {
    return this.database.read((reader) => {
      const metadata = reader.get<RuntimeMetadataRow>(
        `SELECT record_revision, next_event_ordinal, next_queue_ordinal, shutdown_latched
         FROM store_metadata WHERE domain = 'RUNTIME'`
      );
      const state = empty();
      for (const codec of COLLECTIONS) {
        const rows = reader.all<Record<string, SqlValue>>(
          `SELECT * FROM ${codec.table} ORDER BY ${codec.orderBy}`
        );
        (state[codec.key] as unknown as RuntimeRecord[]) = rows.map((row) =>
          parseIndexedRecord(row, codec, state)
        );
      }
      state.artifacts = this.loadArtifacts(reader);
      if (!metadata) {
        if (hasRecords(state)) {
          throw new Error('Runtime persistence records exist without runtime metadata.');
        }
        return state;
      }
      state.revision = safeInteger(metadata.record_revision, 'runtime revision');
      state.nextEventOrdinal = safeInteger(metadata.next_event_ordinal, 'runtime event ordinal');
      state.nextQueueOrdinal = safeInteger(metadata.next_queue_ordinal, 'runtime queue ordinal');
      state.shutdownLatched = strictStoredBoolean(
        metadata.shutdown_latched,
        'runtime shutdown latch'
      );
      return state;
    });
  }

  async persist(
    previous: AgentRuntimeStoreState,
    next: AgentRuntimeStoreState
  ): Promise<void> {
    await this.database.write((transaction) => {
      for (const codec of [...COLLECTIONS].reverse()) {
        deleteRemoved(transaction, codec, records(previous, codec.key), records(next, codec.key));
      }
      this.deleteRemovedArtifacts(transaction, previous.artifacts, next.artifacts);

      for (const codec of COLLECTIONS) {
        if (codec.key === 'events') continue;
        upsertChanged(
          transaction,
          codec,
          records(previous, codec.key),
          records(next, codec.key),
          next
        );
      }
      this.upsertChangedArtifacts(transaction, previous.artifacts, next.artifacts);
      const eventCodec = COLLECTIONS.find((codec) => codec.key === 'events');
      if (!eventCodec) throw new Error('Runtime event persistence codec is missing.');
      upsertChanged(
        transaction,
        eventCodec,
        records(previous, eventCodec.key),
        records(next, eventCodec.key),
        next
      );
      transaction.run(
        `INSERT INTO store_metadata (
           domain, record_revision, next_event_ordinal, next_queue_ordinal,
           shutdown_latched, payload_json, updated_at
         ) VALUES ('RUNTIME', ?, ?, ?, ?, '{}', ?)
         ON CONFLICT(domain) DO UPDATE SET
           record_revision = excluded.record_revision,
           next_event_ordinal = excluded.next_event_ordinal,
           next_queue_ordinal = excluded.next_queue_ordinal,
           shutdown_latched = excluded.shutdown_latched,
           updated_at = excluded.updated_at`,
        [
          next.revision,
          next.nextEventOrdinal,
          next.nextQueueOrdinal,
          next.shutdownLatched ? 1 : 0,
          new Date().toISOString()
        ]
      );
    });
  }

  async verifyArtifacts(artifacts: readonly AgentRuntimeArtifactRecord[]): Promise<void> {
    for (const artifact of artifacts) {
      await this.managedFiles.verify({
        storageKey: artifact.storageKey,
        byteCount: artifact.byteCount,
        sha256: artifact.contentSha256
      });
    }
  }

  async retryPendingGarbageCollection(): Promise<void> {
    const rows = await this.database.read((reader) =>
      reader.all<PendingGcRow>(
        `SELECT storage_key FROM managed_file_gc
         WHERE storage_key LIKE 'runtime/artifacts/%'
         ORDER BY queued_at, storage_key`
      )
    );
    const completed: string[] = [];
    for (const row of rows) {
      try {
        await this.managedFiles.deleteAfterReferenceCommit(row.storage_key);
        completed.push(row.storage_key);
      } catch (error) {
        await this.database.write((transaction) => {
          transaction.run(
            `UPDATE managed_file_gc
             SET attempts = attempts + 1, last_error = ?
             WHERE storage_key = ?`,
            [error instanceof Error ? error.message : String(error), row.storage_key]
          );
        });
      }
    }
    if (completed.length > 0) {
      await this.database.write((transaction) => {
        for (const storageKey of completed) {
          transaction.run('DELETE FROM managed_file_gc WHERE storage_key = ?', [storageKey]);
        }
      });
    }
  }

  private loadArtifacts(reader: SqlReader): AgentRuntimeArtifactRecord[] {
    return reader
      .all<RuntimeArtifactRow>(
        `SELECT a.*,
                mf.id AS managed_file_row_id,
                mf.domain AS managed_file_domain,
                mf.owner_id AS managed_file_owner_id,
                mf.role AS managed_file_role,
                mf.storage_key AS managed_file_storage_key,
                mf.content_sha256 AS managed_file_content_sha256,
                mf.byte_count AS managed_file_byte_count,
                mf.media_type AS managed_file_media_type,
                mf.state AS managed_file_state,
                mf.created_at AS managed_file_created_at,
                mf.updated_at AS managed_file_updated_at
         FROM runtime_artifacts a
         LEFT JOIN managed_files mf ON mf.id = a.managed_file_id
         ORDER BY a.created_at, a.id`
      )
      .map((row) => {
        const artifact = parseRecord(
          row.payload_json,
          'runtime_artifacts'
        ) as unknown as AgentRuntimeArtifactRecord;
        const managedFileId = runtimeArtifactManagedFileId(artifact.id);
        assertStoredValues(row, {
          id: artifact.id,
          ...ownerValues(artifact.owner),
          run_id: artifact.runId,
          kind: artifact.kind,
          managed_file_id: managedFileId,
          client_operation_id: artifact.clientOperationId,
          request_fingerprint: artifact.requestFingerprint,
          record_revision: artifact.recordRevision,
          created_at: artifact.createdAt,
          updated_at: artifact.updatedAt
        }, `Runtime artifact ${artifact.id}`);
        assertStoredValues(row, {
          managed_file_row_id: managedFileId,
          managed_file_domain: 'RUNTIME',
          managed_file_owner_id: ownerKey(artifact.owner),
          managed_file_role: `ARTIFACT:${artifact.kind}`,
          managed_file_storage_key: artifact.storageKey,
          managed_file_content_sha256: artifact.contentSha256,
          managed_file_byte_count: artifact.byteCount,
          managed_file_media_type: 'text/plain; charset=utf-8',
          managed_file_state: 'LIVE',
          managed_file_created_at: artifact.createdAt,
          managed_file_updated_at: artifact.updatedAt
        }, `Runtime artifact ${artifact.id} managed file`);
        return artifact;
      });
  }

  private upsertChangedArtifacts(
    transaction: AppDatabaseTransaction,
    previous: readonly AgentRuntimeArtifactRecord[],
    next: readonly AgentRuntimeArtifactRecord[]
  ): void {
    const previousById = new Map(previous.map((record) => [record.id, record]));
    const publishedStorageKeys: string[] = [];
    for (const artifact of next) {
      const prior = previousById.get(artifact.id);
      if (prior && json(prior) === json(artifact)) continue;
      if (!prior || prior.storageKey !== artifact.storageKey) {
        publishedStorageKeys.push(artifact.storageKey);
      }
      if (prior && prior.storageKey !== artifact.storageKey) {
        queueFileDeletion(transaction, prior.storageKey, 'RUNTIME_ARTIFACT_REPLACED');
      }
      const managedFileId = runtimeArtifactManagedFileId(artifact.id);
      upsertRow(transaction, 'managed_files', {
        id: managedFileId,
        domain: 'RUNTIME',
        owner_id: ownerKey(artifact.owner),
        role: `ARTIFACT:${artifact.kind}`,
        storage_key: artifact.storageKey,
        content_sha256: artifact.contentSha256,
        byte_count: artifact.byteCount,
        media_type: 'text/plain; charset=utf-8',
        state: 'LIVE',
        created_at: artifact.createdAt,
        updated_at: artifact.updatedAt
      });
      upsertRow(transaction, 'runtime_artifacts', {
        id: artifact.id,
        ...ownerValues(artifact.owner),
        run_id: artifact.runId,
        kind: artifact.kind,
        managed_file_id: managedFileId,
        client_operation_id: artifact.clientOperationId,
        request_fingerprint: artifact.requestFingerprint,
        record_revision: artifact.recordRevision,
        created_at: artifact.createdAt,
        updated_at: artifact.updatedAt,
        payload_json: json(artifact)
      });
    }
    if (publishedStorageKeys.length > 0) {
      transaction.afterRollbackDeferred(() =>
        Promise.allSettled(
          publishedStorageKeys.map((storageKey) =>
            this.managedFiles.deleteAfterReferenceCommit(storageKey)
          )
        ).then(() => undefined)
      );
    }
  }

  private deleteRemovedArtifacts(
    transaction: AppDatabaseTransaction,
    previous: readonly AgentRuntimeArtifactRecord[],
    next: readonly AgentRuntimeArtifactRecord[]
  ): void {
    const nextIds = new Set(next.map((record) => record.id));
    for (const artifact of previous) {
      if (nextIds.has(artifact.id)) continue;
      queueFileDeletion(transaction, artifact.storageKey, 'RUNTIME_ARTIFACT_REMOVED');
      transaction.run('DELETE FROM runtime_artifacts WHERE id = ?', [artifact.id]);
      transaction.run('DELETE FROM managed_files WHERE id = ?', [
        runtimeArtifactManagedFileId(artifact.id)
      ]);
    }
  }
}

function records(
  state: AgentRuntimeStoreState,
  key: RuntimeCollectionKey
): RuntimeRecord[] {
  return state[key] as unknown as RuntimeRecord[];
}

function parseRecord(payload: string, table: string): RuntimeRecord {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    throw new Error(`Runtime persistence table ${table} contains invalid JSON.`, { cause: error });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== 'string'
  ) {
    throw new Error(`Runtime persistence table ${table} contains an invalid logical record.`);
  }
  return value as RuntimeRecord;
}

function parseIndexedRecord(
  row: Record<string, SqlValue>,
  codec: RuntimeCollectionCodec,
  state: AgentRuntimeStoreState
): RuntimeRecord {
  if (typeof row.payload_json !== 'string') {
    throw new Error(`Runtime persistence table ${codec.table} contains invalid JSON metadata.`);
  }
  const record = parseRecord(row.payload_json, codec.table);
  const indexed = indexedValues(codec, record, state);
  for (const [column, expected] of Object.entries(indexed)) {
    if (column === 'payload_json') continue;
    if (row[column] !== expected) {
      throw new Error(
        `Runtime persistence table ${codec.table} column ${column} does not match its record ` +
          `(stored ${String(row[column])}, payload ${String(expected)}).`
      );
    }
  }
  return record;
}

function deleteRemoved(
  transaction: AppDatabaseTransaction,
  codec: RuntimeCollectionCodec,
  previous: readonly RuntimeRecord[],
  next: readonly RuntimeRecord[]
): void {
  const nextIds = new Set(next.map((record) => record.id));
  for (const record of previous) {
    if (!nextIds.has(record.id)) {
      transaction.run(`DELETE FROM ${codec.table} WHERE id = ?`, [record.id]);
    }
  }
}

function upsertChanged(
  transaction: AppDatabaseTransaction,
  codec: RuntimeCollectionCodec,
  previous: readonly RuntimeRecord[],
  next: readonly RuntimeRecord[],
  state: AgentRuntimeStoreState
): void {
  const previousById = new Map(previous.map((record) => [record.id, record]));
  for (const record of next) {
    const prior = previousById.get(record.id);
    if (prior && json(prior) === json(record)) continue;
    const values = indexedValues(codec, record, state);
    upsertRow(transaction, codec.table, values);
  }
}

function indexedValues(
  codec: RuntimeCollectionCodec,
  record: RuntimeRecord,
  state: AgentRuntimeStoreState
): RowValues {
  const values = codec.values(record);
  if (codec.key !== 'runs' || values.runtime_id !== null) return values;

  const session = state.sessions.find((candidate) => candidate.id === record.sessionId);
  if (!session) {
    throw new Error(`Runtime run ${record.id} has no owning session.`);
  }
  values.runtime_id = session.runtimeId;
  return values;
}

function upsertRow(
  transaction: AppDatabaseTransaction,
  table: string,
  values: RowValues
): void {
  const columns = Object.keys(values);
  const update = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`);
  transaction.run(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT(id) DO UPDATE SET ${update.join(', ')}`,
    columns.map((column) => values[column] ?? null)
  );
}

function queueFileDeletion(
  transaction: AppDatabaseTransaction,
  storageKey: string,
  reason: string
): void {
  transaction.run(
    `INSERT INTO managed_file_gc (storage_key, reason, queued_at)
     VALUES (?, ?, ?)
     ON CONFLICT(storage_key) DO NOTHING`,
    [storageKey, reason, new Date().toISOString()]
  );
}

function runtimeArtifactManagedFileId(artifactId: string): string {
  return `runtime-artifact:${artifactId}`;
}

function ownerKey(owner: AgentOwnerScope): string {
  if (owner.kind === 'TASK') return `task:${owner.taskId}`;
  if (owner.kind === 'PROMPT_REFINEMENT') return `prompt-refinement:${owner.requestId}`;
  if (owner.kind === 'PREVIEW_RECIPE_GENERATION') {
    return `preview-recipe-generation:${owner.taskId}:${owner.generationId}`;
  }
  return `discourse:${owner.conversationId}:${owner.stableParticipantId}`;
}

function assertStoredValues(
  row: Record<string, SqlValue>,
  expected: RowValues,
  label: string
): void {
  for (const [column, value] of Object.entries(expected)) {
    const stored = row[column];
    if (stored === value || integerValuesEqual(stored, value)) continue;
    throw new Error(
      `${label} column ${column} does not match its record ` +
        `(stored ${String(stored)}, payload ${String(value)}).`
    );
  }
}

function integerValuesEqual(left: SqlValue | undefined, right: SqlValue): boolean {
  if (
    (typeof left !== 'number' && typeof left !== 'bigint') ||
    (typeof right !== 'number' && typeof right !== 'bigint')
  ) {
    return false;
  }
  return Number.isSafeInteger(Number(left)) && Number(left) === Number(right);
}

function strictStoredBoolean(value: number | bigint | null, label: string): boolean {
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  throw new Error(`Stored ${label} is invalid.`);
}

function safeInteger(value: number | bigint, label: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new Error(`Stored ${label} is invalid.`);
  }
  return numberValue;
}

function hasRecords(state: AgentRuntimeStoreState): boolean {
  return COLLECTIONS.some((codec) => records(state, codec.key).length > 0) || state.artifacts.length > 0;
}
