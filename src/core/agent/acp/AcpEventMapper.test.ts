import { describe, expect, it } from 'vitest';
import {
  interactionActionsForAcpOptions,
  mapAcpStopReason,
  modelsFromAcpConfig,
  observedSettingsFromAcpState,
  permissionOutcomeForDecision,
  requestedNativeConfigValues
} from './AcpEventMapper';
import { GROK_ACP_PROFILE } from './AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../../testSupport/acpRuntimeProfile';
import { assertAcpExecutionPolicy } from './AcpRuntimeAdapter';
import type { AcpPermissionOption } from './AcpProtocol';

const options: AcpPermissionOption[] = [
  { optionId: 'provider-once-71', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'provider-always-23', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'provider-reject-11', name: 'Reject', kind: 'reject_once' },
  { optionId: 'provider-never-99', name: 'Always reject', kind: 'reject_always' }
];

describe('ACP event mapping', () => {
  it.each([
    ['end_turn', 'completed'],
    ['cancelled', 'interrupted'],
    ['refusal', 'failed'],
    ['max_tokens', 'failed'],
    ['max_turn_requests', 'failed']
  ] as const)('maps terminal stop reason %s to %s', (stopReason, status) => {
    expect(mapAcpStopReason(stopReason)).toBe(status);
  });

  it('advertises only provider-present permission actions', () => {
    expect(interactionActionsForAcpOptions([options[0]!, options[2]!])).toEqual([
      'ACCEPT',
      'DECLINE',
      'CANCEL'
    ]);
  });

  it.each([
    ['ACCEPT', 'provider-once-71'],
    ['ACCEPT_FOR_SESSION', 'provider-always-23'],
    ['DECLINE', 'provider-reject-11'],
    ['DECLINE_FOR_SESSION', 'provider-never-99']
  ] as const)('maps %s back to the exact opaque option ID', (action, optionId) => {
    expect(
      permissionOutcomeForDecision(options, {
        interactionType: 'COMMAND_APPROVAL',
        action
      })
    ).toEqual({ outcome: 'selected', optionId });
  });

  it('maps cancel to the protocol cancellation outcome without inventing an option', () => {
    expect(
      permissionOutcomeForDecision(options, {
        interactionType: 'COMMAND_APPROVAL',
        action: 'CANCEL'
      })
    ).toEqual({ outcome: 'cancelled' });
  });

  it('derives runtime-qualified models from native ACP selectors losslessly', () => {
    const models = modelsFromAcpConfig(
      TEST_ACP_PROFILE,
      [
        {
          sessionId: 'session-1',
          modes: null,
          models: null,
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'test-model-pro',
              options: [
                {
                  value: 'test-model-pro',
                  name: 'Test Model Pro',
                  description: 'Provider description',
                  _meta: { tier: 'native' }
                }
              ]
            }
          ]
        }
      ],
      ['text', 'image']
    );
    expect(models).toEqual([
      expect.objectContaining({
        id: 'test-acp:test-provider/test-model-pro',
        modelProvider: 'test-provider',
        model: 'test-model-pro',
        inputModalities: ['text', 'image'],
        native: expect.objectContaining({ configId: 'model' })
      })
    ]);
  });

  it('maps and observes captured Grok session models as first-class models', () => {
    const state = {
      sessionId: 'session-grok',
      modes: null,
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
            description: 'Best for advanced coding tasks',
            reasoningEffort: 'high',
            reasoningEfforts: [
              {
                id: 'high',
                value: 'high',
                label: 'High Effort',
                default: true
              },
              {
                id: 'low',
                value: 'low',
                label: 'Low Effort',
                default: false
              }
            ]
          }
        ]
      },
      configOptions: []
    };
    const profile = {
      ...GROK_ACP_PROFILE,
      defaultModel: 'grok-build'
    };

    expect(modelsFromAcpConfig(profile, [state], ['text'])).toEqual([
      expect.objectContaining({
        id: 'grok-acp:xai/grok-build',
        model: 'grok-build',
        isDefault: true,
        supportedReasoningEfforts: []
      }),
      expect.objectContaining({
        id: 'grok-acp:xai/grok-composer-2.5-fast',
        modelProvider: 'xai',
        model: 'grok-composer-2.5-fast',
        displayName: 'Composer 2.5',
        isDefault: false,
        native: expect.objectContaining({ source: 'session-models' })
      })
    ]);
    expect(
      observedSettingsFromAcpState(profile, state, {
        model: 'grok-composer-2.5-fast',
        modelProvider: 'xai'
      })
    ).toMatchObject({
      runtimeId: 'grok-acp',
      model: 'grok-build',
      modelProvider: 'xai',
      reasoningEffort: undefined,
      runtimeOptions: {
        'grok-acp': {
          models: { currentModelId: 'grok-build' }
        }
      }
    });
  });

  it('keeps the model union and fallback stable across live-session order', () => {
    const profile = {
      ...GROK_ACP_PROFILE,
      defaultModel: 'provider-default-not-advertised'
    };
    const sessions: Parameters<typeof modelsFromAcpConfig>[1] = [
      {
        sessionId: 'session-z',
        modes: null,
        models: {
          currentModelId: 'model-z',
          availableModels: [
            { modelId: 'model-z', name: 'Model Z' },
            { modelId: 'model-a', name: 'Native Model A' }
          ]
        },
        configOptions: []
      },
      {
        sessionId: 'session-a',
        modes: null,
        models: null,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'model-b',
            options: [
              { value: 'model-b', name: 'Model B' },
              { value: 'model-a', name: 'Config Model A' }
            ]
          }
        ]
      }
    ];

    const forward = modelsFromAcpConfig(profile, sessions, ['text']);
    const reversed = modelsFromAcpConfig(profile, [...sessions].reverse(), ['text']);

    expect(reversed).toEqual(forward);
    expect(forward.map((model) => model.model)).toEqual([
      'model-a',
      'model-b',
      'model-z'
    ]);
    expect(forward.every((model) => !model.isDefault)).toBe(true);
    expect(forward[0]).toMatchObject({
      displayName: 'Native Model A',
      native: { source: 'session-models' }
    });
  });

  it('never promotes credential-bearing provider values into model routing or settings', () => {
    const profile = {
      ...GROK_ACP_PROFILE,
      defaultModel: 'safe-model'
    };
    const state: Parameters<typeof modelsFromAcpConfig>[1][number] = {
      sessionId: 'session-sensitive-models',
      modes: null,
      models: {
        currentModelId: 'AWS_SESSION_TOKEN=secret-marker',
        availableModels: [
          { modelId: 'safe-model', name: 'Safe model' },
          {
            modelId: 'HASHICORP_TOKEN=secret-marker',
            name: 'Credential-shaped model'
          }
        ]
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'AWS_SESSION_TOKEN=secret-marker',
          options: [
            { value: 'safe-config-model', name: 'Safe config model' },
            {
              value: 'HASURA_GRAPHQL_ADMIN_SECRET=secret-marker',
              name: 'Credential-shaped option'
            }
          ]
        }
      ]
    };

    const models = modelsFromAcpConfig(profile, [state], ['text']);
    expect(models.map((model) => model.model)).toEqual([
      'safe-config-model',
      'safe-model'
    ]);
    const observed = observedSettingsFromAcpState(profile, state, {});
    expect(observed.model).toBeUndefined();
    expect(JSON.stringify({ models, observed })).not.toContain('secret-marker');
  });

  it('keeps runtime-native values scoped to their runtime', () => {
    expect(
      requestedNativeConfigValues(TEST_ACP_PROFILE.descriptor.id, {
        runtimeOptions: {
          [TEST_ACP_PROFILE.descriptor.id]: {
            configValues: { model: 'test-model', telemetry: false }
          },
          'grok-acp': { configValues: { model: 'grok-code' } }
        }
      })
    ).toEqual({ model: 'test-model', telemetry: false });
  });

  it('fails closed instead of silently downgrading Task Monki security settings', () => {
    expect(() =>
      assertAcpExecutionPolicy(TEST_ACP_PROFILE, {
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      })
    ).toThrow('cannot enforce');
    expect(() =>
      assertAcpExecutionPolicy(TEST_ACP_PROFILE, {
        sandbox: 'DANGER_FULL_ACCESS',
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      })
    ).not.toThrow();
    expect(() =>
      assertAcpExecutionPolicy(TEST_ACP_PROFILE, {
        sandbox: 'DANGER_FULL_ACCESS',
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        runtimeOptions: {
          [TEST_ACP_PROFILE.descriptor.id]: { apiKey: 'sk-secret-value-123' }
        }
      })
    ).toThrow('cannot contain credentials');
    expect(() =>
      assertAcpExecutionPolicy(TEST_ACP_PROFILE, {
        sandbox: 'DANGER_FULL_ACCESS',
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        runtimeOptions: {
          'grok-acp': { apiKey: 'provider-owned-value' }
        }
      })
    ).not.toThrow();
  });
});
