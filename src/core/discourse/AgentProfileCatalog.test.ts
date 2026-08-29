import { describe, expect, it } from 'vitest';
import type { AgentModel, AgentRuntimeCatalog } from '../../shared/agent';
import { createRuntimeReadiness } from '../agent/AgentRuntimeReadiness';
import { codexCapabilities, CODEX_RUNTIME_DESCRIPTOR } from '../agent/codex/codexCapabilities';
import { opencodeCapabilities, OPENCODE_RUNTIME_DESCRIPTOR } from '../agent/opencode/opencodeCapabilities';
import { AgentProfileCatalog } from './AgentProfileCatalog';

describe('AgentProfileCatalog', () => {
  it('returns stable roles with one runtime-qualified model snapshot', () => {
    const snapshot = new AgentProfileCatalog().list(runtimeCatalog(), {
      defaultRuntimeId: 'codex',
      defaultModel: 'gpt-primary',
      defaultReasoningEffort: 'high'
    });

    expect(snapshot.profiles.map((entry) => entry.profile.id)).toEqual([
      'builtin.lead',
      'builtin.skeptic',
      'builtin.verifier'
    ]);
    expect(snapshot.profiles.map((entry) => entry.profile.roleTemplate)).toEqual([
      'LEAD',
      'SKEPTIC',
      'VERIFIER'
    ]);
    expect(snapshot.profiles.every((entry) => entry.profile.roleContractVersion === 3)).toBe(true);
    expect(snapshot.profiles.every((entry) => entry.availability === 'AVAILABLE')).toBe(true);
    expect(snapshot.profiles.map((entry) => entry.resolvedSettings)).toEqual([
      {
        runtimeId: 'codex',
        modelId: 'codex:gpt-primary',
        model: 'gpt-primary',
        modelProvider: 'openai',
        reasoningEffort: 'high'
      },
      {
        runtimeId: 'codex',
        modelId: 'codex:gpt-primary',
        model: 'gpt-primary',
        modelProvider: 'openai',
        reasoningEffort: 'high'
      },
      {
        runtimeId: 'codex',
        modelId: 'codex:gpt-primary',
        model: 'gpt-primary',
        modelProvider: 'openai',
        reasoningEffort: 'high'
      }
    ]);
  });

  it('falls back to the visible runtime default and normalizes unsupported reasoning', () => {
    const snapshot = new AgentProfileCatalog().list(runtimeCatalog(), {
      defaultRuntimeId: 'codex',
      defaultModel: 'removed-model',
      defaultReasoningEffort: 'unsupported'
    });

    expect(snapshot.profiles[0]?.resolvedSettings).toEqual({
      runtimeId: 'codex',
      modelId: 'codex:gpt-primary',
      model: 'gpt-primary',
      modelProvider: 'openai',
      reasoningEffort: 'medium'
    });
  });

  it('preserves the difference between a providerless model and an explicit provider', () => {
    const providerless = model({ modelProvider: undefined });
    const explicitCollision = model({
      id: 'opencode:opencode/model',
      runtimeId: 'opencode',
      modelProvider: 'opencode',
      model: 'model'
    });
    const catalog = runtimeCatalog([providerless, explicitCollision]);
    catalog.runtimes[0] = { ...catalog.runtimes[0]!, models: [providerless] };
    catalog.runtimes[1] = { ...catalog.runtimes[1]!, models: [explicitCollision] };

    expect(new AgentProfileCatalog().resolveSelection(catalog, {
      agentProfileId: 'builtin.lead',
      runtimeId: 'codex',
      modelId: providerless.id
    })).not.toHaveProperty('modelProvider');
    expect(new AgentProfileCatalog().resolveSelection(catalog, {
      agentProfileId: 'builtin.lead',
      runtimeId: 'opencode',
      modelId: explicitCollision.id
    })).toMatchObject({ modelProvider: 'opencode' });
  });

  it('honors a selected hidden model without using it as an implicit fallback', () => {
    const catalog = runtimeCatalog([
      model({ id: 'codex:hidden-saved', model: 'hidden-saved', hidden: true, isDefault: false }),
      model({ id: 'codex:visible', model: 'visible', hidden: false, isDefault: false })
    ]);
    const profiles = new AgentProfileCatalog();

    expect(profiles.list(catalog).profiles[0]?.resolvedSettings?.model).toBe('visible');
    expect(
      profiles.list(catalog, { defaultModel: 'codex:hidden-saved' }).profiles[0]
        ?.resolvedSettings?.model
    ).toBe('hidden-saved');
  });

  it('never reroutes an explicit missing provider through another runtime with the same model id', () => {
    const catalog = runtimeCatalog();
    const profiles = new AgentProfileCatalog();

    expect(() => profiles.resolveSelection(catalog, {
      agentProfileId: 'builtin.lead',
      runtimeId: 'removed-runtime',
      modelId: 'codex:gpt-primary'
    })).toThrow('selected Discourse agent provider is no longer available');
  });

  it('falls back to another qualified runtime when the app default has no model', () => {
    const catalog = runtimeCatalog();
    catalog.defaultRuntimeId = 'opencode';

    expect(new AgentProfileCatalog().list(catalog).profiles[0]).toMatchObject({
      availability: 'AVAILABLE',
      resolvedSettings: { runtimeId: 'codex', modelId: 'codex:gpt-primary' }
    });
  });

  it('keeps roles visible and explains an unqualified read-only profile', () => {
    const catalog = runtimeCatalog();
    catalog.defaultRuntimeId = 'opencode';
    catalog.runtimes = catalog.runtimes.filter(
      (runtime) => runtime.preflight.runtime.id === 'opencode'
    );
    catalog.models = [];
    const capabilities = catalog.runtimes[0]!.preflight.capabilities;
    capabilities.executionPolicy = {
      ...capabilities.executionPolicy,
      presets: capabilities.executionPolicy.presets.filter(
        (preset) => preset.repositoryMutation !== 'DENY'
      )
    };
    capabilities.detachedReview = {
      maturity: 'unsupported',
      detail: 'This profile can still mutate through shell commands.'
    };

    expect(new AgentProfileCatalog().list(catalog).profiles[0]).toMatchObject({
      availability: 'UNAVAILABLE',
      unavailableReason:
        'This profile can still mutate through shell commands. Normal Tasks remain available.'
    });
  });

  it('uses typed readiness detail when the selected runtime cannot start', () => {
    const catalog = runtimeCatalog();
    const runtime = catalog.runtimes[0]!;
    runtime.preflight.readiness = createRuntimeReadiness(
      'AUTHENTICATION_REQUIRED',
      'Sign in to Codex before starting Discourse.'
    );
    catalog.runtimes = [runtime];

    expect(new AgentProfileCatalog().list(catalog).profiles[0]).toMatchObject({
      availability: 'UNAVAILABLE',
      unavailableReason: 'Sign in to Codex before starting Discourse.'
    });
  });

  it('rejects forged profile ids and does not share mutable settings', () => {
    const profiles = new AgentProfileCatalog();
    expect(() => profiles.require('builtin.admin')).toThrow('Unknown agent profile id');
    expect(profiles.roleContract('builtin.verifier')).toContain('supplied facts');
    const entries = profiles.list(runtimeCatalog()).profiles;
    entries[0]!.resolvedSettings!.model = 'mutated';
    expect(entries[1]?.resolvedSettings?.model).toBe('gpt-primary');
  });

  it('keeps prior role contracts addressable after a contract revision', () => {
    const profiles = new AgentProfileCatalog();
    expect(profiles.roleContract('builtin.skeptic', 1)).toBe(
      'Challenge material assumptions and identify specific counterexamples.'
    );
    expect(profiles.roleContract('builtin.skeptic', 2)).toContain('Do not echo');
    expect(profiles.roleContract('builtin.skeptic', 3)).toContain(
      'strongest credible counter-position'
    );
    expect(profiles.roleContract('builtin.lead', 3)).toContain('actionable choice');
    expect(profiles.roleContract('builtin.verifier', 3)).toContain('evidence-audit lens');
    expect(() => profiles.roleContract('builtin.skeptic', 99)).toThrow(
      'Unknown role contract version'
    );
  });
});

