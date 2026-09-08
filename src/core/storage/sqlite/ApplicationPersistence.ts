import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskAgentRuntimeAccess } from '../../agent/AgentRuntimeStore';
import { SqliteDesignDraftStore } from '../../design/DesignDraftStore';
import {
  PreviewPrivateVault,
  type PreviewSecretProtector
} from '../../preview/private/PreviewPrivateVault';
import { AppSettingsStore } from '../../settings/AppSettingsStore';
import { ensurePrivateDirectory } from '../../filesystem/secureFilesystem';
import {
  acquireStoreOwnershipLease,
  assertStoreOwnershipLease,
  releaseStoreOwnershipLease,
  type StoreOwnershipLease
} from '../StoreOwnershipLease';
import { SqliteAgentRuntimeStore } from '../SqliteAgentRuntimeStore';
import { SqliteTaskStore } from '../SqliteTaskStore';
import { AppDatabase } from './AppDatabase';
import {
  assertNoInterruptedRestore,
  BackupRestoreService,
  type QuarantineResult,
  type RestoreResult,
  type VerifiedBackup
} from './BackupRestoreService';
import { APP_DATABASE_APPLICATION_ID } from './DatabaseMigrations';
import { ManagedFileStore } from './ManagedFileStore';
import { SqliteDiscourseStore } from './SqliteDiscourseStore';
import { SqlitePersistenceError } from './SqliteErrors';

const STORAGE_DIRECTORY = 'storage';
const BACKUPS_DIRECTORY = 'backups';
const DATABASE_FILE = 'task-monki.sqlite3';
const OWNERSHIP_LEASE_FILE = '.task-monki-storage.owner.lock';
const DURABLE_STORAGE_WITHOUT_DATABASE = new Set([
  'files',
  'protocol-journals',
  'design-repositories',
  `${DATABASE_FILE}-journal`,
  `${DATABASE_FILE}-wal`,
  `${DATABASE_FILE}-shm`
]);

export interface ApplicationPersistencePaths {
  profileRoot: string;
  storageRoot: string;
  databasePath: string;
  managedFilesRoot: string;
  protocolJournalRoot: string;
  designRepositoryRoot: string;
  designWorktreeRoot: string;
  backupsRoot: string;
  ownershipLeasePath: string;
}

export interface OpenApplicationPersistenceOptions {
  profileRoot: string;
  appVersion: string;
  previewSecretProtector?: PreviewSecretProtector;
  /** Isolated tests only. Production and recovery must share the profile lease. */
  acquireLease?: boolean;
}

/**
 * Owns all authoritative local persistence for one application profile.
 * Stores share one connection so cross-domain mutations can use one SQLite
 * transaction. Filesystem services own only their explicit byte roots.
 */
export class ApplicationPersistence {
  readonly database: AppDatabase;
  readonly managedFiles: ManagedFileStore;
  readonly tasks: SqliteTaskStore;
  readonly agentRuntime: SqliteAgentRuntimeStore;
  readonly taskRuntime: TaskAgentRuntimeAccess;
  readonly discourse: SqliteDiscourseStore;
  readonly settings: AppSettingsStore;
  readonly designDrafts: SqliteDesignDraftStore;
  readonly previewPrivateVault?: PreviewPrivateVault;
  readonly backups: BackupRestoreService;

  private closeWork?: Promise<void>;

  private constructor(
    readonly paths: ApplicationPersistencePaths,
    private readonly ownershipLease: StoreOwnershipLease | undefined,
    resources: {
      database: AppDatabase;
      managedFiles: ManagedFileStore;
      tasks: SqliteTaskStore;
      agentRuntime: SqliteAgentRuntimeStore;
      taskRuntime: TaskAgentRuntimeAccess;
      discourse: SqliteDiscourseStore;
      settings: AppSettingsStore;
      designDrafts: SqliteDesignDraftStore;
      previewPrivateVault?: PreviewPrivateVault;
      backups: BackupRestoreService;
    }
  ) {
    this.database = resources.database;
    this.managedFiles = resources.managedFiles;
    this.tasks = resources.tasks;
    this.agentRuntime = resources.agentRuntime;
    this.taskRuntime = resources.taskRuntime;
    this.discourse = resources.discourse;
    this.settings = resources.settings;
    this.designDrafts = resources.designDrafts;
    this.previewPrivateVault = resources.previewPrivateVault;
    this.backups = resources.backups;
  }

