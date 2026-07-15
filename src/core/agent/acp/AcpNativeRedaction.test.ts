import { describe, expect, it } from 'vitest';
import {
  acpInitializeNativeView,
  redactAcpNativeValue,
  sanitizeAcpNativeSession
} from './AcpNativeRedaction';

describe('ACP native-state redaction', () => {
  it('drops opaque metadata and recursively redacts credential-shaped values', () => {
    expect(
      redactAcpNativeValue({
        nested: {
          apiKey: 'another-secret',
          refresh_token: 'refresh-secret',
          oauthToken: 'oauth-secret',
          HASHICORP_TOKEN: 'hashicorp-secret',
          HASURA_GRAPHQL_ADMIN_SECRET: 'hasura-secret',
          clientSecret: 'client-secret',
          password: 'password-secret',
          description:
            'refresh_token=embedded-refresh oauthToken=embedded-oauth ' +
            'HASHICORP_TOKEN=embedded-hashicorp ' +
            'HASURA_GRAPHQL_ADMIN_SECRET=embedded-hasura'
        },
        env: [
          { name: 'HASHICORP_TOKEN', value: 'env-hashicorp-secret' },
          { name: 'LOG_LEVEL', value: 'debug' }
        ],
        headers: [
          { key: 'Authorization', value: 'Bearer header-secret' },
          { key: 'Accept', value: 'application/json' }
        ],
        capabilities: [
          { name: 'hasCredentials', value: true },
          { name: 'supportsApiKey', value: true }
        ],
        hasCredentials: true,
        supportsApiKey: true
      })
    ).toEqual({
      nested: {
        apiKey: '[REDACTED]',
        refresh_token: '[REDACTED]',
        oauthToken: '[REDACTED]',
        HASHICORP_TOKEN: '[REDACTED]',
        HASURA_GRAPHQL_ADMIN_SECRET: '[REDACTED]',
        clientSecret: '[REDACTED]',
        password: '[REDACTED]',
        description:
          'refresh_token=[REDACTED] oauthToken=[REDACTED] ' +
          'HASHICORP_TOKEN=[REDACTED] ' +
          'HASURA_GRAPHQL_ADMIN_SECRET=[REDACTED]'
      },
      env: [
        { name: 'HASHICORP_TOKEN', value: '[REDACTED]' },
        { name: 'LOG_LEVEL', value: 'debug' }
      ],
      headers: [
        { key: 'Authorization', value: '[REDACTED]' },
        { key: 'Accept', value: 'application/json' }
      ],
      capabilities: [
        { name: 'hasCredentials', value: true },
        { name: 'supportsApiKey', value: true }
      ],
      hasCredentials: true,
      supportsApiKey: true
    });
  });

  it('removes sensitive config selectors without corrupting xai model identities', () => {
    const sensitiveConfigs = [
      { id: 'apiKey', name: 'API key', value: 'api-secret' },
      { id: 'refresh_token', name: 'Refresh token', value: 'refresh-secret' },
      { id: 'oauthToken', name: 'OAuth token', value: 'oauth-secret' },
      {
        id: 'HASHICORP_TOKEN',
        name: 'HashiCorp token',
        value: 'hashicorp-secret'
      },
      {
        id: 'HASURA_GRAPHQL_ADMIN_SECRET',
        name: 'Hasura admin secret',
        value: 'hasura-secret'
      },
      { id: 'clientSecret', name: 'Client secret', value: 'client-secret' },
      { id: 'password', name: 'Password', value: 'password-secret' }
    ] as const;
    const safe = sanitizeAcpNativeSession({
      sessionId: 'session-1',
      modes: {
        currentModeId: 'code',
        availableModes: [
          {
            id: 'code',
            name: 'Code',
            description: 'oauthToken=mode-description-secret'
          }
        ]
      },
      models: {
        currentModelId: 'xai-grok-4-fast-reasoning',
        availableModels: [
          {
            modelId: 'xai-grok-4-fast-reasoning',
            name: 'Grok 4 Fast Reasoning',
            description: 'Bearer live-token-123',
            _meta: { accessToken: 'hidden' }
          }
        ],
        _meta: { password: 'hidden' }
      },
      configOptions: [
        ...sensitiveConfigs.map(({ id, name, value }) => ({
          id,
          name,
          type: 'select' as const,
          currentValue: value,
          options: [{ value, name: 'Provider credential' }]
        })),
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'xai-grok-4-fast-reasoning',
          options: [
            {
              value: 'xai-grok-4-fast-reasoning',
              name: 'Grok 4 Fast Reasoning',
              description: 'clientSecret=selector-description-secret',
              _meta: { accessToken: 'hidden' }
            }
          ],
          _meta: { password: 'hidden' }
        }
      ]
    });
    expect(safe.configOptions).toHaveLength(1);
    expect(safe.configOptions[0]).toMatchObject({
      id: 'model',
      currentValue: 'xai-grok-4-fast-reasoning',
      options: [
        expect.objectContaining({
          value: 'xai-grok-4-fast-reasoning',
          description: 'clientSecret=[REDACTED]'
        })
      ]
    });
    expect(safe.modes).toEqual({
      currentModeId: 'code',
      availableModes: [
        {
          id: 'code',
          name: 'Code',
          description: 'oauthToken=[REDACTED]'
        }
      ]
    });
    expect(safe.models).toEqual({
      currentModelId: 'xai-grok-4-fast-reasoning',
      availableModels: [
        {
          modelId: 'xai-grok-4-fast-reasoning',
          name: 'Grok 4 Fast Reasoning',
          description: 'Bearer [REDACTED]'
        }
      ]
    });
    expect(JSON.stringify(safe)).not.toContain('_meta');
    expect(JSON.stringify(safe)).not.toContain('hidden');
    for (const credential of [
      'refresh-secret',
      'oauth-secret',
      'hashicorp-secret',
      'hasura-secret',
      'client-secret',
      'password-secret',
      'selector-description-secret',
      'mode-description-secret'
    ]) {
      expect(JSON.stringify(safe)).not.toContain(credential);
    }
  });

  it('exposes only schema-selected authentication fields', () => {
    const view = acpInitializeNativeView({
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true },
        _meta: { password: 'hidden' }
      },
      authMethods: [
        {
          id: 'oauth',
          name: 'Provider OAuth',
          description: 'Bearer live-token-123',
          authorization: 'secret',
          _meta: { cookie: 'hidden' }
        }
      ],
      agentInfo: { name: 'agent', version: '1.0.0' }
    });
    expect(view).toMatchObject({
      authMethods: [
        {
          id: 'oauth',
          name: 'Provider OAuth',
          description: 'Bearer [REDACTED]'
        }
      ]
    });
    expect(JSON.stringify(view)).not.toContain('live-token-123');
    expect(JSON.stringify(view)).not.toContain('cookie');
    expect(JSON.stringify(view)).not.toContain('authorization');
  });

  it('omits sensitive actionable IDs instead of publishing redacted substitutes', () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const safe = sanitizeAcpNativeSession({
      sessionId: 'session-safe',
      modes: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: `Code ${opaque}` },
          { id: `mode-${opaque}`, name: 'Unsafe mode' }
        ]
      },
      models: {
        currentModelId: 'model-safe',
        availableModels: [
          { modelId: 'model-safe', name: `Safe model ${opaque}` },
          { modelId: `model-${opaque}`, name: 'Unsafe model' }
        ]
      },
      configOptions: [
        {
          id: 'style',
          name: `Style ${opaque}`,
          type: 'select',
          currentValue: 'safe-choice',
          options: [
            { value: 'safe-choice', name: `Safe ${opaque}` },
            { value: `choice-${opaque}`, name: 'Unsafe choice' }
          ]
        },
        {
          id: `control-${opaque}`,
          name: 'Unsafe control',
          type: 'boolean',
          currentValue: true
        }
      ]
    }, [opaque]);

    expect(safe).toEqual({
      sessionId: 'session-safe',
      modes: {
        currentModeId: 'code',
        availableModes: [{ id: 'code', name: 'Code [REDACTED]', description: null }]
      },
      models: {
        currentModelId: 'model-safe',
        availableModels: [
          {
            modelId: 'model-safe',
            name: 'Safe model [REDACTED]',
            description: null
          }
        ]
      },
      configOptions: [
        {
          id: 'style',
          name: 'Style [REDACTED]',
          description: null,
          category: null,
          type: 'select',
          currentValue: 'safe-choice',
          options: [
            {
              value: 'safe-choice',
              name: 'Safe [REDACTED]',
              description: null
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(safe)).not.toContain(opaque);
    expect(JSON.stringify(safe)).not.toContain('model-[REDACTED]');
    expect(() =>
      sanitizeAcpNativeSession(
        { sessionId: opaque, modes: null, models: null, configOptions: [] },
        [opaque]
      )
    ).toThrow('cannot publish a sensitive operational identifier');
  });
});
