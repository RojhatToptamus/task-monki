import path from 'node:path';
import { TASK_STORE_SCHEMA_VERSION, type ArtifactRecord, type TaskAttachmentRecord } from '../../../shared/contracts';
import type { StoreState } from '../../projection/reducer';
import {
  type AppDatabase,
  type AppDatabaseTransaction,
  type SqlReader,
  type SqlValue
} from './AppDatabase';
import { SqliteTaskArtifactStore } from './SqliteTaskArtifactStore';
import type { ManagedFileStore } from './ManagedFileStore';

const TASK_RUNTIME_COLLECTIONS = [
  'runs',
  'agentServers',
  'agentSessions',
  'agentItems',
  'agentGoalSnapshots',
  'agentPlanRevisions',
  'agentUsageSnapshots',
  'agentSettingsObservations',
  'agentSubagentObservations',
  'interactionRequests'
] as const satisfies readonly (keyof StoreState)[];

type TaskRuntimeCollection = (typeof TASK_RUNTIME_COLLECTIONS)[number];
export type PersistedTaskState = Omit<StoreState, TaskRuntimeCollection>;
type CollectionKey = Exclude<keyof PersistedTaskState, 'schemaVersion' | 'artifacts' | 'attachments'>;
type PersistedRecord = { id: string } & Record<string, unknown>;
type RowValues = Record<string, SqlValue>;

interface CollectionCodec {
  key: CollectionKey;
  table: string;
  orderBy: string;
  recordRevision?: boolean;
  values(record: PersistedRecord): RowValues;
}

interface ManagedArtifactRow {
  [column: string]: SqlValue;
  id: string;
  payload_json: string;
  managed_file_row_id: string | null;
  managed_file_storage_key: string | null;
  managed_file_content_sha256: string | null;
  managed_file_byte_count: number | bigint | null;
}

interface ManagedAttachmentRow extends ManagedArtifactRow {}

const json = (value: unknown): string => JSON.stringify(value);
const nullable = (value: unknown): SqlValue =>
  value === undefined || value === null ? null : (value as SqlValue);
const field = (record: PersistedRecord, key: string): SqlValue =>
  nullable(record[key]);

