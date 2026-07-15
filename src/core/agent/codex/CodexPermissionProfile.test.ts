import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertCodexReadOnlyScopeEvidence,
  assertCodexPermissionProfileEvidence,
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

describe('Codex discourse read-only permission scope', () => {
  it('hashes an order-independent verified multi-root scope into the attested profile id', async () => {
    const fixture = await scopeFixture();
    const first = await codexReadOnlyScopeProfile({
      sessionId: 'session-discourse',
      scope: {
        primaryCwd: fixture.primary,
        readOnlyRoots: [fixture.secondary, fixture.primary],
        verifiedReadOnlyFiles: [
          { canonicalPath: fixture.attachment, contentSha256: fixture.attachmentHash }
        ]
      },
      reasoningEffort: 'high'
    });
    const reordered = await codexReadOnlyScopeProfile({
      sessionId: 'session-discourse',
      scope: {
        primaryCwd: fixture.primary,
        readOnlyRoots: [fixture.primary, fixture.secondary],
        verifiedReadOnlyFiles: [
          { canonicalPath: fixture.attachment, contentSha256: fixture.attachmentHash }
        ]
      },
      reasoningEffort: 'high'
    });

    expect(reordered).toEqual(first);
    expect(first.profileId).toContain(first.scopeHash.slice(0, 24));
    expect(first.config).toMatchObject({
      model_reasoning_effort: 'high',
      default_permissions: first.profileId,
      permissions: {
        [first.profileId]: {
          filesystem: {
            ':minimal': 'read',
            [fixture.primary]: 'read',
            [fixture.secondary]: 'read',
            [fixture.attachment]: 'read'
          },
          network: { enabled: false }
        }
      }
    });
  });

  it('rejects broad, overlapping, noncanonical, and unverified paths', async () => {
    const fixture = await scopeFixture();
    await expect(
      codexReadOnlyScopeProfile({
        sessionId: 'session-discourse',
        scope: {
          primaryCwd: fixture.primary,
          readOnlyRoots: [path.parse(fixture.primary).root]
        }
      })
    ).rejects.toThrow('filesystem root or home');
    await expect(
      codexReadOnlyScopeProfile({
        sessionId: 'session-discourse',
        scope: { primaryCwd: fixture.primary, readOnlyRoots: [fixture.nested] }
      })
    ).rejects.toThrow('must not overlap');
    await expect(
      codexReadOnlyScopeProfile({
        sessionId: 'session-discourse',
        scope: {
          primaryCwd: fixture.primary,
          readOnlyRoots: [],
          verifiedReadOnlyFiles: [
            {
              canonicalPath: path.parse(fixture.primary).root,
              contentSha256: fixture.attachmentHash
            }
          ]
        }
      })
    ).rejects.toThrow('filesystem root or home');
    await expect(
      codexReadOnlyScopeProfile({
        sessionId: 'session-discourse',
        scope: {
          primaryCwd: fixture.primary,
          readOnlyRoots: [],
          verifiedReadOnlyFiles: [
            { canonicalPath: fixture.attachment, contentSha256: 'not-a-hash' }
          ]
        }
      })
    ).rejects.toThrow('verified SHA-256');
    await expect(
      codexReadOnlyScopeProfile({
        sessionId: 'session-discourse',
        scope: {
          primaryCwd: fixture.primary,
          readOnlyRoots: [],
          verifiedReadOnlyFiles: [
            { canonicalPath: fixture.symlink, contentSha256: fixture.attachmentHash }
          ]
        }
      })
    ).rejects.toThrow('canonical regular file');
    await fs.writeFile(fixture.attachment, 'changed', 'utf8');
    await expect(
      codexReadOnlyScopeProfile({
        sessionId: 'session-discourse',
        scope: {
          primaryCwd: fixture.primary,
          readOnlyRoots: [],
          verifiedReadOnlyFiles: [
            { canonicalPath: fixture.attachment, contentSha256: fixture.attachmentHash }
          ]
        }
      })
    ).rejects.toThrow('content changed');
  });

  it('requires exact profile, cwd, sole primary root, offline read-only sandbox, and no approvals', async () => {
    const fixture = await scopeFixture();
    const profile = await codexReadOnlyScopeProfile({
      sessionId: 'session-discourse',
      scope: { primaryCwd: fixture.primary, readOnlyRoots: [] }
    });
    const response = {
      activePermissionProfile: { id: profile.profileId, extends: null },
      runtimeWorkspaceRoots: [fixture.primary],
      cwd: fixture.primary,
      sandbox: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    expect(() =>
      assertCodexReadOnlyScopeEvidence({
        profileId: profile.profileId,
        primaryCwd: fixture.primary,
        response
      })
    ).not.toThrow();

    for (const patch of [
      { activePermissionProfile: { id: 'stale-profile', extends: null } },
      { activePermissionProfile: { id: profile.profileId } },
      { runtimeWorkspaceRoots: [fixture.primary, fixture.secondary] },
      { runtimeWorkspaceRoots: ['.'] },
      { cwd: '.' },
      { cwd: fixture.secondary },
      { sandbox: { type: 'workspaceWrite', networkAccess: false } },
      { sandbox: { type: 'readOnly', networkAccess: true } },
      { approvalPolicy: 'on-request' },
      { approvalsReviewer: 'auto_review' }
    ]) {
      expect(() =>
        assertCodexReadOnlyScopeEvidence({
          profileId: profile.profileId,
          primaryCwd: fixture.primary,
          response: { ...response, ...patch }
        })
      ).toThrow();
    }
  });
});

async function scopeFixture(): Promise<{
  primary: string;
  secondary: string;
  nested: string;
  attachment: string;
  attachmentHash: string;
  symlink: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-read-scope-'));
  const canonicalRoot = await fs.realpath(root);
  const primary = path.join(canonicalRoot, 'primary');
  const secondary = path.join(canonicalRoot, 'secondary');
  const nested = path.join(primary, 'nested');
  const attachment = path.join(canonicalRoot, 'evidence.txt');
  const symlink = path.join(canonicalRoot, 'evidence-link.txt');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(secondary, { recursive: true });
  await fs.writeFile(attachment, 'verified evidence', 'utf8');
  await fs.symlink(attachment, symlink);
  return {
    primary,
    secondary,
    nested,
    attachment,
    attachmentHash: crypto.createHash('sha256').update('verified evidence').digest('hex'),
    symlink
  };
}

function nativeAbsolute(...segments: string[]): string {
  return path.join(path.parse(process.cwd()).root, 'private', ...segments);
}
