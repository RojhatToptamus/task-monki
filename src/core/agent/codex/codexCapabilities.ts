import {
  CODEX_RUNTIME_ID,
  type AgentCapability,
  type AgentRuntimeCapabilities,
  type AgentRuntimeDescriptor
} from '../../../shared/agent';
import { BROWSER_DEV_ISOLATION_CAPABILITY } from '../BrowserDevAgentBoundary';

const stable = (detail?: string): AgentCapability => ({ maturity: 'stable', detail });
const experimental = (detail?: string): AgentCapability => ({
  maturity: 'experimental',
  detail
});
const unsupported = (detail?: string): AgentCapability => ({
  maturity: 'unsupported',
  detail
});

export function codexCapabilities(): AgentRuntimeCapabilities {
  return {
    runtimeId: CODEX_RUNTIME_ID,
    executionPolicy: {
      defaultPresetId: 'restricted',
      detail:
        'Codex enforces managed filesystem/process boundaries and supports native or Task Monki-reviewed approvals.',
      presets: [
        {
          id: 'restricted',
          label: 'Restricted',
          detail: 'Worktree only; network disabled; no exceptions.',
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          networkAccess: 'DISABLED'
        },
        {
          id: 'ask-for-approval',
          label: 'Ask for approval',
          detail: 'Sandboxed; you review eligible exceptions.',
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          networkAccess: 'OPTIONAL'
        },
        {
          id: 'approve-for-me',
          label: 'Approve for me',
          detail: 'Sandboxed; the automatic reviewer evaluates eligible exceptions.',
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
          networkAccess: 'OPTIONAL'
        },
        {
          id: 'full-access',
          label: 'Full access',
          detail: 'Unrestricted.',
          sandbox: 'DANGER_FULL_ACCESS',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          networkAccess: 'REQUIRED'
        }
      ]
    },
    promptRefinement: stable('Uses a read-only ephemeral Codex execution.'),
    modelCatalog: stable('Discovered through model/list.'),
    reasoningEffort: stable('Supported efforts are supplied by each model catalog entry.'),
    persistentSessions: stable('Backed by App Server threads.'),
    sessionResume: stable('Resumes persisted threads; active work is not recreated after process loss.'),
    sessionFork: stable('Forks stored thread history into a new thread.'),
    activeTurnSteering: stable('Adds input to the currently active regular turn.'),
    turnInterruption: stable('Interrupts the active turn while preserving its thread.'),
    truePause: unsupported('Codex has no resumable model-generation pause primitive.'),
    interactiveApprovals: stable('Command, file, permission, and MCP requests use server requests.'),
    userInputRequests: experimental('The current request-user-input schema is marked experimental.'),
    goals: stable('One persisted goal is available per materialized thread.'),
    plans: stable('turn/plan/updated provides provider-reported plan state.'),
    detachedReview: stable(
      'Codex can run the provider-neutral review contract in an attested read-only session.'
    ),
    review: stable('review/start supports inline or detached review work.'),
    subagents: unsupported(
      'Task Monki permission profiles disable Codex multi-agent execution; unsolicited child activity remains telemetry only.'
    ),
    backgroundTerminals: experimental('List, terminate, and cleanup methods require experimental API access.'),
    dynamicTools: experimental('Client-registered dynamic tools require experimental API access.'),
    attachmentDelivery: stable('Verified local images and text-like managed files use an attested permission profile.'),
    runtimeRecovery: stable('Persisted threads are reconciled after App Server process loss.'),
    extensions: {
      [BROWSER_DEV_ISOLATION_CAPABILITY]: stable(
        'Codex attests the active permission profile, exact workspace roots, and disabled network/tool boundary.'
      ),
      'task-monki.prompt-refinement': stable('Uses a read-only ephemeral Codex execution.'),
      'codex.review.start': stable('Native review/start with inline or detached delivery.'),
      'codex.thread.goal': stable('Native persisted thread goal operations.'),
      'codex.permission.attestation': stable('Active permission profiles and workspace roots are attested by the runtime.'),
      'codex.collaboration': unsupported(
        'Task Monki disables Codex multi-agent execution in every managed permission profile.'
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
