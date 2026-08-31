import { randomUUID } from 'node:crypto';
import type { PreviewExecutionBlocker } from '../../../shared/preview';
import type {
  AppDatabaseTransaction,
  SqlReader,
  SqlRowValue
} from '../../storage/sqlite/AppDatabase';
import { AppDatabase } from '../../storage/sqlite/AppDatabase';
import {
  ManagedFileStore,
  type ManagedFileReference
} from '../../storage/sqlite/ManagedFileStore';

export interface PreviewSecretProtector {
  isAvailable(): boolean;
  encrypt(value: Buffer): Promise<Buffer>;
  decrypt(value: Buffer): Promise<Buffer>;
}

export interface PreviewPrivateLease {
  values: Readonly<Record<string, string>>;
  revisions: Readonly<Record<string, string>>;
  release(): Promise<void>;
}

export interface PreviewPrivateVaultOptions {
  now?: () => string;
  createId?: () => string;
}

const MAX_PRIVATE_VALUE_BYTES = 8_192;
const MAX_ENCRYPTED_VALUE_BYTES = 64 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STORAGE_PREFIX = 'preview-private/';
const MANAGED_DOMAIN = 'PREVIEW';
const MANAGED_ROLE = 'PRIVATE_INPUT';

/**
 * Owns encrypted preview inputs. SQLite owns revision reachability and the
 * immutable managed-file store owns ciphertext bytes; plaintext is never
 * persisted by Task Monki.
 */
export class PreviewPrivateVault {
  private operation: Promise<unknown> = Promise.resolve();
  private cleanup: Promise<void> = Promise.resolve();
  private recoveryRequired = false;
  private readonly leases = new Map<string, number>();
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(
    private readonly database: AppDatabase,
    private readonly managedFiles: ManagedFileStore,
    private readonly protector: PreviewSecretProtector,
    options: PreviewPrivateVaultOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
  }

  async set(
    taskId: string,
    inputId: string,
    value: string
  ): Promise<'STORED' | 'PROTECTION_UNAVAILABLE' | 'VAULT_RECOVERY_REQUIRED'> {
    if (!this.protector.isAvailable()) return 'PROTECTION_UNAVAILABLE';
    if (!isOwnerId(taskId) || !isOwnerId(inputId) || !isPrivateValue(value)) {
      return 'VAULT_RECOVERY_REQUIRED';
    }
    return this.lock(async () => {
      if (this.recoveryRequired) return 'VAULT_RECOVERY_REQUIRED';
      const revisionId = this.nextId('private revision');
      const managedFileId = this.nextId('private managed file');
      const storageKey = `${STORAGE_PREFIX}${revisionId}.blob`;
      const plaintext = Buffer.from(value, 'utf8');
      let encrypted: Buffer | undefined;
      try {
        encrypted = await this.protector.encrypt(plaintext);
        if (encrypted.byteLength > MAX_ENCRYPTED_VALUE_BYTES) {
          throw new Error('Protected preview input exceeds its encrypted size limit.');
        }
        const reference = await this.managedFiles.publish(storageKey, encrypted);
        const createdAt = requireTimestamp(this.now());
        await this.database.write((transaction) => {
          transaction.afterRollbackDeferred(() =>
            this.managedFiles
              .deleteAfterReferenceCommit(reference.storageKey)
              .then(() => undefined, () => undefined)
          );
          insertManagedFile(
            transaction,
            managedFileId,
            taskId,
            reference,
            createdAt
          );
          transaction.run(
            `INSERT INTO preview_private_revisions (
               id, task_id, input_id, managed_file_id, created_at
             ) VALUES (?, ?, ?, ?, ?)`,
            [revisionId, taskId, inputId, managedFileId, createdAt]
          );
          transaction.run(
            `INSERT INTO preview_private_current (task_id, input_id, revision_id)
             VALUES (?, ?, ?)
             ON CONFLICT(task_id, input_id)
             DO UPDATE SET revision_id = excluded.revision_id`,
            [taskId, inputId, revisionId]
          );
          this.markUnreachable(transaction);
          transaction.afterCommitDeferred(() => this.scheduleCleanup());
        });
        return 'STORED';
      } catch {
        this.recoveryRequired = true;
        return 'VAULT_RECOVERY_REQUIRED';
      } finally {
        plaintext.fill(0);
        encrypted?.fill(0);
      }
    });
  }

