import { describe, expect, it } from 'vitest';
import {
  ACP_RUNTIME_PROFILES,
  CURSOR_PARAMETERIZED_MODEL_CATALOG,
  CURSOR_ACP_PROFILE,
  GROK_ACP_PROFILE,
  GROK_SESSION_MODEL_EXTENSION,
  CLAUDE_AGENT_ACP_PROFILE,
  acpCapabilities,
  defaultAcpModel
} from './AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../../testSupport/acpRuntimeProfile';

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
    expect(GROK_ACP_PROFILE.argv).toEqual(['--no-auto-update', 'agent', 'stdio']);
    expect(GROK_ACP_PROFILE.defaultModel).toBe('grok-build');
    expect(CURSOR_ACP_PROFILE.argv).toEqual(['acp']);
    expect(CURSOR_ACP_PROFILE.executableCandidates).toEqual(['cursor-agent']);
    expect(CURSOR_ACP_PROFILE.launchContractProbe.argv).toEqual(['help', 'acp']);
    expect(CURSOR_ACP_PROFILE.defaultModel).toBe('default');
    expect(CURSOR_ACP_PROFILE.allowOpaqueExecuteOnce).toBe(true);
    expect(GROK_ACP_PROFILE.allowOpaqueExecuteOnce).toBeUndefined();
    expect(CLAUDE_AGENT_ACP_PROFILE.allowOpaqueExecuteOnce).toBeUndefined();
    expect(CLAUDE_AGENT_ACP_PROFILE.argv).toEqual([]);
  });

  it('requires a profile-owned non-mutating launch-contract probe', () => {
    expect(TEST_ACP_PROFILE.launchContractProbe.argv).toEqual(['--help']);
    expect(GROK_ACP_PROFILE.launchContractProbe.argv).toEqual([
      '--no-auto-update',
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
      acpCapabilities(GROK_ACP_PROFILE).extensions.grokSessionModels
    ).toMatchObject({ maturity: 'experimental' });
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

  it('enables optional lifecycle features only after negotiation', () => {
    expect(acpCapabilities(TEST_ACP_PROFILE).sessionResume.maturity).toBe('inferred');
    expect(acpCapabilities(TEST_ACP_PROFILE).persistentSessions.maturity).toBe(
      'inferred'
    );
    expect(
      acpCapabilities(TEST_ACP_PROFILE, {
        resume: false,
        loadSession: false,
        close: false,
        prompt: {}
      }).persistentSessions.maturity
    ).toBe('unsupported');
    expect(
      acpCapabilities(TEST_ACP_PROFILE, {
        resume: false,
        loadSession: false,
        close: false,
        prompt: {}
      }).sessionResume.maturity
    ).toBe('unsupported');
    expect(
      acpCapabilities(TEST_ACP_PROFILE, {
        resume: true,
        close: true,
        prompt: { image: true }
      }).sessionResume.maturity
    ).toBe('stable');
    expect(
      acpCapabilities(TEST_ACP_PROFILE, {
        loadSession: true,
        close: true,
        prompt: {}
      }).persistentSessions.maturity
    ).toBe('stable');
    expect(
      acpCapabilities(TEST_ACP_PROFILE, {
        close: true,
        prompt: {}
      }).extensions.sessionClose?.maturity
    ).toBe('stable');
  });

  it('never claims Task Monki client terminal execution', () => {
    for (const profile of ACP_RUNTIME_PROFILES) {
      expect(acpCapabilities(profile).backgroundTerminals.maturity).toBe('unsupported');
    }
  });

  it('exposes only the access policies each provider profile can enforce', () => {
    const policy = acpCapabilities(CURSOR_ACP_PROFILE).executionPolicy;
    expect(policy.defaultPresetId).toBe('supervised');
    expect(policy.presets).toEqual([
      expect.objectContaining({
        id: 'supervised',
        label: 'Supervised',
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'on-request'
      }),
      expect.objectContaining({
        id: 'auto-accept-edits',
        label: 'Auto-accept edits',
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'auto-accept-edits'
      }),
      expect.objectContaining({
        id: 'full-access',
        label: 'Full access',
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'never'
      })
    ]);
    expect(policy.detail).toContain('does not provide an enforceable process sandbox');

    expect(acpCapabilities(GROK_ACP_PROFILE).executionPolicy.presets).toEqual(
      policy.presets
    );
    expect(acpCapabilities(CLAUDE_AGENT_ACP_PROFILE).executionPolicy.presets).toEqual([
      expect.objectContaining({ id: 'supervised', approvalPolicy: 'on-request' })
    ]);
    expect(acpCapabilities(TEST_ACP_PROFILE).executionPolicy.presets).toEqual([
      expect.objectContaining({ id: 'supervised', approvalPolicy: 'on-request' })
    ]);
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
});
