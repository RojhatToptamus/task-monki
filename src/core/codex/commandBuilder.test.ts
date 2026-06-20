import { describe, expect, it } from 'vitest';
import { buildCodexExecCommand } from './commandBuilder';

describe('buildCodexExecCommand', () => {
  it('builds the Phase 1 read-only codex exec argv without shell interpolation', () => {
    const command = buildCodexExecCommand({ repositoryPath: '/tmp/example repo' });

    expect(command.executable).toBe('codex');
    expect(command.argv).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--cd',
      '/tmp/example repo',
      '-'
    ]);
  });

  it('rejects an empty repository path', () => {
    expect(() => buildCodexExecCommand({ repositoryPath: '   ' })).toThrow(
      'Repository path is required.'
    );
  });
});
