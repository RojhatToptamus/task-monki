import type {
  DesignDetailSnapshot,
  DesignOpenedCandidateCheckpoint,
  DesignTurn,
  GitSnapshotRecord,
  PreviewGenerationRecord,
  RunRecord
} from '../../shared/contracts';
import {
  buildDesignTurnPrompt,
  buildInitialDesignPrompt
} from '../../shared/promptTemplates';
import { AgentOrchestrator } from '../agent/AgentOrchestrator';
import type { PreviewTaskContext } from '../preview/PreviewManager';
import { PreviewManager } from '../preview/PreviewManager';
import type { DesignCanvasCutoverFence } from '../preview/DesignCanvasCutoverFence';
import { AppEventBus } from '../runner/AppEventBus';
import { FileTaskStore } from '../storage/FileTaskStore';
import {
  type DesignBrowserOwner,
  type DesignBrowserToolResult,
  type InspectDesignOperation
} from './AgentBrowserRuntime';
import {
  DesignSourceService,
  type DesignSourceOwnership,
  type PublishedDesignCandidateCheckpoint
} from './DesignSourceService';

const ACTIVE_RUN_STATUSES: ReadonlySet<RunRecord['status']> = new Set([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
]);

class RecoverableCheckpointWriteError extends Error {
  constructor(
    readonly boundary: 'REF_UPDATED_INDEX_PENDING' | 'INDEX_REPAIRED',
    writeError: unknown
  ) {
    super(`Design source recovery is waiting at ${boundary}.`, {
      cause: writeError
    });
    this.name = 'RecoverableCheckpointWriteError';
  }
}

export interface DesignUpdateCoordinatorOptions {
  store: FileTaskStore;
  agents: AgentOrchestrator;
  previews: PreviewManager;
  source: DesignSourceService;
  browser: DesignBrowserOwner;
  fence: DesignCanvasCutoverFence;
  events: AppEventBus;
  refreshGitEvidence(designId: string): Promise<GitSnapshotRecord>;
  ensurePostRunEvidence(runId: string): Promise<void>;
}

/**
 * Serializes the one Design-specific sequence that existing owners cannot
 * cover alone: turn, evidence, commit, Preview, and durable ready revision.
 */
export class DesignUpdateCoordinator {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly terminalAdmissions = new Set<Promise<void>>();
  private accepting = false;
  private shuttingDown = false;
  private terminalAdmissionClosed = false;

  constructor(private readonly options: DesignUpdateCoordinatorOptions) {}

  open(): void {
    if (this.shuttingDown) {
      throw new Error('Design updates cannot reopen during shutdown.');
    }
    this.accepting = true;
  }

  async recover(): Promise<void> {
    if (this.shuttingDown) return;
    const designs = await this.options.store.listDesigns();
    for (const design of designs) {
      await this.withDesignLock(design.id, async () => {
        const detail = await this.options.store.getDesignDetail(design.id);
        const unsettled = detail.turns.find((turn) => turn.outcome === undefined);
        if (unsettled) {
          await this.recoverTurn(detail, unsettled);
        }
        const refreshed = await this.options.store.getDesignDetail(design.id);
        if (
          refreshed.revisions.length > 0 &&
          !isActiveReadyGeneration(refreshed.currentPreview)
        ) {
          await this.restartLatestReadyUnlocked(refreshed).catch(() => undefined);
        }
      });
    }
    this.open();
    for (const design of designs) {
      const detail = await this.options.store.getDesignDetail(design.id);
      const queued = detail.turns.find(
        (turn) =>
          turn.outcome === undefined &&
          turn.checkpoint?.boundary === 'QUEUED' &&
          !turn.runId
      );
      if (queued) await this.dispatch(design.id);
    }
  }

  dispatch(designId: string): Promise<void> {
    this.assertAccepting();
    return this.withDesignLock(designId, () => this.dispatchUnlocked(designId));
  }

  handleRunTerminal(runId: string): Promise<void> {
    if (this.terminalAdmissionClosed) return Promise.resolve();
    const work = this.options.store.getRun(runId).then(async (run) => {
      if (!run || run.mode !== 'DESIGN') return;
      await this.options.browser.closeRun(run.id).catch(() => undefined);
      return this.withDesignLock(run.taskId, () => this.settleRunUnlocked(run.id));
    });
    this.terminalAdmissions.add(work);
    return work.finally(() => this.terminalAdmissions.delete(work));
  }

