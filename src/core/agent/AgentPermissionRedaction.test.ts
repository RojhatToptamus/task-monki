import { describe, expect, it } from 'vitest';
import {
  isRedactedExternalPathReference,
  redactExternalPermissionPaths
} from './AgentPermissionRedaction';

describe('permission path redaction', () => {
  it('retains worktree paths and removes external paths from durable fields', () => {
    const external = '/private/cache/task-monki/run-1/file.txt';
    const result = redactExternalPermissionPaths(
      {
        startedAtMs: 1,
        cwd: external,
        reason: `Read ${external}`,
        permissions: {
          fileSystem: {
            read: [external, '/private/worktree/src/file.ts'],
            entries: [
              { path: { type: 'path', path: external }, access: 'read' }
            ]
          }
        }
      },
      '/private/worktree'
    );

    expect(JSON.stringify(result)).not.toContain(external);
    expect(result.cwd).toBe('task-monki-external-path:1');
    expect(result.reason).toContain('task-monki-external-path:1');
    expect(result.permissions.fileSystem?.read).toEqual([
      'task-monki-external-path:1',
      '/private/worktree/src/file.ts'
    ]);
    expect(isRedactedExternalPathReference('task-monki-external-path:1')).toBe(true);
  });
});
