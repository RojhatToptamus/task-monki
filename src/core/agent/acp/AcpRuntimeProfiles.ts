import type {
  AgentModel,
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor,
  AgentRuntimeId
} from '../../../shared/agent';

export interface AcpRuntimeProfile {
  descriptor: AgentRuntimeDescriptor;
  executableCandidates: readonly string[];
  argv: readonly string[];
  versionArgv: readonly string[];
  defaultModelProvider: string;
  defaultModel: string;
  /** Credential/configuration keys this specific child is allowed to inherit. */
  allowedEnvironmentKeys: readonly string[];
  /** Extra proof required for ambiguous executable names discovered from PATH. */
  discoveryIdentity?: {
    executableNames: readonly string[];
    argv: readonly string[];
    outputPattern: RegExp;
    description: string;
  };
  /** Profile-owned facts only; negotiated ACP capabilities are added at runtime. */
  extensions: Readonly<Record<string, { maturity: 'stable' | 'experimental' | 'inferred'; detail: string }>>;
}

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
export const GEMINI_ACP_PROFILE: AcpRuntimeProfile = {
  descriptor: descriptor('gemini-acp', 'Gemini CLI'),
  executableCandidates: ['gemini'],
  argv: ['--acp'],
  versionArgv: ['--version'],
  defaultModelProvider: 'google',
  defaultModel: 'default',
  allowedEnvironmentKeys: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_APPLICATION_CREDENTIALS'
  ],
  extensions: {
    geminiSessionModes: {
      maturity: 'stable',
      detail: 'Gemini approval modes are retained as native ACP session modes/configuration.'
    },
    geminiExtensions: {
      maturity: 'stable',
      detail: 'Gemini CLI extensions remain agent-owned; Task Monki does not reinterpret them.'
    }
  }
};

export const GROK_ACP_PROFILE: AcpRuntimeProfile = {
  descriptor: descriptor('grok-acp', 'Grok Build'),
  executableCandidates: ['grok'],
  argv: ['--no-auto-update', 'agent', 'stdio'],
  versionArgv: ['--version'],
  defaultModelProvider: 'xai',
  defaultModel: 'default',
  allowedEnvironmentKeys: ['XAI_API_KEY', 'GROK_API_KEY'],
  extensions: {
    noAutomaticUpdates: {
      maturity: 'stable',
      detail: 'The managed ACP process disables self-update for reproducible launches.'
    },
    grokNativeAgent: {
      maturity: 'stable',
      detail: 'Grok Build remains the tool-executing agent; Task Monki is only its ACP client.'
    }
  }
};

export const CURSOR_ACP_PROFILE: AcpRuntimeProfile = {
  descriptor: descriptor('cursor-agent-acp', 'Cursor Agent'),
  executableCandidates: ['cursor-agent', 'agent'],
  argv: ['acp'],
  versionArgv: ['--version'],
  defaultModelProvider: 'cursor',
  defaultModel: 'default',
  allowedEnvironmentKeys: ['CURSOR_API_KEY'],
  discoveryIdentity: {
    executableNames: ['agent'],
    argv: ['help', 'acp'],
    outputPattern: /(?:Usage:\s+agent\s+acp|Start the Cursor Agent as an ACP)/iu,
    description: 'Cursor Agent ACP help identity'
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
  executableCandidates: ['claude-agent-acp'],
  argv: [],
  versionArgv: ['--version'],
  defaultModelProvider: 'anthropic',
  defaultModel: 'default',
  allowedEnvironmentKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
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
  GEMINI_ACP_PROFILE,
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
      detail: 'ACP has no global model-list method; models come from native session config selectors.'
    },
    reasoningEffort: {
      maturity: 'inferred',
      detail: 'Preserved through native thought-level/model-config selectors when an agent exposes them.'
    },
    persistentSessions: { maturity: 'stable', detail: 'ACP sessions have provider-owned IDs.' },
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
    extensions: {
      nativeSessionConfiguration: {
        maturity: 'stable',
        detail: 'Operational mode/config IDs remain exact; renderer state is schema-selected and opaque metadata stays in the protected journal.'
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
