import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import path from 'node:path';
import type { RepositoryCatalogSnapshot } from '../../shared/repositories';
import {
  MAX_REGISTERED_REPOSITORIES,
  MAX_REPOSITORY_IDENTITY_ANCHORS,
  MAX_REPOSITORY_PATH_ALIASES,
  MAX_REPOSITORY_REMOTE_FINGERPRINTS,
  REPOSITORY_REGISTRY_SCHEMA_VERSION,
  RepositoryInspectionError,
  type InspectedRepository,
  type RepositoryDiscoveryCandidate,
  type RepositoryIdentityEvidence,
  type RepositoryPathInspector,
  type RepositoryRecord,
  type RepositoryRegistry,
  type RepositoryRegistryFile,
  type ResolvedRepository
} from '../repository/RepositoryRegistry';

export interface FileRepositoryRegistryOptions {
  now?: () => string;
  createId?: () => string;
  syncDirectory?: (directory: string) => Promise<void>;
}

export class RepositoryRegistryPublishedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RepositoryRegistryPublishedError';
  }
}

export class FileRepositoryRegistry implements RepositoryRegistry {
  private state?: RepositoryRegistryFile;
  private initPromise?: Promise<void>;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly syncDirectoryHook: (directory: string) => Promise<void>;

  constructor(
    private readonly rootDir: string,
    private readonly inspector: RepositoryPathInspector,
    options: FileRepositoryRegistryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.syncDirectoryHook = options.syncDirectory ?? syncDirectory;
  }

  async reconcile(
    candidates: readonly RepositoryDiscoveryCandidate[]
  ): Promise<RepositoryRegistryFile> {
    return this.mutate(async (draft) => {
      for (const candidate of dedupeCandidates(candidates)) {
        await this.reconcileCandidate(draft, candidate);
      }
      repairDefault(draft);
    });
  }

  async snapshot(): Promise<RepositoryRegistryFile> {
    await this.init();
    return clone(this.state!);
  }

