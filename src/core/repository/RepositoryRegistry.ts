import type {
  RepositoryAvailability,
  RepositoryCatalogSnapshot,
  RepositoryUnavailableReason
} from '../../shared/repositories';

export const REPOSITORY_REGISTRY_SCHEMA_VERSION = 1 as const;
export const MAX_REGISTERED_REPOSITORIES = 128;
export const MAX_REPOSITORY_PATH_ALIASES = 16;
export const MAX_REPOSITORY_IDENTITY_ANCHORS = 8;
export const MAX_REPOSITORY_REMOTE_FINGERPRINTS = 8;

export type RepositoryDiscoverySource = 'USER' | 'DEFAULT' | 'LEGACY_SETTINGS' | 'TASK';

export interface RepositoryIdentityEvidence {
  objectFormat: string;
  anchorCommits: string[];
  remoteFingerprints: string[];
  fileSystem?: { device: string; inode: string };
}

export interface RepositoryRecord {
  id: string;
  canonicalRealPath?: string;
  lastKnownPath: string;
  pathAliases: string[];
  displayName: string;
  availability: RepositoryAvailability;
  unavailableReason?: RepositoryUnavailableReason;
  discoverySource: RepositoryDiscoverySource;
  identity: RepositoryIdentityEvidence;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  lastCheckedAt: string;
  removedAt?: string;
}

export interface RepositoryRegistryFile {
  schemaVersion: typeof REPOSITORY_REGISTRY_SCHEMA_VERSION;
  revision: number;
  defaultRepositoryId: string | null;
  repositories: RepositoryRecord[];
}

export interface RepositoryDiscoveryCandidate {
  path: string;
  source: RepositoryDiscoverySource;
  isDefault?: boolean;
}

export interface InspectedRepository {
  canonicalRealPath: string;
  displayName: string;
  identity: RepositoryIdentityEvidence;
}

export interface RepositoryPathInspector {
  inspect(
    candidatePath: string,
    expectedIdentity?: RepositoryIdentityEvidence
  ): Promise<InspectedRepository>;
}

export class RepositoryInspectionError extends Error {
  constructor(
    readonly reason: Exclude<RepositoryUnavailableReason, 'IDENTITY_CHANGED'>,
    message: string
  ) {
    super(message);
    this.name = 'RepositoryInspectionError';
  }
}

export interface ResolvedRepository {
  repositoryId: string;
  canonicalRealPath: string;
  record: RepositoryRecord;
}

export interface RepositoryRegistry {
  reconcile(candidates: readonly RepositoryDiscoveryCandidate[]): Promise<RepositoryRegistryFile>;
  snapshot(): Promise<RepositoryRegistryFile>;
  catalog(input: {
    selectedRepositoryId: string | null;
    tasks: readonly { id: string; repositoryPath: string }[];
  }): Promise<RepositoryCatalogSnapshot>;
  resolve(repositoryId: string): Promise<ResolvedRepository>;
  resolveRecordedPath(recordedPath: string): Promise<ResolvedRepository | undefined>;
  registerTrustedPath(candidatePath: string): Promise<RepositoryRecord>;
  relinkTrustedPath(repositoryId: string, candidatePath: string): Promise<RepositoryRecord>;
  remove(repositoryId: string, options?: { inUse?: boolean }): Promise<void>;
}