  static async open(
    options: OpenApplicationPersistenceOptions
  ): Promise<ApplicationPersistence> {
    if (!options.appVersion.trim()) {
      throw new Error('Application version must not be empty.');
    }
    const paths = resolveApplicationPersistencePaths(options.profileRoot);
    await ensurePrivateDirectory(paths.profileRoot);
    const ownershipLease =
      options.acquireLease === false
        ? undefined
        : await acquireStoreOwnershipLease(
            paths.profileRoot,
            paths.ownershipLeasePath
          );
    let database: AppDatabase | undefined;
    try {
      await assertNoInterruptedRestore(paths.storageRoot);
      await assertDatabaseInitializationIsSafe(paths);
      const managedFiles = new ManagedFileStore(paths.managedFilesRoot);
      await managedFiles.init();
      await managedFiles.cleanupStaleTemporaryFiles();
      database = await AppDatabase.open(paths.databasePath, {
        acquireLease: false,
        ownershipLeasePath: paths.ownershipLeasePath,
        beforeSchemaUpgrade: async ({ database: upgrading }) => {
          const backup = createLiveBackupService(
            paths,
            options.appVersion,
            upgrading,
            managedFiles
          );
          try {
            await backup.createBackup('PRE_UPGRADE');
          } finally {
            await backup.close();
          }
        }
      });
      database.checkIntegrity('quick');

      const tasks = new SqliteTaskStore(database, managedFiles);
      const agentRuntime = new SqliteAgentRuntimeStore(
        database,
        managedFiles,
        paths.protocolJournalRoot
      );
      const taskRuntime = agentRuntime.taskAgentRuntimeAccess(
        tasks.createAgentRuntimeEventSink()
      );
      tasks.bindAgentRuntime(taskRuntime);
      const discourse = new SqliteDiscourseStore(database);
      const settings = new AppSettingsStore(database);
      const designDrafts = new SqliteDesignDraftStore(database);
      const previewPrivateVault = options.previewSecretProtector
        ? new PreviewPrivateVault(database, managedFiles, options.previewSecretProtector)
        : undefined;
      const backups = createLiveBackupService(
        paths,
        options.appVersion,
        database,
        managedFiles,
        () => agentRuntime.flushProtocolJournals()
      );

      const persistence = new ApplicationPersistence(paths, ownershipLease, {
        database,
        managedFiles,
        tasks,
        agentRuntime,
        taskRuntime,
        discourse,
        settings,
        designDrafts,
        previewPrivateVault,
        backups
      });
      try {
        await Promise.all([
          agentRuntime.init(),
          discourse.init(),
          designDrafts.init(),
          settings.get()
        ]);
      } catch (error) {
        await Promise.allSettled([
          previewPrivateVault?.shutdown(),
          discourse.close(),
          agentRuntime.close(),
          tasks.close()
        ]);
        throw error;
      }
      return persistence;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      await database?.close().catch((closeError) => cleanupErrors.push(closeError));
      if (ownershipLease) {
        await releaseStoreOwnershipLease(
          paths.profileRoot,
          paths.ownershipLeasePath,
          ownershipLease
        ).catch((releaseError) => cleanupErrors.push(releaseError));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'Application persistence failed to open and cleanup was incomplete.'
        );
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.closeWork ??= this.closeResources();
    return this.closeWork;
  }

  private async closeResources(): Promise<void> {
    const resourceErrors: unknown[] = [];
    try {
      // Backup owns a managed-file deletion barrier and reads both journals and
      // SQLite, so it must finish before any of those owners begin shutdown.
      await this.backups.close();
    } catch (error) {
      resourceErrors.push(error);
    }
    const results = await Promise.allSettled([
      this.previewPrivateVault?.shutdown(),
      this.discourse.close(),
      this.agentRuntime.close(),
      this.tasks.close()
    ]);
    resourceErrors.push(...results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason));
    try {
      // Flush every database operation admitted by a store before draining
      // filesystem work scheduled by its commit callbacks.
      await this.database.read(() => undefined);
    } catch (error) {
      resourceErrors.push(error);
    }
    try {
      await this.managedFiles.drain();
    } catch (error) {
      resourceErrors.push(error);
    }
    try {
      await this.database.close();
    } catch (error) {
      resourceErrors.push(error);
    }
    if (this.ownershipLease) {
      try {
        await releaseStoreOwnershipLease(
          this.paths.profileRoot,
          this.paths.ownershipLeasePath,
          this.ownershipLease
        );
      } catch (error) {
        resourceErrors.push(error);
      }
    }
    if (resourceErrors.length > 0) {
      throw new AggregateError(
        resourceErrors,
        'Application persistence did not close cleanly.'
      );
    }
  }
}

/**
 * SQLite creates a missing or empty target as a new database. That behavior is
 * correct only for a new profile. If another durable storage owner remains,
 * silently creating a database would make the surviving bytes look orphaned
 * and eligible for cleanup.
 */
