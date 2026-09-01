import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteTaskStore } from '../SqliteTaskStore';
import { AppDatabase } from './AppDatabase';
import { ManagedFileStore } from './ManagedFileStore';

async function createFixture(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), name));
  const databasePath = path.join(root, 'task-monki.sqlite3');
  const managedFileRoot = path.join(root, 'managed-files');
  const database = await AppDatabase.open(databasePath);
  const managedFiles = new ManagedFileStore(managedFileRoot);
  const store = new SqliteTaskStore(database, managedFiles);
  return { root, databasePath, managedFileRoot, database, store };
}

async function addRepository(store: SqliteTaskStore, root: string) {
  const repositoryPath = path.join(root, 'repository');
  await fs.mkdir(repositoryPath);
  return store.addRepository({
    path: repositoryPath,
    root: repositoryPath,
    status: 'VALID',
    headSha: 'a'.repeat(40),
    branch: 'main',
    remotes: [],
    checkedAt: new Date().toISOString()
  });
}

describe('Task persistence', () => {
  it('reconstructs Task records and managed files after restart', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-reload-');
    const repository = await addRepository(fixture.store, fixture.root);
    const draft = await fixture.store.createAttachmentDraft();
    const staged = await fixture.store.stageTaskAttachment({
      draftId: draft.id,
      clientToken: 'attachment-client-token-0001',
      displayName: 'notes.txt',
      bytes: Buffer.from('durable attachment')
    });
    const task = await fixture.store.createTask({
      title: 'Persist normalized Task state',
      prompt: 'Reload this record from SQLite.',
      repositoryId: repository.id,
      attachmentDraftId: draft.id,
      creationToken: 'task-creation-token-0000001'
    });
    const artifact = await fixture.store.writeTextArtifact(task.id, 'git-snapshot', 'evidence');

    expect(fixture.database.get<{ count: number }>('SELECT count(*) AS count FROM tasks')?.count).toBe(1);
    expect(
      fixture.database.get<{ count: number }>('SELECT count(*) AS count FROM task_attachments')?.count
    ).toBe(1);
    expect(
      fixture.database.get<{ count: number }>(
        `SELECT count(*) AS count FROM artifacts WHERE domain = 'TASK'`
      )?.count
    ).toBe(1);

    await fixture.store.close();
    await fixture.database.close();
    const reopenedDatabase = await AppDatabase.open(fixture.databasePath);
    const reopened = new SqliteTaskStore(
      reopenedDatabase,
      new ManagedFileStore(fixture.managedFileRoot)
    );
    await expect(reopened.getTask(task.id)).resolves.toMatchObject({
      id: task.id,
      title: 'Persist normalized Task state'
    });
    await expect(reopened.getTaskAttachments(task.id)).resolves.toEqual([
      expect.objectContaining({ id: staged.id, sha256: staged.sha256 })
    ]);
    await expect(reopened.readArtifact(artifact.id)).resolves.toBe('evidence');
    await reopened.close();
    await reopenedDatabase.close();
  });

  it('loads committed state before admitting the first mutation after restart', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-cold-mutation-');
    const first = await addRepository(fixture.store, fixture.root);
    await fixture.store.close();
    await fixture.database.close();

    const reopenedDatabase = await AppDatabase.open(fixture.databasePath);
    const reopened = new SqliteTaskStore(
      reopenedDatabase,
      new ManagedFileStore(fixture.managedFileRoot)
    );
    const secondPath = path.join(fixture.root, 'second-repository');
    await fs.mkdir(secondPath);
    const second = await reopened.addRepository({
      path: secondPath,
      root: secondPath,
      status: 'VALID',
      headSha: 'b'.repeat(40),
      branch: 'main',
      remotes: [],
      checkedAt: new Date().toISOString()
    });

    await expect(reopened.snapshot()).resolves.toMatchObject({
      repositories: expect.arrayContaining([
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: second.id })
      ])
    });
    expect(
      reopenedDatabase.get<{ count: number }>('SELECT count(*) AS count FROM repositories')
        ?.count
    ).toBe(2);
    await reopened.close();
    await reopenedDatabase.close();
  });

  it('publishes transaction-local state only after the shared transaction commits', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-transaction-');
    const repository = await addRepository(fixture.store, fixture.root);
    let rolledBackTaskId = '';

    await expect(
      fixture.database.write(async () => {
        const task = await fixture.store.createTask({
          title: 'Roll back me',
          prompt: 'This state must never become visible.',
          repositoryId: repository.id
        });
        rolledBackTaskId = task.id;
        await expect(fixture.store.getTask(task.id)).resolves.toMatchObject({ id: task.id });
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    await expect(fixture.store.getTask(rolledBackTaskId)).resolves.toBeUndefined();
    expect(fixture.database.get<{ count: number }>('SELECT count(*) AS count FROM tasks')?.count).toBe(0);

    await fixture.database.write(async () => {
      const first = await fixture.store.createTask({
        title: 'First committed Task',
        prompt: 'Commit together.',
        repositoryId: repository.id
      });
      const second = await fixture.store.createTask({
        title: 'Second committed Task',
        prompt: 'Observe the first staged Task.',
        repositoryId: repository.id
      });
      await expect(fixture.store.getTask(first.id)).resolves.toMatchObject({ id: first.id });
      await expect(fixture.store.getTask(second.id)).resolves.toMatchObject({ id: second.id });
    });

    expect(fixture.database.get<{ count: number }>('SELECT count(*) AS count FROM tasks')?.count).toBe(2);
    await expect(fixture.store.snapshot()).resolves.toMatchObject({ tasks: expect.arrayContaining([
      expect.objectContaining({ title: 'First committed Task' }),
      expect.objectContaining({ title: 'Second committed Task' })
    ]) });
    await fixture.store.close();
    await fixture.database.close();
  });

  it('updates only changed logical rows', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-diff-');
    const repository = await addRepository(fixture.store, fixture.root);
    const before = fixture.database.get<{ record_revision: number }>(
      'SELECT record_revision FROM repositories WHERE id = ?',
      [repository.id]
    )?.record_revision;

    await fixture.store.createTask({
      title: 'Independent row',
      prompt: 'Do not rewrite the repository row.',
      repositoryId: repository.id
    });

    const after = fixture.database.get<{ record_revision: number }>(
      'SELECT record_revision FROM repositories WHERE id = ?',
      [repository.id]
    )?.record_revision;
    expect(after).toBe(before);
    await fixture.store.close();
    await fixture.database.close();
  });

  it('replaces appended artifact bytes with a new immutable managed revision', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-artifact-append-');
    const repository = await addRepository(fixture.store, fixture.root);
    const task = await fixture.store.createTask({
      title: 'Immutable evidence',
      prompt: 'Append without mutating the referenced file.',
      repositoryId: repository.id
    });
    const artifact = await fixture.store.writeTextArtifact(task.id, 'git-snapshot', 'before');
    const originalPath = artifact.path;

    await fixture.store.appendArtifact(artifact.id, '-after');

    const replacementPath = await fixture.store.getArtifactPath(artifact.id);
    expect(replacementPath).not.toBe(originalPath);
    await expect(fixture.store.readArtifact(artifact.id)).resolves.toBe('before-after');
    await expect(fs.access(originalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(replacementPath)).mode & 0o777).toBe(0o400);
    expect(
      fixture.database.get<{ content_sha256: string; byte_count: number }>(
        `SELECT mf.content_sha256, mf.byte_count
         FROM artifacts a JOIN managed_files mf ON mf.id = a.managed_file_id
         WHERE a.id = ?`,
        [artifact.id]
      )
    ).toMatchObject({ byte_count: Buffer.byteLength('before-after'), content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    await fixture.store.close();
    await fixture.database.close();
  });

  it('snapshots externally-written preview captures into immutable managed revisions', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-preview-capture-');
    const repository = await addRepository(fixture.store, fixture.root);
    const task = await fixture.store.createTask({
      title: 'Preview output',
      prompt: 'Reconcile external process output.',
      repositoryId: repository.id
    });
    const capture = await fixture.store.createPreviewArtifact(task.id, 'preview-stdout');
    const initialManagedPath = await fixture.store.getArtifactPath(capture.id);
    expect(capture.path).not.toBe(initialManagedPath);

    await fs.appendFile(capture.path, 'external output');
    const reconciled = await fixture.store.syncArtifactByteCount(capture.id);

    expect(reconciled.path).not.toBe(initialManagedPath);
    expect(reconciled.byteCount).toBe(Buffer.byteLength('external output'));
    await expect(fixture.store.readArtifact(capture.id)).resolves.toBe('external output');
    await expect(fs.access(initialManagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(capture.path)).resolves.toBeUndefined();
    await fixture.store.close();
    await fixture.database.close();
  });

  it('keeps the committed artifact revision and removes the replacement when a shared transaction rolls back', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-artifact-rollback-');
    const repository = await addRepository(fixture.store, fixture.root);
    const task = await fixture.store.createTask({
      title: 'Rollback evidence',
      prompt: 'Preserve the previously committed bytes.',
      repositoryId: repository.id
    });
    const artifact = await fixture.store.writeTextArtifact(task.id, 'git-snapshot', 'committed');
    let rolledBackPath = '';

    await expect(
      fixture.database.write(async () => {
        await fixture.store.appendArtifact(artifact.id, '-uncommitted');
        rolledBackPath = await fixture.store.getArtifactPath(artifact.id);
        expect(rolledBackPath).not.toBe(artifact.path);
        throw new Error('force artifact rollback');
      })
    ).rejects.toThrow('force artifact rollback');

    expect(await fixture.store.getArtifactPath(artifact.id)).toBe(artifact.path);
    await expect(fixture.store.readArtifact(artifact.id)).resolves.toBe('committed');
    await expect(fs.access(artifact.path)).resolves.toBeUndefined();
    await expect(fs.access(rolledBackPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fixture.store.close();
    await fixture.database.close();
  });

  it('rejects a task artifact hidden by a tampered domain index after restart', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-artifact-domain-');
    const repository = await addRepository(fixture.store, fixture.root);
    const task = await fixture.store.createTask({
      title: 'Validate artifact domain',
      prompt: 'Do not omit the artifact from reload.',
      repositoryId: repository.id
    });
    const artifact = await fixture.store.writeTextArtifact(task.id, 'git-snapshot', 'evidence');
    await fixture.database.write((transaction) => {
      transaction.run(`UPDATE artifacts SET domain = 'RUNTIME' WHERE id = ?`, [artifact.id]);
    });
    await fixture.store.close();
    await fixture.database.close();

    const reopenedDatabase = await AppDatabase.open(fixture.databasePath);
    const reopened = new SqliteTaskStore(
      reopenedDatabase,
      new ManagedFileStore(fixture.managedFileRoot)
    );
    await expect(reopened.snapshot()).rejects.toThrow(/Task artifact .* column domain/);
    await reopened.close();
    await reopenedDatabase.close();
  });

  it('rejects inconsistent task artifact managed-file ownership after restart', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-artifact-owner-');
    const repository = await addRepository(fixture.store, fixture.root);
    const task = await fixture.store.createTask({
      title: 'Validate artifact owner',
      prompt: 'Keep the managed-file owner aligned.',
      repositoryId: repository.id
    });
    const artifact = await fixture.store.writeTextArtifact(task.id, 'git-snapshot', 'evidence');
    await fixture.database.write((transaction) => {
      transaction.run(
        `UPDATE managed_files SET owner_id = 'another-task'
          WHERE id = (SELECT managed_file_id FROM artifacts WHERE id = ?)`,
        [artifact.id]
      );
    });
    await fixture.store.close();
    await fixture.database.close();

    const reopenedDatabase = await AppDatabase.open(fixture.databasePath);
    const reopened = new SqliteTaskStore(
      reopenedDatabase,
      new ManagedFileStore(fixture.managedFileRoot)
    );
    await expect(reopened.snapshot()).rejects.toThrow(
      /managed file column managed_file_owner_id/
    );
    await reopened.close();
    await reopenedDatabase.close();
  });

  it('rejects a task attachment indexed to a different valid task after restart', async () => {
    const fixture = await createFixture('task-monki-sqlite-task-attachment-owner-');
    const repository = await addRepository(fixture.store, fixture.root);
    const draft = await fixture.store.createAttachmentDraft();
    const staged = await fixture.store.stageTaskAttachment({
      draftId: draft.id,
      clientToken: 'attachment-owner-tamper-0001',
      displayName: 'notes.txt',
      bytes: Buffer.from('durable attachment')
    });
    await fixture.store.createTask({
      title: 'Original attachment owner',
      prompt: 'Own the attachment.',
      repositoryId: repository.id,
      attachmentDraftId: draft.id
    });
    const other = await fixture.store.createTask({
      title: 'Other valid owner',
      prompt: 'Do not inherit the attachment.',
      repositoryId: repository.id
    });
    await fixture.database.write((transaction) => {
      transaction.run('UPDATE task_attachments SET task_id = ? WHERE id = ?', [
        other.id,
        staged.id
      ]);
    });
    await fixture.store.close();
    await fixture.database.close();

    const reopenedDatabase = await AppDatabase.open(fixture.databasePath);
    const reopened = new SqliteTaskStore(
      reopenedDatabase,
      new ManagedFileStore(fixture.managedFileRoot)
    );
    await expect(reopened.snapshot()).rejects.toThrow(/Task attachment .* column task_id/);
    await reopened.close();
    await reopenedDatabase.close();
  });
});
