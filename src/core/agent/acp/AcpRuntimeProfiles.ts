import type {
  AgentModel,
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor,
  AgentRuntimeId
} from '../../../shared/agent';
import {
  AWS_ENVIRONMENT_KEYS,
  AWS_SENSITIVE_ENVIRONMENT_KEYS,
  GOOGLE_ENVIRONMENT_KEYS,
  GOOGLE_SENSITIVE_ENVIRONMENT_KEYS,
  NETWORK_ENVIRONMENT_KEYS,
  NETWORK_SENSITIVE_ENVIRONMENT_KEYS,
  USER_CONFIG_ENVIRONMENT_KEYS,
  type ProviderEnvironmentPolicy
} from '../ProviderEnvironmentPolicy';

export interface AcpRuntimeProfile {
  descriptor: AgentRuntimeDescriptor;
  /** Debug-only executable override owned by this provider profile. */
  executableEnvironmentKey: string;
  executableCandidates: readonly string[];
  argv: readonly string[];
  versionArgv: readonly string[];
  /**
   * Non-mutating proof that this executable exposes the profile's exact ACP
   * launch entrypoint. A successful version command establishes only that an
   * executable can run; it does not establish provider identity or ACP support.
   */
  launchContractProbe: {
    argv: readonly string[];
    description: string;
    requiredOutput: readonly {
      pattern: RegExp;
      description: string;
    }[];
  };
  defaultModelProvider: string;
  defaultModel: string;
  /** Versioned, exact environment contract inherited by this provider child. */
  environmentPolicy: ProviderEnvironmentPolicy;
  /**
   * Optional provider-owned model contract layered on top of stable ACP v1.
   * This is deliberately profile-gated because the stable v1.19 schema does
   * not define a session `models` field or `session/set_model`.
   */
  sessionModelExtension?: AcpSessionModelExtensionContract;
  /** Profile-owned facts only; negotiated ACP capabilities are added at runtime. */
  extensions: Readonly<
    Record<string, { maturity: 'stable' | 'experimental' | 'inferred'; detail: string }>
  >;
}

export interface AcpSessionModelExtensionContract {
  contractId: string;
  /** Provider-owned catalog advertised during ACP initialize, before a session exists. */
  initializeResponseMetaField?: 'modelState';
  setupResponseField: 'models';
  setModelMethod: 'session/set_model';
  modelUpdateNotification: '_x.ai/models/update';
}

/**
 * Captured Grok Build ACP vendor contract. Its wire shape is versioned here so
 * a future incompatible provider change requires an explicit adapter update.
 */
export const GROK_SESSION_MODEL_EXTENSION = {
  contractId: 'grok-build-acp/session-models@v1',
  initializeResponseMetaField: 'modelState',
  setupResponseField: 'models',
  setModelMethod: 'session/set_model',
  modelUpdateNotification: '_x.ai/models/update'
} as const satisfies AcpSessionModelExtensionContract;

const descriptor = (id: AgentRuntimeId, displayName: string): AgentRuntimeDescriptor => ({
  id,
  displayName,
  kind: 'ACP_AGENT',
  transport: 'STDIO',
  lifecycleScope: 'APPLICATION',
  startupPolicy: 'ON_DEMAND'
});

/**
 * Provider profiles are intentionally explicit. ACP standardizes transport and
 * session control; it does not erase each agent's own authentication, model
 * catalog, configuration selectors, or extensions.
 */
