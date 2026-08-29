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

export const OPENCODE_RUNTIME_DESCRIPTOR: AgentRuntimeDescriptor = {
  id: OPENCODE_RUNTIME_ID,
  displayName: 'OpenCode',
  kind: 'HTTP_AGENT',
  transport: 'HTTP_SSE',
  lifecycleScope: 'SESSION',
  startupPolicy: 'EAGER'
};

export function opencodeCapabilities(): AgentRuntimeCapabilities {
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
    promptRefinement: {
      maturity: 'stable',
      detail: 'Prompt refinement uses the shared read-only turn path. OpenCode denies mutation-capable native tools, and Task Monki verifies repository state after the turn. This is not an OS sandbox.'
    },
    modelCatalog: {
      maturity: 'stable',
      detail: 'OpenCode reports connected providers, models, modalities, and native variants.'
    },
    reasoningEffort: {
      maturity: 'stable',
      detail: 'OpenCode model variants are preserved as runtime-native reasoning choices.'
    },
    persistentSessions: { maturity: 'stable' },
    sessionResume: { maturity: 'stable' },
    sessionFork: {
      maturity: 'stable',
      detail:
        'OpenCode clones native message history into a new session in the request directory. Task Monki sends the mutation through the target worktree runtime and verifies the returned directory.'
    },
    activeTurnSteering: {
      maturity: 'unsupported',
      detail: 'OpenCode does not guarantee in-flight prompt steering over its public HTTP API.'
    },
    turnInterruption: { maturity: 'stable' },
    truePause: { maturity: 'unsupported' },
    interactiveApprovals: {
      maturity: 'stable',
      detail: 'Permission requests are durable HTTP resources and SSE events.'
    },
    userInputRequests: {
      maturity: 'stable',
      detail: 'Question requests are durable HTTP resources and SSE events.'
    },
    goals: {
      maturity: 'unsupported',
      detail: 'Task Monki remains authoritative for goals.'
    },
    plans: {
      maturity: 'stable',
      detail: 'OpenCode todo updates are retained as plan revisions.'
    },
    detachedReview: {
      maturity: 'stable',
      detail: 'Detached review uses the shared read-only turn path with native mutation denial and Task Monki repository comparison.'
    },
    review: {
      maturity: 'stable',
      detail: 'OpenCode has no native review primitive. Task Monki supplies the review prompt through its shared read-only turn path and validates the result independently.'
    },
    subagents: {
      maturity: 'experimental',
      detail: 'OpenCode child sessions are preserved when parent relationships are reported. Native task delegation is disabled by the approval-gated preset because child tool permissions cannot be independently attested.'
    },
    backgroundTerminals: {
      maturity: 'inferred',
      detail: 'Terminal work is surfaced through native tool parts.'
    },
    dynamicTools: {
      maturity: 'stable',
      detail: 'OpenCode retains its native tool, plugin, and MCP runtime.'
    },
    attachmentDelivery: {
      maturity: 'stable',
      detail: 'Task Monki sends selected verified files as bounded native data-URL parts. OpenCode and its model service receive those bytes; this is not an OS confinement boundary.'
    },
    runtimeRecovery: {
      maturity: 'stable',
      detail: 'Sessions, messages, pending interactions, and status are reconciled after reconnect.'
    },
    extensions: {
      'task-monki.design-instructions': unsupported(
        'OpenCode currently receives Design guidance only as user prompt text.'
      ),
      'task-monki.design-skill-access': unsupported(
        'OpenCode cannot attest a restricted app-owned read root for Design skills.'
      ),
      [BROWSER_DEV_ISOLATION_CAPABILITY]: {
        maturity: 'unsupported',
        detail: 'OpenCode permission rules do not attest an OS-level filesystem and network sandbox.'
      },
      nativeProviderRegistry: { maturity: 'stable' },
      modelVariants: { maturity: 'stable' },
      todoPlans: { maturity: 'stable' },
      sessionUndoRedo: {
        maturity: 'inferred',
        detail: 'Retained as OpenCode-native state; Task Monki does not currently expose undo/redo as an application operation.'
      },
      nativeFileParts: {
        maturity: 'stable',
        detail: 'OpenCode native file parts carry Task Monki managed attachments as verified bounded data URLs.'
      },
    }
  };
}