const COLLECTIONS: readonly CollectionCodec[] = [
  {
    key: 'repositories',
    table: 'repositories',
    orderBy: 'created_at DESC, id',
    recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'),
      kind: field(r, 'kind'),
      name: field(r, 'name'),
      path: field(r, 'path'),
      status: field(r, 'status'),
      head_sha: field(r, 'headSha'),
      branch: field(r, 'branch'),
      remotes_json: json(r.remotes),
      error: field(r, 'error'),
      payload_json: json(r),
      created_at: field(r, 'createdAt'),
      updated_at: field(r, 'updatedAt'),
      checked_at: field(r, 'checkedAt')
    })
  },
  {
    key: 'boards',
    table: 'boards',
    orderBy: 'created_at DESC, id',
    recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'),
      name: field(r, 'name'),
      color: field(r, 'color'),
      payload_json: json(r),
      created_at: field(r, 'createdAt'),
      updated_at: field(r, 'updatedAt')
    })
  },
  {
    key: 'tasks',
    table: 'tasks',
    orderBy: 'created_at DESC, id',
    recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'),
      kind: field(r, 'kind'),
      runtime_id: field(r, 'runtimeId'),
      title: field(r, 'title'),
      prompt: field(r, 'prompt'),
      repository_id: field(r, 'repositoryId'),
      creation_token: field(r, 'creationToken'),
      creation_request_fingerprint: field(r, 'creationRequestFingerprint'),
      workflow_phase: field(r, 'workflowPhase'),
      resolution: field(r, 'resolution'),
      completion_policy: field(r, 'completionPolicy'),
      phase_version: field(r, 'phaseVersion'),
      current_run_id: field(r, 'currentRunId'),
      current_session_id: field(r, 'currentAgentSessionId'),
      current_iteration_id: field(r, 'currentIterationId'),
      current_worktree_id: field(r, 'currentWorktreeId'),
      forked_from_task_id: field(r, 'forkedFromTaskId'),
      forked_from_run_id: field(r, 'forkedFromRunId'),
      source_design_id: field(r, 'sourceDesignId'),
      source_design_revision_id: field(r, 'sourceDesignRevisionId'),
      agent_settings_json: json(r.agentSettings),
      payload_json: json(r),
      created_at: field(r, 'createdAt'),
      updated_at: field(r, 'updatedAt')
    })
  },
  {
    key: 'iterations',
    table: 'task_iterations',
    orderBy: 'created_at DESC, id',
    recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'),
      action_request_id: field(r, 'actionRequestId'), generation_key: field(r, 'generationKey'),
      status: field(r, 'status'), branch_name: field(r, 'branchName'), base_ref: field(r, 'baseRef'),
      base_sha: field(r, 'baseSha'), worktree_id: field(r, 'worktreeId'), payload_json: json(r),
      created_at: field(r, 'createdAt'), updated_at: field(r, 'updatedAt')
    })
  },
  {
    key: 'worktrees',
    table: 'worktrees',
    orderBy: 'created_at DESC, id',
    recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), iteration_id: field(r, 'iterationId'),
      repository_id: field(r, 'repositoryId'), worktree_path: field(r, 'worktreePath'),
      branch_name: field(r, 'branchName'), base_ref: field(r, 'baseRef'), base_sha: field(r, 'baseSha'),
      head_sha: field(r, 'headSha'), status: field(r, 'status'), error: field(r, 'error'),
      payload_json: json(r), created_at: field(r, 'createdAt'), updated_at: field(r, 'updatedAt'),
      last_verified_at: field(r, 'lastVerifiedAt')
    })
  },
  {
    key: 'designTurns', table: 'design_turns', orderBy: 'turn_ordinal DESC, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), design_id: field(r, 'designId'), client_message_id: field(r, 'clientMessageId'),
      turn_ordinal: field(r, 'order'), run_id: field(r, 'runId'), outcome: field(r, 'outcome'),
      created_at: field(r, 'createdAt'), settled_at: field(r, 'settledAt'), payload_json: json(r)
    })
  },
  {
    key: 'designReferences', table: 'design_references', orderBy: 'created_at, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), design_id: field(r, 'designId'), attachment_id: field(r, 'attachmentId'),
      role: field(r, 'role'), state: field(r, 'state'), created_at: field(r, 'createdAt'),
      updated_at: nullable(r.deactivatedAt ?? r.createdAt), payload_json: json(r)
    })
  },
  {
    key: 'designRevisions', table: 'design_revisions', orderBy: 'revision_ordinal DESC, id',
    values: (r) => ({
      id: field(r, 'id'), design_id: field(r, 'designId'), revision_ordinal: field(r, 'ordinal'),
      commit_sha: field(r, 'commitSha'), change_source: field(r, 'changeSource'),
      created_at: field(r, 'createdAt'), payload_json: json(r)
    })
  },
  {
    key: 'designSourceActions', table: 'design_source_actions', orderBy: 'created_at DESC, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), design_id: field(r, 'designId'), client_action_id: field(r, 'clientActionId'),
      kind: field(r, 'kind'), checkpoint: nullable((r.checkpoint as Record<string, unknown> | undefined)?.boundary),
      source_revision_id: field(r, 'sourceRevisionId'), target_design_id: field(r, 'targetDesignId'),
      created_at: field(r, 'createdAt'), updated_at: field(r, 'updatedAt'), payload_json: json(r)
    })
  },
  evidenceCodec('gitSnapshots', 'git_snapshots', 'captured_at DESC, id', (r) => ({
    id: field(r, 'id'), task_id: field(r, 'taskId'), iteration_id: field(r, 'iterationId'),
    worktree_id: field(r, 'worktreeId'), status: field(r, 'status'), head_sha: field(r, 'headSha'),
    captured_at: field(r, 'capturedAt'), payload_json: json(r)
  })),
  evidenceCodec('githubRepositories', 'github_repository_observations', 'checked_at DESC, id', (r) => ({
    id: field(r, 'id'), task_id: field(r, 'taskId'), iteration_id: field(r, 'iterationId'),
    worktree_id: field(r, 'worktreeId'), status: field(r, 'status'), checked_at: field(r, 'checkedAt'),
    payload_json: json(r)
  })),
  {
    key: 'branchPublications', table: 'branch_publications', orderBy: 'requested_at DESC, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), iteration_id: field(r, 'iterationId'),
      worktree_id: field(r, 'worktreeId'), status: field(r, 'status'), head_sha: field(r, 'headSha'),
      requested_at: field(r, 'requestedAt'), updated_at: field(r, 'updatedAt'), payload_json: json(r)
    })
  },
  githubRollupCodec('pullRequests', 'pull_request_snapshots'),
  githubRollupCodec('ciRollups', 'ci_rollups'),
  githubRollupCodec('reviewRollups', 'review_rollups'),
  githubRollupCodec('mergeSnapshots', 'merge_snapshots'),
  {
    key: 'previewPlans', table: 'preview_plans', orderBy: 'created_at DESC, id',
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), iteration_id: field(r, 'iterationId'),
      worktree_id: field(r, 'worktreeId'), execution_digest: field(r, 'executionDigest'),
      created_at: field(r, 'createdAt'), payload_json: json(r)
    })
  },
  {
    key: 'previewApprovals', table: 'preview_approvals', orderBy: 'approved_at DESC, id',
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), plan_id: field(r, 'planId'),
      execution_digest: field(r, 'executionDigest'), approved_at: field(r, 'approvedAt'),
      invalidated_at: field(r, 'invalidatedAt'), payload_json: json(r)
    })
  },
  {
    key: 'previewGenerations', table: 'preview_generations', orderBy: 'created_at DESC, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), preview_key: field(r, 'previewKey'), task_id: field(r, 'taskId'),
      iteration_id: field(r, 'iterationId'), worktree_id: field(r, 'worktreeId'), plan_id: field(r, 'planId'),
      state: field(r, 'state'), routing_state: field(r, 'routingState'), adapter: field(r, 'adapter'),
      replaces_generation_id: field(r, 'replacesGenerationId'), created_at: field(r, 'createdAt'),
      updated_at: field(r, 'updatedAt'), ready_at: field(r, 'readyAt'), cutover_at: field(r, 'cutoverAt'),
      stopped_at: field(r, 'stoppedAt'), payload_json: json(r)
    })
  },
  {
    key: 'previewComposeProjects', table: 'preview_compose_projects', orderBy: 'created_at DESC, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), preview_key: field(r, 'previewKey'),
      state: field(r, 'state'), active_generation_id: field(r, 'activeGenerationId'),
      pending_generation_id: field(r, 'pendingGenerationId'), created_at: field(r, 'createdAt'),
      updated_at: field(r, 'updatedAt'), stopped_at: field(r, 'stoppedAt'), payload_json: json(r)
    })
  },
  {
    key: 'previewManagedEnvironments', table: 'preview_managed_environments', orderBy: 'created_at DESC, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), preview_key: field(r, 'previewKey'), task_id: field(r, 'taskId'),
      state: field(r, 'state'), created_at: field(r, 'createdAt'), updated_at: field(r, 'updatedAt'),
      stopped_at: field(r, 'stoppedAt'), payload_json: json(r)
    })
  },
  {
    key: 'previewManagedResources', table: 'preview_managed_resources', orderBy: 'created_at DESC, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), environment_id: field(r, 'environmentId'),
      logical_resource_id: field(r, 'logicalResourceId'), type: field(r, 'type'), state: field(r, 'state'),
      binding_id: nullable((r.binding as Record<string, unknown> | undefined)?.id),
      created_at: field(r, 'createdAt'), updated_at: field(r, 'updatedAt'), stopped_at: field(r, 'stoppedAt'),
      payload_json: json(r)
    })
  },
  {
    key: 'previewGenerationAttachments', table: 'preview_generation_attachments', orderBy: 'attached_at, id',
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), generation_id: field(r, 'generationId'),
      managed_resource_id: field(r, 'managedResourceId'), logical_resource_id: field(r, 'logicalResourceId'),
      binding_id: field(r, 'bindingId'), attached_at: field(r, 'attachedAt'), payload_json: json(r)
    })
  },
  {
    key: 'previewLocalBindings', table: 'preview_local_bindings', orderBy: 'created_at DESC, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), attachment_id: field(r, 'attachmentId'),
      created_at: field(r, 'createdAt'), updated_at: field(r, 'updatedAt'), payload_json: json(r)
    })
  },
  {
    key: 'previewResources', table: 'preview_native_resources', orderBy: 'updated_at DESC, id', recordRevision: true,
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), generation_id: field(r, 'generationId'),
      logical_node_id: field(r, 'logicalNodeId'), state: field(r, 'state'), updated_at: field(r, 'updatedAt'),
      payload_json: json(r)
    })
  },
  {
    key: 'previewNodeAttempts', table: 'preview_node_attempts', orderBy: 'started_at DESC, id',
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), generation_id: field(r, 'generationId'),
      node_id: field(r, 'nodeId'), attempt: field(r, 'attempt'), kind: field(r, 'kind'), state: field(r, 'state'),
      started_at: field(r, 'startedAt'), ended_at: field(r, 'endedAt'), payload_json: json(r)
    })
  },
  {
    key: 'events', table: 'task_domain_events', orderBy: 'received_at, id',
    values: (r) => ({
      id: field(r, 'id'), task_id: field(r, 'taskId'), iteration_id: field(r, 'iterationId'),
      run_id: field(r, 'runId'), session_id: field(r, 'agentSessionId'),
      server_instance_id: field(r, 'serverInstanceId'), agent_item_id: field(r, 'agentItemId'),
      interaction_request_id: field(r, 'interactionRequestId'), worktree_id: field(r, 'worktreeId'),
      preview_plan_id: field(r, 'previewPlanId'), preview_generation_id: field(r, 'previewGenerationId'),
      type: field(r, 'type'), source: field(r, 'source'), source_event_id: field(r, 'sourceEventId'),
      occurred_at: field(r, 'occurredAt'), received_at: field(r, 'receivedAt'), payload_json: json(r)
    })
  }
] as const;

