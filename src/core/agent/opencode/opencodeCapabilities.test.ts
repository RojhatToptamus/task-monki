import { describe, expect, it } from 'vitest';
import { opencodeCapabilities } from './opencodeCapabilities';

describe('opencodeCapabilities', () => {
  it('reports native attachment delivery without claiming process confinement', () => {
    const capabilities = opencodeCapabilities();

    expect(
      capabilities.executionPolicy.presets.map((preset) => preset.networkAccess)
    ).toEqual(['REQUIRED', 'REQUIRED', 'REQUIRED']);
    expect(
      capabilities.executionPolicy.presets.map((preset) => ({
        sandbox: preset.sandbox,
        approvalPolicy: preset.approvalPolicy
      }))
    ).toEqual([
      { sandbox: 'DANGER_FULL_ACCESS', approvalPolicy: 'never' },
      { sandbox: 'DANGER_FULL_ACCESS', approvalPolicy: 'on-request' },
      { sandbox: 'DANGER_FULL_ACCESS', approvalPolicy: 'never' }
    ]);
    expect(capabilities.attachmentDelivery).toEqual({
      maturity: 'stable',
      detail: expect.stringContaining('not an OS confinement boundary')
    });
    expect(capabilities.promptRefinement.maturity).toBe('stable');
    expect(capabilities.sessionFork).toEqual({
      maturity: 'stable',
      detail: expect.stringContaining('target worktree runtime')
    });
    expect(capabilities.extensions.nativeFileParts?.maturity).toBe('stable');
    expect(capabilities.detachedReview.maturity).toBe('stable');
    expect(capabilities.review.maturity).toBe('stable');
  });
});
