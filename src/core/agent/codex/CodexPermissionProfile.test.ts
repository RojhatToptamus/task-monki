import { describe, expect, it } from 'vitest';
import {
  assertCodexPermissionProfileEvidence,
  codexPermissionProfileConfig,
  codexPermissionProfileId
} from './CodexPermissionProfile';

describe('Codex permission profile', () => {
  it('allows only the runtime minimum, exact worktree, and exact attachment files', () => {
    const config = codexPermissionProfileConfig({
      sessionId: 'session-1',
      settings: {
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        reasoningEffort: 'high'
      },
      worktreePath: '/private/worktrees/task-1',
      attachmentPaths: ['/private/cache/run-1/image.png']
    });

    expect(config).toEqual({
      model_reasoning_effort: 'high',
      default_permissions: 'task_monki_session-1',
      permissions: {
        'task_monki_session-1': {
          filesystem: {
            ':minimal': 'read',
            '/private/worktrees/task-1': 'write',
            '/private/cache/run-1/image.png': 'read'
          },
          network: { enabled: false }
        }
      },
      features: {
        multi_agent: false,
        multi_agent_v2: false,
        memories: false
      }
    });
  });

  it('keeps read-only worktrees read-only and preserves explicit network access', () => {
    const config = codexPermissionProfileConfig({
      sessionId: 'session-2',
      settings: { sandbox: 'READ_ONLY', networkAccess: true },
      worktreePath: '/private/worktrees/task-2'
    }) as { permissions: Record<string, unknown> };

    expect(config.permissions).toEqual({
      'task_monki_session-2': {
        filesystem: {
          ':minimal': 'read',
          '/private/worktrees/task-2': 'read'
        },
        network: { enabled: true }
      }
    });
  });

  it('rejects Full access only for attachments and validates managed paths', () => {
    expect(() =>
      codexPermissionProfileConfig({
        sessionId: 'session-1',
        settings: { sandbox: 'DANGER_FULL_ACCESS' },
        worktreePath: '/private/worktrees/task-1'
      })
    ).not.toThrow();
    expect(() =>
      codexPermissionProfileConfig({
        sessionId: 'session-1',
        settings: { sandbox: 'DANGER_FULL_ACCESS' },
        worktreePath: '/private/worktrees/task-1',
        attachmentPaths: ['/private/attachments/file.txt']
      })
    ).toThrow('Attachments require');
    expect(() =>
      codexPermissionProfileConfig({
        sessionId: 'session-1',
        settings: { sandbox: 'WORKSPACE_WRITE' },
        worktreePath: 'relative'
      })
    ).toThrow('must be absolute');
    expect(() =>
      codexPermissionProfileConfig({
        sessionId: 'session-1',
        settings: { sandbox: 'WORKSPACE_WRITE' },
        worktreePath: '/private/worktrees/task-1',
        attachmentPaths: ['/private/worktrees/task-1/file.txt']
      })
    ).toThrow('outside the task worktree');
    expect(() => codexPermissionProfileId('bad/id')).toThrow('invalid session id');
  });

  it('disables network access whenever managed attachments are present', () => {
    const config = codexPermissionProfileConfig({
      sessionId: 'session-3',
      settings: { sandbox: 'WORKSPACE_WRITE', networkAccess: true },
      worktreePath: '/private/worktrees/task-3',
      attachmentPaths: ['/private/attachments/file.txt']
    }) as { permissions: Record<string, { network: { enabled: boolean } }> };

    expect(config.permissions['task_monki_session-3']?.network.enabled).toBe(false);
  });

  it('requires the exact active profile and sole runtime worktree root', () => {
    expect(() =>
      assertCodexPermissionProfileEvidence({
        sessionId: 'session-1',
        worktreePath: '/private/worktrees/task-1',
        response: {
          activePermissionProfile: {
            id: 'task_monki_session-1',
            extends: null
          },
          runtimeWorkspaceRoots: ['/private/worktrees/task-1']
        }
      })
    ).not.toThrow();

    for (const response of [
      {},
      {
        activePermissionProfile: { id: ':workspace', extends: null },
        runtimeWorkspaceRoots: ['/private/worktrees/task-1']
      },
      {
        activePermissionProfile: {
          id: 'task_monki_session-1',
          extends: ':workspace'
        },
        runtimeWorkspaceRoots: ['/private/worktrees/task-1']
      },
      {
        activePermissionProfile: {
          id: 'task_monki_session-1',
          extends: null
        },
        runtimeWorkspaceRoots: ['/private/worktrees/task-1', '/private/other']
      }
    ]) {
      expect(() =>
        assertCodexPermissionProfileEvidence({
          sessionId: 'session-1',
          worktreePath: '/private/worktrees/task-1',
          response
        })
      ).toThrow();
    }
  });
});
