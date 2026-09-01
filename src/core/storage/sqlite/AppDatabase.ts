import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  backup as sqliteBackup,
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementResultingChanges
} from 'node:sqlite';
import {
  ensurePrivateDirectory,
  enforcePosixMode,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported
} from '../../filesystem/secureFilesystem';
import {
  acquireStoreOwnershipLease,
  releaseStoreOwnershipLease,
  STORE_OWNERSHIP_LEASE_FILE,
  type StoreOwnershipLease
} from '../StoreOwnershipLease';
import {
  APP_DATABASE_APPLICATION_ID,
  APP_DATABASE_SCHEMA_VERSION,
  DATABASE_MIGRATIONS,
  validateDatabaseMigrations
} from './DatabaseMigrations';
import {
  DatabaseIdentityError,
  DatabaseIntegrityError,
  type DatabaseIntegrityIssue,
  DatabasePostCommitError,
  DatabaseVersionError,
  SqlitePersistenceError,
  translateSqliteError
} from './SqliteErrors';

export type SqlValue = SQLInputValue;
export type SqlRowValue = SQLOutputValue;
export type SqlParameters =
  | readonly SqlValue[]
  | Readonly<Record<string, SqlValue>>;
export type SqlRunResult = StatementResultingChanges;

export interface SqlReader {
  get<T = Record<string, SqlRowValue>>(sql: string, parameters?: SqlParameters): T | undefined;
  all<T = Record<string, SqlRowValue>>(sql: string, parameters?: SqlParameters): T[];
}

export interface DatabaseIntegrityResult {
  readonly mode: 'quick' | 'full';
  readonly checkedAt: string;
}

export interface DatabaseVerificationResult {
  readonly applicationId: number;
  readonly schemaVersion: number;
  readonly integrity: DatabaseIntegrityResult;
}

export interface OpenAppDatabaseOptions {
  /** Disable only for isolated tests. File-backed application databases must retain this guard. */
  acquireLease?: boolean;
  /**
   * Optional profile-level lease path. Restore flows use the same sibling
   * lease so ownership remains stable while the storage directory is swapped.
   */
  ownershipLeasePath?: string;
  /** Must publish and verify a complete restorable backup before a file-backed schema upgrade. */
  beforeSchemaUpgrade?: (context: {
    database: AppDatabase;
    currentVersion: number;
    targetVersion: number;
  }) => Promise<void>;
}

export interface VerifyDatabaseOptions {
  expectedApplicationId?: number;
  expectedSchemaVersion?: number;
  integrityMode?: 'quick' | 'full';
}

type TransactionCallback = () => void;
type DeferredTransactionCallback = () => void | Promise<void>;

interface CommittedWrite<T> {
  readonly status: 'COMMITTED';
  readonly result: T;
  readonly callbackError?: unknown;
  readonly deferredCallbacks: readonly DeferredTransactionCallback[];
}

interface RolledBackWrite {
  readonly status: 'ROLLED_BACK';
  readonly error: unknown;
  readonly rollbackError?: unknown;
  readonly callbackError?: unknown;
  readonly deferredCallbacks: readonly DeferredTransactionCallback[];
}

type WriteOutcome<T> = CommittedWrite<T> | RolledBackWrite;

export class AppDatabaseTransaction implements SqlReader {
  readonly id = randomUUID();
  private readonly values = new Map<unknown, unknown>();
  private readonly commitCallbacks: TransactionCallback[] = [];
  private readonly rollbackCallbacks: TransactionCallback[] = [];
  private readonly deferredCommitCallbacks: DeferredTransactionCallback[] = [];
  private readonly deferredRollbackCallbacks: DeferredTransactionCallback[] = [];
  private phase: 'ACTIVE' | 'COMMITTED' | 'ROLLED_BACK' = 'ACTIVE';

  constructor(private readonly owner: AppDatabase) {}

  run(sql: string, parameters: SqlParameters = []): SqlRunResult {
    this.assertActive();
    return this.owner.runInContext(this, sql, parameters);
  }

  get<T = Record<string, SqlRowValue>>(
    sql: string,
    parameters: SqlParameters = []
  ): T | undefined {
    this.assertActive();
    return this.owner.getInContext<T>(this, sql, parameters);
  }

