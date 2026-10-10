import { randomUUID } from 'node:crypto';
import {
  REVIEW_FINDING_TEXT_MAX_LENGTH,
  TASK_INSTRUCTION_MAX_LENGTH,
  effectiveReviewFindings,
  reviewAcceptsDecisions,
  splitReviewerReply,
  type AgentExecutionSettings,
  type AgentReviewGateProjection,
  type AskReviewerRequest,
  type DecideReviewFindingRequest,
  type EffectiveReviewFinding,
  type ReviewFindingDecision,
  type RunRecord,
  type StopReviewerQuestionRequest,
  type Task,
  type TaskDetailSnapshot,
  type TaskInstruction
} from '../../shared/contracts';
import {
  buildReviewQuestionPrompt,
  type ReviewQuestionPromptContext
} from '../../shared/promptTemplates';
import type { AgentOrchestrator } from '../agent/AgentOrchestrator';
import { ACTIVE_AGENT_RUN_STATUSES } from '../app/TaskTransitionPolicy';
import type { AppEventBus } from '../runner/AppEventBus';
import type { SqliteTaskStore } from '../storage/SqliteTaskStore';
import {
  formatReviewedDiffStat,
  parseReviewedDiff,
  reviewedDiffExcerpt
} from './ReviewedDiff';

export interface AgentReviewCoordinatorOptions {
  store: Pick<
    SqliteTaskStore,
    'getTaskDetail' | 'getRun' | 'updateTaskInstructions' | 'recordReviewFindingDecisions' | 'readArtifact'
  >;
  agents: Pick<AgentOrchestrator, 'startReviewQuestion' | 'interruptRun'>;
  /** Reads a runtime-owned artifact, such as a question run's answer output. */
  readRuntimeArtifact(artifactId: string): Promise<string>;
  events: Pick<AppEventBus, 'emit'>;
  /** The review's runtime, model and read-only settings for a question about it. */
  questionSettings(task: Task, reviewRun: RunRecord): AgentExecutionSettings;
  assertRuntimeEnabled(runtimeId: string): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINDING_ID_MAX_LENGTH = 200;
const INSTRUCTION_HISTORY_LIMIT = 1_000;

/**
 * The person's side of a completed review: dismissing and restoring findings, and
 * asking the reviewer. Questions are durable `TaskInstruction` records with role
 * REVIEW. Each is answered by one REVIEW_QUESTION run in a fresh read-only session
 * on the review's runtime and model; the answer may revise findings only through
 * the validated revision block the orchestrator applies when the run completes.
 */
export class AgentReviewCoordinator {
  constructor(private readonly options: AgentReviewCoordinatorOptions) {}

  async decide(input: DecideReviewFindingRequest): Promise<ReviewFindingDecision> {
    if (input.kind !== 'DISMISS' && input.kind !== 'RESTORE') {
      throw new Error('A finding can only be dismissed or restored.');
    }
    if (input.note !== undefined && typeof input.note !== 'string') throw new Error('A note must be text.');
    const note = input.note?.trim();
    if (input.kind === 'RESTORE' && note) throw new Error('Only a dismissal takes a note.');
    if (note && note.length > REVIEW_FINDING_TEXT_MAX_LENGTH) {
      throw new Error(`Keep the note to at most ${REVIEW_FINDING_TEXT_MAX_LENGTH} characters.`);
    }
    let decision: ReviewFindingDecision | undefined;
    await this.options.store.recordReviewFindingDecisions(input.taskId, (task) => {
      const gate = task.projection.agentReview;
      assertCurrentReview(gate, input.reviewRunId);
      const finding = effectiveReviewFindings(gate?.result, gate?.findingDecisions ?? [])
        .find((candidate) => candidate.id === input.findingId);
      if (!finding) throw new Error('This finding is not part of the review.');
      if (finding.state === 'WITHDRAWN') throw new Error('The reviewer withdrew this finding.');
      if (input.kind === 'DISMISS' && finding.state !== 'OPEN') {
        throw new Error('This finding is already dismissed.');
      }
      if (input.kind === 'RESTORE' && finding.state !== 'DISMISSED') {
        throw new Error('Only a dismissed finding can be restored.');
      }
      decision = {
        id: randomUUID(),
        reviewRunId: input.reviewRunId,
        findingId: finding.id,
        kind: input.kind,
        actor: 'USER',
        ...(input.kind === 'DISMISS' && note ? { note } : {}),
        createdAt: new Date().toISOString()
      };
      return [decision];
    });
    this.emitTaskUpdate(input.taskId, { reviewFindingsDecided: true });
    return decision!;
  }