function evidenceCodec(
  key: CollectionKey,
  table: string,
  orderBy: string,
  values: CollectionCodec['values']
): CollectionCodec {
  return { key, table, orderBy, values };
}

function githubRollupCodec(key: CollectionKey, table: string): CollectionCodec {
  return evidenceCodec(key, table, 'observed_at DESC, id', (r) => ({
    id: field(r, 'id'), task_id: field(r, 'taskId'), iteration_id: field(r, 'iterationId'),
    worktree_id: field(r, 'worktreeId'), pull_request_number: field(r, 'pullRequestNumber') ?? field(r, 'number'),
    head_sha: field(r, 'headSha') ?? field(r, 'headRefOid'), status: field(r, 'status'),
    observed_at: field(r, 'observedAt'), payload_json: json(r)
  }));
}

export class TaskStateMapper {
  private readonly artifactFiles: SqliteTaskArtifactStore;

  constructor(
    private readonly database: AppDatabase,
    private readonly managedFiles: ManagedFileStore
  ) {
    this.artifactFiles = new SqliteTaskArtifactStore(managedFiles);
  }

  async load(): Promise<PersistedTaskState> {
    return this.database.read((reader) => {
      const state = emptyPersistedTaskState();
      for (const codec of COLLECTIONS) {
        const rows = reader.all<Record<string, SqlValue>>(
          `SELECT * FROM ${codec.table} ORDER BY ${codec.orderBy}`
        );
        (state[codec.key] as unknown as PersistedRecord[]) = rows.map((row) =>
          parseIndexedRecord(row, codec)
        );
      }
      state.artifacts = this.loadArtifacts(reader);
      state.attachments = this.loadAttachments(reader);
      verifyBoardAndTaskJoins(reader, state);
      return state;
    });
  }

