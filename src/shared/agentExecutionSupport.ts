import type {
  AgentModel,
  AgentRuntimeCapabilities
} from './agent';

export type AgentExecutionOperation =
  | 'ACTIVE_TURN_STEERING'
  | 'PROMPT_REFINEMENT'
  | 'PREVIEW_RECIPE_GENERATION'
  | 'REVIEW'
  | 'DESIGN'
  | 'DISCOURSE';

export interface AgentExecutionSupportContext {
  model?: Pick<AgentModel, 'inputModalities' | 'designSupport'>;
  /** Lets the live Design harness test a candidate model whose capabilities are not reported. */
  allowCandidateDesignModel?: boolean;
}

export type AgentExecutionSupport =
  | { supported: true }
  | { supported: false; reason: string };

/**
 * Projects the operations that Task Monki currently exposes for one runtime.
 * Runtime health is separate because active-session controls can remain usable
 * while new-work discovery is unavailable.
 */
export function projectAgentExecutionSupport(
  capabilities: AgentRuntimeCapabilities,
  operation: AgentExecutionOperation,
  context: AgentExecutionSupportContext = {}
): AgentExecutionSupport {
  switch (operation) {
    case 'ACTIVE_TURN_STEERING':
      return capabilities.activeTurnSteering.maturity !== 'unsupported'
        ? supported()
        : unsupported('This agent cannot add instructions to an active turn.');

    case 'PROMPT_REFINEMENT':
      return supported();

    case 'PREVIEW_RECIPE_GENERATION':
      return supported();

    case 'REVIEW':
      return supported();

    case 'DESIGN': {
      const extensions = capabilities.extensions;
      const autonomousWrite = capabilities.executionPolicy.presets.some(
        (preset) =>
          preset.repositoryMutation === 'ALLOW' &&
          preset.approvalPolicy.toLocaleLowerCase() === 'never'
      );
      if (!autonomousWrite) {
        return unsupported(
          'This agent has no approval-free write policy for autonomous Design work.'
        );
      }
      const runtimeSupported =
        extensions['task-monki.design-instructions']?.maturity === 'stable' &&
        extensions['task-monki.design-skill-access']?.maturity === 'stable' &&
        extensions['task-monki.design-browser-verification']?.maturity === 'stable' &&
        capabilities.attachmentDelivery.maturity === 'stable' &&
        capabilities.turnInterruption.maturity === 'stable';
      if (!runtimeSupported) {
        return unsupported(
          'The configured agent cannot apply Design instructions and skills safely, verify the rendered result, protect Design references, or support Stop.'
        );
      }
      if (!context.allowCandidateDesignModel) {
        if (
          context.model &&
          !context.model.inputModalities.some(
            (modality) => modality.toLocaleLowerCase() === 'image'
          )
        ) {
          return unsupported('Design Mode requires a model that supports images.');
        }
        if (context.model && context.model.designSupport?.maturity !== 'stable') {
          return unsupported(
            context.model?.designSupport?.detail?.trim() ||
              'This provider or model does not report the image input required by Design Mode.'
          );
        }
      }
      return supported();
    }

    case 'DISCOURSE': {
      return supported();
    }
  }
}

function supported(): AgentExecutionSupport {
  return { supported: true };
}

function unsupported(reason: string): AgentExecutionSupport {
  return { supported: false, reason };
}
