export type RepositoryAvailability = 'AVAILABLE' | 'UNAVAILABLE';
export type RepositoryUnavailableReason =
  | 'MISSING'
  | 'INACCESSIBLE'
  | 'NOT_A_REPOSITORY'
  | 'IDENTITY_CHANGED';

export interface RepositoryCatalogEntry {
  id: string;
  displayName: string;
  displayPath: string;
  availability: RepositoryAvailability;
  unavailableReason?: RepositoryUnavailableReason;
  isDefault: boolean;
  taskCount: number;
  lastSeenAt?: string;
}

export interface TaskRepositoryAssociation {
  taskId: string;
  repositoryId: string;
}

export interface RepositoryCatalogSnapshot {
  revision: number;
  defaultRepositoryId: string | null;
  selectedRepositoryId: string | null;
  repositories: RepositoryCatalogEntry[];
  taskAssociations: TaskRepositoryAssociation[];
}

export interface SelectRepositoryRequest {
  repositoryId: string;
}

export interface RemoveRepositoryRequest {
  repositoryId: string;
  clientMutationId: string;
}

export interface RelinkRepositoryRequest {
  repositoryId: string;
  clientMutationId: string;
}

export interface AddRepositoryRequest {
  clientMutationId: string;
}
