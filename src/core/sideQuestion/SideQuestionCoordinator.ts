import { randomUUID } from 'node:crypto';
import {
  TASK_INSTRUCTION_MAX_LENGTH,
  effectiveReviewFindings,
  effectiveReviewGateStatus,
  isImplementationRunMode,
  parsePullRequestFeedback,
  parseReviewWalkthrough,
  type AgentExecutionSettings,
  type AskSideQuestionRequest,
  type AskSubject,
  type EndSideThreadRequest,
  type RunRecord,
  type SideQuestionModelChoice,
  type StopSideQuestionRequest,
  type TaskDetailSnapshot,
  type TaskInstruction
} from '../../shared/contracts';
import {
  taskGoal,
  SIDE_QUESTION_CONVERSATION_LIMIT,
  SIDE_QUESTION_HISTORY_LIMIT,
  buildSideQuestionPrompt,
  type SideQuestionPromptContext
} from '../../shared/promptTemplates';
import { sideQuestionForRun } from '../../shared/sideQuestions';
import { UNTRACKED_SNAPSHOT_MAX_FILE_BYTES, UNTRACKED_SNAPSHOT_MAX_TOTAL_BYTES } from '../git/ReadOnlySnapshotService';
import type { AgentOrchestrator } from '../agent/AgentOrchestrator';
import { ACTIVE_AGENT_RUN_STATUSES, isActiveWorktreeWriter } from '../app/TaskTransitionPolicy';
import type {
  ReadOnlySnapshot,
  ReadOnlySnapshotOmissionReason,
  ReadOnlySnapshotService
} from '../git/ReadOnlySnapshotService';
import type { AppEventBus } from '../runner/AppEventBus';
import type { SqliteTaskStore } from '../storage/SqliteTaskStore';
import { parseReviewedDiff, reviewedDiffExcerpt } from '../review/ReviewedDiff';
import { runReplyText } from '../agent/runReply';

