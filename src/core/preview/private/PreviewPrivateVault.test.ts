import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../storage/sqlite/AppDatabase';
import { ManagedFileStore } from '../../storage/sqlite/ManagedFileStore';
import { PreviewPrivateVault, type PreviewSecretProtector } from './PreviewPrivateVault';

const roots: string[] = [];
const databases: AppDatabase[] = [];
const protector: PreviewSecretProtector = {
  isAvailable: () => true,
  encrypt: async (value) => Buffer.from(value.map((byte) => byte ^ 0xaa)),
  decrypt: async (value) => Buffer.from(value.map((byte) => byte ^ 0xaa))
};

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('PreviewPrivateVault', () => {
  it('rotates without deleting a leased revision and never persists plaintext', async () => {
    const fixture = await createFixture(['task']);
    const vault = fixture.vault;
    expect(await vault.set('task', 'token', 'canary-one')).toBe('STORED');
    const lease = await vault.acquire('task', ['token']);
    if (Array.isArray(lease)) throw new Error('unexpected blocker');
    expect(lease.values.token).toBe('canary-one');

    expect(await vault.set('task', 'token', 'canary-two')).toBe('STORED');
    await waitForCleanup(vault);
    expect(await privateBlobNames(fixture.files.rootPath)).toHaveLength(2);
    await lease.release();
    await waitForCleanup(vault);
    expect(await privateBlobNames(fixture.files.rootPath)).toHaveLength(1);

    const databaseBytes = await fs.readFile(fixture.databasePath);
    expect(databaseBytes.includes(Buffer.from('canary'))).toBe(false);
    for (const name of await privateBlobNames(fixture.files.rootPath)) {
      const contents = await fs.readFile(path.join(fixture.files.rootPath, 'preview-private', name));
      expect(contents.includes(Buffer.from('canary'))).toBe(false);
    }
  });

  it('reports missing values without preventing planning', async () => {
    const { vault } = await createFixture(['task']);

    await expect(vault.readiness('task', ['token'])).resolves.toEqual([
      { kind: 'PRIVATE_INPUT_MISSING', inputId: 'token' }
    ]);
  });

  it('loads encrypted authority after reopening the application database', async () => {
    const fixture = await createFixture(['task']);
    expect(await fixture.vault.set('task', 'token', 'persisted-canary')).toBe('STORED');
    await closeDatabase(fixture.database);

    const reopened = await AppDatabase.open(fixture.databasePath);
    databases.push(reopened);
    const vault = new PreviewPrivateVault(reopened, fixture.files, protector);
    const lease = await vault.acquire('task', ['token']);
    if (Array.isArray(lease)) throw new Error('unexpected blocker');

    expect(lease.values.token).toBe('persisted-canary');
    await lease.release();
  });

  it('removes published ciphertext when an outer transaction rolls back', async () => {
    const fixture = await createFixture(['task']);

    await expect(
      fixture.database.write(async () => {
        expect(await fixture.vault.set('task', 'token', 'rolled-back-canary')).toBe('STORED');
        throw new Error('abort transaction');
      })
    ).rejects.toThrow('abort transaction');

    await expect(fixture.vault.readiness('task', ['token'])).resolves.toEqual([
      { kind: 'PRIVATE_INPUT_MISSING', inputId: 'token' }
    ]);
    expect(await privateBlobNames(fixture.files.rootPath)).toEqual([]);
  });

  it('retains an exact revision until its durable generation reference is released', async () => {
    const fixture = await createFixture(['task']);
    const vault = fixture.vault;
    await vault.set('task', 'token', 'r1');
    const lease = await vault.acquire('task', ['token']);
    if (Array.isArray(lease)) throw new Error('unexpected blocker');
    await vault.retainGeneration('generation-1', 'task', lease.revisions);
    await lease.release();
    await vault.set('task', 'token', 'r2');
    await waitForCleanup(vault);

    expect(await privateBlobNames(fixture.files.rootPath)).toHaveLength(2);
    await vault.releaseGeneration('generation-1');
    await waitForCleanup(vault);
    expect(await privateBlobNames(fixture.files.rootPath)).toHaveLength(1);
  });

  it('sweeps deleted-task authority and encrypted files with no database owner', async () => {
    const fixture = await createFixture(['deleted-task']);
    await fixture.vault.set('deleted-task', 'token', 'residue');
    const orphanKey = `preview-private/${randomUUID()}.blob`;
    await fixture.files.publish(orphanKey, Buffer.from('orphan'));

    await expect(
      fixture.vault.sweep({ taskIds: new Set(), retainedGenerationIds: new Set() })
    ).resolves.toBe('CLEAN');
    expect(await privateBlobNames(fixture.files.rootPath)).toEqual([]);
  });

  it('fails closed when immutable ciphertext no longer matches its database digest', async () => {
    const fixture = await createFixture(['task']);
    await fixture.vault.set('task', 'token', 'canary');
    const blob = (await privateBlobNames(fixture.files.rootPath))[0]!;
    const blobPath = path.join(fixture.files.rootPath, 'preview-private', blob);
    if (process.platform !== 'win32') await fs.chmod(blobPath, 0o600);
    await fs.writeFile(blobPath, 'tampered');
    if (process.platform !== 'win32') await fs.chmod(blobPath, 0o400);

    await expect(fixture.vault.acquire('task', ['token'])).resolves.toEqual([
      { kind: 'PRIVATE_INPUT_CORRUPT', inputId: 'token' }
    ]);
    await expect(fixture.vault.retryCleanup()).resolves.toBe('RECOVERY_REQUIRED');
  });

  it('does not persist a value when platform protection is unavailable', async () => {
    const fixture = await createFixture(['task']);
    const unavailable = new PreviewPrivateVault(fixture.database, fixture.files, {
      ...protector,
      isAvailable: () => false
    });

    await expect(unavailable.set('task', 'token', 'canary')).resolves.toBe(
      'PROTECTION_UNAVAILABLE'
    );
    expect(await privateBlobNames(fixture.files.rootPath)).toEqual([]);
  });
});