  async catalog(input: {
    selectedRepositoryId: string | null;
    tasks: readonly { id: string; repositoryPath: string }[];
  }): Promise<RepositoryCatalogSnapshot> {
    const state = await this.snapshot();
    const active = state.repositories.filter((record) => !record.removedAt);
    const taskAssociations = input.tasks.flatMap((task) => {
      const record = findByRecordedPath(active, task.repositoryPath);
      return record ? [{ taskId: task.id, repositoryId: record.id }] : [];
    });
    const counts = new Map<string, number>();
    for (const association of taskAssociations) {
      counts.set(
        association.repositoryId,
        (counts.get(association.repositoryId) ?? 0) + 1
      );
    }
    const selectedRepositoryId = active.some(
      (record) => record.id === input.selectedRepositoryId
    )
      ? input.selectedRepositoryId
      : state.defaultRepositoryId ?? active[0]?.id ?? null;
    return {
      revision: state.revision,
      defaultRepositoryId: state.defaultRepositoryId,
      selectedRepositoryId,
      repositories: active.map((record) => ({
        id: record.id,
        displayName: record.displayName,
        displayPath: displayPath(record.lastKnownPath),
        availability: record.availability,
        ...(record.unavailableReason
          ? { unavailableReason: record.unavailableReason }
          : {}),
        isDefault: record.id === state.defaultRepositoryId,
        taskCount: counts.get(record.id) ?? 0,
        ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {})
      })),
      taskAssociations
    };
  }

  async resolve(repositoryId: string): Promise<ResolvedRepository> {
    let result: ResolvedRepository | undefined;
    await this.mutate(async (draft) => {
      const record = requireActiveRecord(draft, repositoryId);
      if (record.availability !== 'AVAILABLE' || !record.canonicalRealPath) return;
      try {
        const inspected = await this.inspector.inspect(
          record.canonicalRealPath,
          record.identity
        );
        if (
          !samePath(inspected.canonicalRealPath, record.canonicalRealPath) ||
          !identityCompatible(record.identity, inspected.identity)
        ) {
          markIdentityChanged(record, this.now());
          return;
        }
        const mergedIdentity = mergeIdentity(record.identity, inspected.identity);
        if (!identityEqual(record.identity, mergedIdentity)) {
          const now = this.now();
          record.identity = mergedIdentity;
          record.updatedAt = now;
          record.lastSeenAt = now;
          record.lastCheckedAt = now;
        }
        result = {
          repositoryId,
          canonicalRealPath: inspected.canonicalRealPath,
          record: clone(record)
        };
      } catch (error) {
        const now = this.now();
        record.availability = 'UNAVAILABLE';
        record.unavailableReason =
          error instanceof RepositoryInspectionError ? error.reason : 'INACCESSIBLE';
        record.updatedAt = now;
        record.lastCheckedAt = now;
      }
    });
    if (!result) throw new Error(`Repository ${repositoryId} is unavailable or changed identity.`);
    return result;
  }

  async resolveRecordedPath(recordedPath: string): Promise<ResolvedRepository | undefined> {
    await this.init();
    const record = findByRecordedPath(
      this.state!.repositories.filter((candidate) => !candidate.removedAt),
      recordedPath
    );
    if (!record || record.availability !== 'AVAILABLE' || !record.canonicalRealPath) {
      return undefined;
    }
    return this.resolve(record.id);
  }

  async registerTrustedPath(candidatePath: string): Promise<RepositoryRecord> {
    let result: RepositoryRecord | undefined;
    await this.mutate(async (draft) => {
      const inspected = await this.inspector.inspect(candidatePath);
      const collision = findByCanonicalPath(draft.repositories, inspected.canonicalRealPath);
      if (collision) {
        const reattested = await this.inspector.inspect(candidatePath, collision.identity);
        if (!identityCompatible(collision.identity, reattested.identity)) {
          throw new Error('The selected path no longer matches its registered repository identity.');
        }
        const aliases = checkedAliases([
          ...collision.pathAliases,
          candidatePath,
          reattested.canonicalRealPath
        ]);
        if (JSON.stringify(aliases) !== JSON.stringify(collision.pathAliases)) {
          const now = this.now();
          collision.pathAliases = aliases;
          collision.identity = mergeIdentity(collision.identity, reattested.identity);
          collision.updatedAt = now;
          collision.lastSeenAt = now;
          collision.lastCheckedAt = now;
        }
        result = collision;
        return;
      }
      const aliasCollision = findByRecordedPath(draft.repositories, candidatePath);
      if (aliasCollision) {
        throw new Error(
          'The selected path is already reserved by a registered repository. Relink that record explicitly.'
        );
      }
      result = createAvailableRecord({
        id: this.createId(),
        candidatePath,
        source: 'USER',
        inspected,
        now: this.now()
      });
      addRecord(draft, result);
    });
    return clone(result!);
  }

  async relinkTrustedPath(
    repositoryId: string,
    candidatePath: string
  ): Promise<RepositoryRecord> {
    let result: RepositoryRecord | undefined;
    await this.mutate(async (draft) => {
      const record = requireActiveRecord(draft, repositoryId);
      const inspected = await this.inspector.inspect(candidatePath, record.identity);
      const collision = draft.repositories.find(
        (candidate) =>
          candidate.id !== repositoryId &&
          !candidate.removedAt &&
          (samePath(candidate.canonicalRealPath, inspected.canonicalRealPath) ||
            matchesRecordedPath(candidate, candidatePath))
      );
      if (collision) {
        throw new Error('The selected path already belongs to another registered repository.');
      }
      if (!identityCompatible(record.identity, inspected.identity)) {
        throw new Error('The selected path does not match the registered repository identity.');
      }
      const aliases = uniquePaths([
        ...record.pathAliases,
        record.lastKnownPath,
        candidatePath,
        inspected.canonicalRealPath
      ]);
      if (aliases.length > MAX_REPOSITORY_PATH_ALIASES) {
        throw new Error('Relinking would exceed the repository path-alias safety limit.');
      }
      const now = this.now();
      Object.assign(record, {
        canonicalRealPath: inspected.canonicalRealPath,
        lastKnownPath: normalizePath(candidatePath),
        pathAliases: aliases,
        displayName: inspected.displayName,
        availability: 'AVAILABLE' as const,
        unavailableReason: undefined,
        identity: mergeIdentity(record.identity, inspected.identity),
        updatedAt: now,
        lastSeenAt: now,
        lastCheckedAt: now
      });
      result = record;
    });
    return clone(result!);
  }

  async remove(repositoryId: string, options: { inUse?: boolean } = {}): Promise<void> {
    await this.mutate((draft) => {
      const record = requireActiveRecord(draft, repositoryId);
      if (record.id === draft.defaultRepositoryId) {
        throw new Error('The default repository cannot be removed.');
      }
      if (options.inUse) {
        throw new Error('The repository is referenced by one or more tasks.');
      }
      const now = this.now();
      record.removedAt = now;
      record.updatedAt = now;
      repairDefault(draft);
    });
  }

  private async reconcileCandidate(
    draft: RepositoryRegistryFile,
    candidate: RepositoryDiscoveryCandidate
  ): Promise<void> {
    const candidatePath = normalizePath(candidate.path);
    if (!candidatePath) return;

    let inspected: InspectedRepository;
    try {
      inspected = await this.inspector.inspect(candidatePath);
    } catch (error) {
      const reason =
        error instanceof RepositoryInspectionError ? error.reason : 'INACCESSIBLE';
      let record = findByRecordedPath(draft.repositories, candidatePath);
      if (!record) {
        record = createUnavailableRecord({
          id: this.createId(),
          candidatePath,
          source: candidate.source,
          reason,
          now: this.now()
        });
        addRecord(draft, record);
      } else if (record.availability !== 'UNAVAILABLE' || record.unavailableReason !== reason) {
        const now = this.now();
        record.availability = 'UNAVAILABLE';
        record.unavailableReason = reason;
        record.updatedAt = now;
        record.lastCheckedAt = now;
      }
      if (candidate.isDefault) draft.defaultRepositoryId = record.id;
      return;
    }

    let byCanonical = findByCanonicalPath(draft.repositories, inspected.canonicalRealPath);
    let byRecordedPath = findByRecordedPath(draft.repositories, candidatePath);
    if (byCanonical && byRecordedPath && byCanonical.id !== byRecordedPath.id) {
      throw new Error(
        'Repository registry contains conflicting canonical-path and alias ownership.'
      );
    }
    let record = byCanonical ?? byRecordedPath;
    if (record && hasIdentity(record.identity)) {
      const reattested = await this.inspector.inspect(candidatePath, record.identity);
      byCanonical = findByCanonicalPath(draft.repositories, reattested.canonicalRealPath);
      byRecordedPath = findByRecordedPath(draft.repositories, candidatePath);
      if (byCanonical && byRecordedPath && byCanonical.id !== byRecordedPath.id) {
        throw new Error(
          'Repository registry contains conflicting canonical-path and alias ownership.'
        );
      }
      record = byCanonical ?? byRecordedPath;
      if (!record || !identityCompatible(record.identity, reattested.identity)) {
        const changed = record ?? byRecordedPath;
        if (changed) {
          markIdentityChanged(changed, this.now());
          if (candidate.isDefault) draft.defaultRepositoryId = changed.id;
          return;
        }
        throw new Error('Repository identity changed during reconciliation.');
      }
      inspected = reattested;
    }
    if (!record) {
      record = createAvailableRecord({
        id: this.createId(),
        candidatePath,
        source: candidate.source,
        inspected,
        now: this.now()
      });
      addRecord(draft, record);
    } else if (!recordMatchesInspection(record, candidatePath, inspected)) {
      const now = this.now();
      record.canonicalRealPath = inspected.canonicalRealPath;
      record.lastKnownPath = candidatePath;
      record.pathAliases = checkedAliases([
        ...record.pathAliases,
        candidatePath,
        inspected.canonicalRealPath
      ]);
      record.displayName = inspected.displayName;
      record.availability = 'AVAILABLE';
      record.unavailableReason = undefined;
      record.identity = mergeIdentity(record.identity, inspected.identity);
      record.updatedAt = now;
      record.lastSeenAt = now;
      record.lastCheckedAt = now;
    }
    if (candidate.isDefault) draft.defaultRepositoryId = record.id;
  }

  private async init(): Promise<void> {
    if (this.state) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.rootDir);
    const filePath = this.filePath();
    try {
      const handle = await fs.open(
        filePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      );
      try {
        const fileStat = await handle.stat();
        assertPrivateRegistryFile(fileStat);
        if (fileStat.size > 2 * 1024 * 1024) {
          throw new Error('Repository registry exceeds its file-size safety limit.');
        }
        const raw = await handle.readFile('utf8');
        this.state = parseRegistryFile(raw);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const initial = emptyRegistry();
      try {
        await this.persist(initial);
        this.state = initial;
      } catch (persistError) {
        if (persistError instanceof RepositoryRegistryPublishedError) {
          this.state = initial;
        }
        throw persistError;
      }
    }
  }

  private async mutate(
    operation: (draft: RepositoryRegistryFile) => void | Promise<void>
  ): Promise<RepositoryRegistryFile> {
    const queued = this.operationQueue
      .catch(() => undefined)
      .then(async () => {
        await this.init();
        const before = this.state!;
        const draft = clone(before);
        await operation(draft);
        validateRegistryFile(draft);
        if (stableRegistryContent(draft) !== stableRegistryContent(before)) {
          draft.revision = before.revision + 1;
          try {
            await this.persist(draft);
            this.state = draft;
          } catch (error) {
            if (error instanceof RepositoryRegistryPublishedError) {
              this.state = draft;
            }
            throw error;
          }
        }
        return clone(this.state!);
      });
    this.operationQueue = queued.catch(() => undefined);
    return queued;
  }

  private async persist(state: RepositoryRegistryFile): Promise<void> {
    await ensurePrivateDirectory(this.rootDir);
    const target = this.filePath();
    const temporary = path.join(
      this.rootDir,
      `.store-${process.pid}-${crypto.randomUUID()}.tmp`
    );
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, target);
      try {
        await this.syncDirectoryHook(this.rootDir);
      } catch (error) {
        throw new RepositoryRegistryPublishedError(
          'Repository registry was published but directory durability could not be confirmed.',
          { cause: error }
        );
      }
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private filePath(): string {
    return path.join(this.rootDir, 'store.json');
  }
}

