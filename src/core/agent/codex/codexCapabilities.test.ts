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
    expect(capabilities.subagents.maturity).toBe('unsupported');
    expect(capabilities.extensions['codex.collaboration']?.maturity).toBe(
      'unsupported'
    );
  });

  it('declares the restricted execution policy without approval exceptions', () => {
    const policy = codexCapabilities().executionPolicy;

    expect(policy.defaultPresetId).toBe('restricted');
    expect(policy.presets.find((preset) => preset.id === 'restricted')).toMatchObject({
      id: 'restricted',
      label: 'Restricted',
      sandbox: 'WORKSPACE_WRITE',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      networkAccess: 'DISABLED'
    });
    expect(policy.presets.find((preset) => preset.id === 'isolated-read-only')).toMatchObject({
      sandbox: 'READ_ONLY',
      approvalPolicy: 'never',
      networkAccess: 'DISABLED'
    });
  });
});