export const GROK_ACP_PROFILE: AcpRuntimeProfile = {
  descriptor: descriptor('grok-acp', 'Grok Build'),
  executableEnvironmentKey: 'TASK_MONKI_GROK_ACP_BIN',
  executableCandidates: ['grok'],
  argv: ['--no-auto-update', 'agent', 'stdio'],
  versionArgv: ['--version'],
  launchContractProbe: {
    argv: ['--no-auto-update', 'agent', 'stdio', '--help'],
    description: 'Grok Build ACP stdio launch contract',
    requiredOutput: [
      {
        pattern: /\bUsage:\s+grok\s+agent\s+stdio\b/iu,
        description: 'the grok agent stdio command'
      },
      {
        pattern: /\bRun the agent over stdio\b/iu,
        description: 'the stdio agent identity'
      }
    ]
  },
  defaultModelProvider: 'xai',
  defaultModel: 'grok-build',
  environmentPolicy: {
    contractId: 'task-monki/grok-acp-environment@v1',
    allowedKeys: [
      'XAI_API_KEY',
      'GROK_API_KEY',
      'XAI_BASE_URL',
      ...USER_CONFIG_ENVIRONMENT_KEYS,
      ...NETWORK_ENVIRONMENT_KEYS
    ],
    sensitiveKeys: [
      'XAI_API_KEY',
      'GROK_API_KEY',
      ...NETWORK_SENSITIVE_ENVIRONMENT_KEYS
    ]
  },
  sessionModelExtension: GROK_SESSION_MODEL_EXTENSION,
  extensions: {
    noAutomaticUpdates: {
      maturity: 'stable',
      detail: 'The managed ACP process disables self-update for reproducible launches.'
    },
    grokNativeAgent: {
      maturity: 'stable',
      detail: 'Grok Build remains the tool-executing agent; Task Monki is only its ACP client.'
    },
    grokSessionModels: {
      maturity: 'experimental',
      detail:
        'Grok Build session models use the captured grok-build-acp/session-models@v1 vendor contract, not baseline ACP v1.'
    }
  }
};

export const CURSOR_ACP_PROFILE: AcpRuntimeProfile = {
  descriptor: descriptor('cursor-agent-acp', 'Cursor Agent'),
  executableEnvironmentKey: 'TASK_MONKI_CURSOR_AGENT_ACP_BIN',
  // `agent` is a generic binary name used by unrelated products. It remains
  // valid as an explicit user-selected executable after launch-contract
  // attestation, but must never be executed during automatic PATH discovery.
  executableCandidates: ['cursor-agent'],
  argv: ['acp'],
  versionArgv: ['--version'],
  launchContractProbe: {
    argv: ['help', 'acp'],
    description: 'Cursor Agent ACP launch contract',
    requiredOutput: [
      {
        pattern: /(?:Usage:\s+(?:cursor-agent|agent)\s+acp\b|Start the Cursor Agent as an ACP)/iu,
        description: 'Cursor Agent ACP identity'
      }
    ]
  },
  defaultModelProvider: 'cursor',
  defaultModel: 'default',
  environmentPolicy: {
    contractId: 'task-monki/cursor-agent-acp-environment@v1',
    allowedKeys: [
      'CURSOR_API_KEY',
      ...USER_CONFIG_ENVIRONMENT_KEYS,
      ...NETWORK_ENVIRONMENT_KEYS
    ],
    sensitiveKeys: ['CURSOR_API_KEY', ...NETWORK_SENSITIVE_ENVIRONMENT_KEYS]
  },
  extensions: {
    cursorModelSelection: {
      maturity: 'inferred',
      detail: 'Cursor model/provider choices are preserved from native ACP config selectors.'
    },
    cursorAgentRules: {
      maturity: 'stable',
      detail: 'Cursor Agent continues to own its rule and tool behavior.'
    }
  }
};

