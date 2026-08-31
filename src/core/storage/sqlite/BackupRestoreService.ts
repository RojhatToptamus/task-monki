import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  captureManagedDesignRepository,
  restoreManagedDesignRepository,
  validateDesignRepositoryBackupMetadata,
  verifyManagedDesignRepositoryBackup,
  verifyRestoredManagedDesignRepository,
  type DesignGitReference,
  type DesignRepositoryBackupMetadata
} from '../../design/ManagedDesignRepositoryBackup';
import {
  enforcePosixMode,
  ensurePrivateDirectory,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  readPrivateFile,
  syncDirectoryIfSupported,
  writePrivateFileAtomically
} from '../../filesystem/secureFilesystem';
import {
  assertStorageKey,
  copyVerifiedPrivateFile,
  inspectPrivateImmutableFile,
  ManagedFileStore,
  type ManagedFileReference
} from './ManagedFileStore';
import { AppDatabase } from './AppDatabase';
import { APP_DATABASE_SCHEMA_VERSION } from './DatabaseMigrations';

const BACKUP_FORMAT = 'TASK_MONKI_COMPLETE_BACKUP';
const BACKUP_FORMAT_VERSION = 1;
const DATABASE_FILE = 'task-monki.sqlite3';
const MANIFEST_FILE = 'manifest.json';
const RESTORE_INTENT_FILE = '.task-monki-restore-intent.json';
const RESTORE_INTENT_FORMAT = 'TASK_MONKI_RESTORE_INTENT';
const RESTORE_INTENT_FORMAT_VERSION = 1;
const RESTORE_INTENT_MAX_BYTES = 16 * 1_024;
const MANIFEST_MAX_BYTES = 128 * 1_024 * 1_024;
const MAX_MANAGED_FILES = 1_000_000;
const MAX_PROTOCOL_JOURNAL_FILES = 10_000;
const MAX_PROTOCOL_JOURNAL_BYTES = 512 * 1_024 * 1_024 * 1_024;
const MAX_DESIGN_REPOSITORIES = 10_000;
const BACKUP_ID = /^backup-[0-9]{8}T[0-9]{9}Z-[0-9a-f-]{36}$/u;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RUNTIME_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PROTOCOL_JOURNAL_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\.([0-9]+))?\.ndjson$/u;

export interface BackupDatabaseInfo {
  applicationId: number;
  schemaVersion: number;
}

export interface BackupRestoreServiceOptions {
  storageRoot: string;
  backupsRoot: string;
  applicationId: number;
  appVersion: string;
  database: AppDatabase;
  managedFiles: ManagedFileStore;
  /** Flushes runtime-owned journal writers before their stable file copy. */
  flushProtocolJournals?: () => Promise<void>;
  /** Must reject unless all live database handles are closed and the profile lease is held. */
  assertRestoreAllowed: () => Promise<void>;
  now?: () => Date;
  createId?: () => string;
}

export interface BackupRecoveryServiceOptions {
  storageRoot: string;
  backupsRoot: string;
  applicationId: number;
  /** Must reject unless no live database handle owns the profile. */
  assertRestoreAllowed: () => Promise<void>;
  now?: () => Date;
  createId?: () => string;
}

export type BackupPurpose = 'MANUAL' | 'PRE_UPGRADE';

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  backupId: string;
  purpose: BackupPurpose;
  createdAt: string;
  appVersion: string;
  database: {
    relativePath: typeof DATABASE_FILE;
    applicationId: number;
    schemaVersion: number;
    byteCount: number;
    sha256: string;
  };
  managedFiles: ManagedFileReference[];
  protocolJournals: BackupProtocolJournal[];
  designRepositories: BackupDesignRepository[];
}

export interface BackupProtocolJournal {
  serverInstanceId: string;
  segment: number;
  relativePath: string;
  byteCount: number;
  sha256: string;
}

export interface BackupDesignRepository extends DesignRepositoryBackupMetadata {
  relativePath: string;
  marker: DesignRepositoryBackupMetadata['marker'] & { relativePath: string };
  bundle: DesignRepositoryBackupMetadata['bundle'] & { relativePath: string };
}

export interface VerifiedBackup {
  backupDirectory: string;
  manifest: BackupManifest;
}

export interface RestoreResult {
  backupId: string;
  restoredAt: string;
  previousStoragePath?: string;
}

export interface QuarantineResult {
  quarantinedAt: string;
  quarantinePath: string;
  reason: string;
}

interface RestoreIntent {
  format: typeof RESTORE_INTENT_FORMAT;
  formatVersion: typeof RESTORE_INTENT_FORMAT_VERSION;
  operationId: string;
  backupId: string;
  createdAt: string;
  stagingDirectory: string;
  previousStorageDirectory: string | null;
}

interface LocatedRestoreIntent {
  intent: RestoreIntent;
  location: 'LIVE' | 'STAGING';
  rootPath: string;
}

export class BackupRestoreError extends Error {
  readonly name = 'BackupRestoreError';

