import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../storage/sqlite/AppDatabase';
import { SqliteDesignDraftStore } from './DesignDraftStore';

const databases: AppDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('SqliteDesignDraftStore', () => {
  it('persists, replaces, and deletes a draft with optimistic revision checks', async () => {
    const { database, databasePath } = await createDatabase();
    const designId = randomUUID();
    await insertDesignTask(database, designId);
    const store = new SqliteDesignDraftStore(database);

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

    await closeDatabase(database);
    const reopened = await AppDatabase.open(databasePath);
    databases.push(reopened);
    const reopenedStore = new SqliteDesignDraftStore(reopened);
    await expect(reopenedStore.get(designId)).resolves.toEqual(second);

    await expect(
      reopenedStore.delete({ designId, expectedRevision: first.recordRevision })
    ).rejects.toThrow('changed before it could be deleted');
    await reopenedStore.delete({ designId, expectedRevision: second.recordRevision });
    await expect(reopenedStore.get(designId)).resolves.toBeUndefined();
  });

  it('preserves reference selection and exclusive attachment-draft ownership', async () => {
    const { database } = await createDatabase();
    const firstDesignId = randomUUID();
    const secondDesignId = randomUUID();
    const referenceId = randomUUID();
    await insertDesignTask(database, firstDesignId);
    await insertDesignTask(database, secondDesignId);
    const store = new SqliteDesignDraftStore(database);
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
    await expect(store.get(firstDesignId)).resolves.toEqual(first);
  });

  it('participates in an outer database transaction and remains absent after rollback', async () => {
    const { database } = await createDatabase();
    const designId = randomUUID();
    await insertDesignTask(database, designId);
    const store = new SqliteDesignDraftStore(database);

    await expect(
      database.write(async () => {
        await store.save({
          designId,
          expectedRevision: 0,
          body: 'Do not publish',
          referenceIds: []
        });
        expect(await store.get(designId)).toMatchObject({ body: 'Do not publish' });
        throw new Error('abort transaction');
      })
    ).rejects.toThrow('abort transaction');

    await expect(store.get(designId)).resolves.toBeUndefined();
  });

  it('rejects corrupt structured payloads without rewriting them', async () => {
    const { database } = await createDatabase();
    const designId = randomUUID();
    await insertDesignTask(database, designId);
    const payload = JSON.stringify({ body: 42, referenceIds: [] });
    await database.write((transaction) => {
      transaction.run(
        `INSERT INTO design_drafts (
           design_id, attachment_draft_id, record_revision, updated_at, payload_json
         ) VALUES (?, NULL, 1, ?, ?)`,
        [designId, '2026-08-29T10:00:00.000Z', payload]
      );
    });
    const store = new SqliteDesignDraftStore(database);

    await expect(store.get(designId)).rejects.toThrow('payload is invalid');
    await expect(
      database.read((reader) =>
        reader.get<{ payload_json: string }>(
          'SELECT payload_json FROM design_drafts WHERE design_id = ?',
          [designId]
        )
      )
    ).resolves.toEqual({ payload_json: payload });
  });
});

async function createDatabase(): Promise<{ database: AppDatabase; databasePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-draft-'));
  roots.push(root);
  const databasePath = path.join(root, 'task-monki.sqlite3');
  const database = await AppDatabase.open(databasePath);
  databases.push(database);
  return { database, databasePath };
}

async function closeDatabase(database: AppDatabase): Promise<void> {
  await database.close();
  databases.splice(databases.indexOf(database), 1);
}

async function insertDesignTask(database: AppDatabase, designId: string): Promise<void> {
  const repositoryId = randomUUID();
  const now = '2026-08-29T10:00:00.000Z';
  await database.write((transaction) => {
    transaction.run(
      `INSERT INTO repositories (
         id, kind, name, path, status, head_sha, branch, remotes_json, error,
         payload_json, record_revision, created_at, updated_at, checked_at
       ) VALUES (?, 'DESIGN_MANAGED', 'Design', ?, 'READY', NULL, NULL, '[]', NULL,
         '{}', 0, ?, ?, ?)`,
      [repositoryId, `/tmp/design-${repositoryId}`, now, now, now]
    );
    transaction.run(
      `INSERT INTO tasks (
         id, kind, runtime_id, title, prompt, repository_id, creation_token,
         creation_request_fingerprint, workflow_phase, resolution, completion_policy,
         phase_version, current_run_id, current_session_id, current_iteration_id,
         current_worktree_id, forked_from_task_id, forked_from_run_id, source_design_id,
         source_design_revision_id, agent_settings_json, payload_json, record_revision,
         created_at, updated_at
       ) VALUES (?, 'DESIGN', 'codex', 'Design', 'Design prompt', ?, NULL, NULL,
         'BACKLOG', 'UNRESOLVED', 'COMMIT', 0, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, '{}', '{}', 0, ?, ?)`,
      [designId, repositoryId, now, now]
    );
  });
}
