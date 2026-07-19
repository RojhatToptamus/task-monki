import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentAdoptionAmbiguousError,
  AttachmentFileStore
} from './AttachmentFileStore';

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
    const [verified] = await store.verifyTask('task-one', prepared.records);
    expect(verified?.absolutePath).toBe(
      path.join(root, 'attachments', 'tasks', 'task-one', `${staged.id}.txt`)
    );
    if (process.platform !== 'win32') {
      expect((await fs.stat(verified!.absolutePath)).mode & 0o777).toBe(0o400);
    }

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

  it('applies the attachment storage quota before copying a fork', async () => {
    const root = await temporaryDirectory();
    const sourceStore = new AttachmentFileStore(root);
    const draft = await sourceStore.createDraft();
    await sourceStore.stageBytes({
      draftId: draft.id,
      clientToken: 'client-token-quota-copy-0001',
      displayName: 'bounded.txt',
      bytes: Buffer.from('bounded')
    });
    const source = await sourceStore.prepareDraftForTask(draft.id, 'quota-source');
    await sourceStore.finalizeDraftForTask(source);
    const attachmentsDirectory = path.join(root, 'attachments');
    const constrainedStore = new AttachmentFileStore(root, {
      storageQuotaBytes: await directoryByteCount(attachmentsDirectory),
      reserveFreeBytes: 0
    });

    await expect(
      constrainedStore.copyTaskAttachments(
        'quota-source',
        'quota-fork',
        source.records
      )
    ).rejects.toMatchObject({ code: 'ATTACHMENT_STORAGE_QUOTA_EXCEEDED' });
    await expect(
      fs.access(path.join(attachmentsDirectory, 'tasks', 'quota-fork'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform !== 'win32')('rejects writable task files', async () => {
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

  it('drains admitted work while rejecting operations after close begins', async () => {
    const root = await temporaryDirectory();
    const store = new AttachmentFileStore(root);
    const draft = await store.createDraft();
    await store.stageBytes({
      draftId: draft.id,
      clientToken: 'client-token-close-0001',
      displayName: 'closing.txt',
      bytes: Buffer.from('finish admitted work')
    });

    const source = path.join(root, 'attachments', 'staging', draft.id);
    let signalRenameStarted!: () => void;
    let releaseRename!: () => void;
    const renameStarted = new Promise<void>((resolve) => { signalRenameStarted = resolve; });
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    const rename = fs.rename.bind(fs);
    let delayed = false;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!delayed && from === source) {
        delayed = true;
        signalRenameStarted();
        await renameGate;
      }
      await rename(from, to);
    });

    try {
      const adoption = store.prepareDraftForTask(draft.id, 'closing-task');
      await renameStarted;
      const queued = store.discardTaskFiles('unused-task');
      const closing = store.close();

      expect(store.close()).toBe(closing);
      let closeFinished = false;
      void closing.then(() => { closeFinished = true; });
      await Promise.resolve();
      expect(closeFinished).toBe(false);
      await expect(store.createDraft()).rejects.toMatchObject({
        code: 'ATTACHMENT_STORAGE_ERROR',
        message: 'Attachment storage is closed.'
      });
      await expect(store.init()).rejects.toMatchObject({
        code: 'ATTACHMENT_STORAGE_ERROR',
        message: 'Attachment storage is closed.'
      });

      releaseRename();
      await expect(adoption).resolves.toMatchObject({ taskId: 'closing-task' });
      await expect(queued).resolves.toBeUndefined();
      await expect(closing).resolves.toBeUndefined();
      await expect(store.discardTaskFiles('closing-task')).rejects.toMatchObject({
        code: 'ATTACHMENT_STORAGE_ERROR',
        message: 'Attachment storage is closed.'
      });
    } finally {
      releaseRename();
      renameSpy.mockRestore();
    }
  });

  it('removes an unpublished temporary file after a staged write fails', async () => {
    const root = await temporaryDirectory();
    const store = new AttachmentFileStore(root);
    const draft = await store.createDraft();
    const draftDirectory = path.join(root, 'attachments', 'staging', draft.id);
    const openFile = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (!injected && path.basename(String(args[0])).startsWith('.tmp-')) {
        injected = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          new Error('Injected attachment flush failure.')
        );
      }
      return handle;
    });

    try {
      await expect(
        store.stageBytes({
          draftId: draft.id,
          clientToken: 'client-token-failed-write-0001',
          displayName: 'failed.txt',
          bytes: Buffer.from('must not leave temporary state')
        })
      ).rejects.toThrow('Injected attachment flush failure.');
    } finally {
      open.mockRestore();
    }

    expect(injected).toBe(true);
    expect(await fs.readdir(draftDirectory)).toEqual(['manifest.json']);
    await expect(store.discardDraft(draft.id)).resolves.toBeUndefined();
  });

  it('removes a new draft directory when its manifest cannot be published', async () => {
    const root = await temporaryDirectory();
    const draftId = 'draft-create-failure-0001';
    const store = new AttachmentFileStore(root, { createId: () => draftId });
    const draftDirectory = path.join(root, 'attachments', 'staging', draftId);
    const openFile = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (
        !injected &&
        path.dirname(String(args[0])) === draftDirectory &&
        path.basename(String(args[0])).startsWith('.tmp-')
      ) {
        injected = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          new Error('Injected draft manifest flush failure.')
        );
      }
      return handle;
    });

    try {
      await expect(store.createDraft()).rejects.toThrow(
        'Injected draft manifest flush failure.'
      );
    } finally {
      open.mockRestore();
    }

    expect(injected).toBe(true);
    await expect(fs.access(draftDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.join(root, 'attachments', 'staging'))).toEqual([]);
    await store.close();
  });

  it.runIf(process.platform !== 'win32')(
    'rolls adoption back when either parent-directory sync fails',
    async () => {
      for (const parent of ['staging', 'tasks'] as const) {
        const root = await temporaryDirectory();
        const store = new AttachmentFileStore(root);
        const draft = await store.createDraft();
        await store.stageBytes({
          draftId: draft.id,
          clientToken: `client-token-adoption-${parent}`,
          displayName: 'adopted.txt',
          bytes: Buffer.from(`adopted through ${parent}`)
        });
        const syncDirectory = path.join(root, 'attachments', parent);
        const openFile = fs.open.bind(fs);
        let injected = false;
        const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await openFile(...args);
          if (!injected && String(args[0]) === syncDirectory) {
            injected = true;
            vi.spyOn(handle, 'sync').mockRejectedValueOnce(
              new Error(`Injected ${parent} directory flush failure.`)
            );
          }
          return handle;
        });

        try {
          await expect(
            store.prepareDraftForTask(draft.id, `adopted-task-${parent}`)
          ).rejects.toThrow(`Injected ${parent} directory flush failure.`);
        } finally {
          open.mockRestore();
        }

        expect(injected).toBe(true);
        await expect(
          store.listDraft(draft.id)
        ).resolves.toMatchObject({ id: draft.id });
        await expect(
          fs.access(
            path.join(root, 'attachments', 'tasks', `adopted-task-${parent}`)
          )
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await store.close();
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'reports ambiguous adoption when a failed directory sync cannot be rolled back',
    async () => {
      const root = await temporaryDirectory();
      const store = new AttachmentFileStore(root);
      const draft = await store.createDraft();
      await store.stageBytes({
        draftId: draft.id,
        clientToken: 'client-token-ambiguous-adoption',
        displayName: 'ambiguous.txt',
        bytes: Buffer.from('preserve ambiguous ownership')
      });
      const taskId = 'ambiguous-adoption-task';
      const stagingDirectory = path.join(root, 'attachments', 'staging');
      const source = path.join(stagingDirectory, draft.id);
      const target = path.join(root, 'attachments', 'tasks', taskId);
      const openFile = fs.open.bind(fs);
      const renameFile = fs.rename.bind(fs);
      let syncFailureInjected = false;
      let rollbackFailureInjected = false;
      const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await openFile(...args);
        if (!syncFailureInjected && String(args[0]) === stagingDirectory) {
          syncFailureInjected = true;
          vi.spyOn(handle, 'sync').mockRejectedValueOnce(
            new Error('Injected adoption publication failure.')
          );
        }
        return handle;
      });
      const rename = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
        if (
          !rollbackFailureInjected &&
          String(args[0]) === target &&
          String(args[1]) === source
        ) {
          rollbackFailureInjected = true;
          throw new Error('Injected adoption rollback failure.');
        }
        await renameFile(...args);
      });

      let failure: unknown;
      try {
        failure = await store.prepareDraftForTask(draft.id, taskId).catch(
          (error: unknown) => error
        );
      } finally {
        rename.mockRestore();
        open.mockRestore();
      }

      expect(syncFailureInjected).toBe(true);
      expect(rollbackFailureInjected).toBe(true);
      expect(failure).toBeInstanceOf(AttachmentAdoptionAmbiguousError);
      expect(failure).toMatchObject({ receipt: { taskId } });
      const receipt = (failure as AttachmentAdoptionAmbiguousError).receipt;
      await expect(store.verifyTask(taskId, receipt.records)).resolves.toHaveLength(1);
      await store.rollbackDraftForTask(receipt);
      await expect(store.listDraft(draft.id)).resolves.toMatchObject({ id: draft.id });
      await store.close();
    }
  );

  it.runIf(process.platform !== 'win32')(
    'does not report a published attachment manifest as retryable when directory sync fails',
    async () => {
      const root = await temporaryDirectory();
      const store = new AttachmentFileStore(root);
      const draft = await store.createDraft();
      const draftDirectory = path.join(root, 'attachments', 'staging', draft.id);
      const openFile = fs.open.bind(fs);
      let directoryOpenCount = 0;
      const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await openFile(...args);
        if (String(args[0]) === draftDirectory) {
          directoryOpenCount += 1;
          if (directoryOpenCount === 2) {
            vi.spyOn(handle, 'sync').mockRejectedValueOnce(
              new Error('Injected attachment directory flush failure.')
            );
          }
        }
        return handle;
      });

      try {
        await expect(
          store.stageBytes({
            draftId: draft.id,
            clientToken: 'client-token-published-write-0001',
            displayName: 'published.txt',
            bytes: Buffer.from('published once')
          })
        ).resolves.toMatchObject({ displayName: 'published.txt' });
      } finally {
        open.mockRestore();
      }

      expect(directoryOpenCount).toBe(3);
      await expect(store.listDraft(draft.id)).resolves.toMatchObject({
        attachments: [expect.objectContaining({ displayName: 'published.txt' })]
      });
      const prepared = await store.prepareDraftForTask(draft.id, 'published-task');
      await expect(
        store.verifyTask('published-task', prepared.records)
      ).resolves.toHaveLength(1);
    }
  );

  it('removes a crash-left atomic temporary file during reconciliation', async () => {
    const root = await temporaryDirectory();
    const store = new AttachmentFileStore(root);
    const draft = await store.createDraft();
    await store.stageBytes({
      draftId: draft.id,
      clientToken: 'client-token-crash-temp-0001',
      displayName: 'durable.txt',
      bytes: Buffer.from('durable attachment')
    });
    const prepared = await store.prepareDraftForTask(draft.id, 'durable-task');
    await store.finalizeDraftForTask(prepared);
    const taskDirectory = path.dirname(
      (await store.verifyTask('durable-task', prepared.records))[0]!.absolutePath
    );
    const temporaryPath = path.join(
      taskDirectory,
      '.tmp-00000000-0000-4000-8000-000000000001'
    );
    await fs.writeFile(temporaryPath, 'abandoned', { mode: 0o600 });

    await expect(store.reconcile(prepared.records)).resolves.toEqual({
      purgedBlobs: 0,
      purgedDrafts: 0
    });
    await expect(fs.access(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

});

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-attachments-'));
}

async function directoryByteCount(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    total += entry.isDirectory()
      ? await directoryByteCount(entryPath)
      : (await fs.stat(entryPath)).size;
  }
  return total;
}
