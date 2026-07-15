import { describe, expect, it } from 'vitest';
import { browserDevSettingsViolations } from '../../core/agent/BrowserDevAgentBoundary';
import {
  formatAgentNetworkAccess,
  formatAgentPermissionMode,
  inferAgentPermissionMode,
  settingsForExecutionPolicyPreset
} from './agentPermissions';
import type { AgentExecutionPolicyPreset } from '../../shared/contracts';

describe('agent permission settings', () => {
  it('maps runtime-owned permission presets to execution settings', () => {
    const sandboxed = settingsForExecutionPolicyPreset(preset({
      id: 'sandboxed',
      sandbox: 'WORKSPACE_WRITE',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      networkAccess: 'DISABLED'
    }), {
      networkAccess: true
    });
    expect(sandboxed).toEqual({
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    });
    expect(browserDevSettingsViolations(sandboxed)).toEqual([]);
    expect(
      settingsForExecutionPolicyPreset(preset({
        id: 'ask',
        sandbox: 'WORKSPACE_WRITE',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        networkAccess: 'OPTIONAL'
      }), { networkAccess: true })
    ).toEqual({
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user'
    });
    expect(
      settingsForExecutionPolicyPreset(preset({
        id: 'auto',
        sandbox: 'WORKSPACE_WRITE',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        networkAccess: 'OPTIONAL'
      }), { networkAccess: true })
    ).toEqual({
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review'
    });
    expect(settingsForExecutionPolicyPreset(preset({
      id: 'auto',
      sandbox: 'WORKSPACE_WRITE',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      networkAccess: 'OPTIONAL'
    }))).toEqual({
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review'
    });
    expect(settingsForExecutionPolicyPreset(preset({
      id: 'provider-full',
      sandbox: 'DANGER_FULL_ACCESS',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      networkAccess: 'REQUIRED'
    }))).toEqual({
      sandbox: 'DANGER_FULL_ACCESS',
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user'
    });
  });

  it('detects task-specific approval reviewer modes without creating run states', () => {
    expect(
      inferAgentPermissionMode({
        sandbox: 'READ_ONLY',
        networkAccess: false,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      })
    ).toBe('SANDBOXED');
    expect(
      formatAgentPermissionMode({
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      })
    ).toBe('Sandboxed');
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
    expect(
      formatAgentPermissionMode({
        runtimeId: 'opencode',
        sandbox: 'DANGER_FULL_ACCESS',
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      })
    ).toBe('Ask for approval');
  });
});

function preset(
  input: Omit<AgentExecutionPolicyPreset, 'label' | 'detail'>
): AgentExecutionPolicyPreset {
  return { ...input, label: input.id, detail: `${input.id} policy` };
}