export const CLAUDE_AGENT_ACP_PROFILE: AcpRuntimeProfile = {
  descriptor: descriptor('claude-agent-acp', 'Claude Agent ACP'),
  executableEnvironmentKey: 'TASK_MONKI_CLAUDE_AGENT_ACP_BIN',
  executableCandidates: ['claude-agent-acp'],
  argv: [],
  versionArgv: ['--version'],
  launchContractProbe: {
    // The bridge has no standalone help mode. Its bridge-specific --cli
    // delegation is the only non-mutating identity probe available before the
    // real ACP process negotiates initialize.
    argv: ['--cli', '--help'],
    description: 'Claude Agent ACP bridge delegation contract',
    requiredOutput: [
      {
        pattern: /\bUsage:\s+claude\b/iu,
        description: 'the bundled Claude CLI delegation entrypoint'
      }
    ]
  },
  defaultModelProvider: 'anthropic',
  defaultModel: 'default',
  environmentPolicy: {
    contractId: 'task-monki/claude-agent-acp-environment@v1',
    allowedKeys: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_VERTEX_BASE_URL',
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_SKIP_VERTEX_AUTH',
      'CLOUD_ML_REGION',
      'DISABLE_PROMPT_CACHING',
      ...AWS_ENVIRONMENT_KEYS,
      ...GOOGLE_ENVIRONMENT_KEYS,
      ...USER_CONFIG_ENVIRONMENT_KEYS,
      ...NETWORK_ENVIRONMENT_KEYS
    ],
    sensitiveKeys: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      ...AWS_SENSITIVE_ENVIRONMENT_KEYS,
      ...GOOGLE_SENSITIVE_ENVIRONMENT_KEYS,
      ...NETWORK_SENSITIVE_ENVIRONMENT_KEYS
    ]
  },
  extensions: {
    claudeAgentSdk: {
      maturity: 'stable',
      detail: 'The upstream claude-agent-acp bridge owns Claude Agent SDK behavior.'
    },
    claudePermissionModes: {
      maturity: 'inferred',
      detail: 'Claude-specific modes and selectors are retained as native ACP state.'
    }
  }
};

export const ACP_RUNTIME_PROFILES = [
  GROK_ACP_PROFILE,
  CURSOR_ACP_PROFILE,
  CLAUDE_AGENT_ACP_PROFILE
] as const;

