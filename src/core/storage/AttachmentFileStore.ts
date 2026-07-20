import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ATTACHMENT_DEFAULT_STORAGE_QUOTA_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  isAttachmentClientToken,
  type AttachmentDraftSnapshot,
  type AttachmentKind,
  type StageAttachmentBytesInput,
  type StagedAttachmentRecord,
  type TaskAttachmentRecord
} from '../../shared/attachments';
import { admitAttachment } from './AttachmentAdmission';
import {
  enforcePosixMode,
  isOwnedByCurrentUser,
  posixModeMatches,
  syncDirectoryIfSupported
} from '../filesystem/secureFilesystem';
import {
  AttachmentStoreError,
  attachmentIntegrityError,
  attachmentStorageError
} from './AttachmentErrors';

export { AttachmentStoreError, type AttachmentStoreErrorCode } from './AttachmentErrors';

export interface VerifiedTaskAttachment {
  record: TaskAttachmentRecord;
  /** Ephemeral core-only path. Never persist or expose this in a snapshot. */
  absolutePath: string;
}

export interface StoredAttachmentContent {
  attachmentId: string;
  displayName: string;
  kind: AttachmentKind;
  mediaType: string;
  byteCount: number;
  bytes: Uint8Array;
}

export interface PreparedAttachmentDraft {
  draft: AttachmentDraftSnapshot;
  taskId: string;
  records: TaskAttachmentRecord[];
}

export class AttachmentAdoptionAmbiguousError extends AggregateError {
  readonly name = 'AttachmentAdoptionAmbiguousError';

  constructor(
    readonly receipt: PreparedAttachmentDraft,
    publicationError: unknown,
    rollbackError: unknown
  ) {
    super(
      [publicationError, rollbackError],
      'Attachment adoption failed and its durable directory ownership could not be proven.'
    );
  }
}

export interface AttachmentFileStoreOptions {
  storageQuotaBytes?: number;
  reserveFreeBytes?: number;
  now?: () => Date;
  createId?: () => string;
}

export interface AttachmentReconciliationResult {
  purgedBlobs: number;
  purgedDrafts: number;
}