export interface SideQuestionCoordinatorOptions {
  store: Pick<SqliteTaskStore, 'getTaskDetail' | 'getRun' | 'updateTaskInstructions'>;
  agents: Pick<AgentOrchestrator, 'startSideQuestion' | 'interruptRun'>;
  snapshots: Pick<ReadOnlySnapshotService, 'prepare' | 'remove'>;
  /** Reads a runtime-owned or Task-owned artifact, such as a run's final answer. */
  readArtifact(artifactId: string): Promise<string>;
  events: Pick<AppEventBus, 'emit'>;
  /**
   * The settings a question runs with, always read-only: the chosen runtime and model, or
   * the task's implementation runtime and model when none was chosen.
   */
  questionSettings(detail: TaskDetailSnapshot, choice?: SideQuestionModelChoice): AgentExecutionSettings;
  assertRuntimeEnabled(runtimeId: string): void;
  /**
   * Runs `action` under the task's action lock, once the task's current action settles,
   * and inside a runtime operation, so provider admission follows the service's order.
   */
  withTaskLock<T>(taskId: string, action: () => Promise<T>): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTRUCTION_HISTORY_LIMIT = 1_000;
const OMISSION_REASONS: Record<ReadOnlySnapshotOmissionReason, string> = {
  LARGER_THAN_FILE_LIMIT: `larger than ${UNTRACKED_SNAPSHOT_MAX_FILE_BYTES / 1024 / 1024} MiB`,
  TOTAL_LIMIT_REACHED: `the ${UNTRACKED_SNAPSHOT_MAX_TOTAL_BYTES / 1024 / 1024} MiB snapshot limit was reached`,
  NOT_A_FILE: 'not a regular file',
  CHANGED_DURING_SNAPSHOT: 'changed while the snapshot was taken'
};

interface QuestionTarget {
  record: TaskInstruction;
  threadId: string;
  settings: AgentExecutionSettings;
}

/**
 * Ask: side questions about a task, on every task tab. Questions are durable
 * `TaskInstruction` records with role SIDE and a renderer-owned thread ID, optionally
 * about a subject (a finding of the current review, lines of the diff, a section of the
 * review's walkthrough, a changed file, or a thread of the pull request). Each is
 * answered by one SIDE_QUESTION run in a fresh read-only session on the task's runtime,
 * beside the main conversation, with the recent conversation and the current review in
 * its prompt. The run reads the live worktree, or a read-only snapshot of it while
 * implementation work can change the checkout. A thread's snapshot lives until the
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
    const choice = modelChoice(input.model);
    const subject = askSubject(input.subject);
    return this.serialize(input.taskId, async () => {
      const detail = await this.options.store.getTaskDetail(input.taskId);
      const task = detail.task;
      if (task.kind !== 'NORMAL') throw new Error('Ask is available only for tasks.');
      const existing = detail.taskInstructions.find((record) => record.id === messageId);
      if (existing && (
        existing.role !== 'SIDE' || existing.text !== text || existing.threadId !== threadId ||
        JSON.stringify(existing.subject) !== JSON.stringify(subject)
      )) {
        throw new Error('This message ID has already been used for different content.');
      }
      const retry = Boolean(
        existing?.status === 'FAILED' && existing.runId && !detail.runs.some((run) => run.id === existing.runId)
      );
      if (existing && !retry) return existing;

      const { iteration, worktree } = questionWorktree(detail);
      // A subject that is no longer the task's is refused before anything is recorded.
      if (subject?.kind === 'FINDING') findingSubject(detail, subject);
      if (subject?.kind === 'STAGE') await this.stageSubject(detail, subject);
      if (subject?.kind === 'THREAD') await this.threadSubject(detail, subject);
      if (detail.runs.some((run) => run.mode === 'SIDE_QUESTION' && ACTIVE_AGENT_RUN_STATUSES.has(run.status))) {
        throw new Error('Wait for the current answer to finish, or stop it.');
      }
      const settings = this.options.questionSettings(detail, choice);
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
          ...(subject ? { subject } : {}),
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
      throw new Error('This question is unavailable.');
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
    await this.options.snapshots.remove(taskId);
  }

  /**
   * Starts the answer run. The question reads the live worktree when no run can change
   * it; that admission holds the task lock, so other work waits for the question. When a
   * run can change the worktree, the question reads a snapshot instead, prepared outside
   * the task lock so the implementation agent stays controllable meanwhile.
   */
  private async admit(target: QuestionTarget, initial: TaskDetailSnapshot): Promise<RunRecord> {
    const taskId = target.record.taskId;
    if (!initial.runs.some(isActiveWorktreeWriter)) {
      const live = await this.options.withTaskLock(taskId, async () => {
        const current = await this.options.store.getTaskDetail(taskId);
        if (current.runs.some(isActiveWorktreeWriter)) return undefined;
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
          text: await runReplyText(run, this.options.readArtifact),
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
    const git = latestCapture(detail);
    const { worktree } = questionWorktree(detail);
    return {
      task: { title: detail.task.title, request: taskGoal(detail.task) },
      conversation,
      ...(plan ? { plan: { ...(plan.explanation ? { explanation: plan.explanation } : {}), steps: plan.steps } } : {}),
      implementationActive: detail.runs.some(isActiveWorktreeWriter),
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
      ...reviewContext(detail),
      ...(record.subject ? { subject: await this.subjectContext(detail, record.subject) } : {}),
      question: record.text
    };
  }

  /**
   * The subject with what it is about: a finding with the reviewed capture's diff,
   * lines or a file with the latest capture's, a walkthrough section as written,
   * and a thread as quoted data.
   */
  private async subjectContext(
    detail: TaskDetailSnapshot,
    subject: AskSubject
  ): Promise<NonNullable<SideQuestionPromptContext['subject']>> {
    switch (subject.kind) {
      case 'FINDING': {
        const { finding, reviewedSnapshotId } = findingSubject(detail, subject);
        const snapshot = detail.gitSnapshots.find((candidate) => candidate.id === reviewedSnapshotId);
        const diff = finding.path ? await this.diffExcerpt(snapshot?.diffArtifactId, finding.path, finding.line) : undefined;
        return { kind: 'FINDING', finding, ...(diff ? { diff } : {}) };
      }
      case 'LINES':
      case 'FILE': {
        const line = subject.kind === 'LINES' && subject.side === 'NEW' ? subject.line : undefined;
        const diff = await this.diffExcerpt(latestCapture(detail)?.diffArtifactId, subject.path, line);
        return { ...subject, ...(diff ? { diff } : {}) };
      }
      case 'STAGE': {
        const { walkthrough, section } = await this.stageSubject(detail, subject);
        return { kind: 'STAGE', number: subject.section + 1, count: walkthrough.sections.length, section };
      }
      case 'THREAD': {
        const { feedback, discussion } = await this.threadSubject(detail, subject);
        return {
          kind: 'THREAD',
          provider: feedback.provider,
          discussion,
          ...(feedback.viewer ? { viewer: feedback.viewer } : {}),
          // Its authors cannot know this boundary, so their words cannot end their own quote.
          boundary: randomUUID()
        };
      }
    }
  }

  /** A stage names a section of the walkthrough the review gate shows, current or kept as earlier context. */
  private async stageSubject(detail: TaskDetailSnapshot, subject: Extract<AskSubject, { kind: 'STAGE' }>) {
    const stored = detail.task.projection.agentReview?.walkthrough;
    if (stored?.status !== 'STORED' || stored.reviewRunId !== subject.reviewRunId) {
      throw new Error('This walkthrough is no longer the task’s.');
    }
    const text = await this.options.readArtifact(stored.artifactId).catch(() => '');
    const walkthrough = parseReviewWalkthrough(text, stored.reviewRunId);
    const section = walkthrough?.sections[subject.section];
    if (!walkthrough || !section) throw new Error('This section is not part of the walkthrough.');
    return { walkthrough, section };
  }

  /** A thread names a discussion of the task's pull request, as last read. */
  private async threadSubject(detail: TaskDetailSnapshot, subject: Extract<AskSubject, { kind: 'THREAD' }>) {
    const rollup = detail.reviewRollups
      .filter((record) => record.iterationId === detail.task.currentIterationId)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
      .at(-1);
    const number = rollup?.pullRequestNumber;
    const text = rollup?.feedback ? await this.options.readArtifact(rollup.feedback.artifactId).catch(() => '') : '';
    const feedback = number === undefined ? undefined : parsePullRequestFeedback(text, number);
    const discussion = feedback?.discussions.find((candidate) => candidate.id === subject.discussionId);
    if (!feedback || !discussion) throw new Error('This discussion is no longer part of the pull request.');
    return { feedback, discussion };
  }

  private async diffExcerpt(artifactId: string | undefined, path: string, line?: number): Promise<string | undefined> {
    if (!artifactId) return undefined;
    const text = await this.options.readArtifact(artifactId).catch(() => '');
    const file = parseReviewedDiff(text).find((candidate) => candidate.path === path);
    return file ? reviewedDiffExcerpt(file, line) : undefined;
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
      .slice(-SIDE_QUESTION_HISTORY_LIMIT);
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
function questionWorktree(detail: TaskDetailSnapshot) {
  const task = detail.task;
  if (task.workflowPhase === 'ARCHIVED') throw new Error('Ask is unavailable for an archived task.');
  const iteration = detail.iterations.find((candidate) => candidate.id === task.currentIterationId);
  const worktree = detail.worktrees.find((candidate) => candidate.id === task.currentWorktreeId);
  if (!iteration || !worktree || worktree.iterationId !== iteration.id) {
    throw new Error('Prepare the task worktree before asking.');
  }
  if (worktree.status !== 'PRESENT') {
    throw new Error(worktree.error ?? 'The task worktree is unavailable. Restore it before asking.');
  }
  return { iteration, worktree };
}

function threadKey(taskId: string, threadId: string): string {
  return `${taskId}:${threadId}`;
}

/** Task Monki's latest Git capture of the task's current iteration. */
function latestCapture(detail: TaskDetailSnapshot) {
  return detail.gitSnapshots
    .filter((item) => item.iterationId === detail.task.currentIterationId)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .at(-1);
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`A valid ${label} ID is required.`);
  return value;
}

const MODEL_CHOICE_FIELD_MAX_LENGTH = 200;

/** A chosen runtime and model, checked for shape; whether they can run is the runtime's to say. */
function modelChoice(value: unknown): SideQuestionModelChoice | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a valid model to ask.');
  const record = value as Record<string, unknown>;
  const field = (key: string, required: boolean): string | undefined => {
    const item = record[key];
    if (item === undefined && !required) return undefined;
    if (typeof item !== 'string' || !item.trim() || item.length > MODEL_CHOICE_FIELD_MAX_LENGTH) {
      throw new Error('Choose a valid model to ask.');
    }
    return item.trim();
  };
  return {
    runtimeId: field('runtimeId', true)!,
    model: field('model', false),
    modelProvider: field('modelProvider', false),
    reasoningEffort: field('reasoningEffort', false)
  };
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

/** The task's finished review, as an Ask answer reads it: its status after decisions, summary and findings. */
function reviewContext(detail: TaskDetailSnapshot): Pick<SideQuestionPromptContext, 'review'> {
  const gate = detail.task.projection.agentReview;
  if (!gate?.runId || gate.status === 'NOT_RUN' || gate.status === 'RUNNING') return {};
  const findings = effectiveReviewFindings(gate.result, gate.findingDecisions ?? []);
  const summary = gate.result?.summary ?? gate.summary;
  if (findings.length === 0 && !summary) return {};
  return { review: { status: effectiveReviewGateStatus(gate), ...(summary ? { summary } : {}), findings } };
}

/** A finding subject names a finding of the task's current review, out of date or not. */
function findingSubject(detail: TaskDetailSnapshot, subject: Extract<AskSubject, { kind: 'FINDING' }>) {
  const gate = detail.task.projection.agentReview;
  if (!gate?.runId || gate.runId !== subject.reviewRunId) {
    throw new Error('This finding is no longer part of the task’s current review.');
  }
  const finding = effectiveReviewFindings(gate.result, gate.findingDecisions ?? [])
    .find((candidate) => candidate.id === subject.findingId);
  if (!finding) throw new Error('This finding is not part of the review.');
  return { finding, reviewedSnapshotId: gate.reviewedGitSnapshotId };
}

const SUBJECT_TEXT_MAX_LENGTH = 1_000;
const SUBJECT_LINE_MAX = 10_000_000;

/**
 * A subject checked for shape; whether a finding, a walkthrough section or a thread
 * still exists is checked against the task.
 */
function askSubject(value: unknown): AskSubject | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new Error('Ask about a valid finding, section, file, thread or line range.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const text = (key: string) => {
    const item = record[key];
    if (typeof item !== 'string' || !item.trim() || item.length > SUBJECT_TEXT_MAX_LENGTH || item.trim() !== item) throw invalid();
    return item;
  };
  const line = (key: string, required: boolean) => {
    const item = record[key];
    if (item === undefined && !required) return undefined;
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > SUBJECT_LINE_MAX) throw invalid();
    return item;
  };
  if (record.kind === 'FINDING') {
    return { kind: 'FINDING', reviewRunId: requireUuid(record.reviewRunId, 'review run'), findingId: text('findingId') };
  }
  if (record.kind === 'LINES') {
    if (record.side !== 'NEW' && record.side !== 'OLD') throw invalid();
    const start = line('line', true)!;
    const end = line('endLine', false);
    if (end !== undefined && end <= start) throw invalid();
    return { kind: 'LINES', path: text('path'), side: record.side, line: start, ...(end !== undefined ? { endLine: end } : {}) };
  }
  if (record.kind === 'STAGE') {
    const section = record.section;
    if (typeof section !== 'number' || !Number.isSafeInteger(section) || section < 0) throw invalid();
    return { kind: 'STAGE', reviewRunId: requireUuid(record.reviewRunId, 'review run'), section };
  }
  if (record.kind === 'FILE') return { kind: 'FILE', path: text('path') };
  if (record.kind === 'THREAD') return { kind: 'THREAD', discussionId: text('discussionId') };
  throw invalid();
}
