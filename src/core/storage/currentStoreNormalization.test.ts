import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION } from '../../shared/contracts';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { FileTaskStore } from './FileTaskStore';
import { migratePersistedStateToCurrent } from './currentStoreNormalization';

describe('migratePersistedStateToCurrent', () => {
  it('migrates schema 19 ownership discriminators and Preview identities in one step', () => {
    const migrated = migratePersistedStateToCurrent({
      schemaVersion: 19,
      tasks: [{ id: 'task' }],
      repositories: [{ id: 'repository' }],
      previewPlans: [
        {
          id: 'plan',
          recipePath: '.taskmonki/preview.yaml',
          recipeVersion: 1,
          recipeDigest: 'a'.repeat(64),
          executionDigest: 'b'.repeat(64)
        }
      ],
      previewGenerations: [
        {
          id: 'generation',
          approvalId: 'approval',
          executionDigest: 'b'.repeat(64),
          sourceGitSnapshotId: 'snapshot',
          sourceHeadSha: 'c'.repeat(40),
          sourceDirtyFingerprint: 'clean'
        }
      ]
    });

    expect(migrated).toMatchObject({ changed: true });
    expect(migrated.state).toMatchObject({
      schemaVersion: TASK_STORE_SCHEMA_VERSION,
      tasks: [{ id: 'task', kind: 'NORMAL' }],
      repositories: [{ id: 'repository', kind: 'USER_REGISTERED' }],
      designTurns: [],
      designReferences: [],
      designRevisions: [],
      previewPlans: [
        {
          id: 'plan',
          planSource: {
            type: 'REPOSITORY_RECIPE',
            recipePath: '.taskmonki/preview.yaml',
            recipeVersion: 1,
            recipeDigest: 'a'.repeat(64)
          }
        }
      ],
      previewGenerations: [
        {
          id: 'generation',
          executionAuthority: {
            type: 'USER_APPROVAL',
            approvalId: 'approval',
            executionDigest: 'b'.repeat(64)
          },
          source: {
            type: 'WORKTREE_SNAPSHOT',
            gitSnapshotId: 'snapshot',
            headSha: 'c'.repeat(40),
            dirtyFingerprint: 'clean'
          }
        }
      ]
    });
    expect(migrated.state.previewPlans[0]).not.toHaveProperty('recipePath');
    expect(migrated.state.previewGenerations[0]).not.toHaveProperty('approvalId');
  });

  it('fails closed instead of inventing owners for Design records in schema 19', () => {
    expect(() =>
      migratePersistedStateToCurrent({
        schemaVersion: 19,
        tasks: [],
        repositories: [],
        previewPlans: [],
        previewGenerations: [],
        designTurns: [{ id: 'unexpected' }]
      })
    ).toThrow('designTurns contains unsupported Design records');
  });

  it('migrates schema 20 references to active immutable references', () => {
    const migrated = migratePersistedStateToCurrent({
      schemaVersion: 20,
      designReferences: [
        {
          id: 'reference-1',
          designId: 'design-1',
          attachmentId: 'attachment-1',
          createdAt: '2026-08-20T10:00:00.000Z'
        }
      ]
    });

    expect(migrated).toEqual({
      changed: true,
      state: {
        schemaVersion: TASK_STORE_SCHEMA_VERSION,
        designReferences: [
          {
            id: 'reference-1',
            designId: 'design-1',
            attachmentId: 'attachment-1',
            role: 'REFERENCE',
            state: 'ACTIVE',
            createdAt: '2026-08-20T10:00:00.000Z'
          }
        ]
      }
    });
  });

  it('loads and republishes an on-disk schema 19 store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-schema-19-'));
    const storePath = path.join(dir, 'store.json');
    const store = new FileTaskStore(dir);
    const repository = await addTestRepository(store, dir);
    const task = await store.createTask({
      title: 'Migrate existing task',
      prompt: 'Keep the normal workflow intact.',
      repositoryId: repository.id
    });
    await store.close();

    const legacy = JSON.parse(await fs.readFile(storePath, 'utf8')) as Record<
      string,
      unknown
    >;
    legacy.schemaVersion = 19;
    legacy.tasks = (legacy.tasks as Array<Record<string, unknown>>).map(
      ({ kind: _kind, ...record }) => record
    );
    legacy.repositories = (
      legacy.repositories as Array<Record<string, unknown>>
    ).map(({ kind: _kind, ...record }) => record);
    delete legacy.designTurns;
    delete legacy.designReferences;
    delete legacy.designRevisions;
    await fs.writeFile(storePath, `${JSON.stringify(legacy)}\n`, 'utf8');

    const restarted = new FileTaskStore(dir);
    const snapshot = await restarted.snapshot();
    expect(snapshot.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(snapshot.tasks).toEqual([
      expect.objectContaining({ id: task.id, kind: 'NORMAL' })
    ]);
    expect(snapshot.repositories).toEqual([
      expect.objectContaining({ id: repository.id, kind: 'USER_REGISTERED' })
    ]);
    expect(snapshot.designTurns).toEqual([]);
    await restarted.close();
  });
});
