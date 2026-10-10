import type {
  AgentModel,
  AgentRuntimeCapabilities
} from './agent';

/** A runtime reports that it cannot run the read-only Preview conversation with Task Monki tools. */
export const PREVIEW_AGENT_EXTENSION = 'task-monki.preview-agent';

export type AgentExecutionOperation =
  | 'ACTIVE_TURN_STEERING'
  | 'PROMPT_REFINEMENT'
  | 'PREVIEW_AGENT'
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

export function designNetworkAccessPolicy(
  capabilities: AgentRuntimeCapabilities
): 'DISABLED' | 'OPTIONAL' | 'REQUIRED' | undefined {
  const presets = capabilities.executionPolicy.presets;
  const preset = presets.find(
    (candidate) =>
      candidate.repositoryMutation === 'ALLOW' &&
      candidate.approvalPolicy.toLocaleLowerCase() === 'never'
  );
  if (!preset) return undefined;
  return presets.some(
    (candidate) =>
      candidate.sandbox === preset.sandbox && candidate.networkAccess === 'OPTIONAL'
  )
    ? 'OPTIONAL'
    : preset.networkAccess;
}

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

    case 'PREVIEW_AGENT': {
      // No runtime or model allowlist: a runtime is refused only when it reports it cannot run
      // the conversation, such as one whose read-only work happens outside the task session.
      const preview = capabilities.extensions[PREVIEW_AGENT_EXTENSION];
      return preview?.maturity === 'unsupported'
        ? unsupported(preview.detail ?? 'This agent cannot run the Preview conversation.')
        : supported();
    }

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
