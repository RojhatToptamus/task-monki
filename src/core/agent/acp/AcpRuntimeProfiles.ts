import type {
  AgentDesignCapability,
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
  /**
   * Provider-owned model catalog available before session creation. Stable ACP
   * does not define this method, so both the request and initialize capability
   * stay gated by an exact, versioned profile contract.
   */
  parameterizedModelCatalog?: AcpParameterizedModelCatalogContract;
  /** Access policies Task Monki can enforce for this provider's ACP requests. */
  approvalPolicies?: readonly AcpApprovalPolicy[];
  /**
   * Exact provider policy used for shared read-only turns. Most profiles use a
   * native session mode. A qualified provider can instead require a separate,
   * process-scoped sandbox.
   */
  readOnlyTurnPolicy?:
    | {
        kind: 'SESSION_MODE';
        modeId: string;
        policyId: string;
        detail: string;
      }
    | {
        kind: 'DEDICATED_PROCESS';
        policyId: string;
        detail: string;
        runtimeVersion: string;
        platform: NodeJS.Platform;
        launchArgv: readonly string[];
        startupFailurePattern: RegExp;
      };
  /** Why this profile cannot currently run shared read-only workflows. */
  readOnlyTurnUnavailableReason?: string;
  /**
   * Exact provider text that represents a failed turn despite an ACP
   * `end_turn` response. This is profile-owned because ACP has no structured
   * account or usage-limit terminal reason.
   */
  terminalFailureMessage?: {
    exactText: string;
    diagnostic: string;
  };
  /** The provider may offer an exact option whose remembered scope it owns. */
  allowRememberedPermissions?: true;
  /** Exact native ACP mapping enabled by a packaged content-use test. */
  attachmentTextTransport?: 'embedded-resource' | 'text-block';
  /** Why this profile has no qualified managed-attachment delivery. */
  attachmentDeliveryUnavailableReason?: string;
  /** Exact runtime/model pairs proven to consume native ACP image blocks. */
  imageInputQualifications?: readonly AcpImageInputQualification[];
  /** Exact runtime/model pairs proven to support the required Design infrastructure in packaged runs. */
  designQualifications?: readonly AcpDesignQualification[];
  /** The qualified Design path needs ACP additional-directories access to the app-owned skill root. */
  designSkillAdditionalDirectoryRequired?: true;
}

export interface AcpImageInputQualification {
  runtimeVersion: string;
  modelId: string;
  /** Narrow compatibility exception for an agent with a proven false capability flag. */
  allowWhenNotAdvertised?: true;
  /** Provider/model formats allowed through this exact qualified path. */
  mediaTypes: readonly [string, ...string[]];
}

export interface AcpDesignQualification {
  runtimeVersion: string;
  modelId: string;
  /** Optional Design-only default proven by the exact packaged qualification. */
  defaultReasoningEffort?: string;
}

export interface AcpImageInputSupport {
  advertised?: boolean;
  enabled: boolean;
  qualification?: AcpImageInputQualification;
  capabilityDrift: boolean;
  unavailableReason?: string;
}

export type AcpApprovalPolicy = 'on-request' | 'auto-accept-edits' | 'never';

export interface AcpParameterizedModelCatalogContract {
  contractId: string;
  listModelsMethod: 'cursor/list_available_models';
  clientCapabilityMeta: Readonly<{ parameterizedModelPicker: true }>;
}

export interface AcpSessionModelExtensionContract {
  contractId: string;
  /** Provider-owned catalog advertised during ACP initialize, before a session exists. */
  initializeResponseMetaField?: 'modelState';
  setupResponseField: 'models';
  setModelMethod: 'session/set_model';
  /** Provider metadata field accepted by session/set_model for exact effort selection. */
  setModelReasoningEffortMetaField?: 'reasoningEffort';
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
  setModelReasoningEffortMetaField: 'reasoningEffort',
  modelUpdateNotification: '_x.ai/models/update'
} as const satisfies AcpSessionModelExtensionContract;