interface DraftManifest extends AttachmentDraftSnapshot {
  schemaVersion: 3;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ATOMIC_TEMP_FILE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_DRAFT_MANIFEST_BYTES = 256 * 1024;
const MAX_ACTIVE_DRAFTS = 32;
const MAX_STAGED_BYTES = 100 * 1024 * 1024;

/**
 * Owns one private staging directory per composer submission and one immutable
 * directory per task. There is no global blob pool or run-specific copy.
 */
export class AttachmentFileStore {
  private readonly attachmentsDir: string;
  private readonly stagingDir: string;
  private readonly tasksDir: string;
  private readonly quota: number;
  private readonly reserveFreeBytes: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private initialized = false;
  private initialization?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    baseDir: string,
    options: AttachmentFileStoreOptions = {}
  ) {
    this.attachmentsDir = path.join(baseDir, 'attachments');
    this.stagingDir = path.join(this.attachmentsDir, 'staging');
    this.tasksDir = path.join(this.attachmentsDir, 'tasks');
    this.quota = options.storageQuotaBytes ?? ATTACHMENT_DEFAULT_STORAGE_QUOTA_BYTES;
    this.reserveFreeBytes = options.reserveFreeBytes ?? 50 * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  init(): Promise<void> {
    if (this.closing) return Promise.reject(attachmentStoreClosed());
    return this.ensureInitialized();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const initialization = this.initialization;
    const queue = this.queue;
    this.closePromise = Promise.all([
      initialization?.catch(() => undefined),
      queue.catch(() => undefined)
    ]).then(() => undefined);
    return this.closePromise;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = this.initialize().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
    this.initialized = true;
  }

  createDraft(): Promise<AttachmentDraftSnapshot> {
    return this.enqueue(async () => {
      const entries = await safeDirectoryEntries(this.stagingDir);
      if (entries.length >= MAX_ACTIVE_DRAFTS) {
        throw new AttachmentStoreError(
          'ATTACHMENT_LIMIT_EXCEEDED',
          'Too many unfinished attachment drafts are open.',
          413
        );
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = this.createId();
        assertSafeId(id);
        const directory = this.draftDirectory(id);
        try {
          await fs.mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        try {
          const timestamp = this.timestamp();
          const draft: DraftManifest = {
            schemaVersion: 3,
            id,
            attachments: [],
            createdAt: timestamp,
            updatedAt: timestamp
          };
          await this.writeDraft(draft);
          return publicDraft(draft);
        } catch (error) {
          try {
            await this.removeManagedDirectory(directory, true);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Attachment draft creation failed and its staging directory could not be removed.'
            );
          }
          throw error;
        }
      }
      throw new AttachmentStoreError('ATTACHMENT_CONFLICT', 'Could not create attachment draft.', 409);
    });
  }

  listDraft(draftId: string): Promise<AttachmentDraftSnapshot> {
    return this.enqueue(async () => publicDraft(await this.readDraftManifest(draftId)));
  }

  stageBytes(input: StageAttachmentBytesInput): Promise<StagedAttachmentRecord> {
    return this.enqueue(async () => {
      const clientToken = input.clientToken ?? randomUUID();
      assertClientToken(clientToken);
      const draft = await this.readDraftManifest(input.draftId);
      const bytes = Buffer.from(input.bytes);
      const admitted = admitAttachment(input.displayName, bytes);
      const sha256 = digest(bytes);
      const retry = draft.attachments.find((item) => item.clientToken === clientToken);
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
        await this.readVerified(this.draftFile(draft.id, retry), retry);
        return structuredClone(retry);
      }
      if (draft.attachments.length >= ATTACHMENT_MAX_COUNT) {
        throw new AttachmentStoreError(
          'ATTACHMENT_LIMIT_EXCEEDED',
          `A task can have at most ${ATTACHMENT_MAX_COUNT} attachments.`,
          413
        );
      }
      const total = draft.attachments.reduce((sum, item) => sum + item.byteCount, 0) + bytes.byteLength;
      if (total > ATTACHMENT_MAX_TOTAL_BYTES) {
        throw new AttachmentStoreError(
          'ATTACHMENT_TOTAL_TOO_LARGE',
          'Attachments exceed the per-task size limit.',
          413
        );
      }
      const stagedBytes = await directoryBytes(this.stagingDir);
      if (stagedBytes + bytes.byteLength > MAX_STAGED_BYTES) {
        throw new AttachmentStoreError(
          'ATTACHMENT_STORAGE_QUOTA_EXCEEDED',
          'Unfinished attachment drafts are using too much space.',
          507
        );
      }
      await this.ensureCapacity(bytes.byteLength);
      const id = this.uniqueId(draft.attachments);
      const createdAt = this.timestamp();
      const record: StagedAttachmentRecord = {
        id,
        draftId: draft.id,
        clientToken,
        ordinal: draft.attachments.length,
        displayName: admitted.displayName,
        kind: admitted.kind,
        mediaType: admitted.mediaType,
        byteCount: bytes.byteLength,
        sha256,
        createdAt
      };
      const filePath = this.draftFile(draft.id, record);
      await writeAtomic(filePath, bytes, 0o400, true);
      try {
        await this.writeDraft({
          ...draft,
          attachments: [...draft.attachments, record],
          updatedAt: createdAt
        });
      } catch (error) {
        await unlinkManagedFile(filePath, 0o400).catch(() => undefined);
        throw error;
      }
      return structuredClone(record);
    });
  }

  discardDraft(draftId: string): Promise<void> {
    return this.enqueue(() => this.removeManagedDirectory(this.draftDirectory(draftId), true));
  }

  prepareDraftForTask(draftId: string, taskId: string): Promise<PreparedAttachmentDraft> {
    return this.enqueue(async () => {
      assertSafeId(taskId);
      const draft = await this.readDraftManifest(draftId);
      const records = draft.attachments.map<TaskAttachmentRecord>(({ draftId: _draftId, clientToken: _token, ...item }) => ({
        ...item,
        taskId
      }));
      validateTaskAttachmentRecords(records, taskId);
      await Promise.all(draft.attachments.map((record) => this.readVerified(this.draftFile(draft.id, record), record)));
      const target = this.taskDirectory(taskId);
      if (await exists(target)) {
        throw new AttachmentStoreError('ATTACHMENT_CONFLICT', 'Task attachment storage already exists.', 409);
      }
      const receipt = { draft: publicDraft(draft), taskId, records };
      await fs.rename(this.draftDirectory(draft.id), target);
      try {
        await syncDirectoryIfSupported(this.stagingDir);
        await syncDirectoryIfSupported(this.tasksDir);
      } catch (publicationError) {
        try {
          await this.rollbackDraftForTaskUnlocked(receipt);
        } catch (rollbackError) {
          throw new AttachmentAdoptionAmbiguousError(
            receipt,
            publicationError,
            rollbackError
          );
        }
        throw publicationError;
      }
      return receipt;
    });
  }

