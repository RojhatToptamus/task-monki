import type {
  AgentExecutionPolicyCapability,
  AgentExecutionPolicyPreset,
  AgentExecutionSettings,
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor
} from '../../shared/contracts';
import { PREVIEW_AGENT_EXTENSION } from '../../shared/agentExecutionSupport';

export const BROWSER_DEV_ISOLATION_CAPABILITY =
  'task-monki.browser-dev-isolation';

export const BROWSER_DEV_BOUNDARY_MESSAGE =
  'The browser development server only permits non-escalatable agent runs: use a managed or read-only sandbox, disable network access, set approval policy to never, and use the user approval reviewer. Use the Electron app for other permission modes.';

export const BROWSER_DEV_PREVIEW_AGENT_MESSAGE =
  'The Preview agent is unavailable in the browser development server: it asks before reading folders outside the task worktree, and that server only permits runs that cannot ask. Use the Electron app for the Preview agent.';

export function browserDevSettingsViolations(
  settings: AgentExecutionSettings
): string[] {
  const violations: string[] = [];
  if (settings.sandbox === 'DANGER_FULL_ACCESS') {
    violations.push('uses full-access sandboxing');
  }
  if (settings.networkAccess === true) {
    violations.push('enables network access');
  }
  if (settings.approvalPolicy !== 'never') {
    violations.push('uses an escalatable approval policy');
  }
  if (
    settings.approvalsReviewer === 'auto_review' ||
    settings.approvalsReviewer === 'guardian_subagent'
  ) {
    violations.push('uses an automated approval reviewer');
  }
  return violations;
}

export function assertBrowserDevSettingsSafe(
  settings: AgentExecutionSettings,
  subject: string
): void {
  const violations = browserDevSettingsViolations(settings);
  if (violations.length > 0) {
    throw new Error(
      `${BROWSER_DEV_BOUNDARY_MESSAGE} ${subject} is unsafe: ${violations.join(', ')}.`
    );
  }
}

/** The settings a preset applies before explicit choices: an optional network is off. */
export function executionPresetSettings(preset: AgentExecutionPolicyPreset): AgentExecutionSettings {
  return {
    sandbox: preset.sandbox,
    approvalPolicy: preset.approvalPolicy,
    approvalsReviewer: preset.approvalsReviewer,
    networkAccess: preset.networkAccess === 'REQUIRED'
  };
}

/**
 * The execution policy as the browser development server offers it. When the runtime's
 * default preset would be rejected there, the default becomes the first browser-safe
 * preset that may change the repository, else the first browser-safe preset. Every
 * preset stays listed so stored settings keep their names. Without a safe preset the
 * policy is unchanged and starting a run reports the boundary.
 */
export function browserDevExecutionPolicy(
  policy: AgentExecutionPolicyCapability
): AgentExecutionPolicyCapability {
  const safe = policy.presets.filter(
    (preset) => browserDevSettingsViolations(executionPresetSettings(preset)).length === 0
  );
  if (safe.some((preset) => preset.id === policy.defaultPresetId)) return policy;
  const fallback = safe.find((preset) => preset.repositoryMutation === 'ALLOW') ?? safe[0];
  return fallback ? { ...policy, defaultPresetId: fallback.id } : policy;
}

/**
 * A runtime's capabilities as the browser development server offers them: a default
 * preset it permits, and no Preview agent, whose folder requests need an escalatable
 * approval policy. The catalog and run admission use this same projection.
 */
export function browserDevCapabilities(
  capabilities: AgentRuntimeCapabilities
): AgentRuntimeCapabilities {
  return {
    ...capabilities,
    executionPolicy: browserDevExecutionPolicy(capabilities.executionPolicy),
    extensions: {
      ...capabilities.extensions,
      [PREVIEW_AGENT_EXTENSION]: { maturity: 'unsupported', detail: BROWSER_DEV_PREVIEW_AGENT_MESSAGE }
    }
  };
}

export function assertBrowserDevRuntimeIsolation(
  runtime: AgentRuntimeDescriptor,
  capabilities: AgentRuntimeCapabilities
): void {
  if (!hasBrowserDevRuntimeIsolation(capabilities)) {
    throw new Error(
      `${BROWSER_DEV_BOUNDARY_MESSAGE} ${runtime.displayName} does not attest the process, filesystem, and network isolation required before the browser API credential is published.`
    );
  }
}

export function hasBrowserDevRuntimeIsolation(
  capabilities: AgentRuntimeCapabilities
): boolean {
  return (
    capabilities.extensions[BROWSER_DEV_ISOLATION_CAPABILITY]?.maturity ===
    'stable'
  );
}