function emptyRegistry(): RepositoryRegistryFile {
  return {
    schemaVersion: REPOSITORY_REGISTRY_SCHEMA_VERSION,
    revision: 0,
    defaultRepositoryId: null,
    repositories: []
  };
}

function parseRegistryFile(raw: string): RepositoryRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'Repository registry is corrupt. The original file was preserved; restore it or move it aside before retrying.'
    );
  }
  if (!isRecord(parsed) || typeof parsed.schemaVersion !== 'number') {
    throw new Error('Repository registry has an invalid or missing schema version.');
  }
  if (parsed.schemaVersion > REPOSITORY_REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Repository registry schema ${parsed.schemaVersion} is newer than this app supports. Upgrade Task Monki or restore a compatible backup.`
    );
  }
  if (parsed.schemaVersion !== REPOSITORY_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported repository registry schema: ${parsed.schemaVersion}`);
  }
  validateRegistryFile(parsed);
  return clone(parsed);
}

function validateRegistryFile(value: unknown): asserts value is RepositoryRegistryFile {
  if (!isRecord(value)) throw new Error('Repository registry root must be an object.');
  if (value.schemaVersion !== REPOSITORY_REGISTRY_SCHEMA_VERSION) {
    throw new Error('Repository registry schema is invalid.');
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error('Repository registry revision is invalid.');
  }
  if (value.defaultRepositoryId !== null && typeof value.defaultRepositoryId !== 'string') {
    throw new Error('Repository registry default id is invalid.');
  }
  if (!Array.isArray(value.repositories) || value.repositories.length > MAX_REGISTERED_REPOSITORIES) {
    throw new Error('Repository registry collection is invalid or exceeds its safety limit.');
  }
  const ids = new Set<string>();
  const ownedPaths = new Map<string, string>();
  for (const candidate of value.repositories) {
    validateRepositoryRecord(candidate);
    if (ids.has(candidate.id)) throw new Error(`Duplicate repository id: ${candidate.id}`);
    ids.add(candidate.id);
    if (!candidate.removedAt) {
      for (const candidatePath of [
        candidate.canonicalRealPath,
        candidate.lastKnownPath,
        ...candidate.pathAliases
      ]) {
        if (!candidatePath) continue;
        const key = pathKey(candidatePath);
        const owner = ownedPaths.get(key);
        if (owner && owner !== candidate.id) {
          throw new Error('Repository registry paths must have exactly one active owner.');
        }
        ownedPaths.set(key, candidate.id);
      }
    }
  }
  if (
    value.defaultRepositoryId &&
    !value.repositories.some(
      (record) => record.id === value.defaultRepositoryId && !record.removedAt
    )
  ) {
    throw new Error('Repository registry default id does not exist.');
  }
}

