import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
import {
  NETWORK_ENVIRONMENT_KEYS,
  NETWORK_SENSITIVE_ENVIRONMENT_KEYS,
  USER_CONFIG_ENVIRONMENT_KEYS,
  type ProviderEnvironmentPolicy
} from '../ProviderEnvironmentPolicy';

export const ANTIGRAVITY_MACOS_XPC_SERVICE_NAME =
  'application.com.google.antigravity' as const;

const ANTIGRAVITY_INHERITED_ENVIRONMENT_KEYS = [
  ...USER_CONFIG_ENVIRONMENT_KEYS,
  ...NETWORK_ENVIRONMENT_KEYS
] as const;

export const ANTIGRAVITY_ENVIRONMENT_POLICY: ProviderEnvironmentPolicy = {
  contractId: 'task-monki/antigravity-environment@v3',
  allowedKeys: [
    ...ANTIGRAVITY_INHERITED_ENVIRONMENT_KEYS,
    // This key is admitted to the child contract only with the fixed value
    // below. An ambient value is never inherited.
    'XPC_SERVICE_NAME'
  ],
  sensitiveKeys: [...NETWORK_SENSITIVE_ENVIRONMENT_KEYS]
};

/**
 * Builds the exact Antigravity child environment.
 *
 * The authenticated public macOS CLI requires its reviewed application XPC
 * identity even when Task Monki itself was launched outside that application.
 * The identity is non-secret, but accepting an ambient value would make launch
 * behavior depend on (or be spoofed by) the caller's shell. Other platforms do
 * not receive a macOS-only XPC variable.
 */
export function antigravityChildEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const environment = sanitizeEnvironment(
    source,
    ANTIGRAVITY_INHERITED_ENVIRONMENT_KEYS
  );
  if (platform === 'darwin') {
    environment.XPC_SERVICE_NAME = ANTIGRAVITY_MACOS_XPC_SERVICE_NAME;
  }
  return environment;
}
