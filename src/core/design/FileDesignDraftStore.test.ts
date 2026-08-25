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
    const first = await store.save({
      designId,
      expectedRevision: 0,
      body: 'First draft',
      referenceIds: []
    });
    expect(first).toMatchObject({
      designId,
      recordRevision: 1,
      body: 'First draft',
      referenceIds: []
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(root, `${designId}.json`))).mode & 0o777).toBe(0o600);
    }

    await expect(
      store.save({
        designId,
        expectedRevision: 0,
        body: 'Stale draft',
        referenceIds: []
      })
    ).rejects.toThrow('changed before it could be saved');
    const second = await store.save({
      designId,
      expectedRevision: first.recordRevision,
      body: 'Second draft',
      referenceIds: []
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

  it('persists exact reference and attachment ownership without sharing a staged draft', async () => {
    const root = await createRoot();
    const firstDesignId = randomUUID();
    const secondDesignId = randomUUID();
    const referenceId = randomUUID();
    const store = new FileDesignDraftStore(root);
    const first = await store.save({
      designId: firstDesignId,
      expectedRevision: 0,
      body: 'Use this file on the next turn.',
      referenceIds: [referenceId],
      attachmentDraftId: 'attachment-draft-owner-0001'
    });

    expect(await store.list()).toEqual([first]);
    await expect(
      store.save({
        designId: secondDesignId,
        expectedRevision: 0,
        body: 'Try to share the same files.',
        referenceIds: [],
        attachmentDraftId: 'attachment-draft-owner-0001'
      })
    ).rejects.toThrow('already belongs to another Design draft');
    await expect(new FileDesignDraftStore(root).get(firstDesignId)).resolves.toEqual(first);
  });

  it('loads a body-only draft from an older app version with no selected references', async () => {
    const root = await createRoot();
    const designId = randomUUID();
    await fs.writeFile(
      path.join(root, `${designId}.json`),
      `${JSON.stringify({
        designId,
        recordRevision: 1,
        body: 'Older saved thought',
        updatedAt: '2026-08-20T10:00:00.000Z'
      })}\n`,
      { mode: 0o600 }
    );

    await expect(new FileDesignDraftStore(root).get(designId)).resolves.toMatchObject({
      designId,
      body: 'Older saved thought',
      referenceIds: []
    });
  });

  it('rejects stored drafts that claim the same staged files for two Designs', async () => {
    const root = await createRoot();
    const firstDesignId = randomUUID();
    const secondDesignId = randomUUID();
    const store = new FileDesignDraftStore(root);
    const first = await store.save({
      designId: firstDesignId,
      expectedRevision: 0,
      body: 'First owner',
      referenceIds: [],
      attachmentDraftId: 'attachment-draft-shared-0001'
    });
    await fs.writeFile(
      path.join(root, `${secondDesignId}.json`),
      `${JSON.stringify({ ...first, designId: secondDesignId })}\n`,
      { mode: 0o600 }
    );

    await expect(new FileDesignDraftStore(root).list()).rejects.toThrow(
      'belongs to more than one Design draft'
    );
  });
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-draft-'));
  roots.push(root);
  return root;
}
