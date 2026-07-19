import { describe, expect, it } from 'vitest';
import {
  interactionActionsForAcpOptions,
  mapAcpStopReason,
  nativeSelectionOptionsValue,
  permissionOutcomeForDecision,
  requestedNativeConfigValues
} from './AcpEventMapper';
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
    ['ACCEPT', 'provider-always-23'],
    ['DECLINE', 'provider-reject-11'],
    ['DECLINE', 'provider-never-99']
  ] as const)('maps %s back to the exact opaque option ID', (action, optionId) => {
    expect(
      permissionOutcomeForDecision(options, {
        interactionType: 'COMMAND_APPROVAL',
        action,
        providerOptionId: optionId
      })
    ).toEqual({ outcome: 'selected', optionId });
  });

  it('selects the exact provider option when multiple choices share one kind', () => {
    const duplicateKindOptions: AcpPermissionOption[] = [
      { optionId: 'allow-edits-session', name: 'Allow edits this session', kind: 'allow_always' },
      { optionId: 'allow-project', name: 'Always allow in this project', kind: 'allow_always' }
    ];

    expect(
      permissionOutcomeForDecision(duplicateKindOptions, {
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT',
        providerOptionId: 'allow-edits-session'
      })
    ).toEqual({ outcome: 'selected', optionId: 'allow-edits-session' });
    expect(() =>
      permissionOutcomeForDecision(duplicateKindOptions, {
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT'
      })
    ).toThrow('exact provider option ID');
  });

  it('maps cancel to the protocol cancellation outcome without inventing an option', () => {
    expect(
      permissionOutcomeForDecision(options, {
        interactionType: 'COMMAND_APPROVAL',
        action: 'CANCEL'
      })
    ).toEqual({ outcome: 'cancelled' });
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
    expect(
      requestedNativeConfigValues(TEST_ACP_PROFILE.descriptor.id, {
        runtimeOptions: {
          [TEST_ACP_PROFILE.descriptor.id]: { telemetry: false }
        }
      })
    ).toEqual({});
  });

  it('does not persist a stale mode-category config beside the native mode', () => {
    expect(
      nativeSelectionOptionsValue({
        sessionId: 'provider-session',
        modes: {
          currentModeId: 'plan',
          availableModes: [
            { id: 'code', name: 'Code' },
            { id: 'plan', name: 'Plan' }
          ]
        },
        models: null,
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'code',
            options: [
              { value: 'code', name: 'Code' },
              { value: 'plan', name: 'Plan' }
            ]
          },
          {
            id: 'telemetry',
            name: 'Telemetry',
            category: 'other',
            type: 'boolean',
            currentValue: false
          }
        ]
      })
    ).toEqual({ modeId: 'plan', configValues: { telemetry: false } });
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
