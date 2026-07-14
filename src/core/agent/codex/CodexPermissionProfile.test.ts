import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertCodexPermissionProfileEvidence,
  codexPermissionProfileConfig,
  codexPermissionProfileId
} from './CodexPermissionProfile';

describe('Codex permission profile', () => {
  it('allows only the runtime minimum, exact worktree, and exact attachment files', () => {
    const worktree = nativeAbsolute('worktrees', 'task-1');
    const attachment = nativeAbsolute('cache', 'run-1', 'image.png');
    const config = codexPermissionProfileConfig({
      sessionId: 'session-1',
      settings: {
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        reasoningEffort: 'high'
      },
      worktreePath: worktree,
      attachmentPaths: [attachment]
    });

    expect(config).toEqual({
      model_reasoning_effort: 'high',
      default_permissions: 'task_monki_session-1',
      permissions: {
        'task_monki_session-1': {
          filesystem: {
            ':minimal': 'read',
            [worktree]: 'write',
            [attachment]: 'read'
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
    const worktree = nativeAbsolute('worktrees', 'task-2');
    const config = codexPermissionProfileConfig({
      sessionId: 'session-2',
      settings: { sandbox: 'READ_ONLY', networkAccess: true },
      worktreePath: worktree
    }) as { permissions: Record<string, unknown> };

    expect(config.permissions).toEqual({
      'task_monki_session-2': {
        filesystem: {
          ':minimal': 'read',
          [worktree]: 'read'
        },
        network: { enabled: true }
      }
    });
  });

  it('rejects Full access only for attachments and validates managed paths', () => {
    const worktree = nativeAbsolute('worktrees', 'task-1');
    const attachment = nativeAbsolute('attachments', 'file.txt');
    expect(() =>
      codexPermissionProfileConfig({
        sessionId: 'session-1',
        settings: { sandbox: 'DANGER_FULL_ACCESS' },
        worktreePath: worktree
      })
    ).not.toThrow();
    expect(() =>
      codexPermissionProfileConfig({
        sessionId: 'session-1',
        settings: { sandbox: 'DANGER_FULL_ACCESS' },
        worktreePath: worktree,
        attachmentPaths: [attachment]
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
        worktreePath: worktree,
        attachmentPaths: [path.join(worktree, 'file.txt')]
      })
    ).toThrow('outside the task worktree');
    expect(() =>
      codexPermissionProfileConfig({
        sessionId: 'session-1',
        settings: { sandbox: 'WORKSPACE_WRITE' },
        worktreePath: worktree,
        attachmentPaths: [path.join(worktree, '..data', 'file.txt')]
      })
    ).toThrow('outside the task worktree');
    expect(() => codexPermissionProfileId('bad/id')).toThrow('invalid session id');
  });

  it('disables network access whenever managed attachments are present', () => {
    const config = codexPermissionProfileConfig({
      sessionId: 'session-3',
      settings: { sandbox: 'WORKSPACE_WRITE', networkAccess: true },
      worktreePath: nativeAbsolute('worktrees', 'task-3'),
      attachmentPaths: [nativeAbsolute('attachments', 'file.txt')]
    }) as { permissions: Record<string, { network: { enabled: boolean } }> };

    expect(config.permissions['task_monki_session-3']?.network.enabled).toBe(false);
  });

  it('requires the exact active profile and sole runtime worktree root', () => {
    const worktree = nativeAbsolute('worktrees', 'task-1');
    const other = nativeAbsolute('other');
    expect(() =>
      assertCodexPermissionProfileEvidence({
        sessionId: 'session-1',
        worktreePath: worktree,
        response: {
          activePermissionProfile: {
            id: 'task_monki_session-1',
            extends: null
          },
          runtimeWorkspaceRoots: [worktree]
        }
      })
    ).not.toThrow();

    for (const response of [
      {},
      {
        activePermissionProfile: { id: ':workspace', extends: null },
        runtimeWorkspaceRoots: [worktree]
      },
      {
        activePermissionProfile: {
          id: 'task_monki_session-1',
          extends: ':workspace'
        },
        runtimeWorkspaceRoots: [worktree]
      },
      {
        activePermissionProfile: {
          id: 'task_monki_session-1',
          extends: null
        },
        runtimeWorkspaceRoots: [worktree, other]
      }
    ]) {
      expect(() =>
        assertCodexPermissionProfileEvidence({
          sessionId: 'session-1',
          worktreePath: worktree,
          response
        })
      ).toThrow();
    }

    expect(() =>
      assertCodexPermissionProfileEvidence({
        sessionId: 'session-1',
        worktreePath: process.cwd(),
        response: {
          activePermissionProfile: {
            id: 'task_monki_session-1',
            extends: null
          },
          runtimeWorkspaceRoots: [null]
        }
      })
    ).toThrow('unexpected runtime workspace roots');
  });

  it.runIf(process.platform === 'win32')(
    'compares runtime roots and exact worktree paths case-insensitively on Windows',
    () => {
      const worktree = nativeAbsolute('worktrees', 'task-case');
      expect(() =>
        assertCodexPermissionProfileEvidence({
          sessionId: 'session-case',
          worktreePath: worktree.toUpperCase(),
          response: {
            activePermissionProfile: {
              id: 'task_monki_session-case',
              extends: null
            },
            runtimeWorkspaceRoots: [worktree.toLowerCase()]
          }
        })
      ).not.toThrow();
      expect(() =>
        codexPermissionProfileConfig({
          sessionId: 'session-case',
          settings: { sandbox: 'WORKSPACE_WRITE' },
          worktreePath: worktree.toUpperCase(),
          attachmentPaths: [worktree.toLowerCase()]
        })
      ).toThrow('outside the task worktree');
    }
  );
});

function nativeAbsolute(...segments: string[]): string {
  return path.join(path.parse(process.cwd()).root, 'private', ...segments);
}
