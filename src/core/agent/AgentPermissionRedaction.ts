import path from 'node:path';
import type {
  AgentPermissionApprovalRequest,
  AgentPermissionProfile
} from '../../shared/contracts';

const REDACTED_PATH = 'task-monki-external-path:';

export function isRedactedExternalPathReference(value: string): boolean {
  return /^task-monki-external-path:[1-9][0-9]*$/u.test(value);
}

/** Keeps provider paths outside the worktree out of durable interaction data. */
export function redactExternalPermissionPaths(
  request: AgentPermissionApprovalRequest,
  worktreePath: string
): AgentPermissionApprovalRequest {
  const worktree = path.resolve(worktreePath);
  const references = new Map<string, string>();
  const redact = (candidate: string): string => {
    if (isRedactedExternalPathReference(candidate)) return candidate;
    if (!path.isAbsolute(candidate)) return candidate;
    const resolved = path.resolve(candidate);
    if (isInsideOrEqual(resolved, worktree)) return resolved;
    let reference = references.get(resolved);
    if (!reference) {
      reference = `${REDACTED_PATH}${references.size + 1}`;
      references.set(resolved, reference);
    }
    return reference;
  };

  const permissions = mapPermissionPaths(request.permissions, redact);
  let reason = request.reason;
  for (const [original, reference] of references) {
    reason = reason?.split(original).join(reference);
    reason = reason?.split(path.dirname(original)).join('[external path]');
  }
  return { ...request, cwd: redact(request.cwd), reason, permissions };
}

function mapPermissionPaths(
  permissions: AgentPermissionProfile,
  mapPath: (candidate: string) => string
): AgentPermissionProfile {
  if (!permissions.fileSystem) return structuredClone(permissions);
  return {
    ...permissions,
    fileSystem: {
      ...permissions.fileSystem,
      read: permissions.fileSystem.read?.map(mapPath),
      write: permissions.fileSystem.write?.map(mapPath),
      entries: permissions.fileSystem.entries?.map((entry) => ({
        ...entry,
        path: mapNestedStrings(entry.path, mapPath)
      }))
    }
  };
}

function mapNestedStrings(value: unknown, mapPath: (candidate: string) => string): never {
  if (typeof value === 'string') return mapPath(value) as never;
  if (Array.isArray(value)) {
    return value.map((candidate) => mapNestedStrings(candidate, mapPath)) as never;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, candidate]) => [
        key,
        mapNestedStrings(candidate, mapPath)
      ])
    ) as never;
  }
  return value as never;
}

function isInsideOrEqual(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
