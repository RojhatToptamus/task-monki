import { describe, expect, it } from 'vitest';
import { safeCliMessage } from './RemoteWorkError';

describe('CLI failure messages', () => {
  // These messages are stored on tasks and shown in the app, so a token in a CLI's output must not survive.
  it.each([
    'fatal: unable to access \'https://oauth2:glpat-abcdefghijklmnopqrst@gitlab.com/group/project.git/\': 403',
    'error: authentication failed for github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'remote: Invalid token glpat-abcdefghijklmnopqrst'
  ])('removes credentials from %s', (stderr) => {
    const message = safeCliMessage({ stderr, message: 'Command failed with exit code 128: git' });
    expect(message).not.toMatch(/glpat-abcdef|github_pat_11ABC|oauth2:glpat/u);
    expect(message).toContain('[REDACTED');
  });

  it('keeps the first useful line', () => {
    expect(safeCliMessage({ stderr: '\n  error: pathspec did not match\nhint: more\n', message: 'Command failed with exit code 1: git' }))
      .toBe('error: pathspec did not match');
  });
});
