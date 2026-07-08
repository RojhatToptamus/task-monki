import {
  normalizeAgentApprovalsReviewer,
  type AgentApprovalsReviewer,
  type AgentExecutionSettings
} from '../../shared/contracts';

export type AgentPermissionMode =
  | 'ASK_FOR_APPROVAL'
  | 'APPROVE_FOR_ME'
  | 'FULL_ACCESS'
  | 'CUSTOM';

export type SelectableAgentPermissionMode = Exclude<AgentPermissionMode, 'CUSTOM'>;

export const AGENT_PERMISSION_MODE_OPTIONS: Array<{
  value: SelectableAgentPermissionMode;
  label: string;
}> = [
  { value: 'ASK_FOR_APPROVAL', label: 'Ask for approval' },
  { value: 'APPROVE_FOR_ME', label: 'Approve for me' },
  { value: 'FULL_ACCESS', label: 'Full access' }
];

export interface AgentPermissionSettings {
  sandbox: NonNullable<AgentExecutionSettings['sandbox']>;
  networkAccess: boolean;
  approvalPolicy: string;
  approvalsReviewer: AgentApprovalsReviewer;
}

export function settingsForPermissionMode(
  mode: SelectableAgentPermissionMode,
  options: { networkAccess?: boolean } = {}
): AgentPermissionSettings {
  const networkAccess = mode === 'FULL_ACCESS' ? true : (options.networkAccess ?? false);
  switch (mode) {
    case 'APPROVE_FOR_ME':
      return {
        sandbox: 'WORKSPACE_WRITE',
        networkAccess,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review'
      };
    case 'FULL_ACCESS':
      return {
        sandbox: 'DANGER_FULL_ACCESS',
        networkAccess,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      };
    case 'ASK_FOR_APPROVAL':
      return {
        sandbox: 'WORKSPACE_WRITE',
        networkAccess,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      };
  }
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
