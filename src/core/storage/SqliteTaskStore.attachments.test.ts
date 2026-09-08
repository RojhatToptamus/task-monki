import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteTaskStore } from './SqliteTaskStore';
import type { TaskAgentRuntimeAccess } from '../agent/AgentRuntimeStore';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import type { ApplicationPersistence } from './sqlite/ApplicationPersistence';

const persistenceByTaskStore = new WeakMap<SqliteTaskStore, ApplicationPersistence>();

async function createStore(profileRoot: string): Promise<SqliteTaskStore> {
  const persistence = await openTestPersistence(profileRoot);
  persistenceByTaskStore.set(persistence.tasks, persistence);
  return persistence.tasks;
}

function persistenceFixture(store: SqliteTaskStore): ApplicationPersistence {
  const persistence = persistenceByTaskStore.get(store);
  if (!persistence) throw new Error('Task store does not belong to this test fixture.');
  return persistence;
}

function closeStore(store: SqliteTaskStore): Promise<void> {
  return persistenceFixture(store).close();
}

function taskRuntime(store: SqliteTaskStore): TaskAgentRuntimeAccess {
  return persistenceFixture(store).taskRuntime;
}

describe('SqliteTaskStore attachments', () => {
  it('creates and reloads a task-owned immutable attachment', async () => {
    const dir = await temporaryDirectory();
    const store = await createStore(dir);
    const draft = await store.createAttachmentDraft();
    const staged = await store.stageTaskAttachment({
      draftId: draft.id,
      displayName: 'context.json',
      bytes: bytes('{"scope":"task"}')
    });
    const request = {
      title: 'Use context',
      prompt: 'Read the attached context.',
      repositoryId: (await addTestRepository(store, dir)).id,
      creationToken: 'task-create-attachment-reload-0001',
      attachmentDraftId: draft.id
    };
    const task = await store.createTask(request);
    await closeStore(store);

    const reloaded = await createStore(dir);
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
    const store = await createStore(dir);
    const request = {
      title: 'Original task',
      prompt: 'Use the original request.',
      repositoryId: (await addTestRepository(store, dir)).id,
      agentSettings: { model: 'codex-test', networkAccess: false },
      creationToken: 'task-create-conflict-token-0001'
    };
    const created = await store.createTask(request);

    await expect(
      store.createTask({
        ...request,
        title: `  ${request.title}  `,
        prompt: ` ${request.prompt} `,
        repositoryId: `${request.repositoryId} `,
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

  it('leaves the draft retryable when the enclosing database transaction rolls back', async () => {
    const dir = await temporaryDirectory();
    const store = await createStore(dir);
    const repository = await addTestRepository(store, dir);
    const { draftId } = await stageText(store, 'notes.txt', 'keep me');
    await expect(
      persistenceFixture(store).database.write(async () => {
        await store.createTask({
          title: 'Will fail',
          prompt: 'Do not lose the draft.',
          repositoryId: repository.id,
          attachmentDraftId: draftId
        });
        throw new Error('injected transaction failure');
      })
    ).rejects.toThrow('injected transaction failure');

    await expect(store.listAttachmentDraft(draftId)).resolves.toMatchObject({
      attachments: [expect.objectContaining({ displayName: 'notes.txt' })]
    });
    expect((await store.snapshot()).tasks).toEqual([]);
  });

  it('forks attachments into an independent task-owned directory', async () => {
    const dir = await temporaryDirectory();
    const worktreePath = await temporaryDirectory();
    const store = await createStore(dir);
    const { draftId } = await stageText(store, 'context.md', '# Shared context\n');
    const source = await store.createTask({
      title: 'Source',
      prompt: 'Use context.',
      repositoryId: (await addTestRepository(store, dir)).id,
      attachmentDraftId: draftId
    });
    const run = await createRun(store, source, worktreePath, 'source');
    const fork = await store.createForkedAlternativeTask({
      title: 'Alternative',
      prompt: source.prompt,
      repositoryId: source.repositoryId,
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
    const store = await createStore(dir);
    const { draftId } = await stageText(store, 'shared.txt', 'shared');
    const source = await store.createTask({
      title: 'Source',
      prompt: 'Use context.',
      repositoryId: (await addTestRepository(store, dir)).id,
      attachmentDraftId: draftId
    });
    const run = await createRun(store, source, worktreePath, 'delete');
    const fork = await store.createForkedAlternativeTask({
      title: 'Fork',
      prompt: source.prompt,
      repositoryId: (await addTestRepository(store, dir)).id,
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
    const store = await createStore(dir);
    const { draftId } = await stageText(store, 'context.json', '{"delete":true}');
    const task = await store.createTask({
      title: 'Delete run inputs',
      prompt: 'Use context.',
      repositoryId: (await addTestRepository(store, dir)).id,
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
    const store = await createStore(dir);
    const { draftId } = await stageText(store, 'restart.txt', 'authoritative bytes');
    const task = await store.createTask({
      title: 'Restart recovery',
      prompt: 'Use the attachment.',
      repositoryId: (await addTestRepository(store, dir)).id,
      attachmentDraftId: draftId
    });
    const run = await createRun(store, task, worktreePath, 'repair');
    const [delivery] = await store.prepareRunAttachments(run.id, task.id);
    if (process.platform !== 'win32') await fs.chmod(delivery.absolutePath, 0o600);
    await fs.writeFile(delivery.absolutePath, 'tampered');
    if (process.platform !== 'win32') await fs.chmod(delivery.absolutePath, 0o400);

    await closeStore(store);
    const restarted = await createStore(dir);
    await expect(restarted.verifyTaskAttachments(task.id)).rejects.toThrow(
      'Managed file does not match its authoritative metadata'
    );
  });

  it('preserves durable task records when a referenced attachment is missing at startup', async () => {
    const dir = await temporaryDirectory();
    const store = await createStore(dir);
    const { draftId } = await stageText(store, 'missing.txt', 'authoritative bytes');
    const attachedTask = await store.createTask({
      title: 'Attached task',
      prompt: 'Use the attachment.',
      repositoryId: (await addTestRepository(store, dir)).id,
      attachmentDraftId: draftId
    });
    const siblingTask = await store.createTask({
      title: 'Sibling task',
      prompt: 'Remain durable.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const [delivery] = await store.verifyTaskAttachments(attachedTask.id);
    await closeStore(store);

    await fs.unlink(delivery.absolutePath);

    const restarted = await createStore(dir);
    await expect(restarted.snapshot()).rejects.toMatchObject({ code: 'ENOENT' });
    const durable = await persistenceFixture(restarted).database.read((reader) => ({
      taskIds: reader
        .all<{ id: string }>('SELECT id FROM tasks ORDER BY id')
        .map(({ id }) => id),
      attachmentOwners: reader
        .all<{ task_id: string }>('SELECT task_id FROM task_attachments')
        .map(({ task_id }) => task_id)
    }));
    expect(durable.taskIds).toEqual(
      expect.arrayContaining([attachedTask.id, siblingTask.id])
    );
    expect(durable.attachmentOwners).toContain(attachedTask.id);
  });

  it.runIf(process.platform !== 'win32')('fails closed when a task-owned attachment is writable at restart', async () => {
    const dir = await temporaryDirectory();
    const store = await createStore(dir);
    const { draftId } = await stageText(store, 'restart.txt', 'authoritative bytes');
    const task = await store.createTask({
      title: 'Restart boundary breach',
      prompt: 'Use the attachment.',
      repositoryId: (await addTestRepository(store, dir)).id,
      attachmentDraftId: draftId
    });
    const [attachment] = await store.verifyTaskAttachments(task.id);
    await fs.chmod(attachment.absolutePath, 0o644);

    await closeStore(store);
    await expect(createStore(dir)).rejects.toThrow(
      'Managed file failed its integrity check'
    );
  });

});

async function stageText(
  store: SqliteTaskStore,
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
  store: SqliteTaskStore,
  task: Awaited<ReturnType<SqliteTaskStore['createTask']>>,
  worktreePath: string,
  suffix: string
) {
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: `codex/${suffix}`,
    worktreePath,
    baseSha: 'base'
  });
  const sessionId = randomUUID();
  const operationId = `test:attachment-session:${sessionId}`;
  const requestedSettings = {
    ...task.agentSettings,
    runtimeId: 'codex',
    model: task.agentSettings.model ?? 'test-model'
  };
  const session = await taskRuntime(store).createTaskSession({
    id: sessionId,
    taskId: task.id,
    iterationId: iteration.id,
    worktreeId: worktree.id,
    worktreePath: worktree.worktreePath,
    runtimeId: 'codex',
    requestedSettings,
    executionContext: {
      attestation: { status: 'ATTESTED' },
      repositoryAccess: 'WRITE',
      primaryCwd: worktree.worktreePath,
      readRoots: [{
        canonicalPath: worktree.worktreePath,
        kind: 'WORKTREE',
        entityId: worktree.id
      }],
      managedAttachments: [],
      permissionProfileHash: createHash('sha256')
        .update(JSON.stringify({ sessionId, path: worktree.worktreePath }))
        .digest('hex'),
      modelSettings: requestedSettings,
      externalTools: {
        network: requestedSettings.networkAccess === true,
        webSearch: 'disabled',
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      clientOperationId: operationId
    },
    operationId
  });
  await store.recordAgentSessionCreated(session);
  const runId = randomUUID();
  const run = await taskRuntime(store).createTaskRun({
    id: runId,
    taskId: task.id,
    iterationId: iteration.id,
    worktreeId: worktree.id,
    sessionId: session.id,
    mode: 'IMPLEMENTATION',
    prompt: task.prompt,
    operationId: `test:attachment-run:${runId}`
  });
  await store.recordAgentRunStarted(run);
  return run;
}

function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-store-attachments-'));
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
