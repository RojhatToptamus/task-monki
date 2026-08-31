import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_DATABASE_APPLICATION_ID,
  APP_DATABASE_SCHEMA_VERSION,
  validateDatabaseMigrations
} from './DatabaseMigrations';
import { AppDatabase } from './AppDatabase';
import {
  DatabaseIdentityError,
  DatabaseIntegrityError,
  DatabasePostCommitError,
  DatabaseVersionError,
  SqlitePersistenceError,
  isSqliteCorruptionError
} from './SqliteErrors';

const databases: AppDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('AppDatabase', () => {
  it('creates the normalized schema with the required durability configuration', async () => {
    const { database, databasePath } = await createDatabase();

    expect(database.applicationId).toBe(APP_DATABASE_APPLICATION_ID);
    expect(database.schemaVersion).toBe(APP_DATABASE_SCHEMA_VERSION);
    expect(database.get<{ journal_mode: string }>('PRAGMA journal_mode')).toEqual({
      journal_mode: 'delete'
    });
    expect(database.get<{ synchronous: number }>('PRAGMA synchronous')).toEqual({ synchronous: 3 });
    expect(database.get<{ foreign_keys: number }>('PRAGMA foreign_keys')).toEqual({
      foreign_keys: 1
    });
    expect(database.get<{ trusted_schema: number }>('PRAGMA trusted_schema')).toEqual({
      trusted_schema: 0
    });
    expect(
      database
        .all<{ name: string }>(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name IN (
             'tasks', 'runtime_runs', 'discourse_conversations',
             'preview_generations', 'managed_files', 'app_settings'
           )
           ORDER BY name`
        )
        .map((row) => row.name)
    ).toEqual([
      'app_settings',
      'discourse_conversations',
      'managed_files',
      'preview_generations',
      'runtime_runs',
      'tasks'
    ]);
    expect(
      database.get(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name = 'runtime_access_epochs'`
      )
    ).toBeUndefined();
    expect(
      database
        .all<{ from: string }>('PRAGMA foreign_key_list(tasks)')
        .some((foreignKey) => foreignKey.from === 'source_design_id')
    ).toBe(false);
    expect(
      database
        .all<{ from: string }>('PRAGMA foreign_key_list(preview_generations)')
        .some((foreignKey) => foreignKey.from === 'replaces_generation_id')
    ).toBe(false);
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('commits nested writes once and publishes transaction-local state after commit', async () => {
    const { database } = await createDatabase();
    const localKey = Symbol('test-local');
    const events: string[] = [];

    await database.write(async (outer) => {
      outer.run(
        `INSERT INTO store_metadata (
           domain, record_revision, payload_json, updated_at
         ) VALUES (?, ?, ?, ?)`,
        ['test', 0, '{}', '2026-08-29T10:00:00.000Z']
      );
      outer.setLocal(localKey, { value: 1 });
      outer.afterCommit(() => {
        events.push('committed');
      });

      await database.write((inner) => {
        expect(inner).toBe(outer);
        expect(database.getTransactionLocal<{ value: number }>(localKey)).toEqual({ value: 1 });
        inner.run('UPDATE store_metadata SET record_revision = ? WHERE domain = ?', [1, 'test']);
      });
      expect(events).toEqual([]);
    });

    expect(events).toEqual(['committed']);
    expect(database.getTransactionLocal(localKey)).toBeUndefined();
    expect(database.get<{ record_revision: number }>(
      'SELECT record_revision FROM store_metadata WHERE domain = ?',
      ['test']
    )).toEqual({ record_revision: 1 });
  });

  it('rolls back the complete outer write and runs rollback cleanup', async () => {
    const { database } = await createDatabase();
    const callbacks: string[] = [];

    await expect(
      database.write(async (transaction) => {
        transaction.run(
          'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
          ['rolled-back', 0, '{}']
        );
        transaction.afterCommit(() => {
          callbacks.push('commit');
        });
        transaction.afterRollback(() => {
          callbacks.push('rollback');
        });
        await database.write((nested) => {
          nested.run('UPDATE store_metadata SET record_revision = 1 WHERE domain = ?', [
            'rolled-back'
          ]);
        });
        throw new Error('stop');
      })
    ).rejects.toThrow('stop');

    expect(callbacks).toEqual(['rollback']);
    expect(database.get('SELECT domain FROM store_metadata WHERE domain = ?', ['rolled-back'])).toBeUndefined();
  });

  it('serializes concurrent asynchronous writers', async () => {
    const { database } = await createDatabase();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = database.write(async (transaction) => {
      order.push('first-start');
      transaction.run(
        'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
        ['first', 0, '{}']
      );
      await firstCanFinish;
      order.push('first-end');
    });
    const second = database.write((transaction) => {
      order.push('second');
      transaction.run(
        'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
        ['second', 0, '{}']
      );
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('releases the database queue while deferred commit work keeps the write pending', async () => {
    const { database } = await createDatabase();
    const order: string[] = [];
    let releaseDeferred!: () => void;
    let markDeferredStarted!: () => void;
    const deferredCanFinish = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    const deferredStarted = new Promise<void>((resolve) => {
      markDeferredStarted = resolve;
    });
    let firstSettled = false;

    const first = database.write((transaction) => {
      transaction.run(
        'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
        ['deferred-first', 0, '{}']
      );
      transaction.afterCommitDeferred(async () => {
        order.push('deferred-start');
        markDeferredStarted();
        await deferredCanFinish;
        order.push('deferred-end');
      });
    }).then(() => {
      firstSettled = true;
    });

    await deferredStarted;
    await database.write((transaction) => {
      order.push('second-write');
      transaction.run(
        'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
        ['deferred-second', 0, '{}']
      );
    });

    expect(order).toEqual(['deferred-start', 'second-write']);
    expect(firstSettled).toBe(false);
    releaseDeferred();
    await first;
    expect(order).toEqual(['deferred-start', 'second-write', 'deferred-end']);
  });

  it('runs nested deferred rollback cleanup outside the queue before rejecting the outer write', async () => {
    const { database } = await createDatabase();
    let releaseCleanup!: () => void;
    let markCleanupStarted!: () => void;
    const cleanupCanFinish = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let outerSettled = false;

    const outer = database.write(async (transaction) => {
      transaction.run(
        'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
        ['nested-rollback', 0, '{}']
      );
      await database.write((nested) => {
        expect(nested).toBe(transaction);
        nested.afterRollbackDeferred(async () => {
          markCleanupStarted();
          await cleanupCanFinish;
        });
      });
      throw new Error('roll back outer');
    }).then(
      () => undefined,
      (error: unknown) => error
    ).finally(() => {
      outerSettled = true;
    });

    await cleanupStarted;
    await database.write((transaction) => {
      transaction.run(
        'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
        ['after-rollback', 0, '{}']
      );
    });
    expect(outerSettled).toBe(false);
    expect(database.get('SELECT domain FROM store_metadata WHERE domain = ?', ['nested-rollback'])).toBeUndefined();

    releaseCleanup();
    await expect(outer).resolves.toMatchObject({ message: 'roll back outer' });
  });

  it('preserves post-commit and rollback-cleanup error classification for deferred work', async () => {
    const { database } = await createDatabase();

    const committedError = await database.write((transaction) => {
      transaction.afterCommitDeferred(() => {
        throw new Error('deferred commit failed');
      });
    }).catch((error: unknown) => error);
    expect(committedError).toBeInstanceOf(DatabasePostCommitError);
    expect((committedError as Error & { cause?: unknown }).cause).toMatchObject({
      message: 'deferred commit failed'
    });

    const rollbackError = await database.write((transaction) => {
      transaction.afterRollbackDeferred(() => {
        throw new Error('deferred rollback failed');
      });
      throw new Error('write failed');
    }).catch((error: unknown) => error);
    expect(rollbackError).toBeInstanceOf(AggregateError);
    expect((rollbackError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'write failed' }),
      expect.objectContaining({ message: 'deferred rollback failed' })
    ]);
  });

  it('attempts every synchronous publication callback after the database outcome is decided', async () => {
    const { database } = await createDatabase();
    const publications: string[] = [];

    const committedError = await database.write((transaction) => {
      transaction.afterCommit(() => {
        publications.push('commit-first');
        throw new Error('commit publication failed');
      });
      transaction.afterCommit(() => {
        publications.push('commit-second');
      });
    }).catch((error: unknown) => error);
    expect(committedError).toBeInstanceOf(DatabasePostCommitError);
    expect(publications).toEqual(['commit-first', 'commit-second']);

    const rollbackError = await database.write((transaction) => {
      transaction.afterRollback(() => {
        publications.push('rollback-first');
        throw new Error('rollback publication failed');
      });
      transaction.afterRollback(() => {
        publications.push('rollback-second');
      });
      throw new Error('write failed');
    }).catch((error: unknown) => error);
    expect(rollbackError).toBeInstanceOf(AggregateError);
    expect(publications).toEqual([
      'commit-first',
      'commit-second',
      'rollback-first',
      'rollback-second'
    ]);
  });

  it('drains admitted deferred work before closing the connection and releasing its lease', async () => {
    const { database, databasePath } = await createDatabase();
    let releaseDeferred!: () => void;
    let markDeferredStarted!: () => void;
    const deferredCanContinue = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    const deferredStarted = new Promise<void>((resolve) => {
      markDeferredStarted = resolve;
    });

    const write = database.write((transaction) => {
      transaction.afterCommitDeferred(async () => {
        markDeferredStarted();
        await deferredCanContinue;
        await database.write((nestedTransaction) => {
          nestedTransaction.run(
            'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
            ['deferred-before-close', 0, '{}']
          );
        });
      });
    });
    await deferredStarted;

    const close = database.close();
    await expect(database.read(() => undefined)).rejects.toThrow('closing');
    releaseDeferred();
    await Promise.all([write, close]);

    const reopened = await AppDatabase.open(databasePath);
    databases.push(reopened);
    expect(
      reopened.get<{ domain: string }>(
        'SELECT domain FROM store_metadata WHERE domain = ?',
        ['deferred-before-close']
      )
    ).toEqual({ domain: 'deferred-before-close' });
  });

  it('classifies SQLite constraint failures without losing the native cause', async () => {
    const { database } = await createDatabase();

    const error = await database
      .write((transaction) => {
        transaction.run(
          'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
          ['invalid-json', 0, 'not-json']
        );
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SqlitePersistenceError);
    expect((error as SqlitePersistenceError).kind).toBe('CONSTRAINT');
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('creates an online backup that passes identity and full integrity verification', async () => {
    const { database, root } = await createDatabase();
    await database.write((transaction) => {
      transaction.run(
        'INSERT INTO store_metadata (domain, record_revision, payload_json) VALUES (?, ?, ?)',
        ['backup-record', 7, '{"present":true}']
      );
    });
    const backupPath = path.join(root, 'backups', 'task-monki.sqlite3');

    await database.backup(backupPath);

    await expect(AppDatabase.verifyFile(backupPath)).resolves.toMatchObject({
      applicationId: APP_DATABASE_APPLICATION_ID,
      schemaVersion: APP_DATABASE_SCHEMA_VERSION,
      integrity: { mode: 'full' }
    });
    const backup = AppDatabase.openReadOnly(backupPath);
    databases.push(backup);
    expect(backup.get<{ record_revision: number }>(
      'SELECT record_revision FROM store_metadata WHERE domain = ?',
      ['backup-record']
    )).toEqual({ record_revision: 7 });
    await expect(database.backup(backupPath)).rejects.toThrow('already exists');
  });

  it('keeps the profile lease for the complete connection lifetime', async () => {
    const { databasePath } = await createDatabase();

    await expect(AppDatabase.open(databasePath)).rejects.toThrow(
      `already owned by process ${process.pid}`
    );
  });

  it('rejects an unrelated or newer database without initializing it', async () => {
    const root = await createRoot();
    const unrelatedPath = path.join(root, 'unrelated.sqlite3');
    const unrelated = new DatabaseSync(unrelatedPath);
    unrelated.exec('PRAGMA application_id = 1234');
    unrelated.close();

    await expect(AppDatabase.open(unrelatedPath)).rejects.toBeInstanceOf(DatabaseIdentityError);

    const { database, databasePath } = await createDatabase();
    await closeDatabase(database);
    const newer = new DatabaseSync(databasePath);
    newer.exec(`PRAGMA user_version = ${APP_DATABASE_SCHEMA_VERSION + 1}`);
    newer.close();

    await expect(AppDatabase.open(databasePath)).rejects.toBeInstanceOf(DatabaseVersionError);
  });

  it('reports foreign-key damage and recognizes a non-database as corruption', async () => {
    const { database, databasePath } = await createDatabase();
    await closeDatabase(database);
    const damaged = new DatabaseSync(databasePath);
    damaged.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO board_repositories (board_id, repository_id, ordinal)
      VALUES ('missing-board', 'missing-repository', 0);
    `);
    damaged.close();

    const integrityError = await AppDatabase.verifyFile(databasePath).catch(
      (caught: unknown) => caught
    );
    expect(integrityError).toBeInstanceOf(DatabaseIntegrityError);
    expect(isSqliteCorruptionError(integrityError)).toBe(true);

    const invalidPath = path.join(await createRoot(), 'invalid.sqlite3');
    await fs.writeFile(invalidPath, 'not a sqlite database', { mode: 0o600 });
    const invalidError = await AppDatabase.verifyFile(invalidPath).catch(
      (caught: unknown) => caught
    );
    expect(isSqliteCorruptionError(invalidError)).toBe(true);
  });
});

describe('validateDatabaseMigrations', () => {
  it('rejects migration gaps and empty migration definitions', () => {
    expect(() =>
      validateDatabaseMigrations([{ version: 2, name: 'gap', sql: 'SELECT 1' }])
    ).toThrow('missing 1');
    expect(() =>
      validateDatabaseMigrations([{ version: 1, name: '', sql: 'SELECT 1' }])
    ).toThrow('must have a name');
    expect(() =>
      validateDatabaseMigrations([{ version: 1, name: 'empty', sql: ' ' }])
    ).toThrow('must have SQL');
  });
});

async function createDatabase(): Promise<{
  database: AppDatabase;
  databasePath: string;
  root: string;
}> {
  const root = await createRoot();
  const databasePath = path.join(root, 'storage-v2', 'task-monki.sqlite3');
  const database = await AppDatabase.open(databasePath);
  databases.push(database);
  return { database, databasePath, root };
}

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-database-'));
  roots.push(root);
  return root;
}

async function closeDatabase(database: AppDatabase): Promise<void> {
  await database.close();
  databases.splice(databases.indexOf(database), 1);
}
