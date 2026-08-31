import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isTaskCreationToken } from '../../shared/contracts';
import {
  enforcePosixMode,
  ensurePrivateDirectory,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported,
  writePrivateFileAtomically
} from '../filesystem/secureFilesystem';
import { git, type GitExecutionOptions } from '../git/gitCli';
import {
  copyVerifiedPrivateFile,
  inspectPrivateImmutableFile
} from '../storage/sqlite/ManagedFileStore';
import { DESIGN_REPOSITORY_MARKER } from './DesignSourceService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_REFS = 100_000;
const MAX_REQUIRED_OBJECTS = 100_000;
const GIT_TIMEOUT_MS = 5 * 60_000;

export interface DesignGitReference {
  name: string;
  objectId: string;
}

export interface DesignRepositoryFileIntegrity {
  byteCount: number;
  sha256: string;
}

export interface DesignRepositoryBackupMetadata {
  repositoryId: string;
  objectFormat: 'sha1' | 'sha256';
  headReference: string;
  /** Exact repository HEAD recorded in the SQLite snapshot that owns this backup. */
  headSha: string;
  refs: DesignGitReference[];
  requiredObjects: string[];
  marker: DesignRepositoryFileIntegrity;
  bundle: DesignRepositoryFileIntegrity;
}

interface DesignRepositoryMarkerBackup {
  schemaVersion: 1;
  repositoryId: string;
  creationToken: string;
  state: 'READY';
  initialCommitSha: string;
  createdAt: string;
}

export async function captureManagedDesignRepository(input: {
  repositoryId: string;
  repositoryPath: string;
  bundlePath: string;
  markerBackupPath: string;
  expectedHeadSha: string;
  requiredObjects: readonly string[];
}): Promise<DesignRepositoryBackupMetadata> {
  assertRepositoryId(input.repositoryId);
  assertObjectId(input.expectedHeadSha);
  await assertPrivateDirectory(input.repositoryPath);
  const markerPath = path.join(input.repositoryPath, DESIGN_REPOSITORY_MARKER);
  const marker = await readAndValidateMarker(markerPath, input.repositoryId);
  const requiredObjects = normalizeObjectIds([
    ...input.requiredObjects,
    input.expectedHeadSha
  ]);
  await managedGit(input.repositoryPath, [
    'cat-file',
    '-e',
    `${marker.initialCommitSha}^{commit}`
  ]);
  const before = await inspectRepository(input.repositoryPath, requiredObjects);
  if (before.headSha !== input.expectedHeadSha) {
    throw new Error(
      `Managed Design repository ${input.repositoryId} HEAD does not match the database snapshot.`
    );
  }
  if (before.status.length > 0) {
    throw new Error(`Managed Design repository ${input.repositoryId} has uncommitted source.`);
  }

  const markerIntegrity = await inspectPrivateImmutableFile(markerPath);
  if (markerIntegrity.byteCount > MAX_MARKER_BYTES) {
    throw new Error('Managed Design repository marker exceeds its size limit.');
  }
  await copyVerifiedPrivateFile(markerPath, input.markerBackupPath, markerIntegrity);

  await ensurePrivateDirectory(path.dirname(input.bundlePath));
  await managedGit(
    input.repositoryPath,
    ['bundle', 'create', input.bundlePath, '--all', '--stdin'],
    { stdin: requiredObjects.length > 0 ? `${requiredObjects.join('\n')}\n` : '' }
  );
  await sealPrivateFile(input.bundlePath, 0o400);
  const bundle = await inspectPrivateImmutableFile(input.bundlePath);
  if (bundle.byteCount <= 0) throw new Error('Managed Design repository bundle is empty.');

  const after = await inspectRepository(input.repositoryPath, requiredObjects);
  if (
    before.headReference !== after.headReference ||
    before.headSha !== after.headSha ||
    before.objectFormat !== after.objectFormat ||
    JSON.stringify(before.refs) !== JSON.stringify(after.refs) ||
    after.status.length > 0
  ) {
    throw new Error(`Managed Design repository ${input.repositoryId} changed during backup.`);
  }
  const markerAfter = await readAndValidateMarker(markerPath, input.repositoryId);
  const markerAfterIntegrity = await inspectPrivateImmutableFile(markerPath);
  if (
    JSON.stringify(marker) !== JSON.stringify(markerAfter) ||
    markerIntegrity.byteCount !== markerAfterIntegrity.byteCount ||
    markerIntegrity.sha256 !== markerAfterIntegrity.sha256
  ) {
    throw new Error(`Managed Design repository ${input.repositoryId} marker changed during backup.`);
  }

  const metadata: DesignRepositoryBackupMetadata = {
    repositoryId: input.repositoryId,
    objectFormat: before.objectFormat,
    headReference: before.headReference,
    headSha: input.expectedHeadSha,
    refs: before.refs,
    requiredObjects,
    marker: markerIntegrity,
    bundle
  };
  return metadata;
}

