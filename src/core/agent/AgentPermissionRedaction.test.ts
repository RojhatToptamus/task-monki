import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isRedactedExternalPathReference,
  redactExternalPermissionPaths
} from './AgentPermissionRedaction';

describe('permission path redaction', () => {
  it('retains native worktree paths and removes external paths from nested durable fields', () => {
    const worktree = nativeAbsolute('worktree');
    const external = nativeAbsolute('cache', 'task-monki', 'run-1', 'file.txt');
    const siblingPrefix = `${worktree}-other`;
    const result = redactExternalPermissionPaths(
      {
        startedAtMs: 1,
        cwd: external,
        reason: `Read ${external} after listing ${path.dirname(external)}`,
        permissions: {
          fileSystem: {
            read: [external, path.join(worktree, 'src', 'file.ts'), siblingPrefix],
            entries: [
              {
                path: {
                  type: 'path',
                  nested: [external, { prior: 'task-monki-external-path:9' }]
                },
                access: 'read'
              }
            ]
          }
        }
      },
      worktree
    );

    expect(JSON.stringify(result)).not.toContain(external);
    expect(result.cwd).toBe('task-monki-external-path:1');
    expect(result.reason).toContain('task-monki-external-path:1');
    expect(result.reason).toContain('[external path]');
    expect(result.permissions.fileSystem?.read).toEqual([
      'task-monki-external-path:1',
      path.join(worktree, 'src', 'file.ts'),
      'task-monki-external-path:2'
    ]);
    expect(isRedactedExternalPathReference('task-monki-external-path:1')).toBe(true);
  });

  it('preserves already-redacted references', () => {
    const worktree = nativeAbsolute('worktree');
    const result = redactExternalPermissionPaths(
      {
        startedAtMs: 1,
        cwd: 'task-monki-external-path:4',
        reason: 'Previously approved task-monki-external-path:4',
        permissions: { fileSystem: { read: ['task-monki-external-path:4'] } }
      },
      worktree
    );

    expect(result.cwd).toBe('task-monki-external-path:4');
    expect(result.reason).toContain('task-monki-external-path:4');
    expect(result.permissions.fileSystem?.read).toEqual([
      'task-monki-external-path:4'
    ]);
  });

  it('does not redact the entire filesystem root for a root-level external file', () => {
    const root = path.parse(process.cwd()).root;
    const external = path.join(root, 'task-monki-secret.txt');
    const unrelated = path.join(root, 'public', 'readme.txt');
    const result = redactExternalPermissionPaths(
      {
        startedAtMs: 1,
        cwd: external,
        reason: `Read ${external}; leave ${unrelated} visible`,
        permissions: { fileSystem: { read: [external] } }
      },
      nativeAbsolute('worktree')
    );

    expect(result.reason).toContain('task-monki-external-path:1');
    expect(result.reason).toContain(unrelated);
  });

  it.runIf(process.platform === 'win32')(
    'redacts native drive paths case-insensitively on Windows',
    () => {
      const worktree = 'C:\\Users\\Runner\\worktree';
      const external = 'C:\\Users\\Runner\\Cache\\file.txt';
      const result = redactExternalPermissionPaths(
        {
          startedAtMs: 1,
          cwd: external.toLowerCase(),
          reason: `Read ${external.toUpperCase()}`,
          permissions: { fileSystem: { read: [external] } }
        },
        worktree.toUpperCase()
      );

      expect(JSON.stringify(result).toLowerCase()).not.toContain(
        external.toLowerCase()
      );
      expect(result.cwd).toBe('task-monki-external-path:1');
    }
  );

  it.runIf(process.platform === 'win32')(
    'redacts the original slash form received from a Windows provider',
    () => {
      const external = '/private/cache/task-monki/run-1/file.txt';
      const result = redactExternalPermissionPaths(
        {
          startedAtMs: 1,
          cwd: external,
          reason: `Read ${external} from ${path.dirname(external)}`,
          permissions: { fileSystem: { read: [external] } }
        },
        '/private/worktree'
      );

      expect(JSON.stringify(result)).not.toContain(external);
      expect(result.reason).toContain('task-monki-external-path:1');
      expect(result.reason).toContain('[external path]');
    }
  );
});

function nativeAbsolute(...segments: string[]): string {
  return path.join(path.parse(process.cwd()).root, 'private', ...segments);
}
