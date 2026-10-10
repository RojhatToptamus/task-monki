import { randomUUID } from 'node:crypto';
import {
  TASK_INSTRUCTION_MAX_LENGTH,
  isImplementationRunMode,
  type AgentExecutionSettings,
  type AskSideQuestionRequest,
  type EndSideThreadRequest,
  type RunRecord,
  type StopSideQuestionRequest,
  type TaskDetailSnapshot,
  type TaskInstruction
} from '../../shared/contracts';
import {
  SIDE_QUESTION_CONVERSATION_LIMIT,
  buildSideQuestionPrompt,
  type SideQuestionPromptContext
} from '../../shared/promptTemplates';
import {
  SIDE_QUESTION_SNAPSHOT_MAX_FILE_BYTES,
  SIDE_QUESTION_SNAPSHOT_MAX_TOTAL_BYTES,
  runMayWriteTaskWorktree,
  sideQuestionForRun
} from '../../shared/sideQuestions';
import type { AgentOrchestrator } from '../agent/AgentOrchestrator';
import { ACTIVE_AGENT_RUN_STATUSES } from '../app/TaskTransitionPolicy';
import type {
  ReadOnlySnapshot,
  ReadOnlySnapshotOmissionReason,
  ReadOnlySnapshotService
} from '../git/ReadOnlySnapshotService';
import type { AppEventBus } from '../runner/AppEventBus';
import type { SqliteTaskStore } from '../storage/SqliteTaskStore';

export interface SideQuestionCoordinatorOptions {
  store: Pick<SqliteTaskStore, 'getTaskDetail' | 'getRun' | 'updateTaskInstructions'>;
  agents: Pick<AgentOrchestrator, 'startSideQuestion' | 'interruptRun'>;
  snapshots: Pick<ReadOnlySnapshotService, 'prepare' | 'remove' | 'removeTask'>;
  /** Reads a runtime-owned or Task-owned artifact, such as a run's final answer. */
  readArtifact(artifactId: string): Promise<string>;
  events: Pick<AppEventBus, 'emit'>;
  /** The task's implementation runtime, model and settings, made read-only. */
  questionSettings(detail: TaskDetailSnapshot): AgentExecutionSettings;
  assertRuntimeEnabled(runtimeId: string): void;
  /**
   * Runs `action` under the task's action lock, once the task's current action settles,
   * and inside a runtime operation, so provider admission follows the service's order.
   */
  withTaskLock<T>(taskId: string, action: () => Promise<T>): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTRUCTION_HISTORY_LIMIT = 1_000;
const THREAD_HISTORY_LIMIT = 6;
const OMISSION_REASONS: Record<ReadOnlySnapshotOmissionReason, string> = {
  LARGER_THAN_FILE_LIMIT: `larger than ${SIDE_QUESTION_SNAPSHOT_MAX_FILE_BYTES / 1024 / 1024} MiB`,
  TOTAL_LIMIT_REACHED: `the ${SIDE_QUESTION_SNAPSHOT_MAX_TOTAL_BYTES / 1024 / 1024} MiB snapshot limit was reached`,
  NOT_A_FILE: 'not a regular file'
};

interface QuestionTarget {
  record: TaskInstruction;
  threadId: string;
  settings: AgentExecutionSettings;
}

/**
 * Side questions to a task's implementation agent. Questions are durable `TaskInstruction`
 * records with role SIDE and a renderer-owned thread ID. Each is answered by one
 * SIDE_QUESTION run in a fresh read-only session on the task's runtime and model, beside
 * the main conversation. The run reads the live worktree, or a read-only snapshot of it
 * while implementation work can change the checkout. A thread's snapshot lives until the
 * thread ends, the task is archived or deleted, or the app stops.
 */
export class SideQuestionCoordinator {
  private readonly taskWork = new Map<string, Promise<unknown>>();
  /** Threads that ended while their question was still stopping: `<taskId>:<threadId>`. */
  private readonly endedThreads = new Set<string>();

  constructor(private readonly options: SideQuestionCoordinatorOptions) {}

