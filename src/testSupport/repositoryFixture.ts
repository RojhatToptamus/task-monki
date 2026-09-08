import path from 'node:path';
import type { Repository } from '../shared/contracts';
import type { SqliteTaskStore } from '../core/storage/SqliteTaskStore';

/** Registers repository identity for tests that do not exercise Git validation itself. */
export async function addTestRepository(
  store: SqliteTaskStore,
  repositoryPath: string
): Promise<Repository> {
  const root = path.resolve(repositoryPath);
  const existing = (await store.snapshot()).repositories.find(
    (repository) => path.resolve(repository.path) === root
  );
  if (existing) {
    return existing;
  }
  return store.addRepository({
    path: root,
    root,
    status: 'VALID',
    headSha: 'test-head',
    branch: 'main',
    remotes: [],
    checkedAt: new Date(0).toISOString()
  });
}
