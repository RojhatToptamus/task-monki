import path from 'node:path';
import type { AgentExecutionSettings } from '../../../shared/contracts';
import type { JsonValue } from './protocol/generated/serde_json/JsonValue';

const PROFILE_PREFIX = 'task_monki_';
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export interface CodexPermissionProfileEvidence {
  activePermissionProfile?: { id?: unknown; extends?: unknown } | null;
  runtimeWorkspaceRoots?: unknown;
}

export function codexPermissionProfileId(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error('Cannot create a Codex permission profile for an invalid session id.');
  }
  return `${PROFILE_PREFIX}${sessionId}`;
}

/**
 * Builds a complete, collision-resistant profile in the thread-local config
 * layer. Restricted profiles deny every path that is not listed here.
 */
export function codexPermissionProfileConfig(input: {
  sessionId: string;
  settings: AgentExecutionSettings;
  worktreePath: string;
  attachmentPaths?: readonly string[];
}): Record<string, JsonValue> {
  const attachmentPaths = input.attachmentPaths ?? [];
  if (attachmentPaths.length > 0 && input.settings.sandbox === 'DANGER_FULL_ACCESS') {
    throw new Error(
      'Attachments require Ask for approval, Approve for me, or read-only access. Full access cannot protect managed attachment files.'
    );
  }

  const worktreePath = requireAbsolute(input.worktreePath, 'worktree');
  const filesystem: Record<string, 'read' | 'write'> = {
    ':minimal': 'read',
    [worktreePath]: input.settings.sandbox === 'READ_ONLY' ? 'read' : 'write'
  };
  for (const candidate of attachmentPaths) {
    const attachmentPath = requireAbsolute(candidate, 'attachment');
    if (
      isSamePath(attachmentPath, worktreePath) ||
      isInside(attachmentPath, worktreePath)
    ) {
      throw new Error('Managed attachment paths must stay outside the task worktree.');
    }
    filesystem[attachmentPath] = 'read';
  }

  const profileId = codexPermissionProfileId(input.sessionId);
  return {
    ...(input.settings.reasoningEffort
      ? { model_reasoning_effort: input.settings.reasoningEffort }
      : {}),
    default_permissions: profileId,
    permissions: {
      [profileId]: {
        filesystem,
        network: {
          enabled: attachmentPaths.length === 0 && input.settings.networkAccess === true
        }
      }
    },
    features: {
      multi_agent: false,
      multi_agent_v2: false,
      memories: false
    }
  };
}

export function assertCodexPermissionProfileEvidence(input: {
  sessionId: string;
  worktreePath: string;
  response: CodexPermissionProfileEvidence;
}): void {
  const expectedProfileId = codexPermissionProfileId(input.sessionId);
  const active = input.response.activePermissionProfile;
  if (!active || active.id !== expectedProfileId || active.extends != null) {
    throw new Error('Codex did not attest the Task Monki permission profile.');
  }

  if (!Array.isArray(input.response.runtimeWorkspaceRoots)) {
    throw new Error('Codex did not attest its runtime workspace roots.');
  }
  const expectedWorktree = path.resolve(input.worktreePath);
  const roots = input.response.runtimeWorkspaceRoots.map((root) =>
    typeof root === 'string' ? path.resolve(root) : ''
  );
  if (roots.length !== 1 || !isSamePath(roots[0] ?? '', expectedWorktree)) {
    throw new Error('Codex reported unexpected runtime workspace roots.');
  }
}

export function assertCodexActivePermissionProfile(
  sessionId: string,
  active: CodexPermissionProfileEvidence['activePermissionProfile']
): void {
  const expectedProfileId = codexPermissionProfileId(sessionId);
  if (!active || active.id !== expectedProfileId || active.extends != null) {
    throw new Error('Codex changed or removed the Task Monki permission profile.');
  }
}

function requireAbsolute(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`Codex ${label} permission paths must be absolute.`);
  }
  return path.resolve(candidate);
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isSamePath(left: string, right: string): boolean {
  return (
    path.isAbsolute(left) &&
    path.isAbsolute(right) &&
    path.relative(left, right) === ''
  );
}
