import { describe, expect, it } from 'vitest';
import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
import { CODEX_ENVIRONMENT_POLICY } from './CodexEnvironmentPolicy';

describe('Codex environment policy', () => {
  it('owns CODEX_HOME without admitting unrelated provider configuration', () => {
    expect(CODEX_ENVIRONMENT_POLICY).toEqual({
      contractId: 'task-monki/codex-environment@v1',
      allowedKeys: ['CODEX_HOME'],
      sensitiveKeys: []
    });
    expect(
      sanitizeEnvironment(
        {
          PATH: '/bin',
          CODEX_HOME: '/codex/provider-state',
          XAI_API_KEY: 'must-not-pass'
        },
        CODEX_ENVIRONMENT_POLICY.allowedKeys
      )
    ).toEqual({ PATH: '/bin', CODEX_HOME: '/codex/provider-state' });
  });
});
