import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PreviewExecutionBlocker } from '../../../shared/preview';
import {
  isOwnedByCurrentUser,
  posixModeMatches,
  syncDirectoryIfSupported,
  writePrivateFileAtomically
} from '../../filesystem/secureFilesystem';

export interface PreviewSecretProtector {
  isAvailable(): boolean;
  encrypt(value: Buffer): Promise<Buffer>;
  decrypt(value: Buffer): Promise<Buffer>;
}

interface VaultRevision { id: string; taskId: string; inputId: string; blobName: string; createdAt: string }
interface VaultReference { kind: 'GENERATION' | 'MANAGED_RESOURCE'; ownerRecordId: string; taskId: string; revisionId: string }
interface VaultIndex { formatVersion: 1; current: Record<string, string>; revisions: VaultRevision[]; references: VaultReference[] }

const MAX_VAULT_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_VAULT_BLOB_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INDEX_NAME = 'index.json';
const BACKUP_INDEX_NAME = 'index.backup.json';

export interface PreviewPrivateLease {
  values: Readonly<Record<string, string>>;
  revisions: Readonly<Record<string, string>>;
  release(): Promise<void>;
}

export class PreviewPrivateVault {
  private operation: Promise<unknown> = Promise.resolve();
  private recoveryRequired = false;
  private readonly leases = new Map<string, number>();

  constructor(private readonly root: string, private readonly protector: PreviewSecretProtector) {}

  async set(taskId: string, inputId: string, value: string): Promise<'STORED' | 'PROTECTION_UNAVAILABLE' | 'VAULT_RECOVERY_REQUIRED'> {
    if (!this.protector.isAvailable()) return 'PROTECTION_UNAVAILABLE';
    if (!value || Buffer.byteLength(value, 'utf8') > 8_192 || value.includes('\0')) return 'VAULT_RECOVERY_REQUIRED';
    return this.lock(async () => {
      const index = await this.readIndex();
      if (!index) return 'VAULT_RECOVERY_REQUIRED';
      const plaintext = Buffer.from(value, 'utf8');
      try {
        const encrypted = await this.protector.encrypt(plaintext);
        const id = randomUUID();
        const blobName = `${id}.blob`;
        await this.ensureRoot();
        await writePrivateFileAtomically(path.join(this.root, blobName), encrypted);
        index.revisions.push({ id, taskId, inputId, blobName, createdAt: new Date().toISOString() });
        index.current[key(taskId, inputId)] = id;
        await this.writeIndex(index);
        await this.collect(index);
        return 'STORED';
      } catch {
        this.recoveryRequired = true;
        return 'VAULT_RECOVERY_REQUIRED';
      } finally {
        plaintext.fill(0);
      }
    });
  }

  async remove(taskId: string, inputId: string): Promise<void> {
    await this.lock(async () => {
      const index = await this.readIndex();
      if (!index) return;
      delete index.current[key(taskId, inputId)];
      await this.writeIndex(index);
      await this.collect(index);
    });
  }

  async readiness(taskId: string, inputIds: readonly string[]): Promise<PreviewExecutionBlocker[]> {
    if (!this.protector.isAvailable()) return inputIds.map((inputId) => ({ kind: 'PROTECTION_UNAVAILABLE', inputId }));
    return this.lock(async () => {
      const index = await this.readIndex();
      if (!index || this.recoveryRequired) return inputIds.map((inputId) => ({ kind: 'PRIVATE_INPUT_CORRUPT', inputId }));
      return inputIds.flatMap((inputId): PreviewExecutionBlocker[] =>
        index.current[key(taskId, inputId)] ? [] : [{ kind: 'PRIVATE_INPUT_MISSING', inputId }]
      );
    });
  }