export async function verifyManagedDesignRepositoryBackup(input: {
  bundlePath: string;
  markerPath: string;
  metadata: DesignRepositoryBackupMetadata;
}): Promise<void> {
  validateDesignRepositoryBackupMetadata(input.metadata);
  await verifyFile(input.bundlePath, input.metadata.bundle, 'bundle');
  await verifyFile(input.markerPath, input.metadata.marker, 'marker');
  await readAndValidateMarker(input.markerPath, input.metadata.repositoryId);

  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-design-backup-verify-')
  );
  await enforcePosixMode(temporaryRoot, 0o700);
  try {
    await reconstructRepository({
      repositoryPath: temporaryRoot,
      bundlePath: input.bundlePath,
      markerPath: input.markerPath,
      metadata: input.metadata
    });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function restoreManagedDesignRepository(input: {
  repositoryPath: string;
  bundlePath: string;
  markerPath: string;
  metadata: DesignRepositoryBackupMetadata;
}): Promise<void> {
  validateDesignRepositoryBackupMetadata(input.metadata);
  await verifyFile(input.bundlePath, input.metadata.bundle, 'bundle');
  await verifyFile(input.markerPath, input.metadata.marker, 'marker');
  await fs.mkdir(input.repositoryPath, { mode: 0o700 });
  await ensurePrivateDirectory(input.repositoryPath);
  try {
    await reconstructRepository(input);
    await syncDirectoryTree(input.repositoryPath);
    await syncDirectoryIfSupported(path.dirname(input.repositoryPath));
  } catch (error) {
    await fs.rm(input.repositoryPath, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRestoredManagedDesignRepository(input: {
  repositoryPath: string;
  metadata: DesignRepositoryBackupMetadata;
}): Promise<void> {
  validateDesignRepositoryBackupMetadata(input.metadata);
  await assertPrivateDirectory(input.repositoryPath);
  const markerPath = path.join(input.repositoryPath, DESIGN_REPOSITORY_MARKER);
  await verifyFile(markerPath, input.metadata.marker, 'marker');
  const actual = await inspectRepository(
    input.repositoryPath,
    input.metadata.requiredObjects
  );
  if (
    actual.objectFormat !== input.metadata.objectFormat ||
    actual.headReference !== input.metadata.headReference ||
    actual.headSha !== input.metadata.headSha ||
    JSON.stringify(actual.refs) !== JSON.stringify(input.metadata.refs) ||
    actual.status.length > 0
  ) {
    throw new Error('Restored managed Design repository does not match its manifest.');
  }
  const marker = await readAndValidateMarker(markerPath, input.metadata.repositoryId);
  await managedGit(input.repositoryPath, [
    'cat-file',
    '-e',
    `${marker.initialCommitSha}^{commit}`
  ]);
  await managedGit(input.repositoryPath, ['fsck', '--full', '--no-reflogs']);
}

export function validateDesignRepositoryBackupMetadata(
  metadata: DesignRepositoryBackupMetadata
): void {
  assertRepositoryId(metadata.repositoryId);
  if (metadata.objectFormat !== 'sha1' && metadata.objectFormat !== 'sha256') {
    throw new Error('Managed Design repository object format is invalid.');
  }
  assertGitReference(metadata.headReference);
  assertObjectId(metadata.headSha);
  const refs = normalizeRefs(metadata.refs);
  const objectIdLength = metadata.objectFormat === 'sha1' ? 40 : 64;
  if (metadata.headSha.length !== objectIdLength) {
    throw new Error('Managed Design repository HEAD uses the wrong object format.');
  }
  if (refs.some((reference) => reference.objectId.length !== objectIdLength)) {
    throw new Error('Managed Design repository ref uses the wrong object format.');
  }
  if (JSON.stringify(refs) !== JSON.stringify(metadata.refs)) {
    throw new Error('Managed Design repository refs are not canonical.');
  }
  const head = refs.find((reference) => reference.name === metadata.headReference);
  if (!head) {
    throw new Error('Managed Design repository HEAD does not resolve to a bundled ref.');
  }
  if (head.objectId !== metadata.headSha) {
    throw new Error('Managed Design repository HEAD does not match its SQLite snapshot.');
  }
  const requiredObjects = normalizeObjectIds(metadata.requiredObjects);
  if (requiredObjects.some((objectId) => objectId.length !== objectIdLength)) {
    throw new Error('Managed Design required object uses the wrong object format.');
  }
  if (JSON.stringify(requiredObjects) !== JSON.stringify(metadata.requiredObjects)) {
    throw new Error('Managed Design repository required objects are not canonical.');
  }
  if (!requiredObjects.includes(metadata.headSha)) {
    throw new Error('Managed Design repository HEAD is not retained as a required object.');
  }
  assertIntegrity(metadata.marker, 'marker');
  assertIntegrity(metadata.bundle, 'bundle');
  if (metadata.bundle.byteCount <= 0 || metadata.marker.byteCount <= 0) {
    throw new Error('Managed Design repository backup files must not be empty.');
  }
}

async function reconstructRepository(input: {
  repositoryPath: string;
  bundlePath: string;
  markerPath: string;
  metadata: DesignRepositoryBackupMetadata;
}): Promise<void> {
  await managedGit(input.repositoryPath, [
    'init',
    ...(input.metadata.objectFormat === 'sha256' ? ['--object-format=sha256'] : []),
    '--initial-branch',
    'main'
  ]);
  await managedGit(input.repositoryPath, ['bundle', 'verify', input.bundlePath]);
  const advertised = await readBundleRefs(input.repositoryPath, input.bundlePath);
  if (JSON.stringify(advertised.refs) !== JSON.stringify(input.metadata.refs)) {
    throw new Error('Managed Design bundle refs do not match its manifest.');
  }
  const head = input.metadata.refs.find(
    (reference) => reference.name === input.metadata.headReference
  )!;
  if (advertised.headObjectId !== head.objectId) {
    throw new Error('Managed Design bundle HEAD does not match its manifest.');
  }

  await managedGit(input.repositoryPath, ['bundle', 'unbundle', input.bundlePath]);
  await managedGit(input.repositoryPath, ['update-ref', '--stdin'], {
    stdin: input.metadata.refs
      .map((reference) => `update ${reference.name} ${reference.objectId}`)
      .join('\n') + '\n'
  });
  await managedGit(input.repositoryPath, [
    'symbolic-ref',
    'HEAD',
    input.metadata.headReference
  ]);
  await managedGit(input.repositoryPath, ['reset', '--hard', head.objectId]);
  await managedGit(input.repositoryPath, ['config', 'user.name', 'Task Monki']);
  await managedGit(input.repositoryPath, [
    'config',
    'user.email',
    'task-monki@localhost'
  ]);
  await managedGit(input.repositoryPath, ['config', 'core.autocrlf', 'false']);
  await writePrivateFileAtomically(
    path.join(input.repositoryPath, '.git', 'info', 'exclude'),
    `/${DESIGN_REPOSITORY_MARKER}\n`
  );
  await copyVerifiedPrivateFile(
    input.markerPath,
    path.join(input.repositoryPath, DESIGN_REPOSITORY_MARKER),
    input.metadata.marker
  );
  await sealPrivateFile(path.join(input.repositoryPath, DESIGN_REPOSITORY_MARKER), 0o600);

  await verifyRestoredManagedDesignRepository({
    repositoryPath: input.repositoryPath,
    metadata: input.metadata
  });
}

async function inspectRepository(
  repositoryPath: string,
  requiredObjects: readonly string[]
): Promise<{
  objectFormat: 'sha1' | 'sha256';
  headReference: string;
  headSha: string;
  refs: DesignGitReference[];
  status: string;
}> {
  const objectFormat = clean(
    await managedGit(repositoryPath, ['rev-parse', '--show-object-format'])
  );
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error('Managed Design repository object format is unsupported.');
  }
  const headReference = clean(
    await managedGit(repositoryPath, ['symbolic-ref', '--quiet', 'HEAD'])
  );
  assertGitReference(headReference);
  const refs = await listRefs(repositoryPath);
  const head = refs.find((reference) => reference.name === headReference);
  if (!head) {
    throw new Error('Managed Design repository HEAD is not backed by a ref.');
  }
  const headSha = clean(
    await managedGit(repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}'])
  );
  assertObjectId(headSha);
  if (head.objectId !== headSha) {
    throw new Error('Managed Design repository HEAD ref does not point directly to its commit.');
  }
  for (const objectId of requiredObjects) {
    await managedGit(repositoryPath, ['cat-file', '-e', `${objectId}^{object}`]);
  }
  const status = await managedGit(repositoryPath, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all'
  ]);
  return { objectFormat, headReference, headSha, refs, status };
}

async function listRefs(repositoryPath: string): Promise<DesignGitReference[]> {
  const output = await managedGit(repositoryPath, [
    'for-each-ref',
    '--format=%(objectname) %(refname)',
    'refs/'
  ]);
  const refs = output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseRefLine);
  return normalizeRefs(refs);
}

async function readBundleRefs(
  repositoryPath: string,
  bundlePath: string
): Promise<{ refs: DesignGitReference[]; headObjectId?: string }> {
  const entries = (await managedGit(repositoryPath, [
    'bundle',
    'list-heads',
    bundlePath
  ]))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseRefLine);
  const headObjectId = entries.find((entry) => entry.name === 'HEAD')?.objectId;
  return {
    refs: normalizeRefs(entries.filter((entry) => entry.name !== 'HEAD')),
    ...(headObjectId ? { headObjectId } : {})
  };
}

