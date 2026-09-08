import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ATTACHMENT_DEFAULT_STORAGE_QUOTA_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  isAttachmentClientToken,
  type AttachmentDraftSnapshot,
  type StageAttachmentBytesInput,
  type StagedAttachmentRecord,
  type TaskAttachmentRecord
} from '../../../shared/attachments';
import { admitAttachment } from '../AttachmentAdmission';
import {
  AttachmentStoreError,
  attachmentIntegrityError,
  attachmentStorageError
} from '../AttachmentErrors';
import type {
  StoredAttachmentContent,
  VerifiedDraftAttachment,
  VerifiedTaskAttachment
} from '../TaskAttachmentStorage';
import { AppDatabase, type AppDatabaseTransaction, type SqlReader } from './AppDatabase';
import { ManagedFileStore, type ManagedFileReference } from './ManagedFileStore';
import { attachmentManagedFileId } from './TaskStateMapper';

const MAX_ACTIVE_DRAFTS = 32;
const MAX_STAGED_BYTES = 100 * 1024 * 1024;

export interface PreparedSqliteAttachmentDraft {
  draft: AttachmentDraftSnapshot;
  taskId: string;
  records: TaskAttachmentRecord[];
  publishedStorageKeys: string[];
}

export interface PreparedSqliteAttachmentAppend extends PreparedSqliteAttachmentDraft {
  existingRecords: TaskAttachmentRecord[];
}

export interface SqliteTaskAttachmentStoreOptions {
  storageQuotaBytes?: number;
  reserveFreeBytes?: number;
  now?: () => Date;
  createId?: () => string;
}

interface StagedRow {
  payload_json: string;
  storage_key: string;
  content_sha256: string;
  byte_count: number | bigint;
}

interface DraftRow {
  id: string;
  created_at: string;
  updated_at: string;
}

interface DraftWithReferences {
  snapshot: AttachmentDraftSnapshot;
  references: Array<{ record: StagedAttachmentRecord; reference: ManagedFileReference }>;
}

/**
 * Stores attachment metadata in SQLite and immutable bytes below the shared
 * managed-file root. Draft rows are authoritative; no manifest file is used.
 */