  finalizeDraftForTask(receipt: PreparedAttachmentDraft): Promise<void> {
    return this.enqueue(async () => {
      validateTaskAttachmentRecords(receipt.records, receipt.taskId);
      await unlinkManagedFile(this.taskManifest(receipt.taskId), 0o600).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    });
  }

  rollbackDraftForTask(receipt: PreparedAttachmentDraft): Promise<void> {
    return this.enqueue(() => this.rollbackDraftForTaskUnlocked(receipt));
  }

  copyTaskAttachments(
    sourceTaskId: string,
    targetTaskId: string,
    sourceRecords: readonly TaskAttachmentRecord[]
  ): Promise<TaskAttachmentRecord[]> {
    return this.enqueue(async () => {
      if (sourceRecords.length === 0) return [];
      const verified = await this.verifyTaskUnlocked(sourceTaskId, sourceRecords);
      await this.ensureCapacity(
        verified.reduce((total, source) => total + source.record.byteCount, 0)
      );
      assertSafeId(targetTaskId);
      const targetDirectory = this.taskDirectory(targetTaskId);
      await fs.mkdir(targetDirectory, { mode: 0o700 });
      const records: TaskAttachmentRecord[] = [];
      try {
        for (const source of verified) {
          const record: TaskAttachmentRecord = {
            ...source.record,
            id: this.uniqueId(records),
            taskId: targetTaskId,
            ordinal: records.length,
            createdAt: this.timestamp()
          };
          const bytes = await this.readVerified(source.absolutePath, source.record);
          await writeAtomic(this.taskFile(targetTaskId, record), bytes, 0o400, true);
          records.push(record);
        }
        await syncDirectoryIfSupported(targetDirectory);
        return records;
      } catch (error) {
        await this.removeManagedDirectory(targetDirectory, false).catch(() => undefined);
        throw error;
      }
    });
  }

  discardTaskFiles(taskId: string): Promise<void> {
    return this.enqueue(() => this.removeManagedDirectory(this.taskDirectory(taskId), true));
  }

  verifyTask(taskId: string, records: readonly TaskAttachmentRecord[]): Promise<VerifiedTaskAttachment[]> {
    return this.enqueue(() => this.verifyTaskUnlocked(taskId, records));
  }

  readTask(record: TaskAttachmentRecord): Promise<StoredAttachmentContent> {
    return this.enqueue(async () => content(record, await this.readVerified(this.taskFile(record.taskId, record), record)));
  }

  readDraft(draftId: string, attachmentId: string): Promise<StoredAttachmentContent> {
    return this.enqueue(async () => {
      const draft = await this.readDraftManifest(draftId);
      const record = draft.attachments.find((item) => item.id === attachmentId);
      if (!record) throw notFound();
      return content(record, await this.readVerified(this.draftFile(draft.id, record), record));
    });
  }

  reconcile(records: readonly TaskAttachmentRecord[]): Promise<AttachmentReconciliationResult> {
    return this.enqueue(async () => {
      validateGlobalTaskRecords(records);
      let purgedDrafts = 0;
      for (const entry of await safeDirectoryEntries(this.stagingDir)) {
        assertSafeId(entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw attachmentIntegrityError();
        await this.removeManagedDirectory(path.join(this.stagingDir, entry.name), true);
        purgedDrafts += 1;
      }
      const byTask = new Map<string, TaskAttachmentRecord[]>();
      for (const record of records) byTask.set(record.taskId, [...(byTask.get(record.taskId) ?? []), record]);
      let purgedBlobs = 0;
      for (const entry of await safeDirectoryEntries(this.tasksDir)) {
        assertSafeId(entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw attachmentIntegrityError();
        const taskDirectory = path.join(this.tasksDir, entry.name);
        await cleanupAtomicTemporaryFiles(taskDirectory);
        const expected = byTask.get(entry.name);
        if (!expected) {
          await this.removeManagedDirectory(taskDirectory, true);
          purgedBlobs += 1;
          continue;
        }
        await this.verifyTaskUnlocked(entry.name, expected);
        await unlinkManagedFile(this.taskManifest(entry.name), 0o600).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        byTask.delete(entry.name);
      }
      if (byTask.size > 0) throw attachmentIntegrityError();
      return { purgedBlobs, purgedDrafts };
    });
  }

  private async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.attachmentsDir);
    await ensurePrivateDirectory(this.stagingDir);
    await ensurePrivateDirectory(this.tasksDir);
  }

