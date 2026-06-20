import { describe, expect, it } from 'vitest';
import { parseCommandLine } from './commandLine';

describe('parseCommandLine', () => {
  it('parses an executable and quoted arguments without invoking a shell', () => {
    expect(parseCommandLine('npm run "test:unit" -- --filter=core')).toEqual({
      executable: 'npm',
      argv: ['run', 'test:unit', '--', '--filter=core']
    });
  });

  it('rejects empty commands', () => {
    expect(() => parseCommandLine('   ')).toThrow('Command is required');
  });
});
