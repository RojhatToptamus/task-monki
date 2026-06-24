import { describe, expect, it } from 'vitest';
import { validateRuntimeVersion } from './CodexAppServerSupervisor';

describe('Codex App Server runtime compatibility', () => {
  it('accepts the generated protocol runtime without a warning', () => {
    expect(validateRuntimeVersion('0.141.0')).toBeUndefined();
  });

  it('ignores build metadata for compatibility checks', () => {
    expect(validateRuntimeVersion('0.141.0+build.1')).toBeUndefined();
  });

  it('allows newer untested runtimes in stable compatibility mode with a warning', () => {
    expect(validateRuntimeVersion('0.142.0')).toContain('maximum tested runtime');
  });

  it('rejects runtimes older than the generated protocol', () => {
    expect(() => validateRuntimeVersion('0.140.0')).toThrow(
      'Install 0.141.0 or newer'
    );
  });

  it('rejects prereleases lower than the generated protocol', () => {
    expect(() => validateRuntimeVersion('0.141.0-alpha.1')).toThrow(
      'Install 0.141.0 or newer'
    );
  });

  it('rejects invalid runtime versions instead of comparing partial numbers', () => {
    expect(() => validateRuntimeVersion('0.141.x')).toThrow(
      'Invalid Codex runtime version'
    );
  });
});
