import { describe, expect, it } from 'vitest';
import { messageModelName } from './messageIdentity';
import type { AgentModel } from '../../shared/contracts';

describe('message model identity', () => {
  it('uses catalog display names for selected IDs and executed models, scoped to the runtime', () => {
    const models = [
      { id: 'runtime:model', model: 'model', runtimeId: 'runtime', displayName: 'Selected agent name' },
      { id: 'other:model', model: 'model', runtimeId: 'other', displayName: 'Different agent' }
    ] as AgentModel[];
    expect(messageModelName('runtime:model', 'A', models, 'runtime')).toBe('Selected agent name');
    expect(messageModelName('model', 'A', models, 'runtime')).toBe('Selected agent name');
    expect(messageModelName('model', 'B', models, 'other')).toBe('Different agent');
    expect(messageModelName('runtime:model', 'A', [{ ...models[0]!, displayName: 'Updated catalog name' }], 'runtime')).toBe('Updated catalog name');
  });

  it('preserves exact identities when the catalog is missing or ambiguous instead of guessing a name', () => {
    expect(messageModelName('gpt-6-astra', 'A')).toBe('gpt-6-astra');
    expect(messageModelName('provider/custom-model')).toBe('provider/custom-model');
    expect(messageModelName(undefined, 'Historical author')).toBe('Historical author');
    const models = [
      { id: 'one', model: 'shared', runtimeId: 'runtime', displayName: 'One' },
      { id: 'two', model: 'shared', runtimeId: 'runtime', displayName: 'Two' }
    ] as AgentModel[];
    expect(messageModelName('shared', 'A', models, 'runtime')).toBe('shared');
  });
});