async function assertDatabaseInitializationIsSafe(
  paths: ApplicationPersistencePaths
): Promise<void> {
  const storage = await lstatIfExists(paths.storageRoot);
  if (!storage) return;
  if (storage.isSymbolicLink() || !storage.isDirectory()) {
    throw corruptStartup(
      'Task Monki storage is not a safe directory. Preserve it for explicit recovery.'
    );
  }

  const database = await lstatIfExists(paths.databasePath);
  if (database) {
    if (database.isFile() && database.size === 0) {
      throw corruptStartup(
        'The Task Monki database is empty. Preserve storage and use explicit recovery.'
      );
    }
    return;
  }

  const entries = await fs.readdir(paths.storageRoot);
  const residue: string[] = [];
  for (const entry of entries) {
    if (!DURABLE_STORAGE_WITHOUT_DATABASE.has(entry)) continue;
    const candidate = path.join(paths.storageRoot, entry);
    if (entry.startsWith(`${DATABASE_FILE}-`) || await containsDurableEntry(candidate)) {
      residue.push(entry);
    }
  }
  if (residue.length > 0) {
    throw corruptStartup(
      `The Task Monki database is missing while durable storage remains: ${residue.sort().join(', ')}. Preserve storage and use explicit recovery.`
    );
  }
}

async function containsDurableEntry(candidate: string): Promise<boolean> {
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  for (const entry of await fs.readdir(candidate)) {
    if (await containsDurableEntry(path.join(candidate, entry))) return true;
  }
  return false;
}

function corruptStartup(message: string): SqlitePersistenceError {
  return new SqlitePersistenceError(message, { kind: 'CORRUPT' });
}

async function lstatIfExists(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Offline recovery owner. It holds the same profile-level lease as the live
 * database for the full quarantine or restore operation.
 */
export class ApplicationPersistenceRecovery {
  readonly paths: ApplicationPersistencePaths;

  constructor(
    profileRoot: string,
    appVersion: string
  ) {
    this.paths = resolveApplicationPersistencePaths(profileRoot);
    if (!appVersion.trim()) throw new Error('Application version must not be empty.');
  }

  verifyBackup(backupId: string): Promise<VerifiedBackup> {
    return this.recoveryService(async () => undefined).verifyBackup(backupId);
  }

  restoreBackup(backupId: string): Promise<RestoreResult> {
    return this.withOwnership((service) => service.restoreBackup(backupId));
  }

  quarantineLiveStorage(reason: string): Promise<QuarantineResult> {
    return this.withOwnership((service) => service.quarantineLiveStorage(reason));
  }

  private async withOwnership<T>(
    operation: (service: BackupRestoreService) => Promise<T>
  ): Promise<T> {
    await ensurePrivateDirectory(this.paths.profileRoot);
    const lease = await acquireStoreOwnershipLease(
      this.paths.profileRoot,
      this.paths.ownershipLeasePath
    );
    const assertOwnership = () =>
      assertStoreOwnershipLease(this.paths.ownershipLeasePath, lease);
    try {
      return await operation(this.recoveryService(assertOwnership));
    } finally {
      await releaseStoreOwnershipLease(
        this.paths.profileRoot,
        this.paths.ownershipLeasePath,
        lease
      );
    }
  }

  private recoveryService(
    assertRestoreAllowed: () => Promise<void>
  ): BackupRestoreService {
    return new BackupRestoreService({
      storageRoot: this.paths.storageRoot,
      backupsRoot: this.paths.backupsRoot,
      applicationId: APP_DATABASE_APPLICATION_ID,
      assertRestoreAllowed
    });
  }
}

export function resolveApplicationPersistencePaths(
  profileRoot: string
): ApplicationPersistencePaths {
  if (!profileRoot.trim()) throw new Error('Application profile root must not be empty.');
  const resolvedProfileRoot = path.resolve(profileRoot);
  if (path.dirname(resolvedProfileRoot) === resolvedProfileRoot) {
    throw new Error('Application persistence cannot own a filesystem root.');
  }
  const storageRoot = path.join(resolvedProfileRoot, STORAGE_DIRECTORY);
  return {
    profileRoot: resolvedProfileRoot,
    storageRoot,
    databasePath: path.join(storageRoot, DATABASE_FILE),
    managedFilesRoot: path.join(storageRoot, 'files'),
    protocolJournalRoot: path.join(storageRoot, 'protocol-journals'),
    designRepositoryRoot: path.join(storageRoot, 'design-repositories'),
    designWorktreeRoot: path.join(storageRoot, 'design-worktrees'),
    backupsRoot: path.join(resolvedProfileRoot, BACKUPS_DIRECTORY),
    ownershipLeasePath: path.join(resolvedProfileRoot, OWNERSHIP_LEASE_FILE)
  };
}

function createLiveBackupService(
  paths: ApplicationPersistencePaths,
  appVersion: string,
  database: AppDatabase,
  managedFiles: ManagedFileStore,
  flushProtocolJournals?: () => Promise<void>
): BackupRestoreService {
  return new BackupRestoreService({
    storageRoot: paths.storageRoot,
    backupsRoot: paths.backupsRoot,
    applicationId: APP_DATABASE_APPLICATION_ID,
    appVersion,
    database,
    managedFiles,
    flushProtocolJournals,
    assertRestoreAllowed: async () => {
      throw new Error('Close application persistence before restoring a backup.');
    }
  });
}