  constructor(
    readonly code:
      | 'BACKUP_INVALID'
      | 'BACKUP_CONFLICT'
      | 'BACKUP_PUBLICATION_AMBIGUOUS'
      | 'RESTORE_ACTIVATION_AMBIGUOUS'
      | 'STORAGE_NOT_FOUND',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/**
 * Creates and restores verified directory backups. The service intentionally
 * does not schedule, upload, compress, merge, or expire backups.
 */
export class BackupRestoreService {
  private readonly storageRoot: string;
  private readonly backupsRoot: string;
  private readonly applicationId: number;
  private readonly appVersion: string;
  private readonly database?: AppDatabase;
  private readonly managedFiles?: ManagedFileStore;
  private readonly flushProtocolJournals?: () => Promise<void>;
  private readonly assertRestoreAllowed: () => Promise<void>;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private queue: Promise<unknown> = Promise.resolve();
  private admissionClosed = false;
  private closeWork?: Promise<void>;

  constructor(options: BackupRestoreServiceOptions | BackupRecoveryServiceOptions) {
    this.storageRoot = path.resolve(options.storageRoot);
    this.backupsRoot = path.resolve(options.backupsRoot);
    this.applicationId = options.applicationId;
    this.appVersion = 'appVersion' in options ? options.appVersion : 'recovery-only';
    this.database = 'database' in options ? options.database : undefined;
    this.managedFiles = 'managedFiles' in options ? options.managedFiles : undefined;
    this.flushProtocolJournals =
      'flushProtocolJournals' in options ? options.flushProtocolJournals : undefined;
    this.assertRestoreAllowed = options.assertRestoreAllowed;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    if (!Number.isSafeInteger(this.applicationId) || this.applicationId <= 0) {
      throw new Error('Backup database application ID must be a positive integer.');
    }
    if (this.appVersion.trim().length === 0) {
      throw new Error('Backup application version must not be empty.');
    }
    if (pathsOverlap(this.storageRoot, this.backupsRoot)) {
      throw new Error('Backup, storage, and managed-file roots have unsafe ownership boundaries.');
    }
    if (this.managedFiles && this.managedFiles.rootPath !== path.join(this.storageRoot, 'files')) {
      throw new Error('Managed files must be owned by the live storage root.');
    }
  }

  createBackup(purpose: BackupPurpose = 'MANUAL'): Promise<VerifiedBackup> {
    return this.enqueue(async () => {
      const { database, managedFiles } = this.requireLiveResources();
      await ensurePrivateDirectory(this.backupsRoot);
      await managedFiles.init();
      const createdAt = this.now().toISOString();
      const backupId = createBackupId(createdAt, this.nextOperationId());
      const staging = path.join(
        this.backupsRoot,
        `.task-monki-backup-${this.nextOperationId()}.tmp`
      );
      const target = this.backupDirectory(backupId);
      if (await pathExists(target)) {
        throw new BackupRestoreError('BACKUP_CONFLICT', `Backup already exists: ${backupId}`);
      }
      await fs.mkdir(staging, { mode: 0o700 });
      await ensurePrivateDirectory(staging);
      const barrier = await managedFiles.beginDeletionBarrier();
      let published = false;
      try {
        await this.flushProtocolJournals?.();
        const databasePath = path.join(staging, DATABASE_FILE);
        await database.backup(databasePath);
        await enforcePosixMode(databasePath, 0o600);
        const databaseInfo = await verifyDatabaseSnapshot(
          databasePath,
          this.applicationId,
          database.schemaVersion
        );
        const references = normalizeReferences(
          await listLiveManagedFiles(databasePath)
        );

        for (const reference of references) {
          await managedFiles.copyVerifiedTo(
            reference,
            backupManagedFilePath(staging, reference.storageKey)
          );
        }

        const protocolJournals = await copyProtocolJournals({
          sourceRoot: path.join(this.storageRoot, 'protocol-journals'),
          backupRoot: staging,
          retainedServerIds: await listRuntimeServerIds(databasePath)
        });
        const designRepositories = await captureDesignRepositories({
          databasePath,
          storageRoot: this.storageRoot,
          backupRoot: staging
        });

        const databaseIntegrity = await inspectPrivateImmutableFile(databasePath);
        const manifest: BackupManifest = {
          format: BACKUP_FORMAT,
          formatVersion: BACKUP_FORMAT_VERSION,
          backupId,
          purpose,
          createdAt,
          appVersion: this.appVersion,
          database: {
            relativePath: DATABASE_FILE,
            applicationId: databaseInfo.applicationId,
            schemaVersion: databaseInfo.schemaVersion,
            ...databaseIntegrity
          },
          managedFiles: references,
          protocolJournals,
          designRepositories
        };
        const encodedManifest = encodeBackupManifest(manifest);
        await writePrivateFileAtomically(
          path.join(staging, MANIFEST_FILE),
          encodedManifest
        );
        await verifyBackupDirectory(staging, manifest, this.storageRoot);
        await syncDirectoryIfSupported(staging);
        await fs.rename(staging, target);
        published = true;
        try {
          await syncDirectoryIfSupported(this.backupsRoot);
        } catch (error) {
          throw new BackupRestoreError(
            'BACKUP_PUBLICATION_AMBIGUOUS',
            `Backup ${backupId} was renamed into place, but its directory sync failed.`,
            { cause: error }
          );
        }
        return { backupDirectory: target, manifest };
      } finally {
        barrier.release();
        if (!published) await removeGeneratedDirectory(staging, this.backupsRoot);
      }
    });
  }

  /** Stops new backup/recovery work and waits for every admitted operation. */
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.admissionClosed = true;
    this.closeWork = this.queue.then(() => undefined, () => undefined);
    return this.closeWork;
  }

  verifyBackup(backupId: string): Promise<VerifiedBackup> {
    return this.enqueue(() => this.verifyBackupDirect(backupId));
  }

  restoreBackup(backupId: string): Promise<RestoreResult> {
    return this.enqueue(async () => {
      await this.assertRestoreAllowed();
      const interrupted = await locateRestoreIntent(this.storageRoot);
      if (interrupted) {
        if (interrupted.intent.backupId !== backupId) {
          throw new BackupRestoreError(
            'RESTORE_ACTIVATION_AMBIGUOUS',
            `Backup ${interrupted.intent.backupId} has an interrupted restore. Resume that restore before selecting another backup.`
          );
        }
        const verified = await this.verifyBackupDirect(backupId);
        return this.completeRestore(verified, interrupted.intent);
      }

      const verified = await this.verifyBackupDirect(backupId);
      const storageParent = path.dirname(this.storageRoot);
      await ensurePrivateDirectory(storageParent);
      const operationId = this.nextOperationId();
      const createdAt = this.now().toISOString();
      const stagingDirectory = restoreStagingDirectoryName(
        path.basename(this.storageRoot),
        operationId
      );
      const staging = path.join(storageParent, stagingDirectory);
      await fs.mkdir(staging, { mode: 0o700 });
      await ensurePrivateDirectory(staging);
      let intentPublished = false;
      try {
        await copyVerifiedPrivateFile(
          path.join(verified.backupDirectory, DATABASE_FILE),
          path.join(staging, DATABASE_FILE),
          verified.manifest.database
        );
        await makeMutablePrivateFile(path.join(staging, DATABASE_FILE));
        for (const reference of verified.manifest.managedFiles) {
          await copyVerifiedPrivateFile(
            backupManagedFilePath(verified.backupDirectory, reference.storageKey),
            backupManagedFilePath(staging, reference.storageKey),
            reference
          );
        }
        for (const journal of verified.manifest.protocolJournals) {
          const destination = path.join(staging, ...journal.relativePath.split('/'));
          await copyVerifiedPrivateFile(
            path.join(verified.backupDirectory, ...journal.relativePath.split('/')),
            destination,
            journal
          );
          await makeMutablePrivateFile(destination);
        }
        await ensurePrivateDirectory(path.join(staging, 'design-repositories'));
        for (const repository of verified.manifest.designRepositories) {
          await restoreManagedDesignRepository({
            repositoryPath: path.join(staging, ...repository.relativePath.split('/')),
            bundlePath: path.join(
              verified.backupDirectory,
              ...repository.bundle.relativePath.split('/')
            ),
            markerPath: path.join(
              verified.backupDirectory,
              ...repository.marker.relativePath.split('/')
            ),
            metadata: repository
          });
        }
        // Design worktrees are disposable materializations. Startup recovery
        // recreates only the worktrees still referenced by authoritative state.
        await ensurePrivateDirectory(path.join(staging, 'design-worktrees'));
        await verifyDatabaseSnapshot(
          path.join(staging, DATABASE_FILE),
          this.applicationId,
          verified.manifest.database.schemaVersion
        );
        await syncDirectoryIfSupported(staging);

        await this.assertRestoreAllowed();
        const hasLiveStorage = await pathExists(this.storageRoot);
        if (hasLiveStorage) {
          await assertPrivateDirectory(this.storageRoot);
        }
        const previousStorageDirectory = hasLiveStorage
          ? restorePreviousDirectoryName(
              path.basename(this.storageRoot),
              createdAt,
              operationId
            )
          : null;
        if (
          previousStorageDirectory &&
          (await pathExists(path.join(storageParent, previousStorageDirectory)))
        ) {
          throw new BackupRestoreError(
            'BACKUP_CONFLICT',
            'The restore rollback path already exists.'
          );
        }
        const intent: RestoreIntent = {
          format: RESTORE_INTENT_FORMAT,
          formatVersion: RESTORE_INTENT_FORMAT_VERSION,
          operationId,
          backupId,
          createdAt,
          stagingDirectory,
          previousStorageDirectory
        };
        await writePrivateFileAtomically(
          path.join(staging, RESTORE_INTENT_FILE),
          `${JSON.stringify(intent, null, 2)}\n`
        );
        // The intent travels with staging during activation. Syncing the parent
        // before the first rename makes a crash leave either a discoverable
        // staging root or the same intent in the activated live root.
        await syncDirectoryIfSupported(staging);
        await syncDirectoryIfSupported(storageParent);
        intentPublished = true;
        return await this.completeRestore(verified, intent, false);
      } finally {
        // Once the intent is durable, cleanup belongs to completeRestore. A
        // failed or interrupted swap must retain its exact recovery evidence.
        if (!intentPublished) await removeGeneratedDirectory(staging, storageParent);
      }
    });
  }

  private async completeRestore(
    verified: VerifiedBackup,
    intent: RestoreIntent,
    verifyPreparedRoot = true
  ): Promise<RestoreResult> {
    if (verified.manifest.backupId !== intent.backupId) {
      throw new BackupRestoreError(
        'RESTORE_ACTIVATION_AMBIGUOUS',
        'The interrupted restore does not match the verified backup.'
      );
    }
    await this.assertRestoreAllowed();
    const located = await locateRestoreIntent(this.storageRoot);
    if (!located || !sameRestoreIntent(located.intent, intent)) {
      throw new BackupRestoreError(
        'RESTORE_ACTIVATION_AMBIGUOUS',
        'Restore recovery evidence changed before activation.'
      );
    }
    if (verifyPreparedRoot) {
      await verifyPreparedRestoreRoot(located.rootPath, verified);
    }

    const storageParent = path.dirname(this.storageRoot);
    const stagingPath = path.join(storageParent, intent.stagingDirectory);
    const previousStoragePath = intent.previousStorageDirectory
      ? path.join(storageParent, intent.previousStorageDirectory)
      : undefined;

    if (located.location === 'STAGING') {
      try {
        if (previousStoragePath) {
          const [liveExists, previousExists] = await Promise.all([
            pathExists(this.storageRoot),
            pathExists(previousStoragePath)
          ]);
          if (liveExists === previousExists) {
            throw new BackupRestoreError(
              'RESTORE_ACTIVATION_AMBIGUOUS',
              'The interrupted restore has an ambiguous live and rollback-root state.'
            );
          }
          if (liveExists) {
            await assertPrivateDirectory(this.storageRoot);
            await fs.rename(this.storageRoot, previousStoragePath);
            await syncDirectoryIfSupported(storageParent);
          }
        } else if (await pathExists(this.storageRoot)) {
          throw new BackupRestoreError(
            'RESTORE_ACTIVATION_AMBIGUOUS',
            'A live storage root appeared during a restore that started without one.'
          );
        }

        await fs.rename(stagingPath, this.storageRoot);
        await syncDirectoryIfSupported(storageParent);
      } catch (error) {
        await this.rollbackFailedActivation(intent, error);
      }
    }

    // A restore discovered in the live location may be resuming after the
    // staging-to-live rename succeeded but the parent-directory sync failed.
    // Retry that durability barrier before removing the only recovery marker.
    if (located.location === 'LIVE') {
      try {
        await syncDirectoryIfSupported(storageParent);
      } catch (error) {
        throw new BackupRestoreError(
          'RESTORE_ACTIVATION_AMBIGUOUS',
          'The restored storage root is live, but its activation is not durably published.',
          { cause: error }
        );
      }
    }

    if (
      previousStoragePath &&
      !(await pathExists(previousStoragePath))
    ) {
      throw new BackupRestoreError(
        'RESTORE_ACTIVATION_AMBIGUOUS',
        'The retained pre-restore storage root is missing after activation.'
      );
    }
    await clearRestoreIntent(this.storageRoot);
    return {
      backupId: intent.backupId,
      restoredAt: this.now().toISOString(),
      previousStoragePath
    };
  }

  private async rollbackFailedActivation(
    intent: RestoreIntent,
    activationError: unknown
  ): Promise<never> {
    const storageParent = path.dirname(this.storageRoot);
    const stagingPath = path.join(storageParent, intent.stagingDirectory);
    const previousStoragePath = intent.previousStorageDirectory
      ? path.join(storageParent, intent.previousStorageDirectory)
      : undefined;
    try {
      const located = await locateRestoreIntent(this.storageRoot);
      if (!located || !sameRestoreIntent(located.intent, intent)) {
        throw new Error('Restore recovery evidence is missing or changed.');
      }
      if (located.location === 'LIVE') {
        throw new Error('The staged root may already have been activated.');
      }

      const [liveExists, previousExists] = await Promise.all([
        pathExists(this.storageRoot),
        previousStoragePath ? pathExists(previousStoragePath) : Promise.resolve(false)
      ]);
      if (previousStoragePath) {
        if (!liveExists && previousExists) {
          await fs.rename(previousStoragePath, this.storageRoot);
          await syncDirectoryIfSupported(storageParent);
        } else if (!liveExists || previousExists) {
          throw new Error('The previous storage root cannot be restored unambiguously.');
        }
      } else {
        throw new Error(
          liveExists
            ? 'A live storage root appeared during failed activation.'
            : 'A restore without a previous live root remains incomplete.'
        );
      }
      await removeGeneratedDirectory(stagingPath, storageParent);
    } catch (rollbackError) {
      throw new BackupRestoreError(
        'RESTORE_ACTIVATION_AMBIGUOUS',
        'Restore activation failed and its exact on-disk outcome requires recovery.',
        { cause: new AggregateError([activationError, rollbackError]) }
      );
    }
    throw activationError;
  }

  /**
   * Preserves the complete live root, including matching journal sidecars.
   * It never creates a replacement or attempts automatic salvage.
   */
  quarantineLiveStorage(reason: string): Promise<QuarantineResult> {
    return this.enqueue(async () => {
      await this.assertRestoreAllowed();
      if (await locateRestoreIntent(this.storageRoot)) {
        throw new BackupRestoreError(
          'RESTORE_ACTIVATION_AMBIGUOUS',
          'Finish the interrupted restore before quarantining live storage.'
        );
      }
      if (!(await pathExists(this.storageRoot))) {
        throw new BackupRestoreError(
          'STORAGE_NOT_FOUND',
          'The live storage root does not exist.'
        );
      }
      await assertPrivateDirectory(this.storageRoot);
      const quarantinedAt = this.now().toISOString();
      const quarantinePath = path.join(
        path.dirname(this.storageRoot),
        `${path.basename(this.storageRoot)}.corrupt-${timestampForPath(this.now())}-${this.nextOperationId()}`
      );
      if (await pathExists(quarantinePath)) {
        throw new BackupRestoreError(
          'BACKUP_CONFLICT',
          'The corruption quarantine path already exists.'
        );
      }
      await fs.rename(this.storageRoot, quarantinePath);
      await syncDirectoryIfSupported(path.dirname(this.storageRoot));
      return { quarantinedAt, quarantinePath, reason };
    });
  }

  private async verifyBackupDirect(backupId: string): Promise<VerifiedBackup> {
    assertBackupId(backupId);
    try {
      await ensurePrivateDirectory(this.backupsRoot);
      const backupDirectory = this.backupDirectory(backupId);
      await assertPrivateDirectory(backupDirectory);
      const manifestBytes = await readPrivateFile(
        path.join(backupDirectory, MANIFEST_FILE),
        MANIFEST_MAX_BYTES,
        { permissionPolicy: 'REQUIRE' }
      );
      const manifest = parseManifest(manifestBytes, backupId, this.applicationId);
      await verifyBackupDirectory(backupDirectory, manifest, this.storageRoot);
      return { backupDirectory, manifest };
    } catch (error) {
      if (error instanceof BackupRestoreError) throw error;
      throw new BackupRestoreError(
        'BACKUP_INVALID',
        `Backup ${backupId} failed integrity verification.`,
        { cause: error }
      );
    }
  }

  private backupDirectory(backupId: string): string {
    assertBackupId(backupId);
    return path.join(this.backupsRoot, backupId);
  }

  private requireLiveResources(): {
    database: AppDatabase;
    managedFiles: ManagedFileStore;
  } {
    if (!this.database || !this.managedFiles || this.appVersion === 'recovery-only') {
      throw new Error('A recovery-only backup service cannot create backups.');
    }
    return { database: this.database, managedFiles: this.managedFiles };
  }

  private nextOperationId(): string {
    const id = this.createId();
    if (!OPERATION_ID.test(id)) {
      throw new Error('Backup operation ID generator returned an unsafe value.');
    }
    return id;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.admissionClosed) {
      return Promise.reject(new Error('Backup and restore service is closed.'));
    }
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function encodeBackupManifest(
  manifest: BackupManifest,
  maxBytes = MANIFEST_MAX_BYTES
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Backup manifest byte limit must be a positive safe integer.');
  }
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new BackupRestoreError(
      'BACKUP_INVALID',
      'Backup manifest exceeds its durable read limit.'
    );
  }
  return encoded;
}

