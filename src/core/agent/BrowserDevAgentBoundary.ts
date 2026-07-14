import type {
  AgentExecutionSettings,
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor
} from '../../shared/contracts';

export const BROWSER_DEV_ISOLATION_CAPABILITY =
  'task-monki.browser-dev-isolation';

export const BROWSER_DEV_BOUNDARY_MESSAGE =
  'The browser development server only permits non-escalatable agent runs: use a managed or read-only sandbox, disable network access, set approval policy to never, and use the user approval reviewer. Use the Electron app for other permission modes.';

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