function parseRefLine(line: string): DesignGitReference {
  const separator = line.indexOf(' ');
  if (separator <= 0 || line.indexOf(' ', separator + 1) !== -1) {
    throw new Error('Managed Design Git reference output is malformed.');
  }
  return {
    objectId: line.slice(0, separator),
    name: line.slice(separator + 1)
  };
}

function normalizeRefs(values: readonly DesignGitReference[]): DesignGitReference[] {
  if (values.length === 0 || values.length > MAX_REFS) {
    throw new Error('Managed Design repository ref count is invalid.');
  }
  const refs = values.map((value) => {
    if (!value || typeof value.name !== 'string' || typeof value.objectId !== 'string') {
      throw new Error('Managed Design Git reference is malformed.');
    }
    assertGitReference(value.name);
    assertObjectId(value.objectId);
    return { name: value.name, objectId: value.objectId };
  });
  refs.sort((left, right) => left.name.localeCompare(right.name));
  for (let index = 1; index < refs.length; index += 1) {
    if (refs[index - 1]!.name === refs[index]!.name) {
      throw new Error('Managed Design repository contains duplicate refs.');
    }
  }
  return refs;
}

function normalizeObjectIds(values: readonly string[]): string[] {
  if (values.length > MAX_REQUIRED_OBJECTS) {
    throw new Error('Managed Design repository required-object count exceeds its limit.');
  }
  const ids = [...new Set(values)];
  ids.forEach(assertObjectId);
  ids.sort();
  return ids;
}

