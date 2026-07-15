import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs/promises';
import { DISCOURSE_LIMITS } from '../../../shared/discourse';
import type { AgentExecutionSettings } from '../../../shared/contracts';
import type { JsonValue } from './protocol/generated/serde_json/JsonValue';

const PROFILE_PREFIX = 'task_monki_';
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export interface CodexPermissionProfileEvidence {
  activePermissionProfile?: { id?: unknown; extends?: unknown } | null;
  runtimeWorkspaceRoots?: unknown;
  cwd?: unknown;
  sandbox?: unknown;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
}

export interface CodexReadOnlyExecutionScope {
  primaryCwd: string;
  readOnlyRoots: readonly string[];
  verifiedReadOnlyFiles?: readonly {
    canonicalPath: string;
    contentSha256: string;
  }[];
}

export interface CodexReadOnlyScopeProfile {
  profileId: string;
  scopeHash: string;
  config: Record<string, JsonValue>;
}

export function codexPermissionProfileId(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error('Cannot create a Codex permission profile for an invalid session id.');
  }
  return `${PROFILE_PREFIX}${sessionId}`;
}

/**
 * Builds the complete, order-independent permission scope used by discourse
 * jobs. Callers must pass canonical repository roots and verified managed
 * files; broad roots and overlapping roots fail closed.
 */
export async function codexReadOnlyScopeProfile(input: {
  sessionId: string;
  scope: CodexReadOnlyExecutionScope;
  reasoningEffort?: string;
}): Promise<CodexReadOnlyScopeProfile> {
  if (!SAFE_SESSION_ID.test(input.sessionId)) {
    throw new Error('Cannot create a Codex permission profile for an invalid session id.');
  }
  const primaryCwd = await requireCanonicalDirectory(
    input.scope.primaryCwd,
    'primary workspace'
  );
  const roots = uniqueSorted([
    primaryCwd,
    ...(await Promise.all(
      input.scope.readOnlyRoots.map((candidate) =>
        requireCanonicalDirectory(candidate, 'read-only root')
      )
    ))
  ]);
  if (roots.length > DISCOURSE_LIMITS.maxFilesystemRootsPerWave) {
    throw new Error('Codex read-only scope exceeds the filesystem-root safety limit.');
  }
  assertNonOverlappingRoots(roots);
  if ((input.scope.verifiedReadOnlyFiles?.length ?? 0) > 10) {
    throw new Error('Codex read-only scope exceeds the managed-file safety limit.');
  }
  const verifiedFiles = await Promise.all((input.scope.verifiedReadOnlyFiles ?? []).map(async (file) => {
    if (!/^[a-f0-9]{64}$/u.test(file.contentSha256)) {
      throw new Error('Codex managed read-only files require a verified SHA-256 digest.');
    }
    const canonicalPath = await requireCanonicalRegularFile(
      file.canonicalPath,
      'read-only file'
    );
    const actualHash = crypto
      .createHash('sha256')
      .update(await fs.readFile(canonicalPath))
      .digest('hex');
    if (actualHash !== file.contentSha256) {
      throw new Error('Codex managed read-only file content changed after verification.');
    }
    return {
      canonicalPath,
      contentSha256: file.contentSha256
    };
  }));
  const files = [...verifiedFiles].sort((left, right) =>
    compareCodeUnits(left.canonicalPath, right.canonicalPath)
  );
  const filesystemEntries = [
    { path: ':minimal', access: 'read' as const },
    ...roots.map((candidate) => ({ path: candidate, access: 'read' as const })),
    ...files.map((file) => ({ path: file.canonicalPath, access: 'read' as const }))
  ];
  const encodedPathBytes = filesystemEntries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.path, 'utf8'),
    0
  );
  if (encodedPathBytes > 32 * 1024) {
    throw new Error('Codex read-only scope exceeds the encoded-path safety limit.');
  }
  const features = {
    apps: false,
    multi_agent: false,
    multi_agent_v2: false,
    memories: false
  };
  const scopeDescriptor = {
    formatVersion: 1,
    primaryCwd,
    filesystemEntries,
    managedFileDigests: files,
    network: { enabled: false },
    features,
    webSearch: 'disabled',
    approvalPolicy: 'never',
    approvalsReviewer: 'user'
  };
  const scopeHash = crypto.createHash('sha256').update(JSON.stringify(scopeDescriptor)).digest('hex');
  const sessionHash = crypto.createHash('sha256').update(input.sessionId).digest('hex').slice(0, 12);
  const profileId = `${PROFILE_PREFIX}${sessionHash}_${scopeHash.slice(0, 24)}`;
  const filesystem: Record<string, 'read'> = { ':minimal': 'read' };
  for (const candidate of roots) filesystem[candidate] = 'read';
  for (const file of files) filesystem[file.canonicalPath] = 'read';
  return {
    profileId,
    scopeHash,
    config: {
      ...(input.reasoningEffort
        ? { model_reasoning_effort: input.reasoningEffort }
        : {}),
      default_permissions: profileId,
      permissions: {
        [profileId]: {
          filesystem,
          network: { enabled: false }
        }
      },
      features,
      web_search: 'disabled'
    }
  };
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

export function codexPermissionProfileHash(
  config: Record<string, JsonValue>
): string {
  return crypto
    .createHash('sha256')
    .update(stableJson(config))
    .digest('hex');
}

