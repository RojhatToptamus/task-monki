import type {
  AgentModel,
  AgentRuntimeCapabilities
} from './agent';

export type AgentExecutionOperation =
  | 'ACTIVE_TURN_STEERING'
  | 'PROMPT_REFINEMENT'
  | 'REVIEW'
  | 'DESIGN'
  | 'DISCOURSE';

export interface AgentExecutionSupportContext {
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
      return readOnlyTurnSupport(capabilities, 'PROMPT_REFINEMENT');

    case 'REVIEW':
      return readOnlyTurnSupport(capabilities, 'REVIEW');

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
      return readOnlyTurnSupport(capabilities, 'DISCOURSE');
    }
  }
}

function readOnlyTurnSupport(
  capabilities: AgentRuntimeCapabilities,
  operation: Extract<AgentExecutionOperation, 'PROMPT_REFINEMENT' | 'REVIEW' | 'DISCOURSE'>
): AgentExecutionSupport {
  const qualified = capabilities.executionPolicy.presets.some(
    (preset) =>
      preset.repositoryMutation === 'DENY' &&
      preset.approvalPolicy.toLocaleLowerCase() === 'never'
  );
  if (qualified) return supported();

  const detail = readOnlyUnavailableDetail(capabilities, operation);
  const reason = detail ??
    'This agent profile has no qualified native policy that denies repository changes.';
  return unsupported(
    /normal tasks remain available\.?$/iu.test(reason)
      ? reason
      : `${reason.replace(/[.\s]+$/u, '')}. Normal Tasks remain available.`
  );
}

function readOnlyUnavailableDetail(
  capabilities: AgentRuntimeCapabilities,
  operation: Extract<AgentExecutionOperation, 'PROMPT_REFINEMENT' | 'REVIEW' | 'DISCOURSE'>
): string | undefined {
  const capability = operation === 'PROMPT_REFINEMENT'
    ? capabilities.promptRefinement
    : operation === 'REVIEW'
      ? capabilities.detachedReview
      : capabilities.extensions['task-monki.read-only-turn']?.maturity === 'unsupported'
        ? capabilities.extensions['task-monki.read-only-turn']
        : capabilities.detachedReview;
  const normalized = capability.maturity === 'unsupported'
    ? capability.detail?.trim()
    : undefined;
  return normalized || undefined;
}

function supported(): AgentExecutionSupport {
  return { supported: true };
}

function unsupported(reason: string): AgentExecutionSupport {
  return { supported: false, reason };
}
