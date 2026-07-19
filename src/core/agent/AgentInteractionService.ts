import type {
  InteractionRequestRecord,
  RespondToInteractionRequest,
  RunRecord
} from '../../shared/contracts';
import type { AppEventBus } from '../runner/AppEventBus';
import type { FileTaskStore } from '../storage/FileTaskStore';
import {
  validateInteractionDecision
} from './AgentInteractionPolicy';
import {
  AgentMutationAmbiguousError,
  type AgentRuntimeAdapter
} from './AgentRuntimeAdapter';
import type { AgentRuntimeId } from '../../shared/agent';
import { createDomainEvent } from '../storage/domainEvent';

export class AgentInteractionService {
  constructor(
    private readonly store: FileTaskStore,
    private readonly events: AppEventBus,
    private readonly resolveRuntime: (runtimeId: AgentRuntimeId) => AgentRuntimeAdapter
  ) {}

  async respond(
    input: RespondToInteractionRequest
  ): Promise<InteractionRequestRecord> {
    const interaction = await this.store.getInteractionRequest(
      input.interactionRequestId
    );
    if (!interaction) {
      throw new Error(`Interaction request not found: ${input.interactionRequestId}`);
    }
    if (interaction.taskId !== input.taskId || interaction.runId !== input.runId) {
      throw new Error('Interaction request ownership does not match the selected task and run.');
    }
    if (interaction.status !== 'PENDING') {
      throw new Error(
        `Interaction request ${interaction.id} is ${interaction.status}; expected PENDING.`
      );
    }

    const run = await this.store.getRun(interaction.runId);
    const session = await this.store.getAgentSession(interaction.sessionId);
    if (
      !run ||
      !session ||
      run.taskId !== interaction.taskId ||
      run.sessionId !== interaction.sessionId ||
      run.serverInstanceId !== interaction.serverInstanceId ||
      run.runtimeId !== interaction.runtimeId ||
      session.runtimeId !== interaction.runtimeId
    ) {
      throw new Error('Interaction request no longer matches its provider run.');
    }

    const expectedRunStatus =
      interaction.type === 'USER_INPUT' ? 'AWAITING_USER_INPUT' : 'AWAITING_APPROVAL';
    if (
      !isNonGrantingDecision(input.decision.action) &&
      (run.status !== expectedRunStatus || session.status !== expectedRunStatus)
    ) {
      throw new Error(
        `Interaction request ${interaction.id} cannot resume run ${run.id} while its run/session awaiting state is ${run.status}/${session.status}.`
      );
    }

    validateInteractionDecision(
      interaction,
      input.decision,
      session,
      run
    );

    const responding = await this.store.transitionInteractionRequest(
      interaction.id,
      'PENDING',
      {
        status: 'RESPONDING',
        decision: input.decision,
        respondedAt: new Date().toISOString()
      }
    );
    this.emitUpdate(responding);

    try {
      await this.resolveRuntime(interaction.runtimeId).respondToInteraction({
        interaction: responding,
        decision: input.decision
      });
      return (await this.store.getInteractionRequest(interaction.id)) ?? responding;
    } catch (error) {
      const latest = await this.store.getInteractionRequest(interaction.id);
      if (latest?.status === 'RESPONDING') {
        if (error instanceof AgentMutationAmbiguousError) {
          const reason = error.message;
          const stale = await this.store.transitionInteractionRequest(
            latest.id,
            'RESPONDING',
            {
              status: 'STALE',
              resolution: {
                error: reason,
                operation: error.operation,
                automaticResubmission: false
              },
              resolvedAt: new Date().toISOString()
            }
          );
          this.emitUpdate(stale);
          const recorded = await this.store.appendRunEventIfStatus(
            createDomainEvent({
              type: 'AGENT_MUTATION_AMBIGUOUS',
              taskId: run.taskId,
              iterationId: run.iterationId,
              runId: run.id,
              worktreeId: run.worktreeId,
              agentSessionId: run.sessionId,
              serverInstanceId: run.serverInstanceId,
              source: 'provider',
              payload: {
                operation: error.operation,
                reason,
                automaticResubmission: false
              }
            }),
            ACTIVE_RUN_STATUSES
          );
          if (recorded) {
            this.events.emit({
              type: 'run.activity',
              taskId: run.taskId,
              iterationId: run.iterationId,
              runId: run.id,
              worktreeId: run.worktreeId,
              payload: {
                eventType: 'mutation/ambiguous',
                operation: error.operation
              },
              at: new Date().toISOString()
            });
          }
        } else {
          const pending = await this.store.transitionInteractionRequest(
            latest.id,
            'RESPONDING',
            {
              status: 'PENDING',
              decision: undefined,
              respondedAt: undefined,
              resolution: {
                lastResponseError:
                  error instanceof Error ? error.message : String(error)
              }
            }
          );
          this.emitUpdate(pending);
        }
      }
      throw error;
    }
  }

  private emitUpdate(interaction: InteractionRequestRecord): void {
    this.events.emit({
      type: 'interaction.updated',
      taskId: interaction.taskId,
      iterationId: interaction.iterationId,
      runId: interaction.runId,
      payload: interaction,
      at: new Date().toISOString()
    });
  }
}

const ACTIVE_RUN_STATUSES: readonly RunRecord['status'][] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING'
];

function isNonGrantingDecision(
  action: RespondToInteractionRequest['decision']['action']
): boolean {
  return action === 'DECLINE' || action === 'DECLINE_FOR_SESSION' || action === 'CANCEL';
}
