import { describe, expect, it } from 'vitest';
import { selectNativeSessionControls } from './providerNativeSession';

describe('selectNativeSessionControls', () => {
  it('selects only the adapter-projected control set for the local session', () => {
    const controls = {
      localSessionId: 'local-session-1',
      providerSessionId: 'provider-session-1',
      revision: 'revision-1',
      controls: [
        {
          id: 'model',
          label: 'Model',
          kind: 'SELECT' as const,
          value: 'grok-build',
          choices: [{ value: 'grok-build', label: 'Grok Build' }],
          mutable: true
        }
      ]
    };

    expect(
      selectNativeSessionControls(
        [
          controls,
          { ...controls, localSessionId: 'local-session-2', revision: 'revision-2' }
        ],
        'local-session-1'
      )
    ).toEqual(controls);
    expect(selectNativeSessionControls([controls], 'missing')).toBeUndefined();
  });
});
