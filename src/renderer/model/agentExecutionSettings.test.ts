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
    provider: 'codex',
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
    provider: 'codex',
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
