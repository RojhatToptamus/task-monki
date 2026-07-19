import { describe, expect, it } from 'vitest';
import {
  OPENCODE_ENVIRONMENT_POLICY,
  openCodeEnvironmentKeys,
  openCodeSensitiveEnvironmentValues
} from './OpenCodeEnvironmentPolicy';

describe('OpenCode environment policy', () => {
  it('versions the exact provider and configuration contract', () => {
    expect(OPENCODE_ENVIRONMENT_POLICY.contractId).toMatch(/@v\d+$/u);
    expect(OPENCODE_ENVIRONMENT_POLICY.allowedKeys).toEqual(
      expect.arrayContaining([
        'OPENCODE_CONFIG',
        'OPENCODE_CONFIG_DIR',
        'XDG_CONFIG_HOME',
        'ANTHROPIC_API_KEY',
        'AWS_PROFILE',
        'AWS_WEB_IDENTITY_TOKEN_FILE',
        'ANTHROPIC_VERTEX_PROJECT_ID',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'GEMINI_API_KEY',
        'XAI_API_KEY'
      ])
    );
    expect(new Set(OPENCODE_ENVIRONMENT_POLICY.allowedKeys).size).toBe(
      OPENCODE_ENVIRONMENT_POLICY.allowedKeys.length
    );
    expect(OPENCODE_ENVIRONMENT_POLICY.allowedKeys).not.toContain('CODEX_HOME');
    expect(
      OPENCODE_ENVIRONMENT_POLICY.sensitiveKeys.every((key) =>
        OPENCODE_ENVIRONMENT_POLICY.allowedKeys.includes(key)
      )
    ).toBe(true);
  });

  it('selects only present exact keys and never forwards arbitrary host secrets', () => {
    const environment = {
      OPENCODE_CONFIG_DIR: '/profiles/work',
      AWS_PROFILE: 'bedrock',
      GEMINI_API_KEY: 'gemini-secret',
      TASK_MONKI_UNRELATED_SECRET: 'must-not-pass',
      CUSTOM_PROVIDER_API_KEY: 'must-not-pass'
    };

    expect(openCodeEnvironmentKeys(environment)).toEqual([
      'OPENCODE_CONFIG_DIR',
      'AWS_PROFILE',
      'GEMINI_API_KEY'
    ]);
    expect(openCodeSensitiveEnvironmentValues(environment)).toEqual([
      '/profiles/work',
      'gemini-secret'
    ]);
  });
});
