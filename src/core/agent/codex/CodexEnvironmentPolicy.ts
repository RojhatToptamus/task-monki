import type { ProviderEnvironmentPolicy } from '../ProviderEnvironmentPolicy';

/**
 * Codex-owned additions to Task Monki's portable child environment.
 *
 * CODEX_HOME controls Codex configuration, authentication, and runtime state;
 * it must not be inherited by OpenCode or ACP children through
 * the provider-neutral process base.
 */
export const CODEX_ENVIRONMENT_POLICY: ProviderEnvironmentPolicy = {
  contractId: 'task-monki/codex-environment@v1',
  allowedKeys: ['CODEX_HOME'],
  sensitiveKeys: []
};