  restartLatestReady(designId: string): Promise<void> {
    this.assertAccepting();
    return this.withDesignLock(designId, async () => {
      const detail = await this.options.store.getDesignDetail(designId);
      await this.restartLatestReadyUnlocked(detail);
      this.emitUpdated(designId, { reason: 'preview-restarted' });
    });
  }

  cancelTurn(designId: string, turnId: string): Promise<void> {
    this.assertAccepting();
    void this.options.store.getDesignDetail(designId).then((detail) => {
      const runId = detail.turns.find((candidate) => candidate.id === turnId)?.runId;
      if (runId) this.options.browser.abortRun(runId);
    });
    return this.withDesignLock(designId, async () => {
      const detail = await this.options.store.getDesignDetail(designId);
      const turn = detail.turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error('Design turn not found.');
      if (turn.outcome !== undefined) return;

      if (!turn.runId) {
        await this.options.store.settleDesignTurn({
          designId,
          turnId,
          outcome: 'CANCELED'
        });
        this.emitUpdated(designId, { reason: 'turn-canceled', turnId });
        await this.dispatchNextUnlocked(designId);
        return;
      }

      const run = await this.options.store.getRun(turn.runId);
      if (!run) {
        throw new Error('The active Design turn lost its agent run.');
      }
      if (ACTIVE_RUN_STATUSES.has(run.status)) {
        await this.options.browser.closeRun(run.id).catch(() => undefined);
        await this.stopOpenedCandidate(turn).catch(() => undefined);
        await this.options.agents.interruptRun(run.id);
        this.emitUpdated(designId, {
          reason: 'turn-cancel-requested',
          turnId,
          runId: run.id
        });
        return;
      }
      await this.settleRunUnlocked(run.id);
    });
  }

  withExclusiveAccess<T>(designId: string, operation: () => Promise<T>): Promise<T> {
    this.assertAccepting();
    return this.withDesignLock(designId, operation);
  }

  async inspectDesign(input: {
    runId: string;
    operation: InspectDesignOperation;
  }): Promise<DesignBrowserToolResult> {
    this.assertAccepting();
    const run = await this.requireActiveDesignRun(input.runId);
    if (input.operation.operation !== 'open_candidate') {
      const detail = await this.options.store.getDesignDetail(run.taskId);
      const turn = detail.turns.find((candidate) => candidate.id === run.generationKey);
      if (!turn?.finalOpenedCandidate || turn.outcome !== undefined) {
        throw new Error('This Design Run has no current verified candidate.');
      }
      return this.options.browser.inspect(run.id, input.operation);
    }
    return this.withDesignLock(run.taskId, () => this.openCandidateUnlocked(run));
  }

