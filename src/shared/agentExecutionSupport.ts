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
  /** Lets the explicit Design qualification harness test an unqualified candidate model and its image-result path. */
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
      return readOnlyTurnSupport(capabilities);

    case 'PREVIEW_RECIPE_GENERATION':
      return readOnlyTurnSupport(capabilities);

    case 'REVIEW':
      return readOnlyTurnSupport(capabilities);

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
              'This provider version and model have not passed the required Design Mode technical qualification.'
          );
        }
      }
      return supported();
    }

    case 'DISCOURSE': {
      return readOnlyTurnSupport(capabilities);
    }
  }
}

function readOnlyTurnSupport(
  capabilities: AgentRuntimeCapabilities
): AgentExecutionSupport {
  if (capabilities.readOnlyTurns.maturity === 'stable') {
    return supported();
  }

  const reason =
    capabilities.readOnlyTurns.detail?.trim() ||
    'This agent profile has no qualified native policy that denies repository changes.';
  return unsupported(
    /normal tasks remain available\.?$/iu.test(reason)
      ? reason
      : `${reason.replace(/[.\s]+$/u, '')}. Normal Tasks remain available.`
  );
}

function supported(): AgentExecutionSupport {
  return { supported: true };
}

function unsupported(reason: string): AgentExecutionSupport {
  return { supported: false, reason };
}
