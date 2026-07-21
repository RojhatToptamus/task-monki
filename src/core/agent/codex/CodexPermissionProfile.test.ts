import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertCodexPermissionProfileEvidence,
  assertCodexReadOnlyScopeEvidence,
  codexPermissionProfileConfig,
  codexPermissionProfileId,
  codexReadOnlyScopeProfile
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

  it('adds an exact read-only Git common directory without widening the worktree grant', () => {
    const worktree = nativeAbsolute('worktrees', 'task with spaces');
    const gitCommonDir = nativeAbsolute('repositories', 'main repo', '.git');
    const config = codexPermissionProfileConfig({
      sessionId: 'review-session',
      settings: { sandbox: 'READ_ONLY', networkAccess: false },
      worktreePath: worktree,
      additionalReadOnlyPaths: [gitCommonDir]
    }) as {
      permissions: Record<
        string,
        { filesystem: Record<string, 'read' | 'write'> }
      >;
    };

    expect(config.permissions['task_monki_review-session']?.filesystem).toEqual({
      ':minimal': 'read',
      [worktree]: 'read',
      [gitCommonDir]: 'read'
    });
    expect(() =>
      codexPermissionProfileConfig({
        sessionId: 'review-session',
        settings: { sandbox: 'READ_ONLY' },
        worktreePath: worktree,
        additionalReadOnlyPaths: ['relative/.git']
      })
    ).toThrow('must be absolute');
  });

  it('rejects Full access only for attachments and validates managed paths', () => {
    const worktree = nativeAbsolute('worktrees', 'task-1');
    const attachment = nativeAbsolute('attachments', 'file.txt');
    const fullAccess = codexPermissionProfileConfig({
      sessionId: 'session-1',
      settings: { sandbox: 'DANGER_FULL_ACCESS' },
      worktreePath: worktree
    });
    expect(fullAccess).toMatchObject({
      default_permissions: ':danger-full-access'
    });
    expect(fullAccess).not.toHaveProperty('permissions');
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
    expect(() => codexPermissionProfileId('bad/id', 'WORKSPACE_WRITE')).toThrow(
      'invalid session id'
    );
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
        sandbox: 'WORKSPACE_WRITE',
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
    expect(() =>
      assertCodexPermissionProfileEvidence({
        sessionId: 'session-1',
        sandbox: 'DANGER_FULL_ACCESS',
        worktreePath: worktree,
        response: {
          activePermissionProfile: {
            id: ':danger-full-access',
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
          sandbox: 'WORKSPACE_WRITE',
          worktreePath: worktree,
          response
        })
      ).toThrow();
    }

    expect(() =>
      assertCodexPermissionProfileEvidence({
        sessionId: 'session-1',
        sandbox: 'WORKSPACE_WRITE',
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
          sandbox: 'WORKSPACE_WRITE',
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

describe('Codex Discourse read-only permission scope', () => {
  it('hashes an order-independent bounded multi-root scope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-scope-'));
    const firstPath = path.join(root, 'first');
    const secondPath = path.join(root, 'second');
    await Promise.all([fs.mkdir(firstPath), fs.mkdir(secondPath)]);
    const [first, second] = await Promise.all([fs.realpath(firstPath), fs.realpath(secondPath)]);

    const profile = await codexReadOnlyScopeProfile({
      sessionId: 'session-discourse',
      scope: { primaryCwd: first, readOnlyRoots: [second, first] },
      reasoningEffort: 'high'
    });
    const reordered = await codexReadOnlyScopeProfile({
      sessionId: 'session-discourse',
      scope: { primaryCwd: first, readOnlyRoots: [first, second] },
      reasoningEffort: 'high'
    });

    expect(reordered).toEqual(profile);
    expect(profile.scopeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(profile.config).toMatchObject({
      default_permissions: profile.profileId,
      permissions: {
        [profile.profileId]: {
          filesystem: { ':minimal': 'read', [first]: 'read', [second]: 'read' },
          network: { enabled: false }
        }
      },
      features: { apps: false, multi_agent: false, multi_agent_v2: false, memories: false },
      web_search: 'disabled'
    });
  });

  it('rejects broad and overlapping roots and requires exact runtime evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-scope-'));
    const primaryPath = path.join(root, 'primary');
    const nestedPath = path.join(primaryPath, 'nested');
    await fs.mkdir(nestedPath, { recursive: true });
    const primary = await fs.realpath(primaryPath);
    const nested = await fs.realpath(nestedPath);
    await expect(codexReadOnlyScopeProfile({
      sessionId: 'session-discourse',
      scope: { primaryCwd: primary, readOnlyRoots: [path.parse(primary).root] }
    })).rejects.toThrow('filesystem root or home');
    await expect(codexReadOnlyScopeProfile({
      sessionId: 'session-discourse',
      scope: { primaryCwd: primary, readOnlyRoots: [nested] }
    })).rejects.toThrow('must not overlap');

    const profile = await codexReadOnlyScopeProfile({
      sessionId: 'session-discourse',
      scope: { primaryCwd: primary, readOnlyRoots: [] }
    });
    const evidence = {
      activePermissionProfile: { id: profile.profileId, extends: null },
      runtimeWorkspaceRoots: [primary],
      cwd: primary,
      sandbox: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    expect(() => assertCodexReadOnlyScopeEvidence({
      profileId: profile.profileId,
      primaryCwd: primary,
      response: evidence
    })).not.toThrow();
    expect(() => assertCodexReadOnlyScopeEvidence({
      profileId: profile.profileId,
      primaryCwd: primary,
      response: { ...evidence, sandbox: { type: 'workspaceWrite', networkAccess: false } }
    })).toThrow('offline read-only');
  });
});

function nativeAbsolute(...segments: string[]): string {
  return path.join(path.parse(process.cwd()).root, 'private', ...segments);
}
