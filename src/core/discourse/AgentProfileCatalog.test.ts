import { describe, expect, it } from 'vitest';
import type { AgentModel, AgentProviderState } from '../../shared/agent';
import { AgentProfileCatalog } from './AgentProfileCatalog';

describe('AgentProfileCatalog', () => {
  it('returns stable built-ins with distinct functional roles and shared concrete settings', () => {
    const catalog = new AgentProfileCatalog();
    const snapshot = catalog.list(providerState(), {
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
    expect(snapshot.profiles.every((entry) => entry.availability === 'AVAILABLE')).toBe(true);
    expect(snapshot.profiles.map((entry) => entry.resolvedSettings)).toEqual([
      { model: 'gpt-primary', modelProvider: 'openai', reasoningEffort: 'high' },
      { model: 'gpt-primary', modelProvider: 'openai', reasoningEffort: 'high' },
      { model: 'gpt-primary', modelProvider: 'openai', reasoningEffort: 'high' }
    ]);
  });

  it('falls back to the visible provider default and normalizes unsupported reasoning', () => {
    const catalog = new AgentProfileCatalog();
    const snapshot = catalog.list(providerState(), {
      defaultModel: 'removed-model',
      defaultReasoningEffort: 'unsupported'
    });

    expect(snapshot.profiles[0]?.resolvedSettings).toEqual({
      model: 'gpt-primary',
      modelProvider: 'openai',
      reasoningEffort: 'medium'
    });
  });

  it('honors an explicitly selected hidden model without choosing it as an implicit fallback', () => {
    const state = providerState([
      model({ model: 'hidden-saved', hidden: true, isDefault: false }),
      model({ model: 'visible', hidden: false, isDefault: false })
    ]);
    const catalog = new AgentProfileCatalog();

    expect(catalog.list(state).profiles[0]?.resolvedSettings?.model).toBe('visible');
    expect(
      catalog.list(state, { defaultModel: 'hidden-saved' }).profiles[0]?.resolvedSettings?.model
    ).toBe('hidden-saved');
  });

  it('keeps every profile visible but unavailable when provider preflight or models fail', () => {
    const catalog = new AgentProfileCatalog();
    const unavailable = providerState([]);
    unavailable.preflight.ready = false;
    unavailable.preflight.problems = ['Sign in to Codex.'];

    expect(catalog.list(unavailable).profiles).toHaveLength(3);
    expect(catalog.list(unavailable).profiles[0]).toMatchObject({
      availability: 'UNAVAILABLE',
      unavailableReason: 'Sign in to Codex.'
    });
    expect(catalog.list(providerState([])).profiles[0]).toMatchObject({
      availability: 'UNAVAILABLE',
      unavailableReason: 'No compatible agent model is available.'
    });
  });

  it('rejects forged profile ids before conversation construction', () => {
    const catalog = new AgentProfileCatalog();
    expect(() => catalog.require('builtin.admin')).toThrow('Unknown agent profile id');
    expect(catalog.roleContract('builtin.verifier')).toContain('supplied context');
    expect(() => catalog.roleContract('builtin.admin')).toThrow('Unknown agent profile id');
  });

  it('does not share mutable resolved settings between catalog entries', () => {
    const profiles = new AgentProfileCatalog().list(providerState()).profiles;
    profiles[0]!.resolvedSettings!.model = 'mutated';
    expect(profiles[1]?.resolvedSettings?.model).toBe('gpt-primary');
  });
});

function providerState(models: AgentModel[] = [model()]): AgentProviderState {
  return {
    preflight: {
      provider: 'codex',
      ready: true,
      capabilities: {
        provider: 'codex',
        modelCatalog: { maturity: 'stable' },
        reasoningEffort: { maturity: 'stable' },
        persistentSessions: { maturity: 'stable' },
        sessionResume: { maturity: 'stable' },
        sessionFork: { maturity: 'stable' },
        activeTurnSteering: { maturity: 'stable' },
        turnInterruption: { maturity: 'stable' },
        truePause: { maturity: 'unsupported' },
        interactiveApprovals: { maturity: 'stable' },
        userInputRequests: { maturity: 'stable' },
        goals: { maturity: 'stable' },
        plans: { maturity: 'stable' },
        review: { maturity: 'stable' },
        subagents: { maturity: 'stable' },
        backgroundTerminals: { maturity: 'stable' },
        dynamicTools: { maturity: 'stable' }
      },
      problems: [],
      warnings: []
    },
    models,
    refreshedAt: '2026-07-13T10:00:00.000Z'
  };
}

function model(overrides: Partial<AgentModel> = {}): AgentModel {
  return {
    id: 'model-primary',
    provider: 'codex',
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
