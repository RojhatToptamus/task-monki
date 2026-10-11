import { randomUUID } from 'node:crypto';
import {
  REVIEW_FINDING_DISMISS_REASONS,
  REVIEW_FINDING_TEXT_MAX_LENGTH,
  effectiveReviewFindings,
  reviewAcceptsDecisions,
  type AgentReviewGateProjection,
  type DecideReviewFindingRequest,
  type ReviewFindingDecision,
  type Task
} from '../../shared/contracts';
import type { AppEventBus } from '../runner/AppEventBus';
import type { SqliteTaskStore } from '../storage/SqliteTaskStore';

export interface AgentReviewCoordinatorOptions {
  store: Pick<SqliteTaskStore, 'recordReviewFindingDecisions'>;
  events: Pick<AppEventBus, 'emit'>;
}

const ID_MAX_LENGTH = 200;

/**
 * The person's side of a completed review: dismissing a finding with its reason, and
 * restoring it. The reviewer is not a conversation; questions about a finding go to
 * Ask (the side-question lane) with the finding as their subject.
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
    if (input.kind === 'RESTORE' && note) throw new Error('Only a dismissal takes a note.');
    if (input.dismissReason !== undefined && (
      input.kind !== 'DISMISS' || !(REVIEW_FINDING_DISMISS_REASONS as readonly unknown[]).includes(input.dismissReason)
    )) {
      throw new Error('A dismissal reason is Incorrect, Intentional or Won\'t fix now.');
    }
    if (note && note.length > REVIEW_FINDING_TEXT_MAX_LENGTH) {
      throw new Error(`Keep the note to at most ${REVIEW_FINDING_TEXT_MAX_LENGTH} characters.`);
    }
    let decision: ReviewFindingDecision | undefined;
    await this.options.store.recordReviewFindingDecisions(input.taskId, (task) => {
      assertTaskTakesReviewWork(task);
      const gate = task.projection.agentReview;
      assertCurrentReview(gate, reviewRunId);
      const finding = effectiveReviewFindings(gate?.result, gate?.findingDecisions ?? [])
        .find((candidate) => candidate.id === findingId);
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
        reviewRunId,
        findingId: finding.id,
        kind: input.kind,
        actor: 'USER',
        ...(input.kind === 'DISMISS' && input.dismissReason ? { dismissReason: input.dismissReason } : {}),
        ...(input.kind === 'DISMISS' && note ? { note } : {}),
        createdAt: new Date().toISOString()
      };
      return [decision];
    });
    this.options.events.emit({ type: 'task.updated', taskId: input.taskId, payload: { reviewFindingsDecided: true }, at: new Date().toISOString() });
    return decision!;
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
