import { describe, expect, it } from 'vitest';
import { parseAntigravityModels } from './AntigravityProtocol';

describe('Antigravity model catalog', () => {
  it('preserves exact advertised labels, order, and underlying providers', () => {
    const models = parseAntigravityModels([
      'Gemini 3.5 Flash (Low)',
      'Claude Sonnet 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
      'Future Model 1'
    ].join('\n'));

    expect(models.map((model) => ({
      model: model.model,
      provider: model.modelProvider,
      isDefault: model.isDefault
    }))).toEqual([
      { model: 'Gemini 3.5 Flash (Low)', provider: 'google', isDefault: false },
      { model: 'Claude Sonnet 4.6 (Thinking)', provider: 'anthropic', isDefault: false },
      { model: 'GPT-OSS 120B (Medium)', provider: 'openai', isDefault: false },
      { model: 'Future Model 1', provider: 'antigravity', isDefault: false }
    ]);
  });

  it('rejects empty, duplicate, control-bearing, and unbounded catalogs', () => {
    expect(() => parseAntigravityModels('')).toThrow('empty');
    expect(() => parseAntigravityModels('Model A\nModel A\n')).toThrow('duplicate');
    expect(() => parseAntigravityModels('Model\tA\n')).toThrow('malformed');
    expect(() => parseAntigravityModels(`${'x'.repeat(129 * 1024)}\n`)).toThrow(
      'larger than 128 KiB'
    );
  });
});