  async acquire(taskId: string, inputIds: readonly string[]): Promise<PreviewPrivateLease | PreviewExecutionBlocker[]> {
    if (!this.protector.isAvailable()) return inputIds.map((inputId) => ({ kind: 'PROTECTION_UNAVAILABLE', inputId }));
    return this.lock(async () => {
      const index = await this.readIndex();
      if (!index || this.recoveryRequired) return inputIds.map((inputId) => ({ kind: 'PRIVATE_INPUT_CORRUPT', inputId }));
      const values: Record<string, string> = {};
      const revisions: Record<string, string> = {};
      const acquired: string[] = [];
      try {
        for (const inputId of inputIds) {
          const revisionId = index.current[key(taskId, inputId)];
          if (!revisionId) { for (const id of acquired) this.releaseLease(id); return [{ kind: 'PRIVATE_INPUT_MISSING', inputId }]; }
          const revision = index.revisions.find((candidate) => candidate.id === revisionId && candidate.taskId === taskId && candidate.inputId === inputId);
          if (!revision) { for (const id of acquired) this.releaseLease(id); return [{ kind: 'PRIVATE_INPUT_CORRUPT', inputId }]; }
          const encrypted = await readProtectedFile(path.join(this.root, revision.blobName), MAX_VAULT_BLOB_BYTES);
          try {
            const plaintext = await this.protector.decrypt(encrypted);
            try { values[inputId] = plaintext.toString('utf8'); } finally { plaintext.fill(0); }
          } finally {
            encrypted.fill(0);
          }
          revisions[inputId] = revisionId;
          this.leases.set(revisionId, (this.leases.get(revisionId) ?? 0) + 1);
          acquired.push(revisionId);
        }
      } catch {
        for (const id of acquired) this.releaseLease(id);
        return inputIds.map((inputId) => ({ kind: 'PRIVATE_INPUT_CORRUPT', inputId }));
      }
      let released = false;
      return {
        values, revisions,
        release: async () => {
          if (released) return;
          released = true;
          await this.lock(async () => {
            for (const id of acquired) this.releaseLease(id);
            const current = await this.readIndex();
            if (current) await this.collect(current);
          });
        }
      };
    });
  }

  async retireTask(taskId: string): Promise<void> {
    await this.lock(async () => {
      const index = await this.readIndex();
      if (!index) return;
      for (const item of index.revisions.filter((revision) => revision.taskId === taskId)) delete index.current[key(item.taskId, item.inputId)];
      index.references = index.references.filter((reference) => reference.taskId !== taskId);
      await this.writeIndex(index).catch(() => undefined);
      await this.collect(index).catch(() => undefined);
    });
  }

  async retainGeneration(generationId: string, taskId: string, revisions: Readonly<Record<string, string>>): Promise<void> {
    await this.lock(async () => {
      const index = await this.readIndex(); if (!index) throw new Error('Private vault recovery is required.');
      for (const revisionId of Object.values(revisions)) {
        if (!index.revisions.some((revision) => revision.id === revisionId && revision.taskId === taskId)) throw new Error('Private revision authority is invalid.');
        if (!index.references.some((reference) => reference.kind === 'GENERATION' && reference.ownerRecordId === generationId && reference.revisionId === revisionId)) index.references.push({ kind: 'GENERATION', ownerRecordId: generationId, taskId, revisionId });
      }
      await this.writeIndex(index);
    });
  }

  async releaseGeneration(generationId: string): Promise<void> {
    await this.lock(async () => {
      const index = await this.readIndex(); if (!index) return;
      index.references = index.references.filter((reference) => !(reference.kind === 'GENERATION' && reference.ownerRecordId === generationId));
      await this.writeIndex(index); await this.collect(index);
    });
  }

  async retryCleanup(): Promise<'CLEAN' | 'CLEANUP_PENDING' | 'RECOVERY_REQUIRED'> {
    return this.lock(async () => {
      const index = await this.readIndex();
      if (!index) return 'RECOVERY_REQUIRED';
      await this.collect(index).catch(() => undefined);
      return await this.deleteUnindexedBlobs(index) ? 'CLEANUP_PENDING' : 'CLEAN';
    });
  }

  async sweep(authority: { taskIds: ReadonlySet<string>; retainedGenerationIds: ReadonlySet<string> }): Promise<'CLEAN' | 'CLEANUP_PENDING' | 'RECOVERY_REQUIRED'> {
    return this.lock(async () => {
      const index = await this.readIndex(); if (!index) return 'RECOVERY_REQUIRED';
      for (const revision of index.revisions) {
        if (!authority.taskIds.has(revision.taskId)) delete index.current[key(revision.taskId, revision.inputId)];
      }
      index.references = index.references.filter((reference) =>
        authority.taskIds.has(reference.taskId) &&
        (reference.kind !== 'GENERATION' || authority.retainedGenerationIds.has(reference.ownerRecordId))
      );
      await this.writeIndex(index); await this.collect(index);
      return await this.deleteUnindexedBlobs(index) ? 'CLEANUP_PENDING' : 'CLEAN';
    });
  }

