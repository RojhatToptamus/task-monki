import type { AttachmentDraftSnapshot } from './attachments';

export type DesignTurnMessageSource = 'TASK_PROMPT' | 'INLINE_MESSAGE';

export const DESIGN_LIMITS = {
  queuedTurns: 20,
  transcriptPageSize: 50,
  recentTelemetryItems: 100,
  readyContextEntries: 8,
  draftBytes: 1024 * 1024
} as const;

export interface DesignSourceCheckpoint {
  repositoryId: string;
  worktreeId: string;
  branchName: string;
  expectedParentCommit: string;
  treeSha: string;
  candidateCommitSha?: string;
}

export interface DesignOpenedCandidateCheckpoint {
  source: DesignSourceCheckpoint & { candidateCommitSha: string };
  previewGenerationId: string;
}

export type DesignTurnCheckpoint =
  | { boundary: 'QUEUED' }
  | { boundary: 'RUN_LINKED' }
  | { boundary: 'POST_RUN_EVIDENCE_RECORDED'; gitSnapshotId: string }
  | { boundary: 'SOURCE_CAPTURED'; source: DesignSourceCheckpoint }
  | {
      boundary: 'REF_UPDATED_INDEX_PENDING';
      source: DesignSourceCheckpoint & { candidateCommitSha: string };
    }
  | {
      boundary: 'INDEX_REPAIRED';
      source: DesignSourceCheckpoint & { candidateCommitSha: string };
    }
  | {
      boundary: 'PREVIEW_CANDIDATE_READY';
      previewGenerationId: string;
      commitSha: string;
    };

export type DesignTurnOutcome =
  | 'READY'
  | 'NO_CHANGE'
  | 'FAILED'
  | 'CANCELED'
  | 'NEEDS_ATTENTION';

export interface DesignTurn {
  id: string;
  designId: string;
  clientMessageId: string;
  order: number;
  messageSource: DesignTurnMessageSource;
  messageArtifactId?: string;
  attachmentDraftId?: string;
  referenceIds: string[];
  runId?: string;
  checkpoint?: DesignTurnCheckpoint;
  finalOpenedCandidate?: DesignOpenedCandidateCheckpoint;
  outcome?: DesignTurnOutcome;
  failureReason?: string;
  createdAt: string;
  settledAt?: string;
}

export interface DesignReference {
  id: string;
  designId: string;
  attachmentId: string;
  role: 'REFERENCE' | 'PROJECT_ASSET_SOURCE';
  state: 'ACTIVE' | 'INACTIVE';
  sourceDraftId?: string;
  firstDeliveredAt?: string;
  projectAssetPath?: string;
  createdAt: string;
  deactivatedAt?: string;
}

export interface DesignProjectFile {
  path: string;
  byteCount: number;
}

interface DesignRevisionBase {
  id: string;
  designId: string;
  ordinal: number;
  commitSha: string;
  routeId: string;
  createdAt: string;
}

export type DesignRevision = DesignRevisionBase &
  (
    | {
        changeSource: 'AGENT_TURN';
        turnId: string;
        runId: string;
      }
    | {
        changeSource: 'RESTORE';
        sourceRevisionId: string;
        clientActionId: string;
      }
    | {
        changeSource: 'DUPLICATE';
      }
  );

export type DesignRestoreCheckpoint =
  | { boundary: 'RECORDED' }
  | {
      boundary: 'SOURCE_CAPTURED';
      expectedParentCommit: string;
      treeSha: string;
    }
  | {
      boundary: 'COMMIT_PUBLISHED';
      expectedParentCommit: string;
      treeSha: string;
      targetCommitSha: string;
    }
  | {
      boundary: 'WORKTREE_MATERIALIZED';
      targetCommitSha: string;
    }
  | {
      boundary: 'PREVIEW_CANDIDATE_READY';
      targetCommitSha: string;
      previewGenerationId: string;
    };

export type DesignDuplicateCheckpoint =
  | { boundary: 'TARGET_CREATED' }
  | { boundary: 'WORKTREE_CREATED' }
  | {
      boundary: 'PREVIEW_CANDIDATE_READY';
      previewGenerationId: string;
    };

