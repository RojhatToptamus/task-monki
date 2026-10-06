import { DatabaseSync } from 'node:sqlite';
import { DATABASE_MIGRATIONS } from '../core/storage/sqlite/DatabaseMigrations';

/** Restore the empty runtime schema when a migration fixture downgrades a current database. */
export function restoreLegacyPreviewSchema(database: DatabaseSync): void {
  const legacy = new DatabaseSync(':memory:');
  try {
    for (const migration of DATABASE_MIGRATIONS.filter(
      (entry) => entry.version < 10
    )) {
      legacy.exec(migration.sql);
    }
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM preview_generations')
      .get()!.count;
    if (count !== 0)
      throw new Error('Legacy fixture requires an empty preview history.');
    database.exec('DROP TABLE preview_generations');
    const schema = legacy
      .prepare(
        `SELECT sql FROM sqlite_master
      WHERE tbl_name LIKE 'preview_%' AND sql IS NOT NULL
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`
      )
      .all();
    for (const entry of schema) database.exec(String(entry.sql));
    database.exec(
      'ALTER TABLE task_domain_events ADD COLUMN preview_plan_id TEXT'
    );
  } finally {
    legacy.close();
  }
}
