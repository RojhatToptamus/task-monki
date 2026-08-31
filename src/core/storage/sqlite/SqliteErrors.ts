export type SqliteFailureKind =
  | 'BUSY'
  | 'CONSTRAINT'
  | 'CORRUPT'
  | 'FULL'
  | 'IO'
  | 'NOT_DATABASE'
  | 'READ_ONLY'
  | 'SCHEMA'
  | 'UNKNOWN';

interface NodeSqliteError extends Error {
  code?: string;
  errcode?: number;
  errstr?: string;
}

const SQLITE_PRIMARY_RESULT = {
  BUSY: 5,
  LOCKED: 6,
  READ_ONLY: 8,
  IO: 10,
  CORRUPT: 11,
  FULL: 13,
  SCHEMA: 17,
  CONSTRAINT: 19,
  NOT_DATABASE: 26
} as const;

export class SqlitePersistenceError extends Error {
  readonly kind: SqliteFailureKind;
  readonly sqliteCode?: string;
  readonly sqliteResultCode?: number;

  constructor(
    message: string,
    options: {
      kind: SqliteFailureKind;
      sqliteCode?: string;
      sqliteResultCode?: number;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = 'SqlitePersistenceError';
    this.kind = options.kind;
    this.sqliteCode = options.sqliteCode;
    this.sqliteResultCode = options.sqliteResultCode;
  }
}

export class DatabaseIdentityError extends SqlitePersistenceError {
  constructor(message: string) {
    super(message, { kind: 'SCHEMA' });
    this.name = 'DatabaseIdentityError';
  }
}

export class DatabaseVersionError extends SqlitePersistenceError {
  readonly actualVersion: number;
  readonly supportedVersion: number;

  constructor(actualVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${actualVersion} is newer than supported version ${supportedVersion}.`,
      { kind: 'SCHEMA' }
    );
    this.name = 'DatabaseVersionError';
    this.actualVersion = actualVersion;
    this.supportedVersion = supportedVersion;
  }
}

export interface DatabaseIntegrityIssue {
  kind: 'DATABASE' | 'FOREIGN_KEY';
  detail: string;
  table?: string;
  rowId?: number | bigint | null;
  parentTable?: string;
  foreignKeyIndex?: number | bigint;
}

export class DatabaseIntegrityError extends SqlitePersistenceError {
  readonly issues: readonly DatabaseIntegrityIssue[];

  constructor(issues: readonly DatabaseIntegrityIssue[]) {
    super(`Database integrity check failed with ${issues.length} issue(s).`, {
      kind: 'CORRUPT'
    });
    this.name = 'DatabaseIntegrityError';
    this.issues = issues;
  }
}

export class DatabasePostCommitError extends Error {
  readonly committed = true;

  constructor(cause: unknown) {
    super('The database transaction committed, but an after-commit callback failed.', { cause });
    this.name = 'DatabasePostCommitError';
  }
}

function isNodeSqliteError(error: unknown): error is NodeSqliteError {
  return (
    error instanceof Error &&
    ('errcode' in error || (error as NodeSqliteError).code === 'ERR_SQLITE_ERROR')
  );
}

export function classifySqliteFailure(error: unknown): SqliteFailureKind {
  if (!isNodeSqliteError(error) || typeof error.errcode !== 'number') return 'UNKNOWN';

  // Extended SQLite result codes retain the primary code in the low byte.
  const primaryCode = error.errcode & 0xff;
  if (primaryCode === SQLITE_PRIMARY_RESULT.BUSY || primaryCode === SQLITE_PRIMARY_RESULT.LOCKED) {
    return 'BUSY';
  }
  if (primaryCode === SQLITE_PRIMARY_RESULT.CONSTRAINT) return 'CONSTRAINT';
  if (primaryCode === SQLITE_PRIMARY_RESULT.CORRUPT) return 'CORRUPT';
  if (primaryCode === SQLITE_PRIMARY_RESULT.FULL) return 'FULL';
  if (primaryCode === SQLITE_PRIMARY_RESULT.IO) return 'IO';
  if (primaryCode === SQLITE_PRIMARY_RESULT.NOT_DATABASE) return 'NOT_DATABASE';
  if (primaryCode === SQLITE_PRIMARY_RESULT.READ_ONLY) return 'READ_ONLY';
  if (primaryCode === SQLITE_PRIMARY_RESULT.SCHEMA) return 'SCHEMA';
  return 'UNKNOWN';
}

export function translateSqliteError(error: unknown, operation: string): unknown {
  if (error instanceof SqlitePersistenceError || !isNodeSqliteError(error)) return error;

  return new SqlitePersistenceError(`${operation}: ${error.message}`, {
    kind: classifySqliteFailure(error),
    sqliteCode: error.code,
    sqliteResultCode: error.errcode,
    cause: error
  });
}

export function isSqliteCorruptionError(error: unknown): boolean {
  return (
    error instanceof DatabaseIntegrityError ||
    (error instanceof SqlitePersistenceError &&
      (error.kind === 'CORRUPT' || error.kind === 'NOT_DATABASE')) ||
    classifySqliteFailure(error) === 'CORRUPT' ||
    classifySqliteFailure(error) === 'NOT_DATABASE'
  );
}
