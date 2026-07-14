import { describe, expect, it } from 'vitest';
import {
  interactionActionsForAcpOptions,
  modelsFromAcpConfig,
  permissionOutcomeForDecision,
  requestedNativeConfigValues
} from './AcpEventMapper';
import { GEMINI_ACP_PROFILE } from './AcpRuntimeProfiles';
import { assertAcpExecutionPolicy } from './AcpRuntimeAdapter';
import type { AcpPermissionOption } from './AcpProtocol';

const options: AcpPermissionOption[] = [
  { optionId: 'provider-once-71', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'provider-always-23', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'provider-reject-11', name: 'Reject', kind: 'reject_once' },
  { optionId: 'provider-never-99', name: 'Always reject', kind: 'reject_always' }
];

describe('ACP event mapping', () => {
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
      GEMINI_ACP_PROFILE,
      [
        {
          sessionId: 'session-1',
          modes: null,
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gemini-3-pro',
              options: [
                {
                  value: 'gemini-3-pro',
                  name: 'Gemini 3 Pro',
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
        id: 'gemini-acp:google/gemini-3-pro',
        modelProvider: 'google',
        model: 'gemini-3-pro',
        inputModalities: ['text', 'image'],
        native: expect.objectContaining({ configId: 'model' })
      })
    ]);
  });

  it('keeps runtime-native values scoped to their runtime', () => {
    expect(
      requestedNativeConfigValues('gemini-acp', {
        runtimeOptions: {
          'gemini-acp': {
            configValues: { model: 'gemini-pro', telemetry: false }
          },
          'grok-acp': { configValues: { model: 'grok-code' } }
        }
      })
    ).toEqual({ model: 'gemini-pro', telemetry: false });
  });

  it('fails closed instead of silently downgrading Task Monki security settings', () => {
    expect(() =>
      assertAcpExecutionPolicy(GEMINI_ACP_PROFILE, {
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      })
    ).toThrow('cannot enforce');
    expect(() =>
      assertAcpExecutionPolicy(GEMINI_ACP_PROFILE, {
        sandbox: 'DANGER_FULL_ACCESS',
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      })
    ).not.toThrow();
    expect(() =>
      assertAcpExecutionPolicy(GEMINI_ACP_PROFILE, {
        sandbox: 'DANGER_FULL_ACCESS',
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        runtimeOptions: {
          'gemini-acp': { apiKey: 'sk-secret-value-123' }
        }
      })
    ).toThrow('cannot contain credentials');
  });
});