  all<T = Record<string, SqlRowValue>>(sql: string, parameters: SqlParameters = []): T[] {
    this.assertActive();
    return this.owner.allInContext<T>(this, sql, parameters);
  }

  getLocal<T>(key: unknown): T | undefined {
    this.assertActive();
    return this.values.get(key) as T | undefined;
  }

  setLocal<T>(key: unknown, value: T): T {
    this.assertActive();
    this.values.set(key, value);
    return value;
  }

  getOrCreateLocal<T>(key: unknown, create: () => T): T {
    this.assertActive();
    if (this.values.has(key)) return this.values.get(key) as T;
    return this.setLocal(key, create());
  }

  /** Publishes in-memory state synchronously after SQLite commits. */
  afterCommit(callback: TransactionCallback): void {
    this.assertActive();
    this.commitCallbacks.push(callback);
  }

  /** Publishes in-memory state synchronously after SQLite rolls back. */
  afterRollback(callback: TransactionCallback): void {
    this.assertActive();
    this.rollbackCallbacks.push(callback);
  }

  /** Runs outside the serialized database queue, while the write promise remains pending. */
  afterCommitDeferred(callback: DeferredTransactionCallback): void {
    this.assertActive();
    this.deferredCommitCallbacks.push(callback);
  }

  /** Runs outside the serialized database queue, while the write promise remains pending. */
  afterRollbackDeferred(callback: DeferredTransactionCallback): void {
    this.assertActive();
    this.deferredRollbackCallbacks.push(callback);
  }

  belongsTo(database: AppDatabase): boolean {
    return this.owner === database;
  }

  markCommitted(): void {
    this.phase = 'COMMITTED';
  }

  markRolledBack(): void {
    this.phase = 'ROLLED_BACK';
  }

  publishCommit(): void {
    publishSynchronousCallbacks(this.commitCallbacks, 'after-commit');
  }

  publishRollback(): void {
    publishSynchronousCallbacks(this.rollbackCallbacks, 'after-rollback');
  }

  takeDeferredCommitCallbacks(): readonly DeferredTransactionCallback[] {
    return this.deferredCommitCallbacks.splice(0);
  }

  takeDeferredRollbackCallbacks(): readonly DeferredTransactionCallback[] {
    return this.deferredRollbackCallbacks.splice(0);
  }

  private assertActive(): void {
    if (this.phase !== 'ACTIVE') {
      throw new Error(`Database transaction ${this.id} is already ${this.phase.toLowerCase()}.`);
    }
  }
}

/**
 * Owns Task Monki's single SQLite connection and serializes all reads, writes,
 * backups, and shutdown. A write callback may await nested store calls, but it
 * must not await external I/O while the SQLite transaction is open.
 */
export class AppDatabase implements SqlReader {
  private readonly transactionStorage = new AsyncLocalStorage<AppDatabaseTransaction>();
  private readonly deferredCallbackStorage = new AsyncLocalStorage<boolean>();
  private queue: Promise<void> = Promise.resolve();
  private readonly activeWriteCompletions = new Set<Promise<unknown>>();
  private activeTransaction?: AppDatabaseTransaction;
  private admissionClosed = false;
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(
    readonly databasePath: string,
    private readonly database: DatabaseSync,
    private readonly leaseRoot?: string,
    private readonly leasePath?: string,
    private readonly lease?: StoreOwnershipLease,
    private readonly beforeSchemaUpgrade?: OpenAppDatabaseOptions['beforeSchemaUpgrade']
  ) {}

