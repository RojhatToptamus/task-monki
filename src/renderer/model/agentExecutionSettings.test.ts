import { describe, expect, it } from 'vitest';
import type { AgentModel } from '../../shared/contracts';
import { resolveModelExecutionSettings, resolveReasoningEffort } from './agentExecutionSettings';

describe('resolveModelExecutionSettings', () => {
  it('uses the configured reasoning effort when the selected model supports it', () => {
    expect(
      resolveModelExecutionSettings(models, 'spark', 'low')
    ).toMatchObject({
      model: 'spark',
      modelProvider: 'openai',
      reasoningEffort: 'low'
    });
  });

  it('falls back to the selected model default when the configured effort is unsupported', () => {
    expect(resolveModelExecutionSettings(models, 'reviewer', 'minimal')).toMatchObject({
      model: 'reviewer',
      reasoningEffort: 'high'
    });
  });

  it('falls back to the provider default model when the saved model is unavailable', () => {
    expect(resolveModelExecutionSettings(models, 'removed-model', 'medium')).toMatchObject({
      model: 'spark',
      reasoningEffort: 'medium'
    });
  });

  it('keeps duplicate model names scoped to the selected runtime and model provider', () => {
    const duplicateModels: AgentModel[] = [
      ...models,
      {
        ...models[0]!,
        id: 'opencode:anthropic/spark',
        runtimeId: 'opencode',
        modelProvider: 'anthropic',
        displayName: 'Spark via OpenCode'
      }
    ];

    expect(
      resolveModelExecutionSettings(
        duplicateModels,
        'spark',
        'high',
        'opencode',
        'anthropic'
      )
    ).toMatchObject({
      runtimeId: 'opencode',
      model: 'spark',
      modelProvider: 'anthropic',
      reasoningEffort: 'high'
    });
  });

  it('never falls back to a model owned by another runtime', () => {
    expect(
      resolveModelExecutionSettings(models, 'missing', undefined, 'opencode', 'anthropic')
    ).toBeUndefined();
  });

  it('never falls back to a model owned by another model provider', () => {
    expect(
      resolveModelExecutionSettings(models, 'spark', undefined, 'codex', 'anthropic')
    ).toBeUndefined();
  });
});

describe('resolveReasoningEffort', () => {
  it('uses the first supported effort when the model has no explicit default', () => {
    expect(resolveReasoningEffort({ ...models[0]!, defaultReasoningEffort: undefined }, undefined))
      .toBe('low');
  });
});

const models: AgentModel[] = [
  {
    id: 'spark',
    runtimeId: 'codex',
    modelProvider: 'openai',
    model: 'spark',
    displayName: 'Spark',
    hidden: false,
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
    inputModalities: [],
    isDefault: true
  },
  {
    id: 'reviewer',
    runtimeId: 'codex',
    modelProvider: 'openai',
    model: 'reviewer',
    displayName: 'Reviewer',
    hidden: false,
    supportedReasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    serviceTiers: [],
    inputModalities: [],
    isDefault: false
  }
];