function validateRepositoryRecord(value: unknown): asserts value is RepositoryRecord {
  if (!isRecord(value)) throw new Error('Repository registry record must be an object.');
  for (const field of ['id', 'lastKnownPath', 'displayName', 'createdAt', 'updatedAt', 'lastCheckedAt']) {
    if (typeof value[field] !== 'string' || !(value[field] as string)) {
      throw new Error(`Repository record ${field} is invalid.`);
    }
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value.id as string)) {
    throw new Error('Repository record id is invalid.');
  }
  for (const field of ['lastKnownPath', 'canonicalRealPath'] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (!path.isAbsolute(candidate as string) || normalizePath(candidate as string) !== candidate)
    ) {
      throw new Error(`Repository record ${field} must be an absolute normalized path.`);
    }
  }
  if (value.canonicalRealPath !== undefined && typeof value.canonicalRealPath !== 'string') {
    throw new Error('Repository canonical path is invalid.');
  }
  if (
    !Array.isArray(value.pathAliases) ||
    value.pathAliases.some((alias) => typeof alias !== 'string') ||
    value.pathAliases.length > MAX_REPOSITORY_PATH_ALIASES
  ) {
    throw new Error('Repository path aliases are invalid or exceed their safety limit.');
  }
  if (
    (value.pathAliases as string[]).some(
      (alias) => !path.isAbsolute(alias) || normalizePath(alias) !== alias
    )
  ) {
    throw new Error('Repository path aliases must be absolute normalized paths.');
  }
  if (value.availability !== 'AVAILABLE' && value.availability !== 'UNAVAILABLE') {
    throw new Error('Repository availability is invalid.');
  }
  if (
    (value.availability === 'AVAILABLE' &&
      (!value.canonicalRealPath || value.unavailableReason !== undefined)) ||
    (value.availability === 'UNAVAILABLE' &&
      !['MISSING', 'INACCESSIBLE', 'NOT_A_REPOSITORY', 'IDENTITY_CHANGED'].includes(
        String(value.unavailableReason)
      ))
  ) {
    throw new Error('Repository availability evidence is inconsistent.');
  }
  if (!['USER', 'DEFAULT', 'LEGACY_SETTINGS', 'TASK'].includes(String(value.discoverySource))) {
    throw new Error('Repository discovery source is invalid.');
  }
  validateIdentity(value.identity);
  for (const field of ['createdAt', 'updatedAt', 'lastCheckedAt', 'lastSeenAt', 'removedAt']) {
    if (value[field] !== undefined && !isIsoTimestamp(value[field])) {
      throw new Error(`Repository record ${field} is invalid.`);
    }
  }
}