async function createFixture(taskIds: string[]): Promise<{
  root: string;
  databasePath: string;
  database: AppDatabase;
  files: ManagedFileStore;
  vault: PreviewPrivateVault;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-private-vault-'));
  roots.push(root);
  const databasePath = path.join(root, 'storage', 'task-monki.sqlite3');
  const database = await AppDatabase.open(databasePath);
  databases.push(database);
  for (const taskId of taskIds) await insertTask(database, taskId);
  const files = new ManagedFileStore(path.join(root, 'storage', 'files'));
  const vault = new PreviewPrivateVault(database, files, protector);
  return { root, databasePath, database, files, vault };
}

async function insertTask(database: AppDatabase, taskId: string): Promise<void> {
  const repositoryId = randomUUID();
  const now = '2026-08-29T10:00:00.000Z';
  await database.write((transaction) => {
    transaction.run(
      `INSERT INTO repositories (
         id, kind, name, path, status, head_sha, branch, remotes_json, error,
         payload_json, record_revision, created_at, updated_at, checked_at
       ) VALUES (?, 'USER_REGISTERED', 'Repository', ?, 'AVAILABLE', NULL, NULL,
         '[]', NULL, '{}', 0, ?, ?, ?)`,
      [repositoryId, `/tmp/repository-${repositoryId}`, now, now, now]
    );
    transaction.run(
      `INSERT INTO tasks (
         id, kind, runtime_id, title, prompt, repository_id, creation_token,
         creation_request_fingerprint, workflow_phase, resolution, completion_policy,
         phase_version, current_run_id, current_session_id, current_iteration_id,
         current_worktree_id, forked_from_task_id, forked_from_run_id, source_design_id,
         source_design_revision_id, agent_settings_json, payload_json, record_revision,
         created_at, updated_at
       ) VALUES (?, 'NORMAL', 'codex', 'Task', 'Prompt', ?, NULL, NULL,
         'BACKLOG', 'UNRESOLVED', 'COMMIT', 0, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, '{}', '{}', 0, ?, ?)`,
      [taskId, repositoryId, now, now]
    );
  });
}

async function privateBlobNames(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(root, 'preview-private'))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForCleanup(vault: PreviewPrivateVault): Promise<void> {
  await vault.shutdown();
}

async function closeDatabase(database: AppDatabase): Promise<void> {
  await database.close();
  databases.splice(databases.indexOf(database), 1);
}