  async shutdown(): Promise<void> { await this.operation.catch(() => undefined); }

  private releaseLease(id: string): void { const next = (this.leases.get(id) ?? 1) - 1; if (next > 0) this.leases.set(id, next); else this.leases.delete(id); }
  private lock<T>(action: () => Promise<T>): Promise<T> { const next = this.operation.then(action, action); this.operation = next.then(() => undefined, () => undefined); return next; }
  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const handle = await fs.open(
      this.root,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isDirectory() ||
        !isOwnedByCurrentUser(stat) ||
        !posixModeMatches(stat, 0o700)
      ) {
        throw new Error('Unsafe vault root.');
      }
      const [actual, parent] = await Promise.all([
        fs.realpath(this.root),
        fs.realpath(path.dirname(this.root))
      ]);
      if (actual !== path.join(parent, path.basename(this.root))) {
        throw new Error('Unsafe vault root.');
      }
    } finally {
      await handle.close();
    }
  }
  private async readIndex(): Promise<VaultIndex | undefined> {
    if (this.recoveryRequired) return undefined;
    try {
      await this.ensureRoot();
      const primary = await readIndexFile(path.join(this.root, INDEX_NAME));
      if (primary.status === 'READY') {
        const backup = await readIndexFile(path.join(this.root, BACKUP_INDEX_NAME));
        if (backup.status === 'MISSING') {
          await this.writeIndexFile(BACKUP_INDEX_NAME, primary.index);
        } else if (backup.status !== 'READY') {
          throw new Error('Private vault backup index is unsafe or corrupt.');
        }
        return primary.index;
      }
      if (primary.status === 'UNSAFE') {
        throw new Error('Private vault index is unsafe.');
      }

      const backup = await readIndexFile(path.join(this.root, BACKUP_INDEX_NAME));
      if (backup.status === 'READY') {
        await this.writeIndexFile(INDEX_NAME, backup.index);
        return backup.index;
      }
      if (backup.status === 'UNSAFE') {
        throw new Error('Private vault backup index is unsafe.');
      }

      if (primary.status === 'MISSING' && backup.status === 'MISSING') {
        const entries = await fs.readdir(this.root);
        if (entries.length === 0) {
          return { formatVersion: 1, current: {}, revisions: [], references: [] };
        }
      }
      throw new Error('Private vault index recovery is required.');
    } catch {
      this.recoveryRequired = true;
      return undefined;
    }
  }
  private async writeIndex(index: VaultIndex): Promise<void> {
    await this.ensureRoot();
    const current = await readIndexFile(path.join(this.root, INDEX_NAME));
    if (current.status === 'READY') {
      await this.writeIndexFile(BACKUP_INDEX_NAME, current.index);
    } else if (current.status !== 'MISSING') {
      throw new Error('Private vault index is unsafe or corrupt.');
    }
    await this.writeIndexFile(INDEX_NAME, index);
    if (current.status === 'MISSING') {
      await this.writeIndexFile(BACKUP_INDEX_NAME, index);
    }
  }

  private async writeIndexFile(name: string, index: VaultIndex): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(index), 'utf8');
    try {
      await writePrivateFileAtomically(path.join(this.root, name), bytes);
      await syncDirectoryIfSupported(this.root);
    } finally {
      bytes.fill(0);
    }
  }
  private async collect(index: VaultIndex): Promise<boolean> {
    const live = new Set([...Object.values(index.current), ...index.references.map((reference) => reference.revisionId)]);
    const removed = index.revisions.filter((revision) => !live.has(revision.id) && !this.leases.has(revision.id));
    if (!removed.length) return false;
    index.revisions = index.revisions.filter((revision) => !removed.includes(revision));
    await this.writeIndex(index);
    const results = await Promise.allSettled(
      removed.map((revision) => fs.unlink(path.join(this.root, revision.blobName)))
    );
    return results.some((result) => result.status === 'rejected');
  }

  private async deleteUnindexedBlobs(index: VaultIndex): Promise<boolean> {
    const indexed = new Set(index.revisions.map((revision) => revision.blobName));
    const names = await fs.readdir(this.root);
    const results = await Promise.allSettled(
      names
        .filter((name) => name.endsWith('.blob') && UUID_PATTERN.test(name.slice(0, -5)) && !indexed.has(name))
        .map((name) => fs.unlink(path.join(this.root, name)))
    );
    return results.some((result) => result.status === 'rejected');
  }
}