  /** Records the question, then starts its answer run. A repeated message ID returns the recorded question. */
  ask(input: AskSideQuestionRequest): Promise<TaskInstruction> {
    const messageId = requireUuid(input.messageId, 'message');
    const threadId = requireUuid(input.threadId, 'thread');
    const text = questionText(input.text);
    return this.serialize(input.taskId, async () => {
      const detail = await this.options.store.getTaskDetail(input.taskId);
      const task = detail.task;
      if (task.kind !== 'NORMAL') throw new Error('Side questions are available only for tasks.');
      const existing = detail.taskInstructions.find((record) => record.id === messageId);
      if (existing && (existing.role !== 'SIDE' || existing.text !== text || existing.threadId !== threadId)) {
        throw new Error('This message ID has already been used for different content.');
      }
      const retry = Boolean(
        existing?.status === 'FAILED' && existing.runId && !detail.runs.some((run) => run.id === existing.runId)
      );
      if (existing && !retry) return existing;

      const { iteration, worktree } = questionWorktree(detail);
      if (detail.runs.some((run) => run.mode === 'SIDE_QUESTION' && ACTIVE_AGENT_RUN_STATUSES.has(run.status))) {
        throw new Error('Wait for the current side question to finish, or stop it.');
      }
      const settings = this.options.questionSettings(detail);
      this.options.assertRuntimeEnabled(settings.runtimeId ?? task.runtimeId);

      const runId = existing?.runId ?? randomUUID();
      const sessionId = existing?.sessionId ?? randomUUID();
      const record = await this.update(task.id, (records) => {
        if (existing) {
          const current = records.find((item) => item.id === existing.id);
          if (current?.status !== 'FAILED') throw new Error('The question is no longer waiting to send.');
          return Object.assign(current, {
            status: 'SENDING',
            detail: undefined,
            snapshotTakenAt: undefined,
            snapshotOmittedFileCount: undefined,
            updatedAt: now()
          });
        }
        if (records.some((item) => item.id === messageId)) throw new Error('Message already exists.');
        if (records.length >= INSTRUCTION_HISTORY_LIMIT) {
          throw new Error('This task has reached its message history limit. Start a new task.');
        }
        const at = now();
        const question: TaskInstruction = {
          id: messageId,
          taskId: task.id,
          iterationId: iteration.id,
          worktreeId: worktree.id,
          sourceRunId: runId,
          sessionId,
          order: Math.max(0, ...records.map((item) => item.order)) + 1,
          text,
          mode: 'FOLLOW_UP',
          status: 'SENDING',
          role: 'SIDE',
          threadId,
          runId,
          createdAt: at,
          updatedAt: at
        };
        records.push(question);
        return question;
      });
      try {
        const run = await this.admit({ record, threadId, settings }, detail);
        await this.receipt(record, { status: 'SUBMITTED', runId: run.id, sessionId: run.sessionId });
      } catch (error) {
        const admitted = await this.options.store.getRun(runId).catch(() => undefined);
        await this.receipt(record, admitted
          ? { status: 'SUBMITTED' }
          : { status: 'FAILED', detail: error instanceof Error ? error.message : String(error) }
        ).catch(() => undefined);
        throw error;
      }
      return (await this.options.store.getTaskDetail(task.id)).taskInstructions.find((item) => item.id === record.id)!;
    });
  }

  async stop(input: StopSideQuestionRequest): Promise<void> {
    const run = await this.options.store.getRun(input.runId);
    if (!run || run.taskId !== input.taskId || run.mode !== 'SIDE_QUESTION') {
      throw new Error('This side question is unavailable.');
    }
    if (!ACTIVE_AGENT_RUN_STATUSES.has(run.status)) return;
    await this.options.agents.interruptRun(run.id);
  }

  /**
   * Ends a side thread: stops its active question and removes its snapshot. The snapshot
   * of a question that is still stopping is removed when its run ends.
   */
  endThread(input: EndSideThreadRequest): Promise<void> {
    const threadId = requireUuid(input.threadId, 'thread');
    return this.serialize(input.taskId, async () => {
      const detail = await this.options.store.getTaskDetail(input.taskId).catch(() => undefined);
      const active = detail?.runs.find((run) =>
        run.mode === 'SIDE_QUESTION' &&
        ACTIVE_AGENT_RUN_STATUSES.has(run.status) &&
        sideQuestionForRun(detail.taskInstructions, run.id)?.threadId === threadId);
      if (active) {
        await this.options.agents.interruptRun(active.id);
        const after = await this.options.store.getRun(active.id);
        if (after && ACTIVE_AGENT_RUN_STATUSES.has(after.status)) {
          this.endedThreads.add(threadKey(input.taskId, threadId));
          return;
        }
      }
      await this.options.snapshots.remove(input.taskId, threadId);
    });
  }

  /** Removes the snapshot of a thread that ended while its question was stopping. */
  async handleRunTerminal(runId: string): Promise<void> {
    if (this.endedThreads.size === 0) return;
    const run = await this.options.store.getRun(runId);
    if (!run || run.mode !== 'SIDE_QUESTION' || ACTIVE_AGENT_RUN_STATUSES.has(run.status)) return;
    const detail = await this.options.store.getTaskDetail(run.taskId);
    const threadId = sideQuestionForRun(detail.taskInstructions, run.id)?.threadId;
    if (!threadId || !this.endedThreads.delete(threadKey(run.taskId, threadId))) return;
    await this.options.snapshots.remove(run.taskId, threadId);
  }

