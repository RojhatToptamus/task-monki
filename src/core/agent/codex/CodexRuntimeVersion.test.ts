import { describe, expect, it } from 'vitest';
import {
  compareCodexVersions,
  parseCodexVersionOutput
} from './CodexRuntimeVersion';

describe('Codex runtime version parsing', () => {
  it('parses Codex CLI version output', () => {
    expect(parseCodexVersionOutput('codex-cli 0.141.0\n')).toBe('0.141.0');
    expect(parseCodexVersionOutput('codex 0.142.4+build.1\n')).toBe(
      '0.142.4+build.1'
    );
  });

  it('compares versions without treating newer runtimes as incompatible', () => {
    expect(compareCodexVersions('0.142.4', '0.141.0')).toBe(1);
    expect(compareCodexVersions('0.141.0+build.1', '0.141.0')).toBe(0);
    expect(compareCodexVersions('0.141.0-alpha.1', '0.141.0')).toBe(-1);
  });

  it('rejects invalid runtime versions instead of comparing partial numbers', () => {
    expect(() => parseCodexVersionOutput('codex-cli 0.141.x')).toThrow(
      'Could not parse Codex runtime version'
    );
    expect(() => compareCodexVersions('0.141.x', '0.141.0')).toThrow(
      'Invalid Codex runtime version'
    );
  });
});
