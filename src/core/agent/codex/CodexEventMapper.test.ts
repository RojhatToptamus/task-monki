import { describe, expect, it } from 'vitest';
import {
  mapThreadStatus,
  settingsFromThreadResponse,
  settingsFromThreadSettings,
  toSandboxMode,
  toSandboxPolicy
} from './CodexEventMapper';

describe('Codex event mapping', () => {
  it('keeps workspace writes scoped to the task worktree with network disabled', () => {
    expect(
      toSandboxPolicy(
        {
          sandbox: 'WORKSPACE_WRITE',
          networkAccess: false
        },
        '/tmp/task-worktree'
      )
    ).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/tmp/task-worktree'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    });
  });

  it('preserves network access as an independent workspace-write sandbox setting', () => {
    expect(
      toSandboxPolicy(
        {
          sandbox: 'WORKSPACE_WRITE',
          networkAccess: true
        },
        '/tmp/task-worktree'
      )
    ).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/tmp/task-worktree'],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    });
  });

  it('maps read-only settings and approval wait states without inference', () => {
    expect(toSandboxMode({ sandbox: 'READ_ONLY' })).toBe('read-only');
    expect(
      mapThreadStatus({
        type: 'active',
        activeFlags: ['waitingOnApproval']
      })
    ).toBe('AWAITING_APPROVAL');
  });

  it('maps approvals reviewer from thread responses and settings notifications', () => {
    expect(
      settingsFromThreadResponse({
        model: 'fake-model',
        modelProvider: 'openai',
        serviceTier: null,
        reasoningEffort: 'high',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: ['/tmp/task-worktree'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        }
      }).approvalsReviewer
    ).toBe('auto_review');
    expect(
      settingsFromThreadSettings({
        cwd: '/tmp/task-worktree',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/tmp/task-worktree'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        },
        activePermissionProfile: null,
        model: 'fake-model',
        modelProvider: 'openai',
        serviceTier: null,
        effort: 'high',
        summary: null,
        collaborationMode: null,
        personality: null
      } as never).approvalsReviewer
    ).toBe('auto_review');
  });
});