  async remove(taskId: string, inputId: string): Promise<void> {
    if (!isOwnerId(taskId) || !isOwnerId(inputId)) return;
    await this.lock(async () => {
      await this.database.write((transaction) => {
        transaction.run(
          'DELETE FROM preview_private_current WHERE task_id = ? AND input_id = ?',
          [taskId, inputId]
        );
        this.markUnreachable(transaction);
        transaction.afterCommitDeferred(() => this.scheduleCleanup());
      });
    });
  }

  async readiness(
    taskId: string,
    inputIds: readonly string[]
  ): Promise<PreviewExecutionBlocker[]> {
    if (!this.protector.isAvailable()) {
      return inputIds.map((inputId) => ({ kind: 'PROTECTION_UNAVAILABLE', inputId }));
    }
    return this.lock(async () => {
      if (this.recoveryRequired || !isOwnerId(taskId) || !validInputIds(inputIds)) {
        return corruptBlockers(inputIds);
      }
      try {
        const authorities = await this.readAuthorities(taskId, inputIds);
        const blockers: PreviewExecutionBlocker[] = [];
        for (const inputId of inputIds) {
          const authority = authorities.get(inputId);
          if (!authority) {
            blockers.push({ kind: 'PRIVATE_INPUT_MISSING', inputId });
            continue;
          }
          try {
            await this.managedFiles.verify(authority.reference);
          } catch {
            blockers.push({ kind: 'PRIVATE_INPUT_CORRUPT', inputId });
          }
        }
        return blockers;
      } catch {
        this.recoveryRequired = true;
        return corruptBlockers(inputIds);
      }
    });
  }

  async acquire(
    taskId: string,
    inputIds: readonly string[]
  ): Promise<PreviewPrivateLease | PreviewExecutionBlocker[]> {
    if (!this.protector.isAvailable()) {
      return inputIds.map((inputId) => ({ kind: 'PROTECTION_UNAVAILABLE', inputId }));
    }
    return this.lock(async () => {
      if (this.recoveryRequired || !isOwnerId(taskId) || !validInputIds(inputIds)) {
        return corruptBlockers(inputIds);
      }
      const acquired: string[] = [];
      try {
        const authorities = await this.readAuthorities(taskId, inputIds);
        const missing = inputIds.filter((inputId) => !authorities.has(inputId));
        if (missing.length > 0) {
          return missing.map((inputId) => ({ kind: 'PRIVATE_INPUT_MISSING', inputId }));
        }
        const values: Record<string, string> = {};
        const revisions: Record<string, string> = {};
        for (const inputId of inputIds) {
          const authority = authorities.get(inputId)!;
          const encrypted = await this.managedFiles.read(
            authority.reference,
            MAX_ENCRYPTED_VALUE_BYTES
          );
          try {
            const plaintext = await this.protector.decrypt(encrypted);
            try {
              const value = plaintext.toString('utf8');
              if (!isPrivateValue(value)) throw new Error('Protected preview input is invalid.');
              values[inputId] = value;
            } finally {
              plaintext.fill(0);
            }
          } finally {
            encrypted.fill(0);
          }
          revisions[inputId] = authority.revisionId;
          this.leases.set(
            authority.revisionId,
            (this.leases.get(authority.revisionId) ?? 0) + 1
          );
          acquired.push(authority.revisionId);
        }
        let released = false;
        return {
          values,
          revisions,
          release: async () => {
            if (released) return;
            released = true;
            await this.lock(async () => {
              for (const revisionId of acquired) this.releaseLease(revisionId);
              await this.database.write((transaction) => {
                this.markUnreachable(transaction);
                transaction.afterCommitDeferred(() => this.scheduleCleanup());
              });
            });
          }
        };
      } catch {
        for (const revisionId of acquired) this.releaseLease(revisionId);
        this.recoveryRequired = true;
        return corruptBlockers(inputIds);
      }
    });
  }

  async retireTask(taskId: string): Promise<void> {
    if (!isOwnerId(taskId)) return;
    await this.retireTaskWith(taskId, async () => undefined);
  }

