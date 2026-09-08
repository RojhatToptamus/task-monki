import { describe, expect, it } from 'vitest';
import { codexCapabilities } from './codexCapabilities';

describe('codexCapabilities', () => {
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

  it('reports scoped Design skill access only after the app pack is available', () => {
    expect(
      codexCapabilities().extensions['task-monki.design-skill-access']
    ).toMatchObject({ maturity: 'stable' });
    expect(
      codexCapabilities({
        designSkillAccess: { available: false, detail: 'Pack validation failed.' }
      }).extensions['task-monki.design-skill-access']
    ).toEqual({ maturity: 'unsupported', detail: 'Pack validation failed.' });
  });
});
