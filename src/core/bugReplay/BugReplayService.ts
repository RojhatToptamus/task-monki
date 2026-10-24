import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PreviewRuntime } from 'previewhost';
import type { AppDatabaseTransaction, SqlReader } from '../storage/sqlite/AppDatabase';
import type { SqliteBugReplayStore } from '../storage/sqlite/SqliteBugReplayStore';
import type { SqliteTaskStore } from '../storage/SqliteTaskStore';
import type { AppEventBus } from '../runner/AppEventBus';
import type { ReviewSnapshotStore } from '../git/ReviewSnapshotStore';
import { createDomainEvent } from '../storage/domainEvent';
import type { DomainEventType, Task, WorktreeRecord } from '../../shared/contracts';
import type {
  BugCaseAction,
  BugCaseReference,
  BugExpectationsDraft,
  BugExpectationsPreview,
  BugReplayGateProjection,
  BugReplayKeptApproval,
  BugReplayLeaseRequest,
  BugReplayOutcomeReason,
  BugReplayRunFailure,
  BugReplayRunKind,
  BugReplayRunOutcome,
  BugReplayRunState,
  BugReplaySnapshot,
  BugReplayWaitReason,
  BugVerdictCurrency
} from '../../shared/bugReplay';
import { COUNTED_BUG_REPLAY_OUTCOMES } from '../../shared/bugReplay';
import type { BugCaseV1 } from '../../shared/bugCase';
import { isDomAssertion } from '../../shared/bugCase';
import type { BugCaseRecord, BugCaseVersionRecord, BugReplayFileRecord, StoredBugReplayRun } from './BugReplayRecords';
import { computeGate, effectiveVersion, latestSets, openSetNeeds, owedRuns, qualificationOf, replayTerms, verdictAttempt, verificationCovered } from './BugReplayGate';
import { evaluateRun } from './BugReplayVerdict';
import type { BugReplayRunner } from './BugReplayRunner';
import { deriveReplaySpec, ReplayEligibilityError, REPLAY_NAME_PATTERN, replayEnvironmentName } from './ReplayDerivation';
import { changedProtectedInputs, type ProtectedTree } from './ProtectedInputs';
import type { ReplayAuthorization } from './ReplayAuthorization';
import { ReplayEnvironment, ReplayEnvironmentError } from './ReplayEnvironment';
import { ReplaySourceError, ReplaySourceFreezer } from './ReplaySourceFreezer';
import { buildBugReplaySnapshot } from './BugReplayViews';
import { leaseRequestFor } from './BugReplayLease';
import {
  buildBugBrief,
  buildBugPullRequestBlock,
  buildBugReviewSection,
  findSuspiciousLines,
  oneLine,
  redactEvidence,
  type BugContextRecords
} from './BugReplayContext';
import type { BugRecordingSessions, BugReplayCore, BugReplayTaskAccess, PendingReplayApproval } from './BugReplayPorts';
import { ceilingFor, versionDigest } from './BugReplayIdentity';
import { describeRevision, EXPECTATIONS_MOVED, followedTitle, reviseBugCase } from './BugCaseRevision';

/**
 * Bug Replay's orchestration: a persisted queue of clean runs, each executed from checks to
 * teardown, with every change that moves the bug committed together with its task event. It never
 * holds the task's action lock for a run and never stops the developer's own preview.
 */

export type { BugReplayTaskAccess } from './BugReplayPorts';

export interface BugReplayServiceOptions {
  store: SqliteBugReplayStore;
  tasks: SqliteTaskStore;
  events: AppEventBus;
  runtime: () => PreviewRuntime;
  authorization: ReplayAuthorization;
  snapshots: ReviewSnapshotStore;
  /** `<previewhost root>/sources/bug-replay`. */
  exportRoot: string;
  /** Marker-owned runner scratch: `<profile>/bug-replay/runs`. */
  scratchRoot: string;
  storeId: string;
  runner: BugReplayRunner;
  access: BugReplayTaskAccess;
  toolchain: () => string;
  /** The desktop app on a supported platform; recording also needs the in-app browser. */
  available: () => { replay: boolean; record: boolean; reason?: string };
  maxConcurrentRuns?: number;
}

interface StartedContext {
  task: Task;
  worktree: WorktreeRecord;
}

class RunSettled extends Error {
  constructor(
    readonly outcome: BugReplayRunOutcome,
    readonly failure?: BugReplayRunFailure
  ) {
    super(failure?.detail ?? outcome);
  }
}

class RunWaits extends Error {
  constructor(readonly reason: BugReplayWaitReason) {
    super(reason);
  }
}

/** Settled runs of a case whose evidence files are kept, beside the qualification and the verdict's attempt. */
const RETENTION_RUNS_PER_CASE = 8;
/** Settled run records of a case that are kept; older ones go with their files and pinned trees. */
const RETENTION_RUN_ROWS_PER_CASE = 60;

/** The ref that keeps a verification attempt's tree readable until its runs are pruned. */
function attemptRef(setId: string): string {
  return `attempt-${setId}`;
}

export class BugReplayService implements BugReplayCore {
  readonly environment: ReplayEnvironment;
  readonly freezer: ReplaySourceFreezer;
  private admitting = false;
  private closed = false;
  private readonly executing = new Map<string, AbortController>();
  private readonly tracked = new Set<Promise<unknown>>();
  private pumping = false;
  private pumpAgain = false;
  private heartbeat?: NodeJS.Timeout;
  private gc?: Promise<void>;
  private recording?: BugRecordingSessions;
  /** The gate each task's last BUG_ event carried, set after commit; it only spares repeating an event. */
  private readonly lastProjection = new Map<string, string>();
  /** Answers about two trees, which never change: kept for the newest few by `remember`. */
  private readonly suspiciousCache = new Map<string, string[]>();
  private readonly sharedSetupCache = new Map<string, string[]>();
  private readonly protectedCache = new Map<string, string[]>();
  /** The approval digest each waiting run last derived. */
  private readonly derivedDigests = new Map<string, string>();

  constructor(private readonly options: BugReplayServiceOptions) {
    this.environment = new ReplayEnvironment(options.runtime, options.authorization);
    this.freezer = new ReplaySourceFreezer(options.snapshots, options.exportRoot, options.storeId);
  }

  attachRecording(recording: BugRecordingSessions): void {
    this.recording = recording;
  }

  get store(): SqliteBugReplayStore {
    return this.options.store;
  }

  get authorization(): ReplayAuthorization {
    return this.options.authorization;
  }

  get access(): BugReplayTaskAccess {
    return this.options.access;
  }

  toolchain(): string {
    return this.options.toolchain();
  }

  available(): { replay: boolean; record: boolean; reason?: string } {
    return this.options.available();
  }

