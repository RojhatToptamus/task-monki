import {
  CODEX_RUNTIME_ID,
  type AgentCapability,
  type AgentRuntimeCapabilities,
  type AgentRuntimeDescriptor
} from '../../../shared/agent';
import { BROWSER_DEV_ISOLATION_CAPABILITY } from '../BrowserDevAgentBoundary';

const stable = (detail?: string): AgentCapability => ({ maturity: 'stable', detail });
const unsupported = (detail?: string): AgentCapability => ({
  maturity: 'unsupported',
  detail
});

export function codexCapabilities(input: {
  designSkillAccess?: { available: boolean; detail?: string };
  designBrowserVerification?: { available: boolean; detail?: string };
} = {}): AgentRuntimeCapabilities {
  const designSkillAccess = input.designSkillAccess ?? { available: true };
  const designBrowserVerification = input.designBrowserVerification ?? {
    available: true
  };
  return {
    runtimeId: CODEX_RUNTIME_ID,
    executionPolicy: {
      defaultPresetId: 'restricted',
      detail:
        'Codex enforces managed filesystem/process boundaries and supports native or Task Monki-reviewed approvals.',
      presets: [
        {
          id: 'isolated-read-only',
          label: 'Isolated read-only',
          detail: 'Explicitly attested read roots; network and approval exceptions disabled.',
          sandbox: 'READ_ONLY',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          repositoryMutation: 'DENY',
          networkAccess: 'DISABLED'
        },
        {
          id: 'restricted',
          label: 'Restricted',
          detail: 'Worktree only; network disabled; no exceptions.',
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          repositoryMutation: 'ALLOW',
          networkAccess: 'DISABLED'
        },
        {
          id: 'ask-for-approval',
          label: 'Ask for approval',
          detail: 'Sandboxed; you review eligible exceptions.',
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          repositoryMutation: 'ALLOW',
          networkAccess: 'OPTIONAL'
        },
        {
          id: 'approve-for-me',
          label: 'Approve for me',
          detail: 'Sandboxed; the automatic reviewer evaluates eligible exceptions.',
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
          repositoryMutation: 'ALLOW',
          networkAccess: 'OPTIONAL'
        },
        {
          id: 'full-access',
          label: 'Full access',
          detail: 'Unrestricted.',
          sandbox: 'DANGER_FULL_ACCESS',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          repositoryMutation: 'ALLOW',
          networkAccess: 'REQUIRED'
        }
      ]
    },
    readOnlyTurns: stable(
      'Uses the shared read-only turn path with an attested Codex permission profile.'
    ),
    modelCatalog: stable('Discovered through model/list.'),
    activeTurnSteering: stable('Adds input to the currently active regular turn.'),
    turnInterruption: stable('Interrupts the active turn while preserving its thread.'),
    attachmentDelivery: stable('Verified local images and text-like managed files use an attested permission profile.'),
    extensions: {
      [BROWSER_DEV_ISOLATION_CAPABILITY]: stable(
        'Codex attests the active permission profile, exact workspace roots, and disabled network/tool boundary.'
      ),
      'task-monki.design-instructions': stable(
        'Maps the shared Design instruction profile to Codex developer instructions.'
      ),
      'task-monki.design-skill-access': designSkillAccess.available
        ? stable('Adds a validated app-owned skill root to verified Design session read access.')
        : unsupported(
            designSkillAccess.detail ?? 'The app-owned Design skill pack is unavailable.'
          ),
      'task-monki.design-browser-verification': designBrowserVerification.available
        ? stable(
            'Uses one app-owned, same-turn browser tool with bounded text and image output.'
          )
        : unsupported(
            designBrowserVerification.detail ??
              'The packaged Design browser runtime is unavailable.'
          )
    }
  };
}

export const CODEX_RUNTIME_DESCRIPTOR: AgentRuntimeDescriptor = {
  id: CODEX_RUNTIME_ID,
  displayName: 'Codex',
  kind: 'APP_SERVER',
  transport: 'STDIO',
  lifecycleScope: 'APPLICATION',
  startupPolicy: 'EAGER'
};
