import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectPrivateImmutableFile,
  ManagedFileIntegrityError,
  ManagedFileStore,
  type ManagedFileReference
} from './ManagedFileStore';

describe('ManagedFileStore', () => {
  let temporaryRoot: string;
  let filesRoot: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-managed-files-'));
    filesRoot = path.join(temporaryRoot, 'files');
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it('publishes immutable bytes with authoritative relative metadata', async () => {
    const store = new ManagedFileStore(filesRoot);
    const bytes = Buffer.from('durable evidence');

    const reference = await store.publish('artifacts/task-1/revision-1.txt', bytes);

    expect(reference).toEqual({
      storageKey: 'artifacts/task-1/revision-1.txt',
      byteCount: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
    await expect(store.read(reference, 1_024)).resolves.toEqual(bytes);
    await expect(store.publish(reference.storageKey, bytes)).resolves.toEqual(reference);
    await expect(
      store.publish(reference.storageKey, Buffer.from('different bytes'))
    ).rejects.toBeInstanceOf(ManagedFileIntegrityError);
  });

  it('preserves the digest while copying a multi-buffer file into backup staging', async () => {
    const store = new ManagedFileStore(filesRoot);
    const bytes = Buffer.alloc(700_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const reference = await store.publish('artifacts/task-1/large.bin', bytes);
    const destination = path.join(temporaryRoot, 'backup', 'large.bin');

    await store.copyVerifiedTo(reference, destination);

    await expect(inspectPrivateImmutableFile(destination)).resolves.toEqual({
      byteCount: reference.byteCount,
      sha256: reference.sha256
    });
    await expect(fs.readFile(destination)).resolves.toEqual(bytes);
  });

  it.each([
    '../outside',
    '/absolute',
    'artifacts/../outside',
    'artifacts\\outside',
    'artifacts//outside',
    '.hidden/file'
  ])('rejects unsafe storage key %s', async (storageKey) => {
    const store = new ManagedFileStore(filesRoot);

    await expect(store.publish(storageKey, Buffer.from('bytes'))).rejects.toBeInstanceOf(
      ManagedFileIntegrityError
    );
  });

  it('reports missing, corrupt, and orphaned files without changing them', async () => {
    const store = new ManagedFileStore(filesRoot);
    const valid = await store.publish('attachments/valid.bin', Buffer.from('valid'));
    const corrupt = await store.publish('attachments/corrupt.bin', Buffer.from('before'));
    const orphan = await store.publish('artifacts/orphan.log', Buffer.from('orphan'));
    const corruptPath = await store.resolveVerifiedPath(corrupt);
    if (process.platform !== 'win32') await fs.chmod(corruptPath, 0o600);
    await fs.writeFile(corruptPath, 'after');
    if (process.platform !== 'win32') await fs.chmod(corruptPath, 0o400);
    const missing = reference('attachments/missing.bin', 'missing');

    const report = await store.inspect([valid, corrupt, missing]);

    expect(report.checkedReferences).toBe(3);
    expect(report.checkedFiles).toBe(3);
    expect(report.issues.map(({ storageKey, kind }) => ({ storageKey, kind }))).toEqual([
      { storageKey: 'artifacts/orphan.log', kind: 'ORPHAN' },
      { storageKey: 'attachments/corrupt.bin', kind: 'CORRUPT' },
      { storageKey: 'attachments/missing.bin', kind: 'MISSING' }
    ]);
    await expect(store.read(orphan, 100)).resolves.toEqual(Buffer.from('orphan'));
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a managed file that was hard-linked outside its ownership root',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-managed-hardlink-'));
      const store = new ManagedFileStore(root);
      const reference = await store.publish('task/artifacts/linked.log', Buffer.from('linked'));
      await fs.link(path.join(root, ...reference.storageKey.split('/')), path.join(root, 'outside-link'));

      await expect(store.verify(reference)).rejects.toThrow('integrity check');
    }
  );

  it('does not physically delete a file while a backup deletion barrier is held', async () => {
    const store = new ManagedFileStore(filesRoot);
    const reference = await store.publish('artifacts/run-1.log', Buffer.from('log'));
    const filePath = await store.resolveVerifiedPath(reference);
    const barrier = await store.beginDeletionBarrier();

    let settled = false;
    const deletion = store.deleteAfterReferenceCommit(reference.storageKey).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    await expect(fs.stat(filePath)).resolves.toBeDefined();
    barrier.release();
    await expect(deletion).resolves.toBe('DELETED');
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets an admitted read finish before deleting its retired immutable revision', async () => {
    const store = new ManagedFileStore(filesRoot);
    const contents = Buffer.from('revision being read');
    const reference = await store.publish('artifacts/run-1-r1.log', contents);
    const filePath = path.join(filesRoot, ...reference.storageKey.split('/'));
    const originalOpen = fs.open.bind(fs);
    let releaseOpen!: () => void;
    const openReleased = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let observeReadOpen!: () => void;
    const readOpenObserved = new Promise<void>((resolve) => {
      observeReadOpen = resolve;
    });
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (candidate, flags, mode) => {
      if (
        candidate === filePath &&
        typeof flags === 'number' &&
        (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR)) === fsConstants.O_RDONLY
      ) {
        observeReadOpen();
        await openReleased;
      }
      return originalOpen(candidate, flags, mode);
    });

    try {
      const read = store.read(reference, contents.byteLength);
      await readOpenObserved;
      const deletion = store.deleteAfterReferenceCommit(reference.storageKey);

      releaseOpen();

      await expect(read).resolves.toEqual(contents);
      await expect(deletion).resolves.toBe('DELETED');
    } finally {
      releaseOpen();
      openSpy.mockRestore();
    }
  });

  it('removes only recognized stale publication temporary files', async () => {
    const now = new Date('2026-08-29T10:00:00.000Z');
    const store = new ManagedFileStore(filesRoot, {
      now: () => now,
      staleTempAgeMs: 60_000
    });
    await fs.mkdir(path.join(filesRoot, 'artifacts'), { recursive: true, mode: 0o700 });
    const stale = path.join(
      filesRoot,
      'artifacts',
      `.evidence.log.task-monki-${randomUUID()}.tmp`
    );
    const unrecognized = path.join(filesRoot, 'artifacts', 'do-not-delete.tmp');
    await fs.writeFile(stale, 'stale', { mode: 0o600 });
    await fs.writeFile(unrecognized, 'unrecognized', { mode: 0o600 });
    const old = new Date(now.getTime() - 120_000);
    await fs.utimes(stale, old, old);
    await fs.utimes(unrecognized, old, old);

    await store.init();

    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(unrecognized)).resolves.toBeDefined();
  });

  it.runIf(process.platform !== 'win32')('rejects a symbolic-link ancestor', async () => {
    const store = new ManagedFileStore(filesRoot);
    await store.init();
    const outside = path.join(temporaryRoot, 'outside');
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, path.join(filesRoot, 'artifacts'));

    await expect(
      store.publish('artifacts/evidence.txt', Buffer.from('unsafe'))
    ).rejects.toBeInstanceOf(ManagedFileIntegrityError);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });
});

function reference(storageKey: string, contents: string): ManagedFileReference {
  const bytes = Buffer.from(contents);
  return {
    storageKey,
    byteCount: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}
