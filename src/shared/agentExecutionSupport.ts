import type {
  AgentModel,
  AgentRuntimeCapabilities,
  AgentRuntimeId
} from './agent';

export type AgentExecutionOperation =
  | 'ACTIVE_TURN_STEERING'
  | 'PROMPT_REFINEMENT'
  | 'REVIEW'
  | 'DESIGN'
  | 'DISCOURSE';

export interface AgentExecutionSupportContext {
  sourceRuntimeId?: AgentRuntimeId;
  model?: Pick<AgentModel, 'inputModalities'>;
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
      return capabilities.promptRefinement.maturity !== 'unsupported'
        ? supported()
        : unsupported('This agent does not support prompt refinement.');

    case 'REVIEW': {
      const nativeReview =
        capabilities.review.maturity !== 'unsupported' &&
        (!context.sourceRuntimeId || context.sourceRuntimeId === capabilities.runtimeId);
      return nativeReview || capabilities.detachedReview.maturity === 'stable'
        ? supported()
        : unsupported('This agent does not support the current review workflow.');
    }

    case 'DESIGN': {
      const extensions = capabilities.extensions;
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
      if (
        context.model &&
        !context.model.inputModalities.some(
          (modality) => modality.toLocaleLowerCase() === 'image'
        )
      ) {
        return unsupported('Design Mode requires a model that supports images.');
      }
      return supported();
    }

    case 'DISCOURSE': {
      const policySupported = capabilities.executionPolicy.presets.some(
        (preset) =>
          preset.sandbox === 'READ_ONLY' &&
          preset.networkAccess === 'DISABLED' &&
          preset.approvalPolicy.toLocaleLowerCase() === 'never'
      );
      return capabilities.extensions['task-monki.discourse']?.maturity === 'stable' &&
        policySupported
        ? supported()
        : unsupported(
            'This agent cannot confirm the read-only, offline access required by Discourse.'
          );
    }
  }
}

function supported(): AgentExecutionSupport {
  return { supported: true };
}

function unsupported(reason: string): AgentExecutionSupport {
  return { supported: false, reason };
}