interface DesignSourceActionBase {
  id: string;
  designId: string;
  clientActionId: string;
  sourceRevisionId: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type DesignSourceAction = DesignSourceActionBase &
  (
    | {
        kind: 'RESTORE';
        checkpoint: DesignRestoreCheckpoint;
      }
    | {
        kind: 'DUPLICATE';
        targetDesignId: string;
        checkpoint: DesignDuplicateCheckpoint;
      }
  );

export interface CreateBlankDesignRequest {
  brief: string;
  creationToken: string;
  model?: string;
  reasoningEffort?: string;
  attachmentDraftId?: string;
}

export interface SubmitDesignTurnRequest {
  designId: string;
  clientMessageId: string;
  message: string;
  referenceIds: string[];
  attachmentDraftId?: string;
}

export interface AddDesignReferencesRequest {
  designId: string;
  attachmentDraftId: string;
}

export interface RemoveDesignReferenceRequest {
  designId: string;
  referenceId: string;
}

export interface ImportDesignReferenceAssetRequest {
  designId: string;
  referenceId: string;
}

export interface CancelDesignTurnRequest {
  designId: string;
  turnId: string;
}

export interface ListDesignConversationRequest {
  designId: string;
  beforeCursor?: string;
  limit?: number;
}

export interface DesignConversationPage {
  entries: DesignConversationEntry[];
  previousCursor?: string;
}

export interface DesignDraftRecord {
  designId: string;
  recordRevision: number;
  body: string;
  referenceIds: string[];
  attachmentDraftId?: string;
  /** Current staging metadata, resolved by the service instead of copied into the draft file. */
  attachmentDraft?: AttachmentDraftSnapshot;
  updatedAt: string;
}

export interface SaveDesignDraftRequest {
  designId: string;
  expectedRevision: number;
  body: string;
  referenceIds: string[];
  attachmentDraftId?: string;
}

export interface ReadDesignDraftAttachmentRequest {
  designId: string;
  attachmentId: string;
}

export interface DeleteDesignDraftRequest {
  designId: string;
  expectedRevision: number;
}

export interface RestartDesignPreviewRequest {
  designId: string;
}

export interface RestoreDesignRevisionRequest {
  designId: string;
  revisionId: string;
  clientActionId: string;
}

export interface DuplicateDesignRequest {
  designId: string;
  revisionId: string;
  clientActionId: string;
}

export interface RenameDesignRequest {
  designId: string;
  title: string;
}

export interface ArchiveDesignRequest {
  designId: string;
}

export type DesignStatus =
  | 'STARTING'
  | 'READY'
  | 'UPDATING'
  | 'NEEDS_INPUT'
  | 'NEEDS_ATTENTION'
  | 'ARCHIVED';

export interface DesignCanvasTarget {
  generationId: string;
  routeId: string;
}

export interface DesignCanvasProjection {
  state: 'EMPTY' | 'UPDATING' | 'READY' | 'RESTART_REQUIRED';
  target?: DesignCanvasTarget;
  detail?: string;
}

export interface DesignActionAvailability {
  canRefine: boolean;
  refineDisabledReason?: string;
  queuedTurnCount: number;
  canStop: boolean;
  stopTurnId?: string;
  canRestart: boolean;
  canRestore: boolean;
  canDuplicate: boolean;
  canArchive: boolean;
  canDelete: boolean;
  deleteDisabledReason?: string;
}

export interface DesignOrigin {
  designId: string;
  revisionId: string;
  designTitle?: string;
  revisionOrdinal?: number;
}

export interface DesignListItem {
  id: string;
  title: string;
  runtimeId: string;
  status: DesignStatus;
  latestRevision?: DesignRevision;
  updatedAt: string;
}

export interface DesignConversationEntry {
  turn: DesignTurn;
  userMessage: string;
  assistantMessage?: string;
  runStatus?: import('./agent').AgentRunStatus;
  readyRevision?: DesignRevision;
}

export interface DesignReadyContextEntry {
  revision: DesignRevision;
  userRequest?: string;
  sourceRevisionOrdinal?: number;
}
