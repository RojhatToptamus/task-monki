import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignSourceService, DESIGN_REPOSITORY_MARKER } from '../../design/DesignSourceService';
import { git } from '../../git/gitCli';
import { createDomainEvent } from '../domainEvent';
import { addTestRepository } from '../../../testSupport/repositoryFixture';
import { createScriptedAgentRuntimeFixture } from '../../../testSupport/taskMonkiScenario';
import {
  acquireStoreOwnershipLease,
  releaseStoreOwnershipLease
} from '../StoreOwnershipLease';
import {
  ApplicationPersistence,
  ApplicationPersistenceRecovery,
  resolveApplicationPersistencePaths
} from './ApplicationPersistence';

const opened = new Set<ApplicationPersistence>();

afterEach(async () => {
  const instances = [...opened];
  opened.clear();
  await Promise.allSettled(instances.map((instance) => instance.close()));
});

async function open(profileRoot: string): Promise<ApplicationPersistence> {
  const persistence = await ApplicationPersistence.open({
    profileRoot,
    appVersion: 'test-1.0.0'
  });
  opened.add(persistence);
  return persistence;
}

async function close(persistence: ApplicationPersistence): Promise<void> {
  opened.delete(persistence);
  await persistence.close();
}

describe('ApplicationPersistence', () => {
  it('owns one database and one profile lease for every persistence facade', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-application-persistence-')
    );
    const persistence = await open(profileRoot);

    await Promise.all([
      persistence.tasks.init(),
      persistence.agentRuntime.init(),
      persistence.discourse.init(),
      persistence.designDrafts.init(),
      persistence.settings.get()
    ]);
    await expect(
      ApplicationPersistence.open({ profileRoot, appVersion: 'test-1.0.0' })
    ).rejects.toThrow('already owned');

    expect(persistence.paths.databasePath).toBe(
      path.join(profileRoot, 'storage-v2', 'task-monki.sqlite3')
    );
    expect(persistence.managedFiles.rootPath).toBe(
      path.join(profileRoot, 'storage-v2', 'files')
    );
    expect(persistence.paths.designWorktreeRoot).toBe(
      path.join(profileRoot, 'storage-v2', 'design-worktrees')
    );
    expect(persistence.taskRuntime).toBeDefined();
    expect(persistence.database.checkIntegrity('quick')).toMatchObject({ mode: 'quick' });
  });

  it('acquires the profile lease before creating or cleaning managed storage', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-persistence-lease-first-')
    );
    const paths = resolveApplicationPersistencePaths(profileRoot);
    const lease = await acquireStoreOwnershipLease(
      paths.profileRoot,
      paths.ownershipLeasePath
    );
    try {
      await expect(
        ApplicationPersistence.open({ profileRoot, appVersion: 'test-1.0.0' })
      ).rejects.toThrow('already owned');
      await expect(fs.stat(paths.storageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await releaseStoreOwnershipLease(
        paths.profileRoot,
        paths.ownershipLeasePath,
        lease
      );
    }
  });

  it.each([
    'files',
    'protocol-journals',
    'design-repositories',
    'task-monki.sqlite3-journal',
    'task-monki.sqlite3-wal',
    'task-monki.sqlite3-shm'
  ])('refuses to replace %s residue with a new database', async (residueName) => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-missing-database-')
    );
    const paths = resolveApplicationPersistencePaths(profileRoot);
    await fs.mkdir(paths.storageRoot, { mode: 0o700 });
    const residuePath = path.join(paths.storageRoot, residueName);
    const isDirectory = !residueName.startsWith('task-monki.sqlite3-');
    const preservedPath = isDirectory
      ? path.join(residuePath, 'preserve-me')
      : residuePath;
    if (isDirectory) await fs.mkdir(residuePath, { mode: 0o700 });
    await fs.writeFile(preservedPath, 'durable residue', { mode: 0o600 });

    await expect(
      ApplicationPersistence.open({ profileRoot, appVersion: 'test-1.0.0' })
    ).rejects.toMatchObject({ kind: 'CORRUPT' });

    await expect(fs.stat(paths.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(preservedPath, 'utf8')).resolves.toBe('durable residue');
  });

  it('refuses an empty database without changing it or surviving durable files', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-empty-database-')
    );
    const paths = resolveApplicationPersistencePaths(profileRoot);
    await fs.mkdir(paths.managedFilesRoot, { recursive: true, mode: 0o700 });
    const preservedPath = path.join(paths.managedFilesRoot, 'preserve-me');
    await fs.writeFile(paths.databasePath, Buffer.alloc(0), { mode: 0o600 });
    await fs.writeFile(preservedPath, 'durable bytes', { mode: 0o600 });

    await expect(
      ApplicationPersistence.open({ profileRoot, appVersion: 'test-1.0.0' })
    ).rejects.toMatchObject({ kind: 'CORRUPT' });

    await expect(fs.stat(paths.databasePath)).resolves.toMatchObject({ size: 0 });
    await expect(fs.readFile(preservedPath, 'utf8')).resolves.toBe('durable bytes');
  });

  it('recovers a fresh profile whose first startup left only empty storage directories', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-empty-startup-skeleton-')
    );
    const paths = resolveApplicationPersistencePaths(profileRoot);
    await fs.mkdir(paths.managedFilesRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.protocolJournalRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.designRepositoryRoot, { recursive: true, mode: 0o700 });

    const persistence = await open(profileRoot);

    await expect(fs.stat(paths.databasePath)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(persistence.settings.get()).resolves.toBeDefined();
  });

  it('commits and rolls back Task and settings changes as one transaction', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-cross-domain-transaction-')
    );
    const persistence = await open(profileRoot);
    const repositoryPath = path.join(profileRoot, 'repository');
    await fs.mkdir(repositoryPath);
    await persistence.tasks.init();
    await persistence.settings.get();

    await expect(
      persistence.database.write(async () => {
        await persistence.tasks.addRepository({
          path: repositoryPath,
          root: repositoryPath,
          status: 'VALID',
          headSha: 'a'.repeat(40),
          branch: 'main',
          remotes: [],
          checkedAt: new Date(0).toISOString()
        });
        await persistence.settings.update({ showMascot: false });
        throw new Error('roll back both owners');
      })
    ).rejects.toThrow('roll back both owners');

    await expect(persistence.tasks.snapshot()).resolves.toMatchObject({ repositories: [] });
    await expect(persistence.settings.get()).resolves.toMatchObject({ showMascot: true });

    await persistence.database.write(async () => {
      await persistence.tasks.addRepository({
        path: repositoryPath,
        root: repositoryPath,
        status: 'VALID',
        headSha: 'b'.repeat(40),
        branch: 'main',
        remotes: [],
        checkedAt: new Date(0).toISOString()
      });
      await persistence.settings.update({ showMascot: false });
    });

    await expect(persistence.tasks.snapshot()).resolves.toMatchObject({
      repositories: [expect.objectContaining({ path: repositoryPath })]
    });
    await expect(persistence.settings.get()).resolves.toMatchObject({ showMascot: false });
  });

  it('orders Task serialization before runtime event transactions', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-runtime-task-lock-order-')
    );
    const persistence = await open(profileRoot);
    const task = await persistence.tasks.createTask({
      title: 'Lock order',
      prompt: 'Keep Task and runtime persistence free of lock inversion.',
      repositoryId: (await addTestRepository(persistence.tasks, profileRoot)).id
    });
    const ownership = await persistence.tasks.createIterationAndWorktree({
      task,
      branchName: 'codex/lock-order',
      worktreePath: path.join(profileRoot, 'worktree'),
      baseSha: 'base'
    });
    const scripted = createScriptedAgentRuntimeFixture(persistence);
    const session = await scripted.createSession({ task, ...ownership });
    const run = await scripted.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await persistence.taskRuntime.updateRun(
      run.id,
      { status: 'STARTING', providerTurnId: 'lock-order-turn' },
      'lock-order:start'
    );

    let releaseTaskMutation!: () => void;
    let signalTaskMutation!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      releaseTaskMutation = resolve;
    });
    const taskMutationEntered = new Promise<void>((resolve) => {
      signalTaskMutation = resolve;
    });
    const taskMutation = persistence.tasks.serializePersistenceMutation(async () => {
      signalTaskMutation();
      await taskGate;
      await persistence.settings.update({ showMascot: false });
    });
    await taskMutationEntered;

    const applyEvent = persistence.taskRuntime.applyTaskRuntimeEvent(
      createDomainEvent({
        type: 'PROCESS_STARTED',
        taskId: task.id,
        iterationId: ownership.iteration.id,
        runId: run.id,
        source: 'process',
        payload: {}
      }),
      'lock-order:apply'
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseTaskMutation();

    await expect(Promise.all([taskMutation, applyEvent])).resolves.toEqual([
      undefined,
      undefined
    ]);
    await expect(persistence.taskRuntime.getRun(run.id)).resolves.toMatchObject({
      status: 'RUNNING'
    });
    await expect(persistence.settings.get()).resolves.toMatchObject({ showMascot: false });
  });

  it('keeps Task projections read-only in SQLite', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-read-only-projections-')
    );
    const persistence = await open(profileRoot);
    await persistence.tasks.init();
    await persistence.agentRuntime.init();
    const before = await persistence.database.read((reader) =>
      reader.get<{ changes: number | bigint; revision: number | bigint | null }>(
        `SELECT total_changes() AS changes,
                (SELECT record_revision FROM store_metadata WHERE domain = 'TASK') AS revision`
      )
    );

    await persistence.tasks.snapshot();
    await persistence.tasks.getBoardSnapshot();
    await persistence.tasks.listDesigns();
    await persistence.tasks.snapshot();

    const after = await persistence.database.read((reader) =>
      reader.get<{ changes: number | bigint; revision: number | bigint | null }>(
        `SELECT total_changes() AS changes,
                (SELECT record_revision FROM store_metadata WHERE domain = 'TASK') AS revision`
      )
    );
    expect(after).toEqual(before);
  });

  it('drains managed-file deletion before releasing profile ownership', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-close-managed-drain-')
    );
    const persistence = await open(profileRoot);
    const reference = await persistence.managedFiles.publish(
      'task/artifacts/close-drain/revision-1.txt',
      Buffer.from('retire before handoff')
    );
    const filePath = await persistence.managedFiles.resolveVerifiedPath(reference);
    const barrier = await persistence.managedFiles.beginDeletionBarrier();
    const deletion = persistence.managedFiles.deleteAfterReferenceCommit(
      reference.storageKey
    );
    opened.delete(persistence);
    let closed = false;
    const closing = persistence.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(closed).toBe(false);
    await expect(
      ApplicationPersistence.open({ profileRoot, appVersion: 'test-1.0.0' })
    ).rejects.toThrow('already owned');
    await expect(fs.stat(filePath)).resolves.toBeDefined();

    barrier.release();
    await expect(Promise.all([closing, deletion])).resolves.toEqual([
      undefined,
      'DELETED'
    ]);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const nextOwner = await open(profileRoot);
    await expect(nextOwner.database.read(() => true)).resolves.toBe(true);
  });

  it('waits for an admitted backup before closing the database or releasing ownership', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-close-active-backup-')
    );
    const persistence = await open(profileRoot);
    await persistence.settings.update({ showMascot: false });

    const originalBackup = persistence.database.backup.bind(persistence.database);
    let signalBackupStarted!: () => void;
    let releaseBackup!: () => void;
    const backupStarted = new Promise<void>((resolve) => {
      signalBackupStarted = resolve;
    });
    const backupGate = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    const backupSpy = vi
      .spyOn(persistence.database, 'backup')
      .mockImplementation(async (destinationPath) => {
        signalBackupStarted();
        await backupGate;
        await originalBackup(destinationPath);
      });

    const backup = persistence.backups.createBackup();
    await backupStarted;
    let closed = false;
    const closing = persistence.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    try {
      expect(closed).toBe(false);
      await expect(
        ApplicationPersistence.open({ profileRoot, appVersion: 'test-1.0.0' })
      ).rejects.toThrow('already owned');
    } finally {
      releaseBackup();
    }
    await expect(backup).resolves.toMatchObject({
      manifest: { purpose: 'MANUAL' }
    });
    await expect(closing).resolves.toBeUndefined();
    backupSpy.mockRestore();
    opened.delete(persistence);

    const nextOwner = await open(profileRoot);
    await expect(nextOwner.settings.get()).resolves.toMatchObject({ showMascot: false });
  });

  it('creates a verified backup and restores it under the offline profile lease', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-application-restore-')
    );
    let persistence = await open(profileRoot);
    await persistence.settings.update({ showMascot: false });
    const backup = await persistence.backups.createBackup();
    await persistence.settings.update({ showMascot: true });
    await close(persistence);

    const recovery = new ApplicationPersistenceRecovery(profileRoot, 'test-1.0.0');
    await expect(recovery.verifyBackup(backup.manifest.backupId)).resolves.toEqual(backup);
    await expect(recovery.restoreBackup(backup.manifest.backupId)).resolves.toMatchObject({
      backupId: backup.manifest.backupId,
      previousStoragePath: expect.any(String)
    });

    persistence = await open(profileRoot);
    await expect(persistence.settings.get()).resolves.toMatchObject({ showMascot: false });
    expect(persistence.database.checkIntegrity('full')).toMatchObject({ mode: 'full' });
  });

  it('fails closed before creating storage and resumes an interrupted restore offline', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-interrupted-application-restore-')
    );
    let persistence = await open(profileRoot);
    await persistence.settings.update({ showMascot: false });
    const backup = await persistence.backups.createBackup();
    await persistence.settings.update({ showMascot: true });
    const paths = persistence.paths;
    await close(persistence);

    const recovery = new ApplicationPersistenceRecovery(profileRoot, 'test-1.0.0');
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (
        path.resolve(String(destination)) === path.resolve(paths.storageRoot) &&
        (String(source).includes('.restore-') || String(source).includes('pre-restore'))
      ) {
        throw new Error('simulated process interruption during activation');
      }
      await rename(source, destination);
    });
    try {
      await expect(recovery.restoreBackup(backup.manifest.backupId)).rejects.toMatchObject({
        code: 'RESTORE_ACTIVATION_AMBIGUOUS'
      });
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.stat(paths.storageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      ApplicationPersistence.open({ profileRoot, appVersion: 'test-1.0.0' })
    ).rejects.toMatchObject({ code: 'RESTORE_ACTIVATION_AMBIGUOUS' });
    // Startup must not let ManagedFileStore or AppDatabase turn the swap gap
    // into a new empty authoritative profile.
    await expect(fs.stat(paths.storageRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(recovery.restoreBackup(backup.manifest.backupId)).resolves.toMatchObject({
      backupId: backup.manifest.backupId,
      previousStoragePath: expect.any(String)
    });
    persistence = await open(profileRoot);
    await expect(persistence.settings.get()).resolves.toMatchObject({ showMascot: false });
  });

  it('restores journals and managed Design Git history but not ephemeral worktrees', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-complete-application-backup-')
    );
    let persistence = await open(profileRoot);
    const source = new DesignSourceService({
      repositoryRoot: persistence.paths.designRepositoryRoot,
      worktreeRoot: persistence.paths.designWorktreeRoot
    });
    const creationToken = 'design-backup-token-0001';
    const repository = await source.prepareBlankRepository({ creationToken });
    const created = await persistence.tasks.createDesignBundle({
      request: { brief: 'Preserve this Design source.', creationToken },
      repository
    });
    await git(repository.path, [
      'update-ref',
      'refs/task-monki/preserved',
      repository.headSha
    ]);
    await fs.mkdir(persistence.paths.designWorktreeRoot, { recursive: true });
    await fs.writeFile(
      path.join(persistence.paths.designWorktreeRoot, 'ephemeral.txt'),
      'do not restore',
      { mode: 0o600 }
    );

    const server = await persistence.agentRuntime.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: '/usr/local/bin/codex',
      argv: ['app-server', '--stdio']
    });
    await persistence.agentRuntime.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"event":"persist-me"}'
    );

    const backup = await persistence.backups.createBackup();
    expect(backup.manifest.protocolJournals).toHaveLength(1);
    expect(backup.manifest.designRepositories).toEqual([
      expect.objectContaining({
        repositoryId: repository.id,
        refs: expect.arrayContaining([
          { name: 'refs/task-monki/preserved', objectId: repository.headSha }
        ])
      })
    ]);
    await close(persistence);

    const recovery = new ApplicationPersistenceRecovery(profileRoot, 'test-1.0.0');
    await recovery.restoreBackup(backup.manifest.backupId);
    persistence = await open(profileRoot);

    const restoredRepositoryPath = path.join(
      persistence.paths.designRepositoryRoot,
      repository.id
    );
    await expect(
      git(restoredRepositoryPath, [
        'rev-parse',
        '--verify',
        'refs/task-monki/preserved'
      ])
    ).resolves.toBe(`${repository.headSha}\n`);
    await expect(
      fs.readFile(path.join(restoredRepositoryPath, DESIGN_REPOSITORY_MARKER), 'utf8')
    ).resolves.toContain(repository.id);
    await expect(fs.readdir(persistence.paths.designWorktreeRoot)).resolves.toEqual([]);
    await expect(
      fs.readFile(path.join(persistence.paths.protocolJournalRoot, `${server.id}.ndjson`), 'utf8')
    ).resolves.toContain('persist-me');
    await expect(persistence.tasks.getDesignDetail(created.task.id)).resolves.toMatchObject({
      task: { id: created.task.id }
    });
  }, 20_000);

  it('fails closed on corrupt SQLite, then quarantines and restores explicitly', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-corrupt-application-recovery-')
    );
    let persistence = await open(profileRoot);
    await persistence.settings.update({ showMascot: false });
    const backup = await persistence.backups.createBackup();
    const databasePath = persistence.paths.databasePath;
    await close(persistence);
    if (process.platform !== 'win32') await fs.chmod(databasePath, 0o600);
    await fs.writeFile(databasePath, 'not a sqlite database', { mode: 0o600 });

    await expect(
      ApplicationPersistence.open({ profileRoot, appVersion: 'test-1.0.0' })
    ).rejects.toThrow();
    await expect(fs.readFile(databasePath, 'utf8')).resolves.toBe('not a sqlite database');

    const recovery = new ApplicationPersistenceRecovery(profileRoot, 'test-1.0.0');
    const quarantine = await recovery.quarantineLiveStorage('SQLITE_CORRUPT');
    await expect(
      fs.readFile(path.join(quarantine.quarantinePath, 'task-monki.sqlite3'), 'utf8')
    ).resolves.toBe('not a sqlite database');
    await expect(fs.stat(path.join(profileRoot, 'storage-v2'))).rejects.toMatchObject({
      code: 'ENOENT'
    });

    await expect(recovery.verifyBackup(backup.manifest.backupId)).resolves.toEqual(backup);
    await expect(recovery.restoreBackup(backup.manifest.backupId)).resolves.toMatchObject({
      backupId: backup.manifest.backupId,
      previousStoragePath: undefined
    });
    persistence = await open(profileRoot);
    await expect(persistence.settings.get()).resolves.toMatchObject({ showMascot: false });
    expect(persistence.database.checkIntegrity('full')).toMatchObject({ mode: 'full' });
  });

  it('rejects a corrupt Design bundle before replacing live storage', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-corrupt-design-backup-')
    );
    let persistence = await open(profileRoot);
    const source = new DesignSourceService({
      repositoryRoot: persistence.paths.designRepositoryRoot,
      worktreeRoot: persistence.paths.designWorktreeRoot
    });
    const creationToken = 'design-corrupt-token-001';
    const repository = await source.prepareBlankRepository({ creationToken });
    await persistence.tasks.createDesignBundle({
      request: { brief: 'Keep the live source intact.', creationToken },
      repository
    });
    const backup = await persistence.backups.createBackup();
    const bundlePath = path.join(
      backup.backupDirectory,
      ...backup.manifest.designRepositories[0]!.bundle.relativePath.split('/')
    );
    if (process.platform !== 'win32') await fs.chmod(bundlePath, 0o600);
    await fs.writeFile(bundlePath, 'corrupt bundle', { mode: 0o600 });
    if (process.platform !== 'win32') await fs.chmod(bundlePath, 0o400);
    await close(persistence);

    const recovery = new ApplicationPersistenceRecovery(profileRoot, 'test-1.0.0');
    await expect(recovery.restoreBackup(backup.manifest.backupId)).rejects.toMatchObject({
      code: 'BACKUP_INVALID'
    });

    persistence = await open(profileRoot);
    await expect(
      git(repository.path, ['rev-parse', '--verify', 'HEAD'])
    ).resolves.toBe(`${repository.headSha}\n`);
    await expect(persistence.tasks.snapshot()).resolves.toMatchObject({
      repositories: [expect.objectContaining({ id: repository.id })]
    });
  });
});
