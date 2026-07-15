import type { Task } from '../../shared/contracts';
import type { RepositoryCatalogSnapshot } from '../../shared/repositories';

export interface RepositoryOption {
  id: string;
  name: string;
  displayPath: string;
  taskCount: number;
  isDefault: boolean;
  available: boolean;
}

export type RepositorySetupState =
  | 'loading'
  | 'needsRepository'
  | 'repositoryUnavailable'
  | 'needsReview'
  | 'complete';

export function normalizeRepositoryPath(repositoryPath: string): string {
  const trimmed = repositoryPath.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed === '/' || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/[\\/]+$/, '');
}

export function isSameRepositoryPath(left: string, right: string): boolean {
  return normalizeRepositoryPath(left) === normalizeRepositoryPath(right);
}

export function repositoryName(repositoryPath: string): string {
  const normalized = normalizeRepositoryPath(repositoryPath);
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function repositoryDisplayPath(repositoryPath: string): string {
  const normalized = normalizeRepositoryPath(repositoryPath);
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || normalized;
}

export function buildRepositoryOptions(
  catalog: RepositoryCatalogSnapshot
): RepositoryOption[] {
  return catalog.repositories.map((repository) => ({
    id: repository.id,
    name: repository.displayName,
    displayPath: repository.displayPath,
    taskCount: repository.taskCount,
    isDefault: repository.isDefault,
    available: repository.availability === 'AVAILABLE'
  }));
}

export function tasksForRepository(
  tasks: Task[],
  catalog: RepositoryCatalogSnapshot,
  repositoryId: string
): Task[] {
  if (!repositoryId) {
    return tasks;
  }
  const taskIds = new Set(
    catalog.taskAssociations
      .filter((association) => association.repositoryId === repositoryId)
      .map((association) => association.taskId)
  );
  return tasks.filter((task) => taskIds.has(task.id));
}

export function resolveSelectedRepositoryId(catalog: RepositoryCatalogSnapshot): string {
  const requested = catalog.selectedRepositoryId;
  return requested && catalog.repositories.some((repository) => repository.id === requested)
    ? requested
    : '';
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
  const hasRepository =
    Boolean(input.activeRepositoryId) || input.options.length > 0;
  if (!hasRepository) {
    return 'needsRepository';
  }
  const active = input.options.find((option) => option.id === input.activeRepositoryId);
  if (active && !active.available) {
    return 'repositoryUnavailable';
  }
  return input.firstLaunchSetupCompleted ? 'complete' : 'needsReview';
}
