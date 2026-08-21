export type DesignTurnMessageSource = 'TASK_PROMPT' | 'INLINE_MESSAGE';

export interface DesignSourceCheckpoint {
  repositoryId: string;
  worktreeId: string;
  branchName: string;
  expectedParentCommit: string;
  treeSha: string;
  candidateCommitSha?: string;
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
  referenceIds: string[];
  runId?: string;
  checkpoint?: DesignTurnCheckpoint;
  outcome?: DesignTurnOutcome;
  failureReason?: string;
  createdAt: string;
  settledAt?: string;
}

export interface DesignReference {
  id: string;
  designId: string;
  attachmentId: string;
  createdAt: string;
}

export interface DesignRevision {
  id: string;
  designId: string;
  ordinal: number;
  commitSha: string;
  changeSource: 'AGENT_TURN';
  turnId: string;
  runId: string;
  routeId: string;
  createdAt: string;
}

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
}

export interface RestartDesignPreviewRequest {
  designId: string;
}

export type DesignStatus =
  | 'STARTING'
  | 'READY'
  | 'UPDATING'
  | 'NEEDS_INPUT'
  | 'NEEDS_ATTENTION';

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
  canRestart: boolean;
  canDelete: boolean;
  deleteDisabledReason?: string;
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
}