  /**
   * Startup: runs a crash left mid-flight are settled as interrupted (never resumed), queued work
   * waits for approval again (given now, or kept for the task's repository), exports and scratch
   * nobody owns are swept, and every `br-` name is torn down in the background before new runs are
   * admitted.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.options.exportRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
    const open = await this.options.store.read((reader) => this.options.store.listRuns(reader, { open: true }));
    const touched = new Set<string>();
    for (const run of open) {
      touched.add(run.taskId);
      if (run.kind === 'RECORD') {
        await this.settleRun(run, 'DISCARDED', { reason: 'SHUTDOWN', detail: 'Recording ended when Task Monki closed.' }, {}, { quiet: true });
        const context = await this.options.access.context(run.taskId).catch(() => undefined);
        if (context) await this.freezer.release(context.worktree.worktreePath, run.taskId, `record-${run.id}`).catch(() => undefined);
      } else if (['QUEUED', 'CHECKING', 'WAITING'].includes(run.state)) {
        await this.updateRun(run, { state: 'WAITING', waitingFor: 'APPROVAL' }, 'BUG_REPLAY_RUN_UPDATED', { quiet: true });
      } else {
        await this.settleRun(run, 'INTERRUPTED', { reason: 'SHUTDOWN', detail: 'Task Monki closed during this run.' }, {}, { quiet: true });
      }
    }
    const liveRuns = new Set((await this.options.store.read((reader) => this.options.store.listRuns(reader, { open: true }))).map((run) => run.id));
    await this.freezer.sweep(liveRuns).catch(() => undefined);
    await this.sweepScratch(liveRuns);
    // Runs a restart cut short are run again, and a version saved without its qualification gets
    // one, for every bug, so the code they were about is still checked.
    const activeTasks = await this.options.store.read((reader) => this.options.store.tasksWithActiveCases(reader));
    for (const taskId of new Set([...touched, ...activeTasks])) await this.refillOpenSets(taskId).catch(() => undefined);
    for (const taskId of activeTasks) {
      await this.publishGate(taskId, 'BUG_REPLAY_RUN_UPDATED', {}, { onlyIfChanged: true }).catch(() => undefined);
    }
    this.admitting = true;
    this.gc = this.collectEnvironments().finally(() => {
      this.gc = undefined;
      this.schedule();
    });
    this.track(this.gc);
    this.heartbeat = setInterval(() => this.schedule(), 15_000);
    this.heartbeat.unref?.();
  }

  /** Closes admission at once; in-flight runs are cancelled and their environments torn down. */
  beginShutdown(): void {
    this.admitting = false;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const controller of this.executing.values()) controller.abort();
    this.options.authorization.clear();
  }

  async drain(timeoutMs = 30_000): Promise<void> {
    await Promise.race([Promise.allSettled([...this.tracked]), sleep(timeoutMs)]);
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.tracked.add(promise);
    void promise.finally(() => this.tracked.delete(promise)).catch(() => undefined);
    return promise;
  }

  // Public API used by TaskManagerService

  async snapshot(taskId: string): Promise<BugReplaySnapshot> {
    const snapshot = await buildBugReplaySnapshot(this, taskId, this.recording?.sessionView(taskId), this.recording?.busyElsewhere(taskId) ?? false);
    const view = snapshot.activeCase;
    if (view?.gate.activeRun?.waitingFor === 'APPROVAL') {
      const lease = await this.pendingLease(taskId);
      if (lease) snapshot.pendingLease = lease;
      else {
        // Approving names exactly what the sheet states; without one there is nothing to approve.
        const unavailable = { ...view.unavailable };
        for (const action of ['allow-runs', 'always-allow-runs'] as const) if (view.actions.includes(action)) unavailable[action] = "Couldn't read what the replays run";
        if (Object.keys(unavailable).length) view.unavailable = unavailable;
      }
    }
    return snapshot;
  }

  /** The lease sheet for a clean run waiting on the person's permission, from that run's own spec. */
  async pendingLease(taskId: string): Promise<BugReplayLeaseRequest | undefined> {
    return (await this.pendingRunApproval(taskId))?.request;
  }

  private async pendingRunApproval(taskId: string): Promise<PendingReplayApproval | undefined> {
    const waiting = (await this.options.store.read((reader) => this.options.store.listRuns(reader, { taskId, open: true })))
      .find((run) => run.state === 'WAITING' && run.waitingFor === 'APPROVAL');
    if (!waiting) return undefined;
    const records = await this.loadRunRecords(waiting);
    if (!records) return undefined;
    try {
      const context = await this.options.access.context(taskId);
      const tree = waiting.kind === 'CANDIDATE' ? waiting.inputTreeId! : records.version.baselineTreeId;
      const derived = await this.derive(waiting, records.version, context.worktree.worktreePath, tree, '/<export>');
      const envFiles = records.version.envFiles.map((file) => file.relativePath);
      return { request: leaseRequestFor(derived, envFiles, false), envFiles, calls: derived.outsideHosts };
    } catch {
      return undefined;
    }
  }

  /** The person approved what the task asks to run: for now, or kept for its repository. */
  async allowRuns(taskId: string, approvalDigest: string, keep = false): Promise<void> {
    const keptId = keep ? await this.keepApproval(taskId, approvalDigest) : undefined;
    this.options.authorization.grant(taskId, approvalDigest, keptId);
    await this.recording?.leaseGranted(taskId, approvalDigest);
    this.schedule();
  }

  /**
   * Keeps only what the task asks to approve right now, as its sheet states it: a digest from
   * anywhere else, or a request that changed since the person read it, keeps nothing.
   */
  private async keepApproval(taskId: string, approvalDigest: string): Promise<string> {
    const recordingAsks = this.recording?.pendingApproval(taskId);
    const asked = recordingAsks?.request.approvalDigest === approvalDigest ? recordingAsks : await this.pendingRunApproval(taskId);
    if (asked?.request.approvalDigest !== approvalDigest) throw new Error('What replays run has changed. Read it again.');
    const { task } = await this.options.access.context(taskId);
    const { approval, released } = await this.options.store.write((tx) => this.options.store.keepApproval(tx, {
      id: randomUUID(),
      repositoryId: task.repositoryId,
      approvalDigest,
      commands: asked.request.commands.slice(0, 20).map((command) => ({ ...command, command: command.command.slice(0, 500) })),
      envFiles: asked.envFiles.slice(0, 12),
      calls: asked.calls.slice(0, 10),
      keptAt: now()
    }));
    for (const id of released) this.options.authorization.revokeKept(id);
    return approval.id;
  }

  /**
   * Whether replays of this recipe may start for the task: approved for now, or kept for its
   * repository, which then covers the task until the person revokes it.
   */
  async approved(taskId: string, approvalDigest: string): Promise<boolean> {
    if (this.options.authorization.covers(taskId, approvalDigest)) return true;
    const { task } = await this.options.access.context(taskId);
    const kept = await this.options.store.read((reader) => this.options.store.keptApproval(reader, task.repositoryId, approvalDigest));
    if (!kept) return false;
    this.options.authorization.grant(taskId, approvalDigest, kept.id);
    return this.options.authorization.covers(taskId, approvalDigest);
  }

  /** The approvals the person kept, newest first, with their repository's name. */
  async keptApprovals(): Promise<BugReplayKeptApproval[]> {
    const records = await this.options.store.read((reader) => this.options.store.listKeptApprovals(reader));
    const names = new Map<string, string>();
    for (const record of records) {
      if (!names.has(record.repositoryId)) names.set(record.repositoryId, (await this.options.tasks.getRepository(record.repositoryId))?.name ?? '');
    }
    return records.map((record) => ({
      id: record.id,
      repositoryId: record.repositoryId,
      repositoryName: names.get(record.repositoryId) ?? '',
      commands: record.commands,
      envFiles: record.envFiles,
      calls: record.calls,
      keptAt: record.keptAt
    }));
  }

  /** Revokes a kept approval: the leases it stood for end now, so the next replay of its recipe asks. */
  async revokeApproval(approvalId: string): Promise<void> {
    await this.options.store.write((tx) => this.options.store.revokeApproval(tx, approvalId));
    this.options.authorization.revokeKept(approvalId);
  }

  /** Queues the two runs of a qualification for a version. */
  async queueQualification(taskId: string, caseId: string, versionId: string): Promise<void> {
    await this.commit(taskId, 'BUG_REPLAY_RUN_UPDATED', (tx) => this.insertQualification(tx, taskId, caseId, versionId));
    this.schedule();
  }

  /** The two runs of a new qualification, in the caller's transaction: a saved version always has them. */
  insertQualification(tx: AppDatabaseTransaction, taskId: string, caseId: string, versionId: string): void {
    const setId = randomUUID();
    for (let index = 0; index < 2; index += 1) this.options.store.insertRun(tx, this.newRun(taskId, 'BASELINE', { caseId, versionId, setId }));
  }

  async runAgain(taskId: string): Promise<void> {
    const { bugCase, version } = await this.requireActiveVersion(taskId);
    await this.queueQualification(taskId, bugCase.id, version.id);
  }

  /** Verify again: a new attempt for the worktree as it is now. */
  async verifyAgain(taskId: string): Promise<void> {
    const { bugCase, version } = await this.requireActiveVersion(taskId);
    const context = await this.options.access.context(taskId);
    const setId = randomUUID();
    const { treeId } = await this.freezer.capture(context.worktree.worktreePath, taskId, attemptRef(setId));
    // Clean runs of the recorded code can only show the recorded failure again.
    if (treeId === version.baselineTreeId) {
      await this.freezer.release(context.worktree.worktreePath, taskId, attemptRef(setId)).catch(() => undefined);
      throw new Error('No changes since the recording.');
    }
    // The worktree was just read, so a verdict for this tree is about the current code.
    await this.queueAttempt(taskId, bugCase, version, treeId, setId, undefined, true);
  }

  /**
   * After an implementation turn completes, a verification is owed for its tree unless one
   * already covers it. Called after post-run evidence, so the worktree is the turn's result.
   */
  async onAgentTurnCompleted(taskId: string, agentRunId: string): Promise<void> {
    if (!this.admitting && !this.closed) return;
    await this.refreshHandoff(taskId);
    const active = await this.options.store.read((reader) => this.options.store.activeCase(reader, taskId));
    if (!active) return;
    const { versions, decisions, runs } = await this.caseRecords(active.id);
    const version = effectiveVersion(versions, decisions);
    if (!version) return;
    let context: StartedContext;
    try {
      context = await this.options.access.context(taskId);
    } catch {
      return;
    }
    const worktreePath = context.worktree.worktreePath;
    const setId = randomUUID();
    let treeId: string;
    try {
      ({ treeId } = await this.freezer.capture(worktreePath, taskId, attemptRef(setId)));
    } catch (error) {
      // The turn's result cannot be read, so no earlier verdict is about the code it left.
      await this.recordObservedIssue(taskId, active.id, errorMessage(error));
      return;
    }
    const gate = await this.options.store.read((reader) => this.gateIn(reader, taskId));
    // A bug that did not reproduce has nothing to verify against; code already verified needs no runs.
    const owed = treeId !== version.baselineTreeId &&
      Boolean(gate) && !['NOT_REPRODUCED', 'FLAKY', 'REPRODUCTION_BLOCKED', 'CAPTURED'].includes(gate!.state) &&
      !verificationCovered(runs, version.id, treeId, replayTerms(this.toolchain(), active.keepBrowserStorage, version.document));
    if (owed) {
      await this.queueAttempt(taskId, active, version, treeId, setId, agentRunId, false);
      return;
    }
    await this.freezer.release(worktreePath, taskId, attemptRef(setId)).catch(() => undefined);
    await this.recordObservedTree(taskId, active.id, treeId);
  }

  /** Re-reads the instruction or run carrying the bug and projects whether the agent is fixing it. */
  async refreshHandoff(taskId: string): Promise<void> {
    const active = await this.options.store.read((reader) => this.options.store.activeCase(reader, taskId));
    if (!active?.handoff) return;
    const detail = await this.options.access.detail(taskId).catch(() => undefined);
    if (!detail) return;
    const handoff = active.handoff;
    let status: 'QUEUED' | 'RUNNING' | 'HELD' | undefined;
    let runId = handoff.runId;
    if (handoff.instructionId) {
      const instruction = detail.taskInstructions.find((candidate) => candidate.id === handoff.instructionId);
      if (instruction) {
        if (instruction.status === 'HELD') status = 'HELD';
        else if (instruction.status === 'QUEUED' || instruction.status === 'SENDING') status = 'QUEUED';
        else if (instruction.runId) runId = instruction.runId;
      }
    }
    if (!status && runId) {
      const run = detail.runs.find((candidate) => candidate.id === runId);
      if (run && ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING'].includes(run.status)) status = 'RUNNING';
    }
    const next = status ? { ...handoff, status, ...(runId ? { runId } : {}) } : undefined;
    if (JSON.stringify(next) === JSON.stringify(handoff)) return;
    await this.commit(taskId, 'BUG_HANDOFF_CHANGED', (tx) => {
      const current = this.options.store.getCase(tx, active.id);
      if (!current) return;
      const updated: BugCaseRecord = { ...current, updatedAt: now() };
      if (next) updated.handoff = next;
      else delete updated.handoff;
      this.options.store.updateCase(tx, updated, current.revision);
    }, { handoff: next?.status ?? 'ENDED' });
  }

  async sendToAgent(taskId: string, clientOperationId: string, attachmentDraftId?: string): Promise<void> {
    const active = await this.requireActiveCase(taskId);
    if (active.handoff && (active.handoff.status === 'QUEUED' || active.handoff.status === 'RUNNING')) {
      throw new Error('The agent already has this bug.');
    }
    if (active.handoff?.status === 'HELD' && active.handoff.instructionId) {
      await this.options.access.sendHeld({ taskId, instructionId: active.handoff.instructionId });
      await this.refreshHandoff(taskId);
      return;
    }
    const { versions, decisions } = await this.caseRecords(active.id);
    const version = effectiveVersion(versions, decisions);
    const reference: BugCaseReference = { caseId: active.id, captureId: active.captureId, ...(version ? { versionId: version.id } : {}) };
    const sent = await this.options.access.handOff({
      taskId,
      // The person's queued words carry no page text: the brief holds the bug, as data.
      text: 'Fix the recorded bug.',
      bugCase: reference,
      clientOperationId,
      ...(attachmentDraftId ? { attachmentDraftId } : {})
    });
    await this.recordHandoff(taskId, active.id, sent);
  }

  /** The bug the first implementation turn starts with, when the task has one. */
  async activeReference(taskId: string): Promise<BugCaseReference | undefined> {
    const active = await this.options.store.read((reader) => this.options.store.activeCase(reader, taskId));
    if (!active) return undefined;
    const { versions, decisions } = await this.caseRecords(active.id);
    const version = effectiveVersion(versions, decisions);
    return { caseId: active.id, captureId: active.captureId, ...(version ? { versionId: version.id } : {}) };
  }

  /** The agent has the bug: a run working on it, or an instruction queued behind the current turn. */
  async recordHandoff(taskId: string, caseId: string, sent: { runId?: string; instructionId?: string }): Promise<void> {
    const handoffId = sent.instructionId ?? sent.runId ?? randomUUID();
    await this.commit(taskId, 'BUG_HANDOFF_CHANGED', (tx) => {
      const current = this.options.store.getCase(tx, caseId);
      if (!current) return;
      this.options.store.updateCase(tx, {
        ...current,
        handoff: {
          handoffId,
          ...(sent.runId ? { runId: sent.runId } : {}),
          ...(sent.instructionId ? { instructionId: sent.instructionId } : {}),
          status: sent.instructionId ? 'QUEUED' : 'RUNNING',
          since: now()
        },
        lastSentAt: now(),
        updatedAt: now()
      }, current.revision);
    }, { handoff: 'SENT' });
    await this.refreshHandoff(taskId);
  }

  /** Cancel stops the run's whole set: one run of a pair decides nothing on its own. */
  async cancelRun(taskId: string, runId: string): Promise<void> {
    const run = await this.options.store.read((reader) => this.options.store.getRun(reader, runId));
    if (!run || run.taskId !== taskId) throw new Error('This clean run no longer exists.');
    const members = run.setId
      ? await this.options.store.read((reader) => this.options.store.listRuns(reader, { setId: run.setId, open: true }))
      : run.state === 'SETTLED' ? [] : [run];
    await this.cancelWaiting(taskId, this.stopExecuting(members, () => new CancelledByPerson()), 'Canceled');
  }

  private async cancelWaiting(taskId: string, runs: StoredBugReplayRun[], detail: string): Promise<void> {
    if (runs.length === 0) return;
    const write = (tx: AppDatabaseTransaction) => {
      for (const run of runs) this.settleIn(tx, run.id, 'CANCELED', { reason: 'CANCELED_BY_PERSON', detail });
    };
    if (runs.some((run) => run.caseId)) {
      await this.commit(taskId, 'BUG_REPLAY_RUN_SETTLED', write, { runIds: runs.map((run) => run.id), outcome: 'CANCELED' });
    } else {
      await this.options.store.write(write);
      this.emitUpdate(taskId);
    }
  }

  async applyAction(taskId: string, action: BugCaseAction): Promise<void> {
    switch (action) {
      case 'verify-again':
        return this.verifyAgain(taskId);
      case 'run-again':
        return this.runAgain(taskId);
      case 'keep-browser-storage':
        return this.toggleBrowserStorage(taskId);
      case 'use-new-env-files':
        return this.adoptEnvFiles(taskId);
      case 'save-without-check':
        return this.withdrawCheck(taskId);
      case 'remove':
        return this.removeBug(taskId);
      default:
        throw new Error('This action is not available for the bug now.');
    }
  }

  /** What saving the editor's draft would do, judged against the recording and nothing saved. */
  async previewExpectations(taskId: string, draft: BugExpectationsDraft): Promise<BugExpectationsPreview> {
    const { version } = await this.requireActiveVersion(taskId);
    if (version.id !== draft.versionId) return { versionId: version.id, changed: true, reproducible: false, reason: EXPECTATIONS_MOVED, checks: [] };
    const revised = reviseBugCase(version, draft.expectations);
    return {
      versionId: version.id,
      changed: revised.changed,
      reproducible: revised.reproducible,
      ...(revised.reason ? { reason: revised.reason } : {}),
      checks: revised.checks
    };
  }

  /**
   * The person changed what "fixed" means. The next version holds the changed expectations and
   * reproduces the bug on the recorded code before any fix counts against them, and the code the
   * worktree holds is verified again after that. Results about the version it replaces stay as
   * earlier context; its open runs stop.
   */
  async reviseExpectations(taskId: string, draft: BugExpectationsDraft): Promise<void> {
    const { bugCase, version } = await this.requireActiveVersion(taskId);
    if (version.id !== draft.versionId) throw new Error(`${EXPECTATIONS_MOVED}.`);
    const revised = reviseBugCase(version, draft.expectations);
    if (!revised.changed) return;
    if (!revised.reproducible) throw new Error(`${revised.reason ?? 'These expectations cannot be reproduced'}.`);
    const next: BugCaseVersionRecord = {
      ...version,
      id: randomUUID(),
      version: version.version + 1,
      revisionKind: 'EXPECTATION_CHANGED',
      reason: describeRevision(version.document, revised.document),
      document: revised.document,
      recorded: revised.recorded,
      createdAt: now()
    };
    next.digest = versionDigest(next);
    const title = followedTitle(bugCase.title, version, next);
    await this.commit(taskId, 'BUG_CASE_DECIDED', (tx) => {
      // Saving approves the expectations the editor showed; a version saved meanwhile refuses it.
      const current = effectiveVersion(this.options.store.listVersions(tx, bugCase.id), this.options.store.listDecisions(tx, bugCase.id));
      if (current?.id !== version.id) throw new Error(`${EXPECTATIONS_MOVED}.`);
      this.options.store.insertVersion(tx, next);
      this.options.store.insertDecision(tx, { id: randomUUID(), caseId: bugCase.id, taskId, kind: 'APPROVED', versionId: next.id, ...(next.reason ? { reason: next.reason } : {}), createdAt: now() });
      this.options.store.insertDecision(tx, { id: randomUUID(), caseId: bugCase.id, taskId, kind: 'SUPERSEDED', versionId: version.id, createdAt: now() });
      // The changed expectations are reproduced again before a fix can be verified against them.
      this.insertQualification(tx, taskId, bugCase.id, next.id);
      const latest = title ? this.options.store.getCase(tx, bugCase.id) : undefined;
      if (latest && title) this.options.store.updateCase(tx, { ...latest, title, updatedAt: now() }, latest.revision);
    }, { decision: 'APPROVED', revision: 'EXPECTATION_CHANGED', ...(next.reason ? { change: next.reason } : {}) });
    await this.supersedeRuns(bugCase.id, version.id);
    this.schedule();
    await this.reverifyCurrentCode(taskId, bugCase, next);
  }

  /** Stops the open runs of a version that no longer decides anything: they checked other expectations. */
  private async supersedeRuns(caseId: string, versionId: string): Promise<void> {
    const open = await this.options.store.read((reader) => this.options.store.listRuns(reader, { caseId, open: true }));
    for (const run of open.filter((candidate) => candidate.versionId === versionId)) {
      const controller = this.executing.get(run.id);
      if (controller) controller.abort(new ExpectationsChanged());
      else await this.settleRun(run, 'SUPERSEDED', EXPECTATIONS_CHANGED);
    }
  }

  async removeBug(taskId: string): Promise<void> {
    const active = await this.requireActiveCase(taskId);
    await this.cancelCaseRuns(taskId, active.id, 'Bug removed');
    await this.commit(taskId, 'BUG_CASE_DECIDED', (tx) => {
      const current = this.options.store.getCase(tx, active.id);
      if (!current) return;
      this.options.store.updateCase(tx, { ...current, status: 'REMOVED', updatedAt: now() }, current.revision);
      this.options.store.insertDecision(tx, { id: randomUUID(), caseId: active.id, taskId, kind: 'REMOVED', createdAt: now() });
    }, { decision: 'REMOVED' });
  }

  /** Replace: the active bug becomes an earlier bug; a new recording becomes the active one. */
  async replaceActiveCase(transaction: AppDatabaseTransaction, taskId: string): Promise<void> {
    const active = this.options.store.activeCase(transaction, taskId);
    if (!active) return;
    this.options.store.updateCase(transaction, { ...active, status: 'REPLACED', updatedAt: now() }, active.revision);
    this.options.store.insertDecision(transaction, { id: randomUUID(), caseId: active.id, taskId, kind: 'REPLACED', createdAt: now() });
  }

  async deleteEvidence(taskId: string, caseId: string): Promise<void> {
    await this.options.store.write((tx) => {
      const bugCase = this.options.store.getCase(tx, caseId);
      if (!bugCase || bugCase.taskId !== taskId) throw new Error('This bug no longer exists.');
      if (bugCase.status === 'ACTIVE') throw new Error('Remove the bug before deleting its evidence.');
      const runs = this.options.store.listRuns(tx, { caseId });
      const files = [
        ...this.options.store.filesFor(tx, 'CAPTURE', bugCase.captureId),
        ...runs.flatMap((run) => this.options.store.filesFor(tx, 'RUN', run.id))
      ];
      this.options.store.deleteFiles(tx, files);
    });
    this.emitUpdate(taskId);
  }

  async readImage(taskId: string, fileId: string): Promise<Buffer> {
    const file = await this.options.store.read((reader) => this.options.store.getFile(reader, fileId));
    if (!file || file.taskId !== taskId || file.kind !== 'SCREENSHOT') throw new Error('This screenshot is no longer available.');
    return this.options.store.readFile(file);
  }

  /**
   * Compares the worktree with the verdict's tree. A bounded recapture catches edits no Git action
   * observed; a difference marks the verdict out of date on every surface. Showing a verdict waits
   * briefly; Mark done waits for the answer.
   */
  async checkCurrency(taskId: string, waitMs = 4_000): Promise<BugVerdictCurrency> {
    const active = await this.options.store.read((reader) => this.options.store.activeCase(reader, taskId));
    if (!active) return { state: 'NONE' };
    const gate = (await this.options.tasks.getTask(taskId))?.projection.bugReplay;
    const verdictTree = gate?.verdictTreeId;
    // A worktree that could not be read is read again, so removing what blocked it is enough.
    if (!verdictTree || !gate || (!active.observedTreeIssue && !['FIX_VERIFIED', 'STILL_FAILING', 'STALE'].includes(gate.state))) return { state: 'NONE' };
    let context: StartedContext;
    try {
      context = await this.options.access.context(taskId);
    } catch {
      return { state: 'UNKNOWN' };
    }
    const capture = this.freezer.capture(context.worktree.worktreePath, taskId, 'currency').then(
      (result) => result.treeId,
      async (error: unknown) => {
        // Files that can never be copied leave no verdict about the code; files that kept
        // changing while they were read are only checked again.
        if (error instanceof ReplaySourceError && error.code === 'OMITTED_FILES') await this.recordObservedIssue(taskId, active.id, error.message).catch(() => undefined);
        return undefined;
      }
    );
    const treeId = await within(capture, waitMs);
    if (!treeId) return { state: 'UNKNOWN' };
    await this.recordObservedTree(taskId, active.id, treeId);
    return { state: treeId === verdictTree ? 'CURRENT' : 'STALE', treeId };
  }

  /** The stored records the brief, the reviewer section and the pull request block are built from. */
  async contextRecords(taskId: string, caseId?: string): Promise<BugContextRecords | undefined> {
    return this.options.store.read((reader) => {
      const bugCase = caseId ? this.options.store.getCase(reader, caseId) : this.options.store.activeCase(reader, taskId);
      if (!bugCase || bugCase.taskId !== taskId || bugCase.status !== 'ACTIVE') return undefined;
      const capture = this.options.store.getCapture(reader, bugCase.captureId);
      const gate = this.gateIn(reader, taskId);
      if (!capture || !gate) return undefined;
      const version = effectiveVersion(this.options.store.listVersions(reader, bugCase.id), this.options.store.listDecisions(reader, bugCase.id));
      return { bugCase, capture, gate, runs: this.options.store.listRuns(reader, { caseId: bugCase.id }), ...(version ? { version } : {}) };
    });
  }

  /** The brief for a turn that carries the bug, from the case as it is now. */
  async brief(taskId: string, reference: BugCaseReference): Promise<string | undefined> {
    const records = await this.contextRecords(taskId, reference.caseId);
    if (records) return buildBugBrief(records);
    const ended = await this.options.store.read((reader) => this.options.store.getCase(reader, reference.caseId));
    if (!ended || ended.taskId !== taskId) return undefined;
    return `Recorded bug\nThe person removed or replaced the bug "${oneLine(ended.title).slice(0, 120)}" after sending it. Task Monki will not verify this fix.`;
  }

  /**
   * The reviewer's section. The reviewed tree is the worktree as the review reads it, so it also
   * tells every surface whether the verdict is about this code.
   */
  async reviewSection(taskId: string, reviewedTreeId: string | undefined): Promise<string | undefined> {
    const active = await this.options.store.read((reader) => this.options.store.activeCase(reader, taskId));
    if (!active) return undefined;
    if (reviewedTreeId) await this.recordObservedTree(taskId, active.id, reviewedTreeId).catch(() => undefined);
    const records = await this.contextRecords(taskId);
    if (!records) return undefined;
    const suspicious = await this.suspiciousAdditions(taskId, records, reviewedTreeId ?? records.gate.verdictTreeId).catch(() => []);
    return buildBugReviewSection(records, { ...(reviewedTreeId ? { reviewedTreeId } : {}), suspicious });
  }

  /** The pull request block, after comparing the worktree with the verdict. */
  async pullRequestBlock(taskId: string, headTreeId: string | undefined): Promise<string | undefined> {
    await this.checkCurrency(taskId).catch(() => undefined);
    const records = await this.contextRecords(taskId);
    return records ? buildBugPullRequestBlock(records, headTreeId) : undefined;
  }

  /** Added lines since the recorded code that mention a checked value or the replay environment. */
  async suspiciousAdditions(taskId: string, records: BugContextRecords, toTree: string | undefined): Promise<string[]> {
    const version = records.version;
    if (!version || !toTree || toTree === version.baselineTreeId) return [];
    const key = `${version.id}:${toTree}`;
    const cached = this.suspiciousCache.get(key);
    if (cached) return cached;
    const context = await this.options.access.context(taskId);
    const lines = await this.options.snapshots.addedLines(context.worktree.worktreePath, version.baselineTreeId, toTree);
    return remember(this.suspiciousCache, key, findSuspiciousLines(lines, version.document));
  }

  /** Shared setup files whose content differs between the recorded code and `treeId`. */
  async changedSharedSetup(taskId: string, version: BugCaseVersionRecord, treeId: string): Promise<string[]> {
    const key = `${version.id}:${treeId}`;
    const cached = this.sharedSetupCache.get(key);
    if (cached) return cached;
    const context = await this.options.access.context(taskId);
    const paths = version.sharedSetup.slice(0, 50);
    const [before, after] = await Promise.all(
      [version.baselineTreeId, treeId].map((tree) => this.options.snapshots.entriesAt(context.worktree.worktreePath, tree, paths))
    );
    return remember(this.sharedSetupCache, key, paths.filter((file) => before.get(file)?.blob !== after.get(file)?.blob).slice(0, 10));
  }

  /** Stops recording and runs of a task before it is deleted or archived; waits for teardown. */
  async stopTask(taskId: string, timeoutMs = 60_000): Promise<void> {
    await this.recording?.cancelForTask(taskId);
    const open = await this.options.store.read((reader) => this.options.store.listRuns(reader, { taskId, open: true }));
    for (const run of open) {
      const controller = this.executing.get(run.id);
      if (controller) controller.abort(new CancelledByPerson());
      else if (run.kind !== 'RECORD') await this.settleRun(run, 'CANCELED', { reason: 'CANCELED_BY_PERSON', detail: 'Canceled' });
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && [...this.executing.keys()].some((id) => open.some((run) => run.id === id))) await sleep(200);
    this.lastProjection.delete(taskId);
  }

  // Queue and execution

  schedule(): void {
    if (!this.admitting || this.gc) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void this.pump()
      .catch(() => undefined)
      .finally(() => {
        this.pumping = false;
        if (this.pumpAgain) {
          this.pumpAgain = false;
          this.schedule();
        }
      });
  }

  private async pump(): Promise<void> {
    const limit = this.options.maxConcurrentRuns ?? 2;
    const open = (await this.options.store.read((reader) => this.options.store.listRuns(reader, { open: true })))
      .filter((run) => run.kind !== 'RECORD' && !this.executing.has(run.id) && (run.state === 'QUEUED' || run.state === 'WAITING'))
      .sort(queueOrder);
    for (const run of open) {
      if (!this.admitting || this.executing.size >= limit) return;
      const decision = await this.admission(run).catch((error: unknown) => {
        if (error instanceof RunSettled) return error;
        return new RunSettled('ENVIRONMENT_FAILED', { reason: 'START_FAILED', detail: errorMessage(error) });
      });
      // Closing began while this run was checked: the next start checks it again.
      if (!this.admitting) return;
      if (decision instanceof RunSettled) {
        await this.settleRun(run, decision.outcome, decision.failure);
        continue;
      }
      if (decision !== 'START') {
        if (run.state !== 'WAITING' || run.waitingFor !== decision) {
          await this.updateRun(run, { state: 'WAITING', waitingFor: decision }, 'BUG_REPLAY_RUN_UPDATED');
        }
        continue;
      }
      const controller = new AbortController();
      this.executing.set(run.id, controller);
      const work = this.execute(run, controller).finally(() => {
        this.executing.delete(run.id);
        this.schedule();
      });
      this.track(work);
    }
  }

  /**
   * The checks a queued run passes before anything starts. Outcomes that need no environment
   * (changed setup inputs, changed env files, missing baseline code) settle here and never ask
   * for approval; everything else either starts or names what it waits for.
   */
  private async admission(run: StoredBugReplayRun): Promise<'START' | BugReplayWaitReason> {
    const records = await this.loadRunRecords(run);
    if (!records) throw new RunSettled('CANCELED', { reason: 'CANCELED_BY_PERSON', detail: 'The bug was removed.' });
    const { version } = records;
    // A run of a version the person replaced checks expectations that no longer decide anything.
    if (records.superseded) throw new RunSettled('SUPERSEDED', { reason: 'CANCELED_BY_PERSON', detail: 'A newer version of the bug replaced it' });
    const context = await this.options.access.context(run.taskId).catch((error: unknown) => {
      throw new RunSettled('BLOCKED', { reason: 'INELIGIBLE', detail: errorMessage(error) });
    });
    if (['DONE', 'CANCELED', 'ARCHIVED'].includes(context.task.workflowPhase)) {
      throw new RunSettled('CANCELED', { reason: 'CANCELED_BY_PERSON', detail: 'The task is closed.' });
    }
    // Until the person allows runs, the full checks below would only repeat every heartbeat.
    if (run.state === 'WAITING' && run.waitingFor === 'APPROVAL' && !(await this.mayBeApproved(run, context.task.repositoryId))) return 'APPROVAL';
    const worktreePath = context.worktree.worktreePath;
    const tree = run.kind === 'CANDIDATE' ? run.inputTreeId! : version.baselineTreeId;
    if (!(await this.freezer.available(worktreePath, tree))) {
      throw new RunSettled('BLOCKED', {
        reason: 'BASELINE_UNAVAILABLE',
        detail: run.kind === 'CANDIDATE' ? 'The code to verify is no longer available. Verify again.' : 'The code where the bug was recorded is no longer available. Record again.'
      });
    }
    for (const file of version.envFiles) {
      const bytes = await fs.readFile(path.join(worktreePath, file.relativePath)).catch(() => undefined);
      if (!bytes || sha256(bytes) !== file.sha256) {
        throw new RunSettled('ENV_FILES_CHANGED', {
          reason: 'INELIGIBLE',
          detail: run.kind === 'CANDIDATE'
            ? `Couldn't verify: ${file.relativePath} changed since the bug was recorded`
            : `Reproduction blocked: ${file.relativePath} changed since the bug was recorded`,
          paths: [file.relativePath]
        });
      }
    }
    if (run.kind === 'CANDIDATE') {
      // The cheap waits first: a run that waits repeats these every heartbeat.
      if (await this.options.access.agentRunActive(run.taskId)) return 'AGENT_TURN';
      const qualification = await this.qualificationFor(run, records.bugCase, version);
      if (qualification === 'FAILED') {
        throw new RunSettled('BLOCKED', { reason: 'NOT_REPRODUCED', detail: "Couldn't verify: the bug did not reproduce on the recorded code" });
      }
      if (qualification === 'PENDING') return 'QUALIFICATION';
      const changed = await this.changedProtected(version, worktreePath, tree);
      if (changed.length > 0) {
        throw new RunSettled('PROTECTED_INPUT_CHANGED', {
          reason: 'INELIGIBLE',
          detail: `Couldn't verify: setup files changed since the recording (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''})`,
          paths: changed.slice(0, 10)
        });
      }
    }
    const derived = await this.derive(run, version, worktreePath, tree, '/<export>');
    remember(this.derivedDigests, run.id, derived.approvalDigest);
    if (!(await this.approved(run.taskId, derived.approvalDigest))) return 'APPROVAL';
    if ((derived.managedDatabases.length > 0 || derived.secretIds.length > 0) && (await this.options.runtime().keystore.status()).state !== 'unlocked') {
      return 'KEYSTORE';
    }
    const capacity = await this.environment.capacity(Object.keys((derived.spec as { services?: object }).services ?? {}).length);
    if (!capacity.ok) return 'CAPACITY';
    return 'START';
  }

  /**
   * Whether a run waiting for approval could be approved now, short of its full checks: the task
   * holds a lease, or the repository kept an approval for the digest the run last derived (any
   * kept approval, when it has derived none since Task Monki started).
   */
  private async mayBeApproved(run: StoredBugReplayRun, repositoryId: string): Promise<boolean> {
    if (this.options.authorization.hasLease(run.taskId)) return true;
    const digest = this.derivedDigests.get(run.id);
    return this.options.store.read((reader) =>
      digest ? Boolean(this.options.store.keptApproval(reader, repositoryId, digest)) : this.options.store.hasKeptApprovals(reader, repositoryId)
    );
  }

  /** The version's pinned setup inputs that differ in `tree`; neither ever changes, so it is remembered. */
  private async changedProtected(version: BugCaseVersionRecord, worktreePath: string, tree: string): Promise<string[]> {
    const key = `${version.id}:${tree}`;
    const cached = this.protectedCache.get(key);
    if (cached) return cached;
    return remember(this.protectedCache, key, await changedProtectedInputs(version.protectedInputs, await this.treeReader(worktreePath, tree)));
  }

  /**
   * Whether a candidate's version is reproduced under the current terms, by the gate's own
   * rules: a qualification that still runs or still owes a replacement is pending, never failed.
   */
  private async qualificationFor(run: StoredBugReplayRun, bugCase: BugCaseRecord, version: BugCaseVersionRecord): Promise<'OK' | 'PENDING' | 'FAILED'> {
    const runs = await this.options.store.read((reader) => this.options.store.listRuns(reader, { caseId: version.caseId }));
    const qualification = latestSets(runs, version.id).qualification ?? [];
    if (qualification.length === 0) {
      // The one rule for what a version owes queues it, so it is never queued twice.
      await this.refillOpenSets(run.taskId);
      return 'PENDING';
    }
    if (qualification.some((member) => member.state !== 'SETTLED') || openSetNeeds(qualification, 'BASELINE') > 0) return 'PENDING';
    const outcome = qualificationOf(qualification, version.document);
    if (outcome.state === 'PENDING') return 'PENDING';
    if (outcome.state !== 'REPRODUCED') return 'FAILED';
    const terms = replayTerms(this.toolchain(), bugCase.keepBrowserStorage, version.document);
    if (qualification.some((member) => member.counted && member.toolchain !== terms)) {
      await this.queueQualification(run.taskId, version.caseId, version.id);
      return 'PENDING';
    }
    return 'OK';
  }

  private async execute(queued: StoredBugReplayRun, controller: AbortController): Promise<void> {
    let run = queued;
    let context: StartedContext | undefined;
    let started = false;
    const scratchDir = path.join(this.options.scratchRoot, run.id);
    try {
      const records = await this.loadRunRecords(run);
      if (!records) throw new RunSettled('CANCELED', { reason: 'CANCELED_BY_PERSON', detail: 'The bug was removed.' });
      const { version, bugCase } = records;
      context = await this.options.access.context(run.taskId);
      const worktreePath = context.worktree.worktreePath;
      const tree = run.kind === 'CANDIDATE' ? run.inputTreeId! : version.baselineTreeId;
      const toolchain = replayTerms(this.toolchain(), bugCase.keepBrowserStorage, version.document);
      run = await this.updateRun(run, { state: 'PREPARING_SOURCE', phase: 'Copying source', startedAt: now(), inputTreeId: tree, toolchain, scratchDir }, 'BUG_REPLAY_RUN_UPDATED');
      if (run.state === 'SETTLED') return;
      const envFiles = await Promise.all(version.envFiles.map(async (file) => ({
        relativePath: file.relativePath,
        bytes: await fs.readFile(path.join(worktreePath, file.relativePath))
      })));
      const exported = await this.freezer.export({ worktreePath, taskId: run.taskId, runId: run.id, treeId: tree, envFiles, signal: controller.signal });
      const derived = await this.derive(run, version, worktreePath, tree, exported.sourcePath);
      if (!this.options.authorization.covers(run.taskId, derived.approvalDigest)) throw new RunWaits('APPROVAL');
      await this.environment.preflight(derived.spec);
      run = await this.updateRun(run, { state: 'STARTING_ENVIRONMENT', phase: 'Starting the app' }, 'BUG_REPLAY_RUN_UPDATED');
      started = true;
      const environment = await this.environment.start({
        taskId: run.taskId,
        name: run.name,
        spec: derived.spec,
        approvalDigest: derived.approvalDigest,
        secretIds: derived.secretIds,
        signal: controller.signal,
        onPhase: (phase) => this.notePhase(run, phase),
        onAttempt: (attemptId) => {
          void this.options.store.write((tx) => {
            const current = this.options.store.getRun(tx, run.id);
            if (current) run = this.options.store.updateRun(tx, { ...current, previewAttemptId: attemptId }, current.revision);
          }).catch(() => undefined);
        }
      });
      run = await this.updateRun(run, { state: 'WARMING_UP', phase: 'Warming up', previewAttemptId: environment.attemptId }, 'BUG_REPLAY_RUN_UPDATED');
      const warmFacts = await this.environment.warmUp(environment.origins, warmUpRequests(version.document), controller.signal);
      const setupChanged = await this.freezer.changedFiles(exported.sourcePath, exported.tracked);
      const readyBlobs = await this.currentBlobs(exported.sourcePath, exported.tracked, setupChanged);
      run = await this.updateRun(run, { state: 'EXECUTING', phase: 'Running the steps', setupChangedPaths: setupChanged.slice(0, 50) }, 'BUG_REPLAY_RUN_UPDATED');
      const document: BugCaseV1 = { ...version.document, keepBrowserStorageAfterReload: bugCase.keepBrowserStorage };
      const result = await this.options.runner.run({
        runId: run.id,
        document,
        origins: environment.origins,
        scratchDir,
        signal: controller.signal
      });
      if (result.kind === 'canceled') throw new RunSettled('CANCELED', { reason: 'CANCELED_BY_PERSON', detail: 'Canceled' });
      if (result.kind === 'invalid') {
        throw new RunSettled('ENVIRONMENT_FAILED', { reason: 'RUNNER_FAILED', detail: `Couldn't verify: ${result.detail.replace(/\.$/, '')}` });
      }
      run = await this.updateRun(run, { state: 'COLLECTING', phase: 'Collecting results' }, 'BUG_REPLAY_RUN_UPDATED');
      const bracket = await this.environment.bracket(run.name, environment.attemptId);
      const endChanged = await this.freezer.changedFiles(exported.sourcePath, readyBlobs);
      const evaluated = evaluateRun(run.kind === 'CANDIDATE' ? 'CANDIDATE' : 'BASELINE', document, result.frames, {
        ...(bracket.ok ? {} : { serviceStopped: bracket.service }),
        ...(endChanged.length ? { sourceChanged: endChanged } : {}),
        ...(run.kind === 'CANDIDATE' ? { baselineLocators: await this.baselineLocators(version) } : {})
      });
      const facts = [
        ...warmFacts,
        ...evaluated.facts,
        ...(setupChanged.length ? [`Setup changed ${setupChanged.length} tracked files before the app was ready`] : [])
      ].slice(0, 30);
      // An abort decides how a run ends, even when the runner finished as it came.
      if (controller.signal.aborted) throw controller.signal.reason;
      const files = await this.publishRunFiles(run, result);
      await this.settleRun(run, evaluated.outcome, evaluated.failure, {
        observations: evaluated.observations,
        facts,
        signatureObserved: evaluated.signatureObserved,
        readyTreeId: tree,
        ...(endChanged.length ? {} : { endTreeId: tree }),
        files
      });
    } catch (error) {
      const settled = classify(error, controller.signal);
      if (settled instanceof RunWaits) {
        await this.updateRun(run, { state: 'WAITING', waitingFor: settled.reason }, 'BUG_REPLAY_RUN_UPDATED').catch(() => undefined);
      } else {
        await this.settleRun(run, settled.outcome, settled.failure).catch(() => undefined);
      }
    } finally {
      if (started || run.state !== 'QUEUED') {
        const teardown = REPLAY_NAME_PATTERN.test(run.name) ? await this.environment.teardown(run.name) : { complete: true as const };
        if (!teardown.complete) await this.noteCleanupDebt(run.id, teardown.reason);
        await this.freezer.cleanup(run.taskId, run.id).catch(() => undefined);
        await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
      }
      await this.prune(run.taskId).catch(() => undefined);
    }
  }

  /** The weakest candidate each check needed in the runs that reproduced the bug. */
  private async baselineLocators(version: BugCaseVersionRecord): Promise<Record<string, number>> {
    const runs = await this.options.store.read((reader) => this.options.store.listRuns(reader, { caseId: version.caseId }));
    const locators: Record<string, number> = {};
    for (const run of (latestSets(runs, version.id).qualification ?? []).filter((member) => member.outcome === 'REPRODUCED')) {
      for (const observation of run.observations) {
        if (observation.locator === undefined) continue;
        locators[observation.assertionId] = Math.max(locators[observation.assertionId] ?? 0, observation.locator);
      }
    }
    return locators;
  }

  private async derive(run: StoredBugReplayRun, version: BugCaseVersionRecord, worktreePath: string, tree: string, exportRoot: string) {
    const envTexts = await Promise.all(version.envFiles.map(async (file) => ({
      relativePath: file.relativePath,
      text: await fs.readFile(path.join(worktreePath, file.relativePath), 'utf8').catch(() => '')
    })));
    try {
      return await deriveReplaySpec({
        recipeText: version.recipe.text,
        exportRoot: exportRoot === '/<export>' ? exportRoot : await fs.realpath(exportRoot),
        liveWorktree: worktreePath,
        runName: run.name,
        ceiling: ceilingFor(exportRoot),
        tree: await this.treeReader(worktreePath, tree),
        envFiles: envTexts
      });
    } catch (error) {
      if (error instanceof ReplayEligibilityError) throw new RunSettled('BLOCKED', { reason: 'INELIGIBLE', detail: error.message });
      throw error;
    }
  }

  async treeReader(worktreePath: string, treeId: string): Promise<ProtectedTree> {
    const files = await this.options.snapshots.listTree(worktreePath, treeId);
    const cache = new Map<string, Promise<string | undefined>>();
    return {
      files,
      readText: (relativePath) => {
        let read = cache.get(relativePath);
        if (!read) {
          read = this.options.snapshots.readText(worktreePath, treeId, relativePath).catch(() => undefined);
          cache.set(relativePath, read);
        }
        return read;
      },
      blobs: async (paths) => {
        const entries = await this.options.snapshots.entriesAt(worktreePath, treeId, [...paths]);
        return new Map([...entries].map(([file, entry]) => [file, entry.blob]));
      }
    };
  }

  private async currentBlobs(sourcePath: string, tracked: Map<string, string>, changed: string[]): Promise<Map<string, string>> {
    if (changed.length === 0) return tracked;
    const next = new Map(tracked);
    for (const file of changed) {
      const bytes = await fs.readFile(path.join(sourcePath, file)).catch(() => undefined);
      if (bytes) next.set(file, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
      else next.delete(file);
    }
    return next;
  }

  private async publishRunFiles(run: StoredBugReplayRun, result: Extract<Awaited<ReturnType<BugReplayRunner['run']>>, { kind: 'completed' }>) {
    const files: BugReplayFileRecord[] = [];
    try {
      for (const shot of result.screenshots.slice(0, 6)) {
        const bytes = await fs.readFile(shot.path).catch(() => undefined);
        if (!bytes || bytes.length > 1024 * 1024) continue;
        files.push(await this.options.store.publishFile({ taskId: run.taskId, ownerKind: 'RUN', ownerId: run.id, kind: 'SCREENSHOT', mediaType: 'image/png', bytes }));
      }
      const sensitive = (await this.loadRunRecords(run))?.version.document.sensitiveInputs.map((input) => input.value) ?? [];
      const frames = Buffer.from(JSON.stringify(redactEvidence(result.frames, sensitive)), 'utf8');
      if (frames.length <= 1024 * 1024) {
        files.push(await this.options.store.publishFile({ taskId: run.taskId, ownerKind: 'RUN', ownerId: run.id, kind: 'RUN_FRAMES', mediaType: 'application/json', bytes: frames }));
      }
    } catch (error) {
      await this.options.store.discardPublished(files);
      throw error;
    }
    return files;
  }

  /** Queues what the task's bug still owes (`owedRuns`). */
  private async refillOpenSets(taskId: string): Promise<void> {
    let added = 0;
    await this.commit(taskId, 'BUG_REPLAY_RUN_UPDATED', (tx) => {
      added = this.refillIn(tx, taskId);
    }, {}, { onlyIfChanged: true });
    if (added > 0) this.schedule();
  }

  /**
   * Inserts the runs the task's active bug still owes in the caller's transaction, so two runs
   * settling together can never both add a replacement. Returns how many it added.
   */
  private refillIn(tx: AppDatabaseTransaction, taskId: string): number {
    // Closing queues nothing new; the next start refills what this one cut short.
    if (this.closed) return 0;
    const active = this.options.store.activeCase(tx, taskId);
    if (!active) return 0;
    const version = effectiveVersion(this.options.store.listVersions(tx, active.id), this.options.store.listDecisions(tx, active.id));
    if (!version) return 0;
    const owed = owedRuns(this.options.store.listRuns(tx, { caseId: active.id }), version.id);
    const qualificationSet = randomUUID();
    for (const run of owed) {
      this.options.store.insertRun(tx, this.newRun(taskId, run.kind, {
        caseId: active.id,
        versionId: version.id,
        setId: run.setId ?? qualificationSet,
        ...(run.control ? { control: true } : {}),
        ...(run.like?.inputTreeId ? { inputTreeId: run.like.inputTreeId } : {}),
        ...(run.like?.agentRunId ? { agentRunId: run.like.agentRunId } : {}),
        ...(run.like?.controlDue ? { controlDue: true } : {})
      }));
    }
    return owed.length;
  }

  /**
   * A new verification attempt for a tree the worktree holds now; queued older candidates of the
   * case are superseded, and the tree is recorded as the code last observed in the same commit.
   */
  private async queueAttempt(taskId: string, bugCase: BugCaseRecord, version: BugCaseVersionRecord, treeId: string, setId: string, agentRunId: string | undefined, person: boolean): Promise<void> {
    const runs = await this.options.store.read((reader) => this.options.store.listRuns(reader, { caseId: bugCase.id, open: true }));
    const waiting = this.stopExecuting(runs.filter((candidate) => candidate.kind === 'CANDIDATE' || candidate.control), () => new Superseded());
    const qualification = latestSets(await this.options.store.read((reader) => this.options.store.listRuns(reader, { caseId: bugCase.id })), version.id).qualification ?? [];
    const settledAt = qualification.filter((run) => run.counted).map((run) => run.settledAt ?? '').sort().pop();
    const controlDue = needsControlRun(settledAt);
    await this.commit(taskId, 'BUG_REPLAY_RUN_UPDATED', (tx) => {
      // The older attempt's waiting runs end with the new attempt's start: one step from one to the next.
      for (const run of waiting) this.settleIn(tx, run.id, 'SUPERSEDED', { reason: 'CANCELED_BY_PERSON', detail: 'A newer turn replaced this check.' });
      const current = this.options.store.getCase(tx, bugCase.id);
      if (current && (current.observedTreeId !== treeId || current.observedTreeIssue)) {
        const observed: BugCaseRecord = { ...current, observedTreeId: treeId, updatedAt: now() };
        delete observed.observedTreeIssue;
        this.options.store.updateCase(tx, observed, current.revision);
      }
      for (let index = 0; index < 2; index += 1) {
        this.options.store.insertRun(tx, this.newRun(taskId, 'CANDIDATE', {
          caseId: bugCase.id,
          versionId: version.id,
          setId,
          inputTreeId: treeId,
          ...(agentRunId ? { agentRunId } : {}),
          ...(controlDue ? { controlDue: true } : {})
        }));
      }
    }, { person });
    this.schedule();
  }

  private newRun(taskId: string, kind: BugReplayRunKind, fields: { caseId?: string; versionId?: string; setId?: string; inputTreeId?: string; agentRunId?: string; control?: boolean; controlDue?: boolean }): StoredBugReplayRun {
    const run: StoredBugReplayRun = {
      id: randomUUID(),
      taskId,
      kind,
      state: 'QUEUED',
      counted: false,
      name: replayEnvironmentName(randomBytes(6).toString('hex')),
      observations: [],
      facts: [],
      fileIds: [],
      queuedAt: now(),
      revision: 0,
      ...(fields.caseId ? { caseId: fields.caseId } : {}),
      ...(fields.versionId ? { versionId: fields.versionId } : {}),
      ...(fields.setId ? { setId: fields.setId } : {}),
      ...(fields.inputTreeId ? { inputTreeId: fields.inputTreeId } : {}),
      ...(fields.agentRunId ? { agentRunId: fields.agentRunId } : {}),
      ...(fields.control ? { control: true } : {})
    };
    if (fields.controlDue) run.controlDue = true;
    return run;
  }

  // Persistence helpers

  async updateRun(
    run: StoredBugReplayRun,
    patch: Partial<StoredBugReplayRun> & { state?: BugReplayRunState },
    type: DomainEventType,
    options: { quiet?: boolean } = {}
  ): Promise<StoredBugReplayRun> {
    let updated = run;
    const projected = patch.state !== undefined || patch.waitingFor !== undefined;
    const write = async (tx: AppDatabaseTransaction) => {
      const current = this.options.store.getRun(tx, run.id);
      if (!current) throw new Error('This clean run no longer exists.');
      // A run the person canceled, or a task close settled, stays settled.
      if (current.state === 'SETTLED') {
        updated = current;
        return;
      }
      const next: StoredBugReplayRun = { ...current, ...patch };
      if (patch.state && patch.state !== 'WAITING') delete next.waitingFor;
      updated = this.options.store.updateRun(tx, next, current.revision);
    };
    if (projected && run.caseId) {
      await this.commit(run.taskId, type, write, { runId: run.id }, { ...options, onlyIfChanged: true });
    } else {
      await this.options.store.write(write);
      if (!options.quiet) this.emitUpdate(run.taskId);
    }
    return updated;
  }

  async settleRun(
    run: StoredBugReplayRun,
    outcome: BugReplayRunOutcome,
    failure?: BugReplayRunFailure,
    extra: Partial<StoredBugReplayRun> & { files?: Awaited<ReturnType<SqliteBugReplayStore['publishFile']>>[] } = {},
    options: { quiet?: boolean } = {}
  ): Promise<void> {
    const { files = [], ...fields } = extra;
    let added = 0;
    let recorded = false;
    let committed = false;
    const write = (tx: AppDatabaseTransaction) => {
      recorded = this.settleIn(tx, run.id, outcome, failure, fields, files);
      // The replacement a settled run makes owed is queued with it, before any teardown.
      if (recorded && run.caseId) added = this.refillIn(tx, run.taskId);
    };
    try {
      if (run.caseId) await this.commit(run.taskId, 'BUG_REPLAY_RUN_SETTLED', write, { runId: run.id, outcome }, { ...options, quiet: true });
      else await this.options.store.write(write);
      committed = true;
    } finally {
      // Bytes no committed row references go again: the write rolled back, or the run was settled elsewhere first.
      if (!(committed && recorded) && files.length > 0) await this.options.store.discardPublished(files);
    }
    if (!run.caseId || !options.quiet) this.emitUpdate(run.taskId, Boolean(run.caseId));
    if (added > 0) this.schedule();
  }

  /** Settles one run in the caller's transaction; false when it was already settled or is gone. */
  private settleIn(
    tx: AppDatabaseTransaction,
    runId: string,
    outcome: BugReplayRunOutcome,
    failure?: BugReplayRunFailure,
    fields: Partial<StoredBugReplayRun> = {},
    files: BugReplayFileRecord[] = []
  ): boolean {
    const current = this.options.store.getRun(tx, runId);
    if (!current || current.state === 'SETTLED') return false;
    for (const file of files) this.options.store.recordFile(tx, file);
    const next: StoredBugReplayRun = {
      ...current,
      ...fields,
      state: 'SETTLED',
      outcome,
      counted: COUNTED_BUG_REPLAY_OUTCOMES.has(outcome),
      settledAt: now(),
      fileIds: [...current.fileIds, ...files.map((file) => file.id)],
      ...(failure ? { failure } : {})
    };
    delete next.waitingFor;
    delete next.phase;
    this.options.store.updateRun(tx, next, current.revision);
    return true;
  }

  /**
   * Stops the runs that are executing, which settle when their run ends, and returns the ones
   * still waiting. Callers settle those in one commit: one run of a set decides nothing alone,
   * so a set is never shown half settled.
   */
  private stopExecuting(runs: StoredBugReplayRun[], reason: () => Error): StoredBugReplayRun[] {
    return runs.filter((run) => {
      const controller = this.executing.get(run.id);
      controller?.abort(reason());
      return !controller;
    });
  }

  private notePhase(run: StoredBugReplayRun, phase: string): void {
    void this.options.store.write((tx) => {
      const current = this.options.store.getRun(tx, run.id);
      if (!current || current.state === 'SETTLED' || current.phase === phase) return;
      this.options.store.updateRun(tx, { ...current, phase }, current.revision);
    }).then(() => this.emitUpdate(run.taskId), () => undefined);
  }

  private async noteCleanupDebt(runId: string, reason: string): Promise<void> {
    await this.options.store.write((tx) => {
      const current = this.options.store.getRun(tx, runId);
      if (current) this.options.store.updateRun(tx, { ...current, cleanupDebt: reason.slice(0, 300) }, current.revision);
    }).catch(() => undefined);
  }

  /** Commits a ledger change together with the BUG_ event that carries the recomputed bug projection. */
  async commit(
    taskId: string,
    type: DomainEventType,
    change: (tx: AppDatabaseTransaction) => void | Promise<void>,
    detail: Record<string, unknown> = {},
    options: { quiet?: boolean; onlyIfChanged?: boolean } = {}
  ): Promise<BugReplayGateProjection | undefined> {
    const gate = await this.options.tasks.serializePersistenceMutation(() =>
      this.options.store.write(async (tx) => {
        await change(tx);
        const projection = this.gateIn(tx, taskId);
        const key = JSON.stringify({ ...projection, updatedAt: undefined });
        if (options.onlyIfChanged && this.lastProjection.get(taskId) === key) return projection;
        tx.afterCommit(() => this.lastProjection.set(taskId, key));
        await this.options.tasks.appendEvent(
          createDomainEvent({ type, taskId, source: 'replay', payload: { gate: projection ?? null, ...detail } })
        );
        return projection;
      })
    );
    if (!options.quiet) this.emitUpdate(taskId, true);
    return gate;
  }

  async publishGate(taskId: string, type: DomainEventType, detail: Record<string, unknown>, options: { onlyIfChanged?: boolean } = {}): Promise<void> {
    await this.commit(taskId, type, () => undefined, detail, { quiet: false, ...options });
  }

  gateIn(reader: SqlReader, taskId: string): BugReplayGateProjection | undefined {
    const bugCase = this.options.store.activeCase(reader, taskId);
    if (!bugCase) return undefined;
    return computeGate({
      bugCase,
      versions: this.options.store.listVersions(reader, bugCase.id),
      decisions: this.options.store.listDecisions(reader, bugCase.id),
      runs: this.options.store.listRuns(reader, { caseId: bugCase.id }),
      toolchain: this.toolchain(),
      now: now()
    });
  }

  emitUpdate(taskId: string, projectionChanged = false): void {
    const at = now();
    this.options.events.emit({ type: 'bugReplay.updated', taskId, payload: {}, at });
    if (projectionChanged) this.options.events.emit({ type: 'task.updated', taskId, payload: { bugReplay: true }, at });
  }

  async caseRecords(caseId: string) {
    return this.options.store.read((reader) => ({
      versions: this.options.store.listVersions(reader, caseId),
      decisions: this.options.store.listDecisions(reader, caseId),
      runs: this.options.store.listRuns(reader, { caseId })
    }));
  }

  private async loadRunRecords(run: StoredBugReplayRun): Promise<{ bugCase: BugCaseRecord; version: BugCaseVersionRecord; superseded: boolean } | undefined> {
    if (!run.caseId || !run.versionId) return undefined;
    return this.options.store.read((reader) => {
      const bugCase = this.options.store.getCase(reader, run.caseId!);
      if (!bugCase || bugCase.status !== 'ACTIVE') return undefined;
      const version = this.options.store.listVersions(reader, bugCase.id).find((candidate) => candidate.id === run.versionId);
      if (!version) return undefined;
      const superseded = this.options.store.listDecisions(reader, bugCase.id).some((decision) => decision.kind === 'SUPERSEDED' && decision.versionId === version.id);
      return { bugCase, version, superseded };
    });
  }

  private async requireActiveCase(taskId: string): Promise<BugCaseRecord> {
    const active = await this.options.store.read((reader) => this.options.store.activeCase(reader, taskId));
    if (!active) throw new Error('This task has no recorded bug.');
    return active;
  }

  private async requireActiveVersion(taskId: string): Promise<{ bugCase: BugCaseRecord; version: BugCaseVersionRecord }> {
    const bugCase = await this.requireActiveCase(taskId);
    const { versions, decisions } = await this.caseRecords(bugCase.id);
    const version = effectiveVersion(versions, decisions);
    if (!version) throw new Error('This bug has no check to run.');
    return { bugCase, version };
  }

  private async recordObservedTree(taskId: string, caseId: string, treeId: string): Promise<void> {
    const current = await this.options.store.read((reader) => this.options.store.getCase(reader, caseId));
    if (!current || (current.observedTreeId === treeId && !current.observedTreeIssue)) return;
    await this.commit(taskId, 'BUG_REPLAY_VERDICT_STALE', (tx) => {
      const latest = this.options.store.getCase(tx, caseId);
      if (!latest) return;
      const observed: BugCaseRecord = { ...latest, observedTreeId: treeId, updatedAt: now() };
      delete observed.observedTreeIssue;
      this.options.store.updateCase(tx, observed, latest.revision);
    }, { reason: 'SOURCE' }, { onlyIfChanged: true });
  }

  /** The worktree could not be read; until it can, no verdict is about the code it holds. */
  private async recordObservedIssue(taskId: string, caseId: string, issue: string): Promise<void> {
    const reason = issue.replace(/\.$/, '').slice(0, 200);
    await this.commit(taskId, 'BUG_REPLAY_VERDICT_STALE', (tx) => {
      const latest = this.options.store.getCase(tx, caseId);
      if (!latest || latest.observedTreeIssue === reason) return;
      this.options.store.updateCase(tx, { ...latest, observedTreeIssue: reason, updatedAt: now() }, latest.revision);
    }, { reason: 'UNREADABLE' }, { onlyIfChanged: true });
  }

  private async cancelCaseRuns(taskId: string, caseId: string, detail: string): Promise<void> {
    const open = await this.options.store.read((reader) => this.options.store.listRuns(reader, { caseId, open: true }));
    await this.cancelWaiting(taskId, this.stopExecuting(open, () => new CancelledByPerson()), detail);
  }

  private async toggleBrowserStorage(taskId: string): Promise<void> {
    const active = await this.requireActiveCase(taskId);
    const { versions, decisions } = await this.caseRecords(active.id);
    const version = effectiveVersion(versions, decisions);
    const requalify = Boolean(version?.document.assertions.some((assertion) => isDomAssertion(assertion) && assertion.alsoAfterReload));
    await this.commit(taskId, 'BUG_CASE_DECIDED', (tx) => {
      const current = this.options.store.getCase(tx, active.id);
      if (current) this.options.store.updateCase(tx, { ...current, keepBrowserStorage: !current.keepBrowserStorage, updatedAt: now() }, current.revision);
      if (requalify && version) this.insertQualification(tx, taskId, active.id, version.id);
    }, { decision: 'OPTION' });
    if (requalify && version) {
      this.schedule();
      await this.reverifyCurrentCode(taskId, active, version);
    }
  }

  /** Use the new env file: a new version with the files' current hashes, requalified at once. */
  private async adoptEnvFiles(taskId: string): Promise<void> {
    const { bugCase, version } = await this.requireActiveVersion(taskId);
    const context = await this.options.access.context(taskId);
    const envFiles = [];
    for (const file of version.envFiles) {
      const bytes = await fs.readFile(path.join(context.worktree.worktreePath, file.relativePath)).catch(() => undefined);
      if (bytes) envFiles.push({ relativePath: file.relativePath, sha256: sha256(bytes) });
    }
    const next: BugCaseVersionRecord = {
      ...version,
      id: randomUUID(),
      version: version.version + 1,
      revisionKind: 'ENV_FILES_ADOPTED',
      envFiles,
      createdAt: now()
    };
    next.digest = versionDigest(next);
    await this.commit(taskId, 'BUG_CASE_DECIDED', (tx) => {
      this.options.store.insertVersion(tx, next);
      this.options.store.insertDecision(tx, { id: randomUUID(), caseId: bugCase.id, taskId, kind: 'APPROVED', versionId: next.id, createdAt: now() });
      this.options.store.insertDecision(tx, { id: randomUUID(), caseId: bugCase.id, taskId, kind: 'SUPERSEDED', versionId: version.id, createdAt: now() });
      this.insertQualification(tx, taskId, bugCase.id, next.id);
    }, { decision: 'APPROVED' });
    this.schedule();
    await this.reverifyCurrentCode(taskId, bugCase, next);
  }

  /**
   * When the person changes what a check runs with, an earlier verdict no longer applies: the code
   * the worktree holds is verified again under the new terms, after the bug reproduces under them.
   */
  private async reverifyCurrentCode(taskId: string, bugCase: BugCaseRecord, version: BugCaseVersionRecord): Promise<void> {
    let context: StartedContext;
    try {
      context = await this.options.access.context(taskId);
    } catch {
      return;
    }
    const setId = randomUUID();
    const { treeId } = await this.freezer.capture(context.worktree.worktreePath, taskId, attemptRef(setId)).catch(() => ({ treeId: '' }));
    if (!treeId) return;
    if (treeId === version.baselineTreeId) {
      await this.freezer.release(context.worktree.worktreePath, taskId, attemptRef(setId)).catch(() => undefined);
      return;
    }
    await this.queueAttempt(taskId, bugCase, version, treeId, setId, undefined, false);
  }

  /** Save as bug without check: the case stays as evidence and is never verified. */
  private async withdrawCheck(taskId: string): Promise<void> {
    const { bugCase, version } = await this.requireActiveVersion(taskId);
    await this.cancelCaseRuns(taskId, bugCase.id, 'The check was withdrawn.');
    await this.commit(taskId, 'BUG_CASE_DECIDED', (tx) => {
      this.options.store.insertDecision(tx, { id: randomUUID(), caseId: bugCase.id, taskId, kind: 'WITHDRAWN', versionId: version.id, createdAt: now() });
    }, { decision: 'WITHDRAWN' });
  }

  /**
   * Keeps evidence of the newest runs, the qualification and the verdict's attempt; older run files
   * go. Records past the newest sixty go too, releasing the trees their attempts pinned, so a bug
   * verified over many turns stays bounded.
   */
  private async prune(taskId: string): Promise<void> {
    const active = await this.options.store.read((reader) => this.options.store.activeCase(reader, taskId));
    if (!active) return;
    const released = new Set<string>();
    await this.options.store.write((tx) => {
      const all = this.options.store.listRuns(tx, { caseId: active.id });
      const settled = all.filter((run) => run.state === 'SETTLED');
      const sets = new Set<string>();
      const gate = this.gateIn(tx, taskId);
      if (gate?.versionId) {
        const latest = latestSets(all, gate.versionId);
        const verdict = verdictAttempt(all, gate.versionId, gate);
        for (const run of [...(latest.qualification ?? []), ...(latest.attempt?.candidates ?? []), ...(verdict?.candidates ?? [])]) {
          if (run.setId) sets.add(run.setId);
        }
      }
      const kept = (run: StoredBugReplayRun, newest: number, index: number) => index < newest || Boolean(run.setId && sets.has(run.setId));
      const files = settled
        .filter((run, index) => !kept(run, RETENTION_RUNS_PER_CASE, index))
        .flatMap((run) => this.options.store.filesFor(tx, 'RUN', run.id));
      if (files.length) this.options.store.deleteFiles(tx, files);
      const dropped = settled.filter((run, index) => !kept(run, RETENTION_RUN_ROWS_PER_CASE, index));
      if (dropped.length === 0) return;
      this.options.store.deleteRuns(tx, dropped.map((run) => run.id));
      const remaining = new Set(all.filter((run) => !dropped.includes(run)).map((run) => run.setId));
      for (const run of dropped) if (run.kind === 'CANDIDATE' && run.setId && !remaining.has(run.setId)) released.add(run.setId);
    });
    if (released.size === 0) return;
    const context = await this.options.access.context(taskId).catch(() => undefined);
    if (!context) return;
    for (const setId of released) await this.freezer.release(context.worktree.worktreePath, taskId, attemptRef(setId)).catch(() => undefined);
  }

  /** Tears down every `br-` name: names a crash left behind and runs whose cleanup did not finish. */
  private async collectEnvironments(): Promise<void> {
    let names: string[] = [];
    try {
      names = await this.environment.replayNames();
    } catch {
      return;
    }
    const executing = new Set(await this.options.store.read((reader) =>
      this.options.store.listRuns(reader, { open: true }).filter((run) => this.executing.has(run.id)).map((run) => run.name)
    ));
    for (const name of names) {
      if (executing.has(name)) continue;
      await this.environment.teardown(name).catch(() => undefined);
    }
  }

  private async sweepScratch(liveRuns: Set<string>): Promise<void> {
    const entries = await fs.readdir(this.options.scratchRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || liveRuns.has(entry.name)) continue;
      if (!/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      await fs.rm(path.join(this.options.scratchRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export class CancelledByPerson extends Error {
  constructor() {
    super('Canceled');
  }
}

class Superseded extends Error {
  constructor() {
    super('Superseded');
  }
}

/** The person changed the expectations a run checks: its result would be about the old ones. */
class ExpectationsChanged extends Error {
  constructor() {
    super('The expectations changed');
  }
}

const EXPECTATIONS_CHANGED: BugReplayRunFailure = { reason: 'CANCELED_BY_PERSON', detail: 'The expectations changed' };

function classify(error: unknown, signal: AbortSignal): RunSettled | RunWaits {
  // Whatever the run was doing when it was aborted, the abort says why it ended: a newer turn,
  // changed expectations, the person, or Task Monki closing. A shutdown is never recorded as the
  // person's cancel.
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Superseded) return new RunSettled('SUPERSEDED', { reason: 'CANCELED_BY_PERSON', detail: 'A newer turn replaced this check.' });
    if (reason instanceof ExpectationsChanged) return new RunSettled('SUPERSEDED', EXPECTATIONS_CHANGED);
    if (reason instanceof CancelledByPerson) return new RunSettled('CANCELED', { reason: 'CANCELED_BY_PERSON', detail: 'Canceled' });
    return new RunSettled('INTERRUPTED', { reason: 'SHUTDOWN', detail: 'Task Monki closed during this run.' });
  }
  if (error instanceof RunSettled || error instanceof RunWaits) return error;
  if (error instanceof ReplayEligibilityError) return new RunSettled('BLOCKED', { reason: 'INELIGIBLE', detail: error.message });
  if (error instanceof ReplayEnvironmentError) {
    if (error.code === 'PREREQUISITE') return new RunSettled('BLOCKED', { reason: 'IMAGE_MISSING', detail: error.message });
    if (error.code === 'CANCELED') return new RunSettled('CANCELED', { reason: 'CANCELED_BY_PERSON', detail: 'Canceled' });
    if (error.code === 'CAPACITY') return new RunWaits('CAPACITY');
    const reasons: Record<typeof error.code, BugReplayOutcomeReason> = {
      NOT_CLEAN: 'NOT_A_CLEAN_START',
      START_FAILED: 'START_FAILED',
      AUTHORIZATION: 'AUTHORIZATION_REFUSED'
    };
    return new RunSettled('ENVIRONMENT_FAILED', {
      reason: reasons[error.code],
      detail: `The clean copy didn't start${error.service ? ` (${error.service}: ${error.message.replace(/\.$/, '')})` : ` (${error.message.replace(/\.$/, '')})`}`
    });
  }
  return new RunSettled('ENVIRONMENT_FAILED', { reason: 'START_FAILED', detail: `The clean copy didn't start (${errorMessage(error)})` });
}

/** Queue order: a qualification's first run (the person is waiting), then candidates oldest first, then the rest. */
function queueOrder(left: StoredBugReplayRun, right: StoredBugReplayRun): number {
  const rank = (run: StoredBugReplayRun) => (run.kind === 'BASELINE' && !run.control ? 0 : run.kind === 'CANDIDATE' ? 1 : 2);
  return rank(left) - rank(right) || (left.queuedAt < right.queuedAt ? -1 : left.queuedAt > right.queuedAt ? 1 : 0);
}

/** A control run is due when the qualification is old or from another day: a bug can stop showing on its own. */
function needsControlRun(qualifiedAt: string | undefined): boolean {
  if (!qualifiedAt) return false;
  const then = new Date(qualifiedAt);
  const current = new Date();
  return current.getTime() - then.getTime() > 6 * 3600 * 1000 || then.toDateString() !== current.toDateString();
}

/** GET the pages and read APIs the recording used and OPTIONS the routes it wrote to, so first compiles happen before the steps. */
function warmUpRequests(document: BugCaseV1): Array<{ role: string; method: 'GET' | 'OPTIONS'; path: string }> {
  const requests: Array<{ role: string; method: 'GET' | 'OPTIONS'; path: string }> = [];
  const seen = new Set<string>();
  const add = (role: string, method: 'GET' | 'OPTIONS', target: string) => {
    if (target.includes('*')) return;
    const key = `${role} ${method} ${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ role, method, path: target });
  };
  const start = document.steps[0];
  if (start?.kind === 'navigate') add(start.origin, 'GET', start.path);
  for (const assertion of document.assertions) {
    if (assertion.kind !== 'request') continue;
    add(assertion.origin, assertion.method === 'GET' ? 'GET' : 'OPTIONS', assertion.pathTemplate);
  }
  return requests.slice(0, 24);
}

/** Keeps `value` under `key`, forgetting the oldest beyond the newest 32. */
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.set(key, value);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return value;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The promise's value, or undefined once `ms` pass; the timer never outlives the answer. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