async function readAndValidateMarker(
  filePath: string,
  repositoryId: string
): Promise<DesignRepositoryMarkerBackup> {
  const integrity = await inspectPrivateImmutableFile(filePath);
  if (integrity.byteCount <= 0 || integrity.byteCount > MAX_MARKER_BYTES) {
    throw new Error('Managed Design repository marker size is invalid.');
  }
  const raw = await readStablePrivateFile(filePath, MAX_MARKER_BYTES);
  if (
    integrity.byteCount !== raw.byteLength ||
    integrity.sha256 !== createHash('sha256').update(raw).digest('hex')
  ) {
    throw new Error('Managed Design repository marker changed while it was read.');
  }
  const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    value.repositoryId !== repositoryId ||
    !isTaskCreationToken(value.creationToken) ||
    value.state !== 'READY' ||
    typeof value.initialCommitSha !== 'string' ||
    !GIT_OBJECT_ID.test(value.initialCommitSha) ||
    typeof value.createdAt !== 'string' ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new Error('Managed Design repository marker is malformed.');
  }
  return {
    schemaVersion: 1,
    repositoryId,
    creationToken: value.creationToken,
    state: 'READY',
    initialCommitSha: value.initialCommitSha,
    createdAt: value.createdAt
  };
}

async function verifyFile(
  filePath: string,
  expected: DesignRepositoryFileIntegrity,
  label: string
): Promise<void> {
  const actual = await inspectPrivateImmutableFile(filePath);
  if (actual.byteCount !== expected.byteCount || actual.sha256 !== expected.sha256) {
    throw new Error(`Managed Design repository ${label} digest does not match.`);
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !isOwnedByCurrentUser(stat) ||
    !hasNoGroupOrOtherPosixAccess(stat)
  ) {
    throw new Error('Managed Design repository directory is unsafe.');
  }
}

