import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSourceService } from '../../design/DesignSourceService';
import { git } from '../../git/gitCli';
import { SqliteTaskStore } from '../SqliteTaskStore';
import {
  APP_DATABASE_APPLICATION_ID,
  APP_DATABASE_SCHEMA_VERSION
} from './DatabaseMigrations';
import { AppDatabase } from './AppDatabase';
import {
  BackupRestoreError,
  BackupRestoreService,
  encodeBackupManifest
} from './BackupRestoreService';
import { ManagedFileStore, type ManagedFileReference } from './ManagedFileStore';

function designAgentSettings() {
  return {
    runtimeId: 'codex',
    model: 'gpt-test',
    sandbox: 'WORKSPACE_WRITE' as const,
    networkAccess: false,
    approvalPolicy: 'never',
    approvalsReviewer: 'user' as const
  };
}

describe('BackupRestoreService', () => {
  let temporaryRoot: string;
  let storageRoot: string;
  let backupsRoot: string;
  let database: AppDatabase;
  let files: ManagedFileStore;
  let service: BackupRestoreService;
  let databaseClosed: boolean;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-backup-'));
    storageRoot = path.join(temporaryRoot, 'storage-v2');
    backupsRoot = path.join(temporaryRoot, 'backups');
    database = await AppDatabase.open(path.join(storageRoot, 'task-monki.sqlite3'), {
      acquireLease: false
    });
    databaseClosed = false;
    files = new ManagedFileStore(path.join(storageRoot, 'files'));
    service = new BackupRestoreService({
      storageRoot,
      backupsRoot,
      applicationId: APP_DATABASE_APPLICATION_ID,
      appVersion: 'test-version',
      database,
      managedFiles: files,
      assertRestoreAllowed: async () => {
        if (!databaseClosed) throw new Error('Database is still open.');
      }
    });
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it('backs up a consistent database snapshot and every LIVE managed file', async () => {
    const reference = await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');

    const backup = await service.createBackup();

    expect(backup.manifest).toMatchObject({
      format: 'TASK_MONKI_COMPLETE_BACKUP',
      formatVersion: 1,
      purpose: 'MANUAL',
      appVersion: 'test-version',
      database: {
        applicationId: APP_DATABASE_APPLICATION_ID,
        schemaVersion: database.schemaVersion
      },
      managedFiles: [reference]
    });
    await expect(service.verifyBackup(backup.manifest.backupId)).resolves.toEqual(backup);
    await expect(
      fs.readFile(path.join(backup.backupDirectory, 'files', ...reference.storageKey.split('/')))
    ).resolves.toEqual(Buffer.from('result'));
  });

  it('rejects a manifest that cannot be read back within the durable byte limit', async () => {
    const backup = await service.createBackup();

    expect(() => encodeBackupManifest(backup.manifest, 32)).toThrowError(
      expect.objectContaining({ code: 'BACKUP_INVALID' })
    );
    expect(encodeBackupManifest(backup.manifest, 1_000_000)).toContain(
      backup.manifest.backupId
    );
  });

  it('does not treat GC-pending bytes as reachable backup contents', async () => {
    const live = await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    const pending = await addManagedFile(
      'artifact-2',
      'artifacts/run-2/deleted.txt',
      'deleted',
      'GC_PENDING'
    );

    const backup = await service.createBackup();

    expect(backup.manifest.managedFiles).toEqual([live]);
    await expect(
      fs.stat(path.join(backup.backupDirectory, 'files', ...pending.storageKey.split('/')))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('flushes and verifies bounded protocol-journal segments owned by runtime records', async () => {
    const serverId = 'server-backup-1';
    const timestamp = '2026-08-29T10:00:00.000Z';
    await database.write((transaction) => {
      transaction.run(
        String.raw`
          INSERT INTO runtime_servers (
            id, runtime_id, status, record_revision, started_at, payload_json
          ) VALUES (?, 'codex', 'READY', 0, ?, '{}')
        `,
        [serverId, timestamp]
      );
    });
    const journalRoot = path.join(storageRoot, 'protocol-journals');
    await fs.mkdir(journalRoot, { recursive: true, mode: 0o700 });
    const journalPath = path.join(journalRoot, `${serverId}.ndjson`);
    await fs.writeFile(journalPath, '{"event":"durable"}\n', { mode: 0o600 });
    const flushProtocolJournals = vi.fn(async () => undefined);
    const journalService = new BackupRestoreService({
      storageRoot,
      backupsRoot,
      applicationId: APP_DATABASE_APPLICATION_ID,
      appVersion: 'test-version',
      database,
      managedFiles: files,
      flushProtocolJournals,
      assertRestoreAllowed: async () => {
        if (!databaseClosed) throw new Error('Database is still open.');
      }
    });

    const backup = await journalService.createBackup();

    expect(flushProtocolJournals).toHaveBeenCalledOnce();
    expect(backup.manifest.protocolJournals).toEqual([
      expect.objectContaining({
        serverInstanceId: serverId,
        segment: 0,
        relativePath: `protocol-journals/${serverId}.ndjson`
      })
    ]);
    const backupJournal = path.join(
      backup.backupDirectory,
      ...backup.manifest.protocolJournals[0]!.relativePath.split('/')
    );
    await expect(fs.readFile(backupJournal, 'utf8')).resolves.toBe(
      '{"event":"durable"}\n'
    );
    if (process.platform !== 'win32') await fs.chmod(backupJournal, 0o600);
    await fs.appendFile(backupJournal, 'tampered\n');
    if (process.platform !== 'win32') await fs.chmod(backupJournal, 0o400);
    await expect(journalService.verifyBackup(backup.manifest.backupId)).rejects.toMatchObject({
      code: 'BACKUP_INVALID'
    });
  });

  it('does not publish a journal that changes during copy and succeeds on a stable retry', async () => {
    const serverId = 'server-mutating-backup';
    const timestamp = '2026-08-29T10:00:00.000Z';
    await database.write((transaction) => {
      transaction.run(
        String.raw`
          INSERT INTO runtime_servers (
            id, runtime_id, status, record_revision, started_at, payload_json
          ) VALUES (?, 'codex', 'READY', 0, ?, '{}')
        `,
        [serverId, timestamp]
      );
    });
    const journalRoot = path.join(storageRoot, 'protocol-journals');
    await fs.mkdir(journalRoot, { recursive: true, mode: 0o700 });
    const journalPath = path.join(journalRoot, `${serverId}.ndjson`);
    await fs.writeFile(journalPath, '{"event":"first"}\n', { mode: 0o600 });

    const originalOpen = fs.open.bind(fs);
    let sourceOpenCount = 0;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (path.resolve(String(filePath)) === path.resolve(journalPath)) {
        sourceOpenCount += 1;
        if (sourceOpenCount === 2) {
          const writer = await originalOpen(journalPath, 'a');
          try {
            await writer.writeFile('{"event":"concurrent"}\n');
            await writer.sync();
          } finally {
            await writer.close();
          }
        }
      }
      return handle;
    });
    try {
      await expect(service.createBackup()).rejects.toThrow(/changed|size does not match/u);
    } finally {
      openSpy.mockRestore();
    }

    await expect(fs.readdir(backupsRoot)).resolves.toEqual([]);
    const retry = await service.createBackup();
    await expect(service.verifyBackup(retry.manifest.backupId)).resolves.toEqual(retry);
    await expect(
      fs.readFile(
        path.join(
          retry.backupDirectory,
          ...retry.manifest.protocolJournals[0]!.relativePath.split('/')
        ),
        'utf8'
      )
    ).resolves.toBe('{"event":"first"}\n{"event":"concurrent"}\n');
  });

  it('creates a complete pre-upgrade backup before runtime facades are initialized', async () => {
    const source = new DesignSourceService({
      repositoryRoot: path.join(storageRoot, 'design-repositories'),
      worktreeRoot: path.join(storageRoot, 'design-worktrees')
    });
    const taskStore = new SqliteTaskStore(database, files);
    const creationToken = 'pre-upgrade-token-0001';
    const repository = await source.prepareBlankRepository({ creationToken });
    await taskStore.createDesignBundle({
      request: { brief: 'Back up before migrating.', creationToken, runtimeId: 'codex' },
      agentSettings: designAgentSettings(),
      repository
    });
    const serverId = 'pre-upgrade-server';
    await database.write((transaction) => {
      transaction.run(
        String.raw`
          INSERT INTO runtime_servers (
            id, runtime_id, status, record_revision, started_at, payload_json
          ) VALUES (?, 'codex', 'READY', 0, '2026-08-29T10:00:00.000Z', '{}')
        `,
        [serverId]
      );
    });
    const journalRoot = path.join(storageRoot, 'protocol-journals');
    await fs.mkdir(journalRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(journalRoot, `${serverId}.ndjson`),
      '{"event":"pre-upgrade"}\n',
      { mode: 0o600 }
    );

    const backup = await service.createBackup('PRE_UPGRADE');

    expect(backup.manifest.purpose).toBe('PRE_UPGRADE');
    expect(backup.manifest.protocolJournals).toEqual([
      expect.objectContaining({ serverInstanceId: serverId })
    ]);
    expect(backup.manifest.designRepositories).toEqual([
      expect.objectContaining({
        repositoryId: repository.id,
        headSha: repository.headSha
      })
    ]);
    await expect(service.verifyBackup(backup.manifest.backupId)).resolves.toEqual(backup);
    await taskStore.close();
  }, 60_000);

  it('rejects a managed Design bundle when live HEAD diverges from the database snapshot', async () => {
    const source = new DesignSourceService({
      repositoryRoot: path.join(storageRoot, 'design-repositories'),
      worktreeRoot: path.join(storageRoot, 'design-worktrees')
    });
    const taskStore = new SqliteTaskStore(database, files);
    try {
      const creationToken = 'backup-head-drift-token';
      const repository = await source.prepareBlankRepository({ creationToken });
      await taskStore.createDesignBundle({
        request: {
          brief: 'Keep the snapshot and Git bundle consistent.',
          creationToken,
          runtimeId: 'codex'
        },
        agentSettings: designAgentSettings(),
        repository
      });

      await fs.writeFile(path.join(repository.path, 'drift.txt'), 'new committed source\n');
      await git(repository.path, ['add', 'drift.txt']);
      await git(repository.path, ['commit', '--no-gpg-sign', '-m', 'Advance live Design HEAD']);
      expect((await git(repository.path, ['rev-parse', 'HEAD'])).trim()).not.toBe(
        repository.headSha
      );

      await expect(service.createBackup()).rejects.toThrow(
        'HEAD does not match the database snapshot'
      );
      await expect(fs.readdir(backupsRoot)).resolves.toEqual([]);
    } finally {
      await taskStore.close();
    }
  });

  it('holds physical deletion until snapshot-referenced files finish copying', async () => {
    const reference = await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    const originalBackup = database.backup.bind(database);
    let releaseBackup!: () => void;
    let signalBackupStarted!: () => void;
    const backupGate = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    const backupStarted = new Promise<void>((resolve) => {
      signalBackupStarted = resolve;
    });
    vi.spyOn(database, 'backup').mockImplementation(async (destination) => {
      signalBackupStarted();
      await backupGate;
      await originalBackup(destination);
    });

    const backupPromise = service.createBackup();
    await backupStarted;
    let deletionSettled = false;
    const deletion = files.deleteAfterReferenceCommit(reference.storageKey).then((result) => {
      deletionSettled = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deletionSettled).toBe(false);

    releaseBackup();
    const backup = await backupPromise;
    await expect(deletion).resolves.toBe('DELETED');
    await expect(service.verifyBackup(backup.manifest.backupId)).resolves.toEqual(backup);
  });

  it('does not deadlock when a committed task deletion reaches GC after the backup barrier', async () => {
    const taskStore = new SqliteTaskStore(database, files);
    const repositoryPath = path.join(temporaryRoot, 'repository');
    await fs.mkdir(repositoryPath);
    const repository = await taskStore.addRepository({
      path: repositoryPath,
      root: repositoryPath,
      status: 'VALID',
      headSha: 'a'.repeat(40),
      branch: 'main',
      remotes: [],
      checkedAt: new Date().toISOString()
    });
    const task = await taskStore.createTask({
      title: 'Delete during backup',
      prompt: 'Exercise the database-to-managed-file lock order.',
      repositoryId: repository.id
    });
    await taskStore.writeTextArtifact(task.id, 'git-snapshot', 'managed evidence');

    let releaseTransaction!: () => void;
    let signalDeletionStaged!: () => void;
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const deletionStaged = new Promise<void>((resolve) => {
      signalDeletionStaged = resolve;
    });
    const deletion = database.write(async () => {
      await taskStore.deleteTask(task.id);
      signalDeletionStaged();
      await transactionGate;
    });
    await deletionStaged;

    const backup = service.createBackup();
    await new Promise((resolve) => setImmediate(resolve));
    releaseTransaction();

    await expect(Promise.all([deletion, backup])).resolves.toEqual([
      undefined,
      expect.objectContaining({ manifest: expect.objectContaining({ purpose: 'MANUAL' }) })
    ]);
    await taskStore.close();
  });

  it('rejects a backup whose managed bytes were changed after publication', async () => {
    const reference = await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    const backup = await service.createBackup();
    const backupFile = path.join(
      backup.backupDirectory,
      'files',
      ...reference.storageKey.split('/')
    );
    if (process.platform !== 'win32') await fs.chmod(backupFile, 0o600);
    await fs.writeFile(backupFile, 'tampered');
    if (process.platform !== 'win32') await fs.chmod(backupFile, 0o400);

    await expect(service.verifyBackup(backup.manifest.backupId)).rejects.toMatchObject({
      code: 'BACKUP_INVALID'
    });
  });

  it('does not publish a partial backup and releases its deletion barrier on failure', async () => {
    const reference = await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    vi.spyOn(database, 'backup').mockRejectedValueOnce(new Error('simulated backup failure'));

    await expect(service.createBackup()).rejects.toThrow('simulated backup failure');

    await expect(fs.readdir(backupsRoot)).resolves.toEqual([]);
    await expect(files.deleteAfterReferenceCommit(reference.storageKey)).resolves.toBe('DELETED');
  });

  it('restores through a staged root and preserves the replaced root for rollback', async () => {
    const reference = await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    const backup = await service.createBackup();
    await closeDatabase();
    const liveDatabasePath = path.join(storageRoot, 'task-monki.sqlite3');
    if (process.platform !== 'win32') await fs.chmod(liveDatabasePath, 0o600);
    await fs.writeFile(liveDatabasePath, 'broken-live-database');
    const liveManagedPath = await files.resolveVerifiedPath(reference);
    if (process.platform !== 'win32') await fs.chmod(liveManagedPath, 0o600);
    await fs.writeFile(liveManagedPath, 'broken-live-file');

    const recovery = new BackupRestoreService({
      storageRoot,
      backupsRoot,
      applicationId: APP_DATABASE_APPLICATION_ID,
      assertRestoreAllowed: async () => {
        if (!databaseClosed) throw new Error('Database is still open.');
      }
    });
    const restored = await recovery.restoreBackup(backup.manifest.backupId);

    expect(restored.previousStoragePath).toBeDefined();
    await expect(fs.readFile(liveManagedPath)).resolves.toEqual(Buffer.from('result'));
    await expect(
      AppDatabase.verifyFile(liveDatabasePath, {
        expectedApplicationId: APP_DATABASE_APPLICATION_ID,
        expectedSchemaVersion: backup.manifest.database.schemaVersion
      })
    ).resolves.toMatchObject({
      applicationId: APP_DATABASE_APPLICATION_ID,
      schemaVersion: backup.manifest.database.schemaVersion
    });
    await expect(
      fs.readFile(path.join(restored.previousStoragePath!, 'task-monki.sqlite3'))
    ).resolves.toEqual(Buffer.from('broken-live-database'));
  });

  it('does not let a recovery-only service create a new backup', async () => {
    const recovery = new BackupRestoreService({
      storageRoot,
      backupsRoot,
      applicationId: APP_DATABASE_APPLICATION_ID,
      assertRestoreAllowed: async () => undefined
    });

    await expect(recovery.createBackup()).rejects.toThrow(
      'recovery-only backup service cannot create backups'
    );
  });

  it('requires exclusive ownership before restore changes the live root', async () => {
    await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    const backup = await service.createBackup();

    await expect(service.restoreBackup(backup.manifest.backupId)).rejects.toThrow(
      'Database is still open.'
    );
    await expect(AppDatabase.verifyFile(path.join(storageRoot, 'task-monki.sqlite3'))).resolves
      .toBeDefined();
  });

  it('rejects a corrupt backup before changing the live storage root', async () => {
    const reference = await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    const backup = await service.createBackup();
    const backupFile = path.join(
      backup.backupDirectory,
      'files',
      ...reference.storageKey.split('/')
    );
    if (process.platform !== 'win32') await fs.chmod(backupFile, 0o600);
    await fs.writeFile(backupFile, 'tampered');
    if (process.platform !== 'win32') await fs.chmod(backupFile, 0o400);
    await closeDatabase();

    await expect(service.restoreBackup(backup.manifest.backupId)).rejects.toMatchObject({
      code: 'BACKUP_INVALID'
    });
    await expect(
      AppDatabase.verifyFile(path.join(storageRoot, 'task-monki.sqlite3'))
    ).resolves.toBeDefined();
  });

  it('rejects a valid newer-schema backup before staging or replacing live storage', async () => {
    const backup = await service.createBackup();
    await closeDatabase();
    const liveDatabasePath = path.join(storageRoot, 'task-monki.sqlite3');
    const liveDatabaseBefore = await fs.readFile(liveDatabasePath);
    const backupDatabasePath = path.join(backup.backupDirectory, 'task-monki.sqlite3');
    const newerSchemaVersion = APP_DATABASE_SCHEMA_VERSION + 1;

    if (process.platform !== 'win32') await fs.chmod(backupDatabasePath, 0o600);
    const newerDatabase = new DatabaseSync(backupDatabasePath);
    try {
      newerDatabase.exec(`PRAGMA user_version = ${newerSchemaVersion}`);
    } finally {
      newerDatabase.close();
    }
    await expect(
      AppDatabase.verifyFile(backupDatabasePath, {
        expectedApplicationId: APP_DATABASE_APPLICATION_ID,
        expectedSchemaVersion: newerSchemaVersion
      })
    ).resolves.toMatchObject({ schemaVersion: newerSchemaVersion });

    const databaseBytes = await fs.readFile(backupDatabasePath);
    const manifestPath = path.join(backup.backupDirectory, 'manifest.json');
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, 'utf8')
    ) as typeof backup.manifest;
    manifest.database.schemaVersion = newerSchemaVersion;
    manifest.database.byteCount = databaseBytes.byteLength;
    manifest.database.sha256 = createHash('sha256').update(databaseBytes).digest('hex');
    if (process.platform !== 'win32') await fs.chmod(manifestPath, 0o600);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const recovery = new BackupRestoreService({
      storageRoot,
      backupsRoot,
      applicationId: APP_DATABASE_APPLICATION_ID,
      assertRestoreAllowed: async () => {
        if (!databaseClosed) throw new Error('Database is still open.');
      }
    });
    const verificationError = await recovery
      .verifyBackup(backup.manifest.backupId)
      .catch((error: unknown) => error);
    expect(verificationError).toMatchObject({ code: 'BACKUP_INVALID' });
    expect((verificationError as Error).message).toContain('newer than supported');
    const entriesBeforeRestore = await fs.readdir(temporaryRoot);

    await expect(recovery.restoreBackup(backup.manifest.backupId)).rejects.toMatchObject({
      code: 'BACKUP_INVALID',
      message: expect.stringContaining('newer than supported')
    });

    await expect(fs.readFile(liveDatabasePath)).resolves.toEqual(liveDatabaseBefore);
    await expect(fs.readdir(temporaryRoot)).resolves.toEqual(entriesBeforeRestore);
  }, 15_000);

  it('restores the previous root when staged activation fails before publication', async () => {
    await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    const backup = await service.createBackup();
    await closeDatabase();
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (
        String(source).includes('.restore-') &&
        path.resolve(String(destination)) === path.resolve(storageRoot)
      ) {
        throw new Error('simulated activation failure');
      }
      await rename(source, destination);
    });
    try {
      await expect(service.restoreBackup(backup.manifest.backupId)).rejects.toThrow(
        'simulated activation failure'
      );
    } finally {
      renameSpy.mockRestore();
    }

    await expect(AppDatabase.verifyFile(path.join(storageRoot, 'task-monki.sqlite3'))).resolves
      .toBeDefined();
    expect((await fs.readdir(temporaryRoot)).filter((name) => name.includes('pre-restore'))).toEqual(
      []
    );
  });

  it('retains exact recovery evidence and resumes the same backup after an interrupted swap', async () => {
    await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    const backup = await service.createBackup();
    const otherBackup = await service.createBackup();
    await closeDatabase();
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (
        path.resolve(String(destination)) === path.resolve(storageRoot) &&
        (String(source).includes('.restore-') || String(source).includes('pre-restore'))
      ) {
        throw new Error('simulated process interruption during activation');
      }
      await rename(source, destination);
    });
    try {
      await expect(service.restoreBackup(backup.manifest.backupId)).rejects.toMatchObject({
        code: 'RESTORE_ACTIVATION_AMBIGUOUS'
      });
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.stat(storageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const interruptedEntries = await fs.readdir(temporaryRoot);
    expect(interruptedEntries.some((name) => name.includes('.restore-'))).toBe(true);
    expect(interruptedEntries.some((name) => name.includes('pre-restore'))).toBe(true);
    await expect(
      service.restoreBackup(otherBackup.manifest.backupId)
    ).rejects.toMatchObject({ code: 'RESTORE_ACTIVATION_AMBIGUOUS' });

    const resumed = await service.restoreBackup(backup.manifest.backupId);

    expect(resumed.previousStoragePath).toContain('pre-restore');
    await expect(
      AppDatabase.verifyFile(path.join(storageRoot, 'task-monki.sqlite3'), {
        expectedApplicationId: APP_DATABASE_APPLICATION_ID,
        expectedSchemaVersion: backup.manifest.database.schemaVersion
      })
    ).resolves.toBeDefined();
    expect((await fs.readdir(temporaryRoot)).filter((name) => name.includes('.restore-'))).toEqual(
      []
    );
  });

  it.runIf(process.platform !== 'win32')(
    'retains the recovery marker until a live activation parent sync succeeds',
    async () => {
      await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
      const backup = await service.createBackup();
      await closeDatabase();

      const originalRename = fs.rename.bind(fs);
      const originalOpen = fs.open.bind(fs);
      let activationPublished = false;
      let parentSyncFailuresRemaining = 2;
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        await originalRename(source, destination);
        if (
          String(source).includes('.restore-') &&
          path.resolve(String(destination)) === path.resolve(storageRoot)
        ) {
          activationPublished = true;
        }
      });
      const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (
          activationPublished &&
          parentSyncFailuresRemaining > 0 &&
          path.resolve(String(filePath)) === path.resolve(temporaryRoot)
        ) {
          parentSyncFailuresRemaining -= 1;
          vi.spyOn(handle, 'sync').mockRejectedValueOnce(
            new Error('simulated storage-parent sync failure')
          );
        }
        return handle;
      });
      try {
        await expect(service.restoreBackup(backup.manifest.backupId)).rejects.toMatchObject({
          code: 'RESTORE_ACTIVATION_AMBIGUOUS'
        });
        await expect(
          fs.stat(path.join(storageRoot, '.task-monki-restore-intent.json'))
        ).resolves.toBeDefined();

        await expect(service.restoreBackup(backup.manifest.backupId)).rejects.toMatchObject({
          code: 'RESTORE_ACTIVATION_AMBIGUOUS'
        });
        await expect(
          fs.stat(path.join(storageRoot, '.task-monki-restore-intent.json'))
        ).resolves.toBeDefined();

        await expect(service.restoreBackup(backup.manifest.backupId)).resolves.toMatchObject({
          backupId: backup.manifest.backupId
        });
        await expect(
          fs.stat(path.join(storageRoot, '.task-monki-restore-intent.json'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        openSpy.mockRestore();
        renameSpy.mockRestore();
      }
    }
  );

  it('quarantines the complete storage root without creating an empty replacement', async () => {
    await closeDatabase();
    await fs.writeFile(path.join(storageRoot, 'task-monki.sqlite3-journal'), 'journal', {
      mode: 0o600
    });

    const result = await service.quarantineLiveStorage('SQLITE_CORRUPT');

    expect(result.reason).toBe('SQLITE_CORRUPT');
    await expect(fs.stat(storageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.readFile(path.join(result.quarantinePath, 'task-monki.sqlite3-journal'), 'utf8')
    ).resolves.toBe('journal');
    await expect(fs.stat(path.join(result.quarantinePath, 'task-monki.sqlite3'))).resolves
      .toBeDefined();
  });

  it.runIf(process.platform !== 'win32')('rejects symbolic links inside a backup', async () => {
    const reference = await addManagedFile('artifact-1', 'artifacts/run-1/output.txt', 'result');
    const backup = await service.createBackup();
    const backupFile = path.join(
      backup.backupDirectory,
      'files',
      ...reference.storageKey.split('/')
    );
    await fs.unlink(backupFile);
    await fs.symlink(path.join(storageRoot, 'task-monki.sqlite3'), backupFile);

    await expect(service.verifyBackup(backup.manifest.backupId)).rejects.toBeInstanceOf(
      BackupRestoreError
    );
  });

  async function addManagedFile(
    id: string,
    storageKey: string,
    contents: string,
    state: 'LIVE' | 'GC_PENDING' = 'LIVE'
  ): Promise<ManagedFileReference> {
    const reference = await files.publish(storageKey, Buffer.from(contents));
    const timestamp = '2026-08-29T10:00:00.000Z';
    await database.write((transaction) => {
      transaction.run(
        String.raw`
          INSERT INTO managed_files (
            id, domain, owner_id, role, storage_key, content_sha256, byte_count,
            media_type, state, record_revision, created_at, updated_at
          ) VALUES (?, 'TASK', 'task-1', 'ARTIFACT', ?, ?, ?, 'text/plain',
                    ?, 0, ?, ?)
        `,
        [
          id,
          reference.storageKey,
          reference.sha256,
          reference.byteCount,
          state,
          timestamp,
          timestamp
        ]
      );
    });
    return reference;
  }

  async function closeDatabase(): Promise<void> {
    await database.close();
    databaseClosed = true;
  }
});