/**
 * Startup guard. It must run after the profile lease is acquired and before
 * any live storage directory is created. Restore itself is the only owner that
 * may resolve these paths.
 */
export async function assertNoInterruptedRestore(storageRoot: string): Promise<void> {
  const resolvedStorageRoot = path.resolve(storageRoot);
  const interrupted = await locateRestoreIntent(resolvedStorageRoot);
  if (interrupted) {
    throw new BackupRestoreError(
      'RESTORE_ACTIVATION_AMBIGUOUS',
      `Backup ${interrupted.intent.backupId} has an interrupted restore. Resume it with offline recovery before opening Task Monki.`
    );
  }

  if (await pathExists(resolvedStorageRoot)) return;
  const parent = path.dirname(resolvedStorageRoot);
  const base = path.basename(resolvedStorageRoot);
  const entries = await fs.readdir(parent, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        restoreStagingOperationId(base, entry.name) !== undefined ||
        isRestorePreviousDirectory(base, entry.name)
    )
  ) {
    throw new BackupRestoreError(
      'RESTORE_ACTIVATION_AMBIGUOUS',
      'The live storage root is missing while restore-owned recovery paths remain. Run offline recovery before opening Task Monki.'
    );
  }
}

async function locateRestoreIntent(
  storageRoot: string
): Promise<LocatedRestoreIntent | undefined> {
  const storageParent = path.dirname(storageRoot);
  const storageBase = path.basename(storageRoot);
  const located: LocatedRestoreIntent[] = [];

  const liveIntent = await readRestoreIntentFromRoot(storageRoot, storageBase, 'LIVE');
  if (liveIntent) located.push(liveIntent);

  const entries = await fs.readdir(storageParent, { withFileTypes: true });
  for (const entry of entries) {
    if (restoreStagingOperationId(storageBase, entry.name) === undefined) continue;
    const stagingRoot = path.join(storageParent, entry.name);
    const stagingIntent = await readRestoreIntentFromRoot(
      stagingRoot,
      storageBase,
      'STAGING'
    );
    if (stagingIntent) located.push(stagingIntent);
  }

  if (located.length > 1) {
    throw new BackupRestoreError(
      'RESTORE_ACTIVATION_AMBIGUOUS',
      'Multiple interrupted restore roots were found.'
    );
  }
  return located[0];
}