  static async open(
    databasePath: string,
    options: OpenAppDatabaseOptions = {}
  ): Promise<AppDatabase> {
    if (databasePath === ':memory:') {
      const database = openConnection(databasePath, false);
      const owner = new AppDatabase(databasePath, database);
      owner.configureWritableConnection(false);
      await owner.applyMigrations();
      return owner;
    }

    const resolvedPath = path.resolve(databasePath);
    const storageRoot = path.dirname(resolvedPath);
    await ensurePrivateDirectory(storageRoot);
    await assertSafeDatabaseTarget(resolvedPath, false);

    const leasePath = options.ownershipLeasePath
      ? path.resolve(options.ownershipLeasePath)
      : path.join(storageRoot, STORE_OWNERSHIP_LEASE_FILE);
    const leaseRoot = path.dirname(leasePath);
    await ensurePrivateDirectory(leaseRoot);
    if (leasePath === resolvedPath) {
      throw new Error('The application database and ownership lease paths must be distinct.');
    }

    const lease =
      options.acquireLease === false
        ? undefined
        : await acquireStoreOwnershipLease(
            leaseRoot,
            leasePath
          );
    let database: DatabaseSync | undefined;
    try {
      database = openConnection(resolvedPath, false);
      await enforcePosixMode(resolvedPath, 0o600);
      const owner = new AppDatabase(
        resolvedPath,
        database,
        leaseRoot,
        leasePath,
        lease,
        options.beforeSchemaUpgrade
      );
      owner.configureWritableConnection(true);
      await owner.applyMigrations();
      return owner;
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the open/migration error. The process has no usable connection.
      }
      if (lease) {
        try {
          await releaseStoreOwnershipLease(
            leaseRoot,
            leasePath,
            lease
          );
        } catch (releaseError) {
          throw new AggregateError(
            [translateSqliteError(error, 'Opening the application database'), releaseError],
            'The application database failed to open and its ownership lease could not be released.'
          );
        }
      }
      throw translateSqliteError(error, 'Opening the application database');
    }
  }

  static openReadOnly(databasePath: string): AppDatabase {
    const resolvedPath = path.resolve(databasePath);
    assertSafeDatabaseTargetSync(resolvedPath);
    try {
      const database = openConnection(resolvedPath, true);
      const owner = new AppDatabase(resolvedPath, database);
      owner.configureReadOnlyConnection();
      return owner;
    } catch (error) {
      throw translateSqliteError(error, 'Opening the application database read-only');
    }
  }

  static async verifyFile(
    databasePath: string,
    options: VerifyDatabaseOptions = {}
  ): Promise<DatabaseVerificationResult> {
    const database = AppDatabase.openReadOnly(databasePath);
    try {
      const applicationId = database.readPragmaInteger('application_id');
      const schemaVersion = database.readPragmaInteger('user_version');
      const expectedApplicationId =
        options.expectedApplicationId ?? APP_DATABASE_APPLICATION_ID;
      const expectedSchemaVersion =
        options.expectedSchemaVersion ?? APP_DATABASE_SCHEMA_VERSION;
      if (applicationId !== expectedApplicationId) {
        throw new DatabaseIdentityError(
          `Database application id ${applicationId} does not match Task Monki id ${expectedApplicationId}.`
        );
      }
      if (schemaVersion !== expectedSchemaVersion) {
        throw new DatabaseIdentityError(
          `Database schema version ${schemaVersion} does not match expected version ${expectedSchemaVersion}.`
        );
      }
      return {
        applicationId,
        schemaVersion,
        integrity: database.checkIntegrity(options.integrityMode ?? 'full')
      };
    } finally {
      await database.close();
    }
  }

  get schemaVersion(): number {
    return this.readPragmaInteger('user_version');
  }

  get applicationId(): number {
    return this.readPragmaInteger('application_id');
  }

  async write<T>(
    callback: (transaction: AppDatabaseTransaction) => T | Promise<T>
  ): Promise<T> {
    const current = this.transactionStorage.getStore();
    if (current) {
      if (!current.belongsTo(this)) {
        throw new Error('A write cannot span two application databases.');
      }
      return callback(current);
    }
    this.assertAdmitting();
    return this.trackWriteCompletion(this.performTopLevelWrite(callback));
  }

  transaction<T>(
    callback: (transaction: AppDatabaseTransaction) => T | Promise<T>
  ): Promise<T> {
    return this.write(callback);
  }

  getTransactionLocal<T>(key: unknown): T | undefined {
    const transaction = this.transactionStorage.getStore();
    if (!transaction?.belongsTo(this)) return undefined;
    return transaction.getLocal<T>(key);
  }

  hasCurrentWriteTransaction(): boolean {
    return this.transactionStorage.getStore()?.belongsTo(this) === true;
  }

  async read<T>(callback: (reader: SqlReader) => T | Promise<T>): Promise<T> {
    const current = this.transactionStorage.getStore();
    if (current) {
      if (!current.belongsTo(this)) {
        throw new Error('A read cannot span two application databases.');
      }
      return callback(current);
    }
    this.assertAdmitting();
    return this.enqueue(() => callback(this));
  }

  run(sql: string, parameters: SqlParameters = []): SqlRunResult {
    const transaction = this.transactionStorage.getStore();
    if (!transaction?.belongsTo(this)) {
      throw new Error('Database writes require an active AppDatabase.write transaction.');
    }
    return this.runInContext(transaction, sql, parameters);
  }

  get<T = Record<string, SqlRowValue>>(
    sql: string,
    parameters: SqlParameters = []
  ): T | undefined {
    this.assertSynchronousReadAllowed();
    return this.executeStatement(sql, parameters, 'get') as T | undefined;
  }

  all<T = Record<string, SqlRowValue>>(sql: string, parameters: SqlParameters = []): T[] {
    this.assertSynchronousReadAllowed();
    return this.executeStatement(sql, parameters, 'all') as T[];
  }

  async backup(destinationPath: string): Promise<void> {
    this.assertAdmitting();
    if (this.transactionStorage.getStore()) {
      throw new Error('Database backup cannot start inside a write transaction.');
    }
    await this.enqueue(async () => {
      const resolvedDestination = path.resolve(destinationPath);
      await ensurePrivateDirectory(path.dirname(resolvedDestination));
      try {
        await fs.lstat(resolvedDestination);
        throw new Error('Database backup destination already exists.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await sqliteBackup(this.database, resolvedDestination);
        await enforcePosixMode(resolvedDestination, 0o600);
        await syncDirectoryIfSupported(path.dirname(resolvedDestination));
      } catch (error) {
        await fs.unlink(resolvedDestination).catch(() => undefined);
        await syncDirectoryIfSupported(path.dirname(resolvedDestination)).catch(() => undefined);
        throw translateSqliteError(error, 'Backing up the application database');
      }
    });
  }

  checkIntegrity(mode: 'quick' | 'full' = 'quick'): DatabaseIntegrityResult {
    this.assertSynchronousReadAllowed();
    const pragma = mode === 'quick' ? 'quick_check' : 'integrity_check';
    let rows: Array<Record<string, SqlRowValue>>;
    let foreignKeyRows: Array<Record<string, SqlRowValue>>;
    try {
      rows = this.database.prepare(`PRAGMA ${pragma}`).all();
      foreignKeyRows = this.database.prepare('PRAGMA foreign_key_check').all();
    } catch (error) {
      throw translateSqliteError(error, `Running SQLite ${pragma}`);
    }
    const issues: DatabaseIntegrityIssue[] = [];
    for (const row of rows) {
      const detail = row[pragma];
      if (detail !== 'ok') {
        issues.push({ kind: 'DATABASE', detail: String(detail ?? 'Unknown integrity error') });
      }
    }
    for (const row of foreignKeyRows) {
      issues.push({
        kind: 'FOREIGN_KEY',
        detail: `Foreign key ${String(row.fkid)} on ${String(row.table)} references ${String(row.parent)}.`,
        table: typeof row.table === 'string' ? row.table : undefined,
        rowId:
          typeof row.rowid === 'number' || typeof row.rowid === 'bigint' || row.rowid === null
            ? row.rowid
            : undefined,
        parentTable: typeof row.parent === 'string' ? row.parent : undefined,
        foreignKeyIndex:
          typeof row.fkid === 'number' || typeof row.fkid === 'bigint' ? row.fkid : undefined
      });
    }
    if (issues.length > 0) throw new DatabaseIntegrityError(issues);
    return { mode, checkedAt: new Date().toISOString() };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    if (this.transactionStorage.getStore()) {
      throw new Error('The application database cannot close inside a write transaction.');
    }
    if (this.deferredCallbackStorage.getStore()) {
      throw new Error('The application database cannot close inside deferred transaction work.');
    }
    this.admissionClosed = true;
    this.closePromise = this.closeOwnedConnection();
    return this.closePromise;
  }

  private async closeOwnedConnection(): Promise<void> {
    await this.drainWriteCompletions();
    await this.enqueue(async () => {
      if (this.closed) return;
      try {
        this.database.close();
        this.closed = true;
      } catch (error) {
        throw translateSqliteError(error, 'Closing the application database');
      }
      if (this.leaseRoot && this.lease) {
        await releaseStoreOwnershipLease(
          this.leaseRoot,
          this.leasePath!,
          this.lease
        );
      }
    }, true);
  }

  runInContext(
    transaction: AppDatabaseTransaction,
    sql: string,
    parameters: SqlParameters
  ): SqlRunResult {
    this.assertTransaction(transaction);
    return this.executeStatement(sql, parameters, 'run') as SqlRunResult;
  }

  getInContext<T>(
    transaction: AppDatabaseTransaction,
    sql: string,
    parameters: SqlParameters
  ): T | undefined {
    this.assertTransaction(transaction);
    return this.executeStatement(sql, parameters, 'get') as T | undefined;
  }

  allInContext<T>(
    transaction: AppDatabaseTransaction,
    sql: string,
    parameters: SqlParameters
  ): T[] {
    this.assertTransaction(transaction);
    return this.executeStatement(sql, parameters, 'all') as T[];
  }

  private async performTopLevelWrite<T>(
    callback: (transaction: AppDatabaseTransaction) => T | Promise<T>
  ): Promise<T> {
    const outcome = await this.enqueue(() => this.performWrite(callback));
    return this.completeWrite(outcome);
  }

  private async performWrite<T>(
    callback: (transaction: AppDatabaseTransaction) => T | Promise<T>
  ): Promise<WriteOutcome<T>> {
    this.assertOpen();
    const transaction = new AppDatabaseTransaction(this);
    this.activeTransaction = transaction;
    let began = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      began = true;
      const result = await this.transactionStorage.run(transaction, () => callback(transaction));
      this.database.exec('COMMIT');
      began = false;
      transaction.markCommitted();
      this.activeTransaction = undefined;
      let callbackError: unknown;
      try {
        transaction.publishCommit();
      } catch (error) {
        callbackError = error;
      }
      return {
        status: 'COMMITTED',
        result,
        callbackError,
        deferredCallbacks: transaction.takeDeferredCommitCallbacks()
      };
    } catch (error) {
      if (began) {
        let rollbackError: unknown;
        try {
          this.database.exec('ROLLBACK');
        } catch (caught) {
          rollbackError = translateSqliteError(caught, 'Rolling back the application transaction');
        }
        transaction.markRolledBack();
        this.activeTransaction = undefined;
        let callbackError: unknown;
        try {
          transaction.publishRollback();
        } catch (caught) {
          callbackError = caught;
        }
        return {
          status: 'ROLLED_BACK',
          error: translateSqliteError(error, 'Writing the application database'),
          rollbackError,
          callbackError,
          deferredCallbacks: transaction.takeDeferredRollbackCallbacks()
        };
      }
      this.activeTransaction = undefined;
      throw error;
    }
  }

  private async completeWrite<T>(outcome: WriteOutcome<T>): Promise<T> {
    let deferredError: unknown;
    try {
      await this.deferredCallbackStorage.run(true, () =>
        runDeferredCallbacks(outcome.deferredCallbacks)
      );
    } catch (error) {
      deferredError = error;
    }

    if (outcome.status === 'COMMITTED') {
      const callbackError = combineCallbackErrors(outcome.callbackError, deferredError);
      if (callbackError !== undefined) throw new DatabasePostCommitError(callbackError);
      return outcome.result;
    }

    const additional = [outcome.rollbackError, outcome.callbackError, deferredError].filter(
      (value): value is NonNullable<typeof value> => value !== undefined
    );
    if (additional.length > 0) {
      throw new AggregateError(
        [outcome.error, ...additional],
        'The application transaction failed and rollback cleanup was incomplete.'
      );
    }
    throw outcome.error;
  }

  private executeStatement(
    sql: string,
    parameters: SqlParameters,
    operation: 'all' | 'get' | 'run'
  ): unknown {
    this.assertOpen();
    try {
      const statement = this.database.prepare(sql);
      statement.setAllowBareNamedParameters(false);
      statement.setAllowUnknownNamedParameters(false);
      const args = Array.isArray(parameters)
        ? parameters
        : [parameters as Record<string, SqlValue>];
      return statement[operation](...(args as [Record<string, SqlValue>, ...SqlValue[]]));
    } catch (error) {
      throw translateSqliteError(error, `Executing SQLite statement (${operation})`);
    }
  }

  private configureWritableConnection(fileBacked: boolean): void {
    try {
      this.database.enableLoadExtension(false);
      enableDefensiveMode(this.database);
      this.database.exec(`
        PRAGMA busy_timeout = 0;
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = EXTRA;
      `);
      if (this.readPragmaInteger('foreign_keys') !== 1) {
        throw new Error('SQLite foreign key enforcement could not be enabled.');
      }
      if (this.readPragmaInteger('trusted_schema') !== 0) {
        throw new Error('SQLite trusted schema could not be disabled.');
      }
      const synchronous = this.readPragmaInteger('synchronous');
      if (synchronous !== 3) {
        throw new Error(`SQLite synchronous mode is ${synchronous}; EXTRA (3) is required.`);
      }
      const journal = this.database.prepare('PRAGMA journal_mode').get()?.journal_mode;
      if (fileBacked && journal !== 'delete') {
        throw new Error(`SQLite journal mode is ${String(journal)}; DELETE is required.`);
      }
    } catch (error) {
      throw translateSqliteError(error, 'Configuring the application database');
    }
  }

  private configureReadOnlyConnection(): void {
    try {
      this.database.enableLoadExtension(false);
      enableDefensiveMode(this.database);
      this.database.exec(`
        PRAGMA busy_timeout = 0;
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA query_only = ON;
      `);
    } catch (error) {
      try {
        this.database.close();
      } catch {
        // Keep the configuration failure.
      }
      throw translateSqliteError(error, 'Configuring a read-only application database');
    }
  }

  private async applyMigrations(): Promise<void> {
    validateDatabaseMigrations();
    const currentApplicationId = this.readPragmaInteger('application_id');
    const currentVersion = this.readPragmaInteger('user_version');
    if (currentApplicationId !== 0 && currentApplicationId !== APP_DATABASE_APPLICATION_ID) {
      throw new DatabaseIdentityError(
        `SQLite file belongs to application id ${currentApplicationId}, not Task Monki.`
      );
    }
    if (currentVersion > APP_DATABASE_SCHEMA_VERSION) {
      throw new DatabaseVersionError(currentVersion, APP_DATABASE_SCHEMA_VERSION);
    }
    if (currentVersion > 0 && currentApplicationId !== APP_DATABASE_APPLICATION_ID) {
      throw new DatabaseIdentityError('Versioned database is missing the Task Monki application id.');
    }
    if (currentVersion === 0 && currentApplicationId === 0 && this.hasApplicationTables()) {
      throw new DatabaseIdentityError('Refusing to initialize a non-empty unidentified SQLite database.');
    }

    if (currentVersion > 0 && currentVersion < APP_DATABASE_SCHEMA_VERSION) {
      if (this.databasePath !== ':memory:') {
        if (!this.beforeSchemaUpgrade) {
          throw new Error(
            `Database schema ${currentVersion} must be backed up before upgrading to ${APP_DATABASE_SCHEMA_VERSION}.`
          );
        }
        await this.beforeSchemaUpgrade({
          database: this,
          currentVersion,
          targetVersion: APP_DATABASE_SCHEMA_VERSION
        });
      }
    }

    for (const migration of DATABASE_MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      let began = false;
      try {
        this.database.exec('BEGIN IMMEDIATE');
        began = true;
        this.database.exec(migration.sql);
        this.checkIntegrity('quick');
        this.database.exec(`PRAGMA application_id = ${APP_DATABASE_APPLICATION_ID}`);
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
        this.database.exec('COMMIT');
        began = false;
      } catch (error) {
        if (began) {
          try {
            this.database.exec('ROLLBACK');
          } catch (rollbackError) {
            throw new AggregateError(
              [
                translateSqliteError(error, `Applying database migration ${migration.version}`),
                translateSqliteError(rollbackError, 'Rolling back database migration')
              ],
              `Database migration ${migration.version} failed and could not roll back cleanly.`
            );
          }
        }
        throw translateSqliteError(error, `Applying database migration ${migration.version}`);
      }
    }
  }

  private hasApplicationTables(): boolean {
    const row = this.database
      .prepare(
        `SELECT count(*) AS table_count
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
      )
      .get();
    return Number(row?.table_count ?? 0) > 0;
  }

  private readPragmaInteger(name: 'application_id' | 'foreign_keys' | 'synchronous' | 'trusted_schema' | 'user_version'): number {
    this.assertOpen();
    try {
      const row = this.database.prepare(`PRAGMA ${name}`).get();
      const value = row?.[name];
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(`SQLite PRAGMA ${name} did not return an integer.`);
      }
      return value;
    } catch (error) {
      throw translateSqliteError(error, `Reading SQLite PRAGMA ${name}`);
    }
  }

  private assertTransaction(transaction: AppDatabaseTransaction): void {
    this.assertOpen();
    if (this.activeTransaction !== transaction || !transaction.belongsTo(this)) {
      throw new Error('Database transaction context is not active on this connection.');
    }
  }

  private assertSynchronousReadAllowed(): void {
    this.assertOpen();
    const current = this.transactionStorage.getStore();
    if (this.activeTransaction && current !== this.activeTransaction) {
      throw new SqlitePersistenceError(
        'Database read must use AppDatabase.read while another write transaction is active.',
        { kind: 'BUSY' }
      );
    }
  }

  private assertAdmitting(): void {
    this.assertOpen();
    if (this.admissionClosed && !this.deferredCallbackStorage.getStore()) {
      throw new Error('The application database is closing.');
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('The application database is closed.');
  }

  private enqueue<T>(operation: () => T | Promise<T>, allowAfterAdmissionClosed = false): Promise<T> {
    if (!allowAfterAdmissionClosed) this.assertAdmitting();
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private trackWriteCompletion<T>(operation: Promise<T>): Promise<T> {
    this.activeWriteCompletions.add(operation);
    void operation.then(
      () => this.activeWriteCompletions.delete(operation),
      () => this.activeWriteCompletions.delete(operation)
    );
    return operation;
  }

  private async drainWriteCompletions(): Promise<void> {
    while (this.activeWriteCompletions.size > 0) {
      await Promise.allSettled([...this.activeWriteCompletions]);
    }
  }
}

async function runDeferredCallbacks(
  callbacks: readonly DeferredTransactionCallback[]
): Promise<void> {
  for (const callback of callbacks) await callback();
}

function combineCallbackErrors(left: unknown, right: unknown): unknown {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return new AggregateError(
    [left, right],
    'Synchronous and deferred after-commit callbacks both failed.'
  );
}

function assertSynchronousCallback(result: unknown): void {
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    'then' in result &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error(
      'Transaction publication callbacks must be synchronous; use a deferred callback for asynchronous work.'
    );
  }
}

function publishSynchronousCallbacks(
  callbacks: readonly TransactionCallback[],
  phase: 'after-commit' | 'after-rollback'
): void {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    try {
      assertSynchronousCallback(callback());
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Multiple ${phase} publication callbacks failed.`
    );
  }
}

function openConnection(databasePath: string, readOnly: boolean): DatabaseSync {
  return new DatabaseSync(databasePath, {
    readOnly,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 0,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    defensive: true
  });
}

function enableDefensiveMode(database: DatabaseSync): void {
  const optional = database as DatabaseSync & { enableDefensive?: (active: boolean) => void };
  optional.enableDefensive?.(true);
}

async function assertSafeDatabaseTarget(databasePath: string, mustExist: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(databasePath);
    if (stat.isSymbolicLink() || !stat.isFile() || !isOwnedByCurrentUser(stat)) {
      throw new Error('Application database path failed its integrity check.');
    }
  } catch (error) {
    if (!mustExist && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function assertSafeDatabaseTargetSync(databasePath: string): void {
  const stat = fsSync.lstatSync(databasePath);
  if (stat.isSymbolicLink() || !stat.isFile() || !isOwnedByCurrentUser(stat)) {
    throw new Error('Application database path failed its integrity check.');
  }
}