  /**
   * Retires private inputs in the same transaction as another task-owned
   * mutation. The caller must acquire Task serialization before entering.
   */
  retireTaskWith<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    if (!isOwnerId(taskId)) {
      return Promise.reject(new Error('Private input task owner is invalid.'));
    }
    return this.lock(async () => {
      return this.database.write(async (transaction) => {
        transaction.run('DELETE FROM preview_private_current WHERE task_id = ?', [taskId]);
        transaction.run('DELETE FROM preview_private_references WHERE task_id = ?', [taskId]);
        this.markUnreachable(transaction);
        const result = await operation();
        transaction.afterCommitDeferred(() => this.scheduleCleanup());
        return result;
      });
    });
  }

  async retainGeneration(
    generationId: string,
    taskId: string,
    revisions: Readonly<Record<string, string>>
  ): Promise<void> {
    if (!isOwnerId(generationId) || !isOwnerId(taskId)) {
      throw new Error('Private revision authority is invalid.');
    }
    await this.lock(async () => {
      await this.database.write((transaction) => {
        for (const [inputId, revisionId] of Object.entries(revisions)) {
          if (!isOwnerId(inputId) || !isUuid(revisionId)) {
            throw new Error('Private revision authority is invalid.');
          }
          const authority = transaction.get<{ id: SqlRowValue }>(
            `SELECT id FROM preview_private_revisions
             WHERE id = ? AND task_id = ? AND input_id = ?`,
            [revisionId, taskId, inputId]
          );
          if (!authority) throw new Error('Private revision authority is invalid.');
          transaction.run(
            `INSERT INTO preview_private_references (
               owner_kind, owner_record_id, task_id, revision_id, created_at
             ) VALUES ('GENERATION', ?, ?, ?, ?)
             ON CONFLICT(owner_kind, owner_record_id, revision_id) DO NOTHING`,
            [generationId, taskId, revisionId, requireTimestamp(this.now())]
          );
        }
      });
    });
  }

  async releaseGeneration(generationId: string): Promise<void> {
    if (!isOwnerId(generationId)) return;
    await this.lock(async () => {
      await this.database.write((transaction) => {
        transaction.run(
          `DELETE FROM preview_private_references
           WHERE owner_kind = 'GENERATION' AND owner_record_id = ?`,
          [generationId]
        );
        this.markUnreachable(transaction);
        transaction.afterCommitDeferred(() => this.scheduleCleanup());
      });
    });
  }

  async retryCleanup(): Promise<'CLEAN' | 'CLEANUP_PENDING' | 'RECOVERY_REQUIRED'> {
    return this.lock(async () => this.collectAndInspect());
  }

  async sweep(authority: {
    taskIds: ReadonlySet<string>;
    retainedGenerationIds: ReadonlySet<string>;
  }): Promise<'CLEAN' | 'CLEANUP_PENDING' | 'RECOVERY_REQUIRED'> {
    return this.lock(async () => {
      if (this.recoveryRequired) return 'RECOVERY_REQUIRED';
      try {
        await this.database.write((transaction) => {
          const taskRows = transaction.all<{ task_id: SqlRowValue }>(
            `SELECT DISTINCT task_id FROM preview_private_revisions
             UNION SELECT DISTINCT task_id FROM preview_private_current
             UNION SELECT DISTINCT task_id FROM preview_private_references`
          );
          for (const row of taskRows) {
            if (typeof row.task_id !== 'string') {
              throw new Error('Stored private input owner is invalid.');
            }
            if (!authority.taskIds.has(row.task_id)) {
              transaction.run('DELETE FROM preview_private_current WHERE task_id = ?', [row.task_id]);
              transaction.run('DELETE FROM preview_private_references WHERE task_id = ?', [row.task_id]);
            }
          }
          const generations = transaction.all<{ owner_record_id: SqlRowValue }>(
            `SELECT DISTINCT owner_record_id FROM preview_private_references
             WHERE owner_kind = 'GENERATION'`
          );
          for (const row of generations) {
            if (typeof row.owner_record_id !== 'string') {
              throw new Error('Stored private input reference is invalid.');
            }
            if (!authority.retainedGenerationIds.has(row.owner_record_id)) {
              transaction.run(
                `DELETE FROM preview_private_references
                 WHERE owner_kind = 'GENERATION' AND owner_record_id = ?`,
                [row.owner_record_id]
              );
            }
          }
          this.markUnreachable(transaction);
          transaction.afterCommitDeferred(() => this.scheduleCleanup());
        });
        return this.collectAndInspect();
      } catch {
        this.recoveryRequired = true;
        return 'RECOVERY_REQUIRED';
      }
    });
  }

  async shutdown(): Promise<void> {
    await this.operation.catch(() => undefined);
    await this.cleanup.catch(() => undefined);
  }

  private async readAuthorities(
    taskId: string,
    inputIds: readonly string[]
  ): Promise<Map<string, PrivateAuthority>> {
    return this.database.read((reader) => {
      const authorities = new Map<string, PrivateAuthority>();
      for (const inputId of inputIds) {
        const row = reader.get<PrivateAuthorityRow>(
          `SELECT
             current.input_id,
             revision.id AS revision_id,
             managed.storage_key,
             managed.content_sha256,
             managed.byte_count
           FROM preview_private_current AS current
           JOIN preview_private_revisions AS revision
             ON revision.id = current.revision_id
            AND revision.task_id = current.task_id
            AND revision.input_id = current.input_id
           JOIN managed_files AS managed
             ON managed.id = revision.managed_file_id
            AND managed.domain = ?
            AND managed.role = ?
            AND managed.state = 'LIVE'
           WHERE current.task_id = ? AND current.input_id = ?`,
          [MANAGED_DOMAIN, MANAGED_ROLE, taskId, inputId]
        );
        if (row) authorities.set(inputId, decodeAuthority(row, inputId));
      }
      return authorities;
    });
  }

  private markUnreachable(transaction: AppDatabaseTransaction): void {
    const rows = transaction.all<{
      revision_id: SqlRowValue;
      managed_file_id: SqlRowValue;
    }>(
      `SELECT revision.id AS revision_id, revision.managed_file_id
       FROM preview_private_revisions AS revision
       LEFT JOIN preview_private_current AS current
         ON current.revision_id = revision.id
       LEFT JOIN preview_private_references AS reference
         ON reference.revision_id = revision.id
       WHERE current.revision_id IS NULL AND reference.revision_id IS NULL`
    );
    for (const row of rows) {
      if (typeof row.revision_id !== 'string' || typeof row.managed_file_id !== 'string') {
        throw new Error('Stored private input revision is invalid.');
      }
      if (this.leases.has(row.revision_id)) continue;
      transaction.run('DELETE FROM preview_private_revisions WHERE id = ?', [row.revision_id]);
      transaction.run(
        `UPDATE managed_files
         SET state = 'GC_PENDING', record_revision = record_revision + 1, updated_at = ?
         WHERE id = ? AND state = 'LIVE'`,
        [requireTimestamp(this.now()), row.managed_file_id]
      );
    }
  }

  private scheduleCleanup(): Promise<void> {
    const next = this.cleanup.then(
      () => this.cleanupPendingFiles(),
      () => this.cleanupPendingFiles()
    );
    this.cleanup = next.catch(() => undefined);
    return this.cleanup;
  }

  private async cleanupPendingFiles(): Promise<void> {
    const pending = await this.database.read((reader) =>
      reader.all<{ id: SqlRowValue; storage_key: SqlRowValue }>(
        `SELECT id, storage_key FROM managed_files
         WHERE domain = ? AND role = ? AND state = 'GC_PENDING'
         ORDER BY id`,
        [MANAGED_DOMAIN, MANAGED_ROLE]
      )
    );
    for (const row of pending) {
      if (typeof row.id !== 'string' || typeof row.storage_key !== 'string') {
        throw new Error('Stored private managed file is invalid.');
      }
      await this.managedFiles.deleteAfterReferenceCommit(row.storage_key);
      await this.database.write((transaction) => {
        transaction.run(
          `DELETE FROM managed_files
           WHERE id = ? AND state = 'GC_PENDING'
             AND NOT EXISTS (
               SELECT 1 FROM preview_private_revisions
               WHERE managed_file_id = managed_files.id
             )`,
          [row.id]
        );
      });
    }
  }

  private async collectAndInspect(): Promise<'CLEAN' | 'CLEANUP_PENDING' | 'RECOVERY_REQUIRED'> {
    if (this.recoveryRequired) return 'RECOVERY_REQUIRED';
    try {
      await this.database.write((transaction) => {
        this.markUnreachable(transaction);
      });
      await this.cleanupPendingFiles();
      const references = await readLiveManagedReferences(this.database);
      const report = await this.managedFiles.inspect(references);
      let cleanupPending = false;
      for (const issue of report.issues) {
        if (!issue.storageKey.startsWith(STORAGE_PREFIX)) continue;
        if (issue.kind !== 'ORPHAN') {
          this.recoveryRequired = true;
          return 'RECOVERY_REQUIRED';
        }
        try {
          await this.managedFiles.deleteAfterReferenceCommit(issue.storageKey);
        } catch {
          cleanupPending = true;
        }
      }
      return cleanupPending ? 'CLEANUP_PENDING' : 'CLEAN';
    } catch {
      return 'CLEANUP_PENDING';
    }
  }

  private releaseLease(revisionId: string): void {
    const next = (this.leases.get(revisionId) ?? 1) - 1;
    if (next > 0) this.leases.set(revisionId, next);
    else this.leases.delete(revisionId);
  }

  private lock<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action, action);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }

  private nextId(label: string): string {
    const id = this.createId();
    if (!isUuid(id)) throw new Error(`${label} id generator returned an invalid id.`);
    return id;
  }
}

