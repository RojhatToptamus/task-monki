import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileDesignDraftStore } from './FileDesignDraftStore';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('FileDesignDraftStore', () => {
  it('persists, replaces, and deletes one private draft with revision checks', async () => {
    const root = await createRoot();
    const designId = randomUUID();
    const store = new FileDesignDraftStore(root);

    await expect(store.get(designId)).resolves.toBeUndefined();
    const first = await store.save({ designId, expectedRevision: 0, body: 'First draft' });
    expect(first).toMatchObject({ designId, recordRevision: 1, body: 'First draft' });
    expect((await fs.stat(path.join(root, `${designId}.json`))).mode & 0o777).toBe(0o600);

    await expect(
      store.save({ designId, expectedRevision: 0, body: 'Stale draft' })
    ).rejects.toThrow('changed before it could be saved');
    const second = await store.save({
      designId,
      expectedRevision: first.recordRevision,
      body: 'Second draft'
    });
    await expect(new FileDesignDraftStore(root).get(designId)).resolves.toEqual(second);

    await expect(
      store.delete({ designId, expectedRevision: first.recordRevision })
    ).rejects.toThrow('changed before it could be deleted');
    await store.delete({ designId, expectedRevision: second.recordRevision });
    await expect(store.get(designId)).resolves.toBeUndefined();
  });

  it('removes an interrupted atomic-write file during initialization', async () => {
    const root = await createRoot();
    const stalePath = path.join(root, `${randomUUID()}.json.123.${randomUUID()}.tmp`);
    await fs.writeFile(stalePath, 'partial', { mode: 0o600 });

    await new FileDesignDraftStore(root).init();

    await expect(fs.stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-draft-'));
  roots.push(root);
  return root;
}
