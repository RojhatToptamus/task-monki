import type {
  AgentCapability,
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor
} from '../../../shared/agent';
import { OPENCODE_RUNTIME_ID } from './OpenCodeRuntimeResolver';
import { BROWSER_DEV_ISOLATION_CAPABILITY } from '../BrowserDevAgentBoundary';

const unsupported = (detail?: string): AgentCapability => ({
  maturity: 'unsupported',
  detail
});
const stable = (detail?: string): AgentCapability => ({ maturity: 'stable', detail });

export const OPENCODE_RUNTIME_DESCRIPTOR: AgentRuntimeDescriptor = {
  id: OPENCODE_RUNTIME_ID,
  displayName: 'OpenCode',
  kind: 'HTTP_AGENT',
  transport: 'HTTP_SSE',
  lifecycleScope: 'SESSION',
  startupPolicy: 'EAGER'
};

export function opencodeCapabilities(input: {
  designSkills?: { available: boolean; detail?: string };
  designBrowser?: { available: boolean; detail?: string };
} = {}): AgentRuntimeCapabilities {
  const designSkills = input.designSkills ?? { available: false };
  const designBrowser = input.designBrowser ?? { available: false };
  return {
    runtimeId: OPENCODE_RUNTIME_ID,
    executionPolicy: {
      defaultPresetId: 'ask-for-approval',
      detail:
        'OpenCode has native permission rules but no attested OS or network sandbox. Its provider, plugins, MCP servers, and tools share a credential-bearing process, so network is provider-controlled.',
      presets: [
        {
          id: 'native-read-only',
          label: 'Read only',
          detail: 'OpenCode read, search, list, and language-service tools remain available. Its native policy denies edits, commands, child tasks, questions, external paths, and web tools. The provider process itself remains unconfined.',
          sandbox: 'DANGER_FULL_ACCESS',
          repositoryMutation: 'DENY',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          networkAccess: 'REQUIRED'
        },
        {
          id: 'ask-for-approval',
          label: 'Ask for approval',
          detail: 'Commands, edits, and external-directory access require Task Monki approval. The OpenCode process itself remains unconfined and its network is provider-controlled.',
          sandbox: 'DANGER_FULL_ACCESS',
          repositoryMutation: 'ASK',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          networkAccess: 'REQUIRED'
        },
        {
          id: 'full-access',
          label: 'Full access',
          detail: 'All native OpenCode tools may run without Task Monki approval; process network is provider-controlled.',
          sandbox: 'DANGER_FULL_ACCESS',
          repositoryMutation: 'ALLOW',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          networkAccess: 'REQUIRED'
        }
      ]
    },
    readOnlyTurns: {
      maturity: 'stable',
      detail: 'Shared read-only turns deny mutation-capable native tools, and Task Monki verifies repository state after the turn. This is not an OS sandbox.'
    },
    modelCatalog: {
      maturity: 'stable',
      detail: 'OpenCode reports connected providers, models, modalities, and native variants.'
    },
    activeTurnSteering: {
      maturity: 'unsupported',
      detail: 'OpenCode does not guarantee in-flight prompt steering over its public HTTP API.'
    },
    turnInterruption: { maturity: 'stable' },
    attachmentDelivery: {
      maturity: 'stable',
      detail: 'Task Monki sends selected verified files as bounded native data-URL parts. OpenCode and its model service receive those bytes; this is not an OS confinement boundary.'
    },
    extensions: {
      'task-monki.design-instructions': designSkills.available
        ? stable('Maps the shared Design instruction profile to the native OpenCode system prompt.')
        : unsupported(designSkills.detail ?? 'The app-owned Design skill pack is unavailable.'),
      'task-monki.design-skill-access': designSkills.available
        ? stable('The validated app-owned skill catalog gives exact skill files to the Design agent.')
        : unsupported(designSkills.detail ?? 'The app-owned Design skill pack is unavailable.'),
      'task-monki.design-browser-verification': designBrowser.available
        ? stable('Uses the app-owned inspect_design MCP bridge with bounded text and image output.')
        : unsupported(designBrowser.detail ?? 'The packaged inspect_design MCP bridge is unavailable.'),
      [BROWSER_DEV_ISOLATION_CAPABILITY]: {
        maturity: 'unsupported',
        detail: 'OpenCode permission rules do not attest an OS-level filesystem and network sandbox.'
      }
    }
  };
}
