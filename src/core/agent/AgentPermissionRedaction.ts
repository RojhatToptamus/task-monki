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
  const references = new Map<
    string,
    { reference: string; paths: Set<string>; parents: Set<string> }
  >();
  const redact = (candidate: string): string => {
    if (isRedactedExternalPathReference(candidate)) return candidate;
    if (!path.isAbsolute(candidate)) return candidate;
    const resolved = path.resolve(candidate);
    if (isInsideOrEqual(resolved, worktree)) return resolved;
    const key = pathComparisonKey(resolved);
    let entry = references.get(key);
    if (!entry) {
      entry = {
        reference: `${REDACTED_PATH}${references.size + 1}`,
        paths: new Set<string>(),
        parents: new Set<string>()
      };
      references.set(key, entry);
    }
    for (const representation of [candidate, resolved]) {
      entry.paths.add(representation);
      const parent = path.dirname(representation);
      if (
        parent !== representation &&
        parent !== path.parse(representation).root
      ) {
        entry.parents.add(parent);
      }
    }
    return entry.reference;
  };

  const permissions = mapPermissionPaths(request.permissions, redact);
  const cwd = redact(request.cwd);
  let reason = request.reason;
  for (const entry of references.values()) {
    for (const representation of byDescendingLength(entry.paths)) {
      reason = replacePathRepresentation(reason, representation, entry.reference);
    }
  }
  for (const entry of references.values()) {
    for (const parent of byDescendingLength(entry.parents)) {
      reason = replacePathRepresentation(reason, parent, '[external path]');
    }
  }
  return { ...request, cwd, reason, permissions };
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
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function pathComparisonKey(candidate: string): string {
  return process.platform === 'win32'
    ? candidate.toLocaleLowerCase('en-US')
    : candidate;
}

function byDescendingLength(values: ReadonlySet<string>): string[] {
  return [...values].sort((left, right) => right.length - left.length);
}

function replacePathRepresentation(
  value: string | undefined,
  representation: string,
  replacement: string
): string | undefined {
  if (!value || !representation) return value;
  if (process.platform !== 'win32') {
    return value.split(representation).join(replacement);
  }
  return value.replace(
    new RegExp(escapeRegExp(representation), 'giu'),
    () => replacement
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
