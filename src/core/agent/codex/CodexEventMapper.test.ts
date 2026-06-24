import { describe, expect, it } from 'vitest';
import {
  mapThreadStatus,
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

  it('maps read-only settings and approval wait states without inference', () => {
    expect(toSandboxMode({ sandbox: 'READ_ONLY' })).toBe('read-only');
    expect(
      mapThreadStatus({
        type: 'active',
        activeFlags: ['waitingOnApproval']
      })
    ).toBe('AWAITING_APPROVAL');
  });
});