  /** Removes the task's snapshot, as when the task is archived or deleted. */
  async removeTask(taskId: string): Promise<void> {
    for (const key of [...this.endedThreads]) {
      if (key.startsWith(`${taskId}:`)) this.endedThreads.delete(key);
    }
    await this.options.snapshots.removeTask(taskId);
  }

  /**
   * Starts the answer run. The question reads the live worktree when no run can change
   * it; that admission holds the task lock, so other work waits for the question. When a
   * run can change the worktree, the question reads a snapshot instead, prepared outside
   * the task lock so the implementation agent stays controllable meanwhile.
   */
  private async admit(target: QuestionTarget, initial: TaskDetailSnapshot): Promise<RunRecord> {
    const taskId = target.record.taskId;
    if (!initial.runs.some(isWriterRun)) {
      const live = await this.options.withTaskLock(taskId, async () => {
        const current = await this.options.store.getTaskDetail(taskId);
        if (current.runs.some(isWriterRun)) return undefined;
        return this.start(current, target);
      });
      if (live) return live;
    }
    const { worktree } = questionWorktree(initial);
    const snapshot = await this.options.snapshots.prepare(taskId, target.threadId, worktree);
    try {
      return await this.options.withTaskLock(taskId, async () =>
        this.start(await this.options.store.getTaskDetail(taskId), target, snapshot));
    } catch (error) {
      // The thread keeps its snapshot for its next question unless the task cannot use it.
      const current = await this.options.store.getTaskDetail(taskId).catch(() => undefined);
      if (
        !current ||
        current.task.workflowPhase === 'ARCHIVED' ||
        current.task.currentWorktreeId !== target.record.worktreeId
      ) {
        await this.options.snapshots.remove(taskId, target.threadId).catch(() => undefined);
      }
      throw error;
    }
  }

  private async start(
    detail: TaskDetailSnapshot,
    target: QuestionTarget,
    snapshot?: ReadOnlySnapshot
  ): Promise<RunRecord> {
    const { iteration, worktree } = questionWorktree(detail);
    const record = detail.taskInstructions.find((item) => item.id === target.record.id);
    if (record?.status !== 'SENDING') throw new Error('The question is no longer waiting to send.');
    if (record.iterationId !== iteration.id || record.worktreeId !== worktree.id) {
      throw new Error('The task worktree changed. Ask the question again.');
    }
    const prompt = buildSideQuestionPrompt(await this.promptContext(detail, record, snapshot));
    if (snapshot) {
      // Recorded before admission: after a crash the question still reads as a snapshot reader.
      await this.receipt(record, {
        status: 'SENDING',
        snapshotTakenAt: snapshot.takenAt,
        ...(snapshot.omitted.length > 0 ? { snapshotOmittedFileCount: snapshot.omitted.length } : {})
      });
    }
    return this.options.agents.startSideQuestion({
      runId: record.runId!,
      sessionId: record.sessionId,
      task: detail.task,
      iteration,
      worktree,
      settings: target.settings,
      prompt,
      ...(snapshot ? { snapshotPath: snapshot.path } : {})
    });
  }

  private async promptContext(
    detail: TaskDetailSnapshot,
    record: TaskInstruction,
    snapshot: ReadOnlySnapshot | undefined
  ): Promise<SideQuestionPromptContext> {
    const iterationId = detail.task.currentIterationId;
    const implementationRuns = detail.runs
      .filter((run) => isImplementationRunMode(run.mode) && run.iterationId === iterationId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const implementationRunIds = new Set(implementationRuns.map((run) => run.id));
    const instructions = detail.taskInstructions
      .filter((item) =>
        item.role === undefined &&
        (item.status === 'SUBMITTED' || item.status === 'UNCERTAIN') &&
        item.runId !== undefined &&
        implementationRunIds.has(item.runId))
      .sort((left, right) => left.order - right.order)
      .slice(-SIDE_QUESTION_CONVERSATION_LIMIT)
      .map((item) => ({ author: 'PERSON' as const, text: item.text, at: item.createdAt }));
    const answers = (await Promise.all(
      implementationRuns
        .filter((run) => run.status === 'COMPLETED')
        .slice(-SIDE_QUESTION_CONVERSATION_LIMIT)
        .map(async (run) => ({
          author: 'AGENT' as const,
          text: run.finalMessage?.trim() ||
            (run.finalArtifactId ? (await this.options.readArtifact(run.finalArtifactId).catch(() => '')).trim() : ''),
          at: run.endedAt ?? run.startedAt
        }))
    )).filter((entry) => entry.text);
    const conversation = [...instructions, ...answers]
      .sort((left, right) => left.at.localeCompare(right.at))
      .map(({ author, text }) => ({ author, text }));
    const plan = detail.agentPlanRevisions
      .filter((revision) => implementationRunIds.has(revision.runId))
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.revision - right.revision)
      .at(-1);
    const git = detail.gitSnapshots
      .filter((item) => item.iterationId === iterationId)
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
      .at(-1);
    const { worktree } = questionWorktree(detail);
    return {
      task: { title: detail.task.title, request: detail.task.prompt },
      conversation,
      ...(plan ? { plan: { ...(plan.explanation ? { explanation: plan.explanation } : {}), steps: plan.steps } } : {}),
      implementationActive: detail.runs.some(isWriterRun),
      diffStat: git?.diffStat.trim() || 'No diff stat was recorded.',
      checkout: {
        path: snapshot?.path ?? worktree.worktreePath,
        ...(snapshot
          ? {
              snapshot: {
                takenAt: snapshot.takenAt,
                omittedFiles: snapshot.omitted.map((file) => ({ path: file.path, reason: OMISSION_REASONS[file.reason] }))
              }
            }
          : {})
      },
      history: await this.threadHistory(detail, record),
      question: record.text
    };
  }