  persist(
    transaction: AppDatabaseTransaction,
    previous: PersistedTaskState,
    next: PersistedTaskState
  ): void {
    this.registerArtifactLifecycle(transaction, previous.artifacts, next.artifacts);
    for (const codec of [...COLLECTIONS].reverse()) {
      deleteRemoved(transaction, codec, records(previous, codec.key), records(next, codec.key));
    }
    deleteRemovedManagedRecords(transaction, previous, next);

    for (const codec of COLLECTIONS) {
      upsertChanged(transaction, codec, records(previous, codec.key), records(next, codec.key));
    }
    syncBoardAndTaskJoins(transaction, previous, next);
    this.upsertChangedArtifacts(transaction, previous.artifacts, next.artifacts);
    this.upsertChangedAttachments(transaction, previous.attachments, next.attachments);
    transaction.run(
      `INSERT INTO store_metadata (
         domain, record_revision, next_event_ordinal, next_queue_ordinal,
         shutdown_latched, payload_json, updated_at
       ) VALUES ('TASK', 1, NULL, NULL, NULL, '{}', ?)
       ON CONFLICT(domain) DO UPDATE SET
         record_revision = store_metadata.record_revision + 1,
         updated_at = excluded.updated_at`,
      [new Date().toISOString()]
    );
  }

