import { describe, expect, it } from 'vitest';
import { redactCredentialValue } from '../AgentCredentialRedaction';
import {
  redactProtocolJournalRecord,
  redactProtocolText
} from './AgentProtocolRedaction';

describe('AgentProtocolRedaction', () => {
  it('redacts credential-bearing fields while preserving token metrics', () => {
    const raw = JSON.stringify({
      authorization: 'Bearer direct-secret',
      authToken: 'auth-secret',
      password: 'password-secret',
      passwordHash: 'password-hash-secret',
      client_secret: 'client-secret',
      OPENAI_API_KEY: 'api-secret',
      apiKeyValue: 'indirect-api-secret',
      cookie: 'session=cookie-secret',
      cookieHeader: 'session=header-cookie-secret',
      credentials: { accessToken: 'nested-secret' },
      HASHICORP_TOKEN: 'hashicorp-secret',
      HASURA_GRAPHQL_ADMIN_SECRET: 'hasura-secret',
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        tokenCount: 125
      },
      authenticationStatus: 'authenticated',
      hasCredentials: true,
      supportsApiKey: true,
      supportsApiKeyText: 'must-not-survive'
    });

    const parsed = JSON.parse(redactProtocolText(raw)) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      authorization: '[REDACTED]',
      authToken: '[REDACTED]',
      password: '[REDACTED]',
      passwordHash: '[REDACTED]',
      client_secret: '[REDACTED]',
      OPENAI_API_KEY: '[REDACTED]',
      apiKeyValue: '[REDACTED]',
      cookie: '[REDACTED]',
      cookieHeader: '[REDACTED]',
      credentials: '[REDACTED]',
      HASHICORP_TOKEN: '[REDACTED]',
      HASURA_GRAPHQL_ADMIN_SECRET: '[REDACTED]',
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        tokenCount: 125
      },
      authenticationStatus: 'authenticated',
      hasCredentials: true,
      supportsApiKey: true,
      supportsApiKeyText: '[REDACTED]'
    });
    expect(JSON.stringify(parsed)).not.toContain('direct-secret');
    expect(JSON.stringify(parsed)).not.toContain('nested-secret');
  });

  it('redacts provider account email from durable protocol traffic', () => {
    const parsed = JSON.parse(
      redactProtocolText(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            account: {
              type: 'chatgpt',
              email: 'provider-account@example.test',
              planType: 'pro'
            },
            requiresOpenaiAuth: false
          }
        })
      )
    ) as {
      result: {
        account: { type: string; email: string; planType: string };
        requiresOpenaiAuth: boolean;
      };
    };

    expect(parsed.result).toEqual({
      account: {
        type: 'chatgpt',
        email: '[REDACTED]',
        planType: 'pro'
      },
      requiresOpenaiAuth: false
    });
  });

  it('redacts named env and header values plus credentials embedded in text', () => {
    const record = redactProtocolJournalRecord(
      JSON.stringify({
        method: '_x.ai/mcp/servers_updated',
        params: {
          servers: [
            {
              name: 'github',
              env: [
                { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: 'env-secret' },
                { name: 'HASHICORP_TOKEN', value: 'hashicorp-env-secret' },
                {
                  name: 'HASURA_GRAPHQL_ADMIN_SECRET',
                  value: 'hasura-env-secret'
                },
                { name: 'LOG_LEVEL', value: 'debug' }
              ],
              headers: [
                { key: 'Authorization', value: 'Bearer header-secret' },
                { key: 'Accept', value: 'application/json' }
              ],
              endpoint: 'https://mcp-user:mcp-password@example.test/rpc'
            }
          ]
        }
      }),
      {
        request: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
        endpoint: 'https://metadata-user:metadata-password@example.test',
        totalTokens: 240
      }
    );
    const parsed = JSON.parse(record.raw) as {
      params: {
        servers: Array<{
          env: Array<{ name: string; value: string }>;
          headers: Array<{ key: string; value: string }>;
          endpoint: string;
        }>;
      };
    };
    const server = parsed.params.servers[0]!;

    expect(server.env).toEqual([
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '[REDACTED]' },
      { name: 'HASHICORP_TOKEN', value: '[REDACTED]' },
      { name: 'HASURA_GRAPHQL_ADMIN_SECRET', value: '[REDACTED]' },
      { name: 'LOG_LEVEL', value: 'debug' }
    ]);
    expect(server.headers).toEqual([
      { key: 'Authorization', value: '[REDACTED]' },
      { key: 'Accept', value: 'application/json' }
    ]);
    expect(server.endpoint).toBe('https://[REDACTED]@example.test/rpc');
    expect(record.metadata).toEqual({
      request: 'Authorization: [REDACTED]',
      endpoint: 'https://[REDACTED]@example.test',
      totalTokens: 240
    });
  });

  it('preserves benign JSON byte-for-byte', () => {
    const raw = '{ "method": "session/update", "totalTokens": 42 }';
    expect(redactProtocolText(raw)).toBe(raw);
  });

  it('redacts exact runtime credentials whose values have no credential shape', () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const record = redactProtocolJournalRecord(
      JSON.stringify({ message: `provider echoed ${opaque}` }),
      { detail: `metadata echoed ${opaque}` },
      [opaque]
    );

    expect(record.raw).toContain('[REDACTED]');
    expect(record.metadata).toEqual({ detail: 'metadata echoed [REDACTED]' });
    expect(JSON.stringify(record)).not.toContain(opaque);
  });

  it('redacts exact runtime credentials used as structured object keys', () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const redacted = redactCredentialValue(
      { variants: { [`variant-${opaque}`]: { label: 'unsafe' }, safe: {} } },
      [opaque]
    );

    expect(redacted).toEqual({
      variants: { safe: {} }
    });
    expect(JSON.stringify(redacted)).not.toContain(opaque);
  });

  it('redacts credential-shaped values in unstructured diagnostics', () => {
    const diagnostic = redactProtocolText(
      'failed with sk-exampleCredential123, OPENAI_API_KEY=opaque-provider-key, ' +
        'AWS_SESSION_TOKEN=temporary-token, refresh_token="refresh-secret", ' +
        'oauthToken=oauth-secret, HASHICORP_TOKEN=hashicorp-secret, ' +
        'HASURA_GRAPHQL_ADMIN_SECRET=hasura-secret, ' +
        'and https://user:password@example.test'
    );
    expect(diagnostic).toBe(
      'failed with [REDACTED], OPENAI_API_KEY=[REDACTED], ' +
        'AWS_SESSION_TOKEN=[REDACTED], refresh_token="[REDACTED]", ' +
        'oauthToken=[REDACTED], HASHICORP_TOKEN=[REDACTED], ' +
        'HASURA_GRAPHQL_ADMIN_SECRET=[REDACTED], ' +
      'and https://[REDACTED]@example.test'
    );
  });

  it('redacts URI userinfo in linear time while preserving ordinary URLs', () => {
    const benignPrefix = 'v'.repeat(128 * 1024);
    const input =
      `${benignPrefix}\n` +
      'remote=(https://user:password@example.test/path) ' +
      'public=https://example.test/docs';
    const startedAt = performance.now();

    const diagnostic = redactProtocolText(input);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(diagnostic).toBe(
      `${benignPrefix}\n` +
        'remote=(https://[REDACTED]@example.test/path) ' +
        'public=https://example.test/docs'
    );
  });
});