function validateIdentity(value: unknown): asserts value is RepositoryIdentityEvidence {
  if (!isRecord(value) || typeof value.objectFormat !== 'string') {
    throw new Error('Repository identity evidence is invalid.');
  }
  if (value.fileSystem !== undefined) {
    if (
      !isRecord(value.fileSystem) ||
      typeof value.fileSystem.device !== 'string' ||
      typeof value.fileSystem.inode !== 'string'
    ) {
      throw new Error('Repository filesystem identity evidence is invalid.');
    }
  }
  for (const [field, limit] of [
    ['anchorCommits', MAX_REPOSITORY_IDENTITY_ANCHORS],
    ['remoteFingerprints', MAX_REPOSITORY_REMOTE_FINGERPRINTS]
  ] as const) {
    const entries = value[field];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string') || entries.length > limit) {
      throw new Error(`Repository identity ${field} is invalid or exceeds its safety limit.`);
    }
  }
}

function createAvailableRecord(input: {
  id: string;
  candidatePath: string;
  source: RepositoryRecord['discoverySource'];
  inspected: InspectedRepository;
  now: string;
}): RepositoryRecord {
  return {
    id: input.id,
    canonicalRealPath: input.inspected.canonicalRealPath,
    lastKnownPath: normalizePath(input.candidatePath),
    pathAliases: checkedAliases([input.candidatePath, input.inspected.canonicalRealPath]),
    displayName: input.inspected.displayName,
    availability: 'AVAILABLE',
    discoverySource: input.source,
    identity: boundedIdentity(input.inspected.identity),
    createdAt: input.now,
    updatedAt: input.now,
    lastSeenAt: input.now,
    lastCheckedAt: input.now
  };
}

