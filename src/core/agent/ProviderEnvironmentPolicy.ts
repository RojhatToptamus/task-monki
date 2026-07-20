/**
 * Exact child-process environment contract for a provider runtime. Contract
 * IDs are versioned so changing inherited provider configuration is an
 * intentional compatibility and security decision.
 */
export interface ProviderEnvironmentPolicy {
  contractId: `${string}@v${number}`;
  /** Exact keys only. Prefix and wildcard matching are intentionally forbidden. */
  allowedKeys: readonly string[];
  /** Allowed keys whose values must be treated as credentials in diagnostics. */
  sensitiveKeys: readonly string[];
}

export const NETWORK_ENVIRONMENT_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR'
] as const;

export const NETWORK_SENSITIVE_ENVIRONMENT_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy'
] as const;

export const USER_CONFIG_ENVIRONMENT_KEYS = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA'
] as const;

export const GOOGLE_ENVIRONMENT_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GENAI_API_VERSION',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL'
] as const;

export const GOOGLE_SENSITIVE_ENVIRONMENT_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS'
] as const;

export const AWS_ENVIRONMENT_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_EC2_METADATA_DISABLED'
] as const;

export const AWS_SENSITIVE_ENVIRONMENT_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'
] as const;

export function presentEnvironmentKeys(
  policy: ProviderEnvironmentPolicy,
  environment: NodeJS.ProcessEnv
): string[] {
  return policy.allowedKeys.filter((key) => environment[key] !== undefined);
}

export function sensitiveEnvironmentValues(
  policy: ProviderEnvironmentPolicy,
  environment: NodeJS.ProcessEnv
): string[] {
  return policy.sensitiveKeys.flatMap((key) =>
    environment[key] ? [environment[key]!] : []
  );
}
