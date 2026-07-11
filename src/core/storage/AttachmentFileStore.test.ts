import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentFileStore } from './AttachmentFileStore';

describe('AttachmentFileStore', () => {
  it('atomically adopts a private draft as task-owned immutable files', async () => {
    const root = await temporaryDirectory();
    const store = new AttachmentFileStore(root);
    const draft = await store.createDraft();
    const staged = await store.stageBytes({
      draftId: draft.id,
      clientToken: 'client-token-0001',
      displayName: 'context.txt',
      bytes: Buffer.from('hello')
    });

    const prepared = await store.prepareDraftForTask(draft.id, 'task-one');
    expect(prepared.records[0]).not.toHaveProperty('storageKey');
    const [verified] = await store.verifyTask('task-one', prepared.records);
    expect(verified?.absolutePath).toBe(
      path.join(root, 'attachments', 'tasks', 'task-one', `${staged.id}.txt`)
    );
    expect((await fs.stat(verified!.absolutePath)).mode & 0o777).toBe(0o400);

    await store.finalizeDraftForTask(prepared);
    await expect(
      fs.access(path.join(root, 'attachments', 'tasks', 'task-one', 'manifest.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls an adopted draft back when task persistence fails', async () => {
    const root = await temporaryDirectory();
    const store = new AttachmentFileStore(root);
    const draft = await store.createDraft();
    await store.stageBytes({
      draftId: draft.id,
      clientToken: 'client-token-0002',
      displayName: 'context.json',
      bytes: Buffer.from('{"ok":true}')
    });
    const prepared = await store.prepareDraftForTask(draft.id, 'task-two');

    await store.rollbackDraftForTask(prepared);
    await expect(store.listDraft(draft.id)).resolves.toMatchObject({ id: draft.id });
    await expect(store.verifyTask('task-two', prepared.records)).rejects.toBeTruthy();
  });

  it('copies task-owned files for a fork instead of sharing references', async () => {
    const root = await temporaryDirectory();
    const store = new AttachmentFileStore(root);
    const draft = await store.createDraft();
    await store.stageBytes({
      draftId: draft.id,
      clientToken: 'client-token-0003',
      displayName: 'notes.md',
      bytes: Buffer.from('# notes')
    });
    const source = await store.prepareDraftForTask(draft.id, 'task-source');
    await store.finalizeDraftForTask(source);

    const fork = await store.copyTaskAttachments('task-source', 'task-fork', source.records);
    const [sourceFile] = await store.verifyTask('task-source', source.records);
    const [forkFile] = await store.verifyTask('task-fork', fork);
    expect(forkFile?.absolutePath).not.toBe(sourceFile?.absolutePath);
    expect(await fs.readFile(forkFile!.absolutePath, 'utf8')).toBe('# notes');

    await store.discardTaskFiles('task-source');
    await expect(fs.access(forkFile!.absolutePath)).resolves.toBeUndefined();
  });

  it('rejects writable, replaced, and modified task files', async () => {
    const root = await temporaryDirectory();
    const store = new AttachmentFileStore(root);
    const draft = await store.createDraft();
    await store.stageBytes({
      draftId: draft.id,
      clientToken: 'client-token-0004',
      displayName: 'safe.sql',
      bytes: Buffer.from('select 1;')
    });
    const prepared = await store.prepareDraftForTask(draft.id, 'task-safe');
    await store.finalizeDraftForTask(prepared);
    const [verified] = await store.verifyTask('task-safe', prepared.records);

    await fs.chmod(verified!.absolutePath, 0o600);
    await expect(store.verifyTask('task-safe', prepared.records)).rejects.toMatchObject({
      code: 'ATTACHMENT_INTEGRITY_MISMATCH'
    });
  });

  it('removes abandoned staging and orphan task directories during reconciliation', async () => {
    const root = await temporaryDirectory();
    const store = new AttachmentFileStore(root);
    const draft = await store.createDraft();
    await store.stageBytes({
      draftId: draft.id,
      clientToken: 'client-token-0005',
      displayName: 'abandoned.txt',
      bytes: Buffer.from('unused')
    });
    const orphan = await store.createDraft();
    await store.stageBytes({
      draftId: orphan.id,
      clientToken: 'client-token-0006',
      displayName: 'orphan.txt',
      bytes: Buffer.from('orphan')
    });
    await store.prepareDraftForTask(orphan.id, 'orphan-task');

    await expect(store.reconcile([])).resolves.toEqual({ purgedBlobs: 1, purgedDrafts: 1 });
    expect(await fs.readdir(path.join(root, 'attachments', 'staging'))).toEqual([]);
    expect(await fs.readdir(path.join(root, 'attachments', 'tasks'))).toEqual([]);
  });

  it('reuses a verified task-owned copy when repeating schema-10 migration', async () => {
    const root = await temporaryDirectory();
    const blobRoot = path.join(root, 'attachment-blobs');
    await fs.mkdir(blobRoot, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from('legacy');
    const sha256 = 'c49fea7425fa7f8699897a97c159c6690267d9003bb78c53fafa8fc15c325d84';
    await fs.writeFile(path.join(blobRoot, sha256), bytes, { mode: 0o400 });
    const store = new AttachmentFileStore(root);
    const legacyRecord = {
      id: 'legacy-file',
      taskId: 'legacy-task',
      ordinal: 0,
      displayName: 'legacy.txt',
      kind: 'text',
      mediaType: 'text/plain',
      byteCount: bytes.byteLength,
      sha256,
      storageKey: `attachment-blobs/${sha256}`,
      createdAt: '2026-07-10T00:00:00.000Z'
    } as const;
    const [record] = await store.migrateLegacyRecords([legacyRecord]);

    expect(record).not.toHaveProperty('storageKey');
    await expect(store.verifyTask('legacy-task', [record!])).resolves.toHaveLength(1);
    await expect(fs.access(blobRoot)).resolves.toBeUndefined();

    await fs.rm(blobRoot, { recursive: true });
    await expect(store.migrateLegacyRecords([legacyRecord])).resolves.toEqual([record]);
    await expect(store.verifyTask('legacy-task', [record!])).resolves.toHaveLength(1);

    await store.cleanupLegacyStorage();
    await expect(fs.access(blobRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-attachments-'));
}
