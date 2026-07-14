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
          description: 'Authorization: Bearer token-value-123'
        }
      })
    ).toEqual({
      nested: {
        apiKey: '[REDACTED]',
        description: 'Authorization=[REDACTED]'
      }
    });
  });

  it('removes sensitive config selectors without corrupting xai model identities', () => {
    const safe = sanitizeAcpNativeSession({
      sessionId: 'session-1',
      modes: null,
      configOptions: [
        {
          id: 'apiKey',
          name: 'API key',
          type: 'select',
          currentValue: 'secret-value',
          options: [{ value: 'secret-value', name: 'Secret' }]
        },
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
      options: [expect.objectContaining({ value: 'xai-grok-4-fast-reasoning' })]
    });
    expect(JSON.stringify(safe)).not.toContain('_meta');
    expect(JSON.stringify(safe)).not.toContain('hidden');
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
});