async function readRestoreIntentFromRoot(
  rootPath: string,
  storageBase: string,
  location: LocatedRestoreIntent['location']
): Promise<LocatedRestoreIntent | undefined> {
  const rootStat = await lstatIfExists(rootPath);
  if (!rootStat) return undefined;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    if (location === 'STAGING') {
      throw new BackupRestoreError(
        'RESTORE_ACTIVATION_AMBIGUOUS',
        'A restore-owned staging path is unsafe.'
      );
    }
    return undefined;
  }
  const markerPath = path.join(rootPath, RESTORE_INTENT_FILE);
  if (!(await lstatIfExists(markerPath))) return undefined;

  try {
    await assertPrivateDirectory(rootPath);
    const raw = await readPrivateFile(markerPath, RESTORE_INTENT_MAX_BYTES, {
      permissionPolicy: 'REQUIRE'
    });
    const intent = parseRestoreIntent(raw, storageBase);
    if (location === 'STAGING' && path.basename(rootPath) !== intent.stagingDirectory) {
      throw new Error('Restore intent does not own its staging directory.');
    }
    return { intent, location, rootPath };
  } catch (error) {
    if (
      error instanceof BackupRestoreError &&
      error.code === 'RESTORE_ACTIVATION_AMBIGUOUS'
    ) {
      throw error;
    }
    throw new BackupRestoreError(
      'RESTORE_ACTIVATION_AMBIGUOUS',
      'Restore recovery evidence failed its integrity check.',
      { cause: error }
    );
  }
}

function parseRestoreIntent(bytes: Buffer, storageBase: string): RestoreIntent {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('Restore intent is not valid JSON.', { cause: error });
  }
  if (!isRecord(value)) throw new Error('Restore intent is malformed.');
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'backupId',
    'createdAt',
    'format',
    'formatVersion',
    'operationId',
    'previousStorageDirectory',
    'stagingDirectory'
  ].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    value.format !== RESTORE_INTENT_FORMAT ||
    value.formatVersion !== RESTORE_INTENT_FORMAT_VERSION ||
    typeof value.operationId !== 'string' ||
    !OPERATION_ID.test(value.operationId) ||
    typeof value.backupId !== 'string' ||
    !BACKUP_ID.test(value.backupId) ||
    !isCanonicalTimestamp(value.createdAt) ||
    typeof value.stagingDirectory !== 'string' ||
    (value.previousStorageDirectory !== null &&
      typeof value.previousStorageDirectory !== 'string')
  ) {
    throw new Error('Restore intent is malformed.');
  }
  const expectedStaging = restoreStagingDirectoryName(storageBase, value.operationId);
  const expectedPrevious = restorePreviousDirectoryName(
    storageBase,
    value.createdAt,
    value.operationId
  );
  if (
    value.stagingDirectory !== expectedStaging ||
    (value.previousStorageDirectory !== null &&
      value.previousStorageDirectory !== expectedPrevious)
  ) {
    throw new Error('Restore intent contains an unsafe owned path.');
  }
  return {
    format: RESTORE_INTENT_FORMAT,
    formatVersion: RESTORE_INTENT_FORMAT_VERSION,
    operationId: value.operationId,
    backupId: value.backupId,
    createdAt: value.createdAt,
    stagingDirectory: expectedStaging,
    previousStorageDirectory: value.previousStorageDirectory
  };
}

async function verifyPreparedRestoreRoot(
  rootPath: string,
  verified: VerifiedBackup
): Promise<void> {
  try {
    await assertPrivateDirectory(rootPath);
    const databasePath = path.join(rootPath, DATABASE_FILE);
    const databaseIntegrity = await inspectPrivateImmutableFile(databasePath);
    if (
      databaseIntegrity.byteCount !== verified.manifest.database.byteCount ||
      databaseIntegrity.sha256 !== verified.manifest.database.sha256
    ) {
      throw new Error('Prepared restore database does not match the backup.');
    }
    await verifyDatabaseSnapshot(
      databasePath,
      verified.manifest.database.applicationId,
      verified.manifest.database.schemaVersion
    );
    for (const reference of verified.manifest.managedFiles) {
      const actual = await inspectPrivateImmutableFile(
        backupManagedFilePath(rootPath, reference.storageKey)
      );
      if (actual.byteCount !== reference.byteCount || actual.sha256 !== reference.sha256) {
        throw new Error(`Prepared managed file does not match: ${reference.storageKey}`);
      }
    }
    for (const journal of verified.manifest.protocolJournals) {
      const actual = await inspectPrivateImmutableFile(
        path.join(rootPath, ...journal.relativePath.split('/'))
      );
      if (actual.byteCount !== journal.byteCount || actual.sha256 !== journal.sha256) {
        throw new Error(`Prepared protocol journal does not match: ${journal.relativePath}`);
      }
    }
    for (const repository of verified.manifest.designRepositories) {
      await verifyRestoredManagedDesignRepository({
        repositoryPath: path.join(rootPath, ...repository.relativePath.split('/')),
        metadata: repository
      });
    }
    const designWorktreeRoot = path.join(rootPath, 'design-worktrees');
    await assertPrivateDirectory(designWorktreeRoot);
    if ((await fs.readdir(designWorktreeRoot)).length !== 0) {
      throw new Error('Prepared restore contains a Design worktree materialization.');
    }
  } catch (error) {
    throw new BackupRestoreError(
      'RESTORE_ACTIVATION_AMBIGUOUS',
      'The prepared restore root failed integrity verification.',
      { cause: error }
    );
  }
}