/** Captured Cursor ACP parameterized-model-picker vendor contract. */
export const CURSOR_PARAMETERIZED_MODEL_CATALOG = {
  contractId: 'cursor-agent-acp/parameterized-model-picker@v1',
  listModelsMethod: 'cursor/list_available_models',
  clientCapabilityMeta: { parameterizedModelPicker: true }
} as const satisfies AcpParameterizedModelCatalogContract;

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
  argv: ['--no-auto-update', '--permission-mode', 'default', 'agent', 'stdio'],
  versionArgv: ['--version'],
  launchContractProbe: {
    argv: [
      '--no-auto-update',
      '--permission-mode',
      'default',
      'agent',
      'stdio',
      '--help'
    ],
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
  // The CLI's process-scoped default mode reports native permission requests.
  // Task Monki decides only how to answer those exact requests; Grok still owns
  // its documented global allow/deny rules and the unconfined agent process.
  approvalPolicies: ['on-request', 'auto-accept-edits', 'never'],
  readOnlyTurnPolicy: {
    kind: 'DEDICATED_PROCESS',
    policyId: 'grok-build/read-only-process@1.0.13',
    detail:
      'A separate Grok Build process uses its read-only sandbox, denies direct edit, write, and MCP tools, and denies Task Monki permission requests.',
    runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
    platform: 'darwin',
    launchArgv: [
      '--no-auto-update',
      '--sandbox',
      'read-only',
      '--permission-mode',
      'dontAsk',
      '--deny',
      'Edit(*)',
      '--deny',
      'Write(*)',
      '--deny',
      'MCPTool(*)',
      '--no-subagents',
      '--disable-web-search',
      'agent',
      '--no-leader',
      'stdio'
    ],
    startupFailurePattern:
      /sandbox could not be applied|could not apply the ['"]read-only['"] sandbox profile|refusing to start without sandbox enforcement/iu
  },
  allowRememberedPermissions: true,
  attachmentTextTransport: 'embedded-resource',
  imageInputQualifications: [
    {
      runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
      modelId: 'grok-4.6',
      allowWhenNotAdvertised: true,
      mediaTypes: ['image/png']
    }
  ],
  designQualifications: [
    {
      runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
      modelId: 'grok-4.6',
      defaultReasoningEffort: 'low'
    }
  ],
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
  sessionModelExtension: GROK_SESSION_MODEL_EXTENSION
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
  parameterizedModelCatalog: CURSOR_PARAMETERIZED_MODEL_CATALOG,
  approvalPolicies: ['on-request', 'auto-accept-edits', 'never'],
  readOnlyTurnPolicy: {
    kind: 'SESSION_MODE',
    modeId: 'ask',
    policyId: 'cursor-agent-acp/ask-read-only@v1',
    detail:
      'Cursor Ask mode provides read-only code exploration. Task Monki also rejects every permission request and compares repository state after the turn.'
  },
  terminalFailureMessage: {
    exactText: 'Upgrade your plan to continue',
    diagnostic:
      'Cursor Agent could not continue because the current account plan or usage allowance requires an upgrade.'
  },
  allowRememberedPermissions: true,
  attachmentTextTransport: 'text-block',
  imageInputQualifications: [
    {
      runtimeVersion: '2026.08.25-3e8eec8',
      modelId: 'composer-2.5',
      mediaTypes: ['image/png']
    }
  ],
  designQualifications: [
    {
      runtimeVersion: '2026.08.25-3e8eec8',
      modelId: 'composer-2.5'
    }
  ],
  environmentPolicy: {
    contractId: 'task-monki/cursor-agent-acp-environment@v1',
    allowedKeys: [
      'CURSOR_API_KEY',
      ...USER_CONFIG_ENVIRONMENT_KEYS,
      ...NETWORK_ENVIRONMENT_KEYS
    ],
    sensitiveKeys: ['CURSOR_API_KEY', ...NETWORK_SENSITIVE_ENVIRONMENT_KEYS]
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
  approvalPolicies: ['on-request', 'never'],
  readOnlyTurnPolicy: {
    kind: 'SESSION_MODE',
    modeId: 'plan',
    policyId: 'claude-agent-acp/plan-read-only@v1',
    detail:
      'Claude Agent ACP plan mode denies tool execution. Task Monki also rejects every permission request and compares repository state after the turn.'
  },
  attachmentTextTransport: 'embedded-resource',
  imageInputQualifications: [
    {
      runtimeVersion: '0.70.0',
      modelId: 'sonnet',
      mediaTypes: ['image/png']
    }
  ],
  designQualifications: [
    {
      runtimeVersion: '0.70.0',
      modelId: 'sonnet'
    }
  ],
  designSkillAdditionalDirectoryRequired: true,
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
    runtimeVersion?: string;
    platform?: NodeJS.Platform;
  }
): AgentRuntimeCapabilities {
  const negotiationDetail = negotiated
    ? 'Enabled only when advertised by the connected ACP agent.'
    : 'Pending ACP initialize capability negotiation.';
  const approvalPolicies = profile.approvalPolicies ?? ['on-request'];
  const hasQualifiedModelSelections = Boolean(
    !profile.sessionModelExtension &&
      !profile.parameterizedModelCatalog &&
      (profile.imageInputQualifications?.length || profile.designQualifications?.length)
  );
  const normalExecutionPresets = approvalPolicies.map((approvalPolicy) => {
    switch (approvalPolicy) {
      case 'on-request':
        return {
          id: 'ask-for-approval',
          label: 'Ask for approval',
          detail:
            'Task Monki asks before provider-reported operations. The ACP agent process is not sandboxed, so unreported activity cannot be confined.',
          sandbox: 'DANGER_FULL_ACCESS' as const,
          approvalPolicy,
          approvalsReviewer: 'user' as const,
          repositoryMutation: 'ASK' as const,
          networkAccess: 'REQUIRED' as const
        };
      case 'auto-accept-edits':
        return {
          id: 'auto-accept-edits',
          label: 'Auto-accept edits',
          detail:
            'Verified file changes inside the task worktree are accepted once. Commands and other provider-reported operations still require approval; the provider process is not sandboxed.',
          sandbox: 'DANGER_FULL_ACCESS' as const,
          approvalPolicy,
          approvalsReviewer: 'user' as const,
          repositoryMutation: 'ALLOW' as const,
          networkAccess: 'REQUIRED' as const
        };
      case 'never':
        return {
          id: 'full-access',
          label: 'Full access',
          detail:
            'Exact one-time provider permission requests are accepted automatically. Remembered choices always require explicit confirmation. The ACP agent process has unconfined filesystem and network access.',
          sandbox: 'DANGER_FULL_ACCESS' as const,
          approvalPolicy,
          approvalsReviewer: 'user' as const,
          repositoryMutation: 'ALLOW' as const,
          networkAccess: 'REQUIRED' as const
        };
    }
  });
  const configuredReadOnlyPolicy = profile.readOnlyTurnPolicy;
  const dedicatedProcessQualified =
    configuredReadOnlyPolicy?.kind !== 'DEDICATED_PROCESS' ||
    (negotiated?.runtimeVersion === configuredReadOnlyPolicy.runtimeVersion &&
      negotiated.platform === configuredReadOnlyPolicy.platform);
  const readOnlyPolicy = dedicatedProcessQualified
    ? configuredReadOnlyPolicy
    : undefined;
  const executionPresets = [
    ...normalExecutionPresets,
    ...(readOnlyPolicy?.kind === 'SESSION_MODE'
      ? [
          {
            id: 'native-read-only',
            label: 'Read-only',
            detail: `${readOnlyPolicy.detail} The provider process still has normal user permissions and is not operating-system sandboxed.`,
            sandbox: 'DANGER_FULL_ACCESS' as const,
            approvalPolicy: 'NEVER',
            approvalsReviewer: 'user' as const,
            repositoryMutation: 'DENY' as const,
            networkAccess: 'REQUIRED' as const
          }
        ]
      : [])
  ];
  const readOnlyCapability = readOnlyPolicy
    ? {
        maturity: 'stable' as const,
        detail: readOnlyPolicy.detail
      }
    : {
        maturity: 'unsupported' as const,
        detail:
          configuredReadOnlyPolicy?.kind === 'DEDICATED_PROCESS'
            ? `${profile.descriptor.displayName} read-only work requires ${configuredReadOnlyPolicy.runtimeVersion} on ${configuredReadOnlyPolicy.platform}. Found ${negotiated?.runtimeVersion ?? 'an unknown runtime version'} on ${negotiated?.platform ?? 'an unknown platform'}.`
            : profile.readOnlyTurnUnavailableReason ??
              `${profile.descriptor.displayName} has no qualified native repository-mutation denial policy.`
      };
  return {
    runtimeId: profile.descriptor.id,
    executionPolicy: {
      defaultPresetId: normalExecutionPresets[0]!.id,
      presets: executionPresets,
      detail:
        readOnlyPolicy?.kind === 'DEDICATED_PROCESS'
          ? 'Normal ACP access modes govern Task Monki responses to reported permission requests. Read-only work uses a separate provider process with its qualified native process sandbox.'
          : 'Access modes govern Task Monki responses to reported ACP permission requests. ACP does not provide an enforceable process sandbox.'
    },
    readOnlyTurns: readOnlyCapability,
    modelCatalog: {
      maturity: 'inferred',
      ...(profile.parameterizedModelCatalog || hasQualifiedModelSelections
        ? { activation: 'EXPLICIT' as const }
        : {}),
      detail: profile.sessionModelExtension
        ? `${profile.descriptor.displayName} session models use the explicit ${profile.sessionModelExtension.contractId} provider extension; stable ACP model-category config selectors remain a separate path.`
        : profile.parameterizedModelCatalog
          ? `Models are loaded on demand through the explicit ${profile.parameterizedModelCatalog.contractId} provider extension and revalidated by every new session.`
          : hasQualifiedModelSelections
            ? 'Exact packaged model selections are shown before session creation. The connected provider session must advertise and accept the selected model before prompt delivery.'
            : 'ACP has no global model-list method; model-category config selectors are preserved after session setup.'
    },
    activeTurnSteering: {
      maturity: 'unsupported',
      detail: 'ACP stable v1 cannot inject another prompt into an active prompt turn.'
    },
    turnInterruption: { maturity: 'stable', detail: 'session/cancel is a stable ACP notification.' },
    attachmentDelivery: acpAttachmentCapability(profile, negotiated?.prompt),
    extensions: {
      'task-monki.design-instructions': {
        maturity: 'unsupported',
        detail: 'ACP currently receives Design guidance only as user prompt text.'
      },
      'task-monki.design-skill-access': {
        maturity: 'unsupported',
        detail: 'ACP cannot attest a restricted app-owned read root for Design skills.'
      }
    }
  };
}

function acpAttachmentCapability(
  profile: AcpRuntimeProfile,
  prompt: { image?: boolean; embeddedContext?: boolean } | undefined
): AgentRuntimeCapabilities['attachmentDelivery'] {
  if (!profile.attachmentTextTransport) {
    return {
      maturity: 'unsupported',
      detail:
        profile.attachmentDeliveryUnavailableReason ??
        `${profile.descriptor.displayName} has no qualified managed-attachment transport.`
    };
  }
  if (
    profile.attachmentTextTransport === 'embedded-resource' &&
    prompt &&
    prompt.embeddedContext !== true
  ) {
    return {
      maturity: 'unsupported',
      detail: `${profile.descriptor.displayName} did not negotiate ACP embedded context for text attachments.`
    };
  }
  return {
    maturity: prompt || profile.attachmentTextTransport === 'text-block'
      ? 'stable'
      : 'inferred',
    detail:
      profile.attachmentTextTransport === 'embedded-resource'
        ? 'Verified text files use native ACP embedded resources after capability negotiation.'
        : 'Verified text files use bounded ACP text content blocks.'
  };
}

export function acpModelInputModalities(input: {
  profile: AcpRuntimeProfile;
  promptCapabilities?: { image?: boolean; audio?: boolean };
  runtimeVersion?: string;
  modelId: string;
}): string[] {
  const imageSupport = acpImageInputSupport(input);
  return [
    'text',
    ...(imageSupport.enabled ? ['image'] : []),
    ...(input.promptCapabilities?.audio ? ['audio'] : [])
  ];
}

export function acpImageInputSupport(input: {
  profile: AcpRuntimeProfile;
  promptCapabilities?: { image?: boolean };
  runtimeVersion?: string;
  modelId: string;
}): AcpImageInputSupport {
  const advertised = input.promptCapabilities?.image;
  const qualification = input.runtimeVersion && input.modelId !== 'default'
    ? input.profile.imageInputQualifications?.find(
        (candidate) =>
          candidate.runtimeVersion === input.runtimeVersion &&
          candidate.modelId === input.modelId
      )
    : undefined;
  const capabilityDrift = Boolean(
    qualification?.allowWhenNotAdvertised && advertised === false
  );
  const enabled = Boolean(qualification && (advertised || capabilityDrift));
  if (enabled) {
    return { advertised, enabled, qualification, capabilityDrift };
  }

  const runtime = input.runtimeVersion ?? 'an unknown runtime version';
  const unavailableReason = input.modelId === 'default'
    ? `${input.profile.descriptor.displayName} automatic model selection is not image-qualified.`
    : !qualification
      ? advertised === true
        ? `${input.profile.descriptor.displayName} advertises ACP image input, but ${input.modelId} on ${runtime} has not passed Task Monki image qualification.`
        : advertised === false
          ? `${input.profile.descriptor.displayName} did not advertise ACP image input, and ${input.modelId} on ${runtime} has no verified compatibility exception.`
          : `${input.profile.descriptor.displayName} did not report whether ACP image input is supported for ${input.modelId} on ${runtime}.`
      : advertised === false
        ? `${input.profile.descriptor.displayName} did not advertise ACP image input for ${input.modelId} on ${runtime}.`
        : `${input.profile.descriptor.displayName} did not report ACP image support for ${input.modelId} on ${runtime}.`;
  return {
    advertised,
    enabled: false,
    qualification,
    capabilityDrift: false,
    unavailableReason
  };
}

export function acpDesignSupport(input: {
  profile: AcpRuntimeProfile;
  runtimeVersion?: string;
  modelId: string;
}): AgentDesignCapability {
  const qualification = input.runtimeVersion
    ? input.profile.designQualifications?.find(
        (candidate) =>
          candidate.runtimeVersion === input.runtimeVersion &&
          candidate.modelId === input.modelId
      )
    : undefined;
  return qualification
    ? {
        maturity: 'stable',
        detail: `${input.profile.descriptor.displayName} ${qualification.runtimeVersion} with ${qualification.modelId} passed the packaged Design instruction, skill, MCP image-result, browser, candidate, and cleanup qualification.`,
        ...(qualification.defaultReasoningEffort
          ? { defaultReasoningEffort: qualification.defaultReasoningEffort }
          : {})
      }
    : {
        maturity: 'unsupported',
        detail: `${input.profile.descriptor.displayName} ${input.runtimeVersion ?? 'unknown version'} model ${input.modelId} has not passed the required packaged Design technical qualification.`
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
    displayName: profile.parameterizedModelCatalog
      ? 'Auto'
      : `${profile.descriptor.displayName} default`,
    description: profile.parameterizedModelCatalog
      ? 'The provider selects a model automatically. Select Cursor to load its current model catalog.'
      : 'The agent selects its configured default model. Native choices appear after session setup.',
    hidden: false,
    supportedReasoningEfforts: [],
    serviceTiers: [],
    inputModalities,
    isDefault: true,
    native: {
      source: profile.parameterizedModelCatalog?.contractId ?? 'profile-default'
    }
  };
}

export function requireAcpRuntimeProfile(runtimeId: string): AcpRuntimeProfile {
  const profile = ACP_RUNTIME_PROFILES.find((candidate) => candidate.descriptor.id === runtimeId);
  if (!profile) throw new Error(`Unknown ACP runtime profile: ${runtimeId}`);
  return profile;
}