  private registerArtifactLifecycle(
    transaction: AppDatabaseTransaction,
    previous: readonly ArtifactRecord[],
    next: readonly ArtifactRecord[]
  ): void {
    const previousById = new Map(previous.map((record) => [record.id, record]));
    const nextById = new Map(next.map((record) => [record.id, record]));
    const published = next.filter((record) => {
      const prior = previousById.get(record.id);
      return !prior || prior.path !== record.path;
    });
    const replacedOrRemoved = previous.filter((record) => {
      const replacement = nextById.get(record.id);
      return !replacement || replacement.path !== record.path;
    });

    for (const record of replacedOrRemoved) {
      queueFileDeletion(
        transaction,
        this.artifactFiles.reference(record).storageKey,
        nextById.has(record.id) ? 'TASK_ARTIFACT_REPLACED' : 'TASK_ARTIFACT_REMOVED'
      );
    }
    if (published.length > 0) {
      transaction.afterRollbackDeferred(() =>
        Promise.allSettled(
          published.map((record) => this.artifactFiles.deleteRevision(record))
        ).then(() => undefined)
      );
    }
    if (replacedOrRemoved.length > 0) {
      transaction.afterCommitDeferred(() =>
        Promise.allSettled(
          replacedOrRemoved.flatMap((record) => [
            this.artifactFiles.deleteRevision(record),
            ...(nextById.has(record.id) ? [] : [this.artifactFiles.deleteCapture(record.id)])
          ])
        ).then(() => undefined)
      );
    }
  }

  async verifyArtifactIntegrity(): Promise<void> {
    const records = await this.database.read((reader) => this.loadArtifacts(reader));
    for (const record of records) {
      await this.artifactFiles.verify(record);
    }
  }