async function clearRestoreIntent(rootPath: string): Promise<void> {
  const markerPath = path.join(rootPath, RESTORE_INTENT_FILE);
  try {
    const marker = await fs.lstat(markerPath);
    if (
      marker.isSymbolicLink() ||
      !marker.isFile() ||
      !isOwnedByCurrentUser(marker) ||
      !hasNoGroupOrOtherPosixAccess(marker)
    ) {
      throw new Error('Restore intent is unsafe.');
    }
    await fs.unlink(markerPath);
    await syncDirectoryIfSupported(rootPath);
  } catch (error) {
    throw new BackupRestoreError(
      'RESTORE_ACTIVATION_AMBIGUOUS',
      'The restored storage root was activated, but its recovery marker could not be cleared.',
      { cause: error }
    );
  }
}

function restoreStagingDirectoryName(storageBase: string, operationId: string): string {
  if (!OPERATION_ID.test(operationId)) throw new Error('Restore operation ID is invalid.');
  return `.${storageBase}.restore-${operationId}.tmp`;
}

function restorePreviousDirectoryName(
  storageBase: string,
  createdAt: string,
  operationId: string
): string {
  if (!isCanonicalTimestamp(createdAt) || !OPERATION_ID.test(operationId)) {
    throw new Error('Restore identity is invalid.');
  }
  return `${storageBase}.pre-restore-${timestampForPath(new Date(createdAt))}-${operationId}`;
}

function restoreStagingOperationId(
  storageBase: string,
  directoryName: string
): string | undefined {
  const prefix = `.${storageBase}.restore-`;
  const suffix = '.tmp';
  if (!directoryName.startsWith(prefix) || !directoryName.endsWith(suffix)) {
    return undefined;
  }
  const operationId = directoryName.slice(prefix.length, -suffix.length);
  return OPERATION_ID.test(operationId) ? operationId : undefined;
}

function isRestorePreviousDirectory(
  storageBase: string,
  directoryName: string
): boolean {
  const prefix = `${storageBase}.pre-restore-`;
  if (!directoryName.startsWith(prefix)) return false;
  const identity = directoryName.slice(prefix.length);
  return /^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    identity
  );
}