  /** Earlier answered questions in the thread, oldest first. */
  private async threadHistory(
    detail: TaskDetailSnapshot,
    record: TaskInstruction
  ): Promise<SideQuestionPromptContext['history']> {
    const answered = detail.taskInstructions
      .filter((item) =>
        item.role === 'SIDE' && item.threadId === record.threadId && item.id !== record.id && item.status === 'SUBMITTED')
      .sort((left, right) => left.order - right.order)
      .flatMap((item) => {
        const run = detail.runs.find((candidate) => candidate.id === item.runId);
        return run?.mode === 'SIDE_QUESTION' && run.status === 'COMPLETED' ? [{ item, run }] : [];
      })
      .slice(-THREAD_HISTORY_LIMIT);
    return Promise.all(answered.map(async ({ item, run }) => ({
      question: item.text,
      answer: (await this.options.readArtifact(run.outputArtifactId).catch(() => '')).trim() ||
        '(No answer text was recorded.)'
    })));
  }

  private receipt(
    record: TaskInstruction,
    update: Partial<Pick<TaskInstruction, 'status' | 'runId' | 'sessionId' | 'detail' | 'snapshotTakenAt' | 'snapshotOmittedFileCount'>>
  ): Promise<TaskInstruction> {
    return this.update(record.taskId, (records) => {
      const current = records.find((item) => item.id === record.id);
      if (!current) throw new Error('The question receipt is missing.');
      return Object.assign(current, { detail: undefined, ...update, updatedAt: now() });
    });
  }

  private async update<T>(taskId: string, mutate: (records: TaskInstruction[]) => T): Promise<T> {
    const result = await this.options.store.updateTaskInstructions(taskId, (records) => mutate(records));
    this.options.events.emit({ type: 'task.updated', taskId, payload: { instructionsChanged: true }, at: now() });
    return structuredClone(result);
  }

  /** One question or thread change per task at a time, so admission checks cannot interleave. */
  private serialize<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.taskWork.get(taskId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(action);
    const settled = work.catch(() => undefined);
    this.taskWork.set(taskId, settled);
    void settled.then(() => {
      if (this.taskWork.get(taskId) === settled) this.taskWork.delete(taskId);
    });
    return work;
  }
}

/** An active run that can change the task's live worktree. */
function isWriterRun(run: RunRecord): boolean {
  return ACTIVE_AGENT_RUN_STATUSES.has(run.status) && runMayWriteTaskWorktree(run);
}

function questionWorktree(detail: TaskDetailSnapshot) {
  const task = detail.task;
  if (task.workflowPhase === 'ARCHIVED') throw new Error('Side questions are unavailable for an archived task.');
  const iteration = detail.iterations.find((candidate) => candidate.id === task.currentIterationId);
  const worktree = detail.worktrees.find((candidate) => candidate.id === task.currentWorktreeId);
  if (!iteration || !worktree || worktree.iterationId !== iteration.id) {
    throw new Error('Prepare the task worktree before asking a side question.');
  }
  if (worktree.status !== 'PRESENT') {
    throw new Error(worktree.error ?? 'The task worktree is unavailable. Restore it before asking a side question.');
  }
  return { iteration, worktree };
}

function threadKey(taskId: string, threadId: string): string {
  return `${taskId}:${threadId}`;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`A valid ${label} ID is required.`);
  return value;
}

function questionText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.length > TASK_INSTRUCTION_MAX_LENGTH) {
    throw new Error(`Write a question of at most ${TASK_INSTRUCTION_MAX_LENGTH.toLocaleString()} characters.`);
  }
  return text.trim();
}

function now(): string {
  return new Date().toISOString();
}
