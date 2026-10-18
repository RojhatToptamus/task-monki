import type { AppDatabaseTransaction, SqlReader } from '../storage/sqlite/AppDatabase';
import type { SqliteBugReplayStore } from '../storage/sqlite/SqliteBugReplayStore';
import type { DomainEventType, Task, TaskDetailSnapshot, WorktreeRecord } from '../../shared/contracts';
import type {
  BugCaseReference,
  BugRecordingSessionView,
  BugReplayGateProjection,
  BugReplayRunFailure,
  BugReplayRunOutcome
} from '../../shared/bugReplay';
import type { StoredBugReplayRun } from './BugReplayRecords';
import type { ReplayTreeReader } from './ReplayDerivation';
import type { ReplayAuthorization } from './ReplayAuthorization';
import type { ReplayEnvironment } from './ReplayEnvironment';
import type { ReplaySourceFreezer } from './ReplaySourceFreezer';

/** What Bug Replay needs from the rest of Task Monki, supplied by TaskManagerService. */
export interface BugReplayTaskAccess {
  context(taskId: string): Promise<{ task: Task; worktree: WorktreeRecord }>;
  detail(taskId: string): Promise<TaskDetailSnapshot>;
  /** An implementation turn of the task is queued, running or waiting on the person. */
  agentRunActive(taskId: string): Promise<boolean>;
  /** Whether an implementation turn ever ran, and what the current one is doing. */
  agentState(taskId: string): Promise<BugAgentState>;
  /**
   * Hands the bug to the task's agent through the normal follow-up and queue rules. The operation
   * id becomes the instruction's id, so a repeated request finds the first one.
   */
  handOff(input: {
    taskId: string;
    text: string;
    bugCase: BugCaseReference;
    clientOperationId: string;
    attachmentDraftId?: string;
  }): Promise<{ runId?: string; instructionId?: string }>;
  /** Sends a held bug instruction instead of creating another. */
  sendHeld(input: { taskId: string; instructionId: string }): Promise<void>;
}

export interface BugAgentState {
  hasRun: boolean;
  /** RUNNING works; WAITING waits on the person; MOVING is starting or stopping. */
  turn: 'IDLE' | 'RUNNING' | 'WAITING' | 'MOVING';
}

/** The orchestration surface recording and views use, so neither depends on the service itself. */
export interface BugReplayCore {
  readonly store: SqliteBugReplayStore;
  readonly authorization: ReplayAuthorization;
  readonly access: BugReplayTaskAccess;
  readonly environment: ReplayEnvironment;
  readonly freezer: ReplaySourceFreezer;
  toolchain(): string;
  available(): { replay: boolean; record: boolean; reason?: string };
  treeReader(worktreePath: string, treeId: string): Promise<ReplayTreeReader>;
  emitUpdate(taskId: string, projectionChanged?: boolean): void;
  settleRun(run: StoredBugReplayRun, outcome: BugReplayRunOutcome, failure?: BugReplayRunFailure): Promise<void>;
  commit(
    taskId: string,
    type: DomainEventType,
    change: (tx: AppDatabaseTransaction) => void | Promise<void>,
    detail?: Record<string, unknown>
  ): Promise<BugReplayGateProjection | undefined>;
  /** The two runs of a new qualification, in the caller's transaction. */
  insertQualification(transaction: AppDatabaseTransaction, taskId: string, caseId: string, versionId: string): void;
  /** Admits queued runs that can start now. */
  schedule(): void;
  replaceActiveCase(transaction: AppDatabaseTransaction, taskId: string): Promise<void>;
  track<T>(promise: Promise<T>): Promise<T>;
  gateIn(reader: SqlReader, taskId: string): BugReplayGateProjection | undefined;
}

/** The recording sessions the orchestration service reports to. */
export interface BugRecordingSessions {
  sessionView(taskId: string): BugRecordingSessionView | undefined;
  /** Another task's recording is open, so this one cannot start. */
  busyElsewhere(taskId: string): boolean;
  leaseGranted(taskId: string, templateDigest: string): Promise<void>;
  forgetTask(taskId: string): void;
  cancelForTask(taskId: string): Promise<void>;
}