  async beginShutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.accepting = false;
    this.shuttingDown = true;
    await this.options.browser.shutdown();
    const snapshot = await this.options.store.snapshot();
    await Promise.allSettled(
      snapshot.designTurns
        .filter((turn) => turn.outcome === undefined && turn.finalOpenedCandidate)
        .map((turn) =>
          this.options.previews.stopManagedDesignCandidate(
            turn.finalOpenedCandidate!.previewGenerationId
          )
        )
    );
    await Promise.allSettled(
      snapshot.runs
        .filter(
          (run) => run.mode === 'DESIGN' && ACTIVE_RUN_STATUSES.has(run.status)
        )
        .map((run) => this.options.agents.interruptRun(run.id))
    );
    this.terminalAdmissionClosed = true;
    await this.drain();
  }

  async drain(): Promise<void> {
    while (this.locks.size > 0 || this.terminalAdmissions.size > 0) {
      await Promise.allSettled([
        ...this.locks.values(),
        ...this.terminalAdmissions.values()
      ]);
    }
  }

  private async dispatchUnlocked(designId: string): Promise<void> {
    this.assertAccepting();
    const detail = await this.options.store.getDesignDetail(designId);
    const turn = detail.turns.find((candidate) => candidate.outcome === undefined);
    if (!turn) return;
    const existing = await this.options.store.getRunByGenerationKey(designId, turn.id);
    if (existing) {
      if (!turn.runId) {
        await this.options.store.linkDesignTurnRun({
          designId,
          turnId: turn.id,
          runId: existing.id
        });
      }
      if (!ACTIVE_RUN_STATUSES.has(existing.status)) {
        await this.settleRunUnlocked(existing.id);
      }
      return;
    }
    if (turn.checkpoint?.boundary !== 'QUEUED') {
      throw new Error('A dispatched Design turn has an invalid durable checkpoint.');
    }

    let run: RunRecord | undefined;
    try {
      const context = requireReadyContext(detail);
      const before = await this.options.refreshGitEvidence(designId);
      if (!before.headSha) {
        throw new Error('Design worktree does not have a readable source commit.');
      }
      const prompt = promptForTurn(detail, turn, context, before.headSha);
      run = await this.options.agents.startTurn({
        task: context.task,
        iteration: context.iteration,
        worktree: context.worktree,
        mode: 'DESIGN',
        prompt,
        instructionProfile: 'DESIGN',
        settings: context.task.agentSettings,
        generationKey: turn.id,
        beforeGitSnapshotId: before.id
      });
    } catch (error) {
      run = await this.options.store.getRunByGenerationKey(designId, turn.id);
      if (run && !turn.runId) {
        await this.options.store.linkDesignTurnRun({
          designId,
          turnId: turn.id,
          runId: run.id
        });
      }
      if (run && !ACTIVE_RUN_STATUSES.has(run.status)) {
        await this.settleTerminalFailure(designId, turn.id, run);
      } else if (!run) {
        await this.options.store.settleDesignTurn({
          designId,
          turnId: turn.id,
          outcome: 'FAILED',
          failureReason: boundedReason(error, 'The Design agent could not start.')
        });
      }
      this.emitUpdated(designId, { reason: 'agent-start-failed' });
      throw error;
    }
    await this.options.store.linkDesignTurnRun({
      designId,
      turnId: turn.id,
      runId: run.id
    });
    this.emitUpdated(designId, { reason: 'run-started', runId: run.id });
  }

  private async settleRunUnlocked(runId: string): Promise<void> {
    let run = await this.options.store.getRun(runId);
    if (!run || run.mode !== 'DESIGN') return;
    const detail = await this.options.store.getDesignDetail(run.taskId);
    const turn = detail.turns.find(
      (candidate) => candidate.id === run!.generationKey
    );
    if (!turn || turn.outcome !== undefined) return;
    if (!turn.runId) {
      await this.options.store.linkDesignTurnRun({
        designId: run.taskId,
        turnId: turn.id,
        runId: run.id
      });
    }
    if (ACTIVE_RUN_STATUSES.has(run.status)) return;
    if (run.status !== 'COMPLETED') {
      await this.options.browser.closeRun(run.id).catch(() => undefined);
      await this.stopOpenedCandidate(turn).catch(() => undefined);
      await this.settleTerminalFailure(run.taskId, turn.id, run);
      this.emitUpdated(run.taskId, { reason: 'run-failed', runId });
      await this.dispatchNextUnlocked(run.taskId);
      return;
    }

    try {
      await this.options.ensurePostRunEvidence(run.id);
      run = (await this.options.store.getRun(run.id)) ?? run;
      if (!run.afterGitSnapshotId) {
        throw new Error('The completed Design run has no post-run Git evidence.');
      }
      let currentTurn = (
        await this.options.store.getDesignDetail(run.taskId)
      ).turns.find((candidate) => candidate.id === turn.id)!;
      if (currentTurn.checkpoint?.boundary === 'RUN_LINKED') {
        currentTurn = await this.options.store.updateDesignTurnCheckpoint({
          designId: run.taskId,
          turnId: turn.id,
          checkpoint: {
            boundary: 'POST_RUN_EVIDENCE_RECORDED',
            gitSnapshotId: run.afterGitSnapshotId
          }
        });
      }
      await this.finishSourceAndPreview(run, currentTurn);
      this.emitUpdated(run.taskId, { reason: 'turn-settled', runId });
      await this.dispatchNextUnlocked(run.taskId);
    } catch (error) {
      if (error instanceof RecoverableCheckpointWriteError) {
        this.emitUpdated(run.taskId, {
          reason: 'source-recovery-deferred',
          runId,
          boundary: error.boundary
        });
        return;
      }
      const latest = await this.options.store.getDesignDetail(run.taskId);
      const unsettled = latest.turns.find((candidate) => candidate.id === turn.id);
      if (unsettled && unsettled.outcome === undefined) {
        await this.stopOpenedCandidate(unsettled).catch(() => undefined);
        await this.options.store.settleDesignTurn({
          designId: run.taskId,
          turnId: turn.id,
          outcome: 'NEEDS_ATTENTION',
          failureReason: boundedReason(
            error,
            'The update could not produce a ready preview.'
          )
        });
      }
      this.emitUpdated(run.taskId, { reason: 'candidate-failed', runId });
    }
  }

  private async finishSourceAndPreview(
    run: RunRecord,
    initialTurn: DesignTurn
  ): Promise<void> {
    const detail = await this.options.store.getDesignDetail(run.taskId);
    const context = requireReadyContext(detail);
    const state = await this.options.store.snapshot();
    const before = state.gitSnapshots.find(
      (candidate) => candidate.id === run.beforeGitSnapshotId
    );
    if (!before || before.taskId !== run.taskId || before.worktreeId !== run.worktreeId) {
      throw new Error('Design run start evidence is unavailable.');
    }
    if (!before.headSha) {
      throw new Error('The Design run started without a source commit.');
    }
    const ownership: DesignSourceOwnership = {
      designId: run.taskId,
      repository: detail.repository,
      worktree: context.worktree,
      turnId: initialTurn.id,
      runId: run.id
    };
    let turn = initialTurn;
    let commitSha: string;
    let opened = turn.finalOpenedCandidate;

    if (turn.checkpoint?.boundary === 'POST_RUN_EVIDENCE_RECORDED') {
      const captured = await this.options.source.captureCandidate({
        ...ownership,
        expectedParentCommit: before.headSha
      });
      if (captured.kind === 'NO_CHANGE') {
        if (detail.revisions.length > 0) {
          await this.stopOpenedCandidate(turn).catch(() => undefined);
          await this.options.store.settleDesignTurn({
            designId: run.taskId,
            turnId: turn.id,
            outcome: 'NO_CHANGE'
          });
          return;
        }
        opened = requireFinalOpenedCandidate(turn);
        assertOpenedSourceMatchesCapture(opened, {
          repositoryId: detail.repository.id,
          worktreeId: context.worktree.id,
          branchName: context.worktree.branchName,
          expectedParentCommit: before.headSha,
          treeSha: captured.treeSha,
          candidateCommitSha: captured.commitSha
        });
        commitSha = captured.commitSha;
      } else {
        opened = requireFinalOpenedCandidate(turn);
        assertOpenedSourceMatchesCapture(opened, captured.checkpoint);
        turn = await this.options.store.updateDesignTurnCheckpoint({
          designId: run.taskId,
          turnId: turn.id,
          checkpoint: { boundary: 'SOURCE_CAPTURED', source: opened.source }
        });
        commitSha = await this.publishAndRepair(ownership, turn, opened);
        turn = (await this.options.store.getDesignDetail(run.taskId)).turns.find(
          (candidate) => candidate.id === turn.id
        )!;
      }
    } else if (
      turn.checkpoint?.boundary === 'SOURCE_CAPTURED' ||
      turn.checkpoint?.boundary === 'REF_UPDATED_INDEX_PENDING'
    ) {
      opened = requireFinalOpenedCandidate(turn);
      commitSha = await this.publishAndRepair(ownership, turn, opened);
      turn = (await this.options.store.getDesignDetail(run.taskId)).turns.find(
        (candidate) => candidate.id === turn.id
      )!;
    } else if (turn.checkpoint?.boundary === 'INDEX_REPAIRED') {
      opened = requireFinalOpenedCandidate(turn);
      assertOpenedSourceMatchesCapture(opened, turn.checkpoint.source);
      commitSha = turn.checkpoint.source.candidateCommitSha;
    } else if (turn.checkpoint?.boundary === 'PREVIEW_CANDIDATE_READY') {
      opened = requireFinalOpenedCandidate(turn);
      if (
        turn.checkpoint.commitSha !== opened.source.candidateCommitSha ||
        turn.checkpoint.previewGenerationId !== opened.previewGenerationId
      ) {
        throw new Error('The ready Preview candidate does not match the verified source.');
      }
      commitSha = turn.checkpoint.commitSha;
    } else {
      throw new Error('The Design turn cannot resume from its stored checkpoint.');
    }

    opened = requireFinalOpenedCandidate(turn);
    if (opened.source.candidateCommitSha !== commitSha) {
      throw new Error('The final source does not match the final verified candidate.');
    }
    const generation = await this.ensureOpenedCandidateAvailable({
      designId: run.taskId,
      turnId: turn.id,
      context,
      opened
    });
    if (turn.checkpoint?.boundary !== 'PREVIEW_CANDIDATE_READY') {
      turn = await this.options.store.updateDesignTurnCheckpoint({
        designId: run.taskId,
        turnId: turn.id,
        checkpoint: {
          boundary: 'PREVIEW_CANDIDATE_READY',
          previewGenerationId: generation.id,
          commitSha
        }
      });
    }
    await this.options.previews.cutoverManagedDesignCandidate({
      generationId: generation.id,
      designId: run.taskId,
      settlement: { turnId: turn.id, runId: run.id },
      fence: this.options.fence
    });
  }

  private async publishAndRepair(
    ownership: DesignSourceOwnership,
    initialTurn: DesignTurn,
    opened: DesignOpenedCandidateCheckpoint
  ): Promise<string> {
    let turn = initialTurn;
    let published: PublishedDesignCandidateCheckpoint;
    if (turn.checkpoint?.boundary === 'SOURCE_CAPTURED') {
      assertOpenedSourceMatchesCapture(opened, turn.checkpoint.source);
      published = await this.options.source.publishPreparedCandidateCommit({
        ...ownership,
        checkpoint: opened.source
      });
      try {
        turn = await this.options.store.updateDesignTurnCheckpoint({
          designId: ownership.designId,
          turnId: ownership.turnId,
          checkpoint: { boundary: 'REF_UPDATED_INDEX_PENDING', source: published }
        });
      } catch (error) {
        throw new RecoverableCheckpointWriteError(
          'REF_UPDATED_INDEX_PENDING',
          error
        );
      }
    } else if (turn.checkpoint?.boundary === 'REF_UPDATED_INDEX_PENDING') {
      assertOpenedSourceMatchesCapture(opened, turn.checkpoint.source);
      published = turn.checkpoint.source;
    } else {
      throw new Error('Design source publication has an invalid checkpoint.');
    }
    await this.options.source.repairCandidateIndex({
      ...ownership,
      checkpoint: published
    });
    try {
      await this.options.store.updateDesignTurnCheckpoint({
        designId: ownership.designId,
        turnId: ownership.turnId,
        checkpoint: { boundary: 'INDEX_REPAIRED', source: published }
      });
    } catch (error) {
      throw new RecoverableCheckpointWriteError('INDEX_REPAIRED', error);
    }
    await this.options.refreshGitEvidence(ownership.designId);
    return published.candidateCommitSha;
  }

  private async openCandidateUnlocked(runInput: RunRecord): Promise<DesignBrowserToolResult> {
    const run = await this.requireActiveDesignRun(runInput.id);
    const detail = await this.options.store.getDesignDetail(run.taskId);
    const turn = detail.turns.find((candidate) => candidate.id === run.generationKey);
    if (!turn || turn.outcome !== undefined) {
      throw new Error('The active Design turn is unavailable.');
    }
    const context = requireReadyContext(detail);
    const snapshot = await this.options.store.snapshot();
    const before = snapshot.gitSnapshots.find(
      (candidate) => candidate.id === run.beforeGitSnapshotId
    );
    if (!before?.headSha || before.taskId !== run.taskId || before.worktreeId !== run.worktreeId) {
      throw new Error('Design run start evidence is unavailable.');
    }
    const ownership: DesignSourceOwnership = {
      designId: run.taskId,
      repository: detail.repository,
      worktree: context.worktree,
      turnId: turn.id,
      runId: run.id
    };
    const captured = await this.options.source.captureCandidate({
      ...ownership,
      expectedParentCommit: before.headSha
    });
    const source: PublishedDesignCandidateCheckpoint =
      captured.kind === 'NO_CHANGE'
        ? {
            repositoryId: detail.repository.id,
            worktreeId: context.worktree.id,
            branchName: context.worktree.branchName,
            expectedParentCommit: before.headSha,
            treeSha: captured.treeSha,
            candidateCommitSha: captured.commitSha
          }
        : await this.options.source.prepareCandidateCommit({
            ...ownership,
            checkpoint: captured.checkpoint
          });

    await this.options.browser.closeRun(run.id).catch(() => undefined);
    let generation = await this.reusableOpenedGeneration(turn, source);
    if (!generation) {
      await this.stopOpenedCandidate(turn).catch(() => undefined);
      const prepared = await this.options.previews.prepareManagedDesignExactCommit({
        context,
        commitSha: source.candidateCommitSha
      });
      generation = await this.options.previews.executeManagedDesignCandidate(prepared, {
        designId: run.taskId,
        onCandidateReady: async () => undefined
      });
    }
    const lease = await this.options.previews.openManagedDesignBrowserLease(generation.id);
    try {
      const observation = await this.options.browser.openCandidate({
        designId: run.taskId,
        runId: run.id,
        generationId: generation.id,
        origin: lease.origin,
        lease
      });
      await this.options.store.updateDesignOpenedCandidate({
        designId: run.taskId,
        turnId: turn.id,
        candidate: { source, previewGenerationId: generation.id }
      });
      this.emitUpdated(run.taskId, {
        reason: 'candidate-opened-for-verification',
        runId: run.id
      });
      return { text: formatBrowserObservation(observation) };
    } catch (error) {
      await lease.close().catch(() => undefined);
      await this.options.browser.closeRun(run.id).catch(() => undefined);
      if (generation.id !== turn.finalOpenedCandidate?.previewGenerationId) {
        await this.options.previews.stopManagedDesignCandidate(generation.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async reusableOpenedGeneration(
    turn: DesignTurn,
    source: PublishedDesignCandidateCheckpoint
  ): Promise<PreviewGenerationRecord | undefined> {
    const opened = turn.finalOpenedCandidate;
    if (!opened || !sameSource(opened.source, source)) return undefined;
    const generation = await this.options.store.getPreviewGeneration(
      opened.previewGenerationId
    );
    return isLiveVerificationCandidate(generation, turn.designId, source)
      ? generation
      : undefined;
  }

  private async ensureOpenedCandidateAvailable(input: {
    designId: string;
    turnId: string;
    context: PreviewTaskContext;
    opened: DesignOpenedCandidateCheckpoint;
  }): Promise<PreviewGenerationRecord> {
    const existing = await this.options.store.getPreviewGeneration(
      input.opened.previewGenerationId
    );
    if (isLiveVerificationCandidate(existing, input.designId, input.opened.source)) {
      return existing;
    }
    const prepared = await this.options.previews.prepareManagedDesignExactCommit({
      context: input.context,
      commitSha: input.opened.source.candidateCommitSha
    });
    const replacement = await this.options.previews.executeManagedDesignCandidate(prepared, {
      designId: input.designId,
      onCandidateReady: async () => undefined
    });
    await this.options.store.updateDesignOpenedCandidate({
      designId: input.designId,
      turnId: input.turnId,
      candidate: {
        source: input.opened.source,
        previewGenerationId: replacement.id
      }
    });
    return replacement;
  }

  private async requireActiveDesignRun(runId: string): Promise<RunRecord> {
    const run = await this.options.store.getRun(runId);
    if (
      !run ||
      run.mode !== 'DESIGN' ||
      !['RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(run.status)
    ) {
      throw new Error('inspect_design requires the current active Design Run.');
    }
    const detail = await this.options.store.getDesignDetail(run.taskId);
    const turn = detail.turns.find((candidate) => candidate.id === run.generationKey);
    if (
      detail.task.kind !== 'DESIGN' ||
      !turn ||
      turn.outcome !== undefined ||
      turn.runId !== run.id ||
      detail.currentWorktree?.id !== run.worktreeId
    ) {
      throw new Error('inspect_design does not own this Design workspace.');
    }
    return run;
  }

  private async stopOpenedCandidate(turn: DesignTurn): Promise<void> {
    if (!turn.finalOpenedCandidate) return;
    const generation = await this.options.store.getPreviewGeneration(
      turn.finalOpenedCandidate.previewGenerationId
    );
    if (generation?.routingState === 'CANDIDATE') {
      await this.options.previews.stopManagedDesignCandidate(generation.id);
    }
  }

  private async recoverTurn(
    detail: DesignDetailSnapshot,
    turn: DesignTurn
  ): Promise<void> {
    let run = await this.options.store.getRunByGenerationKey(detail.design.id, turn.id);
    if (!run) {
      if (turn.checkpoint?.boundary === 'QUEUED') {
        if (this.accepting) await this.dispatchUnlocked(detail.design.id);
        return;
      }
      await this.options.store.settleDesignTurn({
        designId: detail.design.id,
        turnId: turn.id,
        outcome: 'NEEDS_ATTENTION',
        failureReason: 'The Design update lost its durable agent run.'
      });
      return;
    }
    if (!turn.runId) {
      await this.options.store.linkDesignTurnRun({
        designId: detail.design.id,
        turnId: turn.id,
        runId: run.id
      });
    }
    run = (await this.options.store.getRun(run.id)) ?? run;
    if (ACTIVE_RUN_STATUSES.has(run.status)) return;
    await this.settleRunUnlocked(run.id);
  }

  private async restartLatestReadyUnlocked(
    detail: DesignDetailSnapshot
  ): Promise<void> {
    const revision = detail.revisions.at(-1);
    if (!revision) {
      throw new Error('This Design does not have a ready revision to restart.');
    }
    const context = requireReadyContext(detail);
    await this.options.previews.restartManagedDesign({
      context,
      commitSha: revision.commitSha,
      designRevisionId: revision.id,
      fence: this.options.fence
    });
  }

  private async settleTerminalFailure(
    designId: string,
    turnId: string,
    run: RunRecord
  ): Promise<void> {
    await this.options.store.settleDesignTurn({
      designId,
      turnId,
      outcome: run.status === 'INTERRUPTED' ? 'CANCELED' : 'FAILED',
      failureReason:
        run.status === 'INTERRUPTED'
          ? undefined
          : boundedReason(run.terminalReason, 'The Design agent did not complete the update.')
    });
  }

  private emitUpdated(designId: string, payload: unknown): void {
    this.options.events.emit({
      type: 'design.updated',
      scope: { kind: 'DESIGN', designId },
      taskId: designId,
      payload,
      at: new Date().toISOString()
    });
  }

  private async dispatchNextUnlocked(designId: string): Promise<void> {
    if (!this.accepting || this.shuttingDown) return;
    await this.dispatchUnlocked(designId);
  }

  private assertAccepting(): void {
    if (!this.accepting || this.shuttingDown) {
      throw new Error('Design updates are not accepting work.');
    }
  }

  private withDesignLock<T>(designId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(designId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(work);
    this.locks.set(designId, operation);
    return operation.finally(() => {
      if (this.locks.get(designId) === operation) this.locks.delete(designId);
    });
  }
}

function requireReadyContext(detail: DesignDetailSnapshot): PreviewTaskContext {
  if (
    detail.task.kind !== 'DESIGN' ||
    !detail.currentIteration ||
    !detail.currentWorktree ||
    detail.currentWorktree.status !== 'PRESENT'
  ) {
    throw new Error('Design workspace is not ready.');
  }
  return {
    task: detail.task,
    iteration: detail.currentIteration,
    worktree: detail.currentWorktree
  };
}

function promptForTurn(
  detail: DesignDetailSnapshot,
  turn: DesignTurn,
  context: PreviewTaskContext,
  currentCommitSha: string
): string {
  const referenceContext = turn.referenceIds.map((referenceId) => {
    const reference = detail.references.find(
      (candidate) => candidate.id === referenceId
    );
    const attachment = reference
      ? detail.attachments.find(
          (candidate) => candidate.id === reference.attachmentId
        )
      : undefined;
    if (!reference || !attachment) {
      throw new Error('Design refinement reference context is unavailable.');
    }
    return reference.projectAssetPath
      ? `${attachment.displayName} (editable project asset: ${reference.projectAssetPath})`
      : attachment.displayName;
  });
  if (turn.messageSource === 'TASK_PROMPT') {
    return buildInitialDesignPrompt({
      task: context.task,
      worktree: context.worktree,
      initialCommitSha: currentCommitSha,
      referenceContext
    });
  }
  const entry = detail.conversation.find((candidate) => candidate.turn.id === turn.id);
  if (!entry) throw new Error('Design refinement message is unavailable.');
  const latestReadyCommitSha = detail.revisions.at(-1)?.commitSha ?? currentCommitSha;
  return buildDesignTurnPrompt({
    task: context.task,
    worktree: context.worktree,
    message: entry.userMessage,
    latestReadyCommitSha,
    referenceContext,
    recentConversation: detail.conversation
      .filter((candidate) => candidate.turn.order < turn.order)
      .slice(-6)
      .map((candidate) =>
        [
          `User: ${candidate.userMessage}`,
          candidate.assistantMessage ? `Codex: ${candidate.assistantMessage}` : undefined
        ]
          .filter(Boolean)
          .join('\n')
      )
  });
}

function isActiveReadyGeneration(
  generation: PreviewGenerationRecord | undefined
): boolean {
  return generation?.state === 'READY' && generation.routingState === 'ACTIVE';
}

function requireFinalOpenedCandidate(
  turn: DesignTurn
): DesignOpenedCandidateCheckpoint {
  if (!turn.finalOpenedCandidate) {
    throw new Error(
      'The Design agent did not open and verify its final source candidate.'
    );
  }
  return turn.finalOpenedCandidate;
}

function assertOpenedSourceMatchesCapture(
  opened: DesignOpenedCandidateCheckpoint,
  captured: {
    repositoryId: string;
    worktreeId: string;
    branchName: string;
    expectedParentCommit: string;
    treeSha: string;
    candidateCommitSha?: string;
  }
): void {
  if (
    opened.source.repositoryId !== captured.repositoryId ||
    opened.source.worktreeId !== captured.worktreeId ||
    opened.source.branchName !== captured.branchName ||
    opened.source.expectedParentCommit !== captured.expectedParentCommit ||
    opened.source.treeSha !== captured.treeSha ||
    (captured.candidateCommitSha !== undefined &&
      opened.source.candidateCommitSha !== captured.candidateCommitSha)
  ) {
    throw new Error(
      'The final Design source changed after the final candidate was opened.'
    );
  }
}

function sameSource(
  left: DesignOpenedCandidateCheckpoint['source'],
  right: DesignOpenedCandidateCheckpoint['source']
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.worktreeId === right.worktreeId &&
    left.branchName === right.branchName &&
    left.expectedParentCommit === right.expectedParentCommit &&
    left.treeSha === right.treeSha &&
    left.candidateCommitSha === right.candidateCommitSha
  );
}

function isLiveVerificationCandidate(
  generation: PreviewGenerationRecord | undefined,
  designId: string,
  source: DesignOpenedCandidateCheckpoint['source']
): generation is PreviewGenerationRecord {
  return Boolean(
    generation &&
      generation.taskId === designId &&
      generation.state === 'READY' &&
      generation.routingState === 'CANDIDATE' &&
      generation.source.type === 'EXACT_COMMIT' &&
      generation.source.commitSha === source.candidateCommitSha &&
      generation.source.designRevisionId === undefined
  );
}

function formatBrowserObservation(observation: {
  snapshot: string;
  console: string;
  errors: string;
}): string {
  return [
    `Snapshot:\n${observation.snapshot}`,
    `Console:\n${observation.console}`,
    `Runtime errors:\n${observation.errors}`
  ].join('\n\n');
}

function boundedReason(error: unknown, fallback: string): string {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : fallback;
  return message.length <= 1_000 ? message : `${message.slice(0, 997)}...`;
}
