import type { Task } from '../../shared/contracts';

export interface RepositoryOption {
  path: string;
  name: string;
  displayPath: string;
  taskCount: number;
  isDefault: boolean;
}

export type RepositorySetupState = 'loading' | 'needsRepository' | 'needsReview' | 'complete';

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

export function buildRepositoryOptions(input: {
  defaultRepositoryPath: string;
  storedRepositoryPaths: string[];
  tasks: Task[];
}): RepositoryOption[] {
  const defaultPath = normalizeRepositoryPath(input.defaultRepositoryPath);
  const taskCounts = new Map<string, number>();
  for (const task of input.tasks) {
    const path = normalizeRepositoryPath(task.repositoryPath);
    if (path) {
      taskCounts.set(path, (taskCounts.get(path) ?? 0) + 1);
    }
  }

  const paths = new Map<string, string>();
  addRepositoryPath(paths, defaultPath);
  for (const path of input.storedRepositoryPaths) {
    addRepositoryPath(paths, path);
  }
  const taskRepositoryPaths = [...taskCounts.keys()].sort((a, b) =>
    repositoryName(a).localeCompare(repositoryName(b))
  );
  for (const path of taskRepositoryPaths) {
    addRepositoryPath(paths, path);
  }

  return [...paths.keys()].map((path) => ({
    path,
    name: repositoryName(path),
    displayPath: repositoryDisplayPath(path),
    taskCount: taskCounts.get(path) ?? 0,
    isDefault: defaultPath ? path === defaultPath : false
  }));
}

export function tasksForRepository(tasks: Task[], repositoryPath: string): Task[] {
  const selectedPath = normalizeRepositoryPath(repositoryPath);
  if (!selectedPath) {
    return tasks;
  }
  return tasks.filter((task) => normalizeRepositoryPath(task.repositoryPath) === selectedPath);
}

export function resolveSelectedRepositoryPath(
  options: RepositoryOption[],
  requestedRepositoryPath: string
): string {
  const requested = normalizeRepositoryPath(requestedRepositoryPath);
  if (requested && options.some((option) => option.path === requested)) {
    return requested;
  }
  return options[0]?.path ?? '';
}

export function resolveRepositorySetupState(input: {
  loading: boolean;
  options: RepositoryOption[];
  activeRepositoryPath: string;
  firstLaunchSetupCompleted: boolean;
}): RepositorySetupState {
  if (input.loading) {
    return 'loading';
  }
  const hasRepository =
    Boolean(normalizeRepositoryPath(input.activeRepositoryPath)) || input.options.length > 0;
  if (!hasRepository) {
    return 'needsRepository';
  }
  return input.firstLaunchSetupCompleted ? 'complete' : 'needsReview';
}

export function mergeRepositoryPath(paths: string[], repositoryPath: string): string[] {
  const normalized = normalizeRepositoryPath(repositoryPath);
  if (!normalized) {
    return paths;
  }
  if (paths.some((path) => isSameRepositoryPath(path, normalized))) {
    return paths.map((path) => normalizeRepositoryPath(path)).filter(Boolean);
  }
  return [...paths.map((path) => normalizeRepositoryPath(path)).filter(Boolean), normalized];
}

function addRepositoryPath(paths: Map<string, string>, repositoryPath: string): void {
  const normalized = normalizeRepositoryPath(repositoryPath);
  if (normalized && !paths.has(normalized)) {
    paths.set(normalized, normalized);
  }
}
