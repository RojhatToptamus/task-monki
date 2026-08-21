import type {
  DesignDetailSnapshot,
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
    const work = this.options.store.getRun(runId).then((run) => {
      if (!run || run.mode !== 'DESIGN') return;
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

  withExclusiveAccess<T>(designId: string, operation: () => Promise<T>): Promise<T> {
    this.assertAccepting();
    return this.withDesignLock(designId, operation);
  }

  async beginShutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.accepting = false;
    this.shuttingDown = true;
    const snapshot = await this.options.store.snapshot();
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
      await this.settleTerminalFailure(run.taskId, turn.id, run);
      this.emitUpdated(run.taskId, { reason: 'run-failed', runId });
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
      if (unsettled?.outcome === undefined) {
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

    if (turn.checkpoint?.boundary === 'POST_RUN_EVIDENCE_RECORDED') {
      const captured = await this.options.source.captureCandidate({
        ...ownership,
        expectedParentCommit: before.headSha
      });
      if (captured.kind === 'NO_CHANGE') {
        if (detail.revisions.length > 0) {
          await this.options.store.settleDesignTurn({
            designId: run.taskId,
            turnId: turn.id,
            outcome: 'NO_CHANGE'
          });
          return;
        }
        commitSha = captured.commitSha;
      } else {
        turn = await this.options.store.updateDesignTurnCheckpoint({
          designId: run.taskId,
          turnId: turn.id,
          checkpoint: { boundary: 'SOURCE_CAPTURED', source: captured.checkpoint }
        });
        commitSha = await this.publishAndRepair(ownership, turn);
        turn = (await this.options.store.getDesignDetail(run.taskId)).turns.find(
          (candidate) => candidate.id === turn.id
        )!;
      }
    } else if (
      turn.checkpoint?.boundary === 'SOURCE_CAPTURED' ||
      turn.checkpoint?.boundary === 'REF_UPDATED_INDEX_PENDING'
    ) {
      commitSha = await this.publishAndRepair(ownership, turn);
      turn = (await this.options.store.getDesignDetail(run.taskId)).turns.find(
        (candidate) => candidate.id === turn.id
      )!;
    } else if (turn.checkpoint?.boundary === 'INDEX_REPAIRED') {
      commitSha = turn.checkpoint.source.candidateCommitSha;
    } else if (turn.checkpoint?.boundary === 'PREVIEW_CANDIDATE_READY') {
      commitSha = turn.checkpoint.commitSha;
    } else {
      throw new Error('The Design turn cannot resume from its stored checkpoint.');
    }

    const prepared = await this.options.previews.prepareManagedDesignExactCommit({
      context,
      commitSha
    });
    await this.options.previews.executeManagedDesign(prepared, {
      designId: run.taskId,
      settlement: { turnId: turn.id, runId: run.id },
      fence: this.options.fence,
      onCandidateReady: async (generation) => {
        await this.options.store.updateDesignTurnCheckpoint({
          designId: run.taskId,
          turnId: turn.id,
          checkpoint: {
            boundary: 'PREVIEW_CANDIDATE_READY',
            previewGenerationId: generation.id,
            commitSha
          }
        });
      }
    });
  }

  private async publishAndRepair(
    ownership: DesignSourceOwnership,
    initialTurn: DesignTurn
  ): Promise<string> {
    let turn = initialTurn;
    let published: PublishedDesignCandidateCheckpoint;
    if (turn.checkpoint?.boundary === 'SOURCE_CAPTURED') {
      published = await this.options.source.publishCandidateCommit({
        ...ownership,
        checkpoint: turn.checkpoint.source
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
  if (turn.messageSource === 'TASK_PROMPT') {
    return buildInitialDesignPrompt({
      task: context.task,
      worktree: context.worktree,
      initialCommitSha: currentCommitSha
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

function boundedReason(error: unknown, fallback: string): string {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : fallback;
  return message.length <= 1_000 ? message : `${message.slice(0, 997)}...`;
}
