import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_TASK_MANAGER_APP_SETTINGS } from '../../../shared/agent';
import { AppSettingsStore } from '../../settings/AppSettingsStore';
import { AppDatabase } from './AppDatabase';
import { APP_DATABASE_APPLICATION_ID, DATABASE_MIGRATIONS } from './DatabaseMigrations';

async function previousDatabase(live: boolean) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-preview-migration-'));
  const file = path.join(directory, 'application.sqlite');
  const old = new DatabaseSync(file);
  old.exec('PRAGMA foreign_keys = ON; BEGIN');
  for (const migration of DATABASE_MIGRATIONS.filter(value => value.version < 10)) old.exec(migration.sql);
  const insert = (table: string, row: Record<string, string | number>) => old.prepare(
    `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`
  ).run(...Object.values(row));
  const timestamp = '2026-10-01T00:00:00.000Z';
  const settings = { ...DEFAULT_TASK_MANAGER_APP_SETTINGS, schemaVersion: 13, theme: 'light', showMascot: false, selectedRepositoryId: 'repo', previewGateway: { port: 41234 } };
  insert('app_settings', { singleton_id: 1, record_revision: 7, settings_json: JSON.stringify(settings), updated_at: timestamp });
  const stored = { created_at: timestamp, updated_at: timestamp, payload_json: '{"retained":"original"}' };
  insert('repositories', { ...stored, id: 'repo', kind: 'USER_REGISTERED', name: 'repo', path: directory, status: 'READY', remotes_json: '[]' });
  insert('tasks', { ...stored, id: 'task', kind: 'DESIGN', runtime_id: 'codex', title: 'Retain task', prompt: 'Original prompt', repository_id: 'repo', workflow_phase: 'READY', resolution: 'NONE', completion_policy: 'MANUAL', phase_version: 1, agent_settings_json: '{}' });
  insert('task_iterations', { ...stored, id: 'iteration', task_id: 'task', action_request_id: 'action', generation_key: 'generation', status: 'READY', branch_name: 'main', base_sha: 'base' });
  insert('worktrees', { ...stored, id: 'worktree', task_id: 'task', iteration_id: 'iteration', repository_id: 'repo', worktree_path: directory, branch_name: 'main', base_sha: 'base', status: 'PRESENT' });
  insert('preview_plans', { id: 'plan', task_id: 'task', iteration_id: 'iteration', worktree_id: 'worktree', execution_digest: 'digest', created_at: timestamp, payload_json: '{}' });
  insert('preview_generations', { ...stored, id: 'generation', preview_key: 'preview', task_id: 'task', iteration_id: 'iteration', worktree_id: 'worktree', plan_id: 'plan', state: live ? 'CLEANUP_INCOMPLETE' : 'STOPPED', routing_state: 'RETIRED', payload_json: JSON.stringify({ id: 'generation', source: { type: 'EXACT_COMMIT', repositoryId: 'repo', commitSha: 'a'.repeat(40) }, planId: 'plan', executionAuthority: { type: 'MANAGED_STATIC' } }) });
  insert('preview_native_resources', { id: 'native', task_id: 'task', generation_id: 'generation', logical_node_id: 'web', state: live ? 'CLEANUP_INCOMPLETE' : 'STOPPED', updated_at: timestamp, payload_json: '{"receipt":"exact process identity"}' });
  old.exec(`PRAGMA application_id = ${APP_DATABASE_APPLICATION_ID}; PRAGMA user_version = 9; COMMIT;`);
  const task = old.prepare('SELECT * FROM tasks').get();
  old.close();
  return { directory, file, task, settings };
}

it('replaces retired runtime storage while preserving tasks and exact Design source history', async () => {
  const fixture = await previousDatabase(false);
  const database = await AppDatabase.open(fixture.file, { acquireLease: false, beforeSchemaUpgrade: async ({ database }) => { await database.backup(path.join(fixture.directory, 'before.sqlite')); } });
  try {
    expect(await database.read(reader => reader.get('SELECT * FROM tasks'))).toEqual(fixture.task);
    const { previewGateway: _gateway, schemaVersion: _version, ...preferences } = fixture.settings;
    expect(await new AppSettingsStore(database).get()).toEqual({ ...preferences, schemaVersion: 14 });
    expect(await database.read(reader => reader.all('PRAGMA foreign_key_check'))).toEqual([]);
    const rows = await database.read(reader => reader.all<{ payload_json: string }>('SELECT payload_json FROM preview_generations'));
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({ id: 'generation', source: { type: 'EXACT_COMMIT', repositoryId: 'repo', commitSha: 'a'.repeat(40) } });
    expect(await database.read(reader => reader.all("SELECT name FROM sqlite_master WHERE name = 'preview_native_resources'"))).toEqual([]);
    const backup = new DatabaseSync(path.join(fixture.directory, 'before.sqlite'), { readOnly: true });
    expect(backup.prepare('SELECT payload_json FROM preview_native_resources').get()).toEqual({ payload_json: '{"receipt":"exact process identity"}' });
    expect(JSON.parse(String(backup.prepare('SELECT settings_json FROM app_settings').get()!.settings_json))).toEqual(fixture.settings);
    backup.close();
  } finally { await database.close(); await fs.rm(fixture.directory, { recursive: true, force: true }); }
});

it('refuses migration before discarding an unresolved process owner', async () => {
  const fixture = await previousDatabase(true);
  try {
    await expect(AppDatabase.open(fixture.file, { acquireLease: false, beforeSchemaUpgrade: async ({ database }) => { await database.backup(path.join(fixture.directory, 'before.sqlite')); } })).rejects.toThrow('stop_previous_preview_runtime');
    const old = new DatabaseSync(fixture.file, { readOnly: true });
    expect(old.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 });
    expect(old.prepare('SELECT * FROM tasks').get()).toEqual(fixture.task);
    expect(old.prepare('SELECT state FROM preview_native_resources').get()).toEqual({ state: 'CLEANUP_INCOMPLETE' });
    expect(JSON.parse(String(old.prepare('SELECT settings_json FROM app_settings').get()!.settings_json))).toEqual(fixture.settings);
    old.close();
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
});