  private async verifyTaskUnlocked(taskId: string, records: readonly TaskAttachmentRecord[]): Promise<VerifiedTaskAttachment[]> {
    validateTaskAttachmentRecords(records, taskId);
    await assertPrivateDirectory(this.taskDirectory(taskId));
    return Promise.all(records.map(async (record) => {
      const absolutePath = this.taskFile(taskId, record);
      await this.readVerified(absolutePath, record);
      return { record: structuredClone(record), absolutePath };
    }));
  }

  private async readDraftManifest(draftId: string): Promise<DraftManifest> {
    assertSafeId(draftId);
    const directory = this.draftDirectory(draftId);
    try {
      await assertPrivateDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw draftNotFound();
      throw error;
    }
    const raw = await readRegularFile(path.join(directory, 'manifest.json'), MAX_DRAFT_MANIFEST_BYTES, 0o600);
    let value: unknown;
    try { value = JSON.parse(raw.toString('utf8')); } catch { throw attachmentIntegrityError(); }
    return validateDraft(value, draftId);
  }

  private async writeDraft(draft: DraftManifest): Promise<void> {
    await writeAtomic(
      path.join(this.draftDirectory(draft.id), 'manifest.json'),
      Buffer.from(`${JSON.stringify(draft, null, 2)}\n`),
      0o600,
      false
    );
  }

  private async rollbackDraftForTaskUnlocked(
    receipt: PreparedAttachmentDraft
  ): Promise<void> {
    validateTaskAttachmentRecords(receipt.records, receipt.taskId);
    assertSafeId(receipt.draft.id);
    const source = this.taskDirectory(receipt.taskId);
    const target = this.draftDirectory(receipt.draft.id);
    const [sourceExists, targetExists] = await Promise.all([
      exists(source),
      exists(target)
    ]);
    if (!sourceExists && targetExists) {
      await syncDirectoryIfSupported(this.tasksDir);
      await syncDirectoryIfSupported(this.stagingDir);
      return;
    }
    if (!sourceExists || targetExists) throw attachmentIntegrityError();
    await fs.rename(source, target);
    await syncDirectoryIfSupported(this.tasksDir);
    await syncDirectoryIfSupported(this.stagingDir);
  }

  private async readVerified(filePath: string, record: Pick<TaskAttachmentRecord, 'byteCount' | 'sha256'>): Promise<Buffer> {
    const bytes = await readRegularFile(filePath, record.byteCount, 0o400);
    if (bytes.byteLength !== record.byteCount || digest(bytes) !== record.sha256) {
      throw attachmentIntegrityError();
    }
    return bytes;
  }

  private async ensureCapacity(additionalBytes: number): Promise<void> {
    const used = await directoryBytes(this.attachmentsDir);
    if (used + additionalBytes > this.quota) {
      throw new AttachmentStoreError('ATTACHMENT_STORAGE_QUOTA_EXCEEDED', 'Attachment storage is full.', 507);
    }
    try {
      const stats = await fs.statfs(this.attachmentsDir);
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (free - additionalBytes < this.reserveFreeBytes) {
        throw new AttachmentStoreError('ATTACHMENT_INSUFFICIENT_SPACE', 'Not enough free disk space for this attachment.', 507);
      }
    } catch (error) {
      if (error instanceof AttachmentStoreError) throw error;
      throw attachmentStorageError();
    }
  }

