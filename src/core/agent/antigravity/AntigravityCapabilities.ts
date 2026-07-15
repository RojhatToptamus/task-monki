import type {
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor
} from '../../../shared/agent';

export const ANTIGRAVITY_RUNTIME_ID = 'antigravity' as const;
export const TASK_MONKI_ANTIGRAVITY_BIN_ENV =
  'TASK_MONKI_ANTIGRAVITY_BIN' as const;

export const ANTIGRAVITY_RUNTIME_DESCRIPTOR: AgentRuntimeDescriptor = {
  id: ANTIGRAVITY_RUNTIME_ID,
  displayName: 'Antigravity',
  kind: 'NATIVE_AGENT',
  transport: 'STDIO',
  lifecycleScope: 'TURN',
  startupPolicy: 'ON_DEMAND'
};

export function antigravityCapabilities(): AgentRuntimeCapabilities {
  const unsupported = (detail: string) => ({
    maturity: 'unsupported' as const,
    detail
  });
  return {
    runtimeId: ANTIGRAVITY_RUNTIME_ID,
    executionPolicy: {
      defaultPresetId: 'sandboxed-project',
      detail:
        'Every turn starts a new Antigravity project rooted at the exact Task Monki worktree and enables the public terminal sandbox. File-edit acceptance and terminal permissions remain Antigravity-owned.',
      presets: [
        {
          id: 'sandboxed-project',
          label: 'Sandboxed project',
          detail:
            'Antigravity runs with --new-project and --sandbox. Implementation turns use --mode accept-edits; terminal permissions are not auto-approved.',
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'provider-terminal-policy',
          approvalsReviewer: 'user',
          networkAccess: 'REQUIRED'
        }
      ]
    },
    promptRefinement: unsupported(
      'The public Antigravity CLI does not provide a separately attested read-only refinement primitive.'
    ),
    modelCatalog: {
      maturity: 'stable',
      detail: 'Exact model labels are discovered with the public `agy models` command.'
    },
    reasoningEffort: unsupported(
      'Antigravity exposes reasoning variants as exact model labels, not a separate effort selector.'
    ),
    persistentSessions: unsupported(
      'Task Monki intentionally uses one documented `agy --print` process per turn.'
    ),
    sessionResume: unsupported(
      'The turn-scoped integration does not persist or resume Antigravity conversations.'
    ),
    sessionFork: unsupported('The public print-mode contract has no session fork primitive.'),
    activeTurnSteering: unsupported(
      'A running non-interactive print turn cannot accept another prompt.'
    ),
    turnInterruption: {
      maturity: 'stable',
      detail: 'Task Monki interrupts the owned turn process and waits for its exit.'
    },
    truePause: unsupported('The public CLI has process cancellation, not pause.'),
    interactiveApprovals: unsupported(
      'Print mode has no structured approval protocol. Terminal permission prompts remain provider-controlled and cannot be answered by Task Monki.'
    ),
    userInputRequests: unsupported(
      'Print mode has no structured user-input request protocol.'
    ),
    goals: unsupported('The public CLI has no goal synchronization API.'),
    plans: unsupported('Print output has no typed plan event stream.'),
    review: unsupported(
      'The public CLI does not attest detached read-only review isolation.'
    ),
    subagents: unsupported('Print mode exposes no structured subagent lifecycle.'),
    backgroundTerminals: unsupported(
      'Terminal activity is not exposed as structured events in print mode.'
    ),
    dynamicTools: unsupported(
      'Antigravity owns its tools; print mode exposes only bounded assistant output.'
    ),
    attachmentDelivery: unsupported(
      'The public CLI has no Task Monki-attested managed attachment delivery contract.'
    ),
    runtimeRecovery: unsupported(
      'A turn process cannot be reattached after Task Monki loses process ownership. Ambiguous work is never replayed automatically.'
    ),
    extensions: {
      exactModelLabels: {
        maturity: 'stable',
        detail: 'Model names are passed back to `--model` exactly as advertised.'
      },
      isolatedProjectPerTurn: {
        maturity: 'stable',
        detail:
          '`--new-project` is mandatory because cwd alone does not bind Antigravity to the requested repository.'
      },
      terminalSandbox: {
        maturity: 'stable',
        detail: 'Every managed turn includes the documented `--sandbox` flag.'
      },
      nonInteractivePrintMode: {
        maturity: 'stable',
        detail:
          'The integration uses only the documented `--print <prompt>` process contract. The full prompt is visible in the live child argv, although Task Monki redacts it from durable command records; do not put secrets in Antigravity task prompts.'
      }
    }
  };
}
