import { describe, expect, it } from 'vitest';
import { codexCapabilities } from './codexCapabilities';

describe('codexCapabilities', () => {
  it('does not present interruption as a resumable pause', () => {
    const capabilities = codexCapabilities();

    expect(capabilities.turnInterruption.maturity).toBe('stable');
    expect(capabilities.truePause.maturity).toBe('unsupported');
  });

  it('keeps experimental behavior explicitly gated', () => {
    const capabilities = codexCapabilities();

    expect(capabilities.backgroundTerminals.maturity).toBe('experimental');
    expect(capabilities.dynamicTools.maturity).toBe('experimental');
  });
});