  private draftDirectory(id: string): string { assertSafeId(id); return path.join(this.stagingDir, id); }
  private taskDirectory(id: string): string { assertSafeId(id); return path.join(this.tasksDir, id); }
  private draftFile(id: string, record: Pick<StagedAttachmentRecord, 'id' | 'displayName'>): string {
    return path.join(this.draftDirectory(id), managedFileName(record));
  }
  private taskFile(id: string, record: Pick<TaskAttachmentRecord, 'id' | 'displayName'>): string {
    return path.join(this.taskDirectory(id), managedFileName(record));
  }
  private taskManifest(id: string): string { return path.join(this.taskDirectory(id), 'manifest.json'); }
  private uniqueId(records: readonly { id: string }[]): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.createId(); assertSafeId(id);
      if (!records.some((record) => record.id === id)) return id;
    }
    throw new AttachmentStoreError('ATTACHMENT_CONFLICT', 'Could not allocate attachment id.', 409);
  }
  private timestamp(): string { const value = this.now().toISOString(); if (!Number.isFinite(Date.parse(value))) throw attachmentStorageError(); return value; }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(attachmentStoreClosed());
    const run = this.queue.catch(() => undefined).then(async () => {
      await this.ensureInitialized();
      return operation();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async removeManagedDirectory(directory: string, allowManifest: boolean): Promise<void> {
    if (!(await exists(directory))) return;
    await assertPrivateDirectory(directory);
    await cleanupAtomicTemporaryFiles(directory);
    for (const entry of await safeDirectoryEntries(directory)) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw attachmentIntegrityError();
      const filePath = path.join(directory, entry.name);
      if (entry.name === 'manifest.json') {
        if (!allowManifest) throw attachmentIntegrityError();
        await unlinkManagedFile(filePath, 0o600);
      } else {
        if (!SAFE_ID.test(path.parse(entry.name).name)) throw attachmentIntegrityError();
        await unlinkManagedFile(filePath, 0o400);
      }
    }
    await fs.rmdir(directory);
    await syncDirectoryIfSupported(path.dirname(directory));
  }
}

export function validateTaskAttachmentRecords(records: readonly TaskAttachmentRecord[], taskId: string): void {
  assertSafeId(taskId);
  if (records.length > ATTACHMENT_MAX_COUNT) throw attachmentIntegrityError();
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  let total = 0;
  for (const record of records) {
    validateRecord(record);
    if (record.taskId !== taskId || ids.has(record.id) || ordinals.has(record.ordinal)) throw attachmentIntegrityError();
    ids.add(record.id); ordinals.add(record.ordinal); total += record.byteCount;
  }
  if (total > ATTACHMENT_MAX_TOTAL_BYTES || [...ordinals].some((ordinal) => ordinal < 0 || ordinal >= records.length)) {
    throw attachmentIntegrityError();
  }
}

function validateGlobalTaskRecords(records: readonly TaskAttachmentRecord[]): void {
  const ids = new Set<string>();
  const byTask = new Map<string, TaskAttachmentRecord[]>();
  for (const record of records) {
    if (ids.has(record.id)) throw attachmentIntegrityError();
    ids.add(record.id);
    byTask.set(record.taskId, [...(byTask.get(record.taskId) ?? []), record]);
  }
  for (const [taskId, taskRecords] of byTask) validateTaskAttachmentRecords(taskRecords, taskId);
}

function validateRecord(record: StagedAttachmentRecord | TaskAttachmentRecord): void {
  if ('storageKey' in record || !SAFE_ID.test(record.id) || !Number.isSafeInteger(record.ordinal) || record.ordinal < 0 ||
      !record.displayName || /[\u0000-\u001f\u007f]/u.test(record.displayName) ||
      (record.kind !== 'image' && record.kind !== 'text') || !record.mediaType ||
      !Number.isSafeInteger(record.byteCount) || record.byteCount <= 0 || !SHA256.test(record.sha256) ||
      !Number.isFinite(Date.parse(record.createdAt))) throw attachmentIntegrityError();
  if ('taskId' in record) assertSafeId(record.taskId);
  if ('draftId' in record) { assertSafeId(record.draftId); if (record.clientToken) assertClientToken(record.clientToken); }
}