interface PrivateAuthorityRow {
  input_id: SqlRowValue;
  revision_id: SqlRowValue;
  storage_key: SqlRowValue;
  content_sha256: SqlRowValue;
  byte_count: SqlRowValue;
}

interface PrivateAuthority {
  revisionId: string;
  reference: ManagedFileReference;
}

function decodeAuthority(row: PrivateAuthorityRow, expectedInputId: string): PrivateAuthority {
  if (
    row.input_id !== expectedInputId ||
    typeof row.revision_id !== 'string' ||
    !isUuid(row.revision_id) ||
    typeof row.storage_key !== 'string' ||
    !row.storage_key.startsWith(STORAGE_PREFIX) ||
    typeof row.content_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(row.content_sha256) ||
    typeof row.byte_count !== 'number' ||
    !Number.isSafeInteger(row.byte_count) ||
    row.byte_count < 0 ||
    row.byte_count > MAX_ENCRYPTED_VALUE_BYTES
  ) {
    throw new Error('Stored private input authority is invalid.');
  }
  return {
    revisionId: row.revision_id,
    reference: {
      storageKey: row.storage_key,
      sha256: row.content_sha256,
      byteCount: row.byte_count
    }
  };
}

function insertManagedFile(
  transaction: AppDatabaseTransaction,
  id: string,
  taskId: string,
  reference: ManagedFileReference,
  createdAt: string
): void {
  transaction.run(
    `INSERT INTO managed_files (
       id, domain, owner_id, role, storage_key, content_sha256, byte_count,
       media_type, state, record_revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'application/octet-stream', 'LIVE', 0, ?, ?)`,
    [
      id,
      MANAGED_DOMAIN,
      taskId,
      MANAGED_ROLE,
      reference.storageKey,
      reference.sha256,
      reference.byteCount,
      createdAt,
      createdAt
    ]
  );
}

async function readLiveManagedReferences(
  database: AppDatabase
): Promise<ManagedFileReference[]> {
  return database.read((reader: SqlReader) =>
    reader.all<{
      storageKey: string;
      sha256: string;
      byteCount: number;
    }>(
      `SELECT storage_key AS storageKey, content_sha256 AS sha256, byte_count AS byteCount
       FROM managed_files WHERE state = 'LIVE' ORDER BY storage_key`
    )
  );
}

function validInputIds(inputIds: readonly string[]): boolean {
  return (
    Array.isArray(inputIds) &&
    new Set(inputIds).size === inputIds.length &&
    inputIds.every(isOwnerId)
  );
}

function corruptBlockers(inputIds: readonly string[]): PreviewExecutionBlocker[] {
  return inputIds.map((inputId) => ({ kind: 'PRIVATE_INPUT_CORRUPT', inputId }));
}

function isPrivateValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_PRIVATE_VALUE_BYTES &&
    !value.includes('\0')
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isOwnerId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 256 &&
    !/[\0\r\n]/u.test(value)
  );
}

function requireTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error('Preview private vault timestamp is invalid.');
  }
  return value;
}
