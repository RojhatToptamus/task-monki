import { describe, expect, it } from 'vitest';
import {
  formatAgentNetworkAccess,
  formatAgentPermissionMode,
  inferAgentPermissionMode,
  settingsForPermissionMode
} from './agentPermissions';

describe('agent permission settings', () => {
  it('maps the Codex-style permission presets to execution settings', () => {
    expect(
      settingsForPermissionMode('ASK_FOR_APPROVAL', { networkAccess: true })
    ).toEqual({
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user'
    });
    expect(
      settingsForPermissionMode('APPROVE_FOR_ME', { networkAccess: true })
    ).toEqual({
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review'
    });
    expect(settingsForPermissionMode('APPROVE_FOR_ME')).toEqual({
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review'
    });
    expect(
      settingsForPermissionMode('FULL_ACCESS', { networkAccess: false })
    ).toEqual({
      sandbox: 'DANGER_FULL_ACCESS',
      networkAccess: true,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    });
  });

  it('detects task-specific approval reviewer modes without creating run states', () => {
    expect(
      inferAgentPermissionMode({
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review'
      })
    ).toBe('APPROVE_FOR_ME');
    expect(
      formatAgentPermissionMode({
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review'
      })
    ).toBe('Approve for me');
    expect(
      formatAgentNetworkAccess({
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      })
    ).toBe('Enabled');
  });
});
