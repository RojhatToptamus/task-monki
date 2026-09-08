import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedFileStore } from './ManagedFileStore';
import { SqliteTaskArtifactStore } from './SqliteTaskArtifactStore';

describe('SqliteTaskArtifactStore', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
  });

  it('publishes a unique immutable key when artifact contents return to an earlier digest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-artifact-revisions-'));
    roots.push(root);
    const managedFiles = new ManagedFileStore(path.join(root, 'files'));
    const artifacts = new SqliteTaskArtifactStore(managedFiles);
    const artifactId = randomUUID();

    const first = await artifacts.publish(artifactId, Buffer.from('same contents'));
    const second = await artifacts.publish(artifactId, Buffer.from('different contents'));
    const third = await artifacts.publish(artifactId, Buffer.from('same contents'));

    expect(new Set([first.storageKey, second.storageKey, third.storageKey]).size).toBe(3);
    await expect(managedFiles.read(first, 100)).resolves.toEqual(Buffer.from('same contents'));
    await expect(managedFiles.read(third, 100)).resolves.toEqual(Buffer.from('same contents'));
  });
});