function createUnavailableRecord(input: {
  id: string;
  candidatePath: string;
  source: RepositoryRecord['discoverySource'];
  reason: RepositoryRecord['unavailableReason'];
  now: string;
}): RepositoryRecord {
  const normalized = normalizePath(input.candidatePath);
  return {
    id: input.id,
    lastKnownPath: normalized,
    pathAliases: [normalized],
    displayName: path.basename(normalized),
    availability: 'UNAVAILABLE',
    unavailableReason: input.reason,
    discoverySource: input.source,
    identity: { objectFormat: '', anchorCommits: [], remoteFingerprints: [] },
    createdAt: input.now,
    updatedAt: input.now,
    lastCheckedAt: input.now
  };
}

function recordMatchesInspection(
  record: RepositoryRecord,
  candidatePath: string,
  inspected: InspectedRepository
): boolean {
  return (
    record.availability === 'AVAILABLE' &&
    !record.unavailableReason &&
    samePath(record.canonicalRealPath, inspected.canonicalRealPath) &&
    samePath(record.lastKnownPath, candidatePath) &&
    record.displayName === inspected.displayName &&
    identityEqual(record.identity, mergeIdentity(record.identity, inspected.identity))
  );
}

function identityCompatible(
  stored: RepositoryIdentityEvidence,
  inspected: RepositoryIdentityEvidence
): boolean {
  if (!hasIdentity(stored) || stored.objectFormat !== inspected.objectFormat) return false;
  return stored.anchorCommits.some((anchor) => inspected.anchorCommits.includes(anchor));
}

function hasIdentity(identity: RepositoryIdentityEvidence): boolean {
  return Boolean(
    identity.objectFormat &&
      (identity.anchorCommits.length > 0 || identity.remoteFingerprints.length > 0)
  );
}

function mergeIdentity(
  current: RepositoryIdentityEvidence,
  observed: RepositoryIdentityEvidence
): RepositoryIdentityEvidence {
  return boundedIdentity({
    objectFormat: observed.objectFormat || current.objectFormat,
    anchorCommits: [...observed.anchorCommits, ...current.anchorCommits],
    remoteFingerprints: [...observed.remoteFingerprints, ...current.remoteFingerprints],
    fileSystem: observed.fileSystem
  });
}

function boundedIdentity(identity: RepositoryIdentityEvidence): RepositoryIdentityEvidence {
  return {
    objectFormat: identity.objectFormat,
    anchorCommits: [...new Set(identity.anchorCommits)].slice(0, MAX_REPOSITORY_IDENTITY_ANCHORS),
    remoteFingerprints: [...new Set(identity.remoteFingerprints)].slice(
      0,
      MAX_REPOSITORY_REMOTE_FINGERPRINTS
    ),
    ...(identity.fileSystem ? { fileSystem: { ...identity.fileSystem } } : {})
  };
}

