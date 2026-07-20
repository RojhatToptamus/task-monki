import type { Repository, Task } from '../../shared/contracts';

export interface RepositoryOption {
  id: string;
  path: string;
  name: string;
  displayPath: string;
  taskCount: number;
  status: Repository['status'];
}

export type RepositorySetupState = 'loading' | 'needsRepository' | 'needsReview' | 'complete';

export function repositoryName(repositoryPath: string): string {
  const normalized = repositoryPath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function repositoryDisplayPath(repositoryPath: string): string {
  const normalized = repositoryPath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const suffix = parts.slice(-2).join('/');
  return suffix && parts.length > 2 ? `…/${suffix}` : normalized.replace(/\\/g, '/');
}

export function filterRepositoryOptions(
  options: readonly RepositoryOption[],
  query: string
): RepositoryOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...options];
  return options.filter((option) =>
    `${option.name}\n${option.path}`.toLocaleLowerCase().includes(normalizedQuery)
  );
}

export function buildRepositoryOptions(input: {
  repositories: Repository[];
  tasks: Task[];
}): RepositoryOption[] {
  const taskCounts = new Map<string, number>();
  for (const task of input.tasks) {
    taskCounts.set(task.repositoryId, (taskCounts.get(task.repositoryId) ?? 0) + 1);
  }
  const displayPaths = buildDistinctRepositoryDisplayPaths(input.repositories);
  return input.repositories.map((repository) => ({
    id: repository.id,
    path: repository.path,
    name: repository.name,
    displayPath: displayPaths.get(repository.id) ?? repositoryDisplayPath(repository.path),
    taskCount: taskCounts.get(repository.id) ?? 0,
    status: repository.status
  }));
}

function buildDistinctRepositoryDisplayPaths(
  repositories: readonly Repository[]
): Map<string, string> {
  const pathParts = repositories.map((repository) => ({
    id: repository.id,
    normalizedPath: repository.path.replace(/[\\/]+$/, '').replace(/\\/g, '/'),
    parts: repository.path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  }));
  const displayPaths = new Map<string, string>();

  for (const candidate of pathParts) {
    let suffixLength = Math.min(2, candidate.parts.length);
    while (
      suffixLength < candidate.parts.length &&
      pathParts.some(
        (other) =>
          other.id !== candidate.id &&
          other.parts
            .slice(-suffixLength)
            .join('/')
            .toLocaleLowerCase() ===
            candidate.parts.slice(-suffixLength).join('/').toLocaleLowerCase()
      )
    ) {
      suffixLength += 1;
    }
    const suffix = candidate.parts.slice(-suffixLength).join('/');
    displayPaths.set(
      candidate.id,
      suffixLength < candidate.parts.length ? `…/${suffix}` : candidate.normalizedPath
    );
  }

  return displayPaths;
}

export function resolveSelectedRepositoryId(
  options: RepositoryOption[],
  requestedRepositoryId: string
): string {
  if (requestedRepositoryId && options.some((option) => option.id === requestedRepositoryId)) {
    return requestedRepositoryId;
  }
  return options.find((option) => option.status === 'AVAILABLE')?.id ?? options[0]?.id ?? '';
}

export function resolveRepositorySetupState(input: {
  loading: boolean;
  options: RepositoryOption[];
  activeRepositoryId: string;
  firstLaunchSetupCompleted: boolean;
}): RepositorySetupState {
  if (input.loading) {
    return 'loading';
  }
  if (!input.activeRepositoryId && input.options.length === 0) {
    return 'needsRepository';
  }
  return input.firstLaunchSetupCompleted ? 'complete' : 'needsReview';
}