  /** Records the question, then starts its answer run. A repeated message ID returns the recorded question. */
  async ask(input: AskReviewerRequest): Promise<TaskInstruction> {
    if (typeof input.messageId !== 'string' || !UUID.test(input.messageId)) {
      throw new Error('A valid message ID is required.');
    }
    const text = questionText(input.text);
    const findingId = input.findingId === undefined ? undefined : requireFindingId(input.findingId);
    const detail = await this.options.store.getTaskDetail(input.taskId);
    const task = detail.task;
    if (task.kind !== 'NORMAL') throw new Error('Only a task review has a reviewer to ask.');
    const existing = detail.taskInstructions.find((record) => record.id === input.messageId);
    if (
      existing &&
      (existing.role !== 'REVIEW' ||
        existing.text !== text ||
        existing.reviewRunId !== input.reviewRunId ||
        existing.findingId !== findingId)
    ) {
      throw new Error('This message ID has already been used for different content.');
    }
    const retry = Boolean(
      existing?.status === 'FAILED' && existing.runId && !detail.runs.some((run) => run.id === existing.runId)
    );
    if (existing && !retry) return existing;

    const gate = task.projection.agentReview;
    assertCurrentReview(gate, input.reviewRunId);
    const findings = effectiveReviewFindings(gate?.result, gate?.findingDecisions ?? []);
    const focused = findingId ? findings.find((finding) => finding.id === findingId) : undefined;
    if (findingId && !focused) throw new Error('This finding is not part of the review.');
    if (detail.runs.some((run) => run.mode === 'REVIEW_QUESTION' && ACTIVE_AGENT_RUN_STATUSES.has(run.status))) {
      throw new Error('Wait for the reviewer to answer the current question.');
    }
    const reviewRun = detail.runs.find((run) => run.id === input.reviewRunId && run.mode === 'REVIEW');
    const iteration = detail.iterations.find((candidate) => candidate.id === reviewRun?.iterationId);
    const worktree = detail.worktrees.find((candidate) => candidate.id === reviewRun?.worktreeId);
    if (!reviewRun || !iteration || !worktree) throw new Error('The review run is unavailable.');
    if (iteration.id !== task.currentIterationId || worktree.id !== task.currentWorktreeId) {
      throw new Error('The task worktree changed after this review. Run the review again.');
    }
    const settings = this.options.questionSettings(task, reviewRun);
    this.options.assertRuntimeEnabled(settings.runtimeId ?? reviewRun.runtimeId);
    const prompt = buildReviewQuestionPrompt(
      await this.questionContext(detail, gate!, findings, focused, text)
    );

    const runId = existing?.runId ?? randomUUID();
    const sessionId = existing?.sessionId ?? randomUUID();
    const record = await this.update(task.id, (records) => {
      if (existing) {
        const current = records.find((item) => item.id === existing.id);
        if (current?.status !== 'FAILED') throw new Error('The question is no longer waiting to send.');
        return Object.assign(current, { status: 'SENDING', detail: undefined, updatedAt: now() });
      }
      if (records.some((item) => item.id === input.messageId)) throw new Error('Message already exists.');
      if (records.length >= INSTRUCTION_HISTORY_LIMIT) {
        throw new Error('This task has reached its message history limit. Start a new task.');
      }
      const at = now();
      const question: TaskInstruction = {
        id: input.messageId,
        taskId: task.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        sourceRunId: reviewRun.id,
        sessionId,
        order: Math.max(0, ...records.map((item) => item.order)) + 1,
        text,
        mode: 'FOLLOW_UP',
        status: 'SENDING',
        role: 'REVIEW',
        reviewRunId: reviewRun.id,
        ...(findingId ? { findingId } : {}),
        runId,
        createdAt: at,
        updatedAt: at
      };
      records.push(question);
      return question;
    });
    try {
      const run = await this.options.agents.startReviewQuestion({
        runId,
        sessionId,
        task,
        iteration,
        worktree,
        reviewRun,
        settings,
        prompt
      });
      await this.receipt(record, { status: 'SUBMITTED', runId: run.id, sessionId: run.sessionId });
    } catch (error) {
      const admitted = await this.options.store.getRun(runId);
      await this.receipt(record, admitted
        ? { status: 'SUBMITTED' }
        : { status: 'FAILED', detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return (await this.options.store.getTaskDetail(task.id)).taskInstructions.find((item) => item.id === record.id)!;
  }

  async stop(input: StopReviewerQuestionRequest): Promise<void> {
    const run = await this.options.store.getRun(input.runId);
    if (!run || run.taskId !== input.taskId || run.mode !== 'REVIEW_QUESTION') {
      throw new Error('This reviewer question is unavailable.');
    }
    if (!ACTIVE_AGENT_RUN_STATUSES.has(run.status)) return;
    await this.options.agents.interruptRun(run.id);
  }

  private async questionContext(
    detail: TaskDetailSnapshot,
    gate: AgentReviewGateProjection,
    findings: EffectiveReviewFinding[],
    focused: EffectiveReviewFinding | undefined,
    question: string
  ): Promise<ReviewQuestionPromptContext> {
    const snapshot = detail.gitSnapshots.find((candidate) => candidate.id === gate.reviewedGitSnapshotId);
    const diff = snapshot?.diffArtifactId
      ? await this.options.store.readArtifact(snapshot.diffArtifactId).catch(() => '')
      : '';
    const files = parseReviewedDiff(diff);
    const focusedFile = focused?.path ? files.find((file) => file.path === focused.path) : undefined;
    return {
      taskTitle: detail.task.title,
      review: {
        status: gate.status,
        ...(gate.result ? { verdict: gate.result.verdict } : {}),
        ...(gate.summary ? { summary: gate.summary } : {})
      },
      findings,
      ...(focused
        ? { focusedFinding: { finding: focused, diff: focusedFile ? reviewedDiffExcerpt(focusedFile, focused.line) : undefined } }
        : {}),
      diffStat: files.length > 0
        ? formatReviewedDiffStat(files)
        : snapshot?.diffStat.trim() || 'No diff stat was recorded.',
      history: await this.questionHistory(detail, gate.runId!),
      question
    };
  }

  /** Earlier answered questions about this review, oldest first, with prose-only answers. */
  private async questionHistory(
    detail: TaskDetailSnapshot,
    reviewRunId: string
  ): Promise<ReviewQuestionPromptContext['history']> {
    const answered = detail.taskInstructions
      .filter((item) => item.role === 'REVIEW' && item.reviewRunId === reviewRunId && item.status === 'SUBMITTED')
      .sort((left, right) => left.order - right.order)
      .flatMap((item) => {
        const run = detail.runs.find((candidate) => candidate.id === item.runId);
        return run?.mode === 'REVIEW_QUESTION' && run.status === 'COMPLETED' ? [{ item, run }] : [];
      })
      .slice(-6);
    return Promise.all(answered.map(async ({ item, run }) => ({
      question: item.text,
      answer: splitReviewerReply(await this.options.readRuntimeArtifact(run.outputArtifactId).catch(() => '')).prose ||
        '(No answer text was recorded.)',
      ...(item.findingId ? { findingId: item.findingId } : {})
    })));
  }

  private receipt(
    record: TaskInstruction,
    update: Partial<Pick<TaskInstruction, 'status' | 'runId' | 'sessionId' | 'detail'>>
  ): Promise<TaskInstruction> {
    return this.update(record.taskId, (records) => {
      const current = records.find((item) => item.id === record.id);
      if (!current) throw new Error('The question receipt is missing.');
      return Object.assign(current, { detail: undefined, ...update, updatedAt: now() });
    });
  }

  private async update<T>(taskId: string, mutate: (records: TaskInstruction[]) => T): Promise<T> {
    const result = await this.options.store.updateTaskInstructions(taskId, (records) => mutate(records));
    this.emitTaskUpdate(taskId, { instructionsChanged: true });
    return structuredClone(result);
  }

  private emitTaskUpdate(taskId: string, payload: Record<string, boolean>): void {
    this.options.events.emit({ type: 'task.updated', taskId, payload, at: now() });
  }
}

function assertCurrentReview(gate: AgentReviewGateProjection | undefined, reviewRunId: string): void {
  if (reviewAcceptsDecisions(gate, reviewRunId)) return;
  if (!gate?.runId || gate.status === 'NOT_RUN') throw new Error('This task has no completed review.');
  if (gate.runId !== reviewRunId) throw new Error('This review is no longer the task’s current review.');
  if (gate.status === 'RUNNING') throw new Error('Wait for the review to finish.');
  throw new Error('The code changed after this review. Run the review again.');
}

function questionText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.length > TASK_INSTRUCTION_MAX_LENGTH) {
    throw new Error(`Write a question of at most ${TASK_INSTRUCTION_MAX_LENGTH.toLocaleString()} characters.`);
  }
  return text.trim();
}

function requireFindingId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > FINDING_ID_MAX_LENGTH || value.trim() !== value) {
    throw new Error('A valid finding ID is required.');
  }
  return value;
}

function now(): string {
  return new Date().toISOString();
}