export class SqliteTaskAttachmentStore {
  private readonly managedFileRoot: string;
  private readonly quota: number;
  private readonly reserveFreeBytes: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly database: AppDatabase,
    private readonly managedFiles: ManagedFileStore,
    options: SqliteTaskAttachmentStoreOptions = {}
  ) {
    this.managedFileRoot = managedFiles.rootPath;
    this.quota = options.storageQuotaBytes ?? ATTACHMENT_DEFAULT_STORAGE_QUOTA_BYTES;
    this.reserveFreeBytes = options.reserveFreeBytes ?? 50 * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  init(): Promise<void> {
    return this.managedFiles.init();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.queue.catch(() => undefined).then(() => undefined);
    return this.closePromise;
  }

  createDraft(): Promise<AttachmentDraftSnapshot> {
    return this.enqueue(async () => {
      const id = this.createId();
      const timestamp = this.timestamp();
      await this.database.write((transaction) => {
        const row = transaction.get<{ count: number | bigint }>(
          'SELECT count(*) AS count FROM attachment_drafts'
        );
        if (Number(row?.count ?? 0) >= MAX_ACTIVE_DRAFTS) {
          throw new AttachmentStoreError(
            'ATTACHMENT_LIMIT_EXCEEDED',
            'Too many unfinished attachment drafts are open.',
            413
          );
        }
        transaction.run(
          `INSERT INTO attachment_drafts (id, created_at, updated_at, payload_json)
           VALUES (?, ?, ?, '{}')`,
          [id, timestamp, timestamp]
        );
      });
      return { id, attachments: [], createdAt: timestamp, updatedAt: timestamp };
    });
  }

  listDraft(draftId: string): Promise<AttachmentDraftSnapshot> {
    return this.enqueue(async () => structuredClone((await this.loadDraft(draftId)).snapshot));
  }

  verifyDraft(draftId: string): Promise<VerifiedDraftAttachment[]> {
    return this.enqueue(async () => {
      const draft = await this.loadDraft(draftId);
      return Promise.all(draft.references.map(async ({ record, reference }) => ({
        record: structuredClone(record),
        absolutePath: await this.managedFiles.resolveVerifiedPath(reference)
      })));
    });
  }

  stageBytes(input: StageAttachmentBytesInput): Promise<StagedAttachmentRecord> {
    return this.enqueue(async () => {
      const clientToken = input.clientToken ?? randomUUID();
      if (!isAttachmentClientToken(clientToken)) {
        throw new AttachmentStoreError('ATTACHMENT_INVALID_REQUEST', 'Attachment retry token is invalid.', 400);
      }
      const before = await this.loadDraft(input.draftId);
      const bytes = Buffer.from(input.bytes);
      const admitted = admitAttachment(input.displayName, bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const retry = before.snapshot.attachments.find((record) => record.clientToken === clientToken);
      if (retry) {
        if (
          retry.displayName !== admitted.displayName ||
          retry.byteCount !== bytes.byteLength ||
          retry.sha256 !== sha256
        ) {
          throw new AttachmentStoreError(
            'ATTACHMENT_CONFLICT',
            'This attachment retry token was already used for different contents.',
            409
          );
        }
        await this.managedFiles.verify(before.references.find(({ record }) => record.id === retry.id)!.reference);
        return structuredClone(retry);
      }
      assertDraftLimits(before.snapshot.attachments, bytes.byteLength);
      await this.ensureCapacity(bytes.byteLength);

      const record: StagedAttachmentRecord = {
        id: this.createId(),
        draftId: input.draftId,
        clientToken,
        ordinal: before.snapshot.attachments.length,
        displayName: admitted.displayName,
        kind: admitted.kind,
        mediaType: admitted.mediaType,
        byteCount: bytes.byteLength,
        sha256,
        createdAt: this.timestamp()
      };
      const storageKey = stagedStorageKey(record);
      const reference = await this.managedFiles.publish(storageKey, bytes);
      try {
        await this.database.write((transaction) => {
          const current = loadDraftFromReader(transaction, input.draftId);
          const concurrentRetry = current.snapshot.attachments.find(
            (candidate) => candidate.clientToken === clientToken
          );
          if (concurrentRetry) {
            if (JSON.stringify(concurrentRetry) !== JSON.stringify(record)) {
              throw new AttachmentStoreError(
                'ATTACHMENT_CONFLICT',
                'This attachment retry token was already used for different contents.',
                409
              );
            }
            return;
          }
          if (current.snapshot.attachments.length !== record.ordinal) {
            throw new AttachmentStoreError(
              'ATTACHMENT_CONFLICT',
              'The attachment draft changed while the file was being staged.',
              409
            );
          }
          assertDraftLimits(current.snapshot.attachments, record.byteCount);
          insertManagedFile(transaction, {
            id: stagedManagedFileId(record.id),
            domain: 'TASK',
            ownerId: record.draftId,
            role: 'STAGED_ATTACHMENT',
            reference,
            mediaType: record.mediaType,
            createdAt: record.createdAt
          });
          transaction.run(
            `INSERT INTO staged_attachments (
               id, draft_id, managed_file_id, client_token, kind, display_name,
               ordinal, created_at, payload_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              record.id, record.draftId, stagedManagedFileId(record.id), clientToken,
              record.kind, record.displayName, record.ordinal, record.createdAt,
              JSON.stringify(record)
            ]
          );
          transaction.run('UPDATE attachment_drafts SET updated_at = ? WHERE id = ?', [record.createdAt, record.draftId]);
          transaction.afterRollbackDeferred(() => this.deleteManagedFiles([storageKey]));
        });
      } catch (error) {
        await this.managedFiles.deleteAfterReferenceCommit(storageKey).catch(() => undefined);
        throw error;
      }
      return structuredClone(record);
    });
  }

  discardDraft(draftId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.database.write((transaction) => {
        const draft = loadDraftFromReader(transaction, draftId);
        transaction.run('DELETE FROM staged_attachments WHERE draft_id = ?', [draftId]);
        transaction.run('DELETE FROM attachment_drafts WHERE id = ?', [draftId]);
        for (const { record } of draft.references) {
          transaction.run('DELETE FROM managed_files WHERE id = ?', [stagedManagedFileId(record.id)]);
        }
        transaction.afterCommitDeferred(() =>
          this.deleteManagedFiles(
            draft.references.map(({ reference }) => reference.storageKey)
          )
        );
      });
    });
  }

  prepareDraftForTask(draftId: string, taskId: string): Promise<PreparedSqliteAttachmentDraft> {
    return this.enqueue(async () => {
      const draft = await this.loadDraft(draftId);
      const records = draft.snapshot.attachments.map<TaskAttachmentRecord>(
        ({ draftId: _draftId, clientToken: _clientToken, ...record }) => ({ ...record, taskId })
      );
      const publishedStorageKeys = await this.publishTaskCopies(draft.references, records);
      return { draft: structuredClone(draft.snapshot), taskId, records, publishedStorageKeys };
    });
  }

  prepareDraftForExistingTask(
    draftId: string,
    taskId: string,
    existingRecords: readonly TaskAttachmentRecord[]
  ): Promise<PreparedSqliteAttachmentAppend> {
    return this.enqueue(async () => {
      const draft = await this.loadDraft(draftId);
      if (draft.snapshot.attachments.length === 0) {
        throw new AttachmentStoreError('ATTACHMENT_INVALID_REQUEST', 'Add at least one reference.', 400);
      }
      const incomingBytes = draft.snapshot.attachments.reduce((sum, record) => sum + record.byteCount, 0);
      assertTaskLimits(existingRecords.length, existingRecords.reduce((sum, record) => sum + record.byteCount, 0), draft.snapshot.attachments.length, incomingBytes);
      await this.verifyTaskRecords(existingRecords);
      const records = draft.snapshot.attachments.map<TaskAttachmentRecord>((staged, index) => ({
        id: this.createId(),
        taskId,
        ordinal: existingRecords.length + index,
        displayName: staged.displayName,
        kind: staged.kind,
        mediaType: staged.mediaType,
        byteCount: staged.byteCount,
        sha256: staged.sha256,
        createdAt: this.timestamp()
      }));
      const publishedStorageKeys = await this.publishTaskCopies(draft.references, records);
      return {
        draft: structuredClone(draft.snapshot),
        taskId,
        existingRecords: structuredClone([...existingRecords]),
        records,
        publishedStorageKeys
      };
    });
  }

  finalizeDraftForTask(receipt: PreparedSqliteAttachmentDraft): Promise<void> {
    return this.discardDraft(receipt.draft.id);
  }

  finalizeDraftForExistingTask(receipt: PreparedSqliteAttachmentAppend): Promise<void> {
    return this.discardDraft(receipt.draft.id);
  }

  rollbackDraftForTask(receipt: PreparedSqliteAttachmentDraft): Promise<void> {
    return this.enqueue(() => this.deleteManagedFiles(receipt.publishedStorageKeys));
  }

  rollbackDraftForExistingTask(receipt: PreparedSqliteAttachmentAppend): Promise<void> {
    return this.enqueue(() => this.deleteManagedFiles(receipt.publishedStorageKeys));
  }

  copyTaskAttachments(
    sourceTaskId: string,
    targetTaskId: string,
    sourceRecords: readonly TaskAttachmentRecord[]
  ): Promise<TaskAttachmentRecord[]> {
    return this.copyTaskAttachmentSelection(sourceTaskId, targetTaskId, sourceRecords);
  }

  copySelectedTaskAttachments(
    sourceTaskId: string,
    targetTaskId: string,
    sourceRecords: readonly TaskAttachmentRecord[]
  ): Promise<TaskAttachmentRecord[]> {
    return this.copyTaskAttachmentSelection(sourceTaskId, targetTaskId, sourceRecords);
  }

  private copyTaskAttachmentSelection(
    sourceTaskId: string,
    targetTaskId: string,
    sourceRecords: readonly TaskAttachmentRecord[]
  ): Promise<TaskAttachmentRecord[]> {
    return this.enqueue(async () => {
      if (sourceRecords.some((record) => record.taskId !== sourceTaskId)) throw attachmentIntegrityError();
      const verified = await this.verifyTaskRecords(sourceRecords);
      const records = sourceRecords.map<TaskAttachmentRecord>((source, ordinal) => ({
        ...source,
        id: this.createId(),
        taskId: targetTaskId,
        ordinal,
        createdAt: this.timestamp()
      }));
      const sources = verified.map((entry) => ({
        record: {
          ...entry.record,
          draftId: 'copy',
          clientToken: undefined
        } as StagedAttachmentRecord,
        reference: taskReference(entry.record)
      }));
      await this.publishTaskCopies(sources, records);
      return records;
    });
  }

  discardTaskFiles(taskId: string, records: readonly TaskAttachmentRecord[] = []): Promise<void> {
    return this.enqueue(() =>
      this.deleteManagedFiles(
        records.filter((record) => record.taskId === taskId).map(taskStorageKey)
      )
    );
  }

  verifyTask(taskId: string, records: readonly TaskAttachmentRecord[]): Promise<VerifiedTaskAttachment[]> {
    if (records.some((record) => record.taskId !== taskId)) return Promise.reject(attachmentIntegrityError());
    return this.enqueue(() => this.verifyTaskRecords(records));
  }

  verifyTaskSelection(taskId: string, records: readonly TaskAttachmentRecord[]): Promise<VerifiedTaskAttachment[]> {
    return this.verifyTask(taskId, records);
  }

  readTask(record: TaskAttachmentRecord): Promise<StoredAttachmentContent> {
    return this.enqueue(async () => content(record, await this.managedFiles.read(taskReference(record), record.byteCount)));
  }

  readDraft(draftId: string, attachmentId: string): Promise<StoredAttachmentContent> {
    return this.enqueue(async () => {
      const draft = await this.loadDraft(draftId);
      const entry = draft.references.find(({ record }) => record.id === attachmentId);
      if (!entry) throw new AttachmentStoreError('ATTACHMENT_NOT_FOUND', 'Attachment not found.', 404);
      return content(entry.record, await this.managedFiles.read(entry.reference, entry.record.byteCount));
    });
  }

  reconcile(
    records: readonly TaskAttachmentRecord[],
    retainedDraftIds: ReadonlySet<string> = new Set()
  ): Promise<{ purgedBlobs: number; purgedDrafts: number }> {
    return this.enqueue(async () => {
      await this.verifyTaskRecords(records);
      const draftIds = await this.database.read((reader) =>
        reader.all<{ id: string }>('SELECT id FROM attachment_drafts ORDER BY created_at, id').map((row) => row.id)
      );
      let purgedBlobs = 0;
      let purgedDrafts = 0;
      for (const draftId of draftIds) {
        if (retainedDraftIds.has(draftId)) {
          const draft = await this.loadDraft(draftId);
          await Promise.all(draft.references.map(({ reference }) => this.managedFiles.verify(reference)));
          continue;
        }
        const draft = await this.loadDraft(draftId);
        purgedBlobs += draft.references.length;
        await this.discardDraftDirect(draft);
        purgedDrafts += 1;
      }
      const referencedKeys = new Set(
        await this.database.read((reader) =>
          reader.all<{ storage_key: string }>(
            `SELECT storage_key FROM managed_files
             WHERE domain = 'TASK' AND role IN ('ATTACHMENT', 'STAGED_ATTACHMENT')`
          ).map((row) => row.storage_key)
        )
      );
      for (const storageKey of await collectAttachmentStorageKeys(this.managedFileRoot)) {
        if (referencedKeys.has(storageKey)) continue;
        await this.managedFiles.deleteAfterReferenceCommit(storageKey);
        purgedBlobs += 1;
      }
      return { purgedBlobs, purgedDrafts };
    });
  }

  private async discardDraftDirect(draft: DraftWithReferences): Promise<void> {
    await this.database.write((transaction) => {
      transaction.run('DELETE FROM staged_attachments WHERE draft_id = ?', [draft.snapshot.id]);
      transaction.run('DELETE FROM attachment_drafts WHERE id = ?', [draft.snapshot.id]);
      for (const { record } of draft.references) {
        transaction.run('DELETE FROM managed_files WHERE id = ?', [stagedManagedFileId(record.id)]);
      }
      transaction.afterCommitDeferred(() =>
        this.deleteManagedFiles(
          draft.references.map(({ reference }) => reference.storageKey)
        )
      );
    });
  }

  private async loadDraft(draftId: string): Promise<DraftWithReferences> {
    return this.database.read((reader) => loadDraftFromReader(reader, draftId));
  }

  private async publishTaskCopies(
    sources: readonly { record: StagedAttachmentRecord; reference: ManagedFileReference }[],
    records: readonly TaskAttachmentRecord[]
  ): Promise<string[]> {
    if (sources.length !== records.length) throw attachmentIntegrityError();
    const published: string[] = [];
    try {
      for (let index = 0; index < records.length; index += 1) {
        const source = sources[index]!;
        const target = records[index]!;
        const bytes = await this.managedFiles.read(source.reference, source.record.byteCount);
        const reference = await this.managedFiles.publish(taskStorageKey(target), bytes);
        if (reference.byteCount !== target.byteCount || reference.sha256 !== target.sha256) {
          throw attachmentIntegrityError();
        }
        published.push(reference.storageKey);
      }
      return published;
    } catch (error) {
      await this.deleteManagedFiles(published);
      throw error;
    }
  }

  private async verifyTaskRecords(records: readonly TaskAttachmentRecord[]): Promise<VerifiedTaskAttachment[]> {
    return Promise.all(records.map(async (record) => ({
      record: structuredClone(record),
      absolutePath: await this.managedFiles.resolveVerifiedPath(taskReference(record))
    })));
  }

  private async ensureCapacity(additionalBytes: number): Promise<void> {
    const used = await this.database.read((reader) => reader.get<{ bytes: number | bigint }>(
      `SELECT coalesce(sum(byte_count), 0) AS bytes
       FROM managed_files
       WHERE domain = 'TASK' AND role IN ('ATTACHMENT', 'STAGED_ATTACHMENT') AND state = 'LIVE'`
    ));
    if (Number(used?.bytes ?? 0) + additionalBytes > this.quota) {
      throw new AttachmentStoreError(
        'ATTACHMENT_STORAGE_QUOTA_EXCEEDED',
        'Attachment storage quota exceeded. Remove old attachments and try again.',
        507
      );
    }
    const staged = await this.database.read((reader) => reader.get<{ bytes: number | bigint }>(
      `SELECT coalesce(sum(mf.byte_count), 0) AS bytes
       FROM staged_attachments sa JOIN managed_files mf ON mf.id = sa.managed_file_id`
    ));
    if (Number(staged?.bytes ?? 0) + additionalBytes > MAX_STAGED_BYTES) {
      throw new AttachmentStoreError(
        'ATTACHMENT_STORAGE_QUOTA_EXCEEDED',
        'Unfinished attachment drafts are using too much space.',
        507
      );
    }
    try {
      const stats = await fs.statfs(this.managedFileRoot);
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (free - additionalBytes < this.reserveFreeBytes) {
        throw new AttachmentStoreError('ATTACHMENT_INSUFFICIENT_SPACE', 'Not enough free disk space for this attachment.', 507);
      }
    } catch (error) {
      if (error instanceof AttachmentStoreError) throw error;
      throw attachmentStorageError();
    }
  }

  private deleteManagedFiles(storageKeys: readonly string[]): Promise<void> {
    return Promise.allSettled(
      storageKeys.map((storageKey) => this.managedFiles.deleteAfterReferenceCommit(storageKey))
    ).then(() => undefined);
  }

  private timestamp(): string {
    const timestamp = this.now().toISOString();
    if (!Number.isFinite(Date.parse(timestamp))) throw attachmentStorageError();
    return timestamp;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Task attachment store is closed.'));
    const result = this.queue.catch(() => undefined).then(async () => {
      await this.init();
      return operation();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function loadDraftFromReader(reader: SqlReader, draftId: string): DraftWithReferences {
  const draft = reader.get<DraftRow>(
    'SELECT id, created_at, updated_at FROM attachment_drafts WHERE id = ?',
    [draftId]
  );
  if (!draft) {
    throw new AttachmentStoreError('ATTACHMENT_DRAFT_NOT_FOUND', 'Attachment draft not found.', 404);
  }
  const rows = reader.all<StagedRow>(
    `SELECT sa.payload_json, mf.storage_key, mf.content_sha256, mf.byte_count
     FROM staged_attachments sa
     JOIN managed_files mf ON mf.id = sa.managed_file_id
     WHERE sa.draft_id = ?
     ORDER BY sa.ordinal, sa.id`,
    [draftId]
  );
  const references = rows.map((row) => {
    const record = JSON.parse(row.payload_json) as StagedAttachmentRecord;
    if (
      record.draftId !== draftId ||
      record.byteCount !== Number(row.byte_count) ||
      record.sha256 !== row.content_sha256 ||
      stagedStorageKey(record) !== row.storage_key
    ) {
      throw attachmentIntegrityError();
    }
    return {
      record,
      reference: {
        storageKey: row.storage_key,
        byteCount: Number(row.byte_count),
        sha256: row.content_sha256
      }
    };
  });
  return {
    snapshot: {
      id: draft.id,
      attachments: references.map(({ record }) => record),
      createdAt: draft.created_at,
      updatedAt: draft.updated_at
    },
    references
  };
}

function insertManagedFile(
  transaction: AppDatabaseTransaction,
  input: {
    id: string;
    domain: string;
    ownerId: string;
    role: string;
    reference: ManagedFileReference;
    mediaType: string;
    createdAt: string;
  }
): void {
  transaction.run(
    `INSERT INTO managed_files (
       id, domain, owner_id, role, storage_key, content_sha256, byte_count,
       media_type, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'LIVE', ?, ?)`,
    [
      input.id, input.domain, input.ownerId, input.role, input.reference.storageKey,
      input.reference.sha256, input.reference.byteCount, input.mediaType,
      input.createdAt, input.createdAt
    ]
  );
}

function assertDraftLimits(records: readonly StagedAttachmentRecord[], additionalBytes: number): void {
  assertTaskLimits(
    0,
    0,
    records.length + 1,
    records.reduce((sum, record) => sum + record.byteCount, 0) + additionalBytes
  );
}

function assertTaskLimits(
  existingCount: number,
  existingBytes: number,
  incomingCount: number,
  incomingBytes: number
): void {
  if (existingCount + incomingCount > ATTACHMENT_MAX_COUNT) {
    throw new AttachmentStoreError(
      'ATTACHMENT_LIMIT_EXCEEDED',
      `A task can have at most ${ATTACHMENT_MAX_COUNT} attachments.`,
      413
    );
  }
  if (existingBytes + incomingBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new AttachmentStoreError(
      'ATTACHMENT_TOTAL_TOO_LARGE',
      'Attachments exceed the per-task size limit.',
      413
    );
  }
}

function stagedStorageKey(record: Pick<StagedAttachmentRecord, 'draftId' | 'id' | 'displayName'>): string {
  return `task/attachments/staging/${record.draftId}/${record.id}${extension(record.displayName)}`;
}

function taskStorageKey(record: Pick<TaskAttachmentRecord, 'taskId' | 'id' | 'displayName'>): string {
  return `task/attachments/tasks/${record.taskId}/${record.id}${extension(record.displayName)}`;
}

function extension(displayName: string): string {
  return path.extname(displayName).toLocaleLowerCase('en-US');
}

function stagedManagedFileId(attachmentId: string): string {
  return `staged-attachment:${attachmentId}`;
}

function taskReference(record: TaskAttachmentRecord): ManagedFileReference {
  return { storageKey: taskStorageKey(record), byteCount: record.byteCount, sha256: record.sha256 };
}

function content(
  record: StagedAttachmentRecord | TaskAttachmentRecord,
  bytes: Uint8Array
): StoredAttachmentContent {
  return {
    attachmentId: record.id,
    displayName: record.displayName,
    kind: record.kind,
    mediaType: record.mediaType,
    byteCount: record.byteCount,
    bytes
  };
}

async function collectAttachmentStorageKeys(managedFileRoot: string): Promise<string[]> {
  const attachmentRoot = path.join(managedFileRoot, 'task', 'attachments');
  const collected: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw attachmentIntegrityError();
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const relative = path.relative(managedFileRoot, absolute);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw attachmentIntegrityError();
      }
      collected.push(relative.split(path.sep).join('/'));
    }
  };
  await visit(attachmentRoot);
  return collected;
}

export { AttachmentStoreError, attachmentManagedFileId };
