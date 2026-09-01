import { onTestFinished } from 'vitest';
import {
  ApplicationPersistence,
  type OpenApplicationPersistenceOptions
} from '../core/storage/sqlite/ApplicationPersistence';
import type { SqliteTaskStore } from '../core/storage/SqliteTaskStore';

const persistenceByTaskStore = new WeakMap<SqliteTaskStore, ApplicationPersistence>();

export async function openTestPersistence(
  profileRoot: string,
  options: Omit<OpenApplicationPersistenceOptions, 'profileRoot' | 'appVersion'> = {}
): Promise<ApplicationPersistence> {
  const persistence = await ApplicationPersistence.open({
    profileRoot,
    appVersion: 'test-1.0.0',
    ...options
  });
  onTestFinished(() => persistence.close());
  return persistence;
}

export async function openTestTaskStore(
  profileRoot: string,
  options: Omit<OpenApplicationPersistenceOptions, 'profileRoot' | 'appVersion'> = {}
) {
  const persistence = await openTestPersistence(profileRoot, options);
  persistenceByTaskStore.set(persistence.tasks, persistence);
  return persistence.tasks;
}

export async function closeTestTaskStore(store: SqliteTaskStore): Promise<void> {
  await persistenceByTaskStore.get(store)?.close();
}

export function taskManagerPersistenceOptions(
  persistence: ApplicationPersistence
) {
  return {
    appSettingsStore: persistence.settings,
    agentRuntimeStore: persistence.agentRuntime,
    taskRuntimeAccess: persistence.taskRuntime
  };
}
