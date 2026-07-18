import { describe, expect, it } from 'vitest';
import {
  decodeAcpMessage,
  flattenSelectOptions,
  parseConfigOptions,
  parseInitializeModelExtension,
  parseNewSessionResponse,
  parsePermissionRequest,
  parseSessionModelExtension,
  parseSessionModelUpdateExtension,
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

  it('keeps provider session-model fields outside the stable-v1 setup schema', () => {
    const setup = parseNewSessionResponse({
      sessionId: 'session-1',
      models: { incompatibleVendorShape: true },
      _meta: { providerOwned: true }
    });
    expect(setup).toEqual({
      sessionId: 'session-1',
      modes: null,
      configOptions: null,
      _meta: { providerOwned: true }
    });
    expect(setup).not.toHaveProperty('models');
  });

  it('parses the captured Grok model catalog only through the explicit extension codec', () => {
    const models = parseSessionModelExtension(
      {
        sessionId: '4da7bbcf-21ef-4748-81cf-84c4960b2370',
        models: {
          currentModelId: 'grok-build',
          availableModels: [
            {
              modelId: 'grok-composer-2.5-fast',
              name: 'Composer 2.5',
              description: 'Cursor latest coding model'
            },
            {
              modelId: 'grok-build',
              name: 'Grok Build',
              description: 'Best for advanced coding tasks'
            }
          ]
        },
        _meta: { providerOwned: true }
      },
      'models'
    );
    expect(models).toMatchObject({
      currentModelId: 'grok-build',
      availableModels: [
        { modelId: 'grok-composer-2.5-fast', name: 'Composer 2.5' },
        { modelId: 'grok-build', name: 'Grok Build' }
      ]
    });
  });

  it('parses the captured Grok initialize catalog only through the explicit metadata extension', () => {
    expect(
      parseInitializeModelExtension(
        {
          protocolVersion: 1,
          agentCapabilities: {},
          _meta: {
            modelState: {
              currentModelId: 'grok-build',
              availableModels: [
                { modelId: 'grok-composer-2.5-fast', name: 'Composer 2.5' },
                { modelId: 'grok-build', name: 'Grok Build' }
              ]
            }
          }
        },
        'modelState'
      )
    ).toMatchObject({
      currentModelId: 'grok-build',
      availableModels: [
        { modelId: 'grok-composer-2.5-fast' },
        { modelId: 'grok-build' }
      ]
    });
  });

  it('parses Grok model updates with exact reasoning metadata', () => {
    expect(
      parseSessionModelUpdateExtension({
        currentModelId: 'grok-4.5',
        availableModels: [
          {
            modelId: 'grok-4.5',
            name: 'Grok 4.5',
            description: 'Frontier model',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: 'low',
              reasoningEfforts: [
                {
                  id: 'high',
                  value: 'high',
                  label: 'High Effort',
                  description: 'Extensive reasoning',
                  default: true
                },
                {
                  id: 'low',
                  value: 'low',
                  label: 'Low Effort',
                  description: 'Fast implementation',
                  default: false
                }
              ]
            }
          }
        ]
      })
    ).toMatchObject({
      currentModelId: 'grok-4.5',
      availableModels: [
        {
          modelId: 'grok-4.5',
          reasoningEffort: 'low',
          reasoningEfforts: [
            { id: 'high', value: 'high', default: true },
            { id: 'low', value: 'low', default: false }
          ]
        }
      ]
    });
  });

  it('rejects inconsistent Grok reasoning metadata', () => {
    expect(() =>
      parseSessionModelUpdateExtension({
        currentModelId: 'grok-4.5',
        availableModels: [
          {
            modelId: 'grok-4.5',
            name: 'Grok 4.5',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: 'low',
              reasoningEfforts: [
                {
                  id: 'high',
                  value: 'high',
                  label: 'High Effort',
                  default: true
                }
              ]
            }
          }
        ]
      })
    ).toThrow('duplicate or inconsistent values');
  });

  it('rejects model state whose current ID was not advertised', () => {
    expect(() =>
      parseSessionModelExtension(
        {
          sessionId: 'session-1',
          models: {
            currentModelId: 'unadvertised',
            availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }]
          }
        },
        'models'
      )
    ).toThrow('unadvertised model IDs');
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
