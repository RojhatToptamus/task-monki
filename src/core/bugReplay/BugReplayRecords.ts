import type { BugCaseEnvironment, BugCaseV1 } from '../../shared/bugCase';
import type {
  BugCaseDecisionKind,
  BugCaseRevisionKind,
  BugCaseStatus,
  BugElementBox,
  BugReplayProtectedInput,
  BugReplayRunRecord,
  BugStepKind
} from '../../shared/bugReplay';

/** Durable Bug Replay records. Core-only: the renderer reads views built from them. */

export interface BugReplayRecipeRecord {
  name: 'preview.yaml' | 'preview.yml';
  text: string;
  sha256: string;
}

export interface BugReplayEnvFileRecord {
  relativePath: string;
  sha256: string;
}

export interface BugCaptureRecord {
  id: string;
  taskId: string;
  worktreeId: string;
  recordingRunId: string;
  sourceTreeId: string;
  environment: BugCaseEnvironment;
  engine: { chromium: string };
  coverage: { complete: boolean; reasons: string[] };
  roles: string[];
  recipe: BugReplayRecipeRecord;
  templateDigest: string;
  envFiles: BugReplayEnvFileRecord[];
  pageTitle?: string;
  stepSummaries: string[];
  /** What each step does, beside its summary; absent on captures saved before kinds were kept. */
  stepKinds?: BugStepKind[];
  /** Where each picked element sat in the capture's screenshot, by its structural CSS path. */
  markedBoxes?: Array<{ css: string; box: BugElementBox }>;
  fileIds: { actionLog?: string; network?: string; console?: string; screenshots: string[] };
  createdAt: string;
}

export interface BugCaseRecord {
  id: string;
  taskId: string;
  captureId: string;
  title: string;
  statement?: string;
  status: BugCaseStatus;
  keepBrowserStorage: boolean;
  /** The bug follow-up in flight, as Task Monki last observed it. */
  handoff?: { handoffId: string; runId?: string; instructionId?: string; status: 'QUEUED' | 'RUNNING' | 'HELD'; since: string };
  lastSentAt?: string;
  /** The worktree tree last compared with the verdict. */
  observedTreeId?: string;
  /** Why the worktree could not be read after the agent's last turn; cleared by the next read. */
  observedTreeIssue?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/**
 * What the recording showed for one expectation, kept with each version so a changed expectation
 * is checked against the recording by the compiler's own rules. Lists keep each distinct value in
 * the order it was first seen, which is all those rules read.
 */
export type BugRecordedObservation =
  /** The picked element: its whitespace-normalised text, a field's value, and its name as the pick showed it. */
  | { kind: 'element'; label: string; text: string; value?: string; visible: boolean; count: number; field: boolean }
  /** The requests the check counts: how many, and how each was answered (a status, or no response). */
  | { kind: 'requests'; count: number; answers: Array<number | 'no-response'> }
  /** Canonical JSON at the checked pointer; null where a response had no value there. */
  | { kind: 'json'; values: Array<string | null> }
  | { kind: 'pageError'; raised: boolean };

export interface BugCaseVersionRecord {
  id: string;
  caseId: string;
  taskId: string;
  version: number;
  digest: string;
  revisionKind: BugCaseRevisionKind;
  /** For a changed expectation: what changed, in the product's words. */
  reason?: string;
  document: BugCaseV1;
  /** What the recording showed for each expectation, by its id; absent on versions saved before it was kept. */
  recorded?: Record<string, BugRecordedObservation>;
  recipe: BugReplayRecipeRecord;
  templateDigest: string;
  protectedInputs: BugReplayProtectedInput[];
  sharedSetup: string[];
  envFiles: BugReplayEnvFileRecord[];
  baselineTreeId: string;
  /** Runner bundle, browser and playwright-core identity; verdicts compare only within one toolchain. */
  toolchain: string;
  createdAt: string;
}

export interface BugCaseDecisionRecord {
  id: string;
  caseId: string;
  taskId: string;
  kind: BugCaseDecisionKind;
  versionId?: string;
  reason?: string;
  createdAt: string;
}

/** Replays of one recipe the person approved for a repository, until they revoke the approval. */
export interface BugReplayKeptApprovalRecord {
  id: string;
  repositoryId: string;
  /** What the person read and approved: the recipe's template, its env files and outside hosts. */
  approvalDigest: string;
  /** The commands as the person read them. */
  commands: Array<{ service: string; command: string; directory: string }>;
  /** The ignored env files replays get and the outside hosts they call. */
  envFiles: string[];
  calls: string[];
  keptAt: string;
}

export type BugReplayFileKind ='ACTION_LOG' | 'NETWORK_LOG' | 'CONSOLE_LOG' | 'SCREENSHOT' | 'RUN_FRAMES' | 'SERVICE_LOG';

export interface BugReplayFileRecord {
  id: string;
  taskId: string;
  ownerKind: 'CAPTURE' | 'RUN';
  ownerId: string;
  managedFileId: string;
  kind: BugReplayFileKind;
  mediaType: string;
  storageKey: string;
  byteCount: number;
  sha256: string;
  createdAt: string;
}

/** Core-only run fields beside the shared view of a run. */
export interface StoredBugReplayRun extends BugReplayRunRecord {
  /** Marker-owned scratch directory of the runner, removed at teardown. */
  scratchDir?: string;
  /** What each signature check showed, for comparing the two runs of a qualification. */
  signatureObserved?: Record<string, string>;
  /** Tracked files of the frozen copy that changed between the export and readiness. */
  setupChangedPaths?: string[];
  toolchain?: string;
  cleanupDebt?: string;
  /** Set on a verification attempt's candidates when its qualification is old: two passes add a control run. */
  controlDue?: boolean;
}

export const TERMINAL_RUN_STATES = new Set(['SETTLED']);

export function isTerminalRun(run: Pick<BugReplayRunRecord, 'state'>): boolean {
  return run.state === 'SETTLED';
}
