import { describe, expect, it } from 'vitest';
import { opencodeCapabilities } from './opencodeCapabilities';

describe('opencodeCapabilities', () => {
  it('truthfully reports provider-controlled network and no managed attachment boundary', () => {
    const capabilities = opencodeCapabilities();

    expect(
      capabilities.executionPolicy.presets.map((preset) => preset.networkAccess)
    ).toEqual(['REQUIRED', 'REQUIRED']);
    expect(capabilities.attachmentDelivery.maturity).toBe('unsupported');
    expect(capabilities.promptRefinement.maturity).toBe('unsupported');
    expect(capabilities.sessionFork).toEqual({
      maturity: 'stable',
      detail: expect.stringContaining('target worktree runtime')
    });
    expect(capabilities.extensions.nativeFileParts?.maturity).toBe('stable');
    expect(capabilities.extensions.genericDetachedReview?.maturity).toBe('inferred');
  });
});