function runtimeCatalog(models: AgentModel[] = [model()]): AgentRuntimeCatalog {
  const codex = codexCapabilities();
  const opencode = opencodeCapabilities();
  return {
    defaultRuntimeId: 'codex',
    refreshedAt: '2026-07-13T10:00:00.000Z',
    models,
    runtimes: [
      {
        preflight: {
          runtime: CODEX_RUNTIME_DESCRIPTOR,
          readiness: createRuntimeReadiness('READY', 'Codex is ready.'),
          capabilities: codex
        },
        models,
        refreshedAt: '2026-07-13T10:00:00.000Z'
      },
      {
        preflight: {
          runtime: OPENCODE_RUNTIME_DESCRIPTOR,
          readiness: createRuntimeReadiness('READY', 'OpenCode is ready.'),
          capabilities: opencode
        },
        models: [],
        refreshedAt: '2026-07-13T10:00:00.000Z'
      }
    ]
  };
}

function model(overrides: Partial<AgentModel> = {}): AgentModel {
  return {
    id: 'codex:gpt-primary',
    runtimeId: 'codex',
    modelProvider: 'openai',
    model: 'gpt-primary',
    displayName: 'GPT Primary',
    hidden: false,
    supportedReasoningEfforts: ['medium', 'high'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
    inputModalities: ['text'],
    isDefault: true,
    ...overrides
  };
}