async function readStablePrivateFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !isOwnedByCurrentUser(before) ||
      !hasNoGroupOrOtherPosixAccess(before) ||
      before.size < 0 ||
      before.size > maxBytes
    ) {
      throw new Error('Managed Design repository file failed its integrity check.');
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      (before.ino !== 0 && after.ino !== 0 && before.ino !== after.ino) ||
      before.size !== after.size ||
      contents.byteLength !== before.size
    ) {
      throw new Error('Managed Design repository file changed while it was read.');
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function sealPrivateFile(filePath: string, mode: number): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !isOwnedByCurrentUser(stat)) {
      throw new Error('Managed Design backup file is unsafe.');
    }
    await enforcePosixMode(handle, mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryIfSupported(path.dirname(filePath));
}

async function syncDirectoryTree(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await syncDirectoryTree(entryPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error('Restored managed Design repository contains an unsafe filesystem entry.');
    }
    const handle = await fs.open(entryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectoryIfSupported(directory);
}

function assertRepositoryId(value: string): void {
  if (!UUID.test(value)) throw new Error('Managed Design repository id is invalid.');
}

function assertGitReference(value: string): void {
  const segments = value.split('/');
  if (
    !value.startsWith('refs/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('//') ||
    /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.lock')
    )
  ) {
    throw new Error('Managed Design Git reference is invalid.');
  }
}

function assertObjectId(value: string): void {
  if (!GIT_OBJECT_ID.test(value)) throw new Error('Managed Design Git object id is invalid.');
}

function assertIntegrity(value: DesignRepositoryFileIntegrity, label: string): void {
  if (
    !value ||
    !Number.isSafeInteger(value.byteCount) ||
    value.byteCount < 0 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    throw new Error(`Managed Design repository ${label} metadata is invalid.`);
  }
}

async function managedGit(
  cwd: string,
  argv: string[],
  additional: Pick<GitExecutionOptions, 'stdin'> = {}
): Promise<string> {
  const nullDevice = process.platform === 'win32' ? 'NUL' : os.devNull;
  const options: GitExecutionOptions = {
    timeout: GIT_TIMEOUT_MS,
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: nullDevice
    },
    ...additional
  };
  return git(cwd, argv, options);
}

function clean(value: string): string {
  return value.replace(/[\r\n]+$/u, '');
}
