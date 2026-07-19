import {
  AWS_ENVIRONMENT_KEYS,
  AWS_SENSITIVE_ENVIRONMENT_KEYS,
  GOOGLE_ENVIRONMENT_KEYS,
  GOOGLE_SENSITIVE_ENVIRONMENT_KEYS,
  NETWORK_ENVIRONMENT_KEYS,
  NETWORK_SENSITIVE_ENVIRONMENT_KEYS,
  USER_CONFIG_ENVIRONMENT_KEYS,
  presentEnvironmentKeys,
  sensitiveEnvironmentValues,
  type ProviderEnvironmentPolicy
} from '../ProviderEnvironmentPolicy';

/**
 * Host environment contract for the OpenCode child. OpenCode can read many
 * provider configurations, but Task Monki forwards only named provider and
 * config keys; it never inherits the host environment by prefix or wildcard.
 */
export const OPENCODE_ENVIRONMENT_POLICY = {
  contractId: 'task-monki/opencode-environment@v1',
  allowedKeys: [
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT_ID',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_TENANT_ID',
    'AZURE_FEDERATED_TOKEN_FILE',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    'CLOUD_ML_REGION',
    'DISABLE_PROMPT_CACHING',
    'XAI_API_KEY',
    'GROK_API_KEY',
    'XAI_BASE_URL',
    ...AWS_ENVIRONMENT_KEYS,
    ...GOOGLE_ENVIRONMENT_KEYS,
    ...USER_CONFIG_ENVIRONMENT_KEYS,
    ...NETWORK_ENVIRONMENT_KEYS
  ],
  sensitiveKeys: [
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT',
    'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_TENANT_ID',
    'AZURE_FEDERATED_TOKEN_FILE',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'XAI_API_KEY',
    'GROK_API_KEY',
    ...AWS_SENSITIVE_ENVIRONMENT_KEYS,
    ...GOOGLE_SENSITIVE_ENVIRONMENT_KEYS,
    ...NETWORK_SENSITIVE_ENVIRONMENT_KEYS
  ]
} as const satisfies ProviderEnvironmentPolicy;

export function openCodeEnvironmentKeys(environment: NodeJS.ProcessEnv): string[] {
  return presentEnvironmentKeys(OPENCODE_ENVIRONMENT_POLICY, environment);
}

export function openCodeSensitiveEnvironmentValues(
  environment: NodeJS.ProcessEnv
): string[] {
  return sensitiveEnvironmentValues(OPENCODE_ENVIRONMENT_POLICY, environment);
}