export function acpCapabilities(
  profile: AcpRuntimeProfile,
  negotiated?: {
    prompt?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    loadSession?: boolean;
    resume?: boolean;
    close?: boolean;
  }
): AgentRuntimeCapabilities {
  const negotiationDetail = negotiated
    ? 'Enabled only when advertised by the connected ACP agent.'
    : 'Pending ACP initialize capability negotiation.';
  return {
    runtimeId: profile.descriptor.id,
    executionPolicy: {
      defaultPresetId: 'provider-controlled-full-access',
      presets: [
        {
          id: 'provider-controlled-full-access',
          label: 'Provider-controlled full access',
          detail: 'The ACP agent process controls filesystem and network access. Task Monki handles reported approvals but cannot attest a sandbox.',
          sandbox: 'DANGER_FULL_ACCESS',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          networkAccess: 'REQUIRED'
        }
      ],
      detail: 'ACP stable v1 does not negotiate an execution sandbox; restricted presets remain unavailable until a provider profile can attest equivalent isolation.'
    },
    promptRefinement: {
      maturity: 'unsupported',
      detail: 'No current ACP profile attests the read-only isolation required for prompt refinement.'
    },
    modelCatalog: {
      maturity: 'inferred',
      detail: profile.sessionModelExtension
        ? `${profile.descriptor.displayName} session models use the explicit ${profile.sessionModelExtension.contractId} provider extension; stable ACP model-category config selectors remain a separate path.`
        : 'ACP has no global model-list method; model-category config selectors are preserved after session setup.'
    },
    reasoningEffort: {
      maturity: 'inferred',
      detail: 'Preserved through native thought-level/model-config selectors when an agent exposes them.'
    },
    persistentSessions: negotiated?.resume || negotiated?.loadSession
      ? {
          maturity: 'stable',
          detail: 'Provider session IDs can be reloaded because the connected agent advertised session/resume or session/load.'
        }
      : {
          maturity: negotiated ? 'unsupported' : 'inferred',
          detail: negotiated
            ? 'Provider session IDs are recorded, but the connected agent advertised no method to reload them after process loss.'
            : negotiationDetail
        },
    sessionResume: negotiated?.resume || negotiated?.loadSession
      ? { maturity: 'stable', detail: negotiationDetail }
      : {
          maturity: negotiated ? 'unsupported' : 'inferred',
          detail: negotiated
            ? 'The connected ACP agent advertised neither session/resume nor session/load.'
            : negotiationDetail
        },
    sessionFork: { maturity: 'unsupported', detail: 'ACP stable v1 has no session fork method.' },
    activeTurnSteering: {
      maturity: 'unsupported',
      detail: 'ACP stable v1 cannot inject another prompt into an active prompt turn.'
    },
    turnInterruption: { maturity: 'stable', detail: 'session/cancel is a stable ACP notification.' },
    truePause: { maturity: 'unsupported', detail: 'ACP stable v1 has cancellation, not pause.' },
    interactiveApprovals: {
      maturity: 'stable',
      detail: 'Opaque permission option IDs are retained and returned exactly.'
    },
    userInputRequests: {
      maturity: 'unsupported',
      detail: 'Stable ACP v1.19.0 has no general user-input request method.'
    },
    goals: { maturity: 'unsupported', detail: 'ACP stable v1 has no goal API.' },
    plans: { maturity: 'stable', detail: 'Plans arrive as typed session/update records.' },
    review: {
      maturity: 'unsupported',
      detail: 'ACP stable v1 has no detached review primitive; review requires a higher-level workflow.'
    },
    subagents: {
      maturity: 'unsupported',
      detail: 'ACP stable v1 does not define subagent lifecycle records.'
    },
    backgroundTerminals: {
      maturity: 'unsupported',
      detail: 'Task Monki advertises terminal=false and never executes agent-requested commands.'
    },
    dynamicTools: {
      maturity: 'unsupported',
      detail: 'Task Monki exposes no client tools to ACP agents.'
    },
    attachmentDelivery: {
      maturity: 'unsupported',
      detail: 'Current ACP profiles have no Task Monki-attested sandbox that protects managed attachment copies from a full-access provider process.'
    },
    runtimeRecovery: {
      maturity: 'stable',
      detail: 'Disconnects fail closed; ambiguous prompts are never replayed automatically.'
    },
    sessionControls: {
      maturity: 'stable',
      detail: 'Provider-owned ACP session selectors are projected as typed, revisioned boolean/select controls.'
    },
    extensions: {
      nativeSessionConfiguration: {
        maturity: 'stable',
        detail: 'Stable ACP mode and config IDs remain exact; renderer state is schema-selected and opaque metadata stays in the protected journal.'
      },
      rawAcpExtensions: {
        maturity: 'stable',
        detail: 'Unknown extension notifications and _meta payloads remain in the protected durable journal.'
      },
      nativeContentBlocks:
        negotiated?.prompt?.image || negotiated?.prompt?.embeddedContext
          ? {
              maturity: 'stable',
              detail: 'The agent negotiated native ACP content blocks, but Task Monki attachments remain disabled until confidentiality isolation is attested.'
            }
          : {
              maturity: negotiated ? 'stable' : 'inferred',
              detail: negotiated
                ? 'Text and resource links are baseline ACP content; richer blocks were not advertised.'
                : negotiationDetail
            },
      sessionClose: negotiated?.close
        ? { maturity: 'stable', detail: negotiationDetail }
        : {
            maturity: negotiated ? 'unsupported' : 'inferred',
            detail: negotiated ? 'The connected agent did not advertise session/close.' : negotiationDetail
          },
      ...profile.extensions
    }
  };
}

export function defaultAcpModel(
  profile: AcpRuntimeProfile,
  inputModalities: string[] = ['text']
): AgentModel {
  return {
    id: `${profile.descriptor.id}:${profile.defaultModelProvider}/${profile.defaultModel}`,
    runtimeId: profile.descriptor.id,
    modelProvider: profile.defaultModelProvider,
    model: profile.defaultModel,
    displayName: `${profile.descriptor.displayName} default`,
    description: 'The agent selects its configured default model. Native choices appear after session setup.',
    hidden: false,
    supportedReasoningEfforts: [],
    serviceTiers: [],
    inputModalities,
    isDefault: true,
    native: { source: 'profile-default' }
  };
}

export function requireAcpRuntimeProfile(runtimeId: string): AcpRuntimeProfile {
  const profile = ACP_RUNTIME_PROFILES.find((candidate) => candidate.descriptor.id === runtimeId);
  if (!profile) throw new Error(`Unknown ACP runtime profile: ${runtimeId}`);
  return profile;
}