function identityEqual(left: RepositoryIdentityEvidence, right: RepositoryIdentityEvidence): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addRecord(state: RepositoryRegistryFile, record: RepositoryRecord): void {
  if (state.repositories.length >= MAX_REGISTERED_REPOSITORIES) {
    throw new Error('Repository registry has reached its safety limit.');
  }
  state.repositories.push(record);
}

function requireActiveRecord(state: RepositoryRegistryFile, id: string): RepositoryRecord {
  const record = state.repositories.find((candidate) => candidate.id === id && !candidate.removedAt);
  if (!record) throw new Error(`Unknown repository id: ${id}`);
  return record;
}

function findByCanonicalPath(
  records: readonly RepositoryRecord[],
  candidatePath: string
): RepositoryRecord | undefined {
  return records.find(
    (record) => !record.removedAt && samePath(record.canonicalRealPath, candidatePath)
  );
}

function findByRecordedPath(
  records: readonly RepositoryRecord[],
  candidatePath: string
): RepositoryRecord | undefined {
  return records.find((record) => !record.removedAt && matchesRecordedPath(record, candidatePath));
}

function matchesRecordedPath(record: RepositoryRecord, candidatePath: string): boolean {
  return [record.canonicalRealPath, record.lastKnownPath, ...record.pathAliases].some((stored) =>
    samePath(stored, candidatePath)
  );
}

function repairDefault(state: RepositoryRegistryFile): void {
  if (
    state.defaultRepositoryId &&
    state.repositories.some(
      (record) => record.id === state.defaultRepositoryId && !record.removedAt
    )
  ) {
    return;
  }
  state.defaultRepositoryId = state.repositories.find((record) => !record.removedAt)?.id ?? null;
}

function dedupeCandidates(
  candidates: readonly RepositoryDiscoveryCandidate[]
): RepositoryDiscoveryCandidate[] {
  const byPath = new Map<string, RepositoryDiscoveryCandidate>();
  for (const candidate of candidates) {
    const normalized = normalizePath(candidate.path);
    if (!normalized) continue;
    const key = pathKey(normalized);
    const current = byPath.get(key);
    if (!current || candidate.isDefault) {
      byPath.set(key, { ...candidate, path: normalized });
    }
  }
  return [...byPath.values()];
}

function checkedAliases(paths: readonly string[]): string[] {
  const aliases = uniquePaths(paths);
  if (aliases.length > MAX_REPOSITORY_PATH_ALIASES) {
    throw new Error('Repository path aliases exceed their safety limit.');
  }
  return aliases;
}

function uniquePaths(paths: readonly string[]): string[] {
  const result = new Map<string, string>();
  for (const candidate of paths) {
    const normalized = normalizePath(candidate);
    if (normalized) result.set(pathKey(normalized), normalized);
  }
  return [...result.values()];
}

function normalizePath(candidatePath: string): string {
  const trimmed = candidatePath.trim();
  return trimmed ? path.resolve(trimmed) : '';
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && pathKey(normalizePath(left)) === pathKey(normalizePath(right)));
}

function pathKey(candidatePath: string): string {
  return process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
}

function displayPath(candidatePath: string): string {
  const normalized = normalizePath(candidatePath);
  const parent = path.basename(path.dirname(normalized));
  return parent ? path.join(parent, path.basename(normalized)) : normalized;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Repository registry root must be a private directory, not a symlink.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(directory, 0o700);
  const stat = await fs.stat(directory);
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error('Repository registry root must be owned by the current user and private.');
    }
  }
}

function assertPrivateRegistryFile(stat: Stats): void {
  if (!stat.isFile()) {
    throw new Error('Repository registry store must be a regular private file.');
  }
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error('Repository registry store must be owned by the current user and private.');
    }
  }
}

function markIdentityChanged(record: RepositoryRecord, now: string): void {
  record.availability = 'UNAVAILABLE';
  record.unavailableReason = 'IDENTITY_CHANGED';
  record.updatedAt = now;
  record.lastCheckedAt = now;
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function stableRegistryContent(state: RepositoryRegistryFile): string {
  return JSON.stringify({ ...state, revision: 0 });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