function sameRestoreIntent(left: RestoreIntent, right: RestoreIntent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyBackupDirectory(
  directory: string,
  manifest: BackupManifest,
  storageRoot: string
): Promise<void> {
  const expectedPaths = new Set<string>([MANIFEST_FILE, DATABASE_FILE]);
  for (const reference of manifest.managedFiles) {
    expectedPaths.add(`files/${reference.storageKey}`);
  }
  for (const journal of manifest.protocolJournals) {
    expectedPaths.add(journal.relativePath);
  }
  for (const repository of manifest.designRepositories) {
    expectedPaths.add(repository.bundle.relativePath);
    expectedPaths.add(repository.marker.relativePath);
  }
  const actualPaths = await listPrivateFiles(directory);
  if (
    actualPaths.length !== expectedPaths.size ||
    actualPaths.some((relativePath) => !expectedPaths.has(relativePath))
  ) {
    throw new BackupRestoreError(
      'BACKUP_INVALID',
      'Backup contents do not exactly match the manifest.'
    );
  }

  const databasePath = path.join(directory, DATABASE_FILE);
  const databaseIntegrity = await inspectPrivateImmutableFile(databasePath);
  if (
    databaseIntegrity.byteCount !== manifest.database.byteCount ||
    databaseIntegrity.sha256 !== manifest.database.sha256
  ) {
    throw new BackupRestoreError('BACKUP_INVALID', 'Backup database digest does not match.');
  }
  const databaseInfo = await verifyDatabaseSnapshot(
    databasePath,
    manifest.database.applicationId,
    manifest.database.schemaVersion
  );
  if (
    databaseInfo.applicationId !== manifest.database.applicationId ||
    databaseInfo.schemaVersion !== manifest.database.schemaVersion
  ) {
    throw new BackupRestoreError('BACKUP_INVALID', 'Backup database identity does not match.');
  }

  const snapshotReferences = normalizeReferences(
    await listLiveManagedFiles(databasePath)
  );
  if (JSON.stringify(snapshotReferences) !== JSON.stringify(manifest.managedFiles)) {
    throw new BackupRestoreError(
      'BACKUP_INVALID',
      'Backup file manifest does not match the database snapshot.'
    );
  }
  for (const reference of manifest.managedFiles) {
    const actual = await inspectPrivateImmutableFile(
      backupManagedFilePath(directory, reference.storageKey)
    );
    if (actual.byteCount !== reference.byteCount || actual.sha256 !== reference.sha256) {
      throw new BackupRestoreError(
        'BACKUP_INVALID',
        `Backup managed file does not match: ${reference.storageKey}`
      );
    }
  }

  const serverIds = await listRuntimeServerIds(databasePath);
  for (const journal of manifest.protocolJournals) {
    if (!serverIds.has(journal.serverInstanceId)) {
      throw new BackupRestoreError(
        'BACKUP_INVALID',
        `Backup journal has no authoritative runtime server: ${journal.serverInstanceId}`
      );
    }
    const actual = await inspectPrivateImmutableFile(
      path.join(directory, ...journal.relativePath.split('/'))
    );
    if (actual.byteCount !== journal.byteCount || actual.sha256 !== journal.sha256) {
      throw new BackupRestoreError(
        'BACKUP_INVALID',
        `Backup protocol journal does not match: ${journal.relativePath}`
      );
    }
  }

  const expectedRepositories = await listDesignRepositories(databasePath, storageRoot);
  if (
    expectedRepositories.length !== manifest.designRepositories.length ||
    expectedRepositories.some((expected, index) => {
      const actual = manifest.designRepositories[index];
      return (
        !actual ||
        actual.repositoryId !== expected.repositoryId ||
        actual.headSha !== expected.headSha ||
        JSON.stringify(actual.requiredObjects) !== JSON.stringify(expected.requiredObjects)
      );
    })
  ) {
    throw new BackupRestoreError(
      'BACKUP_INVALID',
      'Backup Design repository manifest does not match the database snapshot.'
    );
  }
  for (const repository of manifest.designRepositories) {
    await verifyManagedDesignRepositoryBackup({
      bundlePath: path.join(directory, ...repository.bundle.relativePath.split('/')),
      markerPath: path.join(directory, ...repository.marker.relativePath.split('/')),
      metadata: repository
    });
  }
}

async function verifyDatabaseSnapshot(
  databasePath: string,
  expectedApplicationId: number,
  expectedSchemaVersion: number
): Promise<BackupDatabaseInfo> {
  const result = await AppDatabase.verifyFile(databasePath, {
    expectedApplicationId,
    expectedSchemaVersion,
    integrityMode: 'full'
  });
  return {
    applicationId: result.applicationId,
    schemaVersion: result.schemaVersion
  };
}

interface ManagedFileRow {
  storageKey: string;
  byteCount: number;
  sha256: string;
}

async function listLiveManagedFiles(databasePath: string): Promise<ManagedFileReference[]> {
  const snapshot = AppDatabase.openReadOnly(databasePath);
  try {
    return snapshot.all<ManagedFileRow>(String.raw`
      SELECT
        storage_key AS storageKey,
        byte_count AS byteCount,
        content_sha256 AS sha256
      FROM managed_files
      WHERE state = 'LIVE'
      ORDER BY storage_key
    `);
  } finally {
    await snapshot.close();
  }
}

async function copyProtocolJournals(input: {
  sourceRoot: string;
  backupRoot: string;
  retainedServerIds: ReadonlySet<string>;
}): Promise<BackupProtocolJournal[]> {
  // A flush drains writes already queued, but intentionally does not stop a
  // running agent from appending afterward. The before/copy/after digest check
  // therefore aborts the whole staged backup on overlap; a later retry starts
  // from a fresh database snapshot and journal inventory.
  const rootStat = await lstatIfExists(input.sourceRoot);
  if (!rootStat) return [];
  await assertPrivateDirectory(input.sourceRoot);
  const entries = await fs.readdir(input.sourceRoot, { withFileTypes: true });
  const candidates: Array<{
    serverInstanceId: string;
    segment: number;
    sourcePath: string;
    relativePath: string;
  }> = [];
  for (const entry of entries) {
    const parsed = parseProtocolJournalFileName(entry.name);
    if (!parsed || !input.retainedServerIds.has(parsed.serverInstanceId)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Protocol journal segment is unsafe: ${entry.name}`);
    }
    const stat = await fs.lstat(path.join(input.sourceRoot, entry.name));
    if (
      !stat.isFile() ||
      !isOwnedByCurrentUser(stat) ||
      !hasNoGroupOrOtherPosixAccess(stat) ||
      (process.platform !== 'win32' && stat.nlink !== 1)
    ) {
      throw new Error(`Protocol journal segment failed its ownership check: ${entry.name}`);
    }
    candidates.push({
      ...parsed,
      sourcePath: path.join(input.sourceRoot, entry.name),
      relativePath: protocolJournalRelativePath(
        parsed.serverInstanceId,
        parsed.segment
      )
    });
  }
  candidates.sort(compareProtocolJournals);
  if (candidates.length > MAX_PROTOCOL_JOURNAL_FILES) {
    throw new Error('Protocol journal backup exceeds its file-count limit.');
  }

  let totalBytes = 0;
  const journals: BackupProtocolJournal[] = [];
  for (const candidate of candidates) {
    const before = await inspectPrivateImmutableFile(candidate.sourcePath);
    totalBytes += before.byteCount;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PROTOCOL_JOURNAL_BYTES) {
      throw new Error('Protocol journal backup exceeds its byte limit.');
    }
    await copyVerifiedPrivateFile(
      candidate.sourcePath,
      path.join(input.backupRoot, ...candidate.relativePath.split('/')),
      before
    );
    const after = await inspectPrivateImmutableFile(candidate.sourcePath);
    if (before.byteCount !== after.byteCount || before.sha256 !== after.sha256) {
      throw new Error(`Protocol journal changed during backup: ${candidate.sourcePath}`);
    }
    journals.push({
      serverInstanceId: candidate.serverInstanceId,
      segment: candidate.segment,
      relativePath: candidate.relativePath,
      ...before
    });
  }
  return journals;
}

async function captureDesignRepositories(input: {
  databasePath: string;
  storageRoot: string;
  backupRoot: string;
}): Promise<BackupDesignRepository[]> {
  const repositories = await listDesignRepositories(input.databasePath, input.storageRoot);
  const captured: BackupDesignRepository[] = [];
  for (const repository of repositories) {
    const relativePath = designRepositoryRelativePath(repository.repositoryId);
    const markerRelativePath = `${relativePath}/marker.json`;
    const bundleRelativePath = `${relativePath}/repository.bundle`;
    const metadata = await captureManagedDesignRepository({
      repositoryId: repository.repositoryId,
      repositoryPath: repository.repositoryPath,
      markerBackupPath: path.join(input.backupRoot, ...markerRelativePath.split('/')),
      bundlePath: path.join(input.backupRoot, ...bundleRelativePath.split('/')),
      expectedHeadSha: repository.headSha,
      requiredObjects: repository.requiredObjects
    });
    captured.push({
      ...metadata,
      relativePath,
      marker: { ...metadata.marker, relativePath: markerRelativePath },
      bundle: { ...metadata.bundle, relativePath: bundleRelativePath }
    });
  }
  return captured;
}

interface DatabaseDesignRepository {
  repositoryId: string;
  repositoryPath: string;
  headSha: string;
  requiredObjects: string[];
}

async function listDesignRepositories(
  databasePath: string,
  storageRoot: string
): Promise<DatabaseDesignRepository[]> {
  const snapshot = AppDatabase.openReadOnly(databasePath);
  try {
    const rows = snapshot.all<{
      repositoryId: string;
      repositoryPath: string;
      headSha: string | null;
    }>(String.raw`
      SELECT id AS repositoryId, path AS repositoryPath, head_sha AS headSha
      FROM repositories
      WHERE kind = 'DESIGN_MANAGED'
      ORDER BY id
    `);
    if (rows.length > MAX_DESIGN_REPOSITORIES) {
      throw new Error('Managed Design repository count exceeds its backup limit.');
    }
    const designRoot = path.join(path.resolve(storageRoot), 'design-repositories');
    return rows.map((row) => {
      if (!UUID.test(row.repositoryId)) {
        throw new Error('Managed Design repository database id is invalid.');
      }
      if (row.headSha === null || !GIT_OBJECT_ID.test(row.headSha)) {
        throw new Error('Managed Design repository database head is invalid.');
      }
      const expectedPath = path.join(designRoot, row.repositoryId);
      if (path.resolve(row.repositoryPath) !== expectedPath) {
        throw new Error(
          `Managed Design repository ${row.repositoryId} is outside its persistence root.`
        );
      }
      const required = new Set<string>();
      if (row.headSha) required.add(row.headSha);
      for (const objectId of listStructuredDesignObjectIds(snapshot, row.repositoryId)) {
        required.add(objectId);
      }
      return {
        repositoryId: row.repositoryId,
        repositoryPath: expectedPath,
        headSha: row.headSha,
        requiredObjects: [...required].sort()
      };
    });
  } finally {
    await snapshot.close();
  }
}

function listStructuredDesignObjectIds(
  snapshot: ReturnType<typeof AppDatabase.openReadOnly>,
  repositoryId: string
): string[] {
  const objectIds = new Set<string>();
  const directRows = snapshot.all<{ objectId: string | null }>(String.raw`
    SELECT commit_sha AS objectId
    FROM design_revisions
    WHERE design_id IN (SELECT id FROM tasks WHERE repository_id = ?)
    UNION ALL
    SELECT base_sha AS objectId
    FROM task_iterations
    WHERE task_id IN (SELECT id FROM tasks WHERE repository_id = ?)
    UNION ALL
    SELECT base_sha AS objectId
    FROM worktrees
    WHERE repository_id = ?
    UNION ALL
    SELECT head_sha AS objectId
    FROM worktrees
    WHERE repository_id = ?
    UNION ALL
    SELECT head_sha AS objectId
    FROM git_snapshots
    WHERE task_id IN (SELECT id FROM tasks WHERE repository_id = ?)
  `, [repositoryId, repositoryId, repositoryId, repositoryId, repositoryId]);
  for (const row of directRows) {
    if (row.objectId === null) continue;
    if (!GIT_OBJECT_ID.test(row.objectId)) {
      throw new Error('Managed Design database Git object id is invalid.');
    }
    objectIds.add(row.objectId);
  }

  const payloadRows = snapshot.all<{ payload: string }>(String.raw`
    SELECT payload_json AS payload
    FROM tasks
    WHERE repository_id = ?
    UNION ALL
    SELECT payload_json AS payload
    FROM task_iterations
    WHERE task_id IN (SELECT id FROM tasks WHERE repository_id = ?)
    UNION ALL
    SELECT payload_json AS payload
    FROM worktrees
    WHERE repository_id = ?
    UNION ALL
    SELECT payload_json AS payload
    FROM design_turns
    WHERE design_id IN (SELECT id FROM tasks WHERE repository_id = ?)
    UNION ALL
    SELECT payload_json AS payload
    FROM design_revisions
    WHERE design_id IN (SELECT id FROM tasks WHERE repository_id = ?)
    UNION ALL
    SELECT payload_json AS payload
    FROM design_source_actions
    WHERE design_id IN (SELECT id FROM tasks WHERE repository_id = ?)
    UNION ALL
    SELECT payload_json AS payload
    FROM preview_generations
    WHERE task_id IN (SELECT id FROM tasks WHERE repository_id = ?)
    UNION ALL
    SELECT payload_json AS payload
    FROM task_domain_events
    WHERE task_id IN (SELECT id FROM tasks WHERE repository_id = ?)
  `, [
    repositoryId,
    repositoryId,
    repositoryId,
    repositoryId,
    repositoryId,
    repositoryId,
    repositoryId,
    repositoryId
  ]);
  for (const row of payloadRows) {
    collectDesignObjectIds(JSON.parse(row.payload), undefined, objectIds);
    if (objectIds.size > 100_000) {
      throw new Error('Managed Design repository required-object count exceeds its limit.');
    }
  }
  return [...objectIds].sort();
}

const DESIGN_OBJECT_FIELDS = new Set([
  'baseSha',
  'candidateCommitSha',
  'commitSha',
  'expectedParentCommit',
  'headSha',
  'targetCommitSha',
  'treeSha'
]);

function collectDesignObjectIds(
  value: unknown,
  field: string | undefined,
  output: Set<string>
): void {
  if (typeof value === 'string') {
    if (field && DESIGN_OBJECT_FIELDS.has(field)) {
      if (!GIT_OBJECT_ID.test(value)) {
        throw new Error(`Managed Design database ${field} is not a Git object id.`);
      }
      output.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectDesignObjectIds(entry, field, output));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    collectDesignObjectIds(nested, key, output);
  }
}

async function listRuntimeServerIds(databasePath: string): Promise<Set<string>> {
  const snapshot = AppDatabase.openReadOnly(databasePath);
  try {
    const ids = snapshot
      .all<{ id: string }>('SELECT id FROM runtime_servers ORDER BY id')
      .map((row) => row.id);
    if (ids.some((id) => !RUNTIME_SERVER_ID.test(id))) {
      throw new Error('Runtime server database identity is unsafe.');
    }
    return new Set(ids);
  } finally {
    await snapshot.close();
  }
}

function parseProtocolJournalFileName(
  fileName: string
): { serverInstanceId: string; segment: number } | undefined {
  const match = PROTOCOL_JOURNAL_FILE.exec(fileName);
  if (!match) return undefined;
  const rawSegment = match[2];
  if (rawSegment !== undefined && !/^[1-9][0-9]*$/u.test(rawSegment)) {
    throw new Error(`Protocol journal segment name is invalid: ${fileName}`);
  }
  const segment = rawSegment === undefined ? 0 : Number(rawSegment);
  if (!Number.isSafeInteger(segment) || segment < 0) {
    throw new Error(`Protocol journal segment is invalid: ${fileName}`);
  }
  return { serverInstanceId: match[1]!, segment };
}

function protocolJournalRelativePath(serverInstanceId: string, segment: number): string {
  if (!RUNTIME_SERVER_ID.test(serverInstanceId)) invalidManifest();
  if (!Number.isSafeInteger(segment) || segment < 0) invalidManifest();
  return `protocol-journals/${serverInstanceId}${segment === 0 ? '' : `.${segment}`}.ndjson`;
}

function designRepositoryRelativePath(repositoryId: string): string {
  if (!UUID.test(repositoryId)) invalidManifest();
  return `design-repositories/${repositoryId}`;
}

function compareProtocolJournals(
  left: Pick<BackupProtocolJournal, 'serverInstanceId' | 'segment'>,
  right: Pick<BackupProtocolJournal, 'serverInstanceId' | 'segment'>
): number {
  return (
    left.serverInstanceId.localeCompare(right.serverInstanceId) ||
    left.segment - right.segment
  );
}

function parseManifest(
  bytes: Buffer,
  backupId: string,
  applicationId: number
): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new BackupRestoreError('BACKUP_INVALID', 'Backup manifest is not valid JSON.', {
      cause: error
    });
  }
  if (!isRecord(value)) invalidManifest();
  if (
    value.format !== BACKUP_FORMAT ||
    value.formatVersion !== BACKUP_FORMAT_VERSION ||
    value.backupId !== backupId ||
    (value.purpose !== 'MANUAL' && value.purpose !== 'PRE_UPGRADE') ||
    !isCanonicalTimestamp(value.createdAt) ||
    typeof value.appVersion !== 'string' ||
    value.appVersion.length === 0 ||
    !isRecord(value.database) ||
    value.database.relativePath !== DATABASE_FILE ||
    value.database.applicationId !== applicationId ||
    !Number.isSafeInteger(value.database.schemaVersion) ||
    (value.database.schemaVersion as number) < 1 ||
    !Number.isSafeInteger(value.database.byteCount) ||
    (value.database.byteCount as number) <= 0 ||
    typeof value.database.sha256 !== 'string' ||
    !SHA256.test(value.database.sha256) ||
    !Array.isArray(value.managedFiles) ||
    value.managedFiles.length > MAX_MANAGED_FILES ||
    !Array.isArray(value.protocolJournals) ||
    value.protocolJournals.length > MAX_PROTOCOL_JOURNAL_FILES ||
    !Array.isArray(value.designRepositories) ||
    value.designRepositories.length > MAX_DESIGN_REPOSITORIES
  ) {
    invalidManifest();
  }
  if ((value.database.schemaVersion as number) > APP_DATABASE_SCHEMA_VERSION) {
    throw new BackupRestoreError(
      'BACKUP_INVALID',
      `Backup database schema version ${String(value.database.schemaVersion)} is newer than supported version ${APP_DATABASE_SCHEMA_VERSION}.`
    );
  }
  const managedFiles = normalizeReferences(value.managedFiles);
  const protocolJournals = normalizeProtocolJournals(value.protocolJournals);
  const designRepositories = normalizeDesignRepositories(value.designRepositories);
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    backupId,
    purpose: value.purpose as BackupPurpose,
    createdAt: value.createdAt as string,
    appVersion: value.appVersion as string,
    database: {
      relativePath: DATABASE_FILE,
      applicationId,
      schemaVersion: value.database.schemaVersion as number,
      byteCount: value.database.byteCount as number,
      sha256: value.database.sha256
    },
    managedFiles,
    protocolJournals,
    designRepositories
  };
}

function normalizeProtocolJournals(values: readonly unknown[]): BackupProtocolJournal[] {
  if (values.length > MAX_PROTOCOL_JOURNAL_FILES) invalidManifest();
  let totalBytes = 0;
  const journals = values.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.serverInstanceId !== 'string' ||
      !Number.isSafeInteger(value.segment) ||
      (value.segment as number) < 0 ||
      typeof value.relativePath !== 'string' ||
      !Number.isSafeInteger(value.byteCount) ||
      (value.byteCount as number) < 0 ||
      typeof value.sha256 !== 'string' ||
      !SHA256.test(value.sha256)
    ) {
      invalidManifest();
    }
    const expectedPath = protocolJournalRelativePath(
      value.serverInstanceId,
      value.segment as number
    );
    if (value.relativePath !== expectedPath) invalidManifest();
    totalBytes += value.byteCount as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PROTOCOL_JOURNAL_BYTES) {
      invalidManifest();
    }
    return {
      serverInstanceId: value.serverInstanceId,
      segment: value.segment as number,
      relativePath: expectedPath,
      byteCount: value.byteCount as number,
      sha256: value.sha256
    };
  });
  journals.sort(compareProtocolJournals);
  for (let index = 1; index < journals.length; index += 1) {
    if (journals[index - 1]!.relativePath === journals[index]!.relativePath) {
      invalidManifest();
    }
  }
  return journals;
}

function normalizeDesignRepositories(values: readonly unknown[]): BackupDesignRepository[] {
  if (values.length > MAX_DESIGN_REPOSITORIES) invalidManifest();
  const repositories = values.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.repositoryId !== 'string' ||
      !UUID.test(value.repositoryId) ||
      typeof value.relativePath !== 'string' ||
      (value.objectFormat !== 'sha1' && value.objectFormat !== 'sha256') ||
      typeof value.headReference !== 'string' ||
      typeof value.headSha !== 'string' ||
      !GIT_OBJECT_ID.test(value.headSha) ||
      !Array.isArray(value.refs) ||
      !Array.isArray(value.requiredObjects) ||
      !isRecord(value.marker) ||
      !isRecord(value.bundle)
    ) {
      invalidManifest();
    }
    const relativePath = designRepositoryRelativePath(value.repositoryId);
    const markerRelativePath = `${relativePath}/marker.json`;
    const bundleRelativePath = `${relativePath}/repository.bundle`;
    if (
      value.relativePath !== relativePath ||
      value.marker.relativePath !== markerRelativePath ||
      value.bundle.relativePath !== bundleRelativePath
    ) {
      invalidManifest();
    }
    const refs = value.refs.map((reference) => parseDesignGitReference(reference));
    const requiredObjects = value.requiredObjects.map((objectId) => {
      if (typeof objectId !== 'string' || !GIT_OBJECT_ID.test(objectId)) invalidManifest();
      return objectId;
    });
    const repository: BackupDesignRepository = {
      repositoryId: value.repositoryId,
      relativePath,
      objectFormat: value.objectFormat,
      headReference: value.headReference,
      headSha: value.headSha,
      refs,
      requiredObjects,
      marker: {
        relativePath: markerRelativePath,
        ...parseIntegrity(value.marker)
      },
      bundle: {
        relativePath: bundleRelativePath,
        ...parseIntegrity(value.bundle)
      }
    };
    try {
      validateDesignRepositoryBackupMetadata(repository);
    } catch {
      invalidManifest();
    }
    return repository;
  });
  repositories.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  for (let index = 1; index < repositories.length; index += 1) {
    if (repositories[index - 1]!.repositoryId === repositories[index]!.repositoryId) {
      invalidManifest();
    }
  }
  return repositories;
}

function parseDesignGitReference(value: unknown): DesignGitReference {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.objectId !== 'string'
  ) {
    invalidManifest();
  }
  return { name: value.name, objectId: value.objectId };
}

function parseIntegrity(value: Record<string, unknown>): {
  byteCount: number;
  sha256: string;
} {
  if (
    !Number.isSafeInteger(value.byteCount) ||
    (value.byteCount as number) < 0 ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256)
  ) {
    invalidManifest();
  }
  return { byteCount: value.byteCount as number, sha256: value.sha256 };
}

function normalizeReferences(values: readonly unknown[]): ManagedFileReference[] {
  if (values.length > MAX_MANAGED_FILES) invalidManifest();
  const references = values.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.storageKey !== 'string' ||
      !Number.isSafeInteger(value.byteCount) ||
      (value.byteCount as number) < 0 ||
      typeof value.sha256 !== 'string' ||
      !SHA256.test(value.sha256)
    ) {
      invalidManifest();
    }
    try {
      assertStorageKey(value.storageKey);
    } catch (error) {
      throw new BackupRestoreError(
        'BACKUP_INVALID',
        `Backup contains an unsafe storage key: ${value.storageKey}`,
        { cause: error }
      );
    }
    return {
      storageKey: value.storageKey,
      byteCount: value.byteCount as number,
      sha256: value.sha256
    };
  });
  references.sort((left, right) => left.storageKey.localeCompare(right.storageKey));
  for (let index = 1; index < references.length; index += 1) {
    if (references[index - 1]!.storageKey === references[index]!.storageKey) {
      throw new BackupRestoreError(
        'BACKUP_INVALID',
        `Backup contains duplicate storage key: ${references[index]!.storageKey}`
      );
    }
  }
  return references;
}

function backupManagedFilePath(root: string, storageKey: string): string {
  assertStorageKey(storageKey);
  return path.join(root, 'files', ...storageKey.split('/'));
}

async function listPrivateFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, segments: string[]): Promise<void> => {
    await assertPrivateDirectory(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new BackupRestoreError('BACKUP_INVALID', 'Backup contains a symbolic link.');
      }
      if (stat.isDirectory()) {
        await assertPrivateDirectory(absolutePath);
        await walk(absolutePath, [...segments, entry.name]);
        continue;
      }
      if (
        !stat.isFile() ||
        !isOwnedByCurrentUser(stat) ||
        !hasNoGroupOrOtherPosixAccess(stat)
      ) {
        throw new BackupRestoreError('BACKUP_INVALID', 'Backup contains an unsafe file.');
      }
      files.push([...segments, entry.name].join('/'));
    }
  };
  await walk(root, []);
  files.sort();
  return files;
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    throw new BackupRestoreError('BACKUP_INVALID', `Backup directory is unavailable: ${directory}`, {
      cause: error
    });
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !isOwnedByCurrentUser(stat) ||
    !hasNoGroupOrOtherPosixAccess(stat)
  ) {
    throw new BackupRestoreError('BACKUP_INVALID', `Directory is not private: ${directory}`);
  }
}

async function removeGeneratedDirectory(directory: string, expectedParent: string): Promise<void> {
  if (path.dirname(directory) !== expectedParent || !path.basename(directory).startsWith('.')) {
    throw new Error('Refusing to remove an unexpected staging directory.');
  }
  const stat = await lstatIfExists(directory);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isOwnedByCurrentUser(stat)) {
    throw new Error('Refusing to remove an unsafe staging directory.');
  }
  await fs.rm(directory, { recursive: true });
  await syncDirectoryIfSupported(expectedParent);
}

function createBackupId(createdAt: string, id: string): string {
  const backupId = `backup-${createdAt.replace(/[-:.]/gu, '')}-${id}`;
  assertBackupId(backupId);
  return backupId;
}

function assertBackupId(backupId: string): void {
  if (!BACKUP_ID.test(backupId)) {
    throw new BackupRestoreError('BACKUP_INVALID', 'Backup ID is invalid.');
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[-:.]/gu, '');
}

function invalidManifest(): never {
  throw new BackupRestoreError('BACKUP_INVALID', 'Backup manifest is invalid.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathsOverlap(left: string, right: string): boolean {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  return (
    relativeLeft === '' ||
    (!relativeLeft.startsWith('..') && !path.isAbsolute(relativeLeft)) ||
    (!relativeRight.startsWith('..') && !path.isAbsolute(relativeRight))
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function lstatIfExists(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function makeMutablePrivateFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  try {
    await enforcePosixMode(handle, 0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryIfSupported(path.dirname(filePath));
}