function validateDraft(value: unknown, id: string): DraftManifest {
  if (!value || typeof value !== 'object') throw attachmentIntegrityError();
  const draft = value as DraftManifest;
  if (draft.schemaVersion !== 3 || draft.id !== id || !Array.isArray(draft.attachments) ||
      !Number.isFinite(Date.parse(draft.createdAt)) || !Number.isFinite(Date.parse(draft.updatedAt))) throw attachmentIntegrityError();
  for (let ordinal = 0; ordinal < draft.attachments.length; ordinal += 1) {
    const record = draft.attachments[ordinal]!;
    validateRecord(record);
    if (record.draftId !== id || record.ordinal !== ordinal) throw attachmentIntegrityError();
  }
  return structuredClone(draft);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await enforcePosixMode(directory, 0o700);
  await assertPrivateDirectory(directory);
}
async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !posixModeMatches(stat, 0o700)) throw attachmentIntegrityError();
  assertOwner(stat);
}
async function writeAtomic(target: string, bytes: Uint8Array, mode: number, createOnly: boolean): Promise<void> {
  const directory = path.dirname(target);
  await assertPrivateDirectory(directory);
  const temp = path.join(directory, `.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let tempPresent = false;
  let directoryDirty = false;
  let published = false;
  try {
    handle = await fs.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    tempPresent = true;
    directoryDirty = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await enforcePosixMode(handle, mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (createOnly) {
      await fs.link(temp, target);
      published = true;
      await fs.unlink(temp);
      tempPresent = false;
    } else {
      await fs.rename(temp, target);
      published = true;
      tempPresent = false;
    }
    await syncDirectoryIfSupported(directory);
    directoryDirty = false;
  } catch (error) {
    // Publication is already visible and cannot be safely rolled back or
    // reported as retryable without risking duplicate/corrupt state.
    if (!published) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (tempPresent) {
      await fs.unlink(temp).then(
        () => { tempPresent = false; },
        () => undefined
      );
    }
    if (directoryDirty) {
      await syncDirectoryIfSupported(directory).catch(() => undefined);
    }
  }
}

async function cleanupAtomicTemporaryFiles(directory: string): Promise<void> {
  let removed = false;
  for (const entry of await safeDirectoryEntries(directory)) {
    if (!ATOMIC_TEMP_FILE.test(entry.name)) continue;
    const tempPath = path.join(directory, entry.name);
    const stat = await fs.lstat(tempPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !isOwnedByCurrentUser(stat) ||
      (!posixModeMatches(stat, 0o400) && !posixModeMatches(stat, 0o600))
    ) {
      throw attachmentIntegrityError();
    }
    await fs.unlink(tempPath);
    removed = true;
  }
  if (removed) await syncDirectoryIfSupported(directory);
}
async function readRegularFile(filePath: string, maxBytes: number, mode: number): Promise<Buffer> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw attachmentIntegrityError();
  assertOwner(before);
  if (!posixModeMatches(before, mode)) throw attachmentIntegrityError();
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw attachmentIntegrityError();
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function unlinkManagedFile(filePath: string, mode: number): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || !posixModeMatches(stat, mode)) throw attachmentIntegrityError();
  assertOwner(stat); await fs.unlink(filePath); await syncDirectoryIfSupported(path.dirname(filePath));
}
async function safeDirectoryEntries(directory: string) { await assertPrivateDirectory(directory); return fs.readdir(directory, { withFileTypes: true }); }
async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await safeDirectoryEntries(directory)) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw attachmentIntegrityError();
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else if (entry.isFile()) total += (await fs.lstat(entryPath)).size;
    else throw attachmentIntegrityError();
  }
  return total;
}
function assertOwner(stat: { uid: number }): void { if (!isOwnedByCurrentUser(stat)) throw attachmentIntegrityError(); }
function managedFileName(record: Pick<TaskAttachmentRecord, 'id' | 'displayName'>): string { assertSafeId(record.id); return `${record.id}${path.extname(record.displayName).toLocaleLowerCase('en-US')}`; }
function publicDraft(draft: DraftManifest): AttachmentDraftSnapshot { const { schemaVersion: _version, ...snapshot } = draft; return structuredClone(snapshot); }
function content(record: Pick<TaskAttachmentRecord, 'id' | 'displayName' | 'kind' | 'mediaType' | 'byteCount'>, bytes: Uint8Array): StoredAttachmentContent { return { attachmentId: record.id, displayName: record.displayName, kind: record.kind, mediaType: record.mediaType, byteCount: record.byteCount, bytes }; }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function assertSafeId(value: string): void { if (!SAFE_ID.test(value)) throw new AttachmentStoreError('ATTACHMENT_INVALID_REQUEST', 'Attachment identifier is invalid.', 400); }
function assertClientToken(value: string): void { if (!isAttachmentClientToken(value)) throw new AttachmentStoreError('ATTACHMENT_INVALID_REQUEST', 'Attachment retry token is invalid.', 400); }
function notFound(): AttachmentStoreError { return new AttachmentStoreError('ATTACHMENT_NOT_FOUND', 'Attachment not found.', 404); }
function draftNotFound(): AttachmentStoreError { return new AttachmentStoreError('ATTACHMENT_DRAFT_NOT_FOUND', 'Attachment draft not found.', 404); }
function attachmentStoreClosed(): AttachmentStoreError { return new AttachmentStoreError('ATTACHMENT_STORAGE_ERROR', 'Attachment storage is closed.', 409); }
async function exists(filePath: string): Promise<boolean> { try { await fs.lstat(filePath); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
