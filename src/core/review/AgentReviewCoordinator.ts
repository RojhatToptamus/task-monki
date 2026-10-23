import { randomUUID } from 'node:crypto';
import {
  REVIEW_FINDING_DISMISS_REASONS,
  REVIEW_FINDING_TEXT_MAX_LENGTH,
  REVIEW_REQUEST_ITEM_LIMIT,
  acceptedRequestItems,
  effectiveReviewFindings,
  latestReviewRequest,
  reviewAcceptsDecisions,
  type AgentReviewGateProjection,
  type DecideReviewFindingRequest,
  type DecideReviewRequestItemRequest,
  type ReviewFindingDecision,
  type ReviewRequestItemDecision,
  type Task
} from '../../shared/contracts';
import type { AppEventBus } from '../runner/AppEventBus';
import type { SqliteTaskStore } from '../storage/SqliteTaskStore';

export interface AgentReviewCoordinatorOptions {
  store: Pick<SqliteTaskStore, 'recordReviewFindingDecision' | 'recordReviewRequestItemDecision'>;
  events: Pick<AppEventBus, 'emit'>;
}

const ID_MAX_LENGTH = 200;

/**
 * The person's side of a completed review: dismissing a finding with its reason, and
 * restoring it, and settling the agent's answers to their request after it. The
 * reviewer is not a conversation; questions about a finding go to Ask (the
 * side-question lane) with the finding as their subject.
 */
export class AgentReviewCoordinator {
  constructor(private readonly options: AgentReviewCoordinatorOptions) {}

  async decide(input: DecideReviewFindingRequest): Promise<ReviewFindingDecision> {
    if (input.kind !== 'DISMISS' && input.kind !== 'RESTORE') {
      throw new Error('A finding can only be dismissed or restored.');
    }
    const reviewRunId = requireId(input.reviewRunId, 'review run');
    const findingId = requireId(input.findingId, 'finding');
    if (input.note !== undefined && typeof input.note !== 'string') throw new Error('A note must be text.');
    const note = input.note?.trim();
    if (input.kind === 'RESTORE' && (note || input.dismissReason !== undefined)) {
      throw new Error('Only a dismissal takes a reason and a note.');
    }
    if (input.kind === 'DISMISS' && !(REVIEW_FINDING_DISMISS_REASONS as readonly unknown[]).includes(input.dismissReason)) {
      throw new Error('A dismissal reason is Incorrect, Intentional or Won\'t fix now.');
    }
    if (note && note.length > REVIEW_FINDING_TEXT_MAX_LENGTH) {
      throw new Error(`Keep the note to at most ${REVIEW_FINDING_TEXT_MAX_LENGTH} characters.`);
    }
    const decision = await this.options.store.recordReviewFindingDecision(input.taskId, (task) => {
      assertTaskTakesReviewWork(task);
      const gate = task.projection.agentReview;
      assertCurrentReview(gate, reviewRunId);
      const finding = effectiveReviewFindings(gate?.result, gate?.findingDecisions ?? [])
        .find((candidate) => candidate.id === findingId);
      if (!finding) throw new Error('This finding is not part of the review.');
      if (input.kind === 'DISMISS' && finding.state !== 'OPEN') {
        throw new Error('This finding is already dismissed.');
      }
      if (input.kind === 'RESTORE' && finding.state !== 'DISMISSED') {
        throw new Error('Only a dismissed finding can be restored.');
      }
      const base = { id: randomUUID(), reviewRunId, findingId: finding.id, createdAt: new Date().toISOString() };
      return input.kind === 'DISMISS'
        ? { ...base, kind: 'DISMISS', dismissReason: input.dismissReason!, ...(note ? { note } : {}) }
        : { ...base, kind: 'RESTORE' };
    });
    this.options.events.emit({ type: 'task.updated', taskId: input.taskId, payload: { reviewFindingsDecided: true }, at: new Date().toISOString() });
    return decision;
  }

  /**
   * Accepts the agent's answer to an item of the person's latest request after the
   * task's review, which settles the item, or reopens an accepted one. The review
   * may be out of date, as it is once the agent changed the code; an earlier
   * request, or one whose reply has not finished, takes no decisions.
   */
  async decideRequestItem(input: DecideReviewRequestItemRequest): Promise<ReviewRequestItemDecision> {
    if (input.kind !== 'ACCEPT' && input.kind !== 'REOPEN') {
      throw new Error('An answer can only be accepted or reopened.');
    }
    const reviewRunId = requireId(input.reviewRunId, 'review run');
    const instructionId = requireId(input.instructionId, 'request');
    if (!Number.isInteger(input.item) || input.item < 1 || input.item > REVIEW_REQUEST_ITEM_LIMIT) {
      throw new Error('A valid request item is required.');
    }
    const decision = await this.options.store.recordReviewRequestItemDecision(input.taskId, (task, messages, runs) => {
      assertTaskTakesReviewWork(task);
      const gate = task.projection.agentReview;
      if (!gate?.runId || gate.status === 'NOT_RUN') throw new Error('This task has no completed review.');
      if (gate.runId !== reviewRunId) throw new Error('This review is no longer the task’s current review.');
      const request = latestReviewRequest(messages, reviewRunId);
      if (!request || request.id !== instructionId) throw new Error('Only the latest request after the review takes decisions.');
      if (runs.find((run) => run.id === request.runId)?.status !== 'COMPLETED') {
        throw new Error('Wait for the agent to answer the request.');
      }
      if (!request.reviewRequest!.items.some((item) => item.number === input.item)) {
        throw new Error('This item is not part of the request.');
      }
      const accepted = acceptedRequestItems(gate.requestItemDecisions ?? [], instructionId).has(input.item);
      if (input.kind === 'ACCEPT' && accepted) throw new Error('This answer is already accepted.');
      if (input.kind === 'REOPEN' && !accepted) throw new Error('Only an accepted answer can be reopened.');
      return { id: randomUUID(), reviewRunId, instructionId, item: input.item, kind: input.kind, createdAt: new Date().toISOString() };
    });
    this.options.events.emit({ type: 'task.updated', taskId: input.taskId, payload: { reviewAnswersDecided: true }, at: new Date().toISOString() });
    return decision;
  }
}

function assertCurrentReview(gate: AgentReviewGateProjection | undefined, reviewRunId: string): void {
  if (reviewAcceptsDecisions(gate, reviewRunId)) return;
  if (!gate?.runId || gate.status === 'NOT_RUN') throw new Error('This task has no completed review.');
  if (gate.runId !== reviewRunId) throw new Error('This review is no longer the task’s current review.');
  if (gate.status === 'RUNNING') throw new Error('Wait for the review to finish.');
  throw new Error('The code changed after this review. Run the review again.');
}

/** An archived or canceled task keeps its review as a record; it takes no new decisions. */
function assertTaskTakesReviewWork(task: Task): void {
  if (task.workflowPhase === 'ARCHIVED' || task.workflowPhase === 'CANCELED') {
    throw new Error(
      `This task is ${task.workflowPhase === 'ARCHIVED' ? 'archived' : 'canceled'}, so its review takes no decisions.`
    );
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > ID_MAX_LENGTH || value.trim() !== value) {
    throw new Error(`A valid ${label} ID is required.`);
  }
  return value;
}
