import {
  normalizeAgentApprovalsReviewer,
  type AgentApprovalsReviewer,
  type AgentExecutionPolicyPreset,
  type AgentExecutionSettings
} from '../../shared/contracts';

export type AgentPermissionMode =
  | 'SANDBOXED'
  | 'ASK_FOR_APPROVAL'
  | 'APPROVE_FOR_ME'
  | 'FULL_ACCESS'
  | 'CUSTOM';

export interface AgentPermissionSettings {
  sandbox: NonNullable<AgentExecutionSettings['sandbox']>;
  networkAccess: boolean;
  approvalPolicy: string;
  approvalsReviewer: AgentApprovalsReviewer;
}

export function settingsForExecutionPolicyPreset(
  preset: AgentExecutionPolicyPreset,
  options: { networkAccess?: boolean } = {}
): AgentPermissionSettings {
  return {
    sandbox: preset.sandbox,
    networkAccess:
      preset.networkAccess === 'REQUIRED'
        ? true
        : preset.networkAccess === 'DISABLED'
          ? false
          : options.networkAccess === true,
    approvalPolicy: preset.approvalPolicy,
    approvalsReviewer: preset.approvalsReviewer
  };
}

export function inferAgentPermissionMode(
  settings: AgentExecutionSettings
): AgentPermissionMode {
  const sandbox = settings.sandbox ?? 'WORKSPACE_WRITE';
  const approvalPolicy = settings.approvalPolicy ?? 'on-request';
  const approvalsReviewer = normalizeAgentApprovalsReviewer(
    settings.approvalsReviewer
  );

  if (sandbox === 'DANGER_FULL_ACCESS' && approvalPolicy === 'never') {
    return 'FULL_ACCESS';
  }
  if (
    sandbox === 'DANGER_FULL_ACCESS' &&
    approvalPolicy === 'on-request' &&
    approvalsReviewer === 'user'
  ) {
    return 'ASK_FOR_APPROVAL';
  }
  if (
    (sandbox === 'WORKSPACE_WRITE' || sandbox === 'READ_ONLY') &&
    settings.networkAccess !== true &&
    approvalPolicy === 'never' &&
    approvalsReviewer === 'user'
  ) {
    return 'SANDBOXED';
  }
  if (
    sandbox === 'WORKSPACE_WRITE' &&
    approvalPolicy !== 'never' &&
    approvalsReviewer === 'auto_review'
  ) {
    return 'APPROVE_FOR_ME';
  }
  if (
    sandbox === 'WORKSPACE_WRITE' &&
    approvalPolicy !== 'never' &&
    approvalsReviewer === 'user'
  ) {
    return 'ASK_FOR_APPROVAL';
  }
  return 'CUSTOM';
}

export function formatAgentPermissionMode(
  settings: AgentExecutionSettings
): string {
  switch (inferAgentPermissionMode(settings)) {
    case 'SANDBOXED':
      return 'Sandboxed';
    case 'ASK_FOR_APPROVAL':
      return 'Ask for approval';
    case 'APPROVE_FOR_ME':
      return 'Approve for me';
    case 'FULL_ACCESS':
      return 'Full access';
    case 'CUSTOM':
      return 'Custom';
  }
}

export function isAgentNetworkAccessEnabled(
  settings: AgentExecutionSettings
): boolean {
  return settings.sandbox === 'DANGER_FULL_ACCESS' || settings.networkAccess === true;
}

export function formatAgentNetworkAccess(settings: AgentExecutionSettings): string {
  return isAgentNetworkAccessEnabled(settings) ? 'Enabled' : 'Disabled';
}