export function assertCodexPermissionProfileEvidence(input: {
  sessionId: string;
  worktreePath: string;
  response: CodexPermissionProfileEvidence;
}): void {
  const expectedProfileId = codexPermissionProfileId(input.sessionId);
  const active = input.response.activePermissionProfile;
  if (!active || active.id !== expectedProfileId || active.extends !== null) {
    throw new Error('Codex did not attest the Task Monki permission profile.');
  }

  if (!Array.isArray(input.response.runtimeWorkspaceRoots)) {
    throw new Error('Codex did not attest its runtime workspace roots.');
  }
  const expectedWorktree = path.resolve(input.worktreePath);
  const roots = input.response.runtimeWorkspaceRoots.map((root) =>
    typeof root === 'string' && path.isAbsolute(root) ? path.resolve(root) : ''
  );
  if (roots.length !== 1 || !isSamePath(roots[0] ?? '', expectedWorktree)) {
    throw new Error('Codex reported unexpected runtime workspace roots.');
  }
}

export function assertCodexReadOnlyScopeEvidence(input: {
  profileId: string;
  primaryCwd: string;
  response: CodexPermissionProfileEvidence;
}): void {
  if (!path.isAbsolute(input.primaryCwd)) {
    throw new Error('Codex primary workspace evidence must be absolute.');
  }
  const active = input.response.activePermissionProfile;
  if (!active || active.id !== input.profileId || active.extends !== null) {
    throw new Error('Codex did not attest the exact Task Monki read-only permission scope.');
  }
  if (!Array.isArray(input.response.runtimeWorkspaceRoots)) {
    throw new Error('Codex did not attest its runtime workspace roots.');
  }
  const roots = input.response.runtimeWorkspaceRoots.map((candidate) =>
    typeof candidate === 'string' && path.isAbsolute(candidate) ? path.resolve(candidate) : ''
  );
  if (
    roots.length !== 1 ||
    !isSamePath(roots[0] ?? '', path.resolve(input.primaryCwd))
  ) {
    throw new Error('Codex reported unexpected runtime workspace roots.');
  }
  if (
    typeof input.response.cwd !== 'string' ||
    !path.isAbsolute(input.response.cwd) ||
    !isSamePath(path.resolve(input.response.cwd), path.resolve(input.primaryCwd))
  ) {
    throw new Error('Codex reported an unexpected runtime cwd.');
  }
  const sandbox = input.response.sandbox;
  if (
    !sandbox ||
    typeof sandbox !== 'object' ||
    !('type' in sandbox) ||
    sandbox.type !== 'readOnly' ||
    !('networkAccess' in sandbox) ||
    sandbox.networkAccess !== false
  ) {
    throw new Error('Codex did not attest the required offline read-only sandbox.');
  }
  if (input.response.approvalPolicy !== 'never') {
    throw new Error('Codex did not attest the never-approve policy.');
  }
  if (input.response.approvalsReviewer !== 'user') {
    throw new Error('Codex did not attest the required approval reviewer.');
  }
}

export function assertCodexActivePermissionProfile(
  sessionId: string,
  active: CodexPermissionProfileEvidence['activePermissionProfile']
): void {
  const expectedProfileId = codexPermissionProfileId(sessionId);
  assertCodexActivePermissionProfileId(expectedProfileId, active);
}

export function assertCodexActivePermissionProfileId(
  expectedProfileId: string,
  active: CodexPermissionProfileEvidence['activePermissionProfile']
): void {
  if (!active || active.id !== expectedProfileId || active.extends !== null) {
    throw new Error('Codex changed or removed the Task Monki permission profile.');
  }
}

function requireAbsolute(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`Codex ${label} permission paths must be absolute.`);
  }
  return path.resolve(candidate);
}

function requireNarrowAbsolute(candidate: string, label: string): string {
  const resolved = requireAbsolute(candidate, label);
  const filesystemRoot = path.parse(resolved).root;
  if (isSamePath(resolved, filesystemRoot) || isSamePath(resolved, path.resolve(os.homedir()))) {
    throw new Error(`Codex ${label} cannot grant a filesystem root or home directory.`);
  }
  return resolved;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

async function requireCanonicalDirectory(candidate: string, label: string): Promise<string> {
  const resolved = requireNarrowAbsolute(candidate, label);
  const canonical = await fs.realpath(resolved).catch(() => {
    throw new Error(`Codex ${label} must be an existing canonical directory.`);
  });
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isSamePath(resolved, canonical)) {
    throw new Error(`Codex ${label} must be an existing canonical directory.`);
  }
  return canonical;
}

async function requireCanonicalRegularFile(candidate: string, label: string): Promise<string> {
  const resolved = requireNarrowAbsolute(candidate, label);
  const canonical = await fs.realpath(resolved).catch(() => {
    throw new Error(`Codex ${label} must be an existing canonical regular file.`);
  });
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || !isSamePath(resolved, canonical)) {
    throw new Error(`Codex ${label} must be an existing canonical regular file.`);
  }
  return canonical;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(',')}}`;
}

function assertNonOverlappingRoots(roots: readonly string[]): void {
  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      if (isInside(roots[index]!, roots[other]!) || isInside(roots[other]!, roots[index]!)) {
        throw new Error('Codex read-only repository roots must not overlap.');
      }
    }
  }
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
