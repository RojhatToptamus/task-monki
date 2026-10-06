import { createHash, randomUUID } from 'node:crypto';
import { type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRecord } from '../../../shared/contracts';
import {
  ensurePrivateDirectory
} from '../../filesystem/secureFilesystem';
import { ManagedFileStore, type ManagedFileReference } from './ManagedFileStore';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ARTIFACT_REVISION_FILE = new RegExp(
  `^(${UUID.source.slice(1, -1)})-([a-f0-9]{64})\\.log$`,
  'u'
);
/** Owns immutable Task-domain artifact bytes. */

export class SqliteTaskArtifactStore {
  private readonly managedFileRoot: string;
  private readonly artifactRoot: string;

  constructor(private readonly managedFiles: ManagedFileStore) {
    this.managedFileRoot = managedFiles.rootPath;
    this.artifactRoot = path.join(this.managedFileRoot, 'task', 'artifacts');

  }

  async init(): Promise<void> {
    await this.managedFiles.init();
    await ensurePrivateDirectory(this.artifactRoot);
  }

  async publish(artifactId: string, contents: Uint8Array): Promise<ManagedFileReference & { path: string }> {
    assertArtifactId(artifactId);
    const bytes = Buffer.from(contents);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reference = await this.managedFiles.publish(
      artifactStorageKey(artifactId, randomUUID(), sha256),
      bytes
    );
    return { ...reference, path: this.absolutePath(reference.storageKey) };
  }

  reference(record: ArtifactRecord): ManagedFileReference {
    const relative = path.relative(path.resolve(this.managedFileRoot), path.resolve(record.path));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Task artifact escaped the managed-file root.');
    }
    const storageKey = relative.split(path.sep).join('/');
    const match = /^task\/artifacts\/([^/]+)\/(.+)$/u.exec(storageKey);
    const revision = match ? ARTIFACT_REVISION_FILE.exec(match[2]!) : undefined;
    if (!match || !revision || match[1] !== record.id || !UUID.test(match[1])) {
      throw new Error(`Task artifact ${record.id} has an invalid immutable storage key.`);
    }
    if (!Number.isSafeInteger(record.byteCount) || record.byteCount < 0) {
      throw new Error(`Task artifact ${record.id} has an invalid byte count.`);
    }
    return { storageKey, byteCount: record.byteCount, sha256: revision[2]! };
  }

  async verify(record: ArtifactRecord): Promise<void> {
    await this.managedFiles.verify(this.reference(record));
  }

  async read(record: ArtifactRecord, maxBytes: number): Promise<Buffer> {
    return this.managedFiles.read(this.reference(record), maxBytes);
  }

  deleteRevision(record: ArtifactRecord): Promise<'DELETED' | 'MISSING'> {
    return this.managedFiles.deleteAfterReferenceCommit(this.reference(record).storageKey);
  }

  deleteStorageKey(storageKey: string): Promise<'DELETED' | 'MISSING'> {
    const match = /^task\/artifacts\/([^/]+)\/(.+)$/u.exec(storageKey);
    if (!match || !UUID.test(match[1]!) || !ARTIFACT_REVISION_FILE.test(match[2]!)) {
      throw new Error('Task artifact garbage-collection key is invalid.');
    }
    return this.managedFiles.deleteAfterReferenceCommit(storageKey);
  }

  async reconcile(records: readonly ArtifactRecord[]): Promise<void> {
    await this.init();
    const expectedKeys = new Set<string>();
    for (const record of records) {
      const reference = this.reference(record);
      if (expectedKeys.has(reference.storageKey)) {
        throw new Error('Task artifact records contain a duplicate immutable revision.');
      }
      expectedKeys.add(reference.storageKey);
      await this.managedFiles.verify(reference);
    }

    for (const storageKey of await collectStorageKeys(this.artifactRoot, this.managedFileRoot)) {
      if (!expectedKeys.has(storageKey)) {
        await this.managedFiles.deleteAfterReferenceCommit(storageKey);
      }
    }
  }

  private absolutePath(storageKey: string): string {
    return path.join(this.managedFileRoot, ...storageKey.split('/'));
  }
}

function artifactStorageKey(artifactId: string, revisionId: string, sha256: string): string {
  assertArtifactId(artifactId);
  if (!UUID.test(revisionId)) throw new Error('Task artifact revision id is invalid.');
  if (!SHA256.test(sha256)) throw new Error('Task artifact digest is invalid.');
  return `task/artifacts/${artifactId}/${revisionId}-${sha256}.log`;
}

function assertArtifactId(artifactId: string): void {
  if (!UUID.test(artifactId)) throw new Error('Task artifact id is invalid.');
}

async function collectStorageKeys(directory: string, root: string): Promise<string[]> {
  const keys: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readDirectory(current)) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error('Task artifact directory contains an unsafe entry.');
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else {
        if (/^\..+\.task-monki-[0-9a-f-]{36}\.tmp$/u.test(entry.name)) continue;
        const relative = path.relative(root, absolute);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('Task artifact escaped the managed-file root.');
        }
        keys.push(relative.split(path.sep).join('/'));
      }
    }
  };
  await visit(directory);
  return keys;
}

async function readDirectory(directory: string): Promise<Dirent<string>[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