  async retryPendingArtifactGarbageCollection(): Promise<void> {
    const storageKeys = await this.database.read((reader) =>
      reader.all<{ storage_key: string }>(
        `SELECT storage_key FROM managed_file_gc
         WHERE storage_key LIKE 'task/artifacts/%'
         ORDER BY queued_at, storage_key`
      ).map((row) => row.storage_key)
    );
    const completed: string[] = [];
    for (const storageKey of storageKeys) {
      try {
        await this.artifactFiles.deleteStorageKey(storageKey);
        completed.push(storageKey);
      } catch (error) {
        await this.database.write((transaction) => {
          transaction.run(
            `UPDATE managed_file_gc
             SET attempts = attempts + 1, last_error = ?
             WHERE storage_key = ?`,
            [error instanceof Error ? error.message : String(error), storageKey]
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

  private loadArtifacts(reader: SqlReader): ArtifactRecord[] {
    return reader.all<ManagedArtifactRow>(
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
       FROM artifacts a
       LEFT JOIN managed_files mf ON mf.id = a.managed_file_id
       ORDER BY a.created_at DESC, a.id`
    ).map((row) => {
      const payload = parseRecord(row.payload_json, 'artifacts') as unknown as ArtifactRecord;
      const record = {
        ...payload,
        path: this.absoluteManagedPath(row.managed_file_storage_key ?? '')
      };
      const managedFileId = artifactManagedFileId(record.id);
      const file = this.artifactFiles.reference(record);
      assertStoredValues(row, {
        id: record.id,
        domain: 'TASK',
        owner_id: record.taskId,
        task_id: record.taskId,
        run_id: nullable(record.runId),
        kind: record.kind,
        managed_file_id: managedFileId,
        revision: 0,
        client_operation_id: null,
        request_fingerprint: null,
        created_at: record.createdAt,
        updated_at: record.updatedAt
      }, `Task artifact ${record.id}`);
      assertStoredValues(row, {
        managed_file_row_id: managedFileId,
        managed_file_domain: 'TASK',
        managed_file_owner_id: record.taskId,
        managed_file_role: `ARTIFACT:${record.kind}`,
        managed_file_storage_key: file.storageKey,
        managed_file_content_sha256: file.sha256,
        managed_file_byte_count: file.byteCount,
        managed_file_media_type: 'text/plain; charset=utf-8',
        managed_file_state: 'LIVE',
        managed_file_created_at: record.createdAt,
        managed_file_updated_at: record.updatedAt
      }, `Task artifact ${record.id} managed file`);
      return record;
    });
  }

  private loadAttachments(reader: SqlReader): TaskAttachmentRecord[] {
    return reader.all<ManagedAttachmentRow>(
      `SELECT ta.*,
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
       FROM task_attachments ta
       LEFT JOIN managed_files mf ON mf.id = ta.managed_file_id
       ORDER BY ta.task_id, ta.ordinal, ta.id`
    ).map((row) => {
      const record = parseRecord(row.payload_json, 'task_attachments') as unknown as TaskAttachmentRecord;
      const managedFileId = attachmentManagedFileId(record.id);
      assertStoredValues(row, {
        id: record.id,
        task_id: record.taskId,
        managed_file_id: managedFileId,
        kind: record.kind,
        display_name: record.displayName,
        ordinal: record.ordinal,
        created_at: record.createdAt
      }, `Task attachment ${record.id}`);
      assertStoredValues(row, {
        managed_file_row_id: managedFileId,
        managed_file_domain: 'TASK',
        managed_file_owner_id: record.taskId,
        managed_file_role: 'ATTACHMENT',
        managed_file_storage_key: this.storageKeyForAttachment(record),
        managed_file_content_sha256: record.sha256,
        managed_file_byte_count: record.byteCount,
        managed_file_media_type: record.mediaType,
        managed_file_state: 'LIVE',
        managed_file_created_at: record.createdAt,
        managed_file_updated_at: record.createdAt
      }, `Task attachment ${record.id} managed file`);
      return record;
    });
  }

  private upsertChangedArtifacts(
    transaction: AppDatabaseTransaction,
    previous: readonly ArtifactRecord[],
    next: readonly ArtifactRecord[]
  ): void {
    const previousById = new Map(previous.map((record) => [record.id, record]));
    for (const record of next) {
      const prior = previousById.get(record.id);
      if (prior && json(prior) === json(record)) continue;
      const file = this.artifactFiles.reference(record);
      const managedFileId = artifactManagedFileId(record.id);
      upsertManagedFile(transaction, {
        id: managedFileId,
        domain: 'TASK', owner_id: record.taskId, role: `ARTIFACT:${record.kind}`,
        storage_key: file.storageKey, content_sha256: file.sha256, byte_count: file.byteCount,
        media_type: 'text/plain; charset=utf-8', state: 'LIVE',
        created_at: record.createdAt, updated_at: record.updatedAt
      });
      upsertRow(transaction, 'artifacts', {
        id: record.id, domain: 'TASK', owner_id: record.taskId, task_id: record.taskId,
        run_id: nullable(record.runId), kind: record.kind, managed_file_id: managedFileId,
        revision: 0, client_operation_id: null, request_fingerprint: null,
        payload_json: json({ ...record, path: undefined }), created_at: record.createdAt,
        updated_at: record.updatedAt
      }, true);
    }
  }

  private upsertChangedAttachments(
    transaction: AppDatabaseTransaction,
    previous: readonly TaskAttachmentRecord[],
    next: readonly TaskAttachmentRecord[]
  ): void {
    const previousById = new Map(previous.map((record) => [record.id, record]));
    for (const record of next) {
      const prior = previousById.get(record.id);
      if (prior && json(prior) === json(record)) continue;
      const managedFileId = attachmentManagedFileId(record.id);
      upsertManagedFile(transaction, {
        id: managedFileId,
        domain: 'TASK', owner_id: record.taskId, role: 'ATTACHMENT',
        storage_key: this.storageKeyForAttachment(record), content_sha256: record.sha256,
        byte_count: record.byteCount, media_type: record.mediaType, state: 'LIVE',
        created_at: record.createdAt, updated_at: record.createdAt
      });
      upsertRow(transaction, 'task_attachments', {
        id: record.id, task_id: record.taskId, managed_file_id: managedFileId,
        kind: record.kind, display_name: record.displayName, ordinal: record.ordinal,
        payload_json: json(record), created_at: record.createdAt
      }, true);
    }
  }

  private storageKeyForAttachment(record: TaskAttachmentRecord): string {
    return `task/attachments/tasks/${record.taskId}/${record.id}${path.extname(record.displayName).toLocaleLowerCase('en-US')}`;
  }

  private storageKeyForAbsolutePath(filePath: string): string {
    const relative = path.relative(this.managedFiles.rootPath, path.resolve(filePath));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Task managed file escaped the configured managed-file root.');
    }
    return relative.split(path.sep).join('/');
  }

  private absoluteManagedPath(storageKey: string): string {
    if (!storageKey || storageKey.includes('\\')) {
      throw new Error('Task managed-file storage key is invalid.');
    }
    const absolute = path.resolve(this.managedFiles.rootPath, ...storageKey.split('/'));
    this.storageKeyForAbsolutePath(absolute);
    return absolute;
  }
}

function emptyPersistedTaskState(): PersistedTaskState {
  return {
    schemaVersion: TASK_STORE_SCHEMA_VERSION,
    repositories: [], boards: [], tasks: [], designTurns: [], designReferences: [],
    designRevisions: [], designSourceActions: [], iterations: [], worktrees: [], gitSnapshots: [],
    githubRepositories: [], branchPublications: [], pullRequests: [], ciRollups: [], reviewRollups: [],
    mergeSnapshots: [], previewPlans: [], previewApprovals: [], previewComposeProjects: [],
    previewGenerations: [], previewManagedEnvironments: [], previewManagedResources: [],
    previewGenerationAttachments: [], previewLocalBindings: [], previewNodeAttempts: [],
    previewResources: [], events: [], artifacts: [], attachments: []
  };
}

function records(state: PersistedTaskState, key: CollectionKey): PersistedRecord[] {
  return state[key] as unknown as PersistedRecord[];
}

function parseRecord(payload: string, table: string): PersistedRecord {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    throw new Error(`Task persistence table ${table} contains invalid JSON.`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { id?: unknown }).id !== 'string') {
    throw new Error(`Task persistence table ${table} contains an invalid logical record.`);
  }
  return value as PersistedRecord;
}

function parseIndexedRecord(
  row: Record<string, SqlValue>,
  codec: CollectionCodec
): PersistedRecord {
  if (typeof row.payload_json !== 'string') {
    throw new Error(`Task persistence table ${codec.table} contains invalid JSON metadata.`);
  }
  const record = parseRecord(row.payload_json, codec.table);
  const indexed = codec.values(record);
  for (const [column, expected] of Object.entries(indexed)) {
    if (column === 'payload_json') continue;
    if (row[column] !== expected) {
      throw new Error(
        `Task persistence table ${codec.table} column ${column} does not match its record ` +
          `(stored ${String(row[column])}, payload ${String(expected)}).`
      );
    }
  }
  return record;
}

function deleteRemoved(
  transaction: AppDatabaseTransaction,
  codec: CollectionCodec,
  previous: readonly PersistedRecord[],
  next: readonly PersistedRecord[]
): void {
  const nextIds = new Set(next.map((record) => record.id));
  for (const record of previous) {
    if (!nextIds.has(record.id)) transaction.run(`DELETE FROM ${codec.table} WHERE id = ?`, [record.id]);
  }
}

function upsertChanged(
  transaction: AppDatabaseTransaction,
  codec: CollectionCodec,
  previous: readonly PersistedRecord[],
  next: readonly PersistedRecord[]
): void {
  const previousById = new Map(previous.map((record) => [record.id, record]));
  for (const record of next) {
    const prior = previousById.get(record.id);
    if (prior && json(prior) === json(record)) continue;
    upsertRow(transaction, codec.table, codec.values(record), codec.recordRevision === true);
  }
}

function upsertRow(
  transaction: AppDatabaseTransaction,
  table: string,
  values: RowValues,
  recordRevision: boolean
): void {
  const columns = Object.keys(values);
  const update = columns.filter((column) => column !== 'id').map((column) => `${column} = excluded.${column}`);
  if (recordRevision) update.push(`record_revision = ${table}.record_revision + 1`);
  transaction.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT(id) DO UPDATE SET ${update.join(', ')}`,
    columns.map((column) => values[column] ?? null)
  );
}

function upsertManagedFile(transaction: AppDatabaseTransaction, values: RowValues): void {
  upsertRow(transaction, 'managed_files', values, true);
}

function syncBoardAndTaskJoins(
  transaction: AppDatabaseTransaction,
  previous: PersistedTaskState,
  next: PersistedTaskState
): void {
  const previousBoards = new Map(previous.boards.map((board) => [board.id, board]));
  for (const board of next.boards) {
    if (json(previousBoards.get(board.id)) === json(board)) continue;
    transaction.run('DELETE FROM board_repositories WHERE board_id = ?', [board.id]);
    transaction.run('DELETE FROM board_workflow_phases WHERE board_id = ?', [board.id]);
    board.repositoryIds.forEach((repositoryId, ordinal) =>
      transaction.run('INSERT INTO board_repositories (board_id, repository_id, ordinal) VALUES (?, ?, ?)', [board.id, repositoryId, ordinal])
    );
    board.workflowPhases.forEach((phase, ordinal) =>
      transaction.run('INSERT INTO board_workflow_phases (board_id, workflow_phase, ordinal) VALUES (?, ?, ?)', [board.id, phase, ordinal])
    );
  }

  const previousTasks = new Map(previous.tasks.map((task) => [task.id, task]));
  for (const task of next.tasks) {
    if (json(previousTasks.get(task.id)?.forkedAlternativeTaskIds) === json(task.forkedAlternativeTaskIds)) continue;
    transaction.run('DELETE FROM task_alternatives WHERE task_id = ?', [task.id]);
    task.forkedAlternativeTaskIds.forEach((alternativeId, ordinal) =>
      transaction.run('INSERT INTO task_alternatives (task_id, alternative_task_id, ordinal) VALUES (?, ?, ?)', [task.id, alternativeId, ordinal])
    );
  }
}

function verifyBoardAndTaskJoins(reader: SqlReader, state: PersistedTaskState): void {
  for (const board of state.boards) {
    const repositories = reader.all<{ repository_id: string }>(
      'SELECT repository_id FROM board_repositories WHERE board_id = ? ORDER BY ordinal', [board.id]
    ).map((row) => row.repository_id);
    const phases = reader.all<{ workflow_phase: string }>(
      'SELECT workflow_phase FROM board_workflow_phases WHERE board_id = ? ORDER BY ordinal', [board.id]
    ).map((row) => row.workflow_phase);
    if (json(repositories) !== json(board.repositoryIds) || json(phases) !== json(board.workflowPhases)) {
      throw new Error(`Board ${board.id} has inconsistent relational indexes.`);
    }
  }
  for (const task of state.tasks) {
    const alternatives = reader.all<{ alternative_task_id: string }>(
      'SELECT alternative_task_id FROM task_alternatives WHERE task_id = ? ORDER BY ordinal', [task.id]
    ).map((row) => row.alternative_task_id);
    if (json(alternatives) !== json(task.forkedAlternativeTaskIds)) {
      throw new Error(`Task ${task.id} has inconsistent alternative links.`);
    }
  }
}

function deleteRemovedManagedRecords(
  transaction: AppDatabaseTransaction,
  previous: PersistedTaskState,
  next: PersistedTaskState
): void {
  const nextArtifactIds = new Set(next.artifacts.map((record) => record.id));
  for (const record of previous.artifacts) {
    if (nextArtifactIds.has(record.id)) continue;
    transaction.run(`DELETE FROM artifacts WHERE id = ? AND domain = 'TASK'`, [record.id]);
    transaction.run('DELETE FROM managed_files WHERE id = ?', [artifactManagedFileId(record.id)]);
  }
  const nextAttachmentIds = new Set(next.attachments.map((record) => record.id));
  for (const record of previous.attachments) {
    if (nextAttachmentIds.has(record.id)) continue;
    transaction.run('DELETE FROM task_attachments WHERE id = ?', [record.id]);
    transaction.run('DELETE FROM managed_files WHERE id = ?', [attachmentManagedFileId(record.id)]);
  }
}

export function artifactManagedFileId(artifactId: string): string {
  return `task-artifact:${artifactId}`;
}

export function attachmentManagedFileId(attachmentId: string): string {
  return `task-attachment:${attachmentId}`;
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
