import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentAdoptionAmbiguousError,
  AttachmentFileStore
} from './AttachmentFileStore';
import { FileTaskStore } from './FileTaskStore';

function createStore(storeDir: string): FileTaskStore {
  return new FileTaskStore(storeDir);
}

describe('FileTaskStore attachments', () => {
  it('creates and reloads a task-owned immutable attachment', async () => {
    const dir = await temporaryDirectory();
    const store = createStore(dir);
    const draft = await store.createAttachmentDraft();
    const staged = await store.stageTaskAttachment({
      draftId: draft.id,
      displayName: 'context.json',
      bytes: bytes('{"scope":"task"}')
    });
    const request = {
      title: 'Use context',
      prompt: 'Read the attached context.',
      repositoryPath: dir,
      creationToken: 'task-create-attachment-reload-0001',
      attachmentDraftId: draft.id
    };
    const task = await store.createTask(request);
    await store.close();

    const reloaded = createStore(dir);
    const retried = await reloaded.createTask(request);
    const snapshot = await reloaded.snapshot();
    expect(retried.id).toBe(task.id);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.attachments).toEqual([
      expect.objectContaining({
        id: staged.id,
        taskId: task.id
      })
    ]);
    expect(
      new TextDecoder().decode((await reloaded.readTaskAttachment(staged.id)).bytes)
    ).toBe('{"scope":"task"}');
  });

  it('keeps task creation idempotent and rejects token reuse for changed input', async () => {
    const dir = await temporaryDirectory();
    const store = createStore(dir);
    const request = {
      title: 'Original task',
      prompt: 'Use the original request.',
      repositoryPath: dir,
      agentSettings: { model: 'codex-test', networkAccess: false },
      creationToken: 'task-create-conflict-token-0001'
    };
    const created = await store.createTask(request);

    await expect(
      store.createTask({
        ...request,
        title: `  ${request.title}  `,
        prompt: ` ${request.prompt} `,
        repositoryPath: `${request.repositoryPath} `,
        completionPolicy: 'LOCAL_ACCEPTANCE'
      })
    ).resolves.toMatchObject({ id: created.id });
    await expect(
      store.createTask({ ...request, prompt: 'A different request.' })
    ).rejects.toMatchObject({
      name: 'TaskCreationRequestError',
      code: 'TASK_CREATION_CONFLICT',
      httpStatus: 409
    });
  });

  it('rejects retired blob storage fields on reload', async () => {
    const dir = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'context.json', '{"scope":"task"}');
    await store.createTask({
      title: 'Use context',
      prompt: 'Read the attached context.',
      repositoryPath: dir,
      attachmentDraftId: draftId
    });
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      attachments: Array<{ storageKey: string }>;
    };
    persisted.attachments[0].storageKey = '../outside';
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, {
      mode: 0o600
    });

    await expect(createStore(dir).snapshot()).rejects.toThrow(
      'attachments contains an invalid record'
    );
  });

  it('leaves the draft retryable when task persistence fails', async () => {
    const dir = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'notes.txt', 'keep me');
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === path.join(dir, 'store.json')) {
        throw new Error('injected persistence failure');
      }
      return originalRename(source, destination);
    });
    try {
      await expect(
        store.createTask({
          title: 'Will fail',
          prompt: 'Do not lose the draft.',
          repositoryPath: dir,
          attachmentDraftId: draftId
        })
      ).rejects.toThrow('injected persistence failure');
    } finally {
      rename.mockRestore();
    }

    await expect(store.listAttachmentDraft(draftId)).resolves.toMatchObject({
      attachments: [expect.objectContaining({ displayName: 'notes.txt' })]
    });
    expect((await store.snapshot()).tasks).toEqual([]);
  });

  it('reports ambiguous adoption when task persistence rollback cannot be proven', async () => {
    const dir = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'notes.txt', 'keep me recoverable');
    const storePath = path.join(dir, 'store.json');
    const draftPath = path.join(dir, 'attachments', 'staging', draftId);
    const tasksRoot = path.join(dir, 'attachments', 'tasks');
    const renameFile = fs.rename.bind(fs);
    let publicationFailureInjected = false;
    let rollbackFailureInjected = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (!publicationFailureInjected && String(destination) === storePath) {
        publicationFailureInjected = true;
        throw new Error('Injected task publication failure.');
      }
      if (
        !rollbackFailureInjected &&
        path.dirname(String(source)) === tasksRoot &&
        String(destination) === draftPath
      ) {
        rollbackFailureInjected = true;
        throw new Error('Injected task attachment rollback failure.');
      }
      await renameFile(source, destination);
    });

    let failure: unknown;
    try {
      failure = await store.createTask({
        title: 'Ambiguous attachment task',
        prompt: 'Do not report this create as retryable.',
        repositoryPath: dir,
        attachmentDraftId: draftId
      }).catch((error: unknown) => error);
    } finally {
      rename.mockRestore();
    }

    expect(publicationFailureInjected).toBe(true);
    expect(rollbackFailureInjected).toBe(true);
    expect(failure).toBeInstanceOf(AttachmentAdoptionAmbiguousError);
    const receipt = (failure as AttachmentAdoptionAmbiguousError).receipt;
    await expect(
      fs.access(path.join(tasksRoot, receipt.taskId))
    ).resolves.toBeUndefined();
    expect((await store.snapshot()).tasks).toEqual([]);
    await store.close();

    const recovery = new AttachmentFileStore(dir);
    await recovery.rollbackDraftForTask(receipt);
    await expect(recovery.listDraft(draftId)).resolves.toMatchObject({ id: draftId });
    await recovery.close();
  });

  it('reconciles a durable task when draft cleanup was interrupted', async () => {
    const dir = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'recovery.md', '# Recover\n');
    const finalize = vi
      .spyOn(AttachmentFileStore.prototype, 'finalizeDraftForTask')
      .mockRejectedValueOnce(new Error('simulated crash before cleanup'));
    const task = await store.createTask({
      title: 'Recover cleanup',
      prompt: 'Use the attachment.',
      repositoryPath: dir,
      attachmentDraftId: draftId
    });
    finalize.mockRestore();
    await expect(store.listAttachmentDraft(draftId)).rejects.toMatchObject({
      code: 'ATTACHMENT_DRAFT_NOT_FOUND'
    });
    await store.close();

    const restarted = createStore(dir);
    await expect(restarted.snapshot()).resolves.toMatchObject({
      tasks: [expect.objectContaining({ id: task.id })],
      attachments: [expect.objectContaining({ taskId: task.id })]
    });
    await expect(restarted.listAttachmentDraft(draftId)).rejects.toMatchObject({
      code: 'ATTACHMENT_DRAFT_NOT_FOUND'
    });
  });

  it('forks attachments into an independent task-owned directory', async () => {
    const dir = await temporaryDirectory();
    const worktreePath = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'context.md', '# Shared context\n');
    const source = await store.createTask({
      title: 'Source',
      prompt: 'Use context.',
      repositoryPath: dir,
      attachmentDraftId: draftId
    });
    const run = await createRun(store, source, worktreePath, 'source');
    const fork = await store.createForkedAlternativeTask({
      title: 'Alternative',
      prompt: source.prompt,
      repositoryPath: source.repositoryPath,
      sourceTaskId: source.id,
      sourceRunId: run.id
    });
    const sourceFiles = (await store.snapshot()).attachments.filter(
      (attachment) => attachment.taskId === source.id
    );
    const forkFiles = (await store.snapshot()).attachments.filter(
      (attachment) => attachment.taskId === fork.id
    );

    expect(forkFiles).toHaveLength(1);
    expect(forkFiles[0].id).not.toBe(sourceFiles[0].id);
    const sourcePath = (await store.verifyTaskAttachments(source.id))[0]!.absolutePath;
    const forkPath = (await store.verifyTaskAttachments(fork.id))[0]!.absolutePath;
    expect(forkPath).not.toBe(sourcePath);
  });

  it('deletes one task directory without affecting a fork copy', async () => {
    const dir = await temporaryDirectory();
    const worktreePath = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'shared.txt', 'shared');
    const source = await store.createTask({
      title: 'Source',
      prompt: 'Use context.',
      repositoryPath: dir,
      attachmentDraftId: draftId
    });
    const run = await createRun(store, source, worktreePath, 'delete');
    const fork = await store.createForkedAlternativeTask({
      title: 'Fork',
      prompt: source.prompt,
      repositoryPath: dir,
      sourceTaskId: source.id,
      sourceRunId: run.id
    });
    const sourcePath = (await store.verifyTaskAttachments(source.id))[0]!.absolutePath;
    const forkPath = (await store.verifyTaskAttachments(fork.id))[0]!.absolutePath;

    await store.deleteTask(source.id);
    await expect(fs.access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(forkPath)).resolves.toBeUndefined();
    await store.deleteTask(fork.id);
    await expect(fs.access(forkPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes task-owned attachment files after durable task deletion', async () => {
    const dir = await temporaryDirectory();
    const worktreePath = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'context.json', '{"delete":true}');
    const task = await store.createTask({
      title: 'Delete run inputs',
      prompt: 'Use context.',
      repositoryPath: dir,
      attachmentDraftId: draftId
    });
    const run = await createRun(store, task, worktreePath, 'run-inputs');
    const [delivery] = await store.prepareRunAttachments(run.id, task.id);

    await store.deleteTask(task.id);
    await expect(fs.access(delivery.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a task-owned attachment is tampered with', async () => {
    const dir = await temporaryDirectory();
    const worktreePath = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'restart.txt', 'authoritative bytes');
    const task = await store.createTask({
      title: 'Restart recovery',
      prompt: 'Use the attachment.',
      repositoryPath: dir,
      attachmentDraftId: draftId
    });
    const run = await createRun(store, task, worktreePath, 'repair');
    const [delivery] = await store.prepareRunAttachments(run.id, task.id);
    if (process.platform !== 'win32') await fs.chmod(delivery.absolutePath, 0o600);
    await fs.writeFile(delivery.absolutePath, 'tampered');
    if (process.platform !== 'win32') await fs.chmod(delivery.absolutePath, 0o400);

    await store.close();
    const restarted = createStore(dir);
    await expect(restarted.reconcileRunAttachments()).rejects.toMatchObject({
      code: 'ATTACHMENT_INTEGRITY_MISMATCH'
    });
  });

  it('preserves durable task records when a referenced attachment is missing at startup', async () => {
    const dir = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'missing.txt', 'authoritative bytes');
    const attachedTask = await store.createTask({
      title: 'Attached task',
      prompt: 'Use the attachment.',
      repositoryPath: dir,
      attachmentDraftId: draftId
    });
    const siblingTask = await store.createTask({
      title: 'Sibling task',
      prompt: 'Remain durable.',
      repositoryPath: dir
    });
    const [delivery] = await store.verifyTaskAttachments(attachedTask.id);
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persistedBeforeRestart = await fs.readFile(storePath, 'utf8');
    await fs.unlink(delivery.absolutePath);

    const restarted = createStore(dir);
    try {
      await expect(restarted.snapshot()).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await restarted.close();
    }

    expect(await fs.readFile(storePath, 'utf8')).toBe(persistedBeforeRestart);
    const persisted = JSON.parse(persistedBeforeRestart) as {
      tasks: Array<{ id: string }>;
      attachments: Array<{ taskId: string }>;
    };
    expect(persisted.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([attachedTask.id, siblingTask.id])
    );
    expect(persisted.attachments).toContainEqual(
      expect.objectContaining({ taskId: attachedTask.id })
    );
  });

  it.runIf(process.platform !== 'win32')('fails closed when a task-owned attachment is writable at restart', async () => {
    const dir = await temporaryDirectory();
    const worktreePath = await temporaryDirectory();
    const store = createStore(dir);
    const { draftId } = await stageText(store, 'restart.txt', 'authoritative bytes');
    const task = await store.createTask({
      title: 'Restart boundary breach',
      prompt: 'Use the attachment.',
      repositoryPath: dir,
      attachmentDraftId: draftId
    });
    const run = await createRun(store, task, worktreePath, 'unsafe');
    const [delivery] = await store.prepareRunAttachments(run.id, task.id);
    await fs.chmod(delivery.absolutePath, 0o600);

    await store.close();
    await expect(createStore(dir).reconcileRunAttachments()).rejects.toMatchObject({
      code: 'ATTACHMENT_INTEGRITY_MISMATCH'
    });
  });

  it('holds store ownership until admitted attachment I/O finishes', async () => {
    const dir = await temporaryDirectory();
    const store = createStore(dir);
    const draft = await store.createAttachmentDraft();
    const linkFile = fs.link.bind(fs);
    let signalLinkStarted!: () => void;
    let releaseLink!: () => void;
    const linkStarted = new Promise<void>((resolve) => { signalLinkStarted = resolve; });
    const linkGate = new Promise<void>((resolve) => { releaseLink = resolve; });
    let delayed = false;
    const link = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      if (
        !delayed &&
        String(destination).startsWith(
          path.join(dir, 'attachments', 'staging', draft.id, path.sep)
        )
      ) {
        delayed = true;
        signalLinkStarted();
        await linkGate;
      }
      await linkFile(source, destination);
    });
    const contender = createStore(dir);

    try {
      const staging = store.stageTaskAttachment({
        draftId: draft.id,
        displayName: 'drain.txt',
        bytes: bytes('finish admitted attachment work')
      });
      await linkStarted;
      const closing = store.close();

      await expect(contender.snapshot()).rejects.toThrow(
        `already owned by process ${process.pid}`
      );
      await expect(store.createAttachmentDraft()).rejects.toThrow('Task store is closed');
      releaseLink();
      await expect(staging).resolves.toMatchObject({ displayName: 'drain.txt' });
      await expect(closing).resolves.toBeUndefined();
      await expect(contender.snapshot()).resolves.toMatchObject({ tasks: [] });
    } finally {
      releaseLink();
      link.mockRestore();
      await store.close();
      await contender.close();
    }
  });

});

async function stageText(
  store: FileTaskStore,
  displayName: string,
  content: string
): Promise<{ draftId: string; attachmentId: string }> {
  const draft = await store.createAttachmentDraft();
  const attachment = await store.stageTaskAttachment({
    draftId: draft.id,
    displayName,
    bytes: bytes(content)
  });
  return { draftId: draft.id, attachmentId: attachment.id };
}

async function createRun(
  store: FileTaskStore,
  task: Awaited<ReturnType<FileTaskStore['createTask']>>,
  worktreePath: string,
  suffix: string
) {
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: `codex/${suffix}`,
    worktreePath,
    baseSha: 'base'
  });
  const session = await store.createAgentSession({
    task,
    iteration,
    worktree,
    runtimeId: 'codex'
  });
  return store.createRun({
    task,
    session,
    mode: 'IMPLEMENTATION',
    prompt: task.prompt
  });
}

function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-store-attachments-'));
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
