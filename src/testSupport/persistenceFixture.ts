import { onTestFinished } from 'vitest';
import {
  ApplicationPersistence,
  type OpenApplicationPersistenceOptions
} from '../core/storage/sqlite/ApplicationPersistence';
import type { SqliteTaskStore } from '../core/storage/SqliteTaskStore';

const persistenceByTaskStore = new WeakMap<SqliteTaskStore, ApplicationPersistence>();

/** Opens the real SQLite composition and guarantees closure at test end. */
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

/** Opens the real application persistence owner and returns its task facade. */
export async function openTestTaskStore(
  profileRoot: string,
  options: Omit<OpenApplicationPersistenceOptions, 'profileRoot' | 'appVersion'> = {}
) {
  const persistence = await openTestPersistence(profileRoot, options);
  persistenceByTaskStore.set(persistence.tasks, persistence);
  return persistence.tasks;
}

/** Closes the complete persistence composition that owns a test task facade. */
export async function closeTestTaskStore(store: SqliteTaskStore): Promise<void> {
  await persistenceByTaskStore.get(store)?.close();
}

/** Required TaskManager persistence owners from one application profile. */
export function taskManagerPersistenceOptions(
  persistence: ApplicationPersistence
) {
  return {
    appSettingsStore: persistence.settings,
    agentRuntimeStore: persistence.agentRuntime,
    taskRuntimeAccess: persistence.taskRuntime
  };
}
