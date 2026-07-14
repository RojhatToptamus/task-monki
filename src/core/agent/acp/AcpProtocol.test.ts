import { describe, expect, it } from 'vitest';
import {
  decodeAcpMessage,
  flattenSelectOptions,
  parseConfigOptions,
  parsePermissionRequest,
  parseSessionNotification
} from './AcpProtocol';

describe('ACP stable-v1 protocol codec', () => {
  it('requires JSON-RPC 2.0 envelopes', () => {
    expect(() => decodeAcpMessage('{"id":1,"result":{}}')).toThrow(
      'JSON-RPC 2.0'
    );
    expect(
      decodeAcpMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
    ).toMatchObject({ id: 1, method: 'initialize' });
  });

  it('preserves native grouped config selectors and metadata', () => {
    const options = parseConfigOptions([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gemini-pro',
        options: [
          {
            group: 'google',
            name: 'Google',
            options: [
              {
                value: 'gemini-pro',
                name: 'Gemini Pro',
                _meta: { context: 1000000 }
              }
            ]
          }
        ],
        _meta: { providerOwned: true }
      }
    ]);
    expect(options?.[0]).toMatchObject({
      id: 'model',
      category: 'model',
      currentValue: 'gemini-pro',
      _meta: { providerOwned: true }
    });
    const model = options?.[0];
    expect(model?.type).toBe('select');
    if (model?.type === 'select') {
      expect(flattenSelectOptions(model)).toEqual([
        expect.objectContaining({ value: 'gemini-pro', _meta: { context: 1000000 } })
      ]);
    }
  });

  it('retains opaque permission option IDs for every semantic kind', () => {
    const permission = parsePermissionRequest({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute' },
      options: [
        { optionId: 'opaque-a', name: 'Once', kind: 'allow_once' },
        { optionId: 'opaque-b', name: 'Always', kind: 'allow_always' },
        { optionId: 'opaque-c', name: 'Reject', kind: 'reject_once' },
        { optionId: 'opaque-d', name: 'Never', kind: 'reject_always' }
      ],
      _meta: { provider: 'native' }
    });
    expect(permission.options.map((option) => option.optionId)).toEqual([
      'opaque-a',
      'opaque-b',
      'opaque-c',
      'opaque-d'
    ]);
    expect(permission._meta).toEqual({ provider: 'native' });
  });

  it('validates typed session updates while retaining unknown extension fields', () => {
    const notification = parseSessionNotification({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'provider_custom_update',
        nested: { exact: true },
        _meta: { extension: 'x' }
      }
    });
    expect(notification.update).toEqual({
      sessionUpdate: 'provider_custom_update',
      nested: { exact: true },
      _meta: { extension: 'x' }
    });
  });
});
