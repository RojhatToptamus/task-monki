import { describe, expect, it } from 'vitest';
import {
  ACP_RUNTIME_PROFILES,
  CURSOR_PARAMETERIZED_MODEL_CATALOG,
  CURSOR_ACP_PROFILE,
  GROK_ACP_PROFILE,
  GROK_SESSION_MODEL_EXTENSION,
  CLAUDE_AGENT_ACP_PROFILE,
  acpCapabilities,
  acpDesignSupport,
  acpImageInputSupport,
  acpModelInputModalities,
  defaultAcpModel
} from './AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../../testSupport/acpRuntimeProfile';
import { normalizeAcpReadOnlyExecutionSettings } from './AcpRuntimeAdapter';

describe('ACP runtime profiles', () => {
  it('defines unique first-class runtime identities', () => {
    const ids = ACP_RUNTIME_PROFILES.map((profile) => profile.descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'grok-acp',
      'cursor-agent-acp',
      'claude-agent-acp'
    ]);
  });

  it('uses provider-native ACP launch forms', () => {
    expect(TEST_ACP_PROFILE.argv).toEqual(['--acp']);
    expect(GROK_ACP_PROFILE.argv).toEqual([
      '--no-auto-update',
      '--permission-mode',
      'default',
      'agent',
      'stdio'
    ]);
    expect(GROK_ACP_PROFILE.defaultModel).toBe('grok-build');
    expect(CURSOR_ACP_PROFILE.argv).toEqual(['acp']);
    expect(CURSOR_ACP_PROFILE.executableCandidates).toEqual(['cursor-agent']);
    expect(CURSOR_ACP_PROFILE.launchContractProbe.argv).toEqual(['help', 'acp']);
    expect(CURSOR_ACP_PROFILE.defaultModel).toBe('default');
    expect(CLAUDE_AGENT_ACP_PROFILE.argv).toEqual([]);
  });

  it('requires a profile-owned non-mutating launch-contract probe', () => {
    expect(TEST_ACP_PROFILE.launchContractProbe.argv).toEqual(['--help']);
    expect(GROK_ACP_PROFILE.launchContractProbe.argv).toEqual([
      '--no-auto-update',
      '--permission-mode',
      'default',
      'agent',
      'stdio',
      '--help'
    ]);
    expect(CLAUDE_AGENT_ACP_PROFILE.launchContractProbe.argv).toEqual([
      '--cli',
      '--help'
    ]);
    for (const profile of ACP_RUNTIME_PROFILES) {
      expect(profile.launchContractProbe.requiredOutput.length).toBeGreaterThan(0);
    }
  });

  it('owns a unique executable override and versioned exact environment policy per profile', () => {
    expect(
      ACP_RUNTIME_PROFILES.map((profile) => profile.executableEnvironmentKey)
    ).toEqual([
      'TASK_MONKI_GROK_ACP_BIN',
      'TASK_MONKI_CURSOR_AGENT_ACP_BIN',
      'TASK_MONKI_CLAUDE_AGENT_ACP_BIN'
    ]);
    for (const profile of ACP_RUNTIME_PROFILES) {
      expect(profile.environmentPolicy.contractId).toMatch(/@v\d+$/u);
      expect(new Set(profile.environmentPolicy.allowedKeys).size).toBe(
        profile.environmentPolicy.allowedKeys.length
      );
      expect(
        profile.environmentPolicy.sensitiveKeys.every((key) =>
          profile.environmentPolicy.allowedKeys.includes(key)
        )
      ).toBe(true);
      expect(profile.environmentPolicy.allowedKeys).not.toContain(
        'TASK_MONKI_UNRELATED_SECRET'
      );
      expect(profile.environmentPolicy.allowedKeys).not.toContain('CODEX_HOME');
    }
  });

  it('supports Claude cloud authentication without broad host inheritance', () => {
    expect(CLAUDE_AGENT_ACP_PROFILE.environmentPolicy.allowedKeys).toEqual(
      expect.arrayContaining([
        'CLAUDE_CODE_USE_BEDROCK',
        'AWS_PROFILE',
        'AWS_WEB_IDENTITY_TOKEN_FILE',
        'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
        'CLAUDE_CODE_USE_VERTEX',
        'ANTHROPIC_VERTEX_PROJECT_ID',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'CLOUD_ML_REGION'
      ])
    );
  });

  it('gates model-catalog contracts to explicit profiles', () => {
    expect(GROK_SESSION_MODEL_EXTENSION).toEqual({
      contractId: 'grok-build-acp/session-models@v1',
      initializeResponseMetaField: 'modelState',
      setupResponseField: 'models',
      setModelMethod: 'session/set_model',
      setModelReasoningEffortMetaField: 'reasoningEffort',
      modelUpdateNotification: '_x.ai/models/update'
    });
    expect(GROK_ACP_PROFILE.sessionModelExtension).toBe(GROK_SESSION_MODEL_EXTENSION);
    expect(
      ACP_RUNTIME_PROFILES.filter((profile) => profile.sessionModelExtension).map(
        (profile) => profile.descriptor.id
      )
    ).toEqual(['grok-acp']);
    expect(
      ACP_RUNTIME_PROFILES.filter((profile) => profile.parameterizedModelCatalog).map(
        (profile) => profile.descriptor.id
      )
    ).toEqual(['cursor-agent-acp']);
    expect(CURSOR_ACP_PROFILE.parameterizedModelCatalog).toBe(
      CURSOR_PARAMETERIZED_MODEL_CATALOG
    );
    expect(CURSOR_PARAMETERIZED_MODEL_CATALOG).toEqual({
      contractId: 'cursor-agent-acp/parameterized-model-picker@v1',
      listModelsMethod: 'cursor/list_available_models',
      clientCapabilityMeta: { parameterizedModelPicker: true }
    });
  });

  it('exposes only the access policies each provider profile can enforce', () => {
    const policy = acpCapabilities(CURSOR_ACP_PROFILE).executionPolicy;
    expect(policy.defaultPresetId).toBe('ask-for-approval');
    expect(policy.presets).toEqual([
      expect.objectContaining({
        id: 'ask-for-approval',
        label: 'Ask for approval',
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'on-request',
        repositoryMutation: 'ASK'
      }),
      expect.objectContaining({
        id: 'auto-accept-edits',
        label: 'Auto-accept edits',
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'auto-accept-edits',
        repositoryMutation: 'ALLOW'
      }),
      expect.objectContaining({
        id: 'full-access',
        label: 'Full access',
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'never',
        repositoryMutation: 'ALLOW'
      }),
      expect.objectContaining({
        id: 'native-read-only',
        label: 'Read-only',
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'NEVER',
        repositoryMutation: 'DENY'
      })
    ]);
    expect(policy.detail).toContain('does not provide an enforceable process sandbox');

    expect(acpCapabilities(GROK_ACP_PROFILE).executionPolicy).toMatchObject({
      defaultPresetId: 'ask-for-approval',
      presets: [
        expect.objectContaining({ id: 'ask-for-approval', approvalPolicy: 'on-request' }),
        expect.objectContaining({ id: 'auto-accept-edits', approvalPolicy: 'auto-accept-edits' }),
        expect.objectContaining({ id: 'full-access', approvalPolicy: 'never' })
      ]
    });
    expect(acpCapabilities(CLAUDE_AGENT_ACP_PROFILE).executionPolicy.presets).toEqual([
      expect.objectContaining({ id: 'ask-for-approval', approvalPolicy: 'on-request' })
    ]);
    expect(acpCapabilities(TEST_ACP_PROFILE).executionPolicy.presets).toEqual([
      expect.objectContaining({ id: 'ask-for-approval', approvalPolicy: 'on-request' })
    ]);
  });

  it('qualifies only Cursor for shared read-only workflows', () => {
    expect(CURSOR_ACP_PROFILE.readOnlyTurnPolicy).toMatchObject({
      modeId: 'ask',
      policyId: 'cursor-agent-acp/ask-read-only@v1'
    });
    expect(acpCapabilities(CURSOR_ACP_PROFILE)).toMatchObject({
      readOnlyTurns: { maturity: 'stable' }
    });
    for (const profile of [GROK_ACP_PROFILE, CLAUDE_AGENT_ACP_PROFILE]) {
      expect(profile.readOnlyTurnPolicy).toBeUndefined();
      expect(profile.readOnlyTurnUnavailableReason).toBeTruthy();
      expect(acpCapabilities(profile)).toMatchObject({
        readOnlyTurns: {
          maturity: 'unsupported',
          detail: profile.readOnlyTurnUnavailableReason
        }
      });
      expect(
        acpCapabilities(profile).executionPolicy.presets.some(
          (preset) => preset.repositoryMutation === 'DENY'
        )
      ).toBe(false);
    }
  });

  it('maps provider-neutral read-only resolution to Cursor Ask without changing normal Tasks', () => {
    expect(
      normalizeAcpReadOnlyExecutionSettings(CURSOR_ACP_PROFILE, {
        runtimeId: CURSOR_ACP_PROFILE.descriptor.id,
        sandbox: 'READ_ONLY',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        networkAccess: false
      })
    ).toMatchObject({
      sandbox: 'DANGER_FULL_ACCESS',
      approvalPolicy: 'NEVER',
      approvalsReviewer: 'user',
      networkAccess: true,
      runtimeOptions: {
        'cursor-agent-acp': { modeId: 'ask' }
      }
    });
    const normal = {
      runtimeId: CURSOR_ACP_PROFILE.descriptor.id,
      sandbox: 'DANGER_FULL_ACCESS' as const,
      approvalPolicy: 'never',
      approvalsReviewer: 'user' as const,
      networkAccess: true
    };
    expect(normalizeAcpReadOnlyExecutionSettings(CURSOR_ACP_PROFILE, normal)).toBe(
      normal
    );
    expect(() =>
      normalizeAcpReadOnlyExecutionSettings(GROK_ACP_PROFILE, {
        ...normal,
        runtimeId: GROK_ACP_PROFILE.descriptor.id,
        sandbox: 'READ_ONLY'
      })
    ).toThrow(GROK_ACP_PROFILE.readOnlyTurnUnavailableReason);
  });

  it('gates provider-owned remembered permission choices to Cursor and Grok', () => {
    expect(CURSOR_ACP_PROFILE.allowRememberedPermissions).toBe(true);
    expect(GROK_ACP_PROFILE.allowRememberedPermissions).toBe(true);
    expect(CLAUDE_AGENT_ACP_PROFILE.allowRememberedPermissions).toBeUndefined();
    expect(TEST_ACP_PROFILE.allowRememberedPermissions).toBeUndefined();
  });

  it('owns the known Cursor plan gate as a failed terminal response', () => {
    expect(CURSOR_ACP_PROFILE.terminalFailureMessage).toEqual({
      exactText: 'Upgrade your plan to continue',
      diagnostic:
        'Cursor Agent could not continue because the current account plan or usage allowance requires an upgrade.'
    });
    expect(GROK_ACP_PROFILE.terminalFailureMessage).toBeUndefined();
    expect(CLAUDE_AGENT_ACP_PROFILE.terminalFailureMessage).toBeUndefined();
  });

  it('describes the Cursor default without relying on a prior task session', () => {
    expect(defaultAcpModel(CURSOR_ACP_PROFILE)).toMatchObject({
      model: 'default',
      displayName: 'Auto',
      native: {
        source: 'cursor-agent-acp/parameterized-model-picker@v1'
      }
    });
    expect(defaultAcpModel(CURSOR_ACP_PROFILE).description).not.toContain(
      'task-owned session'
    );
  });

  it('intersects ACP image negotiation with exact profile version and model evidence', () => {
    expect(
      acpModelInputModalities({
        profile: CURSOR_ACP_PROFILE,
        promptCapabilities: { image: true },
        runtimeVersion: '2026.08.25-3e8eec8',
        modelId: 'composer-2.5'
      })
    ).toEqual(['text', 'image']);
    for (const input of [
      { runtimeVersion: '2026.08.25-3e8eec8', modelId: 'default', image: true },
      { runtimeVersion: '2026.08.25-3e8eec8', modelId: 'other', image: true },
      { runtimeVersion: 'other-version', modelId: 'composer-2.5', image: true },
      { runtimeVersion: '2026.08.25-3e8eec8', modelId: 'composer-2.5', image: false }
    ]) {
      expect(
        acpModelInputModalities({
          profile: CURSOR_ACP_PROFILE,
          promptCapabilities: { image: input.image },
          runtimeVersion: input.runtimeVersion,
          modelId: input.modelId
        })
      ).toEqual(['text']);
    }
    expect(
      acpImageInputSupport({
        profile: GROK_ACP_PROFILE,
        promptCapabilities: { image: false },
        runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
        modelId: 'grok-4.6'
      })
    ).toMatchObject({
      advertised: false,
      enabled: true,
      capabilityDrift: true,
      qualification: {
        allowWhenNotAdvertised: true,
        mediaTypes: ['image/png']
      }
    });
    expect(
      acpImageInputSupport({
        profile: GROK_ACP_PROFILE,
        promptCapabilities: {},
        runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
        modelId: 'grok-4.6'
      })
    ).toMatchObject({
      advertised: undefined,
      enabled: false,
      capabilityDrift: false,
      unavailableReason: expect.stringContaining('did not report ACP image support')
    });
    for (const input of [
      {
        runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
        modelId: 'grok-4.5'
      },
      { runtimeVersion: 'grok 1.0.13', modelId: 'grok-4.6' }
    ]) {
      expect(
        acpImageInputSupport({
          profile: GROK_ACP_PROFILE,
          promptCapabilities: { image: false },
          ...input
        })
      ).toMatchObject({
        advertised: false,
        enabled: false,
        capabilityDrift: false,
        unavailableReason: expect.stringContaining('no verified compatibility exception')
      });
    }
    expect(GROK_ACP_PROFILE.attachmentTextTransport).toBe('embedded-resource');
    expect(CURSOR_ACP_PROFILE.attachmentTextTransport).toBe('text-block');
    expect(CLAUDE_AGENT_ACP_PROFILE.attachmentTextTransport).toBeUndefined();
    expect(
      acpCapabilities(GROK_ACP_PROFILE, {
        prompt: { embeddedContext: true }
      }).attachmentDelivery.maturity
    ).toBe('stable');
    expect(
      acpCapabilities(GROK_ACP_PROFILE, {
        prompt: { embeddedContext: false }
      }).attachmentDelivery.maturity
    ).toBe('unsupported');
    expect(acpCapabilities(CURSOR_ACP_PROFILE).attachmentDelivery.maturity).toBe(
      'stable'
    );
    expect(
      acpCapabilities(CLAUDE_AGENT_ACP_PROFILE).attachmentDelivery
    ).toMatchObject({
      maturity: 'unsupported',
      detail: expect.stringContaining('content-use qualification')
    });
  });

  it('qualifies Design only for exact ACP version and model pairs', () => {
    expect(
      acpDesignSupport({
        profile: CURSOR_ACP_PROFILE,
        runtimeVersion: '2026.08.25-3e8eec8',
        modelId: 'composer-2.5'
      })
    ).toMatchObject({ maturity: 'stable' });
    expect(
      acpDesignSupport({
        profile: CURSOR_ACP_PROFILE,
        runtimeVersion: 'other-version',
        modelId: 'composer-2.5'
      })
    ).toMatchObject({
      maturity: 'unsupported',
      detail: expect.stringContaining('has not passed')
    });
    expect(
      acpDesignSupport({
        profile: GROK_ACP_PROFILE,
        runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
        modelId: 'grok-4.6'
      })
    ).toMatchObject({
      maturity: 'unsupported',
      detail: expect.stringContaining('has not passed')
    });
  });
});