function key(taskId: string, inputId: string): string { return `${taskId}\u0000${inputId}`; }

type IndexReadResult =
  | { status: 'READY'; index: VaultIndex }
  | { status: 'MISSING' | 'CORRUPT' | 'UNSAFE' };

async function readIndexFile(filePath: string): Promise<IndexReadResult> {
  try {
    const bytes = await readProtectedFile(filePath, MAX_VAULT_INDEX_BYTES);
    try {
      return { status: 'READY', index: validateVaultIndex(JSON.parse(bytes.toString('utf8'))) };
    } catch {
      return { status: 'CORRUPT' };
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'MISSING' };
    return { status: 'UNSAFE' };
  }
}

async function readProtectedFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const allocation = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > maximumBytes ||
      !posixModeMatches(stat, 0o600) ||
      !isOwnedByCurrentUser(stat)
    ) {
      throw new Error('Unsafe private vault file.');
    }
    while (offset < allocation.length) {
      const { bytesRead } = await handle.read(allocation, offset, allocation.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw new Error('Private vault file is too large.');
    return Buffer.from(allocation.subarray(0, offset));
  } finally {
    allocation.fill(0);
    await handle.close();
  }
}

function validateVaultIndex(value: unknown): VaultIndex {
  if (!isRecord(value) || value.formatVersion !== 1 || !isRecord(value.current) || !Array.isArray(value.revisions)) {
    throw new Error('Invalid vault index.');
  }
  const referencesValue = value.references ?? [];
  if (!Array.isArray(referencesValue)) throw new Error('Invalid vault index references.');
  const revisions: VaultRevision[] = [];
  const revisionsById = new Map<string, VaultRevision>();
  for (const item of value.revisions) {
    if (
      !isRecord(item) ||
      !isUuid(item.id) ||
      !isOwnerId(item.taskId) ||
      !isOwnerId(item.inputId) ||
      item.blobName !== `${item.id}.blob` ||
      typeof item.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      revisionsById.has(item.id)
    ) {
      throw new Error('Invalid vault revision.');
    }
    const revision: VaultRevision = {
      id: item.id,
      taskId: item.taskId,
      inputId: item.inputId,
      blobName: item.blobName,
      createdAt: item.createdAt
    };
    revisions.push(revision);
    revisionsById.set(revision.id, revision);
  }
  const current: Record<string, string> = {};
  for (const [ownerKey, revisionId] of Object.entries(value.current)) {
    const separator = ownerKey.indexOf('\u0000');
    if (
      separator < 1 ||
      separator !== ownerKey.lastIndexOf('\u0000') ||
      !isOwnerId(ownerKey.slice(0, separator)) ||
      !isOwnerId(ownerKey.slice(separator + 1)) ||
      !isUuid(revisionId)
    ) {
      throw new Error('Invalid vault current pointer.');
    }
    const revision = revisionsById.get(revisionId);
    if (!revision || key(revision.taskId, revision.inputId) !== ownerKey) {
      throw new Error('Vault current pointer does not match its revision owner.');
    }
    current[ownerKey] = revisionId;
  }
  const references: VaultReference[] = [];
  const referenceKeys = new Set<string>();
  for (const item of referencesValue) {
    if (
      !isRecord(item) ||
      (item.kind !== 'GENERATION' && item.kind !== 'MANAGED_RESOURCE') ||
      !isOwnerId(item.ownerRecordId) ||
      !isOwnerId(item.taskId) ||
      !isUuid(item.revisionId)
    ) {
      throw new Error('Invalid vault reference.');
    }
    const revision = revisionsById.get(item.revisionId);
    const referenceKey = `${item.kind}\u0000${item.ownerRecordId}\u0000${item.revisionId}`;
    if (!revision || revision.taskId !== item.taskId || referenceKeys.has(referenceKey)) {
      throw new Error('Vault reference does not match its revision owner.');
    }
    referenceKeys.add(referenceKey);
    references.push({
      kind: item.kind,
      ownerRecordId: item.ownerRecordId,
      taskId: item.taskId,
      revisionId: item.revisionId
    });
  }
  return { formatVersion: 1, current, revisions, references };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isOwnerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\0\r\n]/.test(value);
}
