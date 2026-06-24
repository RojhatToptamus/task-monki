import type {
  InteractionRequestRecord,
  RespondToInteractionRequest
} from '../../shared/contracts';
import type { AppEventBus } from '../runner/AppEventBus';
import type { FileTaskStore } from '../storage/FileTaskStore';
import {
  validateInteractionDecision
} from './AgentInteractionPolicy';
import type { AgentProviderAdapter } from './AgentProviderAdapter';

export class AgentInteractionService {
  constructor(
    private readonly store: FileTaskStore,
    private readonly events: AppEventBus,
    private readonly adapter: AgentProviderAdapter
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
      run.serverInstanceId !== interaction.serverInstanceId
    ) {
      throw new Error('Interaction request no longer matches its provider run.');
    }

    validateInteractionDecision(interaction, input.decision, session, run);

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
      await this.adapter.respondToInteraction({
        interaction: responding,
        decision: input.decision
      });
      return (await this.store.getInteractionRequest(interaction.id)) ?? responding;
    } catch (error) {
      const latest = await this.store.getInteractionRequest(interaction.id);
      if (latest?.status === 'RESPONDING') {
        const stale = await this.store.transitionInteractionRequest(
          latest.id,
          'RESPONDING',
          {
            status: 'STALE',
            resolution: {
              error: error instanceof Error ? error.message : String(error)
            },
            resolvedAt: new Date().toISOString()
          }
        );
        this.emitUpdate(stale);
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
