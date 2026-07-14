import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION } from '../../shared/contracts';
import { AttachmentFileStore } from './AttachmentFileStore';
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

  it('rejects forged legacy blob keys on reload', async () => {
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

    await expect(createStore(dir).snapshot()).rejects.toMatchObject({
      code: 'ATTACHMENT_INTEGRITY_MISMATCH'
    });
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

    const restarted = createStore(dir);
    await expect(restarted.reconcileRunAttachments()).rejects.toMatchObject({
      code: 'ATTACHMENT_INTEGRITY_MISMATCH'
    });
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

    await expect(createStore(dir).reconcileRunAttachments()).rejects.toMatchObject({
      code: 'ATTACHMENT_INTEGRITY_MISMATCH'
    });
  });

  it('migrates schema 9 by adding an empty attachment collection', async () => {
    const dir = await temporaryDirectory();
    const store = createStore(dir);
    await store.createTask({ title: 'Legacy', prompt: 'Keep me.', repositoryPath: dir });
    await store.close();
    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as Record<string, unknown>;
    delete persisted.attachments;
    persisted.schemaVersion = 9;
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });

    const migrated = await createStore(dir).snapshot();
    expect(migrated.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(migrated.attachments).toEqual([]);
  });

  it('migrates schema 10 blobs into path-free task-owned storage', async () => {
    const fixture = await createSchema10AttachmentFixture();

    const migrated = createStore(fixture.dir);
    const snapshot = await migrated.snapshot();
    expect(snapshot.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(snapshot.attachments[0]).not.toHaveProperty('storageKey');
    expect(
      new TextDecoder().decode(
        (await migrated.readTaskAttachment(fixture.attachmentId)).bytes
      )
    ).toBe('legacy bytes');
    await expect(fs.access(fixture.blobRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers and repeats schema 10 migration after snapshot publication is interrupted', async () => {
    const fixture = await createSchema10AttachmentFixture();
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === fixture.storePath) {
        throw new Error('injected migration publication failure');
      }
      return originalRename(source, destination);
    });

    try {
      await expect(createStore(fixture.dir).snapshot()).rejects.toThrow(
        'injected migration publication failure'
      );
    } finally {
      rename.mockRestore();
    }

    const interrupted = JSON.parse(await fs.readFile(fixture.storePath, 'utf8')) as {
      schemaVersion: number;
      attachments: Array<{ storageKey?: string }>;
    };
    expect(interrupted.schemaVersion).toBe(10);
    expect(interrupted.attachments[0]).toHaveProperty('storageKey');
    await expect(fs.access(fixture.taskOwnedPath)).resolves.toBeUndefined();
    await expect(fs.access(fixture.blobPath)).resolves.toBeUndefined();

    // Simulate the old interrupted ordering, where cleanup removed the source
    // blob before the schema-11 snapshot was published.
    await fs.rm(fixture.blobRoot, { recursive: true });

    const restarted = createStore(fixture.dir);
    const restartedSnapshot = await restarted.snapshot();
    expect(restartedSnapshot.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(restartedSnapshot.attachments[0]).not.toHaveProperty('storageKey');
    expect(
      new TextDecoder().decode(
        (await restarted.readTaskAttachment(fixture.attachmentId)).bytes
      )
    ).toBe('legacy bytes');
    await expect(fs.access(fixture.blobRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.close();

    const repeated = createStore(fixture.dir);
    const repeatedSnapshot = await repeated.snapshot();
    expect(repeatedSnapshot.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(repeatedSnapshot.attachments[0]).not.toHaveProperty('storageKey');
    expect(
      new TextDecoder().decode(
        (await repeated.readTaskAttachment(fixture.attachmentId)).bytes
      )
    ).toBe('legacy bytes');
  });
});

async function createSchema10AttachmentFixture(): Promise<{
  dir: string;
  storePath: string;
  blobRoot: string;
  blobPath: string;
  taskOwnedPath: string;
  attachmentId: string;
}> {
  const dir = await temporaryDirectory();
  const store = createStore(dir);
  const { draftId } = await stageText(store, 'legacy.txt', 'legacy bytes');
  const task = await store.createTask({
    title: 'Legacy attachments',
    prompt: 'Use the attachment.',
    repositoryPath: dir,
    attachmentDraftId: draftId
  });
  const [verified] = await store.verifyTaskAttachments(task.id);
  await store.close();

  const blobRoot = path.join(dir, 'attachment-blobs');
  await fs.mkdir(blobRoot, { mode: 0o700 });
  const blobPath = path.join(blobRoot, verified!.record.sha256);
  await fs.copyFile(verified!.absolutePath, blobPath);
  if (process.platform !== 'win32') await fs.chmod(blobPath, 0o400);
  await fs.rm(path.join(dir, 'attachments'), { recursive: true });

  const storePath = path.join(dir, 'store.json');
  const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
    schemaVersion: number;
    attachments: Array<{ storageKey?: string }>;
  };
  persisted.schemaVersion = 10;
  persisted.attachments[0]!.storageKey =
    `attachment-blobs/${verified!.record.sha256}`;
  await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, {
    mode: 0o600
  });

  return {
    dir,
    storePath,
    blobRoot,
    blobPath,
    taskOwnedPath: verified!.absolutePath,
    attachmentId: verified!.record.id
  };
}

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
