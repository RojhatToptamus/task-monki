import {
  NETWORK_ENVIRONMENT_KEYS,
  NETWORK_SENSITIVE_ENVIRONMENT_KEYS,
  USER_CONFIG_ENVIRONMENT_KEYS
} from '../core/agent/ProviderEnvironmentPolicy';
import type { AcpRuntimeProfile } from '../core/agent/acp/AcpRuntimeProfiles';

/** Generic ACP profile used only by protocol/runtime tests. */
export const TEST_ACP_PROFILE: AcpRuntimeProfile = {
  descriptor: {
    id: 'test-acp',
    displayName: 'Test ACP Agent',
    kind: 'ACP_AGENT',
    transport: 'STDIO',
    lifecycleScope: 'APPLICATION',
    startupPolicy: 'ON_DEMAND'
  },
  executableEnvironmentKey: 'TASK_MONKI_TEST_ACP_BIN',
  executableCandidates: ['test-acp'],
  argv: ['--acp'],
  versionArgv: ['--version'],
  launchContractProbe: {
    argv: ['--help'],
    description: 'Test ACP launch contract',
    requiredOutput: [
      { pattern: /\bUsage:\s+test-acp(?:\s|$)/iu, description: 'test ACP identity' },
      { pattern: /--acp\b/iu, description: 'the --acp launch option' }
    ]
  },
  defaultModelProvider: 'test-provider',
  defaultModel: 'default',
  environmentPolicy: {
    contractId: 'task-monki/test-acp-environment@v1',
    allowedKeys: [
      'TEST_ACP_API_KEY',
      ...USER_CONFIG_ENVIRONMENT_KEYS,
      ...NETWORK_ENVIRONMENT_KEYS
    ],
    sensitiveKeys: ['TEST_ACP_API_KEY', ...NETWORK_SENSITIVE_ENVIRONMENT_KEYS]
  },
  extensions: {
    testProtocol: {
      maturity: 'stable',
      detail: 'Test-only ACP protocol fixture.'
    }
  }
};
